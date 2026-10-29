# 标准财务账套：本地集成与合成验证

一个工作区对应一个客户账套。A 保留原件，B 保存有原始行引用的结构化事实；C 通过 REST 读取本账套数据生成独立看板，D 核对依据、口径与结果。岗位专家在侧边栏查询当前 B，并明确区分已归集、待复核和已人工确认的账务。上传或清洗完成本身不会确认过账。

本目录是合成开发用例，**不是用户真实盲盒测试的验收证据**。金额、企业与人员标识均为虚构。不要把本目录的人工确认引用导入真实客户账套。

## 标准表与范围

`server/finance.ts` 提供 14 份中文字段 Schema。规范 ID 为 `${workspaceId}:finance:v1:${key}`，数据集应使用同样的工作区与规范稳定关联，不能按上传文件名另建同义表。原件仍按文件分别留痕；查询或更新必须限定工作区。

| key | 内容 | 确认边界 |
| --- | --- | --- |
| company_profile | 客户名称、纳税人标识、币种、会计制度 | 制度不明时为 unselected |
| chart_of_accounts | 科目编码、名称、层级、类别、余额方向 | 使用客户实际科目表；账簿使用的科目版本须人工确认 |
| journal_entries | 凭证号、行号、日期、科目、借贷整数分、币种 | 导入状态始终 unconfirmed |
| bank_transactions | 银行/现金收支、账户、往来对象、明确关联单据 | 交易事实不直接推导科目 |
| sales_invoices | 销项发票、购方、价税与到期日 | 发票金额不直接等于收入 |
| purchase_invoices | 进项发票、供应商、价税、原件抵扣状态 | 不推断抵扣资格 |
| receivables | 应收单据、客户、原始/已收/未收金额 | 保留与发票关联，避免重复汇总 |
| payables | 应付单据、供应商、原始/已付/未付金额 | 保留与发票和付款关联 |
| expense_claims | 费用、报销、原件审批状态、关联发票和付款 | 审批不等于本系统过账 |
| payroll | 工资期间、人员标识、应发实发、社保公积金与扣税 | 不计算未知税率或比例 |
| fixed_assets | 资产原值、购置启用、累计折旧及原件政策 | 不猜年限、残值和折旧 |
| tax_records | 税种、所属期、原件申报与缴纳金额 | 不自动申报或计算税额 |
| opening_balances | 本期期初日期、科目、借贷余额、币种 | 逐条确认并确认完整性 |
| inventory_movements | 出入库、商品、数量、原件成本 | 不猜成本计价或减值 |

关键字段必须有依据。可选字段未知时省略；允许 `unknown` 的枚举用于明确表示未确认。币种不能默认混用，金额按原件单位精确转换成整数分，不能把未知金额填 0。日期歧义、未知字段语义、多个客户或多类业务混在一个文件、无法完整表达的工作表都需要复核，不能丢弃部分记录后宣布成功。

首版金额字段接收非负安全整数分，收付款用方向字段表达。红字、负数冲销和不明确的更正表达进入复核；当前未实现所有红字凭证和负余额场景的自动入账。这是明确的处理边界，原件不能被删除或标记为已完成会计处理。

## 集成接口

从 `server/finance.ts` 导入：

- `getFinanceStandardSpecs()`：取得独立副本，按 `financeSpecId(workspaceId, key)` 创建/查找规范。不要让模型重命名固定 key 或任意修改标准字段。
- `financeKindFromSpecId(id)`：识别标准规范类别；工作区授权仍由调用方验证，不能只凭此函数授权。
- `validateFinanceRows(kind, rows)`：Schema 之后的语义复核，包括安全整数分、日期、来源行号、双边分录、重复业务编号、价税勾稽等。应收/应付按单据号、往来对象与币种联合去重，同一单据余额不同也需复核。函数检测传入行之间的重复；调用方需把同工作区、同标准表的已有当前记录与新记录一起核对，才能阻断跨文件重复发布。返回问题必须进入复核，不能静默过滤异常行。
- `buildFinanceLedger(input)`：只读确定性计算科目余额/总账、逐行明细账、试算平衡和有依据的管理报表草稿。不会修改 B 或提交会计过账。

`FinanceLedgerInput` 需要：`workspaceId`、`from`、`to`、`currency`、`accountingBasis`、`records`、`confirmedRecordVersions` 和 `openingBalancesComplete`。`records` 项为 `{ id, workspaceId, version, kind, data }`。科目表应保留原件类别；凭证和期初的 `data.posting_status` 一律为 `unconfirmed`。本期使用的科目表记录、凭证与期初均须独立人工确认，调用方以 `{id,version}` 保存确认记录；修改任一记录（包括科目名称、类别或方向）后版本变化使旧确认失效。响应 `evidence` 包含实际使用的科目版本以及凭证和期初版本；没有本期期初或发生额、未被账簿使用的科目不要求确认。模型不能设置这些确认或完整性开关。

会计制度支持 `small_enterprise`（小企业会计准则）、`enterprise`（企业会计准则）与 `unselected`。这些选择用于明确管理报表口径，当前不是完整法定报表模板引擎；没有覆盖其他制度的自动转换。不得把企业会计制度与企业会计准则混称为同一选项。

输入中混入其他工作区直接拒绝；账期、币种、科目、确认版本、期初、凭证日期/完整分录及借贷均有验证。缺资料返回 `insufficient_evidence`，矛盾或异常返回 `needs_review`；只有通过的账簿为 `ready`。`ready` 不代表三个报表都通过，应逐项读取 `financialStatements` 的状态。响应保留记录 ID 与版本作为证据。

### 人工报表配置

`FinanceReportingConfig` 通过 `input.reporting` 传入，必须由用户明确编辑并确认，不由 Agent 自动宣称完成。下面只用于合成例子的管理口径：

```json
{
  "periodAdjustmentsConfirmed": true,
  "balanceSheetLines": [
    {"code":"cash","label":"货币资金","section":"assets","accountCodes":["1002"],"sign":1},
    {"code":"capital","label":"实收资本及未结转损益","section":"equity","accountCodes":["3001","5001","5602"],"sign":-1}
  ],
  "incomeStatementLines": [
    {"code":"revenue","label":"营业收入","section":"income","accountCodes":["5001"],"sign":-1},
    {"code":"expense","label":"期间费用","section":"expense","accountCodes":["5602"],"sign":1}
  ],
  "closingEntriesReviewed": true,
  "closingEntryRecordVersions": [],
  "cashAccountCodes": ["1002"],
  "cashFlowClassifications": [
    {"recordId":"sale-bank","version":1,"category":"operating"},
    {"recordId":"cost-bank","version":1,"category":"operating"}
  ]
}
```

资产负债项目依据期末借贷净额与人工 sign 汇总，必须覆盖全部非零余额科目、不能重复，并验证资产 = 负债 + 权益。利润项目依据本期借贷净发生额与 sign 汇总，需覆盖有发生额的收入/成本/费用科目，未知科目类别不猜测。已确认的损益结转凭证必须以完整凭证的全部记录 ID/版本列入 `closingEntryRecordVersions`，只在利润计算时排除；账簿保留全部结转分录。

现金流对每条现金分录按 `operating`、`investing`、`financing` 或 `internal_transfer` 明确分类。内部划转必须在同一凭证中配平；其他现金分录必须全部分类且版本有效。系统验证期初现金 + 净流量 = 期末现金。

有完整依据时各报表返回 `draft`、项目、总额和勾稽结果，展示名称为“管理报表草稿，法定申报未验收”。配置缺失返回对应报表 `insufficient_evidence`；配置冲突返回 `needs_review`。本模块没有税务申报、银行转账、法定签署或客户政策适用性的自动判断。

## 技能与合成用例

将 `skills/finance-intake/SKILL.md`、`skills/finance-bookkeeping/SKILL.md`、`skills/finance-dashboard/SKILL.md` 分别配置给清洗、岗位专家和看板 Agent。通过现有 pi harness 加载技能，名称和工具集合以实际注册结果为准；没有工具时技能要求说明缺失，不能虚构工具调用结果。

- `input/raw_batch_alpha.csv`：银行未知表头、千分位与中文日期。
- `input/document_beta.csv`：销项票据混合日期格式和付款到期日。
- `input/chart_of_accounts.csv`、`input/opening_balances.csv`、`input/journal_import.csv`：配套账簿来源；原件的“已审核”不能变成本系统确认。
- `input/needs-review-mixed.csv`：多客户、多业务、歧义日期、未知金额，应停止完整自动入库并保留复核依据。
- `expected.json`：路由与已知金额断言，允许保留更多有依据的可选字段，不允许遗漏业务行。
- `ledger-fixture.json`：不调用模型的完整账簿函数输入及预期结果，展示人工确认与报表映射格式。它包含明确标注的合成确认，不能冒充实际人工操作。

配套测试执行 `npx tsx --test tests/finance.test.ts`。目前验证标准字段、异常阻断、客户与币种边界、版本失效、凭证/期初平衡、整数溢出、三类有依据的报表草稿、映射与现金分类错误，以及损益结转处理。这些确定性测试不能证明任何真实模型的未知文件清洗质量。

### 只读验收已运行的合成工作区

在项目目录执行（先安装项目依赖，服务已运行于 `127.0.0.1:4317`）：

```sh
node examples/finance/standard/verify.mjs <workspaceId>
```

脚本只发 GET 请求，读取该工作区 state、finance、finance/reports 与六份原件的版本历史；不上传、不重试模型、不确认记账、不修改配置或重启服务。它核对本目录原件的 SHA-256/大小、不可变版本和清洗任务引用、14 类标准 Schema、银行 2 条、发票 2 条、凭证 4 条、科目 4 条与期初 4 条。`expected.json` 的必需值须精确一致，其他符合 Schema 的字段可以保留；“对应票据”编号可在 `invoice_id` 或 `document_ref` 中保留，不能据此强推票据类型。未知余额不能补 0。

原件的“已审核”不能替代当前记录版本的人工确认。账簿校验要求 12 条科目/期初/凭证确认及期初完整性确认，再检查银行期末余额 110000 分、试算发生额借贷各 14000 分和三份管理报表草稿。多客户混合异常文件必须拒绝路由或带问题等待复核，不得部分发布。报告列出人工复核后发布的文件数量与名称；这些文件不能描述为全自动清洗通过。

输出为 JSON：`passed` 退出码 0；限流、未上传、待处理、待人工复核或报表依据未齐为 `pending`，退出码 2；字段、金额、来源链或隔离断言错误为 `failed`，退出码 1。建议在任务稳定后运行，正在处理时可稍后重新执行；脚本不会自动轮询。它核验的是本合成工作区的当前发布结果，不能独立证明历史模型供应商，不能替代用户真实盲盒文件和真实问题验收。

## 参考与适用范围

字段归集与核验方法参考已安装的 `finance:reconciliation`、`finance:financial-statements` 技能（Anthropic knowledge-work-plugins）。本目录技能为独立编写的中国本地账套适配；原技能中的 GAAP/ASC/IAS 模板未作为中国会计政策或税务规则使用。

制度选项与适用边界依据财政部公开资料核对（2026-10-28）：[《小企业会计准则》通知与附件](https://kjs.mof.gov.cn/zhengcefabu/201111/t20111107_605525.htm)、[财政部关于不同会计制度及科目设置依据的答复](https://www.mof.gov.cn/bd/mhwzzxly/hjs/202301/t20230104_3861971.htm)。具体客户适用制度、最新税收政策、会计处理和法定报表仍需根据实际依据确认；本模块没有把征求意见稿当生效规范，也没有默认税率。
