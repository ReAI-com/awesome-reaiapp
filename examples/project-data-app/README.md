# Project 业务数据示例

通过普通 SDK `ctx.http.fetch`、Host 托管的插件 OAuth 连接，手动读取用户选中的既有 Project / Collection 并新增、完整更新、软删除和恢复记录。插件不保存 token，不使用插件设置 KV 存业务记录，也不修改 Host、SDK、后端或 Catalog。

默认 `oauthAppId` 是 `PROJECT_DATA_EXAMPLE_CLIENT_ID`，实际插件界面禁用云操作；安装、挂载、语言切换及卸载不会发起 HTTP。这是开发示例包，尚未完成真实 OAuth 授权或上架身份核验。

## 隔离运行

在本示例目录执行：

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

预览仅监听 `127.0.0.1` 的随机端口。选 `project-a`、读取数据表、选择 `Fixture records`，然后输入 JSON 操作。所有业务请求都改送进程内合成 fixture；没有 OAuth token、数据库或云服务请求。预览入口不进入插件生产 bundle。关掉预览进程即丢弃全部合成记录。明暗主题使用随附的 Host 主题色快照（`tests/fixtures/theme-tokens.json`）；语言和拒绝/慢请求控件是预览工具。

独立消费者可将 `@reai/app-sdk`、`app-contract`、`app-test`、`app-cli`、`app-i18n-cli` 换为发行 tarball，再执行上述验证；`preview` 只依赖随附的主题色快照。仓内 `file:` 依赖只用于开发。

## 数据合同

下表列出本示例使用的公开接口合同。它描述接口约定，不证明当前线上部署。

| 操作 | OAuth 端口 | scope / 响应 |
| --- | --- | --- |
| 表树 | GET `/projects/:projectId/collections` | read；`{databaseFolder}` |
| 表 schema | GET `/projects/:projectId/collections/:collectionId/schema` | read；`{schema:{fields}}` |
| 分页查询 | GET `/projects/:projectId/data?collectionId=…&page=…&pageSize=…&sort=created_at&order=desc` | read；`{data,total,page,pageSize,totalPages}` |
| 读取单条 | GET `/projects/:projectId/data/:id` | read；原始记录 |
| 数量 | GET `/projects/:projectId/data/count?collectionId=…` | read；`{count}` |
| 回收站 | GET `/projects/:projectId/data/trash?collectionId=…` | read；`{data}`，没有分页 |
| 新增 | POST `/projects/:projectId/data` | write；`{collectionId,data}` → 201 原始记录 |
| 完整更新 | PATCH `/projects/:projectId/data/:id` | write；`{data}` → 原始记录 |
| 软删除 | DELETE `/projects/:projectId/data/:id` | write；`{success:true}` |
| 恢复 | POST `/projects/:projectId/data/:id/restore` | write；原始记录；父 Collection 消失时 410 `COLLECTION_DELETED` |

read / write 分别指 `project:data:read` / `project:data:write`；Project ACL 独立校验。记录按 Project ACL 共享，不承诺创建者或插件隔离。跨 Project 的记录 ID 不能绕过权限。未知 Collection 查询/回收站可能返回 200 空数组；schema、新增失败是 404。Collection 创建、改 schema、永久删除、导出等 JWT 接口不在示例范围内。

PATCH 替换整个 `data` 对象。编辑先重读完整记录，用户必须保留未修改字段；后端没有 CAS、幂等键或冲突合并，更晚写入会覆盖先前值。每次修改前重读 schema，拒绝带知识库标记的表；这不是原子锁，schema 并发变更仍需真实验收。恢复前查询回收站并核对所属 Collection；保留后端实际 410，不能从 schema 的 404 伪造恢复成功。

网络超时、5xx 或不可信写响应会将结果标为不确定并锁定写操作。用户需主动重读记录、回收站及其他分页，再明确确认；此确认不等于服务端幂等保证。成功写入后刷新失败会单独提示“写入成功”，避免误重复新增。示例不自动重试、不轮询业务接口、不记录原始响应/凭据。

输入 ID 限制为 1–128 位字母数字、`_`、`-`，排除保留路由字；JSON 对象限 64 KiB、深度 16，不接受非 JSON 对象。数据用 `textContent` 展示。卸载取消请求、移除 locale 订阅和计时器；迟到响应不触发后续网络。

## 验证边界

本地验证覆盖源码、MockHost / AppContext 与 DOM 测试。真实 OAuth Client 登记、scope 授权、HTTP Broker 的生产注入、多设备与真实 ACL、服务部署和上架不在本地验证范围内，需要在真实 Host 和已登记的 OAuth Client 上单独验收。
