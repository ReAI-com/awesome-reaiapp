# 插件服务与 Agent / DSH 扩展规范 vNext

> 文档状态：**Host API 1.14 已实现 App Service 最小子集；其余仍为规划**<br>
> 当前实现基线：Driver V2 Host API `1.14.0`（2026-08-29）<br>
> 当前接口事实源：[插件接口参考](./plugin-api-reference-v1.md)、
> `host-support-matrix.json`、`app-manifest-1.1.schema.json`<br>
> `contributes.services`、`requires.services` 与 `ctx.services.provide/call` 已实现；
> `contributes.agentScenes`、`contributes.agentTools`、Service 进度、headless Provider、
> `speech.transcribe@1` 仍为规划名称；`com.reai.voice/request-text@1` 已有实现候选，版本与发布边界见下方合同页。

> F04 implementation candidate: see [Voice request-text](./voice-request-text.md) for the implemented request/control shapes and remaining release gates. The broad target design below is not a release declaration.
## 1. 先说人话

一个插件以后可以同时带三样东西：

1. 用户看到的界面；
2. 其他插件可以直接调用的服务；
3. Agent 可以按场景使用的提示词和工具。

它们仍然是**同一个 `.reaiapp`**：共用 appId、版本、签名、安装、升级、停用和卸载。
不存在另一套“DSH 插件商店”，也不需要把第三方代码塞进 DSH 引擎进程。

最重要的边界是：

- 调用方已经知道要做什么，直接调用服务；
- 只有需要模型自己判断“要不要调用”时，才把服务包装成 Agent Tool；
- Agent 场景由插件开发者定义，DSH Profile 只是 Host 选择的执行载体；
- 安装新能力后，必须由用户确认“继续刚才的任务”，Agent 不会自行恢复运行。

## 2. 当前方案与目标方案

| 问题 | Host API 1.14 当前实现 | 本规范的目标方案 |
|---|---|---|
| 插件间拿结果 | App Service 已支持类型化输入/输出、取消、超时和结构化错误；尚无进度 | 增加进度、Provider 选择与审计管理面 |
| 语音输入 | `voice.input@1` 只授予 `com.reai.voice`；Voice 自己调用 `ctx.voiceInput` | 其他插件可调用 `com.reai.voice/request-text@1`，无需提供音频，最后只拿文本 |
| 音频转写 | 识别运行在 Host Rust `voice/` 服务中，但没有通用插件服务合同 | 开放 `speech.transcribe@1`；输入 Host `audioRef`，输出文本，不绑定 Voice Web Runtime 生命周期 |
| Agent 场景 | 插件在代码里直接创建 `AgentSessionSpec`，自己传 `systemPrompt/tools/skills` | 插件在包内声明 Agent Scene；Host 校验后生成本次 Pi/DSH 配置 |
| 工具目录 | Agent Session 创建时固定；DSH Host Bridge 使用固定目录 | 每个 Scene、会话和 generation 按安装、授权、挂载状态计算有效工具 |
| 能力变化 | 同一会话没有动态能力事件合同 | 当前会话记录 `capabilities.changed`；用户确认后下一回合使用新目录，接受一次缓存 miss |
| 缺少插件 | 没有 Agent → App Store → 安装 → 原任务续接合同 | Agent 只提出建议；用户安装后再次确认，原会话继续 |
| 无界面插件 | 当前支持矩阵仍要求一个 `web-surface` | 允许 service/headless App；不占侧边栏，在“更多/已安装 App”中管理 |
| 官方与第三方 | 生产 Catalog 当前是 `official-only`，部分能力按官方 appId seed | 目标合同不区分官方/第三方；同一字段、limit、审核和授权规则 |

所以，今天 App Service 的最小公开合同已经落地。Scene、Agent Tool、进度、交付和动态能力仍为规划，
下文凡标注“目标”的字段都不能当作当前可用接口。

Host API 1.14 同时落地了一个有界的 Host executor 子集：官方本地配音 Provider 可声明
`implementation: "host:tts.local@1"`，由 Host 直接执行本地推理并用绑定调用身份的一次性短期凭据交付
WAV。它不创建隐藏 Provider Web Runtime；其他未声明固定 Host 实现的 Service 继续由 Provider
JavaScript handler 执行，不能把这一特例泛化为任意 Host 私有旁路。

## 3. 四层合同，不要混成一层

### 3.1 App Service：确定性的复用能力

Service 是插件或 Host 对外提供的稳定方法。例如：

- `speech.transcribe@1`：音频引用进，文本出；
- `com.reai.voice/request-text@1`：请求用户说一段话，文本出；
- `com.example.browser/search@1`：查询进，结构化搜索结果出。

调用方已经明确要转写、录音或查询时，直接调用 Service，不让模型多做一次选择。

### 3.2 Agent Scene：插件定义的一条 Agent 工作流

Agent Scene 由插件随版本发布，至少说明：

- 输入和输出；
- 提示词及其包内版本摘要；
- one-shot 还是持续会话；
- 需要哪些服务或 Agent Tool；
- 依赖发生在预处理、Agent 运行中还是结果交付阶段；
- 最终结果由谁展示、写回或继续处理。

Voice 的“翻译”和“带联网搜索的 Agent”是两个不同 Agent Scene。它们不是在开发底层 DSH
Profile 时预先写死的全局场景。

### 3.3 Agent Tool：Service 的模型适配器

Agent Tool 是模型可见的函数合同。它可以引用一个 Service 方法，但两者不是同一概念：

- Service 默认不出现在模型上下文里；
- 只有插件显式声明 Tool adapter，Host 才把名称、说明和 JSON Schema 给模型；
- Direct Service 和 Agent Tool 必须调用同一个 Provider 实现，不能复制两套业务代码。

Pi 和 DSH 都消费 Host 的同一份有效工具目录。DSH 侧只注册薄工具桩，实际调用回到 Host Broker，
再由 Host 分派给对应 Provider。

### 3.4 Delivery：结果归谁、界面归谁

服务提供者返回结果，不替调用者猜界面行为：

- 普通插件调用 Voice 后，拿到文本，由调用插件插入自己的输入框并决定是否发送；
- 翻译 Scene 返回译文，由调用方或声明的 Presentation Owner 展示；
- Agent Scene 的结果进入它自己的会话/面板，不强行写回原输入框；
- Provider 不得访问调用方 DOM、保存 CSS selector、模拟点击或伪造发送命令。

普通 Promise 返回时，调用方本来就知道结果属于哪个本地输入框，不需要把 DOM 目标交给 Voice。
确有跨 Surface 延迟投递时，只能使用 Host 签发的 `receiverRef`：它绑定调用 appId、当前 mount、
逻辑接收者、TTL 和单次消费，插件不能伪造或反解。

## 4. 同一个 App 包可以贡献什么

目标 Manifest 允许一个 `.reaiapp` 同时贡献：

| 贡献 | 作用 | 是否必须有界面 |
|---|---|---|
| UI Surface | 设置、结果、历史、管理界面 | 是 |
| App Service | 被其他插件或 Host 类型化调用 | 否 |
| Agent Scene | 插件自己的 Agent 工作流 | 否 |
| Agent Tool adapter | 让模型按需调用某个 Service | 否 |

安装、升级或卸载始终以整个 App 为事务单位。用户安装浏览器 App 时，UI 和它携带的 Service/Tool
一起进入系统；“是否安装”与“是否挂载到某个 Agent Scene”是两层状态：

```text
已安装并启用
  → 被某个 Agent Scene 声明或由用户挂载
  → 通过权限和平台策略
  → 本回合真正被调用
```

不能因为 App 已安装，就把它的所有工具默认塞进每个 Agent 会话。

## 5. Voice 应该怎样拆

### 5.1 原子转写：有音频的人直接拿文本

目标服务：

```text
speech.transcribe@1
  input:  Host 签发的 audioRef + language/options
  output: text + language + timing/diagnostic
```

音频可以来自录音、音频文件或其他 Host Broker，但插件只能传 `audioRef`，不能传任意本地路径。
当前实际识别引擎位于 Host Rust，因此开放服务合同不等于把识别代码搬进 Voice Web Runtime，
也不应该让底层转写能力取决于 Voice 界面是否正在运行。

`audioRef` 至少绑定来源、调用者、用途、TTL 和消费次数。Provider 不能把音频转交给未声明的网络
端点，Host 也不能把一个插件的引用交给另一个未授权插件。

### 5.2 交互式语音输入：调用方没有音频也能用

目标服务：

```text
com.reai.voice/request-text@1
  input:  language / source preference / interaction label
  output: text + language + outcome
```

调用方只表达“我需要用户说一段话”。Voice/Host 负责：

```text
显示录音交互
  → 获取音频
  → 调用同一转写内核
  → 返回文本
```

调用插件无需开发录音、无需提供音频，也无需切换到 Voice 主界面。结果返回调用插件后，调用插件自己：

```ts
// 目标接口示意，当前 SDK 尚不可用
const requestId = crypto.randomUUID();
const result = await ctx.services.call({
  requestId,
  serviceId: "com.reai.voice/request-text@1",
  method: "request",
  input: { language: "auto", interactionLabel: "为消息输入语音" },
});

composer.insertText(result.text);
// 是否 send() 由调用插件决定。
```

后台 Agent 不得静默打开麦克风。DSH 若调用“请求用户语音输入”工具，Host 必须先显示明确的应用内
交互；用户开始并完成录音后，文本才返回原 Agent 会话。

### 5.3 三条上层流程复用同一能力

| Voice 场景 | 流程 | Agent 工具 |
|---|---|---|
| 语音输入 | request text → 调用方插入文本 | 不需要 |
| 翻译 | request text → one-shot 模型翻译 → 返回译文 | 不需要其他工具 |
| Agent | request text → 进入持续 Agent Scene → 结果进入 Agent 界面 | 只挂该 Scene 声明且已授权的工具 |

“录音来源不同”和“文本去向不同”都只是上层组合，不应复制转写内核。

## 6. 目标 Manifest 合同

下面混合了已实现的 Service 字段和仍为规划的 Scene/Tool 字段；完整示例整体不能直接打包：

```json
{
  "contributes": {
    "services": [
      {
        "id": "com.reai.voice/request-text@1",
        "activation": "on-demand",
        "methods": [
          {
            "id": "request",
            "inputSchema": { "type": "object", "additionalProperties": false },
            "outputSchema": {
              "type": "object",
              "required": ["text", "outcome"],
              "properties": {
                "text": { "type": "string" },
                "outcome": { "enum": ["recognized", "cancelled"] }
              }
            },
            "interaction": "user-present",
            "timeoutMs": 120000
          }
        ]
      }
    ],
    "agentScenes": [
      {
        "id": "com.reai.voice/translate@1",
        "prompt": {
          "entry": "prompts/translate.md",
          "sha256": "<pack 时计算并锁定>"
        },
        "memory": "one-shot",
        "dependencies": [
          {
            "serviceId": "speech.transcribe@1",
            "phase": "preprocess",
            "necessity": "required",
            "acquisition": "on-demand"
          }
        ],
        "delivery": { "owner": "caller", "format": "text" }
      }
    ],
    "agentTools": [
      {
        "id": "com.reai.voice/request-user-speech@1",
        "serviceId": "com.reai.voice/request-text@1",
        "method": "request",
        "description": "用户明确同意后，请用户说一段话并返回文字。",
        "interaction": "user-present"
      }
    ]
  },
  "requires": {
    "services": [
      {
        "id": "speech.transcribe@1",
        "version": ">=1 <2",
        "necessity": "required",
        "acquisition": "on-demand"
      }
    ]
  }
}
```

目标字段落地时必须同时更新 Manifest Schema、Host/CLI 双侧 validator、SDK 类型、支持矩阵、正反
fixture 和合同测试，不能先让 validator 接受后静默忽略。

### 6.1 Service 方法最小合同

每个方法至少声明或由平台固定：

- 稳定、带命名空间的 Service/Method ID 与版本；
- JSON Schema 输入和输出；
- 是否要求用户在场、是否有副作用；
- 超时、最大输入/输出、并发和速率；
- 进度、精确取消、幂等/重试语义；
- 稳定错误码；
- 数据类别、网络端点、系统权限和保留策略；
- 调用者、Provider 与委托链审计。

目标 SDK 需要 `call/cancel/onProgress` 三类能力。Host 按 `requestId + callerAppId` 隔离调用，
Provider 不能读取其他调用方的请求或结果。

### 6.2 Agent Scene 最小合同

每个 Agent Scene 至少声明：

- 稳定 Scene ID、标题和用途；
- 输入/输出 Schema；
- 包内 prompt entry、版本和摘要；
- `one-shot` 或 `session`；
- preprocess / agent-tool / postprocess-delivery 三阶段依赖；
- 每个依赖的必要性、获取时机和 fallback；
- Presentation Owner 与结果格式；
- 所需权限、数据类别、超时和取消策略。

提示词、Tool 描述和 Schema 都会进入模型上下文，属于审核内容。它们必须随签名包版本化；运行时从
远端静默替换提示词等价于绕过审核，只能禁止，或作为新版本/新摘要重新审核与确认。

## 7. Scene 依赖：必需性和安装时机是两回事

每条依赖要分别说明：

| 维度 | 可选值 | 回答的问题 |
|---|---|---|
| `necessity` | `required` / `optional` | 没有它能不能继续当前任务 |
| `acquisition` | `preinstalled` / `on-demand` | 什么时候获取 Provider |
| `phase` | `preprocess` / `agent-tool` / `postprocess` | 在流程哪一步使用 |

不能把 `required` 和 `on-demand` 混成一个枚举。

- 可选依赖缺失或被拒：Scene 可以继续，Agent 必须知道该能力不可用并如实降级；
- 必需依赖缺失且无 fallback：Host 阻止当前任务，让用户选择“放弃任务”或“重新安装/授权”；
- preprocess 依赖由流程确定性调用，不自动暴露给模型；
- 只有 `agent-tool` 依赖进入有效工具目录。

Service 依赖稳定 capability/service ID，不硬编码 Provider appId。存在多个 Provider 时，Host 按平台
策略、用户选择、版本兼容和授权状态确定一个 Provider，并把选择写入能力快照。

## 8. 动态工具与同会话热更新

每次创建 Scene 或继续会话时，Host 计算：

```text
有效工具
  = Scene 请求的 Agent Tools
  ∩ 当前已安装且启用的 Provider
  ∩ 当前用户授权与 Scene 挂载
  ∩ 当前平台/渠道策略
```

“已安装”“已挂载”“本回合已调用”必须分开记录。工具多不是能力强：无关工具会增加 token、降低
模型选择准确率，所以任何 App 都不能把自己的全部工具默认挂给所有 Agent。

能力发生变化时：

1. 已经在飞的模型请求不改变；
2. Host 向 Session Log 写入 `capabilities.changed` 和新的 canonical snapshot；
3. 用户确认继续后，下一回合使用新工具目录；
4. 接受这一次前缀缓存 miss，之后以新前缀重新稳定；
5. 不要求用户新建对话。

快照至少包括：Tool 名称与 Schema 摘要、Provider appId/版本/包摘要、grant、Scene attachment、
generation 和解析时间。这样回放和审计仍然能解释“当时模型究竟看到了什么”。

卸载或撤权时，Host 先生成 tombstone/generation 变化；迟到调用返回结构化
`capability_revoked`，不能变成无法解释的 404。Skill/prompt 变化比 Tool 更重，也必须进入摘要和
generation，不能静默热换。

## 9. 缺能力时：搜索、安装、再由用户继续

App Store 面向 Agent 开放的是**能力搜索和安装建议**，不是静默安装权限：

```text
Scene 发现缺少能力
  → Host 搜索审核 Catalog 中提供该 capability 的 App
  → Agent/Host 说明为什么需要、将获得什么能力和权限
  → 用户点击或语音确认安装
  → Host 完成整个 .reaiapp 的安装事务
  → 显示“继续刚才的任务”
  → 用户再次确认
  → 原会话记录能力 generation 并继续下一回合
```

安装完成**不能自动恢复 Agent**。用户安装 App 可能只是想稍后使用；只有“继续刚才的任务”这个明确
动作才授权下一回合。

系统 Catalog 能力只允许 Agent 搜索 Provider、读取已安装状态和发起安装/卸载**建议**。真正的安装、
停用或卸载仍由 Host 展示影响范围并等待用户点击或语音确认；模型不能直接提交安装事务。卸载前还要
列出会失效的 Agent Scene 和待续任务，确认后再撤销 grant、挂载和工具 generation。

待续任务使用持久化状态机：

```text
awaiting_install
  → installing
  → awaiting_resume
  → resumed | abandoned | expired
```

待续记录包含 appId、sessionId、sceneId、原请求、所需 capability 和 generation。继续动作使用 Host
签发、单次消费的 token。应用重启、安装失败、用户取消、Provider 再次失效或授权变化后，Host 先重新
preflight，不能靠内存回调或旧快照直接执行。

### 9.1 依赖嵌套与拒绝记忆

- 安装建议只解析审核 Catalog 中的 capability Provider；
- 依赖闭包一次性展开、去重，并限制深度和总数；
- 循环依赖必须在上架审核和安装 preflight 阶段拒绝；
- 拒绝账本按 `(requesterAppId, capabilityId)` 保存，阻止后台或嵌套依赖反复弹窗；
- 设置中允许用户重置拒绝记录；
- 用户显式再次发起一个被必需依赖阻断的任务时，Host 可以显示一次“放弃/重新安装”决策框，
  但不能循环自动弹出。

## 10. 无界面 Service App 与“更多”

目标运行时允许：

- UI App：主要提供界面；
- Hybrid App：界面 + Service/Scene/Tool；
- Service App：没有主 Surface，只提供受管后台能力。

Service App 不应该为了“让用户看见它”强占侧边栏。侧边栏只放用户固定或经常打开的 UI Surface；
“更多/已安装 App”是完整管理面，显示所有类型的 App，并允许查看：

- 已安装、启用、健康与版本；
- 提供和依赖的 capability；
- 挂载到哪些 Agent Scene；
- 权限、后台状态和资源使用；
- 拒绝记录重置、停用和卸载。

Headless 不是更高权限。它仍受 Component Supervisor、资源预算、心跳/退出健康检查、网络 Broker、
用户授权和卸载事务约束。当前支持矩阵仍要求单一 `web-surface`；在这些 Host 生命周期合同落地前，
开发者不能发布真正的无界面 App。

## 11. 安全与审核

### 11.1 第三方代码不进入 DSH 引擎

允许第三方提供 Function/Tool、MCP 或 Skill，不等于加载第三方 DSH 进程内插件：

| 扩展形式 | 位置 | 边界 |
|---|---|---|
| Direct Service | Host Broker → Provider Runtime | 默认不进模型上下文 |
| Function / Agent Tool | DSH/Pi 薄桩 → Host Broker | 模型可选择，副作用仍由 Host 门禁 |
| MCP | 受管远程/进程适配 | 网络、凭据和生命周期由 Host 管理 |
| Skill / Prompt | 模型上下文 | 必须版本化、摘要化、审核和限长 |
| DSH 进程内插件 | 冻结引擎闭包 | 只允许平台可信组件，不作为通用 App 扩展面 |

第三方 App 不能拿 Wainao token、真实 provider/model ID、任意文件路径或 DSH 进程控制权。

### 11.2 官方和第三方“规范同权、审查同责”

目标 Schema 不提供“官方专用 Scene 字段”。平台自带 Voice 也必须：

- 使用同一 Manifest 字段和命名空间；
- 遵守同一 Schema/大小/数量/超时限制；
- 声明相同权限、数据类别和依赖；
- 接受相同 prompt、Tool Schema 和副作用审核。

同权不等于安装即拥有高权限。能力仍可按风险分级、审核、用户授权和平台策略关闭；关键是规则不能
写成某个官方 appId 的私有旁路：一项能力要么仅属于 Host 内部、插件都不能调用；要么公开为插件能力，
所有满足同一条件的插件都按同一合同申请。

当前生产 Catalog 仍是 `official-only`，部分 grant 仍由编译期 seed appId 控制。这是需要迁移的现状，
不是目标合同。预装只表示默认分发状态，不产生额外 API。

### 11.3 Agent 内容也是攻击面

审核至少覆盖：

- prompt 原文、摘要和更新方式；
- Tool 名称、说明、输入输出 Schema 与大小；
- Service/Tool 的权限、网络、数据去向和副作用；
- 依赖图、fallback、懒安装理由与循环；
- 网页、文档和 Tool 输出中的 prompt injection；
- 调用者、Provider、Agent Scene 和委托链来源展示；
- 取消、超时、重复调用、撤权和卸载后的行为。

Provider 的品牌和能力可以被其他 App 组合，但调用链不能把 Voice 或浏览器能力冒充成调用插件自己实现。

## 12. 与其他规范的关系

| 文档/概念 | 关系 |
|---|---|
| [插件开发规范](./plugin-development-v1.md) | 当前可执行开发路径；只放本文摘要和入口 |
| [插件接口参考](./plugin-api-reference-v1.md) | Host API 1.10 的真实可用接口；本文 vNext 字段不能覆盖它 |
| [运行依赖规范](./runtime-dependencies-v1.md) | Runtime Component 回答“代码在哪里运行”，本文 Service/Scene 回答“对外提供什么能力” |
| `docs/driver-v2-dsh-integration-proposal.md` | 引擎集成实施记录；其中 DSH Profile 是执行载体，不再定义产品侧 Agent Scene |
| 通知 `sceneKey` | 表示通知投递场景；与 Agent Scene ID 使用不同命名空间、授权和账本 |
| [发行策略](./distribution-policy-v1.md) | 包签名、审核状态、Catalog 和分发流程的事实源；本文只增加 Agent 内容审核项 |
| [外脑工作流分发基线](./wainao-cloud-workflow-distribution-v1.md) | 云端身份、工作流快照和计费边界；不由 Agent Scene 重新定义 |

在实现代码落地前，冲突时以当前支持矩阵、Schema、fixture 和接口参考为准。

## 13. 建议实施顺序

1. 先冻结 Service、Agent Scene、Delivery 三份合同和正反 fixture；
2. 开放 `speech.transcribe@1`，只接受 Host `audioRef`；
3. 用同一合同跑通 Voice 输入、翻译、Agent 三条 Scene；
4. Pi/DSH 共用动态 Tool Catalog、generation 和 Session Log 快照；
5. 接 App Store capability 搜索、依赖解析、安装授权和人工续跑；
6. 最后开放 headless Service App 与完整“更多/已安装 App”治理面。

每一步都必须保留旧 Host 的 fail-closed 行为：新 Manifest 不能装进不认识它的 Host，旧插件也不能因为
新合同出现而被静默升级或改变语义。
