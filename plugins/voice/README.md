# 语音输入法

ReAI 插件 `com.reai.voice`。当前源码候选为 `2.15.0`（送审版本，未上架）；平台已批准的公开版本为 `2.14.8`（2026-10-25 审核通过并上架）。通过语音键录音，将识别或润色后的文字写入当前应用。支持全天时间线、云端转写、翻译和 Agent 对话。

Agent 会话使用版本化服务接口。界面不再提供工作目录选择入口。存量对话的已授权目录继续由 Host 复验。Host 控制目录范围和命令权限。复制诊断使用固定字段，不包含转写、回答、凭据或自定义模型路径。语言覆盖见 [I18N_COVERAGE.md](I18N_COVERAGE.md)。

共享工具中的能力审核种子包含 `2.14.7` 的源码审核记录；`2.14.8` 与 `2.15.0` 送审都使用本地独立源码审查证据（未写入共享种子）。源码审核记录只用于提交前校验，不能代替平台对最终包摘要的批准。

## 当前版本变化

`2.15.0` 在 `2.14.8` 之上：界面只剩一个「Agent」（不再出现引擎名与 Agent 配置页）；Agent 读工作范围外的文件夹只确认一次、之后记住；按键触发时按拨杆档位决定新会话能不能改文件；结果弹窗还显示着时再按语音键是续接那条对话（详见更新日志）。Manifest 受控能力集、权限项与 Host API 范围与 `2.14.8` 相同，只有 `agent.session` 两项权限说明去掉了引擎名。

`2.14.7` 在 `2.14.6` 之上只修复 PDF 附件解析：解码缓冲接近 16 MiB 预算时按比例扩容，不再每解出一小块就整段重新分配和复制。累计解码预算、分配前拒绝和 Worker 时限保持不变。

`2.14.6` 及其开发候选带来的主要变化：

- 设置的记录保留中增加「全天存档」开关，读写 Host 时间线设置；失败时回到 Host 真值并给出原因。
- 接入共享音频片段：持续录音开启、界面已挂载且 Host 批准对应能力时，键盘语音输入可以复用按键前后的音频片段。
- 录音来源改为五档内置策略：自动、硬件优先、电脑优先、只用硬件麦、只用电脑麦。没有对应麦克风的档位会禁用并说明原因。
- 页面接入公开的 Surface 导航与布局，支持完整的返回和菜单；最低 Host API 为 1.25。
- 设置中的云端模型只显示名称；语音列表的复制按钮在悬停或键盘聚焦时显示，触屏设备保持可见。

此前候选增加了 PDF、XLSX 和 XLS 附件正文提取及对应的格式与大小防护，详见 [更新日志](CHANGELOG.md)。这些源码变化尚不代表平台批准、签名、已安装插件更新或商店发布。当前设置页的版本和关于入口尚未完成，要求见 [设置页与版本规范](../../docs/plugin-settings-and-release-notes-v1.md)。

## 本地构建

先在仓库的 `packages/` 目录安装冻结依赖，再在本目录执行：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run validate
bun run build
bun run test:contract
bun run pack
```

本目录依赖 `../../packages/` 中的 SDK 和工具。`prepare:documents` 从固定依赖生成 PDF 和表格 Worker、字符映射与字体资源，并保留第三方许可证。测试、构建和打包命令会执行该步骤。文档资源及生成 reader 属于可复现源码输入。构建生成的 `dist/`、`build-manifest.json` 和 `.reaiapp` 不提交到 Git。

## 提交检查

复制 `submission.identity.example.json` 为本地 `submission.identity.json`。模板的 `publisherId`、`oauthAppId` 和 `productId` 都是虚构占位，必须替换为实际平台配置。模板不能用于上传，也不代表审核批准。替换后核对 Manifest 的发布者、OAuth App 和版本与本地配置一致。不要在配置里保存密钥。

普通 `bun run pack` 不读取提交身份；提交检查和 `pack:submission` 才读取本地配置。

`submission.identity.json` 保存提交配置。Manifest 的发布者、OAuth App 和版本必须与提交配置一致。Product ID 只用于提交配置。OAuth Client ID 是公开标识，凭据由 Host 管理。

```sh
bun run check:submission --form-version <实际版本>
bun run pack:submission
```

提交打包会检查身份、重复构建和包内资源。表单版本必须与最终包一致。

开发与安装要求见 [开发规范](../../docs/plugin-development-v1.md) 和 [提交规范](../../docs/plugin-submission-v1.md)。本地测试和打包只证明本地结果。真实 Host 安装、用户授权、平台审核和商店发布需要各自的验证证据。
