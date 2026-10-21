# 能力探针（capability-probe）

`com.example.capability-probe` 是一个开发样例插件：它把 Driver 插件平台的每一项能力讲成人话，能测的就点按钮真实调用一次，结果当场显示，可导出 JSON 报告。用来回答「插件现在到底能做什么」，也是 [AI 员工范式](../../docs/ai-employee-pattern-v2.md) 落地前的能力摸底工具。

本插件是本地开发样例，不送审、不上架，`publisherId` 为 `example`。

## 能看到什么

| 页面 | 内容 |
| --- | --- |
| 总览 | 四档能力数量：免审、需要用户同意、需要平台批准、暂未开放；「运行全部安全测试」 |
| 本机基础能力 | 运行环境、Driver 与固件版本、本地存储读写、键盘按键命令、调用 Voice 服务、跳转 Driver 设置页，以及两个「应该被拒」的存储反例 |
| 需要同意的能力 | 是否已登录、系统通知、经 Driver 访问外脑健康检查，以及两个网络反例（没声明的网址、http 明文） |
| 页面与脚本 | 四项页面脚本自检（内联脚本、字符串当代码、运行时脚本文件、iframe），以及「声明式页面」示例和四个会被拒的反例 |
| 外脑云端 | 外脑对插件开放的接口清单（知识库、数据行、文件、工作流、模型等）和反例，本版按钮关闭 |
| 需要平台批准 | Agent、云端模型、文件夹增删改查、Agent 在文件夹里干活等，本版按钮关闭 |
| 全部能力 | 支持矩阵里的全部能力，标明档位、是否本插件已声明、审核清单里批准给了哪些插件 |
| 插件仓对照 | 插件仓里每个插件（官方插件和 com.example 示例）声明了哪些能力（打包时的静态快照） |
| 记录与报告 | 本次打开以来的测试记录与 JSON 报告（全选文字复制） |

「全部测试」只跑不会跳页面、不会弹通知、不会启动别的插件的项目；「跳到 Driver 设置页」「发一条系统通知」「调用 Voice 插件的服务」要单独点。

结果的意思：

- **成功**：按预期成功。
- **被拦下**：反例按预期被拒（只认预期的那个原因）；或者你还没同意对应权限（会写明去哪里点允许）。
- **与预期不同**：结果和公开文档不一致，值得报告给平台。在浏览器预览里，页面脚本自检会显示这个，因为预览没有 Driver 的页面限制。
- **出错**：调用失败，开发者模式下展开「诊断信息」看错误码。
- **等你操作**：需要先做一步，比如先给「测试按键」绑定一个键。

错误码和原始原因只在 Driver 开发者模式打开时显示，导出的报告也一样。

网络反例说明：当前 Driver 对本地开发包一律按严格网络档检查。如果你用的是较旧的 Driver，开发者模式下本地包可能走宽松网络档，没声明的地址也会放行，两个网络反例会显示「与预期不同」；在「设置 → 开发者」打开「严格网络预览」后再测即可。

## 装进 Driver（仅 macOS）

1. 在本目录打包（见下方「本地构建」），得到 `capability-probe-0.1.1.reaiapp`。
2. Driver「设置 → 开发者」打开「开发者模式」。
3. 「App Store → 已安装 → 从本地安装」，选这个文件，确认「未经审核」提示。
4. 安装时会列出三项权限（账户状态、系统通知、网络），都可以先拒绝，看看「被拦下」的结果，再去「已安装 → 能力探针 → 权限」里允许后重测。
5. 侧栏点「能力探针」，标题栏点「全部测试」。

同一个 appId 已装过时要先卸载再装新包。Windows 目前不能安装本地第三方包。

## 为什么有些能力不能测

本地开发包只能声明「免审」能力和三项「需要用户同意」的权限。只要在清单里声明任何一项「需要平台批准」的能力（比如 `agent.session@2`、`cloud.model.invoke@1`、`resources.files@1`），安装就会整包失败（`APP_CAPABILITY_NOT_GRANTED`）。所以这些能力本版只列出「会调什么、预期什么」。

## 连接外脑（以后的 P1 版本）

外脑云端的接口要用**插件自己的** OAuth 应用身份去调：插件在清单里声明 `oauthAppId` 和 `auth.mode = "oauth_app"` 的网络地址，Driver 会替插件附上令牌，插件拿不到令牌原文。要打开「外脑云端」页的按钮，需要：

1. 在 Driver 的开发者中心为本插件建一个产品和 OAuth 应用，勾选要测的 scope（例如 `profile:read`、`projects:read`、`project:files:*`、`project:kb:*`、`project:data:*`、`documents:*`、`flows:execute`、`runs:read`、`model-gateway:invoke`）。
2. 把应用编号写进 `app.manifest.json` 的 `oauthAppId`，在 `network.endpoints` 里为每组接口加一条 `oauth_app` 地址，重新打包安装。外脑接口目录见外脑开放平台文档。
3. 准备一个专门的测试项目，探针只写这个项目。

每个外脑接口需要的 scope 和预期结果，已写在「外脑云端」页每张卡片上。

## 声明式页面 PageSpec v0

插件页面不允许运行「运行时生成的 JS」（Driver 的页面安全策略只放行插件包里的脚本）。替代做法是：Agent 或模型只产出一份 JSON，由插件预置的渲染器画出来。

- 组件：`text`、`metric`、`list`、`button`、`form`。
- 数据来源：`kv.value`（只读 `page.` 开头的键）、`kv.keys`、`probe.result`。
- 动作：`kv.set`、`kv.delete`、`probe.run`（只能触发安全测试）、`notify.post`（要再点一次确认）。
- `data.*`、`files.*`、`kb.search`、`model.chat` 认识，但要连上外脑才能用，本版直接拒绝。
- 严格校验：多一个字段、引用白名单外的动作、超出预算（整份 16 KB、20 个组件），整份拒绝并说明原因。渲染器只用 DOM API，不用 `innerHTML`，不执行字符串里的代码。

这是探针内的草案，验证可行后再并入 AI 员工范式 v2 的组件库正式合同。

## 本地构建

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack          # 得到 capability-probe-0.1.1.reaiapp
bun run dev           # 浏览器预览：http://127.0.0.1:4179/preview.html
```

预览用假数据，没有 Driver 的权限和页面限制，只用来看界面和交互；`?theme=dark`、`?deny=1`、`?page=basic` 可直接切到对应状态。

插件仓里的插件有变化后，运行 `bun run snapshot` 重新生成「官方插件对照」快照；改完 `CHANGELOG.md` 后运行 `bun run release-notes`。

## 文件

```text
src/app.ts               插件入口：注册命令与界面
src/port.ts              探针调用 Host 的窄接口（真实 Driver 实现）
src/preview-port.ts      预览与测试用的假 Host
src/catalog.ts           能力目录：支持矩阵 + 审核清单 + 本插件清单
src/capability-text.ts   每项能力的人话说明
src/probes.ts            探针清单与执行
src/csp-check.ts         页面脚本限制自检
src/page-spec.ts         PageSpec v0 校验
src/page-renderer.ts     PageSpec v0 渲染
src/report.ts            JSON 报告
src/view.ts              界面
src/generated/           官方插件快照（脚本生成）
```

## 已知限制

- 界面只有中文，还没有英文语言包。
- 「插件仓对照」是打包时的快照，插件仓变化后要重新运行 `bun run snapshot` 并重新打包。
- 审核清单的批准按「任一版本」统计，不区分具体版本。

## 未验证

源码测试、合同测试和浏览器预览只证明代码与 Mock Host 的行为。以下没有验证：真实 Driver 安装与界面，以及每个按钮在真实 Driver 里的结果。真实结果以安装后导出的报告为准。
