# 看板修改与版本

看板保持同一个 ID 和 REST 数据集授权。用户保存 HTML、让 Agent-002 修改，或恢复历史时，均追加一个新版本并立即生效；原有“待确认／已添加”状态不变。恢复不是覆写历史。

每次保存必须提交当前 `version`。保存前和事务提交时都会核验版本，冲突返回 HTTP 409。Agent 修改同样绑定开始时的版本；如果等待模型期间发生人工保存，模型结果标记为 `superseded`，不会覆盖用户新版。任务取消后也不会发布迟到结果。

HTML 按版本保存为独立只读产物，数据库事务切换当前指针并写入不可变版本记录。旧数据没有 `version` 时按 v1 处理；第一次修改会先快照原 HTML。版本历史不包含模型密钥、看板访问 token 或本机文件路径。

## 管理接口

以下路径前缀均为 `/api/workspaces/:wid/boards/:bid`，修改请求仍需要 `X-Workbench-Request: 1`。

| 请求 | 参数 | 返回 |
| --- | --- | --- |
| `GET /source` | 无 | `{html,name,description,datasetIds,version}` |
| `PUT /source` | `{version,html,name?,description?}` | `{board,version}`；board 不含 token 与路径 |
| `GET /versions` | 无 | `{versions:[{version,name,description,createdAt,source,runId?,restoredFrom?}]}`，最新在前 |
| `POST /restore` | `{version,targetVersion}` | `{board,version}`，追加恢复版本 |
| `POST /update` | `{version,prompt}` | HTTP 202 `{run}`；完成后 `run.result={boardId,boardVersion}` |

HTML 必须包含完整 `<html>…</html>`，不能超过 800 KB。接口不接受文件路径；手工保存不能修改绑定的数据表。Agent 只能绑定当前岗位实际存在的 B 数据表。生成看板的既有接口仍然可用，新看板从 v1 开始。

## 刷新与热更新

`GET /board-api/:bid/version` 使用现有看板 Bearer 凭据，返回 `{version,updatedAt}`。它不能读取其他看板或任何管理数据。

独立看板的服务端引导脚本每 3 秒查询一次版本；发现更高版本时刷新当前页面。请求失败时保留现有页面并继续下次检查，不因失败反复重载。页面内的筛选、滚动等未保存状态可能因版本更新而重置。手工浏览器刷新也直接读取当前版本，响应禁用缓存。工作台 iframe 可用版本作为 React key，同样在保存后更新。

沙箱、CSP、跨来源管理接口保护与数据读写权限保持原规则。热更新只替换看板界面，不代替 B 数据的清洗、校验与发布。

## 验证

`npx tsx --test tests/boards.test.ts` 覆盖旧看板首次快照、保存／历史／恢复、并发和过期版本、跨岗位拒绝、受限版本接口与热更新脚本，以及真实 Pi SDK 对接本地测试服务的过期 Agent 结果拒绝和正常更新。这些测试不代表外部模型生成质量或浏览器渲染已验收。
