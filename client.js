/**
 * 通话模式 —— 客户端一半（浏览器）
 *
 * 结构：
 *   CallEngine   音频引擎：16kHz 采集、能量端点检测(自动模式)、播放队列、插话打断
 *   Transport    通道适配层（宿主方法调用），实现见文件末尾
 *   CallButton   输入栏右侧的「通话」按钮；点击后进入通话面板
 *
 * 音频格式全程 16kHz / 单声道 / int16 LE，与宿主子进程一致，免重采样。
 */
const ID = '@dsh-external/dsh-call-mode';
const NS = 'dshCallMode';
const TARGET_RATE = 16000;

window.__ModuleLoader__.load({
  id: ID,
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ---------------------------------------------------------------- 工具
    const b64 = {
      fromPcm(int16) {
        const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
      },
      toPcm(text) {
        const bin = atob(text);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
      },
    };

    const unwrap = (envelope) => {
      if (envelope && typeof envelope === 'object' && 'ok' in envelope) {
        if (envelope.ok === false) throw new Error(envelope.error?.message || '调用失败');
        return envelope.value;
      }
      return envelope;
    };

    // ---------------------------------------------------------------- 通道适配层
    // 宿主一半通过 DSH 的插件级同源路由暴露 /api/call-mode.*，
    // 自带 Host/Origin 围栏与 cookie 认证，因此这里只用相对路径、无需任何密钥。
    const API_BASE = '/api/call-mode';

    async function callApi(pathname, body) {
      try {
        const res = body === undefined
          ? await fetch(`${API_BASE}${pathname}`)
          : await fetch(`${API_BASE}${pathname}`, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            });
        return await res.json();
      } catch (e) {
        return { ok: false, error: { message: String(e?.message || e) } };
      }
    }

    const httpCall = {
      start: (args) => callApi('/start', args ?? {}),
      stop: () => callApi('/stop', {}),
      converse: (args) => callApi('/converse', args),
      cancel: () => callApi('/cancel', {}),
      hello: (info) => callApi('/hello', info ?? {}),
      poll: (info) => callApi('/poll', info ?? {}),
      provision: () => callApi('/provision', {}),
      // 音色：列出 / 试听 / 设为当前（三条都不重启 worker、不断通话）
      voices: () => callApi('/voices', {}),
      // 通话状态区（看得见、不念出来）
      status: () => callApi('/status', {}),
      preview: (args) => callApi('/preview', args),
      setVoice: (args) => callApi('/voice', args),
    };

    // ---------------------------------------------------------------- 端点检测
    /** 正数解析：只认正的有限数字，其余（undefined / NaN / 0 / 负数 / 非数字串）一律回退默认值。 */
    function positiveOr(value, fallback) {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
    }
    /**
     * 连续对话的端点检测状态机。纯函数式（只吃 RMS，不碰 Web Audio），因此可以
     * 脱离麦克风做单元测试——连续模式的手感几乎全由这里决定。
     *
     * 与固定阈值相比做了两件事：
     *  - 自适应噪声底：只在「非语音」帧上学习环境噪声，阈值取 max(absFloor, noise*ratio)，
     *    空调/风扇/笔记本风扇声不会把检测器一直顶在「说话中」。
     *  - 最长一句兜底：超过 maxUtteranceMs 强制结束，避免一直录下去。
     *  - 放音期抬门槛：助手正在说话时麦克风会收到扬声器回声，此时阈值乘
     *    speakingRatio，既保留「真插话」又能顶掉大多数回声。
     *
     * @returns {{push(rms:number, speaking?:boolean):'none'|'start'|'end'|'max', reset():void, state:string, noiseFloor:number, lastReason:string}}
     */
    function createEndpointDetector(options = {}) {
      const frameMs = options.frameMs ?? 64;            // 1024 采样 @16k
      const minSpeechMs = options.minSpeechMs ?? 200;   // 连续有声多久算「开始说话」
      const silenceMs = options.silenceMs ?? 3000;      // 静音多久算「说完了」（3s：句子中间的换气/想词停顿不应被当成说完）
      // 最长一句兜底：120s（原 60s/30s）。到点**不硬切**——进入 pending 状态等下一次静音停顿
      // 再提交，这样绝大多数情况断在句子之间；只有一直说不停、宽限期用尽才硬切。
      // 内存代价：120s × 16kHz × 2B ≈ 3.84 MB，可忽略；上限只为兜底，不是无限录。
      const maxUtteranceMs = positiveOr(options.maxUtteranceMs, 120000);
      const maxUtteranceGraceMs = positiveOr(options.maxUtteranceGraceMs, 8000);
      const absFloor = options.absFloor ?? 0.006;       // 绝对下限，防静音室里噪声底趋近 0
      const ratio = options.ratio ?? 3.5;               // 高出噪声底多少倍算有声
      const speakingRatio = options.speakingRatio ?? 2; // 放音期阈值倍数（抗回声）
      let noise = options.noiseFloor ?? 0.004;
      let state = 'idle';            // idle | speech | pending（到点后等停顿）
      let speechMs = 0;
      let quietMs = 0;
      let totalMs = 0;
      let pendingMs = 0;             // 进入 pending 之后又等了多久
      let lastReason = '';           // 'silence' | 'cap-pause' | 'cap-grace'（给日志用）

      const finish = () => { state = 'idle'; speechMs = 0; quietMs = 0; totalMs = 0; pendingMs = 0; };

      return {
        get state() { return state; },
        get noiseFloor() { return noise; },
        /** 上一次 end/max 的成因：'silence' 正常停顿 / 'cap-pause' 到点后等到停顿 / 'cap-grace' 宽限期用尽硬切。 */
        get lastReason() { return lastReason; },
        reset() { finish(); lastReason = ''; },
        push(rms, speaking = false) {
          const voiced = rms > Math.max(absFloor, noise * ratio) * (speaking ? speakingRatio : 1);
          if (state === 'idle') {
            if (voiced) {
              speechMs += frameMs;
              if (speechMs >= minSpeechMs) {
                state = 'speech';
                totalMs = speechMs;
                quietMs = 0;
                return 'start';
              }
            } else {
              speechMs = 0;
              noise = noise * 0.95 + rms * 0.05;        // 只在静音帧上学习
            }
            return 'none';
          }
          totalMs += frameMs;
          if (voiced) quietMs = 0;
          else quietMs += frameMs;
          if (state === 'pending') {
            // 到点之后：等一个自然停顿就在那里提交（内容全含），一直说不停才硬切
            pendingMs += frameMs;
            if (quietMs >= silenceMs) { finish(); lastReason = 'cap-pause'; return 'end'; }
            if (pendingMs >= maxUtteranceGraceMs) { finish(); lastReason = 'cap-grace'; return 'max'; }
            return 'none';
          }
          if (quietMs >= silenceMs) { finish(); lastReason = 'silence'; return 'end'; }
          if (totalMs >= maxUtteranceMs) { state = 'pending'; pendingMs = 0; return 'none'; }   // 不提交，继续录
          return 'none';
        },
      };
    }

    // ---------------------------------------------------------------- 音频引擎
    class CallEngine {
      constructor(onEvent) {
        this.onEvent = onEvent;
        this.mode = 'ptt';            // 'ptt' | 'auto'
        this.state = 'idle';          // idle | recording | speaking
        this.ctx = null;
        this.stream = null;
        this.node = null;
        this.source = null;
        this.frames = [];
        this.preRoll = [];            // 起音预缓冲：说话被判定前的那几帧不能丢
        this.preRollFrames = 5;       // ≈320ms
        this.detector = createEndpointDetector();
        this.level = 0;
        this.nextPlayTime = 0;
        this.playing = [];
        this.captureRequested = false;
      }

      async open() {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.ctx = new AudioContext({ sampleRate: TARGET_RATE });
        await this.ctx.resume();
        this.source = this.ctx.createMediaStreamSource(this.stream);
        this.node = this.ctx.createScriptProcessor(1024, 1, 1);
        this.node.onaudioprocess = (e) => this.#onFrame(e.inputBuffer.getChannelData(0));
        this.source.connect(this.node);
        this.node.connect(this.ctx.destination);
        this.detector.reset();
        this.preRoll = [];
        this.onEvent({ type: 'ready', sampleRate: this.ctx.sampleRate });
      }

      close() {
        try { this.node?.disconnect(); this.source?.disconnect(); } catch { /* 忽略 */ }
        this.stream?.getTracks().forEach((t) => t.stop());
        this.ctx?.close?.();
        this.node = this.source = this.ctx = this.stream = null;
        this.frames = [];
        this.onEvent({ type: 'idle' });
      }

      setMode(mode) {
        this.mode = mode;
        this.detector.reset();
        this.preRoll = [];
        this.onEvent({ type: 'mode', mode });
      }

      startCapture() {
        this.captureRequested = true;
        this.frames = [];
        this.#setState('recording');
      }

      /** 结束采集并返回整段 PCM（int16） */
      stopCapture() {
        this.captureRequested = false;
        const pcm = this.#collect();
        this.#setState('idle');
        return pcm;
      }

      #collect() {
        const total = this.frames.reduce((n, f) => n + f.length, 0);
        const out = new Int16Array(total);
        let off = 0;
        for (const f of this.frames) { out.set(f, off); off += f.length; }
        this.frames = [];
        return out;
      }

      #onFrame(input) {
        // 电平（0..1）：UI 电平条 + 端点检测
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);
        this.level = rms;
        this.onEvent({ type: 'level', level: rms });

        if (this.mode === 'ptt') {
          if (this.captureRequested) this.frames.push(this.#toInt16(input));
          return;
        }

        // 连续模式：检测器只吃 RMS，音频帧由引擎自己攒；放音期抬高门槛抗回声
        const event = this.detector.push(rms, this.state === 'speaking');
        const frame = this.#toInt16(input);

        if (event === 'start') {
          if (this.state === 'speaking') {
            // 助手正在说话时用户开口 -> 插话：掐掉播放，并把已缓冲的起音接上
            this.frames = this.preRoll.slice();
            this.preRoll = [];
            this.onEvent({ type: 'bargeIn' });
            this.#setState('recording');
          } else {
            this.frames = this.preRoll.slice();   // 带上起音，别把第一个字切掉
            this.preRoll = [];
            this.#setState('recording');
          }
          this.frames.push(frame);
          return;
        }

        if (event === 'end' || event === 'max') {
          // 到点后的宽限硬切：这一帧是话音不是静音，必须先收进来再提交（不丢 64ms）。
          if (event === 'max') this.frames.push(frame);
          const pcm = this.#collect();
          this.preRoll = [];
          // 成因随事件带给上层：正常停顿 / 到点后等到停顿 / 宽限期用尽硬切（日志区分用）
          const reason = event === 'max' ? 'cap-grace' : (this.detector.lastReason || 'silence');
          if (pcm.length > TARGET_RATE * 0.2) this.onEvent({ type: 'utterance', pcm, reason });
          this.#setState('idle');
          return;
        }

        if (this.state === 'recording' || this.captureRequested) {
          this.frames.push(frame);
        } else if (this.state !== 'speaking') {
          this.preRoll.push(frame);
          if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
        }
      }

      #toInt16(input) {
        const out = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const v = Math.max(-1, Math.min(1, input[i]));
          out[i] = v < 0 ? v * 32768 : v * 32767;
        }
        return out;
      }

      /** 播放一段 PCM（int16） */
      play(pcm) {
        if (!this.ctx || pcm.length === 0) return;
        // 长时间空闲/休眠后浏览器会把 AudioContext 挂起：不 resume 就是「有音频但听不到」。
        // 每次播放都补一次 resume，并把上下文状态上报一次（下一次听不到时能在 call.log 里看到）。
        if (this.ctx.state !== 'running') {
          this.onEvent({ type: 'audio', state: this.ctx.state, sampleRate: this.ctx.sampleRate });
          try { void this.ctx.resume(); } catch { /* 忽略 */ }
        } else if (this.audioReported !== true) {
          this.audioReported = true;
          this.onEvent({ type: 'audio', state: this.ctx.state, sampleRate: this.ctx.sampleRate });
        }
        const f32 = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
        const buffer = this.ctx.createBuffer(1, f32.length, TARGET_RATE);
        buffer.copyToChannel(f32, 0);
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.ctx.destination);
        const now = this.ctx.currentTime;
        const startAt = Math.max(now, this.nextPlayTime);
        src.start(startAt);
        this.nextPlayTime = startAt + buffer.duration;
        this.playing.push(src);
        this.#setState('speaking');
        src.onended = () => {
          this.playing = this.playing.filter((s) => s !== src);
          if (this.playing.length === 0 && this.state === 'speaking') this.#setState('idle');
        };
      }

      stopPlayback() {
        for (const s of this.playing) { try { s.stop(); } catch { /* 忽略 */ } }
        this.playing = [];
        this.nextPlayTime = 0;
        if (this.state === 'speaking') this.#setState('idle');
      }

      #setState(state) { this.state = state; this.onEvent({ type: 'state', state }); }
    }

    // ---------------------------------------------------------------- 铃声 / 接通音
    /**
     * 铃音与接通音的默认参数。全部**现场合成**（振荡器 + 增益包络），
     * 仓库里不放任何 mp3/wav/ogg：省体积、免格式兼容、无授权问题。
     * enabled/volume 就是「响铃开关 / 音量 / 静音」的配置入口。
     */
    const SOUND_DEFAULTS = {
      enabled: true,        // 关掉就不响铃、不播接通音（静音）
      volume: 0.18,         // 0.18 在系统音量下不刺耳
      ringPeriodMs: 2400,   // 一次「叮铃」+ 间隔
      ringTimeoutMs: 30000, // 最多响 30s，超时收口
    };

    /**
     * 来电铃声 + 接通音。用**独立的 AudioContext**：铃声必须在
     * 模型自检 / worker 拉起之前就响起来，不能等 CallEngine.open()。
     * 所有方法都不抛异常——铃声问题绝不能挡住或打断通话。
     */
    function createCallSounds(options = {}) {
      const cfg = { ...SOUND_DEFAULTS, ...options };
      let ctx = null;
      let timer = null;
      let live = [];
      const ensure = () => {
        if (ctx === null) ctx = new AudioContext();
        if (ctx.state === 'suspended') void ctx.resume?.();
        return ctx;
      };
      /** 一串音符：[频率, 起始偏移s, 时长s, 相对音量]，用增益包络防爆音。 */
      const burst = (specs) => {
        const audio = ensure();
        const at = audio.currentTime;
        for (const [freq, offset, dur, gain] of specs) {
          const osc = audio.createOscillator();
          const amp = audio.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, at + offset);
          amp.gain.setValueAtTime(0, at + offset);
          amp.gain.linearRampToValueAtTime(cfg.volume * gain, at + offset + 0.02);
          amp.gain.setValueAtTime(cfg.volume * gain, at + offset + Math.max(0.03, dur - 0.05));
          amp.gain.linearRampToValueAtTime(0, at + offset + dur);
          osc.connect(amp);
          amp.connect(audio.destination);
          osc.start(at + offset);
          osc.stop(at + offset + dur + 0.02);
          live.push(osc);
        }
      };
      const ringOnce = () => {
        try { burst([[660, 0, 0.32, 1], [520, 0.36, 0.4, 0.85]]); } catch { /* 忽略 */ }
      };
      return {
        get ringing() { return timer !== null; },
        start() {
          if (cfg.enabled !== true || timer !== null) return;
          ringOnce();
          timer = setInterval(ringOnce, cfg.ringPeriodMs);
        },
        /** 立刻静音（接通、挂断、超时都要立刻停）。 */
        stop() {
          if (timer !== null) { clearInterval(timer); timer = null; }
          const nodes = live;
          live = [];
          for (const node of nodes) { try { node.stop(); } catch { /* 已停 */ } }
        },
        /** 接通音「嘟」：短促单音，表示对方接起来了。 */
        beep() {
          if (cfg.enabled !== true) return;
          try { burst([[880, 0, 0.15, 0.75]]); } catch { /* 忽略 */ }
        },
        close() {
          this.stop();
          try { ctx?.close?.(); } catch { /* 忽略 */ }
          ctx = null;
        },
      };
    }

    // ---------------------------------------------------------------- 通话会话
    /**
     * 一次通话的完整生命周期，**与面板可见性、与 React 组件挂载都无关**。
     *
     * 之前通话活在 CallPanel 的 effect 里，面板一卸载（点面板外收起、切会话）
     * cleanup 就 engine.close() + call.stop() —— 「收起面板」等于「挂断」。
     * 现在把这些搬进这个纯 JS 类：收起面板只是 closePanel()（纯 UI 标志），
     * 只有显式 hangUp() 或组件真卸载时的 dispose() 才回收资源。
     *
     * 不依赖 React/DOM（engine 可注入），所以「收起不等于挂断」可以脱浏览器单测。
     */
    class CallSession {
      constructor({ call, sessionId, t, engine, sounds, ringTimeoutMs }) {
        this.call = call;
        this.sessionId = sessionId;
        this.t = t;
        this.engine = engine ?? new CallEngine((ev) => this.#onEngineEvent(ev));
        this.sounds = sounds ?? createCallSounds();
        this.ringTimeoutMs = ringTimeoutMs ?? SOUND_DEFAULTS.ringTimeoutMs;
        this.listeners = new Set();
        this.queue = [];              // agent 思考期间用户说的话排队，不丢
        this.busy = false;
        this.disposed = false;
        this.pollTimer = null;
        this.ringTimer = null;        // 响铃上限（绝不允许无限响）
        this.tickTimer = null;        // 通话计时
        this.activityTimer = null;    // 状态区轮询（2s，只读宿主内存）
        this.connectedAt = 0;
        this.startPromise = null;     // 首次接通只跑一次：重新展开面板不会重新 /start
        this.state = {
          phase: 'dialing',           // dialing | provisioning | live | failed | error | closed
          status: t('dialing'),
          level: 0, mode: 'ptt', transcript: '', reply: '', download: null,
          panelOpen: false,           // 纯 UI 标志，和通话存亡无关
          connectedAt: 0, elapsedSec: 0,
          voiceOpen: false, voice: null, voiceList: null, previewSid: null, notice: '',
          activity: null,             // 状态区（只看不念）：pending / 工具动作 / 最近文本
        };
      }

      /** 通话是否仍活着（面板是否可见无关）。 */
      get inCall() {
        const p = this.state.phase;
        return p === 'dialing' || p === 'provisioning' || p === 'live';
      }

      /** 本地待提交的语音段数（换绑前要确认它是 0，别把旧会话的话串到新会话）。 */
      get queued() { return this.queue.length; }

      /**
       * 把通话接到另一个会话（换绑）：撤旧守则 → 注新守则 → 后续语音提交到新会话。
       * 只调 /start（不带 /stop）：宿主在子进程存活时只重挂守则（index.js:207-210
       * reused:true），activateRules 会先 deactivateRules 再挂新的（index.js:290-313），
       * 所以 worker 不重启、麦克风与 AudioContext 全程不断。
       *
       * 旧会话里排队待投递的语音留在宿主、按旧 sessionId 索引，不会被新会话取走
       * （不串台）；因此本地还有排队时拒绝换绑，交由 UI 提示稍后再试。
       */
      async rebind(nextSessionId) {
        if (this.disposed || !nextSessionId || nextSessionId === this.sessionId) return false;
        if (this.busy || this.queue.length > 0) return false;
        const previous = this.sessionId;
        this.sessionId = nextSessionId;              // 之后的 /converse、/poll 都用新 id
        try {
          await unwrap(this.call.start({ sessionId: nextSessionId }));
          this.#patch({ status: this.t('rebound') });
          return true;
        } catch (e) {
          this.sessionId = previous;                 // 失败回滚，仍挂原会话
          this.#patch({ status: `${this.t('error')}: ${e.message}` });
          return false;
        }
      }

      /** 订阅状态快照；返回退订函数。每次变更给出新对象，便于 React setState。 */
      subscribe(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
      }

      #patch(patch) {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) {
          try { listener(this.state); } catch { /* 视图报错不能影响通话 */ }
        }
      }

      /** 展开面板；首次展开才真的接通（重复展开不会再 /start，也不会重建 AudioContext）。 */
      openPanel() {
        if (this.disposed) return Promise.resolve();
        this.#patch({ panelOpen: true });
        return this.#ensureStarted();
      }

      /** 收起面板：只收 UI。麦克风、AudioContext、播放队列、/poll 轮询全部保持。 */
      closePanel() {
        if (this.disposed || this.state.panelOpen !== true) return;
        this.#patch({ panelOpen: false });
      }

      #ensureStarted() {
        if (this.startPromise !== null) return this.startPromise;
        // 立刻响铃 + 立刻进入呼叫态：模型自检/worker 拉起与响铃并行，用户不用干等
        this.#startRinging();
        this.startPromise = this.#run();
        return this.startPromise;
      }

      /** 起铃并挂上「最多响 N 秒」的收口定时器。 */
      #startRinging() {
        try { this.sounds.start(); } catch { /* 铃声失败不能挡住通话 */ }
        this.#patch({ phase: 'dialing', status: this.t('dialing') });
        if (this.ringTimer !== null) clearTimeout(this.ringTimer);
        this.ringTimer = setTimeout(() => this.#onRingTimeout(), this.ringTimeoutMs);
      }

      /** 停铃（幂等）：接通、挂断、出错、超时都要走这里。 */
      #stopRinging() {
        if (this.ringTimer !== null) { clearTimeout(this.ringTimer); this.ringTimer = null; }
        try { this.sounds.stop(); } catch { /* 忽略 */ }
      }

      /** 响铃超时：停铃 + 收口 + 明确失败提示，绝不无限响、不静默卡住。 */
      #onRingTimeout() {
        this.ringTimer = null;
        if (this.disposed || this.state.phase === 'live') return;
        try { this.sounds.stop(); } catch { /* 忽略 */ }
        this.disposed = true;
        this.queue.length = 0;
        if (this.pollTimer !== null) { clearInterval(this.pollTimer); this.pollTimer = null; }
        try { this.engine.close(); } catch { /* 忽略 */ }
        void this.call.stop();
        this.#patch({ phase: 'failed', status: this.t('noAnswer'), level: 0 });
      }

      #startTicker() {
        if (this.tickTimer !== null) return;
        this.tickTimer = setInterval(() => {
          if (this.disposed) return;
          this.#patch({ elapsedSec: Math.round((Date.now() - this.connectedAt) / 1000) });
        }, 1000);
      }

      /** 状态区：每 2s 拉一次宿主的本地聚合（不碰 worker、不产生 LLM 请求）。 */
      #startActivityPolling() {
        if (this.activityTimer !== null) return;
        void this.refreshActivity();
        this.activityTimer = setInterval(() => { void this.refreshActivity(); }, 2000);
      }

      /** 拉一次通话状态（导出为公开方法，便于单测直接驱动）。 */
      async refreshActivity() {
        if (this.disposed) return;
        try {
          const info = unwrap(await this.call.status());
          if (this.disposed) return;
          this.#patch({ activity: info });
        } catch { /* 状态区失败不影响通话，下一次再试 */ }
      }

      async #run() {
        try {
          if (!this.sessionId) throw new Error(this.t('noSession'));
          let started = unwrap(await this.call.start({ sessionId: this.sessionId }));
          // 首次使用：宿主会先把识别与合成模型下载好（检测若空就下载），
          // 这里把进度显示出来，下完自动接通；这段时间铃声一直响着。
          while (started?.provisioning === true) {
            if (this.disposed) return;
            const p = started.progress ?? {};
            this.#patch({ phase: 'provisioning', download: p, status: `${this.t('preparingModels')} ${p.label ?? ''} ${p.percent ?? 0}%`.trim() });
            await new Promise((r) => setTimeout(r, 1500));
            if (this.disposed) return;
            const st = unwrap(await this.call.provision());
            if (st?.phase === 'failed') throw new Error(`${this.t('provisionFailed')}：${st.detail ?? ''}`);
            started = st?.phase === 'ready'
              ? unwrap(await this.call.start({ sessionId: this.sessionId }))
              : { provisioning: true, progress: st };
          }
          await this.engine.open();
          if (this.disposed) { try { this.engine.close(); } catch { /* 忽略 */ } return; }
          // 接通顺序固定：停铃 → 一声「嘟」→ 问候语
          this.#stopRinging();
          this.connectedAt = Date.now();
          this.#patch({ phase: 'live', status: this.t('live'), connectedAt: this.connectedAt, elapsedSec: 0 });
          this.#startTicker();
          this.#startActivityPolling();
          try { this.sounds.beep(); } catch { /* 忽略 */ }
          // 接通问候由宿主合成，播放它即证明「说」的通路正常
          if (started?.greeting) this.engine.play(b64.toPcm(started.greeting));
          this.#startPolling();
        } catch (e) {
          this.#stopRinging();
          if (!this.disposed) this.#patch({ phase: 'error', status: `${this.t('error')}: ${e.message}` });
        }
      }

      #startPolling() {
        if (this.pollTimer !== null || this.disposed) return;
        // 空闲时轮询「迟到回复」：agent 答得慢时，真实结果会以这种方式补播
        this.pollTimer = setInterval(() => {
          if (this.disposed || this.busy || this.engine.state !== 'idle') return;
          void (async () => {
            try {
              const res = unwrap(await this.call.poll({ sessionId: this.sessionId }));
              for (const chunk of res?.chunks ?? []) this.engine.play(b64.toPcm(chunk));
            } catch { /* 轮询失败忽略，下一次再试 */ }
          })();
        }, 3000);
      }

      /** 收到一段用户语音：入队并尝试处理（最多留最近 3 段，避免积压）。 */
      converse(pcm) {
        if (this.disposed) return;
        this.queue.push(pcm);
        if (this.queue.length > 3) this.queue.shift();
        void this.#drain();
      }

      /** 依次处理排队中的每一段话；同一时刻只有一次往返在飞。 */
      async #drain() {
        if (this.busy || this.disposed) return;
        const pcm = this.queue.shift();
        if (pcm === undefined) return;
        this.busy = true;
        try {
          this.#patch({ status: this.queue.length > 0 ? this.t('queued') : this.t('thinking') });
          const res = unwrap(await this.call.converse({ sessionId: this.sessionId, pcm: b64.fromPcm(pcm), language: this.t('lang') === 'zh' ? 'zh' : 'auto' }));
          if (this.disposed) return;
          this.#patch({ transcript: res.transcript || '', reply: res.replyText || '', status: this.t('live') });
          for (const chunk of res.chunks || []) this.engine.play(b64.toPcm(chunk));
        } catch (e) {
          if (!this.disposed) this.#patch({ status: `${this.t('error')}: ${e.message}` });
        } finally {
          this.busy = false;
          if (!this.disposed && this.queue.length > 0) void this.#drain();
        }
      }

      #onEngineEvent(ev) {
        if (this.disposed) return;
        if (ev.type === 'audio') {
          // 一次通话只报一次：下次「听不到声音」时，call.log 里至少能看到播放时上下文的状态。
          if (this.audioReported !== true) {
            this.audioReported = true;
            try { void this.call.hello?.({ stage: 'audio-play', ctxState: ev.state, rate: ev.sampleRate ?? 0 }); } catch { /* 忽略 */ }
          }
          if (ev.state !== 'running') this.#patch({ notice: this.t('audioSuspended') });
          return;
        }
        if (ev.type === 'level') {
          // 电平只求视觉平滑：抖动小于 0.004 就不发新快照。
          // 音色列表可能有上百行，不节流的话每帧都会把整张表重渲染一遍。
          if (Math.abs(ev.level - this.state.level) > 0.004) this.#patch({ level: ev.level });
          return;
        }
        if (ev.type === 'state') {
          if (ev.state === 'recording') this.#patch({ status: this.t('listening') });
          else if (ev.state === 'speaking') this.#patch({ status: this.t('speaking') });
          else if (ev.state === 'idle' && this.state.phase === 'live') this.#patch({ status: this.t('live') });
          return;
        }
        if (ev.type === 'utterance') {
          // 到点后靠停顿提交 / 宽限期硬切：这两条会写进宿主日志（call.log），便于排查
          // 「话说到一半被发出去」到底是哪条路。正常停顿提交不写，免得刷日志。
          if (ev.reason === 'cap-pause' || ev.reason === 'cap-grace') {
            try {
              void this.call.hello?.({
                stage: 'utterance-submit',
                reason: ev.reason,
                seconds: Math.round((ev.pcm.length / TARGET_RATE) * 10) / 10,
              });
            } catch { /* 忽略 */ }
          }
          this.converse(ev.pcm);
          return;
        }
        if (ev.type === 'bargeIn') { void this.call.cancel(); this.engine.stopPlayback(); }
      }

      setMode(mode) {
        if (this.disposed) return;
        this.engine.setMode(mode);
        this.#patch({ mode, status: mode === 'auto' ? this.t('autoOn') : this.t('pttOn') });
      }

      startCapture() {
        if (this.disposed) return;
        this.engine.stopPlayback();
        this.engine.startCapture();
      }

      stopCapture() {
        if (this.disposed) return;
        const pcm = this.engine.stopCapture();
        if (pcm && pcm.length > TARGET_RATE * 0.2) this.converse(pcm);
      }

      /** 显式挂断：停录音、停播放、调 /stop、关 AudioContext，并收起面板。 */
      hangUp() {
        this.#teardown();
      }

      /** 组件真卸载（切会话/离开页面）时回收麦克风与宿主子进程；幂等，不会重复 /stop。 */
      dispose() {
        this.#teardown();
      }

      #teardown() {
        if (this.disposed) return;
        this.disposed = true;                 // 先置位：close()/stop() 的后续事件不再影响状态
        this.#stopRinging();                  // 任何时刻挂断都立刻停铃（含还在响铃时）
        if (this.pollTimer !== null) { clearInterval(this.pollTimer); this.pollTimer = null; }
        if (this.tickTimer !== null) { clearInterval(this.tickTimer); this.tickTimer = null; }
        if (this.activityTimer !== null) { clearInterval(this.activityTimer); this.activityTimer = null; }
        this.queue.length = 0;
        this.startPromise = null;
        try { this.sounds.close(); } catch { /* 忽略 */ }
        try { this.engine.close(); } catch { /* 忽略 */ }
        void this.call.stop();
        this.#patch({ phase: 'closed', panelOpen: false, level: 0 });
      }

      // ----------------------------------------------------------- 音色试听/切换
      /** 展开/收起音色区；首次展开时拉一次列表。 */
      async toggleVoices() {
        if (this.disposed) return;
        const open = this.state.voiceOpen !== true;
        this.#patch({ voiceOpen: open, notice: '' });
        if (open && this.state.voiceList === null) await this.refreshVoices();
      }

      /** 拉可用音色列表（宿主从 worker /health 的 speakers 推导，客户端不写死数量）。 */
      async refreshVoices() {
        if (this.disposed) return;
        try {
          const info = unwrap(await this.call.voices());
          if (this.disposed) return;
          this.#patch({
            voice: { engine: info.engine, speakers: info.speakers, sid: info.sid },
            voiceList: Array.isArray(info.voices) ? info.voices : [],
          });
        } catch (e) {
          if (!this.disposed) this.#patch({ voiceList: [], notice: `${this.t('voiceFailed')}: ${e.message}` });
        }
      }

      /**
       * 试听某个音色。
       * 冲突策略：**试听优先——先掐掉本机正在播的语音**（engine.stopPlayback），
       * 因为用户是在快速横比，等助手把长回复念完就没法比了。但**不** cancel 当前回合、
       * 也**不**发 /stop：agent 的活照跑，宿主队列不动，试听完该念的还会念。
       * 播放仍走既有的 engine.play（和正常回复同一条音频路径），不另造通路。
       */
      async previewVoice(sid) {
        if (this.disposed) return;
        this.engine.stopPlayback();
        this.#patch({ previewSid: sid, notice: '' });
        try {
          const res = unwrap(await this.call.preview({ sessionId: this.sessionId, sid }));
          if (this.disposed) return;
          for (const chunk of res?.chunks ?? []) this.engine.play(b64.toPcm(chunk));
          this.#patch({ previewSid: null });
        } catch (e) {
          if (!this.disposed) this.#patch({ previewSid: null, notice: `${this.t('voiceFailed')}: ${e.message}` });
        }
      }

      /** 把某个音色设为当前：之后所有合成（含迟到补播、开场问候）都用它。不重启 worker。 */
      async setVoice(sid) {
        if (this.disposed) return;
        try {
          const res = unwrap(await this.call.setVoice({ sessionId: this.sessionId, sid }));
          if (this.disposed) return;
          this.#patch({
            voice: { engine: res.engine, speakers: res.speakers, sid: res.sid },
            notice: `${this.t('voiceSet')} #${res.sid}`,
          });
        } catch (e) {
          if (!this.disposed) this.#patch({ notice: `${this.t('voiceFailed')}: ${e.message}` });
        }
      }
    }

    // ---------------------------------------------------------------- 通话面板
    function IconCall({ active }) {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', {
          d: 'M3.4 2.6h2.2l1 2.7-1.3 1a7.6 7.6 0 0 0 4 4l1-1.3 2.7 1v2.2c0 .6-.5 1.1-1.1 1.1A11 11 0 0 1 2.3 3.7c0-.6.5-1.1 1.1-1.1z',
          fill: active ? 'var(--dsw-alias-brand-primary)' : 'none',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round',
        }));
    }

    const panelStyle = {
      position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, width: 300, padding: 12,
      background: 'var(--dsw-alias-bg-layer-2, #fff)', border: '1px solid var(--dsw-alias-border-l2, #ddd)',
      borderRadius: 'var(--dsw-radius-lg, 10px)', boxShadow: 'var(--dsw-shadow-lv1, 0 6px 24px rgba(0,0,0,.16))',
      font: 'var(--dsw-font-sm, 12px/1.5 system-ui)', color: 'var(--dsw-alias-label-primary, #111)', zIndex: 40,
    };
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 };
    const smallBtn = {
      flex: 1, padding: '6px 10px', borderRadius: 'var(--dsw-radius-md, 8px)',
      border: '1px solid var(--dsw-alias-border-l1, #ccc)', background: 'transparent',
      color: 'var(--dsw-alias-label-primary, #111)', cursor: 'pointer', font: 'inherit',
    };

    const overlayStyle = {
      position: 'fixed', right: 16, bottom: 76, width: 320, padding: 12,
      background: 'var(--dsw-alias-bg-layer-2, #fff)', border: '1px solid var(--dsw-alias-border-l2, #ddd)',
      borderRadius: 'var(--dsw-radius-lg, 10px)', boxShadow: 'var(--dsw-shadow-lv1, 0 10px 32px rgba(0,0,0,.22))',
      font: 'var(--dsw-font-sm, 12px/1.5 system-ui)', color: 'var(--dsw-alias-label-primary, #111)', zIndex: 60,
    };
    const hintStyle = { marginTop: 8, color: 'var(--dsw-alias-label-secondary, #666)' };
    const activityStyle = {
      marginTop: 8, padding: '6px 8px', borderRadius: 'var(--dsw-radius-md, 8px)',
      background: 'var(--dsw-alias-interactive-bg-hover, #f2f4f7)', fontSize: 11,
    };

    /** 状态区一行文案（**只看不念**）：有没有请求在飞 + 最近派了几个队友/建了几个任务。 */
    function activityLine(activity, t) {
      if (activity === null) return t('statusLoading');
      const bits = [activity.busy
        ? `${t('statusBusy')} ${activity.pending + activity.inFlightTurn}`
        : t('statusIdle')];
      if (activity.teammates > 0) bits.push(`${t('statusTeammates')} ${activity.teammates}`);
      if (activity.tasks > 0) bits.push(`${t('statusTasks')} ${activity.tasks}`);
      if (activity.messages > 0) bits.push(`${t('statusMessages')} ${activity.messages}`);
      return bits.join(' · ');
    }
    const voiceListStyle = {
      marginTop: 6, maxHeight: 170, overflowY: 'auto', padding: '4px 6px',
      border: '1px solid var(--dsw-alias-border-l1, #ddd)', borderRadius: 'var(--dsw-radius-md, 8px)',
    };
    const warnStyle = {
      marginTop: 8, padding: '6px 8px', borderRadius: 'var(--dsw-radius-md, 8px)',
      background: '#fff4e5', border: '1px solid #f0b429', color: '#7a4d00',
    };
    const confirmStyle = {
      marginTop: 8, padding: 8, borderRadius: 'var(--dsw-radius-md, 8px)',
      background: 'var(--dsw-alias-interactive-bg-hover, #f2f4f7)', border: '1px solid var(--dsw-alias-border-l1, #ccc)',
    };

    // ---------------------------------------------------------------- 通话中心
    /**
     * 通话的全局中心：UI 住在 root 作用域的 shell.overlay（切对话不卸载），
     * 内核 CallSession 只记住自己绑定了哪个会话。输入栏按钮只是入口 + 状态指示。
     *
     * 这里也是「浮层可见性 / 换绑确认」的唯一来源——收起浮层、切对话都不碰通话，
     * 只有 hangUp()（显式挂断）与 dispose()（页面/插件真卸载）会回收。
     */
    function createCallCenter({ call, label, sounds, ringTimeoutMs }) {
      const listeners = new Set();
      let session = null;
      let overlayOpen = false;
      let screenSessionId = '';       // 输入栏按钮上报的「屏幕上正在看的会话」
      let confirmTarget = null;       // 待确认的换绑目标
      let notice = '';
      let translator = (key) => key;
      let overlayEl = null;
      let buttonEl = null;
      const t = (key) => translator(key);

      const snapshot = () => ({
        boundSessionId: session?.sessionId ?? '',
        boundLabel: session === null ? '' : label(session.sessionId),
        screenSessionId,
        screenLabel: screenSessionId === '' ? '' : label(screenSessionId),
        onScreen: session !== null && screenSessionId !== '' && screenSessionId === session.sessionId,
        overlayOpen,
        inCall: session?.inCall === true,
        busy: session?.busy === true || (session?.queued ?? 0) > 0,
        state: session?.state ?? null,
        confirmTarget,
        notice,
      });
      const emit = () => {
        const view = snapshot();
        for (const listener of [...listeners]) {
          try { listener(view); } catch { /* 视图出错不影响通话 */ }
        }
      };

      const startIn = (sessionId) => {
        session?.dispose();
        session = new CallSession({
          call,
          sessionId,
          t,
          ...sounds === undefined ? {} : { sounds: sounds() },
          ...ringTimeoutMs === undefined ? {} : { ringTimeoutMs },
        });
        session.subscribe(emit);
      };

      const api = {
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        snapshot,
        get session() { return session; },
        setMode(mode) { session?.setMode(mode); },
        startCapture() { session?.startCapture(); },
        stopCapture() { session?.stopCapture(); },
        toggleVoices() { void session?.toggleVoices(); },
        previewVoice(sid) { void session?.previewVoice(sid); },
        setVoice(sid) { void session?.setVoice(sid); },
        setTranslator(fn) { translator = fn; },
        setOverlayEl(el) { overlayEl = el; },
        setButtonEl(el) { buttonEl = el; },
        /** 「面板外」= 浮层与输入栏按钮都不含该目标；只用来收 UI，绝不碰通话。 */
        isInside(target) {
          return (overlayEl?.contains?.(target) ?? false) || (buttonEl?.contains?.(target) ?? false);
        },
        /** 输入栏按钮上报当前屏幕会话；切对话只是这里换个值，通话不受影响。 */
        setScreen(sessionId) {
          const next = sessionId ?? '';
          if (next === screenSessionId) return;
          screenSessionId = next;
          if (confirmTarget !== null && confirmTarget.sessionId !== next) confirmTarget = null;
          emit();
        },
        /** 入口：没有通话就用按钮所在会话接通；有通话则只切换浮层显隐。 */
        toggle(sessionId) {
          if (session !== null && session.inCall) {
            overlayOpen = !overlayOpen;
            emit();
            return session;
          }
          if (!sessionId) return null;
          startIn(sessionId);
          overlayOpen = true;
          emit();
          void session.openPanel();
          return session;
        },
        closeOverlay() { if (overlayOpen) { overlayOpen = false; emit(); } },
        /** 「接到当前对话」：只弹出确认，绝不在这里换绑。 */
        requestRebind() {
          if (session === null || !session.inCall) return false;
          if (screenSessionId === '' || screenSessionId === session.sessionId) return false;
          confirmTarget = { sessionId: screenSessionId, label: label(screenSessionId), from: label(session.sessionId) };
          notice = '';
          emit();
          return true;
        },
        cancelRebind() { if (confirmTarget !== null) { confirmTarget = null; emit(); } },
        /** 确认后才真的换绑；排队/在飞时拒绝，避免把旧会话的语音串到新会话。 */
        async confirmRebind() {
          if (confirmTarget === null || session === null) return false;
          if (session.busy || session.queued > 0) { notice = t('waitTurn'); emit(); return false; }
          const target = confirmTarget.sessionId;
          confirmTarget = null;
          const ok = await session.rebind(target);
          notice = ok ? '' : t('rebindFailed');
          emit();
          return ok;
        },
        hangUp() {
          confirmTarget = null;
          notice = '';
          overlayOpen = false;
          session?.hangUp();
          emit();
        },
        dispose() { session?.dispose(); session = null; listeners.clear(); },
      };
      return api;
    }

    // ---------------------------------------------------------------- 通话浮层（root）
    function CallOverlay({ center, t }) {
      const panelRef = React.useRef(null);
      const [view, setView] = React.useState(center.snapshot());
      React.useEffect(() => {
        center.setTranslator(t);
        return center.subscribe(setView);
      }, [center, t]);
      React.useEffect(() => { center.setOverlayEl(panelRef.current); return () => center.setOverlayEl(null); });

      // 常驻悬浮窗：**不做点外部自动收起**。
      // 用户明确要求「像微信那样单独的一个小窗口」，点界面别处不许把它弄没——
      // 之前从输入栏面板继承来的 outside-click 收起，正是「一移开就没了」的来源。
      // 现在只有两种消失方式：显式「挂断」，或点标题栏那个「收起」。

      // 没有通话或用户收起时什么都不画（组件本身是 root 的，切对话不会卸载它）
      if (view.overlayOpen !== true || view.state === null) return null;
      const { status, level, mode, transcript, reply, phase, elapsedSec } = view.state;
      const callerName = view.boundLabel !== '' ? view.boundLabel : t('assistantName');
      const calling = phase === 'dialing' || phase === 'provisioning';
      const clock = `${String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:${String(elapsedSec % 60).padStart(2, '0')}`;

      const bindArea = view.screenSessionId === ''
        ? h('div', { style: hintStyle }, `${t('noConversation')} · ${t('attachedTo')} ${view.boundLabel}`)
        : view.onScreen
          ? h('div', { style: hintStyle }, `${t('sameConversation')} · ${t('attachedTo')} ${view.boundLabel}`)
          : h('div', { style: warnStyle },
              h('div', null, `⚠ ${t('hereIsOther')}`),
              h('div', null, `${t('speechGoesTo')} ${view.boundLabel}`),
              h('button', { type: 'button', style: { ...smallBtn, marginTop: 6 },
                onClick: () => center.requestRebind() }, t('moveToCurrent')));

      const confirmArea = view.confirmTarget === null ? null : h('div', { style: confirmStyle },
        h('div', null, `${t('moveConfirmPrefix')} ${view.confirmTarget.from} ${t('moveConfirmMiddle')} ${view.confirmTarget.label}？`),
        view.notice !== '' && h('div', { style: { marginTop: 4, color: '#b42318' } }, view.notice),
        h('div', { style: rowStyle },
          h('button', { type: 'button', style: smallBtn, onClick: () => { void center.confirmRebind(); } }, t('confirm')),
          h('button', { type: 'button', style: smallBtn, onClick: () => center.cancelRebind() }, t('cancel'))));

      return h('div', { ref: panelRef, style: overlayStyle, onClick: (e) => e.stopPropagation() },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
          // 呼叫中就报「正在呼叫〈会话标题〉」，接通后显示通话中 + 计时
          h('strong', null, calling ? `${t('dialing')} ${callerName}` : t('title')),
          h('span', { style: { flex: 1, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #666)' } },
            phase === 'live' ? `${clock} · ${t('attachedTo')} ${callerName}` : `${t('attachedTo')} ${callerName}`),
          h('button', { type: 'button', 'aria-label': t('close'), onClick: () => center.closeOverlay(),
            style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 14 } }, '×')),
        h('div', { style: { marginTop: 6, color: 'var(--dsw-alias-label-secondary, #666)' } }, status),
        h('div', { style: { marginTop: 8, height: 6, borderRadius: 3, background: 'var(--dsw-alias-border-l1, #ddd)', overflow: 'hidden' } },
          h('div', { style: { width: `${Math.min(100, Math.round((level / 0.15) * 100))}%`, height: '100%', background: 'var(--dsw-alias-brand-primary, #3b82f6)', transition: 'width .06s linear' } })),
        bindArea,
        confirmArea,
        // 状态区：看得见、不念出来（用户要「随时知道现在什么样」，但极度反感啰嗦）
        h('div', { style: activityStyle },
          h('div', null, `${clock} · ${activityLine(view.state.activity, t)}`),
          view.state.activity !== null && view.state.activity.lastText !== ''
            && h('div', { style: { marginTop: 2, color: 'var(--dsw-alias-label-secondary, #666)' } },
                `${t('statusLast')}: ${view.state.activity.lastText.slice(0, 60)}`)),
        // 音色区：一眼看到当前引擎/数量/当前音色，展开后逐个试听、一键设为当前。
        // 数量由宿主从 worker /health 的 speakers 推导，这里不写死。
        h('div', { style: { marginTop: 8 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('button', { type: 'button', style: { ...smallBtn, flex: 'none' },
              onClick: () => center.toggleVoices() }, `${t('voiceSection')} ${view.state.voiceOpen ? '▾' : '▸'}`),
            h('span', { style: { flex: 1, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #666)' } },
              view.state.voice === null
                ? t('voiceLoading')
                : `${view.state.voice.engine} · ${view.state.voice.speakers} ${t('voiceCount')} · ${t('voiceCurrent')} #${view.state.voice.sid}`)),
          view.state.voiceOpen && h('div', null,
            view.state.voice !== null && view.state.voice.speakers <= 1 && h('div', { style: hintStyle }, t('voiceSingle')),
            view.state.voiceList === null
              ? h('div', { style: hintStyle }, t('voiceLoading'))
              : h('div', { style: voiceListStyle },
                  ...view.state.voiceList.map((v) => h('div', { key: v.sid, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' } },
                    h('span', { style: { flex: 1, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #666)' } }, `#${v.sid} ${v.label}`),
                    h('button', { type: 'button', style: { ...smallBtn, flex: 'none', padding: '2px 8px' },
                      onClick: () => center.previewVoice(v.sid) },
                      view.state.previewSid === v.sid ? t('voicePlaying') : t('voicePreview')),
                    h('button', { type: 'button', style: { ...smallBtn, flex: 'none', padding: '2px 8px' },
                      disabled: view.state.voice !== null && view.state.voice.sid === v.sid,
                      onClick: () => center.setVoice(v.sid) },
                      view.state.voice !== null && view.state.voice.sid === v.sid ? t('voiceCurrent') : t('voiceUse')))))),
          view.state.notice !== '' && h('div', { style: { marginTop: 4, fontSize: 11, color: '#b42318' } }, view.state.notice)),
        mode === 'ptt'
          ? h('button', {
              type: 'button', disabled: phase !== 'live',
              onPointerDown: () => center.startCapture(), onPointerUp: () => center.stopCapture(), onPointerLeave: () => center.stopCapture(),
              style: { ...smallBtn, marginTop: 10, width: '100%', padding: '14px 10px', background: 'var(--dsw-alias-interactive-bg-hover, #f2f4f7)' },
            }, t('holdToTalk'))
          : h('div', { style: { ...rowStyle, color: 'var(--dsw-alias-label-secondary, #666)' } }, t('autoHint')),
        h('div', { style: rowStyle },
          h('button', { type: 'button', style: smallBtn, onClick: () => center.setMode(mode === 'ptt' ? 'auto' : 'ptt') }, mode === 'ptt' ? t('switchToAuto') : t('switchToPtt')),
          h('button', { type: 'button', style: smallBtn, onClick: () => center.hangUp() }, t('hangUp'))),
        transcript !== '' && h('div', { style: { ...rowStyle, display: 'block', color: 'var(--dsw-alias-label-secondary, #666)' } }, `${t('you')}: ${transcript}`),
        reply !== '' && h('div', { style: { ...rowStyle, display: 'block' } }, `${t('agent')}: ${reply}`));
    }

    // ---------------------------------------------------------------- 通话按钮
    function CallButton({ call, center, sessionId, t }) {
      const wrapRef = React.useRef(null);
      const [view, setView] = React.useState(center.snapshot());
      React.useEffect(() => {
        center.setTranslator(t);
        return center.subscribe(setView);
      }, [center, t]);

      // 上报「屏幕上正在看的会话」：切对话只是换这个值，通话与浮层都不受影响
      React.useEffect(() => { center.setScreen(sessionId ?? ''); }, [center, sessionId]);
      React.useEffect(() => { center.setButtonEl(wrapRef.current); return () => center.setButtonEl(null); });

      // 注意：这里**没有**卸载回收。按钮是 session 作用域的，切对话就会卸载，
      // 通话的回收只归 center（插件级 effect）与显式挂断，见 apply()。
      const open = view.overlayOpen;
      const inCall = view.inCall;
      const elsewhere = inCall && view.screenSessionId !== '' && view.boundSessionId !== view.screenSessionId;

      const onToggle = () => {
        if (!inCall && (sessionId ?? '') === '') return;   // 首页没有会话时不能起呼
        center.toggle(sessionId ?? '');
      };

      const title = inCall
        ? (elsewhere
            ? `${t('button')} · ${t('live')} · ${t('attachedTo')} ${view.boundLabel}`
            : `${t('button')} · ${t('live')}`)
        : (sessionId ? t('button') : t('noSession'));

      return h('div', { ref: wrapRef, style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button', 'aria-label': t('button'), 'aria-pressed': open || inCall, title, onClick: onToggle,
          style: {
            position: 'relative',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28,
            padding: 0, border: 'none', borderRadius: 'var(--dsw-radius-sm, 6px)', cursor: 'pointer',
            background: open ? 'var(--dsw-alias-interactive-bg-active, #eaeef5)' : 'transparent',
            color: (open || inCall)
              ? (elsewhere ? '#d97706' : 'var(--dsw-alias-brand-primary, #3b82f6)')
              : 'var(--dsw-alias-label-secondary, #666)',
          },
        }, h(IconCall, { active: open || inCall }),
        // 通话进行中：留一个明确的标记；通话挂在别的会话时用琥珀色提示
        inCall && h('span', {
          'aria-hidden': true,
          style: {
            position: 'absolute', top: 2, right: 2, width: 7, height: 7, borderRadius: '50%',
            background: elsewhere ? '#d97706' : 'var(--dsw-alias-brand-primary, #3b82f6)',
            boxShadow: '0 0 0 2px var(--dsw-alias-bg-layer-2, #fff)',
          },
        })));
    }

    return {
      // 只依赖槽位与词典；控制通道走同源路由，不占用 DSH 的 remote 命名空间
      inject: ['slots', 'locale'],
      // 测试缝：脱离麦克风验证端点检测状态机、通话会话与换绑
      //（加载器只读 inject/apply，多余字段无副作用）
      __internals: { createEndpointDetector, b64, CallSession, createCallCenter, createCallSounds, CallEngine },
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            button: '通话', title: '通话模式', close: '收起', hangUp: '挂断',
            connecting: '正在接入…', live: '通话中', listening: '在听…', thinking: '正在思考…',
            speaking: '正在说话…', error: '通话出错', holdToTalk: '按住说话',
            switchToAuto: '切到连续对话', switchToPtt: '切到按住说话',
            autoOn: '连续对话：直接说话即可', pttOn: '按住说话', autoHint: '连续对话中：直接说话，静音约 3 秒即自动发送',
            you: '你说', agent: '助手', lang: 'zh', queued: '上一轮还没回来，已排队',
            noSession: '拿不到当前会话 ID（插件槽位未提供 sessionId）',
            attachedTo: '附着在', sameConversation: '已连接当前对话', noConversation: '当前不在任何对话中',
            hereIsOther: '当前显示的是另一个对话', speechGoesTo: '你在这里说话会发给：',
            moveToCurrent: '接到当前对话', moveConfirmPrefix: '把通话从', moveConfirmMiddle: '接到',
            confirm: '确认', cancel: '取消', rebound: '已接到当前对话',
            rebindFailed: '换绑失败，仍挂在原对话', waitTurn: '正在处理上一句，稍后再切换',
            dialing: '正在呼叫', noAnswer: '无法接通（对方无响应）', assistantName: 'DSH 助手',
            voiceSection: '音色', voicePreview: '试听', voicePlaying: '播放中…', voiceUse: '设为当前',
            voiceCurrent: '当前', voiceCount: '个', voiceLoading: '读取音色…',
            voiceSet: '已设为当前音色', voiceFailed: '音色操作失败',
            voiceSingle: '当前引擎只有 1 个音色；Kokoro 的 103 个音色需要以 DSH_TTS_ENGINE=kokoro 启动 DSH',
            audioSuspended: '音频输出未就绪（已尝试恢复）；若仍听不到，请检查系统输出设备',
            statusLoading: '读取状态…', statusIdle: '空闲', statusBusy: '进行中',
            statusTeammates: '已派队友', statusTasks: '建了任务', statusMessages: '发了消息', statusLast: '最近',
          },
          en: {
            button: 'Call', title: 'Call mode', close: 'Collapse', hangUp: 'Hang up',
            connecting: 'Connecting…', live: 'On call', listening: 'Listening…', thinking: 'Thinking…',
            speaking: 'Speaking…', error: 'Call error', holdToTalk: 'Hold to talk',
            switchToAuto: 'Switch to continuous', switchToPtt: 'Switch to push-to-talk',
            autoOn: 'Continuous: just talk', pttOn: 'Push to talk', autoHint: 'Continuous mode: speak freely; ~3s of silence sends',
            you: 'You', agent: 'Agent', lang: 'en', queued: 'Queued behind the current turn…',
            noSession: 'No session id from the slot (plugin cannot attach to a conversation)',
            attachedTo: 'attached to', sameConversation: 'Connected to this conversation', noConversation: 'No conversation is open',
            hereIsOther: 'You are viewing a different conversation', speechGoesTo: 'Anything you say here goes to:',
            moveToCurrent: 'Move to this conversation', moveConfirmPrefix: 'Move this call from', moveConfirmMiddle: 'to',
            confirm: 'Confirm', cancel: 'Cancel', rebound: 'Moved to this conversation',
            rebindFailed: 'Move failed; still attached to the previous conversation', waitTurn: 'Still processing your last sentence — try again in a moment',
            dialing: 'Calling', noAnswer: 'Could not connect (no answer)', assistantName: 'DSH Assistant',
            voiceSection: 'Voices', voicePreview: 'Preview', voicePlaying: 'Playing…', voiceUse: 'Use',
            voiceCurrent: 'Current', voiceCount: 'voices', voiceLoading: 'Loading voices…',
            voiceSet: 'Now using voice', voiceFailed: 'Voice action failed',
            voiceSingle: 'This engine has a single voice; Kokoro\u2019s 103 voices need DSH started with DSH_TTS_ENGINE=kokoro',
            audioSuspended: 'Audio output was not ready (resume attempted); check your system output device if you still hear nothing',
            statusLoading: 'Loading status…', statusIdle: 'Idle', statusBusy: 'Working',
            statusTeammates: 'teammates', statusTasks: 'tasks', statusMessages: 'messages', statusLast: 'Latest',
          },
        }), 'dsh-call-mode: dictionaries');

        // 会话标题：sessions 服务在就取 displayTitle，取不到退回短 id。
        // 用 ctx.get 而不是把 'sessions' 写进 inject——名字若有出入也不会让插件挂掉。
        const label = (sessionId) => {
          if (!sessionId) return '';
          try {
            const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
            const title = sessions?.list?.getSnapshot?.().byId?.[sessionId]?.displayTitle;
            if (typeof title === 'string' && title !== '') return title;
          } catch { /* 服务不可用就退回短 id */ }
          return sessionId.length > 18 ? `${sessionId.slice(0, 14)}…` : sessionId;
        };
        const center = createCallCenter({ call: httpCall, label });

        // 通话的回收只挂在这里（插件/页面真卸载）；切对话、收起浮层都不回收
        ctx.effect(() => () => center.dispose(), 'dsh-call-mode: 通话回收');

        // 握手：宿主会把它记进 call.log，这样「按钮没出现」时也能远程定位到哪一步。
        // 注意：诊断本身绝不能抛异常，否则会把整个插件挂掉（曾因裸 location 全局踩过）。
        try {
          const win = typeof window !== 'undefined' ? window : undefined;
          httpCall.hello({
            stage: 'client-applied',
            ua: String(win?.navigator?.userAgent ?? '').slice(0, 120),
            here: String(win?.location?.href ?? '').slice(0, 160),
          });
        } catch { /* 诊断失败忽略 */ }

        // 通话浮层：root 作用域的 shell.overlay（kind=list, scope=root），切对话不卸载，
        // 首页等没有会话的界面照样在。UI 与内核都活在 center 里。
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-call-mode-call',
          order: 30,
          locale: NS,
          inject: () => ({ center }),
        }, CallOverlay));

        // 输入栏按钮：入口 + 状态指示（list 型槽位，不与语音插件的 single 麦克风位冲突）
        ctx.slots.inject('conversation.input.right', () => {
          try { httpCall.hello({ stage: 'slot-declared' }); } catch { /* 忽略 */ }
          return ctx.slots.register({
            name: 'conversation.input.right',
            id: 'dsh-call-mode',
            order: 20,
            locale: NS,
            inject: () => ({ call: httpCall, center }),
          }, CallButton);
        });
      },
    };
  },
});
