# 文件

ReAI 插件 `com.reai.files`。当前源码版本为 `1.2.0`。用户把本地文件夹或云项目授权给插件后，在 ReAI 中浏览、编辑和整理其中的文件。插件只通过 Host 的 `resources.files@1` 接口访问文件，拿不到绝对路径或云端凭据；每次调用都由 Host 复验平台批准、用户同意和所选根目录。

## 能做什么

- 授权：「添加文件夹…」打开 Host 原生选择面板。授权按账号与插件保留，可在工具栏移除，或在插件权限中关闭。
- 浏览：进入子文件夹、路径条、返回上一级、分页加载和刷新。
- 文本编辑：不超过 1 MiB 的 UTF-8 文本可打开、编辑和保存。保存按打开时的版本做冲突检查，写入经过分块传输与 SHA-256 校验。
- 整理：新建文件或文件夹、重命名、删除。删除前确认，只删除文件和空文件夹。
- 导入与导出：在两个由用户亲自选择的授权文件夹之间有界复制（不超过 50 MiB），同名自动编号，不覆盖已有文件；失败或取消时尽力删除刚建的空文件。
- 冲突：保存时文件已被别处修改，会保留草稿，并提供「重新加载」或「另存为新文件」。
- 撤权：授权失效后回到选择文件夹状态。未保存的文字只保留在当前页面内存中，不写入磁盘、日志或诊断。
- 云项目：输入项目 ID 或粘贴项目链接后，由 Host 核对项目权限并弹出原生确认。云根与本地根共用同一套浏览、编辑、冲突检查和整理操作。当前包没有声明插件云连接，只支持手动输入项目。
- 诊断：错误码与插件、ReAI 版本只在 Host 开发者模式中显示。

## 清单与授权

`requires.hostCapabilities` 包含 `resources.files@1` 与 `system.tasks@1`，`permissions` 声明同名的 `resources.files@1`。`ctx.resourceFiles` 由 `../../packages/sdk` 提供。`resources.files@1` 需要平台批准；后端审核能力表同步前，提交预检使用 `--server-contract v105-capabilities-pending`，不得据此上传。

## 本地构建

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run lint
bun run validate
bun run build
bun run test:contract
bun run pack
bun run preview   # 127.0.0.1 合成数据预览
```

`src/fixtures.ts` 是只供测试与预览的内存替身，生产入口不导入它。本目录依赖 `../../packages/` 中的 SDK 与工具，构建产物不提交到 Git。

## 已知限制

- 与其他程序同时写同一文件时，Host 侧冲突检查仍有极小竞态窗口。
- 每次「选择其他文件夹…」都会新增一个持久授权，需要时在工具栏移除。
- 暂不支持移动、多选、二进制预览和超过 50 MiB 的复制。
- 当前只是源码候选。真实 Host 安装、用户授权、平台审核和商店发布需要各自的验证证据。开发与安装要求见 [开发规范](../../docs/plugin-development-v1.md) 和 [提交规范](../../docs/plugin-submission-v1.md)。
