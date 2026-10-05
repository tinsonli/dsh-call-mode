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
/** 试听文本上限：用户快速横比音色，一句话就够，绝不能一次生成几分钟音频。 */
const PREVIEW_MAX_CHARS = 24;

/**
 * 各 TTS 引擎的默认语速——**引擎→语速只有这一张表**（worker 里只保留「安全钳制」，不重复默认值）。
 *  - matcha（当前默认引擎，首块快）：1.0 偏「念稿」，1.25 接近正常说话速度；
 *  - kokoro（`DSH_TTS_ENGINE=kokoro`）：24kHz 多语言；加速就吞字，实测 1.10 起开始出错、1.25 三句全错，1.0 全对。
 * 表里的值只是**默认值**：config.speed / DSH_CALL_SPEED / 单次请求的 speed 都能覆盖它。
 */
const ENGINE_DEFAULT_SPEED = { kokoro: 1.0, matcha: 1.25 };
const SPEED_WARN_ABOVE = 1.4;

/**
 * 宿主视角的默认 TTS 引擎。
 * ⚠️ **必须与 `server/worker.mjs` 的默认引擎保持一致**（worker 的 `TTS_ENGINE_WANTED`，以及
 * `server/models.mjs` 里同名判断用的同一个默认值）：宿主按这里选语速、worker 按那边加载模型，
 * 一旦不一致就会出现「worker 跑 Matcha、宿主按 Kokoro 只发 1.0」这种又慢又不达预期的组合。
 * **改一边必须改另一边**；`C:\AI\work\call-mode-engine-guard-test-brevity-tuner.mjs` 会读两个文件断言相等。
 */
export const DEFAULT_TTS_ENGINE = 'matcha';

/**
 * 宿主视角的当前 TTS 引擎：与 worker 读的是**同一个** `DSH_TTS_ENGINE`，判断规则**逐字镜像** worker
 * （不是 kokoro 就按 matcha 处理，默认 matcha）。宿主 spawn worker 时透传 `process.env` 且不覆盖它，
 * 所以两边必然一致；引擎→语速的映射因此只需要上面那一张表。
 */
function currentTtsEngine() {
  return String(process.env.DSH_TTS_ENGINE || DEFAULT_TTS_ENGINE).toLowerCase() === 'kokoro' ? 'kokoro' : 'matcha';
}

/** 语速解析：只认正的有限数字；其余（undefined / NaN / 0 / 负数 / 非数字串）一律回落到 fallback。 */
function normalizeSpeed(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 通话等待上限：超过它就先用一句「我还在处理，稍等一下。」接住用户，真实回复随后走
 * #enqueueSpeech 补播。30 秒在电话里是干等、体感极差，所以默认 8 秒；
 * `config.replyTimeoutMs` / `DSH_CALL_REPLY_TIMEOUT_MS` 可调，单次请求的 timeoutMs 优先级最高。
 */
const DEFAULT_REPLY_TIMEOUT_MS = 8000;

/** 毫秒解析：只认正的有限数字；其余（undefined / NaN / 0 / 负数 / 非数字串）一律回落到 fallback。 */
function positiveMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

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
 *  - 同理，send_message 虽然持久送达，但队友要到下一个步骤边界才会看到；
 *    通话里频繁补充需求时，改写任务描述（永远最新）或 interrupt_agent 打断
 *    都比连发消息有效——第 8-11 条即由此而来（已获用户确认写入）。
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
  '   - 若接通时你手上还有没干完的活：先整体交给一个新团队（team_task_create 写全需求与验收 → spawn_teammate 拉人 → send_message 派活），然后不再自己动手。',
  '4. 派发后【立刻】用一句话给用户即时回应（例如「已经让队友去查了」），不要等队友做完才开口——在通话里这一句就是完整答复，不算「最终答案」，因此你不需要阻塞等待队友。',
  '   绝对不要用 wait_agent，也不要轮询：那会让你在电话里卡住、说不出话。队友的结果随后会以消息到达，届时再补一句结论即可。',
  '5. 你自己的工具调用能少则少：不读大文件、不做长搜索、不跑命令。这些都是队友的活。',
  '6. 用户可能在你说话中途插话；被打断后优先处理用户的新要求。',
  '7. 用用户所用的语言回答（默认中文）。',
  '',
  '给队友发消息的纪律：',
  '8. 闲聊不派活：寒暄、确认、「嗯」「好的」这类不产生动作的话，一律不要给队友发消息；只有真正的需求才建任务、才发消息。',
  '9. 同一件事的补充或修改，优先用 team_task_update 改写任务描述，不要一条条补发消息：队友可能正卡在长工具里，消息只在它的步骤边界送达、等它醒来可能已经过期，而任务描述永远是最新版。',
  '10. 新要求让旧要求作废时（方向变了、不用做了），用 interrupt_agent 立刻打断，不要发消息排队等它做完。',
  '11. 队友在忙时不要催：催的消息一样只排队，只会制造过期信息。',
].join('\n');

/**
 * 接通时若 agent 还在干活，用它 steer 一句「让位」指令（见 #handoffIfBusy）。
 * 它是**用户可见的 steering 气泡**，口气要能公开看；可用 config.handoffText 覆盖。
 */
const HANDOFF_TEXT = '【用户来电】立刻把你手上正在进行的任务整体交给一个新团队：先用 team_task_create 建任务（写全需求、约束、验收标准），再用 spawn_teammate 拉起队友，并用 send_message 把任务派给他们；交接完专心回到通话，不要再自己干活。';

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
    // 语速只在这里解析一次：显式配置（config.speed / DSH_CALL_SPEED）优先，否则按当前 TTS 引擎取默认值。
    // 四条合成路径都读 this.speed，所以这里是唯一的解析点；explicitSpeed 留档便于排查。
    this.explicitSpeed = normalizeSpeed(config?.speed ?? process.env.DSH_CALL_SPEED, undefined);
    this.speed = this.explicitSpeed ?? ENGINE_DEFAULT_SPEED[currentTtsEngine()];
    if (this.speed > SPEED_WARN_ABOVE) log(`语速 ${this.speed} 超过建议上限 ${SPEED_WARN_ABOVE}，音质可能明显受损`);
    // 通话等待上限：默认 8 秒（原 30 秒）。超时先回一句「我还在处理」，真实回复随后补播。
    this.replyTimeoutMs = positiveMs(config?.replyTimeoutMs ?? process.env.DSH_CALL_REPLY_TIMEOUT_MS, DEFAULT_REPLY_TIMEOUT_MS);
    this.child = undefined;
    this.port = undefined;
    this.token = undefined;
    this.pending = new Map();
    this.disposeEvent = undefined;
    this.rulesDispose = undefined;
    this.rulesSession = undefined;
    this.startPromise = undefined;
    this.inFlightTurn = new Map();
    /** 同一通电话只推一次让位指令（worker 崩溃重启会重走 start()，避免重复 steer）。 */
    this.handoffSent = new Set();
    this.pendingSpeech = new Map();
    this.unpromptedDraft = new Map();
    /**
     * 通话激活时，把「不是 /converse 发起的那一轮」的最终文本也念出来。
     * 场景：通话守则把活派给队友，队友干完 send_message 把 Lead 唤醒——那一轮没有
     * pending，旧代码在 #subscribe 开头 `if (!p) return` 直接丢掉，话只打在屏幕上。
     * 默认开；关掉即完全恢复旧行为。
     */
    this.speakUnpromptedReplies = config?.speakUnpromptedReplies !== false;
    /**
     * 通话中试听后选定的音色（sid）。undefined = 用 worker 启动时的默认音色。
     * 只记住一个数：切音色不重启 worker、不发 /stop、不断通话。
     */
    this.ttsSid = Number.isInteger(config?.sid) ? config.sid : undefined;
    this.voiceCache = undefined;   // { at, value }：/voices 的短暂缓存，横比时不反复打扰 worker
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
      if (sessionId !== undefined) {
        await this.activateRules(sessionId);
        await this.#handoffIfBusy(sessionId);        // 复用 worker 时也要推（例如再次点通话）
      }
      return { port: this.port, pid: this.child.pid, reused: true };
    }
    if (this.startPromise) return this.startPromise;      // 并发启动只跑一次
    this.startPromise = this.#spawnWorker(sessionId);
    try {
      const started = await this.startPromise;
      await this.#handoffIfBusy(sessionId);          // 首次接通：worker 一就绪就推
      return started;
    } finally { this.startPromise = undefined; }
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
    this.subscribeEvents();
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
    // 挂断即清空补播队列：既包括迟到回复，也包括「队友唤醒的那一轮」攒下的文本
    this.pendingSpeech.clear();
    this.unpromptedDraft.clear();
    this.handoffSent.clear();      // 通话结束：下次接通允许再推一次让位
    // 每条请求各自一格登记（M2）：超时过的那条（delivered）留着等真实结果补播；没超时的直接失败收尾。
    for (const [id, list] of this.pending) {
      for (const p of list) {
        if (p.delivered) continue;   // 已超时返回给调用方的那条，仍要等它的真实结果（会进待播队列）
        clearTimeout(p.timer);
        p.reject(new Error('通话已结束'));
      }
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

  /**
   * 接通时若该会话的 agent 还在干活，推它一句：把活整体交给一个新团队，然后回来接电话。
   *
   * 为什么用 steer 而不是 followup（asar dsh-agent-loop/lib/index.js:800-814）：
   *  - followup 排在**下一个回合**（send(input,'next-turn',true)），要等当前整个回合跑完；
   *  - steer 排在**下一个步**（send(input,'next-step',true)），当前这次工具调用一返回就被看到，
   *    于是等待从「整个回合」缩到「当前这一步」。
   * 代价：它作为**用户消息**进入对话（用户可见，UI 上是 steering 气泡），并取代当前回合原有的
   * 计划——这正是「让位」想要的效果。它**不会**插进正在跑的工具调用中间，也**绝不**取消它：
   * cancel 会中止正在跑的工具、丢掉未落盘成果，且默认清空 inbox（会把刚 steer 的指令一起清掉）。
   *
   * 判据以 agent.status 为主：`subscribeEvents()` 只在 worker 起来后才开始观测 turn/start，
   * 所以「手打任务 → agent 正忙 → 点通话」这条路上 inFlightTurn 必然是空的；只看 inFlightTurn
   * 会让这个功能在最需要它的场景里静默失效。仅当 agent 没有 status 字段（桩/旧实现）时退回它。
   *
   * 全程不抛：推不动也不能让通话起不来。
   */
  async #handoffIfBusy(sessionId) {
    if (sessionId === undefined) return;
    if (this.config?.handoffOnCall === false) return;
    if (this.handoffSent.has(sessionId)) return;          // 同一通电话只推一次
    try {
      const agent = await this.#resolveAgent(sessionId);
      const busy = typeof agent?.status === 'string'
        ? agent.status === 'running'
        : this.inFlightTurn.has(sessionId);
      if (!busy) return;
      if (typeof agent.steer !== 'function') { log('agent 不支持 steer，跳过让位推送'); return; }
      const text = this.config?.handoffText ?? HANDOFF_TEXT;
      agent.steer(await makeUserMessage(text, { kind: 'call-mode' }));
      this.handoffSent.add(sessionId);
      log('已 steer 让位指令 session=', sessionId, 'text=', text.slice(0, 40));
    } catch (e) {
      log('让位推送失败（忽略，不影响通话）', e?.message);
    }
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

  /**
   * @param {number} [speed] 省略时用构造时解析好的通话语速（this.speed）。
   * @param {number} [sid] 省略时用当前通话选定的音色（this.ttsSid）；两者都省略则用 worker 默认。
   */
  async synthesize(text, speed = this.speed, sid = this.ttsSid) {
    const payload = { text, speed };
    if (Number.isInteger(sid)) payload.sid = sid;      // worker 侧校验 0..speakers-1，非法直接 400
    const res = await this.#worker('/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * 可用音色列表。**从 worker /health 的 speakers 推导**，不硬编码任何音色名：
   * speakers 是当前引擎的说话人数（matcha=1、Kokoro 多语言 v1.1=103），
   * 所以想试听 Kokoro 那 103 个音色，worker 必须以 kokoro 引擎启动（DSH_TTS_ENGINE）。
   * 5 秒缓存：用户在快速横比时不会每点一次就问一遍 worker。
   */
  async voices(options = {}) {
    const now = Date.now();
    if (options.fresh !== true && this.voiceCache !== undefined && now - this.voiceCache.at < 5000) return this.voiceCache.value;
    const h = await this.health().catch(() => undefined);
    const speakers = Number.isInteger(h?.speakers) && h.speakers > 0 ? h.speakers : 0;
    const engine = typeof h?.engine === 'string' ? h.engine : 'unknown';
    const sid = Number.isInteger(this.ttsSid) ? this.ttsSid : (Number.isInteger(h?.sid) ? h.sid : 0);
    const value = {
      engine,
      speakers,
      sid,
      voices: Array.from({ length: speakers }, (_, i) => ({ sid: i, label: `音色 ${i}` })),
    };
    this.voiceCache = { at: now, value };
    return value;
  }

  /** 设定当前通话的音色（只在宿主侧记一个数）。 */
  setSid(sid) {
    this.ttsSid = sid;
    this.voiceCache = undefined;      // 下次读 /voices 拿到新的「当前」
    return this.ttsSid;
  }

  async cancelSpeech() {
    try { await this.#worker('/cancel', { method: 'POST' }); } catch { /* 忽略 */ }
  }

  // ------------------------------------------------------------- 会话
  async submitTurn(sessionId, text, options = {}) {
    const timeoutMs = positiveMs(options.timeoutMs, this.replyTimeoutMs);
    // 【C】迟到的回复只在「用户还在等它」时才有价值：这条新请求说明用户已经翻篇，
    // 该会话里还没播出的迟到回复整队作废（近似做法 = 直接清空 pendingSpeech）。
    // 取舍：无法精确判断每段迟到语音对应哪一问，宁可少念一句，也不要让他先听到一堆过期答案。
    // 只动这个会话的队列，别的会话不受影响；converse 里还会把「已经取走的 carried」一并丢掉
    // （只有 STT 回来才知道用户到底说没说话）。
    const staleSpeech = this.pendingSpeech.get(sessionId);
    if (staleSpeech !== undefined && staleSpeech.length > 0) {
      log(`用户已说下一句，作废 ${staleSpeech.length} 段未播的迟到回复 session=${sessionId}`);
    }
    this.pendingSpeech.delete(sessionId);
    const agent = await this.#resolveAgent(sessionId);
    // 基线回合号：只关心「提交时是否已有回合在飞」。用最大见过的回合号会出错——
    // 若 agent 的回合号不递增（或桩/复用场景重复同一个号），那条回合会被误判为旧回合而丢掉。
    const baselineTurn = this.inFlightTurn.get(sessionId) ?? 0;
    const message = await makeUserMessage(text);
    const reply = new Promise((resolve, reject) => {
      // **每条请求各自一格登记**（M2 修复）：以前每会话只有一个槽位，新请求会把还在等真实结果
      // 的那条顶掉，旧回合结束时匹配到的是新条目 → 上一条真实回复永久丢失。现在多条并存、互不覆盖。
      const entry = { resolve, reject, baselineTurn, draft: undefined, timer: undefined, delivered: false, done: false };
      entry.timer = setTimeout(() => {
        if (entry.done) return;
        entry.delivered = true;                      // 之后到达的回复改为「稍后补播」，不丢
        log(`等待回复超过 ${timeoutMs}ms，改为稍后播报`);
        resolve({ text: '', turn: -1, late: true }); // 不 reject：通话继续，用户先听到一句「还在处理」
      }, timeoutMs);
      const list = this.pending.get(sessionId) ?? [];
      list.push(entry);
      this.pending.set(sessionId, list);
    });
    log('提交用户消息 session=', sessionId, 'text=', text.slice(0, 60));
    agent.followup(message);
    return reply;
  }

  /**
   * 该回合「属于哪条已登记的通话请求」：按提交顺序取第一条「还没结算、且回合号在它基线之后」的。
   * 一个 turn/end 只结算一条 → 一个回合最多入队/返回一次；与 task-13 的补播通路是 if/else 关系
   * （见 subscribeEvents），所以同一回合绝不会被两条通路各念一遍。
   */
  #entryForTurn(sessionId, turn) {
    if (typeof turn !== 'number') return undefined;
    const list = this.pending.get(sessionId);
    if (list === undefined) return undefined;
    return list.find((e) => e.done !== true && turn > e.baselineTurn);
  }

  /** 结算后把登记摘掉；数组空了就把整个键删掉，避免登记无限增长。 */
  #releaseEntry(sessionId, entry) {
    const list = this.pending.get(sessionId);
    if (list === undefined) return;
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.pending.delete(sessionId);
  }

  /** 把迟到的回复合成后排入待播队列，等客户端下次轮询/下一次往返时取走。 */
  async #enqueueSpeech(sessionId, text) {
    const spoken = speakableText(text);
    if (spoken === '') return;
    const chunks = [];
    for (const sentence of splitSentences(spoken)) {
      try { chunks.push((await this.synthesize(sentence, this.speed)).toString('base64')); }
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

  /**
   * 订阅会话事件（幂等）。由 start() 在 worker 就绪后调用；测试可直接调用来验证补播通路。
   */
  subscribeEvents() {
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
      // 这一回合属于哪条已登记的通话请求？属于谁就由谁负责：
      //   owner 存在   → 本任务的主路径（未超时内联返回 / 超时后走 #enqueueSpeech 补播）；
      //   owner 不存在 → task-13 的「队友唤醒」补播通路（speakUnpromptedReplies）。
      // 二者是 if/else：同一回合只会走一条，绝不会被两条通路各念一遍。
      const owner = this.#entryForTurn(session.id, event.data?.turn);
      if (event.type === 'assistant/message') {
        const blocks = event.data.message.content || [];
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        // 记录工具调用：通话里 agent 到底在说话还是在干活，只有这里看得见
        const tools = blocks.filter((b) => b.type === 'tool-call').map((b) => b.name);
        if (owner !== undefined || this.#tracksUnprompted(session.id)) {
          log(`回合中助手消息 turn=${event.data.turn} step=${event.data.step ?? '-'} 文本=${text.length}字${tools.length ? ` 工具=[${tools.join(',')}]` : ''}`);
        }
        if (text === '') return;
        if (owner !== undefined) { owner.draft = { turn: event.data.turn, text }; return; }
        if (this.#tracksUnprompted(session.id)) {
          // 没有登记：这一轮不是 /converse 发起的（典型场景：队友 send_message 把 Lead 唤醒，
          // 通话守则允诺的「随后补一句结论」正发生在这一轮）。只留该轮最后一次文本，等 turn/end 补播；
          // 主路径已经内联播过的那一轮都在上面 owner 分支里，不会走到这。
          this.unpromptedDraft.set(session.id, { turn: event.data.turn, text });
        }
        return;
      }
      if (event.type !== 'turn/end') return;
      if (owner === undefined) {
        // 队友唤醒的那一轮结束：补播（未激活/非绑定会话/开关关闭都会在这里被丢掉）
        this.#speakUnpromptedRound(session.id, event.data?.turn);
        return;
      }
      const text = owner.draft?.turn === event.data.turn ? owner.draft.text : '';
      clearTimeout(owner.timer);
      owner.done = true;
      this.#releaseEntry(session.id, owner);
      if (owner.delivered) {
        // 调用方已经拿着「还在处理」返回了；把真实结果排进待播队列
        // （M2：以前这里匹配到的是被新请求顶替后的条目、会提前 return，这条回复就永久丢了）
        log('收到迟到的回复 turn=', event.data.turn, 'text=', text.slice(0, 40));
        void this.#enqueueSpeech(session.id, text);
        return;
      }
      log('回合结束 turn=', event.data.turn, 'text=', text.slice(0, 60));
      owner.resolve({ text, turn: event.data.turn });
    });
  }

  /**
   * 是否为「不是 /converse 发起的那一轮」补播：开关打开 + 通话激活 + 就是绑定的那个会话。
   * 绑定会话 = 通话守则注入的那个（task-8 换绑后 rulesSession 会跟着变），
   * 所以别的会话里的队友消息不会被念进这通电话。
   */
  #tracksUnprompted(sessionId) {
    return this.speakUnpromptedReplies === true && this.active === true && this.rulesSession === sessionId;
  }

  /** 把「队友唤醒的那一轮」的最后一段文本排进既有补播队列（一轮只念最后一段）。 */
  #speakUnpromptedRound(sessionId, turn) {
    const draft = this.unpromptedDraft.get(sessionId);
    this.unpromptedDraft.delete(sessionId);
    if (draft === undefined) return;
    if (typeof turn === 'number' && draft.turn !== turn) return;   // 只认该轮自己的文本
    if (!this.#tracksUnprompted(sessionId)) return;                // 挂断后不再入队
    log('队友唤醒的回合结束 turn=', turn, 'text=', draft.text.slice(0, 40));
    void this.#enqueueSpeech(sessionId, draft.text);
  }

  /**
   * 一次完整往返：PCM -> 文字 -> 交给 agent -> 取回复 -> 合成语音。
   * @returns {{transcript: string, replyText: string, chunks: string[]}}
   */
  async converse({ pcm, sessionId, language = 'auto', speed: requestedSpeed, timeoutMs }) {
    // 显式传入的 speed 优先；客户端不传时用配置语速
    const speed = normalizeSpeed(requestedSpeed, this.speed);
    // 先把可能积压的「迟到回复」交给调用方播出（无需轮询也能送达）
    const carried = this.drainSpeech(sessionId);
    const stt = await this.transcribe(pcm, language);
    const transcript = (stt.text || '').trim();
    // 用户一个字都没说（静音/误触）：照旧把积压的迟到回复播出去，不误伤 M2 的正向用例。
    if (transcript === '') return { transcript: '', replyText: '', chunks: carried };
    // 【C】用户确实说了下一句 → 他关心的已经是新问题：连刚才已经取走的那批迟到回复也一并作废，
    // 否则客户端会先把过期答案念完才轮到新回答（取舍见 submitTurn 里的同名注释）。
    if (carried.length > 0) log(`用户已说下一句，作废 ${carried.length} 段已取走的迟到回复 session=${sessionId}`);
    const { text: replyText, late } = await this.submitTurn(sessionId, transcript, timeoutMs === undefined ? {} : { timeoutMs });
    if (late) {
      // agent 还没答完：先让用户听到一句「还在处理」，真实结果稍后从队列取出
      const chunks = [];
      try { chunks.push((await this.synthesize(this.config.stillWorkingText ?? '我还在处理，稍等一下。')).toString('base64')); }
      catch (e) { log('等待语合成失败', e?.message); }
      return { transcript, replyText: '', chunks, late: true };
    }
    const spoken = speakableText(replyText);
    const chunks = [];
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
      // 接通问候：让用户一点按钮就能立刻听到底层音频通路正常。
      // 默认用接电话的口吻「喂，你好，我在听。」；config.greeting 仍可覆盖（置空则不说）。
      let greeting;
      try {
        const text = controller.config.greeting ?? '喂，你好，我在听。';
        if (text !== '') greeting = (await controller.synthesize(text, controller.speed)).toString('base64');
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
        // 不传 speed 时交给 converse 用配置语速；显式传入（含 0/非法值）仍以请求为准，非法值由 converse 归一
        ...(payload.speed === undefined || payload.speed === null ? {} : { speed: Number(payload.speed) }),
        ...(payload.timeoutMs === undefined ? {} : { timeoutMs: Number(payload.timeoutMs) }),
      });
    })],
    // 取走「迟到回复」的语音（客户端空闲时轮询）
    ['/poll', ['POST'], guard(async (request) => {
      const { sessionId } = await body(request);
      return { chunks: controller.drainSpeech(sessionId) };
    })],
    // 音色：列出（从 worker /health 推导）/ 试听 / 设为当前。三条都不重启 worker、不打断通话。
    ['/voices', ['GET', 'POST'], guard(async () => controller.voices())],
    ['/preview', ['POST'], guard(async (request) => {
      const payload = await body(request);
      const info = await controller.voices();
      // 与 worker 同一套约定：缺省 / null / 空串都表示「用当前音色」
      const asked = payload.sid;
      const sid = asked === undefined || asked === null || asked === '' ? info.sid : Number(asked);
      if (!Number.isInteger(sid) || sid < 0 || (info.speakers > 0 && sid >= info.speakers)) {
        throw new Error(`音色编号必须在 0..${Math.max(0, info.speakers - 1)} 之间（收到 ${JSON.stringify(payload.sid)}）`);
      }
      const text = (typeof payload.text === 'string' && payload.text.trim() !== '' ? payload.text.trim() : '你好')
        .slice(0, PREVIEW_MAX_CHARS);
      const pcm = await controller.synthesize(text, controller.speed, sid);
      return { sid, text, engine: info.engine, speakers: info.speakers, chunks: [pcm.toString('base64')] };
    })],
    ['/voice', ['POST'], guard(async (request) => {
      const payload = await body(request);
      const info = await controller.voices();
      const asked = payload.sid;
      const sid = asked === undefined || asked === null || asked === '' ? info.sid : Number(asked);
      if (!Number.isInteger(sid) || sid < 0 || (info.speakers > 0 && sid >= info.speakers)) {
        throw new Error(`音色编号必须在 0..${Math.max(0, info.speakers - 1)} 之间（收到 ${JSON.stringify(payload.sid)}）`);
      }
      controller.setSid(sid);
      log('当前音色已切换 sid=', sid, 'engine=', info.engine, 'speakers=', info.speakers);
      return { sid, engine: info.engine, speakers: info.speakers };
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
// 测试缝：脱离 DSH 运行时构造 controller，验证「队友唤醒的那一轮」补播通路。
// 加载器只读 name/inject/apply，多余导出无副作用（client.js 的 __internals 同款做法）。
export const __internals = { CallController };

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
