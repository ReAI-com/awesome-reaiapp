# 插件共享工具与合同

本目录提供独立插件开发所需的 SDK、构建工具、合同与测试支持。它不包含 Driver Host 运行源码，也不代替平台审核或真实 Host 验收。

| 目录 | 包名 | 职责 |
| --- | --- | --- |
| `sdk/` | `@reai/app-sdk` | 版本化插件 API、生命周期、Surface、Command、存储和服务接口 |
| `contract/` | `@reai/app-contract` | Manifest Schema、支持矩阵、限额、能力合同与正反样例 |
| `cli/` | `@reai/app-cli` | `reai-app` 静态校验、构建、Mock Host 合同测试和打包 |
| `i18n-cli/` | `@reai/app-i18n-cli` | `reai-app-i18n` 语言资源、提交输入和最终包检查 |
| `test-kit/` | `@reai/app-test` | Mock Host 与插件合同测试支持 |
| `ui/agent-ui/` | `@reai/agent-ui` | 可复用 Agent 界面、状态和语言绑定 |
| `fixtures/apps/` | 本地测试 fixture | 共享工具测试使用的最小插件，不是商店产品 |

## 安装与验证

在仓库根目录执行：

```sh
cd packages
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run verify:pack
```

`test` 运行 SDK、CLI、语言工具、测试包、Agent UI 和 fixture 的测试，并对安装探针 fixture 执行校验、构建与合同测试。`typecheck` 检查 SDK、CLI、语言工具、测试包和 Agent UI。具体命令以本目录 `package.json` 为准。

共享包验证之后，进入目标 `plugins/<slug>/` 或 `examples/<name>/`，安装该目录自己的冻结依赖，并运行其 README 中的测试、类型检查、校验、构建、合同测试和打包命令。不要借用其他插件的安装目录。

## 分发与验收边界

仓库内 `file:` 和 workspace 依赖用于本地开发。`verify:pack` 将 SDK、合同、测试包及两种 CLI 的 tarball 安装到仓库外 fixture，验证类型、上传、语言资源、校验、构建和打包。它不访问生产服务，也不证明 npm registry 发布或真实 Host 安装完成。

Mock Host 合同测试、源码审查、平台批准、真实 Host 安装、用户授权和商店发布是不同状态。受控能力被拒绝时，应补齐合法审核证据；不能通过放宽合同或复用旧批准记录完成打包。

公开身份示例、开发流程与提交边界见 `docs/plugin-development-v1.md` 和 `docs/plugin-submission-v1.md`。真实凭据、产品提交身份、私人审查证据与构建产物保留于本地，不提交到 Git。

## 公开 clone 的 CI 门禁

`.github/workflows/plugin-toolchain.yml` 从公开仓库 checkout 开始，使用 Bun `1.3.11`、冻结锁文件和 `--ignore-scripts` 安装依赖。各 job 最长运行 20 分钟，GitHub 权限仅为 `contents: read`。

- 共享工具运行测试和类型检查。
- 4 个示例与 18 个插件（16 个官方插件和 2 个 AI 员工 Demo）分别运行测试、类型检查、校验、构建、合同测试和打包。Voice 需要的受控能力已由能力审核种子中的源码审核记录覆盖，按普通插件验证。

CI 不读取私人审核材料，也不生成替代审核记录或运行批准。以上 job 不启动 Host，也不访问生产环境。

能力审核种子是离线合同 fixture，不能作为当前产物已获得平台批准或已上架的证据。
