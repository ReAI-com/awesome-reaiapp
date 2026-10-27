# 发布状态与默认目标

记录日期：2026-10-28。仓库：`ReAI-com/awesome-reaiapp`。

## 公开入口

- 开放平台：[https://open.reai.com/](https://open.reai.com/)
- 中文文档：[https://open.reai.com/docs/](https://open.reai.com/docs/)
- 英文阅读指南：[https://open.reai.com/docs/en/](https://open.reai.com/docs/en/)
- 既有文档入口：[https://ai-board.reai.com/docs/](https://ai-board.reai.com/docs/)
- 站点版本标识：[https://open.reai.com/release.json](https://open.reai.com/release.json)

网站公开版本以实际页面和上述版本标识为准。main 已合并不表示该提交已经部署。

## 线上站点与 main 的差距

2026-10-28 读取 `https://open.reai.com/release.json`：

| 字段 | 线上值 |
| --- | --- |
| releaseId | `20261026T101300Z-55e2b53dfabf` |
| gitCommit | `0ccb9348bb111dee2bcc0002a4e2f3613b676d7f`（`0ccb934`，合并 #32 时的 main） |
| builtAt | `2026-10-26T10:13:00Z` |
| sourceSha256 | `55e2b53dfabf0482cb351b5d1969468f46c4dad44829231cba33f24e729e79a9` |
| workingTree | `modified`（构建时工作树相对该提交有改动；脏文件不在本仓库） |

本仓库 main HEAD 为 `2cb17afee3b27f6b73908293615069204319b193`（`2cb17af`，#38）。`0ccb934` 是它的祖先。`git rev-list --count 0ccb934..2cb17af` 为 **14**。线上记录的 gitCommit 落后 main 这 14 个提交。

这 14 个提交里和站点、插件文档直接相关的是：

- #33–#36：Voice `2.15.0`（只有一个 Agent、拨杆定档、结果弹窗续聊、文件夹读权限只问一次、同一对话只占一条任务，以及已上架说明）。
- #37：开放站 legacy 应用列表去掉 Pi Agent、DSH Agent、Codex App 三个 Agent（源码保留，商店公开目录仍以远端 appStore 为准）。**该站点改动已在 main，线上 `release.json` 仍停在 `0ccb934`，没有吃到。**
- #38：Terminal `1.0.6` 与 Codex Link `0.5.13` 声明 Windows 安装目标。

本次只更新仓库文档，不重新部署 open.reai.com。

## 历史交付

2026-10-03、2026-10-06、2026-10-19 的源码与文档验收分别见 [2026-10-03](source-delivery-2026-10-03.md)、[2026-10-06](source-delivery-2026-10-06.md)、[2026-10-19](source-delivery-2026-10-19.md)。那些记录里的仓库路径以当时的事实为准。

GitHub 源码公开、本地测试、编译、打包、平台审核、签名、Host 安装和商店上架是不同验收项。不能用某一项成功替代其他项。

## 生产发布

网站、插件送审和插件上架分别核对发布目标。实际主机、账号、生产目录、配置、凭据位置、验收材料和回滚命令保留于本地，不写入公开仓库。

执行生产发布前核验目标、当前版本、构建产物、权限、备份与回滚，并取得对应授权。不根据域名推断主机，不复用其他项目的生产环境。未核验目标时不执行生产部署。

用户正在测试时，不启动或重启其应用，不抢占锁或租约。新增凭据、OAuth scope、权限、网络规则、付费资源、migration 和数据删除需要具体授权。
