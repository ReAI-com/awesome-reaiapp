# 插件上架打包与提交规范

适用于 Open Platform 的插件提交准备。目的是在交付文件之前发现身份和包内容错误，避免用户反复上传、进入确认页才失败。打包检查通过、平台受理、审核通过和公开上架是不同状态。

## 1. 先固定同一个产品的身份

从用户当前提供的信息、已有提交配置或已授权的当前产品页面读取，已有明确值不重复询问。不要使用其他插件的 Client ID、Team 或 Product，也不要新建重复产品来解决打包问题。

| 身份 | 写入位置 | 规则 |
| --- | --- | --- |
| 插件 App ID | Manifest `appId` | 已存在的反向域名 ID，安装后不随产品显示名称改变 |
| OAuth Client ID | Manifest `oauthAppId` | 必须是当前产品的 OAuth Client ID；不是 Client Secret，也不是 Product ID |
| 发布者 / Team ID | Manifest `publisherId` | 与产品后台 Publisher 精确一致：Team UUID，或平台保留官方身份 `reai`。2026-09-17 Terminal 产品卡片实读明示 "Source: the existing reserved platform identity reai. Use the value above in your package manifest."，服务端以同一 `product.publisher_id` 做 freeze 比对（`official_reserved` 注记）；本地门已同步接受这两个形态。新团队提交不能保留示例值 `example`，也不能把非保留产品随意写成 `reai` |
| Product ID | `submission.identity.json` 的 `productId`、提交时的产品关联 | 当前 Manifest Schema 没有 `productId`，禁止添加未知字段；它由提交入口关联产品 |
| 提交版本 | `submission.identity.json`、Manifest、`package.json` 的 `version` 与提交表单版本 | 四者精确一致；不要沿用表单默认值，也不要为了匹配默认值擅自升级包版本 |

配置放在插件根目录 `submission.identity.json`，只含公开标识，不保存 Secret、token、Cookie。检查入口随平台包 `@reai/app-i18n-cli` 交付：`reai-app-i18n submission check|pack …`；本仓另保留等价的包装命令 `bun scripts/plugin-submission.ts …`（下文示例用它，参数完全相同）。它记录预期身份，Manifest 是实际包声明，两者必须一致。

**填表前先复制包版本。** 以最终包的提交记录为准，将 `version` 原样填入上架表单。2026-09-14 的实际错误为“本次要求 `1.0.0`，包内实际 `0.2.0`”，用户将表单改为 `0.2.0` 后通过该校验。这不要求把插件升级到 `1.0.0`。如果明确要发布新版本，再同步修改源码版本、提交配置并重新打包；已审核版本或摘要不可静默替换。

已核对：`1.0.0` 是前端默认/建议值，首发没有必须为 1.x 的限制。提交版本需匹配平台完整格式 `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`。服务端未强制与上一版本做大小比较；已有批准 release 的**同版本**不能再次提交，rejected / withdrawn / cancelled 且没有同版本 release 时可复用原版本。同 Product 有 queued / pending / in_review 时不能新建另一条审核。前端建议 patch + 1 不等于服务器强制递增。

**`universal` 的正确含义**：上架请求的 `artifacts[].target` 为 `universal`。Manifest 的 `targets` 仍为平台和架构对象数组，例如 `{ "platform": "macos", "architectures": ["aarch64"] }`。不能把它改成 `["universal"]`，也不能仅凭 Manifest 含平台数组就断言包不能上架。

## 2. 一条命令完成本地提交打包

先按插件 README 安装冻结依赖，执行必要的功能、类型与合同验证。无需因为元数据修复重复无关的整套 App / 真机测试。

在仓库根目录运行（只装了平台包、没有本仓 checkout 时，在插件目录用 `bunx reai-app-i18n submission pack . --out …`，参数相同）：

```sh
bun scripts/plugin-submission.ts pack plugins/official/code-worker --out /absolute/output/code-worker-0.2.0-submission.reaiapp --form-version 0.2.0
```

该命令在现有现代 CLI 外增加提交检查，不改冻结 CLI 或已经批准的插件锁：

1. 检查提交配置完整性、Manifest 的 `appId / publisherId / oauthAppId` 精确匹配，以及提交配置、Manifest、package.json 版本一致；传入 `--form-version` 时在构建前比对实际填写值。
2. 运行现有 Manifest Schema、语言资源和打包校验；包内图标按 **Driver Host** 要求使用 PNG，最大 512 × 512、256 KiB。这与商店上传图片的限制不同。另按**平台 Manifest 合同基线（线上 1.1@005a0f63-agent-features，2026-10-02 起；此前为 1.1@31cf8889 / 1.1@c3475cb，i18n 目标枚举不变）**检查 i18n `messages[].target`：只接受 `name / description / sidebar.label / surface.title / command.title / command.bindingPickerTitle / titlebarAction.* / titlebarStatus.label / scheduledTask.*` 这 11 个 v1 目标，`storeListing.*`、`permission.purpose`、`requirement.displayName` 等 `metadata.i18n@2` 目标一律拒绝（2026-09-26 Codex Link 0.5.11 上传后被服务端以「/i18n/messages/9/target · enum · 1.1@c3475cb」打回；Voice、Browser 早已降回 `metadata.i18n@1`）。源码侧 Host 已支持 v2 目标（见[插件元数据 i18n v2 补充](./plugin-i18n-metadata-v2.md)），但**线上基线未切换前，提交检查仍按 11 个 v1 目标执行**——这是「源码支持 ≠ 线上发布」的既定口径，不是遗漏。商店展示文案由提交表单填写，不靠 i18n 引用。同一基线下还检查两类后端合同（2026-09-27 发布编排确认已在两个节点上线）：`requirements[].probe.id` 只接受 `codex-app-server-v1 / pi-agent-v1 / dsh-runner-v1 / audio8-helper-v1` 与 `codex-app-server-v2 / pi-agent-v2 / dsh-native-v2` 这 7 个（否则上传即 `reaiapp_manifest_schema_invalid`）；Host 标为 grantGated 的 `requires.hostCapabilities` 必须在审核员可批准的 25 项能力目录内（含 `agent.session@2 / surface.clipboard@1 / local.terminal.exec@1`；否则审批时 `app_capability_approval_invalid`，Host 也不会放行）。默认合同 `current` 即这份线上合同，回执状态为 `local-preflight-passed`。旧基线 `1.1@c3475cb`（只认 4 个 v1 probe、22 项能力）已删除、不再作为选项：已无节点执行它，新合同只增不减，按旧合同检查只会复现后端不再发生的拒绝；原 `--server-contract native-v2-pending` 已退役，传入会直接报错并提示去掉开关。以后后端再有在途合同，先在工具里加一条 `pending-rollout` 合同、只能用 `--server-contract <名称>` 显式启用（回执标为 `local-preflight-passed-pending-backend-contract`，**后端确认部署前不得上传**），上线后替换 `current`，不长期依赖开关。另外，本地 Manifest 校验按 `platform/contract/capability-review-policy.seed.json` 判断 grantGated 能力：定版号若声明了通配记录之外的受控能力，需要一条精确 publisher / version 的源码审核记录（能力集不得超出已审核候选；这一点由仓库守卫测试钉住，校验工具本身只逐项判断能力是否获批），否则报 `APP_CAPABILITY_NOT_GRANTED`；这条记录只供本地构建与 Builtin / plugin-dev，不代替平台签名批准。
3. 构建两次并比较完整包字节；重新读取**最终 `.reaiapp`**，核对身份、版本、语言资源、PNG 图标、build-manifest 中每个文件的尺寸、摘要和白名单。
4. 生成 `.reaiapp` 与同名 `.submission.json`（或 `--receipt` 指定的私有文件）。后者保留 Product ID、`target: universal`、实际包 SHA-256 和校验结果，供上传前核对；命令行只打印不含身份的摘要（见下文「身份放在源码树外与日志口径」）。

默认使用 STORE，原归档保持逐字节兼容。回执格式在 2026-10-19 增加了 `command`、`formVersionCheck` 字段（检查项含 `form-version` 时如实列出）；用旧版工具留下的同名回执重跑会因内容不同而拒绝覆盖，改用新的输出文件名即可。需要减小包体积时，在正常提交入口显式增加 `--compression deflate`；modern CLI 的 `reai-app-i18n pack` 也接受同一参数，`check` 自动识别包内 STORE / Deflate，不接受压缩参数。例如：

```sh
bun scripts/plugin-submission.ts pack <pluginDir> --out /absolute/output/new-submission.reaiapp --compression deflate --source-review /absolute/review/new-evidence.json
```

压缩器固定为 `fflate 0.8.3`，参数 `{ level: 9, mem: 8 }`，条目顺序、时间和普通文件属性固定；不节省字节或超过 Host 逐项压缩比上限的资源保留 STORE。完整双构建仍须逐字节相同，验包器在有界解压后核 CRC、尺寸、资源 SHA 和白名单，并核 local / central 目录一致性、路径及原 Host 限额。Deflate 回执增加 `compression: "deflate"` 与 `deterministic-deflate` 检查项；冻结 CLI 不增加该选项。

**压缩方式变化会改变整个包的 SHA-256。** 最终包 owner 必须使用所选压缩方式重新计算候选摘要、获得绑定完整源码输入及该最终摘要的独立 SOURCE 审查，再用正常提交入口生成双包。旧 STORE 的 SOURCE 证据会拒绝新 Deflate 归档；禁止手工重压后复用旧批准。64 MiB 的包格式上限与团队实际单文件 / 总存储限额分别执行，压缩不放宽上传配额，也不代替平台批准或 Host 运行授权。

**送审字段基线与 Host Schema 必须分别验证。** 2026-10-02 Voice `2.14.4-rc.3` 实际正式送审失败：包内合法的 `contributes.agentFeatures` 被当时已部署服务的 `1.1@31cf8889` Schema 以 `additionalProperties` 拒绝。该旧基线的 `contributes` 仅接受 `surfaces / services / titlebarActions / titlebarStatus / tabItems / actionItems / eventSubscriptions / acceptsActionContext / sidebarItems / scheduledTasks / commands / intents / recommendedBindings`；即使 `agentFeatures` 为空数组也属于未知字段。本地预检现在同时检查这份服务器字段白名单，源码与最终归档都不能只凭新版 Host Schema 通过就宣称可上传。

2026-10-02 起线上合同为 `1.1@005a0f63-agent-features`。默认 `current` 因此切换为该已部署合同，仅新增 `contributes.agentFeatures`，回执为 `local-preflight-passed`。7 个 probe、25 项可审核能力及 11 个 i18n v1 目标均未扩展，`metadata.i18n@2` 仍不支持；完整 canonical Schema、身份、资源、最终包摘要及源码审查证据检查照常执行。

`--server-contract agent-features-pending` 已退役，传入会报错并提示改用默认 `current`。为了准确复现 rc3 原失败，旧字段合同保留为显式 `--server-contract legacy-31cf8889`，其 `backend` 为 `historical`、回执为 `local-preflight-passed-historical-server-contract`；这仅表示通过历史合同检查，不能视作当前服务器上传认可。

2026-10-15 服务端上线：上传 Schema 基线 `1.1@005a0f63-notification-scenes`，`contributes` 放行 `notificationScenes`；审核员可批准能力表扩到 29 项，新增 `audio.capture@1`、`audio.clips@1`、`surface.escape@1`、`resources.files@1`。默认 `current` 因此切换为该已部署合同，原 opt-in 的 `notification-scenes-pending` 与 `v105-capabilities-pending` 退役（传入会报错并提示去掉开关），回执恢复为 `local-preflight-passed`。`tasks.present@1`、`notifications.publish@1` 仍不在可批准表里，默认合同继续如实拒绝。通知场景另有后端语义校验（key 唯一且不得为 `legacy.post`、纯文本、`defaultLevel ≤ maxLevel`、`hostApi.range` 下界 ≥ 1.25.0 且只认空格分隔的完整 `x.y.z` 比较子），本地预检尚未复刻这些语义规则，以服务端解析结果为准。

只检查现有源和包：

```sh
bun scripts/plugin-submission.ts check plugins/official/code-worker --package /absolute/output/code-worker-0.2.0-submission.reaiapp --form-version 0.2.0
```

`--form-version` 必须传入表单当前值，不是为了通过检查重复抄一个预期值；例如传 `1.0.0` 检查当前 `0.2.0` 包会立即失败。没有表单时可省略，但本地工具无法读取远程草稿，不能宣称表单已校验。

### 身份放在源码树外与日志口径

默认身份文件仍是插件根 `submission.identity.json`，`pack` 的收据仍写到 `<out>.submission.json`。需要让公开源码与私有送审使用**完全相同的源码输入**时（插件仓公开、身份只放本机或私有配置），用显式外部身份：

```sh
bun scripts/plugin-submission.ts pack <pluginDir> --out /private/out/<name>-submission.reaiapp --identity /private/identity/<name>.json --receipt /private/receipts/<name>.json
bun scripts/plugin-submission.ts check <pluginDir> --identity /private/identity/<name>.json --receipt /private/receipts/<name>-check.json
```

- `--identity` 与插件根的 `submission.identity.json` 二选一；身份、包、收据都必须在插件源码树之外，三者不能是同一文件。所有路径都按物理路径判断，路径中有软链会被拒绝（传 `realpath` 后的路径）。这些检查在任何构建或写入之前完成，失败时不产生产物。
- 这样同一提交的公开树（没有身份文件）与私有送审的源码审查输入摘要一致，包摘要也一致。
- `--receipt` 对 `check`、`pack` 都可用：完整身份收据只写入这个私有文件，已存在不同内容时失败、不覆盖。收据写明 `command`（`check` / `check-package` / `pack`）与实际完成的 `checks`：普通 `check` 只做源码层检查、没有包摘要；`check --package` 记录被验证包的摘要；只有 `pack` 声明两次构建一致。
- 命令行输出只包含状态、命令、合同、`appId`、版本、表单版本核对结果、包文件名与摘要，**不打印 `publisherId`、`oauthAppId`、Product ID**。错误信息同样脱敏：读身份之前的错误不复述参数，读身份之后出现在输出里的这三个值一律替换为 `<redacted:字段名>`（平台保留发布者 `reai` 是公开值，不替换）。不要依赖 CI 日志遮罩。
- 外部身份文件不能是硬链接（防止同一字节同时出现在插件树里）；最终写入前会重新核对一次路径布局，期间路径被替换则失败。
- 脱敏只管工具自身的输出。`pack` 会执行插件的构建代码，插件源码本身能读取本机文件；只对已审查或可信的源码运行送审，身份文件放在插件源码无需访问的位置。

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

以下是 2026-09-14 对服务项目源码的只读核对结果，**不代表已经调用线上提交接口**。接口前缀、身份绑定、余额及审核状态以实际环境为准。

| 检查层 | 服务器强制合同 | 本地工具的边界 |
| --- | --- | --- |
| 身份与角色 | Team owner/admin 可报价、提交；OAuth App 必须属于该 Team，并绑定有效 Product / Project；包的 Team、OAuth Client 与 Product 绑定值匹配 | 配置间相等只能证明本地一致，实际关联和角色需服务端确认 |
| 插件身份 | 首次提交可确立 Product 的 package_app_id；之后保持一致，不能占用其他 Product 的 appId | 不新建 Product 来绕过身份冲突 |
| Manifest | 当前 manifestVersion 为 1.1；按平台 Schema 拒绝未知字段；发布解析器额外要求 oauthAppId 非空 | Schema 中可选不代表上架可缺；不添加 Product ID、reviewPolicy 等未知字段 |
| 包制品 | 恰好一个 `.reaiapp`，artifact.target 为 universal | 最终包与提交记录保持相同 SHA-256 |
| ZIP | 压缩包 ≤64 MiB，≤4096 项；单项解压 ≤128 MiB，总解压 ≤512 MiB，Manifest ≤1 MiB；根目录唯一 Manifest | 禁止多磁盘、ZIP64、加密、非 store/deflate、尾随数据、不安全或重复路径；现有本地工具检查范围见第 2 节，不能宣称已等价复刻所有服务器解析分支 |
| 资源完整性 | 声明 i18n 时要求 build-manifest，并逐项校验路径、大小和 SHA-256 | 本仓库始终生成并复验 build-manifest；服务器尚未统一检查普通 runtime entry 是否真实存在，不能把提交受理视为安装可运行 |
| 展示文本 | name、developerName 必填且各 ≤200 字符；description 必填 ≤10000；tagline 必填 ≤240；category 为 Agents/Productivity/Media/Writing/Dev | 交付说明列出最终填充值；这些不是 Manifest 之外可随意增加的字段 |
| 图片 | 第 3 节的张数、字节格式、大小和 caption 限制 | 当前本地打包脚本只检查包内图标，不声称已检商店文本或全部截图 |
| CAS | 每个 fileId 属于 Product 绑定 Project，未删除且有 content hash；路径为规范 `_cas/aa/bb/<sha256>[.ext]`；记录、路径、下载字节的大小/摘要一致 | 本地 SHA-256 不证明服务器 fileId 归属；不得编造 fileId |
| 权限与能力 | permissions / requires 按 Schema 检查；审核员需确认 OAuth compliance、插件代码审核，并逐项批准请求的受控 Host capabilities | 包内声明、用户安装同意与平台能力批准是不同步骤 |
| 签名与价格 | 当前提交链路未设置 codesign / 发布者证书硬门禁，也没有插件商品售价字段 | 不把 App 签名要求混入插件提交；审核费不等于商品售价 |
| 状态 | submit 生成 queued；审核批准产生 approved release；之后显式 publish 才公开 | 版本校验通过、受理、批准、上架分别记录 |

### 路由与填写字段

路径里的 `:clientId` 是 **OAuth App 数据库记录 ID**，不是公开的 OAuth `client_id`。Manifest `oauthAppId` 才使用公开 Client ID。不得把用户给出的公开 Client ID 直接当成路由 ID。Product ID 由已有 OAuth App 的绑定确定，不加入 submit body 来更换产品。

以下路由使用 `userSessionAuth`；precheck、submit、history、withdraw、publish 要求 Team owner/admin，products 读取允许 Team member。会话令牌不写进规范、收据或 Git。

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

## 7. 合同来源与可复用 Skill

- Manifest 字段以 `app-manifest-1.1.schema.json`（`@reai/app-contract` 包内 `schemas/app-manifest-1.1.schema.json`） 为准；OAuth 运行规则见[开发规范](./plugin-development-v1.md#41-读取账户状态)。
- 包内图标是 Driver Host 合同，见[插件开发指南](./app-development-guide-v1.md)；它比商店图片格式限制更严格。

### 独立提交前源码审查证据

可在 `check` / `pack` 显式传 `--source-review <file.json>`。这是本地预审证据，不写入 Host runtime seed、不授予安装运行能力，也不替代平台签名批准。默认不传时保留原拒绝规则。

证据绑定 appId/publisherId/oauthAppId/version、完整插件输入文件清单与哈希、独立报告哈希及 `SOURCE_REVIEW_SCOPE`、期望最终包 SHA。输入/报告/身份/最终包变化必须重新审查。构建、两次打包与归档复验全程核同一证据，只消除已审范围的能力拒绝，Schema/未知能力/资源/Host API 等错误保留。

正规例：`bun scripts/plugin-submission.ts pack plugins/official/voice --out <path>.reaiapp --form-version <version> --source-review <evidence.json>`。成功 `.submission.json` 标明本地证据摘要、runtimeGrant:false、platformApproval:false。上传须使用真实CASfileId、当前报价、冻结包，审核后的批准必须绑定精确摘要；不能据源码记录启动未批准候选。

#### 首次审查前的离线规范字节计算

`SOURCE_REVIEW_SCOPE` 需要真实包摘要。尚无有效源码证据时，用独立计算命令生成待审材料：

```bash
bun scripts/source-review-bytes.ts <plugin-root> --inputs <complete-input-pin.json> --out <new-directory> --expected-bun 1.3.14
# 等价的包内入口（只装了平台包时）：reai-app-i18n review-bytes <plugin-root> --inputs … --out … --expected-bun 1.3.14 [--toolchain-receipt <toolchain.json>]
```

工具链身份只从插件实际安装的平台包认定，不再依赖本仓 checkout：`calculation.json` 的 `toolchain.gitHead` 是**插件源码所在仓库**的 HEAD（插件必须在 Git 仓库内），`toolchain.toolchainSource` 记录认定方式。不传回执时是 `installed-same-content`（计算入口自身与插件已安装的平台包逐字节相同）；传 `--toolchain-receipt <make platform-release 输出的 toolchain.json>` 时是 `receipt-content-consistent`，并记录回执摘要与回执里的 `sourceHead`。回执模式只证明「回执 → tarball → 已安装字节」内容一致，**不认证** `sourceHead` 的真实性：回执与 tarball 必须来自本仓 `make platform-release`，消费方要把回执摘要钉在自己的锁文件里核对。

待审包需要 Deflate 时，在同一入口显式增加 `--compression deflate`。可选值只有 `store` 和 `deflate`，省略时仍为 STORE。旧 STORE 的源码证据不能批准新 Deflate 包。

输入文件由实际 `collectSourceReviewInputs` 和 `sourceReviewInputsDigest` 生成，格式为 `{schemaVersion:1,sourceFiles,sourceFilesSha256}`。它必须覆盖插件全部输入。计算前后精确核对输入与工具链，并复验插件正常 CLI 实际解析的包字节。缺项、漂移、版本不一致、未知能力、Schema、路径、资源或语言错误都会失败；仅记录声明中现有矩阵要求源码审核的能力拒绝。

命令重用正常 Bun 编译、Build Manifest 与所选 ZIP 构造。它只支持普通 App。显式 Deflate 还核对正常已安装 CLI 实际解析的 `fflate 0.8.3`：相对入口与完整包文件哈希必须和计算入口所用编码器相同，计算前后均复核；缺包、版本或字节漂移会失败。编码器每次从已核对的实际包重新加载，同一进程复用 API 时也不借用旧 CJS 缓存。默认 STORE 不加载或依赖该编码器。输出目录必须在插件外且尚不存在。依次运行两次，不能与其他构建或测试并发。输出只有 `candidate.review-bytes` 和 `calculation.json`，后者记录实际压缩方式、完整输入、工具链哈希、包摘要、大小、资源清单及仍待审的能力拒绝。

材料始终标为 `NOT_VALIDATED`、`NOT_APPROVED`、`NOT_INSTALLABLE`、`NOT_PUBLISHED`，且 `runtimeGrant:false`、`platformApproval:false`。`NOT_INSTALLABLE` 表示它不是安装交付或授权凭据，不是声称 ZIP 字节无法被改名。该入口不生成源码审批、`SOURCE_REVIEW_SCOPE`、提交回执或运行 grant。

独立审查者审核精确来源、能力边界及实测包摘要后，才可生成新报告和正常源码证据。旧报告不能改写或借用其包摘要。随后必须用正常 CLI 两次打包，核对相同摘要和完整字节。工具链、依赖、压缩策略或输入有变化时，重新计算并审查。平台签名审核、Host 安装批准和真实业务验收仍独立执行。

#### 独立审查根：插件仓与审查材料不在同一仓库时

默认（不传 `--review-root`）时，审查报告必须位于插件源码所在 Git 仓库内，只接受 `schemaVersion: 1` 证据，规则与上文完全一致。插件源码放在公开插件仓、审查材料留在私有仓库时，显式指定独立审查根：

```bash
reai-app-i18n validate|build|pack <plugin-root> … --source-review <审查根内的 evidence.json> --review-root <审查根>
reai-app-i18n submission check|pack <plugin-root> … --source-review <evidence.json> --review-root <审查根>
```

- `--review-root` 必须与 `--source-review` 同时出现。审查根必须是已存在的目录、路径中不含软链（传 `realpath` 得到的物理路径）。证据文件、全部审查报告与下面的审查输入文件都必须位于审查根内，现有的路径逃逸、软链与普通文件规则全部按审查根执行。
- 审查根只用于本次调用，不写入证据文件，也不出现在收据与命令输出中；审查根模式下的文件读取失败只报告固定消息，不回显路径。
- 只接受 `schemaVersion: 2` 证据，它在 v1 字段之外必须带 `binding`（不允许多余键）：

| 字段 | 绑定内容与核验 |
|---|---|
| `sourceRepository` | 插件仓库名 `owner/name`。本地只校验格式（本地 Git remote 不是证据），由审查报告批准，真实性由受控发布入口对照自身仓库核验 |
| `sourceCommit` | 精确提交。插件目录所在仓库的 HEAD 必须相等、插件目录无未提交或未跟踪改动，且每个源码输入文件（含被忽略但仍被收集的文件）都必须是该提交中的同一文件（按 Git 对象 ID 比较） |
| `reviewInputs` `{ path, sha256 }` | 完整审查输入：公开 CI 为该提交计算的待审字节 `calculation.json`，复制到审查根内。摘要相等，且其身份、源码输入摘要、包摘要、`toolchain.gitHead` 与工具链摘要都必须与证据和实际源码一致；工具链必须是回执模式 |
| `toolchainReceiptSha256` | 平台工具链回执摘要，必须等于该计算结果记录的回执摘要 |
| `expectedPackageSha256` | 最终包摘要（沿用 v1 字段），也必须等于计算结果的 `archiveSha256` |

审查报告的 `SOURCE_REVIEW_SCOPE=` 行除 v1 键外，还必须包含 `sourceRepository`、`sourceCommit`、`reviewInputsSha256`、`toolchainReceiptSha256` 并逐项相等。v1 证据配审查根、v2 证据不配审查根，一律拒绝。

#### 受控插件的两条打包路径

需要逐版本源码审查才能打包的插件（「受控插件」）分两条路，避免「先打包还是先审查」的循环：

1. **公开 CI**：只计算待审字节（两次结果一致），并用 `runPendingApprovalGate(<plugin-root>)`（`@reai/app-i18n-cli/controlled-release`）以插件已安装的 CLI 依次运行 validate / build / pack。只有「退出码 1、无标准输出、恰好出现预期的审批拒绝、没有其他任何错误、pack 未产出文件」才算通过；validate 遇到 Manifest 问题会停在第一层，所以三步必须都跑。不需要审查的插件调用它会直接失败，应走普通打包。
2. **私有审查**：在审查根内对该提交与待审字节完成审查，写 v2 证据 → 带 `--review-root` 正常打包，包摘要必须等于公开待审字节 → `createControlledReleaseRequest(...)` 生成只含摘要与公开标识的发布请求（无路径、无身份字段、无审查材料）→ 插件仓受控发布入口用 `verifyControlledReleaseRequest(request, { repository, commit, packageBytes, reviewInputsBytes, authorizedRequestSha256 })` 核验。请求字段都能由公开材料算出，字段自洽不等于经过私有审查，所以核验强制要求从发布入口自己的受信通道取得整份请求的摘要 `authorizedRequestSha256`（`controlledReleaseRequestDigest(request)`，一次绑定仓库、提交、包、审查输入、回执与证据摘要），不相等即拒绝；受信通道由发布入口负责。审查根模式下命令输出与报错中的审查根路径一律显示为 `<review-root>`。

这些函数都只做一致性判定，不产生审批、运行时授权或平台审核；包安装仍由 Host 按审核回执与包摘要授权。`bun scripts/verify-controlled-review-drill.ts --bundle <platform-release 输出>`（`make platform-controlled-review-e2e`）用合成的非生产插件在两个全新仓库里完整演练这条链路。
