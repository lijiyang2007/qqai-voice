# 文档索引（docs/README.md）

> 本仓库只保留「把 AI 接到 QQ」主链路的文档。上游原始文档见
> [guides/UPSTREAM_README.md](guides/UPSTREAM_README.md)（其中提到的部分文件在本仓库中已裁剪）。
> 仓库目录结构见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。

---

## guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 |
| --- | --- |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装：`qq-chat` / `qq-chat-v2` preset 与三个 MCP server 怎么挂到目标设备 |
| [guides/SNOWLUMA.md](guides/SNOWLUMA.md) | **SnowLuma 获取、校验与边界**：为什么本仓库不能分发它、官方渠道现状、发行包 SHA256 校验、两个 token 不是同一个 |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | **DSH 0.2.0 适配改动记录**：现象 / 为什么必须改 / 证据 / 怎么验证 |
| [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) | **最新**：DSH 0.2.1 适配（`{{cwd}}` 提示词变量被删导致的 P0）。升级 DSH 前先读 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：威胁主体、已实现的边界、已知残余风险、发布前回归清单。**改动安全相关代码前必读** |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 数据出机清单与脱敏规则 |
| [guides/VOICE.md](guides/VOICE.md) | **语音发送全解**：三种发送方式、配置解析顺序、TTS 三档、ffmpeg、验证与安全边界 |
| [guides/BREEZE_TTS.md](guides/BREEZE_TTS.md) | **个性音色**：拿 Voice ID、填 Key（只走本地/环境变量）、回退与自检 |
| [guides/MEDIA_PIPELINE.md](guides/MEDIA_PIPELINE.md) | 图片 / 表情 / 媒体处理链路，以及 `tools/` 下 ffmpeg 等本地二进制的处理约定 |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径、API、配置 |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）与离线浏览器回归（`npm run test:console-ui`） |
| [guides/UPSTREAM_README.md](guides/UPSTREAM_README.md) | 上游 qq-bridge 的原始 README（中文），**仅作参考**：其中提到的部分文件本仓库已裁剪 |
| [guides/UPSTREAM_README.en.md](guides/UPSTREAM_README.en.md) | 同上，英文版 |

---

## 常见问题 → 看哪篇

| 我想…… | 看 |
| --- | --- |
| 搞懂整体架构 / 数据流 | [../README.md](../README.md) 第一节 |
| 把 preset 和 MCP 挂到 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 升级 DSH 后 QQ 突然全都不回了 | [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) |
| 改的东西和安全有关 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 知道数据都发去哪了 | [guides/PRIVACY.md](guides/PRIVACY.md) |
| 看 AI 花了多少钱 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 改控制台界面并做离线回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) |
| 写人设卡 | [../roles/README.md](../roles/README.md) |
| 了解许可与合规边界 | [../NOTICE.md](../NOTICE.md) |

---

## 已裁剪的文档

上游仓库还有 `design/`、`research/`、`audits/`、`legacy/` 四个目录以及翻唱 / 语音合成相关文档。
它们要么讲的是与「接线」无关的设计与历史，要么强绑定作者本机环境（个人用量数据、本机路径），
因此**本仓库不收录**。需要的话请直接看上游：<https://github.com/Derpyu520/qq-bridge>
