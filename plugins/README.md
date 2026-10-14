# 官方插件

本目录包含 15 个官方插件的独立源码候选。每个目录拥有自己的依赖锁、测试、构建和打包入口；同处一个仓库不要求捆绑发布或重新打包 Host。稳定 appId 和插件版本沿用迁移快照。

另有 [AI 员工工作台](ai-employee/README.md) 开发 Demo：以原始事实、可编辑标准记录和岗位 Agent 为三阶段模板，包含财务、人事示例与新岗位插件生成器。它尚未审核、签名或上架，默认使用明确标识的本地规则分析。范式与扩展边界见 [最佳实践](../docs/ai-employee-pattern-v1.md)。

进入相应插件目录运行：

```bash
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

共享工具在 `../packages/`，开发规范见 [开发文档](../docs/README.md)。产出的 `.reaiapp` 仍走正式审核、摘要绑定、签名和安装流程。源码候选及本地测试通过不代表已批准公开分发或运行。Voice 当前缺少迁移输入对应的四项能力审核，校验与出包会保留拒绝，不得通过降低门禁绕过。
