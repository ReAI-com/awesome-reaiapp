# AI 代码编排

独立 ReAI 插件候选 `com.reai.code-worker` 0.2.1。沿用已验收的全局看板、子任务详情、协作角色、Agent 投影和使用 Skill 界面。业务源码在本目录，Host 只提供公开存储、Service 和本机网关。

## 上架提交身份

**当前上架表单的版本填写 `0.2.1`，与最终包完全一致，不要沿用 `1.0.0` 默认值。** 填表后运行 `bun run check:submission --form-version <表单实际版本>` 核对；需要同时验包时添加 `--package <最终包路径>`。表单版本校验通过不等于平台审核通过。

当前 Open Platform 产品为 **KanBan**。已按用户提供的信息绑定团队发布者和 OAuth Client，精确值保存在 `submission.identity.json`；Manifest 的 `publisherId` / `oauthAppId` 必须与其一致。Product ID 留在提交配置，不添加到 Manifest。新 PNG 图标随包交付，可编辑源文件在 `design/icon.svg`，平台 / 架构 targets 保持原合同。

在本仓库的插件目录执行 `bun run pack:submission`，会生成 `code-worker-0.2.1-submission.reaiapp` 和同名 `.submission.json`，执行身份检查、两次构建和最终包资源复验。只检查源用 `bun run check:submission`。普通 `pack` 保持独立 tarball 构建兼容；上架交付用 `pack:submission`。完整约定见 [插件上架打包与提交规范](../../platform-docs/plugin-submission-v1.md)。当前为同版本未审核候选的元数据修正，不表示已经上传、付费提交、审核通过或发布。

## 本地运行与验证

反馈看板 0.4.1-dev.1 把本机已计划需求提供给分配池。编排者连接领取并拆分；Worker/独立 Tester 使用各自连接执行和报告；`begin` 才占并发额度，终态自动归还。外部 Agent 使用自己已有的编码工具和仓库权限，Host 不自动启动模型或替它执行 Git。报告来源标记 `agent-report`。

需要本次 Host API 1.20 候选和新的反馈插件。启用 Developer Mode 后按正常本地安装/依赖授权流程安装两个 `.reaiapp`；本 PR 不更新 Catalog 或已批准的 builtin lock。正式发行和最终人工验收另行记录。

```sh
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run build
bun run validate
bun run test:contract
bun run pack
```

首次先在仓库 `platform/` 执行 `bun install --frozen-lockfile`。仓库外验证：`bun scripts/verify-official-plugins.ts --plugin code-worker`，使用公开平台 tarball 替换开发期的 file 依赖。

使用：角色池建立或重新连接编排者，选择并复制抽屉里的一行内容给同机 Agent。端口由 App 启动，无需设计稿的 Python 服务器；账号变化或 App 重启后重新获取连接，任务/锁保留。Skill 页可选择复制完整说明，ZIP 附 `scripts/client.py` 和 API/角色/恢复规范。没有伪报自动复制成功。

Skill 单一源在 `assets/skills/ai-code-orchestration/`；修改后运行仓库脚本 `python3 scripts/build-code-worker-skill.py`，`--check` 检查生成的 Markdown、ZIP 和内联文本。

`domain.ts` 是纯规则；`authority.ts` 严格验证持久数据与结构化报告、用 Host CAS 提交状态和有界回执；`app.ts` 从可信 caller 绑定身份。完成任务可导出完整 JSON，保存备份后清理本地执行详情；来源和备份摘要继续保留，活动任务不能清理。更多实现和验证边界见 [开发记录](DEVELOPMENT.md)。

`bun tests/serve-preview.ts` 是单独的浏览器布局测试入口，测试数据不进入安装包，也不代表真实模型执行。旧版本 A 基础报告仍保留于 测试记录（原 Board 仓库内 `docs/2026-09-13-code-worker-a-e2e.md`；未迁入），只适用于该报告标注的提交和包摘要。
