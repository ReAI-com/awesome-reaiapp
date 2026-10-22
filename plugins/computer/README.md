# computer

ReAI 官方插件源码候选。用途、能力、权限与贡献点以 `app.manifest.json` 为准。

## 独立仓库构建

稳定 ID：`com.reai.computer`；当前候选版本：`0.1.1-dev.1`；需要 Host API `>=1.25.0 <2.0.0`。本目录依赖 `../../packages/` 中的 SDK 与工具，不依赖 Board Host 源码进行构建。

```bash
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

`validate` / `build` / `pack` 使用带语言门禁的 `reai-app-i18n`。修改 `CHANGELOG.md` 后先运行 `bun run sync:notes` 再测试；`build`、`pack` 与 `pack:submission` 会自动同步。语言覆盖见 [I18N.md](I18N.md)。

送审前复制 `submission.identity.example.json` 为 `submission.identity.json`（已被忽略，不入库），填入当前产品的真实身份后运行 `bun run check:submission` 与 `bun run pack:submission`，流程见[提交规范](../../docs/plugin-submission-v1.md)。本插件需经平台审核后从商店安装：`com.reai.computer` 为保留的官方 appId，本地导入会被 App 拒绝。

开发、权限、安装与升级边界见 [开发规范](../../docs/plugin-development-v1.md) 和 [提交规范](../../docs/plugin-submission-v1.md)。真实 Host 安装及交互仍需按规范验收；迁移或本地出包不等于获得发布批准。
