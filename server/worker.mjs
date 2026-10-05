/**
 * 通话子进程（通话模式的音频引擎）
 *
 * 由宿主插件在进入通话模式时拉起，退出通话模式时终止。
 * 只监听 127.0.0.1 的临时端口，用 Bearer token 认证（与 DSH 自带语音 worker 同样的做法）。
 *
 * 端点：
 *   GET  /health             -> { ok, sttSampleRate, ttsSampleRate, speakers }
 *   POST /stt?language=zh    -> body: 原始 PCM(int16 LE, 16kHz 单声道)  -> { text, seconds }
 *   POST /tts                -> body: { text, speed } -> 流式返回原始 PCM(int16 LE, 16kHz 单声道)
 *   POST /tts?format=wav     -> 同上但返回完整 WAV
 *   POST /cancel             -> 中止当前正在合成的语音（用户插话用）
 *
 * 音频统一 16kHz / 单声道 / int16 LE：浏览器录音、识别、合成、播放四段全部一致，免重采样。
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
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

const log = (...a) => process.stderr.write(`[call-worker] ${a.join(' ')}\n`);

// 模型路径统一由 models.mjs 解析：插件目录优先，可回退到 DSH 自带语音缓存；
// 环境变量可显式覆盖（便于测试与自定义部署）。
const resolved = resolvePaths(MODELS);
const sttModel = process.env.DSH_STT_MODEL || resolved.sttModel;
const sttTokens = process.env.DSH_STT_TOKENS || resolved.sttTokens;
const vadModel = process.env.DSH_STT_VAD || resolved.vad;
const ttsDir = process.env.DSH_TTS_DIR || resolved.ttsDir;
const vocoder = process.env.DSH_TTS_VOCODER || resolved.vocoder;

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
const ttsBase = ttsDir;
const ttsConfig = {
  model: {
    matcha: {
      acousticModel: process.env.DSH_TTS_MODEL || path.join(ttsBase, 'model-steps-3.onnx'),
      vocoder,
      lexicon: path.join(ttsBase, 'lexicon.txt'),
      tokens: path.join(ttsBase, 'tokens.txt'),
      dataDir: path.join(ttsBase, 'espeak-ng-data'),
    },
    numThreads: THREADS,
    provider: 'cpu',
    debug: 0,
  },
  ruleFsts: [
    path.join(ttsBase, 'phone-zh.fst'),
    path.join(ttsBase, 'date-zh.fst'),
    path.join(ttsBase, 'number-zh.fst'),
  ].join(','),
  maxNumSentences: 1,
  silenceScale: 0.2,
};

const t0 = Date.now();
const recognizer = new sherpa.OfflineRecognizer(sttConfig);
log(`STT 就绪 (${Date.now() - t0}ms) ${sttModel}`);
const t1 = Date.now();
const tts = new sherpa.OfflineTts(ttsConfig);
log(`TTS 就绪 (${Date.now() - t1}ms) sampleRate=${tts.sampleRate} speakers=${tts.numSpeakers}`);
const vad = new sherpa.Vad({
  sileroVad: {
    model: vadModel,
    threshold: 0.5,
    minSilenceDuration: 0.5,
    minSpeechDuration: 0.25,
    maxSpeechDuration: 30,
    windowSize: 512,
  },
  sampleRate: SAMPLE_RATE,
  numThreads: THREADS,
  provider: 'cpu',
  debug: 0,
}, 32);

const sttSampleRate = SAMPLE_RATE;
if (tts.sampleRate !== SAMPLE_RATE) {
  // matcha + vocos 固定 16k；若换模型需在此处重采样，先显式失败以免静默出错音
  throw new Error(`TTS 采样率 ${tts.sampleRate} != ${SAMPLE_RATE}，需要在 worker 里加重采样`);
}

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
    return json(200, { ok: true, sttSampleRate, ttsSampleRate: tts.sampleRate, speakers: tts.numSpeakers, pid: process.pid });
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
      const speed = Number(body.speed || 1);
      const asWav = url.searchParams.get('format') === 'wav';
      const generation = ++ttsGeneration;
      const started = Date.now();
      let firstChunkMs = null;
      let sent = 0;
      const pieces = [];

      if (asWav) res.writeHead(200, { 'content-type': 'audio/wav' });
      else res.writeHead(200, { 'content-type': 'audio/pcm', 'x-sample-rate': String(SAMPLE_RATE), 'x-channels': '1', 'x-format': 's16le' });

      const writable = () => !res.writableEnded && !res.destroyed;
      try {
        const audio = await tts.generateAsync({
          text,
          generationConfig: { sid: 0, speed },
          onProgress: ({ samples }) => {
            if (generation !== ttsGeneration) return 0;          // 被新请求/插话取消
            if (!writable()) return 0;
            if (firstChunkMs === null) firstChunkMs = Date.now() - started;
            const pcm = floatToInt16(samples);
            sent += pcm.length;
            if (asWav) pieces.push(pcm);
            else res.write(pcm);
            return 1;
          },
        });
        if (generation !== ttsGeneration) log(`TTS 被取消: ${text.slice(0, 20)}`);
        if (asWav) {
          const data = Buffer.concat(pieces);
          res.end(Buffer.concat([wavHeader(data.length), data]));
        } else {
          res.end();
        }
        log(`TTS "${text.slice(0, 24)}" 首块=${firstChunkMs}ms 总=${Date.now() - started}ms 音频=${(sent / 2 / SAMPLE_RATE).toFixed(2)}s 完成=${audio.samples.length / audio.sampleRate > 0}`);
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
