# 插件语言包规范 v1

状态：2026-09-07 定案。本文统一插件界面语言资源、App 联动与发布验收；实现框架自由。
本规范的 v1 是语言资源规范版本，不代表 Manifest 或 Host API 新版本。

开始实现时直接参考[三个官方样板与验收步骤](./plugin-i18n-examples.md)：Codex App、Codex Link、Voice。其他插件由各自开发者提供语言包。

## 当前可用与待实现

| 项目 | 当前状态 |
|---|---|
| `ctx.locale.getSnapshot()` / `onChange()` | 仓库 Host API 1.16.0 已实现；是否可分发须核对所用 Host/SDK 发布版本 |
| `assets/` 随 `.reaiapp` 打包并进入 Build Manifest 摘要 | 已实现 |
| 固定中英文资源结构、覆盖要求、公共术语 | 本规范生效，按下面的发布清单验收 |
| CLI 自动检查资源键与插值 | 仓库实现 `reai-app-i18n validate/build/pack`；旧 `reai-app` 保持批准工具链不变，成功不代表语言包合规 |
| Host 静态元数据 | 仓库实现下述 `i18n` 声明；安装、重启与 builtin 只读列表复核包资源，显示时随语言切换。真实客户端/插件发布仍单独验收 |

页面语言合规和整个插件语言合规分别记录。未迁移的旧包继续显示历史默认文字，不能因 Host 支持解析就宣称插件自身已完成迁移。语言验收不替代安装、OAuth、Catalog 审核与真实设备验收。

## 开发者只需维护一套资源

每个插件包必须包含以下文件；开发源直接使用这些文件，不另维护一份翻译副本：

```text
assets/locales/zh.json
assets/locales/en.json
```

`zh` 表示简体中文，`en` 表示英文，二者都必须完整。额外语言可选；文件名采用语言标签，如 `ja.json`、`zh-Hant.json`。当前 Host 只发出 `zh/en`，其他语言文件可随包保留，尚不进入 App 选择界面。第一版不允许插件单独持久化界面语言偏好。

文件使用 UTF-8、严格 JSON（无注释、无尾逗号、无重复键），根及中间节点为对象，叶子为非空字符串；不允许数组、数字或函数作为消息。键段使用英文字母开头的字母、数字、下划线组合，不在键段中写点；嵌套路径以点连接。中文和英文必须具有相同的叶子路径及插值变量集合。已声明的额外语言同样要求完整。

`zh.json`：

```json
{
  "common": { "save": "保存", "cancel": "取消" },
  "settings": { "title": "设置", "saved": "已保存 {name}" },
  "metadata": { "name": "语音输入法" }
}
```

`en.json`：

```json
{
  "common": { "save": "Save", "cancel": "Cancel" },
  "settings": { "title": "Settings", "saved": "Saved {name}" },
  "metadata": { "name": "Voice Input" }
}
```

统一的是资源与插值合同，不是某个框架的完整消息语法。第一版仅支持纯文本及 `{name}` 命名插值，变量名为字母开头的字母、数字、下划线；不在资源中放 HTML、可执行表达式或特定引擎的复数/消息链接语法。字面花括号通过插值参数传入；需要数量表达时使用各语言自然的无变形文案（例如 `Count: {count}`），不能拼接句子碎片。参数中的特殊字符必须按普通文本显示，不得再次作为消息或 HTML 解析。

默认示例可使用现有 Intlify 引擎；Vue、React、原生 DOM 或其他引擎均可，但适配后须满足相同的文本、插值和回退规则。不要把资源格式等同于某个库的全部功能。

## 覆盖范围与公共术语

必须覆盖：插件页面、设置、按钮、菜单、提示、空状态、可控错误说明、工具提示、无障碍标签、插件生成的通知，以及插件提供给 Host 显示的名称、描述、侧栏、Tab 和 Action 文案。开发者应逐项建立覆盖清单。

不翻译：用户输入、录音转写、文件及聊天内容、第三方原始输出、代码、品牌名、稳定协议标识、开发日志。插件自身的错误标题与恢复操作必须可翻译；原始服务错误可放在详情中。界面语言变化不得改变 ASR 识别语言、翻译目标或 AI 输出语言，也不得改写历史记录。

相同操作采用以下公共术语；只复制实际使用的项到插件自身的 `common` 对象。业务文案按语义编写，不要求所有插件使用相同句子，也不依赖 Host 在线分发词典。

| 键 | 中文 | 英文 |
|---|---|---|
| `save` | 保存 | Save |
| `cancel` | 取消 | Cancel |
| `close` | 关闭 | Close |
| `retry` | 重试 | Retry |
| `delete` | 删除 | Delete |
| `settings` | 设置 | Settings |
| `loading` | 加载中… | Loading… |

`metadata` 保留插件静态展示文案，内部使用符合上述键名规则的稳定资源别名（如 `toggleInput`）；在覆盖清单记录原始 Manifest ID 到资源路径的映射，如 `com.reai.voice.toggle-input` → `metadata.actions.toggleInput`。原始 ID 含点或连字符时不直接用作键段，也不改写原始 ID。Manifest 保留可读的历史默认文字，不改变 command/action/tab ID。使用下一节的正式 `i18n` 声明；仅准备 `metadata` 资源不会让 Host 自动翻译。

## 静态元数据声明与 CLI 门禁

```json
{
  "requires": { "hostCapabilities": ["metadata.i18n@1"] },
  "i18n": {
    "locales": ["zh", "en"],
    "messages": [
      { "target": "name", "key": "metadata.name" },
      { "target": "sidebar.label", "id": "main", "key": "metadata.sidebar.main" },
      { "target": "command.title", "id": "com.example.run", "key": "metadata.actions.run" }
    ]
  }
}
```

这只是相关字段片段。`messages` 必须覆盖 Manifest 中实际存在的全部受支持目标；稳定贡献 ID 放在 `id`，不把它改成资源键。v1 的目标（下列十一类）不因扩展能力而增加必填项。机器可读事实源是 `@reai/app-contract/i18n-targets.json`：name、description、sidebar.label、surface.title、command.title、command.bindingPickerTitle、titlebarAction.label/text、titlebarStatus.label、scheduledTask.title/description。顶层与 singleton 目标不带 id，其余目标按原贡献 id 精确查找。每个目标恰好一次，不接受悬空目标或资源键。

静态元数据不得带插值，单个显示值最多 1024 UTF-8 字节。标题栏另按 Unicode 码点计数：action label 最多 48、action text 最多 12、status label 最多 24；CLI 与 Host 都拒收超限译文，避免切语言后被显示守卫隐藏。每份语言文件最多 256 KiB、16 层，最多 16 种语言及 512 个元数据引用；所有声明语言与包内额外 JSON 语言文件都检查键/变量一致。Host 仅把已校验的 zh/en 展示文字送到界面；未知语言回退英文。执行仍使用原 Manifest，资源翻译不改变命令指纹、包摘要或原始 ID。

`metadata.i18n@1` 是普通 App 的独立能力门禁，不请求新用户 permission。Skin 仍禁止 runtime capability，直接由新 i18n Schema 与 Host 安装读取支持；旧 Host 对未知 i18n 字段拒收。不能只根据旧 `>=1.16.0` 范围断言支持静态元数据。无 i18n 的不可变旧包保持可用。

Tab 来源名和 Action 的 Manifest Command 名由 Host 翻译；插件运行时推送的任务/聊天标题、用户内容不猜译，插件须通过既有 locale API 更新自有业务文案。Surface title 可在包内解析，但当前主窗口使用 App 名称作为页面标题；不能据资源存在虚称出现了新的 Surface 标题界面。

安装 `@reai/app-i18n-cli` 后，新发布使用独立入口：

```sh
reai-app-i18n validate ./my-app
reai-app-i18n build ./my-app
reai-app-i18n pack ./my-app --out ./my-app.reaiapp
```

三个入口默认严格要求 i18n 与完整语言资源。pack 调用冻结的原构建器，再对实际 ZIP 字节复核，失败不替换目标包。旧 `@reai/app-cli` 不改动；它已被现有批准包锁定，不能为加语言门禁而绕过工具链 pin、重写旧 lock 或重复提交已付费审核。共享 contract 新增字段后，旧 CLI 会接受带 i18n 的 Manifest，但不检查语言资源；旧命令成功不能替代新命令门禁，违规包仍会被 Host 拒装。未声明 i18n 的历史包由 Host 保持兼容，不读取语言资源；新 CLI 即使在兼容模式下仍检查发现的语言文件。超过 512 个可见静态目标的插件需先缩减贡献数量，不能只声明其中一部分。本入口与 Host 支持的源码合入不等于 CLI/插件已发布到外部。

新增插件及本轮三个样板使用 [`metadata.i18n@2`](./plugin-i18n-metadata-v2.md)，进一步覆盖本地详情、截图、权限用途与依赖名称；其余 v1 旧包保持原目标要求。当前官方验证对三个样板及任何已声明 i18n 的包强制严格入口；三个样板删除声明也会失败，未迁移旧包不在本轮被强制改造。

## App 语言联动

插件使用现有只读环境 API，不新增 permission，不请求修改全局语言：

```ts
const initialLocale = ctx.locale?.getSnapshot().locale ?? "zh";
setTranslatorLocale(initialLocale);
renderInitialView();

// onChange 会立即回放当前语言；更新操作必须可重复调用。
const stop = ctx.locale?.onChange(({ locale }) => {
  setTranslatorLocale(locale);
  updateExistingViewText();
});
// 在对应 Surface cleanup 中调用 stop?.()。
```

上面的三个函数是插件自己的适配函数，不是 SDK 新增接口。先设置语言再首屏渲染；打开、后台恢复及后打开的 Surface 都使用当前快照。重复通知不得重复业务操作；订阅者异常不应影响其他订阅者。`revision` 只在当前 Host 会话内排序，插件不持久化它。

更新现有节点与相关属性，保留输入、光标、焦点、滚动位置、对话与录音/下载/执行任务。不要通过卸载整个 Surface、刷新页面或重启 Runtime 切语言。监听器随 Surface 释放，后台业务监听随 Runtime 释放。已存在的系统通知不强制重写；下一条通知使用最新语言。

所选资源缺键时回退英文，英文仍缺则开发环境告警并显示键用于定位；发布验收不得出现这种情况。未知语言回退英文。旧 Host 缺少 `ctx.locale` 时按历史中文默认；若不提供可选访问兼容，`hostApi.range` 至少声明 `>=1.16.0 <2.0.0`，并核对真实 Host 支持。新增静态元数据能力不能仅凭这一版本范围宣称兼容。

## 发布检查与旧包迁移

规范生效后的新插件及已有插件的新发布版本必须补齐中英文；已发布不可变旧包继续可用，不就地覆盖同一版本，不以语言规范为由强制卸载。纯资源皮肤或无界面包也须提供其自有可见元数据的中英文，无界面时不要求接入不存在的 Surface。

发布须执行独立 CLI 语言门禁并提交结果。商店服务端的强制拒收逻辑不在本仓库任务范围，不能把本地校验当成服务端审核、翻译质量或真机验收。未迁移插件及其他未实现项仍逐项报告。

1. 检查 JSON 语法、重复键、字符串叶子、空值、键路径与插值一致；同文值不自动判错（品牌名可相同），需要人工核对翻译质量。
2. 运行插件自身测试、类型检查、合同测试、构建和打包；从最终 `.reaiapp` 解包复核两个资源及 Build Manifest 摘要，源码存在不等于包内存在。
3. 扫描可见硬编码文案并检查覆盖清单；扫描只能辅助，不能识别全部动态文案或语义正确性。
4. 冷启动中文/英文，前台切换、后台后返回、关闭再打开；检查无混语、裸键、插值残留、英文遮挡及无障碍属性。
5. 在存在未提交输入或任务时切换；验证内容、焦点、业务状态保留，无重复执行、无多余订阅。
6. 单列 Host 元数据的实际显示结果，安装授权、商店上架和真机业务验收独立记录。

## Voice 首个迁移验收

Voice 使用本规范，不单独另建语言格式。覆盖主页面、录音状态、历史列表/详情、Context、命令任务、设置、模型/权限提示、错误与恢复动作，以及自有聊天组件。保留识别内容、提示词/协议含义及识别/翻译配置。

交付至少包括：独立 PR 和准确 head SHA、完整中英文资源、覆盖清单、语言切换与状态保留测试、类型检查、最终包文件及摘要、双语言界面验收记录。审核者必须读代码与最终包，不能只看 PR 描述；Host 元数据等缺口应列为未完成，不计为 Voice 已完全合规。
