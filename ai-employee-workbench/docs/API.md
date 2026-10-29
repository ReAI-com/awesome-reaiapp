# 本地 REST API

服务仅监听本机回环地址。工作台管理接口拒绝跨来源请求；所有写请求带 `X-Workbench-Request: 1`。这是本地单用户应用，不是远程账号鉴权系统。失败返回 `{ "error": "具体原因" }`，版本冲突为 HTTP 409。

## 工作台接口

除创建工作区外，下列业务路径以 `/api/workspaces/:wid` 为前缀。

| 方法与路径 | 请求 / 结果 |
| --- | --- |
| GET `/api/bootstrap` | 工作区列表与运行时版本 |
| POST `/api/workspaces` | `{name, role, directory?}` → `{workspace}` |
| GET `/state` | 当前岗位全量状态；主模型 API Key 不返回 |
| POST `/scan` | 扫描目录 → `{imported, skipped}` |
| POST `/uploads` | multipart 字段 `files` → `{files}` |
| GET `/files/:fid/history` | 原件版本摘要与状态历史，不返回快照文件路径 |
| POST `/files/:fid/clean` | 排队清洗 → `{run}`；同一输入的在途任务复用 |
| POST `/runs/:rid/cancel` | 取消在途或待复核任务 |
| POST `/runs/:rid/review` | `{records, replaceManual}` → 事务发布回执；保留人工修订历史 |
| POST `/specs` | `{name, description, match, prompt, schema?}` |
| PUT `/specs/:sid` | 同上，附当前 `version`；生成新规范版本 |
| PUT `/agents/:aid` | 完整 AgentConfig；`aid` 为 agent-001/002/003，保存校验配置版本 |
| GET `/datasets/:did/schema` | JSON Schema 与真实 SQLite 表/列结构 |
| POST `/records` | `{datasetId, data}` → 人工新增记录 |
| POST `/records/:rid` | `{version, data}` → 新记录版本 |
| GET `/records/:rid/history` | 记录的当前及历史版本 |
| POST `/chat` | `{message}` → 专家任务 `{run}` |
| POST `/boards/generate` | `{prompt}` → 生成看板任务 |
| POST `/boards/:bid/publish` | 确认添加看板，幂等 |
| GET `/boards/:bid/preview` | 可独立打开的 HTML WebApp |
| POST `/deliverables` | `{prompt, title?}` → 交付候选生成任务 |
| POST `/deliverables/:did/select` | 选定候选 |
| POST `/deliverables/:did/sign` | `{signature}` → 签字回执，同签字信息重复提交幂等 |
| POST `/deliverables/:did/reflow` | 签字候选 → 新 A 与清洗任务；按候选幂等 |
| POST `/checks` | `{name, rule}` → 按规则版本运行检查 |

Agent 任务返回 HTTP 202 后，可轮询 `/state` 的 `runs`。`queued/running/waiting_review` 为未结束状态；只有 `succeeded` 表示完成。清洗复核的候选记录位于 `run.result.proposal.records`；错误或取消不代表已发布 B。

## Agent 业务工具

工具通过 AgentConfig 的 `tools` 白名单提供给模型，不是独立 HTTP 接口。默认开放 `read_schema`、`query_records`，清洗任务另有 `inspect_source`；`calculate` 需要显式加入白名单，不会自动启用。

| 工具 | 参数与行为 |
| --- | --- |
| `read_schema` | `{}` → 当前岗位已发布的 Dataset 数组和 JSON Schema |
| `query_records` | `{datasetId?, offset?, limit?}` → `{total, offset, records}`，每次最多 200 条；业务字段位于 `record.data` |
| `inspect_source` | `{offset?, limit?}` → 当前清洗原件片段，每次最多 30,000 字符；仅清洗任务可用 |
| `calculate` | `{operation: "sum" \| "subtract", operands: number[]}` → `{operation, operands, result}`；只支持安全整数加减 |

`calculate` 接受 1–200 个安全整数，`subtract` 至少需要 2 个，并从第一个数依次减去后续数。每一步中间结果及最终结果均须为安全整数，超范围或参数无效时返回工具错误，不执行表达式、脚本或 shell。财务金额以整数分传入，例如 `{"operation":"subtract","operands":[4800000,3628000]}` 返回 `result: 1172000`，展示时换算为 11,720.00 元。

## 看板专用接口

路径前缀 `/board-api/:boardId`。请求须带 `Authorization: Bearer <该看板的token>`；令牌只授权该看板已绑定的 datasetIds。浏览器跨来源请求允许此受限接口，不允许工作区管理接口。草稿写操作返回 403。

| 方法与路径 | 含义 |
| --- | --- |
| GET `/schema` | 当前看板绑定的 Dataset 数组，包含各自 JSON Schema |
| GET `/records?datasetId=…&offset=0&limit=100` | `{records,total,offset,limit}`；每页最大 500 条 |
| POST `/records` | `{datasetId,data}` 新增人工记录 |
| POST `/records/:recordId` | `{version,data}` 校验并修订，冲突返回409 |

看板 HTML 运行时在脚本前注入以下适配器，所有读写均发送上述真实 REST 请求：

```js
const tables = await employee.schema();
const page = await employee.records(tables[0].id, 0, 100);
const record = page.records[0];
await employee.revise(record.id, record.version, {
  ...record.data,
  status: '已核对'
});
```

数据字段必须符合实际 Schema。新增/修改会保留版本和来源，不直接改原件。渲染资料值时使用 `textContent`，不要把原件或数据库字段拼成可执行 HTML。统计全表须按 `total` 分页读取，不能把第一页当作全量数据。
