/**
 * 通话子进程（通话模式的音频引擎）
 *
 * 由宿主插件在进入通话模式时拉起，退出通话模式时终止。
 * 只监听 127.0.0.1 的临时端口，用 Bearer token 认证（与 DSH 自带语音 worker 同样的做法）。
 *
 * 端点：
 *   GET  /health             -> { ok, sttSampleRate, ttsSampleRate, ttsModelSampleRate, engine, sid, speakers }
 *   POST /stt?language=zh    -> body: 原始 PCM(int16 LE, 16kHz 单声道)  -> { text, seconds }
 *   POST /tts                -> body: { text, speed } -> 流式返回原始 PCM(int16 LE, 16kHz 单声道)
 *   POST /tts?format=wav     -> 同上但返回完整 WAV
 *   POST /cancel             -> 中止当前正在合成的语音（用户插话用）
 *
 * 对外音频统一 16kHz / 单声道 / int16 LE：浏览器录音、识别、合成、播放四段全部一致。
 * TTS 模型本身可能是 24kHz（Kokoro），差异在 worker 内重采样，客户端假设不变。
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolvePaths } from './models.mjs';

const require = createRequire(import.meta.url);

/** 解析 sherpa-onnx 原生包：优先宿主传入的绝对路径（asar 内路径只对 Electron 可读）。 */
function loadSherpa() {
  const attempts = [];
  if (process.env.DSH_SHERPA_PATH) attempts.push(process.env.DSH_SHERPA_PATH);
  attempts.push('sherpa-onnx-node');
  // 兜底：从可执行文件位置推导安装目录里的 asar 路径（Electron-as-Node 可读 asar）
  const guess = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', 'sherpa-onnx-node');
  attempts.push(guess);
  const errors = [];
  for (const spec of attempts) {
    try { return require(spec); } catch (e) { errors.push(`${spec}: ${e.code || e.message}`); }
  }
  throw new Error(`无法加载 sherpa-onnx-node，尝试过：\n  ${errors.join('\n  ')}`);
}

const sherpa = loadSherpa();
const MODELS = process.env.DSH_CALL_MODELS || path.join(homedir(), '.dsh', 'call-mode', 'models');
const token = process.env.DSH_CALL_TOKEN || '';
const THREADS = Number(process.env.DSH_CALL_THREADS || 4);
const SAMPLE_RATE = 16000;
/**
 * TTS 引擎：`matcha`（默认，MatchaTTS + Vocos 16kHz，首块延迟几十毫秒）
 * 或 `kokoro`（可选，Kokoro 多语言 v1.1，24kHz、103 音色，音色更好但首块约 1s）。
 * 无论选哪个，对客户端都输出 16kHz int16 —— 采样率差异在 worker 内消化。
 */
const TTS_ENGINE_WANTED = String(process.env.DSH_TTS_ENGINE || 'matcha').toLowerCase() === 'kokoro' ? 'kokoro' : 'matcha';
/** Kokoro 音色编号（0–102）。默认 4：中英混读实测最清楚的一档。 */
const TTS_SID = Number(process.env.DSH_TTS_SID || 4);

/**
 * 合成前的读音白名单（多音字/词表数据错误）。
 *
 * 背景（实测见 quality-lab/polyphone）：matcha 的 lexicon.txt 写的是 `重载 zhong4 zai4`，
 * kokoro 的 lexicon-zh.txt 写的是 `ㄓ 中 4 ㄗ ㄞ 4`——同样是 zhong4 zai4，**两个引擎都念
 * zhòng zài**，属于上游词表数据错误（正确是 chóng zài）。换引擎修不了，就地改词表又会被
 * models.mjs 的 SHA-256 校验判为无效并重下，所以在送进合成之前按词换成同音字：
 * 虫 chong2 + 在 zai4 = chóng zài（这两条在两个引擎的词表里都是对的）。
 *
 * 纪律：
 *  - 只加**逐词实测确认会念错、且替换字在词表里读音正确**的词；没测过的一律不加；
 *  - 只改「送进合成的文本」——屏幕显示、宿主 replyText、/tts 的响应都不经过这里；
 *  - 按整词匹配，不做任何泛化（「载重 / 满载 / 重装 / 重要 / 重新」必须原样）；
 *  - `DSH_TTS_PRONOUNCE=0` 可整体关闭，恢复旧行为。
 */
const PRONUNCIATION_FIXES = [
  { from: '重载', to: '虫在' },
];
const PRONOUNCE_FIX_ON = process.env.DSH_TTS_PRONOUNCE !== '0';

/** 返回「送进合成的文本」与命中记录；关闭开关时原样返回。 */
function applyPronunciationFixes(text) {
  if (!PRONOUNCE_FIX_ON) return { spoken: text, hits: [] };
  let spoken = text;
  const hits = [];
  for (const { from, to } of PRONUNCIATION_FIXES) {
    if (!spoken.includes(from)) continue;
    spoken = spoken.split(from).join(to);
    hits.push(`${from} → ${to}`);
  }
  return { spoken, hits };
}

const log = (...a) => process.stderr.write(`[call-worker] ${a.join(' ')}\n`);

// 模型路径统一由 models.mjs 解析：插件目录优先，可回退到 DSH 自带语音缓存；
// 环境变量可显式覆盖（便于测试与自定义部署）。
const resolved = resolvePaths(MODELS);
const sttModel = process.env.DSH_STT_MODEL || resolved.sttModel;
const sttTokens = process.env.DSH_STT_TOKENS || resolved.sttTokens;
const vadModel = process.env.DSH_STT_VAD || resolved.vad;
const ttsDir = process.env.DSH_TTS_DIR || resolved.ttsDir;
const vocoder = process.env.DSH_TTS_VOCODER || resolved.vocoder;
const kokoroDir = process.env.DSH_TTS_KOKORO_DIR || resolved.kokoroDir;

/** 某引擎的关键模型文件是否都在磁盘上。 */
function engineModelsPresent(engine) {
  const need = engine === 'kokoro'
    ? [path.join(kokoroDir, 'model.onnx'), path.join(kokoroDir, 'voices.bin'), path.join(kokoroDir, 'tokens.txt'), path.join(kokoroDir, 'espeak-ng-data', 'phontab')]
    : [process.env.DSH_TTS_MODEL || path.join(ttsDir, 'model-steps-3.onnx'), vocoder, path.join(ttsDir, 'tokens.txt'), path.join(ttsDir, 'espeak-ng-data', 'phontab')];
  return need.every((f) => fs.existsSync(f));
}

/**
 * 宿主的 models.mjs 是 DSH 启动时加载进内存的，worker 却是每次通话新起的进程，
 * 所以"改了默认引擎但还没重启 DSH"的窗口里，两边可能不一致（宿主按旧默认准备模型、
 * worker 按新默读取模型）。这时按"磁盘上谁的模型齐"来选：宁可音色不是首选，
 * 也不能让电话打不通。两边一致时（正常情况）这里什么都不会发生。
 */
let TTS_ENGINE = TTS_ENGINE_WANTED;
if (!engineModelsPresent(TTS_ENGINE)) {
  const other = TTS_ENGINE === 'kokoro' ? 'matcha' : 'kokoro';
  if (engineModelsPresent(other)) {
    log(`TTS 引擎 ${TTS_ENGINE} 的模型不齐，回退到 ${other}（重启 DSH 后宿主与 worker 的默认值才会一致）`);
    TTS_ENGINE = other;
  }
}

/**
 * Kokoro 的 speed 是"长度缩放"，实测加速就吞字：1.10 起开始出错，1.25 三句全部
 * 识别失败（1.0 三句全对）。旧 Matcha 不受影响（它的 1.25 是用户要的语速），
 * 所以只对 Kokoro 钳一个实测安全上限；要放行设 DSH_TTS_ALLOW_FAST=1。
 */
const TTS_MAX_SPEED = TTS_ENGINE === 'kokoro' && process.env.DSH_TTS_ALLOW_FAST !== '1' ? 1.0 : Infinity;

// ---------------------------------------------------------------- 语音识别
const sttConfig = {
  featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
  modelConfig: {
    senseVoice: { model: sttModel, language: 'auto', useInverseTextNormalization: 1 },
    tokens: sttTokens,
    numThreads: THREADS,
    provider: 'cpu',
    debug: 0,
  },
};

// ---------------------------------------------------------------- 语音合成
// 两个引擎共用同一个 /tts 出口（16kHz int16 PCM），切换只影响模型与音色。
function buildTtsConfig() {
  const common = { numThreads: THREADS, provider: 'cpu', debug: 0 };
  if (TTS_ENGINE === 'kokoro') {
    const dir = kokoroDir;
    return {
      model: {
        kokoro: {
          model: process.env.DSH_TTS_MODEL || path.join(dir, 'model.onnx'),
          voices: path.join(dir, 'voices.bin'),
          tokens: path.join(dir, 'tokens.txt'),
          dataDir: path.join(dir, 'espeak-ng-data'),
          // 中英混读：中文查 zh 词表，英文查 us-en 词表（按顺序匹配）
          lexicon: [path.join(dir, 'lexicon-us-en.txt'), path.join(dir, 'lexicon-zh.txt')].join(','),
        },
        ...common,
      },
      ruleFsts: [
        path.join(dir, 'phone-zh.fst'),
        path.join(dir, 'date-zh.fst'),
        path.join(dir, 'number-zh.fst'),
      ].join(','),
      maxNumSentences: 1,
      silenceScale: 0.2,
    };
  }
  if (TTS_ENGINE === 'matcha') {
    const ttsBase = ttsDir;
    return {
      model: {
        matcha: {
          acousticModel: process.env.DSH_TTS_MODEL || path.join(ttsBase, 'model-steps-3.onnx'),
          vocoder,
          lexicon: path.join(ttsBase, 'lexicon.txt'),
          tokens: path.join(ttsBase, 'tokens.txt'),
          dataDir: path.join(ttsBase, 'espeak-ng-data'),
        },
        ...common,
      },
      ruleFsts: [
        path.join(ttsBase, 'phone-zh.fst'),
        path.join(ttsBase, 'date-zh.fst'),
        path.join(ttsBase, 'number-zh.fst'),
      ].join(','),
      maxNumSentences: 1,
      silenceScale: 0.2,
    };
  }
  throw new Error(`未知的 TTS 引擎 DSH_TTS_ENGINE=${TTS_ENGINE}（可用：kokoro / matcha）`);
}

const t0 = Date.now();
const recognizer = new sherpa.OfflineRecognizer(sttConfig);
log(`STT 就绪 (${Date.now() - t0}ms) ${sttModel}`);
const t1 = Date.now();
const tts = new sherpa.OfflineTts(buildTtsConfig());
log(`TTS 就绪 (${Date.now() - t1}ms) 引擎=${TTS_ENGINE} sampleRate=${tts.sampleRate} speakers=${tts.numSpeakers}`);
const vad = new sherpa.Vad({
  sileroVad: {
    model: vadModel,
    threshold: 0.5,
    minSilenceDuration: 0.5,
    minSpeechDuration: 0.25,
    // 与客户端的 maxUtteranceMs（client.js: 60000）对齐：客户端最多送来 60s 的整段，
    // VAD 在这里再切一刀只会在段边界丢字，所以上限跟着放到 60。
    maxSpeechDuration: 60,
    windowSize: 512,
  },
  sampleRate: SAMPLE_RATE,
  numThreads: THREADS,
  provider: 'cpu',
  debug: 0,
}, 32);

const sttSampleRate = SAMPLE_RATE;
// 模型采样率可能与链路不同（Kokoro 24kHz / Matcha 16kHz）。这里不再直接失败，
// 而是把差异在 worker 内消化：客户端播放、STT、/tts 的 PCM 全部保持 16kHz 假设。
const ttsModelRate = tts.sampleRate;

// ---------------------------------------------------------------- 工具
function int16ToFloat(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

function floatToInt16(samples) {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  return out;
}

/**
 * 流式重采样（模型采样率 -> 16kHz），两块边界都不产生咔哒声：
 *  1) 33 抽头加窗 sinc 低通，截止在输出奈奎斯特（24k→16k 时砍掉 8–12kHz，
 *     否则会折叠回可听频段，这正是"音质变差"最常见的来源）；
 *  2) 线性插值，把小数读取位置和"右邻居"跨 chunk 保留，flush 时补齐尾巴。
 * 输入输出同采样率时是零拷贝直通。纯 JS，单声道，开销远小于 TTS 推理本身。
 */
function createResampler(inRate, outRate) {
  if (inRate === outRate) return { push: (s) => s, flush: () => new Float32Array(0) };
  const taps = 33;
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  const cutoff = 0.5 * (outRate / inRate) * 0.94;   // 留 6% 过渡带
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const x = n - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
    h[n] = sinc * w;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;       // 直流增益归一

  const step = inRate / outRate;
  const histLen = taps - 1;
  let hist = new Float32Array(histLen);
  let started = false;
  let cur = new Float32Array(0);   // 当前块（滤波后），覆盖全局 [base, base+len)
  let base = 0;
  let carry = 0;                   // 上一块最后一个样本（全局 base-1）
  let hasCarry = false;
  let pos = 0;                     // 下一个输出样本的全局输入位置（含小数）
  let ended = false;

  const sampleAt = (g) => {
    const j = g - base;
    if (j === -1) return hasCarry ? carry : null;
    if (j >= 0 && j < cur.length) return cur[j];
    return null;
  };
  const drain = (out) => {
    for (;;) {
      const i0 = Math.floor(pos);
      const a = sampleAt(i0);
      if (a === null) break;                       // 左端点未到 / flush 后越界
      let b = sampleAt(i0 + 1);
      if (b === null) {
        if (!ended) break;                         // 右邻居还没来，等下一块
        b = a;                                     // 末端保持最后一点，避免拖尾
      }
      const f = pos - i0;
      out.push(a * (1 - f) + b * f);
      pos += step;
    }
  };

  return {
    push(chunk) {
      if (chunk.length === 0) return new Float32Array(0);
      if (!started) { hist.fill(chunk[0]); started = true; }   // 避免起始淡入
      const x = new Float32Array(histLen + chunk.length);
      x.set(hist, 0);
      x.set(chunk, histLen);
      const y = new Float32Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        let acc = 0;
        for (let k = 0; k < taps; k++) acc += h[k] * x[i + histLen - k];
        y[i] = acc;
      }
      hist = x.slice(x.length - histLen);
      if (cur.length > 0) { base += cur.length; carry = cur[cur.length - 1]; hasCarry = true; }
      cur = y;
      const out = [];
      drain(out);
      return Float32Array.from(out);
    },
    flush() {
      ended = true;
      const out = [];
      drain(out);
      return Float32Array.from(out);
    },
  };
}

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** 用 VAD 切出语音段，逐段识别 */
function transcribePcm(pcm, language) {
  const samples = int16ToFloat(pcm);
  sttConfig.modelConfig.senseVoice.language = language;
  recognizer.setConfig(sttConfig);
  vad.reset();
  const texts = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: segment.samples });
      recognizer.decode(stream);
      texts.push(recognizer.getResult(stream).text.trim());
      vad.pop();
    }
  };
  for (let off = 0; off < samples.length; off += 512) {
    vad.acceptWaveform(samples.subarray(off, off + 512));
    drain();
  }
  vad.flush();
  drain();
  return { text: texts.filter(Boolean).join(' ').trim(), seconds: samples.length / SAMPLE_RATE };
}

// 当前合成的取消标记（用户插话 / 新请求到来时置位）
let ttsGeneration = 0;

// ---------------------------------------------------------------- HTTP
const server = createServer((req, res) => {
  const auth = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (token === '' || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

  if (req.method === 'GET' && url.pathname === '/health') {
    req.resume();
    return json(200, {
      ok: true,
      sttSampleRate,
      ttsSampleRate: SAMPLE_RATE,        // 对客户端输出恒为 16k
      ttsModelSampleRate: ttsModelRate,  // 模型原生采样率（Kokoro 24k / Matcha 16k）
      engine: TTS_ENGINE,
      sid: TTS_SID,
      speakers: tts.numSpeakers,
      // 合成前读音白名单的状态（只影响音频，不改变任何返回文本）
      pronunciationFix: { enabled: PRONOUNCE_FIX_ON, entries: PRONUNCIATION_FIXES.map((f) => `${f.from}→${f.to}`) },
      pid: process.pid,
    });
  }

  if (req.method === 'POST' && url.pathname === '/cancel') {
    req.resume();
    ttsGeneration++;
    return json(200, { ok: true, cancelled: ttsGeneration });
  }

  if (req.method === 'POST' && url.pathname === '/stt') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const pcm = Buffer.concat(chunks);
        const language = url.searchParams.get('language') || 'auto';
        const started = Date.now();
        const out = transcribePcm(pcm, language);
        log(`STT ${(out.seconds).toFixed(2)}s 音频 -> ${Date.now() - started}ms: ${out.text}`);
        json(200, out);
      } catch (e) {
        log('STT 失败', e.message);
        json(500, { error: String(e.message || e) });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/tts') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return json(400, { error: 'invalid json' }); }
      const text = String(body.text || '').trim();
      if (text === '') return json(400, { error: 'empty text' });
      // 只有"送进合成"的这一份文本会被替换；text 保持原文，日志与后续逻辑都用原文。
      const { spoken, hits } = applyPronunciationFixes(text);
      if (hits.length) log(`TTS 读音替换: ${hits.join('、')}`);
      const requestedSpeed = Number(body.speed || 1);
      const speed = Math.min(Number.isFinite(requestedSpeed) && requestedSpeed > 0 ? requestedSpeed : 1, TTS_MAX_SPEED);
      if (speed !== requestedSpeed) log(`语速 ${requestedSpeed} -> ${speed}（Kokoro 实测安全上限，DSH_TTS_ALLOW_FAST=1 可放行）`);
      // 可选 sid：通话中按请求换音色（试听用）。缺省沿用启动时的配置值；
      // 非法/越界一律 400 —— 不能让一个坏参数把整个语音子进程打挂。
      let sid = TTS_SID;
      if (body.sid !== undefined && body.sid !== null && body.sid !== '') {
        const n = Number(body.sid);
        if (!Number.isInteger(n) || n < 0 || n >= tts.numSpeakers) {
          return json(400, { error: `sid 必须是 0..${tts.numSpeakers - 1} 之间的整数`, sid: body.sid, speakers: tts.numSpeakers, defaultSid: TTS_SID });
        }
        sid = n;
      }
      const asWav = url.searchParams.get('format') === 'wav';
      const generation = ++ttsGeneration;
      const started = Date.now();
      let firstChunkMs = null;
      let sent = 0;
      const pieces = [];

      if (asWav) res.writeHead(200, { 'content-type': 'audio/wav' });
      else res.writeHead(200, { 'content-type': 'audio/pcm', 'x-sample-rate': String(SAMPLE_RATE), 'x-channels': '1', 'x-format': 's16le' });

      const writable = () => !res.writableEnded && !res.destroyed;
      // 每个请求一份重采样状态（跨 chunk 连续），保证输出恒为 16kHz
      const resampler = createResampler(tts.sampleRate, SAMPLE_RATE);
      const emit = (samples16k) => {
        if (samples16k.length === 0) return;
        if (firstChunkMs === null) firstChunkMs = Date.now() - started;
        const pcm = floatToInt16(samples16k);
        sent += pcm.length;
        if (asWav) pieces.push(pcm);
        else res.write(pcm);
      };
      try {
        const audio = await tts.generateAsync({
          text: spoken,
          generationConfig: { sid, speed },
          // Electron-as-Node 下 V8 内存笼不接受外部缓冲：不关掉它，generateAsync
          // 会走原生 reject 路径（每句都记 “TTS settlement failed”），成功日志与
          // ?format=wav 随之失效，且可能只送出半句音频。与 VAD 的 front(false) 同因。
          enableExternalBuffer: false,
          onProgress: ({ samples }) => {
            if (generation !== ttsGeneration) return 0;          // 被新请求/插话取消
            if (!writable()) return 0;
            emit(resampler.push(samples));
            return 1;
          },
        });
        emit(resampler.flush());                                 // 补齐重采样尾部
        if (firstChunkMs === null) firstChunkMs = Date.now() - started;
        if (generation !== ttsGeneration) log(`TTS 被取消: ${text.slice(0, 20)}`);
        if (asWav) {
          const data = Buffer.concat(pieces);
          res.end(Buffer.concat([wavHeader(data.length), data]));
        } else {
          res.end();
        }
        log(`TTS "${text.slice(0, 24)}" sid=${sid} speed=${speed} 首块=${firstChunkMs}ms 总=${Date.now() - started}ms 音频=${(sent / 2 / SAMPLE_RATE).toFixed(2)}s ${ttsModelRate === SAMPLE_RATE ? '' : `${ttsModelRate}Hz→${SAMPLE_RATE}Hz `}完成=${audio.samples.length / audio.sampleRate > 0}`);
      } catch (e) {
        log('TTS 失败', e.message);
        if (writable()) res.end();
      }
    });
    return;
  }

  req.resume();
  return json(404, { error: 'unknown endpoint' });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port, pid: process.pid })}\n`);
});
