# 财务演示技能的来源与范围

本目录的三份中文 `SKILL.md` 是为本项目 A-B-C/D 工作流原创编写的适配文本。仅参考以下公开技能的业务方法，没有逐段复制原文，也不依赖本机插件安装目录、插件命令、外部账务系统或连接器。

## 官方参考

检索与核验日期：2026-10-28。

- Anthropic [Reconciliation](https://github.com/anthropics/knowledge-work-plugins/blob/main/finance/skills/reconciliation/SKILL.md)：借鉴同一截止日核对、区分时间差与待调整事项、保留来源证据、不得用无依据调整凑平差额的原则。
- Anthropic [Variance Analysis](https://github.com/anthropics/knowledge-work-plugins/blob/main/finance/skills/variance-analysis/SKILL.md)：借鉴明确比较基准、量化差异、区分证据与因果推测的原则。本演示未提供预算或比较期间，不生成相应差异指标。
- Anthropic [Financial Statements](https://github.com/anthropics/knowledge-work-plugins/blob/main/finance/skills/financial-statements/SKILL.md)：作为完整财务报表的数据要求与范围参考。本演示仅有银行流水和发票，不据此生成利润表或推断净利润。
- 官方[项目说明](https://github.com/anthropics/knowledge-work-plugins/blob/main/README.md)：原始插件是可按业务、工具与组织情况定制的起点；本地适配不采用其外部工具连接流程。

核验了上述官方仓库的 [LICENSE](https://github.com/anthropics/knowledge-work-plugins/blob/main/LICENSE)，内容为 **Apache License, Version 2.0**。这描述的是参考仓库的许可证，不代表本项目整体采用该许可证。若后续直接分发原始技能文件，应另行保留原许可证、适用署名及修改说明。本目录没有捆绑原始技能文件；无 Anthropic 官方认证或背书含义。

## 合成资料与验收口径

`input/` 下两份 CSV 均为本项目自行构造的虚拟财务资料，无真实客户、银行账户或个人信息。原始金额单位为元，特意包含千分位及不同中文日期格式；清洗后的 B 金额统一为整数分。通过 `INV-A`、`INV-B`、`INV-C` 等原始单据编号关联，不能仅凭客户名称匹配。

`expected.json` 只用于验收真实模型运行结果，不应作为 Agent 的原始资料或注入看板数据。截止日固定为 `2026-10-28`；结果包括 8 笔流水、3 张发票。现金图表期间为 `2026-10-01` 至 `2026-10-28`；应收快照须包含截止日前全部发票，包括九月开票。

本次未提供期初余额、完整总账、成本费用归集、预算或收入确认依据，因此不验收银行余额、净利润、税额、预算差异或完整财务报表。真实模型调用、结构化结果发布、看板 REST 取数和带记录引用的岗位问答需分别验证。
