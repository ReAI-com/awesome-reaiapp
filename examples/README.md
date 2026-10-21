# 独立插件样例

这里的样例展示插件如何脱离 Driver Host 源码开发、测试和打包：

- `todo-app/`：Surface、Command、Intent、存储与 Agent UI 样例。
- `titlebar-actions-app/`：第三方标题栏动作最小样例。
- `capability-probe/`：能力探针。列出插件平台全部能力，并用按钮逐项实测本机真实结果。
- `skins/codex/`、`skins/claude/`：声明式 Skin v1 样例。

每个样例都有自己的 `package.json`、`bun.lock` 和验证命令。先按共享包说明安装 `packages/` 依赖，再进入选定样例目录：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

共享包职责和验证入口见 [packages/README.md](../packages/README.md)。`todo-app` 的浏览器预览另见其 [README](todo-app/README.md)。

仓库内的 `file:` 依赖用于本地联调。本仓库没有自动执行仓库外 tarball 安装及真实 Host 安装生命周期的入口；上述命令通过不能作为这两项验收的证据。真实 Host 安装、启用、卸载、重装和交互仍须单独验证。

这些目录是开发样例，不是已审核的商店插件。不得把样例当作 Driver 内置批准包或 Tauri 发布资源。官方插件同样必须经过正常申请、自动测试、权限检查和人工审核，`publisherId: "reai"` 不会绕过流程。
