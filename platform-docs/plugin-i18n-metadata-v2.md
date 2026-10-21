# Host 可见插件元数据：v2 补充

本补充只定义本地插件包的展示投影。基础资源规则仍见 `plugin-i18n-v1.md`：同一套 `assets/locales/zh.json` / `en.json`，键与插值一致，严格 `reai-app-i18n validate/build/pack` 检查实际包字节。原始执行 Manifest、命令 ID、权限声明及审批摘要不随语言变化。

## 能力与兼容

普通 App 显式要求 `metadata.i18n@2` 才启用扩展目标；可替代 `metadata.i18n@1`，也可同时声明。只声明 v1 的包仍只要求原来的 11 类目标，不因新版 Host 新增能力而缺项。旧无 i18n 包继续显示原始字段。Skin 本轮仍采用 v1 的现有约束，不增加 runtime capability。

仓库 Host 支持矩阵在 API 1.19.0 声明 v2 支持；示例的版本下界为 `>=1.19.0 <2.0.0`。实际兼容还取决于 `metadata.i18n@2` 能力：之前没有此能力的 Host 必须拒绝此候选，不能仅凭数字版本宣称可安装。源码支持、候选包、批准产物及线上 Catalog 发布是不同证据。**当前线上提交基线（见[插件上架打包与提交](./plugin-submission-v1.md)）只认 11 个 v1 目标，v2 目标一律打回**——要上架的包在基线切换前请继续用 `metadata.i18n@1`。

## 扩展目标

机器可读的唯一清单是 `platform/contract/i18n-targets.json`。新增九类，连同旧十一类共二十类；只要求 Manifest 实际存在的字符串字段。

| target | 原始字段 | 引用选择器 |
|---|---|---|
| `storeListing.category` | `storeListing.category` | 无 |
| `storeListing.tagline` | `storeListing.tagline` | 无 |
| `storeListing.longDescription` | `storeListing.longDescription` | 无 |
| `storeListing.capability.label` | `storeListing.capabilities[index].label` | `index` |
| `storeListing.capability.detail` | `storeListing.capabilities[index].detail` | `index` |
| `storeListing.screenshot.caption` | `storeListing.screenshots[index].caption` | `index` |
| `storeListing.phaseOneCommitment` | `storeListing.phaseOneCommitments[index]` | `index` |
| `permission.purpose` | `permissions` 中对应 ID 的 `purpose` | `id` |
| `requirement.displayName` | `requirements` 中对应 ID 的 `displayName` | `id` |

没有稳定 ID 的 listing 数组使用显式零基位置，例如：

```json
{"target":"storeListing.capability.label","index":0,"key":"metadata.firstCapability"}
```

`index` 必须是非负安全整数，且命中该包数组中真实存在的项；不能写数字字符串、负数、小数、越界位置，不能与 `id` 同时出现。带稳定 ID 的目标必须使用精确 ID，不能用位置或路径替代。单字段目标不能带选择器。每个实际目标必须恰好声明一次。未知目标、额外路径字段、重复引用、缺项、缺资源键均拒绝。调整数组顺序时必须同步修改引用，Host 不按文字内容猜测原来是哪一项。

## 展示来源与副作用

Host 先复验语言文件大小与 SHA-256，再把有限的目标文本生成 `localizedMetadata`；此内存展示字段不会进入执行 Manifest 的序列化。前端仅按当前 locale 投影副本，未知语言回退英文，再回退原始字段。语言切换不能发起安装、授权、依赖修复、权限刷新或业务请求，也不能重置输入、勾选或滚动。

详情抽屉显式记录 `listingSource`，并由 `listingMetadata` 声明包自有字段。完整本地 listing 可以投影全部字段；已安装页面混合远端 Catalog 时，只给本地 `capabilities` / `phaseOneCommitments` 投影，远端名称、分类、营销介绍与截图说明保持其来源。远端 Catalog 的多语言发布需由其独立发布流程提供，不能以本地包译文覆盖来冒充完成。

首装确认弹窗使用同一次 `InstallPrepareResponse` 从已验证候选 Manifest 带出的 `localizedMetadata`，不查已安装旧版本来补译。权限及依赖引用只改变展示，确认仍提交原 `id` / `digest` / `decision`。OAuth 弹窗的权威 App 名称、scope 与网络 endpoint 用途来自不同来源，保留原始服务/声明内容，不套用本地 `permission.purpose`。

本轮三个演示包为 Voice、Codex Link、Codex App。其他官方插件和 Examples 的迁移由各 owner 按规范处理，不能将本补充解释为已迁移或已发布。

## 定向验收

- CLI：v1 兼容；v2 完整目标；ID/位置边界；缺项/重复；实际 ZIP 文件摘要、语言资源和元数据校验。
- Rust：同源资源 fixtures，v2 解析与选择器检查，源 Manifest 序列化不变；安装 DTO 保持候选包、Manifest、权限与尝试身份。
- Vue：真实详情抽屉中英切换，远端内容不被覆盖，节点/草稿/滚动保留且新增调用为零；真实首装弹窗分别展示 1.0.0 与 2.0.0 候选的用途，保留勾选，提交原始审批身份。

日志目录：`.artifacts/h06/metadata-v2/`。组件 DOM 验证不等同于真实 App、硬件或线上 Catalog 验收。
