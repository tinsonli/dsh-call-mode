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
    };

    // ---------------------------------------------------------------- 端点检测
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
     * @returns {{push(rms:number, speaking?:boolean):'none'|'start'|'end'|'max', reset():void, state:string, noiseFloor:number}}
     */
    function createEndpointDetector(options = {}) {
      const frameMs = options.frameMs ?? 64;            // 1024 采样 @16k
      const minSpeechMs = options.minSpeechMs ?? 200;   // 连续有声多久算「开始说话」
      const silenceMs = options.silenceMs ?? 700;       // 静音多久算「说完了」
      const maxUtteranceMs = options.maxUtteranceMs ?? 30000;
      const absFloor = options.absFloor ?? 0.006;       // 绝对下限，防静音室里噪声底趋近 0
      const ratio = options.ratio ?? 3.5;               // 高出噪声底多少倍算有声
      const speakingRatio = options.speakingRatio ?? 2; // 放音期阈值倍数（抗回声）
      let noise = options.noiseFloor ?? 0.004;
      let state = 'idle';
      let speechMs = 0;
      let quietMs = 0;
      let totalMs = 0;

      return {
        get state() { return state; },
        get noiseFloor() { return noise; },
        reset() { state = 'idle'; speechMs = 0; quietMs = 0; totalMs = 0; },
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
          if (totalMs >= maxUtteranceMs) { state = 'idle'; speechMs = 0; quietMs = 0; totalMs = 0; return 'max'; }
          if (quietMs >= silenceMs) { state = 'idle'; speechMs = 0; quietMs = 0; totalMs = 0; return 'end'; }
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
          const pcm = this.#collect();
          this.preRoll = [];
          this.#setState('idle');
          if (pcm.length > TARGET_RATE * 0.2) this.onEvent({ type: 'utterance', pcm });
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

    function CallPanel({ engine, call, sessionId, t, onClose }) {
      const [phase, setPhase] = React.useState('connecting'); // connecting | live | error | closing
      const [status, setStatus] = React.useState(t('connecting'));
      const [level, setLevel] = React.useState(0);
      const [mode, setMode] = React.useState('ptt');
      const [transcript, setTranscript] = React.useState('');
      const [reply, setReply] = React.useState('');
      const [download, setDownload] = React.useState(null);
      const engineRef = React.useRef(null);
      const busyRef = React.useRef(false);
      const queueRef = React.useRef([]);   // agent 思考期间用户说的话排队，不丢

      /** 依次处理排队中的每一段话；同一时刻只有一次往返在飞。 */
      const drain = React.useCallback(async () => {
        if (busyRef.current) return;
        const pcm = queueRef.current.shift();
        if (pcm === undefined) return;
        busyRef.current = true;
        try {
          setStatus(queueRef.current.length > 0 ? t('queued') : t('thinking'));
          const res = unwrap(await call.converse({ sessionId, pcm: b64.fromPcm(pcm), language: t('lang') === 'zh' ? 'zh' : 'auto' }));
          setTranscript(res.transcript || '');
          setReply(res.replyText || '');
          setStatus(t('live'));
          for (const chunk of res.chunks || []) engineRef.current?.play(b64.toPcm(chunk));
        } catch (e) {
          setStatus(`${t('error')}: ${e.message}`);
        } finally {
          busyRef.current = false;
          if (queueRef.current.length > 0) void drain();
        }
      }, [call, sessionId, t]);

      /** 收到一段用户语音：入队并尝试处理（最多留最近 3 段，避免积压）。 */
      const converse = React.useCallback((pcm) => {
        queueRef.current.push(pcm);
        if (queueRef.current.length > 3) queueRef.current.shift();
        void drain();
      }, [drain]);

      React.useEffect(() => {
        let disposed = false;
        // 空闲时轮询「迟到回复」：agent 答得慢时，真实结果会以这种方式补播
        const poll = setInterval(async () => {
          if (disposed || busyRef.current) return;
          const engine = engineRef.current;
          if (!engine || engine.state !== 'idle') return;
          try {
            const res = unwrap(await call.poll({ sessionId }));
            for (const chunk of res?.chunks ?? []) engine.play(b64.toPcm(chunk));
          } catch { /* 轮询失败忽略，下一次再试 */ }
        }, 3000);

        const engine = new CallEngine((ev) => {
          if (disposed) return;
          if (ev.type === 'level') setLevel(ev.level);
          if (ev.type === 'state') {
            if (ev.state === 'recording') setStatus(t('listening'));
            if (ev.state === 'speaking') setStatus(t('speaking'));
            if (ev.state === 'idle') setStatus(t('live'));
          }
          if (ev.type === 'utterance') void converse(ev.pcm);
          if (ev.type === 'bargeIn') { void call.cancel(); engine.stopPlayback(); }
        });
        engineRef.current = engine;
        (async () => {
          try {
            if (!sessionId) throw new Error(t('noSession'));
            let started = unwrap(await call.start({ sessionId }));
            // 首次使用：宿主会先把识别与合成模型下载好（检测若空就下载），
            // 这里把进度显示出来，下完自动接通。
            while (started?.provisioning === true) {
              if (disposed) return;
              const p = started.progress ?? {};
              setPhase('provisioning');
              setDownload(p);
              setStatus(`${t('preparingModels')} ${p.label ?? ''} ${p.percent ?? 0}%`.trim());
              await new Promise((r) => setTimeout(r, 1500));
              if (disposed) return;
              const st = unwrap(await call.provision());
              if (st?.phase === 'failed') throw new Error(`${t('provisionFailed')}：${st.detail ?? ''}`);
              started = st?.phase === 'ready'
                ? unwrap(await call.start({ sessionId }))
                : { provisioning: true, progress: st };
            }
            await engine.open();
            if (!disposed) { setPhase('live'); setStatus(t('live')); }
            // 接通问候由宿主合成，播放它即证明「说」的通路正常
            if (started?.greeting) engine.play(b64.toPcm(started.greeting));
          } catch (e) {
            if (!disposed) { setPhase('error'); setStatus(`${t('error')}: ${e.message}`); }
          }
        })();
        return () => {
          disposed = true;
          clearInterval(poll);
          engine.close();
          void call.stop();
        };
      }, [call, sessionId, converse, t]);

      const toggleMode = () => {
        const next = mode === 'ptt' ? 'auto' : 'ptt';
        setMode(next);
        engineRef.current?.setMode(next);
        setStatus(next === 'auto' ? t('autoOn') : t('pttOn'));
      };

      const pttDown = () => { engineRef.current?.stopPlayback(); engineRef.current?.startCapture(); };
      const pttUp = () => {
        const pcm = engineRef.current?.stopCapture();
        if (pcm && pcm.length > TARGET_RATE * 0.2) void converse(pcm);
      };

      return h('div', { style: panelStyle, onClick: (e) => e.stopPropagation() },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('strong', null, t('title')),
          h('button', { type: 'button', 'aria-label': t('close'), onClick: onClose,
            style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 14 } }, '×')),
        h('div', { style: { marginTop: 6, color: 'var(--dsw-alias-label-secondary, #666)' } }, status),
        h('div', { style: { marginTop: 8, height: 6, borderRadius: 3, background: 'var(--dsw-alias-border-l1, #ddd)', overflow: 'hidden' } },
          h('div', { style: { width: `${Math.min(100, Math.round((level / 0.15) * 100))}%`, height: '100%', background: 'var(--dsw-alias-brand-primary, #3b82f6)', transition: 'width .06s linear' } })),
        mode === 'ptt'
          ? h('button', {
              type: 'button', disabled: phase !== 'live',
              onPointerDown: pttDown, onPointerUp: pttUp, onPointerLeave: pttUp,
              style: { ...smallBtn, marginTop: 10, width: '100%', padding: '14px 10px', background: 'var(--dsw-alias-interactive-bg-hover, #f2f4f7)' },
            }, t('holdToTalk'))
          : h('div', { style: { ...rowStyle, color: 'var(--dsw-alias-label-secondary, #666)' } }, t('autoHint')),
        h('div', { style: rowStyle },
          h('button', { type: 'button', style: smallBtn, onClick: toggleMode }, mode === 'ptt' ? t('switchToAuto') : t('switchToPtt')),
          h('button', { type: 'button', style: smallBtn, onClick: onClose }, t('hangUp'))),
        transcript !== '' && h('div', { style: { ...rowStyle, display: 'block', color: 'var(--dsw-alias-label-secondary, #666)' } }, `${t('you')}: ${transcript}`),
        reply !== '' && h('div', { style: { ...rowStyle, display: 'block' } }, `${t('agent')}: ${reply}`));
    }

    // ---------------------------------------------------------------- 通话按钮
    function CallButton({ call, sessionId, t }) {
      const [open, setOpen] = React.useState(false);
      const wrapRef = React.useRef(null);

      React.useEffect(() => {
        if (!open) return;
        const onDocClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
        const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onEsc);
        return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onEsc); };
      }, [open]);

      return h('div', { ref: wrapRef, style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button', 'aria-label': t('button'), 'aria-pressed': open,
          title: sessionId ? t('button') : t('noSession'), onClick: () => setOpen((v) => !v),
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28,
            padding: 0, border: 'none', borderRadius: 'var(--dsw-radius-sm, 6px)', cursor: 'pointer',
            background: open ? 'var(--dsw-alias-interactive-bg-active, #eaeef5)' : 'transparent',
            color: open ? 'var(--dsw-alias-brand-primary, #3b82f6)' : 'var(--dsw-alias-label-secondary, #666)',
          },
        }, h(IconCall, { active: open })),
        open && h(CallPanel, { call, sessionId, t, onClose: () => setOpen(false) }));
    }

    return {
      // 只依赖槽位与词典；控制通道走同源路由，不占用 DSH 的 remote 命名空间
      inject: ['slots', 'locale'],
      // 测试缝：脱离麦克风验证端点检测状态机（加载器只读 inject/apply，多余字段无副作用）
      __internals: { createEndpointDetector, b64 },
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            button: '通话', title: '通话模式', close: '收起', hangUp: '挂断',
            connecting: '正在接入…', live: '通话中', listening: '在听…', thinking: '正在思考…',
            speaking: '正在说话…', error: '通话出错', holdToTalk: '按住说话',
            switchToAuto: '切到连续对话', switchToPtt: '切到按住说话',
            autoOn: '连续对话：直接说话即可', pttOn: '按住说话', autoHint: '连续对话中：直接说话，静音约 0.7 秒即自动发送',
            you: '你说', agent: '助手', lang: 'zh', queued: '上一轮还没回来，已排队',
            noSession: '拿不到当前会话 ID（插件槽位未提供 sessionId）',
          },
          en: {
            button: 'Call', title: 'Call mode', close: 'Collapse', hangUp: 'Hang up',
            connecting: 'Connecting…', live: 'On call', listening: 'Listening…', thinking: 'Thinking…',
            speaking: 'Speaking…', error: 'Call error', holdToTalk: 'Hold to talk',
            switchToAuto: 'Switch to continuous', switchToPtt: 'Switch to push-to-talk',
            autoOn: 'Continuous: just talk', pttOn: 'Push to talk', autoHint: 'Continuous mode: speak freely; ~0.7s of silence sends',
            you: 'You', agent: 'Agent', lang: 'en', queued: 'Queued behind the current turn…',
            noSession: 'No session id from the slot (plugin cannot attach to a conversation)',
          },
        }), 'dsh-call-mode: dictionaries');

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

        // 放在输入栏工具条（list 型槽位，不与语音插件的 single 麦克风位冲突）
        ctx.slots.inject('conversation.input.right', () => {
          try { httpCall.hello({ stage: 'slot-declared' }); } catch { /* 忽略 */ }
          return ctx.slots.register({
            name: 'conversation.input.right',
            id: 'dsh-call-mode',
            order: 20,
            locale: NS,
            inject: () => ({ call: httpCall }),
          }, CallButton);
        });
      },
    };
  },
});
