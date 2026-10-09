# AI 员工界面演示

本地首页：`http://127.0.0.1:4188/showcase.html`。

```sh
bun run dev:showcase
```

17 位岗位员工覆盖 18 条需求，内置 83 个范式看板。组织发展的两条需求保留各自优先级和任务来源。CAD 与四个高层数字分身展示概念界面，其中未定义的职责、形象和行动权限保留待确认。

操作入口：

1. 首页按部门、优先级或任务关键词筛选，进入岗位。
2. 左侧切换专属看板，右侧 Agent 使用规则生成 mock 回复，引用在左侧打开。
3. 左侧「+」填写未发送的草稿。发送后先预览提案，确认才加入新看板。新增看板为独立记录快照。
4. 点击工作记录修订字段和原因；历史与只读初始资料保留。预算与库存的确定性派生字段自动重算，其余指标为初始演示快照。
5. 对话、草稿、修订、提案、报告和岗位设置保存在浏览器的独立演示存储中。文件选择只保存元信息，不保存或解析文件原件。

品牌与菜名语境参考[巴奴官网](https://www.banu.cn/zh-CN#eleproduct)，央厨背景参考[新华网](https://www.xinhuanet.com/finance/20250326/dde7f0fd054448a5a8468e611d7c7007/c.html)。人员、经营指标、库存、金额、合同、案件、路线与日期安排均为虚构样例。

演示入口 `showcase.html` / `src/showcase.ts`，岗位配置在 `src/showcase/roles-*.ts`。原 `preview.html`、Host 应用入口、模型与语音流程均独立。本演示没有正式审批、系统同步、消息发送、下单、模型调用、视频识别或 CAD 制图能力。

验证：`bun test`、`bun run typecheck`、`bun run build`、`bun run test:contract`、`bun run build:showcase`。合同检查需要先构建原插件。
