# 财务岗位 Demo

本示例用于验证本地 AI 员工工作台的完整流程：上传 A 原件 → Agent-001 路由与清洗、自动生成 Schema → 发布 B 结构化数据 → Agent-002 生成通过 REST 读取 B 的独立看板 → Agent-003 基于 B 回答岗位问题。

资料均为合成数据，不包含真实客户、账户或个人信息。业务截止日固定为 **2026-10-28**。模型配置与官方文档核验日期同为 **2026-10-28**；套餐规则可能变化。技能来源、适配方式和业务边界见 [SOURCES.md](SOURCES.md)。

## 启动与岗位目录

按项目 [README](../../README.md) 启动工作台，在页面创建一个独立的财务岗位工作区，职责可填写：

> 整理银行流水与发票，核对客户回款和应收，解释现金收支及逾期风险。仅基于当前岗位已发布资料回答，不推断利润、税额或银行余额。

三个 Skill 需从本示例复制到该岗位工作目录的隐藏 `.skills/` 目录，再以岗位相对路径引用。示例命令从 `ai-employee-workbench/` 执行，将 `FINANCE_WORKSPACE` 的值替换为页面显示的岗位目录：

```sh
FINANCE_WORKSPACE='替换为岗位工作目录'
mkdir -p "$FINANCE_WORKSPACE/.skills"
cp -R examples/finance/skills/. "$FINANCE_WORKSPACE/.skills/"
```

隐藏目录不会被当作 A 原始资料扫描。不要将 Skill、[expected.json](expected.json) 或本文上传为业务原件；`expected.json` 只供验收比较，不提供给 Agent，也不能嵌入看板当作数据。

## 模型与 Agent 配置

三个 Agent 均使用以下配置。用户只需通过本地配置页补充自己的 API Key，不要将密钥写入本示例、提交记录或运行报告。

| 配置项 | 值 |
| --- | --- |
| harness | `pi` |
| provider | `zai-coding-cn` |
| model | `glm-5.3` |
| protocol | `openai-completions` |
| baseUrl | `https://open.bigmodel.cn/api/coding/paas/v4` |
| temperature | `1` |
| thinkingLevel | `low` |
| MCP | `{}`，本演示使用内置业务工具 |

| Agent | maxTokens | tools | skills（岗位相对路径） |
| --- | --- | --- | --- |
| `agent-001` 清洗 | `8192` | `read_schema`、`query_records`、`inspect_source` | `.skills/finance-cleaning/SKILL.md` |
| `agent-002` 看板 | `16384` | `read_schema`、`query_records` | `.skills/finance-dashboard/SKILL.md` |
| `agent-003` 专家 | `8192` | `read_schema`、`query_records`、`calculate` | `.skills/finance-expert/SKILL.md` |

系统提示词分别使用：

- **Agent-001：** 你是财务数据清洗员。根据实际文件内容选择银行流水或发票规范，提取全部事实，自动生成 JSON Schema，保留原始编号和来源行号（CSV表头第1行，第一条数据第2行）。遵循已加载的财务清洗 Skill，只返回任务要求的 JSON。
- **Agent-002：** 你是财务看板开发员。根据当前已发布 B 的真实 Schema 和记录生成独立中文 WebApp，通过注入的 REST 适配器分页读取全部数据。遵循财务看板 Skill，不硬编码业务数据，不使用外部依赖。
- **Agent-003：** 你是当前岗位的财务分析助理。先查询当前已发布 B，再回答现金收支、应收和逾期问题。遵循财务专家 Skill，引用真实记录 ID 与版本，说明数据缺失和结论边界。

Pi 1.4.0 内置 `zai-coding-cn` 适配会使用 `max_tokens`、GLM 思考参数和工具流式输出。GLM-5.3 始终启用思考，只支持 `low`、`high`、`max`，本示例使用 `low`；不要改成 `off`。上述 maxTokens 是每次模型响应的输出上限，不是整个工作流的总用量上限。官方依据：[Pi 接入](https://docs.bigmodel.cn/cn/coding-plan/tool/pi.md)、[模型切换](https://docs.bigmodel.cn/cn/coding-plan/latest-model)、[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[工具流式输出](https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool)。

## 两份清洗规范

在同一岗位新建以下两份规范，**两份 Schema 都留空**。先让真实模型依据原件推导 Schema，再检查发布后的结构；不要预先粘贴预期 Schema。

| 规范名称 | 路由描述 | 清洗提示词 |
| --- | --- | --- |
| 银行流水 | 适用于 `bank-transactions.csv` 或内容含流水编号、交易日期、收支方向、交易对象的银行流水；不用于发票清单。 | 完整提取银行流水。统一日期为 YYYY-MM-DD；收款/付款映射为 receipt/payment；金额由元转换为整数分 amount_fen，保留正值和币种。保留 transaction_id、明确的 invoice_id、分类、摘要、source_row；raw_text可选。无关联发票的付款合法，invoice_id 保留空字符串。按实际字段生成 Schema。 |
| 销售发票 | 适用于 `invoices.csv` 或内容含发票编号、客户、开票日期、到期日、发票金额的发票清单；不用于银行流水。 | 完整提取发票。统一日期为 YYYY-MM-DD，金额由元转换为整数分 amount_fen；保留 invoice_id、customer、invoice_date、due_date、currency、description、source_row；raw_text可选。不能将发票金额当作已收款，不推算税额。按实际字段生成 Schema。 |

CSV 的金额单位是人民币元，包含千分位和小数；B 的金额单位统一为整数分，例如 `24,000.00` 元应为 `2400000` 分。两类资料分别建表，通过原件明确的发票编号关联，不能按客户名称猜测核销。

## 跑通流程

1. 上传 [银行流水](input/bank-transactions.csv) 与 [销售发票](input/invoices.csv)，在文件列表分别发起清洗。保留两份规范，让 Agent 根据内容路由；观察上传、清洗及运行记录。
2. 在管理员模式检查两个数据集的 Schema、全部记录、原件版本和来源。银行流水应有 8 条、发票应有 3 条；金额字段为 integer，日期已统一，原始编号和行文本可追溯。如进入待复核，先检查具体问题再决定是否发布，不能把待复核当作清洗成功。
3. 两份 B 均已发布后，用下面的需求生成看板；检查预览，再按工作台流程确认添加。

> 生成截至 2026-10-28 的财务收支与应收看板。现金图表期间为 2026-10-01 至 2026-10-28；应收快照包含截止日前全部发票及关联回款，包括九月发票。展示现金收款、现金付款、净现金流、应收未收和逾期未收，提供分类图、流水明细和逐票核对表，以及日期筛选与刷新。金额以人民币元展示，通过当前 B 的 REST API 分页读取并计算，不嵌入示例数值。

4. 依次向岗位专家提问，核对工具调用和答案中的实际记录引用：

   - 截至 2026 年 10 月 28 日，现金收款、付款和净现金流各是多少？
   - 截至 2026 年 10 月 28 日，哪些客户还没付清，多少已经逾期？
   - 客户 A 的发票是否收齐？请列出依据。
   - 这家公司本月利润是多少？

## 验收口径与记录

逐行结果、指标、问答检查项见 [expected.json](expected.json)。本示例预期现金收款为 48,000.00 元、付款为 36,280.00 元、净现金流为 11,720.00 元；未收为 12,000.00 元，其中逾期为 2,000.00 元。它们是合成资料的预期结果，**不是已完成真实模型验收的声明**。

完整验收应分别记录：真实模型及运行 ID、实际路由、自动生成的 Schema、发布记录数量与金额、看板 REST 请求和刷新行为、问答工具调用及记录引用。模型成功返回不代表清洗准确；看板成功生成不代表其取数和计算正确。缺少完整账务依据时，专家应说明无法确定利润，不能把净现金流称为利润。

本文件提供可复现配置和验收标准；实际真模型运行结果由运行记录另行补充。

## Coding Plan 的适用范围

官方已将 Pi Coding Agent 列为支持工具，并提供终端接入说明；官方 FAQ 同时明确，自建应用、网站、机器人和 SaaS 通过 API 集成模型应使用标准 API。现有文档没有明确说明，将 Pi SDK 嵌入本工作台这样的自建 Web 应用是否属于套餐支持范围。因此，本配置不能视作该用途已获官方确认，单次请求成功也不能证明套餐适用范围。[支持工具与端点](https://docs.bigmodel.cn/cn/coding-plan/tool/others)、[套餐 FAQ](https://docs.bigmodel.cn/cn/coding-plan/faq)、[使用须知](https://docs.bigmodel.cn/cn/coding-plan/usage-notes)。

本示例固定使用上述 Coding 端点，**不自动回退标准付费 API**，不伪装客户端身份。遇到权限、套餐额度或用途限制时，应保留真实错误并停止该次运行；切换服务或标准 API 需另行明确配置和确认计费范围。

## 自动核验

清洗后可执行只读核验，不需要模型密钥：

```sh
node examples/finance/verify.mjs <岗位工作区ID>
```

该脚本比较两份自动Schema、全部11条记录的原件关联、来源行号、日期、整数分金额和六项财务指标。专家的金额加减通过显式启用的 `calculate` 工具完成；它只允许安全整数求和与减法，不开放任意代码执行。
