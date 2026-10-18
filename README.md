# Awesome ReAI App

本仓库计划作为 ReAI 全部官方插件未来公开收纳的统一仓库，集中维护插件源码、使用说明，以及独立构建、安装和升级所需的内容。

插件的开发与交付应与 ReAI Host 解耦，支持独立构建、安装和升级，无需随 Host 重新打包。

现已在本地可逆复制全部 15 个官方插件、通用开发文档、开发工具与文档站源码。旧 Board 源目录保留；本次新增源码、文档和站点暂不公开推送，待公开范围、许可与验证结果确认。GitHub 仓库：[kongkang/awesome-reaiapp](https://github.com/kongkang/awesome-reaiapp)。

官方插件的审核、签名与发布遵循正式流程，官方身份不绕过相关要求。

2026-10-02 确认[插件设置页、版本与关于入口规范](docs/plugin-settings-and-release-notes-v1.md)：所有插件设置页底部展示可点击版本号（进入对应更新日志）和「关于插件」（进入 `open.reai.com` 的具体应用详情）。每次审核提交由开发工作流自动撰写插件版本介绍；这是新规范，现有插件和服务仍需逐项实施。开放平台第一版站点（插件目录、详情、日志、场景与整合文档）见 [open-website/](open-website/README.md)。

许可证待核实和确认。

## 公开发布记录

公开目标与权限边界见 [发布状态与默认目标](docs/deployment-status.md)。2026-10-02 的目标待确认状态是历史快照；网站新发布事实以 [网站发布说明](open-website/deploy/README.md) 为准。网站发布不授权公开本地 skill、插件迁移源码或私人验收材料。

## 目录规范

以下目录已在本地迁入；树中的 `voice`、`browser`、`terminal` 是示例，完整插件清单见下文。

```text
awesome-reaiapp/
├── README.md
├── plugins/
│   ├── voice/
│   ├── browser/
│   └── terminal/
├── docs/        # 仓库与插件文档
├── scripts/     # 构建、验证与发布脚本
├── packages/    # 可复用的共享代码包
├── examples/    # 插件开发示例
├── website/     # VitePress 文档站源码、导航与构建配置
└── open-website/ # open.reai.com 中英文介绍站点与整合文档
```

每个插件采用独立目录，基本结构规划如下。正式声明文件名 `app.manifest.json` 已按当前平台规范及现有官方插件核对。

```text
plugins/<slug>/
├── README.md          # 用途、依赖、构建、安装与升级说明
├── app.manifest.json  # 插件正式声明，包含稳定 appId 与插件版本
├── package.json       # 插件依赖及构建、测试脚本
├── bun.lock           # 插件依赖锁
├── src/               # 插件源码
└── tests/             # 插件测试
```

- 目录名应短、稳定，使用小写 kebab-case，例如 `voice`、`code-worker`；不将版本号写入目录名。
- 显示名称可以调整，稳定插件 ID（`appId`）保持不变。
- 每个插件独立维护版本、依赖锁、构建、测试与发布流程，分别生成安装包并独立安装、升级。
- 同处一个 monorepo 不要求插件捆绑发布或同步升级，也不要求重新打包 Host。
- 共享代码放在 `packages/`；共享依赖发生变更时，应测试所有受影响插件，并按实际影响安排各插件发布。

## 本地迁入范围

共 15 个官方插件：`agents-im`、`agents-tasks`、`browser`、`code-worker`、`codex-app`、`codex-link`、`computer`、`device-doctor`、`dsh-agent`、`pi-agent`、`podcast`、`terminal`、`text-editor`、`voice`、`wishing-wall`。

通用开发文档位于 `docs/`，插件专属文档留在各插件目录。`packages/` 包含独立构建必需的 SDK、CLI、合同、测试工具与共享 UI；`website/` 保留文档站导航、主题、同步与构建配置；2026-10-03 已通过 `open-website/` 整合发布到 https://open.reai.com/docs/，旧文档入口保留。

本地迁移与源码测试不等于平台审核、签名、安装及发布获批。迁移后的构建输入须重新验证；不会复制旧审核回执来冒充新产物已获批。

## 本地开发与验证

逐个插件进入 `plugins/<slug>/`，执行 `bun install --frozen-lockfile --ignore-scripts`，再运行其 `test`、`typecheck`、`validate`、`build`、`test:contract`、`pack` 脚本。共享工具进入 `packages/` 运行安装、`test` 与 `typecheck`；文档站进入 `website/` 运行安装与 `build`。各插件 README 说明具体依赖与阻塞。

迁移隔离副本验证：15 个插件测试与类型检查通过；14 个通过校验、构建、合同测试和重复打包。Voice 需对迁移后的精确输入重新取得四项能力源码审核，当前校验与出包保留拒绝。共享工具 424 项测试通过，文档站同步 22 份 Markdown 并构建通过；真实 Host 安装、窗口拖动、点击与截图验收尚未进行。

三个本地技能位于 `skills/reaiapp-development/`、`skills/reaiapp-design/`、`skills/reaiapp-review/`，引用本仓库文档及统一审查清单。`/skills/` 暂时精确忽略以防误公开，未来公开须单独复核；未安装到全局，也未上传。

项目内说“发布到线上”时，先使用 [reaiapp-development](skills/reaiapp-development/SKILL.md) 的发布入口及[本地发布记录](skills/reaiapp-development/references/deployment.md)。2026-10-03 已按本次用户授权将中英文介绍网站与整合文档发布到 `open.reai.com`，网站主机为 `root@cn.reai.com`（node3），[发布说明](open-website/deploy/README.md)记录目录、产物与回滚。插件送审/签名/上架仍须单独核目标；网站发布不代表插件迁移产物获批。入口与记录随 `/skills/` 保持本地忽略，公开须另行复核。

公开前检查仍有待处理项：仓库自身许可证、最终依赖及图标署名、内部规范的公开范围、文档站开发工具升级和真实 Host 验收。原审计 404 已定位为镜像未实现接口；npm 官方审计中 15 个插件与共享工具未返回已知告警，当前文档站返回 4 条 Vite/esbuild 开发服务告警。隔离升级候选已通过冻结安装、审计和静态构建，尚未采用到本目录。源码检查未发现已确认的真实密钥，但这不是完整 Host 安全审计。详细本地证据与待决定选项见 `.migration-review/`（忽略，不发布）。
