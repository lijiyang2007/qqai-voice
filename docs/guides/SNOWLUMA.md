# SnowLuma：获取、校验与边界

> **本仓库不分发 SnowLuma，也不提供它的下载、安装脚本或自动部署。**
> 本文只说明：它是什么、为什么本仓库不能提供、你自己拿到之后如何校验、以及用哪些配置把它接上。

---

## 一、它是什么

SnowLuma 是 QQ 侧的**网关**：它通过原生组件接入你正在运行的桌面 QQ 进程，
把 QQ 消息翻译成公开的 **OneBot v11** 协议（WebSocket + HTTP API）。
本仓库的 qq-bridge 只和这两个端口说话，不碰 QQ 客户端。

```
你的 QQ 账号 ──> SnowLuma（WS :3001 / HTTP :3000）──> qq-bridge ──> DSH
```

## 二、为什么本仓库不能提供它

SnowLuma 采用**源码可见的非商业许可**（SnowLuma Source-Available Non-Commercial License），
其 **EULA 第 5.4 条**明确写道：

> 除事先取得著作权人的书面授权外，您仅可为 LICENSE 允许的非商业用途，以专有组件随本软件提供的形式运行该组件；
> **不得复制、修改、单独再分发或再许可该组件。将其并入第三方安装包或 Docker 镜像、通过自动化脚本部署**，
> 或者将其用于任何商业用途，均须事先取得**书面授权**。

EULA §2.2 也规定：**公开发布修改版或衍生版须事先取得著作权人书面授权**。

因此本仓库**不做**以下任何一件：

- ❌ 上传、镜像、打包 SnowLuma 的二进制或原生模块（`snowluma-*.node` / `.dll`）
- ❌ 提供「一键安装包」「整合包」「Docker 镜像」
- ❌ 用脚本自动下载、部署或启动它
- ❌ 代为启动 / 停止其进程

本仓库**只做**：端口探测与状态查询，缺失时提示你自行获取并启动。

## 三、现状：官方渠道已不可用

截至本文件撰写时（2026-11）：

| 渠道 | 状态 |
|---|---|
| `github.com/SnowLuma/SnowLuma` | 已不可访问（删除/私有化） |
| `snowluma.github.io` 文档站 | 404 |
| 官方发行包下载 | 无可用入口 |

**这意味着**：如果你手上已经有一份可用的 SnowLuma **发行包**，它是相对稀缺的；
如果你还没有，需要自行想办法取得，本仓库无法提供，也不建议使用来路不明的第三方镜像
（原生组件会被注入到 QQ 进程，来源不明等于把本机交给陌生人）。

## 四、你手上的副本如何校验

拿到发行包后，先确认它不是被改过的版本。下面是**一份已确认可正常工作的 Windows x64 发行包
（`2.2.1`）**的 SHA256，供你对照：

### 核心文件

```
index.mjs                         12,219,937  0F7EA346AB7E700367CE905A1D0069F36B9615FDE2D43EEF6255ABB1C1295497
launcher.bat                             100  019EAECF89F172B723DED4CF999736ADFAFD64562A9E6ACB4155E213C85DEA21
release.json                             237  2E85361205485FCBA7A20130CAE8DD59A6D904887EAFA8E10804E862B7560E5E
package.json                             602  3DE39184D967A4328C41F46A21EB5A9AC1A1161297743B3E57DE1C0F67B96F21
```

> ⚠️ `node.exe` 的哈希**不能作为校验依据**：该文件是官方 Node 运行时，可能被使用者替换图标或版本，
> 属于正常操作。校验请以上面四个文件与下面的原生模块为准。

### 原生模块（这才是真正的「专有组件」）

```
native/snowluma-win32-x64.dll                                414,208  986312643EC533F57DE31681218739853A8FDC259DB8D5A5897212B5A133F8A8
native/snowluma-win32-x64.node                               344,064  6D8AA2479D774F333E76CC158FF09A5DC95E8B69074C73EA71865D7D7122B806
native/websocket-win32-x64.node                              163,328  6E71A14B1D28A6259BC1FB52DEA2BDF13F100B326C04B14132F7A53B64FE9383
native/ffmpeg/ffmpegAddon.win32.x64.node                   6,812,160  80A4DFBB170F093F4A64FE241B8583FB630C58219100CAD7A3CAD798F71864DB
native/sqlite/prebuilds/win32-x64/@appthreat+sqlite3.node  2,558,464  E8898FD92AEBBECDC946C14E2A9F9C481946DE3CBDE1EBC3C647C02892640598
```

校验命令（PowerShell）：

```powershell
Get-FileHash .\native\snowluma-win32-x64.dll -Algorithm SHA256
Get-FileHash .\native\snowluma-win32-x64.node -Algorithm SHA256
```

> **原生模块哈希对不上 = 直接停用。** 这几个文件会被加载进 QQ 进程，
> 一个被改过的 `.node` 等于本机权限完全交给对方。

## 五、版本与前置要求

- 本文的哈希对应 **SnowLuma 2.2.1 / win32-x64**。
- SnowLuma 运行时要求 **Node.js 24.22.1 或 ≥ 26.12.1**（见其 `package.json` 的 `engines`）。
  注意这**比 qq-bridge 要求的 ≥ 22.13 更严**，两者不冲突但别装低了。
- SnowLuma 只支持**扫码登录**，没有命令行登录。
- 首次用全新数据目录启动时，日志里会打印一次性的 WebUI 管理员密码。

## 六、接到本仓库上需要改的配置

SnowLuma 起来后，确认 OneBot 的两个端口，然后改本仓库的 `config.json`：

| 字段 | 填什么 | 说明 |
|---|---|---|
| `snowluma.wsUrl` | `ws://127.0.0.1:3001` | OneBot **WebSocket** 地址 |
| `snowluma.httpUrl` | `http://127.0.0.1:3000` | OneBot **HTTP API** 地址，**别填 WS 端口**（会 426） |
| `snowluma.homeDir` | SnowLuma 安装目录 | 桥接要从 `config/onebot_*.json` 里读 WS token 做自愈 |
| `snowluma.accessToken` | HTTP 那个 token | 见下方「两个 token 不是同一个」 |

### ⚠️ 两个端口的 token 不是同一个

SnowLuma 的 **HTTP token（3000）与 WS token（3001）是两个不同的值**，而 `config.json` 只能存一个
（存 HTTP 那个）。所以首次连接 WS 会被拒 → 触发 token 自愈 → 重连成功。
**日志里先报一次「连接断开（1006）」再报「已连接」是正常的**，不要去"修"它。

真正有问题的是**自愈也失败**（日志出现 `token 自愈失败`），那时先确认 `snowluma.homeDir`
指向真正的安装目录。

## 七、安全提醒

1. **两个 accessToken 在 SnowLuma 的 `config/onebot_<QQ号>.json` 里是明文**。
   该文件不要提交、不要截图外发、不要放进任何同步盘。
2. 拿到过旧 token 的人（包括曾经的日志、备份、截图）都能连上你的 OneBot 端口。
   **怀疑泄露就在 WebUI 里重新生成**，让旧值失效。
3. OneBot 的 `host` 必须是 `127.0.0.1`，不要改成 `0.0.0.0`。
4. 不要用来源不明的镜像或别人打包的版本——原生组件会被注入 QQ 进程。

## 八、常见问题

**Q：官方删库了，我还能用吗？**
A：已取得的发行包可以继续运行，直到 QQ 客户端升级导致原生组件不兼容。本仓库不提供获取渠道。

**Q：能不能把 SnowLuma 打进本仓库的 Release？**
A：不能。这直接违反 EULA §5.4 的「不得单独再分发」。需要书面授权才能做。

**Q：我用的是别的版本（2.2.x / 2.4.x）怎么办？**
A：本文哈希只对应 2.2.1。其它版本请以发行包自带的内容为准，本仓库不为其背书。
