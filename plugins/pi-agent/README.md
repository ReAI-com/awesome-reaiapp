# Pi Agent 面板

ReAI 插件 `com.reai.pi-agent`。当前源码版本为 `1.0.5-dev.2`。按调用插件查看 Host 管理的 Pi Agent 会话、能力和新会话模型设置。数据通过 `pi.management.*` 接口读取。

Manifest 声明可选 `runtime.pi` 运行组件（Host 注册探针 `pi-agent-v2`）。实际安装状态由 Host 判断。语言覆盖见 [I18N.md](I18N.md)。

## 本地构建

先在仓库的 `packages/` 目录安装冻结依赖，再在本目录执行：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

本目录依赖 `../../packages/` 中的 SDK 和工具。构建会重新生成 `dist/`、`build-manifest.json` 和 `.reaiapp`，这些产物不提交到 Git。

## 提交检查

复制 `submission.identity.example.json` 为本地 `submission.identity.json`。模板的 `publisherId`、`oauthAppId` 和 `productId` 都是虚构占位，必须替换为实际平台配置。模板不能用于上传，也不代表审核批准。替换后核对 Manifest 的发布者、OAuth App 和版本与本地配置一致。不要在配置里保存密钥。

普通 `bun run pack` 不读取提交身份；提交检查和 `pack:submission` 才读取本地配置。

`submission.identity.json` 保存提交配置。Manifest 的发布者、OAuth App 和版本必须与提交配置一致。Product ID 只用于提交配置。OAuth Client ID 是公开标识，凭据由 Host 管理。

```sh
bun run check:submission --form-version <实际版本>
bun run pack:submission
```

提交打包会检查身份、重复构建和包内资源。表单版本必须与最终包一致。

开发与安装要求见 [开发规范](../../docs/plugin-development-v1.md) 和 [提交规范](../../docs/plugin-submission-v1.md)。本地测试和打包只证明本地结果。真实 Host 安装、用户授权、平台审核和商店发布需要各自的验证证据。
