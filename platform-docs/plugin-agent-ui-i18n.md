# @reai/agent-ui 语言入口（实例级 i18n）

状态：2026-09-15 定稿。`platform/ui/agent-ui` 是共享聊天 UI 库，不是插件包：
没有 App manifest、没有 `.reaiapp`、也没有自己的语言包。本文描述它的实例级
语言注入与更新 API，供 Device Doctor、Agents Tasks 等消费者直接参考接线，
不需要复制公共库实现。

资源格式、覆盖要求与 Host locale 联动语义完全沿用
[插件语言包规范 v1](./plugin-i18n-v1.md)：语言由消费者的 Host locale 快照与
`assets/locales/*.json` 驱动。公共库不创建全局可变 locale、不做网络词典、
不持久化独立语言偏好，也不引入第二套插件语言包格式。

## 导出 API

全部从包根导入（`import { … } from "@reai/agent-ui"`）：

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `createAgentUiI18n` | `(options?: { locale?: string; messages?: Record<string, AgentUiLocaleMessages> }) => AgentUiI18n` | 创建一个实例级语言入口。`locale` 是 Host 解析后的语言标签（`"zh"` / `"en"`），默认 `"zh"`；`messages` 是消费者自己的资源表（`assets/locales/<locale>.json` 的原样解析结果），按语言标签索引，可不传。 |
| `AgentUiI18n` | 接口 | 见下。 |
| `AgentUiTextSource` | `string \| (() => AgentUiTextSource)` | 文案来源：字面量或纯文本 getter。传函数时语言变化会重新求值。 |
| `AgentUiLocaleMessages` | `Record<string, unknown>` | 一份语言资源表（嵌套对象 + 字符串叶子）。 |
| `AGENT_UI_DEFAULT_MESSAGES` | `Record<string, AgentUiLocaleMessages>` | 内置默认文案（zh/en），即下表键值；可用来对照抄键。 |
| `readAgentUiText` | `(source: AgentUiTextSource) => string` | 解析 TextSource（高级用法）。 |

`AgentUiI18n` 实例成员：

| 成员 | 说明 |
| --- | --- |
| `locale` | 当前语言标签（只读）。 |
| `t(key, params?)` | 取一条文案；插值是 `{name}` 单趟替换，参数按普通文本显示。 |
| `setLocale(locale)` | 切换语言并**原地更新**本实例绑定的全部节点，返回是否真的切换。语言未变时是幂等 no-op——Host `onChange` 会立即回放当前语言，可放心重复调用。 |
| `bindText(node, source)` / `bindAttribute(element, name, source)` | 给自建节点绑定文案/属性（高级用法）；内部组件已自动绑定。 |
| `releaseBindings(root)` | 丢弃 root 子树内的绑定（业务重渲染替换子树时）。 |
| `onChange(listener)` | 订阅语言变化（文案更新之后触发）；返回退订函数。 |
| `dispose()` | 释放全部绑定与订阅（视图卸载时）。此后 `setLocale` 不再触碰任何节点。 |

组件挂载选项的增量（全部可选，旧调用完全兼容）：

| 组件 | 新增 | 备注 |
| --- | --- | --- |
| `mountConversationStream(container, { agent, items, i18n? })` | `i18n` | 返回值新增 `dispose()`。 |
| `mountAgentComposer(container, { placeholder, …, i18n? })` | `i18n`；`placeholder` 放宽为 `AgentUiTextSource` | 传字符串行为同旧版；传函数时 placeholder / aria-label 随语言重求值。 |
| `createSearchInput({ placeholder, i18n?, onInput })` | `i18n`；`placeholder` 放宽为 `AgentUiTextSource` | 同上。 |
| `createStatusPill(status, { i18n? }?)` | 第二参 `options.i18n` | 单独创建的药丸也会随实例更新。 |
| `mountPaneResizer(pane, appEl, { …, i18n? })` | `i18n` | 只翻译手柄 `title` 提示；`ariaLabel` 是消费者文案，不翻译。 |
| `formatDuration(seconds, i18n?)` | 第二参 `i18n` | 时间格式随语言更新（`3 分 12 秒` / `3m 12s`）。 |

## 默认行为（不注入实例）

不传 `i18n` 时，每个组件在内部使用一个私有的默认实例（内置中文，与历史版本
逐字一致），行为与旧调用完全相同：`AGENT_STATUS_LABEL`、`formatDuration`、
对话流与输入坞的全部自有文案维持原有中文字符串。私有实例不导出、不可变更，
因此不存在全局可变 locale，实例之间也不可能有污染。

## 内置资源键与翻译映射

消费者可以直接使用内置文案（只在 `createAgentUiI18n` 传 `locale`、不传
`messages`），内置 zh/en 已覆盖下表全部键。需要改写措辞时，把要改的键抄进
自己的 `assets/locales/zh.json` / `en.json`（保持相同叶子路径），再整个
传入 `messages`。**不需要全量复制**：缺键按回退链处理。

| 键 | 中文（内置） | 英文（内置） | 消费位置 |
| --- | --- | --- | --- |
| `agentUi.status.wait` | 等你确认 | Needs confirmation | 状态药丸 |
| `agentUi.status.busy` | 工作中 | Working | 状态药丸 |
| `agentUi.status.idle` | 空闲 | Idle | 状态药丸 |
| `agentUi.status.off` | 离线 | Offline | 状态药丸 |
| `agentUi.message.selfAvatar` | 我 | Me | 我方消息头像字 |
| `agentUi.card.imageAlt` | 图片 | Image | 图片卡片缺省占位（有 `alt` 时用数据） |
| `agentUi.anchor.running` | 进行中 | In progress | 任务锚点运行状态 |
| `agentUi.anchor.done` | 已完成 | Done | 任务锚点完成状态 |
| `agentUi.work.elapsed` | 耗时 {duration} | Took {duration} | 工作卡完成态耗时 |
| `agentUi.work.running` | 已运行 {duration} | Running {duration} | 工作卡运行态耗时 |
| `agentUi.ask.confirmed` | ✓ 已确认 | ✓ Confirmed | 已回答提示标题 |
| `agentUi.ask.answer` | 你的回答：{answer} | Your answer: {answer} | 已回答提示内容 |
| `agentUi.composer.backToLatest` | 回到最新消息 | Back to latest message | 待确认坞标题与展开态 aria |
| `agentUi.composer.expandPrompt` | 展开待确认 Action 并回到最新 | Expand pending action and go to latest | 待确认坞折叠态 aria |
| `agentUi.composer.attach` | 添加附件 | Add attachment | 附件按钮 title / aria |
| `agentUi.composer.voice` | 语音输入 | Voice input | 语音按钮 title / aria |
| `agentUi.composer.promptKind` | Action | Action | 待确认坞类别标签 |
| `agentUi.resizer.hint` | 拖动调整宽度 · 双击复位 | Drag to resize · double-click to reset | 拖宽手柄 title |
| `agentUi.duration.seconds` | {seconds} 秒 | {seconds}s | `formatDuration` |
| `agentUi.duration.minutes` | {minutes} 分 | {minutes}m | `formatDuration` |
| `agentUi.duration.minutesSeconds` | {minutes} 分 {seconds} 秒 | {minutes}m {seconds}s | `formatDuration` |

`t` 的回退链：所选语言的消费者资源 → 消费者英文（避免混语，规范要求）→
所选语言的内置默认 → 内置英文 → 内置中文 → 告警（`console.warn`，便于定位）
并返回键本身。未知语言最终落到内置英文。

不翻译的内容（与规范一致）：原始消息与 tool 输出、Agent 名称与头像、
时间戳、卡片文件名/时长、待确认问题与选项、用户回答本身。消息气泡仍走
`appendSafeMarkup` 的白名单安全边界，语言切换不改变任何 HTML 处理逻辑。

## 语言更新语义

- **原地更新已存在的节点**：只改专用文本节点和受控属性（`placeholder`、
  `title`、`aria-*`），不重建组件、不卸载 Surface、不刷新页面。
- **保留**：输入值、光标、选区、焦点、滚动位置（对话流与文档级）、工作卡
  折叠态、附件、待确认坞的折叠/悬停状态、`since` 计时数值、已回答的答案。
- **时间格式随语言更新**：工作卡耗时文案在切换时用当前 `since` 值重排。
- **零业务回调**：语言更新不会发送消息、确认 prompt、运行任务或触发消费者
  的任何业务回调（`onSend` / `onPromptAnswer` / `onInput` 等）。传给
  `placeholder` 的函数必须是纯文本 getter。
- **实例隔离**：绑定与订阅都挂在实例上；两个实例不同 locale 互不污染，
  一个视图一个实例即可。反复切换是幂等的；`dispose` 后不再更新任何节点。

## 消费者接线示例

以下伪代码展示 Device Doctor / Agents Tasks 形态的插件如何接入。资源文件
就是插件自己的语言包（`plugin-i18n-v1.md` 的单套资源结构）：

```text
my-plugin/
  assets/locales/zh.json   # 想改写公共库文案时，把上表的键抄进来
  assets/locales/en.json
  src/app.ts
```

```ts
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";
import {
  createAgentUiI18n,
  createStatusPill,
  mountAgentComposer,
  mountConversationStream,
} from "@reai/agent-ui";

// 1. 一个视图实例一个语言入口；先读快照再首屏渲染。
const uiI18n = createAgentUiI18n({
  locale: ctx.locale?.getSnapshot().locale ?? "zh",
  messages: { zh, en },
});

const stream = mountConversationStream(container, { agent, items, i18n: uiI18n });
const composer = mountAgentComposer(dock, {
  // placeholder 想随语言变就传函数（纯文本 getter）；
  // 它同时反映业务状态（如 busy）也没问题，切换时按活状态重算。
  placeholder: () => busy() ? uiI18n.t("doctor.checking") : uiI18n.t("doctor.ask"),
  scrollContainer: stream.element,
  i18n: uiI18n,
  onSend: (text) => submit(text),
});
pillHost.appendChild(createStatusPill(agent.status, { i18n: uiI18n }));

// 2. Host locale 变化：只调 setLocale，已挂载组件的原地更新由此驱动。
//    onChange 会立即回放当前语言；setLocale 对相同语言是 no-op。
const stopLocale = ctx.locale?.onChange(({ locale }) => {
  uiI18n.setLocale(locale);
  // 消费者自己的 DOM（列表、页头等）在这里按需重渲染。
});

// 3. Surface 清理时按相反顺序释放。
// stopLocale?.(); composer.dispose(); stream.dispose(); uiI18n.dispose();
```

注意：不接 `ctx.locale` 的旧 Host 没有该 API 时按 `?? "zh"` 落历史中文默认，
与规范一致。

## 测试与验证

共享包的 DOM 测试在 `platform/ui/agent-ui/tests/agent-ui-i18n.test.ts`，
覆盖：旧调用兼容（默认中文逐字一致）、双语首屏与运行中切换（同节点更新 +
滚动保持）、两实例不同 locale 互不污染、输入/选区/焦点/滚动/折叠/已回答
状态保留、语言更新零业务回调、销毁后不再更新、反复切换无重复通知、资源
回退链与插值。常规命令即可运行：

```sh
cd platform
bun run typecheck     # 含 tsc --noEmit -p ui/agent-ui
bun test ui/agent-ui  # 已并入 platform 的 bun test 清单
```
