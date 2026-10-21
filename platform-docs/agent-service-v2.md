# Agent Service v2（Host API / SDK 1.21）

插件调用一个 Agent 服务，选择 Pi、DSH 或 Codex；省略 `runtime` 时使用 Host 的全局默认值。
选择在创建会话时固定。插件不必增加引擎设置页，也不需要了解 runtime 的 RPC、MCP 或进程参数。

## 三层职责

| 层 | 负责什么 |
|---|---|
| Agent 服务 | 校验调用方、授权、配置与工具引用；保存会话、请求身份、事件和结果；处理取消、用量与任务呈现 |
| AI-Router | 把统一输入转换为目标 runtime 的配置和原生协议，再把输出转换成标准事件与结果；模型协议转换只处理一次请求/响应 |
| Ai-RunTime | 使用锁定的原版 Pi / DSH / Codex 运行模型与工具回路；通过公开扩展或协议回调 Host 工具 |

模型选择、工具执行和用户文件访问仍受 Host 授权。插件不能传入 OAuth token、API key、
任意 endpoint、环境变量或 runtime 启动参数。模型与工具循环由原生 runtime 推进。

## 权限与兼容

- 新接口声明 `agent.session@2` 能力及同名用户权限，Host API 下界为 `1.21.0`。
- 模型调用还需 `cloud.model.invoke@1` 的平台批准、用户允许及有效外脑 OAuth 会话。
- `agent.session@2` 自己覆盖完整 v2 生命周期，不要求同时授予 `agent.session@1`。
- Runtime 必须有当前插件可用的受管资源引用；安装状态与批准范围以 Host 返回为准。
- v1 `SessionSpec` 与方法继续兼容。已有 v1 会话不自动转换成 v2 会话。
- v2 通过同一个 `ctx.agent` 提供。调用 `createSession` 时传 `schemaVersion: 2`；
  `backends`、`listSessions` 和 `requireToolDependency` 也应显式指定该版本。

Manifest 声明不会自动获得平台批准；继续使用现有审核和用户权限流程。

## 配置

```ts
import type { AgentConfig } from "@reai/app-sdk/v1";

const config: AgentConfig = {
  schemaVersion: 2,
  // runtime: "pi",              // "pi" | "dsh" | "codex"；省略使用全局默认
  systemPrompt: "先给结论，再简要说明。",
  tools: [{ ref: "web_search" }, { ref: "web_fetch" }],
  skills: [{
    id: "brief-answer", title: "回答格式",
    content: "使用用户的语言，优先给出有来源的短答案。",
    loading: "inline",
  }],
  model: { channel: "external-brain", tier: "text-default" },
  output: { format: "text" },
  workspace: { kind: "app-private" },
  memory: "session",
  mode: "chat",
};
const created = await ctx.agent.createSession(config);
// created.runtime 是实际引擎，selectionSource 是 request 或 default。
```

当前可用子集：

| 字段 | 当前行为 |
|---|---|
| `runtime` | Pi、DSH、Codex；省略或 `auto` 在创建时解析全局默认；显式指定失败不会偷偷换引擎 |
| `featureRef` | 1.23 起可选：指认本插件 `contributes.agentFeatures` 声明的功能 id，Host 以此合并声明默认值与用户在配置页的覆盖（提示词模板 × 参数、工具勾选、引擎锁定）；指认未声明的 id 以 `AGENT_FEATURE_NOT_DECLARED` 拒绝。旧 Host 不认识该字段会整包拒绝，按 `backends().capabilities.configuration.featureRef`（1.23 起 `true`，缺席即旧 Host）探测后再附带 |
| `featureParams` | 随 featureRef 出现：模板参数值。带参数时 Host 核验 `systemPrompt` 与「声明模板 + 参数」渲染结果逐字节一致（`AGENT_FEATURE_PROMPT_DRIFT`）；用户覆盖模板时用同一份参数渲染（覆盖不丢动态行为）。随 featureRef 一起降级 |
| `tools` | 引用 Host Tool Registry 的稳定 `ref`；统一目录投影到三个 runtime；未知/重复引用拒绝 |
| `tools[].config` | 可省略或传空对象；当前不接受额外工具配置 |
| `skills[].loading` | 只支持 `inline`，作为只读说明文档；不是执行脚本、加载 npm 包或授予新权限 |
| `model.channel` | 只支持 `external-brain`；选择 Codex 也走外脑 OAuth，不会隐式使用订阅 |
| `model.tier` | 可省略或 `text-default` |
| `model.parameters` | 生成参数覆盖尚未开放；传 `temperature` / `maxOutputTokens` 明确报不支持 |
| `output` | 可省略或 `{format:"text"}`；JSON schema 约束尚未开放 |
| `workspace` / `memory` / `mode` | 沿用已授权工作区、session / one-shot、chat / plan / yolo 合同 |

`on-demand` 技能、JSON 输出约束、Codex 订阅渠道等保留类型槽位的功能，目前返回
`AGENT_CONFIG_UNSUPPORTED`，不会当成已经生效。`inline` 不能冒充原生按需技能。
提示词、说明文档与实际工具定义合计不能超过 64 KiB，其他既有单项限制仍适用。

调用 `ctx.agent.backends({schemaVersion: 2})` 可读取每个引擎的可用性和
`capabilities.configuration`。当前结果交付标记为 `buffered`；不能把 runtime 的文本 delta
包装成已验证的上游实时 token 流。

**技能目录（1.23，随 featureRef）**：用户可为插件配置一个只读本地 Markdown 目录
（Host 配置页），功能级勾选的文档在创建带 `featureRef` 的会话时由 Host 展开为
inline `SkillDocument` 追加进 `skills`（插件自带优先、按 id 去重；总量仍受
8 份 / 32K 字符 / 64KiB 信封闸约束，超限 fail-closed）。展开随创建时快照冻结，
续跑不重读目录；目录符号链接与预算超限会被拒绝（`AGENT_SKILL_DIR_*`）。

配置页刷新时，目录与该目录内的技能勾选保持配对。未编辑的配对值一起更新；
草稿目录不同于新保存目录时，保留原目录和勾选，不把旧 ID 用于新目录。
同目录下只改某功能的勾选时，其他未编辑功能仍更新。用户主动选择或清除目录
会清空各功能勾选，包括重新选择同一目录；刷新保留这次重置意图。
扫描读取当前草稿目录。选择后扫描失败会保留选定目录、空勾选和错误，保存时
Host 仍校验目录。选择器和扫描结果绑定当前页面实例、插件和草稿；清除、
切换插件、保存或恢复后的草稿替换、刷新清单移除插件及离开页面使旧结果失效。
选择器取消不改草稿。选择器打开和后续扫描期间，当前页面只能进行一次选择。

**覆盖层生效链（1.23）**：用户可在 Host「设置 › 插件 Agent 配置」按插件保存覆盖
（默认引擎 + 每功能的模板文本/工具勾选），存账号目录 `agent-plugin-config-v1.json`，
只对 v2 会话生效。生效优先级：会话显式 runtime > 插件级配置 > 全局默认链
（响应 `selectionSource: "request" | "configured" | "default"`；`backends()` 另报
`defaultBackendSource`）。合并只发生在**创建时**：有效配置进 ledger 与引擎边车，
之后改覆盖不影响已建会话；覆盖文件损坏时 fail-closed（`AGENT_PLUGIN_CONFIG_CORRUPT`），
不静默回默认。创建响应的 `configSources: {prompt, tools}` 标注生效来源（plugin/user）。

保存与重置使用相同的当前写入准入：插件已安装且不在卸载中、启用、声明
`agent.session@2`、当前能力批准有效，并排除 Pi / DSH 管理面插件。Catalog 每次按
当前包身份重验签名批准；其他来源使用现有能力镜像。配置记录本身不授予能力，
账号 lease、Host ACL 和用户权限门禁保持各自原有合同。

保存先取得声明与安装身份快照，再在注册表锁外校验请求及扫描技能目录。提交前
复验当前准入，比较 origin、版本、包摘要、来源和声明；停用、撤权、更新或同包
卸载重装后，旧请求须重新加载配置。最后的配置写入与卸载保持注册表锁内顺序，
完整卸载和清理后不能被旧请求重新写入孤儿覆盖。重置也在同一锁内复验后清除。
拒绝时保留旧覆盖及其他插件、账号的记录；非 Catalog 镜像仍使用既有独立撤权锁，
这不是跨组件磁盘事务。

用户覆盖模板中的槽位名必须符合 `^[A-Za-z][A-Za-z0-9_]*$`，且在该功能的
`promptParams` 中声明；创建时由插件提供同名参数值，缺值会拒绝创建。Host 从左花括号
扫描到其后的第一个右花括号，中间是有效名称才作为槽位；其他闭合片段按字面文本保留。
因此 `请输出 JSON：{"ok": true}，目标语言 {targetLanguage}` 可以保存，参数为 `中文`
时得到 `请输出 JSON：{"ok": true}，目标语言 中文`。未闭合片段仍拒绝保存与渲染。

覆盖模板不递归插值：`{"lang": "{targetLanguage}"}`、`{{targetLanguage}}`、
`{ targetLanguage }`、`{target-language}` 和 `{目标语言}` 都按字面保存、原样输出。
需要插值时使用独立的合法 `{targetLanguage}` 片段。这个规则只说明 Host 用户覆盖模板；
插件自己的声明模板与插件侧渲染逻辑保持原有合同。

## 提交、等待与重试

推荐分开提交和等待，先拿到真正的 `turnId`：

```ts
const request = {
  sessionId: created.sessionId,
  idempotencyKey: crypto.randomUUID(), // 本次请求固定；网络重试复用同一对象
  text: "杭州后天天气如何？",
  taskPresentation: "caller" as const,
};
const receipt = await ctx.agent.startTurn(request);
const ref = { sessionId: receipt.sessionId, turnId: receipt.turnId };
// 此处保存 ref，并把它映射到本地 UI 的 taskId。
const result = await ctx.agent.waitForTurn(ref);
if (result.failure) {
  // 展示明确失败；不要把受理回执或工具协议文本当作答案。
} else {
  // 展示 result.text；runtime / channel / usage 来自实际结果。
}
```

`startTurn` 在持久保存请求身份后返回短回执，状态可以是 `queued` 或 `running`。
它不表示模型完成。`waitForTurn` 只查询，不重新提交；也可自行调用 `getTurn(ref)`。

同一账户、插件、会话中的同一 `idempotencyKey` 和请求内容，返回原来的 `turnId`，
不会重跑工具；同键不同内容被拒。键长 1–128，只能使用字母、数字及 `-_.:`。
用户明确发起新的工作才使用新键。UI 的 `taskId`、幂等键与服务生成的 `turnId` 不要求相等。

兼容便利方法 `ctx.agent.send({sessionId, text, turnId?})` 在 v2 下提交一次并等待终态。
这里传入的可选 `turnId` 是兼容位置的幂等键；返回值中的 `turnId` 仍是真实服务回合 ID。
需要立即支持取消/进度的界面应使用 `startTurn` + `waitForTurn`。

## 事件、取消和会话维护

| SDK 方法 | 用途 |
|---|---|
| `getTurn(ref)` | 获取 queued / running / completed / failed / cancelled 快照 |
| `events({...ref, afterSequence})` | 从序列号之后恢复事件；返回 `events`、`gap`、`nextSequence` 和快照 |
| `cancel(ref)` | 取消该真实回合；返回 `{cancelled}`；已终态时不重写结果 |
| `history({sessionId})` | 获取所属会话的用户/助手历史 |
| `listSessions({schemaVersion:2})` | 仅列调用方有权访问的 v2 会话 |
| `deleteSession({sessionId})` | 删除所属会话，关闭其后续运行入口 |
| `reportConversationOpened({sessionId})` | 用户打开会话时同步 Host 已读状态，SDK 自动走 v2 |
| `requireToolDependency({tool, schemaVersion:2})` | 用户明确要求安装浏览器工具依赖时进入 Host 流程 |

当前 owned-open 实现候选增加 `prepareConversationOpen({sessionId})`、
`reportConversationOpened({sessionId, receipt})` 和 `cancelConversationOpen({sessionId, receipt})`。
直接打开先读取真实历史，再准备回执；Host 深链使用其已交付的回执。界面落地并完成 paint 后
才提交同一回执，持久提交失败保留它供同一界面显式重试。换会话、返回或卸载取消旧操作；
来源、账号、package、runtime、mount 或通知版本变化均不能退回无回执的旧式确认。
旧调用形状仍保留给旧式无主任务，不赋予 owned 任务清除权限。

这不开放整套 `tasks.present@1`：中性 `tasks.conversationOpened` 只在当前 Host 已交付关联回执、
私有 descriptor 精确匹配当前实例且明确支持该方法时可用，其他任务方法仍按各自完整支持合同拒绝。
Voice 的候选流程使用真实持久历史和实际 DOM 落地，失败显示本地化原因并保留待看状态。
MockHost 的 owned-open 只在显式合成 fixture 中启用；它不证明真实账号、系统通知或原生授权。
候选包、SOURCE 审查、平台批准和真实签名 App 验收分别记录，不由本节宣称已发布。

事件带 `schemaVersion`、`sessionId`、`turnId`、`runtime`、`sequence`、`timestamp`。
工具事件带原生 `callId` / `toolName`，单次尝试保持同一个 ID；重试使用独立 ID。
按 `(turnId, sequence)` 去重，按 `callId` 关联开始和结束；不能按工具名覆盖失败历史。
一轮任务默认展示一张操作卡，展开时显示各次工具尝试。

**等用户拍板**：回合停在需要用户决定的一步（启用浏览器插件以联网、确认工作目录外的访问）时，
事件流有 `wait.started` / `wait.ended`（字段见 [API 参考](plugin-api-reference-v1.md)），
运行中的快照另带 `waiting: { kind: "waiting_user", waitId, reason, label, action, startedAt }`，
离开等待后该字段消失；运行中快照另带 `waitedMs`（本回合累计等用户的毫秒数，含进行中的等待，
为 0 时缺席）。等待期间 Host 暂停回合的全部计时（含 600 秒任务上限），`waitForTurn`
见到 `waiting` 不计自己的等待截止，并按 `waitedMs` 顺延截止。回合结束即视为等待结束。插件应显示「等待你授权：`<label>`」、已等时长，并按
`action.type` 给入口：`tool-dependency` 调 `requireToolDependency`，`host-approval` 提示去 Host
主窗口确认。同意后同一次请求继续；拒绝按真实原因失败；取消则停止。

事件可能因断连或容量限制被裁剪。`gap: true` 表示部分细节已不可恢复，应展示快照和真实终态，
不要补造过程；不能为补进度重新提交同一任务。浏览器安装启用后续跑仍是同一次原生工具请求。

## 结果与保存期限

- 终态快照包含 `result`；失败结果包含 `failure`，必须与正常文本区分。
- 用量只按真实模型响应累计；`usage.complete: false` 时不补零、不显示部分计数为总数。
- 结果正文与事件最多保留 24 小时，并受容量上限约束，可能提前裁剪。
- 结果过期会保留请求身份并返回 `expired: true` / `AGENT_RESULT_EXPIRED`；不会重跑旧任务。
- 活跃会话保留幂等身份；终态超过 7 天且会话已关闭/删除时才清理。满额时明确拒绝新受理。
- Host 重启时中断任务记为 `AGENT_INTERRUPTED`，不会自动重放可能有副作用的工具。
- 账户切换、撤权与插件生命周期结束仍会关掉调用资格。历史不能跨账户或插件读取。

## Runtime 原版边界

Pi 使用原始 npm 发布文件和 shrinkwrap 锁定依赖，通过公开 provider / registerTool / input
扩展接口接入。DSH 使用锁定上游依赖与外置适配配置；Codex 使用原版 app-server。
Router 文件随签名 Host 分发，不作为被修改的 runtime 内核发布。

文件工具也使用统一目录与 Host 执行器。`read/write/edit/list/glob/grep` 在三种工作区都可授予：
`mounted` 继续遵守镜像、档位和冲突规则；`direct`（用户经 `system.folder-pick@1` 授权的原目录）
与 `app-private`（Host 分配的独立工作根）由 macOS Seatbelt helper 在 OS 层限定范围，范围外的
目标先由 Host 主窗口单次确认（`approval.requested` / `approval.resolved` 事件，插件只能读
`agent.v2.session.approvals.list`，没有批准方法）。`command`（`/bin/sh -c`）只在 direct /
app-private + yolo 开放，与 `run` 一样需要 `local.terminal.exec@1`；这不等于开放任意本机执行接口。
插件审批列表与 `approval.*` 事件中的 `description` 是中性 `workspace_access`，不含完整命令；
完整动作仅供 Host 主窗口的待审批弹窗在内存中读取，不写入审批事件账本。目录身份复查、
硬链接防护与外部同 UID 进程主动篡改的边界见 [受控运行工具](agent-controlled-run.md)。
创建结果的 `workspaceRoot` / `scopeVersion: 1` 是范围执行生效的唯一证明，`backends()` 的
`capabilities.scopedExecutionVersion` 缺席时不得尝试文件或命令。


## 统一工具执行与回合边界

三个 runtime 的原生工具回调都进入同一个 Host ToolScope。Scope 在回合开始时固定真实插件、
会话授权代际、Agent 能力和已授予的工具集合；模型参数不能改变这些值。每次模型调用和工具调用
都重新检查当前账户、插件启用状态和授权。取消、账户切换或撤权会关闭该回合的后续入口；
正在等待的工具会响应取消。浏览器、网页和电脑操作以真实插件为调用方，不能借用固定的 Agent 身份。

- 每回合最多 8 次模型请求、32 个独立工具调用；超额返回明确错误并关闭 Scope。
  原生 runtime 的标题生成等辅助模型请求也占模型额度；工具等待安装的时间不增加模型次数。
  DSH Router 通过公开 profile 关闭可选的模型标题生成，保留原生文本标题回退，避免占用问答额度。
  本地预算耗尽使用 `AGENT_MODEL_BUDGET_EXCEEDED` / `AGENT_TOOL_BUDGET_EXCEEDED`，
  保留第一次终止原因，不伪装成上游限流，也不由 runtime 自动重试。
  `retry: same-session` 只表示用户可以缩小任务后主动再问，不授权自动重放已执行的工具。
- 工具目录同时定义 provider、版本、权限、输入/输出 schema 和配置 schema；传给原生 runtime
  的工具定义只含其支持的名称、描述和输入 schema。Host 按目录校验参数并分派实际 provider。
- 同一回合内，同一 `callId` 和同一规范化请求只能执行一次：在途调用共用结果，完成后重放结果。
  同 ID 不同请求返回 `AGENT_TOOL_CALL_CONFLICT`。模型主动重试必须使用新 ID，并占用调用预算。
- 如果工具执行被中断且结果无法确认，保留 `AGENT_TOOL_OUTCOME_UNKNOWN`，不会猜测成功或重新执行。
  这不保证已发生的外部副作用可以撤销。
- 文件工具使用 Host 授权的工作区（镜像 / 直接目录 / 独立工作根）和档位；受控 `run` 与
  `command` 还需独立的 `local.terminal.exec@1` 平台批准与用户授权：`run` 仅 mounted + yolo，
  `command` 仅 direct / app-private + yolo。限定程序、隔离、越界确认与输出上限见
  [受控文件处理 run 与工作范围内命令 command](agent-controlled-run.md)。

需要在提交回执丢失后恢复的 UI，应在私有存储中有界保存原始请求，以同一幂等键再次查询受理结果。
恢复前通过 `listSessions({schemaVersion:2})` 确认原会话仍属于当前调用方，不借用读取上下文权限
推断身份。明确拒绝与“可能已受理但未收到回执”必须分别呈现；后者不能自动换键新建任务。

## 每轮时间与最终正文

`agent.session@2` 由 Host 在原生回合的公共执行 scope 创建时采样一次本地日期、带 UTC 偏移的 RFC3339 时间及 UTC 时间。这个执行参考时刻不保证与持久化回执的 `createdAt` 完全相同。该回合的工具往返、模型重试共用同一份参考；重复提交同一幂等键只查询已受理回合，不重新采样或执行。新回合会更新参考时间。只描述 Host 的实际偏移，不猜测用户或查询地点的 IANA 时区。

时间作为独立 `system` 消息追加在发往模型的请求副本末尾。原生消息数组完整保留为前缀，不改原始用户文字、请求身份、会话提示词或原生持久历史，不会因此重启会话。临时时间消息不会进入下一轮的原生历史；这里只保证原生历史前缀不变，不保证上一份完整网络请求（含临时时间尾部）成为下一份请求的前缀，也不承诺具体缓存命中率。原生 runtime 可能另有执行时间提示；相对日期以这一轮的 Host 参考时间为准。

终态 `result.text` / `result.content` 表示该回合的最终正文。中途说明仍属于 `message` 事件，工具过程仍按原生 `callId` 保留，不拼入最终正文。Router 优先使用原生最终消息；Codex 未标明消息阶段时，使用最后一次工具之后的最后一条完整助手消息。只有过程、截断片段或失败消息时，不把它们伪装成成功答案。这些新增约定只适用于 v2；旧接口保留原行为。

## 附件输入 v1（可选描述符，Voice 命令限定）

本节描述尚未发布的实现候选。Host 配额、私有账本事务和历史投影修复已完成，
合成回归与限定独立审查已通过；最终 CI 以合入的精确提交为准，正式发布和真机验收独立进行。

`configuration.attachmentInputVersion === 1` 表示 Host 实现附加的强类型合同；缺席时不得发送
`attachmentInput`。当前只接收 `com.reai.voice` 的 `featureRef: "command"`、自己所属的 v2
持久会话。其他插件、翻译、润色和总结不获得该入口。它不增加原文件、云存储或项目读写权限。

Voice 在命令页创建或恢复所属会话后，读取
`ctx.agent.attachmentAdmission({schemaVersion: 1, sessionId})`，本地准入确认后才显示加号。
选择文件与发送前仍按当前绑定再验。
这是本地快照读取，不请求模型目录或发起推理。只有 `state: "ready"`，模型输入标志、用户
`readers` 和实际 `transports` 三者相交才可发送；不能从模型名称或文件工具推测能力。
首次在 Host 的插件 Agent 设置中保存读取开关并检查当前模型；显式重检走已有认证模型目录。
账号、网关、插件配置、实际模型、运行时或授权绑定变化后，旧快照和附件会拒绝。

`startTurn` 可附 `attachmentInput: {schemaVersion: 1, admission, parts}`：

- `admission` 包含当前 `opaqueBinding`、`revision` 和准确且不重复的 `modes`。
- 文本项为 `{kind: "text", mode: "text" | "pdf-text" | "spreadsheet-text", name, mimeType, text}`。
  PDF / XLSX / XLS 在 Voice 本地提取为不可信文本；HTML 不执行脚本，表格不执行宏或公式。
  XLS 在 SheetJS 前按实际文件扇区数校验主 FAT / DIFAT，拒绝循环、越界、错位 FAT 页和大目录条目的越界起点。
  此校验不覆盖目录兄弟图、全部 miniFAT 有效性或 XLS 记录分配，也不证明 SheetJS 总内存峰值；Worker 时限不是内存上限。
  每回合最多四项，文本合计 64 KiB / 24,000 字符，还须满足最终请求文本的限额。
  TXT / HTML 及其他可严格解码的 UTF-8、带 BOM 的 UTF-16 文本，原始文本文件限 64 KiB；
  PDF / Excel 原始文件限 5 MiB，扫描、加密、无文本或超限文档明确失败，不静默丢失。
  表格 hyperlink 的原范围循环前检查已解码行列（1000 × 256），并新增单范围访问面积上限 10000。
  XLS 只访问已有 cell；对其链接范围的行列检查也是新增收紧，已有 cell 少但链接范围越界仍会失败。
  XML/XLSB 补建 cell 前检查文档 unique cell 预算 10000；重复/重叠链接不重复计数。
  XLS HLink/Tooltip 仅访问已有 cell，但同样适用这项新的单范围访问规则。负坐标引用明确 INVALID，
  反向范围保留不访问 cell 的行为。超限整份失败为 `VOICE_ATTACHMENT_DOCUMENT_LIMIT`，不返回部分结果。
  其他 cell、共享字符串、注释、CFB 分配仍有既有后置检查；这不是 SheetJS 总内存上限。
  不设置 `sheetRows` 或静默截断。无累计访问次数上限；重复链接的 CPU 仍由整份 Worker 的 20 秒时限兜底。
  Voice 新增每份 PDF 独立的 16 MiB 累计解码分配预算，按 DecodeStream 最大 buffer capacity
  与 Predictor 可变 scratch 最大容量计费。翻页清理不退还；过滤器链、拼接复制和容量余量分别计费，
  大矢量或多流 PDF 即使文字很少也可能返回 `VOICE_ATTACHMENT_DOCUMENT_LIMIT`。这是新规则，
  与 XLSX ZIP 展开限制独立。Flate 等支持路径使用有预算的 JS 解码；系统 DecompressionStream 禁用。
  Brotli 内容流及实际需要 JPEG/JBIG2/JPX/CCITT 解码的路径在 decoder 分配前明确返回 LIMIT；
  被文本提取忽略的图片仍可共存。预算失败后整份文档失败，不返回部分文本；旧 fake-worker 缓存或握手 Worker 错误返回
  DOCUMENT_UNAVAILABLE。握手取消立即返回 AbortError；静默 port 沿用整份文档原有 20 秒 TIMEOUT，
  不另起一轮握手时限。该预算不覆盖 CMap cidrange、sampled function Size、内容操作数或字体表计数
  等非解码结构，不承诺整个解析过程的 RSS 上限。原有 100 页和 20 秒独立 Worker 生命周期仍保留。
- 图片仅 PNG / JPEG、DSH 和具有 `vision` 输入标志的实际模型。每张最多 5 MiB、
  4096 边长 / 16 百万像素，每回合图片合计 10 MiB。WebP / SVG / GIF / HEIC 当前不支持。
  `attachmentUploads.start → chunk → finish` 返回受控 `leaseId`、SHA256、MIME 和大小，
  插件不得提供任意 URL、本地路径或原始 handle。固定分块 256 KiB；同一账号/插件/会话
  最多一个未完成上传，已完成 lease 可并存，再顺序上传下一张。
  未完成或失败的上传不能发送，取消/移除用 `cancel` 清理。

图片字节在账号私有内存中。同一 account/app/session 最多四个有效 lease，其中最多一个
未完成；每账号最多16个有效句柄。`start` 按声明的完整 `byteLength` 预留空间，所有 lease
合计最多20 MiB，不能只按已收到的分块计算。项目或配置 revision 改变不会重置会话配额，
访问时仍核验完整 Owner 的账号、插件、会话、项目、opaque binding、revision 和授权代次。
闲置180秒或总寿命15分钟后失效，重启不会恢复字节。已发送图片为同会话的工具循环和历史
重放暂留，不能在受理后立即取消；实际请求匹配的图片过期时明确拒绝。旧图片仍在会话
历史中时，需新建任务再上传；在原会话追加新图片不会恢复已过期或重启丢失的图片。
单文件5 MiB、每回合四附件/图片合计10 MiB及原生 PDF 输入关闭的限额保持不变。

Host 把图片注入精确匹配原始用户消息的模型请求，不修改 native archive 的稳定文本前缀。
当前回合携带图片的消息必须以 Host 随机 marker 和原文 SHA-256 精确匹配一次；缺失、
内容变化或重复均拒绝。历史图片 marker 完全未出现在本次 DSH history 时允许省略；
一旦出现就必须唯一且位于 hash 一致的原始用户消息，不能把变动或重复当成缺席跳过。
实际匹配的图像逐一验证 lease、完整 Owner、完成状态、MIME、长度、hash 和 TTL。

附件 metadata 保存为私有 Ledger 的可空 `SessionBinding`，序列化上限16 KiB，不新增
公开 Session/Turn schema 字段，不包含图像字节。prior 读取、binding 更新与 turn 接受在
同一 admission 事务提交或回滚；同 key/body 的已受理重放不再次修改 metadata。事务内
callback 纯校验并构造待提交 binding，只用同一事务提供的 prior 与原生会话身份凭据，
不重入 Ledger 查询或写入入口，也不调用出站 binding reader。

每次 HTTP builder（含401重试）通过不公开的 reader 读取同会话 Ledger 最新 binding
一次，严格核验账号/插件/会话归属、会话仍有效及16 KiB上限。最新 binding/snapshot
必须仍等于原 Context；冻结这次出站 stamp 后，按最新 `requested` 执行完整授权/能力
guard，再按原生 body 的精确 marker 投影实际进入 history 的图片。一次发送的校验与
投影使用同一冻结 stamp，不能在中途换用另一次读取结果。

回合接受顺序不保证 native worker 执行顺序。A先接受、B先进入原生历史时，旧A Context
仍需读取包含A+B的最新 stamp；body 若包含两条精确匹配消息，就投影两图，尚未进入
本次 history 的历史图片继续按缺席规则省略。admission factory 不得调用此 reader。
此乱序执行闭环的合成回归与真实 DSH localhost 探针已通过，不代表真实 OAuth 或模型视觉验收。

丢失回执时保留原始 key、问题和完整 typed parts 重发。已受理的同 key/body 先返回原回执，
不重复上传、模型调用或工具执行；已受理回合的观察只用 `getTurn/events/waitForTurn`。
未受理的过期或异项目 lease 会拒绝。同会话各次模型请求、每次实际 HTTP 发送及401重试
前均重新验证当前绑定、授权和该请求实际匹配的 lease/Owner；允许省略历史图片不能放宽
当前回合图片的精确匹配要求。不为附件在发送阶段刷新模型目录。

这里的内容输入不等于原文件读写：Agent 得到提取文本或受控图像；对项目内文件的工具操作
继续遵守已选工作范围、模式及现有批准。支持矩阵与 SDK 类型为字段事实源，正式发布和真机
视觉识别验收独立进行。
