# ReAI App 平台规范更新日志

## 2026-10-21 · 补迁 project-data-app 与 workflow-app 样例

- 两个样例由插件仓接管：来源为主项目导出提交 `4ed2325a750e` 的同名样例，依赖改为 `vendor/platform/` 中的平台包。预览改读随附的主题色快照 `tests/fixtures/theme-tokens.json`，输出写到仓库根 `.artifacts/`。
- 不随附内部计划、验证记录与后端合同证据（`docs/plan.md`、`docs/verification.md`、`tests/backend-contract.json`），fixture 注释改为中性描述。`workflow-app` 在继续或取消的结果未知时禁止再次继续，读取确认成功后才恢复，并补了回归测试。
- 主项目 `tests/plugin-contracts/` 中与样例相关的插件侧检查迁入 `tests/example-contracts/` 并纳入 CI：样例独立性（按目录自动发现全部样例）、皮肤只用合同包公开 token、Todo 与标题栏动作样例的单层 Title Bar 合同、所有样例 `test:contract` 的 Host API 与合同套件一致，以及审核基线、TBC 挂点和安全区缓冲中的 Todo 部分。官方插件部分在迁入本仓前仍由主项目守。
- 两个样例加入插件工具链 CI 矩阵；本地 test、typecheck、validate、build、test:contract、pack、Deflate 打包与预览启动均已通过。

## 2026-10-21 · 平台包改由主项目发布（迁移阶段 A 插件仓侧）

- 删除 `packages/` 源码拷贝，插件、样例与两个 AI 员工 demo 改为依赖 `vendor/platform/4ed2325a750e/` 中主项目发布的 v106.2 平台包 tarball：合同 `1.26.0-v106.2`、SDK `1.27.0-v106.2`、test-kit `1.5.0-v106.2`、CLI `1.4.2-v106.2`、语言工具 `1.2.0-v106.2`、共享 UI `0.1.1-v106.2`。`vendor/platform/pins.json` 按摘要钉住 lock，lock 钉住来源回执与每个 tarball；插件仓不修改 tarball，升级只能整体替换为主项目新发布的批次。
- 删除 `scripts/` 下四个主项目工具拷贝。送审预检改用语言工具自带的 `reai-app-i18n submission check|pack`，插件的 `check:submission` / `pack:submission` 命令名不变。
- 官方插件按主项目导出（总摘要 `021d8c09…b9aa`）同步；样例、AI 员工 demo、插件仓独有说明与 Voice 诊断测试保留插件仓版本。新增 [`platform-docs/`](../platform-docs/README.md) 作为主项目平台规范的只读快照，本目录文档暂不改写，文中 `packages/…` 路径指平台包 tarball 内的对应文件。
- CI 改测 vendor tarball 并在 `vendor/**` 变化时触发，Bun 升到 `1.3.14`；新增对所有改动生效的公开泄露闸门，导出自带豁免与插件仓自有豁免分文件登记、按文件摘要绑定。

## 2026-10-19 · 同步插件与共享工具至 v1.0.5 平台包

- 共享工具同步到 SDK `1.26.0-v105.1`、合同 `1.25.3-v105.1`、CLI `1.4.1-v105.1`、语言工具 `1.1.1-v105.1` 与 test-kit `1.4.0-v105.1`，新增 Surface 导航与布局、平台服务合同、`resources.files@1`、共享音频片段和通知场景及对应 Mock。
- 官方插件同步 Browser、DSH Agent、Pi Agent、Terminal、Voice 的新候选，新增文件插件。能力审核种子包含 Voice `2.14.7` 的源码审核记录；公开 CI 改为常规验证 Voice。
- 主仓库 `platform/docs/` 的规范更新未在本次同步，相应条款仍以本目录现有文档为准。验证和边界见 [2026-10-19 源码同步](source-delivery-2026-10-19.md)。

## 2026-10-19 · AI 员工范式 v2.2：租户、客户与案件隔离

- [AI 员工范式 v2](ai-employee-pattern-v2.md) 新增 6.9：三层归属（租户 / 客户 / 案件）与行级隔离。所有行带 `tenant_id`，声明客户维度的岗位另带 `client_id`、`matter_id`；读取一律按当前范围过滤，缺租户字段的行不可见。
- 规定 A 上传必须归入案件、去重限于同一范围；B、C、D、回流原件继承归属；Agent 只读当前范围，对话按范围保存，跨范围请求拒绝且不推测；员工只见承办客户，利益冲突墙两侧互不可见；跨案件读取需负责人授权，跨客户默认禁止。
- 开放问题新增租户与客户的事实源、跨案件授权与策略强制层级。新增 v2.2 设计稿（`paradigm-v2.2.html`，v2 原文件保持不变）演示两个租户、专利岗位与冲突墙；真实存储与权限强制未实现。

## 2026-10-14 · AI 员工范式 v2（设计稿与合同，第一阶段）

- 新增 [AI 员工范式 v2](ai-employee-pattern-v2.md)：A-B 解释型、A-B-C 创作型、A-B-D 检查型三种范式及不变量；看板定义为主题最小功能界面，10 个通用岗位按主范式与组合范式归类，示例公司与数据均为虚构。
- 冻结第一阶段最小合同：A→B 流程、B 的四类来源（含回流经 `derived` 原件追溯）、C 候选选定与签字回执幂等、D 规则与检查运行分离及结论过期、看板可信动作白名单、一岗一实例与跨岗引用格式、Agent 消息与 ni-chat / ROMP 映射、Agent 配置事实源、错误类型与恢复动作。
- 记录复用外脑工作流、Agent Service v2、ni-chat / ROMP 与 JOJO 项目网络的边界；相关服务的上线状态来自其自身文档，本次未核验部署。跨岗授权、逻辑工作流名与快照映射、Agent 过程事件、交付物导出、IPO 网络落成 JOJO 边列为开放问题。
- v1 开头标注已由 v2 扩展，正文不变；补齐 v1 与 v2 的英文阅读指南。设计稿为独立 HTML 交互意图，不是合同；插件实现、平台批准、签名、安装与发布均未进行。

## 2026-10-08 · AI 员工通用 HTML 看板与确认合同

- 更新 [AI 员工三阶段范式](ai-employee-pattern-v1.md)，明确 Dashboard 与岗位看板采用统一 HTML 页面定义，财务、人事仅为示例。数据绑定采用有界指标、列表、字段与筛选合同，不增加脚本执行权限。
- 记录页面提案、显式确认、岗位隔离、配置版本校验、实时读取与重复确认幂等。普通业务数据变动不使定义失效；用户新增页面不解锁开发配置。保留20页/岗位、100页/全库上限，本期不提供隐藏或删除。
- 记录非模态持续对话、右侧引用卡片打开左侧内容，以及已有 Voice 可选服务接入。真实模型、真实 Voice 和设备继续单独验收。
- 记录 `0.2.0` 旧配置只读适配、缺失页面索引的 CAS 兼容与 `rollbackFloor: 0.2.0`。未执行 migration，不重解释或删除旧资料。

## 2026-10-08 · AI 员工三阶段插件最佳实践

- 新增 [AI 员工三阶段范式](ai-employee-pattern-v1.md) 与 `plugins/ai-employee` 本地 Demo，区分原始资料、可修订标准记录和只读 Agent 分析。
- 记录集中设置、密码解锁开发模式、岗位配置合同与新插件生成入口。静态模板与公司运行数据分开，HTML / CSS 定制保持展示权限边界。
- 记录规则演示和真实 Agent Service v2 的独立验证路径。平台批准、签名、真实 Host 安装、真实模型、语音与公开发布不从本地 Demo 继承。

## 2026-10-07 · 对齐附件与离线待审工具说明

- [Agent Service v2](agent-service-v2.md)补齐文本附件的严格 UTF-8 / 带 BOM UTF-16 解码规则，以及 PDF Worker 缓存、握手错误、取消与原有 20 秒文档时限的对应行为。
- [送审规范](plugin-submission-v1.md)明确离线待审字节计算仅支持普通 App，并说明 `candidate.review-bytes`、`calculation.json` 及回执内容。
- 英文阅读指南同步上述说明。条款对应既有源码实现；插件版本、能力和发布状态没有变化。

## 2026-10-06 · 同步插件与共享工具增量

- SDK 同步受控附件输入与系统插件开放平台工作流类型、调用校验及合同 Schema；平台批准和真实 Host 支持单独验收。
- test-kit 增加有界分块上传模拟、完整正文 fixture 与可注入时钟；CLI 修正 Agent 功能的稳定版本范围下界。
- modern 打包工具支持固定编码器的可复现 Deflate；新增离线待审字节计算，仍明确非批准、不可作为安装或发布凭据。批准种子与默认拒绝门禁保持不变。
- Voice 源码候选更新至 `2.14.5-dev.3`，同步命令附件、PDF/表格 Worker 提取与输入预算；第三方许可保留。未送审、未签名、未上架。
- 修复 PDF 预算边界的重复缓冲区复制；尾段预留有界的小块，并验证后续数据流的完整字节。16 MiB 累计解码预算、分配前拒绝和 20 秒 Worker 时限保持不变。
- 增加仓库外 tarball 工具链验收入口，保留本仓独立依赖路径与公开范围。仅引入公开规范，不公开内部审查归档。
- 同步测试到期时钟修复，并更正文档中已由本次源码交付的工具能力状态；部署结果仍以实际网站版本核验。

## 2026-10-06 · 更新平台规范与候选能力边界

- [设计规范](plugin-design-system-v1.md#waiting-failure-minimum)区分普通用户提示与开发者诊断；保留设置页底部版本和关于入口要求。
- [开发规范](plugin-development-v1.md)与[接口参考](plugin-api-reference-v1.md)补充当前插件权限决定、Agent 配置导航锁定、合法版本下界、上传归属清理和前台正文读取限制。
- [Agent Service v2](agent-service-v2.md)补充技能目录与勾选配对、配置写入复验、字面花括号，以及 Voice 命令附件候选的准入、限额、重试与过期行为。
- [受控执行](agent-controlled-run.md)澄清搜索截断、账号退休和后代清理边界；[订阅与积分](driver-cloud-billing.md)补充当前/已付下一期、报价等待与凭据收尾。
- [送审规范](plugin-submission-v1.md)记录可复现压缩与待审字节合同。附件、新 Mock 上传、Deflate 与离线计算尚未随本仓工具链交付，不能据文档宣称已支持。
- 新增[开放平台工作流](developer-platform-workflow-v1.md)：仅系统插件的 scope、原生上传、收费确认、幂等重试与发布 CAS 恢复合同；本仓 SDK 尚未提供入口。
- 本轮只同步规范；SDK、CLI、插件代码、权限、批准、签名、上架与网站部署均需独立交付和验证。

## 2026-10-03 · 独立源码与打包验收

- 公开 15 个插件、4 个示例和共享工具，提供本仓库可执行的冻结安装、测试、编译与打包入口。
- 记录当前版本、单元测试结果、包摘要及重复打包一致性；平台批准与真实 Host 安装单独验收。
- CI 覆盖共享工具、普通插件与示例流程；Voice 单独检查测试、类型及无精确证据时的拒绝门禁。
- 私有提交身份使用公开占位模板说明，本地审核报告与生产配置保持私有。

## 2026-10-03 · 公开文档脱敏与开发入口

- 公开文档保留 API、能力声明、用户授权、限额、版本兼容与候选状态；移除本机路径、内部审计、未合并分支和私人操作记录。
- 公开分发说明保留 Developer Mode 的实际用途与隔离限制；内部安全审查和修补细节留在仓库外。
- 送审与云工作流说明改用公开合同和产品状态，移除内部源码定位、主机身份和运维取证细节。开发示例使用独立仓库路径。
- 内部迁移来源与文件哈希记录保持本地忽略；公开源码、构建、平台批准和安装验收继续分别记录。
- 共享工具与样例使用本仓库现有命令；修正旧工具和样例路径，并明确仓库外 tarball 安装及真实 Host 安装须单独验证。文档先发布时，尚未公开的源码引用显示为路径文字。

## 2026-10-03 · 开放平台中英文入口

- 开放平台页面新增中文/英文资源、语言切换与语言路径；下载入口随语言连接到现有官网。
- 文档站新增英文导航与英文阅读指南。中文规范继续承载完整字段、示例与历史；英文指南明确为摘要，不冒充全文翻译。
- 公开 Catalog 的发布者文案仍保留原文，不把单语言接口宣称为多语言元数据。


## 2026-10-02 · 开放平台首版范围与文档导航修正

- 首版保持免登录的文档与介绍网站，账号及提交/管理功能另行讨论；现有插件图标为临时官方素材，后续跟随公共 Catalog 更新，不视为最终设计。
- 首页、插件目录和详情接入现有匿名公共 Catalog，以公开名称、版本、文案和素材为准；构建公开快照供首屏与刷新失败时使用，页面打开后无凭据刷新。不改变服务器权限、不以本地候选替代公开内容。
- 文档返回平台入口改由 VitePress 主题管理，完整导航离开文档路由；移除影响页内锚点的 base 注入，旧尾斜杠路径归一到原生文档路径。

## 2026-10-02 · 开放平台第一版本地站点

- 沿用已确认首页和品牌，新增15个本地插件的目录、appId详情与逐版本日志入口，以及三个场景、开发者页和现有23篇文档的本地整合。内容从 Manifest 与插件独立日志读取，保留未发布和缺失日志状态。
- 文档同步修正 README / CHANGELOG 的网站路由，保证客户端跳转与深链接刷新一致；文档增加返回平台入口，并修正窄屏长表格和中等宽度文档导航撑宽整页的问题。本次未部署域名、未接正式 Catalog，也未改造插件设置页或实现服务器自动撰写服务。

## 2026-10-02 · 开放平台品牌标识确认

- 用户确认外脑既有黑绿透明底括号脸（候选1）和 Driver 白色圆角底黑绿图标（候选3）。开放平台页头/页脚与 favicon 分别复用，保留形状及配色；根 AGENTS 明确禁止自造替代 Logo 或使用已废弃的旧绿色麦克风品牌标识（候选4）。本次仅修改当前项目本地原型，其他项目源码未清理。

## 2026-10-02 · 插件设置页底部入口与开放平台方向

- 确认[插件设置页、版本与关于入口规范 v1](plugin-settings-and-release-notes-v1.md)：全部插件在设置页底部展示版本及「关于插件」；版本取当前安装包 Manifest，点击定位对应更新日志，关于进入 `open.reai.com` 同 appId 的应用详情。
- 每次审核提交由开发工作流自动撰写 `plugins/<slug>/CHANGELOG.md` 中的版本介绍，基于真实差异与证据；候选、批准与公开发布分开，同版本重试不重复，历史版本保留。
- 新增 `open-website/` 用于开放平台首页方向与本地原型；现有文档未来迁往 `open.reai.com/docs/`。这是规范与设计确认，不代表所有插件已改造、服务器生成已实现或域名已部署。

## 2026-10-02 · 独立插件仓库本地迁移

- 官方插件、共享开发工具和开发文档迁入独立仓库：`plugins/`、`packages/`、`docs/`、`website/`。修正文档命令和链接路径，保留原 Host 规范与历史引用；没有改变能力、授权或分发合同。公开源码不代表插件审核、签名或上架已完成。

## 2026-10-02 · 送审预检切换已部署 Agent 功能合同

- 送审工具的默认合同升级至 `1.1@005a0f63-agent-features`；仅增加 `contributes.agentFeatures`，metadata i18n v2、能力及 probe 边界不变。
- 在途选项退役；旧 `1.1@31cf8889` 保留为显式 `legacy-31cf8889`，历史回执不冒充当前部署验证。身份、源码审核和最终包摘要校验保持严格。见[送审规范](plugin-submission-v1.md)。

## 2026-10-02 · 送审预检区分服务器字段基线与新版 Host Schema

- [插件上架打包与提交规范](plugin-submission-v1.md) 补充 Voice rc3 实际 `additionalProperties` 拒绝与服务器 `contributes` 白名单预检：默认已部署 `1.1@31cf8889` 拒绝 `agentFeatures`，源码和最终归档都检查。
- 新增显式 `agent-features-pending` 合同 `1.1@005a0f63-agent-features`，仅允许新增 Agent 功能声明字段；部署前回执始终标为 pending，不等同可上传。metadata i18n v2、未知字段、能力、probe 与既有安全检查不放宽。

## 2026-10-02 · 源码候选：当前账号的云转写有效价格

- `ai.models.list` 的转写项新增可选 `pricingContext: "current-account"` 与 `effectivePrice`：美元美分/秒的精确十进制字符串、基础价格、订阅或公开定价原因及规则/策略/订阅版本。`isDefault` 独立于是否零价，普通默认可能按量收费；不把套餐名或标签当价格证据。
- Host 通过现有认证和 scope 获取 schema3 账户报价，不复用匿名配置或跨账号缓存；每次执行重取报价。旧后端、不可信/过期报价或读取失败明确不可用，不静默猜免费。
- Voice 普通账户默认不永久写入 `free-only`；既有明确免费限定的同模型选择和录音重试继续保留，变价、缺价或收费后备均拒绝。用户明确换到另一项采用其普通计费策略，不转移旧模型限定。
- 价格为数值0时仍留存录音用量、零金额、订阅原因与价格版本；当前订阅价格改为0.1则普通请求正常收费。没有修改生产基础价或订阅政策。
- 本记录仅为源码候选；后端部署、SDK交付、正式插件冻结摘要审核及签名真实界面验收均独立完成，不继承旧候选结果。

## 2026-10-01 · 送审源码预审与运行批准分离

- [插件上架打包与提交规范](plugin-submission-v1.md) 增加显式独立源码审查证据入口；绑定身份、完整构建输入、审查报告和最终包摘要，提交前校验不再要求新增运行 seed。平台冻结包审核与签名批准仍独立执行。

## 2026-10-01 · 源码候选：可信免费云转写默认项

- 云模型列表的可选 `isDefault` / `billingPolicy: "free" | "metered"` 来自公开配置 v2 的显式零价默认项，不从名称、列表顺序或订阅权益推测。旧 v1 配置响应保持兼容；旧服务不提供可信免费默认时，不自动选择收费项。
- `ai.audio.transcribe` 与保存录音的选择快照增加可选 `billingPolicy: "free-only"`。Host 执行时刷新配置，后端对每次供应商尝试重新验证冻结零价报价；价格变化、缺失报价与收费后备均拒绝，重试保留免费约束。
- Voice 保留有效用户选择；首次、失效或移除的选择仅补选可信免费默认并保存。离线保留已选项并显示不可用，不自动切本地，不显示空白可选项。
- 此记录仅说明源码候选；后端部署、SDK发布及正式 Voice 审核打包分别验收，不代表当前运行包已交付。

## 2026-10-01 · Host API / SDK 1.24：有界大文件上传（外脑 #1559）

- `ctx.http.fetch` / 全局 `fetch` 对超过512KiB正文自动分块，经账号内暂存文件流送；保留原生 FormData boundary。50MiB文件、52MiB正文、256KiB分块，普通Bridge/响应1MiB限额不变。
- 复用 http.fetch@1、endpoint、用户同意与 Host OAuth；每 App 一个/每账号四个上传，runtime结束/取消/撤权清理，旧Host明确升级错误。
- 同步支持矩阵、CLI限额/独立候选1.3.0-upload.1、permission-contract与SDK/contract 1.24.0；新增文件完整性与清理回归。代码验证不代表签名客户端/生产 OAuth E2E完成。

## 2026-09-30 · rc.2.16 源码候选：语音阶段反馈与取回呈现确认边界

- 校准[接口参考的 reportStage / ACK 合同](plugin-api-reference-v1.md)：记录可选 `processing` 与最多 200 字符的 `label`、写入失败等待取回窗口可见后 ACK 的候选行为，示例先等待呈现成功再确认；保留处理中 60 秒无推进安全帽与其他失败规则。
- 明确旧 1.23 SDK 丢弃 `label`、旧 Host 对 `processing` 返回 false，以及旧失败计时与呈现回执的差异。Host API 仍为 1.23，本次仅修正文档，不提高安装门槛，不宣称旧 Driver 具备新反馈；源码候选不代表已发布或完成真机验收。

## 2026-09-30 · Host 行为：插件 Agent 配置页、固定入口与技能目录

- **设置二级页**：Host 新增「设置 › Agent 引擎 › 插件 Agent 配置」二级页（Host 命令 `agent_config_*`，host-only）。清单 = 已装 × 启用 × 声明 `agent.session@2` × 当前账号有效审批（每次重验签名），排除 pi-agent/dsh-agent 管理面。模型区首期只放 auto | text-default（合同未扩容前不出现假档位）；运行时四卡与插件侧 `backends()` 同源（含 `defaultBackendSource`）；提示词模板区呈现声明默认与参数槽（方案 B）；工具区 = 可调基集勾选（人话在前/工具 ID 等宽次行，勾选 ≠ 授权）；保存写前按同一口径复验。运行时锁定/技能超限如实只读或标注。
- **插件固定入口**：system task `agent-config` 落点接线——可信来源 appId 只取 live Bridge mount（无可信来源/来源停用即失败，不降级打开泛化设置页）；页面进入锁定模式（锁定标签、不可切换插件），来源插件停用/卸载即解除；返回上下文走既有 `system-task.return`。官方 Voice 设置页新增直达行（本地源码级；**送审滚锁不在本次范围**，生效需后续正常上架流程）。
- **只读技能目录**：用户可为插件选择一个本地 Markdown 目录作为技能候选（`agent_config_pick_skill_dir`，Host 设置页自己的选择器）。Host 扫描：符号链接拒绝（目录与条目）、预算 fail-closed（≤64 份/单份 ≤256KiB，超出 `AGENT_SKILL_DIR_TOO_LARGE` 不截断）、稳定排序、单份 >16K 字符标注不可勾选。功能级勾选在创建会话时展开为 inline `SkillDocument`（插件自带优先、按 id 去重），总量仍过 `session_spec` 的 8 份/32K/64KiB 信封闸；展开随创建时快照冻结——DSH 跨 spawn / Host 重启续跑不重读目录。换目录即整体重读，勾选重开不留幽灵。
- 稳定错误码新增：`AGENT_SKILL_DIR_{UNREADABLE,NOT_DIR,SYMLINK,TOO_LARGE}` / `AGENT_SKILL_NOT_FOUND` / `AGENT_SKILL_OVER_LIMIT`（已入 Voice 错误码登记表）。
- Host API 版本号不变（1.23 合同内落地）；源码合并不代表客户端已发布或真机验收完成。

## 2026-09-30 · Host 行为：插件 Agent 配置覆盖层生效核心

- **覆盖层存储**：账号目录新增 `agent-plugin-config-v1.json`（`app_id → {runtime?, features: {feature_id → {promptTemplate?, tools?}}}`，原子写、版本锁 v1）。坏文件 fail-closed：需要它的 v2 会话创建以 `AGENT_PLUGIN_CONFIG_CORRUPT` 报错（显式 runtime 不受影响，与全局偏好损坏同纪律），不静默回默认——防止用户关闭的工具/改过的模板被悄悄复原；损坏由配置页保存整文件重建修复。只对 `agent.session@2` 生效，v1 会话不读覆盖层。卸载即清账（重装不继承）。
- **`AgentConfig.featureParams`**（随 featureRef 出现/降级）：featureRef 模板的参数值。带参数时 Host 核验 `systemPrompt` 与「manifest 声明模板 + 参数」渲染结果**逐字节一致**，不一致以 `AGENT_FEATURE_PROMPT_DRIFT` 拒绝（单一事实源被强制执行）；用户覆盖模板时用同一份参数渲染（方案 B 完整落地）。参数缺失/越界为稳定错误（`AGENT_FEATURE_PARAM_MISSING` / bad_params）。
- **统一解析 `resolve_effective_config`**（bridge v2 创建口）：manifest 声明默认值 × 用户覆盖合并——runtime 锁定的功能在请求未显式指定时按声明锁定；工具勾选替换且必须 ⊆ `toolBase`（`AGENT_FEATURE_TOOL_OUT_OF_BASE`）。合并后的有效配置**原样**写入 ledger 与 DSH 边车：创建时快照成立，之后改覆盖层不影响已建会话（跨 spawn 恒定、重启续跑），创建响应新增 `configSources: {prompt, tools}` 标注生效来源。
- **引擎解析优先级**：会话显式 runtime > 插件级配置 > 全局默认链；插件级配置的引擎报 `selectionSource: "configured"`，`backends()` 新增 `defaultBackendSource: "global"|"plugin"|"corrupt"`。插件级配置的引擎视同显式选择（不自动准备，未就绪由既有引导如实报错）。
- Host API 版本号不变（1.23 合同内落地）；源码合并不代表客户端已发布或真机验收完成。

## 2026-09-29 · Host API / SDK 1.23：contributes.agentFeatures 与 featureRef（插件 Agent 配置 · 合同先行）

- 新增 Manifest 贡献点 [`contributes.agentFeatures`](plugin-development-v1.md#46-声明-agent-功能默认值contributesagentfeatureshost-api-123)：插件声明自己每个 Agent 功能的默认提示词模板（`{slot}` 参数槽，方案 B——用户以后在配置页覆盖的是模板文本，动态参数仍由插件创建时注入）、参数槽登记（`promptParams`）、可选引擎锁定（`runtime` 出现即锁定，如总结固定 DSH）与可调工具基集（`toolBase`，勾选不等于授权）。声明必须同时声明 `agent.session@2`，且 `hostApi.range` 下界 ≥1.23.0（旧 Host 的 deny_unknown_fields 会因未知字段整包拒装）；功能 id 匹配 `^[a-z][a-z0-9-]*$` 且 ≤64 字节（与 featureRef 引用域一致）；模板槽位未登记、语法不完整或越界限额在 Rust validator 与 CLI 同码拒绝——长度口径统一为 UTF-8 字节（id/参数名/模板），展示名/说明按字符数；限额进支持矩阵 `contributes.agentFeatures`（16 功能/16 参数槽/32 工具，模板 ≤16384 字节，`minHostApi: 1.23.0`）。Host 侧配置页 UI 与合并语义随后续版本接线，本条只落合同、校验与默认值事实源。
- `agent.session@2` 的 `AgentConfig` 新增可选 `featureRef`：指认本插件声明的功能 id，未声明以 `AGENT_FEATURE_NOT_DECLARED` 拒绝（身份取 Bridge mount，插件无法代报）。**兼容性**：旧 Host 的 deny_unknown_fields 会整包拒绝带该字段的配置——`backends().capabilities.configuration` 新增 `featureRef: true` 能力旗标（1.23 起，缺席即旧 Host），插件探测后再附带。官方 Voice 源码候选的 `hostApi.range` 抬到 `>=1.23.0`（声明 agentFeatures 后旧 Host 装不上，已批准锁产物 2.14.3 的兼容性停在 1.22、滚锁走送审），四个功能（命令/翻译/润色/总结）的默认提示词集中到 `src/agent-features.ts` 单一事实源、manifest 由 `scripts/sync-agent-features.ts` 同步生成（防漂移测试锁一致性），四处 `createSession` 按能力旗标降级附带 `featureRef`（双保险），行为逐字节不变。
- `system.tasks@1` target 白名单新增 `agent-config`（设置 › 插件 Agent 配置，锁定到来源插件）：SDK 类型、return-intent 校验、Rust 枚举、前端 api/快照白名单与落点映射五处同步；落点接线前导航按 `SYSTEM_TASK_NAVIGATION_BLOCKED` 诚实失败，不降级打开泛化设置页。
- `@reai/app-test` MockHost 同口径：v2 创建拒绝空白/超长 `featureRef`，backends 能力块宣传 `featureRef: true`。
- Host API / SDK / contract 版本 1.22.0 → 1.23.0；源码合并不代表客户端已发布或真机验收完成。

## 2026-09-29 · 设计规范 §3.6 第 5 条 + 新增 §3.7：进行中状态不抖动；下拉选择与清单联动

- [插件设计规范](plugin-design-system-v1.md) §3.6 新增第 5 条**「进行中状态不得引起布局跳动」**：控件在未开始 → 进行中 → 完成/失败之间换装时高度（或宽度）必须恒定——副文占位、min-height、骨架预留任选其一；同一屏多张卡时网格整体不得因一张卡进入进行中而重排（等高安装卡是基准做法）。
- 新增 [§3.7「下拉选择与清单联动」](plugin-design-system-v1.md)四条：① 原生 `select` 必须 `appearance:none` 组件化（自绘 chevron、颜色走主题 Token），不露浏览器默认箭头；② 下拉清单来自**运行态**（已安装插件 ∩ manifest 声明能力、目录实际内容），不写死；③ 上游变化要即时反映到下游（装卸增删、换目录整表替换）；④ 选项文案**人话在前**、技术标识降为次行等宽小字。§7 交付前自检同步补 3 条。
- 来源：插件 Agent 配置页设计稿 V1.9.0–V1.12.0 五轮迭代（`design/VoiceType_UI_Designs.html`）中提炼的通用理念；产品口径见 `design/DESIGN.md` §6.10（仓库内路径）。不改 Manifest、Host API 或 SDK。

## 2026-09-29 · 文档校准：README 能力清单对齐机器事实源；recommendedBindings 定性统一；圆角例外与 i18n 双口径显式化

- [README](README.md) §8 的 grantGated 清单由过时的「十五项」更正为与 `platform/contract/host-support-matrix.json` 一致的**二十五项**完整清单（补入 `agent.codex.tasks@1 / agent.dsh-observe@1 / agent.session@2 / local.files@1 / computer.engine@1 / tts.local@1 / developer.platform@1 / terminal.session@1 / surface.clipboard@1 / local.terminal.exec@1`），并声明**清单以该 JSON 为准**，消除与偏差 1 表格及[插件上架打包与提交](plugin-submission-v1.md) 25 项口径的矛盾。不改任何能力语义，纯文档对齐。
- [完整开发指南](app-development-guide-v1.md) §3 字段表与 `contributes` 首批清单：`recommendedBindings` 不再按目标行为描述，统一标注**已下线、非空声明即 `HOST_CAPABILITY_NOT_AVAILABLE`**（首批 Contribution 由五类改回四类）；`requires.hardwareServices` 行补注**首版实现非空即拒**（README 偏差 3）。消除与 §2 警告段、「绑定是用户的」章节的内部矛盾。
- [插件设计规范](plugin-design-system-v1.md) §4.2 圆角四档补**既定例外**：§3.2 图标按钮 32px 见方用 8px，不占档位、不计入「三种」上限；其余刻度外数值视为跑档。规范语义不变，把原有隐式做法写成明文。
- i18n 双口径显式化：[插件元数据 i18n v2 补充](plugin-i18n-metadata-v2.md) 开头与[插件上架打包与提交](plugin-submission-v1.md) 检查项互相指向——源码 Host 已支持 20 类 v2 目标，但线上提交基线只认 11 个 v1 目标，基线切换前上架包继续用 `metadata.i18n@1`。
- [插件设计规范示例页](plugin-design-system-v1.html) 顶部加快照横幅：交互示例为手工维护、可能滞后 Markdown 版，规范一律以 Markdown 为准（当前已知缺 §3.5 / §6.0 / §3.6 演示）。文档站侧边栏同步补上 `agent-service-v2`、`agent-controlled-run`、`plugin-agent-ui-i18n`、`plugin-i18n-metadata-v2`、`plugin-i18n-examples` 五篇的可发现入口（站点配置，不属规范正文）。


## 2026-09-28 · Host API / SDK 1.22（同版本并入）：Voice 胶囊可停到写入那一刻；插件运行时 WebView 不再被后台挂起

- `voiceInput.toggle` / `start` 新增可选 `holdOverlayUntilAck`：`mode: "input"` 会话识别结束后中央胶囊不再固定 1.2 秒收起，而是停在处理态（云端「正在转写」、本地「转写完成」），调用方写入成功后调 `acknowledgeResult(sessionId)` 那一刻收起；空结果、取消、Tab 层已消费或 Host 已直写时立即收起。新增 `voiceInput.reportStage(sessionId, stage)`（`voice.report-stage`，沿用 `voice.input@1`）：`transcribing` / `transcribed` / `polishing` / `translating` 只换胶囊那一句并计一次推进，`insert_failed` 切到失败态「文字没有写入」停 6 秒并结算待确认记录；同一次待确认里阶段只进不退，迟到的更早阶段返回 `accepted: false`；`insert_failed` 之后的确认只回收保留的回执、不收失败句，须等该上报实际返回再发。兜底仍按连续 60 秒无推进，到点切到失败态并弹出无文字失败卡、停 6 秒后收起。未声明的旧调用行为不变；更早的 1.22 Host 忽略该选项、拒绝新方法，调用方应吞掉错误。`@reai/app-test-kit` 的 MockHost 同口径实现。详见 [API 参考](plugin-api-reference-v1.md)。
- Host 行为：Voice 插件运行时以及在 `contributes.services` 里声明了 Web Runtime 服务（不带 Host `implementation`）的插件 WebView 关闭 WebKit 后台挂起（`inactiveSchedulingPolicy = none`），且只限可信安装来源（随包内置、商店 Catalog、dev-tools 插件开发 override；本地开发者包与无来源证据的旧记录不享受）。此前隐藏的运行时在等 Host 回包时会被挂起，回包到了也不醒，要等下一次 Host 主动 eval（例如用户再按一次键）才继续——表现为「录完要再按一次才上字」。其他插件 Surface 不变。插件无需改动。
- 不改 Manifest、不新增能力、不升 Host API 版本号；源码合并不代表客户端已发布或真机验收完成。

## 2026-09-28 · Host 行为：Agent 等用户拍板时不算超时，胶囊显示「等待你授权」

- 修复：回合里联网工具等用户启用浏览器插件、或越界访问等 Host 主窗口确认时，回合计时照走，等久了以 `AGENT_TIMEOUT` 失败；超时后挂起的安装请求还留着，事后启用会唤醒一个已经不存在的请求。现在等用户拍板期间 Codex / Pi / DSH 的回合超时、`agent.session@2` 任务的 600 秒上限、Pi / DSH 工具回调的连接上限全部暂停（回调连接只有鉴权通过后才享有暂停，鉴权前仍按真实时钟到点断开）；回合内的浏览器插件安装请求不再有 10 分钟决策上限（没有回合承载的请求仍保留）；越界确认不再有 120 秒上限（`expiresMs` 为 `0` 表示不自动过期）。回合结束或调用被丢弃时，挂起的请求随之撤销并收起提示。
- 事件与快照：新增 `wait.started` / `wait.ended` 事件（`kind: "waiting_user"`，带原因、说明、可直达的动作与结局），v2 运行中快照新增可选 `waiting` 与 `waitedMs`（本回合累计等用户的毫秒数，含仍在进行的等待）；SDK 类型同步（`AgentUserWait`），`waitForTurn` 在快照带 `waiting` 时不计等待截止，并按 `waitedMs` 顺延截止——用户同意后的第一张快照已不带 `waiting`，也不会误判超时。回合结束即视为等待结束：`wait.ended` 以 `cancelled` 收尾，插件应在回合终态时清掉等待展示。旧插件按 `type` 过滤会忽略这些新增项，行为不变。
- 胶囊：等待期间任务那一行显示「等待你授权：<说明>」并进入「等你确认」一组；主窗口不在眼前时投一次系统通知（插件来源的通知写明是哪个插件在等，不带用户原话），离开等待或任务终结即收回。自报呈现的插件（`taskPresentation: "caller"`）需要在 `present-task` 帧里带 `waiting: true` 才会亮起。
- Host API 版本号不变；源码合并不代表客户端已发布或真机验收完成。

## 2026-09-28 · Host 行为：语音命令转后台后不再误报「60 秒未收到结果」；Agent 联网结果引向 web_fetch

- 修复：语音命令超过 3 秒、以 `voice.command.present-task` 的 running 首帧交接到后台任务胶囊后，中央「处理中」胶囊只是被交接动画藏起，它的 60 秒安全帽仍在计时，到点会以 `VOICE_COMMAND_RESULT_TIMEOUT` 把胶囊重新弹出并留无文字失败弹窗——任务其实在后台正常跑着。现在交接完成（落地或 1.5 秒兜底）后 Host 按代次退役中央处理态和它的安全帽，此后的进度与结果只由后台任务出口负责（失败只标红、不弹窗、不给重试）。插件无需改动。
- 安全帽改为按「连续 60 秒没有任何推进」计时，不再按总时长：该插件的 Agent 回合有模型请求获准、工具调用开始 / 结束，或工具调用仍在进行（例如等用户装好浏览器插件），都会顺延。超时时胶囊与弹窗写的是真实等待时长。
- Agent 工具结果：`web_search` 与 `browser_observe` 的结果对象新增 Host 固定提示字段 `hostNote`，说明搜索只有标题 / 链接 / 摘要、页面观察不含正文，读正文应对链接用 `web_fetch`，不要为核实打开页面。每回合 8 次模型请求上限不变。Host API 版本号不变；源码合并不代表客户端已发布或真机验收完成。

## 2026-09-28 · 设计规范 §3.6：操作后立即反馈

- 插件设计规范新增 [§3.6](plugin-design-system-v1.md#action-feedback)，Host 与插件界面通用。凡是点下去要等网络、磁盘、Host 调用或其他进程的一次性操作：点击后 100ms 内按钮必须变样（进行时文案 + 禁用，实现上就是在第一个 `await` 之前改状态）；超过 1 秒在触发按钮下方显示真实进度，拿不到字节或条目计数时显示「当前阶段 + 已用时间 + 不确定进度条」，不许编百分比或按时间伪造进度；进行中禁止重复触发（禁用之外处理函数再挡一次）；完成与失败都有明确终态，失败按 [§6.0](plugin-design-system-v1.md#waiting-failure-minimum) 给原因、错误码、版本、可复制诊断和「重试」且不自动消失。附正反代码示例与不确定进度条样式（含减少动态效果）；§3.4 进行中一句、§6 加载态「超过 400ms 才显示」的适用边界同步说明；交付前自检加一条。
- [插件开发规范 §3.4](plugin-development-v1.md) 新增对应的交付门槛：第一次 `ctx.*` Bridge 调用之前按钮就要变样。
- 插件安装、获取、下载、更新和修复的准备阶段使用统一进度反馈。本条不改 Manifest、SDK、Host API 或 Token 注入合同。

## 2026-09-27 · Host API / SDK 1.22（同版本并入）：Voice 取回卡与结果面板带错误码、版本与复制诊断

- 按 [§6.0](plugin-design-system-v1.md#waiting-failure-minimum) 补齐 Host 自有的 Voice 浮层。`ctx.delivery.presentTakeback()` 与 `ctx.voiceCommand.presentAnswer()` 新增可选 `errorCode`（可选的小写反向域名命名空间加 `/`，再接字母开头、只含字母数字下划线的标识（≤ 64），总长 ≤ 100；例如 `com.example.app/STORAGE_READ_FAILED`、`AI_TIMEOUT`、`not_received`）与 `detail`（≤ 500 字，Host 只保留字数）；越界分别以 `VOICE_DELIVER_INVALID_REQUEST` / `BRIDGE_BAD_PARAMS` 拒绝。缺省时请求形状不变，旧 Host 忽略这两个字段；`@reai/app-test-kit` 的 MockHost 按同一规则校验。
- 取回卡与失败的结果面板显示错误码（缺省写「无错误码」）、原始原因的字数、插件版本与 Host App 版本，并提供「复制诊断」。诊断只由结构化字段组成：插件版本由 Host 按 appId 从已安装记录读取（插件自报的不采信）；`detail` 被视为不可信的自由文本，原文不显示、不复制、不转交浮层，只保留字数（「原始信息可能含用户内容，已省略（N 字符）」），不做正则清洗；复制文本不含识别正文、插件的标题 / 原因与结果原话。Host 自弹的取回卡按 commit 的原始 `reason` 查表给出原因句。
- Host 行为：前台 Voice 胶囊失败时只显示一句按真实错误码选的原因（不放错误码、版本或按钮），停留 6 秒（原 1.2~2.6 秒）；失败说明与诊断统一放进光标不在输入框时弹出的「取回文字」弹窗——有可取回文字时是原弹窗加诊断区，没有可取回文字的失败（识别失败、超时、链路中断）用同一个弹窗只放失败说明（按码查表的原因、按真实落盘回执的录音结论、恢复建议）与诊断区（码、原始错误文字的字数、版本、复制诊断）。命令处理态 60 秒内没有结果时不再静默收起，胶囊显示「60 秒未收到结果」、弹窗写明哪一步等了多久（`VOICE_COMMAND_RESULT_TIMEOUT`），迟到的结果仍能收掉两者。「继续」等待中显示已用时间，会话定位失败带码保留面板、不记已看过。Host API 版本号不变；源码合并不代表客户端已发布或真机验收完成。

## 2026-09-27 · Command 配对操作：旧版插件的按住绑定恢复为两次普通调用

- 修复兼容性回归：9/23 起 Host 把「按住开始、松开结束」绑定作为配对操作下发，而 SDK 对没声明 `supportsOperations` 的处理器直接拒绝，导致商店和内置的旧版插件（例如 Voice 2.12.37 / 2.12.38）长按没有任何反应。
- SDK 注册报告（`app.registered`）新增 `operationCommands`，列出以 `supportsOperations: true` 注册的 Command；Host 只认同时出现在 `commands` 里的项。
- Host 按按下那条命令决定整对的派发方式：声明了走配对操作；没声明时按配对操作出现之前的方式，按下、松开各发一次普通调用。旧方式下按下送达后不因松手取消，松开等按下结算完再送达。按下声明、松开没声明时，松开也发普通调用，并以新增的可选字段 `command.invoke.completesOperation` 带上原 operation id，SDK 据此释放按下保留的取消句柄。会话还在激活时 Host 先等注册报告到达再判断，不会把新版插件误当旧版。
- 已声明配对操作的插件行为不变。不改 Manifest，不升 Host API 版本；Host 与 SDK 运行时同一次发版。

## 2026-09-27 · Voice：原生应用看不到焦点元素时照常粘贴（修复微信写不进去）

- 修复回归：微信 4.x 等原生应用的输入框不向辅助功能暴露焦点元素，事前判断把它当成「原生应用明确无焦点 = 确定没有输入框」，没粘贴就返回 `not_editable` 并弹取回卡。现在看不到焦点元素一律算拿不准、照常粘贴，成败交给取件回执：真没有输入框的应用不来取件，照样返回 `not_received` 并弹卡；前台开着安全输入时仍拒绝。
- 仍会事前拒绝的只剩有正面证据的情况：缺辅助功能权限、前台为空或为 Host（含 Host 的 Dock / 菜单栏身份代理进程：它没有窗口、看不到焦点，原先靠「原生无焦点」顺带拦住，现在显式算 Host 自身）、按钮 / 静态文本 / 菜单等非输入控件（AXValue 可写的除外）、禁用的文本控件、密码框、安全输入且拿不准。请求参数、返回字段与错误码集合不变，不升 Host API 版本；源码合并不代表客户端已发布。

## 2026-09-27 · 设计规范 §6.0 补充：不许把失败说模糊、超时写明哪一步、诊断带 Host 版本且不含敏感内容

- [§6.0](plugin-design-system-v1.md#waiting-failure-minimum) 补四点：失败、超时、被拒绝不能改写成「已取消」「已结束」「暂无结果」或静默收起，「已取消」只留给用户自己取消，拿不到错误码如实写「无错误码」；超时写明哪一步、等了多久，错误码能区分出这一步；插件诊断同时带插件版本（取 `app.manifest.json` 的 `version`）与 Host App 版本（`ctx.systemTasks.getVersionStatus()` 的 `app.currentVersion`，需声明普通开放能力 `system.tasks@1`，调用方 Surface 须有 Host 的有效展示记录、同一界面 2 秒一次），复制出的全文必须自带版本与生成时间；复制文本不得含 token、Cookie、密钥、授权头、签名 URL 参数以及完整的用户输入、转写、对话正文，原始错误同样过滤。插件复制走 `ctx.clipboard.writeText()`（`surface.clipboard@1`），没有这项能力或复制失败时给可选中的文本兜底。
- §6 状态表「失败」一行改为错误码与原始原因放在可展开处，与 §6.0 一致；交付前自检加一条。本条不改 Manifest、SDK、Host API 或 Token 注入合同。

## 2026-09-27 · Voice：同一写回目标的重复提交回放首次结论；收尾错误不再误报「已取消」

- 修复：Input 会话对同一 `targetId` 重复 `voice.deliver.commit` 同一段文字（调用方重试 / 重复请求）时，第二次拿到 `expired`，Host 因此误弹「取回文字」卡——文字其实第一次已写入。现在首次提交有结论后，同文字 + 同 `behavior` 的重复提交原样回放首次结论（成功即 `committed: true`，不再写第二次、不弹卡；失败回放同一原因）；换文字、换 `behavior`、首次仍在执行中、超时或被新录音替换仍返回 `expired`。
- 修复：录音收尾遇到 AI Board 音频链路中断、云端留音频入槽失败时，`finish` 如实返回 `VOICE_SOURCE_UNAVAILABLE` / `VOICE_AUDIO_UNAVAILABLE` 并显示错误浮层，不再被改报成 `VOICE_CANCELLED`。
- 请求参数、返回字段与错误码集合不变，不升 Host API 版本；源码合并不代表客户端已发布。

## 2026-09-27 · 设计规范：等待与失败的最低信息量

- 插件设计规范新增 [§6.0](plugin-design-system-v1.md#waiting-failure-minimum)，Host 与插件界面通用：等待要说清在做什么（具体对象、有可数进度时给「第几个 / 共几个」、已用时间，不用假进度或只转圈）；阻塞整页的等待与失败界面能看到版本号；失败与超时给真实原因（本地化主句 + 可展开的原始原因与错误码，超时说明后台是否仍在继续）；文案写了「查看诊断」就必须真的能打开，至少列出各对象状态、最近错误的原因与代码、日志位置并可一键复制；中英文同时提供。交付前自检加一条对应检查。
- Host 参照实现是内核门禁页（`AppLifecycleRecovery.vue` + `KernelDiagnostics.vue`）。本条不改 Manifest、SDK、Host API 或 Token 注入合同。

## 2026-09-27 · 上架预检默认改按线上新合同 1.1@31cf8889

- 开放平台后端已上线：Manifest 合同基线升到 `1.1@31cf8889`，`requirements[].probe.id` 新增 `codex-app-server-v2` / `pi-agent-v2` / `dsh-native-v2`，审核员可批准能力目录扩到 25 项（新增 `agent.session@2` / `surface.clipboard@1` / `local.terminal.exec@1`）；i18n 目标枚举不变。
- `scripts/plugin-submission.ts` 的默认合同 `current` 改为这份线上合同，回执为 `local-preflight-passed`。旧基线 `1.1@c3475cb` 删除（已无节点执行，新合同只增不减）；`--server-contract native-v2-pending` 退役，传入即报错并提示去掉开关。开关机制保留，留给下一次后端在途合同。
- 本条只改本地提交工具与规范，不改任何插件的 Manifest、版本或能力批准记录。

## 2026-09-27 · Voice：云端识别的命令会话同样按 sessionId 确认收起中央胶囊

- 修复 Host 合同缺口：带 `retainAudio: true` 的 `mode: "command"` 会话（云端识别）识别结束后也留待确认记录，调用方转写、写回后按原 `sessionId` 调 `acknowledgeResult` 即收起中央「处理中」胶囊，不再落空等 60 秒安全帽或下一次录音。本地识别、输入模式与 `retainResultUntilAck` 会话的确认语义不变，调用方、`sessionId` 与胶囊代次三重校验不变。

## 2026-09-27 · 设计规范：按钮四周都要留白

- 插件设计规范新增 [§3.5](plugin-design-system-v1.md#button-padding)：凡是悬停 / 按下会铺底色、常显描边或底色、焦点框画在按钮盒子上的按钮，文字到背景边缘四个方向都必须留白。标准文字 / 链接 / 图标 + 文字按钮左右 ≥ 8px、上下 ≥ 4px；紧凑按钮（字号 ≤ 11px 的密集工具条、列表行内小按钮）下限 4px / 2px；图标按钮（含标签页上的关闭钮）用固定方形尺寸居中。
- 写明贴边对齐的做法（等量负 margin 抵消，文字不挪位、只让悬停背景外扩）、例外（刻意的纯文字链接可以不留内边距，但必须在样式旁注明且焦点框用正 `outline-offset`；整行可点的列表行；开关与滑块）与正反示例；交付前自检加一条对应检查。
- Host 注入的 Token 仍然没有间距 Token（只有颜色与 §1.1 的布局安全区）：插件写数值或自起别名；Host 自有界面用 `shell-adapt.css` 里的 `--btn-pad-x` / `--btn-pad-y` / `--btn-pad-x-compact` / `--btn-pad-y-compact`，它们不注入插件。本条不改 Manifest、SDK、Host API 或 Token 注入合同。

## 2026-09-27 · Host API / SDK 1.22（同版本并入）：识别与插入解耦、命令会话可写回、迟到结果框

- 识别只返回文本，不再产出「插入事件」；是否写回由调用方业务分支决定（Agent 结果永不写回，由插件保证并有合同测试守住）。`voice.input@1` 的 `insertText` 标为弃用、本阶段仍生效：缺省 `true` 时 Host 仍对 `mode: "input"` 会话本地直写（为锁定的旧版插件保留，旧插件退役后移除）；新调用方传 `insertText: false` 后自己 `delivery.commit`。
- `voice.deliver.commit` 不再按会话模式拒绝：`mode: "command"`（翻译 / 转文本）会话的凭证同样写到交付那一刻的当前输入框。Command 会话写回失败 Host 不自动弹取回卡，由调用方呈现。Host 录音开始时对两种模式都准备插入适配器。
- 识别结果新增可选 `consumedBy: "tab_layer"`：Tab 层展开期间的输入听写由 Tab 层语音搜索消费，Host 同时撤销该会话写回凭证，随后的 commit 返回 `expired` 且不弹取回卡。
- `voice.command.present-answer` 新增可选 `deferred: true`（迟到结果框：任务转入后台胶囊后才完成的结果）：被动显示、不抢键盘，用户点击后才成为键盘焦点；Voice 录音 / 识别期间或面板被占时按先后排队；不收中央浮层。用户关闭（或点「继续」）= 已看过，Host 按 `runId` 撤掉同一会话后台任务的胶囊行、Tab 层待办与通知未读，因此 `runId` 须为该任务 `taskId`，并应先报终态帧。旧 Host 忽略该字段、按即时结果面板呈现。
- `@reai/app-test-kit` 新增 `consumeNextVoiceResultByTabLayer()`，模拟被 Tab 层消费的识别结果与凭证撤销。锁定的 Voice 2.12.37 过渡期内：翻译 / 转文本开始真正写回当前输入框，翻译 3 秒内仍会同时弹结果面板（新版插件滚锁后只写回）。源码合并不代表客户端已发布或真机验收完成。

## 2026-09-27 · Host API / SDK 1.22：Voice 三个方向都落盘，落盘与识别并行

- 按 2026-09-27 Voice 链路定稿「输入法、翻译、Agent 三个方向都存切片原始音频」：握着 `voice.recordings@1` 时，`mode: "command"` 的录音也落回听片段，结束结果同样带 `replayClip`；`listRecoverableInputSessions`（含 `includeSettledRetries`）仍只列输入法录音，命令录音只能按 id 回听、查询（`getInputSession` 返回 `mode: "command"`）或重转。`RecoverableVoiceInputSession.mode` 类型相应放宽为 `"input" | "command"`。走 `retainAudio` 的命令录音与输入法一样以 `pending` 落盘，调用方云端识别结束后须按 `replayClip.id` 回写 `setInputSessionTranscription`（成功或失败），否则停在 `pending` 直到下次启动归为 `failed`。
- 结束结果新增可选 `replayClipStatus: "saved" | "not_retained" | "failed"`，把「按策略没留」和「落盘失败」分开报；旧 Host 不返回。`failed` 只表示本次结果拿不到片段引用，超过 3 秒上限的那段仍可能稍后入库，有没有声音以恢复列表与按 id 取件为准。落盘与识别并行，识别不等落盘，落盘失败只影响回听、不影响识别与写回。`@reai/app-test` 的 MockHost 两种模式都返回 `replayClip` 与 `replayClipStatus`。
- Host 内部：录音开始时的无障碍树预热与润色上下文来源窗口采集合并为一处，所有录音会话都做：来源窗口在开始时钉住（只问 WindowServer），预热交给后台、不阻塞录音；两者都不参与插入目标选择。请求参数、权限与错误码不变；源码合并不代表客户端已发布。

## 2026-09-27 · Host API / SDK 1.22：Voice 写回改为事前判断 + 剪贴板取件回执

- 起因：文字已写入 Electron 输入框，但回读确认超时被判失败，仍弹「取回文字」卡。macOS Host 删除整套回读确认（不再读输入框的值与选区），成败只看目标应用是否在约 1 秒内来取剪贴板。本条取代下方 2026-09-26「只判断一次输入框」的交付方式（其失败门日志字段随回读确认一并移除）。
- `voice.deliver.commit` 的失败原因新增 `not_editable`（事前判断确定光标不在可输入位置，未粘贴）与 `not_received`（已粘贴但无人取件）；`focus_changed` 保留在联合类型中供旧 Host 使用，新 Host 的当前输入框写回不再产出；主线程 150ms 内没能写剪贴板归 `insert_failed`。插件应对未知原因保留文本、显示中性说明。
- 事前判断：按钮 / 静态文本 / 菜单等非输入控件、禁用文本控件、密码框、前台为空或为 Host、原生应用明确无焦点元素 → 不粘贴；网页 / Electron / 容器类与拿不准的情况照常粘贴。光标处插入与替换选区由目标应用原生完成，Host 不读不设选区、不激活应用。
- Host 本地直写失败也弹一张 Host 取回卡（与插件 commit 路径同一张）。过渡期锁定的旧版 Voice 插件在写回失败时仍会弹自己的页内卡，新版插件滚锁后消失。
- `@reai/app-test-kit` 的 `setNextVoiceDeliverCommitReason` 可注入两个新原因。源码合并不代表客户端已发布或真机验收完成。

## 2026-09-27 · Voice 时间线：暂停只停全天记录，松键尾部最多 3 秒

- `voice.timeline.set-paused` 语义收窄为「暂停全天记录」：只停持久录音落盘与后台转写，不再清空热环 / 运行期缓存、不再释放 Board 常驻租约；暂停期间 Voice 录音会话（含经 Voice 发起的 `request-text`）照样带按下前的音频，前置气口随本次会话的回听片段按保留时长保存。板载常驻缓存是 Host 的工程优化，任何用户开关都不停它，只有安全开关、Voice 停用与链路不可用会停。
- 线协议不变：暂停时 `AudioTimelineStatus.state` 仍为 `paused_by_user`；但 `hotRingDurationMs` / `cacheDurationMs` 会继续增长，`unavailableReason` 如实反映采集链路（可能非空）。插件不应再以这两个时长为 0 判断「已暂停」。按范围取件的口径不变：暂停期间按 `timeline_paused` 拒绝，暂停期间的音频任何时候都不会被取走，恢复后暂停前那段按 `cache_cleared` 拒绝。
- 按键语音松开时人还在说，Host 最多再收 3 秒（原 1.5 秒）。插件无需改动。

## 2026-09-26 · 上架预检补齐后端 probe 与受控能力合同

- 提交规范在 i18n 目标之外再按开放平台线上合同检查 `requirements[].probe.id`（只认四个 v1 probe）与「Host grantGated 且审核员可批准」的受控能力目录（22 项）。后端在途的 `1.1@31cf8889`（三个 v2 probe 与 `agent.session@2` / `surface.clipboard@1` / `local.terminal.exec@1`）只能用 `--server-contract native-v2-pending` 显式启用，默认不放宽，回执标为待后端上线。
- 本条只改本地提交工具与规范，不改任何插件的 Manifest、版本或能力批准记录。

## 2026-09-26 · Voice 写入瞬间只判断一次输入框

- macOS Host 改为剪贴板准备好后、发送粘贴前只判断一次当前输入框：常见控件 3 次 AX 询问（原约 20 次），判断后立即投递、不再二次复核；取消 250ms 总预算，改为每次询问最多等 100ms，不回答即视为没有可写输入框。
- 判断与投递之间不再复核：判断期间在同一应用内换了输入框时，文字会写进新输入框但仍报失败并弹取回卡。判断期间系统安全输入由关变开（焦点进了密码框）时放弃写入；Voice 临时写入剪贴板的内容带 TransientType 标记，遵守该约定的剪贴板历史工具不会记录（实时读取剪贴板的程序仍可能看到）。失败门日志新增 `secure_input_engaged`、`empty_paste` 与取事实方式 `facts=batch|per_item`。
- 录音开始的无障碍树预热、完整值 / 区段 / 镜像 textarea 回读确认保持不变；无法读取当前值的控件照旧不自动写入、走取回卡。响应字段、错误码与权限不变；源码合并不代表客户端已发布。

## 2026-09-26 · Driver 最低系统改为 macOS 14（Apple Silicon）

- `host-support-matrix.json` 的 macos 支持下限与 `runtime-dependencies-v1` 的 WebKit/WKWebView 最低系统口径由 11.0 改为 14.0：2026-09-26 产品拍板（原因：托管 Chromium 最低要 13；主界面 WebView 按账户持久隔离的存储要 14，低于 14 退化为无痕）。Apple Silicon 均可升级到 14，不排除硬件。
- Driver 构建侧 `MACOSX_DEPLOYMENT_TARGET` 同步为 14.0（由 `REAI_BUILD_PRODUCT=driver` 选择，release 预检仍强校验与 tauri.conf.json 一致），正式发布额外校验 App 内全部 Mach-O 的 minos 不高于 14.0。Preview 遗留产品线仍按 11.0 编译。
- 插件侧无需改动；Manifest 的平台 targets 语义不变。

## 2026-09-26 · Host API / SDK 1.21：直接目录、工作范围内命令与单次越界确认（F02 / F03 / F04）

- `workspace` 新增 `{ kind: "direct", path }`：只接受本插件经 `system.folder-pick@1` 授权的目录，直接读写原目录不经镜像；`app-private` 申请文件 / 命令工具时由 Host 分配独立工作根（不是整个数据目录）。`mounted` 镜像语义不变，旧会话不自动转换。
- 六个文件工具在三种工作区都可授予（catalog 标签泛化为 `workspace-read` / `workspace-write`）；新增 `command`（`/bin/sh -c`，仅 direct / app-private + yolo，macOS Seatbelt 限定只能读写工作范围与本次临时目录），与 `run` 一样要求 `local.terminal.exec@1` 双层授权；镜像会话不放行 `command`。会话工具上限 16 → 32；DSH 模型声明含 8 个固定内部工具，总量上限 40。
- 范围外访问先生成 Host 单次确认：许可绑定插件 / 账号代际 / 会话 / 回合 / 工具调用 id / 完整动作摘要，单次消费，120 秒超时；拒绝、关闭弹窗、过期、取消、撤权都不授予访问。插件只有只读 `agent.session.approvals.list` / `agent.v2.session.approvals.list` 与 `approval.requested` / `approval.resolved` 事件，**没有批准方法**。
- 切换账号后，旧账号的任务不能进入新账号的执行记录。文件与命令操作须满足当前账号的工作区授权。
- 插件只能在获准的工作区范围内读写文件和执行命令。超限或拒绝读取时，`grep` 明确返回 `truncated: true`。
- 明确路径沙箱的外部进程边界：命令自身及后代不能创建硬链接；已有范围内外文件权限的非沙箱同 UID 进程若在运行期主动注入硬链接，命令仍可能经范围内名字读写该 inode。direct / app-private 均不承诺抵御这种外部原生进程篡改，启动前扫描不等于持续隔离。
- `backends()` 的 `capabilities.scopedExecutionVersion: 1` 与 `commandExecution` 表示当前平台实现；字段缺席不能视为支持。`createSession` 返回 `workspace` / `workspaceRoot` / `scopeVersion`。新增稳定错误 `AGENT_SCOPE_STALE`、`AGENT_SCOPE_LIMIT`、`AGENT_SCOPE_PLATFORM_UNSUPPORTED`。
- 命令结束时其进程组与观察到的全部后代（含主动 setsid 脱离、凭进程组找回的）都会被停止；Host 异常退出后下次启动按 pid + 启动时刻清理残留。为避免误杀无关进程，组扩展前后必须有完整身份匹配的已跟踪成员，失去锚点即停止追索。边界：中间进程即使曾被观察到，若退出时孙进程未入账且组内无已知成员，孙进程仍可能残留。常驻服务池（用户同意后转入、独立页面管理）尚未实现。
- Voice 2.13.1-rc.1：对话内切换 Pi / DSH / Codex 只续接有界可见聊天，不迁移工具动作、隐藏状态或用量；新增 `system.folder-pick@1` 与 `local.terminal.exec@1` 声明；仅新增精确 publisher / version 的源码审核记录，不代替发布包摘要授权或 Catalog 发布。

## 2026-09-26 · 上架预检对齐服务端 i18n 目标枚举

- 提交规范增加开放平台 Manifest `1.1@c3475cb` 的 i18n 目标检查：仅接受 11 个 v1 目标，提前拒绝 `storeListing.*`、`permission.purpose`、`requirement.displayName` 等 v2 目标。
- Codex Link 0.5.12 使用 `metadata.i18n@1` 提交，商店展示文案由提交表单维护；本条记录不代表 Host 移除 `metadata.i18n@2` 支持，也不替代最终包校验或商店审核。

## 2026-09-26 · 官方程序共享与账号数据隔离

- Driver 新装官方 runtime 与插件原始程序按签名摘要放入公共程序目录，同一系统用户的多个 ReAI 账号可复用文件，免去重复下载。账号安装状态、授权、版本选择与用户数据仍隔离。
- 启动校验以 Host 公钥验证的原始收据和完整文件树为依据；账号卸载不清理公共版本，开发 override 保留私有目录。旧安装迁移分阶段交付，源码合并不代表签名客户端发布或真机验收完成。

## 2026-09-26 · Voice 交付时选择当前输入框

- `deliveryTarget` 保持原有不透明 ID / TTL / 单次认领合同，改为会话交付凭证；录音开始与停止均不采集输入目标。最终文本交付时短暂检查当前可写输入框，发送前复核控件与选区。
- 移除停止、取消、换会话与清理路径的 AX 冻结及旧焦点恢复，原生工作全部在交付的阻塞任务中完成。250ms 准备预算超时即放弃，发送后仍以独立回读确认作为成功依据。
- Input 无目标或写入失败继续弹取回卡；Command/语音任务继续显示结果，不自动插入。权限、响应字段与错误码保持兼容，旧 Host 的目标选择时机可能不同。源码合并不代表客户端或插件包已发布。

## 2026-09-24 · Host API / SDK 1.21：三层 Agent 服务 v2

- 新增 `agent.session@2`：统一 runtime/config 输入、持久请求身份与标准输出；省略 runtime 使用全局默认，v1 接口兼容。
- 记录 `startTurn` 短提交、`waitForTurn/getTurn/events` 查询、幂等重试、真实 turnId、取消、过期与中断边界；v2 全生命周期不要求同时授予 v1。
- 明确当前只开放外脑 OAuth、text-default、文本输出与 inline 说明文档；生成参数、JSON 约束和原生按需技能明确拒绝，不静默忽略。
- 说明 Router 只做协议转换、原版 runtime 拥有工具回路、统一工具目录与授权执行器，以及 buffered 交付和真实用量口径。

## 2026-09-23 · 浏览器联网工具的安装后续跑边界

- 澄清插件新能力安装仍须用户确认后进入下一回合；已获授权的 Host 浏览器联网请求在用户独立安装并启用浏览器插件后，可恢复同一次挂起调用，不替 Agent 新开回合，也不允许模型自行安装插件。

## 2026-09-22 · Command 通用配对操作

- `commands.register` 可声明 `supportsOperations`，按 operation id 处理 start/end；旧处理器在执行前拒绝新 operation，普通 Command 兼容。
- start 结算后保留取消信号到 end/cancel，覆盖副作用已发生而 Host 尚未收到结算的窗口。设备层拥有手势及配对，插件仅持有业务会话。

## 2026-09-21 · Driver 无订阅按量使用与余额读取

- 新增「订阅、积分与云服务」说明及文档站导航：无订阅不构成云服务禁用条件，积分不足由服务端计费拒绝。
- 说明正式 Driver 的 `billing:read`、旧会话重新授权、个人团队余额范围与毫积分换算；该权限不向普通插件开放。
- 更新云错误文档：旧订阅错误码保留兼容，不再引导用户先买订阅；区分源码合并与客户端、插件、文档站发布。

## 2026-09-20 · 状态条主题与 AI 回复排版验收

- 设计规范新增状态条的主题变量、半透明背景与明暗切换验收，纠正“App 内不会触发 fallback”的绝对表述，记录不存在的变量名导致深字深底的真实案例。
- 新增 AI 回复 Markdown、HTML/URL/图片边界、长代码与表格适配要求，以及源码、plugin-dev 验收包、已批准 Catalog 包的证据区别。

## 2026-09-19 · Host API / SDK 1.20：受控剪贴板写入与开发者模式快照

- `surface.clipboard@1` 从 withheld 收敛为 grant-gated，只开放 `clipboard.writeText` 纯文本写入；不提供读取、富文本、图片或文件，单次正文上限 256 KiB。
- SDK 增加 `ctx.clipboard.writeText(text)` 与只读 `ctx.environment.get().developerMode`；读取失败由插件按关闭开发者模式处理。`ctx.environment.onChange(handler)` 订阅当前运行会话的实时模式变更，返回取消订阅函数；旧快照不得覆盖更新的事件。
- `AgentSendResult.runtime` 保留字符串形态，返回本回合实际执行的 `dsh` / `pi` / `codex`；独立的可选 `channel: "external-brain"` 表示实际模型调用渠道，不能由引擎名称推断为订阅渠道。
- 可选 `usage: { complete, inputTokens?, outputTokens?, totalTokens? }` 按一次 `send` 累计真实模型用量，各回合独立。只有完整统计可展示三个计数；缺失、无效或失败/取消/超时不能补零或把部分计数作为合计，统计不完整时省略计数，尚无统计也可省略 `usage`。
- Voice 随每条 AI 回复保存实际引擎、渠道及用量快照，历史恢复不受当前设置影响；旧记录的单独 `totalTokens` 不视为完整统计。详细合同见 `plugin-api-reference-v1.md` §10.7。

## 2026-09-19 · `host.log` 按 label 公平限流

- Host 日志回传由单一全局窗口改为单 WebView label 100 条/秒 + 全局 500 条/秒两层门禁；一个界面的死循环不再挤掉其他插件的诊断信道，原有全局磁盘保护边界保持不变。
- 支持矩阵同步登记每 label 与全局配额、最多 1024 个跟踪状态及 60 秒闲置回收；Host Rust 直接读取这份矩阵，不再维护第二份数值。

## 2026-09-19 · Bridge 按运行会话限制并发

- `plugin_bridge_invoke` 现在按 Host 生成且插件不可伪造的 `runtimeSessionId` 统一限制在途请求；上限直接读取支持矩阵 `inflightRequestsPerRuntime`（当前 32），第 33 个并发请求返回稳定码 `BRIDGE_TOO_MANY_INFLIGHT`。
- 名额由请求 guard 在所有成功、错误、提前返回及取消出口自动归还；计数归零即删除会话条目，不会因已结束会话持续累积账本。

## 2026-09-18 · Bridge 入向消息统一限额

- `plugin_bridge_invoke` 在进入任何业务分流前，统一按 `params` 的 JSON UTF-8 序列化字节执行矩阵 `bridgeMessageBytes`（当前 1 MiB）限额；超限返回稳定码 `BRIDGE_MESSAGE_TOO_LARGE`。
- 该门禁发生在 Tauri 已完成命令参数反序列化之后，只阻止后续业务、落盘与广播放大，不承诺阻止首次 JSON 解析。

## 2026-09-18 · `http.cancel` 内部清理合同纠偏

- `http.fetch@1` 的权限 `bridgeMethods` 仅保留公开方法 `http.fetch`；`http.cancel` 明确为 SDK `AbortSignal` 使用的内部清理控制消息，需来自有效插件 mount / Bridge 会话，且只能取消当前 App 自己的在途请求。生产 dispatch 与 SDK 公共 API 不变。

## 2026-09-18 · `system.folder-pick@1` 稳定错误码补登记

- 支持矩阵与 SDK 同步登记 `FOLDER_PICK_VISIBLE_SURFACE_REQUIRED`、`FOLDER_PICK_RATE_LIMITED`、`FOLDER_PICK_ALREADY_OPEN`、`FOLDER_PICK_FAILED`；Host 由同一张 Rust 常量表驱动合同检查，避免实现与公开清单再次漂移。
- 原生目录面板只挂到当前可见且未最小化的主窗口；窗口状态不可读时改为无父窗口弹出，避免阻塞面板占住全局单开闸。

## 2026-09-18 · 提交身份 publisherId 官方保留形态实读澄清

- `plugin-submission-v1` 身份表「发布者 / Team ID」行澄清：Manifest `publisherId` 必须与产品后台 Publisher 精确一致——Team UUID，或平台保留官方身份 `reai`（2026-09-17 Terminal 产品卡片实读：服务端以同一 `product.publisher_id` 做 freeze 比对并注记 `official_reserved`）；非保留产品不得写成 `reai`，新团队也不得保留示例值。
- 提交身份规则：保留身份产品使用 `reai`，团队产品使用 Team UUID。
## 2026-09-18 · Codex backend 档位统一接入 + Codex Link cwd 授权闸（Agent 统一化 M3 第三批）

- Codex session backend 接入 Spec.mode：chat/plan = read-only sandbox + 文件工具白名单（三路同判），yolo 收敛为 workspace-write 且 cwd 指向镜像 worktree（镜像内自由写 + 按档位写回，不再 dangerFullAccess 直写）；owned-tasks 的 untrusted 逐项确认形态保留不回退。
- Codex session 的动态工具目录补齐六个文件命令定义（按 Spec.tools 过滤，仅挂接会话实际可用）。
- Codex Link（`codex.start_thread`）的 cwd 补授权闸：必须是调用方插件经 `system.folder-pick@1` 授权过的目录（或子目录），与「folder-pick 即授权」统一；任意绝对路径不再直通。
- 三 backend 的 `capabilities.fileTools` / `turnModes` 统一为 `true` / `["chat","plan","yolo"]`。

## 2026-09-18 · agent.session@1 镜像文件命令与三档写权限（Agent 统一化 M3 第二批）

- 挂接会话的 `tools` 可声明标准 CLI 命名的文件命令 `read`/`write`/`edit`/`list`/`glob`/`grep`：agent 以为直接操作文件，实际被 Host 拦截重定向到 git worktree 镜像（路径禁闭镜像根，穿越与符号链接逃逸 fail-closed）；AppPrivate 会话声明被拒。
- `SessionSpec.mode` 三档写权限上线（缺省 `chat`，封闭词表）：chat 只读、plan 只写 plan 类 md（文件名主干含 plan）、yolo 镜像内自由写；写回按档位（chat 不写回 / plan 只写回 plan 类 / yolo 全量），冲突 fail-closed 且文件清单进 `send` 结果的 `mirror` 字段。
- Pi / DSH 的能力描述符 `fileTools` 翻为 `true`、`turnModes` 报 `["chat","plan","yolo"]`；Codex 的统一文件工具接入在后续批次，此前声明文件命令创建被拒。
- SDK：`AgentTurnMode`、`AgentFileTool`、`AgentSendResult.mirror` 增量字段；旧 Spec JSON 无 `mode` 零迁移。

## 2026-09-18 · agent.session@1 目录挂接 Workspace v2（Agent 统一化 M3）

- `SessionSpec.workspace` 新增 `mounted` 形态：`{kind: "mounted", path}` 挂接用户目录，路径必须命中本插件经 `system.folder-pick@1` 原生面板选出的授权（「folder-pick 即授权」，插件不能自授），未授权返回稳定码 `AGENT_WORKSPACE_NOT_AUTHORIZED`。
- 挂接后 Host 在 App 数据目录内为会话建 git worktree 镜像：agent 的文件改动先落镜像（改动前自动 commit，可回溯回滚）；写回用户目录带冲突检测，用户侧漂移与镜像改动相交时 fail-closed（`AGENT_MIRROR_SYNC_CONFLICT`），不覆盖任何文件。
- 新增稳定错误码 `AGENT_MIRROR_GIT_UNAVAILABLE` / `AGENT_MIRROR_FAILED` / `AGENT_MIRROR_SYNC_CONFLICT`（镜像层依赖系统 git）。
- SDK `AgentSessionSpec.workspace` 类型更新为联合类型；`app-private` 行为不变。CLI 兼容文件命令（read/write/edit/list/glob/grep）与三档写权限在 M3 后续批次进入合同。

## 2026-09-18 · agent.session@1 终局 envelope 对齐三 backend（M1 复审修正）

- Pi 已开跑回合的超时与取消不再以 JSON-RPC error（`LOCAL_AGENT_TIMEOUT` / `LOCAL_AGENT_CANCELLED`）透传，统一折成 envelope `timeout` / `killed` 终局，与 DSH/Codex 一致；任务胶囊终局同源（timeout 红卡、killed 撤卡）。回合未分发即被拒仍是服务级错误。
- `failure.stderr_tail` 的 wire 口径对齐 DSH 的 512 字符尾部：envelope 不再把尾部二次截到 200 字符（此前深位稳定码会被吞掉）；`message` 保持约 200 字符的展示上界，机读分类请检索 `code` 与 `stderr_tail`。
- Mock Host 的 `agent.backends.list` 补 Codex 条目（与真实 Host 的 pi/dsh/codex 三条目对齐；Codex 默认按「本插件未授权」的保守值呈现——真实 Host 只对建立自身引用边的插件报可用），并新增 `setAgentCodexStatus` 场景切换。

## 2026-09-18 · `voice.deliver@1` 新增 `present-takeback`（取回文字卡片）

- 写回失败后插件可请求 Host 在 Voice 胶囊正上方弹出系统级「取回文字」卡片：
  `{ title, reason, text }` 全部由插件按自己的 i18n 映射好后送来，Host 不认识业务词汇，
  只负责「显示在哪、什么时候撤下」（呈现归 Host、语义归插件的呈现合同同款）。
- 文案长度有界（title ≤ 200、reason ≤ 300、text 复用写回 32k 上限），超限返回稳定码
  `VOICE_DELIVER_INVALID_REQUEST`；不支持该方法的旧 Host 以 `HOST_CAPABILITY_NOT_AVAILABLE`
  拒绝，两种情况调用方都应吞掉（呈现是尽力而为）。
- macOS Host 同步把写回目标固定为 B→A 链路（停止录音那一刻的可写焦点优先，
  恢复不了再回到开始那一刻的焦点，录音中间路过的焦点不参与），并在写入瞬间
  前台正聚焦安全文本框（密码框）时拒绝抢焦点、直接判定不可恢复。
- SDK `CloudDeliveryClient.presentTakeback`、Mock Host 与接口文档同步。

## 2026-09-17 · agent.session@1 终局与事件流版本化 envelope（Agent 统一化 M1）

- `agent.session.send` 返回扩为 `{schemaVersion: 1, turnId, text, failure}`：`failure` 结构化为 `{kind, code, message, retry, stderr_tail?}`；`kind`（engine/killed/timeout）与 `stderr_tail` 保持历史字段名，旧消费方零迁移。稳定码 `AGENT_ENGINE`/`AGENT_KILLED`/`AGENT_TIMEOUT`，`retry` 为三层重试语义（none/same-session/new-session）。
- 进度事件统一带 `schemaVersion: 1`；事件类型为封闭词表（turn.started、message、tool.start/end/outcome、turn.settled），backend 产出子集不同，插件不得假设事件必达。
- `agent.backends.list` 每项增加 `channel`（external-brain 外脑云代理 / codex-subscription 订阅渠道，后者词汇先入合同）与 `capabilities`（hostTools/fileTools/turnModes/modelSelection）；fileTools 与 turnModes 在目录挂接 + 镜像 + 三档写权限（M3）落地前恒为保守值。
- SDK 类型与 Mock Host 增量同步；`plugin-api-reference-v1.md` §10.7 补三段合同说明。

## 2026-09-17 · 运行时依赖最低系统对齐 macOS 11（Apple Silicon）

- `runtime-dependencies-v1` 的 macOS 前端运行时（WebKit/WKWebView）最低系统口径由 10.15 订正为 11.0：2026-09-14 产品拍板（BLK-08/REQ-03）后仅支持 Apple Silicon（M1+），Intel / 10.15 不再支持。
- 同步 `host-support-matrix.json` 的 macos 支持下限与 Driver 构建侧 `MACOSX_DEPLOYMENT_TARGET=11.0`（release preflight 强校验与 tauri.conf.json 一致）；Preview 遗留产品线不在本次范围。

## 2026-09-15 · @reai/agent-ui 实例级语言入口

- 共享聊天 UI 库新增 `createAgentUiI18n` 与组件 `i18n` 选项：消费者用 Host locale 快照与自己的 `assets/locales/*.json`（plugin-i18n-v1 同构资源）创建实例注入，`setLocale` 原地更新已挂载节点。
- 覆盖状态药丸、任务锚点状态、工作卡耗时、已确认提示、图片占位、我方头像、输入坞按钮/aria/占位、待确认坞提示、拖宽手柄提示与 `formatDuration` 时间格式；不注入实例时逐字保留历史中文默认，旧调用零改动兼容。
- 语言更新不重建组件、不触发业务回调，保留输入/光标/焦点/滚动/折叠/计时/已回答状态；实例间互不污染，dispose 后不再更新。新增 `plugin-agent-ui-i18n.md`（API、资源键映射与接线示例）与共享包 DOM 测试。

## 2026-09-14 · 插件提交身份与最终包预检

- 新增上架打包与提交规范：区分插件 App ID、OAuth Client ID、Team publisherId 和 Product ID；明确 `universal` 属于提交 artifact，Manifest 保留平台/架构 targets。
- 新增 `scripts/plugin-submission.ts`，核对源与包内身份、版本、PNG 图标、语言资源、文件摘要及两次构建一致性，生成含产品关联的提交记录。
- 提交配置显式记录版本，新增 `--form-version` 拦截表单 `1.0.0` / 包 `0.2.0` 不一致；交付说明提供可复制填写值，回归测试纳入 PR CI。没有实际表单值时不宣称已核对远程草稿。
- 补齐版本占用、图片与 Host 图标区别、文件归属、路由记录 ID、报价、幂等恢复及人工能力审核；源码合同与线上状态分别核对。
- 打包交付、上传、付费提交、审核和公开上架分别记录；复用已有产品和草稿，避免同一个坏包反复提交。

## 2026-09-14 · Voice 结果写回错误分类

- `voice.deliver@1` 的失败结果新增 `insert_failed` 与 `accessibility_permission_required`，分别表示一般平台失败和真正缺少系统辅助功能权限；原 `denied` 保留为目标拒绝及旧 Host 的中性兼容值。
- SDK、Mock Host 与接口文档同步；插件权限仍使用原稳定异常码。一次提交/取消/焦点冻结行为未改变，不自动重试。
- 明确 `committed` 是平台投递回执，不能替代目标文稿变化的真机验收。

## 2026-09-13 · Host API / SDK 1.20：事务 KV 与本机 Service 委托

- 增加 storage.compareAndSet，缺失/null 区分、锁内落盘、失败回滚与损坏文件保护。
- 增加 apps.gateway@1：当前账号的回环 HTTP、独立范围连接、无秘密 handle 列表、撤销及 Service 冷启动/取消。业务角色、Schema 与证据由插件验证。
- SDK、Mock Host、现代 wrapper/Host Manifest 样例同步；本地安装需要同名用户权限和 apps.service@1。Gateway 校验在非冻结的 `reai-app-i18n` validate/build/pack 链路执行；保留旧 CLI 源码与已批准产物锁。

## 2026-09-13 · Host 与插件语言包规范收尾

- 明确 Host 维护唯一界面语言，插件通过 SDK 读取、订阅并释放监听；标准资源支持后续扩展语言，切换保留输入、任务与原文。
- 新增 `metadata.i18n@2` 的九类本地展示目标，覆盖详情、权限用途与依赖名；安装确认读取同次 prepare 的候选资源，权限 ID 和审批摘要不变。旧 v1 包保持兼容。
- 提供 Voice、Codex Link、Codex App 三个官方样板；严格校验声明、资源、插值与最终 ZIP。其余插件由各自开发者提供语言包，远端 Catalog 内容及已批准产物保持原来源。

## 2026-09-13 · G6 云端网络与订阅错误分类

- 新增 `AI_NETWORK_ERROR`、`FLOW_NETWORK_ERROR`、`AI_SUBSCRIPTION_REQUIRED`、`AI_SUBSCRIPTION_UNAVAILABLE`，Host、SDK 常量与机器支持矩阵同步。
- 仅按状态匹配的嵌套网关稳定码识别订阅，错误体有大小/时间上限并安全回退；连接失败、服务不可用、订阅与额度失败分开。
- 保持 SDK 小写 taxonomy、错误信封、版本及锁包。Voice 固定双语消费覆盖生成、润色、摘要、云转写和失败回执；本次代码合并不等于插件制品发布。

## 2026-09-12 · Voice 录音期间跟随输入目标

- macOS Host 按输入控件跟踪录音期间的最后有效焦点，停止时固定；原生交付验证目标并单次消费。
- 本地直写、云端转写和翻译共用交付目标与取消门禁；原生准备不阻塞语音状态锁。
- 明确约 100ms 的无通知采样边界、浏览器选区的尽力恢复、旧 Host/其他平台兼容行为。
- 失败说明只陈述未写入和文字保留，不推断焦点变化发生在润色期间。

## 2026-09-12 · Voice 失败录音来源与云端选项

- 为 `RecoverableVoiceInputSession` 增加可选 `requestedEngine`，由 Host 随录音保存，旧数据维持未知。
- 明确失败状态、成功正文与本地重新转写入口的显示边界。
- MockHost 对云端转写复现真实 Host 的选项校验，拒绝旧占位 ID 和未列出的档位。

## 2026-09-12 · Host API / SDK 1.19：已有 Input 音频重转写

- 新增 `voiceRecordings.getInputSession / transcribeSavedInput / cancelSavedInput`，冻结每次选择并持久保存 attempt/revision 回执，取消和晚到结果按同一尝试隔离。
- 恢复列表可包含已完成的重试，覆盖 Host 成功但插件保存失败；旧接口不能覆盖新尝试。失败、取消、空识别保留原文，重启中断不自动重复云调用。
- 已保存音频复用现有有效区间、本地模型与插件 OAuth 云通道，无硬件采集或焦点写入；SDK、版本矩阵、错误码和 MockHost 同步。详见接口参考“已保存的 Input 录音重新识别”。

## 2026-09-10 · 语音胶囊显示类型提示

- 为 `voiceInput.start` / `toggle` 文档补充可选 `overlayKind: input | translate | task`，用于区分前台胶囊标识。
- 明确提示不改变 input/command 的采集、写回、权限或结果语义；未传时按原 mode 显示，旧 Host 忽略提示。
- 当前属于配套 Host 与 Voice 候选实现，正式内置插件锁未更新；需匹配候选包完成真机验收，不能仅凭字段或版本号宣称业务贯通。

## 2026-09-10 · Voice resumable model downloads

- Document the optional `VoiceModelInfo.resumeAvailable` field and retained `downloadedBytes` semantics for cancellation/restart recovery.
- Existing methods, state enum and permissions remain compatible; older Hosts without the field do not promise resume support.
- Clarify cancellation completion, manifest-bound recovery, complete digest validation and explicit retry after an unsupported byte range response.

## 2026-09-10 · 能力复用与调用边界

- 明确 Host 触发映射、插件服务调用、最终结果与控制回执、单一交付责任和全局呈现边界。
- 增加 Voice 消费示例与文档导航，要求复用已有录音、识别、Agent 和任务机制。
- 区分已实现 App Service、Voice 实现候选和仍规划的 Agent 扩展；同步修正当前边界清单与侧栏名称，避免同页相互矛盾。本次不变更 API 或运行时代码。

## 2026-09-09 · Codex Agent Session 后端候选

- `ctx.agent` 增加显式 `backend: "codex"`：使用受管 Codex app-server、插件 OAuth 与 Wainao 模型通道，支持文本和授权 Host 工具；新手引导和设置增加三引擎选择，安装信息从签名目录读取；先调用 `backends()` 检查可用性。
- 首版限 macOS ARM64，要求调用插件自己的 Codex 资源引用；会话隔离、取消、删除和任务呈现沿用统一接口，未设置默认偏好时 `auto` 依次选择 DSH/Pi/Codex，明确偏好不可用时报错。
- Codex 会话与安装/修复日志分别存入独立文件，回退旧版后 DSH/Pi 仍可继续安装和修复；早期候选版混合日志会在新版启动时迁移，先保存 Codex 再清理旧文件。
- 明确 600 秒执行预算、有界上下文及不支持的输入。当前仍是候选，正式资源目录发布和具有合法开发授权的 B 真实模型验收尚未完成。

## 2026-09-09 · Host API 1.18 云端转写选项

- `ai.models.list` 返回后台启用的动态转写选项及随 Host 界面语言显示的名称，后台默认项排在转写选项首位，仅供首次选择使用。
- `ai.audio.transcribe` 使用列表中的选项 ID；省略时使用后台默认项，已保存选项被删或禁用时必须重新选择，不静默替换。旧开发期 `transcribe-default` 不再支持。
- Host 按公开配置向网关提交 `driver-asr:<optionId>`，不透出实际模型 ID 或供应商；权限、插件身份和计费边界保持不变。SDK/Host API 更新到 1.18.0，保持现有 1.x 插件范围兼容。

## 2026-09-09 · 插件设置项的说明、反馈与分隔

- [插件设计规范 §6.1](plugin-design-system-v1.md#settings-content-layout)明确 title + description 的两行层级、4px 间隔与 16px 内边距，以及 title + feedback 的内缩 divider 和上下各 12px 留白。
- 条件失败策略使用中性文字分组；真实保存失败、权限受阻单独呈现，禁止无语义虚线套框、贴线说明及按 `:last-child` 推断反馈分隔。
- 设计示例补充三档切换和异常状态；要求按明暗、窄窗、长文案及实际插件产物核对视觉，不以文案测试替代。

## 2026-09-08 · Host Tab/Action 管理与本人同步接口

- 设置聚合实际提交项，Tab 显示偏好本地持久化，Action 取消/撤销复用注册清单并同步变化。
- SDK 增加 actionItems.onChange、tabItems.onChange/isVisible；通知携带版本与双会话身份，按 appId 定向。
- 文档补充首次读取、失效通知、disposer 与旧 Host 兼容。批准插件需独立重打包/审核/发布，不能用源码测试代替产物验收。

## 2026-09-08 · 插件语言资源与 Host 静态元数据

- 新增独立 `@reai/app-i18n-cli`（`reai-app-i18n validate/build/pack`），检查严格 UTF-8 JSON、重复键、语言叶键/插值、静态元数据引用和实际封包字节；冻结旧 CLI 与已批准插件工具链。
- Manifest 新增可选 `i18n` 声明；Host 安装/重启复核资源摘要，插件名、侧栏、标题栏、Tab 来源、Action/键位命令在显示时切语言，不修改稳定 ID、用户内容或执行状态。
- 兼容旧包默认文字，动态任务内容由插件现有 locale API 负责；代码支持、工具链发布、插件审核与真机验收分别记录。


## 2026-09-08 · 安装授权交互简化与过期恢复

- “详情”点击即打开，授权快照读取期间显示加载状态；同会话已确认且未过期的详情可直接查看，继续安装仍重新准备并比对完整快照。弹窗初始焦点落在标题，键盘导航保留焦点提示。

- 开发指南同步已验收设计：授权勾选默认选中新声明、保留已有拒绝，首次设置以详情保存选择、继续时实际安装授权；无授权直装。
- 明确过期与快照变化重新确认、错误保留重试入口；简化界面不改变 Host 授权账本、网络范围或 OAuth 校验。

这里记录所有会影响插件设计、开发、接口使用、发行或运行边界的规范变化。

从 2026-08-21 起，修改 `platform/docs/` 下除本文件外的任一规范文件或已跟踪 HTML 导出时，
必须在同一提交或 Pull Request 更新本日志。`websites/docs/` 的同步与构建命令会自动检查；缺少日志时
发布门禁直接失败。

日志只写开发者需要知道的变化，不记录内部评审过程、确认清单或未进入规范的草稿。

## 2026-09-08

### Tab 与 Action 插件接口说明订正

- 订正 Action 菜单的数据来源：只展示用户挂载的快捷方式，不自动展开全部 Manifest 命令。
- 补充现有 `ctx.actionItems.mount/unmount/list` 用法、命令与 Skill 的声明要求、持久化和插件身份边界。
- 明确当前 SDK 尚无挂载变化订阅，不能把 Host 内部事件当作公开 API；聚合设置管理仍在设计阶段。

## 2026-09-07

### F04 Voice request-text implementation candidate

- Added [Voice request-text](voice-request-text.md): text-only service results, trusted caller/account ownership, cancellation and screenshot consent boundaries.
- Voice candidate adds independent translation target settings and default light polish while preserving existing raw choices. Approved artifacts and factory seed remain unchanged; signed-App and independent OAuth acceptance are pending.

### 插件语言包 v1

- 新增[插件语言包规范 v1](plugin-i18n-v1.md)：固定包内 `assets/locales/zh.json` 与 `en.json`，同键同命名插值，框架自由。
- 插件只跟随 App，切换保留业务状态；新发布版本补齐中英文，旧版包保持可用。
- 明确 CLI 自动检查和 Host 静态元数据解析尚未实现，不将文档规范生效等同于运行时支持。
- 统一公共术语、覆盖与最终包验收，Voice 按同一规范迁移。

## 2026-09-05

### Host API 1.17：Host 录音路由权限（本地候选，尚未发布）

- `voiceInput.checkPermissions()` 增加 `microphoneRequired`，由 Host 既有路由权限规则计算；保留真实系统权限状态。
- 原生 Board USB HID/BLE 不请求系统麦克风，显式系统输入与 UAC 兼容仍要求授权，包括权限被拒后不可用的 UAC。
- Voice 2.12.27-k02.1 声明 `>=1.17.0 <2.0.0`；旧 Host 缺字段时给出升级说明。request-text 的取消与晚到授权隔离保持不变。

### Host API 1.16：界面语言环境（本地候选，尚未发布）

- Host 提供持久化的跟随系统、简体中文与 English 界面语言选择，独立于语音识别语言和翻译目标。
- SDK 新增只读 `ctx.locale.getSnapshot()` 与即时回放的 `onChange()`，让已打开、后台和后打开的
  插件接收当前语言；插件自行使用成熟 i18n 引擎维护 zh/en 资源，不需要新增权限。
- 保持旧初始化信封兼容；需要兼容旧 Host 的插件应可选访问 `ctx.locale`，直接依赖此接口时须声明
  Host API 最低版本 1.16.0。切换语言应更新既有界面，不重建 Surface 或清空业务状态。
- 设置页与 Titlebar Actions 示例正文提供最小接入；静态插件元数据及其余首发路径仍待后续覆盖，
  本地候选不代表 SDK 已发布或完整签名客户端验收通过。

## 2026-09-01

### 官方 Driver 开放开发者平台 F3A 管理能力

- Host API 新增仅向签名官方 Driver 系统插件开放的 `developer.platform@1`，固定提供 Team、Project、
  开发期 Scope、Product 创建/列表与 Client 详情六个方法；插件不能提交任意 URL、Header、Bearer、
  publisher、packageAppId 或 owner 身份字段。
- 正式 Driver 使用独立的 `developer:platform` OAuth Scope 和区域 readiness；CN 可在后端 Scope、官方
  Host allowlist 与签名包证据齐全后独立开启，Overseas 未完成同区证据前继续 fail closed。
- Product 创建要求 Host 生成并保管 `Idempotency-Key`，请求 body 只含 Project、名称、用途与 Scope；
  SDK、Test Kit 与 Developer Center 共用同一组严格 DTO 和稳定错误码。

### OAuth endpoint 隐式匹配与显式选择语义统一

- 插件省略 `endpointId`、由 Host 按组件、origin、路径和 HTTP 方法命中 `oauth_app` endpoint 时，
  与显式选择该 endpoint 一样使用插件自己的 Host 托管 OAuth 凭据；插件始终拿不到令牌明文。
- 显式 `endpointId` 仍可用于消除重叠声明的歧义；严格网络、同源、重定向和权限复核规则不变。

## 2026-08-31

### 插件开发态 OAuth 与公开态隔离

- Catalog/public 与 LocalDeveloper/development 使用同一个插件 OAuth Client，但 Host 按模式与 draft
  revision 分开保存授权；Manifest `appId`、OAuth Client ID 与发布版本继续保持三层独立身份。
- 开发态通过当前 Host 账号读取 `delegated-development` metadata，并在授权与运行时校验体验者资格、
  draft revision、scope 和 redirect 快照；体验者被移除或草稿切换后，下一次云能力调用立即拒绝。
- OAuth token 始终由 Host 代签和保管，插件只能经 `oauth_app` 网络能力使用，不能读取 Host 或插件令牌明文。

### App、插件、设备统一生命周期 Hooks

- 新增 `lifecycle-hooks-v1.md`，规定 App 启动、插件启停/修复和设备 connection epoch 的稳定阶段与版本化 Hook envelope。
- DSH/Pi 基础服务 ready 必须包含已验证 payload、固定 probe 与调用 App 的精确引用边；恢复态保留设备、固件、权限、设置与诊断，不以 shared active 冒充 per-app 授权。
- 受管资源修复继续复用 Host 的 prepare/consent/commit 事务，下载、校验、probe 与提交阶段提供真实进度；启动 reconcile 不允许静默授权。

### Host 设置动作增加可见的往返开关规范

- Host 已登记为导航开关的插件设置动作在设置页保持按下，暴露 `aria-pressed="true"`，并把可访问
  文案切换为“返回插件首页”；再次点击仍投递同一可信设置 intent，由插件按当前页面切回根页。
- 按下态只在插件完成返回并 `reportNav(null)` 后解除；仅 intent 投递不能冒充页面已返回。插件仍须为
  面包屑声明 `commands@1`，Host-only 返回命令应从键位动作选择器隐藏。未登记的标题栏动作行为不变。

### 官方插件增加独立 plugin-dev profile

- 官方插件在 macOS 可用 `make plugin-dev-builtin PLUGIN=<slug>` 单独打包，再用 `make plugin-dev-run
  PLUGIN=<slug>` 在签名 Driver 中调试；Windows 使用 `pwsh -File
  .\scripts\run-driver-v2-plugin-dev.ps1 -Plugin <slug>` 串起确定性打包、完整 acceptance 资源、带
  `dev-tools` 的本地 Host 构建与 exe 启动。本地覆盖按包摘要生效，不依赖插件版本号或正式 seed。
- plugin-dev 使用独立账号、设置、插件数据、会话、日志、Voice 模型和浏览器存储，首次需要单独登录；
  只共享按摘要校验的 runtime 归档。结构化数据和可变模型在 instance 目录；shell、OAuth 与 Browser
  WebView 各走 profile store，启动脚本与 `plugin-dev-profile-info.ts` 会打印精确清理位置。普通 Driver
  与 plugin-dev 仍争用同一硬件锁，不能同时访问 HID/BLE/音频；普通 Driver 的既有受管浏览器 store
  ID 保持不变。
- 历史 `dev-tools + REAI_DRIVER_V2_INSTANCE_DIR` 仍只适合无副作用并行验收，不可当作真实硬件验收；
  macOS 的主窗口和受管浏览器完整存储隔离在 plugin-dev 下要求 macOS 14+，更旧系统会拒绝启动。

### 运行组件精确修复入口与内置更新自愈

- `system.tasks.open` 白名单新增 `app-managed-resources`：Host 根据当前 live Surface 注入来源 appId，
  精确打开该插件的已安装详情并聚焦“运行组件”区；没有可信来源时拒绝导航，插件不能提交 appId、
  selector 或内部路由。
- 内置插件更新会在切换包摘要前迁移已经批准且仍兼容的受管运行组件引用；旧版 Host 造成的断边也会
  仅凭既有授权与已验证不可变包离线恢复，不重新下载、不静默扩大同意范围。

### 示例插件改为独立交付包

- Todo、Titlebar Actions 与 Codex/Claude Skin 样例从 Driver 源码树迁到
  `plugins/examples/`；每个样例独立维护 `package.json`、`bun.lock`、测试、类型检查、校验、构建、
  合同测试与打包命令，不再借用 Driver workspace。
- 仓库验收会先打包 Platform 依赖，再把样例复制到仓库外，用冻结 lock 重复完整工具链、两次确定性
  打包和真实 Host 安装生命周期，证明文档中的开发方式能脱离 monorepo 工作。
- Skin 样例也按普通插件包管理；开发者模式安装来源、选择、卸载后的 Aura 回退与重装均经过 Host
  集成测试。插件身份、包格式与公开 Host API 保持不变。

### 插件平台从 Driver 工程拆分

- SDK、CLI、合同测试包、机器可读 contract、fixtures 与开发者文档迁入独立 `platform/`
  workspace；包名、Host API 与 `.reaiapp` 合同保持不变。
- 本地仓库开发可暂用 `file:` 目录依赖，交付门禁会先 pack 平台包，再到仓库外临时目录安装并执行
  validate、build、contract-test 与 pack，避免把 monorepo 相对路径误当成第三方可用能力。
- 旧 `docs/app-platform-v1/` 只保留跳转页；公开 `/docs/` URL 不变。新文档、Skill、CI 与应用内
  开发文档入口统一指向 `platform/docs/`。
- Host 安装烟测改用 `platform/fixtures/apps/install-probe`，不再借用 Todo 产品示例。

### Claude Code 集成迁移到统一集成目录

- App 生成式 Claude Code 集成的规范引用从旧插件目录切换到
  `integrations/claude-code/app-generated/`；Hook 行为与 Node → jq fallback 合同不变。
- 文档站工程迁移到 `websites/docs/`，公开 `/docs/` URL 与规范正文来源保持不变。

## 2026-08-30

### Host API 1.15：官方终端改为权限插件

- Terminal 现在是通过 App Store 安装的真实 `.reaiapp` 界面插件；PTY、默认 Shell、进程回收和
  有界输出仍由 Host 托管，旧 Host 终端产品入口不再对用户开放。
- 新增 `terminal.session@1` / `ctx.terminal`，插件只能创建、列举、挂载、输入、调整、重启和关闭
  自己拥有的会话，不能指定 executable、argv 或环境变量，也不能访问其他插件的会话。
- 该能力同时要求 Manifest capability、同名用户 permission 与机器可读管理员审批记录；当前只批准
  随签名 App 交付且版本、发布者、来源和包摘要完全匹配的官方 Terminal，第三方默认不开放。
- 能力本身保持通用合同，不按 `appId` 在执行路径硬编码；未来第三方开放仍复用同一审批模型和安装授权界面。
- 迁移为插件不构成界面改版授权；官方终端继续以 `design/VoiceType_UI_Designs.html` 和迁移前已验收
  版本为唯一界面基线，插件保留标签、分栏、窗格头、精简态、状态栏与既定操作入口。开发规范同步
  增加通用规则：任何已有页面插件化时都不得自行另做“简化版”界面。
- 通用 `titlebar.action@1` 合同扩展为最多 3 个动作、`default` / `outlined` / `danger` Host 样式、
  `square` 图标与可选 `titlebarStatus` 状态胶囊；能力仍对所有合规插件平等开放，不按终端 appId 硬编码。
- 终端 1.0.1 新审核记录与 1.0.0 历史记录并存，已安装旧版在升级前仍能通过精确版本与包摘要复核，
  不会因为发布新版本就被误判为“能力未审批”。

### 插件顶部交界升级为基础视觉硬规则

- 顶部全宽 Surface 只允许两种模式：同色背景连续铺开且不增加装饰性间距，或把异色 Surface
  内缩到正文留白内；桌面默认留白 `16px`、紧凑布局最低 `12px`。
- 禁止颜色不同的 Title Bar 与正文大色块零距离硬切；1px 分割线不再视为足以完成分层。本规则
  取代 2026-08-28 的“按需补低对比度边界”建议。
- Host 仍完整拥有 Title Bar DOM 与交互。插件只能在自己的 Surface 使用主题 Token，并需在浅色、
  深色主题下验收最终合成色、接缝和留白；设计规范、开发规范、完整指南与配套 HTML 已同步。

### 本地配音采用固定 Host Service executor

- 官方本地配音 Provider 可声明 `implementation: "host:tts.local@1"`，调用时由 Host 直接执行 TTS，
  不再隐藏启动 Provider Web Runtime 或依赖 Provider 侧 JavaScript handler。
- Consumer 仍只声明 `apps.service@1` 与 Service 依赖，不获得 `tts.local@1`；WAV 通过绑定 provider、
  caller mount 与 correlation 的一次性 60 秒结果凭据领取。
- 插件日常配音界面的长文本由 Host 托管 Audio8 helper 按句分段，在同一模型实例中合成并拼接成单个
  WAV；不会把超过模型单次自回归窗口的内容静默截断。
- 未声明固定 Host 实现的 Service 保持原有通用 Provider handler、并发、超时与取消合同。

### Direct 受管运行时与 `requirements` 1.2 子集落地

- Host/Schema/CLI 现在接受强类型 `managed_executable` Requirement；插件只声明稳定 `resourceId`、
  兼容范围、用途和安装策略，URL、摘要、发布者、签名者与 probe 实现仍由 Host 信任边界掌握。
- Direct Profile 增加签名目录与 LKG、`.reairuntime` 安全解包/逐文件校验/平台签名/注册探针、
  插件+资源复合 journal、断点续传、空间预检、单飞、可选依赖稍后修复、引用边与安全 GC。
- Codex/Pi/DSH 从基础 Tauri resources 移除，运行路径改由受管资源 Registry 解析；缺资源时 Host 仍启动，
  相关能力返回可解释的依赖错误。单 `web-surface` 限制不变。
- 生产公钥、签名 Catalog、CDN 制品、公证与 Windows Authenticode 仍是发布门禁；未完成这些外部门禁
  不得宣称线上按需安装已经可用，Store 渠道也不得借 Direct 路径绕过审核。

### 插件开发从设计阶段遵守三层交付边界

- 插件开发规范、完整指南、运行依赖与发行策略统一增加“App 主体 + `.reaiapp` + Host 受管资源”的
  目标分层：它约束运行职责和安装、更新、回滚、卸载生命周期，不强制源码拆成三个目录或仓库。
- ReAI 受管 runtime 与 `optional_external_tool` 明确分开：前者不回退 PATH、用户 Node/Bun、外部
  checkout 或 profile；后者仍由 Host 做无副作用探测，并且只能由用户明确触发安装。
- 本条记录的是规范 PR 合并时的代码基线；同日后续实现已由上一节更新为 requirements 1.2 与 Direct
  受管资源一期。单 `web-surface` 限制仍保留。
- 2026-08-28/29 日志中的“DSH 始终内置/随包”描述的是当前物理交付方式，不是长期包体承诺；DSH
  继续由 Host 作为共享基础服务拥有，透明度插件不拥有其 runtime 生命周期。
- 三份 Markdown 规范把交互版明确标为可能滞后的 HTML 快照；Markdown 与机器可读事实源继续优先。

## 2026-08-29

### Agent 联网工具依赖由用户明确安装

- `ctx.agent.requireToolDependency(...)` / `agent.tool-dependency.require` 用于在 Agent 聊天能力卡中，
  由用户明确安装 `web_search` / `web_fetch` 所需的浏览器插件依赖；模型不能静默发起安装。
- 联网搜索与网页读取仍由 Host 的独立工具执行，不打开浏览器界面；浏览器插件作为用户可理解的
  联网能力入口，并与实际浏览器操作保持不同的工具边界。

### Host API 1.12：DSH 透明度插件头部与新会话模型设置

- DSH 仍是软件始终内置的底层 runtime；`com.reai.dsh-agent` 仍是用户按需安装的普通 Apps 插件，
  不新增“系统能力”分类，也不把 runtime 生命周期交给插件。
- 插件遵循 Host Title Bar 合同：标题栏动作收口为设置与单一刷新，正文不再重复大号 DSH 标题或
  第二个刷新；顶部低对比度分隔线只声明在该插件自己的 `main-body`。
- `ctx.dshObserver` 增加 `settings()` 与 `updateSettings(modelAlias)`，唯一写入范围是之后新会话的
  默认稳定模型档位；已有会话不改。设置页复用 snapshot 只读展示随软件运行的 DSH 组件，不提供
  安装、停用、卸载或升级。
- `agent.dsh-observe@1` 的 permission purpose 与商店披露同步扩大；已安装 1.1.0 的用户升级时会
  看到 `PendingExpansion` 并重新确认，builtin sync 不会静默扩权。

## 2026-08-28

### 插件顶部视觉边界：默认无边框、按需判断

- Host 白色 Title Bar 默认不画底边，插件也不需要统一补线。
- 只有正文顶端的大面积色块或有色背景直接相接且视觉不佳时，插件才自行判断是否在自己的
  `main-body` 增加低对比度边界；该建议仅供参考，不是平台强制规范。
- 若决定增加，边界必须留在插件 Surface 内，不能通过 Host DOM/CSS、标题栏伪元素或全局样式
  影响 Host 页面和其他插件。开发规范、设计规范、完整指南与配套示例页已同步这一口径。

### Skin v1 独立皮肤插件

- 新增 `packageType: "skin"`、`skin.apiVersion` 与固定 `skin/skin.json` 入口。皮肤复用 `.reaiapp`
  安装与审核事务，但没有 Runtime、权限、网络、OAuth、私有数据或普通插件贡献。
- Skin v1 提供 `left-rail`、`top-bar-bottom-dock` 两种结构，`console`、`editorial` 页面编排，
  导航顺序、尺寸、密度、圆角及 39 个明暗 semantic token；禁止任意 JS/CSS/HTML 和外部素材。
- 未安装外部皮肤时设置页不显示皮肤选择；安装后自动出现，Aura 永远作为回退。当前 Codex / Claude
  仅为仓库 demo，不随 App seed，也不进入首批 App Store。
- Catalog 合同增加 `packageType` 与按类型可选的 `oauthAppId`；只有真实皮肤条目存在时客户端才显示
  Skins 分类。完整接口与上架边界见[皮肤插件开发规范](skin-development-v1.md)。

### Host API 1.11：DSH 透明度界面恢复为可选插件

- DSH runtime 始终作为 Driver V2 随包底层服务运行，不依赖任何管理或透明度插件；
  `com.reai.dsh-agent` 只是一套可选安装的官方只读 UI。
- Host 不再固定提供“系统能力 / DSH”侧栏分类或原生管理页。插件安装后与普通 App 一样出现在
  Apps 区域；未安装或卸载时不显示入口，也不改变 DSH runtime、会话、模型偏好或来源 App 的能力。
- App SDK / Host API 升到 1.11.0，新增官方专用、grant 与同名 permission 双门控的
  `agent.dsh-observe@1` / `ctx.dshObserver`，仅提供 snapshot、session detail 和 history page 三个
  只读方法。完整 system prompt、token、未脱敏工具负载与原始 JSONL 不跨 Tauri 边界。
- 旧 `agent.dsh-management@1` 写管理合同不恢复；透明度插件不能创建、续跑、取消、删除、清空
  会话。Host API 1.12 后仅补充“之后新会话默认模型档位”这一项设置，不恢复其它管理能力。

## 2026-08-27

### Voice 2.12.15：设置收口、有效记录与统一胶囊开关

- 设置页按使用频次重排；本地识别为默认，云端引擎明确承接登录、模型、用量与隐私风险，每日总结默认关闭并先确认后选择手动或自动。
- 全天记录只展示并保留有真实转写的语音；空转写与静音会清理，4 小时到 30 天的留存策略同时约束全天记录与按键回听。
- 语音输入、语音翻译、语音 Agent 三条可绑定事件共享同一个互斥胶囊：空闲时启动各自行为，任一语音行为进行中时，三条事件中的任一条都会结束当前行为。

### Command 键位选择器展示元数据

- `contributes.commands` 新增可选的 `bindingPickerVisible` 与 `bindingPickerTitle`。插件可隐藏仅为兼容保留的旧入口，或给键位页提供更短的标题。
- 两个字段只影响新绑定选择器，不注销 Command、不影响已有绑定，也不参与 `target_digest`。

### 插件服务与 Agent / DSH 扩展目标规范

- 新增 vNext 目标规范，定义同一个 `.reaiapp` 如何同时贡献 UI Surface、类型化 App Service、
  Agent Scene 与 Agent Tool adapter；当前 Host API 1.10、Manifest 1.1 和 SDK 尚未实现这些字段。
- Voice 示例拆分为 Host `audioRef` 转写、调用方无需提供音频的交互式
  `com.reai.voice/request-text@1`，以及语音输入、
  翻译、Agent 三条上层流程；文本返回调用方，Provider 不访问其他插件 DOM 或替调用方发送。
- Agent Scene 由插件随包声明，DSH Profile 只作为 Host 解析后的执行载体；Pi/DSH 目标上共用动态
  Tool Catalog、能力 generation 和会话快照。
- 依赖分别声明必需/可选与预装/按需。安装能力后不会自动续跑；用户确认“继续刚才的任务”后，
  原会话下一回合才获得新工具，并接受一次前缀缓存 miss。
- 目标合同对平台自带 App 和第三方 App 使用相同字段、limit、权限和审核规则；当前 `official-only`
  Catalog、`voice.input@1` 单 appId grant 和单 `web-surface` 限制仍按现有支持矩阵执行。
- 文档站新增“服务与 Agent”入口；开发规范、API 参考、完整指南、运行依赖规范和 DSH 实施记录已
  统一当前/规划边界及 Agent Scene / DSH Profile / 通知 sceneKey 的术语。

## 2026-08-26

### Voice 2.12.14：音频时间线设置归位与停用收口

- Host 全局设置不再提供“音频时间线”第二控制面；后台听音、全天存档、保留时长与清空录音缓存统一由 Voice 设置管理。
- Voice 未安装、停用或卸载中时，Host 会撤销常驻 Board 音频租约、清空运行期缓存并停止后台转录；用户的暂停与全天存档偏好保持不变，重新启用后继续沿用。
- 旧 `audio-timeline-settings` 系统任务 target 保留线协议兼容，但落点改为官方 Voice 设置；Voice 缺失或停用时明确返回导航失败。

### Host API 1.10：Pi Agent 管理插件与多会话排队

- App SDK / Host API 升到 1.10.0，新增官方专用 `agent.pi-management@1` 与
  `ctx.piManagement`。`com.reai.pi-agent` 可以只读查看 Driver App 内 Pi 的会话来源、任务、
  App 私有工作区、模型、System prompt、Skill 摘要、Tools 与 MCP 状态；不会扫描或读取电脑
  独立安装的 Pi / DSH。
- Pi 继续只保留一个受管进程和一个 active turn，不按会话复制内核；不同逻辑会话进入 Host 队列，
  后到请求不再因为上一会话未结束而直接失败。管理页显示 queued / preparing / active 状态。
- 管理插件可设置之后新会话的稳定模型档位以及按调用 App 的例外。模型在创建会话时固定到对应
  进程代际，不热改正在运行或排队的任务；未通过真实工具回合验证的档位不可选择。
- Pi Agent 成为正式 builtin，CI、Make 与 Tauri bundle 使用同一 `.reaiapp`；设置子页接入 Host
  标题栏面包屑和真实 back-to-root Command。

### Host API 1.10：可组合的 Voice 本地识别结果

- App SDK / Host API 升到 1.10.0；`voice.input@1` 新增
  `voiceInput.acknowledgeResult(sessionId)`。本地 command 识别只返回结果，调用方消费或
  明确丢弃后按 session 结算中央胶囊，不再依赖固定的 Agent/写回流程。
- 确认同时匹配调用方、session 与胶囊代次；重复或迟到确认不会影响新调用。等待确认只是
  UI 记账，不占用 Voice busy phase。
- `voiceInput.cancel(sessionId)` 表示调用方主动取消并明确丢弃该 session，不再遗留等待确认
  的取消终态，也不会误伤同一 App 随后启动的新会话；Host 侧 Esc 仍经 status 返回终态。
- `VoiceInputResult.outcome` 区分 `recognized` 与 `cancelled`，用户主动取消不再冒充空识别。
  异步达到采集上限或音源中断仍由 `VoiceInputStatus.stopReason` 返回，调用方不应把它们
  显示成“没有听清”；Host 按调用方与 session 保留终态，直到同一调用方确认消费。
- Voice 2.12.13 最低要求 Host API 1.10；旧 Host 会在安装兼容检查阶段拒绝，不会加载后
  才因未知 Bridge 方法失败。

### Host API 1.10：官方 Codex work 客户端与本地文本 Broker

- App SDK / Host API 升到 1.10.0。新增 `agent.codex.tasks@1` / `ctx.codexTasks`，只授予官方
  `com.reai.codex-app`：固定并验签 OpenAI Codex 0.149.1，在 Driver 私有 `CODEX_HOME` 中运行 owned
  app-server，提供 ChatGPT 订阅登录、任务、审批、结构化问题、事件和文件 handoff。
- 新增 `local.files@1` / `ctx.localFiles`，只授予 `com.reai.text-editor`。目录必须由系统面板授权或领取
  Host 短时 handoff；所有路径重新 canonicalize，文本有大小/编码上限，保存使用 revision 与原子写入防覆盖。
- Codex App 与文本编辑器目前只登记为 Developer Builtin 候选，没有加入正式发布清单。正式发布仍须完成
  真实订阅登录、签名 App、本地文件流程、跨平台 runtime 与插件审核门禁。
- `dev-tools` 构建可用绝对路径 `REAI_DRIVER_V2_INSTANCE_DIR` 隔离并行原生验收实例的单实例锁与 IPC；
  release 构建忽略该变量。

## 2026-08-24

### Voice 2.12.12：Agent Session 删除收口与自动总结静默退避

- Voice 的段总结和当日自动总结现在每轮都声明 `taskPresentation: "caller"`，由 Voice
  页面自己呈现；后台自动提示词不会再被 Host 当成全局任务胶囊标题。
- 当日自动总结失败时间写入 Voice 私有 KV，Runtime 重建或 App 重启后一小时内不会
  自动连环重试；用户显式“重新总结”仍可立即发起，删段也会同步清除当天的落盘退避。
- 单个 Agent Session 删除或批量清理 DSH Session 时，Host 同步撤下该会话的运行中与
  终态任务，并把关联通知账本标为已读；通知历史仍保留，其他会话不受影响。
- Voice 官方包与升级 seed 同步进位，存量 2.12.11 安装会在启动时收到这组修复。

### Voice 2.12.11：统一短结果与长任务呈现

- 转文本、翻译和 Agent 共用同一个 3 秒前台预算：3 秒内无论成功或失败均进入屏幕中央的
  结构化结果面板，超过 3 秒才把同一 taskId 交接到 Host 全局任务胶囊。
- `voice.deliver.commit` 只描述写回副作用，不再决定是否展示结果、也不直接控制中央浮层；
  活动运行、前台 owner、Agent session 对账与详情续接都按精确 taskId 隔离。
- `presentAnswer` 向后兼容地增加 status、sections、delivery、canCopy 与 canContinue 字段；
  旧插件不传新字段时继续使用原有 text/originalText 呈现。

### Host API 1.9：可查看、可管理的插件定时任务

- App SDK / Host API 升到 1.9.0；Manifest 新增 `contributes.scheduledTasks`。插件声明任务标题、
  Command 与执行间隔，Host 统一负责自动触发、重启补跑和暂停状态，不再依赖插件里不可见的
  `setInterval`。
- 开发者模式的“定时任务”区显示真实任务总数、来源 App、周期、上次/下次时间，并支持立即运行、
  暂停、恢复和手动刷新。关闭开发者模式会清除暂停，避免业务任务被长期静默停用。
- 每个 App 最多声明 16 个任务，间隔为 1 分钟至 24 小时；目标 Command 必须存在且允许 `host`
  调用。首次发现立即触发，错过多个周期只补跑一次。

### Voice 2.12.10：当日总结改由 Host 调度

- “当日总结检查”成为可见的五分钟定时任务；Voice 删除自己的隐藏轮询，只保留一个 Host-only、
  幂等的刷新 Command。Command 刷新录音列表后异步启动既有单飞总结流程，不等待 AI 合成完成。
- 后台定时触发不进入键位反馈条；运行与管理反馈只在开发者选项中显示。

### Voice 2.12.9：异常状态直达修复位置

- Voice 页头胶囊改为“正常态纯展示、异常态才可点击”：首次读取显示中性的“检查中”，不会用占位值
  闪出权限或模型误报；键盘断开、系统麦克风、权限、模型、登录、全天存档与时间线异常分别进入真实
  解决位置。
- `system.tasks.open` 白名单新增 `audio-timeline-settings` 与 `app-permissions`。后者只按 Host 可信的
  来源 appId 打开该插件的已安装详情权限区，没有可信来源时拒绝导航。
- 全天存档改为默认开启；旧开发安装会一次性迁到开启，marker 完成后继续尊重用户再次关闭。关闭时
  Voice 明确提示 Context、近期语音与全天记录会受限。
- “键盘未连接”进入 Voice 设置后，只高亮具体的“录音来源”行；可点击设置行继续保留底部分割线。
- 定向高亮的强提示阶段至少保持五秒，状态刷新重渲染不会吃掉；五秒后只有真实鼠标移动、点击、键盘或
  滚轮操作才取消，不监听 DOM 重建自动产生的 `mouseover`。

### Voice 2.12.3：旧系统音源一次性迁回 Board-first

- 旧版保存的系统麦克风/测试 endpoint 若没有新版明确选择标记，会一次性恢复为键盘麦克风：
  USB 走 Vendor HID、BLE 走私有 GATT，不请求系统麦克风权限；迁移会清掉旧 endpoint，并在
  第一次打开 Voice 时显示一次中性说明。
- 用户在 2.12.3 之后主动选择电脑麦克风会写入确认标记，后续升级继续尊重。原始录音、按键
  requested marker 与只向外扩的 effective 范围仍分开保存，未改变 VAD 截取算法。

### Voice 2.12.2：兼容 Host 空闲状态

- Host 空闲状态序列化为 `mode: null` 时，Voice 现在会归一为未占用，恢复 Agent 对话输入与
  发送按钮；内置包版本和 seed 同步进位，确保已安装的 2.12.1 会实际升级。

## 2026-08-23

### Host API 1.8：多会话切换与调用方任务呈现

- App SDK / Host API 升到 1.8.0；`agent.session.send` 新增可选的
  `taskPresentation: "host" | "caller"`。默认仍由 Host 创建通用任务胶囊；已有自己结果面板的
  Voice 使用 `caller`，避免同一回合出现两份完成卡。
- Pi 的单进程约束改为“只阻止正在执行的回合被抢占”：进程空闲时，不同持久会话可在 1 秒内
  切换，不再把第二次新任务错误续进第一次对话；执行中的会话仍保持不抢占。
- Agent Session 每插件上限调整为 256；facade 历史收敛为最近 8 条、每条最多 4096 字符。
- Voice 2.12.1 用正向台账管理自己创建的持久会话。完成/失败历史先落盘再展示终态卡；崩溃后
  只回收台账确认归属且已不可见的孤儿，不猜测、也不删除其他会话。

### Agent Session 回合进入任务胶囊

- 持续会话（`memory: "session"`）的回合现在会登记 Host 全局任务胶囊：运行中
  「正在思考」、完成「已完成」、引擎失败标红；one-shot 回合不登记（同步请求-
  应答没有后台呈现需求）。
- 新增 `agent.session.conversation-opened` 窄口方法（SDK `ctx.agent.reportConversationOpened`）：
  会话被用户打开时上报，作为任务胶囊/Tab 层/通知账本「已看过」的唯一判据。
- `AgentSendResult.failure` 字段口径修正为 `{ kind, stderr_tail? }`（与 Rust
  serde 实际序列化一致）；此前按 `detail` 读取的代码会一直得到 undefined。

## 2026-08-22

### Voice Agent 正式产品路径

- Voice 2.11.0 将默认 Command 与润色从 Workflow / 私有 DSH 调用切换到通用
  `agent.session@1`；Pi Agent / DSH Harness 的选择只在 Voice 插件设置中管理。
- Command 的 Agent 回合在 3 秒内完成时显示 Voice 结果面板，超过 3 秒转入 Host 通用任务胶囊；
  打开胶囊或“继续”会进入同一条真实会话，后台完成不抢焦点。
- Host 全局设置移除 Voice 工作流地址等插件专属内容；Voice 设置更新保持当前滚动、焦点和文本选择。

### 通用 Agent Session V0

- Host API 与 App SDK 升到 1.6.0，新增 `agent.session@1` 和 `ctx.agent` 的 backend、创建、发送、
  精确取消、历史、列表与删除接口；插件可在创建时选择 Pi、DSH 或 `auto`。
- Session Spec 只接受有界 system prompt、Host 工具白名单、只读 skill 文档、App 私有工作目录与
  session/one-shot 记忆模式；V0 不加载外部 Harness 插件，也不向插件暴露账号凭据或真实模型。
- Voice 2.10.0 增加默认关闭的 Agent 实验入口，用统一接口验证 Agent 命令、持续追问与润色；
  原 Workflow / DSH 路径保持默认。

### Voice 设置精确导航

- `system.tasks.open` 的公开 target 白名单新增 `account-login` 与
  `voice-command-settings`，供插件分别打开 Host 账户登录行和语音命令设置卡。
- 两个 target 都是导航型任务：Host 完成页面落点与一次性 focus 后即返回成功；插件不能借此读取
  账户身份、工作流配置或其它 Host 私有状态。

## 2026-08-21

### Dsh Agent 会话接口

- 新增 `agent.dsh@1` 插件能力的状态、会话创建、发送、取消、历史、列表与删除接口说明。
- `send` 支持调用方提供稳定 `turnId`，Host 以该标识精确取消单个回合；状态结果同时公开
  Dsh 登录与模型权限可用性，但不会向插件暴露模型凭据。
- Voice Agent 改用 Host 托管的本地 Dsh 会话；模型调用仍受 `cloud.model.invoke@1` 平台授权与
  用户权限双重门禁约束。

### 单层 Host Title Bar 与插件 `main-body`

- 页面级顶部统一为 44px Host Title Bar；插件不再创建第二层 `main-title`、窗口拖拽区、通知区或
  蓝色 hover 渐变。
- 插件 DOM 从 `main-body` 开始，根框架只消费一次 Host 注入的
  `--reai-plugin-titlebar-safe-top`；正文、抽屉和弹层不能越过 Host 安全区。
- 页面级交互通过 `contributes.titlebarActions` 交给 Host。根路径直接显示插件名；子页使用返回
  与可点击祖先面包屑，不加 `Apps /` 前缀。
- 通用子路由、返回与面包屑贡献合同仍是已锁定的设计目标，尚未进入公开 SDK；插件不得自行向
  Host Title Bar 注入 DOM。
- Voice、Agents · IM、Agents · 任务、日程、AI Podcast、Codex Link 以及其他官方样例已统一到
  这套页面结构；AI Podcast 的正文滚动边界已同步收敛。

详见[插件开发规范 §3.1](plugin-development-v1.md#31-单层页面框架host-title-bar--插件-main-body)、
[插件设计规范 §4.5](plugin-design-system-v1.md#45-单层顶部44px-host-title-bar--可滚动-main-body)
和[插件接口参考 · Host 托管标题栏动作](plugin-api-reference-v1.md#host-托管标题栏动作)。

### 规范发布流程

- 新增本更新日志页，并加入文档站顶部导航和侧栏。
- 新增自动门禁：规范正文发生变化而本日志未同步更新时，`docs-site` 构建失败。
