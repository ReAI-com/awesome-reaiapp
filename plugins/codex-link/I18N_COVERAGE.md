# Codex Link 中英文覆盖

设计参照：`design/VoiceType_UI_Designs.html#app/codex`。只翻译插件自己的文字；任务、审批、交接、Skill 和模型选择仍使用原有 API 与稳定 ID。

## 页面与运行时

| 范围 | 实现与验收 |
| --- | --- |
| 页面、任务列表、分组、空态、连接状态 | `assets/locales/zh.json` / `en.json` 是唯一资源；已有节点随语言原地更新 |
| 账户与授权 | 主干账户卡片、浏览器/设备码授权、登录失败和重试提示使用同一语言包；切换时保留设备码、卡片节点、焦点与滚动，不触发登录、取消或账号同步 |
| 新任务 | 目录提示、模型、推理强度、快捷键、预设不匹配说明、创建/重试/长等待状态；保留输入、选择范围、目录和模型值 |
| 审批详情 | 批准/拒绝、等候说明、剩余审批数、交接可用性；不重建按钮，不改变焦点、滚动或请求 ID，不补发审批或已读回执 |
| Skills | 快速开始提示、添加目录、挂载说明、错误与 aria；名称、描述、路径和 Action intent 保持原样 |
| 历史与目录刷新 | 保留主干的分页游标、刷新去重和 `refresh-skills` 入口；加载更多、项目目录、读取失败与警告随 locale 更新，不补发分页或 Skills 请求 |
| 日期 | 相对时间跟随当前语言，包括单复数、时间未知；不改时间戳 |
| 错误 | 可控错误保留消息键或惰性消息；呈现时使用当前语言，原始错误码、原因和详情按纯文本保留 |
| 生命周期 | Runtime 先读 `ctx.locale` 并订阅；各 Surface 读取最新快照。后台文本和晚开 Surface 使用最新语言，卸载解除订阅并释放绑定 |

语言通知只更新 Text 节点、属性及 `lang`。不调用 `renderSnapshot`、刷新、模型请求、存储写入、挂载、任务创建、审批或会话已读回执。正常业务刷新仍保持原来的状态更新逻辑。

## Host 静态元数据

送审候选（0.5.12 起）声明 `metadata.i18n@1`，Host 范围为 `>=1.19.0 <2.0.0`。不可变旧包不受影响。

2026-09-26 的 0.5.11 送审被开放平台拒绝：平台 Manifest 合同基线（1.1@c3475cb）的 i18n `messages[].target` 枚举不含 `storeListing.*` 等 v2 目标（原文「/i18n/messages/9/target · enum · 1.1@c3475cb」，第 9 条即 `storeListing.category`）。与 Voice（b220b130）、Browser（e142e1ab）同姿势：能力降回 `metadata.i18n@1`，移除全部 `storeListing.*` 引用；商店展示文案改由提交表单填写。语言包里的 `metadataV2.*` 键暂留（未被引用，不影响校验），待平台合同升到 v2 目标后再挂回。`scripts/plugin-submission.ts` 已加同一枚举的本地预检，打包前就会拒绝 v2 目标。

| target | ID / index | 资源 |
| --- | --- | --- |
| `name` | `—` | `metadata.name` |
| `description` | `—` | `metadata.description` |
| `surface.title` | `main` | `metadata.surface` |
| `sidebar.label` | `codex-link` | `metadata.sidebar` |
| `titlebarAction.label` | `new-task` | `metadata.newTaskLabel` |
| `titlebarAction.text` | `new-task` | `metadata.newTaskText` |
| `command.title` | `com.reai.codex-link.new-task` | `metadata.newTaskLabel` |
| `command.title` | `com.reai.codex-link.approve` | `metadata.approve` |
| `command.title` | `com.reai.codex-link.deny` | `metadata.deny` |

`build`、`validate`、`pack` 使用独立 `reai-app-i18n` 门禁；保留原 SDK/CLI/contract/test-kit 依赖 pin。最终包必须含两个资源且 Build Manifest 摘要匹配。

## 测试和证据边界

`tests/codex-locale.test.ts` 验证首屏、zh→en→zh、重复通知、后台与晚开 Surface、原始内容/错误保持、待决模型错误、创建结果不确定状态、审批节点/焦点/滚动、无额外 bridge 请求和卸载清理。现有 Codex 测试继续覆盖创建顺序、重试去重、输入法、目录选择及交接权限边界。

`tests/main-integration-locale.test.ts` 从真实 `mountCodexView` 进入账户、历史与 Skills 分支；验证中英切换保持新主干行为、设备码及服务原文，并且没有登录、账户、分页或 Skills 额外调用。原始错误即使文字恰好等于受控标签，也保持原文。

执行 `bun test`、`bun run typecheck`、`bun run validate`、`bun run build`、`bun run test:contract` 和 `bun run pack`。合同测试使用 Mock Host，其日志中的未注入 Codex bridge 是夹具边界；通过仅证明注册、ready、卸载和无出网，不能充当真实 Codex 连接证明。

仍须单列的验收：

- v2 支持包自有 listing、截图说明、阶段承诺、权限用途与依赖名称；远端 Catalog 的营销字段有独立来源，不用本地包译文覆盖，也不把本地验证当作服务端发布。
- 用户已挂载的 Skill Action 项是持久偏好，语言通知不重写它；新的用户挂载操作用当前语言生成说明。已有历史项仍保存当时的说明，Skill 名称和描述不翻译。
- 浏览器/原生界面的英文尺寸与可达性、Host 静态元数据实际显示、签名包、Catalog/安装及真实 Codex 服务连接是独立验收；自动 fixture 和本地包成功不代表这些项目通过。

剩余源码中文仅为开发日志、存储解析诊断和注释；原始服务/用户内容可以包含任意语言。
