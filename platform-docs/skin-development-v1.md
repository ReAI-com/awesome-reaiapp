# Driver V2 皮肤插件开发规范（Skin v1）

Skin v1 是一种独立的 `.reaiapp` 包。它复用普通插件的签名、审核、下载、摘要校验、安装、更新与卸载事务，但不运行插件代码。Host 读取包内声明式 `skin/skin.json`，用自己的通用渲染器重组导航、顶栏、插件入口、页面密度和视觉 token。

这不是“只换颜色”的主题：皮肤可以把默认侧边栏改成工作轨，也可以改为顶部导航 + 底部插件 Dock，并改变页面卡片编排和信息密度。业务数据、权限、系统安全区、Host 原生控件和插件 WebView 隔离仍由 Host 持有。

> 当前发行状态：能力与本地安装链路已经实现；生产 Catalog 暂无皮肤上架，因此未安装皮肤时设置页不显示“皮肤”选项。仓库内 Codex / Claude 仅为协议 demo，不随 App 安装、不进入内置 seed，也不在首批 App Store 提供。

## 1. 包结构

```text
my-skin/
├── app.manifest.json
├── package.json
├── bun.lock
├── tests/
│   └── skin-package.test.ts
└── skin/
    └── skin.json
```

`app.manifest.json` 使用 Manifest 1.1，并把包类型声明为 `skin`：

```json
{
  "manifestVersion": "1.1",
  "packageType": "skin",
  "appId": "com.example.skin.my-style",
  "version": "1.0.0",
  "publisherId": "example",
  "name": "My Style",
  "targets": [
    { "platform": "macos", "architectures": ["aarch64", "x86_64"] },
    { "platform": "windows", "architectures": ["aarch64", "x86_64"] }
  ],
  "hostApi": { "range": ">=1.10.0 <2.0.0" },
  "requires": { "hostCapabilities": [], "hardwareServices": [], "appIntents": [] },
  "runtime": { "components": [] },
  "skin": { "apiVersion": "1", "entry": "skin/skin.json" },
  "permissions": [],
  "network": { "policyVersion": 1, "endpoints": [] },
  "billing": { "mode": "none" },
  "data": { "privateStores": [], "imports": [], "exports": [] },
  "contributes": {}
}
```

关键字段：

| 字段 | 类型 / 取值 | 说明 |
|---|---|---|
| `packageType` | 固定 `"skin"` | 缺省仍表示普通 App，不能省略 |
| `skin.apiVersion` | 固定 `"1"` | Skin 协议版本，不等同于包版本 |
| `skin.entry` | 固定 `"skin/skin.json"` | v1 唯一入口 |
| `runtime.components` | 固定空数组 | 皮肤不创建 Runtime 或 WebView |
| `permissions` / `network.endpoints` | 固定空数组 | 皮肤不能读取用户数据或联网 |
| `contributes` | 固定空对象 | 皮肤不能贡献 Surface、Command、Intent 或任务 |
| `oauthAppId` | 禁止 | 皮肤不建立 OAuth 身份 |

## 2. `skin.json` 接口

完整骨架：

```json
{
  "schemaVersion": 1,
  "metadata": {
    "name": "My Style",
    "description": "给用户看的简短说明"
  },
  "shell": {
    "variant": "left-rail",
    "brand": { "wordmark": "MY APP", "kicker": "WORKSPACE" },
    "primaryOrder": ["home", "device", "extstore", "installed", "terminal", "settings", "account"],
    "searchPlaceholder": "搜索任务或插件"
  },
  "layout": {
    "railWidth": 76,
    "topbarHeight": 112,
    "dockHeight": 72,
    "radius": 8,
    "density": "compact",
    "pagePreset": "console"
  },
  "tokens": {
    "light": { "...": "必须完整提供 39 个公开 token" },
    "dark": { "...": "必须完整提供同一组 39 个公开 token" }
  }
}
```

### 2.1 元数据与外壳

| 参数 | 允许值 / 范围 | 实际效果 |
|---|---|---|
| `metadata.name` | 1–48 字符 | 设置页和商店中的皮肤名 |
| `metadata.description` | 1–160 字符 | 皮肤说明 |
| `shell.variant` | `left-rail` | 左侧工作轨 + 顶部命令栏；插件入口进入工作轨 |
|  | `top-bar-bottom-dock` | 顶部主导航 + 底部插件 Dock |
| `shell.brand.wordmark` | 1–32 字符 | 外壳品牌文字；v1 不接受 HTML、SVG 或图片 |
| `shell.brand.kicker` | 1–48 字符 | 标题栏/外壳辅助标识 |
| `shell.primaryOrder` | 7 个固定 Host 页面 ID 的完整排列 | 允许重新排序，不允许删除或新增页面 |
| `shell.searchPlaceholder` | 1–64 字符 | 全局搜索输入提示 |

`primaryOrder` 必须恰好包含一次：`home`、`device`、`extstore`、`installed`、`terminal`、`settings`、`account`。皮肤可以移动入口，但不能藏掉设备、商店、设置或账户等 Host 功能。插件自己的入口由 Host 动态插入，皮肤包不能写死已安装插件列表。

### 2.2 布局参数

| 参数 | 范围 / 枚举 | 说明 |
|---|---|---|
| `railWidth` | 56–104 px | `left-rail` 的工作轨宽度；另一结构保留但不消费 |
| `topbarHeight` | 76–140 px | 结构顶栏总高度，已包含 macOS 44px 原生标题栏安全区 |
| `dockHeight` | 56–96 px | `top-bar-bottom-dock` 的 Dock 高度；另一结构保留但不消费 |
| `radius` | 0–24 px | Host 外壳、面板和卡片的圆角尺度 |
| `density` | `compact` / `comfortable` | 导航、插件入口与 Dock 的交互密度 |
| `pagePreset` | `console` / `editorial` | Host 页面内容宽度、统计卡网格、间距和标题排版 |

Skin v1 有意提供“有限但结构级”的组合，而不是接受任意 CSS 选择器。这样皮肤能显著改变 UI/UX，同时 Host 升级页面 DOM 时不会让已安装皮肤整体失效。

### 2.3 Semantic token

`tokens.light` 与 `tokens.dark` 都必须完整、且只能包含下列 39 个键：

```text
accent, accent-glow, accent-soft,
alert, alert-line, alert-soft,
bar-bg, bar-border, bar-shadow, bg,
bound, bound-line, bound-soft,
cap-accent, cap-bg, cap-dim, cap-shadow, cap-text, cap-wave,
card-bg, card-border, card-shadow, desk-bg, divider,
panel-bg, panel-border, panel-shadow, panel-sub, panel-text,
scroll-thumb, scroll-thumb-hi,
text-primary, text-secondary, text-tertiary,
toggle-active, toggle-bg,
warn, warn-line, warn-soft
```

值是 CSS property value 文本，每项 1–160 字符。允许颜色、`rgba()`、渐变和阴影；禁止 `url()`、`@import`、`expression()`、分号和花括号。完整值可从仓库 demo 复制后修改：

- `plugins/examples/skins/codex/skin/skin.json`
- `plugins/examples/skins/claude/skin/skin.json`

Host 会把同一组已校验 token 同步到主壳、原生 Title Bar realm、Host Overlay 与插件 Surface。切换明暗主题时只在当前皮肤的 `light` / `dark` 两组之间切换。

## 3. 允许修改与禁止修改

### 允许修改

- 主导航放在左侧还是顶部，插件入口放在工作轨还是底部 Dock；
- Host 固定页面入口的顺序；
- 搜索框位置随结构变化，以及提示文字；
- 页面密度、内容编排预设、外壳尺寸和圆角；
- 明亮 / 暗色下全部公开 semantic token；
- 皮肤的纯文字名称、说明、wordmark 与 kicker。

### 禁止修改

- 业务数据、设备状态、插件内容、账户状态、权限判断和导航目标；
- macOS 交通灯、44px 原生 Title Bar 安全区、Host 通知和系统任务的所有权；
- 插件 WebView 的 DOM、脚本、网络和存储隔离；
- 注入任意 JavaScript、HTML、CSS 规则、选择器、远端字体或网络资源；
- 删除 Host 必需页面、伪造插件入口、覆盖用户安装/启用状态；
- 申请任何插件权限、OAuth、网络、私有存储或后台 Runtime。

### 素材支持状态

Skin v1 暂不开放图片、字体、SVG 等自定义素材。包格式已经保留未来扩展空间，但在 Host 建立素材 MIME 白名单、尺寸预算、解码安全和跨 realm 分发合同前，额外文件不会成为皮肤接口。不要通过 token 的 `url()` 绕过；CLI 与 Host 都会拒绝。

## 4. 构建、测试与安装

每个皮肤样例也是独立包。进入它自己的目录，用提交的冻结 lock 运行：

```bash
cd plugins/examples/skins/codex
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

`build` 会同时校验 Manifest、`skin.json` 结构、尺寸、完整 token 集和危险值，并生成互斥的 `skinEntry` Build Manifest；Host 安装时会独立再校验一次，不能信任客户端构建结果。

仓库内 `file:` 依赖只用于联调。正式验收还要把 Platform CLI 打成 tarball，将皮肤源码复制到仓库外，
用 tarball 安装后重复测试、构建和两次打包，并确认两个 `.reaiapp` 摘要一致；仓库统一入口是
`make plugin-examples-verify`。

本地测试需要在 Driver V2 开启 Developer Mode，再导入 `.reaiapp`。安装成功后：

1. 设置页“外观”区自然出现“皮肤”行；
2. 默认 Aura 始终保留为回退项；
3. 切换皮肤只写后端 `app-preferences.json`，不使用前端 `localStorage` 作为事实源；
4. 卸载当前皮肤时 Host 先回退 Aura，再移除包；
5. 皮肤缺失、损坏或版本不兼容时启动也回退 Aura。

没有外部皮肤安装时，“皮肤”行完全不渲染，用户只看到默认 Aura，不出现只有一个选项的伪选择器。

## 5. App Store 上架约定

未来 Catalog 条目用 `packageType: "skin"` 和 `category: "Skins"` 标识皮肤，且不得提供 `oauthAppId`。客户端只有在真实 Catalog 中出现至少一个皮肤条目时才显示 Skins 分类。

皮肤与普通插件走同一套审核包摘要、发布者、版本和不可变 release 绑定；安装后进入独立皮肤列表，不进入普通 Extensions 侧栏和 Runtime。`official` 仍只影响徽章，不授予额外能力。

Codex / Claude demo 目前只作为仓库测试夹具。它们不是默认皮肤、不是内置包、不是 Catalog seed；要公开上架必须另行完成品牌、版权、视觉质量、跨平台和兼容性审核。

## 6. 兼容与演进规则

- Manifest 缺少 `packageType` 时保持普通 App 语义，现有插件不受影响；
- `skin.apiVersion` 是皮肤协议兼容边界；Host 不认识的版本直接拒绝，不猜测降级；
- `deny_unknown_fields` / `additionalProperties: false`：写错字段必须失败，不能静默忽略；
- Skin v1 的结构枚举与 token allowlist 在同一大版本内保持兼容；新增能力优先增加新可选参数或 Skin v2；
- Aura 是 Host 内置且永远可用的安全回退，不由插件包覆盖；
- 皮肤只能改变呈现，不得改变权限、数据或行为语义。若未来开放自定义素材或更多布局槽位，会先增加机器可读 schema、CLI/Host 双侧校验和文档，再允许商店提交。
