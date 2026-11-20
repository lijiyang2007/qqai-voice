# BreezeBlue 个性音色（BREEZE_TTS）

给桥接接一套云端 TTS：让 AI 用自己设计的声音说话，而不是只用Edge朗读腔。
**默认不启用到音色**——需要你自己填一个 Voice ID 和 Key 才会真的走云端。

> 本仓库默认 `provider: "breeze-first"`：没配音色/Key 时**自动回退**到 Edge → SAPI，
> 所以不填任何东西也能发声；填了才升级成个性音色。

## 现状

| 项 | 状态 |
| --- | --- |
| 代码 | 已接好（`src/tts-breeze.js` + `tts-core.js` 的 provider 链） |
| 配置 | `provider: "breeze-first"`，`voiceId` 为空 |
| 密钥 | **未配置** → 现在走 Edge 晓伊 |
| 自检 | 离线 17/17 通过（`node scripts/tts-breeze-selftest.mjs`） |

## 两步启用个性音色

### 1. 选声音，拿 Voice ID

到 [BreezeBlue 语音设计](https://breezeblue.ai/zh/voice-design) 用你自己的描述生成一版，
试听满意后保存，复制保存后的 `voc_...` ID。

> 本仓库**不提供任何现成音色 ID**。请用你自己生成/拥有的 ID，不要把别人的 ID 写进公开配置。

### 2. 填 Voice ID 和 Key

`config.json` → `socialV2.voice.tts.breeze.voiceId`：

```jsonc
"breeze": { "voiceId": "voc_你的ID" }
```

密钥二选一（**不要写进 config.json**）：

- 环境变量 `BREEZE_API_KEY`（启动桥接前设置），或
- `state/secrets/breeze.json`（该文件已被 `.gitignore` 排除，不会提交）：

```jsonc
// scripts/breeze.example.json（模板，拷贝到 state/secrets/breeze.json 再填）
{ "apiKey": "你的Key" }
```

改完重启桥接；`voiceId` 是热读的，不必重启，其它项要重启才生效。

## 验证顺序

```bash
node scripts/tts-breeze-selftest.mjs          # 1) 不花钱：请求形状/缓存/失败分支
node scripts/tts-breeze-selftest.mjs --live   # 2) 花钱（约几 credits）：合成一句，只落盘不发群
```

第 2 步生成的 mp3 在 `state/tts/`，可先本地听。确认无误后再用控制台
「语音库与语音发送 → TTS 试发」发到你自己的测试会话（第 3 步真机验收由你完成）。

## 配置项

`socialV2.voice.tts.breeze`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `voiceId` | 空 | **必须填**，否则云端静默剔除、按 Edge 走 |
| `baseUrl` | `https://api.breeze.blue` | 云端地址 |
| `outputFormat` | `mp3` | 输出格式 |
| `speed` | `1` | 0.5~2.0，只影响云端 |
| `timeoutMs` | `15000` | 超时即回退 |

`socialV2.voice.autoSpeak`（概率性主动开口）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就只在明确要求时发 |
| `probability` | `0.05` | 每次发完文字，5% 概率补一条语音 |
| `minGapMs` | `1200000` | 两条语音至少隔 20 分钟 |
| `maxPerHour` / `maxPerDay` | `2` / `6` | 硬上限 |
| `minChars` / `maxChars` | `6` / `60` | 太长太短的不念 |
| `delayMinMs` / `delayMaxMs` | `1200` / `3500` | 发完文字后隔多久开口 |

按 5% × 每天约 100 条文字回复估算约 5 条/天，被 `maxPerDay: 6` 兜住。

## 回退（三条命令级操作）

```jsonc
// A. 只回退到 Edge，保留云端代码：provider 改成 "auto"，重启
// B. 关掉概率性开口，保留"我让它说才说"：autoSpeak.enabled 改成 false，重启
// C. 完全摘掉：删 src/tts-breeze.js 不行（tts-core 里 import 了），
//    改成 provider:"auto" 即可，breeze 段留着也不会被调用
```

## 安全边界

- Key 只从环境变量 `BREEZE_API_KEY` 或 `state/secrets/breeze.json` 读，**不写进 config.json**。
- 控制台接口只回 `keyConfigured: true/false`，不回 Key。
- 错误信息只带 HTTP 状态和响应体前 200 字，不含请求头。
- `voiceId` 有格式白名单（`voc_[A-Za-z0-9]+`），防止被拼进 URL 做路径穿越。
- 语音文本照旧过 `assertOutboundAuditOk`（敏感信息审计）和发送限流。
