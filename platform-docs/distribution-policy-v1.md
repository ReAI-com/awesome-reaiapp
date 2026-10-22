# ReAI App Platform v1.1：发行、Host 与 Extension 规范

> 状态：**已锁定的产品基线，实现目标**
>
> 适用对象：产品、设计、平台、硬件 SDK、审核、开发、发布与合作方
>
> 基线日期：2026-08-01
>
> 文件名保留 `-v1`，正文版本升级为 v1.1
>
> 配套规范：[运行依赖规范](./runtime-dependencies-v1.md) · [网络与计费规范](./network-billing-policy-v1.md) · [交互版（HTML 快照，可能滞后于本文）](./distribution-policy-v1.html)

> ⚠️ **这是规范，不是首版实现清单。** 首版 Host 只实现其中一个子集（档位 `official-only`：只装官方插件）。
> 每一处有意的偏差、以及开放第三方前必须补齐的安全清单，见 [README.md](./README.md)。
> 机器可读事实源：`platform/contract/host-support-matrix.json`（能力与限额）、`platform/contract/schemas/app-manifest-1.1.schema.json`（结构）。


## 0. 一页结论

v1.1 锁定以下产品规则：

1. **唯一 Host 是运行时规则，不是目录规则。** 一台电脑上的一个 ReAI 平台实例，在同一时刻只能有一个 Host 负责 Extension 的验签、权限、生命周期、状态和硬件路由；不能根据仓库根目录、进程名或当前产品名推断谁永远是 Host。
2. **Host 必须建立在硬件 SDK / Provider 架构上。** Extension 只调用稳定的 Host Capability；Host 通过 Provider Registry 接入硬件 SDK 和具体设备，不把 Driver 内部实现暴露给 Extension。
3. **旧 root App 退役是迁移目标，不是当前完成状态。** Driver 规划为首个基于 SDK 的实现与验证载体，但它不是被永久指定的最终 Host。最终产品整合完成后仍必须遵守“单一运行时 Host”规则。
4. **一个 App 可以是复合运行时。** Manifest 使用 `runtime.components[]`，一个 App 可以同时包含 Web Surface、Wasm、远端服务和受审原生 Companion；Host Capability 单独写在 `requires.hostCapabilities`，不再用单一 `runtime.kind` 描述整个 App。
5. **支持 Headless App。** 没有页面、侧栏入口或窗口的 Extension 也必须可安装、启停、授权、更新和卸载。
6. **Voice 是推荐安装的第一方 Extension，不是不可卸载系统组件。** 卸载 Voice 不得破坏 Host、硬件 Provider 或 Extensions 管理。
7. **状态是六个正交维度。** Host 保存 installation / activation / health / permissions / dependencies / update，用户看到的“可用”“降级”等只是 Host 推导的摘要。
8. **开发者 Manifest 与 Catalog 政策分离。** 开发者声明代码需要什么；ReAI 决定是否审核通过、在哪个渠道可见、如何灰度、何时下架。开发者不能在 Manifest 中自我批准。
9. **产品界面统一使用 `Browse Extensions` 和 `Extensions`。** 前者只负责发现和安装；后者是唯一的本机管理入口，必须提供“已安装”列表，包括 Headless Extension。
10. **开发阶段就必须遵守三层交付边界。** Host 基础能力、`.reaiapp` 与 Host 受管可执行资源分别拥有
    独立职责和生命周期；这是跨渠道的逻辑规则，不是源码目录规则。

### 三条发行通道

| `channel` | Catalog 如何增加成员 | 可执行内容如何交付 | 新 Extension 能否不升级 Host |
|---|---|---|---|
| `mac_app_store` | 随 Host Release 提交审核 | v1.1 默认随已审核 App Bundle 交付，用户按需启用 | **不能** |
| `microsoft_store` | 随 Host Release 提交认证 | 默认随主包；受管扩展包需满足 Microsoft 政策与许可 | **v1.1 不能** |
| `direct` | Direct Distribution 阶段启用 ReAI 签名 Catalog Feed | 签名 Package 可按需下载 | **可以，但必须通过全部门禁** |

这里的“按需启用”和“按需下载可执行代码”不是一回事。Store Profile v1.1 只承诺前者：本次 Host Release 的完整可执行能力先随主程序一起提交审核并进入已审核 Bundle，用户再决定启用哪些 App；模型、媒体、模板等非执行资源可以按需下载。以后若某个商店明确批准可执行 Optional Package，必须另立并升级对应 Profile，不能沿用 v1.1 默认规则。

### 三层交付职责（Direct 一期合同已落地）

| 层 | 负责什么 | 不负责什么 |
|---|---|---|
| App 主体 | Host、商店/安装修复、权限与能力系统、设备能力、基础 UI | 不把单个插件的可选 runtime 变成全局启动条件 |
| `.reaiapp` | 插件 UI、业务编排、权限和依赖声明 | 不承载需要独立下载、升级、回滚或共享的大型可执行闭包 |
| Host 受管资源 | ReAI 审核的不可变平台制品，由 Host 下载或从已审核 Bundle 注册、校验、探针、切换、回滚和引用治理 | 插件不能自报任意 URL、签名、摘要、安装命令或磁盘路径 |

模型、音色、固件、媒体等非执行内容和用户数据继续使用各自合同；它们不因为“也会下载”就与
可执行 runtime 合并生命周期。DSH 的逻辑所有者仍是 Host 共享基础服务，透明度插件只观察和配置；
Codex、Pi、Audio helper 等资源按真实消费关系建立依赖，不能由管理 UI 的安装状态冒充所有权。

三层逻辑在所有 Profile 中保持一致，物理落点由渠道决定：`direct` Host 可按需取得受信制品；
Store v1.1 仍随审核 Bundle 交付，但 Host 必须通过统一资源权威解析，业务模块不得硬编码 Bundle 路径。
基础 Tauri 配置已移除 Codex/Pi/DSH runtime；官方插件用 `requirementsVersion: "1.2"` 声明依赖，
Host 以签名目录、`.reairuntime`、平台签名、注册探针、复合 journal 和引用边治理 Direct 资源。
生产 Catalog 公钥、签名服务、CDN 制品与公证记录属于发布门禁；缺少任一项时 release 构建或安装
fail closed，不能把代码落地等同于线上资源已经发布。Mac App Store / Microsoft Store 仍不得复用
Direct 下载路径绕过商店审核。

---

## 1. 规范语言与事实边界

- **MUST（必须）**：不满足即不符合 v1.1。
- **MUST NOT（禁止）**：任何实现都不得违反。
- **SHOULD（应该）**：默认满足；例外需书面记录理由、风险与负责人。
- **MAY（可以）**：可选能力，不影响 v1.1 合规。

本文描述的是**目标平台基线**。涉及“旧 root App 退役”“Driver 成为首个 SDK 版本”“Direct Feed”“Marketplace”的内容均为规划或阶段门禁，不表示当前仓库已经实现。代码、安装包和真实发布状态仍需分别核验。

本文把用户安装和使用的功能统一称为 **App**；**Extension** 只强调这个 App 是由 Host 安装、启停和治理的扩展单元。两者不是两套对象，稳定身份都使用 `appId`。产品界面的 `Browse Extensions` / `Extensions` 是管理入口名称。

外部商店政策高于本文。政策变化时，发布负责人 **MUST** 先阻断受影响发布，再升级对应 Profile。

## 2. 单一 Host 与硬件 SDK / Provider

### 2.1 “唯一 Host”到底指什么

在一个本地平台实例内，Host 是唯一拥有以下职责的运行时权威：

- 验证 Catalog、Source Manifest、Release Envelope 与 Package；
- 管理 Extension 安装、启用、更新、回滚和卸载；
- 请求、撤销与审计权限；
- 启停 Wasm、Native Companion 与 Headless 组件；
- 保存六维 Local State 并推导用户摘要；
- 注册 Hardware Provider，并将 Extension Capability 调用路由到 Provider；
- 执行网络、依赖和计费 Broker 门禁。

因此：

- 唯一 Host **MUST** 是运行时互斥与所有权规则，不得写死为某个仓库目录。
- UI Shell、Driver UI、Extension 页面或 Companion **MUST NOT** 各自创建第二套 Extension Registry、权限库或进程监督器。
- 若产品迁移期间存在多个可执行程序，它们 **MUST** 通过单一 Host ownership 协议选出唯一所有者；非所有者只能作为客户端或退出。
- “一个 Host”不等于“一个进程”。受 Host 监督的隔离进程可以存在，但不能成为独立治理中心。

### 2.2 目标迁移关系

- 旧 root App **计划在能力迁移、用户数据迁移和发布切换完成后退役**；在完成验收前不得写成“已经退役”。
- Driver **规划为首个基于硬件 SDK 的版本和架构验证载体**，用于证明 Provider、Capability 和 Extension 生命周期；它不因此自动成为永久最终 Host。
- 最终 Host 由产品整合与发行决策确定。无论最终二进制叫什么、位于哪个目录，都 **MUST** 继承本规范的唯一治理职责。

### 2.3 SDK / Provider 路由

```text
Extension
  → Host Capability API
  → Capability / Permission Gate
  → Hardware Provider Registry
  → Stable Hardware SDK
  → USB / BLE / Future Device
```

- Hardware SDK **MUST** 提供稳定、版本化、与 UI 无关的设备合同。
- 每种硬件或传输实现 **SHOULD** 作为 Provider 注册，而不是让 Extension 直接依赖 Driver 模块。
- Provider **MUST** 声明 `providerId`、协议版本、设备类别、能力、健康状态和可用性。
- Host **MUST** 处理多个 Provider / 设备的发现与选择；Extension 只请求 Capability，不持有底层设备句柄。
- Provider 缺失或故障 **MUST** 映射到 `dependencies` / `health` 维度，不能让 Extension 自行伪造“已连接”。

## 3. 平台对象与所有权

实现 **MUST** 将以下对象分开；任何对象不得兼任其他对象的事实源。

### 3.1 Catalog Entry：用户能发现什么

Catalog Entry 是 ReAI 签名后的发布记录，包含：Extension ID、名称、发布者、版本、摘要、图标、评分、价格、截图/视频、分类、本地化、隐私说明、支持入口、更新日志、系统要求、支持平台，以及对应 target 的 Release Envelope / Package 引用。开发者可以提交其中部分字段的草稿，但只有审核后的 Catalog Entry 是用户界面的事实源；评分、有效价格和渠道状态不得由 Package 自报。

- `channel` **MUST** 是 `mac_app_store`、`microsoft_store`、`direct` 之一。
- 商店渠道的 Catalog 成员集合 **MUST** 锁定到对应 Host Release。
- Direct Catalog **MAY** 从 ReAI 签名 Feed 获取，但必须保留 last-known-good。
- Catalog **MUST NOT** 直接承载可执行脚本或充当远程配置后门。
- 系统要求 **SHOULD** 从 Manifest 的平台、权限、Provider 与 Dependencies 生成并经审核确认，不能只依赖营销文案。

### 3.2 Catalog Policy：平台决定是否允许

Catalog Policy 由 ReAI 审核与运营系统所有，至少包含：

- `review.status`、`review.batchId`；
- `channelEligibility[]`；
- `visibility`、`rollout`、区域与年龄限制；
- `delistMode`：停止新安装 / 阻止新启用 / 强制停用；
- 计费模式、外部支付例外、紧急撤回和风险标记。

Catalog Policy **MUST** 与开发者 Manifest 分开存储、签名和授权。开发者 **MUST NOT** 通过上传 Manifest 修改审核状态、渠道资格、灰度比例、付费例外或强制停用策略。

### 3.3 Developer Manifest：开发者声明需要什么

Manifest 至少声明：

- `appId`、`version`、`publisherId`；
- `hostApi.range`（SemVer 范围）；
- `runtime.components[]`；
- UI Contributions（可为空）；
- Capability、权限、运行依赖、Hardware Provider 要求；
- 网络、数据、计费、生命周期、Store Schema 和回滚边界。

开发者维护的 `app.manifest.json` 是 **Source Manifest**：它不得包含 Package 摘要、发布签名、审核状态或 Catalog Policy。Source Manifest **MUST** 与源码、构建输入和 Package 一起审核；远端服务 **MUST NOT** 在安装后静默扩大其中的声明。

### 3.4 Release Envelope：发布系统证明了什么

受控构建完成后，发布系统为每个平台与架构生成独立 `release-envelope.json`：

```json
{
  "envelopeVersion": "1",
  "identity": {
    "appId": "com.example.todo",
    "version": "1.0.0",
    "publisherId": "example"
  },
  "target": { "platform": "macos", "architecture": "aarch64" },
  "manifestDigest": "sha256:...",
  "packageDigest": "sha256:...",
  "buildId": "build-20260801-001",
  "signature": {
    "algorithm": "ed25519",
    "keyId": "reai-release-1",
    "value": "..."
  }
}
```

- `manifestDigest` 对审核后的 Source Manifest 计算；`packageDigest` 对 Package payload 计算，不包含 Envelope 自身，避免摘要自引用。
- 签名覆盖 Envelope 中除 `signature.value` 外的全部字段。
- Catalog Policy 只引用 `appId + version + target + packageDigest`，不把审核权写回 Manifest。
- Host 的固定验证顺序是：Envelope 签名 → Source Manifest 摘要 → Package 摘要 → Catalog Policy；任一步失败都不得解包或执行。

### 3.5 Package：实际执行什么

- Package **MUST** 不可变、内容寻址并由受信发布链签名。
- 相同 `appId + version + platform + architecture` **MUST** 永远解析为相同字节。
- Host **MUST** 在解包或执行前按 Release Envelope 验证签名、摘要、发布者、Source Manifest 与 Catalog Policy。
- Package **MUST NOT** 再下载并执行未进入审核范围的远程代码。

### 3.6 Local State：本机当前事实

Local State 只保存已安装版本、六维状态、用户授权、配置、数据版本、失败原因与回滚指针。

- Local State **MUST NOT** 改写 Manifest 或 Catalog Policy。
- Local State **MUST** 原子写入并支持崩溃恢复。
- 用户停用 Extension 后，Package 可以保留，但所有 Runtime Component **MUST** 失去运行资格。

### 3.7 安装授权与升级不得看包两次

- Host **MUST** 在预览前把来源 Package 复制到 Host 私有、不可由插件改写的暂存区，并记录
  `installAttemptId + packageDigest + manifestDigest + expiry`。授权提交只接受一次性
  `installAttemptId` 和逐项决定，**MUST NOT** 再接受原路径、重新打开来源文件或重新解析另一份包。
- 每个新增或扩大的权限/网络端点决定都绑定其规范化声明摘要；缺项、重复项、过期、重放或摘要
  不一致一律 fail closed。取消和失败必须清理暂存物。
- A1 → A2 时，权限 id、用途、required 语义及 Host 合同均未扩大才可继承。A2 删除的 A1 项
  立即撤销并留下墓碑；以后同名重新出现按新增处理。网络只允许来源、方法、路径和语义的安全
  子集继承，扩大范围必须重新授权，等待期间旧交集仍可用、新范围不可用。
- Developer Mode 只允许选择本地包，不是权限、网络或发布审核旁路。本地包没有受信发布者连续性
  时，Package 字节变化必须全量重新授权。
- `required=true` 表示拒绝后功能不可用，不得剥夺用户的拒绝按钮；拒绝后允许安装，但 Extension
  必须保持停用并给出修复入口。

任何二维码、深链、日志、截图或分享载荷若包含长期 API token，或其产品说明与真实行为不一致，
审核 **MUST** 阻断发布。开发者本地阶段可以调试，但不得进入正式 Builtin 清单、Catalog 或已发布
`.app`；“能在 Developer Mode 运行”不构成发布资格。

## 4. 复合运行时 `runtime.components[]`

一个 Extension 可以由零个或多个 UI Contribution 与一个或多个 Runtime Component 组成。整个 App 不再只有一个 `runtime.kind`。

```json
{
  "runtime": {
    "components": [
      {
        "id": "agent.workspace",
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
      },
      {
        "id": "agent.cloud",
        "kind": "remote-service",
        "protocol": "remote-service@1",
        "required": false,
        "headless": true,
        "activation": "on-demand",
        "serviceRef": "network:endpoint.agent-primary"
      }
    ]
  },
  "requires": {
    "hostCapabilities": ["terminal.session@1"]
  }
}
```

`kind` 只允许：

| kind | 含义 | v1.1 边界 |
|---|---|---|
| `web-surface` | Host 隔离呈现的界面 Surface | 不直接获得原生 API；通过显式 Host Capability 完成功能 |
| `wasm-component` | Host 沙箱内的可移植组件 | 仅获得显式 Capability，资源配额和停止超时必须可控 |
| `remote-service` | 发布者或用户选择的云端服务 | 本地不执行远端响应；遵守网络、密钥与计费规范 |
| `native-companion` | 受 Host 监督的签名原生组件 | 最高审核等级；不得自更新、提权或脱离 Host 常驻 |

每个 Component 的公共必填字段是 `id / kind / protocol / required / headless / activation`。`protocol` 必须是与 kind 匹配的版本化合同，未知版本 fail closed。`web-surface / wasm-component / native-companion` 必须写 Package 内 `entry`，`remote-service` 必须写 `serviceRef`，两者不得并存。`web-surface@1` 的 `entry` 固定为 ESM JavaScript 模块。`platforms` 省略时继承顶层 `targets`，显式填写时只能是其子集；`dependsOn` 省略等价于 `[]`。Package 内代码声明 `lifecycle.activate / deactivate`，远端组件没有本地 Hook，停用只撤销 Broker 会话，不代表 Host 能关闭第三方服务器。headless Component 使用 `app-enabled / system-event` 时还必须按《运行依赖规范》声明 `backgroundPolicy`。Extension 需要的 Host 能力 **MUST** 单独写入 `requires.hostCapabilities`；Host Capability 不是 Runtime Component kind。

以上是目标 Runtime 合同；当前支持矩阵仍只接受单个 `web-surface`，并未开放 `native-companion`。
随 `.reaiapp` 审核的小型 `native-companion` 目标上使用 Package 内 `entry`；Host 受管资源提供的原生
组件需要独立的资源入口机器合同，不能把下载路径伪装成 Package `entry`。

- `activation=active` 表示用户已允许 Host 运行 App，不表示每个 Component 都健康；`on-demand` Component 可以保持 `stopped`。
- required Component 失败时，App 保持 `activation=active`，聚合 `health=unhealthy`，并阻断引用它的核心 Contribution。
- optional Component 失败时，App 保持 `activation=active`，聚合 `health=degraded`，只阻断引用它的 Contribution。
- 只有用户停用、更新切换、卸载或 Host 明确的安全策略，才能触发 `active → stopping → disabled`；运行故障本身不能偷偷改写用户启用选择。
- Host **MUST** 按依赖图启停 Component，并以逆序停止。
- 任一 Component 变更都 **MUST** 产生新 Manifest / Package 版本并重新审核。

### 4.1 权限声明的七个维度

Manifest **MUST** 分开声明以下权限，不得用一个笼统的 `permissions: ["all"]` 代替：

| 维度 | 示例 | Host 责任 |
|---|---|---|
| Host 能力 | Terminal session、STT、私有存储 | Capability Gate 与调用审计 |
| OS 权限 | 麦克风、辅助功能、输入监控、系统通知 | 调用系统授权并展示真实状态 |
| 数据 | 对话、转写文本、配置、分析数据 | 目的、范围、保留和删除控制 |
| 后台 | 登录启动、Host 退出后运行、定时任务 | 单独同意、可撤销、运行指示 |
| 网络 | 域名、用途、数据类别 | Network Broker、域名门禁和记录 |
| 设备 | 设备类型、Provider Capability、读/写 | Provider 路由、设备选择和占用仲裁 |
| 文件 | 用户选定文件夹、临时文件、全盘范围 | Scope、书签/句柄、撤销和最小访问 |

其中，需要用户授权的 Host、OS、后台和文件能力统一写入 `permissions[]`，每项固定包含 `id / kind / componentId / capability / purpose / required / requiredFor / grantDuration`，可选 `platforms`；字段与枚举以《App 开发指南》的“权限不是一个模糊数组”为准。网络、跨 App 数据和硬件分别写入 `network`、`data`、`requires.hardwareServices`，不得在 `permissions[]` 复制第二份容易漂移的声明；每项 Hardware Service 仍必须声明版本化 `capabilities`、`purpose` 与 `grantDuration`，不能把“需要 AI Board 01”当成无限设备权限。

- 一个维度的授权 **MUST NOT** 隐含另一个维度。例如获得 Host STT Capability 不等于获得原始麦克风或网络权限。
- 新增任一维度或扩大范围 **MUST** 触发重新审核、重新签名与用户再次同意。
- Headless 与有界面 Extension **MUST** 使用相同权限模型。

### 4.2 Headless Extension

当 `contributes.surfaces` 为空而 Runtime Component 非空时，它是 Headless Extension。

- Headless Extension **MUST** 出现在 `Extensions` 的“已安装”列表中，并明确标记“无界面 / 后台能力”。
- 它 **MUST** 拥有与有界面 Extension 相同的安装、启停、权限、健康、更新、回滚和卸载控制。
- Headless **MUST NOT** 意味着隐藏、不可停用或无限期常驻。
- `Browse Extensions` **MUST** 在安装前明确披露其没有独立界面以及会运行哪些 Component。

## 5. 产品界面术语与管理入口

产品界面统一使用以下名称：

- **Browse Extensions**：只负责发现、搜索、查看详情和安装；它可以链接到管理页，但不维护第二套本机状态。
- **Extensions**：唯一的本机管理入口，默认显示 Installed；负责已安装 App 的启停、权限、更新、诊断和卸载。

`Extensions` **MUST** 始终可达，并提供“已安装”列表。每项至少显示：

- 是否 Headless；
- 安装版本与来源渠道；
- Host 推导的摘要；
- permissions / dependencies / health / update 的异常提示；
- 启用/停用、查看权限、更新、回滚（适用时）和卸载入口。

`Browse Extensions` **MUST** 提供进入“已安装”列表的稳定入口；不得让发现页替代本机管理。即使 Marketplace 尚未上线，Platform Core 也必须有 `Extensions` 来管理随包或本地安装的第一方 Extension。

## 6. 发行 Profile

### 6.1 `mac_app_store`

1. Catalog 成员 **MUST** 与 Host Release 一起提交 App Review；新增 Extension 必须随新 Host 版本进入目录。
2. v1.1 可执行 Package **MUST** 随已审核 App Bundle 交付，用户按需启用。
3. 模型、媒体、模板等不会新增或显著改变功能的非执行资源 **MAY** 按需下载，但仍需摘要、来源和清理机制。
4. Host 更新 **MUST** 使用 Mac App Store；不得内置另一套 Host 自更新器。
5. Host、Provider 与 Extension **MUST** 遵守 Sandbox，不得提权、使用第三方安装器或未经同意留下持续进程。
6. Apple 4.7 远程插件路径不属于 v1.1 默认能力；启用前必须另立 Profile 并确认真实审核路径。

### 6.2 `microsoft_store`

1. Catalog 成员 **MUST** 与 Host Release 一起认证；v1.1 不用远程 Feed 静默增加成员。
2. 可执行能力 **SHOULD** 随主包交付，用户按需启用。
3. 若未来采用带可执行代码的 MSIX Optional Package，必须满足 Store 许可、Related Set、签名、包身份与认证要求，并升级 Profile。
4. 非 Microsoft 驱动或 NT Service **MUST NOT** 作为普通 Extension 交付；必要时走平台认证与书面例外。
5. 非集成软件、模块或服务依赖 **MUST** 在 Store 元数据开头披露。
6. 动态代码 **MUST NOT** 根本改变已描述功能或绕过 Store Policy。

### 6.3 `direct`

1. Direct Distribution 阶段启用前，Host 安装包 **MUST** 完成平台认可的生产签名；macOS 完成 Developer ID 签名与公证，Windows 使用受信代码签名。
2. Host **MAY** 读取 ReAI 签名 Catalog Feed，并按需下载签名 Package。
3. Feed **MUST** 使用 HTTPS、整体签名、单调递增版本、防回滚和 last-known-good。
4. 新 Extension 可不升级 Host 发布，但必须通过第 7 节门禁。
5. Host 更新、Extension 更新和非执行资源更新 **MUST** 是三个独立通道。
6. 下架 **MUST** 区分停止新安装、阻止新启用和强制停用；除紧急安全事件外不得静默删除用户数据。

### 6.4 Developer Mode / 本地导入

Developer Mode 是 `direct` 渠道下的受控开发路径，但必须使用独立 `developer_local` Profile；它不是生产 Direct Catalog，也不是 Marketplace 审核捷径。

- 用户 **MUST** 主动开启 Developer Mode，并在开启、本地导入、首次启用和每次 Package 变更时看到明确的“未经过 ReAI 审核”提示。
- 本地 Package **MUST** 使用开发签名或稳定内容摘要；Host 必须显示来源路径、发布者声明、摘要、权限和 Runtime Component。
- `developer_local` Extension **MUST** 与生产 Extension 使用相同 Sandbox、权限、依赖、生命周期、六维状态和资源配额；Developer Mode 不能关闭安全门禁。
- Developer Profile **MUST NOT** 获得生产 Catalog 的“已审核”标识、自动灰度、生产计费权益或静默后台自启动。
- 本地导入 **MUST** 是用户针对具体文件的显式动作，不得扫描目录后静默安装，也不得自动发布给其他用户。
- Host **MUST** 允许用户一键停用全部 Developer Extension，并可清楚区分“已审核”“未审核 / 本地”来源。
- 若本地版本与生产版本使用同一 `appId`，Host **MUST** 阻止覆盖或要求用户明确选择隔离替换，并保留恢复生产版本的路径。

> **当前 Driver V2 实现状态（2026-08-13 核对）**：Developer Mode 已上线，上面的 MUST 条款
> 部分落地——未审核提示 ✓、来源/摘要/权限展示 ✓、同 Sandbox/权限/配额 ✓、
> 保留 appId 拒冒用 ✓（seed 白名单内的官方 id）；**一键停用全部 Developer Extension ✗**
> （只能逐个停用）、**同 `appId` 隔离替换 ✗**（现为 `APP_ID_ALREADY_INSTALLED` 直接拒绝，
> 无“恢复生产版本”流程）、本地包尚无开发签名（仅内容摘要）。缺口清单同步在
> [README](./README.md) 的开放前提条件一节。

## 7. 新 Extension 的独立发布门禁

只有 `direct` 可能在不升级 Host 的情况下增加新 Extension。发布系统 **MUST** 逐项确认：

1. 已完成 ReAI 全量审核，Catalog Policy 允许 `direct`，Package 由受信发布链签名；
2. 当前 Host API 落在 `hostApi.range`；
3. 所有 `runtime.components[]` 的 kind、协议与生命周期均被当前 Host 支持；
4. 只使用当前 Host 与 Hardware Provider 已提供的 Capability；
5. 当前 Host 能展示、请求、撤销和审计全部权限；
6. required / optional 依赖、网络、计费和数据迁移均通过配套规范；
7. 没有更严格的平台或 Catalog Policy 限制。

任一项失败，结果 **MUST** 是“需要升级 Host”或“禁止发布”，不能用 Catalog、远程配置或云端响应绕过。

## 8. 三阶段交付路线

阶段是能力门禁，不是三套互不兼容的架构。后续阶段必须复用 Platform Core。

### 阶段 A：Platform Core v1.1

**本阶段实现目标：**

- 单一 Host ownership；
- Hardware SDK / Provider Registry；
- Catalog Policy 与 Developer Manifest 分离；
- `runtime.components[]` 与 Headless Extension；
- 六维 Local State 与 Host 摘要推导；
- `Extensions` 已安装管理；
- 只展示当前 Host Release 已审核第一方内容的基础 `Browse Extensions`；
- 随 Host 审核交付的第一方 Extension；
- Voice 作为推荐、可卸载的第一方 Extension 的产品政策；真正接入必须先完成版本化 Voice / Media Capability 模块，不能使用未定义接口。

本阶段 **不要求** 第三方 Marketplace 或独立远程 Package Feed。

### 阶段 B：Direct Distribution

在阶段 A 验收后增加：

- ReAI 签名 Catalog Feed 与按需 Package；
- Host / Extension / 资源三通道更新；
- 分阶段发布、last-known-good、防回滚与紧急撤回；
- 官网版新 Extension 独立发布门禁。
- 独立 `developer_local` Profile、Developer Mode 与带未审核提示的本地导入。

### 阶段 C：Marketplace

在阶段 B 的供应链稳定后增加：

- 第三方开发者提交、源码审核、受控构建和签名；
- `Browse Extensions` 面向公开第三方市场的搜索、评分、付费、推荐和运营能力；
- 付费、授权、区域/年龄、举报、下架和争议处理；
- 第三方发布者身份、复审和安全响应 SLA。

Marketplace **MUST NOT** 创建第二个 Host，也不得让开发者 Manifest 持有 Catalog Policy 权限。

## 9. 生命周期与复合组件启停

### 9.1 发布生命周期

```text
源码提交
  → 自动与人工审核
  → 受控构建 / SBOM
  → 生成并签名 Release Envelope，绑定 Source Manifest 与 Package 摘要
  → 生成独立 Catalog Policy
  → 按 channel 发布 Catalog
  → staging 下载 / 验签 / 兼容预检
  → 权限与依赖检查
  → 按组件依赖图启用
  → 健康监测
  → 更新、回滚、停用或卸载
```

- 商店 Profile **MUST** 把完整待发布 Catalog 作为 Host 提交物的一部分审核。
- Direct **MUST** 在 Catalog 可见前完成审核、受控构建和签名。
- 安装 **MUST** 先进入 staging；全部预检成功后才可原子切换 active Package。
- 停用时 Host **MUST** 先阻止新调用，再按组件依赖逆序停止，并执行超时强制终止。
- 用户退出 Host 或停用 Extension 后，Headless / Companion **MUST** 停止；独立常驻必须有单独、可撤销授权。

### 9.2 六个正交状态维度

Host **MUST** 独立保存以下维度，禁止压缩为一个可写的 `status`：

| 维度 | 建议状态 |
|---|---|
| `installation` | `absent` / `downloading` / `verifying` / `staged` / `installed` / `removing` |
| `activation` | `disabled` / `starting` / `active` / `stopping` |
| `health` | `unknown` / `healthy` / `degraded` / `unhealthy` / `crash_loop` |
| `permissions` | `not_required` / `pending` / `granted` / `partial` / `denied` |
| `dependencies` | `checking` / `ready` / `missing_optional` / `missing_required` / `incompatible` |
| `update` | `idle` / `available` / `downloading` / `ready` / `applying` / `blocked` / `rollback_pending` |

- Runtime Component 可以产生自身 health/dependency 观测，但只有 Host **MUST** 聚合并持久化 Extension 维度。
- Extension **MUST NOT** 自己写入总体“healthy”或“ready”。
- Host **MUST** 从六维状态推导 UI 摘要，例如：`安装中`、`需要权限`、`缺少依赖`、`启动中`、`运行正常`、`部分功能降级`、`更新可用`、`已停用`、`回滚中`、`运行失败`。
- 摘要是只读派生值，**MUST NOT** 反向作为状态机输入。
- UI **MUST** 能展开查看六维原始状态和具体 Runtime Component 原因。

推荐的摘要优先级：安全撤回/回滚 → 安装或更新应用动作 → 缺 required 依赖 → 权限阻断 → 启停中 → unhealthy/crash loop → degraded/optional missing → update available → active healthy → disabled。

## 10. 签名、兼容与回滚

### 10.1 供应链

- 生产 Package **MUST** 由 ReAI 受控构建，或从已审核源码可复现构建。
- 审核材料 **MUST** 包含源码版本、构建说明、锁文件、SBOM、Source Manifest、Release Envelope、Package 摘要、Catalog Policy 批次和主要功能清单。
- 签名密钥 **MUST** 位于受控签名服务或硬件保护环境，不进入仓库或 Package。
- 安装记录 **MUST** 保存 channel、签名身份、摘要、审核批次和 Catalog Policy 版本。

### 10.2 兼容

- Host、Package、Manifest Schema、Host API、Hardware SDK 与 Provider Protocol **MUST** 独立版本化。
- Manifest **MUST** 声明连续 Host API 区间和所需 Provider Capability / 协议版本。
- 未知 Manifest 主版本、Component kind、Capability 或生命周期 Hook **MUST** fail closed。
- Catalog **MAY** 分阶段发布，但阶段选择不得改变同版本 Package 字节。
- 数据迁移 **MUST** 幂等，并在激活前备份必要状态。

### 10.3 回滚

- 更新前 **MUST** 完成下载、验签、兼容检查和迁移预检，不得边运行边覆盖。
- Host **MUST** 保留至少一个 last-known-good Package，直到新版本达到健康门槛。
- required Component 启动失败、崩溃循环、健康超时或迁移失败时，Host **MUST** 自动停用新版本并回滚，或进入安全模式。
- 回滚 **MUST NOT** 静默丢失新版本用户数据；无法向下迁移时保留数据并等待修复版本。
- 商店版 Host 回滚受商店机制约束，但 Extension 仍 **SHOULD** 支持安全停用和内部 last-known-good。

## 11. 第一方 Extension 基线

### 11.1 Terminal

- Terminal 是第一方高权限 Extension；PTY、进程创建、终止、环境隔离和审计属于 Host Capability。
- Terminal UI 与 Runtime Component 不得直接取得系统进程或硬件句柄。
- Terminal 必须作为真实 `.reaiapp` 经 Catalog 安装；商店版可把已审核包随 Host Bundle 交付，但安装来源仍记为 Catalog，不得伪装 Builtin。
- `terminal.session@1` 与其他能力技术上同构：Manifest 申请、独立管理员审核批准、用户安装时明确授权三道门缺一不可；不得在 Bridge 中按 `appId` 特判。
- 第三方默认不获批准；未来开放时必须绑定发布者、版本和包摘要，并经过同一撤回、审计和更新扩权流程。
- Terminal 本身不要求 Node 或 Python；具体 Agent CLI 依赖属于对应 Adapter。
- 商店渠道下，可执行能力随 Host 审核交付。

### 11.2 Agent Shell

- Agent Shell 是复合第一方 Extension，可包含 `web-surface`、`remote-service` 与其他受审 Component；本机 CLI 能力通过 `requires.hostCapabilities` 请求 Terminal Session，不伪装成 Runtime kind。
- Claude、Codex、Kimi 等本机 CLI 是 optional dependency；缺少某个 CLI 只让对应 Component degraded。
- 新增供应商 Adapter 必须进入 Manifest / Package / Catalog 审核，不能借配置更新下发任意执行逻辑。

### 11.3 Voice

- Voice 是**推荐安装**的第一方 Extension，Host 可在首次使用或硬件 onboarding 中推荐，但用户 **MUST** 可以不安装、停用或卸载。
- 麦克风采集、STT、文字注入等 Capability 与权限必须在 Voice Manifest 中显式声明。
- Voice absent / disabled 时，Host、Hardware Provider、`Browse Extensions`、`Extensions` 和其他 Extension **MUST** 正常工作。
- Voice 的模型可作为签名非执行资源按需下载，不得因此把 Voice 伪装成 required system app。

## 12. v1.1 验收清单

### Host / SDK

- [ ] 运行时只存在一个 Extension Registry、权限权威和 Local State 所有者。
- [ ] Host 身份由 ownership 规则确定，而不是目录名或进程名。
- [ ] Extension 通过 Host Capability → Provider → Hardware SDK 访问设备。
- [ ] 文档和 UI 未把“旧 root App 已退役”或“Driver 已是最终 Host”写成现状。

### Manifest / Catalog

- [ ] Developer Manifest 使用 `runtime.components[]`，不再使用 App 级单一 `runtime.kind`。
- [ ] Catalog Policy 与 Manifest 分离，开发者无法自我批准渠道、灰度或计费例外。
- [ ] Headless Extension 可完整安装、启停、授权、更新、回滚和卸载。
- [ ] 权限分为 Host 能力、OS、数据、后台、网络、设备、文件七个维度。
- [ ] Package 在执行前按 Release Envelope 验证签名、Source Manifest 摘要、Package 摘要、发布者和 Catalog Policy。

### 状态与界面

- [ ] 六个状态维度独立持久化，UI 摘要由 Host 单向推导。
- [ ] optional Component 失败映射为 `health=degraded`，required 失败映射为 `health=unhealthy`；两者都不偷偷改写用户的 activation 选择。
- [ ] 产品使用 `Browse Extensions` / `Extensions` 术语。
- [ ] `Extensions` 有“已安装”列表并显示 Headless 项及六维异常。

### 阶段与发行

- [ ] Platform Core 未依赖尚未交付的 Direct Feed 或 Marketplace 才能工作。
- [ ] 商店 Catalog 成员与 Host Release 一致。
- [ ] Direct 新 Extension 通过审核、兼容、Provider、权限、依赖、网络、计费与迁移门禁。
- [ ] Developer Mode 使用独立 Profile，未审核提示清楚且不关闭 Sandbox/权限门禁。
- [ ] Marketplace 沿用同一 Host 和供应链，没有第二套安装/权限系统。

### 第一方 Extension

- [ ] Terminal 的进程控制留在 Host Capability。
- [ ] Agent Shell 缺单个 CLI 时只让对应 Component 降级。
- [ ] Voice 可卸载；卸载后平台核心、硬件 Provider 和 Extensions 管理仍可用。

## 13. 官方行业依据

以下链接是发布前的复核入口，不表示平台预先批准 ReAI 的具体实现：

1. [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)：Mac App Store 自包含、更新、插件与逐项授权。
2. [Apple Certificates Overview](https://developer.apple.com/help/account/certificates/certificates-overview)：Mac App Store 与 Developer ID 签名身份。
3. [Microsoft Store Policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)：Add-on / Extension、动态代码、外部依赖与 HTTPS 安装包。
4. [Microsoft：Optional packages with executable code](https://learn.microsoft.com/en-us/windows/msix/package/optional-packages-with-executable-code)：Optional Package、Related Set 与 Store 许可。
5. [Microsoft：Sign an MSIX package](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview)：MSIX 签名与设备信任。

## 14. v1.1 决策记录

- **替代 v1.0**：唯一 Host 从“某个 App/目录”澄清为“单一运行时治理权威”。
- **新增**：Hardware SDK / Provider 是 Host 架构前提；Driver 只是首个 SDK 规划版本，不是永久 Host 指定。
- **新增**：旧 root App 退役是完成迁移后的目标，不能表述为当前事实。
- **替代 v1.0**：App 级 `runtime.kind` 改为 `runtime.components[]` 复合运行时。
- **新增**：Headless Extension 与 `Extensions` 已安装管理是 Platform Core 必备能力。
- **新增**：权限拆分为 Host 能力、OS、数据、后台、网络、设备和文件七个维度。
- **替代 v1.0**：单一生命周期状态改为六个正交维度，摘要只由 Host 推导。
- **新增**：Catalog Policy 与 Developer Manifest 分离。
- **新增**：Voice 是推荐但可卸载的第一方 Extension。
- **分阶段**：Platform Core v1.1 → Direct Distribution → Marketplace。
- **补齐 Direct**：Developer Mode / 本地导入使用独立 `developer_local` Profile，并持续显示未审核来源。
