# ReAI App Platform v1.1：运行依赖规范

> 状态：已锁定的产品基线，实现目标<br>
> 版本：v1.1<br>
> 日期：2026-08-01<br>
> 适用范围：ReAI Host、官方 App、内置插件与后续第三方插件<br>
> 开发入口：[App 开发指南：从 0 做一个 To-Do List](./app-development-guide-v1.md)<br>
> 配套文档：[发行与更新策略](./distribution-policy-v1.md) · [网络与计费策略](./network-billing-policy-v1.md) · [交互式版本（HTML 快照，可能滞后于本文）](./runtime-dependencies-v1.html)

> ⚠️ **这是规范，不是首版实现清单。** 首版 Host 只实现其中一个子集（档位 `official-only`：只装官方插件）。
> 每一处有意的偏差、以及开放第三方前必须补齐的安全清单，见 [README.md](./README.md)。
> 机器可读事实源：`platform/contract/host-support-matrix.json`（能力与限额）、`platform/contract/schemas/app-manifest-1.1.schema.json`（结构）。


## 1. 一句话结论

ReAI 主程序必须在没有 Node.js、Python、ffmpeg、Claude、Codex、Kimi、Chrome、硬件和网络的干净系统中正常启动；每种硬件通过独立 SDK/Host Provider 接入，每个 App 由可组合的 Runtime Component 构成，缺失依赖只能阻断或降级它关联的组件和功能，不能拖垮整个主程序。

## 2. 规范目标

本规范解决六个问题：

1. 用户安装 ReAI 后，哪些能力立即可用，哪些需要授权、下载或另行安装。
2. 插件依赖什么环境，以及依赖缺失时如何探测、解释、修复和降级。
3. Mac App Store、Microsoft Store 与官网下载版采用什么不同的依赖交付方式。
4. 打包和发布前如何证明不存在“开发电脑上能用，用户电脑上不能用”的隐性依赖。
5. 一个 App 如何组合 UI、Wasm、远程服务和原生伴随进程，并逐组件上报健康状态。
6. 不同硬件如何通过稳定 SDK 服务被 App 使用，而不是把普通功能绑定到 AI Board 01 或某个代码目录。

本文使用“必须”“不得”“应”“可以”表达约束强度。发行渠道的代码交付边界以《发行与更新策略》为准；第三方服务和支付依赖以《网络与计费策略》为准。

## 3. 不可破坏的原则

### 3.1 主程序零隐性依赖

- 主程序不得依赖用户预装 Node.js、Python、ffmpeg、Homebrew、npm、Chocolatey 或其他包管理器。
- 构建机器使用的 Bun、Rust、Cargo、编译器和签名工具是 `build_time`，不得被误写成用户运行依赖。
- 运行时确实需要的库必须随安装包交付，或由对应渠道的安装器明确管理。
- 主程序必须能够在离线、无硬件、无外部 CLI 的情况下启动并进入可解释状态。

### 3.2 插件依赖不得上浮

- 插件的依赖归属于插件或具体功能，不得变成 ReAI Host 的全局启动条件。
- 一个插件缺少依赖时，其他 App、设置、卸载和依赖修复入口必须继续可用。
- 外部依赖不得阻止 Host 启动。只有某个 App 在缺少该依赖时连核心界面或核心数据都无法使用，才允许该 App 把依赖标为 `required: true`；影响单个组件或功能的依赖必须保持可选并精确写入 `componentId + requiredFor`。
- Node/Python 类解释器如果仅服务于一个插件，必须由该插件声明；官方插件优先使用已编译或随包携带的运行时，不得暗中借用用户的全局环境。

### 3.3 探测不等于安装

- 启动时的依赖探测必须无副作用、短超时、可取消，不得静默安装、升级、登录或修改用户配置。
- 外部工具安装必须由用户明确触发，并在可见界面中展示来源、命令、权限和影响。
- `curl | sh`、远程 PowerShell 等安装方式不得在后台自动执行；商店渠道还必须满足各自审核规则。
- 依赖版本、签名或哈希不符合要求时，不得仅凭“文件存在”判定为可用。

### 3.4 失败必须可解释

- 缺少必需依赖时显示具体功能、缺少项、影响和修复动作。
- 可选依赖缺失时记录 `dependencies=missing_optional`；若功能只能降级，再聚合为 `health=degraded`。不得展示空白页面、无限加载或通用“未知错误”。
- 修复失败后必须保留重试、手动说明和卸载入口。
- 网络服务暂时不可达与本地依赖未安装是不同状态，不得混为一谈。

### 3.5 硬件服务必须解耦

- 每一种硬件类型必须拥有独立、版本化的 Hardware Service SDK 与 Host Provider；AI Board 01 只是第一个 Provider，不是平台本身。
- App 只能通过 SDK Bridge 调用声明过的 Hardware Service，不得直接打开 HID、USB、BLE 句柄，也不得读取 Provider 私有文件或具体仓库目录。
- 普通功能不得因为 AI Board 01 未连接而不可用。只有 `requires.hardwareServices[].requiredFor` 指向的硬件专属功能可以降级或阻断。
- Provider 的实现可以位于当前 Host、未来官方 Package 或其他受信模块，但公开合同只以 `id + sdkApi` 为准，不以 `src-tauri/`、`driver/` 或任何磁盘路径为准。

### 3.6 Runtime Component 必须独立

- 一个 App 可以同时包含 `web-surface`、`wasm-component`、`remote-service` 和 `native-companion`；不得再用单个 `runtime.kind` 假装整个 App 只有一种运行形态。
- 每个 Component 必须有稳定 `id`、独立生命周期、依赖、健康状态和降级范围。
- Surface、Command、后台任务等 Contribution 必须通过 `componentId` 指向实际执行它的 Component。
- App 可以没有 UI，以 headless 方式运行；但必须经过显式启用、后台能力审核、资源约束和可见的停止/诊断入口。

### 3.7 开发阶段先完成三层交付判定

Runtime Component 解决“哪段代码在哪里运行”，三层交付解决“哪份产物由谁安装和治理”。开发者必须
在写实现前同时完成两项判定，不能到打包阶段才把开发机依赖临时塞进 Host 或 `.reaiapp`：

1. **App 主体**只保留 Host、安装修复、权限与能力系统、设备能力和基础 UI；没有任何可选 Agent/TTS
   runtime 时仍能启动、诊断和卸载插件。
2. **`.reaiapp`**承载插件 UI、业务编排、权限和依赖声明；纯界面插件可以止于这一层。
3. **Host 受管资源**承载需要独立下载、签名、探针、升级、回滚或共享的平台可执行闭包。插件只声明
   稳定资源身份和用途，URL、摘要、签名发布者、撤回状态与落位由 Host 受信目录解析。

模型、音色、固件和媒体仍属于非执行内容，声纹、输出、历史和配置仍属于用户数据；二者与可执行
runtime 生命周期分开，但不另造一套“软件分发层”。这条分层不规定源码目录，判断依据是能否独立
安装、更新、回滚、共享和删除。

> **实现状态**：当前 Host 仍只接受单个 `web-surface`，但已开放受限的
> `requirementsVersion: "1.2"` 受管可执行依赖子集。`.reairuntime`、签名目录、复合安装、修复、
> 引用边和 Codex/Pi/DSH resolver 已落地；其他 Runtime Component 与本节更广的依赖分类仍是目标合同。

## 4. 依赖分类

每项依赖必须且只能选择一个主分类。

| `kind` | 含义 | 用户是否需要准备 | 典型示例 |
|---|---|---:|---|
| `build_time` | 仅用于编译、测试、签名或发布 | 否 | Bun、Rust、Cargo、CI、签名工具 |
| `bundled` | 编译进二进制，或与对应 Host / Extension Package 紧耦合并随包交付 | 否 | SQLite、portable-pty、sherpa-onnx、VAD 模型 |
| `os_capability` | 操作系统自带能力或用户授权 | 可能需要授权 | WebKit、系统 Shell、macOS TCC 权限 |
| `installer_managed` | 由系统商店或 ReAI 安装器安装/修复 | 安装器处理 | Windows WebView2 Runtime |
| `managed_executable` | ReAI 构建、签名、由 Host 按签名目录治理的不可变可执行闭包 | Host 展示并安装 | Codex/Pi/DSH/Audio helper runtime |
| `optional_external_tool` | 用户主动选择的外部软件 | 是，但只影响对应功能 | Claude Code、Codex、Kimi、Chrome |
| `downloaded_content` | 宿主下载并校验的非执行内容 | 需要网络/磁盘 | STT、标点、固件与媒体资源 |
| `remote_service` | 运行在外部网络的服务 | 需要网络或账户 | OAuth、模型 CDN、OTA、Agent API |
| `hardware` | 物理设备及其系统驱动栈 | 对设备功能需要 | AI Board 01、麦克风、USB/BLE |

补充规则：

- 下载后会执行的代码不得伪装为 `downloaded_content`，它属于发行策略中的可执行插件代码。
- `installer_managed` 不代表可以静默安装，仍须遵守渠道规则和用户授权。
- 同一功能可有多个依赖，例如“语音输入”同时依赖麦克风权限、录音设备、本地模型和 sherpa 运行库。
- `bundled` 不表示插件的可选大运行时可以上浮进基础 Host。需要独立下载、升级、回滚、共享或撤回的
  平台可执行闭包，目标上进入 Host 受管资源层；其字段级分类尚未在当前 Manifest 开放。

### 4.1 Node、Python、AppleScript 与外部 CLI

| 技术 | 默认分类 | v1.1 打包规则 |
|---|---|---|
| Node.js / Python（只用于构建） | `build_time` | 不进入用户 `requirements`，正式 Package 只带构建产物 |
| Node.js / Python（随 App 携带完整运行时） | `bundled` | 目标合同仅适用于与单一 Package 紧耦合的受审伴随程序；仍须签名、锁版本并完成许可证/体积检查。需要独立更新、回滚或共享的大型闭包目标上改走 Host 受管资源 |
| Node.js / Python（借用用户全局环境） | `optional_external_tool` | 必须绑定具体 `componentId + requiredFor`；默认只允许 `direct`，不得成为 Host 或普通 UI 的启动条件 |
| AppleScript / `osascript` | `os_capability` | 脚本本身是受审核代码，必须随包；声明 macOS、目标 App、Automation 权限和失败降级，禁止下载后执行新脚本 |
| 系统 Shell / PowerShell | `os_capability` | 仅经审核的明确场景使用；脚本随包、参数结构化、禁止拼接不可信输入，商店 Profile 默认关闭高权限路径 |
| Claude/Codex/Kimi 等 CLI | `optional_external_tool` | 用户主动安装和登录，探测版本/来源；仅影响对应 adapter，不得伪装成 App 的 `native-companion` |
| npm/Homebrew/Chocolatey 等包管理器 | provisioning 辅助项 | 只服务用户主动触发的安装流程；必须另行声明，不能成为 Host 运行依赖，也不能静默修改全局环境 |

目标优先顺序是：纯 Host Capability 或 `wasm-component` → 小型、紧耦合且随包签名的
`native-companion` → Host 受管的独立可执行资源 → 明确可选的用户外部工具。当前 Host 只开放
`web-surface`，后三种本地执行形态不能因为写进目标规范就视为已经可用。不得为了开发方便，默认要求
用户准备一套全局解释器环境。

## 5. Runtime、硬件与依赖机器合同

### 5.1 `runtime.components[]`：一个 App 可以有多个运行组件

v1.1 以 `runtime.components[]` 取代“整个 App 只有一个 `runtime.kind`”的假设。

| `kind` | 作用 | 可否 headless | 关键边界 |
|---|---|---:|---|
| `web-surface` | 隔离的 App UI renderer | 否 | 无 Host DOM、Tauri 原生命令或直通网络 |
| `wasm-component` | Host 沙箱内的可移植业务/后台逻辑 | 是 | 仅导入批准的 SDK 能力，限制 CPU、内存与存储 |
| `remote-service` | 通过 Network Broker 访问发布者或用户配置的云服务 | 是 | 远端响应只能当数据，不得下发可执行代码或扩大权限 |
| `native-companion` | 随 Package 审核、签名的平台原生伴随程序 | 是 | 默认仅 `direct`；独立进程、最小权限、崩溃/退出/卸载可控 |

`requires.hostCapabilities` 声明 App 需要调用哪些 Host API，它不是第五种 Runtime Component。v1.0 的单值 `runtime.kind` 只作为旧 Manifest 的兼容输入；新 Manifest 必须写 `runtime.components[]`。

当前支持矩阵只接受恰好一个 `web-surface`，`native-companion` 尚未开放。目标合同中的随包
`native-companion` 使用 Package 内 `entry`；若组件由 Host 受管资源提供，其资源入口与 Requirement
绑定方式必须另行形成机器合同，不能复用任意路径或靠 Host 猜测。

每个 Component 至少声明：

- `id`：App 内稳定唯一 ID；Contribution 和 Requirement 都通过它引用。
- `kind`：上表四种之一。
- `protocol`：与 kind 匹配的版本化运行合同，例如 `web-surface@1`；Host 不认识时必须 fail closed。
- `required`：该 Component 是否属于 App 的核心能力；失败时决定聚合为 `health=unhealthy` 还是 `health=degraded`，不直接改写用户的启用选择。
- `entry` 或 `serviceRef`：Package 内代码必须写 `entry`，`remote-service` 必须写 `serviceRef`，两者不得并存；`web-surface@1` 的 entry 固定为 ESM JavaScript 模块。
- `headless`：是否允许无界面运行；`web-surface` 固定为 `false`。
- `activation`：`on-demand`、`app-enabled` 或受审核的 `system-event`，不得隐式常驻。

`platforms` 省略时继承顶层 `targets`，显式填写时只能是其子集；`dependsOn` 省略等价于 `[]`。Package 内代码使用 `lifecycle.activate / deactivate` 映射审核过的 Hook；远端组件没有本地 Hook，停用只撤销 Broker 会话。

状态保持正交：`activation=active` 表示用户允许 Host 运行 App；`on-demand` Component 此时可以仍是 `stopped`。required Component 运行失败时聚合 `health=unhealthy`，optional Component 失败时聚合 `health=degraded`，并且都只阻断引用该 Component 的 Contribution。只有用户停用、更新切换、卸载或明确安全策略才进入 `stopping → disabled`。

Surface、Command、后台任务、文件处理器等 Contribution 必须填写 `componentId`。Host 在启用前验证引用存在、类型匹配且该组件在当前渠道可用。一个组件失败只降级引用它的 Contribution；其他组件继续运行。

### 5.2 Headless 运行合同

App 可以完全没有 `web-surface`，也可以在 UI 关闭后保留 headless Component，但必须同时满足：

- 用户已明确启用 App 和对应后台能力；Catalog/启用页明确披露“可在后台运行”。
- Manifest 声明触发源、停止条件、网络、存储、通知、CPU/内存预算与自动重启上限。
- Host Supervisor 按 Component 维护进程/实例、健康状态、退避和熔断；不得让 App 自建脱离 Host 的守护进程。
- 用户可以在 `Extensions → Installed` 的详情中查看依赖、状态、停止、禁用和诊断；禁用或卸载 App 必须停止全部 Component。
- headless 不等于更高权限。Wasm、网络和原生伴随程序仍分别经过 SDK、Network Broker 与渠道门禁。

当 headless Component 使用 `app-enabled` 或 `system-event` 时，还必须在该 `runtime.components[]` 项内声明最小后台策略：

```json
{
  "backgroundPolicy": {
    "triggers": ["app-enabled@1"],
    "stop": ["app-disabled@1", "host-exit@1"],
    "resourceClass": "background-standard@1",
    "restartLimit": 3
  }
}
```

`triggers` 和 `stop` 只能使用 Host 注册的版本化事件，`stop` 不能省略；`resourceClass` 由 Host 定义 CPU、内存与后台时长上限；`restartLimit` 是该资源策略规定的故障窗口内最大自动重启次数。`on-demand` Component 不需要 `backgroundPolicy`，调用结束后由 Host 按协议回收。

### 5.3 `requires.hardwareServices[]`：硬件按服务接入

App 对硬件的依赖必须写在 `requires.hardwareServices`，每项字段固定为：

```json
{
  "id": "com.reai.hardware.board01",
  "sdkApi": ">=1.0.0 <2.0.0",
  "capabilities": ["controls.events@1", "audio.input@1"],
  "purpose": "使用 AI Board 01 的语音键与音频输入",
  "grantDuration": "while_enabled",
  "optional": true,
  "requiredFor": [
    "command:voice-capture-board01",
    "binding:board01-media-key"
  ]
}
```

字段语义：

| 字段 | 规则 |
|---|---|
| `id` | 稳定 Hardware Service ID；每种硬件类型独立，不能使用笼统的 `keyboard` 或 `device` |
| `sdkApi` | App 兼容的 Provider SDK SemVer 区间；不能依赖实现版本或仓库路径 |
| `capabilities` | 版本化硬件能力 ID；Host 只发放这里声明且当前 Provider 支持的能力 |
| `purpose` | 安装与授权前展示给用户的必填用途说明 |
| `grantDuration` | `once / session / while_enabled / until_revoked`；用户可撤销，Host 不得静默延长 |
| `optional` | `true` 表示没有该硬件时 App 主体仍可用；普通 App 应默认为 `true` |
| `requiredFor` | 仅列出硬件专属 Contribution 引用，统一使用 `kind:id`，如 `binding:board01-new-task`；不得写 `app:start` 或普通主界面 |

Host Provider 必须负责设备发现、权限、热插拔、驱动状态、读写串行化和错误归一；App 只获得版本化 SDK 对象与事件。Provider 自己的驱动、系统权限或固件依赖仍需声明为 Provider 作用域的 Requirement，不能上浮到所有 App。

如果 `optional: false`，该 App 必须本质上就是硬件专用 App，并在安装前显著披露；即使如此，硬件缺失也只能阻断该 App，不能阻断 Host。一个 App 可以声明多个 Hardware Service，每个服务独立解析和降级。

### 5.4 完整声明示例

Host 和每个 App 必须提供可静态审核的 Component、Hardware Service 和 Requirement 声明。v1.1 逻辑结构如下：

```json
{
  "appId": "reai.agent-shell",
  "requires": {
    "hostCapabilities": ["surface.main@1", "commands@1", "hardware.service@1"],
    "hardwareServices": [
      {
        "id": "com.reai.hardware.board01",
        "sdkApi": ">=1.0.0 <2.0.0",
        "capabilities": ["controls.binding@1"],
        "purpose": "允许用户为 AI Board 01 配置 Agent 快捷键",
        "grantDuration": "while_enabled",
        "optional": true,
        "requiredFor": ["binding:board01-new-task"]
      }
    ]
  },
  "runtime": {
    "components": [
      {
        "id": "main-ui",
        "kind": "web-surface",
        "protocol": "web-surface@1",
        "required": true,
        "entry": "dist/app.js",
        "headless": false,
        "activation": "on-demand",
        "lifecycle": { "activate": "default.activate", "deactivate": "default.deactivate" }
      },
      {
        "id": "local-agent",
        "kind": "wasm-component",
        "protocol": "wasm-component@1",
        "required": false,
        "entry": "runtime/local-agent.wasm",
        "headless": true,
        "activation": "on-demand",
        "lifecycle": { "activate": "exports.activate", "deactivate": "exports.deactivate" }
      },
      {
        "id": "publisher-agent",
        "kind": "remote-service",
        "protocol": "remote-service@1",
        "required": false,
        "serviceRef": "network:endpoint.agent-api",
        "headless": true,
        "activation": "on-demand"
      }
    ]
  },
  "contributes": {
    "surfaces": [
      { "id": "main", "componentId": "main-ui" }
    ],
    "commands": [
      { "id": "ask-local", "componentId": "local-agent" },
      { "id": "ask-remote", "componentId": "publisher-agent" }
    ]
  },
  "requirementsVersion": "1.1",
  "requirements": [
    {
      "id": "tool.codex-cli",
      "displayName": "Codex CLI",
      "kind": "optional_external_tool",
      "componentId": "local-agent",
      "required": false,
      "requiredFor": ["command:ask-local"],
      "platforms": ["macos", "windows"],
      "channels": ["direct"],
      "version": { "constraint": ">=0.1.0" },
      "probe": {
        "type": "command_version",
        "target": "codex",
        "args": ["--version"],
        "timeoutMs": 3000,
        "sideEffectFree": true
      },
      "provision": {
        "mode": "user_initiated",
        "source": "publisher",
        "requiresConsent": true
      },
      "failure": {
        "componentState": "degraded",
        "featureState": "blocked",
        "hostState": "satisfied",
        "fallbackComponentId": "publisher-agent"
      },
      "remediation": {
        "action": "open_dependency_setup",
        "label": "安装或连接 Codex",
        "restartRequired": false
      }
    }
  ]
}
```

这个例子中，Codex 缺失只阻断 `command:ask-local`；`main-ui` 与 `command:ask-remote` 继续工作。AI Board 01 未连接只移除或禁用 `binding:board01-new-task`，不影响 Agent 对话。

### 5.5 `requirements` 必填字段

本合同独立成文件时，`owner.scope` 与 `owner.id` 必填。嵌入已包含稳定 `appId` 的 App Manifest 时，所有者继承 `appId`，不得再写第二份可能漂移的 owner。

| 字段 | 约束 |
|---|---|
| `requirementsVersion` | 完整目标合同示例使用 `1.1`；当前 Driver 受管可执行子集固定为 `1.2`，非空数组不得省略 |
| `owner.scope` / `owner.id` | 仅独立合同时必填；嵌入 Manifest 时继承 `app` / `appId` |
| `requirements[].id` | 所有者内稳定依赖 ID；升级时不得改变同一 ID 的含义 |
| `displayName` | 面向用户的名称，不得只写包名 |
| `kind` | 本文定义的分类之一；当前 Driver 1.2 机器合同只开放 `managed_executable` |
| `componentId` | App Requirement 必填；必须引用 `runtime.components[].id`。仅 Host 自身启动依赖可以省略 |
| `required` | 是否阻断**所有者启动**；App Requirement 原则上为 `false`，组件是否阻断由 `failure.componentState` 决定 |
| `requiredFor` | 受影响的 Contribution 引用；统一使用 `kind:id`（如 `command:ask-local`），必须精确，禁止写“整个 App” |
| `platforms` | `macos`、`windows`；未来增加平台时扩展 |
| `channels` | `mac_app_store`、`microsoft_store` 或 `direct`；与 `platforms` 组合使用 |
| `probe` | 无副作用探测方式；无法自动探测时明确为 `manual` |
| `provision` | 谁安装、从哪里获得、是否需要用户同意 |
| `failure` | Requirement → Component → Feature → Host 的状态和 fallback |
| `remediation` | 用户可理解且可执行的修复动作 |

按需字段：

- `version.constraint`：支持范围，不接受只写“最新版”。
- `phase`：`runtime` 或 `provisioning`；例如 npm 只用于安装某个 CLI 时必须标为 `provisioning`。
- `integrity.sha256`、`integrity.signaturePublisher`：下载内容和可执行文件的校验约束。
- `disk.minimumBytes`：下载模型或工具前的空间要求。
- `permissions`：关联的系统权限 ID。
- `conflicts`：已知不兼容依赖或版本。
- `notes`：仅用于解释，不得替代结构化字段。

#### Driver `requirementsVersion: "1.2"` 受管可执行子集

当前可运行子集只接受 `kind: "managed_executable"`、`probe.type: "host_registered"` 和
`provision.mode: "host_managed_resource"`。`resourceId` 是插件能声明的唯一远程解析键；URL、归档大小、
SHA-256、发布者、允许的平台签名者和撤回状态全部来自 Host 已验签目录。`installPolicy` 只有：

- `required_at_install`：资源安装、校验和探针失败时，`.reaiapp` 不提交；
- `optional_on_demand`：插件可保持 degraded，用户之后通过 `install_managed_resource` 修复事务补装。

字段、引用和正反样例以 Manifest Schema、Host/CLI validator 与
`managed-requirements-v1.2.json`（`@reai/app-contract` 包内 `managed-requirements-v1.2.json`） 为准。

### 5.6 组件级依赖与功能级 `requiredFor`

依赖状态按以下顺序聚合，禁止跨层扩大影响：

```text
Requirement
  → componentId 对应的 Component
  → requiredFor 列出的 Feature / Contribution
  → App 汇总状态
  → Host 始终独立
```

- `componentId` 回答“哪段运行代码需要它”。
- `requiredFor` 回答“用户看到的哪些能力受影响”。
- 一个 Component 可以有多个 Requirement；一个 Requirement 也可以只影响该 Component 的部分功能。
- Contribution 引用 Component，但不因此自动继承该 Component 的全部依赖；Host 以 `requiredFor` 计算具体可用性。
- Component `blocked` 时，只阻断引用它的 Contribution；有 fallback Component 时改为 `degraded`。

### 5.7 运行时解析结果

静态声明与运行时状态必须分开保存。Requirement 和 Component 都要有可诊断结果：

```json
{
  "componentId": "local-agent",
  "state": "degraded",
  "requirements": [
    {
      "requirementId": "tool.codex-cli",
      "state": "needs_action",
      "detectedVersion": null,
      "checkedAt": "2026-08-01T08:00:00Z",
      "detailCode": "executable_not_found",
      "remediationAvailable": true
    }
  ],
  "availableFeatures": [],
  "blockedFeatures": ["command:ask-local"],
  "fallbackComponentId": "publisher-agent"
}
```

允许的 Requirement、Hardware Service、Component 与功能状态统一为：

> 下面是依赖解析结果，不是 App 的单一总体 `status`。Host 必须把结果映射到六维 Local State：例如缺少必需工具 → `dependencies=missing_required`，存在 fallback → `dependencies=missing_optional` 且 `health=degraded`。

| `state` | 含义 |
|---|---|
| `satisfied` | 版本、权限、连接和完整性均符合要求 |
| `needs_action` | 用户需要授权、安装、下载、升级、连接硬件或重试 |
| `degraded` | 存在可用降级或 fallback 路径 |
| `blocked` | 声明中的具体 Component 或功能不可用 |
| `unsupported` | 当前平台、架构或渠道不支持 |

具体原因放入稳定 `detailCode`，例如 `not_checked`、`checking`、`permission_required`、`hardware_disconnected`、`provider_version_mismatch`、`executable_not_found`、`download_required`、`version_too_old`、`temporarily_unavailable`、`crash_loop` 或 `probe_error`。不得为了表达过程无限扩展顶层 `state`。

### 5.8 Runtime Component 与 App Service / Agent Scene 的关系

Runtime Component 回答“哪段代码在哪里运行、怎样启动和降级”；App Service / Agent Scene 回答
“插件对外提供什么能力、哪条 Agent 流程何时使用”。同一个 Service 可以由一个 headless Component
实现，也可以委托 Host 原生 Provider；一个 Component 也可以实现多个 Service。

目标合同见[插件服务与 Agent / DSH 扩展规范](./agent-service-extension-v1.md)。Service 依赖必须按
capability/service ID 声明，再由 Host 解析到满足版本、平台、健康和授权要求的 Provider Component；
调用方不能为了拿能力而硬编码另一个 App 的进程路径。Agent Scene 的 preprocess / agent-tool /
postprocess 依赖只影响对应阶段，不把整个 App 的全部 Runtime Requirement 自动挂进模型工具目录。

当前支持矩阵仍限单一 `web-surface`，也没有 Service Registry、跨 App 类型化 RPC 或 headless
Supervisor。本文的复合 Component 与 headless 合同和上述 Agent 扩展一样，都属于目标设计。

## 6. 探测、修复与降级流程

```text
读取静态声明
  → 匹配 platform + channel
  → 解析 runtime.components + hardwareServices + requirements
  → 对每个 Provider / Requirement 做无副作用 probe
  → 逐 Component 汇总状态
  → satisfied：开放该 Component 引用的功能
  → needs_action + permission_required：解释用途后跳系统设置
  → needs_action + executable_not_found / version_too_old：展示经审核的修复入口
  → needs_action + download_required：显示大小、来源、校验与进度
  → degraded / blocked：提供重试或替代路径
  → 只刷新受影响 Component 和 requiredFor 功能，不重启整个 Host
```

探测约束：

- 命令探测默认超时 3 秒，必须捕获 stdout、stderr 和退出码，不得进入交互模式。
- 文件探测必须校验规范路径、版本、签名或哈希；不得扫描整个磁盘。
- 权限探测使用系统 API，不以“调用失败一次”替代权限状态。
- 远程服务探测不得在 App 启动关键路径反复请求；离线时使用明确的离线状态。
- 硬件探测必须支持热插拔，并区分“未连接”“权限不足”“驱动异常”。
- Provider 探测必须先验证 `id + sdkApi`，再探测设备；“Provider 未安装”和“设备未连接”是两种不同原因。
- headless Component 的健康探测必须有超时、心跳或进程退出依据，不得以“后台进程还在”代替功能可用。

修复约束：

- 所有安装与下载动作由 Host 统一编排和记录，插件不得自行弹出隐藏安装器。
- 用户必须在执行前看到发布者、来源、版本、体积、权限和卸载方法。
- 下载内容先写临时目录，完整校验后再原子替换。
- 修复动作不得要求管理员权限，除非依赖本身确实需要并经过单独审核。
- 取消、失败和断点恢复必须有定义；失败不得污染已有可用版本。

## 7. 平台与渠道 Profile

| Profile | 系统运行时 | 可选依赖的交付原则 | v1.1 约束 |
|---|---|---|---|
| `macos + mac_app_store` | 系统 WebKit/WKWebView；TCC 用户授权 | 可执行能力随审核包；用户主要执行启用/授权 | 不依赖 Homebrew/npm；新增可执行插件遵循主程序升级审核 |
| `macos + direct` | 系统 WebKit/WKWebView；TCC 用户授权 | 可使用 ReAI 签名下载器和用户触发的外部工具安装 | 所有可执行物必须签名/校验；插件依赖不能阻断 Host |
| `windows + microsoft_store` | WebView2 由包或商店认可机制处理 | 遵守 Store 扩展、驱动和服务规则 | 商店包不得假设系统预装开发环境 |
| `windows + direct` | ReAI 安装器管理 WebView2 | 可以用户触发安装外部工具 | 离线安装包必须明确 WebView2 策略；当前在线 bootstrapper 不满足离线场景 |

同一依赖可以在不同 Profile 中采用不同 `provision.mode`。例如，商店版把一项能力随包交付，官网版可以在签名校验后按需下载；不得为了复用实现而绕过渠道边界。

物理交付方式可以不同，逻辑分层不得漂移：Store 随审核包携带的可执行资源仍由 Host 的统一资源
权威解析和治理，业务模块不得重新硬编码 App Bundle 路径；`direct` 按需下载也不能扩大插件声明或
绕过用户同意。当前基础 App 已移除 Codex/Pi/DSH；Direct 依赖由统一受管资源权威解析，Store Profile
仍须按各自审核政策决定物理交付方式。

v1.1 高权限能力矩阵：

| 能力 | `mac_app_store` | `microsoft_store` | `direct` |
|---|---:|---:|---:|
| Terminal / PTY / 系统 Shell | 编译关闭 | 编译关闭 | 可用，Host 托管 |
| Agent `local_cli` | 编译关闭 | 编译关闭 | 可用，外部工具为可选依赖 |
| Agent `remote_api` | 可用 | 可用 | 可用 |
| Chrome Native Messaging | 编译关闭 | 编译关闭 | 可用，浏览器/扩展/native host 分别探测 |

Store 版是否把官方 App 显示在 Catalog，与是否向该 App 授予高权限 Host Capability 是两件事。被 Profile 禁止的能力必须在构建产物中关闭，不能只隐藏界面入口。

随 App 交付或由 App 调用的运行形态必须进入 `runtime.components[]`：`web-surface`、`wasm-component`、`remote-service` 或 `native-companion`。Host API 另由 `requires.hostCapabilities` 声明。用户自行安装、独立运行的 Codex 等 `optional_external_tool` 不是 App 的 `native-companion`，不得这样标注。

## 8. 打包与发布 Gates

每个平台、每个渠道都必须单独通过以下 Gate：

| Gate | 必须证明的结果 |
|---|---|
| G1 声明完整性 | Component、Contribution 引用、Provider、外部进程、权限、网络内容和依赖全部入表且可静态解析 |
| G2 干净系统启动 | 无 Node/Python/ffmpeg/CLI/Chrome/硬件/网络时，Host 可启动、设置可访问、可卸载 |
| G3 Bundled 完整性 | bundled 库和资源实际进入产物；签名、公证、哈希与架构正确 |
| G4 安装器先决条件 | WebView 等安装器管理项可以安装、探测、修复；离线行为有测试结论 |
| G5 降级隔离 | 从干净环境删除每个可选依赖或停止单个 Component 后，只影响其 `componentId + requiredFor` 功能；Host、插件管理、修复和卸载入口继续可用 |
| G6 权限路径 | 拒绝、稍后授权、撤销授权、再次授权均有真实系统验证 |
| G7 下载内容 | 非执行内容与目标受管可执行资源分别验证大小/摘要/签名、取消、断网、磁盘不足、损坏回滚；半下载内容不得执行或污染已有可用版本 |
| G8 渠道一致性 | Store 与 direct 的 Profile、目录、签名、更新源互不串用 |
| G9 升级与卸载 | 升级保留兼容数据；卸载或插件移除不会留下运行进程和失效自启动项 |
| G10 Hardware Provider | 每个 `hardwareServices` 的 API 兼容、未安装、未连接、热插拔和多设备状态均通过合同测试 |
| G11 Headless 生命周期 | 后台启用、资源预算、崩溃退避、停止、禁用、升级和卸载均可由 Host Supervisor 收敛 |

发布检查应至少包含四台干净环境：当前最低 macOS、当前 macOS、受支持的 Windows 最低版本、当前 Windows；每个环境各覆盖在线与离线启动。

## 9. 当前代码依赖矩阵（2026-08-01 只读核对）

下表描述“现在已经怎么做”，不把设计意图当成已实现能力。

| 能力/依赖 | 分类 | 当前事实 | 缺失时行为 | v1.1 判定 |
|---|---|---|---|---|
| Bun、Rust、Cargo、编译器 | `build_time` | 用于前端和 Tauri 构建 | 不应出现在用户电脑 | 合规；继续与运行时清单隔离 |
| SQLite | `bundled` | `rusqlite` 启用 `bundled` feature | 不依赖系统 SQLite | 合规 |
| Tauri 前端运行时（macOS） | `os_capability` | 使用系统 WebKit/WKWebView；最低系统配置为 macOS 14.0（2026-09-26 拍板，仅支持 Apple Silicon M1+；按账户持久隔离的 WebView 存储要 14，托管 Chromium 要 13） | 系统不支持则 Host 无法渲染 | 打包时验证最低系统真机 |
| Tauri 前端运行时（Windows） | `installer_managed` | `webviewInstallMode` 当前为 `downloadBootstrapper` | 无 WebView2 且离线时安装存在风险 | **发布缺口：补离线/Store Profile 与验收** |
| 内置终端 PTY | `bundled` | Rust `portable-pty` 编译进当前程序 | 库缺失即打包错误 | 官网 Profile 使用；两个 Store Profile 的 v1.1 构建关闭入口与 Capability |
| 终端 Shell | `os_capability` | macOS 读取合法 `$SHELL`，兜底 `/bin/zsh`；Windows 使用系统 PowerShell | 只阻断 Terminal | 仅 `direct`；打包测试系统 Shell 路径 |
| sherpa-onnx 本地 STT | `bundled` | 正式完整包以 `sherpa` feature 编译 | 仅语音识别不可用 | 合规；需产物架构验证 |
| Silero VAD | `bundled` | `silero_vad.onnx` 随 assets 打包，首次启动复制到数据目录 | VAD 降级，STT 可继续整段识别 | 合规 |
| 默认 SenseVoice STT 模型 | `downloaded_content` | 启动后后台下载；声明大小与 SHA-256 | 本地 STT 暂不可用 | 已有校验；需纳入统一依赖状态 |
| 标点模型 | `downloaded_content` | CDN/GitHub fallback，固定大小与 SHA-256 | 识别可用、标点能力降级 | 已有校验；需纳入统一依赖状态 |
| ffmpeg | 不再是依赖 | BLE mSBC 已由纯 Rust 解码替代；前端只剩注释掉的旧状态代码 | 无影响 | 明确禁止重新上浮为主程序依赖 |
| Python | 不存在运行依赖 | 当前桌面运行路径未调用 Python | 无影响 | 合规 |
| AppleScript / `osascript` | `os_capability` | macOS Provider 当前用固定 AppleScript 关闭 Keyboard Setup Assistant；Action schema 预留 `appleScript` 类型，但当前核心模块未执行任意用户脚本 | 缺失只影响对应 macOS 辅助动作 | 纳入精确权限/目标声明；不得扩展为插件任意脚本后门 |
| macOS 输入监听 | `os_capability` | TCC 权限，有独立检查/请求 | HID/相关输入监听功能受限 | 应映射 `permission_required` |
| macOS 辅助功能 | `os_capability` | TCC 权限，用于文字注入 | 文字注入受限 | 应映射 `permission_required` |
| macOS 麦克风 | `os_capability` | AVFoundation 权限检查/请求 | 录音受限 | 应映射 `permission_required` |
| Claude Code CLI | `optional_external_tool` | `claude --version` 探测；官方脚本优先，npm 镜像 fallback | Claude 本地适配器不可用，Host/Terminal 可用 | 依赖必须归 Agent Shell 的 Claude adapter |
| Codex CLI | `optional_external_tool` | `codex --version` 探测；当前安装脚本走 npm | Codex 本地适配器不可用 | **Node/npm 仅是当前安装路径，不是 Host 依赖** |
| Kimi CLI | `optional_external_tool` | `kimi --version` 探测；当前使用发布方安装脚本 | Kimi 本地适配器不可用 | 归 Kimi adapter；不得静默安装 |
| 旧 Claude mode hook | `optional_external_tool` 的附属能力 | JSON 解析依赖 `node`，失败后 fallback 到 `jq` | 两者都缺少时模式校正静默失效 | **技术债：改为无 Node/jq 的宿主 relay 或随包解析器** |
| Chrome + ReAI 扩展 | `optional_external_tool` | Chrome、扩展、Native Messaging 三者共同组成网页适配器；Host 只修复已安装 manifest | 网页适配器不可用 | 仅 `direct`；必须是可选能力，不得阻断 Agent Shell 或 Host |
| OAuth、客户端配置、OTA、模型/CDN | `remote_service` | 网络请求由 Rust Host 发起；有缓存或 fallback 的路径 | 启动应继续，在线功能降级 | 结合网络策略声明域名、用途和离线行为 |
| AI Board 01 / USB / BLE | `hardware` | 当前逻辑直接位于 Host 的 HID、Audio、platform 等模块，使用 hidapi 与系统栈；尚无公开 Hardware Service SDK/Provider 注册表 | AI Board 01 专属能力不可用 | AI Board 01 作为首个 `com.reai.hardware.board01` Provider 迁移；当前目录不是未来 SDK 合同 |
| 麦克风与音频输入设备 | `hardware` | 当前由 cpal 与 AudioSession 处理，既可来自 AI Board 01 也可能来自其他系统音频设备 | 录音/语音输入不可用，其他功能继续 | 音频输入服务与 AI Board 01 Provider 分层；不得把“录音”永久等同于“连接 AI Board 01” |

### 9.1 当前明确不存在的主程序依赖

- Node.js：不是 Host 运行依赖；仅出现在部分外部 CLI 安装和旧 hook 中。
- Python：不是 Host 运行依赖。
- ffmpeg：已经被纯 Rust mSBC 解码替代。
- Claude/Codex/Kimi：均为 Agent 本地适配器的可选外部工具。
- Chrome：仅网页适配器需要。
- AI Board 01：不连接硬件时 Host 仍应可以进入设置、App 管理和依赖诊断；非 AI Board 01 功能不得被锁死。

### 9.2 当前需要进入开发计划的缺口

1. 尚无统一、可执行的 `runtime.components[]`、Hardware Service 与 `requirements` 解析器。
2. Windows 当前 WebView2 使用在线 bootstrapper，离线首次安装需要补正式策略和测试。
3. 旧 Claude mode hook 仍依赖 `node` 或 `jq`，会产生静默降级。
4. Claude/Codex/Kimi 安装脚本已有探测和可见 PTY，但依赖来源、版本、授权和状态尚未统一进本规范。
5. 当前各模块分别上报状态，尚未形成一个面向用户的“依赖中心”。
6. 当前 AI Board 01 能力仍是 Host 内部实现，尚未形成独立、版本化的 SDK/Provider 合同。
7. 尚无 Component Supervisor 与 headless 生命周期、资源预算和逐组件健康汇总。
8. 尚无 App Service Registry、跨 App 类型化调用、Agent Scene 解析或 capability → Provider 动态绑定。

## 10. Terminal 与 Agent Shell 的依赖归属

### Terminal

- `portable-pty` 属于 Host 的 bundled 能力。
- 系统 Shell 属于 Terminal 的 `os_capability`。
- Terminal 本身不得依赖 Node、Python、Claude、Codex 或 Kimi。
- 用户选择执行任何命令是 Terminal 行为，不代表 Host 对该命令的依赖负责。
- v1.1 仅 `direct` Profile 提供 Terminal；两个 Store Profile 在编译期关闭 PTY 与 Shell Capability。
- Terminal App 至少有 `terminal-ui: web-surface`；PTY 仍是 Host Capability，不因当前 Rust 文件位置变成 App SDK。

### Agent Shell

- Agent Shell 是统一 UI 和适配器容器。
- Agent Shell 可组合 `main-ui: web-surface`、本地协调 `wasm-component`、云端 `remote-service`；每个 Contribution 引用实际 `componentId`。
- `local-cli` adapter 可以声明 Claude/Codex/Kimi 等 `optional_external_tool`。
- `remote-api` adapter 声明 `remote_service`，不应因本地 CLI 缺失而关闭。
- `web` adapter 可以声明 Chrome 扩展或隔离 Web Surface，二者状态独立。
- 任一 adapter 失败只影响该 adapter；Agent Shell 仍应允许切换其他连接方式。
- v1.1 的 `local-cli` 和 Chrome Native Messaging 仅属于 `direct`；Store 版 Agent Shell 使用 `remote-service` 或不依赖 Native Messaging 的隔离 Web Surface。

### Hardware Provider

- `com.reai.hardware.board01` 是首个 Hardware Service，不是 Terminal 或 Agent Shell 的默认启动依赖。
- 硬件按键、音频或设备状态通过版本化 SDK Bridge 暴露；App 不依赖 `core/hid`、`platform/*` 等内部模块名称。
- 后续其他键盘、麦克风或设备各自注册 Provider；一个 Provider 故障不得影响另一个 Provider。
- App 通过 `requires.hardwareServices[].requiredFor` 选择性获得硬件增强，普通 UI、远程 Agent 和非硬件 Command 继续工作。

## 11. 验收标准

v1.1 依赖体系在满足以下条件后视为落地：

- 任一 App/插件安装前都能静态列出其依赖、权限、体积和在线服务。
- 干净系统测试能证明 Host 不依赖 Node、Python、ffmpeg 和外部 CLI。
- UI 能区分未安装、未授权、需下载、版本过旧、暂时离线和不支持。
- 每个状态都有稳定错误码、影响范围和修复动作。
- Manifest 能组合四种 Runtime Component，且所有 Contribution 的 `componentId` 引用通过静态校验。
- UI Component、headless Component 和 Hardware Provider 都能独立上报健康、停止和降级。
- AI Board 01 通过独立 SDK/Host Provider 被 App 使用；没有 AI Board 01 时普通功能仍可用，并能并列接入第二种硬件 Provider。
- Store 与 direct 构建使用独立 Profile 并通过各自 Gate。
- Store 构建的产物级测试证明 Terminal、`local_cli` 和 Chrome Native Messaging Capability 不存在，而不只是 UI 隐藏。
- 删除、撤销或断开任一可选依赖，只降级其 `componentId + requiredFor` 声明的功能。
- 发布产物中的实际文件、进程调用和权限与机器可读声明完全一致。
- 开发者能在打包前列出每项产物属于 Host、`.reaiapp`、受管资源、非执行内容还是用户数据，并证明
  卸载其中一层不会误删其他层。

## 12. 当前证据索引

- `CLAUDE.md`：项目架构、正式构建 feature、macOS 权限、Tool Adapter 与浏览器适配器边界。
- `src-tauri/Cargo.toml`：`portable-pty`、`rusqlite bundled`、可选 `sherpa-onnx` 与平台依赖。
- `src-tauri/tauri.conf.json`：assets 资源、macOS 最低版本、Windows `downloadBootstrapper`。
- `src-tauri/src/commands/terminal.rs`：系统 Shell 与 PTY 启动路径。
- `src-tauri/src/core/config/mod.rs`：Claude/Codex/Kimi 的 probe 与安装脚本。
- `integrations/claude-code/app-generated/hooks/*.sh`：旧 hook 的 Node → jq fallback。
- `src-tauri/src/core/audio/msbc.rs`：纯 Rust mSBC，确认 ffmpeg 已退出运行路径。
- `src-tauri/src/core/env/vad.rs`、`src-tauri/src/core/env/punct.rs`、`src-tauri/src/core/stt/downloader.rs`：模型交付与校验。
- `src-tauri/src/commands/permissions.rs`：macOS TCC 权限探测与请求。
- `src-tauri/src/core/browser_adapter/install.rs`：Chrome Native Messaging 的可选安装与修复边界。
- `src-tauri/src/platform/macos/mod.rs`、`src-tauri/src/core/action_menu/mod.rs`：当前 AppleScript 系统调用与尚未形成执行通道的 Action schema。

以上路径只证明 2026-08-01 的当前实现，不构成公开 SDK。v1.1 的 App 与 Hardware Provider 必须依赖版本化合同，不能依赖这些目录继续存在。

## Driver 当前公共程序存储（2026-09-26）

Driver 新安装的官方 DSH / Pi / Codex 与官方插件原始程序按签名摘要存到基础数据根的
`shared-programs/`，同一系统用户的多个 ReAI 账号复用文件。账号安装状态、引用、
版本选择、授权、会话与工作区仍私有。不同系统用户不共享；开发 override 不进入
官方共享区。启动用 Host 公钥校验保留的服务器签名收据，再核对完整程序树。
共享目录不能由单个账号的卸载/GC 删除；版本及空间保留策略见
Driver 内核门禁规范（原 Board 仓库内 `docs/driver-v2-kernel-startup-gate.md`；未迁入）。
