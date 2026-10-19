# Awesome ReAI App

ReAI 官方插件、开发文档、共享工具和示例的统一仓库。插件支持独立构建、安装和升级，无需随 Host 重新打包。

脱敏文档已先发布，15 个插件和 4 个示例随后完成测试、编译与重复打包。完整版本和包摘要见 [本地打包验收](docs/source-delivery-2026-10-03.md)。源码公开和本地出包不表示平台已审核、签名或上架。

最近一次插件与共享工具同步及验证见 [2026-10-19 源码同步](docs/source-delivery-2026-10-19.md)。源码候选未因同步而送审或上架，网站版本单独核验。

- 开放平台：[open.reai.com](https://open.reai.com/)
- 中文文档：[开发规范](https://open.reai.com/docs/)
- 英文文档：[English reading guides](https://open.reai.com/docs/en/)
- 发布状态：[docs/deployment-status.md](docs/deployment-status.md)

## 目录

```text
plugins/       官方插件，各自维护版本和构建脚本
docs/          开发规范、API、设计与版本文档
packages/      SDK、CLI、合同、测试工具和共享 UI
examples/      插件开发与皮肤示例
scripts/       本地校验与提交预检
website/       VitePress 文档站
open-website/  中英文开放平台介绍站点
```

共 16 个官方插件：`agents-im`、`agents-tasks`、`browser`、`code-worker`、`codex-app`、`codex-link`、`computer`、`device-doctor`、`dsh-agent`、`files`、`pi-agent`、`podcast`、`terminal`、`text-editor`、`voice`、`wishing-wall`。

每个插件使用稳定的 `appId`，独立维护 `app.manifest.json`、依赖锁、测试和版本记录。共享依赖变更后检查所有受影响插件。

## 本地验证

所有开发与验证在独立 worktree 中执行。逐个进入 `plugins/<slug>/`，运行冻结安装及其已有脚本：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

使用 `packages/` 的 `test` 与 `typecheck` 检查共享工具，使用 `website/` 的 `build` 检查文档站。具体脚本及额外要求见各目录说明。受审核限制的能力必须提供当前版本的有效证据，不得跳过门禁。

插件设置页、版本日志和关于入口遵循 [版本文档规范](docs/plugin-settings-and-release-notes-v1.md)。审核提交时根据实际改动和验证证据撰写版本介绍。

## 公开范围与许可

生产配置、凭据、用户数据、内部审查记录、迁移来源记录和本地开发技能不进入公开提交。构建产物与依赖安装目录保持忽略。

仓库尚未指定整体许可证。第三方组件及素材遵循各自的许可与署名，相关声明保留在对应目录中。
