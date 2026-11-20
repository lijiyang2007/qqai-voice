# 媒体管线：图片 / 动图 / 大图怎么进模型

桥接把 QQ 里的图片喂给模型之前，要先过一层归一化（`src/media-normalize.js`）。
这份文档说明「为什么要这层」「它依赖什么」「出问题看哪里」。

## 1. 为什么不能直接把原图交给 DSH

两个硬约束，都不是调参能绕开的：

1. **体积悬崖**：DSH 的 MCP 图片入口用正则校验 base64
   （`CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:…)?$/`）。这条正则在长输入上会压爆
   V8 的 regexp 回溯栈，实测 base64 ≥ 4,474,880 字符（原始字节 ≥ **3.20 MiB**）必抛
   `RangeError: Maximum call stack size exceeded`，然后整个图片被降级成一行
   `[image unavailable: image/gif; Maximum call stack size exceeded; …]`。
   而桥接的**抓取**上限（`socialV2.media.maxBytes`，默认 16 MiB）远在这条线之上 ——
   3.2 MiB 以上的图「桥接认为合法、DSH 必然拒绝」，模型一个字节都拿不到。
2. **动图变单帧**：DSH 的 `canPassThroughNormalization()` 显式排除 `image/gif`，
   一律交给 sharp 归一化，而 sharp 默认只解 page 0。一张 48 帧的动图，模型只看到
   第 1 帧，而且上下文里没有任何「这是动图」的提示 —— 它只能瞎猜。

所以分工是：**桥接抓大文件 → 压到模型能吃的体积 → 动图抽帧拼成一张网格图 → 附一句
说明告诉模型「这是 N 帧、按行优先读」**。

## 2. 数据流

```
QQ 消息（image / mface 表情）
   └─ extractMediaFromSegments        元数据：file / url / emojiId / subType
        └─ fetchOneBotImage           原始字节（CDN → 网关 get_image 兜底），最大 socialV2.media.maxBytes
             ├─→ collectStickerV2     收藏表情：**必须原始字节**，不过归一化
             └─→ toModelMedia         ← 归一化在这里
                   ├─ 小图（≤ maxModelBytes 且长边 ≤ maxLongEdge）：原样放行，零延迟
                   ├─ 静态大图：ffmpeg 降采样 + 重编码（最多三轮，逐步降尺寸/质量）
                   ├─ 动图：ffmpeg 抽 N 帧 → tile 拼成网格 → 单张 JPEG
                   └─ 压不动：返回 ok:false + 可读原因，绝不发注定被 DSH 丢掉的字节
                        └─ DSH prompt（image part）→ 模型
```

出口只有三个，全部已接上：一代自动内联（`resolveMediaList`）、二代唤醒内联、
`qq_get_message_images` / `qq_get_sticker_image`（`fetchMediaData`）。
合并转发里的图片也走 `fetchMediaData`。

## 3. 依赖：ffmpeg

抽帧拼图与重编码都靠 ffmpeg。它**不是** npm 依赖（体积大、要按平台下载），
需要单独放进 `tools/ffmpeg.exe`（`tools/` 已在 `.gitignore` 里）。

装法（任选，二选一即可）：

```powershell
# A. 从 npm 源取预编译二进制（不需要管理员权限，不占 PATH）
cd qq-bridge
npm install @ffmpeg-installer/win32-x64 --prefix .ffmpeg-dl
Copy-Item .ffmpeg-dl\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe tools\ffmpeg.exe

# B. 已经在 PATH 里的 ffmpeg（winget install Gyan.FFmpeg），什么都不用拷
```

然后把路径写进 `config.json`：

```json
"socialV2": {
  "voice": { "ffmpegPath": "C:/…/qq-bridge/tools/ffmpeg.exe" },
  "media": { "maxBytes": 16777216 }
}
```

> **必须重启桥接才生效**：`modelMediaLimits` 是启动时算的常量。
> 重启后看日志里 `[media]` 那一行：`归一化就绪` 还是 `归一化降级`。

`ffmpegPath` 复用了语音那一个字段 —— 语音转码和图片处理要的是同一个二进制。

## 4. 配置项（`config.json` → `socialV2.media`）

| 键 | 默认 | 说明 |
|---|---|---|
| `normalize` | `true` | 总开关。`false` 时原样交给 DSH（应急用） |
| `maxBytes` | 16 MiB | **抓取**上限，单张图。小于它才有机会被压缩 |
| `maxModelBytes` | 1 MiB | **交给 DSH** 的原始字节上限（硬顶 3 MiB） |
| `maxLongEdge` | 1280 | 长边上限，超过就缩 |
| `gifFrames` | 6 | 动图抽几帧（2–12）。6 帧正好 3×2 |
| `gifTile` | 240 | 每格宽度 px（64–400） |
| `normalizeTimeoutMs` | 25000 | 单次 ffmpeg 调用的硬超时 |
| `tmpDir` | `state/tmp` | 临时目录，**别放 `%TEMP%`**（见下） |
| `maxPixels` | 64 MP | 解码像素上限，防「图片炸弹」 |

## 5. 临时目录为什么不用 `os.tmpdir()`

实测：受限环境下 ffmpeg 往 `%TEMP%` 写文件会直接 `Permission denied`，而
`runFfmpeg` 用的是 `stdio:'ignore'`（受限沙箱里 pipe 会 EPERM），拿不到 stderr，
最终只剩一句「ffmpeg 退出码 1」——看起来像编码器坏了，其实是没权限。

所以临时目录默认落在 `state/tmp`（工作区内，沙箱内外都可写）。`processAudioVolume`
（语音音量/响度）同理。

## 6. 降级行为（没有 ffmpeg 时）

| 情况 | 结果 |
|---|---|
| 动图 ≤ `maxModelBytes` | 给首帧 + 说明「抽帧拼图失败：…，看不到动作」 |
| 动图 > `maxModelBytes` | 不给图，`ok:false` + 原因 |
| 静态图 ≤ `maxModelBytes` | 原样提供 |
| 静态图 > `maxModelBytes` | 不给图，`ok:false` + 原因 |

降级不会崩，也不会让模型收到「看不懂的英文错误」——但动图看不到动作、大图完全看不到。
启动日志里会有 `[media] 归一化降级` 明确提示。

## 7. 怎么验证

```powershell
npm run test:media-normalize
```

21 条断言，覆盖格式/帧数探测、决策纯函数、真实抽帧拼图、真实降采样、失败路径，
以及「收藏表情必须拿原始字节」。ffmpeg 走 `config.json` 的 `ffmpegPath`，
找不到才 SKIP —— 以前只探 PATH，导致「配了 ffmpegPath 的机器上真路径永远 SKIP」。
