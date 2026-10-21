# 文件插件 1.2.0 候选验证

验证记录随 PR 描述与审查评论交付（命令、结果、包摘要、界面截图），本文件只列验证入口，避免自引用提交 SHA：

- 插件：`bun run test`（控制器 + 界面 + 双语键一致）、`typecheck`、`lint`、`validate`、`build`、`test:contract`、两次 `pack` 摘要一致。
- 仓库：`bun scripts/verify-official-plugins.ts --plugin files`、`make repo-contracts`。
- 界面：`bun run preview` 合成预览在 Chrome 中核对明 / 暗、中 / 英、360px 窄窗、空 / 忙 / 失败 / 未授权 / 未开放 / 冲突 / 撤权草稿；云项目面板（列表 / 手动输入 / 未连接云账号）、云根浏览编辑、结果未知 + 刷新。
- 云项目：`tests/cloud.test.ts` 用 `src/fixtures.ts` 的合成 Host 替身（请求字段与错误文案对齐 driver-v2 `files/cloud_provider.rs`）；真实后台未部署、插件无 OAuth client，真实联调阻塞。
- 真机（plugin-dev 独立 profile）：原生选文件夹面板、真实磁盘读写、外部编辑器冲突、撤回权限——未在本 PR 内完成的项目在 PR 描述中列为待用户验收。
