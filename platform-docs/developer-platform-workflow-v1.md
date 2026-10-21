# 开放平台工作流（Host API 1.21）

此接口仅供 `com.reai.developer-center` 系统插件使用。普通插件、伪造同名本地包、关闭开发者模式的会话不得调用。候选源码与生产批准插件包是不同交付物；源码通过测试不代表线上联调完成。

## 调用边界

`ctx.developerPlatform.workflow.request(action, input)` 统一编码到固定 Bridge 方法 `developer.platform.workflow`。每个 action 有独立请求/响应类型；不接受 URL、HTTP 方法、Authorization、本地路径或任意文件内容。

| 动作 | OAuth scope |
| --- | --- |
| capabilities、legacyProducts、本机表单 | developer:platform |
| draftGet / draftUpdate、材料上传/读取/图片 | developer:draft |
| 审核预检/提交/撤回/记录/冻结图片、费用历史 | developer:review |
| 发布列表/预检/发布/下架 | developer:release |
| 测试人员读写 | developer:manage |

Host 读取实际 token 的 scope；编译配置含新 scope 不代表旧 token 已获授权。权限不足由 capabilities 显示 missingScopes，必须重新 consent。

冻结后端 DTO 和 fixture 位于 `platform/sdk/src/v1/developer-platform-contract/` 与 `platform/sdk/tests/fixtures/developer-platform-v1.json`。`workflow-schema.json` 从 SDK 请求/响应类型生成，Rust 与 Mock Host 共用该结构：

```sh
bun platform/sdk/scripts/generate-developer-workflow-schema.ts
```

Host 拒绝未知请求字段；响应只投影合同字段。未知服务端状态保留为字符串，页面只读展示，不默认变成成功状态。

## 上传与审核

`materialUpload` 由 Host 原生文件选择器选择文件，流式 multipart 上传。包硬上限 64 MiB，图片 10 MiB，后端团队套餐可能有更低的限额。PNG/JPEG/WebP 图片通过固定资源路径读取，插件不持有云端 token。材料必须属于选定 Client 和版本，包身份由后端校验。

审核表单由 `localSave/localGet` 保存在本机，按 issuer、subject、Team、Product、Client 隔离；不提供跨设备同步。OAuth 配置草稿仍以服务端为准，更新带 expectedUpdatedAt。

reviewPrecheck 仅检查额度/费用，不表示插件包通过审核。收费提交必须由用户确认，并携带该报价的金额及 fingerprint。每次操作先保存原请求及幂等 key；网络失败、重启后先查询原请求。not_found 不证明失败；重试使用相同 key 和原 payload，不能以修改表单后的内容替换原请求。

## 发布恢复

发布/下架的 operationId 仅用于本机日志，不传给后端；服务端使用 expectedCurrentPublicRevisionId 作 CAS 校验。发生结果不确定时，使用带 releaseId 的 releasesList 查询该目标及 Client 当前指针。确认发布成功必须同时满足目标状态 published 且当前指针等于目标 revision。

下架保留 public revision 指针，目标状态 delisted 才能证明该目标下架；不能据此断言其他版本也已下架。被新版本替代的目标按 superseded 展示，不自动重放旧发布或下架请求。
