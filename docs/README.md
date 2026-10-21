# App 平台合同 v1.1 · 首版实现范围

> 本仓库提供独立插件开发文档、共享工具和官方插件源码。公开源码、平台审核、签名、上架与 Host 安装是不同状态；能力支持范围以当前工具链合同和实际 Host 版本为准。
> 配套 HTML 是手工维护的布局示例与历史快照；出现差异时，以同名 Markdown 的最新合同和适用边界为准。
>
> 2026-10-21 平台包改为主项目发布：仓库不再保存 `packages/` 源码拷贝，插件与样例改用 `vendor/platform/` 中按摘要锁定的 tarball；主项目平台规范的最新快照位于 [`platform-docs/`](../platform-docs/README.md)。本目录文中的 `packages/contract/…` 等路径指平台包 tarball 内的对应文件。
>
> 2026-10-19 源码同步：共享工具更新至 v1.0.5 平台包，官方插件同步至主仓库最新候选并新增文件插件，详见 [源码同步记录](source-delivery-2026-10-19.md)。公开源码与工具验证不表示已安装 Host、平台批准或商店上架完成。
>
> 2026-10-06 源码同步：本仓 SDK、CLI、test-kit 与 Voice 源码候选已同步附件输入、Deflate 打包、待审字节计算和 Mock 分块上传。Voice `2.14.5-dev.3` 未送审；公开源码与工具验证不表示已安装 Host、平台批准或商店上架完成。


这一目录是**规范**。规范描述的是平台最终要长成的样子；首版 Host 只实现其中一个子集。
本文件说明**首版到底实现了什么**，以及规范与实现之间每一处有意的偏差。

> 2026-08-09 产品方向更新：Host 已有本机 Developer Mode，可显式导入未经审核的本地包；
> 云能力的“仅作者本人可用、使用作者自己 Team 额度”仍待外脑服务端合同落地。公开给其他
> 用户前必须官方审核。生产 Catalog 的机器可读 profile 仍是 `official-only`。外脑 Team、工作流快照、
> 安装实例和计费基线见 [Driver V2 × 外脑云能力与工作流分发基线](wainao-cloud-workflow-distribution-v1.md)。

## 开发者从这里开始

开发前先读 [能力复用与调用边界](plugin-development-v1.md#capability-reuse)：复用已有服务，区分触发、进度、结果与交付。

| 文档 | 用途 |
|---|---|
| [Driver V2 插件开发规范 v1](plugin-development-v1.md) | 从项目骨架、权限声明、合同测试到本机安装验收。**除明确标注「规划，尚未实现」的章节外**对应当前可运行实现 |
| [开放平台工作流](developer-platform-workflow-v1.md) | 仅系统插件的 Host API 1.21 合同：scope、原生材料上传、收费确认、幂等及发布恢复；本仓 SDK 已提供调用与校验，实际 Host 支持单独核对 |
| [Agent Service v2](agent-service-v2.md) | Host API / SDK 1.21：统一 Agent 配置、Pi/DSH/Codex 原生 runtime、持久回合与幂等重试；明确当前支持子集 |
| [插件语言包规范 v1](plugin-i18n-v1.md) | 包内中英文 JSON、App 语言联动、完整覆盖与发布验收；明确当前能力和平台缺口 |
| [插件上架打包与提交规范](plugin-submission-v1.md) | Team / OAuth Client / Product 身份、最终包预检、图片归集与提交重试边界 |
| [插件设置页、版本与关于入口规范 v1](plugin-settings-and-release-notes-v1.md) | 所有插件设置页底部的版本 / 关于入口、逐版本更新日志、每次送审自动撰写版本介绍，以及开放平台地址与文档迁移目标；新产品要求，实施状态分别验收 |
| [AI 员工范式 v2](ai-employee-pattern-v2.md) | 第一阶段设计稿与范式合同：A-B / A-B-C / A-B-D 三种范式、主题看板、10 个通用岗位、C 签字与 D 检查、可信动作与错误恢复；未实现、未送审 |
| [AI 员工三阶段插件最佳实践](ai-employee-pattern-v1.md) | 原始事实、可编辑标准记录与岗位 Agent；提供财务、人事 Demo、开发模式配置和新岗位插件生成器 |
| [Driver V2 插件接口参考 v1](plugin-api-reference-v1.md) | 当前 SDK、Manifest 前置声明、返回值、错误码、权限和限额 |
| [Driver V2 皮肤插件开发规范（Skin v1）](skin-development-v1.md) | 独立皮肤包的 Manifest、结构布局参数、明暗 token、开放边界、构建安装与 App Store 约定 |
| [插件服务与 Agent / DSH 扩展规范 vNext](agent-service-extension-v1.md) | **目标规范，尚未实现**：插件间类型化 Service、插件定义 Agent Scene、动态 Tool、按需安装与同会话人工续跑；当前开发不能把其中字段写入 Manifest |
| [ReAI Board 插件设计规范 v1](plugin-design-system-v1.md) | 插件界面长什么样：单层 Host Title Bar + 可滚动 `main-body`、颜色 Token、图标、按钮档位、刻度、抽屉与状态；配可运行示例页 <https://ai-board.reai.com/design/plugin-v1/> |
| [订阅、积分与云服务](driver-cloud-billing.md) | 无订阅按量使用、重新授权、余额单位及插件处理边界 |
| [规范更新日志](CHANGELOG.md) | 所有影响插件设计、开发、接口、发行或运行边界的变化；每次规范更新必须在同一提交或 PR 追加记录 |
| [ReAI App 开发指南 v1.1](app-development-guide-v1.md) | 平台完整目标合同与设计背景；包含尚未实现的能力，不能代替当前接口参考 |
| [Driver V2 × 外脑云能力与工作流分发基线](wainao-cloud-workflow-distribution-v1.md) | 云端 Team/Project、工作流快照、计费、审核和升级产品基线 |
| [Host 系统任务](plugin-api-reference-v1.md#host-系统任务) | 版本状态、升级入口和返回来源插件的职责边界 |

`website/` 构建会检查本目录的规范文件和已跟踪 HTML 导出；发现变更但 `CHANGELOG.md` 未同步时
直接失败，避免线上规范无记录漂移。

拿不准某个字段能不能用时，以三份**机器可读**的事实源为准——它们同时被 Host（Rust）、
`reai-app` CLI 与本目录的文档引用，不存在「文档说行、Host 说不行」：

| 事实源 | 回答的问题 |
|---|---|
| `host-support-matrix.json`（仓库路径 `packages/contract/host-support-matrix.json`） | 首版放行哪些能力与权限、平台全局限额是多少、稳定错误码有哪些 |
| `app-manifest-1.1.schema.json`（仓库路径 `packages/contract/schemas/app-manifest-1.1.schema.json`） | Manifest 的结构契约（`additionalProperties: false`） |
| `manifest-fixtures/`（仓库路径 `packages/contract/manifest-fixtures/`） | Manifest 正反样例，用于合同验证 |

> 通知与网络的具体限额见[接口参考](plugin-api-reference-v1.md)和[网络与计费策略](network-billing-policy-v1.md)。支持矩阵与接口文档须共同核对。

---

## 首版档位：官方 Catalog + 本机开发者通道

`host-support-matrix.json` 里的 `profile` 是 `official-only`，它描述的是**生产 Catalog**：

- 插件由我们自己编写，**随 App 一起签名发布**；
- 普通用户不能从 Catalog 获取未经审核的第三方插件；
- 本机 Developer Mode 默认关闭，开启后可导入 `.reaiapp`，安装前持续明确提示“未经审核”；
- 本地导入不等于上架、公开分发或获得云能力，插件仍受 Manifest、Bridge、权限和资源门禁；
- 开发者通道运行的是不可信代码，现有独立 WebView/origin 是隔离边界，但不是完整安全沙箱。

Developer Mode 用于作者本机调试。它不提供任意第三方代码的完整安全隔离，也不代表平台审核或公开分发批准。开发者只应导入自己信任的代码。

### 但架构边界照做

独立 WebView、独立 origin、显式 IPC 白名单、KV 命名空间隔离——这些**一条都没砍**。
它们的价值不依赖威胁模型：一个插件崩了不能拖垮主程序，两个插件的样式和 DOM 不能互相污染。
而且开放第三方那天，这些是地基。

**官方插件与将来的第三方走同一套规范**，没有「自己人可以简化」的通道。Worker、
剪贴板、文件选择仍是彼此独立的能力；其中剪贴板从 Host API 1.20 起只开放经审核的
纯文本写入窄口；Worker 与 Host 原生路径选择能力按矩阵控制。HTML 文件输入控件可以选择用户文件，Host API 1.24 的普通网络通道支持有界 multipart 上传，不授予任意路径读取。

---

## 与 v1.1 规范的显式偏差

下面每一条都是**有意的合同修订**，不是实现没跟上。

### 1. 能力拆分（冻结前的 breaking correction）

`surface.main@1` 原本隐含了 Worker、剪贴板与文件选择。现在拆成四个独立能力：

| 能力 | 首版 |
|---|---|
| `surface.main@1` | ✅ 放行 |
| `surface.worker@1` | ❌ 无独立进程，给不了资源预算 |
| `surface.clipboard@1` | ✅ grant-gated；仅 `clipboard.writeText`，不提供读取/富文本/文件 |
| `surface.file-picker@1` | ❌ 文件访问须走未来的 Host Broker |

拆分的理由：不拆的话，「首版支持 `surface.main@1`」这句话对开发者是误导——他们会以为
剪贴板能用。拆开之后，Manifest 里写了未放行的能力会**当场被拒并说明原因**，而不是装上去
才发现某个功能是死的。

### 2. `contributes.recommendedBindings` 下线

插件只声明**可绑定的 Command**，键位一律由用户在键位映射页配置。声明了非空
`recommendedBindings` 会被拒绝（`HOST_CAPABILITY_NOT_AVAILABLE`）。

理由：预设键位必然和用户已有的绑定冲突，而「插件装上去改了我的快捷键」是不可接受的。
让插件声明能力、让用户决定按哪个键，冲突就不存在了。

### 3. `requires.hardwareServices` 非空即拒

首版没有 Hardware Provider Registry。硬件绑定的实现方式是：插件贡献 Command，
用户在键位页把物理键指向它。Todo 样例已据此删除该声明。

> 2026-08-16 架构拍板把这条从首版取舍升格为长期红线（插件只暴露可绑定事件、绑定归 Host 键位设置、
> 插件设置页不出现绑定配置）：见[开发指南 · 插件与硬件解耦](app-development-guide-v1.md#插件与硬件解耦2026-08-16-架构拍板)。

### 3.1 `requirements` 当前开放受管可执行子集

非空 `requirements` 不再一律拒绝。当前 Host/Schema/CLI 只接受
`requirementsVersion: "1.2"` 的 `managed_executable` + `host_managed_resource` 子集，并由 Host
签名目录解析资源、合并授权、执行复合安装或稍后修复。插件仍不能声明下载 URL、摘要、签名或任意
probe 命令；其他依赖分类会 fail closed。分层与当前/目标边界见
[插件开发规范](plugin-development-v1.md#11-开发前先做交付分层direct-受管运行时一期已实现)。
App、Plugin 与 Device 的启动、检查、修复、ready 聚合和可追踪 Hook 合同见
[生命周期 Hooks v1](lifecycle-hooks-v1.md)。

### 4. 术语：App Store / Extensions

界面里用 **App Store**（发现与安装）与 **Extensions · 已安装**（本机管理），
两处互相可达。规范原文的 `Browse Extensions / Extensions` 指的是同两件事。

### 5. 合同套件文件名：`tests/contract.suite.ts`

原先约定的 `tests/contract.test.ts` 会被各种测试运行器自动收录，然后因为「文件里没有测试」
而报错。改名后由 `reai-app contract-test` 显式加载。

### 6. 合同套件移除两项断言

`neverOverwritesUserBindings` 与 `removesOnlyOwnedBindingsOnDisable` 从 App 合同套件里移除。
这两条是 **Host 的保证**——App 无论怎么写都违反不了它们。放在 App 的套件里只会给人
「我测过了」的错觉。它们在 Host 自己的测试里。

### 7. 首版不做更新通道

同 `appId` 已安装时返回 `APP_ID_ALREADY_INSTALLED`，必须先卸载再安装。
因此 `data.migration` 非空即拒——没有更新，就没有迁移。

### 8. 能力四分档与三个新贡献点（C1，2026-08-06 新增）

`hostCapabilities` 在 granted/withheld/未知之外新增 **`grantGated`**：平台已实现、但需按
appId 授予（`capabilityGrants` 数据层）的能力；未授予即 `APP_CAPABILITY_NOT_GRANTED`。
**清单以机器事实源 `packages/contract/host-support-matrix.json` 的 `hostCapabilities.grantGated` 为准**（2026-09-29 核对为二十五项）：`agent.codex@1`、`agent.codex.tasks@1`、`agent.local@1`、`agent.dsh@1`、`agent.dsh-observe@1`、`agent.session@1`、`agent.session@2`、`agent.pi-management@1`、`activation.startup@1`、`voice.input@1`、`voice.command@1`、`voice.recordings@1`、`voice.deliver@1`、`voice.context@1`、`cloud.model.invoke@1`、`cloud.workflow.invoke@1`、`system.folder-pick@1`、`local.files@1`、`browser.engine@1`、`computer.engine@1`、`tts.local@1`、`developer.platform@1`、`terminal.session@1`、`surface.clipboard@1`、`local.terminal.exec@1`。
其中 `agent.local@1` 只授予官方设备诊断助手 `com.reai.device-doctor`：本地 pi agent 内核，
只读工具（设备/权限/日志摘要/环境）+ 脱敏日志摘要经云端分析，按需拉起、闲置退出。
它们只授予机器审核 policy 中按发布者、版本与包摘要批准的最小集合；Voice 通过类型化 `ctx.voiceInput`
调用 Host 的录音、本地识别、模型与文字注入 broker。授予只在能力层放行，**不开第二条
加载路径**（断言测试锁死）。`voice.command@1` 是官方 Voice 的专用 Workflow 窄口：插件只交
最终文本，URL、外壳的 OAuth token、请求与响应校验留在 Host；它**保留不动**，与新的通用通道并存。

Host API 1.3 新增两条**并列**的底层云端纯管道：`cloud.model.invoke@1`（`ctx.aiApi`，中转各家
大模型既有 API）与 `cloud.workflow.invoke@1`（`ctx.flowApi`，调已发布工作流），外加
`voice.deliver@1`（结果写回目标应用）。此后又加入 `voice.context@1`（`ctx.voiceContext.capture()`
——焦点控件文字 + 前台应用粗分类；显式请求截图时只在屏幕录制已授权后返回有界焦点窗口 JPEG，
编辑器类应用还必须先通过焦点文字安全预检，供插件自己拼润色上下文；不给窗口标题、不给文件路径、
不截整屏，也没有申请屏幕录制权限的入口）。四者都是**双层**能力：
`requires.hostCapabilities` 是平台放行（只有官方 seed 拿得到），同名的 `permissions` 是用户显式
同意——「拿我的账户额度去调云端」「读我正在打字的那个窗口」这类事官方插件同样要问。只声明
一半会在校验阶段报 `MANIFEST_REFERENCE_INVALID`。
业务语义（润色 / 翻译 / 命令化 / Agent 编排）一律不进 Host，属于插件或工作流。

C1 同期落地三个新贡献点（门都在 manifest 结构体 + validator，矩阵里的标志供文档/CLI 同源）：
`tabItems`（Tab 层实体供给）、`eventSubscriptions`（Host→插件事件，v1 仅 `actionContext`）、
`acceptsActionContext`（Action 上下文广播接受声明，v1 仅 `recording`）。

Host API 1.2 另新增普通开放的 `system.tasks@1`：插件只提交白名单系统任务 intent 与读取归一化版本
状态，来源身份、设置路由、远端发布元数据、下载校验和 DFU 均由 Host 持有；详见接口参考的
“Host 系统任务”。

### 8.1 Host 托管标题栏动作（2026-08-12 新增）

`titlebar.action@1` 位于 `granted`，不是用户权限或官方 seed 特权。生产 Catalog 仍由
`official-only` 控制分发；macOS Developer Mode 本地插件同样可按 Manifest 合同使用这一能力。
`contributes.titlebarActions` 每 App 最多 3 个，支持 Host 托管的默认、描边和危险动作；可选
`contributes.titlebarStatus` 显示静态状态胶囊。Host 只渲染固定 AppIcon 白名单与纯文本，并按
当前 Ready Surface presentation 投递静态 intent。插件不能把 DOM、CSS、SVG 或网络资源注入
标题栏。精确字段、hover/focus、通知互斥、生命周期与限额见
[插件接口参考](plugin-api-reference-v1.md#host-托管标题栏动作)。

### 8.2 单层 Title Bar 与页面路径（2026-08-20 设计规范更新）

统一页面框架只保留一条 44px Host Title Bar；插件不再叠 `main-title` 或第二组右侧操作，DOM 从
可滚动 `main-body` 开始。根路径直接显示 App 名，二级页有返回按钮与可点击祖先面包屑，不使用
`Apps /` 前缀。Apps 分组的折叠、排序与垂直对齐也属于 Host 壳层，插件无权控制。

Host 已注入跨平台 `--reai-plugin-titlebar-safe-top`：macOS 为 `44px`，其他平台为 `0px`。插件根框架
只消费一次，并用 `44px` fallback 支持脱离 Host 的浏览器预览；抽屉和弹层不能用 viewport fixed
绕开这条安全区。

Host Title Bar 与正文的全宽交界必须“同色连续，异色内缩”：同色时使用同一主题 Token，不加装饰性
padding 或分割线；异色时把第一块异色 Surface 内缩到 `main-body`，桌面默认留白 `16px`、紧凑布局
最低 `12px`。禁止两个不同颜色的全宽大色块零距离硬切，1px 分割线不能替代真实留白。该视觉实现
只能属于插件 Surface，不能修改 Host 或全局样式。

当前实现状态必须分开看：`titlebar.action@1` 已可用；通用子路由、返回与面包屑贡献合同尚未进入
公开 SDK。后者是已经锁定的设计目标，不是现在可以写进 Manifest 的字段。实现骨架、兼容路径与
验收清单见[插件开发规范 §3.1](plugin-development-v1.md#31-单层页面框架host-title-bar--插件-main-body)
和[插件设计规范 §4.5](plugin-design-system-v1.md#45-单层顶部44px-host-title-bar--可滚动-main-body)。

### 9. 插件用户权限与系统通知（2026-08-09 新增，2026-08-13 补 http.fetch@1）

当前开放三项本机设备级插件权限：`account.status@1`、`os.notification.post@1` 与
`http.fetch@1`。它们都要求 Manifest 声明、当前插件的用户授权和有效 Bridge 会话；
授权决定按 `appId` 与声明摘要隔离，官方插件也不能绕过。

`http.fetch@1` 经 `ctx.http.fetch()` 走 Host 网络 Broker 受控出网：目标必须落在 Manifest
`network.endpoints` 声明的 origin/方法/路径前缀内，正式安装走严格档（DNS 固定、私网拒绝），
开发者模式走宽松档；限额与 16 个 `NETWORK_*` 稳定错误码见
[网络与计费策略](network-billing-policy-v1.md) 与支持矩阵。`network` 声明范围变化时
用户授权自动重置回待定。

`os.notification.post@1` 只开放 `ctx.notifications.post({ title, body })`，不把 Tauri notification
JS API 或系统授权接口交给插件。系统通知授权由 Host 持有：App 启动只查询、不申请，必须等用户点击
首次引导中的“开启通知”或设置页的“允许通知”后才请求 macOS 授权；首次未决定时直接弹出系统确认，已拒绝后只能由用户从系统设置重新开启。插件提交仅允许纯文本（标题 80 字符、正文
500 字符），Host 强制加入插件名与 appId 指纹，并限制每插件每 10 秒最多发起 5 次通知请求。

来源标签用于稳定追踪真实 `appId`，但 Manifest 显示名不是可信发布者身份；在 Catalog 发布者标识与
保留名称机制完成前，用户和审核方不能只凭插件显示名判断通知是否来自 ReAI 官方。

---

## 第三方分发边界

当前生产 Catalog 为 `official-only`。未经审核的包不能通过公开 Catalog 分发。

Developer Mode 是本机调试入口，不是公开分发渠道。平台批准、用户权限同意、正式安装和真实 Host 验收需要分别完成。

未来第三方开放范围以正式平台合同为准；文档中的目标能力不能作为现有安装权限。
