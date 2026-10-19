# Voice 语言包覆盖清单

依据：[插件语言包规范 v1](../../docs/plugin-i18n-v1.md)。本清单记录源码、包内资源和运行时验证边界，不能替代签名 Host 内的真实验收。

## Manifest 静态元数据

本插件声明 `i18n.locales`、20 个元数据目标和 `metadata.i18n@1` 能力。当前 Manifest 要求 Host API `>=1.25.0 <2.0.0`。安装前必须核对 Host 兼容范围和授权。

资源单一来源是 `assets/locales/zh.json` 和 `assets/locales/en.json`，此次复用已有翻译，不复制词典。Manifest 默认可读文字与原始贡献 ID 保留，命令执行、权限与版本不随显示语言改变。

| target | ID / index | 资源 |
| --- | --- | --- |
| `name` | `—` | `metadata.name` |
| `description` | `—` | `metadata.description` |
| `surface.title` | `main` | `metadata.surfaces.main.title` |
| `sidebar.label` | `voice` | `metadata.sidebar.voice.label` |
| `titlebarAction.label` | `settings` | `metadata.actions.settings.label` |
| `titlebarAction.text` | `settings` | `metadata.actions.settings.text` |
| `scheduledTask.title` | `daily-digest-refresh` | `metadata.scheduledTasks.dailyDigestRefresh.title` |
| `scheduledTask.description` | `daily-digest-refresh` | `metadata.scheduledTasks.dailyDigestRefresh.description` |
| `command.title` | `com.reai.voice.toggle-input` | `metadata.commands.toggleInput.title` |
| `command.bindingPickerTitle` | `com.reai.voice.toggle-input` | `metadata.commands.toggleInput.bindingPickerTitle` |
| `command.title` | `com.reai.voice.toggle-command` | `metadata.commands.toggleCommand.title` |
| `command.title` | `com.reai.voice.command.transcribe` | `metadata.commands.transcribe.title` |
| `command.title` | `com.reai.voice.command.translate` | `metadata.commands.translate.title` |
| `command.bindingPickerTitle` | `com.reai.voice.command.translate` | `metadata.commands.translate.bindingPickerTitle` |
| `command.title` | `com.reai.voice.command.agent` | `metadata.commands.agent.title` |
| `command.bindingPickerTitle` | `com.reai.voice.command.agent` | `metadata.commands.agent.bindingPickerTitle` |
| `command.title` | `com.reai.voice.refresh-day-digest` | `metadata.commands.refreshDayDigest.title` |
| `command.title` | `com.reai.voice.back-to-root` | `metadata.commands.backToRoot.title` |
| `command.title` | `com.reai.voice.open-settings` | `metadata.commands.openSettings.title` |
| `command.title` | `com.reai.voice.open-audio-settings` | `metadata.commands.openAudioSettings.title` |

当前合同以 `packages/contract/i18n-targets.json` 为准；当前 Manifest 仅声明表内目标。资源中未引用的 v2 键不代表 Host 已显示对应翻译。没有真实 Host 展示目标的 app-intent purpose 与 remediation 不伪造翻译入口。远端 Catalog 宣传与 OAuth 权威信息保持来源原文。

## 插件界面与运行时

| 范围 | 实现 | 验证 |
|---|---|---|
| 历史、状态胶囊、分类、日期、回听、详情 | 文本、恢复动作及无障碍属性使用资源；明确绑定的节点原地更新 | 现有语言测试；新增播放期间 Audio、位置、焦点、滚动及节点保留测试 |
| 回听错误 | 媒体解码错误在显示时翻译；原始 MediaError 作为诊断保留 | 中文→英文→中文已有错误节点；第三方错误原文与文本插入安全测试 |
| Context、日总结、删除确认、命令任务 | 自有标签与错误中英化，转写、总结和对话内容保持原样 | 既有单元测试与合同场景 |
| 设置、模型、录音来源、权限指路 | 跟随 App 语言；保留识别语言、音源、润色和云模型选择 | 新增失效云模型选择原地更新测试，无替换 ID、保存或识别调用 |
| 保存录音重试 | 保留最新重试面板、原始方案与本次尝试的区分；展示文字原地更新 | 面板、按钮和焦点不重建，模型名、ASR 语言、原始录音和重试次数不变 |
| 自有 chat-ui | 消费 Voice 注入的同一词典，不新增偏好或副本 | 既有输入节点、草稿、焦点、选区、IME 保留测试 |
| Voice request-text Service | `VOICE_EMPTY_TRANSCRIPT` 与 `com.reai.voice/VOICE_EMPTY_TRANSCRIPT` 保留稳定错误码，在返回时读取当前 locale | 请求开始后切换语言的四个码/语言组合，不向 consumer 透传私有诊断 |
| Manifest 元数据 | 20 个元数据目标声明并从单套资源解析 | CLI 检查资源接线与包完整性；真实 Host 显示需单独验收 |

初始化从 `ctx.locale?.getSnapshot()` 读取语言并订阅 `onChange`，未知语言回退英文。Runtime deactivate 取消订阅，Surface cleanup 释放绑定。语言更新不调用页面业务 render，不重建输入框；正常业务状态变化继续沿用原有 render。

资源插值单次替换，只作为文本写入节点；不递归解释参数里的花括号或 HTML。公共动作使用 `common`。原始服务错误、开发日志、用户转写、历史回复、AI 总结和模型说明不猜译。界面语言不改变 AI 提示词、识别语言或翻译目标，不重写历史。

## 验证命令与证据

在本插件目录执行：

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run validate
bun run build
bun run test:contract
bun run pack
```

`validate`、`build`、`pack` 现在使用独立 `reai-app-i18n` 门禁；旧 `@reai/app-cli` 及其既有本地 pins 保留，包装器复用原构建器。合同检查读取 `dist/app.js`，须先 build。pack 对实际 ZIP 中的资源和 Build Manifest 摘要复验。

当前源码版本为 `2.14.7`。构建与打包结果必须来自当前输入。单元测试、类型检查和本地包检查不能代替平台能力批准或真实 Host 验收。

## 尚待真实验收

代码与模拟 Host 只证明接线和状态保留。签名 App 内实际录音/任务中切换、后台恢复、新开 Surface、元数据实际显示、英文完整布局、登录与系统权限、真实云转写和商店升级尚未由本轮验证。

本次未增加外部后端接口：继续使用 Host locale、既有录音回听/重试调用与 `com.reai.voice/request-text@1`。测试没有发起付费请求，不能据此宣称真实转写后端、账号授权或硬件已经验收通过。
