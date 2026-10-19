# AI 员工版本导航

`index.html` 是本地开发的简单主页，提供三个主入口；原页面及其数据行为保持独立。

| 主入口 | 页面 | 用途 | 数据行为 |
| --- | --- | --- | --- |
| 通用 v2 范式 | [design/paradigm-v2.html](design/paradigm-v2.html) | 对齐通用资料、交付、检查与 Agent 交互 | 内存演示，刷新重置 |
| 原巴奴岗位版 | [showcase.html](showcase.html) | 回看 17 岗位需求和 83 个内置业务看板 | 当前浏览器按岗位保存 |
| 餐饮 v2.1 | [design/restaurant-v2.1.html](design/restaurant-v2.1.html) | 以巴奴风格整合岗位内容与 v2 交互，继续迭代 | 独立内存演示，刷新重置 |

通用 v2.2（[design/paradigm-v2.2.html](design/paradigm-v2.2.html)）在 v2 之上演示租户、客户与案件隔离，入口在主页页脚。`paradigm-v2.html` 保持 v2.1 原样，因为餐饮 v2.1 由它生成。

主页卡片在新标签页打开，便于同时保留三个版本的演示会话。页脚另保留 [原始 v1 运行模板](preview.html)。这些页面均为本地 UI/UX 演示；源码合并不代表插件已安装、送审、上架或部署。

## 本地开发

在完整仓库安装依赖后，从 `plugins/ai-employee` 启动已有开发命令：

```sh
bun run dev:showcase
```

访问 `http://127.0.0.1:4188/`。已有 4188 服务无需重启即可看到新增主页。原来的四个直达地址继续有效。

餐饮 v2.1 的生成源码位于 `src/restaurant-v21/`，修改后生成页面，不手改生成 HTML：

```sh
bun scripts/build-restaurant-v21.ts
bun test tests/restaurant-v21-catalog.test.ts tests/restaurant-v21-generation.test.ts tests/restaurant-v21-runtime.test.ts
```

交互合同以 [通用 v2 文档](../../docs/ai-employee-pattern-v2.md) 为准；餐饮映射和未接入范围见 [RESTAURANT-V2.1.md](RESTAURANT-V2.1.md)。

## 构建全部预览入口

```sh
bunx vite build --config vite.versions.config.ts
```

独立配置输出到仓库忽略的 `.artifacts/employee-versions/dist/`，包含主页、三个主版本、v1 模板及依赖资源。保留整个输出目录并通过静态 HTTP 服务打开 `index.html`；不只复制主页。Markdown 说明保留在源码目录，主页中的说明链接指向 GitHub main。

该构建仅用于版本预览；插件 Host 入口、Manifest 版本和已有构建脚本保持不变。正式 Host 安装、模型权限与业务系统接入须单独实现和验收。
