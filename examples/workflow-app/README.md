# 公开工作流示例（SDK 1.24）

此最小插件用 `ctx.http.fetch` 和自己的 `oauth_app` endpoint 创建、读取、回答继续、取消工作流草稿 run。新增工作流只换文档和输入，不改 Host、后台或 SDK。默认占位 Client ID，所有云操作关闭；挂载、语言切换与卸载均不发云请求。

## 配置与身份

1. 为你的插件使用自己的已注册 OAuth Client ID，替换 `app.manifest.json` 的 `WORKFLOW_EXAMPLE_CLIENT_ID`。不要复用 Driver、Voice 或其他插件的 client/grant。此任务没有注册、签发或新增真实 grant。
2. 通过正常平台准入、签名安装与用户同意流程取得此插件所需授权：创建草稿要求 `flows:execute` 和当前用户 Project execute；轻量结果要求 `runs:read`；继续/取消使用 `release:invoke`。实际允许路由取服务端定义，不能在插件内自授 scope。重新检查网络留存、平台目标和安装摘要；Manifest 的留存采用现有 feedback-board 示例基线（3650 天 / 文档链接），没有验证为实际服务保证，上架前必须按真实政策替换。
3. 输入你有权执行的文档 ID 和 JSON 对象，然后明确点击创建。创建和继续可能产生费用。本插件没有自行计价或扣费 UI（`billing:none`）；这不代表上游执行免费。

下表列出本示例使用的公开接口合同。它描述接口约定，不代表部署、安装或真实 OAuth 联调通过。

| 操作 | 请求 | 关键边界 |
|---|---|---|
| 创建 | POST `/runs`；`documentId,inputs,requestId`；同值 `Idempotency-Key` | Host 注入此插件的 OAuth；后台派生 user/App、计费来源 |
| 读取 | GET `/runs/:runId?trace=skip` | 只读本 user/App 的轻量状态与 `data.output`；不取得完整 trace |
| 回答继续 | POST `/runs/:runId/resume`；`mode:answer,askEventKey,answer` | 原 run 身份；40 位 hex key；仅自由文本，服务端检查 ask 与 CAS |
| 取消 | POST `/runs/:runId/cancel` | `cancelling` 仅表示受理；读取 `cancelled` 确认终态，已终止 run 不变 |

同用户不同 App、不同用户和历史 `oauth_app_id=NULL` run 均无法互读/继续/取消。不能通过 body 传 `appId/userId/token/payerTeamId` 切换 principal。不要把输出中的字段作为授权证明；权限由后台判断。

事件 SSE 还要求 Project read trace gate。SDK 1.24 的 HTTP Response 缓冲完整 body，不能据此实现增量 SSE；示例使用有限 JSON 手动读取。Ask Key 来自另一个已授权查看此 run 的界面，本示例不发现 ask，不支持结构化 AskUserQuestion 或 retry 模式。工作流内获授权云 Agent 的执行归该 run，本示例不新增独立云 Agent API。

## 失败、重试与生命周期

网络错误、5xx 或畸形 mutation 回执标为结果未知；创建只允许显式重试原快照和原请求 ID，不自动重试。409、401/403、余额错误保留状态与安全错误码，原始错误体不显示。取消受理、HTTP AbortSignal 和云运行终止分别处理。继续/取消结果未知时先读取确认，不能据 HTTP 超时推断未计费或自动退款。

每次 Surface 挂载持有自己的内存状态。卸载中止在途 HTTP、解除 DOM/语言监听并忽略迟到响应，不自动取消云端 run。不持久化凭据或业务输入；关闭后内存 request/run ID 会丢失，关闭前记录它们。未知创建时先在外脑已授权界面核实原请求，避免重新打开后创建重复收费 run。

借用 Voice 语音服务的请求归 Voice；消费插件 A 用返回文本发起自己的云请求归 A。无需跨插件链路归因图。

## 本地验证

```sh
bun install --frozen-lockfile
bun test tests
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
bun run preview
```

`preview` 只绑定 loopback 动态端口，使用合成 fixture；不调用声明的云 origin。工具栏可切换 Host 明暗 Token、语言、成功/取消/失败/scope 拒绝状态。fixture 测试通过 MockHost/brokerFetch 检查 endpoint、请求身份边界和错误；MockHost 不铸造令牌或证明真实 Host 注入。测试假 principal 是闭包注入，绝非运行时客户端参数。

本地命令只覆盖合成 fixture、MockHost 与打包检查。真实 OAuth 安装、scope 发布、收费账证、部署版本和签名 App 真机验收不在本示例的本地验证范围内，需要在真实 Host 和已登记的 OAuth Client 上单独验收。
