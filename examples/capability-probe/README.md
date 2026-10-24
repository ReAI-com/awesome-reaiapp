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
| 外脑云端 | 用插件自己的 OAuth 身份调外脑：用户、项目、文件、知识库、数据行、工作流、模型 8 项正向测试，加 4 个没开放接口的反例；写操作只在「test」项目里做 |
| 需要平台批准 | Agent、云端模型、文件夹增删改查、Agent 在文件夹里干活等，本版按钮关闭 |
| 全部能力 | 支持矩阵里的全部能力，标明档位、是否本插件已声明、审核清单里批准给了哪些插件 |
| 插件仓对照 | 插件仓里每个插件（官方插件和 com.example 示例）声明了哪些能力（打包时的静态快照） |
| 记录与报告 | 本次打开以来的测试记录与 JSON 报告（全选文字复制） |

「全部测试」只跑不会跳页面、不会弹通知、不会启动别的插件的项目；「跳到 Driver 设置页」「发一条系统通知」「调用 Voice 插件的服务」要单独点。

结果的意思：

- **成功**：按预期成功。
- **按预期拦下**：反例按预期被拒（只认预期的那个原因）。
- **被拦下**：你还没同意对应权限（会写明去哪里点允许）。
- **与预期不同**：结果和公开文档不一致，值得报告给平台。在浏览器预览里，页面脚本自检会显示这个，因为预览没有 Driver 的页面限制。
- **出错**：调用失败，开发者模式下展开「诊断信息」看错误码。
- **等你操作**：需要先做一步，比如先给「测试按键」绑定一个键。

「成功」和「按预期拦下」算通过，其余都算没通过。总览顶部的验收卡显示「通过 N / 共 M 项」，列出没通过的项和原因；「跑完全部」按钮会依次跑完全部测试，最后一项会跳到本插件的权限页，点 Driver 右上角的「返回」回到探针：Driver 会带回回执，这一项以回执确认通过（点「关闭」不回来的话，这一项保持「还没测」）。测试结果保存在本插件自己的存储里，跳走再回来、重新打开都还在，可在「记录与报告」里清空。

错误码和原始原因只在 Driver 开发者模式打开时显示，导出的报告也一样。

网络反例说明：当前 Driver 对本地开发包一律按严格网络规则检查（「严格网络预览」开关不影响拦截）。两个网络反例如果显示「与预期不同」，说明 Driver 版本较旧，请更新。

## 装进 Driver（仅 macOS）

1. 在本目录打包（见下方「本地构建」），得到 `capability-probe-0.2.1.reaiapp`。
2. Driver 打开开发者模式。
3. 「设置 › 开发者选项 › 从本地安装 .reaiapp」选这个文件；或者在 Finder 里双击包文件，交给正在运行的 Driver。确认「未经审核」提示。
4. 安装弹窗会列出要同意的项目：账户状态、系统通知、网络、Voice 文字服务、网络地址。全部同意才能全部通过；也可以先取消勾选，看看「被拦下」的结果，再到「已安装」点开能力探针，在「权限」里允许后重测（Voice 服务依赖只能在安装弹窗里决定）。
5. 侧栏点「能力探针」，第一次要点「启用并打开」。
6. 「键盘按键触发命令」需要先触发一次命令：到「设备 › 键位映射」点一个键，在「插件动作」里选「能力探针：测试按键」，按一下这个键或点绑定抽屉里的「测试」。
7. 「发一条系统通知」需要 Driver 自己有 macOS 通知权限：「设置 › 权限与隐私 › 系统通知 › 允许通知」，再在系统弹出的提示里点「允许」。
8. 总览点「跑完全部」。0.2.1 起外脑云端 12 项全部接上，共 29 项。
9. 测完到「记录与报告」点「清理测试数据」，一键删掉探针留下的数据（测试文件和测试工作流外脑不让插件删，会告诉你去哪删）。

同一个 appId 已装过本地包时，直接装新包就是更新，不用先卸载；更新后要重新确认权限并重新启用。Windows 目前不能安装本地第三方包。

## 为什么有些能力不能测

本地开发包只能声明「免审」能力和三项「需要用户同意」的权限。只要在清单里声明任何一项「需要平台批准」的能力（比如 `agent.session@2`、`cloud.model.invoke@1`、`resources.files@1`），安装就会整包失败（`APP_CAPABILITY_NOT_GRANTED`）。所以这些能力本版只列出「会调什么、预期什么」。

## 连接外脑

外脑云端的接口要用**插件自己的** OAuth 应用身份去调：插件在清单里声明 `oauthAppId` 和 `auth.mode = "oauth_app"` 的网络地址，Driver 会替插件附上令牌，插件拿不到令牌原文。本版已接好（应用编号见 `app.manifest.json`）。换成你自己的应用时：

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
bun run pack          # 得到 capability-probe-0.2.1.reaiapp
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
src/saved-results.ts     测试结果保存与恢复
src/host-version.ts      读取 Driver 版本（界面可见后、带重试）
src/view.ts              界面
src/generated/           官方插件快照（脚本生成）
```

## 已知限制

- 界面只有中文，还没有英文语言包。
- 「插件仓对照」是打包时的快照，插件仓变化后要重新运行 `bun run snapshot` 并重新打包。
- 审核清单的批准按「任一版本」统计，不区分具体版本。

## 验证情况

- 0.2.0 已在 Driver 主干开发版（1.0.5，提交 438234e，带 `STORAGE_NOT_DECLARED` 检查）上实测：本地安装、权限同意、启用，清空结果后「跑完全部 17 项」，从权限页点「返回」回到探针，17 项全部通过。「键盘按键触发命令」用 Driver 开发版的 `--debug-app-command` 触发（来源记为手动调用），没有用实体键盘按键。
- 实测中发现的 Driver 侧问题：发系统通知偶发 `NOTIFICATION_ENQUEUE_FAILED`（探针会重试一次并如实写明）；跳到插件权限页后，右上角提示固定写成「已打开 Voice 权限」。
- 没有验证：较旧的 Driver、Windows、英文界面、没有登录时的结果。真实结果以安装后导出的报告为准。
