/**
 * 模型自动准备（首次使用/文件缺失时下载并校验）。
 *
 * 设计要点：
 *  - **检测若空就下载**：每个文件都按「大小 + SHA-256」判定有效，有效就跳过；
 *  - **优先复用 DSH 自带的 SenseVoice 缓存**，避免重复占用 240MB 磁盘；
 *  - 下载源只用实测可通的通道：GitHub release 走 gh-proxy 反代，
 *    个别文件走 hf-mirror + DoH 取真实 IP（本机 DNS 会把 huggingface.co /
 *    github.com / *.hf.co 投毒到拦截设备，直连会报证书不受信任）；
 *  - 所有产物下载后校验 SHA-256，校验不过就重试，绝不放行半个文件。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** GitHub release 反代：本机 github.com 被劫持，这个前缀实测可通。 */
const GH = 'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download';
const HF = 'https://hf-mirror.com';

/** STT（SenseVoice INT8）——与 DSH 官方语音插件同一份权重。 */
export const STT_MODEL = { name: 'model.int8.onnx', bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' };
export const STT_TOKENS = { name: 'tokens.txt', bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' };
export const VAD_MODEL = { name: 'silero_vad.onnx', bytes: 1807522, sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28' };

/** TTS（MatchaTTS zh-en，16kHz）。 */
export const TTS_ACOUSTIC = { name: 'model-steps-3.onnx', bytes: 75717082, sha256: '524286bf6cf11be74329ae1c682ac69e34d6860c2ea9fd1290319d561540b16a' };
export const TTS_VOCODER = { name: 'vocos-16khz-univ.onnx', bytes: 53882848, sha256: 'b599142a1fb8ff03de3e84ac35ff537c619e56f4267a6fe894851a42844acf9e' };

const STT_TAR = {
  file: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
  url: `${GH}/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`,
  bytes: 163002883,
  innerDir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
};
const TTS_TAR = {
  file: 'matcha-icefall-zh-en.tar.bz2',
  url: `${GH}/tts-models/matcha-icefall-zh-en.tar.bz2`,
  bytes: 79033838,
  sha256: '271b804af570400d3bcdcb53bf6e53cc9f75180ee763b9f13eb5eaf2b0d086ef',
  innerDir: 'matcha-icefall-zh-en',
};

// 固定校验值的自检：必须是 64 位十六进制。抄写时少一个字符会让「好文件被判为坏」，
// 而前若干位又往往相同，人工比对极难发现（本项目就踩过一次）。
for (const [label, sha] of [
  ['STT_MODEL', STT_MODEL.sha256], ['STT_TOKENS', STT_TOKENS.sha256], ['VAD_MODEL', VAD_MODEL.sha256],
  ['TTS_ACOUSTIC', TTS_ACOUSTIC.sha256], ['TTS_VOCODER', TTS_VOCODER.sha256], ['TTS_TAR', TTS_TAR.sha256],
]) {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`models.mjs: ${label}.sha256 必须是 64 位小写十六进制，实际长度 ${sha?.length}`);
}

/** 各文件在插件模型目录里的落点。 */
export function targetPaths(root) {
  return {
    sttModel: path.join(root, 'sensevoice', STT_MODEL.name),
    sttTokens: path.join(root, 'sensevoice', STT_TOKENS.name),
    vad: path.join(root, 'silero_vad.onnx'),
    ttsDir: path.join(root, TTS_TAR.innerDir),
    ttsModel: path.join(root, TTS_TAR.innerDir, TTS_ACOUSTIC.name),
    vocoder: path.join(root, TTS_VOCODER.name),
  };
}

/** DSH 自带语音插件的缓存（存在且有效就复用，不必重复下载 240MB）。 */
function dshSttCache() {
  return path.join(os.homedir(), '.dsh', 'speech-to-text', 'sensevoice', 'models');
}

/** 解析实际可用的文件：插件目录优先，找不到再看 DSH 缓存。 */
export function resolvePaths(root) {
  const t = targetPaths(root);
  const cache = dshSttCache();
  const pick = (mine, theirs) => (fs.existsSync(mine) ? mine : theirs);
  return {
    sttModel: pick(t.sttModel, path.join(cache, 'sensevoice-onnx', STT_MODEL.name)),
    sttTokens: pick(t.sttTokens, path.join(cache, 'sensevoice-onnx', STT_TOKENS.name)),
    vad: pick(t.vad, path.join(cache, 'silero', VAD_MODEL.name)),
    ttsDir: t.ttsDir,
    ttsModel: t.ttsModel,
    vocoder: t.vocoder,
  };
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

/** 大小 + SHA-256 双重校验。 */
export async function isValid(file, asset) {
  try {
    if (!fs.existsSync(file)) return false;
    if (asset.bytes !== undefined && fs.statSync(file).size !== asset.bytes) return false;
    if (asset.sha256 !== undefined && (await sha256File(file)) !== asset.sha256) return false;
    return true;
  } catch { return false; }
}

function run(cmd, args, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}: ${err.slice(0, 300)}`))));
  });
}

/** 用 DoH 取真实 IP，绕开被投毒的本地 DNS。 */
async function resolveRealIp(host) {
  for (const url of [`https://dns.alidns.com/resolve?name=${host}&type=A`, `https://doh.pub/dns-query?name=${host}&type=A`]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const json = await res.json();
      const ips = (json.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
      if (ips.length > 0) return ips;
    } catch { /* 换下一个 DoH */ }
  }
  return [];
}

/** 下载一个文件到 .partial，再原子落位；期间上报进度。 */
async function download({ url, file: fileArg, bytes, sha256, resolveHost, log, onProgress, label }) {
  const file = path.resolve(fileArg);          // 传进来的可能是文件名，统一解析成绝对路径
  const partial = `${file}.partial`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let pinnedIp;
  if (resolveHost) {
    const ips = await resolveRealIp(resolveHost);
    pinnedIp = ips[0];
    if (pinnedIp === undefined) log(`${label}: 未取到 ${resolveHost} 真实 IP，直连尝试`);
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (await isValid(file, { bytes, sha256 })) return true;
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    const args = ['-sS', '-L', '--max-time', '3600', '--retry', '2', '--retry-delay', '2', '-o', partial, '-w', '%{http_code}'];
    if (pinnedIp) args.push('--resolve', `${resolveHost}:443:${pinnedIp}`);
    if (fs.existsSync(partial)) args.push('-C', '-');
    args.push(url);
    log(`${label}: 第 ${attempt} 次下载 ${url.slice(0, 90)}`);
    const watch = setInterval(() => {
      try {
        const got = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
        onProgress({ phase: 'downloading', label, percent: bytes ? Math.min(99, Math.round((got / bytes) * 100)) : 0, detail: `${(got / 1048576).toFixed(0)}/${bytes ? (bytes / 1048576).toFixed(0) : '?'} MB` });
      } catch { /* 忽略 */ }
    }, 700);
    const code = await run('curl.exe', args, log).then(() => '0', () => '1');
    clearInterval(watch);
    if (code !== '0') log(`${label}: curl 失败`);
    if (fs.existsSync(partial)) {
      fs.rmSync(file, { force: true });
      fs.renameSync(partial, file);
      if (await isValid(file, { bytes, sha256 })) { log(`${label}: 完成并校验通过`); return true; }
      const gotSize = fs.existsSync(file) ? fs.statSync(file).size : -1;
      const gotSha = gotSize > 0 ? await sha256File(file) : 'n/a';
      log(`${label}: 校验不通过（实测 ${gotSize}/${bytes ?? '?'} 字节，sha256 ${String(gotSha).slice(0, 16)} vs 期望 ${String(sha256).slice(0, 16)}），重试`);
    } else {
      log(`${label}: 没有产生下载文件`);
    }
  }
  return false;
}

/** 解包 .tar.bz2（Windows 自带 bsdtar 支持 bz2）。 */
async function extractTar(archive, destDir, log) {
  fs.mkdirSync(destDir, { recursive: true });
  log(`解包 ${path.basename(archive)}`);
  await run('tar.exe', ['-xjf', archive, '-C', destDir], log);
}

/**
 * 确保全部模型就绪：逐个检查，缺哪个补哪个。
 * @param {{root: string, log?: Function, onProgress?: Function, force?: boolean}} options
 * @returns {Promise<{ok: boolean, missing: string[], reused: number, downloaded: number}>}
 */
export async function ensureModels({ root, log = () => {}, onProgress = () => {} }) {
  const t = targetPaths(root);
  const cache = dshSttCache();
  const tmp = path.join(root, '.tmp');
  const missing = [];
  let reused = 0;
  let downloaded = 0;

  const totalSteps = 5;
  let step = 0;
  const report = (label, percent, detail) => onProgress({ phase: 'downloading', label, percent: Math.round(((step + percent / 100) / totalSteps) * 100), detail });
  const nextStep = () => { step += 1; };

  // 1) 识别模型（优先复用 DSH 缓存，其次插件目录）
  const sttModelCandidates = [path.join(cache, 'sensevoice-onnx', STT_MODEL.name), t.sttModel];
  const sttTokenCandidates = [path.join(cache, 'sensevoice-onnx', STT_TOKENS.name), t.sttTokens];
  const sttOk = (await isValid(sttModelCandidates[0], STT_MODEL)) && (await isValid(sttTokenCandidates[0], STT_TOKENS));
  const sttOkLocal = (await isValid(t.sttModel, STT_MODEL)) && (await isValid(t.sttTokens, STT_TOKENS));
  if (sttOk || sttOkLocal) {
    log(`识别模型已存在，跳过下载（${sttOk ? '复用 DSH 语音缓存' : '复用插件目录'}）`);
    reused += 1;
  } else {
    report('语音识别模型', 0, '准备下载');
    const archive = path.join(tmp, STT_TAR.file);
    const ok = await download({ ...STT_TAR, file: archive, label: '语音识别模型', log, onProgress: (p) => report('语音识别模型', p.percent, p.detail) });
    if (!ok) missing.push('语音识别模型');
    else {
      const dest = path.join(tmp, 'stt');
      await extractTar(archive, dest, log);
      const inner = path.join(dest, STT_TAR.innerDir);
      fs.mkdirSync(path.dirname(t.sttModel), { recursive: true });
      fs.copyFileSync(path.join(inner, STT_MODEL.name), t.sttModel);
      fs.copyFileSync(path.join(inner, STT_TOKENS.name), t.sttTokens);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.rmSync(archive, { force: true });
      if ((await isValid(t.sttModel, STT_MODEL)) && (await isValid(t.sttTokens, STT_TOKENS))) downloaded += 1;
      else missing.push('语音识别模型校验');
    }
  }
  nextStep();

  // 2) 语音检测（VAD）：GitHub release 上的版本与 DSH 固定版本不同，必须走 HF
  const vadCandidates = [path.join(cache, 'silero', VAD_MODEL.name), t.vad];
  if (await isValid(vadCandidates[0], VAD_MODEL)) { log('语音检测模型已存在，跳过下载'); reused += 1; }
  else if (await isValid(t.vad, VAD_MODEL)) { log('语音检测模型已存在（插件目录）'); reused += 1; }
  else {
    const ok = await download({
      url: `${HF}/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/${VAD_MODEL.name}`,
      file: t.vad, bytes: VAD_MODEL.bytes, sha256: VAD_MODEL.sha256,
      resolveHost: 'cas-bridge.xethub.hf.co', label: '语音检测模型', log,
      onProgress: (p) => report('语音检测模型', p.percent, p.detail),
    });
    if (ok) downloaded += 1; else missing.push('语音检测模型');
  }
  nextStep();

  // 3) 合成模型（MatchaTTS 声学模型 + lexicon + tokens + espeak 数据）
  const ttsOk = await isValid(t.ttsModel, TTS_ACOUSTIC);
  if (ttsOk) { log('合成模型已存在，跳过下载'); reused += 1; }
  else {
    const archive = path.join(tmp, TTS_TAR.file);
    const ok = await download({ ...TTS_TAR, file: archive, label: '合成模型', log, onProgress: (p) => report('合成模型', p.percent, p.detail) });
    if (!ok) missing.push('合成模型');
    else {
      await extractTar(archive, root, log);
      fs.rmSync(archive, { force: true });
      if (await isValid(t.ttsModel, TTS_ACOUSTIC)) downloaded += 1;
      else missing.push('合成模型校验');
    }
  }
  nextStep();

  // 4) 声码器
  if (await isValid(t.vocoder, TTS_VOCODER)) { log('声码器已存在，跳过下载'); reused += 1; }
  else {
    const ok = await download({
      url: `${GH}/vocoder-models/${TTS_VOCODER.name}`,
      file: t.vocoder, bytes: TTS_VOCODER.bytes, sha256: TTS_VOCODER.sha256,
      label: '声码器', log, onProgress: (p) => report('声码器', p.percent, p.detail),
    });
    if (ok) downloaded += 1; else missing.push('声码器');
  }
  nextStep();

  // 5) 清理临时目录
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(`${t.vad}.partial`, { force: true });
  fs.rmSync(`${t.vocoder}.partial`, { force: true });

  const ok = missing.length === 0;
  onProgress({ phase: ok ? 'ready' : 'failed', percent: ok ? 100 : 0, label: '', detail: ok ? '' : `失败：${missing.join('、')}` });
  return { ok, missing, reused, downloaded };
}

/** 只做检查，不下载（给 /health 和 worker 快速判定用）。 */
export async function checkModels(root) {
  const t = targetPaths(root);
  const cache = dshSttCache();
  const sttModel = (await isValid(path.join(cache, 'sensevoice-onnx', STT_MODEL.name), STT_MODEL)) ? path.join(cache, 'sensevoice-onnx', STT_MODEL.name) : t.sttModel;
  const sttTokens = (await isValid(path.join(cache, 'sensevoice-onnx', STT_TOKENS.name), STT_TOKENS)) ? path.join(cache, 'sensevoice-onnx', STT_TOKENS.name) : t.sttTokens;
  const vad = (await isValid(path.join(cache, 'silero', VAD_MODEL.name), VAD_MODEL)) ? path.join(cache, 'silero', VAD_MODEL.name) : t.vad;
  const items = {
    识别权重: await isValid(sttModel, STT_MODEL),
    词表: await isValid(sttTokens, STT_TOKENS),
    语音检测: await isValid(vad, VAD_MODEL),
    合成声学: await isValid(t.ttsModel, TTS_ACOUSTIC),
    声码器: await isValid(t.vocoder, TTS_VOCODER),
  };
  return { ready: Object.values(items).every(Boolean), items };
}
