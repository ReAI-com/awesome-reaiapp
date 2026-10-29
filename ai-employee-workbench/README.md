# 铆钉 · AI 员工工作台 3.0

铆钉（Maoding）是独立运行的 AI 员工 Web 工作台。Node 后端、SQLite、React 页面与 Pi harness 全部位于本目录，不依赖本仓库其他插件或任何已有业务系统。

## 启动

需要 Node.js **22.19 或更高版本**（使用内置 `node:sqlite`；Node 22 可能显示实验性 API 提示）。在本目录运行：

```sh
npm ci
npm run dev
```

打开 <http://127.0.0.1:4317>。生产模式的本地运行方式：

```sh
npm run build
npm start
```

`PORT` 可修改端口，`EMPLOYEE_DATA_DIR` 可指定应用数据目录。默认数据目录为项目下的 `.data/`；必须使用可写的本机文件系统。本地模式默认仅监听 `127.0.0.1`。

HTTPS 部署使用外脑 OAuth 登录，并按已验证身份识别管理员。管理员可直接连接外脑模型目录，无需填入 API Key；开发授权和正式发布是不同阶段。配置与实际验证边界见 [登录与 HTTPS](docs/AUTH-AND-HTTPS.md) 和 [部署说明](deploy/README.md)。

## 开始使用

1. 创建岗位工作区，填写名称、职责与工作目录。目录留空时自动创建；同一目录及其子目录不能同时归属不同岗位。
2. 打开「管理员模式 → Agent 配置」，分别配置清洗、生成看板与岗位专家三个 Agent 的模型与连接信息。API Key 留空保存代表保留已有值；密钥不会返回页面状态，且不会读取其他项目或用户全局凭据。
3. 上传文件或扫描目录。目录每 15 秒检查变化；上传保存于工作目录的 `uploads/`，不可变原件快照位于 `.ai-employee/originals/`。外部源文件不会被修改。
4. 在「清洗规范」编辑路由描述和提示词。Schema 留空时由 Agent 自动定义；需要固定字段时填写 JSON Schema。
5. 在资料行点击清洗，查看实际运行记录。结果校验并事务入库后才显示完成；有问题或已有人工修订时，进入复核，编辑结果并确认后再发布。
6. 在结构化数据库查看表格与 Schema，按版本修订记录。通过自然语言生成看板，预览并确认添加；右侧岗位专家查询当前岗位的已发布数据。
7. 交付台生成候选、选定和签字，可回流为新原件继续清洗。规则检查冻结输入，保留规则版本、证据与结果；输入更新后界面提示过时。

## Agent 配置

首版使用真实 **Pi 1.4.0 SDK**。三个 Agent 分别配置模型、协议、参数、系统提示词、tools、MCP、skills；配置只影响新任务，运行保存配置及规范快照。

| 协议 | 配置值 | 地址说明 |
| --- | --- | --- |
| Chat Completions 兼容接口 | `openai-completions` | 通常使用服务的 `/v1` 地址 |
| Responses 接口 | `openai-responses` | 通常使用服务的 `/v1` 地址 |
| Anthropic Messages | `anthropic-messages` | 使用服务根地址，SDK 添加 `/v1/messages` |
| Google Gemini | `google-generative-ai` | 使用该服务的生成接口基础地址 |

具体参数支持取决于模型与协议。不支持的 `temperature`、`maxTokens`、`thinkingLevel` 会明确报错，不假装已生效。未知自定义模型的 thinkingLevel 当前只支持 `off`。API Key 保存在本机 SQLite 文件中，依靠私有目录与文件权限保护，未使用系统钥匙串或数据库加密。

内置业务工具：`read_schema`、`query_records`，清洗任务另有 `inspect_source`。工具白名单不开放任意 shell 和通用文件读写。Skill 可填写 Markdown 文件或包含 `SKILL.md` 的目录；相对路径基于岗位工作目录，内容按显式配置加载，不自动发现全局 Skill。

MCP 示例：

```json
{
  "mcpServers": {
    "facts": {
      "url": "http://127.0.0.1:9100/mcp",
      "headers": {},
      "timeout": 30
    },
    "local_tools": {
      "command": "/absolute/path/to/mcp-server",
      "args": [],
      "env": {},
      "enabled": false
    }
  }
}
```

同时在 tools 加入 `mcp__facts__*` 或某个明确的工具名。服务名中的 `-` 规范化为 `_`。支持 stdio 与 Streamable HTTP、`direct`/`hidden` 工具暴露，不支持旧 SSE、OAuth 自动登录和环境变量/命令形式的凭据展开。stdio 只接收显式配置的环境；MCP 服务器的 command 是用户自行配置的本地程序，不是 OS 沙箱。

## 数据与工作流

- A 原件只增不改，SHA-256 校验；同一个文件更新产生新版本。
- 文件保留九个业务标签，另记录任务的排队、运行、待复核、成功、失败、取消、过期和中断状态。
- B 的 JSON Schema 会落成真实 SQLite 类型化表，同时保留来源和修订历史。无效记录导致整批不发布；Schema 更新保留旧表与历史。
- 更新期间读取上一版已发布 B。原件、规范或记录版本变化后，旧任务不能覆盖新数据。
- 人工修订后再次清洗需要复核并明确确认更新，旧修订保留。待复核提案在重启后仍可处理；意外中断的执行可重新发起。
- C 保存候选、输入版本、选定和签字回执；重复回流不会新增重复原件。
- D 分离规则定义与运行结果，区分业务不通过、证据不足和执行失败。
- 数据库位于 `.data/workbench.sqlite`，原件位于各岗位目录；备份时需一起保存应用数据目录及岗位工作目录。请先停止服务再复制 SQLite 数据库文件。

## 动态 WebApp 与 REST

每个看板有独立的 `index.html`，保存在应用数据目录的 `boards/<workspaceId>/<boardId>/`，可通过其预览 URL 独立打开。运行时注入 `window.employee`，通过 REST 读取绑定表的 Schema、分页记录、新增和版本修订。详情见 [API 文档](docs/API.md)。

看板在 sandbox iframe 中运行，不能访问工作台父窗口；CSP 限制其网络和嵌入能力。每个看板使用仅限绑定数据表的 capability token；草稿只能读数据，确认添加后才能写入。没有任意 SQL、跨岗位操作或硬删除接口。单独复制原始 HTML 时，需要自行提供相同的 REST 适配器；它不包含凭据或内嵌数据副本。

## 当前边界与验证

- 任意文件可保存原件；自动文本提取支持 CSV/TSV、JSON/JSONL、TXT/Markdown/HTML/XML/YAML、XLSX、DOCX 和有文本的 PDF。图片、扫描 PDF、旧版 `.xls/.doc` 尚无 OCR/转换链路，明确报告不支持。
- 单文件最多 30 MB，每次上传最多 20 个文件；单次扫描最多 4,000 个目录项、深度 12，不跟随符号链接；隐藏文件与应用内部目录不导入。
- 单个清洗原件最多 160,000 字符，单批最多 1,000 条记录。超限明确失败，不静默截断或发布部分数据。C/D 单次输入快照同样限制为 160,000 字符。
- 本机单用户，不含多人登录、远程部署或多租户权限。管理员切换只是界面入口。
- 本地业务与集成测试使用真实 Pi SDK 对接 loopback 模型测试服务，覆盖协议、参数、MCP、业务工具、A→B、更新冲突、看板 REST、C/D。测试服务返回固定响应，不证明真实模型的提取准确性或生成质量。
- 已使用用户本次提供的临时测试凭据完成 GLM 真实模型财务演示；过程、人工修正及未验证范围见 [真实模型验收记录](docs/FINANCE-DEMO-VALIDATION.md)。用户盲盒文件验收仍待进行。

```sh
npm test
npm run check
npm run build
```

设计决策与用户确认范围见 [SPEC.md](SPEC.md)。

## 财务账套与持续修改

「财务账套」可启用 14 类标准资料库；「原始资料」的自动清洗开关使上传和目录更新进入串行清洗队列。数据不确定时进入复核，确认入账绑定具体记录版本。账簿和报表的前提及导入样例见 [标准财务库](examples/finance/standard/README.md)。

岗位专家从侧栏打开，支持 Markdown 表格、列表、代码块和记录版本引用。看板支持让 Agent 继续修改、编辑完整页面源码、查看版本历史与恢复；保存新版本后内嵌及独立预览自动更新。详见 [看板更新接口](docs/BOARD-UPDATES.md)。
