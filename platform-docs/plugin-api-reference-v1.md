# Driver V2 插件接口参考 v1

> 文档状态：对应当前 `@reai/app-sdk/v1` 与 Driver V2 Host API `1.14.0`
>
> 最后核对：2026-08-26
>
> 上手流程：[Driver V2 插件开发规范 v1](./plugin-development-v1.md)

插件代码只应从 `@reai/app-sdk/v1` 导入。该入口也为 Host 和测试工具导出了底层协议类型，但普通
插件不要直接调用 `HostBridge` 或拼接 `RequestMethod`；SDK 是公开兼容层，Bridge 是内部传输层。

## 1. 公开入口

普通插件主要使用：

```ts
export {
  AppError,
  defineApp,
  normalizeBridgeError,
  runApp,
  // 稳定错误码常量（矩阵两张 stableErrors 表的 TS 镜像，写 catch 分支用它，
  // 不要手写字符串；一致性由 SDK 合同测试锁定）
  PLUGIN_BRIDGE_ERROR_CODES,
  APP_PLATFORM_ERROR_CODES,
  // 版本锚点（与 package.json version / 矩阵 hostApi 三方相等）
  SDK_VERSION,
  HOST_API_VERSION,
  // system.tasks@1（普通开放能力）的返回意图类型守卫
  isSystemTaskReturnIntent,
};

export type {
  AccountStatusResult,
  AppHttpClient,
  AppHttpFetchOptions,
  AppContext,
  AppDefinition,
  AppEvent,
  AppPlatformErrorCode,
  CommandHandler,
  CommandInvocation,
  KeyValueStore,
  HostTitlebarActionIntent,
  NotificationPostOptions,
  NotificationPostResult,
  PluginBridgeErrorCode,
  StableErrorCode,
  SurfaceHandle,
  SurfaceMountHandler,
  SystemTaskClient,
  SystemTaskOpenOptions,
  SystemTaskOpenResult,
  SystemTaskReturnIntent,
  SystemTaskTarget,
  SystemTaskVersionStatus,
  TabItemInfo,
  TabItemUpsert,
  WireError,
};
```

`runApp`、`HostBridge`、`HostMessage`、`RequestMethod`、`NotifyMethod` 和
`BRIDGE_GLOBAL_KEY` 主要供 Host bootstrap 与测试工具使用。普通插件入口使用 `defineApp()`。
处理 `system-task.return` 信封时用 `isSystemTaskReturnIntent(intent)` 收窄类型，
不要手工判别字段。

## 2. 生命周期

### `defineApp(definition)`

```ts
function defineApp(definition: AppDefinition): AppDefinition;

interface AppDefinition {
  activate(ctx: AppContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
```

- `activate()` 创建一次 Runtime 会话，Surface、Command 和事件处理器在这段窗口注册；
- `deactivate()` 是 SDK 合同中的资源释放 Hook；Mock Host 会调用它。当前生产 Host 尚未在所有
  停用、关闭与卸载路径发送 `deactivate`，所以插件仍必须把 Surface 资源释放放进 mount cleanup，
  并把该 Hook 视为补充保护，不能依赖它保证生产态清场；
- 安装不会执行 `activate()`；当前 Runtime 是 `on-demand`，启用也不代表立刻执行。

`ctx.runtimeSessionId` 是本轮 Runtime 的只读会话 ID，不是用户身份，也不能持久化复用。

## 3. 私有存储

### `ctx.storage.private(storeId)`

Manifest 前置：

```json
{
  "requires": { "hostCapabilities": ["storage.kv@1"] },
  "data": {
    "privateStores": [{ "id": "state", "schemaVersion": 1 }]
  }
}
```

接口：

```ts
interface KeyValueStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  /** Host API 1.20+: expected undefined means absent, null means stored null. */
  compareAndSet(key: string, expected: unknown, value: unknown): Promise<boolean>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
```

- Host 强制命名空间为 `appId/storeId`，插件不能访问其他插件的数据；
- 单值最大 256 KiB，每个插件总量最大 32 MiB；
- `compareAndSet` 在同一个 Host 锁内比较完整 JSON 值（对象键序无关）、检查配额并原子落盘。返回 false 表示旧值不匹配，调用方应重读；磁盘错误抛出且不改变内存。缺失使用 undefined，存储 null 必须显式传 null；新值不能为 undefined。
- 损坏的持久文件保留并拒绝读写，不以空 Store 覆盖；不得捕获读取失败后当成首次安装。
- Surface WebView 是非持久化的，业务持久化应使用 Host KV；
- 当前不支持 `data.imports`、`data.exports` 和 `data.migration`。

## 4. 账户状态与用户权限

### Manifest 权限声明

```ts
interface PermissionDeclaration {
  id: string;
  purpose: string;
  required: boolean;
}
```

当前开放三项权限：

```json
{
  "id": "account.status@1",
  "purpose": "向用户说明为什么需要读取登录状态",
  "required": false
}
```

```json
{
  "id": "os.notification.post@1",
  "purpose": "在任务完成或需要用户处理时发送系统通知",
  "required": false
}
```

```json
{
  "id": "http.fetch@1",
  "purpose": "把用户主动创建的任务同步到已申报服务",
  "required": false
}
```

权限主体是当前本地设备上的插件安装，不是云端 Team。决定按
`local-device + appId + permissionId + declarationDigest` 保存。`id`、`purpose` 或 `required`
变化后，旧决定失效并回到 `pending`；卸载插件会清除权限决定。

### `ctx.account.status()`

```ts
interface AccountStatusResult {
  enabled: boolean;
  loggedIn: boolean;
}

status(): Promise<AccountStatusResult>;
```

| 字段 | 含义 |
|---|---|
| `enabled` | 当前 Host 构建是否启用了 OAuth 账户功能 |
| `loggedIn` | 当前设备是否有可用登录会话 |

明确不会返回用户身份、邮箱、Team、Project、余额、token 或任何 OAuth 凭据。

这不是暂缺，而是刻意的边界（2026-08-13 把身份从该合同移除的真正原因）：**外壳不替插件转发
身份**。已定架构下每个插件是独立的外脑 OAuth App，身份属于插件自己的权限范围，应当经外壳通道用
插件自己的令牌去取，而不是从外壳合同里读。Host 现已对 Catalog/public 与 LocalDeveloper/development 分开代签、
保管和运行校验；开发调用每次实时重验当前账号、draft revision 与 scope 资格，且不向插件暴露 token。方案与理由见
插件 OAuth 父子架构方案（Board 仓库内部材料，未公开）。

### `ctx.notifications.post(options)`

```ts
interface NotificationPostOptions {
  title: string;
  body: string;
}

post(options: NotificationPostOptions): Promise<{ queued: true }>;
```

首版只接受纯文本 `title/body`，两项去除首尾空白后都不能为空；插件提交的标题最多 80 个字符，
正文最多 500 个字符。不支持图标、声音、附件、调度、动作按钮、URL、读取或取消通知。
Host 会在标题前强制加上注册表中的插件名与 appId 指纹，插件不能移除这段来源标签。Manifest
显示名本身不是可信发布者身份，不能只凭显示名判断通知来自 ReAI 官方。最终标题仍最多 80 个字符，
Host 会拒绝不可见排版字符，并在必要时安全截断名称和标题。每个插件每 10 秒最多
发起 5 次通知请求；超过限制时，Host 会在查询系统权限和处理负载前拒绝。`queued: true` 只表示
Host 已把请求加入本地发送队列；
系统后端随后仍可能失败，也不保证用户在勿扰或通知摘要状态下实际看到。

调用必须同时通过 Manifest 声明、当前插件的用户授权、系统通知授权与 Bridge 会话门禁。
macOS 系统授权只会在用户点击 ReAI Board 首次引导中的“开启通知”或设置页的“允许通知”后申请；
首次未决定时直接弹出系统确认，已拒绝后只能由用户从系统设置重新开启；
插件不能触发授权弹窗，也拿不到 Tauri notification JS API。当前 Windows/其他非 macOS 构建由
Host 将系统通知权限视为 `granted`，但每个插件仍必须单独通过 Manifest 声明与用户授权。

> 本接口不接受 `sceneKey`、`requestedLevel` 等字段；传入额外字段会按负载非法拒绝。Driver 1.0.5 起
> 旧接口通过原门禁后也写入通知中心历史（场景 `legacy.post`），并与 `notifications.publish` 共享每插件
> 预算；系统授权失败仍按原错误拒绝。场景化通知见下节与[插件开发规范 4.3](./plugin-development-v1.md#43-场景化通知notificationspublish1driver-105-起)。

Bridge 调用前按固定顺序检查：调用来源存在有效插件会话、插件仍可用、插件已启用、Host 支持、
Manifest 已声明、用户决定为 `granted`。

### v1.0.5 平台服务（grantGated：审核批准 + 用户同意）

`notifications.publish@1`、`tasks.present@1`、`audio.capture@1` 从 Driver 1.0.5 起已接线，但只对
**经平台审核批准**（批准绑定插件版本与包摘要）且**用户同意同名权限**的插件开放。Manifest 必须同时在
`requires.hostCapabilities` 与 `permissions` 声明同一个 id（只声明一半会被 CLI 与 Host 校验拒绝）；
未经审核批准的包安装即被拒绝（`APP_CAPABILITY_NOT_GRANTED`）。SDK 每次调用前都会读取当前 Host 的
实时能力描述符，旧 Host、描述符缺失或界面实例已变时失败关闭（`HOST_CAPABILITY_NOT_AVAILABLE` /
`*_STALE`）。appId、账号与来源一律由 Host 从调用界面派生，请求里自报会按负载非法拒绝。

#### `ctx.notifications.publish / listHistory / markRead`（`notifications.publish@1`）

```ts
publish(input: { requestId: string; sceneKey: string; requestedLevel: "in_app" | "system";
  title: string; body: string; dedupeKey?: string; taskId?: string }): Promise<NotificationPublishReceipt>;
listHistory(input: { requestId: string; cursor?: string; pageSize?: number }): Promise<NotificationHistoryPage>;
markRead(input: { requestId: string; notificationIds: string[] }): Promise<void>;
```

- 只接受 `contributes.notificationScenes` 已声明的 `sceneKey`；纯文本标题 80 / 正文 500 码点。
- 实际深度 = 请求深度、用户在扩展详情里为该场景选的深度、场景 `maxLevel` 三者最小值；带 `taskId`
  时还受该任务来源插件 `task.lifecycle` 的同一上限约束（任务必须是本插件自己登记的）。
- 用户未决定 / 拒绝：`NOTIFICATION_PERMISSION_REQUIRED` / `NOTIFICATION_PERMISSION_DENIED`；已允许但关掉
  总开关：`stored:false, effectiveLevel:"off"`。
- `system` 深度在系统通知不可用、未授权或被拒时降级为 `in_app`，回执 `reason` 写明原因
  （`system-unavailable` / `system-permission-required` / `system-permission-denied`），插件不得循环重试；
  插件永远不能触发系统授权弹窗，授权只由用户在 Host 设置里发起。系统入队失败回 `systemDelivery:"failed"`。
- 去重：同场景同 `dedupeKey` 10 分钟内内容相同返回原 ID（`reason:"deduplicated"`），内容不同拒绝；
  每插件每 10 秒最多 5 次（与旧 `post` 共享）。
- 历史按账号本地持久化（最多 1000 条、30 天），重启后仍在；插件只能读、标已读自己的记录；Host 右上角
  通知中心聚合当前账号全部记录。换号后旧账号的历史不会交给新账号。

#### `ctx.tasks.*`（`tasks.present@1`）

`present / progress / finish / dismiss / conversationOpened` 与 `presentResult / continueResult /
dismissResult`。`entityId` 必须是**调用插件自己的 Agent 会话**（经 `agent.session@1/@2` 创建），任务
显示在 Host 的全局任务胶囊里（与 Agent 自动任务同一套）；`stage` 只写真实阶段名，没有百分比。
`presentResult` 返回 `resultId + panelToken`，用户点结果框「继续」时 Host 打开**这个插件自己的会话**
（不是 Voice），确认真的打开后才回 `{opened:true, acknowledged:true}`；会话被打开即统一标已看过
（胶囊、Tab 待办、关联通知一起落旗）。失败只标红、不给重试，完成不自动消失。插件没有通知许可时任务
照常显示，只是不发提醒。不再需要申请 Voice 的命令权限。

#### `ctx.audioCapture.acquire / release / status`（`audio.capture@1`）

为本插件登记一个 Host 统一采音的消费者（Host 单源、按订阅计数启停，最后一个消费者释放才停）；
不暴露原始设备，也不会请求系统麦克风权限。撤权、停用或换号立即作废消费者。

| code | 含义 |
|---|---|
| `PLUGIN_APP_DISABLED` | 插件已停用 |
| `PLUGIN_PERMISSION_UNSUPPORTED` | 当前 Host 不支持此权限 |
| `PLUGIN_PERMISSION_NOT_DECLARED` | Manifest 未声明此权限 |
| `PLUGIN_PERMISSION_REQUIRED` | 尚未决定，或声明变化后需要重新授权 |
| `PLUGIN_PERMISSION_DENIED` | 用户明确拒绝 |
| `PLUGIN_SESSION_REQUIRED` | 调用来源没有有效插件会话 |
| `PLUGIN_APP_NOT_AVAILABLE` | 插件已卸载、正在卸载或 Manifest 不可用 |
| `SYSTEM_NOTIFICATION_PERMISSION_REQUIRED` | 系统通知尚未决定，请用户在 ReAI Board 中主动开启 |
| `SYSTEM_NOTIFICATION_PERMISSION_DENIED` | 系统通知已被拒绝，请用户去系统设置开启 |
| `SYSTEM_NOTIFICATION_STATE_UNAVAILABLE` | Host 暂时无法读取系统通知权限 |
| `NOTIFICATION_RATE_LIMITED` | 通过插件权限门禁后即预占名额；后续系统权限失败、负载非法或入队失败仍计入每 10 秒 5 次上限 |
| `NOTIFICATION_PAYLOAD_INVALID` | title/body 为空、过长、字段多余或包含禁止控制字符 |
| `NOTIFICATION_ENQUEUE_FAILED` | Host 未能把通知加入本地发送队列 |

### `ctx.http.fetch(input, init?)`

```ts
interface AppHttpFetchOptions extends RequestInit {
  endpointId?: string;
}

interface AppHttpClient {
  fetch(input: RequestInfo | URL, init?: AppHttpFetchOptions): Promise<Response>;
}
```

返回标准 Web `Response`，支持 `AbortSignal`。SDK 也会代理插件环境中的全局 `fetch()`；Windows 的
当前插件资源 origin 和 Tauri IPC URL 会保留给 WebView 原生加载，其余 HTTP(S) 走 Host Broker。
`ctx.http.fetch()` 可用 `endpointId` 显式选择 Manifest 端点；全局 `fetch()` 和省略该字段时由 Host
按精确 origin、路径前缀和 HTTP 方法匹配。Manifest 中的 origin 必须写成 URL 规范序列化结果：
域名小写、无尾斜杠、默认端口省略（例如 `https://api.example.com`）。

Host API / SDK **1.24** 起，`fetch()` 可直接上传 `FormData` / `File` / `Blob`：正文超过 512KiB 时
SDK 自动使用 `http.upload.start/chunk/finish`，按 256KiB 分块交给 Host 临时文件，不把全文塞进
Bridge。继续使用 `http.fetch@1`、已声明 endpoint、用户同意和托管 OAuth；无需新增文件选择权限。
HTML `<input type="file">` 返回用户所选文件，Host 不提供任意电脑路径读取。

文件总量最多 50MiB，multipart/text 开销最多 2MiB，正文最多 52MiB；服务端套餐可能进一步限制
单文件大小。每 App 最多一个上传、每账号最多四个，发送阶段也占名额。暂存空闲 180 秒或总长
15 分钟收回，HTTP 最多 120 秒。成功、失败、取消、停用、撤权、卸载、运行实例结束及账号退出
均清理临时文件；插件拿不到临时路径或 OAuth token。旧 Host 返回 `NETWORK_UPLOAD_UNSUPPORTED`，
需要升级；依赖大文件功能的插件声明 `hostApi.range >=1.24.0 <2.0.0`。

已通过归属校验的 `chunk/finish` 调用失败时，Host 按 `uploadId` 和当前 App、组件、运行实例
收回其暂存条目。新的
`http.upload.start` 在取得预约或创建条目前失败，已有同 `requestId` 的请求继续运行。
另一次 `chunk/finish` 在上传进入发送阶段后失败，原发送继续持有文件和名额，直到发送结束释放。
显式取消仍执行下述会话与归属校验。

```ts
const data = new FormData();
data.append("file", fileInput.files![0]);
const response = await ctx.http.fetch(`${apiOrigin}/storage/${selectedProjectId}/upload`, {
  method: "POST", body: data, endpointId: "project-upload", signal,
});
// apiOrigin 来自配置，selectedProjectId 来自当前用户项目选择。不要手设 multipart boundary。
```

`http.cancel` 是 SDK 为 `AbortSignal` 自动发送的内部清理控制消息，不是 App 的公开 API，也不属于
`http.fetch@1` 的权限 `bridgeMethods`。Host 仍要求调用来自有效的插件 mount / Bridge 会话，并从
该会话确定 App 身份；上传额外核对当前 runtime session；它只能按 `(appId, requestId)` 取消当前实例自己的上传或 App 在途请求，不能取消其他
App 的请求，也不能借此发起网络访问。

隐式命中 `auth.mode=oauth_app` 时与显式选择完全同义：Host 仍会准备并注入该插件自己的托管
OAuth 凭据，插件不需要为了获得授权而强制传 `endpointId`，也始终拿不到令牌明文。

本地开发包在开发者模式且未打开“严格网络预览”时为宽松档位，不要求 endpoint 或用户授权，但仍
执行 Broker 的 HTTP(S)、限额、取消和审计规则。其他来源与严格预览都要求：Manifest 声明
`http.fetch@1`、用户允许、请求匹配 `network.endpoints`。严格档位仅允许 HTTPS 公网目标，每次
重定向重新校验。直连时把本次 DNS 解析结果固定到请求，避免 DNS rebinding 绕过私网检查；命中
用户/系统 HTTPS 代理时显式固定该代理快照。只有在域名请求已经命中系统代理，且本地 DNS 全部
返回 198.18/15 标准 Fake-IP 池时，才交由该代理完成远端 DNS；其他私网或保留地址仍拒绝。
代理来源与 Host 自身出站同一规则：环境变量（`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`，旁路看
`NO_PROXY`）优先，没有时用系统手工代理；回环地址永远直连；暂不支持 PAC 自动代理；代理值无效或
协议不受支持（例如 SOCKS）时请求直接失败，不会改为直连。HTTPS 证书先按内置根证书校验，不通过
再交系统证书库（含用户与企业安装的根证书）校验。

传输层控制的 `host`、`content-length`、连接级、`set-cookie` 与代理认证 header 在所有档位都拒绝。
严格档位还拒绝插件自行设置 `authorization`、`cookie`、`origin`、`referer`、代理/转发来源及
`sec-*` header；开发档位不套用这组发布审核限制，但 header 仍须符合 HTTP 客户端规则。
`auth.mode=managed_cookie` 使用按插件隔离、仅存于当前进程内存的 Cookie Jar；`none` 不携带
Cookie。不会向插件暴露 Host 凭据。拒绝、停用或卸载插件时，Host 会取消该 App 的在途请求并
清除内存 Cookie。

| code | 含义 |
|---|---|
| `NETWORK_URL_INVALID` | URL 或 Broker 请求参数无效 |
| `NETWORK_SCHEME_DENIED` | 不是 HTTP(S)；严格档位还要求 HTTPS |
| `NETWORK_PERMISSION_REQUIRED` | 严格档位未声明/未授权网络权限，或范围变化后需重新授权 |
| `NETWORK_ENDPOINT_NOT_DECLARED` | endpoint ID 或 URL 没有匹配声明 |
| `NETWORK_METHOD_DENIED` / `NETWORK_PATH_DENIED` | 方法或路径超出 endpoint |
| `NETWORK_HEADER_DENIED` | 包含 Host 不允许插件控制的 header |
| `NETWORK_PRIVATE_ADDRESS_DENIED` | 严格档位命中本机、私网、链路本地或保留地址 |
| `NETWORK_REDIRECT_DENIED` | 重定向越界、无效或超过 5 次 |
| `NETWORK_RATE_LIMITED` | 每插件超过 4 个在途请求或每分钟 120 次 |
| `NETWORK_REQUEST_TOO_LARGE` / `NETWORK_RESPONSE_TOO_LARGE` | 普通请求 URL/header/正文合计或响应 header/正文合计超过 1 MiB；上传正文超过 52MiB/分块超过256KiB |
| `NETWORK_TIMEOUT` | 普通请求超过30秒；上传HTTP超过120秒或暂存超时 |
| `NETWORK_UPLOAD_UNSUPPORTED` | 旧Host尚未支持大正文上传，请升级 |
| `NETWORK_CANCELLED` | `AbortSignal` 取消了请求 |
| `NETWORK_UPSTREAM_FAILED` | DNS、连接、TLS 或上游读取失败 |

## 5. Surface

Manifest 前置：`surface.main@1`、一个 `contributes.surfaces[id=main]`，以及可选侧栏入口。

### `ctx.surfaces.register(surfaceId, handler)`

```ts
type SurfaceMountHandler<TIntent = unknown> = (
  surface: SurfaceHandle<TIntent>,
) => void | (() => void) | Promise<void | (() => void)>;
```

只能在 `activate()` 注册。当前 Host 只允许 `main` 一个 Surface。

### `SurfaceHandle`

```ts
interface SurfaceHandle<TIntent = unknown> {
  readonly surfaceId: string;
  readonly surfaceMountId: string;
  readonly root: HTMLElement;
  readonly initialIntent?: TIntent;

  ready(): void;
  fail(error: unknown): void;
  reportError(error: unknown): void;
  onIntent(handler: (intent: TIntent) => void): () => void;
  onPresentationChange?(handler: () => void): () => void;
}
```

- `root` 是插件 DOM 的唯一根节点，不要读写 Host DOM；
- `ready()` / `fail()` 二选一且最多生效一次，15 秒未就绪会超时；
- `reportError()` 上报非致命错误，不关闭已就绪 Surface；
- 打开时的 Intent 从 `initialIntent` 读取；`onIntent()` 只接收 mount 建立后的后续 Intent并返回退订函数；
- 可选 `onPresentationChange()` 在 Host 为此挂载提供新呈现绑定时通知；已有绑定在订阅时同步回放，重复绑定不通知。通知不携带 token，不证明屏幕已绘制，也不授予权限。旧 SDK 须用 `typeof` 探测；
- 每次订阅独立、退订幂等，处理器异常隔离；unmount 或 runtime dispose 会移除订阅。插件应在 cleanup 退订，并为刷新的异步操作保留自己的销毁守卫；
- mount 处理器可以返回 cleanup，SDK 收到 unmount 时会调用；当前生产 Host 的所有关闭路径尚未
  完成 unmount 确认，因此必须把资源写成可幂等释放，不能把 cleanup 已被调用当作既成事实。

### `ctx.surfaces.open(surfaceId, payload?, options?)`

```ts
open(
  surfaceId: string,
  payload?: { intent?: unknown },
  options?: { signal?: AbortSignal },
): Promise<void>;
```

请求 Host 前置或打开插件自己声明的主界面，并可投递 Intent。当前不能创建第二个插件窗口。

### Host 托管标题栏动作

Manifest 前置：`titlebar.action@1` 与 `contributes.titlebarActions[]`。

```ts
interface TitlebarActionContribution {
  id: string;
  label: string;
  icon?: "settings" | "plus" | "search" | "clock" | "external-link"
    | "more-vertical" | "rotate-cw" | "square" | "mic" | "pen" | "folder";
  text?: string;
  variant?: "default" | "outlined" | "danger";
  showOnTitlebarHover?: boolean;
  intent: Record<string, unknown>;
}

interface TitlebarStatusContribution {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
}

interface HostTitlebarActionIntent<TPayload = unknown> {
  source: "host.titlebarAction";
  actionId: string;
  deliveryId: string;
  payload: TPayload;
}
```

- `icon` / `text` 至少一个；每 App 最多 3 个动作；label 48 字符、text 12 字符；intent 最多
  4096 规范化紧凑 JSON 预算、8 层。字符串按实际 UTF-8 JSON 字节计，number 保守按 24 bytes 计。
- 可选 `contributes.titlebarStatus` 由 Host 渲染，label 最多 24 字符；状态和动作都要求
  `titlebar.action@1`。`variant` 与 `tone` 仅接受上述固定枚举，插件不能提供样式或资源。
- Host 在当前 Ready Surface 的标题栏、通知铃铛左侧渲染；不接受插件 DOM、CSS、SVG 或 URL。
- `showOnTitlebarHover` 省略或为 false 时常驻，适合设置、帮助等需要持续可发现的入口；设为 true
  时仅在整条 44px 标题栏 hover 或按钮 `:focus-visible` 时显示，适合低频辅助动作；通知面板打开期间
  隐藏。
- 点击经当前 `appId + presentationToken + actionId + mount` 校验后，用 `surface.onIntent()` 投递；
  payload 由 Host 从已安装 Manifest 重读。陈旧 owner 请求 fail closed，只写诊断日志。
- Host 已登记为导航开关的设置动作是例外：精确设置页活动时按钮带 `aria-pressed="true"`，再次点击
  仍投递同一可信 intent，插件必须按当前页面切回根页；只有插件 `reportNav(null)` 后才解除按下态。
  面包屑返回继续调用已声明的 `back-to-root` Command。此登记当前不是公开 Manifest 字段，普通未登记
  动作仍遵循上一条。
- `source` 是 Host 事件保留字段；App-to-App `apps.open()` 的顶层 input 不得包含它，否则返回
  `BRIDGE_BAD_PARAMS`，peer 插件不能伪造 `host.titlebarAction` 信封。
- 切换 App 时旧动作保留到候选 Surface Ready 后原子替换；离开、停用、卸载或当前 owner 不再贡献
  动作时清空。

`titlebar.action@1` 是 Host 限定显示与投递的普通开放能力，不是用户权限，也不需要
`capabilityGrants`。可运行合同见
[`plugins/examples/titlebar-actions-app`](../examples/titlebar-actions-app/README.md)。

## 6. Command

Manifest 前置：`commands@1`，并在 `contributes.commands` 声明输入输出 Schema、超时、并发和
可取消性。

键位页会默认列出所有 Command。兼容别名或只供内部调用的入口可声明
`bindingPickerVisible: false`；需要更适合键位选择器的短文案时可声明 `bindingPickerTitle`。
这两个字段只影响新绑定时的展示，不影响直接调用、既有绑定或执行目标指纹。

### `ctx.commands.register(commandId, handler, options?)`

```ts
interface CommandInvocation<TInput = unknown> {
  input: TInput;
  signal: AbortSignal;
  operation?: { id: string; phase: "start" | "end" };
  /** 硬件触发时 Host 签发的一次性来源凭证（2026-10-20 并入，见下文）。 */
  triggerRef?: string;
}
// Optional registration: { supportsOperations: true }

type CommandHandler<TInput = unknown, TOutput = unknown> = (
  invocation: CommandInvocation<TInput>,
) => TOutput | Promise<TOutput>;
```

- 只能在 `activate()` 注册；重复注册会报 `app-sdk/DUPLICATE_REGISTRATION`；
- 代码注册与 Manifest 声明必须精确一致；
- SDK 收到 Host 的 `command.cancel` 后触发 `signal`。支持取消的 Command 超时或撤销时，Host 向原 Runtime 发取消；插件须清理已启动的副作用，迟到完成也须检查 signal。
- `supportsOperations: true` 显式接受通用配对操作。`start` 与 `end` 携同一 `operation.id`；插件应将它绑定自己的业务会话，`end` 只能结束该会话，未知/重复 end 不得开始新操作。设备状态、手势和配对由 Host 设备层负责，插件不解析硬件行为。
- 声明 `supportsOperations: true` 的 Command 会随 SDK 注册报告（`operationCommands`）上报给 Host。Host 按**按下那条命令**决定整对怎么派发：声明了，就按配对操作下发；没声明（旧版插件），就按配对操作出现之前的方式，按下、松开各发一次不带 `operation` 的普通调用（松开调用的是绑定里的松开命令）。旧方式下，按下送达后不会因为松手而被取消，松开要等按下结算完才送达。按下声明了而松开命令没声明时，松开同样发普通调用，并在消息里用 `completesOperation` 带上原 operation id，SDK 据此释放按下保留的取消句柄。会话还在激活、注册报告没到时，Host 先等报告到了再决定派发方式（这段等待同样受投递时限与松手取消约束）。
- `triggerRef`（Host API 1.25，2026-10-20 并入）：这次调用由某台硬件的按键 / 拨杆触发（键盘以外的设备，例如录音卡）时，Host 在投递前签发一个不透明的一次性凭证——只对本插件有效、约 10 秒内有效、只能兑现一次，插件拿不到也构造不出设备身份。开录音时原样传给 `voiceInput.start({ requestId, triggerRef })` / `voiceInput.toggle({ triggerRef })`，Host 校验通过（签发对象、未兑现、未过期、发起设备仍在同一次连接）后让发起设备的麦优先；不传或校验失败时按用户的音源档位默认顺序解析，不报错。松开（`operation.phase: "end"`）、软件入口与旧 Host 没有这个字段；不要保存、转交或用它推断任何设备信息。
- 只有 Host 与 SDK 不配套、把 operation 发给了未 opt-in 的处理器时，SDK 才会在调用前返回 `COMMAND_OPERATION_UNSUPPORTED`；无 operation 的普通调用保持兼容。
- 成功 start 的 signal 在结算后仍保留到 paired end/cancel，覆盖副作用已启动但结算未到 Host 的取消窗口；end 后不再取消原 start。处理器应在 end 时移除原会话监听。
- Manifest 的 `timeoutMs` 不得超过 30 秒；
- 插件抛出的错误会转成 `WireError`，作为本次 Command 的唯一失败终局。

### Host 定时任务

定时任务没有新的 SDK 方法。App 在 Manifest 里把一个 Host-callable Command 声明为周期任务：

```json
{
  "contributes": {
    "scheduledTasks": [
      {
        "id": "refresh-summary",
        "title": "总结检查",
        "description": "刷新数据，并在需要时更新总结",
        "commandId": "com.example.refresh-summary",
        "intervalMs": 300000
      }
    ]
  }
}
```

- `commandId` 必须指向同一 Manifest 的 Command，且该 Command 的 `callers` 必须包含 `host`；
- 每个 App 最多 16 个任务，`intervalMs` 范围为 60,000–86,400,000；
- Host 持久化上次成功入队时间。首次发现立即触发；休眠或退出期间错过多个周期只补跑一次；
- 插件停用时不触发。开发者模式可查看真实任务数量、立即运行或暂停；关闭开发者模式会清除暂停；
- Command 应尽快返回“已接收”，把长工作交给自身已有的单飞/幂等流程，不要让 Command 等完整后台工作。

## 7. 跨插件 Intent

Manifest 前置：调用方需要 `apps.intent@1`，并在 `requires.appIntents` 声明目标；目标插件在
`contributes.intents` 声明对应 Intent。

### `ctx.apps.open(target, input?, options?)`

```ts
open(
  target: { appId: string; intent: string },
  input?: unknown,
  options?: { signal?: AbortSignal },
): Promise<void>;
```

成功只表示 Host 已接受，不表示目标 Surface 已经 mount。当前投递是活跃 Surface 会话内的
at-most-once，不承诺跨崩溃的 exactly-once。

Host 会检查调用方声明、目标已安装且启用、目标贡献了兼容主版本的 Intent，以及当前支持范围内
的入参 Schema。目标未安装返回 `APP_INTENT_TARGET_NOT_INSTALLED`。

## 8. Tab 条目

Manifest 前置：

```json
"contributes": {
  "tabItems": { "componentId": "ui" }
}
```

### `ctx.tabItems.upsert(item)`

```ts
interface TabItemUpsert {
  entityId: string;
  title: string;
  icon?: string;
  status: "running" | "waiting_input" | "completed" | "error";
  requiresInteraction?: boolean;
  target?: { surfaceId: string; intent?: unknown };
}
```

同一 `entityId` 再次 upsert 表示更新并移到最近位置，不产生重复项。只有
`status: "waiting_input"` 可以设置 `requiresInteraction: true`。

### `ctx.tabItems.remove(entityId)`

幂等移除一条本插件实体。

### `ctx.tabItems.list()`

返回 `TabItemInfo[]`，在 `TabItemUpsert` 基础上增加：

```ts
interface TabItemInfo extends TabItemUpsert {
  appId: string;
  createdAt: number;
  activatedAt: number;
}
```

限额：每个插件最多 50 条、全局最多 200 条、每个插件最多 10 条需交互条目。

## 9. Host 事件与存证

当前事件类型只有 `actionContext`，Manifest 可识别的 Action 上下文类型只有 `recording`。但生产
Host 尚无可公开依赖的 recording 产物发送链，也没有与之对应的用户权限，因此该上下文目前只用于
合同占位和内部验证；在补齐权限、真实生产者与审计前不得作为公开插件能力。

Manifest 前置：

```json
"contributes": {
  "eventSubscriptions": [
    { "componentId": "ui", "events": ["actionContext"] }
  ],
  "acceptsActionContext": [
    { "componentId": "ui", "contextTypes": ["recording"] }
  ]
}
```

### `ctx.events.on(handler)`

```ts
interface AppEvent {
  eventType: string;
  payload: unknown;
}

on(handler: (event: AppEvent) => void): void;
```

只能在 `activate()` 注册。SDK 会丢弃不属于当前 `runtimeSessionId` 的迟到事件。`payload` 是
`unknown`，插件必须做运行时校验。

### `ctx.evidence.fetch(pickupToken)`

```ts
fetch(pickupToken: string): Promise<Uint8Array>;
```

凭 `actionContext` 事件给出的 token 取存证字节。token 一次性，存证有 TTL 和容量限制；当前总容量
64 MiB、TTL 24 小时。插件取件失败使用 `EVIDENCE_FETCH_FAILED`；`EVIDENCE_LIMIT_EXCEEDED` 属于
Host 侧 producer 写入存证时的容量错误。

## 10. Host 系统任务

### `ctx.systemTasks.getVersionStatus(options?)`

返回 Host 归一化的固件与桌面 App 版本状态。`refresh: true` 会触发一次受限频的远端检查；网络失败时
Host 只会降级到已经校验过的 last-known-good。返回值不会包含发布 URL、SHA、缓存路径或设备句柄。

### `ctx.systemTasks.open(options)`

Manifest 前置：

```json
{ "requires": { "hostCapabilities": ["system.tasks@1"] } }
```

```ts
await ctx.systemTasks.open({
  target: "firmware-upgrade",
  returnIntent: { reason: "feature-requires-new-firmware" },
});
```

`target` 只接受 `firmware-upgrade`、`software-update`、`permission-settings`、`keymap`、
`account-login`、`voice-command-settings`、`audio-timeline-settings`、`app-permissions`、
`app-managed-resources`、`agent-config`。后七项分别精确落到设备键位映射、账户登录行、兼容语音命令设置入口、
官方 Voice 设置、**来源插件自身**的已安装详情权限区或运行组件区，以及「设置 › 插件 Agent 配置」。
`agent-config`（1.23）锁定到来源插件。Host 的当前可配置清单必须包含来源，页面也必须完成该插件的
实际锁定，才确认导航成功。已启用快照不能代替可配置资格；清单排除来源、读取失败或锁定超时均按
`SYSTEM_TASK_NAVIGATION_BLOCKED` 失败，不以打开泛化配置页冒充成功。清单与审批规则保持不变，
插件不能自行指定其他来源。退出页面或账号生命周期结束后，迟到回执不能确认新任务。
`audio-timeline-settings` 只为旧调用方保留线协议兼容，
不再落 Host 全局设置；官方 Voice 缺失或停用时导航失败。`app-permissions` 的 appId 只能由 Host 从 live、当前可见的
Bridge mount 推导；`app-managed-resources` 遵循同一来源约束，适合插件在 Host 报告受管运行组件
不可用时提供“去修复”入口。请求没有可信来源时导航失败，不能退化为泛化的已安装列表。Host 从 live、当前可见的
Bridge mount 推导来源 App/Surface，并固定映射到自己的设置 section；插件不能提交 appId、内部路由、
固件 URL、文件路径或 DFU 参数。固件下载、准确 size/SHA-256 校验、USB 门禁、DFU、取消与 journal
均归 Host。终态返回 intent 固定包装为 `system-task.return`；返回发生在既有或重新建立的 mount 完成后，
统一通过 `surface.onIntent()` 投递，插件收到后必须重新读取状态。`surface.initialIntent` 仍只表示创建
该 mount 时随 mount payload 携带的初始意图，不会被平台返回流程改写。

软件更新在 Host API 1.2 中只开放版本状态与安全导航，尚未开放桌面安装执行器；Driver V2 开发版
0.x 以及未来 1.x 都会拒绝把旧 0.20.x 资产当作可安装更新。

## 10.5 云端 AI：两条纯管道

Host API 1.3 起提供两条**并列、不互相包装**的底层通道。它们只是管道——润色、翻译、
命令化、Agent 编排属于插件或工作流，不属于 Host。

- `ctx.aiApi`（`cloud.model.invoke@1`）：用用户账户额度中转各家大模型的既有 API。
- `ctx.flowApi`（`cloud.workflow.invoke@1`）：调用已编排好、导出成 API 的工作流。

### 你给不了的东西

endpoint / URL / path / header / 原始 body / 凭据 / provider / 真实模型 id / 超时 /
重定向策略 / 请求与响应大小 / 并发数。参数结构体是 `deny_unknown_fields`，夹带这些
字段会在解析阶段就被拒——不是「忽略」，是明确失败。

### 模型是**档位**，不是真实 id

```ts
const models = await ctx.aiApi.listModels();
// [{ id: "text-default", kind: "text", label: "通用文本" }, ...]
```

`listModels()` 返回文本档位和后台配置的启用转写选项。真实模型 id 归后端网关，随时增删换代；
写死在插件里，网关一换代所有已装的包当场失效。返回值里**没有价格、没有 provider**。

Host API 1.18.0 起，转写选项 ID 为后台提供的动态 `transcribe-*` ID，名称跟随 Host 界面语言。
默认项排在转写选项首位，仅用于首次主动选择云端；已有选择不能因目录更新自动替换。
转写的 `model` 省略时使用后台默认项，显式旧 `transcribe-default`、被删或禁用的 ID 必须重新选择。
公开列表不透出实际模型 ID；Host 向网关提交 `driver-asr:<optionId>`，由网关解析实际模型。

### 文本生成与流式

```ts
const invocationId = crypto.randomUUID();
await ctx.aiApi.generateText({
  invocationId,               // 由插件生成：取消要用它，所以必须先于结果拿到
  model: "text-default",
  messages: [{ role: "user", content: "……" }],
  stream: true,               // 立刻返回，增量走推送通道
});
```

需要图像上下文时，只有 `user` 消息可以改用受控内容部件；图片只能是内联 base64，
不能给 URL 或本地路径。Host 会校验 MIME、魔数、最长边 2048、总像素 400 万与
512 KiB 字节上限，并只以低细节档转发；旧插件的字符串 `content` 保持原样兼容。

```ts
messages: [{
  role: "user",
  content: [
    { type: "text", text: "按截图统一术语" },
    { type: "image", mime: "image/jpeg", dataBase64, detail: "low" },
  ],
}]
```

增量在 `ctx.events.onCloud()` 里收，**只能在 `activate` 期间注册**——`generateText`
立刻返回，注册晚了就会丢开头几条。

```ts
ctx.events.onCloud((event) => {
  if (event.invocationId !== current) return;   // 串台的直接丢
  if (event.type === "ai.stream.done") {
    // done 带的是完整最终文本。**据此对账**，别依赖增量拼接正确。
  }
});
```

三条你需要知道的约束：

1. **增量是 Host 合并过的，不是逐 token**。推送通道一条消息一次、同步直投、无缓冲，
   逐 token 转发会打爆 WebView 主线程。
2. **`sequence` 只能让你发现空洞，修不了它**。所以增量一旦在途中丢了，Host 会发
   `ai.stream.error` + `AI_STREAM_LOST` 终止本次调用——你拿到的是「明确失败」，
   而不是一段自己不知道缺了字的残文。
3. 每插件的在途流数、每秒消息数、单条与整段字节都有上限，触顶同样是显式失败。

### 语音转写：插件碰不到音频

先用 `retainAudio` 录一段，再把 `sessionId` 交给 Host：

```ts
const result = await ctx.voiceInput.toggle({ retainAudio: true });  // 开始
// …用户说话…
const done = await ctx.voiceInput.toggle({ retainAudio: true });    // 结束
if (done.phase !== "idle" || !done.sessionId) return;
// Host 判定没有内容（整段静音 / 太短，#1291）或被取消时没有 audio：按「没听清」处理，
// 确认回执即可，不要去转写。
if (done.outcome === "cancelled" || done.noSpeechReason || !done.audio) {
  await ctx.voiceInput.acknowledgeResult(done.sessionId);
  return;
}
const transcription = await ctx.aiApi.transcribe({
  invocationId: crypto.randomUUID(),
  sessionId: done.audio.id,
});
// transcription.text 可能是 ""（transcription.suppressedReason 说明原因）：同样按「没听清」处理。
```

`retainAudio: true` 同时**关掉本地识别与模型强制要求**——跑本地识别是白费一次延迟，
还逼没装模型的用户先下 1GB，而云端通道存在的意义正是「不必先下模型」。所以这次
`toggle` 的 `transcript` 通常是 `null` 而不是空串：没识别过就不假装识别过。唯一例外是
Host 已判定这段没有内容（带 `noSpeechReason`）：这时 `transcript` 为 `""`、不带 `audio`，
没有可上传的音频，也不会计费。

音频由 Host 托管：保留 90 秒、**TTL 内可重试**（网络抖动或余额不足之后让用户重录
一遍是不能接受的）、转写成功后立即作废。取消录音（`voiceInput.cancel()`）会清掉它；
取消这次转写（`aiApi.cancel()`）**不会**——那两个 cancel 语义相反。

### 本地识别结果：调用方负责消费

Host API 1.10 起，`mode: "command"` 的本地识别只把结果返回调用方，不替调用方决定
文字放在哪里或接什么工作流。调用方消费、明确丢弃或判定空结果后，用同一次调用的
`sessionId` 结算结果：

```ts
const done = await ctx.voiceInput.toggle({ mode: "command" });
if (done.phase === "idle" && done.sessionId) {
  try {
    if (done.outcome !== "cancelled" && done.transcript) {
      appendToCurrentComposer(done.transcript);
    }
  } finally {
    await ctx.voiceInput.acknowledgeResult(done.sessionId);
  }
}
```

Host API 1.22 起识别与插入解耦：识别只返回文本，不产出「插入事件」，是否写回由调用方的
业务分支决定（Agent 结果永不写回）。`insertText` 标为弃用、本阶段仍生效——缺省 `true` 时
Host 仍对 `mode: "input"` 会话本地直写，新调用方应传 `insertText: false`，拿到文本后自己
`delivery.commit`；`mode: "command"` 会话从不由 Host 本地直写。识别结果带
`consumedBy: "tab_layer"` 表示这段话已被 Host 的 Tab 层语音搜索消费：该会话写回凭证已撤销，
不要再 commit（只会得到 `expired`），也不要弹取回卡。

识别结果带 `noSpeechReason`（2026-10-16，#1291）表示 Host 判定这段没有可写的内容：`too_short`
（有效录音不足 100ms 且没有任何语音证据）、`silence`（整段静音）或 `suppressed`（本地识别只得到纯标点
或公认的静音幻觉整句）。此时 `transcript` 为 `""`——**云端路径也是 `""` 而不是 `null`**，且不带
`audio`（没有上传、不计费）；`warningCode` 为 `"no_speech"`。中央胶囊由 Host 显示「没听到声音」
并自行计时约 2 秒收起，调用方的 `acknowledgeResult` 或 `cancel(sessionId)` 只消费回执、不会提前收掉
提示。按「没听清」处理：不写回、不弹取回卡。`aiApi.transcribe` 的结果同理可能带 `suppressedReason`
（`punctuation_only` / `hallucination_phrase` / `silence`），此时 `text` 为 `""`。常见真实短词
（「嗯」「好」「you」「Thank you」等）从不被置空。旧 Host 不返回这两个字段。

确认只负责结束对应的中央语音胶囊，不创建新的 busy phase。Host 同时校验调用方、
`sessionId` 和胶囊代次；重复确认或旧调用的迟到确认是幂等空操作，不能收起新调用。
带 `retainAudio: true` 的 command 会话（云端识别：结果只带音频引用、没有本地 transcript）
同样等待确认：调用方转写、写回或决定不接下游后，按原 `sessionId` 确认即收起中央胶囊。
`outcome: "cancelled"` 是用户主动取消，不等同于已识别但没有听清。
录音达到上限或音源中断属于异步自动停止：启动录音的那次 `toggle` 已经返回，Host 不会
把终态塞进下一次 `toggle` 冒充其结果。调用方在持有活动 session 期间应调用
`voiceInput.getStatus(sessionId)`；Host 按调用方与 session 保存终态，不会被其他调用覆盖。
当状态回到 `idle` 且返回同一个 `sessionId` 时，用 `VoiceInputStatus.stopReason` 区分
`"capture_limit"`、`"source_unavailable"` 与 `"user_cancel"`，按原 session 收口本地 UI，
再调用 `acknowledgeResult(sessionId)` 消费这份终态。

调用方主动放弃当前调用时，应传原 session：`voiceInput.cancel(sessionId)`。这本身就是
“结果已明确丢弃”，Host 不再为该 session 留一份等待确认的取消终态；精确 session 也能
防止迟到的取消误伤同一 App 随后启动的新调用。Host 侧 Esc 不属于调用方主动丢弃，仍会
按上面的 status 通道返回 `user_cancel`，让调用方同步自己的 UI。

### 胶囊停到写入那一刻：`holdOverlayUntilAck` 与 `reportStage`（1.22，2026-09-28 并入）

旧行为：`mode: "input"` 会话识别一结束，中央胶囊固定停 1.2 秒就收起，调用方随后的云端转写、
润色和 `delivery.commit` 都在胶囊消失后才发生，用户看不到文字还在路上。声明
`holdOverlayUntilAck: true` 后，Host 把输入会话当成「等调用方写回」：

| 识别结束时 | 胶囊 |
|---|---|
| 云端路径（`retainAudio: true`，还没转写） | 停在处理态「正在转写」 |
| 本地识别有字 | 停在处理态「转写完成」 |
| 空结果、`outcome: "cancelled"`、`consumedBy: "tab_layer"`、Host 已按旧 `insertText` 直写 | 立即收起（不再停 1.2 秒） |
| 带 `noSpeechReason`（Host 判定没有内容） | Host 显示「没听到声音」约 2 秒后自行收起，不等调用方确认 |
| 识别失败、录满上限只保存（未自动转写） | 与未声明时相同 |

之后调用方按原 `sessionId`。以下新增反馈与呈现等待描述的是 **Driver rc.2.16 源码候选**，不是已发布客户端保证；`holdOverlayUntilAck` 的基本接口仍沿用 1.22，Host API 保持 1.23。

- `reportStage(sessionId, stage, label?)` 更新胶囊：`transcribing` 正在转写、`transcribed` 转写完成、`polishing` 正在润色、`translating` 正在翻译；候选新增 `processing` 表示处理中，`label` 为可选的详细阶段文案，最多 **200 个字符**（Host 按字符计数，超限为参数错误）。
- `insert_failed` 切到失败态「文字没有写入」。候选实现不再因这一上报清掉待确认记录或安排 6 秒自动收起；调用方等待取回窗口确认可见后，再按原 session 确认。取回卡仍由 Host 或调用方按写回路径呈现。
- 写入回执 `committed: true` 后调用 `acknowledgeResult(sessionId)`，胶囊立即收起；决定不写（空结果、放弃）也要确认。ACK 本身只按 owner、session 与胶囊身份结算，不验证插入回执或呈现结果，正确先后顺序由调用方保证。

每次 `reportStage` 被受理都算一次推进。处理中仍保留「连续 60 秒没有推进」的安全帽，不按总时长；到点后的失败提示、无文字失败卡和 6 秒收起规则不因本次修改扩大或取消。`insert_failed` 已进入 error，候选实现改为等显式确认，不再沿用原处理中安全帽的消失路径。迟到的 `acknowledgeResult` 仍按原 session 收口。调用方、`sessionId` 与胶囊代次三重校验不变：已换代、已收起、不属于调用方或不认识的阶段返回 `{ accepted: false }`，不报错。阶段只进不退（`transcribing` < `transcribed` < `polishing` / `processing` / `translating` < `insert_failed`）；更早的迟到上报也返回 false。

候选 `delivery.presentTakeback` 只有收到该呈现身份的原生窗口可见回执后才成功返回，等待上限为 5 秒；超时、取消或呈现失败会拒绝。这个确认指**窗口已可见**，不是用户已复制或关闭。仅请求入队不等于呈现成功；失败不能在 `finally` 或吞掉呈现异常之后无条件 ACK。`retainResultUntilAck` 的保留回执也由同一次 ACK 回收。

```ts
const done = await ctx.voiceInput.toggle({ mode: "input", insertText: false, holdOverlayUntilAck: true });
if (done.phase === "idle" && done.sessionId) {
  // 阶段反馈是可选增强：旧 SDK 可能没有方法，旧 Host 可能返回 accepted:false。
  const report = (stage: VoiceReportedStage) =>
    typeof ctx.voiceInput.reportStage === "function"
      ? ctx.voiceInput.reportStage(done.sessionId!, stage).catch(() => undefined)
      : Promise.resolve(undefined);
  await report("polishing");
  const result = await ctx.delivery.commit(/* … */);
  if (result.committed) {
    await ctx.voiceInput.acknowledgeResult(done.sessionId);
  } else {
    await report("insert_failed");
    // card 按写回失败结果构造。候选 Host 返回成功才表示取回窗口已确认可见。
    // 拒绝时保留待确认状态，由调用方处理呈现失败；不要无条件 ACK。
    await ctx.delivery.presentTakeback(card);
    await ctx.voiceInput.acknowledgeResult(done.sessionId);
  }
}
```

**旧 Host 兼容边界**：未知阶段返回 false 是现有降级语义，不是新反馈支持证明。rc.2.15 的 Host API 同样为 1.23：其注入的 SDK `reportStage(sessionId, stage)` 会忽略第三参数 `label`，Host 只识别五个旧阶段并拒绝 `processing`；`insert_failed` 仍按旧规则结算并在 6 秒后收起，取回请求成功返回也不能当作候选的窗口可见回执。吞掉反馈失败能让业务继续，但不能承诺旧 Driver 展示新的前台阶段文案或遵守新的呈现等待顺序。`hostApi.range: ">=1.23.0 <2.0.0"` 无法区分两者；候选 Host 与插件 override 的一致验证只覆盖候选组合，不代表插件独立发布后所有旧 1.23 Host 都具备新反馈。依赖完整新行为时须另行建立可探测能力或有效版本门槛；本段不改变 API 版本、安装门禁或既定异常规则。

未声明 hold 的旧调用行为不变；早于基本接口并入的 Host 可能忽略 `holdOverlayUntilAck` 或拒绝 `voice.report-stage`，更早的 SDK 可能连方法都没有。调用方可按上例检查方法存在并吞掉可选阶段反馈错误；不得据此推断呈现失败也可以无条件确认。

### 回听片段：三个方向都落盘（Host API 1.22）

握着 `voice.recordings@1` 的调用方，输入法与语音命令（翻译 / Agent）的每段录音都会落成
回听片段，结束录音的结果里带 `replayClip`（录音 id、墙钟起点、时长与有效区间），
另带 `replayClipStatus`：`"saved"`（已落盘，`replayClip` 非空）、`"not_retained"`（没有录音
留存授权、保留设置不留或没有可留的音频）、`"failed"`（落盘失败或超时，这条只有文字）。
落盘与识别并行，识别不等落盘，落盘失败也不影响识别结果与写回。`"failed"` 只表示本次结果
拿不到片段引用：磁盘停滞超过 3 秒上限时 Host 不再等，但这段仍可能稍后入库（未转写的输入法
录音因此会出现在 `listRecoverableInputSessions` 里）。判断某段还有没有声音以恢复列表与按 id
取件为准，不以结果为准。旧 Host 不返回 `replayClipStatus`，且只在输入模式返回 `replayClip`。

`listRecoverableInputSessions` 仍只列输入法录音；语音命令的录音按 id 用
`authorizePlayback` 回听、`getInputSession` 查询（`mode: "command"`）或重转，不进恢复列表。
转写状态与输入法同口径：走 `retainAudio` 的命令录音以 `pending` 落盘，调用方云端识别结束后
（成功或失败）须用 `setInputSessionTranscription(replayClip.id, …)` 回写；不回写的录音会停在
`pending`，直到下次 Host 启动归为 `failed`，期间不能发起重转。

### 取消的诚实边界

```ts
const { cancelled, upstreamStopped } = await ctx.aiApi.cancel(invocationId);
```

`upstreamStopped: false` 表示「已放弃结果，但上游可能仍在跑、仍在计费」。转写就是
这一种（上游完全不接 signal）。**不要把它显示成「已停止」**。

### 结果写回目标应用

录音开始时 Host 返回不透明的会话交付凭证（`toggle()` 的 `deliveryTarget`），它不绑定录音开始或停止时的输入框：

```ts
const outcome = await ctx.delivery.commit({ targetId, text });
// { committed: true } | { committed: false, reason: "expired" | "focus_changed" | "not_editable" | "not_received" | "denied" | "insert_failed" | "accessibility_permission_required" }
```

`not_editable`（Host API 1.22 起）表示事前判断确定光标不在可输入位置，没有粘贴；`not_received`（1.22 起）表示已粘贴但约 1 秒内目标应用没来取剪贴板，按未写入处理。`focus_changed` 保留给旧 Host，1.22 的当前输入框写回不再产出（仅剩取消、Command 会话等少数来源）。`accessibility_permission_required` 只表示系统辅助功能权限缺失；`insert_failed` 表示剪贴板准备、内容冲突、主线程 150ms 内没能写剪贴板或原生投递失败。`denied` 表示调用目标被拒绝；旧 Host 也可能用它报告一般失败，客户端不能据此断言缺少系统权限。插件的 `VOICE_DELIVER_NOT_GRANTED` 表示平台能力未放行、未启用或清单状态不可用；`VOICE_DELIVER_PERMISSION_REQUIRED` / `VOICE_DELIVER_PERMISSION_DENIED` 才指向用户授权。这些仍是异常信封，与系统辅助功能状态分开处理。未知失败原因应保留文本、显示中性说明，不自动重试。

macOS 的 `committed: true`（Host API 1.22 起）表示 Host 已向当前前台发出粘贴，且目标应用在约 1 秒内读取了剪贴板（「取件回执」）。Host **不回读输入框内容**：网页 / Electron 输入区的无障碍值不可靠，回读会把「已写入」误判成失败。误差方向是允许偶尔「该弹没弹」（文字仍在历史里），不允许「写进去了还弹」。剪贴板管理器抢先读取、或回执前剪贴板被改写，同样按成功处理。它不能代替签名客户端在真实目标应用中的验收。

写入位置是交付那一刻光标所在的输入框：光标在哪就插在哪，有选区时替换选区，由目标应用原生完成；Host 不读不设选区、不激活应用、不拉回旧窗口。录音开始、停止及转写期间均不锁定目标。例如在 A 录音、B 停止、转写期间切到 C，交付的是 C。

粘贴前先做事前判断（总预算 150ms，单次 AX IPC 最多 30ms）：前台为空或为 Host 自身、按钮 / 静态文本 / 链接 / 菜单等非输入控件（AXValue 可写的除外）、禁用的文本控件、密码框时返回 `not_editable`，不粘贴。网页 / Electron / 容器类控件、看不到焦点元素（含原生应用：微信等的输入框不向辅助功能暴露焦点）、读不到或超时等拿不准的情况照常粘贴；前台应用开着安全输入且拿不准时拒绝。判断与投递之间前台换了应用，对新前台重判一次。

剪贴板只在本机声明（不经 Universal Clipboard 同步），带 Transient / Concealed / AutoGenerated 标记让剪贴板管理器跳过；成功后静默约 200ms 还原原剪贴板，`not_received` 后晚到的读取拿不到数据、约 3 秒后还原，用户在此期间复制的新内容不会被覆盖。Input 会话失败时 Host 弹一张取回卡（插件 commit 与 Host 本地直写同一张）。Host API 1.22 起 Command 会话（翻译 / 转文本）的凭证同样可以 commit——Host 的插入不认业务分支，「Agent 结果永不写回」由调用方保证；Command 会话写回失败 Host 不自动弹卡，由调用方自己呈现（取回卡或结果面板）。不支持当前输入框写回的平台拒绝自动写入。

目标只允许一次提交认领，本地直接写入和插件交付共用该限制。录音期间不能提前提交；超时、被新录音替换，或首次提交仍在执行中时再次提交，返回 `expired`。首次提交已有结论后，用**同一段文字、同一 `behavior`** 重复提交会原样拿回首次结论（成功即 `committed: true`，不会再写一次，Input 会话也不会因此弹取回卡；失败回放同一原因）；换一段文字或换 `behavior` 返回 `expired`。取消可在原生准备阶段获胜并阻止粘贴；按键已获准投递后不能撤回，也不会再伪报成取消成功。`captureDeliveryTarget:false` 且 `insertText:false` 不创建目标；仅 Host 直接写入的调用可以持有不对插件暴露的内部目标。识别被 Host 自己的界面消费（`consumedBy`）时，该会话目标随即撤销。

#### 取回卡：`ctx.delivery.presentTakeback()`

写回失败时请求 Host 在 Voice 胶囊正上方弹「取回文字」卡（识别全文 + 一键复制）；文案归插件，Host 只负责
显示在哪。Host API 1.22（同版本并入）起可带两个可选诊断字段（[设计规范 §6.0](./plugin-design-system-v1.md#waiting-failure-minimum)）：

```ts
await ctx.delivery.presentTakeback({
  title, reason, text,              // 必填：已本地化的标题与原因一句 + 完整识别文本
  errorCode: "not_received",        // 可选：结构化错误码
  detail: "paste receipt timeout",  // 可选：诊断专用的原始原因
});
```

- `errorCode`：可选的小写反向域名命名空间加 `/`，再接字母开头、只含字母数字下划线的标识（≤ 64），总长 ≤ 100；例如 `com.example.app/STORAGE_READ_FAILED`、`AI_TIMEOUT`、`not_received`。路径、URL、空格、冒号、编码串都不合规（码会进浮层与复制诊断，按结构收紧）。
- `detail`：≤ 500 字。Host 把它当作**不可信的自由文本**：原文不显示、不复制、不转交浮层，只保留字数
  （卡片写「原始信息可能含用户内容，已省略（N 字符）」）。要给用户看的原因放进已本地化的 `reason`。
- 越界或类型错误整次以 `VOICE_DELIVER_INVALID_REQUEST` 拒绝；旧 Host 忽略这两个字段。
- 卡片显示错误码（缺省写「无错误码」）、原始原因的字数、插件版本与 Host App 版本，并提供「复制诊断」。
  **版本由 Host 按 appId 从已安装记录读取**，插件自报的任何版本字段都会被忽略；诊断只由结构化字段组成
  （错误码、Host 按码查表的说明、步骤、正文与原始原因的字数、版本、时间），**不含**识别正文、插件的
  `title` / `reason` 与 `detail` 原文，也不对原文做任何正则清洗。
- Input 会话写回失败时 Host 会自弹同一张卡（原因按 commit 的原始 `reason` 给出）；插件随后调用本方法只替换内容。

结果面板 `ctx.voiceCommand.presentAnswer()` 同样新增可选 `errorCode` / `detail`（规则同上，不合规以
`BRIDGE_BAD_PARAMS` 拒绝）：`status: "failed"` 时面板显示失败区（错误码、原始原因的字数、版本）与「复制诊断」，
`detail` 原文不进面板；复制文本不含标题、分段正文、原话与 `detail` 原文。

⚠️ **这条权限的真实边界比「写回结果」宽**：它能在 TTL 内单次把**任意文本**写入交付时当前聚焦的可写控件，
Host 不可能去判断一段文本是不是「合法的识别结果」。交付时焦点若在终端，
一段带换行的文本粘贴进去就是一条会执行的命令。所以权限文案要按真实边界写
（「代表你向该应用输入文字，内容由插件决定」），不要写成「写回结果」——
那会让用户以为范围只到转写文本。

### flowApi 的 v1 边界

发起 + 订阅 + 取消，**不支持回填输入**：后端创建与 resume 仅限 JWT，OAuth 够不到。
收到 `wait_for_input` 时 Host 原样透传，但你应答不了——该类工作流本轮不可用。

今天 Driver 的登录授权里没有工作流档位，所以 `flowApi.invoke()` 会稳定返回
`FLOW_SCOPE_UNAVAILABLE`（文案：云端工作流暂未开通）。这是**明确的未开通**，不是
网络错误；不要重试，也不要回退到别的通道。后端开通后无需改插件代码。

### 错误码

两条通道各有一族带域前缀的稳定码（`AI_*` / `FLOW_*`）。用 SDK 的 `describeCloudError()`
把它翻成小写码与 `retryable`，别自己编映射：

```ts
import { describeCloudError } from "@reai/app-sdk/v1";
const { code, retryable } = describeCloudError("AI_RATE_LIMITED");
```

`AI_PAYMENT_REQUIRED`（余额不足）落到 `unavailable` 且 `retryable: false`——重试解决
不了余额问题，只会白白再失败一次。

连接或正文传输失败使用 `AI_NETWORK_ERROR` / `FLOW_NETWORK_ERROR`，超时仍是 `*_TIMEOUT`，HTTP 503 仍是服务不可用。当前 Driver 无订阅可按量扣积分，详见 [订阅、积分与云服务](./driver-cloud-billing.md)。为兼容旧后端，AI 网关仅在 HTTP 403 + 嵌套 `error.code=driver_subscription_required` 时返回 `AI_SUBSCRIPTION_REQUIRED`，HTTP 503 + `driver_subscription_unavailable` 时返回 `AI_SUBSCRIPTION_UNAVAILABLE`。Host 最多读取 4 KiB、等待 2 秒，只识别这两个状态匹配的稳定码，绝不透传上游 message/param；未知、畸形、超限、读取失败或错状态均回退既有 HTTP 分类。FLOW 不推断此订阅合同。

上述新码在 `describeCloudError()` 中均保持既有 `unavailable` 档；网络故障和订阅服务暂不可用的 `retryable=true`，订阅不满足为 `false`。小写 taxonomy 和 BridgeError 信封未改变。需要区分下一步行动时使用原始稳定码：网络检查连接，旧订阅拒绝提示服务端尚未开放按量能力（不要引导购买订阅），额度不足补充额度，订阅服务/普通服务暂不可用稍后重试。旧 Host 的旧码保持兼容；旧 SDK 对新增码按原有规则安全返回 `unknown`。

## 10.6 Dsh 对话 Agent

声明 `agent.dsh@1` 后，插件通过 `ctx.dshAgent` 使用 Host 托管的 Dsh 会话。插件看不到
Wainao 地址、OAuth access token、真实 provider 或真实模型 id，也不能自行 spawn Dsh。

```ts
const status = await ctx.dshAgent.status();
if (!status.available) throw new Error(status.detail);

const { sessionId } = await ctx.dshAgent.createSession();
const turnId = crypto.randomUUID();
const result = await ctx.dshAgent.send({
  sessionId,
  turnId,
  text: "检查设备状态并告诉我结论",
});

// 精确取消这一回合，不会误伤同一 session 的下一轮。
await ctx.dshAgent.cancel({ sessionId, turnId });
```

接口格式：

| SDK 方法 | Bridge 方法 | 请求 | 响应 |
|---|---|---|---|
| `status()` | `dsh.status` | `{}` | `{ available, detail, loggedIn, modelAccess }` |
| `createSession()` | `dsh.session.create` | `{}` | `{ sessionId }` |
| `send(...)` | `dsh.session.send` | `{ sessionId, turnId?, text }` | `{ turnId, text, failure }` |
| `cancel(...)` | `dsh.session.cancel` | `{ sessionId, turnId }` | `{ cancelled }` |
| `history(...)` | `dsh.session.history` | `{ sessionId }` | `{ items: [{ role, text }] }` |
| `listSessions()` | `dsh.session.list` | `{}` | `{ sessions: [{ sessionId, title, updatedMs, lastOutcome }] }` |
| `deleteSession(...)` | `dsh.session.delete` | `{ sessionId }` | `{ deleted }` |

`failure` 为 `null`，或 `{ kind: "engine" | "killed" | "timeout", stderr_tail? }`。
会话由 Host 按 `appId` 强制归属；同一会话串行，不允许跨插件读写。Voice 的
`reai-voice` profile 只装载只读工具，模型请求由 Host 使用当前账户的
`vibe-board:cloud` 授权转发到 Wainao model gateway；`send` 还会再次执行
`cloud.model.invoke@1` 平台授权 + 用户同意双层门禁，不能靠先前的 status 绕过。

## 10.7 通用 Agent Session

Host API / SDK 1.21 新增 [`agent.session@2` 合同](./agent-service-v2.md)：统一配置、
可省略的 runtime、短提交与持久结果查询。新接入使用该合同；下文保留 v1 兼容说明。

Host API 1.23 起，v2 `AgentConfig` 增加可选 `featureRef`：指认本插件
[`contributes.agentFeatures`](./plugin-development-v1.md#46-声明-agent-功能默认值contributesagentfeatureshost-api-123)
里声明的一项，Host 以此把声明默认值与用户在配置页的覆盖合并。`featureRef` 必须指认调用方
自己声明的功能，否则以 `AGENT_FEATURE_NOT_DECLARED` 拒绝；旧 Host 不认识该字段会整包拒绝，
按 `backends().capabilities.configuration.featureRef`（1.23 起为 `true`，缺席即旧 Host）
探测后再附带。

Host API 1.6 起，官方授权插件可声明 `agent.session@1`，通过 `ctx.agent` 在同一合同下选择
Pi 或 DSH。统一的是 Spec、归属和生命周期，不是底层 transport：Pi 仍是 Host 托管的单进程
RPC，DSH 仍按回合启动 Harness。

```ts
const { sessionId, backend } = await ctx.agent.createSession({
  backend: "pi", // "pi" | "dsh" | "codex" | "auto"
  systemPrompt: "用用户的语言简洁回答",
  tools: ["device_status", "browser_observe"],
  skills: [{ id: "voice-style", title: "表达规则", content: "先给结论，再给依据。" }],
  workspace: { kind: "app-private" },
  memory: "session", // 或 "one-shot"
});
const result = await ctx.agent.send({
  sessionId,
  text: "检查设备并解释异常",
  // Host API 1.8：调用方已有自己的结果面板/胶囊时，关闭 Host 的重复呈现。
  taskPresentation: "caller",
});
```

| SDK 方法 | Bridge 方法 | 说明 |
|---|---|---|
| `backends()` | `agent.backends.list` | 列出 Pi/DSH/Codex 当前插件可用性与能力描述符（渠道 + 能力槽位），不暴露模型或凭据 |
| `createSession(spec)` | `agent.session.create` | 创建不可变 Spec；`auto` 在创建时解析并固定 |
| `send(...)` | `agent.session.send` | 发起一回合；1.8 起可用 `taskPresentation: "caller"` 由调用方独占呈现，否则默认使用 Host 胶囊 |
| `cancel(...)` | `agent.session.cancel` | 按 `sessionId + turnId` 精确取消 |
| `history(...)` | `agent.session.history` | 只读当前插件自己的 facade 历史 |
| `listSessions()` | `agent.session.list` | 只列当前插件会话 |
| `deleteSession(...)` | `agent.session.delete` | 删除会话并释放 backend 资源 |
| `reportConversationOpened(...)` | `agent.session.conversation-opened` | 会话被用户打开时上报——「已看过」唯一判据，任务胶囊/Tab 层/通知账本一起落旗 |
| `requireToolDependency(...)` | `agent.tool-dependency.require` | 用户从聊天能力卡明确安装 `web_search` / `web_fetch` 的浏览器插件依赖；不能由模型静默调用 |

**终局 envelope（M1 起版本化）**：`send` 返回 `{ schemaVersion: 1, turnId, text, failure }`。
`failure` 为 `null`，或结构化对象 `{ kind, code, message, retry, stderr_tail? }`：

- `kind`：`"engine"`（引擎侧失败）/ `"killed"`（主动取消）/ `"timeout"`（回合兜底超时）；
- `code`：稳定机读码 `"AGENT_ENGINE"` / `"AGENT_KILLED"` / `"AGENT_TIMEOUT"`；
- `message`：有界可展示文案，可直接展示；
- `retry`：重试语义分层——`"none"`（不应重试，用户已取消）/ `"same-session"`（同会话可重发）/ `"new-session"`（须新建会话，M2 细分失败源时出现）；
- `stderr_tail`：engine 诊断尾部（可缺席）。旧消费方只读 `kind` / `stderr_tail` 的代码零迁移。

三 backend（Pi/DSH/Codex）对已开跑回合的终局统一：执行中的超时与取消一律折成
`timeout` / `killed` envelope，不以 JSON-RPC error 透传；只有回合尚未分发就被拒
（会话不存在、turnId 复用、冷切换、排队阶段即取消）仍按服务级错误返回。任务胶囊
终局同源：`engine` / `timeout` 留红卡，`killed` 撤卡。`stderr_tail` 在 wire 上保留
backend 产出的完整尾部（约 512 字符上界，机读检索稳定码以此为窗口）；`message` 是
给展示用的更紧文案（约 200 字符），不要只扫 `message` 前段做错误分类。

**实际引擎、渠道与真实用量（Host API / SDK 1.20 增量字段）**：终局保留上述字段，
并可附带以下元数据；旧 Host 缺少字段时按未知处理，不从当前设置反推历史结果。

```ts
runtime?: "pi" | "dsh" | "codex";
channel?: "external-brain";
usage?: {
  complete: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};
```

- `runtime` 保持原有字符串字段，表示本回合实际执行的引擎，不返回 `auto`，也不改成对象。
- `channel` 独立表示实际模型调用渠道。当前 `agent.session.send` 三个引擎均走
  `external-brain`（外脑云代理）；`runtime: "codex"` 不代表使用 Codex 订阅渠道。
- `usage` 只统计提供方真实返回的数据；一次 `send` 独立累计本回合的所有模型请求，
  包括工具调用前后的模型请求。不同回合不混算，流式响应的用量快照不重复累加。
- 仅当本回合统计完整时，返回 `complete: true` 和输入、输出、合计三个计数。
  任一模型请求缺少或返回无效统计，或回合失败、取消、超时，不能把已收到的部分计数
  当作整回合用量：返回 `complete: false` 且不提供三个计数；尚无统计时也可省略 `usage`。
  缺失不等于零，插件不得估算、补零或展示部分合计。
- 要保存聊天历史的插件，应把本次 `runtime`、`channel`、`usage` 快照与对应的每条 AI 回复
  一起保存，恢复时继续使用该回复的快照。旧记录只有 `totalTokens`、没有完整统计标志时，
  不得当作完整用量展示。Voice 的用量展示遵循此规则；保存元数据不等于要求普通模式展示它。

**事件流合同（M1 起版本化）**：进度事件经调用方 Surface 通道投递，每条统一带
`schemaVersion: 1`。事件类型为封闭词表：`turn.started`、`message`（`text`，续块带
`append: true`）、`tool.start`、`tool.end`（`toolName` / `isError`）、`tool.outcome`
（`toolName` / `errorCode`，仅稳定错误码时）、`turn.settled`（`ok`）。不同 backend
实际产出的事件子集不同（Pi 全词表；Codex 无 turn.started/settled；DSH 仅 tool.*），
插件必须容忍子集与顺序差异，不得假设事件必达——进度丢了不影响终局 envelope。

**等用户拍板（2026-09-28 起，三个 runtime 通用）**：回合里某一步要等用户决定（启用浏览器插件
以联网、确认工作目录外的访问）时，Host 投 `wait.started`（`kind: "waiting_user"`、`waitId`、
`reason`、`label`、`action`、`startedAt`，联网工具另带 `toolName`），用户拍板或回合结束时投
`wait.ended`（`waitId`、`reason`、`outcome: "granted" | "declined" | "cancelled"`、`waitedMs`）。
`action.type` 为 `tool-dependency` 时可调 `requireToolDependency({ tool: action.toolName })` 一键进入
安装 / 启用；为 `host-approval` 时只能提示用户去 Host 主窗口确认。**等待期间回合的全部计时暂停，
不算超时**：插件不得在此期间自行判定超时，应显示「等待你授权：`<label>`」与已等时长。同意后原请求
继续；拒绝按真实原因失败；取消则停止。回合结束（含被取消）即视为等待结束，插件应在回合终态时清掉
等待展示。自报呈现的插件（`taskPresentation: "caller"`）要让胶囊亮「等待你授权」，需在
`voice.command.present-task` 帧里带 `waiting: true`。旧插件按 `type` 过滤会忽略这两类事件，行为不变。

**渠道维度（M1 起提供）**：`backends()` 每个 backend 附带 `channel`
（`"external-brain"` 外脑云代理 / `"codex-subscription"` 订阅渠道，后者随 M3/M4
接入）与 `capabilities`（`hostTools` / `fileTools` / `turnModes` / `modelSelection`）。
`fileTools` 与 `turnModes` 在目录挂接 + 镜像 + 三档写权限落地前恒为 `false` / 空数组，
插件不得据此推导文件访问或模式切换行为。

**Host API 1.21：直接工作范围、工作范围内命令与单次越界确认（F02 / F03 / F04，macOS 实现）**

- `workspace: { kind: "app-private" }` 申请文件 / 命令工具时由 Host 分配独立工作根（不是插件设置、
  凭据或整个 Host 数据目录）；`createSession` 返回真实 `workspaceRoot` 与 `scopeVersion: 1`，插件不得猜路径。
- 新增 `{ kind: "direct", path }`：必须先由本插件的 `system.folder-pick@1` 原生面板授权；修改直接
  发生在原目录，不经镜像、不承诺自动回滚；系统目录、`~/Library`、整个个人目录不能成为范围。旧 `mounted`
  不会自动转换。
- 三个 runtime 都经 Host 共同提供 `read/write/edit/list/glob/grep/command`，不另开无限制原生 shell。
  `command` 只在 direct / app-private + `mode: "yolo"` 开放，与 `run` 一样需要 `local.terminal.exec@1`
  双层授权；镜像会话不放行 `command`。消费方须检查 backend 的 `capabilities.scopedExecutionVersion === 1`，
  运行命令还须 `commandExecution === true`；字段缺失不代表支持。会话工具上限 32。
- `command` 输入为 `command`、可选 `cwd`、`extraPaths: [{ path, write }]` 与 `timeoutMs`（默认 30 秒，
  上限 300 秒）；结果包含真实 `stdout` / `stderr` / `exitCode` / `status` / `truncated` / `partialExecution`；
  命令结束时它的进程组与观察到的全部后代（含主动 setsid 脱离、凭进程组找回的）都被停止（结果含
  `descendantsStopped`；从未被观察到的双 fork 守护进程是已知边界），失败不包装成成功，取消不等于回滚。
- 已授权范围内正常执行；范围外明确的目标先生成 Host 单次确认。确认不自动过期（2026-09-28 起
  `expiresMs` 恒为 `0` 表示不过期，旧的 120 秒上限取消），等待期间回合计时暂停并投 `wait.*` 事件。
  拒绝、关闭弹窗、取消、撤权均不授予访问；未预先声明的越界访问被系统拒绝，模型只能根据失败另发包含准确目标的新操作。
- 许可绑定插件、账号代际、会话、回合、工具调用 id、范围代际与完整动作摘要，单次消费。
  `ctx.agent.approvals.list({ sessionId })` 只读本插件会话；`approval.requested` / `approval.resolved`
  事件提供 `id/sessionId/turnId/toolCallId/actionDigest/description/paths/status/createdMs/expiresMs`。
  **插件 SDK 无批准接口**；批准 / 拒绝只能由 Host 主窗口处理。
- 稳定失败：`AGENT_SCOPE_STALE`（已取消 / 权限变化 / 工作根被替换）、`AGENT_SCOPE_LIMIT`（请新建会话）、
  `AGENT_SCOPE_PLATFORM_UNSUPPORTED`（非 macOS）；工具级 `AGENT_APPROVAL_DENIED / EXPIRED / LIMIT`、
  `AGENT_EXEC_SCOPE_REQUIRED`、`AGENT_EXEC_YOLO_REQUIRED`。

**兼容：目录挂接（M3 Workspace v2）**：`workspace` 除 `app-private` 外接受
`{ kind: "mounted", path }`。`path` 必须是本插件经 `system.folder-pick@1` 原生面板
选出并授权过的目录（或其子目录）——「folder-pick 即授权」，插件不能凭任意路径
自授；未授权路径创建返回稳定码 `AGENT_WORKSPACE_NOT_AUTHORIZED`。挂接后 Host 在
App 数据目录内为会话建 git worktree 镜像：agent 的文件改动先发生在镜像里（改动前
自动 commit，用户可回溯回滚），写回用户目录时做冲突检测（用户侧与镜像改动相交则
fail-closed，稳定码 `AGENT_MIRROR_SYNC_CONFLICT`）。镜像需要系统 `git` 可用，缺失时
创建返回 `AGENT_MIRROR_GIT_UNAVAILABLE` / `AGENT_MIRROR_FAILED`。

**镜像文件命令与三档写权限（M3）**：挂接会话的 `tools` 可额外声明标准 CLI 命名的
文件命令 `read` / `write` / `edit` / `list` / `glob` / `grep`（业界通用命名，不发明
新名字；AppPrivate 会话声明会被拒）。agent 以为自己在直接操作文件，实际每条命令被
Host 拦截重定向到镜像：路径一律是工作目录内相对路径，穿越与符号链接逃逸 fail-closed。
写权限由 `spec.mode` 三档决定（缺省 `chat`，封闭词表；拨杆绑定是键盘自己的行为，
插件只暴露这三个值）：

- `chat`：只读——`write` / `edit` 一律拒绝，改动留在镜像等用户确认；
- `plan`：只允许写 **plan 类型的 md 文件**（文件名主干含 `plan`，如 `plan.md`、
  `my-plan.md`）；
- `yolo`：镜像内自由写。

回合收尾按档位写回（`send` 结果的 `mirror` 字段）：`chat` 不写回（改动已 commit
在镜像）；`plan` 只写回 plan 类 md，其余改动保留在镜像不丢；`yolo` 全量写回。写回
冲突时 `mirror.conflict` 带文件清单，用户文件保持原样。M3 起三 backend 的
`capabilities.fileTools` 均为 `true`、`turnModes` 均为 `["chat", "plan", "yolo"]`。

**Codex backend 的档位实现（M3 统一接入）**：`chat` / `plan` 档 = read-only sandbox +
文件工具白名单（plan 只写 plan 类 md，§6.1 三路同判）；`yolo` 档收敛为
`workspace-write` 且 cwd 指向镜像 worktree——「镜像内自由写 + 按档位写回」，不再
dangerFullAccess 直写真实文件夹。Codex owned-tasks（codex-app 的三模式）保留其更严的
untrusted 逐项确认形态，不回退。

**Codex Link 的 cwd 授权闸（M3）**：`codex.start_thread` 的 `cwd` 必须是**调用方插件**
经 `system.folder-pick@1` 原生面板授权过的目录（或其子目录）——任意绝对路径不再
直通，与 agent.session 的「folder-pick 即授权」统一；未授权返回 `PROTOCOL_ERROR`
（消息含「folder-pick」指引）。

V0 只接受 `app-private` 工作目录；skill 是有界只读文本，不会作为代码、外部插件或 Harness
扩展加载。工具必须来自 Host Catalog，backend 实际注册的工具集与 Spec 精确相等。Pi 全局最多
一个进程和一个 active turn；正在执行的回合不会被另一会话抢占。空闲时切换到另一持续会话会在
1 秒内回收旧进程并启动对应的新会话，因此每次新建的 Voice 对话不会复用上一条对话上下文。
每个插件最多保留 256 个会话；facade 只保存每个会话最近 8 条、每条最多 4096 字符的有界摘要。

V0 的 Pi `one-shot` 在终局会停止进程并回收会话，因此连续的一次性调用仍是 cold path；
调用方必须为超时或 backend 不可用保留原始输入等降级结果。若实验数据证明冷启动不满足交互
预算，再单独设计不泄露跨会话上下文的受管 warm pool，不能通过跳过 one-shot 回收来偷换语义。

Codex 可通过显式 `backend: "codex"` 使用，也可在 Host 设置为默认引擎。未设置偏好时，`auto` 依次选择已获授权且可用的 DSH、Pi、Codex；明确偏好不可用时报错，不静默更换。已有会话不受默认偏好变更影响。`backends()` 可返回 `defaultBackend` 和 `defaultBackendError`。当前支持
macOS arm64 与受管 Codex 0.149.1；插件必须声明 `com.reai.runtime.codex` 运行组件并走
正常安装同意流程，其他插件装过组件不能代替本插件授权。模型走插件自己的 Wainao OAuth
连接（`oauthAppId` 和 `model-gateway:invoke`），不需要 ChatGPT 账号，不接受插件指定模型
URL、token 或桌面 Codex 配置。

Codex 每个会话有私有目录，同一会话串行，全局最多两个回合同时执行；每轮结束回收进程，
持续会话通过本地线程记录续接。排队期间可取消，执行阶段最多 600 秒。只支持文本与 Spec 中的 Host 工具，图片和原生 shell 等能力
不在此合同内。模型通道沿用 Host 的有界 SSE 缓冲，因此不承诺逐 token 低延迟。
上下文最多 128 条消息、256 KiB，超限明确返回 `context_length_exceeded` 并保留原会话，
调用方应提示新建会话；不会静默截历史。取消停止 Host 模型/工具通道并回收自身进程，
`failure.kind` 仍区分 `killed`、`timeout`、`engine`，不承诺服务端已产生的用量免费。

### 10.7.1 App Service（Host API 1.14 已实现最小子集）

App Intent 仍只有打开/导航/投递语义；需要结果的跨 App 调用使用独立的 App Service：

```ts
ctx.services.provide<Input, Output>(serviceId, method, async ({ input, signal }) => output);
const output = await ctx.services.call<Output>(serviceId, method, input, { signal });
```

Provider 在 `contributes.services` 声明方法，Consumer 在 `requires.services` 声明版本、用途和必需性，
两端都声明 `apps.service@1`。代码注册与 Provider Manifest 必须精确一致。Host 对 Provider 隐藏冷启动，
冷/热路径都等待 Ready；一次调用绑定调用方 app/mount 与 Provider app/runtime。每个调用方 mount
最多 4 个在途，全局最多 8 个，单方法超时最多 300 秒。取消经 Provider 的 `AbortSignal` 传递。

F04 候选扩展：Provider 的 `ServiceInvocation` 除 `input` / `signal` 外，还收到 Host
提供的 `caller`（appId、surfaceMountId、runtimeSessionId、Voice 专用 opaque accountGeneration）
与 `deadlineUnixMs`。身份不能从 input 推导；deadline 覆盖冷启动、权限等待和执行全过程。
取消信封携带相同 caller/runtime 归属与 correlation，并保留原 deadline；SDK 按原调用隔离取消，
提前到达的取消不能被晚到 invoke 复活。普通本地服务不因 Voice 代际字段而要求登录。

Voice 消费者合同及版本不足时的处理见 [request-text 候选合同](./voice-request-text.md)。
Host API **1.17.0** 起，`await ctx.voiceInput.checkPermissions()` 返回
`{ microphone, accessibility, microphoneRequired }`。前两项是系统真实权限状态；
`microphoneRequired` 由 Host 当前持久化来源与解析路由计算。Board USB Vendor HID、
BLE 原生采集不要求系统麦克风；显式系统输入和 Board UAC 兼容采集要求它，
包括 UAC 因权限被拒绝而暂时不可用的情况。查询不会打开音频端点或请求系统权限。
插件不能依据自己的 `source: "board"` 或缺失的 timeline route 推断是否需要权限。

依赖此字段的插件必须声明 `hostApi.range: ">=1.17.0 <2.0.0"`。
SDK 将字段标记为可选以描述旧 Host 的实际返回；缺字段时应停止录音准备并明确提示升级
ReAI Board，不能把缺字段当作免授权，也不能伪造 `microphone: "granted"`。
2026-10-11 起录音链路只检查、不请求系统麦克风权限：官方 Voice 的 request-text 在
`microphoneRequired === true` 且尚未授权时直接以 `com.reai.voice/VOICE_MIC_PERMISSION_REQUIRED`
失败（不再进入 `waiting_permission`、不弹系统授权），授权只由用户在 Voice 设置里点击发起。

同一响应可选返回只读 `audioSources`（旧 Host 不返回）：`mode` 为 Host 持久的音源档位
（`auto` / `prefer_board` / `prefer_computer` / `board_only` / `computer_only`，旧 USB Audio
兼容态为 `legacy_board_uac`），`hardware` 为硬件麦状态（`available` / `disconnected` /
`firmware_too_old` / `checking`），`computer` 为电脑麦状态（`available` / `permission_required` /
`missing`），`resolved` 为按当前档位下一次录音会用的来源（`board` / `system` / `unavailable`）。
`voiceInput.configure` 的可选 `audioSourcePreference.kind` 接受上述五档（`computer_only` 结合
`systemEndpointId`），只在用户显式选档时携带；激活准备可带 `preserveAudioSourcePreference: true`
让 Host 保留已持久的档位。旧 Host 只认识 `prefer_board` / `prefer_computer` 并忽略 preserve。

`voiceInput.start` 支持 requestId 与不注入的服务采集；`finish(sessionId)` 结束指定录音，
`cancelPendingStart(requestId)` 清理尚未返回 session 的启动，不能用取消当前全局录音替代。
`voiceInput.start` / `toggle` 可附带 `overlayKind: "input" | "translate" | "task"`，
仅告诉 Host 胶囊本次正在做什么。它不改变 `mode: "input" | "command"` 的录音、写回或结果语义，
也不代表键盘或快捷键来源；例如翻译仍传 `mode: "command", overlayKind: "translate"`。
未提供提示时 Host 保留按 mode 显示 input/task 的行为；旧 Host 会忽略新提示，业务结果不受影响。
Host 状态事件保留旧 `mode` 并附带可选 `kind`；该提示是渐进显示能力，不能用它判断翻译业务是否完成。

`voiceInput.start` / `toggle` 还可附带 `triggerRef`（Host API 1.25，2026-10-20 并入）：把命令调用里收到的
`CommandInvocation.triggerRef` 原样传回，本次录音的音源解析让发起设备的麦优先（例如按录音卡键就用录音卡麦，
其他设备的麦对插件仍表现为 `board`，`audioSources.resolved` 不出现新值）。凭证一次性，只在开始录音时传；
结束（`finish` / `action: "finish"`）不需要。旧 Host 忽略此项，按档位默认顺序解析。

`voiceContext.capture` 的截图请求须带原录音 `sessionId` 与用户同意时的 `consentEpoch`；
返回的 `sessionEpoch` 只作 opaque 代际比较，`windowScreenshotStatus` 说明图像可用性。
Host 核对录音归属、账号、取消代际和原窗口；空参数查询只读取代际，不读取文字或图像。
仅 Host API 版本号不能证明这些候选方法已经实现；缺能力/缺可信代际须明确失败。

Service 依赖进入安装同意收据；依赖用途扩大后重新询问。当前存在多个兼容 Provider 时 fail closed，
尚没有 Provider 选择 UI。`examples/local-tts-app` 是 Provider，`examples/local-tts-client` 是不持有
`tts.local@1` 的 Consumer 验收样例。

本地配音是首个 Host executor 子集：官方 Provider 可在 Service 声明中固定
`implementation: "host:tts.local@1"`。这条路径由 Host 直接执行已经授权的本地 TTS，并为调用方签发
绑定 provider、caller mount 与 correlation 的一次性 60 秒结果凭据；Provider 侧 JavaScript handler
不参与执行，也不会为了调用而隐藏启动插件 Web Runtime。没有固定 `implementation` 的 Service 仍走
上述通用 Provider handler 合同。

当前 `AgentSessionSpec` 仍由获授权插件直接提交不可变的 `systemPrompt/tools/skills`；Manifest Agent
Scene、动态 Tool Catalog、进度信封、无界面 Provider 与同会话能力变更事件仍为规划。

Host API 1.10 的 `voice.input@1` 也只授予 `com.reai.voice`。它证明了“Host 录音和识别、调用方拿到
文本后自己消费”的底层路径，但其他插件今天不能通过它调用 Voice。

后续仍为规划：

- `contributes.agentScenes`：插件随包声明提示词、会话策略、依赖阶段和结果交付；
- `contributes.agentTools`：把 Service 方法显式适配成 Pi/DSH 可见工具；
- Service 进度、Provider 选择、按需安装与真正 headless Runtime；
- `capabilities.changed` 与 generation snapshot：用户确认后让当前会话下一回合使用新能力。

这些规划字段仍会被当前 `additionalProperties: false` Schema 拒绝。完整目标、Voice 的“调用方不提供
音频，只拿文本”示例、懒安装人工续跑和安全边界见
[插件服务与 Agent / DSH 扩展规范](./agent-service-extension-v1.md)。

## 10.8 官方 Pi Agent 管理

Host API 1.10 起，正式 builtin `com.reai.pi-agent` 独占 `agent.pi-management@1`，通过
`ctx.piManagement` 管理 Driver App 内置 Pi。它是控制与观察面，不提供聊天输入框，也不会读取
电脑上独立安装的 Pi、DSH、它们的配置或对话。

| SDK 方法 | Bridge 方法 | 说明 |
|---|---|---|
| `snapshot()` | `pi.management.snapshot` | 跨官方插件查看有界的 Pi 会话摘要与回合状态 |
| `session(sessionId)` | `pi.management.session.get` | 按需读取一个会话的 System prompt、Skill 摘要、Tools 与 MCP 状态 |
| `models()` | `pi.management.models` | 返回稳定模型档位、可选/已验证状态、登录状态和已保存设置 |
| `updateSettings(settings)` | `pi.management.settings.update` | 原子保存默认档位与 App 例外；只影响之后创建的新会话 |

轮询快照不携带较重配置，避免合法会话累计后超过 Bridge 上限；选中会话后才按需读取。目录只返回 App 私有目录的相对投影；Skill 返回标题、ID 与 Host 计算的 SHA-256 摘要，不返回跨 App
原文；不展示模型思维链。System prompt 是用户明确要求管理的配置，因此仅向这个官方管理插件开放。
模型档位在 `agent.session.create` 时解析并固定，运行中、等待中与既有会话不受设置修改影响。

Pi 仍是一个进程、一个 active turn。不同逻辑会话通过 Host 队列串行执行，快照区分 `queued`、
`preparing`、`active` 与 `idle`；这解决的是“多个对话可以同时存在并等待”，不是把每个对话复制成
一个高内存进程。

## 10.9 Codex Tasks 与本地文本文件

Host API 1.10 增加两条彼此独立、按 `appId` 授予的官方插件窄口：

- `ctx.codexTasks` / `agent.codex.tasks@1` 只授予 `com.reai.codex-app`。它使用 Driver 私有
  `CODEX_HOME` 启动固定、验签的官方 Codex app-server，提供账户/订阅登录、模型、Skills、thread/turn、
  审批、结构化问题、事件和文件 handoff。它不复用 `agent.codex@1` 的 Codex Link attached profile。
- `ctx.localFiles` / `local.files@1` 只授予 `com.reai.text-editor`。它提供工作文件夹授权、目录列表、
  UTF-8 文本读写、revision 冲突保护和一次性 handoff 领取；不提供任意绝对路径、二进制文件、shell 或 Git。

浏览器登录的 auth URL 由 Host 直接打开，不返回插件；设备码只短时显示。官方 Codex 自己在隔离 home
落盘并刷新凭据，插件 KV 不得保存 token、cookie、auth URL 或 user code。

文本编辑器的 `pickWorkspace()` 必须由当前可见 Surface 的用户手势触发系统目录面板。后续方法只收 Host
签发的 `workspaceId + relative path`；每次访问都重新检查 canonical path 与 symlink containment。保存必须
回传读取时的 revision，冲突时先比较再由用户决定，不能覆盖。完整方法与发布门禁见
Codex App 与本地文本编辑器（原 Board 仓库内 `docs/driver-v2-codex-app-text-editor.md`；未迁入）。

Codex App 的 `folderPick.pick()` 也会在 Host 留下不可由插件伪造的 cwd grant。`startThread(cwd)`、带 cwd
的 Skills 查询与文件 handoff 都只接受该 grant 内的 canonical 目录；“路径绝对且存在”本身不构成授权。

## 11. 结构化错误

### `AppError`

```ts
new AppError({
  code: "com.example.app/READ_FAILED",
  userMessage: "无法读取数据",
  retryable: true,
  cause: error,
});
```

### `WireError`

```ts
interface WireError {
  code: string;
  userMessage: string;
  retryable: boolean;
  diagnostic?: string;
}
```

- `userMessage` 可以显示给用户，不能含 token、绝对路径、堆栈或敏感输入；
- `diagnostic` 供开发日志使用；
- 非 `AppError` 抛出物会归一成 `app/UNHANDLED`；
- Host Bridge 的 `{ code, message }` 会在 SDK 请求出口归一为带 `userMessage` 的形状。

## 12. 能力矩阵

### 普通开放能力

| 能力 | 对应公开面 |
|---|---|
| `surface.main@1` | `ctx.surfaces.*` |
| `sidebar.item@1` | Manifest `contributes.sidebarItems` |
| `storage.kv@1` | `ctx.storage.private()` |
| `commands@1` | `ctx.commands.register()` |
| `apps.intent@1` | `ctx.apps.open()` |
| `system.tasks@1` | `ctx.systemTasks.getVersionStatus()` / `open()`；Host 持有导航与执行器 |
| `titlebar.action@1` | Host 渲染 `contributes.titlebarActions`；点击经 `surface.onIntent()` 投递，已登记的设置导航开关由插件把同一 intent 实现为往返切换 |

### 用户授权权限

| 权限 | 对应公开面 |
|---|---|
| `account.status@1` | `ctx.account.status()` |
| `os.notification.post@1` | `ctx.notifications.post()` |
| `http.fetch@1` | `ctx.http.fetch()` 与 SDK 代理的全局 `fetch()` |
| `cloud.model.invoke@1` | `ctx.aiApi.*` —— 用用户账户额度中转各家大模型 API |
| `cloud.workflow.invoke@1` | `ctx.flowApi.*` —— 调用已发布的云端工作流 |
| `voice.deliver@1` | `ctx.delivery.commit()` —— 把最终文本写入交付时当前输入框；`ctx.delivery.presentTakeback()` —— 写回失败时弹取回卡（可带诊断字段） |
| `voice.context@1` | `ctx.voiceContext.capture()` —— 显式读取焦点窗口的有界文字 / 截图上下文，帮 AI 对齐称谓与语气 |
| `agent.session@1` | `ctx.agent.*` —— 兼容 v1 的 Pi/DSH/Codex 会话 |
| `agent.session@2` | `ctx.agent` v2 配置、提交、查询、取消与会话维护；模型调用另需 `cloud.model.invoke@1` |

### 需要审核批准的特权能力

Manifest 只表达“需要什么”，不产生批准。Host 从独立机器 policy 校验
`appId + publisherId + version + packageSha256`，再结合安装时的用户权限决定放行；业务 Bridge
不得出现某个插件 ID 的特判。当前批准对象仍以官方插件为主，未来第三方必须走同一审核流程。

| 能力 | 当前用途 |
|---|---|
| `agent.codex@1` | Codex app-server 窄接口；只授予官方 `com.reai.codex-link` |
| `agent.codex.tasks@1` | owned-isolated 官方 Codex work 客户端窄口；只授予 `com.reai.codex-app`，包含订阅登录、任务、审批、问题与文件 handoff，不暴露 token 或原始协议 |
| `agent.local@1` | 本地 pi agent 内核窄口；只授予官方 `com.reai.device-doctor`（只读工具，方法 `local.status` / `local.chat.send` / `local.chat.cancel`，进度经 `local.event` 推送） |
| `agent.dsh@1` | Host 托管的 Dsh 会话 Agent；首发授予官方 `com.reai.voice`，方法与格式见 10.6 |
| `agent.session@1` | Pi/DSH 的统一 Agent Session facade；V0 首发授予官方 `com.reai.voice`，仍需同名用户权限与 `cloud.model.invoke@1` |
| `agent.session@2` | Host API 1.21 的统一 Agent 服务；须平台批准和同名用户允许，无需同时申请 v1；支持子集见 [v2 合同](./agent-service-v2.md) |
| `agent.pi-management@1` | Driver App 内 Pi 的官方管理面；只授予正式 builtin `com.reai.pi-agent`，不读取电脑独立 Pi / DSH |
| `activation.startup@1` | 常驻启动；需要编译期白名单和 capability grant 同时成立 |
| `voice.input@1` | 本地录音、STT 与文字注入窄口；只授予官方 `com.reai.voice` |
| `voice.command@1` | 把最终本地 STT 文本交给 Host 配置的 Workflow；URL 与外壳的 OAuth token 不暴露给插件。结果面板 `presentAnswer` 在 Host API 1.22 起可带 `deferred: true`（迟到结果框：被动显示不抢键盘，Voice 录音 / 识别期间排队，关闭即撤掉同 `runId` 后台任务的胶囊行、Tab 层待办与通知未读，`runId` 须为该任务 `taskId`）；同版本起可带可选 `errorCode` / `detail`（失败区与复制诊断，见「取回卡」一节） |
| `voice.deliver@1` | 代表用户向交付时的当前输入框**输入任意文字**；Host 在粘贴前做一次事前判断，成败看目标应用是否来取剪贴板（取件回执），不回读输入框。Input 与 Command 会话的凭证都可提交，是否写回由调用方业务分支决定 |
| `voice.context@1` | 读**焦点控件**里的有界文字与前台应用粗分类；显式传 `includeWindowScreenshot:true` 时，在屏幕录制已授权、窗口未命中排除护栏的前提下返回缩放压缩后的焦点窗口 JPEG。编辑器类应用还必须先读到通过凭据护栏的焦点文字，否则截图 fail-closed。无申请权限入口，不含窗口标题、文件路径或整屏采集 |
| `cloud.model.invoke@1` | 模型网关的纯管道（列档位 / 文本生成 / 语音转写 / 取消） |
| `cloud.workflow.invoke@1` | 已发布工作流的纯管道（发起 / 订阅 / 取消） |
| `system.folder-pick@1` | `ctx.folderPick.pick()` —— 弹系统原生选文件夹面板，只回**用户亲手挑的那一个**目录的绝对路径；不读目录内容、不附带任何文件读写、取消回 `undefined`。只有用户当前正在查看的插件界面能调，同一时刻只允许一个面板。只授予官方 `com.reai.codex-link` 与 `com.reai.codex-app` |
| `local.files@1` | `ctx.localFiles.*` —— 只授予 `com.reai.text-editor`；用户授权目录内的有界文本列表/读写、revision 冲突保护与 Codex App 短时 handoff |
| `terminal.session@1` | Host API 1.15 的托管 Shell 会话；`ctx.terminal.create/list/attach/detach/write/resize/restart/close`。当前批准官方 `com.reai.terminal`，每 App 最多 8 个会话，回放最多 384 KiB；停用、卸载或退出会清理会话及同一 PTY session 的子进程 |

任何本地包都不能因为写进 Manifest 就获得这些能力，Developer Mode 也不例外。

`voice.context@1` 在前台身份无法确认时不读取正文，返回
`windowTextStatus: "unavailable"`，不附正文或应用粗分类。macOS 不读取本 Host 或由同一
Host 拉起的同可执行文件身份代理的焦点正文。正常外部应用的焦点控件正文仍按既有权限、
排除名单、凭据护栏和字节上限采集。共享前台查询、插入/预热与截图合同不变。

`voice.context@1` 会按应用 bundle id / 进程名排除终端与常见密码管理器，并对焦点文字做
凭据形态拦截；但它刻意不读浏览器 URL 或窗口标题，因此无法识别浏览器标签页里的网页密码库。
需要采集窗口上下文的插件必须在自己的权限说明里明确这个边界，不能把它描述成通用防泄漏能力。

⚠️ `agent.session@1`、`cloud.model.invoke@1`、`cloud.workflow.invoke@1`、`voice.deliver@1`、
`voice.context@1`、`terminal.session@1` 与 `local.terminal.exec@1` 是**双层**能力：`requires.hostCapabilities` 与
`permissions` 里必须**同名各声明一次**。
前者是平台放行（只有官方 seed 拿得到），后者是用户在安装时的显式同意——「拿我的账户额度去
调云端」这件事，官方插件同样要问。只声明一半会在校验阶段报 `MANIFEST_REFERENCE_INVALID`；
不这么拦的话，插件能通过打包、装得上，**运行时才炸**，而那时报错指向 Host，作者查不到自己身上。

### 明确保留与受控开放

| 能力或权限 | 当前原因 |
|---|---|
| `surface.worker@1` | 没有独立进程与资源预算 |
| `surface.clipboard@1` | Host API 1.20 起为 grant-gated；仅提供 `ctx.clipboard.writeText(text)`，文本上限 256 KiB，不开放读取、富文本、图片或文件 |
| `surface.file-picker@1` | 不开放通用文件句柄；官方文本编辑器只能走 `local.files@1` Host Broker |
| `bindings.recommended@1` | 键位由用户配置，插件只贡献 Command |
| `local.terminal.exec@1` | macOS 上 Agent `run` 的独立双层权限；仅 mounted+yolo 会话的 awk/wc/sort/diff，见 [受控执行合同](./agent-controlled-run.md) |

不要为未获授能力调用自建网络、shell、剪贴板或文件旁路；Host 会在 Manifest 校验或运行时拒绝。

## 13. 全局限额摘要

| 项目 | 当前值 |
|---|---:|
| Host → 插件事件单消息 | 1 MiB（当前已执行） |
| 插件 → Host 请求单消息 | 1 MiB（命令入口按序列化 UTF-8 字节执行） |
| 每 Runtime 在途请求 | 矩阵保留值 32，当前尚未执行并发计数限制 |
| KV 单值 | 256 KiB |
| KV 每插件总量 | 32 MiB |
| `activate()` 超时 | 10 秒 |
| Surface ready 超时 | 15 秒 |
| Command 最大超时 | 30 秒 |
| 通知标题 | 80 字符（Host 加来源前缀后仍不超过 80） |
| 通知正文 | 500 字符 |
| 网络在途请求 | 每插件 4 个 |
| 网络请求速率 | 每插件每分钟 120 次 |
| 网络 endpoint 声明 | 每插件最多 32 个；每 endpoint 最多 16 个 origin、32 个路径前缀 |
| 网络请求 / 响应 | 普通请求合计1MiB；上传正文52MiB、分块256KiB；响应合计1MiB |
| 网络请求超时 / 重定向 | 30 秒 / 最多 5 次 |
| 通知速率 | 每插件每 10 秒最多发起 5 次请求 |
| 标题栏动作 | 每 App 2 个；label 48 字符；text 12 字符；intent 4096 bytes / 8 层 |
| 本地文本文件 | 单文件 256 KiB；目录列表 500 项；单次序列化 900 KiB；UTF-8 且不含 NUL |
| Package zip | 64 MiB |
| Package 解压后 | 256 MiB |
| Package 单文件 | 32 MiB |

平台全局限额以 `host-support-matrix.json`（`@reai/app-contract` 包内 `host-support-matrix.json`） 为准。通知专用的
80/500 字符与 5 次/10 秒限制目前由 Host 和 Mock Host 的行为测试锁定，以本节通知合同为准。

## 14. 工具接口

当前 CLI 源码入口（在仓库根目录执行）：

```text
bun platform/cli/src/cli.ts validate <appDir>
bun platform/cli/src/cli.ts build <appDir>
bun platform/cli/src/cli.ts contract-test <appDir> [--host-api <版本>] [--suite <文件>]
bun platform/cli/src/cli.ts pack <appDir> --out <输出.reaiapp>
```

尚未实现 `init`、热更新 `dev` 和 `inspect`。完整执行顺序和本机安装步骤见
[插件开发规范](./plugin-development-v1.md)。

## 界面语言（Host API 1.16.0 增量）

本节补充仓库已实现的 1.16.0 语言环境；上文其他接口的核对版本不因此自动升级。实际使用前核对 Host/SDK 分发版本。

```ts
interface LocaleSnapshot {
  readonly locale: "zh" | "en";
  readonly revision: number;
}
interface LocaleClient {
  getSnapshot(): LocaleSnapshot;
  onChange(handler: (snapshot: LocaleSnapshot) => void): () => void;
}
// AppContext.locale: LocaleClient
```

`ctx.locale` 只读、无新增权限；`onChange` 立即回放当前快照并返回退订函数。切换在已打开、后台及后打开的 Surface 生效；插件负责更新已有界面，不重启业务。旧 Host 兼容与资源格式见[插件语言包规范 v1](./plugin-i18n-v1.md)。

SDK 不提供业务词典、全局语言写接口或静态 Manifest 文案解析器。不要直接拼接 `locale.get` / `locale.changed` Bridge 消息；使用公开 SDK 即可。

### Voice model download recovery

`voice.input@1` keeps the existing `voice.models.list`, `voice.models.download` and
`voice.models.cancel-download` methods. Hosts supporting persistent download recovery
include the optional `VoiceModelInfo.resumeAvailable` boolean. `downloadedBytes` can
also describe retained bytes while the model is not downloading. A missing field on
an older Host does not imply support; clients must not promise retained progress.
The existing model state enum and permission requirements are unchanged.

Cancellation requests a stop; it is not synchronous completion. Continue polling until
`state !== "downloading"` before offering resume. `downloadModel` then reuses retained
files bound to the current model version, file sizes and SHA-256 digests. A complete
file is verified before reuse, and all files are verified before atomic installation.
If a source stops supporting byte ranges, the Host reports an error and a subsequent
explicit retry re-downloads only the affected file. Installed models must not be
passed to `downloadModel` merely because they were selected: this method also serves
explicit model updates. Opening a page must not implicitly start a download.


## Voice 录音恢复：识别方式快照（2026-09-12）

`ctx.voiceRecordings.listRecoverableInputSessions({ page, perPage })` 返回尚未转写或失败的输入录音。
`RecoverableVoiceInputSession.requestedEngine?: "local" | "cloud" | null` 是录音开始时的识别意图，
由 Host 的不可变会话选项持久化；它不是成功转写的证明。旧 Host 和旧录音缺少此字段时显示“未记录”，
不能依据当前设置、录音来源（Board/System）或失败状态推断成本地识别。

兼容方法 `ctx.voiceRecordings.transcribeInputSession(recordingId)` 固定使用本地引擎，界面须明确说明；
成功后才显示实际本地转写来源和正文。当前 Voice 使用下方的 1.19 保存录音接口，重试入口按明确选择显示云端/本地；失败、取消和进行中的说明始终与正文分开。
本次仅增加可选返回字段，不新增权限、请求参数或后端网络接口。

云端转写须把 `ctx.aiApi.listModels()` 返回的真实 `kind: "transcribe"` 选项 ID 保存后传给
`ctx.aiApi.transcribe()`；初次明确选择云端时可以使用列表首项，已保存但移除/无效的 ID 必须要求重新选择。
不得用 `transcribe-default` 占位，也不得把未保存的首项显示为已选中。会话启动时固定选项与语言，
Host 仍会在上传前核验选项是否有效；配置失效不能静默切换到另一档位。

### 已保存的 Input 录音重新识别（Host API 1.19）

`ctx.voiceRecordings` 在既有 `voice.recordings@1` 授权下提供以下窄口；启动识别还要求调用方在平台的 `voice.input@1` 授予范围内。它们只读本插件已保存的有效音频区间，不打开麦克风、不要求键盘在线、不调用文字写入。调用方不传音频字节、文件路径或上传地址。

| SDK 方法 | 行为 |
| --- | --- |
| `getInputSession(recordingId)` | 返回本插件录音、单调 `revision` 和最近一次 `attempt` 回执；不存在、过期或不属于调用方返回 `null`。 |
| `transcribeSavedInput({recordingId, attemptId, expectedRevision, selection})` | `attemptId` 为规范小写 UUID；`selection` 冻结 `engine`、公开 `modelId`、可选展示名 `modelName`、`language` 和 `punctEnabled`。同 ID 同参数返回原回执，不重复识别；改参数复用 ID、版本过期或并发竞争均拒绝。 |
| `cancelSavedInput({recordingId, attemptId})` | 精确取消一次尝试，包含取消先于开始到达的情况。返回 `{receipt, upstreamStopped:false}`；不承诺云供应商已停止或退款，不删除音频和文字。 |
| `listRecoverableInputSessions({page, perPage, includeSettledRetries:true})` | 除失败/取消原录音外，也返回带持久尝试的记录，包括完成回执，供界面从保存失败或重启恢复。默认省略此选项保持旧列表语义。 |

回执包含 `recordingId`、`attemptId`、`revision`、`state`（`pending / complete / failed / cancelled / no_speech`）、冻结的 `selection`、成功时的 `transcript`、失败时的 `errorCode`、`startedAtMs / finishedAtMs`。开始和终结各推进一次 revision；文本与回执在同一事务提交。失败、取消和空识别保留原文与原 `stopReason`。进程启动将遗留 pending 终结为 `failed / VOICE_SAVED_INPUT_INTERRUPTED`，不得自动重新出网。

本地识别使用指定的已安装模型和 `auto / zh-CN / en-US`，`punctEnabled` 传给既有 ITN 选项。云端复用 `cloud.model.invoke@1` 的平台 grant、用户 permission、插件 OAuth 和 scope；`modelId` 必须是具体公开转写选项，`transcribe-default` 不可用。展示名不参与路由或授权；云端标点由当前云模型决定，保存的 `punctEnabled` 是请求设置快照，不宣称执行了额外标点处理。任何润色、翻译或备选策略仍属于插件，Host 不自动切模型。

旧的 `transcribeInputSession / setInputSessionTranscription` 保留兼容，但不能写已经进入持久新尝试的记录。Surface 关闭、授权或 owner 代次变化后，晚到结果不得提交。删除音频会同时删除其尝试与取消记录，晚到任务不得复活它们。

新增稳定错误码：`VOICE_SAVED_INPUT_INVALID_REQUEST`、`VOICE_SAVED_INPUT_NOT_FOUND`、`VOICE_SAVED_INPUT_CONFLICT`、`VOICE_SAVED_INPUT_STORAGE_FAILED`、`VOICE_SAVED_INPUT_INTERRUPTED`。取消沿用 `VOICE_CANCELLED`。云转写配置缺失、停用、无效或模型下架返回 `AI_INVALID_REQUEST`，只有暂时无法获取配置返回 `AI_UNAVAILABLE`；前一类不得触发瞬时故障回退。旧 Host 返回 `HOST_CAPABILITY_NOT_AVAILABLE` 时应提示升级，不能静默改用旧固定本地接口。


## 本机外部客户端委托：`ctx.gateway`（Host API 1.20）

Manifest 同时声明 `apps.gateway@1`、`apps.service@1` capability，以及同名 `apps.gateway@1` 用户权限。只可委托插件自己的已声明 web Service 方法，不开放任意 Host API、账号 token 或文件系统。普通本地插件和 Catalog 插件遵循相同门禁。

声明 `apps.gateway@1` 的插件必须使用 `@reai/app-i18n-cli` 的 `reai-app-i18n validate/build/pack`。该工具链在语言校验之外承担现代 Manifest 校验，包括构建前后和打包后的网关声明检查。旧 `@reai/app-cli` 1.2 源码保持已批准产物的固定版本；误用旧工具打出的不合规包仍会被 Host 安装校验拒绝。新旧两批合同样例分别位于 `manifest-fixtures` 和 `gateway-manifest-fixtures`，现代 wrapper 与 Host 均验证两批。

```ts
const connection = await ctx.gateway.issue({
  serviceId: "com.example.tasks/agent@1", methods: ["invoke"], principal: { agentId: "W-1" },
});
const handles = await ctx.gateway.list(); // 本插件的 id/serviceId/principal，无 token
await ctx.gateway.revoke(connection.id); // 仅撤销本插件拥有的连接
```

`issue` 返回 `{id, endpoint, token}`；同进程、同账号、相同范围重试复用同一连接。principal 是提供者定义的小型 JSON object（≤1024 bytes），方法 1–8 个。Host 绑定到 `ServiceCaller.external = {id, principal}`，HTTP 正文或普通插件调用不能伪造它。提供者必须从 caller 验证身份、校验业务 Schema 和归属；Service 的一般 object / 大小规则沿用现有 Broker，Manifest 中的业务 Schema 不是 Host 自动鉴权规则。

Host 按需监听 `127.0.0.1` 随机端口；不要硬编码。外部客户端与 App 必须在同一台电脑或同一 VM：

```text
POST <endpoint>   (http://127.0.0.1:<port>/v1/call)
Authorization: Bearer <token>
Content-Type: application/json

{"method":"invoke","input":{}}
```

成功 `{"result":object}`，拒绝 `{"error":{"code":string,"message":string}}`。拒绝 Origin（包括 null）、非精确回环 Host、查询参数、重复头部与 Transfer-Encoding；不提供 CORS。头部 ≤8 KiB、正文 ≤128 KiB，读取 5 秒限时；最多 16 个并发请求、1024 个进程内连接。并发满时 HTTP 503 / GATEWAY_BUSY。调用使用声明的服务超时且最多 30 秒，包含冷启动；断连、截止时间、权限或身份失效取消当前 Broker 请求。取消不能撤销已经提交的业务结果，调用方必须保留原幂等信封恢复。

凭据只保留 Host 内存；App 退出后失效。账号切换、停用、卸载、拒绝权限会撤销/失效旧连接，重新授权不能复活旧 token；关闭可见页面不删除业务数据，服务可冷启动。签发需要实际登录，匿名快照不签发。进行中的账号代际检测只读内存，不轮询 Keychain。提供者应使用无秘密 handle 列表清理已退休身份，不能依赖某个 WebView 永远存在。

只向当前管理员展示连接用于明确复制；不要记录 token、放在 URL、提交 Git 或给所有子 Agent 共用管理员连接。密钥不赋予操作系统进程或仓库权限，这些仍由外部 Agent 的执行环境授权。
