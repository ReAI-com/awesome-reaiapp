# AI 代码编排实现与验收

实现候选 0.2.0 / Host API 1.20。用户指定先完成代码和 PR 合并，再集中人工验收。源码合并、自动测试、A 签名候选、用户验收、Catalog 发布分别记录。

| 模块 | 当前实现 | 验证边界 |
| --- | --- | --- |
| 已计划入池 | feedback-board 0.4.1-dev.1 planned Service；来源去重，撤回阻止领取但保留已锁定工作 | Provider 从自己 Store 读；缺失/损坏不返回假空列表 |
| 持久状态 | authority 每次重读/CAS；Host 锁内比较、落盘失败回滚，损坏拒绝覆盖 | Mock/单元并发与磁盘测试，A 结果按候选报告 |
| 身份与接口 | 通用 apps.gateway@1；ServiceCaller.external 绑定 Agent；HTTP 正文不含 actorId | 同机随机端口、当前登录及用户权限；token 只在 Host 内存 |
| 编排与配额 | 领取、拆分、独立分派，waiting 不占额度，begin 才占额度，完成/取消自动归还 | 创建记录不是启动模型；外部执行器负责实际工具/仓库权限 |
| 报告 | Worker commit、Tester testedCommit、merge sourceCommit 关联；严格 JSON 字段 | 来源 agent-report，不宣称 Host 独立查 Git |
| 恢复 | 128 条/24h 回执、精确重试；终态执行者只可重放原信封，随后自动撤销 | 不自动抢锁；异常执行先确认真实进程停止再 cancel |
| 存储整理 | 完成任务导出含完整证据的 JSON，明确保存后清理详情，保留来源及摘要 | 清理检查导出 revision/digest，未完成任务拒绝 |
| Skill | 独立 ZIP、可复制一行连接、Python 客户端/runner、原理和接口参考 | Python 标准库；未知写结果保留日志，不盲目换 ID |
| 界面 | 四页签、四列全局、五列子任务，错误重试、角色连接、双语/主题 | 保留既有视觉系统；管理员选择器只读 |

Host 公共合同见 [接口参考](../../platform-docs/plugin-api-reference-v1.md)，实现计划见 当前计划（Board 仓库内部材料，未公开）。反馈与编排两份候选必须共同本地侧载，不能使用旧锁定反馈包证明 planned 同步。无跨项目写入、云迁移或自批准 Catalog 操作。

独立 验收 HTML（原 Board 仓库内 `docs/testing/code-worker-acceptance.html`；未迁入） 的人工结果继续留空，由用户逐项勾选或粘贴文字/截图；开发证据不代勾。

以下是历史候选结果，不能用于证明 0.2.0 的新增接口已完成真机测试。

### 2026-09-12 开发验证记录

- ✅ `bun test tests`：20 项通过，涵盖任务规则与视图；`typecheck`、语言校验、build、pack 通过。
- ✅ `test:contract`：实际插件入口通过注册、私有存储、重挂载、Host 语言、导航与卸载检查；无网络请求。
- ✅ `verify-official-plugins --plugin code-worker`：独立复制到仓库外，只用公开平台 tarball，构建/合同/重复打包摘要一致。
- ✅ 设计与 Skill 回归 16 项通过；仓库路径合同 104 项测试通过，47 个迁移条目有效。
- ✅ Codex 内置浏览器实测：未连接状态不显示虚假执行数字；隔离测试数据下的四列大任务、五列详情、证据抽屉及 Esc 返回；英文与深色显示；700px 下角色池单列、页面不横向溢出；完整 Skill 9436 字符可选中，未显示虚假“已复制”。
- ❌ 未完成：真实反馈同步、Agent API/执行闭环、签名 App 验收、Catalog 安装/审核。浏览器数据来自 `tests/fixture.ts`，不是真实 Agent 结果。

### 2026-09-13 A 环境增量验证

- ✅ 正常测试账号登录、开发者本地安装/启用、四页签未连接状态、完整 Skill 手动复制、语言/主题、Worker 默认上限 10→12 及完整退出重启保留，见 实测版本、步骤与截图（原 Board 仓库内 `docs/2026-09-13-code-worker-a-e2e.md`；未迁入）。
- ✅ 固定 Rust 1.94.0 下全量官方插件仓库外验证通过。纠正 code-worker 的审核拒绝预期：其仅用基线能力且不占保留官方 ID，可以执行本地安装生命周期；这不表示已获 Catalog 审核。
- ❌ 真实 planned 入池、任务持久化、可信 Agent API/执行与合并闭环仍未实现，完整业务验收未通过。A/B 软件结果不替代 C 硬件或用户验收。
- A 测试进程已正常退出并释放租约；保留独立 profile 和精确候选以便后续复现。

### 统一候选与人工反馈

统一开发顺序见 完整候选计划（Board 仓库内部材料，未公开）。独立 验收 HTML（原 Board 仓库内 `docs/testing/code-worker-acceptance.html`；未迁入） 包含 25 项准备条件、操作步骤和通过标准，支持勾选、文字/截图反馈、按版本复测及完整导出。该文档自身的验证不代表业务功能完成，人工通过项初始为空。

### 0.2.0 开发验证与合并前记录

以上 0.1.0 结果为历史记录。当前已实现本地任务权威、CAS、Agent 网关与角色 API，详见 0.2.0 验证记录（原 Board 仓库内 `docs/2026-09-13-code-worker-020-verification.md`；未迁入）。A 环境已安装新编排插件并验证依赖缺失状态；反馈插件 OAuth 元数据 404 阻塞正常安装，完整真实模型业务验收仍待完成。按用户授权先合并 PR，再统一人工验收。
