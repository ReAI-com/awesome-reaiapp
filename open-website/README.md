# ReAI Open · 开放平台站点

目标域名：`open.reai.com`。站点具有独立导航的中英文页面，保留已确认品牌 Logo。2026-10-26 已发布浅色与绿色的新首页，首屏展示官方设计动效，目录和详情页沿用原有样式。访问 [open.reai.com](https://open.reai.com/) 或[英文入口](https://open.reai.com/en/)。已接入现有匿名公共 Catalog。站点定位为公开的文档与插件介绍网站，无注册、登录、用户中心或投稿后台。

## 页面与内容

| 入口 | 第一版内容 |
| --- | --- |
| `/` | 首页、精选插件、组合场景与开发者入口 |
| `/apps/` | 公共 Catalog 中的已发布插件，支持搜索、分类和刷新保留筛选 |
| `/apps/<appId>/` | 公开商店介绍、开发者、公开版本、图标及真实素材（保留演示图标注） |
| `/apps/<appId>/changelog/?version=<version>` | 精确版本入口和版本查找；没有记录时明确显示未收录 |
| `/showcase/` | 内容创作、研究开发、设备诊断三个组合场景 |
| `/showcase/<slug>/` | 场景步骤、用到的插件、预期结果与适用边界 |
| `/developers/` | 开发路径、SDK、设计、审核与版本规范入口 |
| `/docs/` | 既有 VitePress 文档整合，中文23篇完整规范，英文23篇阅读指南，支持深链接、搜索和返回平台 |

插件展示使用现有 [匿名公共 Catalog](https://block2-api.wainao.chat/public/client-config?groups=appStore)，读取 `groups.appStore.apps`：名称、短文案、介绍、开发者、分类、`latestRelease.version`、`iconUrl` 和截图。以 appId 关联详情；只保留审核通过记录的展示字段，不导出 OAuth / Project / Publisher 内部标识、审核 ID、安装包下载信息或本地 Manifest 权限。2026-10-02 实测返回7个插件；此数量随公开发布变化，不写死在页面中。

构建期匿名 GET 生成公开快照供首屏使用；首页、目录、详情和日志页打开后再刷新公共 API。请求使用 `credentials: omit`，不携带用户 Cookie、Authorization 或账户令牌。当前线上 CORS 为 `*`，不需要改变后端权限或新增网站账号。接口暂时不可用时显示最近一次构建获得的公开快照并提示刷新失败；构建无法取得合法 Catalog 时失败，不退回本地候选冒充已发布内容。

图标直接使用公开接口提供的素材 URL，当前视觉为临时官方素材，并非最终设计定稿。作者修改草稿或本地素材不会立即改变公开内容；更新发布版本后，页面按公共接口的缓存策略读取新的公开文案和图标。首页的精选顺序是展示选择规则，插件数据不是手工副本。

公共 API 暂未提供逐版本介绍；日志页面保留未收录状态，不用本地候选说明替代公开版本记录。自动撰写要求仍由根 `AGENTS.md` 和[版本规范](../docs/plugin-settings-and-release-notes-v1.md)管理，公共日志同步服务另行实现。案例继续作为组合场景说明，未发布的场景工具不出现在关联插件卡片中。

## 已确认的品牌 Logo

2026-10-02 确认候选1和3：页头及页脚使用 [黑绿透明底 Logo](assets/reai-logo.svg)，站点 favicon 使用 [白色圆角底图标](assets/reai-app-icon.svg)。保留原始形状与颜色，公开来源说明及摘要见 [brand-sources.json](assets/brand-sources.json)。

候选4的旧绿色麦克风品牌标识已废弃，已从本项目候选页和临时 SVG 副本移除，不再作为平台 Logo。此项不涉及其他项目的源码清理。候选对照页保留原编号，并标明1和3已确认、2未选。

## 本地构建与预览

使用本机 Node.js、Bun 和 Python 3。文档依赖复用 `website/`；首次使用如缺少依赖，在该目录执行 `bun install --frozen-lockfile`。开放平台自身不新增第三方运行依赖。

```sh
cd open-website
bun run build
bun run test
bun run preview
```

打开 [本地站点](http://127.0.0.1:4318/)。预览仅监听 `127.0.0.1`，服务 `dist/`，支持文档 clean URL、插件深链接刷新和真正的404状态。新增公开 appId 可由静态通用详情页读取目录并展示；正式部署需为 `/apps/<appId>/` 与其日志路径配置静态模板回退，不能把整个网站的未知地址回退为首页。不要直接打开源码 `index.html`，它依赖构建生成的目录数据。

`bun run prepare:preview` 与构建命令相同，预览和交付统一使用 `dist/`，不向源码模板写入生成页面。构建不会执行远端发布，也不包含候选 Logo 对照页。

## 维护位置

- 公开数据适配与详情：`public-catalog.js`；页面模板：`scripts/templates.mjs`；场景：`scripts/content.mjs`。
- 首页：`index.html`、`home.css`、`home.js`；首屏播放从官方设计稿直接渲染的动效；公开目录等共用交互：`app.js`；其余页面共用样式：`styles.css`、`pages.css`。
- 文档事实源：仓库 `docs/`，复用 `website/` 构建，避免内容分叉。
- [设计调研与方向取舍](design-direction.md)保留首版视觉依据。

线上文档现提供 [open.reai.com/docs](https://open.reai.com/docs/) 与[英文指南](https://open.reai.com/docs/en/)，旧 [ai-board.reai.com/docs](https://ai-board.reai.com/docs/) 继续保留。安装分发、客户案例、插件设置页改造和服务器版本介绍服务分别验收；网站上线不表示这些已完成。

## 中英文与下载

默认中文，英文使用 `/en/`；`i18n.js` 是静态构建与运行态共用的语言资源。切换保留当前页面、搜索/分类/版本参数及滚动位置；公开 appId 不变。文档对应使用 `/docs/en/`。英文文档明确标为阅读指南，完整字段、示例和历史参照中文原文。公共 Catalog 目前是单语言内容，发布者文案不擅自替换。

下载入口分别链接到现有官网 `/zh/download` 和 `/en/download`，实际安装包与版本由官网的公共接口提供，不在本网站写死下载版本。

## 发布

发布检查见 [deploy/README.md](deploy/README.md)。真实主机、配置、目录和回滚命令保留于本地。当前发布标识见 [release.json](https://open.reai.com/release.json)。部署只上传网站静态产物。

2026-10-03：最终候选构建及8项测试通过；317个线上文件摘要与候选一致；真实浏览器确认中英文及对应语言下载入口，公开 Catalog 刷新、版本参数、文档往返和移动端布局。

## 验证

2026-10-02：构建和6项测试通过，覆盖本地规范数据校验、公开 Catalog 字段隔离/无凭据请求/接口失败、内容转义、整站链接及文档返回/锚点回归。真实浏览器确认公共接口刷新成功、7个远端图标加载、公开详情、手机目录定位及文档客户端换页后返回首页；375 / 768 / 1024 / 1440px 的20次页面布局检查无整页横向溢出。详细验收材料保留于本地。VitePress 保留已有部分 chunk 超过500kB的构建提示。

## 已发布首页与动效

新首页采用集中首屏、公开插件目录、使用场景、开发入口、常见问题与探索入口。使用 Manrope 可变字体并从本站加载，中文使用本机中文字体；字体许可证见 `legal/Manrope-OFL.txt`，也随构建进入 `THIRD-PARTY-NOTICES.txt`。

- 首屏直接展示官方语音输入法的设计预览：保留主稿的窗口、侧栏、配色、控件、演示记录与回听交互。没有自绘工具箱，也没有自绘语音笔记/研究面板。
- 动效进入视野后自动播放；移出视野、切到后台或用户手动暂停时停止。系统减少动态效果或 `?still` 显示官方原稿的静态帧，不请求视频。
- 桌面采用左右排版，手机采用紧凑单列，使动效本体在首次打开的可见区域内出现。
- 下方应用场景只保留文字入口。手机导航继续使用原生对话框，FAQ 使用原生折叠组件。
- 页面标记「官方设计预览」；设计稿演示数据不作为实机录屏、已发布功能或真实操作结果的证明。

## 首屏动效导出

参照关联项目 `ai-vibe-board/design/README.md` 指定的唯一标准 `VoiceType_UI_Designs.html`，不使用同目录尚未确认的新皮肤尝试稿。主稿保持只读。导出用独立 Chromium 打开原始 HTML、进入现有输入详情并点击原有回听控件；只对原稿 DOM 内容添加进出场，不重画产品界面。

需要 Node.js 可解析的 `playwright` 包及专用 Chromium、Python 3 的 Pillow 和 `ffmpeg`。

```sh
REAI_DESIGN_ROOT=/path/to/ai-vibe-board/design node scripts/export-motion.mjs
```

12 秒循环：内容逐步进入 → 回听进度 → 恢复原始状态 → 内容淡出；窗口和背景始终保留。网站使用 `assets/hero-motion.mp4` 和 `assets/hero-poster.png`。其他材料写入仓库忽略的 `.artifacts/hero-motion/`：

- `reai-home-hero.mp4`：最大 1920px、60fps、H.264 / yuv420p。
- `reai-home-hero.gif`：800×500、20fps、无限循环。
- `reference.png`、`verification.json`、`contact-sheet.jpg`：原稿静态对照、像素检查与关键帧。原稿来源摘要留在本地证据中。

`--proof` 只生成原稿对照和首帧；`REAI_MOTION_OUTPUT` 指定本地产物目录，`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 可指定专用测试浏览器。

2026-10-26 发布标识为 `20261026T101300Z-55e2b53dfabf`。候选构建和 8 项测试通过；374 个线上文件摘要与候选一致。线上浏览器验证中英文桌面与手机首屏、视频自动播放与暂停恢复、减少动态效果、手机导航；HTTPS 路由、视频分段请求和未知地址 404 正常。保留旧版本与旧文档静态资源。发布记录中的 `workingTree: modified` 表示本次使用已验收的工作区产物，网站上线不代表 GitHub 源码已推送或合并。

2026-10-29 插件切换动效版发布标识为 `20261029T111425Z-ac7186cd60ef`（gitCommit `41eda621`，#40 合并后构建）。构建与 9 项测试通过；369 个线上文件逐一校验摘要后原子切换；中英文 8 组视口 still 模式、三选项播放与全部交互在线上验证通过。

## 插件切换版

顶部选择 Typezero、浏览器或 Terminal，查看各自的动效、说明和详情入口。选项由公共 Catalog 过滤，默认展示 Typezero 语音胶囊的完整故事：语音键唤起，短句转写后写入光标；接着说一件任务，胶囊退到角落后台处理，完成时弹出系统提醒。四步演示流程对应视频时间点。键盘唤起、胶囊转写、后台任务与完成提醒都属于 Typezero 语音输入的交互，不再作为 Codex Link 的展示内容；Codex Link 的详情页继续在目录中介绍。视频不是实机录屏，也不证明当前安装版本已提供全部演示能力。

`home-previews.js` 管理插件映射与步骤时间；`scripts/hero-preview.mjs` 生成首屏。`home.js` 支持点击、方向键、Home/End、暂停、重播及 `?plugin=voice|browser|terminal` 直达。切换语言保留选项，一次只加载当前视频；系统减少动态效果与 `?still` 只加载海报。

素材使用正式设计与原插件界面：胶囊来自主稿嵌入的 `global-task-capsule.html` / `voice-flow-embed.js`，终端来自主稿原生工作区控件，浏览器直接渲染 `plugins/browser/src/browser-view.ts` 与原样式。终端只替换样例中的私人账号与路径；浏览器注入公开样例标签。未启动 Host、访问用户会话或执行终端命令。

```sh
REAI_DESIGN_ROOT=/path/to/ai-vibe-board/design node scripts/export-plugin-previews.mjs
```

输出至 `assets/previews/`。voice 为 24 秒合并故事（语音输入写入 + 语音任务后台与完成提醒），browser 与 terminal 为 10 秒；均为 1920×1200、60fps。帧、原稿摘要、像素检查与接缝检查留在本地忽略目录。`--only=terminal` 可仅重导一条；`--proof` 只生成关键帧，不发布或替换站点视频。

2026-10-26 本地验证：构建和 9 项测试通过；四条视频的原稿首帧、循环首尾、空闲段及内容边界检查通过。独立 Chromium 检查中英文、4 种屏幕尺寸与4个选项，共32种首屏状态，无横向溢出，视频完整进入首屏；切换、方向键、暂停/恢复、重播、离屏暂停、减少动态效果、语言切换保留选项、加载失败后重试和手机导航通过。动效仍为设计与样例数据预览，未验证实机硬件或真实任务执行；本版尚未生产发布。
