# @reai/agent-computer（原型）

给 Agent 一台自己的后台电脑：与宿主同系统的虚拟机，在后台无窗口运行。Agent 的鼠标键盘只作用于这台虚拟机，不影响宿主的鼠标、键盘、剪贴板和屏幕。文件经用户批准才进入用户目录。

方案与验收见 [Agent 电脑原型 v0](../../docs/agent-computer-prototype-v0.md)。当前只实现 macOS 客体（Apple Silicon），接口按平台无关设计，以后接入 Windows。

## 启动

```bash
bun src/cli.ts adopt     # 首次：把已克隆的虚拟机登记为本服务所有（新克隆的会自动登记）
bun src/cli.ts serve     # 启动本地服务，只监听私有目录里的 Unix socket
bun src/cli.ts vm-start  # 后台启动虚拟机
bun src/cli.ts provision # 首次：装入专用 SSH 公钥、关闭客体休眠；完成后重启 serve
bun src/cli.ts resume    # 服务启动时默认处于紧急停止状态，用户恢复后 Agent 才能操作
bun src/cli.ts shot /tmp/agent.png
```

配置走环境变量：

| 变量 | 默认值 |
|---|---|
| `AGENT_COMPUTER_HOME` | `~/.local/share/agent-computer-proto`（令牌、socket、日志、收件箱、暂存区；必须是权限 700 的私有目录） |
| `AGENT_COMPUTER_VM` | `agent-computer-proto` |
| `AGENT_COMPUTER_BASE` | `ghcr.io/cirruslabs/macos-tahoe-base:latest` |
| `AGENT_COMPUTER_ALLOW` | `$AGENT_COMPUTER_HOME/approved`（允许导出的目标目录，冒号分隔） |
| `AGENT_COMPUTER_GUEST_USER` | `admin`（客体系统用户） |
| `AGENT_COMPUTER_GUEST_PASSWORD` | `admin`（仅 `provision` 首次装钥使用，为公开基础镜像的默认口令） |

## API

Unix socket `$AGENT_COMPUTER_HOME/agent-computer.sock`（权限 600）上的 `POST /rpc`，例如 `curl --unix-socket <socket> http://localhost/rpc`。不用 TCP 端口：回环端口任何本机进程都能抢先监听并骗取令牌。请求头 `Authorization: Bearer <令牌>`，请求体 `{"method": "...", "params": {...}}`。返回 `{"ok": true, "result": ...}` 或 `{"ok": false, "error": {"code", "message"}}`。

| 方法 | Agent | 用户 |
|---|---|---|
| `computer.state` / `computer.stop` | ✅ | ✅ |
| `computer.resume` | ❌ | ✅ |
| `computer.screenshot`（`maxEdge`） | ✅ | ✅ |
| `computer.mouse.move/click/drag/scroll/down/up`、`computer.key.press`、`computer.text.type` | ✅ | ✅ |
| `computer.displays.list`、`computer.permissions.status` | ✅ | ✅ |
| `vm.status` / `vm.start` | ✅ | ✅ |
| `vm.stop` | ❌ | ✅ |
| `files.inbox.list` | ✅ | ✅ |
| `files.outbox.list` | ❌ | ✅ |
| `files.outbox.approve` / `files.outbox.reject` | ❌ | ✅ |

`computer.windows.list`、`computer.frontmost` 与两个权限引导方法返回 `UNSUPPORTED_ON_VM`。坐标为客体屏幕像素（截图的 `sourceWidth/sourceHeight` 空间）。

## 文件进出

- 收件箱：`$AGENT_COMPUTER_HOME/inbox`，只读共享给客体。
- 暂存区：`$AGENT_COMPUTER_HOME/outbox`，客体可写。客体内的挂载位置为 `/Volumes/My Shared Files/inbox` 与 `/Volumes/My Shared Files/outbox`。
- 用户用 `outbox` 查看候选（含 SHA-256），`approve <候选ID> <sha256> <目标目录>` 导出。批准后文件若被改动，导出会被拒绝。
- `reject <候选ID> <sha256>` 只让这一版内容不再出现在列表里，不删除任何文件（暂存区由客体控制，按路径删除可能被链接替换利用）；暂存区的清理由客体自己负责。

## 文字输入与关机

- ASCII 文字按物理键输入，大写与符号自动补 Shift。
- 中文、emoji 等键盘打不出的文字：经 SSH 写进客体剪贴板，再发送 Cmd+V。客体内只执行两条固定命令（写剪贴板、正常关机），不提供通用命令执行。
- 关机先让客体系统正常关机，超时才强制停止，返回的 `forced` 说明是否强制。

## 安全线与已知限制

- 紧急停止可以打断进行中的输入并抬起按住的按键；服务重启、断线重连都不会解除停止。
- 底层输入事件有最小间隔和每分钟上限；审计记录来源（agent / user），文字输入只记长度。
- Agent 令牌与用户令牌分开存放，但 Agent 进程与用户命令行跑在同一个宿主用户下，文件权限无法强制隔离两者；接入宿主后由宿主持有用户令牌。
- 文件出口的父目录竞态：Node 没有按目录句柄的相对打开，客体仍可能在检查与打开之间替换父目录，让服务读到暂存区外的宿主文件。读到的内容只在用户批准后进入用户自己的目录，不会回到客体；列表只对用户开放，Agent 拿不到摘要。正式版需原生辅助程序逐级 `openat(O_NOFOLLOW)`。
- 导出目标目录必须属于当前用户且他人不可写；令牌文件必须是权限 600 的普通文件。
- 原型依赖 tart 2.37.0 的 `--vnc-experimental`（Virtualization.framework 私有 VNC 接口），tart 为 FSL 许可，只用于原型。
- 该 VNC 端口监听所有网卡而不只是回环地址，正式版需改用只监听回环的实现或配合防火墙。
