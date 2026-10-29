# 铆钉部署

本目录提供 `https://maoding.reai.com` 的独立部署模板。应用运行在一个非 root 容器中，Nginx 终止 HTTPS；只有 `127.0.0.1:14317` 暴露给宿主机。数据库、上传文件、看板和 Agent 配置全部保存在专属 Docker volume `maoding_data`。不要运行多个应用副本或让多个实例共享此数据卷。

## 构建与配置

需要 Docker Compose v2、Nginx、Certbot，以及 Node 22.19 以上的基础镜像。Dockerfile 在 Linux 中重新执行 `npm ci --include=dev` 和 `npm run build`；`tsx` 是生产入口需要的依赖。不要上传本机 `node_modules`、`.data`、`.env` 或 `.artifacts`。

在独立项目目录中准备配置：

```sh
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

填写 `WAINAO_OAUTH_CLIENT_ID` 和经 OAuth 服务验证的管理员用户 UUID `WAINAO_ADMIN_SUBJECTS`。多个 ID 用逗号分隔。`WAINAO_ALLOWED_SUBJECTS` 指定额外允许使用工作台的用户；管理员仍须在管理员名单中。保持 `WAINAO_ALLOW_SITE_ADMINS=false`，明确登记本项目管理员。OAuth 应用的回调地址为 `https://maoding.reai.com/api/auth/callback`。

`WAINAO_OAUTH_DEVELOPMENT` 默认 `false`。新 OAuth 应用在审核前需要授权自测时，可暂设 `true`，通过 HTTPS 仅向已在身份名单中登记且具备该 OAuth 应用开发资格的用户开放。此阶段用于收集真实授权与验收证据；OAuth 应用正式发布后设回 `false` 并重建应用容器。开发参数不会替代本项目身份名单或管理员校验。

应用默认连接外脑官方 API。模型凭据或 OAuth token 不写入 Dockerfile、镜像构建参数、前端包或公开部署文件。`.env` 只供部署者读取。首次使用空数据卷；已有本机数据和凭据的迁移需要单独确认、备份并处理其中的绝对路径。

将 `MAODING_RELEASE` 改成唯一版本标签；可通过 `MAODING_NODE_IMAGE` 指定已经核验的 Node 镜像 tag 或 digest。以下命令始终显式指定配置文件，避免读取其他项目的 Compose：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml build app
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --no-build app
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

容器以 UID/GID `1000:1000` 运行。首次创建 named volume 时 Docker 继承镜像内数据目录的所有权；复用已有卷时需先核对权限。不要通过挂载其他项目目录、Docker socket 或宿主机凭据来解决权限问题。

## HTTPS 与 Nginx

先确认目标主机、DNS、端口和现有 Nginx 布局。只新增铆钉自己的虚拟主机；不要替换全局 `nginx.conf`。模板使用 Certbot webroot `/var/www/certbot`。如宿主机采用其他 webroot，需同步修改两个模板与签发命令。

1. 安装 `nginx/maoding.http.conf` 为专属虚拟主机，执行 `nginx -t`，通过后 reload Nginx。
2. 使用现有 Certbot 账户为域名签发独立证书：

   ```sh
   certbot certonly --webroot --webroot-path /var/www/certbot --cert-name maoding.reai.com -d maoding.reai.com
   ```

3. 将同一个虚拟主机文件替换为 `nginx/maoding.https.conf`。确认模板中的证书路径与签发结果一致，执行 `nginx -t`，通过后 reload Nginx。
4. 确认 Certbot 的现有定时续期任务及成功续期后的 Nginx reload hook 覆盖此证书；必要时配置专属 hook，并用 `certbot renew --cert-name maoding.reai.com --dry-run` 验证。

HTTP 准备配置仅提供 ACME 验证，其余请求返回 503；证书准备完成后再开启 HTTPS。最终配置保留 ACME 路径并将其他 HTTP 请求重定向到 HTTPS。不要同时启用两个模板。

`/api` 的登录和管理员权限由应用验证。`/board-api` 使用看板专属 Bearer capability；Nginx 不要在该路径叠加 Basic Auth、OAuth cookie 检查或删除 `Authorization`。生成看板在 sandbox iframe 中请求时可能使用 `Origin: null`，跨域权限与 token 校验由应用控制。不要在代理层覆盖应用 CSP 或 CORS 响应。

## 验收与更新

Compose 健康检查访问 `/healthz`，并发送与公开域名一致的 Host 头；该端点仅报告服务存活，不包含业务数据。还需验证下面的实际行为：

- HTTP 跳转 HTTPS，证书有效，宿主机公网不能直连 14317。
- 匿名请求不能读取岗位、文件、数据库、Agent 配置或受保护的看板页面；OAuth 登录后按管理员和允许用户名单授权。
- 管理员上传测试文件，清洗入库并查看 Schema，生成看板和岗位问答能通过真实模型完成。
- sandbox 内看板带 Bearer 读取 B 层；更新看板后刷新页面能加载新版本，旧 capability 的行为符合应用约定。
- 容器重建后文件、结构化数据和看板版本仍存在。部署到服务器后，“工作目录”是服务器容器中的目录，浏览器只能通过上传导入本机文件。

上传接口单文件上限 30 MiB，Nginx 将单批请求限制在 64 MiB；大批文件分批上传。生产日志、数据卷和备份可能含业务数据，按私有运维材料管理。

更新前备份专属数据卷，记录当前镜像 tag 和配置版本。在没有进行中的用户操作和 Agent 任务时更新单个应用容器。回滚时恢复上一版镜像 tag，执行同一条 `up -d --no-build app`；应用版本与数据库结构的兼容性需先核验。不要使用 `down -v` 或删除数据卷进行版本回滚。

### 当前验证记录（2026-10-28）

线上部署 healthy；外部 HTTPS/TLS、HTTP 301 跳转、匿名管理 API 401 和证书续期 dry-run 已验证。99 项自动化测试通过；此前开发模式下的真实 OAuth PKCE 流程完成 9 步 API 联调，目录返回 105 个可聊天模型。外脑 OAuth 应用已以作者 Codex、版本 3.0.0 审核通过并由开发者正式发布；线上 OAuth 开发模式已关闭，容器健康且已有数据保留。正式浏览器已到授权确认页，当前账号的授权仍待本人确认，完整浏览器 E2E 尚未通过。

财务合成数据测试的 2 个文件、4 条记录通过 54 项断言；另一个无预设 Schema 的费用用例自动推断字段并发布 2 条记录，实际查询与整数计算得到 125.50 元。模型看板在保留失败和首版缺陷后由 Agent 修正，再通过独立浏览器的真实 HTML 渲染、刷新、错误恢复、分页与标题热更新验证，线上保存为 v3。GLM 和 Qwen 的财务专业问答均未通过，用户盲盒资料与生产已登录浏览器全流程仍待验收。具体失败、修订及验证范围见 [维护说明](../docs/AUTH-AND-HTTPS.md)。

## 源码交付边界

从项目根目录按白名单打包源码；不要直接压缩整个工作目录。推荐仅包含 `Dockerfile`、`.dockerignore`、`package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`src/`、`server/`、`shared/`、`tests/`、`examples/` 和本目录的公开模板。`tests/` 用于镜像构建时的 TypeScript 检查。

打包前剔除所有 `.env`（可保留 `.env.example`）、密钥、日志、本地路径与私人验收记录；检查最终归档清单。`.dockerignore` 是镜像构建过滤器，不能代替源码上传时的过滤。生产主机、SSH 账户、实际项目路径、回滚备份位置只记录在私有运维文档。

参考：[Docker Compose services](https://docs.docker.com/reference/compose-file/services/)、[Certbot webroot](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)、[Nginx proxy headers](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)。
