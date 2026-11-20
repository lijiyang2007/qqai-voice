# 语音发送全解（VOICE）

本仓库已内置完整语音子系统：AI 可以把回复**合成语音**发到 QQ，也可以直接发送你准备好的
音频文件。核心源码在 `src/voice-core.js`、`src/tts-core.js`、`src/tts-breeze.js`、
`src/send-voice-lib.js`、`src/voice-delivery-receipts.js`。

> 与上游整理版不同，本仓库**默认开启语音**（`voice.enabled=true`、`tools.sendVoice=true`），
> 并默认使用 `breeze-first` 个性音色档。没配音色 ID / Key 时会自动回退到 Edge → SAPI，
> 所以**什么都不填也能发声**。个性化音色与密钥见 [BREEZE_TTS.md](BREEZE_TTS.md)。

---

## 1. 三种发送方式

| 方式 | 入口 | 适合 |
| --- | --- | --- |
| AI 工具（自动 / 被要求） | `qq_send_voice`、`qq_list_voices` | 群里有人说「说一句」「发个语音」时，AI 现场合成并发送 |
| 控制台面板 | <http://127.0.0.1:3100> →「语音库与语音发送」 | 人工试发、调整音量、管理语音库 |
| 桥接 CLI | `npm run send-voice` / `node scripts/send-voice.mjs` | 脚本、自动化 |

AI 工具是否可用由两处开关同时决定（都在 `config.json` 的 `socialV2` 下）：

```jsonc
"tools": { "sendVoice": true },     // 把工具暴露给 AI
"voice": { "enabled": true }        // 语音子系统总开关
```

任一处为 `false`，AI 都拿不到发语音能力。

## 2. 配置解析顺序

桥接启动时把 `config.json` 读进内存，按以下顺序决定实际行为：

1. `socialV2.voice.enabled` — 总开关。
2. `socialV2.tools.sendVoice` — 工具是否对 AI 可见。
3. `socialV2.voice.tts.*` — 文字转语音（provider、音色、字数、云端配置、主动开口）。
4. `socialV2.voice.*` 其余项 — 目录、体积/时长上限、音量、响度、回读、ffmpeg 路径。

`voiceId` 是**热读**的（见 `src/bridge.js` 的重载逻辑）：改 `tts.breeze.voiceId` 不必重启；
其它配置改完要重启桥接才生效（`restart.bat`）。

## 3. 配置项速查（`socialV2.voice`）

| 键 | 默认（本仓库示例） | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 语音子系统总开关 |
| `dir` | `audio` | 预置语音文件目录（已被 `.gitignore` 排除，不入库） |
| `maxSeconds` | `300` | 单条语音最大时长 |
| `maxBytes` | `20971520` | 单条语音最大体积（20 MiB） |
| `maxPerMinute` / `maxPerHour` | `2` / `10` | 发送频率硬上限 |
| `allowAbsolutePath` | `false` | 是否允许 AI 发绝对路径下的音频（安全默认关） |
| `defaultVolume` | `1` | 默认音量 |
| `loudness` | `normal` | 响度归一化 |
| `ffmpegPath` | `""` | ffmpeg 路径，留空则用 PATH 里的；转码/抽帧需要 |
| `autoReadback` | `true` | 发送后回读校验是否落地 |

## 4. 文字转语音（TTS）

`socialV2.voice.tts` 关键项：

| 键 | 值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否允许现场合成 |
| `provider` | `breeze-first` | 先云端个性音色，失败回退 Edge → SAPI |
| `voice` | `zh-CN-XiaoyiNeural` | 回退用的 Edge 音色 |
| `maxChars` | `200` | 单条语音字数上限 |
| `breeze.voiceId` | `""` | 个性音色 ID，留空则云端静默剔除 |
| `autoSpeak.enabled` | `true` | AI 发完文字后按概率补一条语音 |

**provider 可选值**：`auto`（默认，Edge→SAPI，免密钥）/ `edge` / `sapi`（纯本地离线）
/ `breeze`（只走云端）/ `breeze-first`（云端优先，带三级回退）。

不想花钱、也不想填任何密钥：把 `provider` 改成 `auto` 即可，开箱即用。
想要个性音色：见 [BREEZE_TTS.md](BREEZE_TTS.md)。

## 5. ffmpeg（可选但推荐）

语音转码、音量处理、图片抽帧都靠 ffmpeg。它**不是** npm 依赖，按平台自行安装，
放进 `tools/ffmpeg.exe`（`tools/` 已 `.gitignore`），或确保它在 PATH 里。
装法与排错见 [MEDIA_PIPELINE.md](MEDIA_PIPELINE.md)。

没有 ffmpeg 时降级运行：预置音频按原样发，TTS 生成走直出，只是没有响度归一化/抽帧能力。

## 6. 验证（本地，基本不花钱）

```bash
npm run test-voice          # 语音发送主链路
npm run test-voice:system   # 系统级
npm run test-voice:tts      # TTS 分支
npm run test-voice:volume   # 音量/响度
npm run test-voice:gui      # 控制台面板契约
node scripts/tts-breeze-selftest.mjs   # 云端请求形状/缓存/失败分支（离线，不花钱）
```

真机验收（你自己做）：填好音色与 Key 后，用控制台「TTS 试发」发到你自己的测试会话，
确认「生成 → 送达 → 播放」三个检查点全绿。

## 7. 安全边界

- 语音文本和文字消息一样，过 `assertOutboundAuditOk`（敏感信息审计）与发送限流。
- API Key 只读 `state/secrets/breeze.json`（已忽略）或环境变量 `BREEZE_API_KEY`，
  **不写进 `config.json`、不进仓库**。模板见 `scripts/breeze.example.json`。
- `allowAbsolutePath=false` 防止 AI 读取账号目录下的任意音频文件。
- 不要把控制台 / SnowLuma / DSH 的端口暴露到公网；完整边界见
  [SECURITY_BASELINE.md](SECURITY_BASELINE.md)、[PRIVACY.md](PRIVACY.md)。
