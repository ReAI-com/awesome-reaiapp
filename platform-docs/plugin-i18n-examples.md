# 插件语言包：三个官方样板

新插件从这三个样板选择相近的实现，按[语言包规范](./plugin-i18n-v1.md)准备自己的语言包。Host 维护全局界面语言，插件只读取它。其他插件的翻译由各插件开发者维护，本任务不批量改造。

| 样板 | 适合参考 | 入口 | 语言适配 | 覆盖清单 |
| --- | --- | --- | --- | --- |
| Codex App | 原生 DOM、保留输入和焦点、受控错误与原文分开 | `plugins/official/codex-app/src/main.ts` | `src/i18n.ts` | [I18N.md](../plugins/codex-app/I18N.md) |
| Codex Link | 多 Surface、后台恢复、审批和模型选择 | `plugins/official/codex-link/src/app.ts` | `src/codex-i18n.ts` | [I18N_COVERAGE.md](../plugins/codex-link/I18N_COVERAGE.md) |
| Voice | 录音任务、播放器、嵌入式 chat-ui、错误和通知 | `plugins/official/voice/src/app.ts` | `src/voice-i18n.ts` | [I18N_COVERAGE.md](../plugins/voice/I18N_COVERAGE.md) |

表中源码路径相对仓库根目录；语言适配路径相对对应插件目录。复制语言资源、挂接和测试模式即可，不必复制三个样板的业务功能、权限、应用 ID 或依赖。旧 `plugins/examples/todo-app` 仍是基础功能历史示例，不作为当前语言包样板。

## 1. 单套资源

```text
my-plugin/
  app.manifest.json       # i18n.locales + messages + 对应 Host capability
  assets/locales/
    zh.json               # 简体中文，完整
    en.json               # 英文，完整
    ja.json               # 可选；存在时接受同样的完整性检查
  src/i18n.ts             # 直接导入 assets/locales，不另存翻译副本
  tests/locale.test.ts
```

开发代码直接消费包内同一份资源。只用纯文本和 `{name}` 插值；参数按普通文本显示。资源、Manifest 目标与发布 CLI 的完整规则以规范及 `platform/contract/i18n-targets.json` 为准。

## 2. 先读快照，再订阅

```ts
// setTranslatorLocale / renderInitialView / updateExistingText 是插件自己的函数。
setTranslatorLocale(ctx.locale?.getSnapshot().locale ?? "zh");
renderInitialView();
const stopLocale = ctx.locale?.onChange(({ locale }) => {
  setTranslatorLocale(locale);
  updateExistingText();
});
// Surface 释放时 stopLocale?.()；Runtime 自己的监听在 deactivate 时释放。
```

`onChange` 会立即回放快照，所以更新必须可重复调用。新增与后台恢复的 Surface 先读最新快照。不要新增全局语言写入权限，不要持久化第二份语言偏好或 revision。

语言改变只更新现有文字、`title`、`aria-label`、`placeholder` 等属性。保留输入框节点、草稿、光标、焦点、选区、滚动和正在执行的任务；不补发业务请求。受控错误保留资源键和参数，显示时翻译；服务原文、用户文字、路径与协议 ID 保持原样。

当前 Host 提供 `zh/en/system` 偏好，插件收到解析后的 `zh/en`。未知语言回退英文；老 Host 没有 locale API 的可选访问保留历史中文默认。增加 `ja.json` 可通过包检查，但不自动增加 Host 语言选项；Host 新增语言需要一起扩展其语言合同、目录、菜单资源和 SDK。

## 3. 可复制的验收

| 操作 | 必须看到 | 不得发生 |
| --- | --- | --- |
| 英文冷启动、后打开 Surface | 首屏直接英文 | 先中文后闪换 |
| 中文 → 英文 → 中文 | 标签、提示、已有错误和无障碍属性同步 | 裸键、混语、重新请求业务 |
| 输入中切语言 | 原节点、草稿、选区、焦点不变 | 重建或清空输入 |
| 隐藏 → 改语言 → 返回 | 当前语言，任务继续 | 重开任务、重复审批 |
| 关闭 → 重开、重复通知 | 单份有效监听，状态正确 | 监听泄漏、重复副作用 |
| 最终包校验 | 全部声明语言、摘要和 metadata 映射完整 | 只检查源码，不检查 ZIP |

三个样板的包目录都可以运行：

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

其 `validate/build/pack` 使用 `@reai/app-i18n-cli` 的 `reai-app-i18n` 严格入口。在本仓库也可直接执行 `bun platform/i18n-cli/src/cli.ts validate <pluginDir>`；对独立开发者分发时，须先核对所使用的 CLI、SDK 与 Host 已发布版本，不能把仓库源码等同于 npm 或客户端已经发布。

`bun scripts/verify-official-plugins.ts --plugin codex-app`（可换为 `codex-link` / `voice`）额外检查仓库外 tarball 安装、最终包与 Rust Host 安装生命周期。三个样板即使删除 `i18n` 声明也不能绕过检查；其他已声明包同样严格校验；未迁移的历史包继续原流程。

自动检查证明格式、挂接及包完整性，不能判断翻译语义、真实服务或原生布局。提交覆盖清单，并分别记录英文布局、真实 Host、授权/服务连接及发布验收。
