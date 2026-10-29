# codex-link

ReAI 官方插件源码候选。用途、能力、权限与贡献点以 `app.manifest.json` 为准。

## 独立仓库构建

稳定 ID：`com.reai.codex-link`；当前迁移版本：`0.5.13`。本目录依赖 `../../packages/` 中的 SDK 与工具，不依赖 Board Host 源码进行构建。

```bash
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

开发、权限、安装与升级边界见 [开发规范](../../docs/plugin-development-v1.md) 和 [提交规范](../../docs/plugin-submission-v1.md)。真实 Host 安装及交互仍需按规范验收；迁移或本地出包不等于获得发布批准。

## 提交配置模板

复制 `submission.identity.example.json` 为本地 `submission.identity.json`。模板的 `publisherId`、`oauthAppId` 和 `productId` 都是虚构占位，必须替换为实际平台配置。模板不能用于上传，也不代表审核批准。替换后核对 Manifest 的发布者、OAuth App 和版本与本地配置一致。不要在配置里保存密钥。

普通 `bun run pack` 不读取提交身份；提交检查和 `pack:submission` 才读取本地配置。
