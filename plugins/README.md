# 官方插件

这里的插件由 ReAI 团队开发，但不属于 Driver 源码，也不会因为“官方”身份自动进入安装包或
获得特权能力。每个目录都拥有自己的依赖锁、测试、构建和打包入口；产出的 `.reaiapp` 与第三方
插件走同一套申请、审核、摘要绑定和上架流程。

统一本地验收：

```bash
make plugin-official-verify
```

审核状态以 `../review/candidates/catalog.json`（Board 仓库内部材料，未公开） 为准。
`not_submitted` 的插件只能作为源码候选验证，不能进入 Driver 的 Builtin、Catalog 随包资源或
线上货架。`publisherId: reai` 只代表发布者身份，不代表已经获批。
