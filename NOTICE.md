# NOTICE

本文件说明本仓库的**著作权归属、许可范围、第三方组件与合规边界**。

本文件不是许可条款，也不构成对许可条款的补充、限制或解释。本软件的许可条款以 [`LICENSE`](LICENSE) 为准；
本文件与 `LICENSE` 不一致时，以 `LICENSE` 为准。

---

## 一、来源

本仓库的**主要代码**（`src/`、`scripts/`、`public/`、`dsh/`、`plugins/`、`roles/` 的结构、
`config.example.json`、`RULES.md`、`docs/guides/` 下的绝大部分文档）来自：

> **qq-bridge** — <https://github.com/Derpyu520/qq-bridge>
> 原作者：**Derpyu520** 及 qq-bridge 贡献者
> 本仓库取用的版本基线：**`v0.2.1-r1`**（MIT 许可）

上游项目在 **2026-11-11** 公告停止维护，并计划于 2026-11-18 前后归档
（见其 `SUNSET.md` 与 issue #180）。据其 `NOTICE.md` §1.3 的明确说明：
**`v0.2.1-r1` 及更早的发布版本，仍可按其发布时的 MIT 条款使用。**

本仓库取用的正是 `v0.2.1-r1` 基线，因此按 **MIT** 继续分发，并**完整保留**原始版权声明。

## 二、本仓库做了什么改动

本仓库**不是**上游的完整镜像，只保留「把 AI 接到 QQ」这条主链路，并做了两类改动：

### 2.1 脱敏

- 移除所有个人 QQ 号（原作者相关号码统一替换为 `OWNER_QQ` / `MOM_QQ` 等占位符，测试夹具改为假号码）；
- 移除本机绝对路径（`C:\Users\<用户名>\...`、`D:\<本机目录>\...`），改为可配置项或占位符；
- `config.json`、`state/`、`*.bak`、`*.bak-*`、语音库、`tools/` 下的二进制**一律不入库**；
- 移除 `_snowluma-catalog.json`（该文件属再分发 `@snowluma/mcp` 的内容，不应提交）。

### 2.2 裁剪

移除与「接线」无关、且强绑定作者本机环境的子系统与脚本，包括但不限于：
一键启动器（`start-all.*`、`启动桥接.bat`、`restart-dsh-and-bridge.bat`）、
SnowLuma 图标替换脚本、翻唱 / 语音合成流水线（`breeze` 相关脚本与文档）、
本机专用运维脚本（`autostart.ps1`、`restart-dsh.ps1`、`repair-config-*.mjs` 等）。

文档索引因此做了相应调整：指向已移除文件的条目已清理。
上游原始 README 保留在 [`docs/guides/UPSTREAM_README.md`](docs/guides/UPSTREAM_README.md) 仅供参考，
其中提到的部分文件在本仓库中并不存在。

## 三、第三方组件

本软件依赖或涉及下列第三方组件。各组件依其自身许可授权，不适用本软件的许可。

| 组件 | 许可 | 说明 |
|---|---|---|
| [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) 及 `@deepseek-ai/*` 各包 | MIT | DeepSeek Harness 本体与官方 API 客户端 |
| [`@snowluma/sdk`](https://www.npmjs.com/package/@snowluma/sdk)、[`@snowluma/mcp`](https://www.npmjs.com/package/@snowluma/mcp) | 包内声明为 `SEE LICENSE IN LICENSE`，但发布包**未附**许可文件 | 仅作 npm 依赖使用；本仓库**不分发**其代码与二进制 |
| **SnowLuma** 本体 | 源码可见的非商业许可（非 OSI 开源许可） | 本仓库**不包含、不分发**其源码与二进制，仅通过 OneBot v11 协议通信 |
| `@modelcontextprotocol/sdk`、`js-yaml`、`zod` 等 | MIT / ISC | 见各自包内 LICENSE |

### 3.1 `@snowluma/*` 的处理

`npm install` 的 `postinstall` 会运行 `scripts/patch-snowluma-sdk.mjs`，对**本机安装的**
`node_modules/@snowluma/{sdk,mcp}` 做一次机械修补（为相对导入补齐 `.js` 扩展名，
绕开这两个包自身的 ESM 打包缺陷）。该修补只作用于本机安装副本，**不进入本仓库**；
SnowLuma 许可允许为自身非商业使用而修改。**本软件不修改 SnowLuma 应用本体。**

### 3.2 `@snowluma/*` 的许可瑕疵（已知问题）

**事实**（2026-09-20 实测，可自行复核）：

- 两个包的 `package.json` 都声明 `"license": "SEE LICENSE IN LICENSE"`；
- 但**发布的 npm 包里没有 LICENSE 文件**：`npm pack @snowluma/sdk --dry-run` 的文件清单只有
  `dist/`、`README.md`、`CHANGELOG.md`、`VERSIONING.md`；
- 原因在源头：仓库里 `packages/sdk/package.json` 与 `packages/mcp/package.json` 的 `files` 数组
  没有包含 `LICENSE`，且 `packages/sdk/LICENSE` 与 `packages/mcp/LICENSE` 在仓库中并不存在。

**这意味着什么**：这两个包的许可在包内**不可判定**——`SEE LICENSE IN LICENSE` 指向一个不存在的文件。
但 SnowLuma LICENSE §1 对 "Software" 的定义是「the SnowLuma source code and assets **in this repository**」，
而 `packages/sdk` 与 `packages/mcp` 就在那个仓库里，所以它们在文本上确实受同一份非商业许可约束。

**本仓库对它们的处理**：

1. 仓库内**不含、不分发**它们的代码：`node_modules/` 已在 `.gitignore`；已跟踪文件中没有任何原生二进制
   （`.node` / `.dll` / `.so`）或 `@snowluma` 路径下的文件；
2. 但 `npm install` 会改本机安装副本：`postinstall` 运行 `scripts/patch-snowluma-sdk.mjs`，
   对 `node_modules/@snowluma/{sdk,mcp}` 的 `dist/**/*.js` 做一次性机械修补（只给相对导入补 `.js`
   扩展名，绕开这两个包自身的 ESM 打包问题）。许可允许为自身非商业使用而修改；
   它**只作用于本机安装副本、不进入本仓库**；
3. 若要彻底消除不确定性，可向 SnowLumaDevs 书面确认 `packages/sdk` 与 `packages/mcp` 适用的许可。

## 四、与 SnowLuma 的关系

### 4.1 独立关系

本软件是独立维护的第三方工具，**不是 SnowLuma 的子项目**；与 SnowLuma、DeepSeek、腾讯 / QQ
之间不存在隶属、官方合作或背书关系。

### 4.2 互操作性

本软件**不包含、不分发** SnowLuma 的源码与二进制，仅通过 OneBot v11 协议与其通信。
它会在本机读取安装目录下的 `config/onebot_*.json`，从已有账号配置中寻找当前可用的接入令牌，
并且只将该令牌用于连接相应的 OneBot 地址。**本软件不是 SnowLuma 的修改版或衍生版本。**

### 4.3 必须遵守的边界（重要）

SnowLuma 的 EULA / LICENSE 对以下行为有明确限制，本软件**不做**这些事：

- ❌ 不安装、不复制、不打包 SnowLuma 及其原生组件；
- ❌ 不把 SnowLuma 并入第三方安装包或 Docker 镜像；
- ❌ 不通过自动化脚本部署 SnowLuma；
- ❌ 不以程序化方式启动或结束 SnowLuma 进程；
- ✅ 只做端口探测与状态查询，缺失时提示使用者自行经官方渠道获取并启动。

据此，历史上存在过的 `start_snowluma` / `stop_snowluma` 工具与 `snowluma.allowProcessControl`
配置项**已被移除**，并有回归断言防止回退。

### 4.4 明确排除的使用形态

下列形态会直接落入 SnowLuma 的禁止范围，**不因本软件采用何种许可而改变**：

1. 提供付费的托管、部署、代搭或代运营服务（含以成本价收费）；
2. 将本软件并入任何付费产品或服务；
3. 以收费方式运行本软件对外提供服务；
4. 将赞助或捐赠与可获得的服务相绑定。

### 4.5 结论

本软件的版权许可**只覆盖本软件自身的代码**，不对 SnowLuma 授予任何权利，
也不代替使用者依其许可应承担的义务。使用者应自行取得 SnowLuma 并遵守其许可。

## 五、数据出机清单

本软件运行时主要有下列网络出口。部署方应在部署前知悉，并按适用法律与所在平台规则履行告知义务。

| 目的端 | 传输的数据 | 默认 | 关闭方式 |
|---|---|---|---|
| 本机 DSH | 群聊与私聊消息文本、图片、昵称、会话上下文 | 启用 | 不运行 DSH |
| LLM 提供方（经 DSH 调用） | 同上，包含群内其他成员的消息 | 启用 | 在 DSH 中更换 provider 或 model |
| OneBot 网关（本机） | 发出的消息与动作参数 | 启用 | 不接入 QQ |
| `web_search` → 搜索接口 | 搜索关键词 | 启用 | 不挂载 `mcp-web-search-safe`，或关闭黑话自动研究 |
| `web_fetch` → 公网 URL | 被抓取的页面地址 | 启用 | 不挂载 `mcp-web-search-safe` |
| 图片与表情等媒体 URL → QQ CDN 或公网地址 | 媒体地址及下载请求 | 启用 | 不接入 QQ |

本软件**不包含**遥测、统计或 phone-home 机制。

## 六、使用风险与免责

1. 使用非官方协议工具接入第三方平台，可能违反该平台的服务条款并导致账号受限，**风险由使用者承担**；
2. 本软件将聊天内容交由第三方大语言模型处理，并可能代账号发言。部署方应仅在
   [RULES.md](RULES.md) 所述白名单与审计机制下运行，不应在未配置白名单的情况下向任意群聊或陌生人开放；
3. 部署方应保护控制台令牌、`config.json` 与 `state/` 的访问权限，不应将 DSH 或本软件的端口暴露于公网；
4. 本软件按「现状」提供，不附带任何明示或默示担保。

## 七、联系

- **安全漏洞**：请勿以公开 issue 披露，先私下联系维护者；
- **许可与合规问题**：在本仓库提交 issue；
- **上游项目相关**：请前往 <https://github.com/Derpyu520/qq-bridge>。
