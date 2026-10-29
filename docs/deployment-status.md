# 发布状态与默认目标

记录日期：2026-10-29。仓库：`ReAI-com/awesome-reaiapp`。

## 公开入口

- 开放平台：[https://open.reai.com/](https://open.reai.com/)
- 中文文档：[https://open.reai.com/docs/](https://open.reai.com/docs/)
- 英文阅读指南：[https://open.reai.com/docs/en/](https://open.reai.com/docs/en/)
- 既有文档入口：[https://ai-board.reai.com/docs/](https://ai-board.reai.com/docs/)
- 站点版本标识：[https://open.reai.com/release.json](https://open.reai.com/release.json)

网站公开版本以实际页面和上述版本标识为准。main 已合并不表示该提交已经部署。

## 线上站点与 main 的差距

2026-10-29 读取 `https://open.reai.com/release.json`：

| 字段 | 线上值 |
| --- | --- |
| releaseId | `20261029T111425Z-ac7186cd60ef` |
| gitCommit | `41eda6214be9b5be8ab4909108a73d421995972a`（`41eda62`，合并 #40 后的 main） |
| builtAt | `2026-10-29T11:14:25Z` |
| sourceSha256 | `ac7186cd60efe97f0f0ec7868f4e86e672d220f8badd0929456431286e6deb60` |
| workingTree | `clean` |

线上即当前 main，无差距。#40 发布首页插件切换动效版：三个选项（Typezero 语音、浏览器、Terminal），默认 Typezero；原误挂在 Codex Link 下的「语音任务」动效按用户指正归属 Typezero 语音输入，与语音输入写入演示合并为 24 秒四步故事，Codex Link 选项撤下、详情页保留目录。部署流程：369 个文件逐一校验 SHA256 后在 `.deploy.lock` 下原子切换 `current` 符号链接，nginx 配置不变、未重启服务；中英文 8 组视口 still 模式、三选项视频播放、暂停/重播/离屏暂停/减少动态效果/手机菜单、未知地址 404 与视频分段请求均在线上验证通过，回滚脚本保留在本地发布材料中。

2026-10-28 曾有一次未在更新日志留痕的部署 `20261028T000606Z-e40d3b946144`（gitCommit `4117b85`），本次发布为其后续；更早的 `20261026T101300Z-55e2b53dfabf`（`0ccb934`）为首个动效首页版本，均保留在 releases 目录可回溯。

## 历史交付

2026-10-03、2026-10-06、2026-10-19 的源码与文档验收分别见 [2026-10-03](source-delivery-2026-10-03.md)、[2026-10-06](source-delivery-2026-10-06.md)、[2026-10-19](source-delivery-2026-10-19.md)。那些记录里的仓库路径以当时的事实为准。

GitHub 源码公开、本地测试、编译、打包、平台审核、签名、Host 安装和商店上架是不同验收项。不能用某一项成功替代其他项。

## 生产发布

网站、插件送审和插件上架分别核对发布目标。实际主机、账号、生产目录、配置、凭据位置、验收材料和回滚命令保留于本地，不写入公开仓库。

执行生产发布前核验目标、当前版本、构建产物、权限、备份与回滚，并取得对应授权。不根据域名推断主机，不复用其他项目的生产环境。未核验目标时不执行生产部署。

用户正在测试时，不启动或重启其应用，不抢占锁或租约。新增凭据、OAuth scope、权限、网络规则、付费资源、migration 和数据删除需要具体授权。
