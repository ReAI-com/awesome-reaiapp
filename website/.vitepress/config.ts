import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_SRC = join(HERE, "..", "..", "docs");

/**
 * 取某篇文档在仓库里的最后提交时间。
 *
 * VitePress 的 lastUpdated 是从 git 读的，而本站渲染的是 src/ 下的同步副本 ——
 * 那份不进 git，直接开 lastUpdated 只会永远拿到 null、页脚静默消失。这里改成
 * 显式回源到 docs/ 下的原件去问 git。
 */
function lastUpdatedOf(relativePath: string): number | undefined {
  // rewrites 把 README.md 映射成了 index.md，回源时要换回真实文件名
  const name =
    relativePath === "index.md"
      ? "README.md"
      : relativePath === "changelog.md"
        ? "CHANGELOG.md"
        : relativePath;
  try {
    const out = execFileSync("git", ["log", "--follow", "-1", "--format=%ct", "--", name], {
      cwd: DOCS_SRC,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? Number(out) * 1000 : undefined;
  } catch {
    return undefined; // 非 git 环境（如干净的 CI 归档）下静默降级，不阻断构建
  }
}

/**
 * ReAI App 平台（driver-v2 插件）开发者文档站。
 *
 * 源 markdown 不放在本目录，而是复用 docs/ —— 那里是规范的
 * 事实源，Host（Rust）、reai-app CLI 与本站引用同一批文件，避免文档分叉。
 * 本目录只承载站点配置与构建产物。
 *
 * 部署在官网子路径 /docs/，因此 base 必须带尾斜杠。
 */
const chineseConfig = defineConfig({
  lang: "zh-CN",
  title: "ReAI App 平台",
  description: "ReAI Board 插件开发文档：Manifest 合同、接口参考、发行与运行规范",
  base: "/docs/",
  srcDir: "./src",
  outDir: "./dist",
  cleanUrls: true,
  lastUpdated: true,

  transformPageData(pageData) {
    const ts = lastUpdatedOf(pageData.relativePath);
    if (ts) pageData.lastUpdated = ts;
  },

  // README 是这批文档天然的导航页，直接充当站点首页
  rewrites: {
    "README.md": "index.md",
    "CHANGELOG.md": "changelog.md",
  },

  /*
   * 不再需要死链豁免：指向仓库源码、样例、schema 的链接由 scripts/sync-docs.mjs
   * 在同步时降级成带路径的纯文本，站上不会再出现打不开的链接；文档源 docs/
   * 保持原样，仓库内的阅读体验不受影响。
   *
   * 保持默认（构建时校验死链）是有意的：新写的文档若引用了不会发布的文件，
   * 同步脚本会先一步中断构建，这里是第二道网。
   */
  ignoreDeadLinks: false,

  head: [

  ],

  themeConfig: {
    nav: [
      { text: "开始", link: "/plugin-development-v1" },
      { text: "接口参考", link: "/plugin-api-reference-v1" },
      {
        text: "更多文档",
        items: [
          { text: "皮肤开发", link: "/skin-development-v1" },
          { text: "服务与 Agent", link: "/agent-service-extension-v1" },
          { text: "完整指南", link: "/app-development-guide-v1" },
        ],
      },
      { text: "更新日志", link: "/changelog" },
    ],

    sidebar: [
      {
        text: "总览",
        items: [
          { text: "平台合同 v1.1 · 首版实现范围", link: "/" },
          { text: "规范更新日志", link: "/changelog" },
        ],
      },
      {
        text: "开发插件",
        items: [
          { text: "插件开发指南", link: "/plugin-development-v1" },
          { text: "能力复用与调用边界", link: "/plugin-development-v1#capability-reuse" },
          { text: "Voice 文本服务", link: "/voice-request-text" },
          { text: "插件接口参考", link: "/plugin-api-reference-v1" },
          { text: "插件语言包规范", link: "/plugin-i18n-v1" },
          { text: "插件元数据 i18n v2 补充（源码已支持，线上基线仍 v1）", link: "/plugin-i18n-metadata-v2" },
          { text: "语言包：三个官方样板", link: "/plugin-i18n-examples" },
          { text: "共享库 agent-ui 实例级 i18n", link: "/plugin-agent-ui-i18n" },
          { text: "插件上架打包与提交", link: "/plugin-submission-v1" },
          { text: "设置页、版本与关于入口", link: "/plugin-settings-and-release-notes-v1" },
          { text: "AI 员工范式 v2（设计稿与合同）", link: "/ai-employee-pattern-v2" },
          { text: "AI 员工三阶段最佳实践", link: "/ai-employee-pattern-v1" },
          { text: "皮肤插件开发规范", link: "/skin-development-v1" },
          { text: "插件服务与 Agent / DSH（实现与规划）", link: "/agent-service-extension-v1" },
          { text: "Agent Service v2（引擎选择与会话）", link: "/agent-service-v2" },
          { text: "Agent 受控运行工具", link: "/agent-controlled-run" },
          { text: "插件设计规范", link: "/plugin-design-system-v1" },
          { text: "完整开发指南（从 0 做 To-Do）", link: "/app-development-guide-v1" },
        ],
      },
      {
        text: "平台规范",
        items: [
          { text: "发行、Host 与 Extension", link: "/distribution-policy-v1" },
          { text: "网络、数据共享与计费", link: "/network-billing-policy-v1" },
          { text: "订阅、积分与云服务", link: "/driver-cloud-billing" },
          { text: "运行依赖", link: "/runtime-dependencies-v1" },
          { text: "生命周期 Hooks", link: "/lifecycle-hooks-v1" },
          { text: "云能力与工作流分发", link: "/wainao-cloud-workflow-distribution-v1" },
        ],
      },
    ],

    search: { provider: "local" },

    /*
     * 文档里保留了不少指向仓库源码、样例和 schema 的链接，它们没有随文档站一起
     * 公开，点过去就是 404。默认那句「页面不存在」会让人以为是站坏了，这里换成
     * 说明性的文案，让读者知道是「还没开放」而不是「找错地方」。
     */
    notFound: {
      title: "这部分内容还没有公开",
      quote:
        "你点到的链接可能指向仓库里的源码、样例或 schema —— 它们还没有随文档站一起发布；也可能是这篇文档还在写。需要这部分资料可以直接找我们要。",
      linkLabel: "回到文档首页",
      linkText: "返回文档首页",
    },

    outline: { level: [2, 3], label: "本页内容" },
    docFooter: { prev: "上一篇", next: "下一篇" },
    darkModeSwitchLabel: "主题",
    lightModeSwitchTitle: "切换到浅色",
    darkModeSwitchTitle: "切换到深色",
    sidebarMenuLabel: "菜单",
    returnToTopLabel: "回到顶部",
    lastUpdated: { text: "最后更新" },

    footer: {
      message: "ReAI App 平台合同 v1.1",
      copyright: "© 2026 ReAI",
    },
  },
});


const englishLabels: Record<string,string> = {
  'AI 员工范式 v2（设计稿与合同）':'AI employee paradigm v2',
  'AI 员工三阶段最佳实践':'AI employee pattern v1',
  '开始':'Get started','接口参考':'API reference','更多文档':'More docs','皮肤开发':'Skins','服务与 Agent':'Services & agents','完整指南':'Complete guide','更新日志':'Changelog',
  '总览':'Overview','平台合同 v1.1 · 首版实现范围':'Platform contracts & delivery boundaries','规范更新日志':'Specification changelog','开发插件':'Develop plugins','插件开发指南':'Plugin development','能力复用与调用边界':'Capability reuse & call boundaries','Voice 文本服务':'Voice text services','插件接口参考':'Plugin API reference','插件语言包规范':'Language packs','插件元数据 i18n v2 补充（源码已支持，线上基线仍 v1）':'Metadata i18n v2 compatibility','语言包：三个官方样板':'Language pack examples','共享库 agent-ui 实例级 i18n':'Instance-scoped agent UI i18n','插件上架打包与提交':'Packaging & submission','设置页、版本与关于入口':'Settings, versions & About','皮肤插件开发规范':'Skin development','插件服务与 Agent / DSH（实现与规划）':'Services, agents & DSH','Agent Service v2（引擎选择与会话）':'Agent Service v2','Agent 受控运行工具':'Controlled run tools','插件设计规范':'Plugin design system','完整开发指南（从 0 做 To-Do）':'Complete development guide','平台规范':'Platform specifications','发行、Host 与 Extension':'Distribution, Host & Extension','网络、数据共享与计费':'Network, sharing & billing','订阅、积分与云服务':'Subscriptions, credits & cloud','运行依赖':'Runtime dependencies','生命周期 Hooks':'Lifecycle hooks','云能力与工作流分发':'Cloud capabilities & workflows'
};
function englishItem(item: any): any {
  return {...item, ...(item.text ? {text:englishLabels[item.text] ?? item.text} : {}), ...(item.link ? {link:`/en${item.link}`} : {}), ...(item.items ? {items:item.items.map(englishItem)} : {})};
}
export default defineConfig({
  ...chineseConfig,
  locales: {
    root: {label:'简体中文',lang:'zh-CN',link:'/'},
    en: {
      label:'English',lang:'en',link:'/en/',title:'ReAI Open Docs',description:'English guides to ReAI plugin development, APIs, and release specifications.',
      themeConfig: {
        ...chineseConfig.themeConfig,
        nav: (chineseConfig.themeConfig?.nav as any[])?.map(englishItem),
        sidebar: (chineseConfig.themeConfig?.sidebar as any[])?.map(englishItem),
        outline:{level:[2,3],label:'On this page'},docFooter:{prev:'Previous page',next:'Next page'},
        darkModeSwitchLabel:'Appearance',lightModeSwitchTitle:'Switch to light theme',darkModeSwitchTitle:'Switch to dark theme',sidebarMenuLabel:'Menu',returnToTopLabel:'Back to top',lastUpdated:{text:'Last updated'},langMenuLabel:'Language',
        notFound:{title:'Page not found',quote:'This page may have moved or may not have been published yet.',linkLabel:'Back to documentation',linkText:'Back to documentation'},
        footer:{message:'ReAI plugin documentation · English reading guides',copyright:'© 2026 ReAI'},
      }
    }
  },
});
