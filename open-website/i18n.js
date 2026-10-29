// Shared, dependency-free resources for static rendering and browser interactions.
const rows = [
 ['nav.download','下载','Download'],
 ['site.title','ReAI Open · 让能力连接更多可能','ReAI Open · Connect ideas with possibilities'],
 ['site.description','ReAI Open 开放平台：发现插件、探索应用案例、阅读文档并开始开发。','Discover ReAI plugins, explore practical scenarios, and build your next tool.'],
 ['site.skip','跳到主要内容','Skip to main content'],
 ['site.banner','ReAI Open · 开放插件、文档与应用场景','ReAI Open · Plugins, documentation, and practical scenarios'],
 ['site.homeLabel','ReAI Open 首页','ReAI Open home'],
 ['site.navLabel','主导航','Main navigation'],
 ['nav.apps','插件','Plugins'],['nav.cases','应用案例','Use cases'],['nav.builders','开发者','Developers'],['nav.docs','文档','Docs'],['nav.caseShort','案例','Cases'],['nav.build','开始构建','Start building'],
 ['hero.line1','让 AI 的能力，','Bring AI capabilities'],['hero.line2','走进每一种','into every kind of '],['hero.accent','工作。','work.'],
 ['hero.description1','发现好用的插件，探索真实的应用方式。','Discover useful plugins and practical ways to use them.'],
 ['hero.description2','也把你的想法，构建成下一个可用的工具。','Turn your next idea into a tool people can use.'],
 ['hero.explore','探索插件','Explore plugins'],['hero.develop','开发你的插件','Build your plugin'],
 ['hero.note','独立插件 · 开放能力 · 更多工作方式','Independent plugins · Open capabilities · New ways to work'],
 ['hero.artLabel','语音、浏览器和终端组成的能力演示，非真实插件截图','A concept illustration of voice, browser, and terminal tools; not a product screenshot'],
 ['hero.code','✓ 一点想法，无限可能。','✓ Small ideas. New possibilities.'],['hero.voice','语音输入法','Voice input'],
 ['hero.voiceText','说出想法，让文字落进工作。','Speak an idea. Put it to work.'],['hero.voiceBottom','从声音到行动','From voice to action'],['hero.browserText','连接网页与灵感。','Connect the web with ideas.'],
 ['principle.daily','为日常工作而造','Built for everyday work'],['principle.tools','用插件拓展你的工具箱','Expand your toolbox'],['principle.ideas','从灵感到应用','From ideas to tools'],
 ['discovery.title','找到你的下一件好工具。','Find your next useful tool.'],
 ['discovery.description','从语音输入到浏览器、终端，让每一步工作都有合适的能力。','From voice input to browsing and terminals, find the right capability for each step.'],
 ['discovery.all','浏览全部插件','Browse all plugins'],['discovery.filterLabel','按类别筛选插件','Filter plugins by category'],['discovery.allFilter','全部','All'],
 ['category.productivity','效率工具','Productivity'],['category.agent','AI 与 Agent','AI & Agents'],['category.developer','开发工具','Developer tools'],['category.system','系统与设备','System & devices'],['category.other','其他','Other'],
 ['discovery.search','搜索插件与能力','Search plugins and capabilities'],['discovery.view','查看介绍','View details'],['discovery.empty','没有找到匹配的插件。试试其他关键词或分类。','No matching plugins. Try another keyword or category.'],
 ['discovery.pluginSingular','插件','plugin'],['discovery.featuredSingular','精选插件','featured plugin'],
 ['discovery.count','展示 {count} 个{kind} · {state}','Showing {count} {kind} · {state}'],['discovery.plugins','插件','plugins'],['discovery.featured','精选插件','featured plugins'],
 ['catalog.snapshot','公开目录快照','Public catalog snapshot'],['catalog.updated','公开目录 · 已更新','Public catalog · Updated'],['catalog.failed','暂时无法刷新，显示最近一次公开目录快照','Refresh unavailable; showing the last public catalog snapshot'],['catalog.loading','正在读取公开目录','Loading the public catalog'],
 ['showcase.title1','能力连接起来，','Connect capabilities.'],['showcase.title2','工作就有了新方式。','Find new ways to work.'],['showcase.intro1','从一个具体任务出发，','Start with a specific task.'],['showcase.intro2','探索插件可以怎样一起工作。','Explore how plugins can work together.'],
 ['showcase.note','灵感笔记','Idea notes'],['showcase.paper1','把刚才的想法','Turn a fresh idea'],['showcase.paper2','变成下一步行动。','into your next action.'],['showcase.flow','语音 → 文字 → 编辑','Voice → Text → Edit'],
 ['showcase.writingCategory','内容创作','Content creation'],['showcase.writingLabel','内容创作 · 场景示例','Content creation · Example scenario'],['showcase.writingTitle','说出来，再把它打磨好。','Speak it. Then make it yours.'],['showcase.writingDescription','语音输入与文本编辑，让灵感从声音变成文字。','Capture ideas with your voice, then shape them in an editor.'],
 ['showcase.web','网页','Web'],['showcase.action','行动','Action'],['showcase.researchCategory','研究与开发','Research & development'],['showcase.researchLabel','研究与开发 · 场景示例','Research & development · Example scenario'],['showcase.researchTitle','让发现，成为下一步。','Turn discoveries into next steps.'],['showcase.researchDescription','从网页获取信息，用 Agent 辅助理解与构建。','Explore the web and use agents to help understand and build.'],
 ['builders.title1','下一个好工具，','The next useful tool'],['builders.title2','可以由你来构建。','can be yours to build.'],['builders.description1','从开发规范到接口与审核提交，','From specifications and APIs to review and release,'],['builders.description2','把一个想法带进 ReAI 的插件生态。','bring your idea into the ReAI plugin ecosystem.'],['builders.guide','阅读开发指南','Read the developer guide'],
 ['builders.docsStatus','开发文档已整合；原文档入口继续保留','Developer docs are integrated; the existing docs entry remains available'],
 ['builders.step1','从第一个插件开始','Build your first plugin'],['builders.summary1','项目结构、生命周期与最小权限','Project structure, lifecycle, and least privilege'],['builders.step2','连接平台能力','Connect platform capabilities'],['builders.summary2','SDK、接口合同与可复用服务','SDK, API contracts, and reusable services'],['builders.step3','准备审核与发布','Prepare for review and release'],['builders.summary3','独立打包、版本介绍与交付检查','Independent packaging, release notes, and delivery checks'],
 ['closing.explore','从这里，开始探索','Start exploring'],['footer.description','连接能力，也连接创造者。','Connecting capabilities and creators.'],['footer.copyright','© 2026 ReAI','© 2026 ReAI'],
 ['crumb.label','面包屑','Breadcrumb'],['crumb.home','首页','Home'],['directory.title','发现插件','Discover plugins'],['directory.line1','每一种工作，','For every kind of work,'],['directory.line2','都有新的可能。','there are new possibilities.'],['directory.intro','探索 ReAI 插件，用合适的能力完成下一步。','Explore ReAI plugins and find the capability for your next step.'],['directory.noscript','插件索引需要启用 JavaScript；具体插件页面仍可直接打开。','Enable JavaScript to browse the catalog. Individual plugin pages remain accessible.'],
 ['detail.overview','关于这个插件','About this plugin'],['detail.screenshots','界面预览','Interface previews'],['detail.version','公开版本','Published version'],['detail.category','分类','Category'],['detail.status','状态','Status'],['detail.published','已发布','Published'],['detail.logs','查看更新日志','View changelog'],['detail.notListed','此插件暂未在公开目录中收录。','This plugin is not currently listed in the public catalog.'],['detail.continue','你可以继续探索已发布的插件。','You can continue exploring published plugins.'],['detail.publicCatalog','查看公开目录','Browse the public catalog'],['detail.intro','插件介绍','Plugin details'],['detail.original','以下为发布者提供的原文介绍。','The following is the original description supplied by the publisher.'],
 ['log.title','更新日志','Changelog'],['log.intro','每一个版本，都应该有清楚的说明。','Every version deserves clear release notes.'],['log.search','查找具体版本','Find a specific version'],['log.view','查看版本','View version'],['log.current','你正在查看','You are viewing'],['log.unavailable','此插件尚未提供公开版本日志。','Public release notes are not available for this plugin yet.'],['log.pending','版本说明将在整理完成后展示。','Release notes will appear when they are available.'],['log.empty','更新日志还在准备中。','Release notes are being prepared.'],['log.emptyDescription','这里将记录每个版本的新功能、改进和修复。','This page will track features, improvements, and fixes for each version.'],['log.spec','了解版本文档规范','Read the release notes specification'],['log.missing','尚未收录此版本的更新日志。','Release notes for this version have not been collected yet.'],['log.notPublic','尚未公开','Not published'],['log.record','已找到该版本的源码文档记录；发布状态尚未核验。','Source documentation was found; its release status has not been verified.'],
 ['showcase.list1','好工具在一起，','Good tools, together.'],['showcase.listIntro','从一个任务出发，探索插件组合。以下为场景说明，尚未作为客户案例核验。','Explore combinations of plugins around a task. These are example scenarios, not verified customer case studies.'],['showcase.start','从哪里开始','Where to start'],['showcase.steps','一步一步，把想法接起来。','Connect your ideas, step by step.'],['showcase.outcome','预期结果与边界','Expected results and boundaries'],['showcase.tools','用到的插件','Plugins in this scenario'],['showcase.unavailable','部分场景工具尚未在公开目录中提供。','Some tools in this scenario are not yet available in the public catalog.'],['showcase.boundary','说明不代表自动化能力已经接通。实际使用以插件状态、权限及验证结果为准。','This description does not establish that automation is connected. Actual behavior depends on plugin status, permissions, and verified results.'],['showcase.all','全部应用案例','All use cases'],
 ['builders.full1','你的下一个想法，','Your next idea'],['builders.full2','可以成为一件好工具。','can become a useful tool.'],['builders.fullIntro','用独立插件接入 ReAI 的能力，从本机验证开始，逐步走向审核与发布。','Connect to ReAI through an independent plugin. Start with local validation, then prepare for review and release.'],['builders.start','开始开发','Start developing'],['builders.resources','从这里开始构建。','Start building here.'],['builders.allDocs','全部开发文档','All developer docs'],['builders.independent','版本独立，交付清楚。','Independent versions. Clear delivery.'],['builders.contract','稳定 appId、最小权限、可重放构建和真实验证，让插件能独立迭代。官方插件同样遵循正式审核要求。','Stable app IDs, least privilege, reproducible builds, and real validation let plugins evolve independently. Official plugins follow the same review requirements.'],['builders.settings','设置页、版本与关于入口','Settings, versions, and About links'],['builders.i18n','中英文语言包规范','Chinese and English language packs'],['builders.lifecycle','插件生命周期','Plugin lifecycle'],['builders.existing','探索已有插件','Explore existing plugins'],['builders.docsNote','开发文档已在此站提供，原文档入口继续可用：','Developer docs are available here. The existing entry remains accessible:'],
 ['builders.path1','项目骨架、生命周期与能力边界。','Project scaffolding, lifecycle, and capability boundaries.'],['builders.path2','SDK、Manifest 和接口合同。','SDK, Manifest, and API contracts.'],['builders.path3','做出一致的体验','Create a consistent experience'],['builders.path3Summary','界面、主题、语言与设置页规范。','UI, themes, languages, and settings specifications.'],['builders.path4','身份核对、独立打包与版本介绍。','Identity checks, independent packaging, and release notes.'],
 ['error.title','页面未找到','Page not found'],['error.heading','这个页面还没有找到。','We could not find this page.'],['error.intro','链接可能已变化。你可以回到首页，或继续发现插件。','The link may have changed. Return home or keep exploring plugins.'],['error.home','返回首页','Return home'],
 ['case.example','场景示例','Example scenario'],['case.deviceCategory','设备与日常','Devices & everyday work'],['case.deviceTitle','遇到问题，先把状态看清。','When something fails, check its status first.'],['case.deviceDescription','从连接、权限和运行环境开始定位设备问题。','Start diagnosing devices with connections, permissions, and runtime conditions.'],['case.deviceHeadline','少一点猜测，多一点清楚。','Less guesswork. More clarity.'],
 ['case.writingDescription','用语音捕捉想法，在编辑器里整理成文。','Capture ideas with your voice and organize them in an editor.'],['case.writingHeadline','把刚才的想法，变成下一步行动。','Turn a fresh idea into your next action.'],['case.writingContext','想法往往在走动、讨论或查看资料时出现。这个场景展示如何先留下文字，再整理成一份可读的文档。','Ideas often arrive while walking, discussing, or reading. This scenario captures them first, then shapes them into a readable document.'],['case.writingStep1','在语音输入法中选择识别方式，核对当前权限和模型状态。','Choose a recognition mode in Voice input and check permissions and model availability.'],['case.writingStep2','在需要写入的应用中放好光标，口述想法并完成识别。','Place the cursor in your target app, dictate your idea, and complete recognition.'],['case.writingStep3','在文本编辑器中整理段落、补充细节并保存本地文件。','Organize paragraphs in an editor, add details, and save the local file.'],['case.writingOutcome','期望得到一份由你确认和整理的文字稿。插件间自动交接和效果仍需实际验证；这里不提供已验证的客户案例或效率数据。','The intended result is a draft you have checked and edited. Automated handoffs and outcomes still require validation; no verified customer or productivity claims are made here.'],
 ['case.researchDescription','围绕网页资料，把信息探索接到 Agent 工作中。','Connect web research with agent-assisted work.'],['case.researchHeadline','从一个问题，到下一步行动。','From a question to a next step.'],['case.researchContext','查阅技术资料时，浏览、理解和动手通常交替发生。这个场景用浏览器、Agent 和终端组织这三个环节。','Technical research moves between browsing, understanding, and hands-on work. This scenario organizes those steps with a browser, an agent, and a terminal.'],['case.researchStep1','通过浏览器查看相关资料，确认来源和任务范围。','Browse relevant materials and confirm their sources and the task scope.'],['case.researchStep2','在 Agent 任务中提供你确认过的材料与明确目标；按要求完成授权。','Give the agent checked materials and a clear goal. Complete any required authorization.'],['case.researchStep3','在终端或对应工具中检查输出，验证后再采用修改。','Check the output in the terminal or relevant tool, and validate changes before adopting them.'],['case.researchOutcome','期望得到有来源、有边界、可验证的下一步方案。跨插件数据传递与自动执行需按实际合同验收；本页是场景说明。','The intended result is a sourced, scoped, and verifiable next-step plan. Cross-plugin transfers and automation must be validated against actual contracts. This page describes a scenario.'],
 ['case.deviceContext','设备没有按预期工作时，先辨认是连接、权限还是版本问题。诊断工具把本机状态整理成可行动的信息。','When a device behaves unexpectedly, distinguish connection, permission, and version issues first. Diagnostic tools organize local status into actionable information.'],['case.deviceStep1','打开设备诊断助手，查看连接与系统权限提示。','Open Device Doctor and review connection and system permission information.'],['case.deviceStep2','根据需要查看脱敏日志摘要；涉及云端分析时先确认授权。','Review redacted log summaries as needed. Confirm authorization before cloud analysis.'],['case.deviceStep3','依照诊断结果处理具体问题，再复核设备状态。','Address the specific issue indicated by the diagnosis, then check the device again.'],['case.deviceOutcome','期望得到清晰的故障方向和下一步操作。页面中的说明来自插件声明，未模拟诊断成功或证明具体设备已修好。','The intended result is a clear diagnosis direction and next action. This description follows plugin declarations; it does not simulate a successful diagnosis or establish that a device is repaired.'],
];
rows.push(
 ["home.preview.pick", "选一个插件，看看它怎样工作。", "Choose a plugin. See it in action."],
 ["home.preview.choose", "选择插件动画", "Choose a plugin preview"],
 ["home.preview.browser.name", "浏览器", "Browser"],
 ["home.preview.eyebrow", "小小的交互，顺手的日常", "Small interactions. Everyday ease."],
 ["home.preview.detail", "查看这个插件", "Explore this plugin"],
 ["home.preview.steps", "演示流程", "Preview steps"],
 ["home.preview.replay", "重播", "Replay"],
 ["home.preview.unavailable", "视频暂时无法播放，已显示静态预览。可点重播重试。", "Video unavailable. A still preview is shown. Select Replay to retry."],
 ["home.preview.voice.title1", "把想法说出来，", "Say your idea."],
 ["home.preview.voice.title2", "把任务交代出去。", "Hand off the rest."],
 ["home.preview.voice.intro", "按下语音键：短句直接写入光标；说一件事，胶囊退到角落处理，完成时提醒你。", "Press the voice key: short phrases land at your cursor. Speak a task and the capsule takes it to the corner, then pings you when it's done."],
 ["home.preview.voice.source", "语音胶囊 · 官方设计预览", "Voice capsule · Official design preview"],
 ["home.preview.voice.alt", "语音胶囊：键盘唤起、录音、转写写入文档；语音任务转后台处理并弹出完成提醒；演示数据", "Voice capsule: keyboard trigger, recording, transcription into a document; a voice task runs in the background with a completion reminder; sample data"],
 ["home.preview.voice.step0", "语音键唤起", "Press the voice key"],
 ["home.preview.voice.step1", "说话变文字", "Words become text"],
 ["home.preview.voice.step2", "任务转后台", "Task to the corner"],
 ["home.preview.voice.step3", "完成提醒", "A ping when done"],
 ["home.preview.browser.title1", "AI 在哪一页，", "See where your"],
 ["home.preview.browser.title2", "一眼就看见。", "agent is browsing."],
 ["home.preview.browser.intro", "看见 Agent 打开的工作标签，随时切回自己的页面。", "See the working tab opened by your agent. Switch back to your own page at any time."],
 ["home.preview.browser.source", "插件原界面 · 演示标签数据", "Original plugin UI · Sample tabs"],
 ["home.preview.browser.alt", "浏览器插件原界面：打开 Agent 工作标签并切回自己的页面；演示数据", "Original Browser UI: open an agent working tab and switch back to your own page; sample data"],
 ["home.preview.browser.step0", "新建标签", "Open a tab"],
 ["home.preview.browser.step1", "看见 Agent", "See the agent tab"],
 ["home.preview.browser.step2", "随时切回", "Switch back"],
 ["home.preview.terminal.title1", "不同的任务，", "Different tasks."],
 ["home.preview.terminal.title2", "各有一片空间。", "Space for each one."],
 ["home.preview.terminal.intro", "切换标签，展开分栏。终端各自运行，工作上下文留在原处。", "Switch tabs and arrange panes. Each terminal keeps running with its own working context."],
 ["home.preview.terminal.source", "终端布局 · 官方设计预览", "Terminal layout · Official design preview"],
 ["home.preview.terminal.alt", "终端官方设计：切换工作区与调整分栏；演示数据", "Official Terminal design: switch workspaces and arrange panes; sample data"],
 ["home.preview.terminal.step0", "独立会话", "Separate sessions"],
 ["home.preview.terminal.step1", "切换标签", "Switch tabs"],
 ["home.preview.terminal.step2", "调整分栏", "Arrange panes"]
);

// Homepage redesign resources, shared by static HTML and motion controls.
rows.push(
 ["home.title", "ReAI Open · 让好工具接住每一个想法", "ReAI Open · Good tools for every idea"],
 ["home.description", "ReAI Open 开放平台：发现好用的 AI 插件，探索工作场景，也把你的想法构建成下一件好工具。", "Discover useful AI plugins, explore new ways to work, and turn your ideas into tools others can use."],
 ["home.download", "下载 ReAI", "Download ReAI"],
 ["home.menuOpen", "打开导航", "Open navigation"],
 ["home.menuClose", "关闭导航", "Close navigation"],
 ["home.eyebrow", "工具开放，想法生长", "Open tools. Room to grow."],
 ["home.headline1", "让好工具，", "Good tools."],
 ["home.headline2", "接住每一个想法。", "For every idea."],
 ["home.intro1", "从语音、浏览器到 AI Agent，", "From voice and browsers to AI agents,"],
 ["home.introWay", "找到适合你的工作方式。", "find your own way to work."],
 ["home.intro2", "也把你的下一个想法，做成大家都能用的工具。", "Turn your next idea into a tool everyone can use."],
 ["home.caption", "公开插件目录 · 开发文档 · 应用场景", "Public plugins · Developer docs · Use cases"],
 ["home.toolbox", "你的工具箱", "Your toolbox"],
 ["home.workspace", "工作空间", "Workspace"],
 ["home.myTools", "我的工具", "My tools"],
 ["home.smallTools", "小工具，大可能。", "Small tools. Big ideas."],
 ["home.ideaStart", "一个想法的开始", "Where an idea begins"],
 ["home.concept", "界面概念演示", "Concept preview"],
 ["home.greeting", "今天，想做点什么？", "What will you make today?"],
 ["home.greetingDetail", "从一个小想法，到一次新的尝试。", "A small idea. A new possibility."],
 ["home.prompt", "把刚才的灵感，变成一份清晰的笔记。", "Turn that spark of inspiration into a clear note."],
 ["home.voiceTool", "用声音记录", "Capture by voice"],
 ["home.voiceDetail", "让想法先落下来", "Give your ideas a place"],
 ["home.webTool", "向网页探索", "Explore the web"],
 ["home.webDetail", "为好奇心多开一扇窗", "Follow your curiosity"],
 ["home.buildTool", "动手去构建", "Start building"],
 ["home.buildDetail", "让下一步发生", "Make the next step happen"],
 ["home.combine", "你的工具，按你的方式组合。", "Your tools. Your way of working."],
 ["home.origin", "不同能力，一个开放的起点。", "Different capabilities. One open beginning."],
 ["home.conceptNote", "概念示意，非实际产品截图", "Concept illustration, not a product screenshot"],
 ["home.nextTool", "下一件好工具，", "Your next useful tool"],
 ["home.rightHere", "就在这里。", "is right here."],
 ["home.discover1", "为日常工作，多添一种可能。", "Make room for a new way to work."],
 ["home.discover2", "从公开目录中，找到你需要的能力。", "Find the capability you need in the public catalog."],
 ["home.try1", "从「我想」，", "From “what if”"],
 ["home.try2", "到「我来试试」。", "to “let’s try”."],
 ["home.motionPause", "暂停动效", "Pause animations"],
 ["home.motionResume", "继续动效", "Resume animations"],
 ["home.motionReduced", "已减少动态效果", "Reduced motion enabled"],
 ["home.typed", "把今天的灵感，写成明天的开始。", "Today’s ideas. Tomorrow’s beginnings."],
 ["home.voiceTitle", "先说出来，再慢慢打磨。", "Say it. Then shape it."],
 ["home.voiceCopy", "接住一闪而过的灵感，用文字把它变得清楚。", "Catch a passing thought, then give it clarity in writing."],
 ["home.curiosity", "给好奇心一个方向", "Follow your curiosity"],
 ["home.source1", "发现一条有用的线索", "Find a useful lead"],
 ["home.source2", "整理值得留下的信息", "Keep what matters"],
 ["home.source3", "把发现变成下一步", "Find your next step"],
 ["home.researchResult", "让思路，慢慢变得清晰。", "Let the picture come together."],
 ["home.researchTitle", "顺着好奇，走得更远。", "Take curiosity further."],
 ["home.researchCopy", "在网页中发现信息，用 Agent 辅助理解与构建。", "Explore information on the web, with agents to help you understand and build."],
 ["home.scenarioNote", "以上为能力与使用场景示意，实际效果以插件状态和使用权限为准。", "Illustrative capabilities and scenarios. Actual results depend on plugin availability and permissions."],
 ["home.manifestoLabel", "开放平台理念", "Our open platform philosophy"],
 ["home.word1", "好工具，", "Good tools "],
 ["home.word2", "让想法", "give ideas "],
 ["home.word3", "有处可去。", "a place to go."],
 ["home.word4", "开放，", "Open possibilities "],
 ["home.word5", "让创造", "make room "],
 ["home.word6", "不断发生。", "for what comes next."],
 ["home.builderTitle", "也可以出自你手。", "could be made by you."],
 ["home.builder1", "从一个解决小问题的想法开始。", "Start with an idea that solves a small problem."],
 ["home.builder2", "用开放的文档与接口，构建自己的 ReAI 插件。", "Build your own ReAI plugin with open docs and APIs."],
 ["home.faqTitle1", "开始之前，", "Before you begin,"],
 ["home.faqTitle2", "你可能想知道。", "a few useful answers."],
 ["home.faq1", "如何开始使用 ReAI 和插件？", "How do I get started with ReAI and plugins?"],
 ["home.answer1", "先从官网下载 ReAI，再在应用内查看和安装可用插件。这个网站提供插件介绍、应用场景与开发文档。", "Download ReAI from the official website, then browse and install available plugins in the app. This site provides plugin information, use cases, and developer docs."],
 ["home.faq2", "这里的插件都已发布了吗？", "Are the plugins here published?"],
 ["home.answer2", "插件目录只展示公共 Catalog 中已审核通过的公开记录。具体版本和可用状态，请查看插件详情及应用内商店。", "The directory only shows approved public catalog entries. Check plugin details and the store in the app for specific versions and availability."],
 ["home.faq3", "页面中的动画是真实产品截图吗？", "Are these animations actual product screenshots?"],
 ["home.answer3", "动画取自官方设计稿或插件原有界面，并使用演示数据。对话胶囊和完成提醒由 ReAI 平台承载；各插件展示各自的流程。实际界面与可用功能，请以当前插件说明和安装版本为准。", "Animations use official designs or existing plugin views with sample data. The conversation capsule and completion notifications belong to the ReAI platform. Each plugin shows its own workflow. Check the current plugin information and installed version for available features and UI."],
 ["home.faq4", "插件如何使用我的数据和权限？", "How do plugins use my data and permissions?"],
 ["home.answer4", "不同插件需要的权限和服务不同，请在安装与使用时查看对应说明。开放平台网页只匿名读取公开目录，不需要登录。", "Permissions and services vary by plugin. Review the relevant information when installing and using them. This website reads the public catalog anonymously and does not require sign in."],
 ["home.faq5", "我可以开发自己的插件吗？", "Can I build my own plugin?"],
 ["home.answer5", "可以。从开发指南开始，按平台规范完成本地开发、打包和验证，再准备审核提交。", "Yes. Start with the developer guide, follow the platform specifications for local development, packaging, and validation, then prepare your review submission."],
 ["home.faq6", "有英文版本和英文文档吗？", "Is there an English site and documentation?"],
 ["home.answer6", "可以通过页面右上角切换中英文。英文文档目前为阅读指南，完整字段与示例请参照中文文档。", "Use the language switch at the top of the page. The English docs are currently reading guides; refer to the Chinese docs for complete fields and examples."],
 ["home.closing1", "带着想法来，", "Bring an idea."],
 ["home.closing2", "找到你的下一步。", "Find your next step."],
 ["home.heroPreview", "语音输入法 · 官方设计预览", "Voice input · Official design preview"],
 ["home.heroAlt", "语音输入法官方设计预览", "Official voice input design preview"],
 ["home.heroVideoAlt", "语音输入法官方设计演示：查看记录、打开详情与回听录音", "Official voice input design: browse recordings, open details and play back audio"],
 ["home.pluginMore", "了解插件", "View plugin"],
 ["home.footerNav", "页脚导航", "Footer navigation"]
);

export const messages = Object.fromEntries(['zh','en'].map((locale,i)=>[locale,Object.fromEntries(rows.map(([key,...texts])=>[key,texts[i]]))]));
const sourceKeys = new Map();
for(const [key,zh] of rows) if(!sourceKeys.has(zh)) sourceKeys.set(zh,key);
export const localeFromPath = path => /^\/(?:en(?:\/|$)|docs\/en(?:\/|$))/.test(path) ? 'en' : 'zh';
export function t(key, values={}, locale='zh') {
 const text=messages[locale]?.[key] ?? messages.zh[key];
 if(text===undefined) throw new Error(`Missing translation: ${key}`);
 return text.replace(/\{(\w+)\}/g,(_,name)=>String(values[name] ?? `{${name}}`));
}
export function translateText(text,locale='zh') {
 if(locale==='zh') return text;
 const trimmed=text.trim();
 if(trimmed.endsWith(' · ReAI Open')) return text.replace(trimmed,`${translateText(trimmed.slice(0,-12),locale)} · ReAI Open`);
 if(trimmed.startsWith('← 返回')) return text.replace(trimmed,`← Back to ${translateText(trimmed.slice(4),locale)}`);
 if(trimmed.endsWith(' 更新日志')) return text.replace(trimmed,`${translateText(trimmed.slice(0,-5),locale)} Changelog`);
 const key=sourceKeys.get(trimmed);
 if(key) return text.replace(trimmed,t(key,{},locale));
 const core=trimmed.replace(/^(?:←\s*)|(?:\s*[→↗])$/g,'');
 const coreKey=sourceKeys.get(core);
 if(coreKey) return text.replace(core,t(coreKey,{},locale));
 if(trimmed.endsWith(' · 场景示例')) return text.replace(trimmed,`${translateText(trimmed.slice(0,-7),locale)} · Example scenario`);
 if(trimmed.endsWith(' / 场景示例')) return text.replace(trimmed,`${translateText(trimmed.slice(0,-7),locale)} / Example scenario`);
 return text;
}
export function localizedPath(path,locale) {
 if(!path.startsWith('/') || path.startsWith('//') || /^\/(assets|docs\/assets)\//.test(path) || /\.(?:js|css|png|svg|json)(?:[?#]|$)/.test(path)) return path;
 let clean=path.replace(/^\/en(?=\/|$)/,'').replace(/^\/docs\/en(?=\/|$)/,'/docs') || '/';
 return locale==='en' ? (clean.startsWith('/docs') ? clean.replace(/^\/docs(?=\/|$)/,'/docs/en') : `/en${clean}`) : clean;
}
// Trusted generated markup only. Publisher content marked data-source-text is never translated.
export function localizeHtml(html,locale) {
 html=html.replaceAll('https://ai-board.reai.com/zh/download',`https://ai-board.reai.com/${locale}/download`);
 let protectedDepth=0;
 const stack=[];
 return html.split(/(<[^>]*>)/g).map(part=>{
  if(!part.startsWith('<')) return protectedDepth ? part : translateText(part,locale);
  const close=/^<\/(\w+)/.exec(part);
  if(close) {const was=stack.pop();if(was) protectedDepth--;return part;}
  const open=/^<(\w+)/.exec(part);
  if(open && !/^(?:meta|link|img|input|br|hr|source|area|wbr)$/i.test(open[1]) && !part.endsWith('/>')) {const protect=protectedDepth>0 || /data-source-text/.test(part) || /^(script|style)$/.test(open[1]);stack.push(protect);if(protect)protectedDepth++;}
  if(/^<html\b/.test(part)) part=part.replace(/lang="[^"]+"/,`lang="${locale==='en'?'en':'zh-CN'}"`);
  part=part.replace(/href="(\/[^\"]*)"/g,(_,url)=>`href="${localizedPath(url,locale)}"`);
  if(!protectedDepth) part=part.replace(/(aria-label|placeholder|content|title|alt)="([^"]*)"/g,(_,name,value)=>`${name}="${translateText(value,locale)}"`);
  return part;
 }).join('');
}
export function languageSwitcher(path,locale) {
 const next=locale==='en'?'zh':'en';
 return `<a id="site-language" class="language-switch" data-language-switch="${next}" href="${localizedPath(path,next)}" hreflang="${next==='en'?'en':'zh-CN'}" lang="${next==='en'?'en':'zh-CN'}" aria-label="${next==='en'?'Switch to English':'切换到中文'}">${next==='en'?'English':'中文'}</a>`;
}
