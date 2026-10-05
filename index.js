/**
 * 通话模式 —— 宿主一半（Cordis 服务）
 *
 * 组成：
 *  1. 通话子进程（server/worker.mjs）：本地 STT(SenseVoice) + TTS(MatchaTTS)
 *  2. 会话编排：把识别文字作为用户消息提交给 agent，等这一轮结束并取出回复
 *  3. 通话守则：通话期间给该会话的 agent 注入系统提示词段（结束即撤除）
 *  4. 控制通道：用 DSH 插件级同源 HTTP 路由暴露给浏览器一半
 *     （ctx.connection.fetch.register；自带 Host/Origin 围栏与 cookie 认证，
 *      不需要自己起服务、不需要 CORS、也不需要往页面注入端口和密钥）
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureModels, checkModels } from './server/models.mjs';

const require = createRequire(import.meta.url);

const HOME = os.homedir();
const CALL_DIR = path.join(HOME, '.dsh', 'call-mode');
const LOG_FILE = path.join(CALL_DIR, 'call.log');
const ROUTE_BASE = '/api/call-mode';
const MAX_PCM_BYTES = 8 * 1024 * 1024;

fs.mkdirSync(CALL_DIR, { recursive: true });
/** 日志统一 UTF-8；首次创建时写入 BOM，这样 Windows PowerShell 5.1 直接 Get-Content 也不会乱码。 */
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    const fresh = !fs.existsSync(LOG_FILE);
    fs.appendFileSync(LOG_FILE, fresh ? `\uFEFF${line}` : line);
  } catch { /* 日志失败不影响通话 */ }
}

/**
 * 通话守则：让 Lead 少用工具、专注通话，并把需求立刻分派给团队。
 *
 * 两条来自源码的硬约束（见 @deepseek-ai/dsh-experimental-tool-agent-team）：
 *  - 必须点名真实工具（team_task_create / spawn_teammate / send_message），
 *    笼统说「用 Agent Teams 建队」对模型没有可执行性。
 *  - `wait_agent` 只观察调用之后的变化、且不会唤醒任何成员；通话里用它
 *    等于把 Lead 卡死说不出话，所以明令禁止。
 */
export const CALL_RULES = [
  '你现在处于「通话模式」：用户正在用语音和你实时对话。',
  '',
  '通话守则（优先级高于一般风格偏好）：',
  '1. 你收到的是语音识别文本，可能有同音错字；先理解意图，不要纠结字面，也不要复述纠错。',
  '2. 你的回答会被合成为语音念给用户：只回 1-2 句口语化短句。不要用列表、标题、代码块、表格或 markdown；不要念 URL、文件路径或命令。',
  '3. 任何需要动手的请求，立刻分派，不要在电话里自己开工：',
  '   - 用 team_task_create 建任务，把完整需求、约束和验收标准写进描述；',
  '   - 用 spawn_teammate 拉起队友（一次通话最多 3 名），再用 send_message 把任务交给他们；',
  '   - 派完只回一句「我已经让 X 去做 Y，大概需要 Z」，然后马上回到对话继续听。',
  '4. 派发后【立刻】用一句话给用户即时回应（例如「已经让队友去查了」），不要等队友做完才开口——在通话里这一句就是完整答复，不算「最终答案」，因此你不需要阻塞等待队友。',
  '   绝对不要用 wait_agent，也不要轮询：那会让你在电话里卡住、说不出话。队友的结果随后会以消息到达，届时再补一句结论即可。',
  '5. 你自己的工具调用能少则少：不读大文件、不做长搜索、不跑命令。这些都是队友的活。',
  '6. 用户可能在你说话中途插话；被打断后优先处理用户的新要求。',
  '7. 用用户所用的语言回答（默认中文）。',
].join('\n');

/** DSH 的 createUserMessage 就是「带 uuid 的冻结对象」；优先用官方实现，取不到时等价构造。 */
let createUserMessageImpl;
async function makeUserMessage(text, source = { kind: 'user' }) {
  if (createUserMessageImpl === undefined) {
    try { ({ createUserMessage: createUserMessageImpl } = await import('@deepseek-ai/dsh-llm')); }
    catch { createUserMessageImpl = null; }
  }
  if (createUserMessageImpl) return createUserMessageImpl({ content: [{ type: 'text', text }], source });
  return Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source });
}

/** 把助手回复变成「能读出来」的纯文本：去掉代码块/表格/链接/markdown 记号。 */
export function speakableText(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, '（代码略）')          // 围栏代码块
    .replace(/~~~[\s\S]*?~~~/g, '（代码略）')
    .replace(/`([^`]*)`/g, '$1')                       // 行内代码保留内容
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')              // 图片整块丢掉
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')           // 链接只留文字
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, '')        // 表格分隔行 |---|---|，否则会被念成「横线横线」
    .replace(/https?:\/\/\S+/g, '')                    // 裸 URL 不念
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                // 标题记号
    .replace(/^\s{0,3}[-*+]\s+/gm, '')                 // 无序列表记号
    .replace(/^\s{0,3}\d+\.\s+/gm, '')                 // 有序列表记号
    .replace(/\*\*([^*]*)\*\*/g, '$1')                 // 粗体
    .replace(/__([^_]*)__/g, '$1')
    .replace(/[*_>|]/g, '')                            // 残留记号与表格竖线
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 先按句末标点切分，再把相邻短句合并到 maxChars 以内。
 * 合并是刻意的：每段一次 TTS 调用，短句各自合成会成倍增加往返；合并后同样
 * 能「边合成边播放」。所以段数不等于句子数——想看纯切分请把 maxChars 调小。
 * @param {string} text
 * @param {number} [maxChars=120]
 * @returns {string[]}
 */
export function splitSentences(text, maxChars = 120) {
  const parts = String(text || '')
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const out = [];
  for (const part of parts) {
    if (out.length > 0 && out[out.length - 1].length + part.length <= maxChars) out[out.length - 1] += part;
    else out.push(part);
  }
  return out;
}

function resolveSherpaPath() {
  try { return require.resolve('sherpa-onnx-node'); } catch { /* 宿主解析器可能不认安装包 */ }
  // 外部插件位于安装目录之外，Node 上溯查找找不到 asar 里的包；
  // 子进程以 Electron-as-Node 启动，可直接 require asar 路径。
  const guess = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', 'sherpa-onnx-node');
  try { if (fs.existsSync(guess)) return guess; } catch { /* 不支持的运行时 */ }
  return undefined;
}

/** 一个通话会话：一个子进程 + 等待中的助手回合 + 通话守则句柄。 */
class CallController {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    this.child = undefined;
    this.port = undefined;
    this.token = undefined;
    this.pending = new Map();
    this.disposeEvent = undefined;
    this.rulesDispose = undefined;
    this.rulesSession = undefined;
    this.startPromise = undefined;
    this.inFlightTurn = new Map();
    this.pendingSpeech = new Map();
    this.modelRoot = config?.modelsDir ?? process.env.DSH_CALL_MODELS ?? path.join(CALL_DIR, 'models');
    this.provisionState = { phase: 'unknown', percent: 0, label: '', detail: '' };
    this.provisionPromise = undefined;
  }

  get active() { return this.child !== undefined; }
  get rulesActive() { return this.rulesDispose !== undefined; }

  /**
   * 模型自检 + 缺什么下什么。**不阻塞调用方**：立即返回当前状态，
   * 真正的下载在后台跑，状态由 /provision 轮询取。
   */
  provision() {
    if (this.provisionState.phase === 'ready') return this.provisionState;
    if (this.provisionPromise === undefined) {
      this.provisionState = { phase: 'checking', percent: 0, label: '检查模型文件', detail: '' };
      const progress = (p) => { this.provisionState = { ...p }; };
      this.provisionPromise = (async () => {
        const before = await checkModels(this.modelRoot);
        if (before.ready) {
          log('模型自检通过（全部已就绪）');
          this.provisionState = { phase: 'ready', percent: 100, label: '', detail: '' };
          return before;
        }
        const missingList = Object.entries(before.items).filter(([, ok]) => !ok).map(([k]) => k);
        log('模型缺失：', missingList.join('、'), '→ 开始自动下载');
        const done = await ensureModels({ root: this.modelRoot, log, onProgress: progress });
        if (done.ok) log('全部模型就绪');
        else log('模型准备失败：', done.missing.join('、'));
        return done;
      })()
        .catch((e) => {
          this.provisionState = { phase: 'failed', percent: 0, label: '', detail: String(e?.message || e) };
          log('模型准备异常', e?.message);
        })
        .finally(() => { this.provisionPromise = undefined; });
    }
    return this.provisionState;
  }

  /** 等「检查」阶段结束（就绪或已进入下载），但不等待下载完成。 */
  async provisionGate() {
    const state = this.provision();
    if (state.phase === 'checking' && this.provisionPromise !== undefined) {
      await Promise.race([this.provisionPromise, new Promise((r) => setTimeout(r, 4000))]);
    }
    return this.provisionState;
  }

  async start(sessionId) {
    if (this.child) {
      if (sessionId !== undefined) await this.activateRules(sessionId);
      return { port: this.port, pid: this.child.pid, reused: true };
    }
    if (this.startPromise) return this.startPromise;      // 并发启动只跑一次
    this.startPromise = this.#spawnWorker(sessionId);
    try { return await this.startPromise; } finally { this.startPromise = undefined; }
  }

  async #spawnWorker(sessionId) {
    this.token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const workerPath = fileURLToPath(new URL('./server/worker.mjs', import.meta.url));
    const sherpaPath = resolveSherpaPath();
    log('spawn worker', workerPath, 'sherpa=', sherpaPath || '(子进程自行解析)');
    const child = spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_CALL_TOKEN: this.token,
        DSH_CALL_THREADS: String(this.config.threads ?? 4),
        ...(sherpaPath ? { DSH_SHERPA_PATH: sherpaPath } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const workerLog = path.join(CALL_DIR, 'worker.log');
    // 同上：让 PowerShell 直接读取也不乱码
    if (!fs.existsSync(workerLog)) fs.writeFileSync(workerLog, '\uFEFF');
    fs.appendFileSync(workerLog, `\n=== ${new Date().toISOString()} pid=${child.pid} ===\n`);
    child.stderr.pipe(fs.createWriteStream(workerLog, { flags: 'a' }));
    child.on('exit', (code, signal) => { log('worker 退出', code, signal); this.#reset(); });

    const port = await new Promise((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => reject(new Error('通话子进程启动超时（20s）')), 20000);
      child.stdout.on('data', (chunk) => {
        buffered += chunk.toString();
        const line = buffered.split('\n').find((l) => l.trim().startsWith('{'));
        if (!line) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(line).port); } catch (e) { reject(e); }
      });
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`通话子进程提前退出（code=${code}）`)); });
    });
    this.port = port;
    this.#subscribe();
    log('worker 就绪 port=', port, 'pid=', child.pid);
    if (sessionId !== undefined) await this.activateRules(sessionId);
    return { port, pid: child.pid };
  }

  #reset() {
    this.child = undefined;
    this.port = undefined;
    this.token = undefined;
    this.disposeEvent?.();
    this.disposeEvent = undefined;
    this.deactivateRules();
    for (const [id, p] of this.pending) {
      if (p.delivered) continue;   // 已超时返回给调用方的那条，仍要等它的真实结果（会进待播队列）
      clearTimeout(p.timer);
      p.reject(new Error('通话已结束'));
      this.pending.delete(id);
    }
  }

  async stop() {
    this.deactivateRules();
    const child = this.child;
    if (!child) return { stopped: false };
    log('结束通话 pid=', child.pid);
    this.child = undefined;
    const done = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
    this.#reset();
    return { stopped: true };
  }

  // ------------------------------------------------------------- 通话守则
  /** 只对该会话的 agent 注入守则；结束通话时撤除。 */
  async activateRules(sessionId) {
    if (this.rulesDispose !== undefined && this.rulesSession === sessionId) return { injected: false, reused: true };
    this.deactivateRules();
    try {
      const agent = await this.#resolveAgent(sessionId);
      const systemPrompt = agent.ctx?.systemPrompt;
      if (systemPrompt?.section === undefined) {
        log('systemPrompt 服务不可用，未注入通话守则');
        return { injected: false, reason: 'systemPrompt unavailable' };
      }
      this.rulesDispose = systemPrompt.section({
        name: 'call-mode.rules',
        // 放在第一方指令之后、环境信息之前：靠后 = 模型更难忽略通话守则
        order: this.config.rulesOrder ?? 9000,
        text: CALL_RULES,
      });
      this.rulesSession = sessionId;
      log('已注入通话守则 session=', sessionId);
      return { injected: true };
    } catch (e) {
      log('注入通话守则失败', e?.message);
      return { injected: false, reason: String(e?.message || e) };
    }
  }

  deactivateRules() {
    if (this.rulesDispose === undefined) { this.rulesSession = undefined; return; }
    try { this.rulesDispose(); log('已撤除通话守则'); } catch (e) { log('撤除通话守则失败', e?.message); }
    this.rulesDispose = undefined;
    this.rulesSession = undefined;
  }

  // ------------------------------------------------------------- 子进程
  /**
   * 访问通话子进程；子进程崩了或端口没了就自动重启一次再重试。
   * 长通话里 worker 意外退出如果直接抛错，整通电话就废了，所以这里做自愈。
   */
  async #worker(pathname, init = {}, retried = false) {
    try {
      if (!this.port || !this.token) throw new Error('通话未开启');
      const res = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, ...(init.headers || {}) },
      });
      if (!res.ok) throw new Error(`worker ${pathname} HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (retried) throw e;
      log('worker 请求失败，自动重启后重试:', e?.message);
      await this.stop().catch(() => { /* 已经死了就算了 */ });
      await this.start(this.rulesSession);
      return this.#worker(pathname, init, true);
    }
  }

  async health() {
    if (!this.port) return { active: false };
    const res = await this.#worker('/health');
    return { active: true, ...(await res.json()) };
  }

  async transcribe(pcm, language = 'auto') {
    const res = await this.#worker(`/stt?language=${encodeURIComponent(language)}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm,
    });
    return res.json();
  }

  async synthesize(text, speed = 1) {
    const res = await this.#worker('/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, speed }),
    });
    return Buffer.from(await res.arrayBuffer());
  }

  async cancelSpeech() {
    try { await this.#worker('/cancel', { method: 'POST' }); } catch { /* 忽略 */ }
  }

  // ------------------------------------------------------------- 会话
  async submitTurn(sessionId, text, options = {}) {
    const { timeoutMs = 30000 } = options;
    const agent = await this.#resolveAgent(sessionId);
    // 基线回合号：只关心「提交时是否已有回合在飞」。用最大见过的回合号会出错——
    // 若 agent 的回合号不递增（或桩/复用场景重复同一个号），那条回合会被误判为旧回合而丢掉。
    const baselineTurn = this.inFlightTurn.get(sessionId) ?? 0;
    const message = await makeUserMessage(text);
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(sessionId);
        if (entry) entry.delivered = true;          // 之后到达的回复改为「稍后播报」，不丢
        log(`等待回复超过 ${timeoutMs}ms，改为稍后播报`);
        resolve({ text: '', turn: -1, late: true }); // 不 reject：通话继续，用户先听到一句「还在处理」
      }, timeoutMs);
      this.pending.set(sessionId, { resolve, reject, baselineTurn, draft: undefined, timer, delivered: false });
    });
    log('提交用户消息 session=', sessionId, 'text=', text.slice(0, 60));
    agent.followup(message);
    return reply;
  }

  /** 把迟到的回复合成后排入待播队列，等客户端下次轮询/下一次往返时取走。 */
  async #enqueueSpeech(sessionId, text) {
    const spoken = speakableText(text);
    if (spoken === '') return;
    const chunks = [];
    for (const sentence of splitSentences(spoken)) {
      try { chunks.push((await this.synthesize(sentence)).toString('base64')); }
      catch (e) { log('迟到回复合成失败', e?.message); return; }
    }
    const queue = this.pendingSpeech.get(sessionId) ?? [];
    queue.push(...chunks);
    this.pendingSpeech.set(sessionId, queue);
    log(`迟到回复已排队 ${chunks.length} 段 session=${sessionId}`);
  }

  /** 取出并清空待播语音。 */
  drainSpeech(sessionId) {
    const queue = this.pendingSpeech.get(sessionId) ?? [];
    this.pendingSpeech.delete(sessionId);
    return queue;
  }

  async #resolveAgent(sessionId) {
    const live = this.ctx.agents.get(sessionId);
    if (live) return live;
    const found = await this.ctx.sessionController.resolveAgent(sessionId);
    if (found && 'error' in found) throw found.error;
    return found.agent;
  }

  #subscribe() {
    if (this.disposeEvent) return;
    this.disposeEvent = this.ctx.on('session/event', (session, event) => {
      // 只记录「是否有回合在飞」：提交时若已有回合，就要等它之后的那一轮。
      if (event.type === 'turn/start' || event.type === 'turn/end') {
        const turn = event.data?.turn;
        if (typeof turn === 'number') {
          if (event.type === 'turn/start') this.inFlightTurn.set(session.id, turn);
          else if ((this.inFlightTurn.get(session.id) ?? -1) <= turn) this.inFlightTurn.delete(session.id);
        }
      }
      const p = this.pending.get(session.id);
      if (!p) return;
      if (event.type === 'assistant/message') {
        const blocks = event.data.message.content || [];
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        // 记录工具调用：通话里 agent 到底在说话还是在干活，只有这里看得见
        const tools = blocks.filter((b) => b.type === 'tool-call').map((b) => b.name);
        log(`回合中助手消息 turn=${event.data.turn} step=${event.data.step ?? '-'} 文本=${text.length}字${tools.length ? ` 工具=[${tools.join(',')}]` : ''}`);
        if (text !== '') p.draft = { turn: event.data.turn, text };
        return;
      }
      if (event.type !== 'turn/end') return;
      if (event.data.turn <= p.baselineTurn) return;
      const text = p.draft?.turn === event.data.turn ? p.draft.text : '';
      clearTimeout(p.timer);
      this.pending.delete(session.id);
      if (p.delivered) {
        // 调用方已经拿着「还在处理」返回了；把真实结果排进待播队列
        log('收到迟到的回复 turn=', event.data.turn, 'text=', text.slice(0, 40));
        void this.#enqueueSpeech(session.id, text);
        return;
      }
      log('回合结束 turn=', event.data.turn, 'text=', text.slice(0, 60));
      p.resolve({ text, turn: event.data.turn });
    });
  }

  /**
   * 一次完整往返：PCM -> 文字 -> 交给 agent -> 取回复 -> 合成语音。
   * @returns {{transcript: string, replyText: string, chunks: string[]}}
   */
  async converse({ pcm, sessionId, language = 'auto', speed = 1, timeoutMs }) {
    // 先把可能积压的「迟到回复」交给调用方播出（无需轮询也能送达）
    const carried = this.drainSpeech(sessionId);
    const stt = await this.transcribe(pcm, language);
    const transcript = (stt.text || '').trim();
    if (transcript === '') return { transcript: '', replyText: '', chunks: carried };
    const { text: replyText, late } = await this.submitTurn(sessionId, transcript, timeoutMs === undefined ? {} : { timeoutMs });
    if (late) {
      // agent 还没答完：先让用户听到一句「还在处理」，真实结果稍后从队列取出
      const chunks = [...carried];
      try { chunks.push((await this.synthesize(this.config.stillWorkingText ?? '我还在处理，稍等一下。')).toString('base64')); }
      catch (e) { log('等待语合成失败', e?.message); }
      return { transcript, replyText: '', chunks, late: true };
    }
    const spoken = speakableText(replyText);
    const chunks = [...carried];
    for (const sentence of splitSentences(spoken)) {
      chunks.push((await this.synthesize(sentence, speed)).toString('base64'));
    }
    return { transcript, replyText, chunks };
  }
}

/** 用 DSH 的插件级同源路由把控制器暴露给浏览器。任何失败都只记录，不抛出。 */
function registerRoutes(ctx, controller) {
  try {
    const registry = ctx.connection?.fetch;
    if (registry?.register === undefined) {
      log('connection.fetch 服务不可用，控制通道未注册');
      return false;
    }
  const ok = (value) => Response.json({ ok: true, value });
  const fail = (message, status = 500) => Response.json({ ok: false, error: { message } }, { status });
  const guard = (fn) => async (request) => {
    try { return ok(await fn(request)); }
    catch (e) { log('路由错误', e?.message); return fail(String(e?.message || e)); }
  };
  const body = async (request) => {
    try { return await request.json(); } catch { return {}; }
  };
  const routes = [
    // 客户端握手：用来远程判断「客户端加载了吗 / 槽位被声明了吗」
    ['/hello', ['POST'], guard(async (request) => {
      const info = await body(request);
      log('客户端握手', JSON.stringify(info).slice(0, 300));
      return { received: true };
    })],
    ['/health', ['GET'], guard(async () => ({
      plugin: 'call-mode', active: controller.active, rulesActive: controller.rulesActive,
      models: controller.provisionState,
      worker: await controller.health().catch((e) => ({ error: String(e?.message || e) })),
    }))],
    // 模型自检/自动下载（首次使用调一次，然后轮询看进度）
    ['/provision', ['POST'], guard(async () => controller.provisionGate())],
    ['/start', ['POST'], guard(async (request) => {
      const { sessionId } = await body(request);
      // 先确保识别与合成模型就绪（检测若空就下载），再做别的
      const models = await controller.provisionGate();
      if (models.phase !== 'ready') return { provisioning: true, progress: models };
      const started = await controller.start(sessionId);
      // 接通问候：让用户一点按钮就能立刻听到底层音频通路正常
      let greeting;
      try {
        const text = controller.config.greeting ?? '通话已接通，请讲。';
        if (text !== '') greeting = (await controller.synthesize(text)).toString('base64');
      } catch (e) { log('问候语合成失败', e?.message); }
      return { ...started, rulesActive: controller.rulesActive, greeting };
    })],
    ['/stop', ['POST'], guard(async () => controller.stop())],
    ['/cancel', ['POST'], guard(async () => { await controller.cancelSpeech(); return { cancelled: true }; })],
    ['/converse', ['POST'], guard(async (request) => {
      const payload = await body(request);
      const pcm = Buffer.from(payload.pcm || '', 'base64');
      if (pcm.length > MAX_PCM_BYTES) throw new Error('录音过长');
      return controller.converse({
        pcm, sessionId: payload.sessionId, language: payload.language || 'auto',
        speed: Number(payload.speed || 1),
        ...(payload.timeoutMs === undefined ? {} : { timeoutMs: Number(payload.timeoutMs) }),
      });
    })],
    // 取走「迟到回复」的语音（客户端空闲时轮询）
    ['/poll', ['POST'], guard(async (request) => {
      const { sessionId } = await body(request);
      return { chunks: controller.drainSpeech(sessionId) };
    })],
  ];
  for (const [suffix, methods, fetch] of routes) {
    registry.register({ path: `${ROUTE_BASE}${suffix}`, methods, requestBody: 'buffered', fetch });
  }
  log('控制通道已注册', routes.map(([s]) => ROUTE_BASE + s).join(' '));
  return true;
  } catch (e) {
    log('控制通道注册失败', e?.stack || e?.message);
    return false;
  }
}

export const name = 'call-mode';
export const inject = ['agents', 'sessionController', 'connection'];

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config = {}) {
  const controller = new CallController(ctx, config);
  const state = { registered: false };
  const register = () => {
    if (state.registered) return;
    state.registered = registerRoutes(ctx, controller);
  };
  if (ctx.connection?.fetch?.register !== undefined) register();
  else {
    // 服务尚未就绪时等它出现，避免因加载顺序丢掉控制通道
    try { ctx.inject(['connection'], register); } catch (e) { log('无法等待 connection 服务', e?.message); }
  }
  log('通话模式宿主行已加载，控制通道=', state.registered);
  try { ctx.effect(() => () => { void controller.stop(); }, 'call-mode: 通话进程与守则回收'); }
  catch (e) { log('注册清理钩子失败', e?.message); }
  return { controller, get routesRegistered() { return state.registered; } };
}
