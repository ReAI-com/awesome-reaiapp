# 插件上架打包与提交规范

适用于 Open Platform 的插件提交准备。目的是在交付文件之前发现身份和包内容错误，避免用户反复上传、进入确认页才失败。打包检查通过、平台受理、审核通过和公开上架是不同状态。

## 每次送审的版本介绍（2026-10-02 新要求）

每次审核提交准备必须由开发/送审工作流自动根据实际差异完成插件自己的 `CHANGELOG.md` 版本介绍，不让用户另行提供文案。提交前核对目标版本条目、设置页底部版本入口及「关于插件」的同 appId 链接；同版本同载荷重试复用原条目。详细要求和新站 URL 合同见[插件设置页、版本与关于入口规范](plugin-settings-and-release-notes-v1.md)。本条不新增服务器 submit 字段，不把候选日志自动公开；机器检查与公共同步待后续实施。

## 1. 先固定同一个产品的身份

从用户当前提供的信息、已有提交配置或已授权的当前产品页面读取，已有明确值不重复询问。不要使用其他插件的 Client ID、Team 或 Product，也不要新建重复产品来解决打包问题。

| 身份 | 写入位置 | 规则 |
| --- | --- | --- |
| 插件 App ID | Manifest `appId` | 已存在的反向域名 ID，安装后不随产品显示名称改变 |
| OAuth Client ID | Manifest `oauthAppId` | 必须是当前产品的 OAuth Client ID；不是 Client Secret，也不是 Product ID |
| 发布者 / Team ID | Manifest `publisherId` | 与产品后台 Publisher 精确一致：Team UUID，或平台保留官方身份 `reai`。新团队提交不能保留示例值 `example`，也不能把非保留产品随意写成 `reai` |
| Product ID | `submission.identity.json` 的 `productId`、提交时的产品关联 | 当前 Manifest Schema 没有 `productId`，禁止添加未知字段；它由提交入口关联产品 |
| 提交版本 | `submission.identity.json`、Manifest、`package.json` 的 `version` 与提交表单版本 | 四者精确一致；不要沿用表单默认值，也不要为了匹配默认值擅自升级包版本 |

配置放在插件根目录 `submission.identity.json`，只含公开标识，不保存 Secret、token、Cookie。检查入口随平台包 `@reai/app-i18n-cli` 交付：在插件目录执行 `bunx reai-app-i18n submission check|pack …`，或使用插件自带的 `bun run check:submission` / `bun run pack:submission`。它记录预期身份，Manifest 是实际包声明，两者必须一致。

**填表前先复制包版本。** 以最终包的提交记录为准，将 `version` 原样填入上架表单。表单默认值不要求插件升级为 `1.0.0`。明确发布新版本时，才同步修改源码版本、提交配置并重新打包；已审核版本或摘要不能静默替换。

提交版本需匹配平台完整格式 `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`。已有批准 release 的同版本不能再次提交。同 Product 有 queued / pending / in_review 时不能新建另一条审核。具体版本占用状态须由当前产品页面确认。

**`universal` 的正确含义**：上架请求的 `artifacts[].target` 为 `universal`。Manifest 的 `targets` 仍为平台和架构对象数组，例如 `{ "platform": "macos", "architectures": ["aarch64"] }`。不能把它改成 `["universal"]`，也不能仅凭 Manifest 含平台数组就断言包不能上架。

## 2. 一条命令完成本地提交打包

先按插件 README 安装冻结依赖，执行必要的功能、类型与合同验证。无需因为元数据修复重复无关的整套 App / 真机测试。

在仓库根目录运行：

```sh
cd plugins/code-worker && bunx reai-app-i18n submission pack . --out /absolute/output/code-worker-0.2.0-submission.reaiapp --form-version 0.2.0
```

该命令在现有现代 CLI 外增加提交检查，不改冻结 CLI 或已经批准的插件锁：

1. 检查提交配置完整性、Manifest 的 `appId / publisherId / oauthAppId` 精确匹配，以及提交配置、Manifest、package.json 版本一致；传入 `--form-version` 时在构建前比对实际填写值。
2. 运行 Manifest Schema、语言资源和打包校验。包内图标按 Driver Host 要求使用 PNG，最大 512 × 512、256 KiB；商店图片另按第 3 节验证。送审预检必须使用当前平台合同，并分别核对 i18n 目标、requirements probe、受控能力与 `contributes` 字段。源码侧 Host 支持某个字段不代表当前上架接口已支持。受控能力须取得绑定身份和构建输入的独立源码审查证据，不能从 Manifest 声明推断已获批准。
3. 构建两次并比较完整包字节；重新读取**最终 `.reaiapp`**，核对身份、版本、语言资源、PNG 图标、build-manifest 中每个文件的尺寸、摘要和白名单。
4. 生成 `.reaiapp` 与同名 `.submission.json`。后者保留 Product ID、`target: universal`、实际包 SHA-256 和校验结果，供上传前核对。

**送审字段基线与 Host Schema 必须分别验证。** 默认 `--server-contract current` 使用工具登记的当前送审合同。历史合同通过仅说明历史兼容；在途合同通过仅说明本地候选预检，不能作为当前上传或审核认可。合同变化后重新验证完整 Schema、身份、资源、最终包摘要与源码审查证据。

只检查现有源和包：

```sh
cd plugins/code-worker && bunx reai-app-i18n submission check . --package /absolute/output/code-worker-0.2.0-submission.reaiapp --form-version 0.2.0
```

`--form-version` 必须传入表单当前值，不是为了通过检查重复抄一个预期值；例如传 `1.0.0` 检查当前 `0.2.0` 包会立即失败。没有表单时可省略，但本地工具无法读取远程草稿，不能宣称表单已校验。

`pack:submission` 是仓库提交准备入口（它不带 `--server-contract`，按线上合同 `current` 检查）。插件原有 `pack` 保持独立平台 tarball 环境可用；**上架交付要使用本节的提交入口**，不能把普通构建成功等同于提交准备完成。

## 3. 图片与交付文件

- 包内图标使用符合 Driver Host 要求的 PNG；替换时同时更新 Manifest 和 sidebar 引用，重新打包。商店图标可直接复用该文件。
- **商店图片的服务器规则**：图标恰好一张，截图至少一张、最多九张；实际字节格式允许 PNG/JPEG/WebP，每张最大 10 MiB；截图顺序唯一，caption 可空、最多 200 字符。当前上架接口没有图片像素尺寸/正方形硬校验，不能把 Host 的 PNG / 512 / 256 KiB 规则描述成商店审核规则。
- 截图保持清晰；演示数据带可见标记，不能当真实业务或验收证据。图片清晰度属于交付要求，不是当前代码已有的像素门禁。
- 把当前推荐 `.reaiapp`、`.submission.json`、图标、截图及简短说明放入用户要求的同一目录；说明开头给出可直接复制的**表单版本**、产品身份、文件名和摘要。旧包留在标明“旧版本”的子目录，避免误选；新压缩包不得把旧包混入。
- 交付前检查压缩包实际包含的是刚验证的包，回读 SHA-256；不要手改 `.reaiapp` ZIP 内文件或复用过期下载包。

## 4. 上传、收费与状态恢复

准备包不等于已获上传、付费提交或发布授权。明确授权内尽量复用当前 Product、草稿、已有素材与版本，不反复创建。上传后使用同一绑定 Project 的真实 CAS `fileId`；在提交前核对产品、版本、包 SHA-256、图片与当前报价。不能填造假的 fileId，也不能复制其他产品的审批。

收费截图、页面上预勾选的“确认付费提交”和技能说明都不是用户支付授权。尚未获得明确付费提交授权时，完成全部本地准备后由用户进行最终提交；已获得的明确授权继续有效，不重复询问。

遇到稳定校验错误先修对应字段，再重建和复验；不要对同一个坏包重复点击提交。超时或结果不明时先只读查询当前草稿/审核记录，确认是否已受理，再决定是否重试；保留既有幂等键和产品身份。只报告实际到达的状态，不把本地校验写成审核通过。

## 5. 提交入口与完整服务器检查

以下列出提交需要核对的合同。接口前缀、身份绑定、余额及审核状态以实际产品页面和当前平台合同为准。

| 检查层 | 服务器强制合同 | 本地工具的边界 |
| --- | --- | --- |
| 身份与角色 | Team owner/admin 可报价、提交；OAuth App 必须属于该 Team，并绑定有效 Product / Project；包的 Team、OAuth Client 与 Product 绑定值匹配 | 配置间相等只能证明本地一致，实际关联和角色需服务端确认 |
| 插件身份 | 首次提交可确立 Product 的 package_app_id；之后保持一致，不能占用其他 Product 的 appId | 不新建 Product 来绕过身份冲突 |
| Manifest | 当前 manifestVersion 为 1.1；按平台 Schema 拒绝未知字段；发布解析器额外要求 oauthAppId 非空 | Schema 中可选不代表上架可缺；不添加 Product ID、reviewPolicy 等未知字段 |
| 包制品 | 恰好一个 `.reaiapp`，artifact.target 为 universal | 最终包与提交记录保持相同 SHA-256 |
| ZIP | 压缩包 ≤64 MiB，≤4096 项；单项解压 ≤128 MiB，总解压 ≤512 MiB，Manifest ≤1 MiB；根目录唯一 Manifest | 禁止多磁盘、ZIP64、加密、非 store/deflate、尾随数据、不安全或重复路径；现有本地工具检查范围见第 2 节，不能宣称已等价复刻所有服务器解析分支 |
| 资源完整性 | 声明 i18n 时要求 build-manifest，并逐项校验路径、大小和 SHA-256 | 本仓库生成并复验 build-manifest；提交受理和真实 Host 安装可运行须分别验证 |
| 展示文本 | name、developerName 必填且各 ≤200 字符；description 必填 ≤10000；tagline 必填 ≤240；category 为 Agents/Productivity/Media/Writing/Dev | 交付说明列出最终填充值；这些不是 Manifest 之外可随意增加的字段 |
| 图片 | 第 3 节的张数、字节格式、大小和 caption 限制 | 当前本地打包脚本只检查包内图标，不声称已检商店文本或全部截图 |
| CAS | 每个 fileId 属于 Product 绑定 Project，未删除且有 content hash；文件记录与下载字节的大小、摘要一致 | 本地 SHA-256 不证明服务器 fileId 归属；不得编造 fileId |
| 权限与能力 | permissions / requires 按 Schema 检查；审核员需确认 OAuth compliance、插件代码审核，并逐项批准请求的受控 Host capabilities | 包内声明、用户安装同意与平台能力批准是不同步骤 |
| 签名与价格 | 插件提交审核与 Host 安装签名核验分别执行；提交表单没有插件商品售价字段 | 不把 Host App 签名要求混入插件提交；审核费不等于商品售价 |
| 状态 | submit 生成 queued；审核批准产生 approved release；之后显式 publish 才公开 | 版本校验通过、受理、批准、上架分别记录 |

### 路由与填写字段

路径里的 `:clientId` 是 **OAuth App 数据库记录 ID**，不是公开的 OAuth `client_id`。Manifest `oauthAppId` 才使用公开 Client ID。不得把用户给出的公开 Client ID 直接当成路由 ID。Product ID 由已有 OAuth App 的绑定确定，不加入 submit body 来更换产品。

以下路由要求用户登录。precheck、submit、history、withdraw、publish 要求 Team owner/admin；products 读取允许 Team member。会话令牌不写进规范、收据或 Git。

| 用途 | 方法与路径 |
| --- | --- |
| 只读审核额度/报价 | `GET /teams/:teamId/oauth-apps/clients/:clientId/review/precheck` |
| 提交审核 | `POST /teams/:teamId/oauth-apps/clients/:clientId/review` |
| 查询 Product、submission、release | `GET /teams/:teamId/oauth-apps/products` |
| 查询审核/扣费历史 | `GET /teams/:teamId/oauth-apps/review-history?month=YYYY-MM&page=N&settlement_page=N` |
| 撤回提交 | `POST /teams/:teamId/oauth-apps/clients/:clientId/reviews/:submissionId/withdraw` |
| 批准后发布预检 | `GET /teams/:teamId/oauth-apps/products/:productId/releases/:releaseId/publish-precheck` |
| 批准后显式发布 | `POST /teams/:teamId/oauth-apps/products/:productId/releases/:releaseId/publish` |

**review/precheck 只核对额度和报价，不校验上传包。** 当前没有独立公开的 package prepare/preflight 路由，真正包解析发生在 submit 内。因此本地先验包、先核对表单，不能把“重新获取报价成功”写成“包已通过审核”。

提交 body 的必要业务字段为 `version`、`catalog_metadata`、`artifacts`。`catalog_metadata` 包含 name、developerName、description、category、tagline、iconFileId、screenshots（`[{fileId,caption}]`）；`artifacts` 为 `[{fileId,target:"universal"}]`。收费时还需要 `confirm_paid:true`、`expected_fee_milli_credits`、`expected_paid_quote_fingerprint`。自动化请求显式提供 `Idempotency-Key`；不在文档中填写虚构的 fileId、报价 fingerprint 或数据库记录 ID。

发布接口另需 `expected_current_public_revision_id`，明确传当前 revision 或 null；提交审核的授权不自动包含这一步。

### 报价、收费与失败恢复

- precheck 只读，不占次数、不扣款。当前配置是每 Team 每月两次免费，超额 1,000,000 milli-credits（1,000 credits）；**执行时仍读取真实返回值**，不把文档数字当实时价格。
- 没有固定的“报价有效 N 分钟”。Paid fingerprint 绑定 Team、付款人、App、Product、草稿 revision、余额及费用等事实；变化后需重新报价和确认。不要长期复用下载说明中的旧 fingerprint。
- 同用户、同 `Idempotency-Key`、同载荷重试返回原 submission；载荷变了则返回冲突。先读产品与审核历史确认结果，同次请求保留 key；更改版本/素材/元数据后按新载荷重新准备 key。服务器虽允许缺 key 时随机生成，自动化不能依赖这一点防重。
- 提交、扣款、allocation 与 artifact 绑定在同一数据库事务中；错误导致回滚。网络超时不等于失败，不能盲目再次扣款。前端只有载荷变化时才换 key。

| 错误 | 正确处理 |
| --- | --- |
| `reaiapp_version_mismatch` | 读取 expected/actual；表单应填最终包版本。明确要新版本时才改源码、配置并重打包 |
| `reaiapp_oauth_app_id_missing/mismatch`、`reaiapp_publisher_id_mismatch`、`reaiapp_app_id_mismatch` | 核对同一 Product 身份；修源后重打包，不重试同一个坏包 |
| `package_target_unsupported` | 修提交 artifact.target，保留 Manifest 的平台/架构 targets |
| `oauth_product_review_already_active` | 读取已有活跃审核，不重复新建 |
| `oauth_product_version_already_exists` | 查看已有批准 release；需要新提交时选择一致的新版本 |
| `oauth_review_submit_idempotency_conflict` | 核对是否更改载荷；不得用同 key 提交另一个包 |
| `oauth_review_fee_changed`、`oauth_review_paid_confirmation_stale` | 重新 precheck，按变化后的费用和状态确认 |
| `insufficient_credits` | 余额不足，不能自动充值或重复尝试扣费 |
| `review_source_must_be_cas`、`oauth_review_artifact_digest_mismatch` | 核对 Project 与真实 CAS 文件、路径和摘要 |
| `app_capability_approval_required` | 交平台审核员逐项批准能力，不能靠改批准产物锁绕过 |

## 6. 交付填写清单

每次交付在说明开头给出：**表单版本**、Product 名称/ID、Team publisherId、公开 OAuth Client ID、插件 appId、推荐包文件名/字节数/SHA-256、artifact.target、图标和截图顺序，以及最终展示文本。申请的 OAuth scopes、Host capabilities、permissions/requires 单独列明；平台绑定 Project、OAuth App 记录 ID、上传后的 CAS fileId、线上版本占用和费用在真实页面/接口确认，未取得时标为未核对，不能编造。

审核规则或表单校验变化时，先核对当前公开合同及真实产品状态，再更新提交材料。不要仅根据报错逐个猜规则。

## 7. 合同来源与源码审查

- Manifest 字段以 `app-manifest-1.1.schema.json`（仓库路径 `packages/contract/schemas/app-manifest-1.1.schema.json`） 为准。
- OAuth 运行规则见[开发规范](plugin-development-v1.md#41-读取账户状态)。
- 包内图标遵循[插件开发指南](app-development-guide-v1.md)的 Host 合同；商店图片单独按当前提交合同核对。

### 独立提交前源码审查证据

可在 `check` / `pack` 显式传 `--source-review <file.json>`。这是本地预审证据，不写入 Host runtime seed、不授予安装运行能力，也不替代平台签名批准。默认不传时保留原拒绝规则。

证据绑定 appId/publisherId/oauthAppId/version、完整插件输入文件清单与哈希、独立报告哈希及 `SOURCE_REVIEW_SCOPE`、期望最终包 SHA。输入/报告/身份/最终包变化必须重新审查。构建、两次打包与归档复验全程核同一证据，只消除已审范围的能力拒绝，Schema/未知能力/资源/Host API 等错误保留。

正规例：`cd plugins/voice && bunx reai-app-i18n submission pack . --out <path>.reaiapp --form-version <version> --source-review <evidence.json>`。成功 `.submission.json` 标明本地证据摘要、runtimeGrant:false、platformApproval:false。上传须使用真实CASfileId、当前报价、冻结包，审核后的批准必须绑定精确摘要；不能据源码记录启动未批准候选。


## 8. 可复现压缩与待审字节

2026-10-06 源码同步：`scripts/plugin-submission.ts` 与 modern CLI 已支持
`--compression deflate`，`scripts/source-review-bytes.ts` 提供独立离线待审字节计算。
默认 STORE 路径与校验继续适用；这些工具不产生平台批准或发布状态。

支持该合同的 modern 工具链默认仍使用 STORE。显式 `--compression deflate` 仅用于 pack，
check 自动识别格式。压缩固定 `fflate 0.8.3`、`{ level: 9, mem: 8 }`、条目顺序、时间与
普通文件属性；不节省字节或超过压缩比限额的资源保留 STORE。必须重复构建并逐字节一致，
验包仍核路径、local/central 目录、CRC、尺寸、资源 SHA、白名单及完整归档摘要。
冻结 CLI 不新增该选项。64 MiB 包上限与团队实际存储配额分别执行。

改变压缩策略会改变包 SHA-256，必须重新计算候选、取得绑定完整来源输入与最终摘要的
独立 SOURCE 审查，再走正常双打包。旧 STORE 证据不能批准新 Deflate 归档，不能手工重压
后复用旧批准；SOURCE 证据也不替代平台签名、Host 安装或业务验收。

首次审查前的独立离线计算只生成待审字节及计算回执：绑定全部源码输入、实际工具链、
实际解析的编码器入口与完整文件摘要，计算前后核验；缺项、漂移、版本或 schema/资源/
语言错误应失败。输出目录位于插件之外且尚不存在，两次计算顺序执行，不与构建测试并发。
默认 STORE 不依赖 Deflate 编码器；显式 Deflate 必须核验相同的固定编码器字节。

该入口仅支持普通 App，不支持 Skin。输出为 `candidate.review-bytes` 与 `calculation.json`；
回执记录压缩策略、完整输入与工具链摘要、归档摘要与大小、资源清单，以及仍待审的能力拒绝。

材料始终标记 `NOT_VALIDATED`、`NOT_APPROVED`、`NOT_INSTALLABLE`、`NOT_PUBLISHED`，
`runtimeGrant:false`、`platformApproval:false`。它不生成源码批准、提交回执或运行授权。
独立审查后再用正常 CLI 两次打包核对摘要与完整字节；任何输入、工具链、依赖或压缩策略
变化都要重新计算和审查。文档同步本身不启动审查、上传或发布。

离线输入文件格式为 `{schemaVersion:1,sourceFiles,sourceFilesSha256}`。文件清单和摘要由
`collectSourceReviewInputs`、`sourceReviewInputsDigest` 生成，必须覆盖全部插件输入。

```sh
bunx reai-app-i18n review-bytes <plugin-root> --inputs <complete-input-pin.json> --out <new-directory> --expected-bun 1.3.14 --compression deflate
```

普通提交打包可显式增加 `--compression deflate`；`check` 自动识别归档格式，
不接受压缩参数。计算目录必须位于插件之外且尚不存在。生成待审材料后仍须取得
绑定完整输入和最终包摘要的独立 SOURCE 审查，再执行正常双打包。
