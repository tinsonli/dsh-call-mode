# dsh-call-mode — 给 DSH 的「通话模式」插件

在对话界面里点一个按钮，就能**像打电话一样和 agent 说话**：本地语音识别听懂你，本地语音合成把回答念出来，而 agent 会立刻组队、把你的需求分派给队友，自己只负责跟你对话。

- **听得见**：SenseVoiceSmall（INT8）本地识别，16kHz
- **说得出**：MatchaTTS（中文/英文，16kHz）+ Vocos 声码器，首块延迟几十毫秒；可选 Kokoro 多语言 v1.1（103 个音色、24kHz，`DSH_TTS_ENGINE=kokoro`）或 **MeloTTS zh-en（44.1kHz 原生输出，`DSH_TTS_ENGINE=melo` + `DSH_TTS_NATIVE_RATE=1`）**
- **不联网也能用**：模型下好之后，识别与合成都在这台机器上完成
- **模型自动准备**：首次点通话时自检，缺哪个下哪个（约 298 MB；DSH 已缓存识别模型时约 135 MB），下完自动接通
- **换引擎不用重启**：语音子进程每次通话重新拉起，改默认引擎后**下一通电话就生效**
- **独立进程**：语音引擎跑在单独的子进程里，不会卡住 DSH

> 只包含源码。模型权重不随仓库分发，运行时自动下载并逐个校验 SHA-256。

---

## 一、安装

需要 DSH（DeepSeek Harness）桌面版。用官方 CLI 安装到 `desktop` profile：

```powershell
& 'C:\AI\dsh-latest\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add '<本仓库目录的绝对路径>'
```

也可以把目录放进 `$env:USERPROFILE\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles`，或通过插件管理页安装。

装完**重启 DSH**（profile 里的插件只有在启动时才挂载）。

## 二、首次使用（模型会自动下载）

重启后，聊天输入框右侧会多出一个**电话图标**。点它：

1. 插件先自检模型文件（大小 + SHA-256），**缺哪个下哪个**，面板上会显示「正在准备语音模型 … %」
2. 全部就绪后自动接通，你会听到一句「通话已接通，请讲。」
3. 按住「按住说话」说话，松开即识别；也可以在面板里切到「连续对话」

首次下载合计约 **298 MB**（若 DSH 自带语音插件已经下过 SenseVoice，则约 **135 MB**），来自两个通道（都会自动选用）：

| 内容 | 体积 | 来源 |
|---|---|---|
| 语音识别（SenseVoice INT8 权重 + 词表） | 163 MB | GitHub release（`gh-proxy.com` 反代） |
| 语音检测（Silero VAD） | 1.8 MB | `hf-mirror.com` |
| 语音合成（MatchaTTS 声学模型 + espeak 数据） | 79 MB | GitHub release |
| 声码器（Vocos 16kHz） | 54 MB | GitHub release |

选装 Kokoro（`DSH_TTS_ENGINE=kokoro`，24kHz、103 个音色、首块约 1 秒）时，另下载 365 MB 的 Kokoro 多语言 v1.1 包；选装 MeloTTS（`DSH_TTS_ENGINE=melo`，**44.1kHz 原生输出**、首块约 0.9 秒）时另下载 159 MB（解压后约 182 MB）。**没选中的引擎就不会下载，也不会被判定为「模型缺失」**——三个引擎的清单互不影响。

如果 DSH 自带语音插件已经下过 SenseVoice，插件会**直接复用那份缓存**，不重复占用磁盘。

## 三、怎么用

| 操作 | 说明 |
|---|---|
| 按住说话 | 按住按钮说话，松开后识别、提交、等待回答并朗读 |
| 连续对话 | 直接说话，静音约 0.7 秒自动发送；助手说话时你开口可以打断 |
| 挂断 | 结束通话，终止语音子进程并撤除通话守则 |
| 插话 | 助手朗读时说话会立刻停播并转去听你 |

助手回答期间你仍可以继续说，语音会排队，不会丢。

## 四、通话中 agent 的行为

通话期间插件会给**当前会话的 agent** 注入一段「通话守则」（挂断即撤除）：

- 只回 1–2 句口语化短句，不用列表/代码块/表格/markdown，不念 URL 和路径
- 收到要动手的需求，**立刻用 `team_task_create` 建任务、`spawn_teammate` 拉队友（≤3 名）、`send_message` 分派**，然后只回一句「我已经让 X 去做 Y」
- **禁止 `wait_agent` 与轮询等待**——那会让它在电话里卡住说不出话；队友结果稍后以消息到达，再补一句结论
- 自己的工具调用能少则少，重活全部交给队友

## 五、架构

```
浏览器（client.js）
  通话按钮 / 录音 / 播放
        │  同源 HTTP  /api/call-mode.*
        ▼
宿主插件（index.js）        Cordis 服务
  会话编排：提交用户消息、抓这一轮回复、注入通话守则
  模型准备：自检 + 自动下载 + SHA-256 校验
        │  127.0.0.1 环回 + Bearer token
        ▼
子进程（server/worker.mjs）  第一次通话时拉起，挂断时结束
  STT / TTS / VAD，全程 16kHz 单声道 int16
```

- 控制通道用 DSH 的**插件级同源路由**（`ctx.connection.fetch.register`），自带 Host/Origin 围栏与浏览器认证，因此客户端不需要任何密钥
- 子进程崩溃会自动重启并重试一次；agent 答得慢时先播「还在处理」，真实结果排进队列由客户端轮询补播

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主一半：路由、会话编排、通话守则、进程与模型管理 |
| `client.js` | 浏览器一半：通话按钮、通话面板、录音、端点检测、播放 |
| `server/worker.mjs` | 子进程：STT + TTS + VAD，只监听环回端口 |
| `server/models.mjs` | 模型清单、自检、自动下载、校验、解包 |
| `cordis.patch.yml` | 把宿主行插入 profile |

## 六、配置（可选）

通过环境变量或插件配置覆盖：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_CALL_MODELS` | `~/.dsh/call-mode/models` | 模型目录 |
| `DSH_CALL_THREADS` | `4` | 推理线程数 |
| `DSH_STT_MODEL` / `DSH_STT_TOKENS` / `DSH_STT_VAD` | 自动解析 | 指定已有模型文件 |
| `DSH_TTS_ENGINE` | `matcha` | 合成引擎：`matcha`（默认，16kHz，首块几十毫秒）/ `kokoro`（24kHz，103 音色）/ `melo`（**44.1kHz**，单女声） |
| `DSH_TTS_NATIVE_RATE` | 未设置 | 设为 `1` 时**按模型原生采样率输出**（Melo 44.1kHz / Kokoro 24kHz），客户端按上报采样率建播放缓冲；不设则统一压回 16kHz。**两侧必须成对**，见「已知限制」 |
| `DSH_TTS_DIR` / `DSH_TTS_VOCODER` | 自动解析 | Matcha 的合成模型目录与声码器 |
| `DSH_TTS_KOKORO_DIR` | 自动解析 | Kokoro 模型目录（只在选用 Kokoro 时用到） |
| `DSH_TTS_MELO_DIR` | 自动解析 | MeloTTS 模型目录（只在选用 Melo 时用到） |
| `DSH_TTS_SID` | `4` | Kokoro 音色编号（0–102）。实测 4 / 46 / 53 / 57 / 74 中英混读最清楚（Melo/Matcha 单说话人，自动用 0） |
| `DSH_TTS_ALLOW_FAST` | 未设置 | 设为 `1` 时不钳制 Kokoro 语速（默认钳到 1.0，见「已知限制」） |
| `DSH_TTS_PRONOUNCE` | 未设置 | 设为 `0` 关闭「合成前读音白名单」（目前只有 `重载→虫在`） |
| `DSH_TTS_MODEL` | 自动解析 | 直接指定声学模型文件（三个引擎通用） |
| `DSH_SHERPA_PATH` | 自动解析 | `sherpa-onnx-node` 的绝对路径 |

合成语速、等待上限、问候语等可通过插件配置传（`threads` / `modelsDir` / `greeting` / `stillWorkingText` / `rulesOrder`）。

> 改 `DSH_TTS_ENGINE` **不需要重启 DSH**：语音子进程每次通话开始时重新拉起，下一通电话就按新引擎工作。改 `index.js` / `client.js` 才需要重启或刷新页面。

## 七、排错

日志（UTF-8，可直接用 PowerShell 读）：

```powershell
Get-Content "$env:USERPROFILE\.dsh\call-mode\call.log"   -Tail 30   # 宿主：路由注册、守则注入、回合、模型下载
Get-Content "$env:USERPROFILE\.dsh\call-mode\worker.log" -Tail 30   # 子进程：模型加载、每句合成/识别耗时
```

| 现象 | 处理 |
|---|---|
| 点通话后一直停在「正在准备语音模型」 | 看 `call.log` 里的下载日志；网络受限时可手动把模型放到 `~/.dsh/call-mode/models`（结构见 `server/models.mjs` 的 `targetPaths`） |
| 按钮没出现 | 确认插件在 profile 的 `bundles` 里，且重启过 DSH；`call.log` 里应有「客户端握手」 |
| 通话能接通但没声音 | 看 `worker.log` 是否有 `TTS 就绪`；确认浏览器允许了麦克风 |
| 下载报证书错误 | 本机 DNS 可能把 `huggingface.co` / `github.com` 投毒了；插件已内置 DoH + 真实 IP 与反代通道，仍失败请检查网络策略 |

## 八、已知限制

- 只支持 Windows x64（依赖 DSH 自带的 `sherpa-onnx-win-x64`）
- 语音在**运行 DSH 的机器**上识别与合成，不是浏览器所在机器
- 默认 Matcha 是单说话人、音色偏「念稿」，且**中英混读会把 `API` 念成 `baca`**（本机实测）；想要更自然的音色请设 `DSH_TTS_ENGINE=kokoro`，想要高采样率请设 `DSH_TTS_ENGINE=melo` + `DSH_TTS_NATIVE_RATE=1`
- **Kokoro 是可选引擎，首块延迟明显更高**：同一台机器实测约 0.6–1.5 s（Matcha 0.04–0.12 s），换来的是音色自然度与中英混读正确率（`这个 API 的 response 有点慢。` 能被 STT 逐字还原）
- **Kokoro 语速被钳到 1.0**：它的 `speed` 是长度缩放，实测 1.10 起开始吞字、1.25 三句全部识别失败（1.0 三句全对）。需要更快请设 `DSH_TTS_ALLOW_FAST=1`（后果自负）。Matcha 不受影响，语速按宿主设置走
- **采样率是模型自带的，不是设置项**：Matcha 16k / Kokoro 24k / Melo **44.1k**。要更高就得换模型，**升采样不产生信息**。**48k 没有意义**：44.1k 的奈奎斯特已经 22.05kHz，盖过人耳可听范围，再高只是更大的文件。
- **`DSH_TTS_NATIVE_RATE=1` 必须两侧配对**：worker 按模型采样率输出、客户端按 `/health.ttsSampleRate` 建播放缓冲（拿不到就回退 16k）。若一边开一边不开，44.1k 会被当 16k 播成 **2.75 倍速**。默认关闭，两侧都支持才建议打开。
- **Melo 44.1k 的如实说明**：单女声；中文与数字（配合 `ruleFsts`）实测良好；**英文缩写（API/HTTP/SQL）不在它的词表里，会读成字母或读歪**，中英混读不如 Kokoro。它**不能传 `espeak-ng-data`**（传了会绕开自带中文词表、中文变乱码，已写进 `worker.mjs` 注释）。
- **「糊」的改善有限，别期待翻倍**：实测同句能量分布——Matcha 16k 的 4–8kHz 占 0.16%、Kokoro 24k 占 0.21%、Melo 44.1k 占 **0.41%**（约 2.6 倍，主要改善齿音/咬字）；而 **8kHz 以上**：Matcha 结构上为 0、Kokoro 0.052%、Melo 0.097%。也就是说换 44.1k 拿回的是"空气感"，不是"变清晰一个档次"。
- 试听对照：`C:\AI\work\quality-lab\rate\{16k-matcha,24k-kokoro,44k1-melo}.wav`（同句、同响度归一化）
- 连续模式的阈值（VAD 门限、静音 3 秒、最长 120 秒）在 `client.js` / `server/worker.mjs` 中可调

## 九、卸载

```powershell
& 'C:\AI\dsh-latest\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove '@dsh-external/dsh-call-mode'
```

模型缓存在 `~/.dsh/call-mode/models`，可手动删除。

## 许可证

MIT（见 `LICENSE`）。使用的第三方组件：`sherpa-onnx`（Apache-2.0）、SenseVoiceSmall、Kokoro 多语言 v1.1（Apache-2.0，随包自带 `LICENSE`）、**MeloTTS zh-en（上游 MyShell MeloTTS 为 MIT，随包自带 `LICENSE`）**、MatchaTTS 与 Vocos 权重（各自模型卡许可）。
