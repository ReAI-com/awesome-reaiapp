# App、Plugin 与 Device 生命周期 Hooks v1

本规范定义 Driver Host 的统一生命周期：启动阶段可定位、缺失组件可修复、后续扩展有稳定接缝。Hook 是只读观察记录，不允许插件在 Hook 回调中绕开 Host 执行安装、下载或授权。

## App lifecycle

每次进程启动创建一个 `runId`：

`boot.preflight → host.software + firmware.update-check → catalog.refresh → plugins.reconcile → services.probe → readiness.aggregate → ready.normal|ready.recovery|ready.unsupported`

修复时追加 `repair.awaiting_consent → repair.execute → services.probe → readiness.aggregate`。`readiness.aggregate` 与 `ready.*` 可以重入，每次使用新的 `attempt`。

当前 Host 的实际挂钩点如下。阶段名是稳定诊断合同；实现可以扩展子阶段，但不得绕过这些入口另建一次性启动逻辑。

| 阶段 | 当前实际触发点 | 失败影响 |
|---|---|---|
| `boot.preflight` | `LifecycleCoordinator` 创建、数据目录可写 | 启动失败 |
| `host.software` / `firmware.update-check` | Host `version_status(refresh=true)` | 记录失败；本地功能继续，设置页可重试 |
| `catalog.refresh` | 启动时刷新 App Store 签名目录 | 继续使用 LKG/随包目录 |
| `plugins.reconcile` | factory seed 重放、内置插件升级核对 | 保留原插件，不静默扩权 |
| `services.probe` | factory seed 后及每次 App/资源注册表变化 | DSH 不 ready 时进入恢复态 |
| `device.observe` / `device.firmware` | 每个 connection epoch 与 `firmware.changed` | 只影响该设备 run |
| `device.bootloader-lock` | 每次硬件连接边沿调用只读 DFU stuck probe | 失败进入设备修复入口，不阻断 DSH 修复 |
| `catalog.managed-resources` | 用户打开 DSH 修复确认时刷新签名资源目录 | 不允许下载未知或过期制品 |
| `repair.awaiting-consent` / `repair.execute` | prepare/commit/cancel 事务与真实下载进度 | 失败保持旧 active 与 current pin |

### 当前实现与统一目标的差距

| 能力 | 本次合并后的实际状态 | 距离统一流程 | 后续顺序 |
|---|---|---|---|
| 启动阶段与 Hook journal | 已实现。每次启动有独立 `runId`，单 run 最多 512 条，最近保留 20 个 run；下载进度按阶段、1 MiB 或 250 ms 节流 | 低：仍需把更多既有子系统迁入统一 stage，而不是只写各自日志 | 持续按插件规范接入 |
| DSH 缺失检测与门禁 | 已实现。Voice 是优先消费者；调用 App 必须有精确 ref edge，且与 shared active 的版本、摘要一致；会话创建和发送均 fail closed | 客户端已闭环；生产 `client-config` 仍缺 `managedResources`，未发布前干净机器会得到 `CATALOG_UNAVAILABLE` | 先在配置服务发布、签名、回滚演练 DSH 目录 |
| DSH 一键修复 | 已实现。显式确认后断点下载，校验目录签名、archive/manifest/files 摘要与固定 probe，再原子切换 active/ref edge/current pin；UI 显示真实字节进度 | 低：需完成生产目录发布与真实 CDN 验收 | 本轮最高优先级 |
| DSH 正常期可用性 | 已实现。安装后每次启动和 App 注册表变化都会重新 probe；卸载最后一个消费者后 current base-service 仍受 pin/active 保护，不被 GC；未授权插件不能借 shared active 使用 | 低：后续需补后台健康巡检和坏包自动回退到 `previous` 的产品策略 | DSH 生产发布后 |
| App 软件更新 | 已接入 `host.software` 启动 Hook，复用现有 `version_status(refresh=true)` | 中：更新可用尚未进入统一问题清单和一键修复中心 | DSH 后第一批 |
| 固件更新 | 启动时检查；每次连接 epoch 重新读取固件，已有系统任务升级能力 | 中：生命周期 Hook 与统一问题清单/一键升级尚未完全汇合 | 与 DFU 恢复合并推进 |
| 插件更新 | 启动刷新签名 App Store 目录并执行 factory seed reconcile；activate/surface/deactivate 有 Hook | 中高：尚未逐个计算普通已安装插件的可用更新，也未给通用 install/verify/consent/health 全阶段统一 Hook | 插件生命周期 v2 |
| DFU/烧录锁死 | 每次硬件连接边沿执行只读 stuck probe，并记录 `device.bootloader-lock` | 中：失败尚未成为统一问题项，也没有从启动修复中心直接执行恢复 | 固件统一修复阶段 |
| Pi 基础服务 | 保留现有 Pi provider 和 Voice `auto` 回退；本轮不把 Pi 纳入 App `fully_ready` 聚合 | 高：Pi 的受管安装、pin、probe、统一修复未实现 | DSH 稳定后单独立项 |

## Plugin lifecycle

插件由 Host 驱动 `install → verify → consent → activate → health → deactivate`，更新和修复复用同一验证、同意与提交事务。插件只能声明 `requirements[]` 与组件 `lifecycle.activate/deactivate`，不得自行下载可执行代码、读取用户 PATH、替换 Host 信任根或静默授予 consent。

新安装消费者发现本机已有已验证受管资源时，仍须在安装事务、插件详情页或恢复壳中完成显式 consent；之后允许零下载 attach。启动 reconcile 只记录 `attach_pending_consent`，不能弹窗或自动同意。

## Device lifecycle

一个 connection epoch 对应一次可重入设备检查：

`device.observe → device.firmware + device.bootloader-lock`

当前连接边沿会立即调用既有 DFU stuck probe；后续 Device lifecycle v2 会把 transport/mode/configuration 与最终 `device.ready|device.needs_repair` 聚合成独立 device run。

## Hook envelope

```json
{
  "schemaVersion": 1,
  "runId": "uuid",
  "sequence": 12,
  "lifecycle": "app",
  "stageId": "repair.execute",
  "attempt": 1,
  "hook": "progress",
  "targetType": "service",
  "targetId": "com.reai.runtime.dsh",
  "timestampMs": 0,
  "detailCode": "DOWNLOADING",
  "userMessage": "正在修复 DSH 基础服务",
  "progress": { "completed": 1, "total": 2, "unit": "bytes" },
  "retryable": true
}
```

约束：

- `runId + sequence` 单调有序；`attempt` 按 `stageId + targetType + targetId` 递增，每次尝试最多一个 started 与一个终态。
- Hook 与 journal 必须脱敏，不写 token、带查询参数的 URL、用户内容或私有绝对路径。
- journal 按 run 数量和单 run Hook 数双重有界；丢弃旧 Hook 时保留计数和序号范围。
- `gateEnforced` 由 Host 编译期开关决定；关闭门禁不关闭 Hook 和诊断。
- DSH/Pi 的 `fully_ready` 包含已验证 payload、固定 probe 和调用 App 的精确 ref edge；shared active 不能冒充 per-app 授权。

## 正常、恢复与不支持

- `ready.normal`：当前消费者至少可使用一个基础 Agent provider。
- `ready.recovery`：当前 target/channel 受支持但组件缺失、损坏、未授权、目录漏项或 probe 失败；显示可重试修复入口。
- `ready.unsupported`：所有 provider 的编译期 runtime manifest 都明确不支持当前 target/channel。

恢复态只限制依赖 Agent 的 AI 功能；设备、固件、权限、设置和诊断始终可访问。
启动检查时显示检查页；恢复态允许用户进入“受限恢复模式”，因此修 DSH 不会把硬件/固件修复入口一并锁死。
