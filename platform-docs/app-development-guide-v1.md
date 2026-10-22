# ReAI App 开发指南 v1.1：从 0 做一个 To-Do List

> 文档定位：给 App 开发者看的第一份文档<br>
> 协议状态：**Design v1.1 目标合同；Driver V2 已实现其中一个受支持子集**<br>
> 日期：2026-08-12<br>
> 设计依据：Design 交互规范（原 Board 仓库内 `design/DESIGN.md`；未迁入） · 可运行设计稿（原 Board 仓库内 `design/VoiceType_UI_Designs.html`；未迁入）<br>
> 冲突优先级：本 v1.1 合同覆盖旧 Design 中“Voice 不可卸载”等 v1.0 假设；旧稿只作为界面依据<br>
> 政策附录：[发行渠道](./distribution-policy-v1.md) · [运行依赖](./runtime-dependencies-v1.md) · [网络与计费](./network-billing-policy-v1.md)<br>
> 交互版：[打开交互式开发指南（HTML 快照，可能滞后于本文）](./app-development-guide-v1.html)

> ⚠️ **这是规范，不是首版实现清单。** 首版 Host 只实现其中一个子集（档位 `official-only`：只装官方插件）。
> 每一处有意的偏差、以及开放第三方前必须补齐的安全清单，见 [README.md](./README.md)。
> 机器可读事实源：`platform/contract/host-support-matrix.json`（能力与限额）、`platform/contract/schemas/app-manifest-1.1.schema.json`（结构）。
> 当前可运行的开发步骤与接口请优先阅读 [Driver V2 插件开发规范 v1](./plugin-development-v1.md)
> 和 [插件接口参考 v1](./plugin-api-reference-v1.md)。


## 先说人话

一个 ReAI App 做三件事：

1. 在 Manifest 里告诉 Host：“我是谁、侧栏叫什么、需要哪些能力”；
2. 在 Host 给出的右侧工作区里渲染自己的界面；
3. 注册 Command，让鼠标、键盘按键或其他 Host 入口能够调用自己的功能。

开发者**不负责**画 ReAI 的侧边栏、扩展浏览器、设备卡、账户区和全局播放器。你只能声明入口，具体位置、主题、焦点、安装状态和全局退出层级都由 Host 管。

本文用一个只保存本地数据、不联网、不付费、没有后台服务的 **To-Do List** 演示完整流程。

> **基础纵向链路现在可以复制运行。** Driver V2 已有 Manifest loader、App SDK、动态 Surface、
> 隔离存储、合同测试、`reai-app` CLI 和本机开发者安装通道；完整目标合同仍有尚未实现的能力。
> 本文中标为“目标 API”或在支持矩阵中为 withheld 的部分不能用于当前插件。

### 先拍板：Host 到底是什么

v1.1 不把某个现有目录认作永久 Host。**Host 是一条架构规则**：它是全公司唯一桌面壳层，通过各硬件自己的 SDK / Provider 接入设备，再向 App 提供统一的生命周期、安全、界面和能力入口。

- 当前根目录桌面 App 是计划退役的旧产品实现，不是新平台的架构基线；
- `driver/` 是第一个基于键盘 SDK 的探索版本，可以被重构，也可以由新 App 替代；
- 公开合同只面向 Host API、App SDK 和 Hardware Service ID，不绑定仓库路径；
- AI Board 01 键盘只是第一个 Hardware Service。以后每种硬件都有自己的 SDK，接口可以不同；
- App 可以声明某项功能依赖硬件，但普通软件功能不能因为没有 AI Board 01 就整体失效。

因此，开发者不需要判断“我接的是根目录还是 Driver”。只需要判断 Host 是否满足 Manifest 声明的 API、服务和权限。

---

## 复用已有能力：以语音为例

先读 [能力复用与调用边界](./plugin-development-v1.md#capability-reuse)。插件需要语音文本时，按 [request-text 合同](./voice-request-text.md) 声明依赖，调用服务等待最终结果，再将文本写入自己的状态：

```ts
const requestId = `${Date.now()}:${crypto.randomUUID()}`;
const result = await ctx.services.call(
  "com.reai.voice/request-text@1", "request-text", { requestId, timeoutMs: 180_000 },
);
// 在调用方自己的 Surface 中使用 result.text；是否发送由调用方决定。
```

结束录音调用同一服务的 `finish`，携带原 `requestId`，其 `{ accepted }` 只是受理回执，最终文本仍返回上面的原请求。取消与失败按合同处理，不以空字符串冒充成功。

此服务不自动插入外部光标，也不替调用插件发送文本。语音输入法的原光标写回属于另一条已有交付链，不得再叠加一次插入。调用方无需判断是键盘还是快捷键触发。示例要求 Provider 与 Host 满足合同版本；不代表任意已安装版本都可调用。

## 1. 先看懂界面：你的代码放在哪里

```text
┌────────────────────────── ReAI Host ───────────────────────────┐
│ ┌──────── 侧边栏（Host）────────┐ ┌──── App 工作区 ───────────┐ │
│ │ Home                         │ │                           │ │
│ │ Apps                         │ │  你的 main Surface       │ │
│ │   Voice                      │ │  ┌─────────────────────┐  │ │
│ │   Agents                     │ │  │ 你的列表、页面、抽屉 │  │ │
│ │   To-Do  ← Manifest 声明     │ │  │ 都只能在这里          │  │ │
│ │ Browse Extensions            │ │  └─────────────────────┘  │ │
│ │ Extensions · Installed       │ │                           │ │
│ │ Mini Player（按需出现）      │ │                           │ │
│ │ Devices                      │ │                           │ │
│ │ Account                      │ │                           │ │
│ └──────────────────────────────┘ └───────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

| 界面位置 | 谁负责 | App 如何接入 | 什么时候触发 | App 禁止做什么 |
|---|---|---|---|---|
| Apps 列表 | Host | Manifest 的 `sidebarItems` | Package 安装并写入 Registry 后出现；状态由 Host 标识 | 改侧栏 DOM、自己排序、伪造安装态 |
| Browse Extensions | Host | 无运行时接口；读取 Catalog、Manifest 与渠道政策 | 只负责发现、查看详情和安装；页面提供去 Extensions 的入口 | App 自己画购买/安装按钮冒充 Host |
| Extensions / Installed | Host | 自动汇总所有已安装 App | 只负责本机管理；安装成功后出现，包括没有界面的 Headless App | App 隐藏自己的运行状态、权限或卸载入口 |
| 右侧主工作区 | App | 注册 `main` Surface，Host 提供隔离的 `root` | 用户点侧栏、Command 打开 App | 把样式或事件泄漏到 Host；越过 `root` |
| App 内列表 / 详情 / 抽屉 | App | 在自己的 `root` 内自由实现 | App 自己的业务交互 | 把局部抽屉画到侧栏或全局层 |
| Mini Player / Media | Host | 后续通过 Media Capability 提交播放会话 | App 创建有效播放会话后 | 直接控制其他 App 的播放状态 |
| Devices | Host | 通过各硬件 SDK 对应的 Hardware Service 读取授权能力 | 设备连接、断开、活跃设备改变 | 绕过 SDK 直接接管硬件、隐藏“正在监听”等隐私状态 |
| Account / Billing | Host | Billing Capability | 购买、恢复权益、订阅变化 | 未授权的站外支付或伪造权益 |
| 桌面覆盖层 / 全局 Esc | Host | 只能请求 Host 能力 | Voice、Tab、Action 或 Esc 发生 | 在 App Surface 外创建全局浮层 |

Design 的核心边界只有一句：**左侧是 Host 的壳，右侧是 App 的空间。** “自由界面”指 App 工作区内部自由，不是可以接管整个窗口。

### Design 里的全局层怎么接

Design 还有 Voice、Tab、Action 和屏幕讲解等桌面层。它们位于普通 App Surface 之外，不能由任意 App 自绘：

| 全局层 | 普通 App 能做什么 | 公开合同 / 状态 | 触发条件 |
|---|---|---|---|
| Voice Input | Host 绘制全局层；已安装且已启用的 Voice App 提供能力 | `VoiceSurfaceProvider.input` | 普通快捷键或已配置的硬件语音键 |
| Voice Command | Host 绘制全局层；Voice App 可接收最终结构化 Command | `VoiceSurfaceProvider.command` | 普通快捷键或已配置的硬件语音键 |
| Tab 全局层 | 只能提交结构化候选，不能绘制全屏 UI | `TabProvider.list(query)` | 任意位置按 Tab |
| 短按 Action | 只能给当前 App 内已登记的 Dock 提交能力 | `DockCapabilityProvider` | 有待确认先展开确认坞，否则打开当前 Dock 菜单 |
| 长按 Action / 屏幕讲解 | 不能接管截图和录音；只能接收 Host 产物 | `ScreenExplanationArtifact` | 长按 Action 越过阈值 |
| Title Bar | 声明状态与最多 3 个白名单 AppIcon / 文本动作；不能注入 DOM | `contributes.titlebarStatus/titlebarActions`（已开放） | 当前 Surface Ready；整条标题栏 hover 或键盘 focus |
| Media 输入 | 普通 App 不直接取得原始麦克风；由 Host 管权限和隐私状态 | 后续 `MediaInputSession` | 用户明确授权输入会话 |
| Media 输出 | 发布结构化播放会话，Host 决定是否出现 Mini Player | 后续 `MediaSession.publish()` | App 开始可控的音频播放 |

Voice 是**推荐安装、允许停用和卸载**的第一方 App，不是 Host 的强制系统组件。没有 Voice 时，Host 和其他 App 仍能工作；只有语音相关入口明确显示“需要安装或启用 Voice”。Title Bar 动作已经按 Host 托管声明式合同开放；表中其余 Provider 名只锁定设计方向，使用前必须以支持矩阵和接口参考为准。Host 的区域所有权现在就必须锁定。

### Platform Core v1.1 首批开放范围

本文先锁定最小集合：

- 一个静态侧栏入口；
- 一个 `main` Surface；
- App 自己的隔离 KV Storage，以及受 Host 校验的命名共享 Store；
- Command 注册和调用；
- 声明式跨 App Intent；
- Host 托管的声明式 Title Bar 动作；
- 可组合 Runtime Component 与 Headless App；
- 推荐键位，但不能静默覆盖用户现有绑定；
- `loading → ready / failed` 页面状态；
- 安装、启用、打开、切走、停用、更新和卸载生命周期。

Mini Player、完整设备控制、全局 Overlay、多窗口、动态增加侧栏入口不属于最小 To-Do 示例；它们必须等独立 Capability 定义后再开放。签名 Feed、本地导入属于 Direct Distribution；公共审核、评分、退款和治理属于 Marketplace，不作为 Core v1.1 跑通 To-Do 的前置条件。

---

## 2. 一个 App 从无到有

开发流程只有六步：

```text
创建目录
  → 写 Manifest
  → 实现 main Surface
  → 注册 Command
  → 在 Mock Host 验证生命周期
  → 打包并提交审核
```

下面的代码只讲解最小 App Platform 合同。仓库中的 canonical To-Do 样例已经扩展为可执行的“日程 Agent V1”，增加了异步 Mock、事件树、日历和 Agent Drawer；这些产品层模块不会改变本章说明的 Surface / Command / Intent / Storage 基础合同。完整结构与接口见 To-Do 日程 Agent V1（原 Board 仓库内 `docs/todo-agent-v1.md`；未迁入）。

最小教学结构：

```text
todo-app/
├── app.manifest.json       # Host 先读的静态合同
├── assets/
│   └── icon.svg
├── src/
│   ├── app.ts              # App 入口与生命周期
│   ├── todo-view.ts        # To-Do 界面
│   └── todo.css            # 只作用于隔离 Surface
├── tests/
│   └── contract.suite.ts
├── package.json            # 只用于开发构建
├── tsconfig.json
└── dist/
    └── app.js              # 审核并随 Package 发布的 UI 模块
```

正式 Package 只需要 `app.manifest.json`、`assets/` 和 `dist/`。Node.js、npm、源码目录和测试工具是开发期工具，不能因此变成用户电脑的运行依赖。

这里展示的是最小源码结构，不是三层交付目录模板。开发者必须先判断每项能力属于 Host、
`.reaiapp`、目标中的 Host 受管可执行资源、非执行内容还是用户数据；判断依据是安装、升级、回滚、
共享和删除的生命周期，而不是使用什么语言或放在哪个仓库。当前可执行步骤见
[插件开发规范 · 开发前先做交付分层](./plugin-development-v1.md#11-开发前先做交付分层direct-受管运行时一期已实现)。

---

## 3. 第一步：写 Manifest

下面是 To-Do 的最小 Manifest：

> ⚠️ **这是 v1.1 目标合同的完整示例，照抄会被当前 validator 拒绝**：
> `bindings.recommended@1`、非空 `requires.hardwareServices`、非空
> `contributes.recommendedBindings` 会报 `HOST_CAPABILITY_NOT_AVAILABLE`，
> SVG 图标会被拒（当前只收 PNG ≤512×512 ≤256KiB）。当前可运行版本请直接复制
> `plugins/examples/todo-app/`，与 [插件开发流程](./plugin-development-v1.md) §3 保持一致。

```json
{
  "manifestVersion": "1.1",
  "appId": "com.example.todo",
  "version": "1.0.0",
  "publisherId": "example",
  "name": "To-Do List",
  "description": "一个只保存在本机的待办事项 App",
  "icon": "assets/icon.svg",

  "targets": [
    { "platform": "macos", "architectures": ["aarch64", "x86_64"] },
    { "platform": "windows", "architectures": ["aarch64", "x86_64"] }
  ],

  "hostApi": {
    "range": ">=1.1.0 <2.0.0"
  },

  "requires": {
    "hostCapabilities": [
      "surface.main@1",
      "sidebar.item@1",
      "storage.kv@1",
      "commands@1",
      "apps.intent@1",
      "bindings.recommended@1"
    ],
    "hardwareServices": [
      {
        "id": "com.reai.hardware.board01",
        "sdkApi": "^1.0.0",
        "capabilities": ["controls.binding@1"],
        "purpose": "允许用户把 AI Board 01 New 键绑定为新建待办",
        "grantDuration": "while_enabled",
        "optional": true,
        "requiredFor": ["binding:board01-new-task"]
      }
    ],
    "appIntents": []
  },

  "runtime": {
    "components": [
      {
        "id": "ui",
        "kind": "web-surface",
        "protocol": "web-surface@1",
        "required": true,
        "headless": false,
        "activation": "on-demand",
        "entry": "dist/app.js",
        "dependsOn": [],
        "lifecycle": {
          "activate": "default.activate",
          "deactivate": "default.deactivate"
        }
      }
    ]
  },

  "permissions": [],
  "requirementsVersion": "1.1",
  "requirements": [],
  "network": {
    "policyVersion": 1,
    "endpoints": []
  },
  "billing": {
    "mode": "none"
  },
  "data": {
    "privateStores": [
      { "id": "tasks", "schemaVersion": 1 }
    ],
    "imports": [],
    "exports": []
  },
  "dataCompatibility": {
    "rollbackFloor": "1.0.0"
  },

  "contributes": {
    "surfaces": [
      {
        "id": "main",
        "componentId": "ui",
        "location": "app.main",
        "title": "To-Do List"
      }
    ],
    "sidebarItems": [
      {
        "id": "todo",
        "label": "To-Do",
        "icon": "assets/icon.svg",
        "opens": "surface:main"
      }
    ],
    "commands": [
      {
        "id": "com.example.todo.new",
        "componentId": "ui",
        "title": "新建待办",
        "inputSchema": { "type": "object", "additionalProperties": false },
        "outputSchema": {
          "type": "object",
          "properties": { "status": { "const": "ok" } },
          "required": ["status"],
          "additionalProperties": false
        },
        "timeoutMs": 5000,
        "supportsCancellation": true,
        "concurrency": "serial",
        "idempotency": "not-idempotent",
        "callers": ["host", "user"]
      }
    ],
    "intents": [
      {
        "id": "new-task",
        "version": "1.0.0",
        "componentId": "ui",
        "opens": "surface:main",
        "inputSchema": { "type": "object", "additionalProperties": false }
      }
    ],
    "recommendedBindings": [
      {
        "id": "keyboard-new-task",
        "trigger": {
          "kind": "system-shortcut",
          "shortcut": "Primary+Shift+N"
        },
        "command": "com.example.todo.new",
        "description": "即使没有 ReAI 硬件，也可通过普通键盘触发"
      },
      {
        "id": "board01-new-task",
        "trigger": {
          "kind": "hardware-control",
          "hardwareService": "com.reai.hardware.board01",
          "control": "key.new"
        },
        "command": "com.example.todo.new",
        "description": "有 AI Board 01 时可把 New 键绑定到新建待办"
      }
    ]
  }
}
```

### 每一段在界面上负责什么

| Manifest 字段 | 用户看到的结果 | Host 的处理 |
|---|---|---|
| `appId` | 不直接展示 | 作为权限、存储、Command 和升级的稳定身份；发布后不能改 |
| `targets` | 商店中的支持平台 | 声明本次源码支持的平台和架构；发布系统按目标生成 Package |
| `requires.hostCapabilities` | 兼容性检查 | Host 缺少必需能力时拒绝启用，并指出缺哪一项 |
| `requires.hardwareServices` | 硬件增强与缺失提示 | 目标行为是 `optional: true` 只让 `requiredFor` 指向的功能降级；**首版实现里非空即拒**（见 [README](./README.md) 首版实现范围偏差 3），To-Do 不使用 |
| `requires.appIntents` | 可选的跨 App 联动 | 调用方预先声明目标 App、Intent 和版本范围；未安装目标时可引导安装 |
| `runtime.components` | App 的 UI、后台或远端组成 | Host 分别加载、隔离、诊断和降级；一个 App 可以同时有多种运行时 |
| `component.protocol` / `entry` / `lifecycle` | 审核后的运行合同与入口 | 按版本化协议加载 Package 中已审核的模块，并把 Hook 绑定到对应组件 |
| `surfaces.main` | 右侧主工作区 | 创建隔离 Surface，并负责 Loading / Error 外壳 |
| `sidebarItems` | 左侧 Apps 区的一行 | Host 决定真实位置、选中态、折叠态和可访问性 |
| `commands` | 可被 Host、界面或绑定调用的动作 | 校验输入输出、超时、取消、并发、幂等和调用方；声明了就必须注册同名 handler |
| `intents` | 其他 App 可请求的结构化入口 | 由 Host 路由到已安装、已启用的目标 App，不暴露内部 DOM 或函数 |
| ~~`recommendedBindings`~~ | ~~快捷键或硬件键建议~~ | **已下线（见 [README](./README.md) 首版实现范围偏差 2）**：非空声明在校验阶段直接报 `HOST_CAPABILITY_NOT_AVAILABLE`，不要写进 Manifest |
| `permissions` | 首次启用前的授权摘要 | To-Do 不需要敏感权限，所以为空 |
| `requirementsVersion` / `requirements` | 外部依赖检查 | To-Do 不依赖 Node、Python、CLI 或额外系统组件 |
| `network.endpoints` | 云服务披露 | 为空表示运行时不得联网 |
| `billing.mode` | 购买和权益入口 | `none` 表示没有付费功能 |
| `data.privateStores` | App 自己的数据 | 真实命名空间绑定 `appId / storeId`，默认只能由自己访问 |
| `data.imports` / `data.exports` | 同一签名发布者的跨 App 数据 | 必须请求方与数据拥有方双边声明，并经 Host 校验与用户同意 |
| `dataCompatibility.rollbackFloor` | 更新失败时的数据回滚边界 | 不允许回到无法读取当前数据 Schema 的旧 App 版本 |

`runtime.components[]` 描述 **App 的每一部分在哪里运行**，不限制 UI 用什么框架。可用种类是 `web-surface`、`wasm-component`、`remote-service` 和受严格限制的 `native-companion`。每项固定声明 `id / kind / protocol / required / headless / activation`；Package 内代码写 `entry`，远端组件写 `serviceRef`，两者不能并存。`web-surface@1` 的 `entry` 统一是随 Package 发布的 ESM JavaScript 模块，不是 HTML 文件。`platforms` 省略时继承顶层 `targets`，`dependsOn` 省略时等价于空数组。To-Do 只有一个隔离的 `web-surface`；Kanna 或 Agent Shell 可以同时拥有 UI、本地 Adapter 和远端 Adapter，并让它们独立降级。

上面是开发者维护的 Source Manifest。`reai-app pack` 和发布系统会为每个平台/架构另行生成 Package 与 `release-envelope.json`，其中绑定 Source Manifest 摘要、Package 摘要、构建 ID 和发布签名；开发者不能手填这些可伪造的值。Host 的验证顺序和 Envelope 字段见[发行规范](./distribution-policy-v1.md#34-release-envelope发布系统证明了什么)。

### 为什么 Runtime 必须可组合

真实 App 往往不是“只选一种 Runtime”。例如 Kanna 可以同时包含：

```json
{
  "runtime": {
    "components": [
      {
        "id": "ui",
        "kind": "web-surface",
        "protocol": "web-surface@1",
        "required": true,
        "headless": false,
        "activation": "on-demand",
        "entry": "dist/app.js",
        "lifecycle": { "activate": "default.activate", "deactivate": "default.deactivate" }
      },
      {
        "id": "local-agent",
        "kind": "native-companion",
        "protocol": "native-companion@1",
        "required": false,
        "headless": true,
        "activation": "on-demand",
        "entry": "bin/kanna-agent",
        "lifecycle": { "activate": "default.activate", "deactivate": "default.deactivate" }
      },
      {
        "id": "cloud-agent",
        "kind": "remote-service",
        "protocol": "remote-service@1",
        "required": false,
        "headless": true,
        "activation": "on-demand",
        "serviceRef": "network:endpoint.kanna-cloud"
      }
    ]
  }
}
```

Host 分别跟踪组件状态。实际的本地与云端 Contribution 分别用 `componentId` 指向 `local-agent` 和 `cloud-agent`。本地 Agent 缺失时，只有引用 `local-agent` 的能力不可用，UI 和 Cloud Adapter 仍可工作；远端服务故障也不能把整个 App 误报成“未安装”。`native-companion` 技术上可行，但只允许审核、签名、受控启动和最小权限的载荷；第三方后台逻辑优先使用 Wasm 或 Broker 管理的远端服务。

上例是目标合同，不代表当前 Host 已开放原生组件：当前支持矩阵只接受恰好一个 `web-surface`。
目标中与单一 `.reaiapp` 紧耦合的小型 `native-companion` 使用 Package 内 `entry`；需要独立下载、升级、
回滚或共享的大型可执行闭包进入 Host 受管资源层，其资源入口合同仍由三层分发实施计划定义。插件不能
先把大 runtime 塞入 `.reaiapp`，再把“以后拆包”当成发布阶段优化。

Headless App 只是 `contributes.surfaces` 为空，并不代表“看不见就无法管理”。它可以贡献 Command 或后台 Runtime Component；安装后必须出现在 Host 的 **Extensions → Installed**，展示组件健康、权限、设置、错误、启停和卸载入口。Browse 页面只负责发现，可链接到这里，但不再维护第二份“已安装”状态。

### `contributes` 不是只为 To-Do 定制

Platform Core v1.1 基础合同**首批定义并要求实现 Schema / SDK / validator** 的 Contribution 只有下面四类。这里说的是实现目标，不代表当前代码已经开放。每个需要执行代码的贡献都必须写 `componentId`，每个跨边界输入输出都必须有版本与 Schema；Host 不执行 Manifest 里未登记的“隐藏能力”。

| 类型 | 用途 | 典型 App |
|---|---|---|
| `surfaces` / `sidebarItems` | 右侧页面与侧栏入口 | To-Do、Agents·IM |
| `commands` / `intents` | 用户动作与跨 App 结构化跳转 | To-Do、Agents·任务 |

`recommendedBindings` 曾列为首批第五类，**已按合同修订下线**（非空声明即 `HOST_CAPABILITY_NOT_AVAILABLE`，见 [README](./README.md) 首版实现范围偏差 2）；绑定推荐不再有 Manifest 入口。

下面这些名称只为后续 Capability 模块**保留方向，不是当前可用字段**：`contextProviders`、`services`、`settings`、`mediaSessions`、`tabProviders`、`dockCapabilities`、`badges`、`attention`，以及前文的 Voice / Media / Tab / Action 目标接口。开发者现在把它们写进 v1.1 Manifest，validator 必须返回 `HOST_CAPABILITY_NOT_AVAILABLE`，不能接受后静默忽略。等各自的 Manifest Schema、SDK、权限和生命周期合同完成并发布版本化 Host Capability 后，才可开放。

其中 App Service、Agent Scene、Agent Tool 与 DSH/Pi 动态挂载已经收敛到
[插件服务与 Agent / DSH 扩展规范](./agent-service-extension-v1.md)。它们回答“插件提供什么能力、哪个
Agent 场景何时使用”；`runtime.components[]` 回答“实现代码在哪里运行”。两者不能互相替代，当前
Manifest 也仍不接受 `contributes.services/agentScenes/agentTools`。

### 权限不是一个模糊数组

v1.1 的权限模型至少区分七类：Host 能力、OS 权限（麦克风、辅助功能、系统通知）、数据、后台运行、网络、硬件与文件访问。它们分别落在 `requires.hostCapabilities`、`permissions`、`data`、Runtime 后台声明、`network` 和 `requires.hardwareServices` 等结构化字段中，不能塞进一个 `permissions: ["all"]`。每项要声明用途、范围和授权持续时间；用户可以撤销，App 更新扩大范围时必须重新同意。A1 已批准且在 A2 完全未变的项自动继承，A2 删除项自动撤销，新增或扩大的项在当前授权列表中重新确认，按项保存决定。`requires.hostCapabilities` 只做兼容性检查，不等于用户已经授权。

`permissions[]` 只承载需要用户授权的 Host、OS、后台和文件能力；网络、跨 App 数据与硬件授权继续使用各自的结构化声明，避免同一权限写两遍。最小对象如下：

```json
{
  "id": "voice-microphone",
  "kind": "os",
  "componentId": "voice-worker",
  "capability": "os.microphone.capture@1",
  "purpose": "录制用户主动发起的语音输入",
  "required": true,
  "requiredFor": ["command:voice-capture"],
  "grantDuration": "while_enabled",
  "platforms": ["macos", "windows"]
}
```

| 字段 | v1.1 规则 |
|---|---|
| `id` | App 内稳定 Permission ID |
| `kind` | `host / os / background / file` |
| `componentId` | 发起使用的 Runtime Component；必须引用 `runtime.components[].id` |
| `capability` | 权限注册表中的版本化 ID；访问范围由该 ID 定义，不能写自由文本冒充权限 |
| `purpose` | 安装、启用和系统授权前展示给用户的必填说明 |
| `required` | 是否阻断 `requiredFor` 指向的功能；不得用它阻断无关功能或 Host |
| `requiredFor` | 精确的 `kind:id` Contribution 或 `component:id` 引用 |
| `grantDuration` | `once / session / while_enabled / until_revoked`；Host 或 OS 可以缩短，不能静默延长，`until_revoked` 仍必须有撤销入口 |
| `platforms` | 可选；省略时继承 App `targets`，只允许 `macos / windows` |

Host Capability 的“当前版本是否存在”由 `requires.hostCapabilities` 判断；“用户是否授权这个 App 使用”由 `permissions[]` 判断。这两个检查必须同时通过。

#### Driver V2 当前开放的权限子集（2026-08-09，2026-08-13 补 http.fetch@1）

上面的完整对象是 v1.1 目标合同。Driver V2 当前 Manifest 只接受最小的
`{ id, purpose, required }`，开放三项本机设备级插件权限：

| 权限 | SDK 接口 | 当前边界 |
|---|---|---|
| `account.status@1` | `ctx.account.status()` | 只返回账户功能是否启用、当前是否登录，不返回身份或凭据 |
| `os.notification.post@1` | `ctx.notifications.post({ title, body })` | 只提交纯文本系统通知，不开放系统授权 API、Tauri notification JS API 或通知读取/取消能力 |
| `http.fetch@1` | `ctx.http.fetch()` | 受控出网：目标限 Manifest `network.endpoints` 声明范围，正式安装严格档/开发者模式宽松档，双档细节见 [插件开发流程](./plugin-development-v1.md) §4.4 |

```json
{
  "id": "os.notification.post@1",
  "purpose": "任务完成后提醒用户回来查看结果",
  "required": false
}
```

通知调用有四层独立门禁：Manifest 声明、当前插件的用户授权、系统通知授权、有效 Bridge 会话。
Host 启动只查询系统通知状态，**不会自动申请**；必须等用户点击首次引导中的“开启通知”或设置页的
“去授权”后才请求 macOS 授权。插件不能触发授权弹窗。标题最多 80 个字符、正文最多 500 个字符；Host 会
加入插件名与 appId 指纹，并限制每插件每 10 秒最多发起 5 次通知请求。成功返回 `{ queued: true }` 只表示
加入本地发送队列，不保证系统最终展示。

当前真实系统通知三态查询与授权流程只在 macOS 实现；Windows/其他非 macOS 构建暂由 Host 视为
`granted`，但插件级 Manifest 声明与用户授权仍然必须通过。来源标签中的 appId 指纹用于稳定追踪，
Manifest 显示名不是可信发布者身份，不能仅凭显示名判断通知来自 ReAI 官方。

Command 也不是只有 ID 和标题。Host 必须按 Manifest 校验输入输出 Schema、超时与取消、并发策略、幂等语义、允许调用方、所需权限和稳定错误码。跨 App 页面联动优先使用下面定义的 Intent，不把任意 Command 暴露给其他 App。

### Surface 隔离不是一条“开发自觉”

`web-surface` 的 `entry` **必须运行在每个 App 独立的 renderer / security origin 中**，而不是和 Host 的 Vue 页面共用同一个 `document`。`surface.root` 是这个隔离文档里的根节点：

- App 拿不到 Host DOM、Tauri 原生命令或其他 App 的 JS 对象；
- App CSS 不能泄漏到侧栏或其他 Surface；
- 普通 `fetch`、WebSocket 和原始网络能力默认关闭，只能走 Network Broker；
- Host 能力只通过带 `appId`、Capability 和取消/超时信息的 SDK Bridge 调用。

如果当前实现只能把一个 Host 页面里的普通 `HTMLElement` 交给第三方 JS，就还没有形成安全边界，不能开放第三方 App。

v1.1 的最小 Sandbox 合同：

| 项目 | 默认规则 |
|---|---|
| CSP | `default-src 'self'`；`connect-src 'none'`；禁用 `eval` 和未审核的内联脚本；网络只能走 Broker |
| 导航 / 弹窗 | Surface 内只允许同源导航；外部 HTTPS 交给 Host 确认并用系统浏览器打开 |
| 下载 | 默认拒绝；需要文件输出时走声明过的 Host Download / Export Capability |
| 剪贴板 / 文件 | 只能用 Broker；文件选择器返回有范围、可撤销的 Handle，不返回任意路径权限 |
| Worker | 只加载同 Package、同 security origin 的代码，并计入所属 Component 资源预算 |
| Bridge | 结构化消息双向上限 1 MiB；插件→Host 同一 runtime 最多 32 个在途请求，超限返回稳定码；Host 超时取消仍待补齐 |
| 身份 | Host 为 `appId + componentId + surface/session` 注入不可伪造、短期有效的调用身份；App 不能覆盖 |
| 崩溃 / 配额 | Surface 或 Component 崩溃只影响自己；Host 限制内存、CPU、重启次数和后台时长，并在 Inspector 显示原因 |

1 MiB 是 v1.1 Bridge 的互操作上限，不代表 App 可以频繁发送大消息。音频、文件和长结果必须使用专用流式 Capability。

### Surface 嵌入合同

| 项目 | v1.1 规则 |
|---|---|
| 尺寸 | Host 提供右侧工作区视口；App 根节点填满可用宽高，不假设固定窗口尺寸 |
| 滚动 | App 只管理自己 Surface 内的滚动，不能推动 Host 侧栏或窗口根节点 |
| 主题 | Host 通过版本化 CSS Token 与 `color-scheme` 提供主题；App 不读取 Host 样式表 |
| Resize | App 监听自己根节点的 `ResizeObserver` 做响应式布局，不依赖 Host DOM 尺寸 |
| 焦点 | 普通打开不强制抢焦点；只有明确 intent（如“新建待办”）才聚焦指定控件 |
| 浮层 | App 内 Dialog / Popover 留在隔离 Surface；系统权限、设备和账号浮层由 Host 绘制 |
| 导航 | App 把自己的 Dialog、Drawer 登记为局部导航层；Esc 先关闭最内层，再交还 Host |

---

## 4. 第二步：注册 App 与 main Surface

SDK 已实现为 `@reai/app-sdk/v1`。包路径按兼容主版本稳定，Manifest schema 使用 v1.1，当前 Host API
是 1.4.0；不使用新版能力的既有 `>=1.1.0 <2.0.0` 插件继续兼容。本节仍包含尚未实现的目标接口，
当前可调用范围以[插件接口参考](./plugin-api-reference-v1.md)为准。

```ts
import { defineApp, AppError } from "@reai/app-sdk/v1";
import { mountTodoView } from "./todo-view";

export default defineApp({
  async activate(ctx) {
    const tasks = ctx.storage.private("tasks");

    ctx.commands.register("com.example.todo.new", async ({ signal }) => {
      await ctx.surfaces.open(
        "main",
        { intent: { type: "new-task" } },
        { signal },
      );
      return { status: "ok" };
    });

    ctx.surfaces.register("main", async (surface) => {
      let items;
      try {
        items = (await tasks.get("items")) ?? [];
      } catch (cause) {
        surface.fail(new AppError({
          code: "com.example.todo/STORAGE_READ_FAILED",
          userMessage: "无法读取待办事项",
          retryable: true,
          cause,
        }));
        return;
      }

      let view;
      let offIntent;
      try {
        const mountedView = mountTodoView(surface.root, {
          items,
          onItemsChanged: (next) => tasks.set("items", next),
          onPersistenceError: (cause) => surface.reportError(new AppError({
            code: "com.example.todo/STORAGE_WRITE_FAILED",
            userMessage: "保存失败，请重试。",
            retryable: true,
            cause,
          })),
        });
        view = mountedView;

        const applyIntent = (intent?: { type?: string }) => {
          if (intent?.type === "new-task") mountedView.focusNewTaskInput();
        };

        applyIntent(surface.initialIntent);
        offIntent = surface.onIntent(applyIntent);

        surface.ready();
      } catch (cause) {
        offIntent?.();
        view?.dispose();
        surface.fail(new AppError({
          code: "com.example.todo/SURFACE_INIT_FAILED",
          userMessage: "无法打开待办事项",
          retryable: true,
          cause,
        }));
        return;
      }

      return () => {
        offIntent?.();
        view?.dispose();
      };
    });
  },

  async deactivate() {
    // SDK 自动撤销本次 activate 注册的 Surface 和 Command。
    // App 自建的定时器、连接和观察器仍必须在这里释放。
  },
});
```

这段代码只做三件事：

1. 打开 App 自己的隔离存储；
2. 注册“新建待办”Command；
3. 注册 `main` Surface，在 Host 给出的 `surface.root` 内挂载界面。

### `ready()` 到底什么时候调用

`surface.ready()` 不是“JS 已开始执行”，而是“用户已经看到了第一屏有意义的内容”。

- 正确：存储读取完成，列表或空状态已经画出来，再调用 `ready()`；
- 错误：刚进入 `mount` 就调用，之后让用户盯着 App 自己的空白页；
- 必需数据无法读取：调用 `surface.fail()`，由 Host 结束 Loading 并显示统一重试页；
- 可选能力失败：仍可 `ready()`，但要在 App 内明确显示对应功能不可用。

Host 会把这条语义落实到真正的可见性：新 Surface 先在屏幕外完成 bootstrap、mount
和首屏绘制，只有收到 `ready()` 后才移动到可见区域。切换 App 时，旧 Surface 会保留到
新 Surface Ready 并显示完成；新 Surface `fail()` 或超时时，旧界面不会被提前销毁。
如果用户在 Loading 期间又切换到别的 App 或离开插件页，Host 会按展示 token 撤销旧候选；
旧请求即使稍后才 Ready，也只会在屏幕外结束，不会先显示错误 App 再关闭。
因此不要用固定延时冒充 Ready，也不要在空壳刚挂上时抢先调用 Ready。

### 单层顶部：Host Title Bar + App `main-body`

当前 macOS Host 会让插件 Surface 的背景画布延伸到窗口 `y=0`，再把 44px 高的原生
Title Bar sibling WebView 盖在最上方。这 44px 是**唯一的页面级顶栏**：左侧是返回与路径，
中间是拖拽区，右侧是当前 App 的动作与通知。根页直接显示 App 名（例如 `Voice`）；二级页显示
返回按钮和 `Voice / 设置`，路径不加冗余的 `Apps /` 前缀。祖先面包屑可点击，当前项只读。

App 不再在 Title Bar 下方复制一条 `main-title` / page header，也不绘制第二组右侧动作或蓝色
hover 渐变。App DOM 从 `main-body` 开始：它从 `y=44px` 起填满剩余区域，并作为页面唯一的纵向
滚动容器。标题、说明、Logo、搜索、标签和设置正文都放在其中；正文 sticky 相对 `main-body`
使用 `top:0`，不能重新制造一条系统页头。

Host 在 App 文档启动阶段注入 `--reai-plugin-titlebar-safe-top`：macOS 为 `44px`，没有原生 sibling
Title Bar 的平台为 `0px`。App 根框架以 `var(--reai-plugin-titlebar-safe-top, 44px)` 只消费一次，
浏览器预览才使用 fallback。窗口拖拽、交通灯、路径和标题栏动作都由 Host 渲染；
App 不得用 `z-index`、事件阻止或透明覆盖层接管系统区域。当前已经开放
`contributes.titlebarActions`：App 只提交白名单图标 / 纯文本与静态 intent，Host 在通知铃铛
左侧渲染并按当前 Surface presentation 投递。通用子路由 / 面包屑贡献合同尚未开放；设计目标
已经锁定，但 App 现在不能写一个未登记字段或用 DOM 注入代替。

完整字段和生命周期见
[插件接口参考](./plugin-api-reference-v1.md#host-托管标题栏动作)，完整 CSS 骨架与兼容边界见
[插件开发规范 §3.1](./plugin-development-v1.md#31-单层页面框架host-title-bar--插件-main-body)。

这里说的是插件 Surface 内部坐标；Host 自有页面已经由 `.app-main` 统一让位，不得再套插件的
安全区 Token。两套坐标系不能叠加；弹层也必须锚定 `main-body`，不能用 viewport fixed 绕开安全区。

Title Bar 与正文的全宽交界遵循基础规则：**同色连续，异色内缩**。属于同一页面背景时，两者使用
同一主题 Token 和一致的最终合成色，不加装饰性 padding 或分割线；需要不同背景色时，把第一块
异色 Surface 内缩到 `main-body` 内，桌面默认留白 `16px`、紧凑布局最低 `12px`。禁止两个不同颜色
的全宽大色块零距离硬切；1px 分割线不算留白。样式必须留在插件自己的 Surface 内，不能修改 Host
DOM/CSS、标题栏伪元素或全局样式。

---

## 5. 第三步：实现 To-Do 界面

下面是一个完整但最小的视图。它只操作 Host 给出的 `root`，用户文字使用 `textContent`，不会把输入当作 HTML 执行。

```ts
type TodoItem = {
  id: string;
  title: string;
  done: boolean;
};

type TodoOptions = {
  items: TodoItem[];
  onItemsChanged(items: TodoItem[]): Promise<void>;
  onPersistenceError?(cause: unknown): void;
};

export function mountTodoView(root: HTMLElement, options: TodoOptions) {
  let items = [...options.items];
  let saving = false;
  let disposed = false;

  const page = document.createElement("main");
  page.className = "todo-page";

  const title = document.createElement("h1");
  title.textContent = "To-Do";

  const form = document.createElement("form");
  const input = document.createElement("input");
  input.id = "todo-new-task";
  input.name = "todo-title";
  input.placeholder = "要做什么？";
  input.setAttribute("aria-label", "新待办内容");

  const add = document.createElement("button");
  add.type = "submit";
  add.textContent = "添加";

  const list = document.createElement("ul");
  list.setAttribute("aria-label", "待办列表");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  form.append(input, add);
  page.append(title, form, status, list);
  root.replaceChildren(page);

  const save = async (next: TodoItem[]): Promise<boolean> => {
    if (saving || disposed) return false;
    saving = true;
    status.textContent = "正在保存…";
    render();

    try {
      await options.onItemsChanged(next);
      if (disposed) return false;
      items = next;
      status.textContent = "已保存";
      return true;
    } catch (cause) {
      options.onPersistenceError?.(cause);
      if (!disposed) status.textContent = "保存失败，请重试。";
      return false;
    } finally {
      saving = false;
      if (!disposed) render();
    }
  };

  const render = () => {
    input.disabled = saving;
    add.disabled = saving;
    list.replaceChildren();

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "还没有待办，先添加一件事。";
      list.append(empty);
      return;
    }

    for (const item of items) {
      const row = document.createElement("li");
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = item.done;
      toggle.disabled = saving;
      toggle.setAttribute("aria-label", `完成：${item.title}`);

      const label = document.createElement("span");
      label.textContent = item.title;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "删除";
      remove.disabled = saving;

      toggle.addEventListener("change", () => {
        void save(items.map((current) =>
          current.id === item.id
            ? { ...current, done: toggle.checked }
            : current,
        ));
      });

      remove.addEventListener("click", () => {
        void save(items.filter((current) => current.id !== item.id));
      });

      row.append(toggle, label, remove);
      list.append(row);
    }
  };

  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;

    const saved = await save([
      ...items,
      { id: crypto.randomUUID(), title: value, done: false },
    ]);
    if (saved) input.value = "";
  };

  form.addEventListener("submit", onSubmit);
  render();

  return {
    focusNewTaskInput() {
      input.focus();
    },
    dispose() {
      disposed = true;
      form.removeEventListener("submit", onSubmit);
      root.replaceChildren();
    },
  };
}
```

正式 App 可以使用 Vue、React、Svelte 或原生 DOM。Host 只规定 Surface、生命周期、安全和交互边界，不规定 UI 框架。

### 完整 starter 在哪里

[打开完整日程 Agent 样例](../examples/todo-app/README.md)。本章代码块刻意保留最小教学版本；canonical 样例在相同 Platform 合同上增加模型、单写者队列、Mock workflow、日历、详情和 Agent Drawer，并继续作为工具链验收对象。它拥有自己的 `package.json` 与 `bun.lock`，不加入 Driver workspace；CI 会先用冻结 lock 验证源码，再把 Platform 包成 tarball、复制样例到仓库外，重复测试、构建、合同测试、确定性打包和 Host 安装生命周期。

---

## 6. 点击侧栏以后，实际发生什么

```text
用户点击 To-Do
  → Host 分别检查 installation / activation / permissions / dependencies
  → 未安装则进入安装；未启用或待授权则进入 Host 启用流程并停止本次打开
  → 如已启用但 Runtime 尚未加载，则调用 activate()
  → Host 在右侧显示标准 Loading
  → Host 创建 main Surface，并调用注册的 mount handler
  → App 读取 tasks 存储、渲染列表
  → App 调用 surface.ready()
  → Host 移除 Loading，To-Do 可交互
```

如果 To-Do 已经打开，再点一次侧栏不应重复创建整套 App；Host 只把现有 Surface 切到前台。Host 可以因为内存压力、更新或停用而卸载 Surface，所以 App 不能假设 mount 一生只发生一次。

### 为什么“状态模型”必须进入 Core

这里的 Core 不是某个页面，而是 Host 中所有 App 共用的 Registry 与生命周期引擎。它不能只保存一个互斥的 `status`，因为真实情况会同时成立：一个 App 可以**已安装、未启用、缺少麦克风权限、远端组件降级、同时又有更新可用**。

v1.1 因此保存六个正交维度：

| 维度 | 典型值 | 回答的问题 |
|---|---|---|
| `installation` | `absent / downloading / verifying / staged / installed / removing` | Package 是否已进入本机 Registry |
| `activation` | `disabled / starting / active / stopping` | 用户是否允许 App 运行 |
| `health` | `unknown / healthy / degraded / unhealthy / crash_loop` | 当前各 Runtime Component 是否健康 |
| `permissions` | `not_required / pending / granted / partial / denied` | 所需授权是否齐全 |
| `dependencies` | `checking / ready / missing_optional / missing_required / incompatible` | 硬件、系统组件和外部工具是否满足 |
| `update` | `idle / available / downloading / ready / applying / blocked / rollback_pending` | 是否有更新以及正在做什么 |

界面里的“已安装”“需要授权”“部分功能不可用”是 Host 从这六项**推导**出的摘要，不是另存一个容易互相打架的状态。`activation=active` 只表示用户允许 Host 运行 App，不表示每个组件都健康；按需组件此时可以仍是 `stopped`。每个 Runtime Component 另有 `stopped / starting / running / degraded / failed` 运行状态。required Component 失败聚合为 `health=unhealthy`，optional Component 失败聚合为 `health=degraded`，运行故障本身不能偷偷把用户选择改成 `activation=disabled`。这个模型是 Headless Installed 列表、复合 Runtime、权限撤销和可诊断更新的共同基础，所以必须属于 Platform Core v1.1。

### 页面生命周期

| 事件 / API | 由什么触发 | Host 做什么 | App 必须做什么 |
|---|---|---|---|
| `activate(ctx)` | 用户明确启用；或已启用 App 的 Runtime 被回收后再次打开/调用 | 创建隔离上下文 | 注册 Manifest 已声明的 Surface 和 Command；初始化必须幂等 |
| `surface mount` | 首次打开 main；被回收后重新打开 | 提供 `root`，显示 Loading | 渲染第一屏，最终只能调用一次 `ready()` 或 `fail()` |
| `surface.onIntent()` | 已打开的 App 再收到 Intent，或 Command 请求打开现有 Surface | 把结构化意图送到现有 Surface | 处理意图；To-Do 聚焦新建输入框 |
| `surface.onVisibilityChange()` | 切到其他 App、进入或离开覆盖层 | 告知当前是否前台可见 | 暂停非必要动画；不要把“切走”当“卸载” |
| mount cleanup | 内存回收、重载、更新、停用、卸载 | 使 `root` 失效 | 移除监听、观察器、定时器和局部浮层 |
| `deactivate()` | 停用、更新、卸载、Host 退出 | 停止派发新调用，最后强制回收 | 释放 App 级资源；不得阻塞退出 |
| `data.migration` Hook | 新 Manifest 中任一 `data.privateStores[].schemaVersion` 高于本机版本 | 生成逐 Store 计划，在一次 App 更新事务中执行；失败则数据和新 Package 一起回滚 | 按计划做幂等迁移，不做网络或 UI |

### 安装不是打开

Design 已经规定：

1. 用户在 Browse Extensions 详情里点击安装；
2. Host 验证并写入 Registry；`installation=installed`、`activation=disabled`，且不执行 App 代码；有侧栏贡献的 App 出现在侧栏，所有 App 都出现在 Installed 列表；
3. 详情抽屉仍停在原处，按钮按推导状态显示“启用 / 卸载”或“打开 / 卸载”；
4. 用户明确启用并完成必要授权后，Host 才能调用 `activate()`；
5. Host **不能因为安装成功就自动跳进 To-Do**；
6. 用户明确点击“打开”或已确认的 Command，才进入页面生命周期。

Design 原型里“安装后直接变为打开”是无敏感权限 App 的简化演示。产品实现仍必须按六个维度记录，不能让安装动作暗中执行代码。Headless App 没有“打开”按钮，但同样可以启用、停用、查看设置与诊断、更新和卸载。

当前 Host 的所有用户安装入口（商店、本地选择、双击包）共用一次性安装尝试。安装授权界面展示清晰的授权名称、简短用途与勾选状态，不展示版本、发布者、下载体积或技术标识。列表随窗口高度滚动，标题与确认按钮固定。新增或扩大项默认勾选，用户点击确认时按项提交当前选择；已有拒绝保留，不能由默认规则覆盖。常规安装需要授权时显示弹窗，无权限且无云连接时直接安装。拒绝必要云连接或必需运行依赖会阻止安装；其他拒绝继续由 Host 权限账本和启用门禁处理。

**首装第一阶段（新手引导「自动准备」页，2026-10-11 更新）**：点一次「使用推荐设置并继续」即完成引擎（如缺）与 Voice 的安装、账号授权和启用，全程不再要求任何追加确认点击；首装默认同意包含此前拒绝过的项（常规安装入口不受影响，仍保留历史拒绝）。「查看授权详情」可查看和调整当前将要同意的范围，用户在详情里主动保存的选择优先，直到完整声明合同变化才重新展示；主动在详情里取消必需项（required capability / network endpoint / managed_resource 或 OAuth 未同意）会让主按钮禁用并提示，optional 拒绝不拦主按钮。失败后主按钮变为「重试并继续」。安装授权过期或快照变化时必须获取新凭据；可恢复的安装失败保留重试入口，重新检查不清除已安装内容。

常规安装入口（非首装）不走上述默认同意：卡片显示待安装、待账号授权（带“详情”链接）、待启用；点击详情可查看和保存选择，保存不发起安装或真实 OAuth 授权。用户点击“继续”才以默认或已确认选择准备新的安装事务并显示进度。详情确认显示“已确认授权”，只有实际连接成功才显示“账号已授权”；已有拒绝保留，不能由默认规则覆盖。

简化的是展示与输入方式：每项原始用途、范围、required、声明摘要，以及网络端点的 owner、origins、pathPrefixes、methods、dataCategories、retention、providerMode、userConfiguredOrigins 和 auth 仍进入 Host 完整预览快照、同意账本和 Network Broker 校验。预览失败不会提供“仍然安装”的降级按钮。Developer Mode 同样执行这套流程。

---

## 7. 硬件按键如何挂到 App

To-Do 声明了 Command：

```text
com.example.todo.new
```

它给出两种独立建议：

```text
普通键盘：Primary+Shift+N
AI Board 01 增强：com.reai.hardware.board01 / key.new
```

实际调用链：

```text
用户按普通快捷键，或某个 Hardware SDK 报告已配置的控制项
  → Host Binding Manager 找到用户已经启用的映射
  → 如果 To-Do 未启用或权限失效，阻止调用并进入 Host 启用流程
  → 只有 App 已启用但 Runtime 未加载时，才先 activate To-Do
  → 调用 com.example.todo.new
  → Command 打开 main Surface，并发送 new-task intent
  → 输入框获得焦点
```

规则：

- Manifest 声明的 Command 必须在 `activate()` 注册同名 handler；
- 未声明的 Command 不能动态注册；
- 普通系统快捷键与 AI Board 01 控制项是两条映射；没有或不购买 AI Board 01，To-Do 仍可用；
- App 只贡献推荐映射，安装不会写入或覆盖真实绑定；
- Host 保存“硬件默认值、用户有效映射、App 推荐项”三层来源和所有权；
- 同一个物理键有多个候选任务时，设备设置页必须显示每个 App、Command 和启用状态；
- Host 默认不静默串行执行多个任务。只有用户明确启用一个多动作规则或顺序，才允许一次触发多个 Command；
- 停用或卸载 App 时，只移除它仍然拥有的推荐项，并禁用仍指向该 App 的有效映射；
- **绝不恢复整张“安装前快照”**。如果用户之后改过按键，卸载旧 App 不能覆盖这些新修改。

这就是此前“绑定恢复”问题的含义：不是讨论按键能不能复用，而是避免旧快照在卸载时把用户后来做的设置抹掉。v1.1 用来源与所有权解决，不依赖安装顺序。

### 键位页绑定插件 Command（M6 已落地，2026-08-05）

声明了 `contributes.commands` 的 App，用户在「键位」页给任何硬件键（按一下 / 按住 / 组合）绑「插件动作」：选一个 App 的一条 Command，按下即调。落地语义与上面设计意图的对应：

- **绑定是用户的，不是 App 的**：App 只声明 Command，键位一律用户在键位页配；`contributes.recommendedBindings` 已下线（`HOST_CAPABILITY_NOT_AVAILABLE`）。
- **执行走异步 Dispatcher**：按下 → 引擎非阻塞提交 → 冷启动（App 没开会自动拉起）→ 投递 → 结算，全程有执行流水可查；队列满/未启用/未安装都有明确终态，不静默。
- **停用/卸载不动用户配置**：绑定原样保留，键位列表显示不可用原因（扩展已卸载 / 已停用 / 命令已变化 / 没有这条命令 / 文件损坏 / 反复崩溃）；插件恢复后绑定自动复活，无需重配。恢复判据是 `target_digest`——绑定时对 Command 声明（含 in/out Schema、timeout 等全字段）的 SHA-256 指纹，重装后声明变了会显示「命令已变化，请重新绑定」。
- **选择器展示可单独收口**：Command 可声明 `bindingPickerVisible: false` 隐藏不应再用于新绑定的兼容入口，也可用 `bindingPickerTitle` 提供更短的键位文案。两者只影响选择器，不注销 Command、不改变已有绑定，也不参与 `target_digest`。
- **`static_input` 是受限的扁平小对象**（2026-08-17 起）：一条绑定可以携带少量选择性参数，让同一条 Command 按绑定跑不同类型（官方 Voice 的转文本 / 翻译 / Agent 提问就是这么区分的）。形状钉死在宿主这一层：至多 4 项，键名 `[A-Za-z][A-Za-z0-9_]{0,31}`，值只能是字符串（≤256 字符）/ 布尔 / 数字，**拒绝嵌套对象、数组与 null**。它不是给插件传数据的通道——绑定表是本机 JSON、用户手改得进去，而这份值会原样进插件的 command handler。
- **其余首版边界**：插件动作不支持平台覆写（一个指纹表达不了两个平台目标）；含插件绑定的 profile 导出适配包时整包拒绝（`PACK_EXPORT_UNSUPPORTED_ACTION`），不静默丢项。

对 App 开发者而言要做什么：**什么都不用做**。Command 按合同声明并实现，键位绑定由 Host 提供。要验证绑定效果：装包启用 → 键位页绑一个键 → 按它。

### 插件与硬件解耦（2026-08-16 架构拍板）

上一节 M6 的落地语义在这次拍板中上升为**架构红线**，适用于所有插件、所有硬件：

- **合同面只有插件暴露的事件。** 插件通过 Manifest 与 SDK 声明可被绑定的事件——在当前合同里就是 `contributes.commands`（跨插件入口是 `contributes.intents`）。硬件要触发插件，只能触发这些事件；这是插件与硬件之间唯一的接触面。此处的「事件」指硬件 → 插件的可绑定动作，与 `contributes.eventSubscriptions`（Host → 插件的订阅）不是同一件事。
- **绑定关系归 Host 键位设置。** 按键、拨杆、旋钮以及未来任何硬件的输入，与事件之间的映射由 Host 的键位设置持有和管理；插件既不声明也不读取这层映射。
- **插件不得内置硬件绑定逻辑**，不得假设某款硬件存在（包括 AI Board 01），也不得因为缺少该硬件而整体失效。
- **插件设置页不得出现绑定配置。** 「按哪个键触发我」属于键位设置的界面，出现在插件里就是耦合。
- **理由**：以后还会有其他硬件，穷举硬件行为不可能。让插件暴露事件、让硬件去触发事件，键盘的事留在键盘自己那边。

拨杆的分层覆盖模型是 **Host 键位系统自己的规格，不进入插件合同**：三档拨杆（CHAT / YOLO / PLAN）各算一层，用户默认配在「任何档位都生效」的通用层，某一档位层里的设置覆盖通用层；`拨杆档位 + 某个按键 = 某个事件` 与组合键同构，只是多出「拨杆档位 +」这一维。插件看不到、也不需要看到这套分层，它只会收到自己那条事件被调用。

拨杆自己的**进入 / 离开**同样只是两条普通的可绑定触发（`dial.<档位>.enter` / `.leave`，停稳 0.3 秒才算数），插件侧一视同仁：它收到的仍然只是「我的某条 Command 被调用了」。

### `surfaces.open` 的真实语义：幂等 reveal（M6.1 修正，2026-08-05）

`ctx.surfaces.open("main", { intent })` 的合同是「**让我的主界面被看见**」，不是「再创建一个界面」：

- **已挂载 → reveal**：主窗口前置并聚焦，Host 前端跳到该 App 的扩展页（`app:apps` 通道的 `revealSurface` 事件），携带的 `intent` 按 `surface.intent` 信封投递给当前 mount。重复调用幂等——「再亮个相」不是错误，返回 `{ accepted: true }`。
- **Command 拉起界面时同样「跳到现场」**：Host 冷启动挂载后主动 reveal，界面由扩展页接管落位/关闭/Esc，不留孤儿界面。
- **未挂载**：正常链路里 Host 会先完成冷启动挂载（Command 派发、侧栏打开），App 代码跑到 `surfaces.open` 时 mount 记录必然在；唯一可达的异常是「窗口在、登记不在」的中间态（上次没关干净），此时拒绝文案会说明原因，稍后再试即可。
- **开自己没声明的界面**才是真·第二界面：拒绝 `HOST_CAPABILITY_NOT_AVAILABLE`（首版支持矩阵限单个 `main` Surface）。
- **Host 拒绝的文案能到达用户**：桥接层拒绝（`{code, message}`）在 SDK 进门处归一成 `AppError`（`userMessage` 取 Host 文案）；Command handler 不捕获时，结算带着 Host 的稳定错误码与文案——不会退化成笼统的「扩展遇到未处理的错误」。

配套保证：**intent 不会丢**。`onIntent` 注册之前到达的 intent，由 SDK 为每个 mount 缓冲**最近一条**（意图是状态不是流水，不排队），首个 `onIntent` 注册时补发；unmount 即清。冷启动链路里「先 mount、后注册 `onIntent`」之间没有同步点（注册前往往有一轮存储往返），App 照常写 `surface.onIntent(...)` 即可，不需要自己防丢。

### 跨 App 跳转：像 URL Scheme，但由 Host 执行

目标 App 在 `contributes.intents` 声明入口，调用方在 `requires.appIntents` 声明依赖。调用方的最小声明是：

```json
{
  "requires": {
    "appIntents": [
      {
        "appId": "com.example.todo",
        "intent": "new-task",
        "version": "^1.0.0",
        "required": false,
        "purpose": "从总览页创建待办"
      }
    ]
  }
}
```

`appId + intent` 标识目标，`version` 是调用方接受的 Intent 合同范围，`required` 表示缺少目标 App 时是否禁用依赖该联动的功能，不表示可以阻止调用方整个 App 安装。真正调用只能走结构化 SDK：

```ts
await ctx.apps.open({
  appId: "com.example.todo",
  intent: "new-task",
  version: "1.0.0",
  payload: {},
});
```

Manifest 中 Intent 的 `inputSchema` 校验的是 `payload`，`appId / intent / version` 由 Host 单独校验。投递给 Surface 时，SDK 使用统一信封，例如 `{ type: "new-task", payload: {} }`；App 不需要解析 Deep Link 字符串。

Host 查 Catalog/Registry、校验双方 Manifest 和 payload Schema，再决定行为：

- 已安装且已启用：复用或打开目标 Surface，并投递 Intent；
- 已安装但停用：先显示启用确认，不把调用悄悄变成执行；
- 未安装：打开对应详情或返回 `APP_INTENT_TARGET_NOT_INSTALLED`；
- Intent/版本不匹配：返回稳定错误，不猜目标页面。

`reai-app://com.example.todo/intent/new-task?...` 可以作为外部 Deep Link 或分享格式，但它只是结构化请求的序列化，不是权限边界，也不能直接调用目标 App 的函数。Host 永远是解析、校验和路由者。

---

## 8. App 内部的页面、抽屉、焦点和 Esc

App 可以在 `surface.root` 内做列表、详情、Tab 和局部抽屉。边界如下：

- App 内路由由 App 管；Host 不读取 App 的 DOM 来猜当前页面；
- App 内对话框优先使用可访问的 Dialog 语义，打开后焦点进入，关闭后焦点回到触发点；
- 局部浮层打开时，App 应通过目标 `surface.navigation.pushLayer()` 注册可退出层；
- 用户按 Esc 时，Host 先关闭桌面覆盖层，再关闭登记的 App 局部层，再执行页面返回；
- Surface 失活或卸载时，局部层必须清空，不能让下一次 Esc 被一个不存在的浮层吃掉；
- App 不得监听整个窗口并截断 Host 的全局 Esc、Tab、Action 或设备事件。

目标示意：

```ts
const releaseLayer = surface.navigation.pushLayer({
  id: "edit-task",
  onBack: () => closeTaskEditor(),
});

// 用户主动关闭时也要释放；重复调用必须安全。
releaseLayer();
```

`surface.navigation.pushLayer()` 是 `surface.main@1` 的子合同，不是额外权限，也不需要在 Manifest 重复声明。它同样属于目标 API，目前尚未实现；存在的原因是让 Host 和 App 共用一套退出栈，而不是两边各自抢 Esc。

---

## 9. 存储、网络和后台服务

### To-Do 的存储

```ts
const tasks = ctx.storage.private("tasks");

await tasks.get("items");
await tasks.set("items", nextItems);
```

Host 实际命名空间是 `appId / storeId`。App 不知道真实文件路径，默认也不能读取其他 App 的数据。

- 停用、升级：保留数据；
- 卸载：由 Host 询问“保留数据 / 同时删除”；
- App 没有卸载 Hook，不能在卸载时偷偷上传或转存数据；
- Store Schema 升级走 `data.migration` 指向的事务型 Hook，失败时数据和新 Package 一起回滚。

版本属于每个命名 Store，不存在全局 `storage.schemaVersion`。当某个 Store 以后从 1 升到 2，Manifest 增加：

```json
{
  "data": {
    "privateStores": [
      { "id": "tasks", "schemaVersion": 2 },
      { "id": "preferences", "schemaVersion": 1 }
    ],
    "migration": {
      "componentId": "ui",
      "hook": "default.migrate"
    }
  }
}
```

Host 比较旧、新 Manifest 后，只把真正变化的 Store 放进一次迁移计划：

```ts
async migrate(ctx, plan) {
  // plan.fromAppVersion / plan.toAppVersion
  // plan.stores: [{ id, fromSchemaVersion, toSchemaVersion }]
  // 只能使用 ctx 提供的事务型 Store Handle。
}
```

固定规则：新 Store 的旧版本视为 `0`；Schema 只能单调增加；多个 Store 在同一更新事务中全部成功后才提交；Schema 变化但没有 `data.migration` 时，更新在 staging 阶段拒绝。v1.1 不提供降级 Hook，`dataCompatibility.rollbackFloor` 继续表示“当前数据最低还能由哪个 App SemVer 读取”。迁移 Hook 必须幂等、无网络、无 UI。

### 两个 App 需要共用数据怎么办

v1.1 不允许 A 猜到 B 的文件路径后直接开库。共享单位是 Host 管理的**命名 Store + Schema**，并且只面向同一签名 `publisherId`。例如 Agents·IM 拥有会话 Store，Agents·任务要读写它：

Agents·IM（数据拥有方）：

```json
{
  "data": {
    "exports": [{
      "id": "conversations",
      "store": "conversations",
      "schema": "com.reai.agents.conversations@1",
      "operations": ["query", "append", "update"],
      "consumers": [{
        "appId": "com.reai.agents.tasks",
        "publisherId": "reai"
      }]
    }]
  }
}
```

Agents·任务（数据请求方）：

```json
{
  "data": {
    "imports": [{
      "id": "agent-conversations",
      "componentId": "tasks-ui",
      "ownerAppId": "com.reai.agents.im",
      "ownerPublisherId": "reai",
      "exportId": "conversations",
      "schema": "com.reai.agents.conversations@1",
      "operations": ["query", "append", "update"],
      "required": true,
      "purpose": "在任务页面关联会话与任务锚点"
    }]
  }
}
```

Host 只有在下面条件全部满足时才发放访问句柄：请求方声明 import、拥有方在 `consumers` 允许该 App、两者签名发布者一致、Schema 与 operations 相容、用户在授权摘要中同意。任一项缺失立即拒绝并记录审计事件。

“双边授权”指一次访问同时存在**请求与允许**，不代表 A 能读 B 后 B 自动也能读 A。若 B 也要读 A，必须再建立反向的一组 import/export。App 得到的是 Broker 句柄，不是对方的整个 KV、数据库文件或任意 Key。

属于平台的账号、设备、Media 等公共领域数据仍由 Host Service 管理，不应伪装成某个 App 的共享 KV。

### To-Do 为什么没有后台服务

它只在用户操作时读写自己的数据，因此只有一个 UI 组件：

```json
{
  "runtime": {
    "components": [
      {
        "id": "ui",
        "kind": "web-surface",
        "protocol": "web-surface@1",
        "required": true,
        "headless": false,
        "activation": "on-demand",
        "entry": "dist/app.js",
        "lifecycle": { "activate": "default.activate", "deactivate": "default.deactivate" }
      }
    ]
  }
}
```

如果未来 App 需要后台运行，可以在同一个 Manifest 中组合声明：

- `wasm-component`：默认第三方后台逻辑；
- `remote-service`：逻辑运行在声明过的云服务；
- `native-companion`：官方或严格例外的原生辅助进程。

不能在 UI 代码里偷偷执行 `npm start`、Python、Shell、AppleScript 或自行安装 LaunchAgent。详细规则见[运行依赖规范](./runtime-dependencies-v1.md)与[发行渠道规范](./distribution-policy-v1.md)。

### To-Do 为什么不能联网

它声明：

```json
{
  "network": { "policyVersion": 1, "endpoints": [] }
}
```

所以 Host 的 Network Broker 必须拒绝它的所有外部请求。需要联网的 App 必须逐个声明域名、用途、数据类型和是否必需；具体规则见[网络与计费规范](./network-billing-policy-v1.md)。

---

## 10. Loading、错误与诊断

Surface mount 只能有三个结果：

```text
mount 开始 ──→ ready      用户看到 App
          ├──→ fail       用户看到 Host 标准错误页
          └──→ timeout    Host 判定 SURFACE_READY_TIMEOUT
```

App 错误结构：

```json
{
  "code": "com.example.todo/STORAGE_READ_FAILED",
  "userMessage": "无法读取待办事项",
  "retryable": true,
  "suggestedAction": "retry",
  "traceId": "由 Host 补充"
}
```

- 普通用户只看 `userMessage` 和“重试”等可执行动作；
- Developer Inspector 显示技术原因、生命周期事件和 trace；
- 首屏无法建立时调用 `surface.fail(error)`，Host 结束 Loading；页面 ready 后发生的可恢复错误调用 `surface.reportError(error)`，保留页面并把原始 cause 交给 Inspector；两者都属于 `surface.main@1`；
- 不得把堆栈、本机路径、Token 或用户数据直接显示给用户；
- `activate()` 中缺少 Manifest 声明的 handler，启用失败；已安装的侧栏入口仍由 Host 保留，并显示可诊断的失败/修复状态，不能变成无响应的死入口。

Host 最少需要这些稳定错误码：

`APP_ACTIVATE_FAILED`、`APP_ACTIVATE_TIMEOUT`、`MISSING_COMMAND_HANDLER`、`MISSING_SURFACE_HANDLER`、`SURFACE_READY_TIMEOUT`、`COMMAND_TIMEOUT`、`STORAGE_UNAVAILABLE`、`STORAGE_QUOTA_EXCEEDED`、`HOST_API_INCOMPATIBLE`。

---

## 11. 平台机制：能力授予、标题栏动作、插件权限、Tab 层、事件订阅与 Action 广播

这一章是插件与宿主之间的六个**通用平台机制**。它们不是某个插件的专属功能——
所有插件（官方与将来的第三方）长在同一套规范上。

普通开放的 `system.tasks@1` 允许插件读取 Host 归一化版本状态，并发起
`firmware-upgrade | software-update | permission-settings | keymap | account-login |
voice-command-settings | audio-timeline-settings | app-permissions` 白名单设置任务。后两项分别打开
官方 Voice 设置与来源插件自己的已安装详情权限区；`audio-timeline-settings` 是旧 target 的兼容名称，
Voice 缺失或停用时导航失败。`app-permissions` 没有可信来源 appId 时必须拒绝
导航，插件不能借参数打开别的应用。来源身份与 Surface 由 live
Bridge mount 推导；远端配置、下载、size/SHA-256、USB/DFU 和内部路由全部留在 Host。Host API 1.2
只实现固件执行器，软件更新当前仅提供状态与安全导航。

### 11.1 能力授予分档（grantGated）

`requires.hostCapabilities` 的判定从三档变四档：

| 档位 | 含义 |
|---|---|
| `granted` | 平台已实现，所有按规范安装的插件可用 |
| `grantGated` | 平台已实现，但安装包必须命中独立审核批准并写入 `capabilityGrants` 才可用 |
| `withheld` | 规范里有、首版明确不提供（错误详情附原因） |
| 未知 | 拼写错误或来自更高版本规范 |

grantGated 未授予时安装被拒：`APP_CAPABILITY_NOT_GRANTED`。当前生产矩阵包含
`agent.codex@1`、`agent.local@1`、`activation.startup@1`、`voice.input@1`、`voice.command@1`、
`terminal.session@1` 等能力。批准与 Manifest 分离，并绑定 appId、发布者、版本和包 SHA-256；
官方身份不自动放权，第三方未来也只能走相同审核流程。`agent.local@1` 只授予官方诊断助手：本地 pi agent 内核，四个只读工具
（不接受路径参数、不写文件、不执行命令），日志摘要经云端模型网关分析。授予只影响「能不能用」，**不产生任何加载行为**（授予不创建 session/界面，
红线有断言测试锁死）。`voice.input@1` 只暴露类型化 `ctx.voiceInput`，插件拿不到设备句柄、
模型 URL/路径、原始 Tauri command 或文字注入平台对象。`voice.command@1` 只允许官方 Voice
提交本地 STT 的最终文本；Workflow URL、外壳的 OAuth token、HTTP 与响应校验全由 Host 掌管。

### 11.2 Host 托管标题栏动作（`contributes.titlebarActions`）

`titlebar.action@1` 位于 `granted` 档：官方 Catalog 与 macOS Developer Mode 本地插件都可声明，
它不是用户权限。每 App 最多 3 个动作，Host 只渲染 11 个公开白名单图标与长度受限的纯文本；
icon/text 至少一个，intent 最多 4096 规范化紧凑 JSON 预算、8 层；字符串按实际 UTF-8 JSON
字节、number 保守按 24 bytes 计，确保 CLI 与 Host 在边界给出同一结论。

动作可声明 `default`、`outlined`、`danger` 三种 Host 变体；可选 `titlebarStatus` 由 Host 渲染
最长 24 字符的静态状态胶囊，tone 为 `neutral`、`success`、`warning` 或 `danger`。两者都只提交
受控数据，不允许插件提供标题栏 DOM、CSS、SVG 或网络资源。

`showOnTitlebarHover` 省略或为 false 时动作常驻，适合设置、帮助等需要持续可发现的入口；设为 true
时普通态隐藏，适合低频辅助动作，在整条 44px Title Bar hover 或键盘 `:focus-visible` 时显现；
通知面板打开时暂时隐藏。点击信封为
`{ source: "host.titlebarAction", actionId, deliveryId, payload }`。Host 从已安装 Manifest 重读
payload，并校验当前 presentation 与 mount；插件 DOM、CSS、SVG、URL 都不会进入 Title Bar。
`source` 是 Host 事件保留字段，普通 App-to-App intent 的顶层 input 不允许携带它，peer 插件因而
不能伪造标题栏信封。
切换 App 时旧动作保留到候选 Ready 后原子替换，离开、停用、卸载或当前 owner 贡献消失即清空。

所有从功能页、空状态或错误提示发起的定向设置操作都必须携带稳定目标，而不是只打开设置页。
目标页挂载后应滚动到对应 section/action，给目标容器程序化 focus，并用主题色做一次 1.5–2 秒的
背景高亮闪烁；`prefers-reduced-motion` 下取消动画但保留短暂背景提示。通用“打开设置”没有唯一
目标时可定位页头；“配置工作流”“授权麦克风”等已经点名设置项的入口不能让用户二次寻找。
Host 系统任务负责 Host 设置页，插件负责自己的设置 Surface，合同测试应覆盖目标映射、滚动、
focus 与瞬时高亮状态。

### 11.3 Tab 层实体条目（`contributes.tabItems`）

Tab 层是宿主的**全局置顶浮窗**（Tab 键唤起），按实体记录「当前在跑什么」——花名册，不是流水账。

- 声明 `contributes.tabItems: { "componentId": "..." }` 后，经 SDK `ctx.tabItems` 推送：
  `upsert`（同 entityId 重推 = 重排到最前，**绝不产生第二条**）、`remove`（幂等）、`list`。
- `requiresInteraction: true` **只许配 `waiting_input`**（需要用户决策才许举旗），
  违反门禁 → `TAB_ITEM_FLAG_NOT_ALLOWED`；每插件举旗上限与实体数上限在矩阵 limits。
- 排序：需交互组置顶，组内按最近激活；时间戳由 Host 打（插件不能自报时间抢排序）。
- 生命周期：**停用/卸载清场**（条目全清并刷新层）；回收（reclaim）保留；宿主重启清零（内存态）。
- 条目零决策：点击只跳转（切控制目标 + 跳到现场），旗由你报告「决策已完成」才落。

### 11.4 Host→插件事件订阅（`contributes.eventSubscriptions`）

声明即订阅：mount 建立后自动生效，**mount 关闭即退订**，停用/卸载自然清场。

- v1 事件类型只有 `actionContext`（清单在矩阵，写错 = `MANIFEST_SCHEMA_INVALID`）。
- 收事件：SDK `ctx.events.on(handler)`（activate 期间注册）；信封带两层会话身份，
  非本轮会话的事件 SDK 直接丢。
- 背压：单条超 `bridgeMessageBytes`（1 MiB）不投；投递失败即丢并计数，连续失败超阈值
  暂停该 mount 的投递（不踢插件，mount 重建恢复）。

### 11.5 Action 上下文广播与菜单（`contributes.acceptsActionContext`）

- **数据向下广播**：宿主产物（Action 录制等）写入**存证存储**（TTL + 容量上限 + Redis 式
  自动清理），广播只带引用——`{ meta, pickupToken }`。声明接受该 contextType 的活跃插件
  同时收到同一份；未挂载的不投（不为此冷启动）。
- **取件**：`ctx.evidence.fetch(pickupToken)` 拿字节，token 一次性（取后即焚），
  存证本体留到 TTL（多个订阅者各取一次）。
- **动作向上单选**：Action 菜单（Action 键唤起）聚合用户已挂载的命令与运行时条目，
  不自动列出所有 `contributes.commands`；用户选哪条，**只有那条命令或条目的目标执行**。

#### Action 快捷方式挂载（`ctx.actionItems`，已开放）

插件调用 `mount`、`unmount`、`list` 管理自己的挂载。挂载表达用户选择，应在用户勾选时调用，
不要在 `activate` 中自动添加。Host 从当前插件会话取得身份，插件不能列出或取消其他插件的挂载。

- `kind: "command"`：`id` 必须是本插件 Manifest 已声明且允许 `user` 调用的命令，不接受 `target`。
- `kind: "item"`：适合 Skill 等运行时条目；需声明 `contributes.actionItems`，并提供本插件的
  `target: { surfaceId, intent? }`。选择后由 Host 打开该 Surface 并投递 intent，不接受任意脚本执行。
- `list()` 返回当前插件的 `ActionMountInfo[]`，条目身份字段是 `itemId`；取消时使用
  `unmount(kind, itemId)`，不是取一个不存在的 `id` 字段。
- 挂载由 Host 持久化，停用保留并显示不可用；正常卸载清除。插件内的挂载开关应以 `list()` 为真源。
- `ctx.actionItems.onChange(handler: () => void): () => void` 订阅本人挂载变化，返回同步 disposer。
  通知仅表示需要刷新；在 handler 中调用 `list()`，首次打开也须主动读取，不能依赖历史通知重放。
  Host mount/unmount/卸载清场都会触发；只投递给对应 appId 当前 Surface，不包含其他插件条目。
  SDK 校验 runtimeSessionId 与 surfaceMountId，过期消息丢弃；Surface 退出时调用 disposer。
- `ctx.tabItems.isVisible(): Promise<boolean>` 读取本人 Tab 显示偏好；`ctx.tabItems.onChange(handler)`
  接收显示偏好变化，清理方式相同。隐藏不删除原始条目，也不停止任务；推送不会覆盖用户偏好。
- 此增量接口随包含层管理的 Host SDK runtime 提供。旧 Host 不会发变更通知；跨版本插件可用
  `onChange?.(...)` 特性检测，仍在首次打开/重连时读取 `list()`。源码支持不等于旧批准插件产物已经接线。

```ts
// 在用户点击“挂到 Action 层”时执行；command 必须已在 Manifest 声明。
await ctx.actionItems.mount({ kind: "command", id: "com.example.app.run", title: "运行" });
const mounts = await ctx.actionItems.list();
const selected = mounts.find(item => item.kind === "command" && item.itemId === "com.example.app.run");
if (selected) await ctx.actionItems.unmount(selected.kind, selected.itemId);
```

设置 → Tab 与 Action 聚合显示实际注册内容；只有主设置窗口可以跨插件取消或撤销 Action 挂载。
取消后 Host 持久化同一份清单，Action 层与订阅上述接口的插件重新读取；不清理物理按键绑定。
撤销重新校验当前 Manifest 和限额，并拒绝覆盖取消后重新挂载的新内容。保存失败保留先前状态。
Tab 来源显示偏好由 Host 持久保存，覆盖插件 Tab 条目和归属该插件的后台任务/观察摘要；系统来源只读。

```ts
// Surface mount 内：先订阅，再回读，dispose 时清理；晚到读取要用序号保护。
let request = 0;
let closed = false;
const refresh = async () => {
  const seq = ++request;
  const mounts = await ctx.actionItems.list();
  if (!closed && seq === request) renderMountedSwitches(mounts);
};
const stop = ctx.actionItems.onChange?.(() => { void refresh().catch(showPersistentError); });
void refresh().catch(showPersistentError);
return () => { closed = true; ++request; stop?.(); };
```

### 11.6 系统通知 Host Broker（2026-08-09 落地）

- 插件声明 `os.notification.post@1` 后，只能调用 `ctx.notifications.post({ title, body })`；
- Host 先校验会话、安装/启用状态、Manifest、插件用户授权和系统通知授权，再执行发送；
- 插件权限属于当前 `appId` 的本机安装，系统通知权限属于 ReAI Board Host App，两者相互独立；
- Host App 启动只查询系统状态；macOS 系统授权请求只能由用户点击首次引导中的“开启通知”或设置页的“允许通知”触发。首次未决定时直接弹出系统确认，已拒绝后只能由用户从系统设置重新开启；
- 插件不能直接访问 Tauri notification JS API，也不能申请、读取或修改系统授权；
- Host 强制加入插件来源指纹、执行纯文本校验和每插件速率限制；`queued: true` 不承诺最终展示。
- 当前 Windows/其他非 macOS 构建暂将系统通知权限视为 `granted`，插件级授权门禁不变。

场景 key、应用内/系统级两档通知、本地持久化历史和右上角通知中心从 Driver 1.0.5 起已接线（`notifications.publish@1`，
仅对审核批准 + 用户同意的插件开放），以[插件开发规范 v1 的通知目标章节](./plugin-development-v1.md#43-场景化通知notificationspublish1driver-105-起)
为单一事实源；其中“启动汇总授权框”本版不做。本指南不复制第二份字段合同，避免两处漂移。

---

## 12. 开发命令（2026-08-04 更新：核心四条已落地）

基础工具链入口是 `platform/cli`（bun 直跑，无需安装）。新插件和新版本的语言包还必须通过独立严格入口：

```bash
bun platform/i18n-cli/src/cli.ts validate <appDir>
bun platform/i18n-cli/src/cli.ts build <appDir>
bun platform/i18n-cli/src/cli.ts pack <appDir> --out <出包路径.reaiapp>
```

语言资源与挂接直接参考 [Codex App / Codex Link / Voice 三个官方样板](./plugin-i18n-examples.md)。旧 CLI 保持批准工具链兼容；仅运行下面基础命令不能证明语言包合规：

```bash
bun platform/cli/src/cli.ts validate       <appDir>                 # 静态校验（schema + 支持矩阵）
bun platform/cli/src/cli.ts build          <appDir>                 # 打 dist/ + build-manifest.json
bun platform/cli/src/cli.ts contract-test  <appDir> --host-api 1.1  # 真加载核对声明与注册
bun platform/cli/src/cli.ts pack           <appDir> --out <出包路径.reaiapp>
```

Todo/Codex Link 继续用 1.1 做向后兼容烟测；声明 `system.tasks@1` 的 Voice 使用 `--host-api 1.2`。

| 命令 | 开发者得到什么 | 状态 |
|---|---|---|
| `validate` | Manifest、路径、ID、权限、依赖、网络声明静态校验 | ✅ 已落地 |
| `build` | 编译入口到 `dist/` 并产出 Build Manifest（资源白名单） | ✅ 已落地 |
| `contract-test` | 真正加载 App（Mock Host），核对「声明了什么、实际注册了什么」；套件在 `<appDir>/tests/contract.suite.ts` | ✅ 已落地 |
| `pack` | 可复现 `.reaiapp`（字典序 + 固定 mtime + 不压缩）+ archiveDigest 包身份 | ✅ 已落地 |
| `init` | Manifest、入口、视图和测试模板 | 未实现；语言包按[三个官方样板](./plugin-i18n-examples.md)准备，基础业务可参考 `plugins/examples/todo-app` |
| `dev` | Mock Host、热更新、侧栏和 Surface 仿真 | 未实现（用「改代码 → pack → 重装」循环） |
| `inspect` | 查看 activate、Surface、Command、存储和错误事件链 | 未实现（看 `make driver-v2-logs`） |

To-Do 的合同测试至少验证：

```text
✓ Manifest v1.1 合法，Host API 兼容
✓ activate / deactivate 能完成且可重复
✓ main Surface 已声明并注册
✓ com.example.todo.new 已声明并注册
✓ new-task Intent 已声明、Schema 合法并可由 Host 路由
✓ mount 最终调用 ready
✓ Command 能打开 main 并投递 new-task intent
✓ private storage 不能越过 App 命名空间
✓ 推荐键位不会静默覆盖现有绑定
✓ 卸载只处理仍指向当前 App 的绑定，不恢复整表快照
✓ unmount 后没有残留 listener 或局部层
```

---

## 13. 最佳实践：照着做就不容易踩坑

### 界面克制：只显示此刻要紧的那件事

这一节是**全局设计哲学**，不是日程 App 一家的规矩。它管的是「什么该出现在屏幕上」，
优先于下面所有具体条目——一个功能做得再对，出现在不该出现的时刻，它就是干扰。

> 另一半在[插件设计规范 v1](./plugin-design-system-v1.md)：决定要出现的东西**该长什么样**——
> 颜色 Token、图标参数、按钮档位、间距刻度、抽屉与状态。两份一起构成完整的界面要求，
> 本节优先。

一句话：**根据用户当前的场景和需求渐进披露，不要把所有东西堆到一起。**
用户在一个时刻只关心一件事，界面要替他把别的收起来，而不是把选择权连同认知负担
一起丢回去。下面五条是这句话的可执行判据。

#### 1. 无必要，勿增按钮

**能自动发生的事，不要做成开关让用户手动做。**

判据：问「不给这颗按钮，用户会失去什么」。如果答案是「什么都不会失去，因为
那件事本来就会自己发生」，这颗按钮就是纯粹的负担——它占位置、要命名、要记状态、
要写文档，而它带来的能力是零。

反例（日程页 V1.3 已撤掉）：

| 撤掉的按钮 | 为什么它不该存在 |
|---|---|
| 日历「展开 / 收起」 | 点任意一个日期，日历本来就会展开。这颗按钮让用户替界面做本该自动的事 |
| 「日程助理」 | 助理需要补信息时自己会出来。常驻一颗按钮 = 让用户随时惦记「我是不是该问问它」 |

一个例外要留意：**同一颗按钮在不同尺寸下必要性可能不同**。日历按钮在宽屏是多余的
（日历一直在右边），在窄屏是必要的（右栏收成了抽屉，没有别的入口）。所以它现在
只在窄屏出现——而不是「因为窄屏需要，所以两边都留着」。

#### 2. 全局能力不在单个 App 里开第二个入口

提醒、通知、待办这类「有事要你处理」的语义是**全平台共有**的：Agents、终端、
固件更新都会产生。每个 App 各开一个铃铛，用户就得挨个 App 巡一遍才知道有没有事——
注意力被切成 N 份，恰好是「注意力一次只在一处」要防的。

规则：**App 只负责把事件记进 Host，不自己造呈现入口。** 日程 App 的通知铃铛
（V1.3 已撤）就是这条的反例：它把一个全局问题在一个局部解决了一次。

App 自己那一侧该怎么出声？让**相关的界面在相关的时刻自己出现**——日程改成
「助理需要补信息时自己拉开来问」，而不是在角落点亮一颗小红点等用户自己发现。

#### 3. 留白是用来分组的，不是装饰

两组语义不同的东西挤在一起，用户就得自己在脑子里切分。间距是最便宜的分组手段，
不要省。

判据：屏幕上相邻的两块，如果**回答的不是同一个问题**（「我在看哪天」和「我要做什么」
就是两个问题），它们之间必须有明显大于组内间距的留白。

顶部 Title Bar 是一处明确的系统结构：`0–44px` 只归 Host，App 不再叠第二层页头；可滚动
`main-body` 从它下方开始。正文区域的分组留白仍应按语义分配，不能因为顶部合同明确了，
就在 Title Bar 下面再堆一层装饰性空白。

这里禁止的是没有信息作用的空白堆砌，但有结构作用的留白必须保留。顶部交界只允许两种模式：
同色时让 Title Bar 与正文使用同一主题 Token 连续铺开，不加装饰性间距；异色时把第一块异色
Surface 内缩到 `main-body` 内，桌面默认 `16px`、紧凑布局最低 `12px`。禁止两块不同颜色的全宽
大色面零距离硬切；补一条 1px 线不算完成分层。

#### 4. 按钮的长相由设计系统给，不由浏览器给

任何一个 `<button>`，只要它的样式没写全，浏览器默认的灰底黑框就会顶出来，
在一整套设计语言里格外刺眼。这不是「哪一处写漏了」，是缺一条地基。

规则：**样式表里必须有一条全局按钮基线**，把 `border` / `background` / `font` / `color`
全部归零，视觉一律由具体的 class 显式给出；`:focus-visible` 的可见描边要保留，
键盘用户需要看得见焦点。

```css
button{font:inherit;color:inherit;border:0;background:transparent;cursor:pointer;
       -webkit-appearance:none;appearance:none;text-align:inherit}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
```

同一层级的操作要用同一套按钮语言（主 / 次 / 图标 / 分段），不要为某一处单独造型。
Review 时的判据很直白：**遮住页面其余部分，单看这颗按钮，说得出它属于哪一档吗？**

#### 5. 渐进式披露：先收下，再补全

一个输入流程不要一上来就铺开完整表单。**先拿到最少的必要信息把事办成，
其余的做成可选的、按需展开的补充。**

日程页的新增流程是这条的样板：

1. 入口只是一颗「新增」，不是常驻输入框——它一天用不了几次，却天天占着两行高度；
2. 点开后铺满整页，此刻别的都不重要，所以别的都不在；
3. **默认就在语音待命**——语音是这块键盘的主路径，让用户先找麦克风按钮再点一下，
   等于把主路径降级成需要额外一步的次要选择；一敲键盘就转成打字，不再多问一次；
4. 属性（谁 / 地点 / 时间 / 步骤）默认只是一排图标，点哪个才展开哪一条，不点就
   永远不存在；
5. 收下之后如果还缺关键信息，助理**自己出来问**，而且不回也没事——事情已经收下了，
   不会因为没理它就丢。

最后一条尤其重要：**「可以不理」必须真的零代价**。助理来追问时不要顶开详情页、
不要抢焦点、不要挡住用户原本在看的东西，否则「不理它」就变成了「先退出来再说」。

### 界面（工程边界）

- 只在 `surface.root` 内渲染，不查询或修改 Host DOM；
- 使用 Host 提供的主题 Token，不复制 Design 原型中的内部类名；
- 不调用 Design 原型里的 `setV()`、`VIEWS`、`rail-slot` 等内部实现；
- 列表为空、加载中、失败、权限不足都要有明确状态，不能白屏；
- 用户内容用框架默认转义或 `textContent`，不要直接拼 `innerHTML`；
- 切走后保留业务状态，但暂停无意义动画；unmount 时彻底释放资源。

### 生命周期

- `activate()` 幂等，不把“安装”当“执行安装脚本”；
- `ready()` 只在第一屏真的可用后调用；
- mount 每次都返回 cleanup；
- 不假设 App 只会 mount 一次；
- 更新前先迁移，失败保留旧版；卸载不偷跑清理脚本。

### 能力与安全

- 只声明真正需要的权限、域名、依赖和计费模式；
- 后台任务交给 Host 管理，不偷留子进程；
- Command 必须可取消、可超时、返回结构化结果；
- 推荐键位永远由用户确认；
- 全局设备、Media、Billing 和 Overlay 一律通过 Host Capability，不自己造第二套入口。

---

## 14. 当前能做什么，下一步要实现什么

| 能力 | 2026-08-27 仓库状态（driver-v2） |
|---|---|
| App Manifest v1.1 Schema / validator | ✅ `schemas/app-manifest-1.1.schema.json` + Host/CLI 双侧同源校验 |
| `@reai/app-sdk/v1` | ✅ `platform/sdk`（Host 运行时内嵌提供，构建时 external） |
| 动态侧栏入口与 main Surface | ✅ 安装即出现（installed + disabled，不执行代码） |
| activate / mount / ready / fail | ✅ 生命周期引擎 + 六维状态快照；生产 Host 的 unmount cleanup / deactivate 送达尚未闭环 |
| App 私有 KV | ✅ 落盘隔离（单值 256KiB / 每 App 32MiB）；共享 Store Broker 未实现 |
| Command Schema 与 App Intent | ✅ 声明 + Dispatcher 派发 + M6 键位页绑定（含 availability 与 target_digest） |
| Mock Host、合同测试、`reai-app` CLI | ✅ `platform/test-kit` + `platform/cli`（validate/build/contract-test/pack） |
| 安装事务与 `.reaiapp` 包 | ✅ M5：安全解包 + 限额 + 原子切换 + 崩溃恢复；两阶段可恢复卸载带数据处置 |
| Host 受管可执行资源 | ✅ Direct 一期：requirements 1.2、签名目录、`.reairuntime`、复合 journal、按需修复、引用边与 Codex/Pi/DSH resolver；生产公钥/CDN/公证制品仍是发布门禁 |
| 开发者通道（本地装包） | ✅ M5：开发者模式（默认关）+「从本地安装」+ 双击 `.reaiapp` |
| 能力授予分档（grantGated） | ✅ C1-1：矩阵第四档 + 官方 seed 的最小 appId 授予；当前承载 Codex、startup、Voice Input 与 Voice Command 窄口 |
| Host 托管标题栏动作 | ✅ `titlebar.action@1`：icon/text、hover/focus、当前 presentation intent；主壳与 macOS sibling Titlebar 双路径 |
| 插件用户权限 | ✅ `permissions[]` + 本机权限账本 + 已安装页允许/拒绝；当前开放 `account.status@1` 与 `os.notification.post@1` |
| 系统通知 Broker | ✅ `ctx.notifications.post({ title, body })`；macOS 用户点击后才申请系统授权，非 macOS 暂视为已授权；插件不可触发授权弹窗 |
| Voice 官方插件 | ✅ `com.reai.voice`：双音源、本地 SenseVoice、文字注入、Host 托管 Workflow Command、模型/权限设置、两类真实历史、首次 Voice 键 seed；Context 延后 |
| Host 托管 DSH / 通用 Agent Session | ✅ `agent.dsh@1` 与 `agent.session@1`；当前按 appId grant，Spec 的 prompt/tools/skills 在会话创建时固定 |
| 插件间 Service / Agent Scene / 动态 Tool | 未实现；目标合同见[插件服务与 Agent / DSH 扩展规范](./agent-service-extension-v1.md) |
| Tab 层实体条目与全局浮窗 | ✅ C1-3/C1-4：花名册 upsert + 举旗门禁 + 置顶浮窗（Tab 键默认唤起，旋钮/Enter 路由） |
| Host→插件事件订阅 | ✅ C1-2：声明即订阅 + 背压（1 MiB/失败计数/暂停），mount 关闭退订 |
| Action 上下文广播与菜单 | ✅ C1-5：宿主存证（TTL/容量/引用传递/一次性取件 token）+ 菜单实时聚合、选中单发（Action 键默认唤起） |
| 复合 Runtime Component 与 Headless | 未实现（首版矩阵限单 web-surface 组件） |
| App Package 签名、审核、Catalog 与在线更新 | 未实现（对外开放前置，见主计划 §7） |
| 插件自有外脑 OAuth 身份 | 未实现（方案已定 2026-08-14：每个插件是独立外脑 OAuth App，令牌由 Host 保管、请求经 Host 通道代发、上架只过 ReAI 一道审核；受外脑自助 App 体系闭环制约，见 插件 OAuth 父子架构方案（Board 仓库内部材料，未公开）） |

---

## 15. 政策附录什么时候看

开发 To-Do 先读完本文即可。遇到下面的问题再查对应规范：

| 你的问题 | 去哪里看 |
|---|---|
| App 在 Mac App Store、Microsoft Store、官网版怎么交付和更新 | [发行渠道与软件包规范](./distribution-policy-v1.md) |
| 用户没装 Node、Python、CLI 或系统组件怎么办 | [运行依赖规范](./runtime-dependencies-v1.md) |
| 能访问哪些域名、怎么放 API Key、能否自行支付 | [网络与计费规范](./network-billing-policy-v1.md) |
| 插件怎样提供服务、声明 Agent 场景、动态挂载 DSH/Pi 工具 | [插件服务与 Agent / DSH 扩展规范](./agent-service-extension-v1.md) |

这三份是平台政策；本文是开发入口。开发者先学会把 App 接进 Design，再按实际能力补齐对应政策声明。
