# ReAI App Platform v1.1：网络、数据共享与计费规范

> 状态：已锁定的产品基线，实现目标<br>
> 版本：v1.1<br>
> 日期：2026-08-12<br>
> 适用范围：ReAI Host、官方 App、第三方 App、审核后台与各发行渠道<br>
> 开发入口：[App 开发指南：从 0 做一个 To-Do List](./app-development-guide-v1.md)<br>
> 关联文档：[发行渠道规范](./distribution-policy-v1.md) · [运行依赖规范](./runtime-dependencies-v1.md) · [交互式版本](./network-billing-policy-v1.html)

> ⚠️ **这是规范，不是完整实现清单。** 当前 Host 已实现 Web Surface 的 Network Broker 子集，
> 发行档位仍是 `official-only`，公开 Marketplace、凭据、计费和复合 Runtime 尚未完成。
> 每一处有意的偏差、以及开放第三方前必须补齐的安全清单，见 [README.md](./README.md)。
> 机器可读事实源：`platform/contract/host-support-matrix.json`（能力与限额）、`platform/contract/schemas/app-manifest-1.1.schema.json`（结构）。

> 🔄 **2026-08-14 云用量归因更新**：插件调用外脑云能力的归因模型已重新拍板，本文涉及云端消耗
> 归因的旧表述一律以
> 插件 OAuth 父子架构方案（Board 仓库内部材料，未公开）
> 为准（规则本身不在此复述，以免产生第二事实源）；Billing Broker（App 内购买 / 权益）条款不受影响。


## 1. 结论

本规范锁定三条基础规则：

1. **网络默认拒绝。** App 只能访问 Manifest 中声明、审核通过且当前用户已同意的目标；远端返回值始终是数据，不能成为新增可执行代码。
2. **支付默认由 Host 托管。** App 通过 Billing Broker 购买、查询权益和计量用量；自行支付属于高权限例外，必须单独授权。
3. **跨 App 数据默认隔离。** 每个 App 默认只访问以 App ID 隔离的私有 Store；跨 App 共享必须经过双边声明、Publisher 身份校验、用户同意与 Host Data Broker，不能借网络或共享文件绕过。

这三条规则都可以归因到具体 Runtime Component，并由运行时执行，不只是上架文案。Manifest、审核结果、用户授权与 Host 实际行为必须一致。

## 2. 规范用语与边界

本文中的：

- **必须**：不满足即拒绝发布、安装、启用或执行。
- **应当**：默认必须遵循；偏离时需要书面理由和审核记录。
- **可以**：可选能力，不影响 v1.1 合规性。
- **Host**：ReAI 桌面宿主及其可信后端。
- **App**：运行在 Host 中的官方或第三方功能单元。
- **Publisher**：App 的发布者。
- **Runtime Component**：App 内可独立启动、授权、降级和审计的运行单元，例如 UI、Wasm 后端、Remote Adapter 或受限 Native Companion。
- **Composite Runtime**：由两个或更多 Runtime Component 组成的 App。
- **Private Store**：由 Host 按 App ID 隔离的数据空间，其他 App 默认不可见。
- **Data Contract**：以命名 Store、Schema 和允许操作定义的跨 App 数据共享合同。
- **Billing Broker**：由 Host 提供的统一计费接口。
- **Entitlement**：由 Host 判定的试用、订阅、永久授权或用量权益。

本规范管理 Runtime Component 发起的外网请求、跨 App 数据共享和 App 数字能力收费。系统更新、固件更新、硬件实物交易及 ReAI 自身账号基础设施可复用相同安全原则，但不属于插件计费接口本身。

## 3. 交付层级：Core、Direct 与 Marketplace

本规范必须区分合同、发行方式和运营市场，不能把未来条款写成当前已实现能力：

| 层级 | v1.1 定义 | 当前含义 |
|---|---|---|
| **Platform Core v1.1** | Component 身份与能力归因、Network/Credential/Data/Billing Broker 合同、私有 Store、授权、错误与审计语义 | **已锁定的实现目标**；不代表当前代码已经完成全部 Broker。 |
| **Direct Distribution** | `channel=direct` 下，由 ReAI 签名并直接发行的 App、官方 `local_cli` 例外、ReAI Billing 与按渠道授权的更新策略 | 只能在对应 Core 门禁完成后启用相关能力；不是公开第三方市场。 |
| **Marketplace** | 未来的 Publisher 入驻、公开提交、自动/人工审核、Catalog、销售、退款、处罚与撤销运营 | **后续阶段**。本文的 Marketplace “必须”项是未来准入条件，不是对现有市场功能的声明。 |

因此，Platform Core 可以先实现并服务官方 App；Direct Distribution 可以在 Core 合规后开放签名直发；Marketplace 必须在身份、审核、计费和撤销链路实际可用后才对外宣称上线。

## 4. Runtime Component 归因与独立降级

### 4.1 身份上下文

Host 对每次网络、数据和计费调用都必须绑定：

```text
appId + componentId + publisherId + packageDigest + componentKind
```

- `componentId` 必须来自 Release Envelope 绑定的 Source Manifest，App 运行时不得临时伪造。
- 能力令牌必须限制到具体 Component；一个 Component 不得借用另一个 Component 的网络、数据或计费权限。
- 多个 Component 即使暂时运行在同一进程，也必须保持逻辑身份、能力句柄与审计归因分离。
- 新增 Component、改变 `componentKind`，或把能力迁移到权限更宽的 Component，均视为权限扩大。

### 4.2 Composite Runtime

Manifest 必须为每个 Component 声明 `required`、依赖关系和运行方式；贡献功能通过 `componentId` 指回对应 Component，失败范围由 `required`、依赖和 Contribution 图共同决定：

```json
{
  "runtime": {
    "components": [
      {
        "id": "main-ui",
        "kind": "web-surface",
        "protocol": "web-surface@1",
        "required": true,
        "headless": false,
        "activation": "on-demand",
        "entry": "dist/app.js",
        "lifecycle": { "activate": "default.activate", "deactivate": "default.deactivate" }
      },
      {
        "id": "cloud-sync",
        "kind": "wasm-component",
        "protocol": "wasm-component@1",
        "required": false,
        "headless": true,
        "activation": "app-enabled",
        "entry": "runtime/cloud-sync.wasm",
        "lifecycle": { "activate": "exports.activate", "deactivate": "exports.deactivate" },
        "backgroundPolicy": {
          "triggers": ["app-enabled@1"],
          "stop": ["app-disabled@1", "host-exit@1"],
          "resourceClass": "background-standard@1",
          "restartLimit": 3
        }
      }
    ]
  }
}
```

- 可选 Component 失败时，只降级它贡献的功能和明确依赖项；Host 聚合 `health=degraded`，其他 Component 可以继续运行。
- 必需 Component 失败时，Host 聚合 `health=unhealthy`，并按原因更新 `dependencies` 或 `permissions`；不得拖垮 Host 或其他 App。
- Host 必须同时展示 App 总体状态和 Component 级状态，不能用一个“插件坏了”掩盖可继续使用的部分。
- `local_cli` 仍只属于 `direct` 的官方 Adapter 例外，并且必须作为独立 Component 披露其外部网络边界。

## 5. 网络信任模型

### 5.1 四层门禁

一次网络请求只有同时通过以下四层才允许发出：

1. **Manifest 声明**：目标、用途、数据与鉴权方式完整。
2. **审核批准**：声明与提交源码、构建产物、隐私说明一致。
3. **用户同意**：当前安装实例已同意对应网络能力。
4. **运行时校验**：实际 URL、重定向、方法、凭据与数据范围仍符合声明。

任意一层不满足，Host 必须拒绝请求并返回稳定错误码，不得静默降级为 App 自行联网。

### 5.2 默认规则

- 未声明网络能力等价于 `deny_all`。
- 未声明域名、端口、协议或重定向目标必须阻止。
- 正式环境只允许 `https` 与 `wss`。本机回环地址必须作为独立能力声明，且不能使用外网凭据。
- `*`、任意 IP 段和不受控通配符不得进入正式目录；开发模式可在显著提示下临时授权。
- App 不得绕过 Host 网络代理直接创建 socket、启动 `curl`、Shell 或其他进程联网。
- Component 声明为可选的网络依赖失败时，只能使该 Component 或其贡献功能进入 `degraded`，不得导致整个 App 或 Host 无法启动。

### 5.3 外部 CLI 的例外边界

普通 App、Wasm Component 与 Host 自身网络请求必须经过 Host Network Broker。Native Companion 只有在操作系统沙箱能够提供等价出站限制时才可开放；否则不得作为普通第三方运行时。

Claude、Codex、Kimi 等 `local_cli` 是用户电脑上的独立外部应用。Host 可以控制是否启动、传入什么数据，却不能可靠代理或审计它们启动后的全部网络请求。因此 v1.1 采用以下边界：

- 只允许官方 Agent Adapter 在 `direct` Profile 调用已声明的 `local_cli`；两个 Store Profile 不开放该能力。
- 调用前必须明确说明“网络与数据处理由外部应用负责”，并展示工具发布者、已知服务商/域名、数据类型、凭据归属与隐私政策；无法确认的项目必须标为“由外部应用决定”。
- 相关审计只能记录 Host 发起调用和交付的数据范围，不得宣称已完成运行时域名白名单或完整出站审计。
- 普通第三方 App 不得通过启动 CLI、Shell、`curl` 或浏览器来绕过 Network Broker。

这是一项明确、收窄的产品例外，不是给插件增加第二条网络通道。需要 Host 完整代发、密钥托管与域名约束的场景，应使用 `remote_api` Adapter。

## 6. Network Manifest

### 6.1 最小结构

```json
{
  "network": {
    "policyVersion": 1,
    "endpoints": [
      {
        "id": "model-api",
        "componentId": "cloud-sync",
        "origins": ["https://api.example.com"],
        "owner": "publisher",
        "purpose": ["inference"],
        "dataCategories": ["user_prompt", "model_response"],
        "retention": {
          "mode": "provider_policy",
          "maxDays": 30,
          "policyUrl": "https://example.com/privacy"
        },
        "required": false,
        "providerMode": "user_configurable",
        "userConfiguredOrigins": {
          "allowed": true,
          "maxOrigins": 3
        },
        "auth": {
          "mode": "host_credential",
          "credentialSlot": "model-api-key"
        }
      }
    ]
  }
}
```

### 6.2 字段定义

| 字段 | 必须 | 规则 |
|---|---:|---|
| `policyVersion` | 是 | v1 固定为 `1`。未知主版本必须拒绝。 |
| `id` | 是 | App 内稳定、唯一、不可复用的端点标识。 |
| `componentId` | 是 | 发起请求的 Runtime Component；必须引用 `runtime.components[].id`。 |
| `origins` | 是 | 精确 origin 列表；协议、域名和非默认端口均参与匹配。 |
| `owner` | 是 | `reai`、`publisher`、`third_party`、`user_configured`。 |
| `purpose` | 是 | 一项或多项受控用途，见下表。 |
| `dataCategories` | 是 | 实际可能离开设备的数据类别；无用户数据时也要声明 `none`。 |
| `retention` | 是 | 远端是否保存数据、最长时间及隐私政策链接。 |
| `required` | 是 | 缺少该端点时，该 Component 的声明功能是否不可运行。 |
| `providerMode` | 是 | `host_brokered`、`user_configurable`、`vendor_only`。 |
| `userConfiguredOrigins` | 条件 | 仅 `providerMode=user_configurable` 可用；声明是否允许用户在 Host 设置中添加精确 origin 及数量上限。 |
| `auth` | 是 | 鉴权模式及 Host 凭据槽；不得包含秘密值。 |

`origins` 始终是 Publisher 随 Source Manifest 提交并审核的默认列表。若允许用户切换到自己的 OpenAI-compatible 或其他服务，新增地址必须由用户在 Host 设置中主动输入或选择；Host 只为该用户保存逐个精确 origin 的本地授权。App 和远端响应不能代填、扩宽或静默更换地址。每次新增或更换地址都要重新显示服务商、数据类别和费用承担方，并由用户确认；这不是 `*` 通配权限，也不会改写 Release Envelope 绑定的 Source Manifest。

`purpose` v1 允许：

- `inference`：模型推理。
- `authentication`：登录、令牌交换。
- `storage`：远端持久化。
- `sync`：跨设备或账号同步。
- `assets`：不可执行资源下载。
- `telemetry`：诊断、崩溃或使用分析。
- `billing`：由 Host 托管的计费服务。
- `support`：用户主动发起的客服或问题报告。

`dataCategories` v1 至少区分：

- `none`
- `account_identifier`
- `device_identifier`
- `user_prompt`
- `model_response`
- `conversation`
- `file_content`
- `file_metadata`
- `audio_transcript`
- `diagnostics`
- `usage_metrics`
- `payment_reference`

原始支付卡数据、系统凭据、原始麦克风音频不属于普通 App 可申报类别；需要新的协议版本和专项审核。

### 6.3 留存声明

`retention.mode` 必须为以下之一：

- `none`：完成请求后不在远端持久化。
- `session`：仅在当前会话生命周期内保存。
- `fixed`：声明明确的 `maxDays`。
- `provider_policy`：由服务商政策决定，同时必须给出 `maxDays` 上限与 `policyUrl`。

“未知”“无限期但不说明原因”或只有隐私政策链接而没有结构化上限，均不得通过自动校验。

### 6.4 鉴权与密钥

普通 App 只允许以下鉴权模式：

- `none`：公开端点。
- `host_session`：Host 代表当前 ReAI 会话鉴权。
- `host_credential`：用户或组织凭据由 Host 安全存储并代发请求。
- `vendor_oauth`：Host 承载 OAuth 回调与令牌保管，Publisher 获得受限会话。

强制要求：

- API Key、Refresh Token、支付凭据不得写入 Manifest、App 数据目录、日志、URL 查询串或普通 IPC。
- Host 使用系统凭据库保存秘密；App 只接收不透明的 `credentialRef` 或请求结果。
- 日志必须删除 Authorization、Cookie、Token、请求正文中的秘密字段。
- 撤销 App 或 Component 网络权限时，其对应凭据引用和短期令牌必须同时失效。

## 7. 网络变更与重新同意

以下任一变更都属于**权限扩大**：

- 新增 origin、协议、端口或更宽的通配范围。
- `owner` 从 ReAI/用户配置改为 Publisher/第三方。
- 新增 `purpose` 或 `dataCategories`。
- 延长留存时间，或从不保存改为保存。
- `required` 从 `false` 改为 `true`。
- 从 `user_configurable` 改为 `vendor_only`。
- 新增鉴权令牌或用户身份传递。
- 新增 Component、扩大 Component 能力，或把 endpoint 迁移到权限更宽的 Component。

权限扩大必须：

1. 形成新的 App 版本。
2. 重新进入安全与产品审核。
3. 在更新前展示差异。
4. 取得用户重新同意后才启用新增能力。

用户拒绝时，旧版本或不依赖新增权限的部分应当继续可用；若无法继续，Host 必须把 `permissions` 维度记为 `denied`，并推导“需要授权”的界面摘要，不得无限重试或诱导授权。

删除端点、缩短留存、减少数据类别属于权限收窄，可以随审核通过的更新生效，但必须保留审计记录。

## 8. 远端内容与可执行边界

远端响应始终是不可信数据。App 与 Host 均不得：

- `eval`、动态导入或解释执行远端脚本。
- 下载并加载新的 Wasm、原生二进制、Node/Python 包、AppleScript 或 Shell 脚本。
- 把远端配置变成未随审核包提交的业务逻辑。
- 通过“配置”“提示词”“工作流”规避已声明的命令、权限或计费门禁。
- 执行模型生成的任意 Shell、文件或设备操作，而不经过 Host 已注册命令与对应授权。

允许的远端内容包括：普通 API 数据、不可执行资源、已审核分支的开关值、模型输出，以及由 Host 能力系统再次校验的结构化动作建议。

远端配置只能在**已打包、已审核的有限选项之间选择**，不能扩展 App 的权限、域名、命令集合或原生能力。

## 9. 跨 App 数据共享

### 9.1 默认私有，禁止旁路

每个 App 默认只有以 `appId` 隔离的 Private Store。其他 App、Component、CLI 和远端服务不得直接看到其文件、数据库或内部路径。

以下方式不属于合法共享，必须阻止：

- 打开另一个 App 的 SQLite、目录、数据库文件或应用数据路径。
- 通过共享临时文件、全局目录、剪贴板或本机回环服务持续交换内部数据。
- 把数据上传到云端，再由另一个 App 下载，以此绕过 Host Data Broker。
- 借 Shell、`local_cli`、浏览器、深链或 Native Companion 绕过共享授权。
- 导出整库、裸文件路径或目录句柄，代替稳定的数据合同。

网络权限只允许把数据发送到已声明远端，**不会自动授予另一个 App 读取权**；跨 App 数据权必须单独通过 Data Contract。

### 9.2 双边声明

一次共享必须同时具备：

1. **Importer Request**：导入方声明需要哪个 Owner App 的哪个 Export、Schema、操作、目的和 Component。
2. **Owner Export Allow**：数据所有方声明允许导出哪个命名 Store、哪个 Schema、哪些操作，以及允许的 Consumer 范围。

所有数据声明统一位于 Manifest 顶层 `data`。`data.privateStores[]`、`data.exports[]` 与 `data.imports[]` 可以并存，不得另设共享顶层。

Owner Manifest：

```json
{
  "data": {
    "privateStores": [
      { "id": "tasks", "schemaVersion": 1 }
    ],
    "exports": [
      {
        "id": "task-summary",
        "store": "tasks",
        "schema": "com.example.tasks.summary@1",
        "operations": ["query"],
        "consumers": [
          {
            "appId": "com.example.dashboard",
            "publisherId": "com.example.publisher"
          }
        ]
      }
    ],
    "imports": []
  }
}
```

Importer Manifest：

```json
{
  "data": {
    "privateStores": [],
    "exports": [],
    "imports": [
      {
        "id": "tasks-summary",
        "componentId": "dashboard-ui",
        "ownerAppId": "com.example.tasks",
        "ownerPublisherId": "com.example.publisher",
        "exportId": "task-summary",
        "schema": "com.example.tasks.summary@1",
        "operations": ["query"],
        "required": false,
        "purpose": "在总览页显示待办数量"
      }
    ]
  }
}
```

Host 只有在 Owner 与 Importer 的签名 `publisherId` 相同、Importer 的签名 `appId/publisherId` 命中 Owner 的 `consumers[]`，并且双方 `ownerAppId/ownerPublisherId/exportId/schema/operations` 精确匹配时，才可以建立 Share Grant。v1.1 不开放跨 Publisher 的直接 Store 共享；这类协作必须等待新的协议与单独审核。`imports[].id` 是 Importer 内稳定合同 ID；任一方未声明、身份或版本不兼容、操作范围不一致，都必须拒绝。

### 9.3 身份、同意与审计

Host 建立或恢复 Share Grant 前必须：

- 校验 Owner 与 Importer 安装包签名、`publisherId` 和 `packageDigest`；Publisher 身份变化不得沿用旧授权。
- 向用户展示数据 Owner、Importer、发起 Component、命名 Store、Schema 摘要、允许操作、用途和数据方向。
- 获得用户可见的明确同意，并允许用户随时在 Host 设置中撤销。
- 通过 Host Data Broker 发放不可转移、范围受限的 Handle；App 不获得底层路径或数据库连接。
- 记录授权、拒绝、查询/写入结果、Schema 版本、撤销和错误；审计不记录完整数据正文。

Importer 不得把收到的数据继续分享给第三个 App，除非新的 Owner Export、Importer Request 和用户同意明确允许该链路。

### 9.4 分享合同，不分享存储实现

跨 App 共享的对象是：

```text
named store + versioned schema + allowed operations
```

而不是：

```text
file path + raw SQLite + entire database + directory handle
```

Host 必须按 Schema 校验输入与输出，并允许 Owner 在兼容窗口内迁移实现而不暴露内部表结构。

### 9.5 不是对称读写

双边声明表示**双方都同意这条单向合同**，不表示双方获得对称权限：

- Owner 只允许 `query`，Importer 就只有读取指定 View 的权限，没有写权限。
- Importer 请求 `append`，只有 Owner 同时允许 `append` 且用户同意后才可写入。
- `query`、`append`、`update`、`delete` 和 `subscribe` 必须分别声明；授权其中一项不会隐含其他项。
- Owner 可以只提供聚合 View 或字段子集，不必暴露原始记录。
- 导入 Component 失败或授权撤销时，只降级依赖该 Import 的功能；`required: false` 不得阻止整个 App 启动。

## 10. AI 服务政策

### 10.1 标准、可替换接口

如果 App 使用公开、可替换的模型协议，例如 OpenAI-compatible API，则必须提供：

- 可配置的 `endpoint`。
- 可配置的 `model`。
- 由 Host 管理的 API Key / OAuth 凭据。
- 连接测试、失败原因及恢复入口。
- 当前服务商、费用承担方和数据去向的明确显示。

Publisher 可以提供推荐默认值，但不得把自有代理伪装成用户选择的模型服务。

### 10.2 专有云服务

只有功能确实依赖 Publisher 的专有后端时，才允许 `providerMode: vendor_only`。安装与购买前必须明示：

- 功能依赖插件方云服务。
- 服务运营方和域名。
- 传输的数据与留存期限。
- 无网络、服务停止或账号被停用时哪些能力失效。
- 费用是否包含在插件价格中，是否另有用量费。

`vendor_only` 不是规避用户选择的默认理由；审核方可以要求说明其不可替换性。

## 11. Billing Broker

### 11.1 统一接口

App 只能调用 Host 提供的三类接口：

```text
billing.purchase(sku, offer?, idempotencyKey)
billing.getEntitlement(sku)
billing.consume(sku, quantity, idempotencyKey)
```

- `purchase`：必须由明确的用户操作触发；Host 展示商品、价格、渠道和确认界面。
- `getEntitlement`：返回 Host 判定的权益状态；App 不得自行声明已购买。
- `consume`：对已授权的计量商品扣减用量；必须幂等，失败时不得扣减。

所有调用都隐式绑定 `appId`、`componentId`、`publisherId`、`packageDigest`、当前安装、当前用户与发行渠道，App 不得覆盖这些身份。

Billing 能力必须按 Component 声明：

```json
{
  "billing": {
    "mode": "host_managed",
    "products": ["pro.monthly", "credits.1000"],
    "components": [
      {
        "componentId": "main-ui",
        "capabilities": ["purchase", "getEntitlement"]
      },
      {
        "componentId": "usage-worker",
        "capabilities": ["getEntitlement", "consume"]
      }
    ]
  }
}
```

- `purchase` 只允许由能承载 Host 确认界面的 Component 在明确用户操作后调用。
- 后台 Component 可以在已授权范围内调用 `getEntitlement` 或幂等 `consume`，但不能自行弹出购买或扩大 SKU。
- 某个计费 Component 失败时，只降级依赖它的购买或用量功能；已确认的免费功能和其他 Component 应继续可用。

### 11.2 权益状态

v1.1 标准状态：

- `unknown`：尚未取得可信结果。
- `not_entitled`：未购买或无可用权益。
- `trial`：试用中。
- `active`：有效。
- `grace`：渠道暂时不可达，使用已签名缓存进入有限宽限。
- `expired`：已到期。
- `revoked`：退款、拒付、违规或管理员撤销。
- `pending`：购买或恢复购买尚未最终确认。

只有 `trial`、`active` 与 Host 明确批准的 `grace` 可以解锁对应能力。离线缓存不能把 `unknown` 自动提升为有效权益。

### 11.3 计费模式

Manifest 必须声明：

```json
{
  "billing": {
    "mode": "host_managed",
    "products": ["pro.monthly", "credits.1000"],
    "components": [],
    "externalAuthorizationId": null
  }
}
```

允许的模式：

- `none`：App 不收费。
- `host_managed`：默认且推荐；购买、恢复、退款映射与权益均由 Host 管理。
- `external_authorized`：高权限例外；必须绑定有效的书面授权 ID。

以下行为必须阻止：

- App 自己采集银行卡或支付账户数据。
- App 服务端自行返回“已付费”并绕过 Host 权益。
- 远端下发未登记 SKU、价格或购买链接。
- 在未获授权时打开外部支付页面、二维码或深链。
- 将必要功能拆成未披露的站外收费。

### 11.4 `payment.external` 例外

外部支付不是普通权限。批准前必须同时确认：

- 当前发行渠道允许该方式。
- Publisher 身份、支付主体、退款和客服责任清晰。
- 交易明确获得用户确认并满足适用支付安全要求。
- Host 仍能获得可验证、可撤销的权益结果。
- App 更新不会扩大已授权的商品或支付范围。
- ReAI 可在违规或渠道政策变化时远程撤销该权限。
- 授权必须限制到具体 App、Component、商品范围、渠道与有效期，其他 Component 不得复用。

缺少有效授权时必须返回 `BILLING_EXTERNAL_NOT_AUTHORIZED`，不得只显示警告后继续。

## 12. 按发行渠道适配

App 只认识 Billing Broker，不认识 StoreKit、Microsoft Commerce 或 ReAI 支付 SDK。Host 根据发行渠道选择适配器：

| 发行渠道 | 默认支付适配器 | v1.1 规则 |
|---|---|---|
| Mac App Store | Apple StoreKit / In-App Purchase | 数字功能解锁默认使用 Apple 允许的方式；例外须按地区、品类和最新审核规则核实。 |
| Microsoft Store | Microsoft Commerce 或合规的 ReAI 安全支付 | Windows 非游戏 PC 产品可按 Microsoft 规则选择安全第三方支付，但仍统一经过 Host。 |
| 官网版 | ReAI Billing | 默认使用 ReAI 自有结算与权益；外部支付仍需专项授权。 |

同一 SKU 在不同渠道可以映射到不同底层商品 ID，但权益语义必须一致。插件不得根据渠道偷偷改变核心功能、价格含义或数据使用方式。

应用商店规则会变化。每次正式发布前，发行负责人必须复核当时有效的官方规则；本表不是对平台审核结果的保证。

## 13. 用户自有 API Key 与插件收费

两类费用必须分开：

1. **第三方算力费用**：用户把自己的 API Key 配置到 Host，模型服务商直接向用户计费。这不自动构成插件绕过 ReAI 支付。
2. **插件商品费用**：插件订阅、功能解锁、云服务、额度包或增值服务。必须由 Billing Broker 管理，除非获得 `payment.external` 授权。

App 必须在购买前分别展示“插件费用”和“可能产生的第三方 API 费用”。不得把用户自有 API Key 当成已经购买插件权益，也不得在不必要时上传该 Key 给 Publisher。

## 14. 审计、撤销与隐私

Host 必须记录以下安全事件：

- App 版本、Manifest 摘要、授权版本、`componentId` 与 `packageDigest`。
- 网络请求的 App、Component、endpoint ID、目标 origin、用途、结果码和时间。
- Data Contract 的双方身份、Export/Import、Schema、操作、用户同意、调用结果与撤销。
- 网络请求被阻止的原因。
- 权限授予、拒绝、重新同意和撤销。
- 购买、恢复、退款映射、权益变化和用量扣减结果及其发起 Component。
- `payment.external` 授权的签发、范围和撤销。

审计日志不得记录请求正文、API Key、支付卡数据或完整令牌。日志需要明确保留期限，并支持按安装或 App 撤销访问。

用户撤销网络权限后：

- 新请求立即阻止。
- 进行中的可取消请求应当取消。
- App 专属短期令牌失效。
- Host 把 `permissions` 记为 `denied`；若 App 仍有可用部分，再把 `health` 聚合为 `degraded`。只有等待用户首次决定或重新同意时才使用 `pending`；不得崩溃 Host。

用户撤销 Share Grant 后，Host 必须立即拒绝新的 Data Broker 调用并销毁 Handle。Importer 已合法复制的数据按合同声明的副本与删除策略处理；撤销不会授权 Importer 继续同步，也不会允许 Host 静默恢复共享。

发生退款、拒付或安全撤销后，Host 更新权益并通知 App。App 应保存用户生成数据，除非用户主动删除；不得用删除用户数据作为失去权益的惩罚。

## 15. 失败语义

所有错误必须包含稳定 `code`、用户说明、开发者详情、是否可重试、`appId`、`componentId` 和 `traceId`。

> ⚠️ 下表是**目标命名**。当前 Host 实际返回的稳定错误码以支持矩阵 `stableErrors` 为准
> （见 [插件接口参考](./plugin-api-reference-v1.md)），对应关系：
> `NETWORK_UNDECLARED_DESTINATION` → `NETWORK_ENDPOINT_NOT_DECLARED`、
> `NETWORK_CONSENT_REQUIRED` → `NETWORK_PERMISSION_REQUIRED`、
> `NETWORK_REDIRECT_BLOCKED` → `NETWORK_REDIRECT_DENIED`、
> `NETWORK_UNAVAILABLE` → `NETWORK_UPSTREAM_FAILED` / `NETWORK_TIMEOUT`；
> 其余行（AUTH_MISSING / REMOTE_CODE / DATA_*）尚无实现对应。写 catch 分支用实现码。

v1.1 至少支持：

| 错误码 | 含义 | 默认行为 |
|---|---|---|
| `NETWORK_UNDECLARED_DESTINATION` | 目标未声明 | 阻止；不可自动重试。 |
| `NETWORK_CONSENT_REQUIRED` | 尚未同意或权限已扩大 | 进入 Host 授权流程。 |
| `NETWORK_AUTH_MISSING` | 缺少 Host 凭据 | 显示配置入口。 |
| `NETWORK_REDIRECT_BLOCKED` | 重定向离开允许范围 | 阻止并记录。 |
| `NETWORK_REMOTE_CODE_BLOCKED` | 远端内容被当作代码 | 隔离当前版本并上报审核。 |
| `NETWORK_UNAVAILABLE` | 暂时不可达 | 按指数退避；可进入降级态。 |
| `DATA_IMPORT_UNDECLARED` | Importer 未声明请求 | 阻止，不打开数据。 |
| `DATA_EXPORT_NOT_ALLOWED` | Owner 未允许该 Export/操作 | 阻止并记录双方身份。 |
| `DATA_SCHEMA_MISMATCH` | 双方 Schema 不一致或数据校验失败 | 拒绝该调用；可降级相关功能。 |
| `DATA_PUBLISHER_IDENTITY_INVALID` | Publisher 签名身份不可信或已变化 | 撤销旧 Grant，要求重新审核。 |
| `DATA_CONSENT_REQUIRED` | 用户尚未同意双边共享 | 进入 Host 授权流程。 |
| `DATA_BROKER_REVOKED` | Share Grant 已撤销 | 销毁 Handle，停止后续同步。 |
| `BILLING_USER_CANCELLED` | 用户取消购买 | 不是系统错误，不自动重试。 |
| `BILLING_NOT_ENTITLED` | 当前无有效权益 | 保留可用的免费能力和数据。 |
| `BILLING_PENDING` | 渠道尚未最终确认 | 显示处理中，不重复下单。 |
| `BILLING_CHANNEL_UNAVAILABLE` | 支付渠道不可用 | 不解锁；允许稍后恢复购买。 |
| `BILLING_EXTERNAL_NOT_AUTHORIZED` | 外部支付未获授权 | 阻止并记录。 |
| `BILLING_CONSUME_REJECTED` | 用量不足或扣减失败 | 不执行对应付费动作。 |
| `ENTITLEMENT_REVOKED` | 权益被撤销 | 结束付费能力，保留用户数据。 |

## 16. 当前实现差距与阶段边界

截至 2026-08-12，当前仓库已经形成一个可执行但有意收窄的 Web Surface 网络子集：

- 已解析结构化 Network Manifest；正式来源和本地严格预览会执行用户授权、精确 HTTPS origin、
  路径、方法、header、逐跳重定向、DNS/私网、并发、速率、大小、超时和取消门禁。
- 直连会固定已检查的 DNS 地址；系统 HTTPS 代理使用校验时的代理快照，并仅对已经命中代理的
  域名兼容 198.18/15 Fake-IP DNS，其他私网或保留地址仍拒绝。
- 插件 WebView 的 CSP 不开放外网；SDK 把外部 `fetch` 转到 Host Broker，XHR、WebSocket、远端
  脚本、Shell 和 `curl` 不是插件旁路。开发者本人的 Host 终端与插件 Runtime 隔离。
- 本地开发包在开发者模式默认宽松，可以不先声明 endpoint，但仍经过 Broker、限额和审计；开发者
  可打开严格网络预览，在发布前按 Manifest 与用户授权链验收。
- 网络范围摘要独立绑定本地授权；扩大声明后旧授权失效。每次请求可归因到 App、当前唯一
  Web Surface Component、endpoint/purpose 和结果，开发者面板只接收脱敏 URL（无 query/fragment）。
- 已实现按 App ID 隔离的 Private Store；网络 Broker Cookie 只按 App 保存于进程内存。

完整 Platform Core 与发布链仍有这些差距：

- 尚无源码上传、源码/产物一致性扫描、人工审核、Publisher 签名、Catalog 和远程撤销服务；客户端
  只负责严格执行已经随包交付的 Manifest。
- 当前 Runtime 仍只有一个 `web-surface` Component，没有复合 Runtime 的 Component 级能力令牌、
  独立资源预算、状态归因与降级编排。
- CLI/PTY 中运行的 Claude、Codex、Kimi 等工具可自行联网，当前无法由 Host 限制域名或完整审计数据；v1.1 将其收窄为官网版官方 Adapter，并要求按“外部应用负责网络”披露。
- 没有 Wasm 网络 Host API、Native Companion 的网络沙箱、双边 Data Contract、Publisher 签名校验
  和 Data Broker 审计链路。
- 现有系统凭据库可作为 Host 密钥保管基础，但尚未提供插件级 `credentialRef` 和代发请求接口。
- 没有 Billing Broker、数字商品 Catalog、权益服务、恢复购买、退款映射或用量账本。
- Landing 中已有硬件订单与支付流程，但它面向实物销售，不能直接视为桌面插件计费与权益系统。
- 缺少持久化安全审计查询、计费审计和由发行服务触发的远程撤销机制；本地权限拒绝、App 停用与
  卸载已经会主动终止该 App 的在途请求并清除内存 Cookie。

因此，在上述门禁实现前，不应向普通第三方 App 开放任意联网、任意 CLI 或自行支付能力。即使门禁完成，`local_cli` 也不等同于 Host 代理网络，不能沿用普通 App 的“全部出站已受控”表述。

本节同时标明 **Platform Core v1.1 已实现子集与尚待实现的差距**。`direct` 的签名直发能力必须逐项等待对应 Core 门禁；公开 Marketplace、第三方销售与市场运营仍是后续阶段，不属于当前已交付功能。

## 17. 验收清单

### 17.1 Component、Manifest 与审核

- [x] 正式来源无网络声明时，Web Surface 无法访问外网；本地开发宽松档位是显式例外。
- [x] 当前单 Web Surface 的网络调用能归因到 Host 确定、插件不可伪造的 `componentId`。
- [x] 每个 endpoint 都包含 componentId、owner、purpose、dataCategories、retention、required、providerMode、auth。
- [ ] Composite Runtime 的可选 Component 失败时，只降级相关贡献和依赖项。
- [x] 正式包拒绝明文 HTTP、未受控通配符和未声明重定向。
- [ ] 审核系统能对比源码行为、构建产物与 Manifest。
- [ ] 权限扩大已触发用户重新同意；自动重新审核等待发行服务。

### 17.2 运行时网络

- [x] 当前普通 Web Surface 的外部 HTTP(S) 请求经过 Host 网络代理并绑定 App 身份。
- [ ] Store 构建不包含 `local_cli`；direct 的官方 `local_cli` 调用明确展示外部应用网络边界。
- [x] 第三方 App 没有 CLI、Shell 或 `curl` Bridge，WebView CSP 不开放直接外网。
- [x] 未声明域名、路径越界和跨域重定向被真实阻止。
- [ ] API Key 只在系统凭据库中，日志与 IPC 不出现秘密。
- [x] Web Surface 不能从远端加载脚本；Broker 响应只作为数据返回。
- [x] 本地拒绝网络权限、停用或卸载后，进行中及后续请求停止，内存 Cookie 被清除。
- [ ] 网络失败只让相关 Component 或 App 聚合为 `health=degraded`，不影响 Host 启动。

### 17.3 跨 App 数据

- [x] 每个 App 默认只能访问按 App ID 隔离的 Private Store。
- [ ] Importer Request 与 Owner Export Allow 不精确匹配时，Host 拒绝共享。
- [ ] Host 校验双方签名 Publisher 身份，身份变化后旧 Grant 不再有效。
- [ ] 用户能看见 Owner、Importer、Component、Store、Schema、操作、目的与方向，并可撤销。
- [ ] App 只得到 Data Broker Handle，无法获得裸文件、全库或底层路径。
- [ ] `query` 不隐含写入；每种读写操作分别声明和授权。
- [ ] App 无法借网络、CLI、回环服务或共享目录绕过 Data Broker。
- [ ] 可选 Import 失败只降级相关功能，不阻止整个 App 启动。

### 17.4 AI 服务

- [ ] 标准 AI 接口支持 endpoint、model、credentialRef 配置。
- [ ] UI 明确显示当前服务商、数据去向和费用承担方。
- [ ] `vendor_only` 在安装与购买前显示云依赖和失效边界。
- [ ] 用户自有 API Key 不会被当作插件权益或发送给 Publisher。

### 17.5 计费

- [ ] App 只能通过 `purchase/getEntitlement/consume` 使用计费能力。
- [ ] 每次调用绑定被授权的 Component；后台 Component 不能主动发起购买 UI。
- [ ] 购买必须由用户发起，SKU 与价格由 Host Catalog 决定。
- [ ] `consume` 使用幂等键，失败不扣减、不执行付费动作。
- [ ] Host 能处理购买取消、pending、恢复购买、退款和撤销。
- [ ] `payment.external` 未授权时运行时强制阻止。
- [ ] 三个发行渠道均通过同一权益语义和各自合规适配器。

### 17.6 审计、恢复与阶段

- [ ] 网络、数据与计费事件可按 App、Component、版本和 traceId 审计。
- [ ] 日志不含请求正文、秘密和支付卡数据。
- [ ] 权限或权益撤销能及时生效并通知 App。
- [ ] 失去权益不会删除用户生成数据。
- [ ] 安全团队可以隔离违规版本并撤销高权限例外。
- [ ] 产品和 UI 明确标记 Platform Core、Direct Distribution、Marketplace 的实现状态，不把未来市场规则展示成已上线功能。

## 18. 行业依据

以下官方规则用于验证本规范不是孤立设计；ReAI 采用其中共同的“声明、限制、托管、例外审批”模式：

- [Figma Plugin Manifest](https://developers.figma.com/docs/plugins/manifest/)：插件声明允许访问的域名，运行时阻止未声明目标，并向用户展示域名。
- [Atlassian Forge Permissions](https://developer.atlassian.com/platform/forge/manifest-reference/permissions/) 与 [Remotes](https://developer.atlassian.com/platform/forge/manifest-reference/remotes/)：声明外部目标、数据用途、鉴权与可配置远端。
- [Chrome Web Store Manifest V3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)：远端资源可以是数据，但扩展逻辑应自包含，不得通过远端代码改变行为。
- [Shopify App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)：App 收费默认使用平台 Billing API；未经允许的站外计费不可上架。
- [JetBrains Marketplace Billing & Licensing](https://plugins.jetbrains.com/docs/marketplace/billing-and-licensing.html)：市场统一提供插件销售、订阅与授权能力。
- [Atlassian Marketplace pricing, payment, and billing](https://developer.atlassian.com/platform/marketplace/pricing-payment-and-billing/)：平台计费、厂商计费和免费模式均被明确分类，厂商计费是可管理的模式而非隐式行为。
- [Microsoft Store Policies 10.8](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)：Windows 非游戏 PC 产品可以使用 Microsoft 或合规的安全第三方支付，但必须满足披露、确认与安全要求。
- [Apple App Review Guidelines 3.1、4.7](https://developer.apple.com/app-store/review/guidelines/)：数字功能解锁、插件软件、数据授权与原生能力暴露均受渠道规则约束。

> 参考链接核对日期：2026-08-01。平台规则可能更新；正式发布时必须再次核对当前版本。
