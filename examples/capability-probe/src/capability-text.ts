/**
 * 每项 Host 能力的人话说明。能力清单本身来自 `@reai/app-contract` 的支持矩阵，
 * 这里只补「它是做什么的」；矩阵里出现了这里没写的新能力时，界面用通用说明兜住，
 * 测试会提醒补文案。
 */

export type CapabilityGroup = "basic" | "permission" | "agent" | "files" | "device";

export interface CapabilityText {
  title: string;
  summary: string;
  group: CapabilityGroup;
}

export const GROUP_LABELS: Record<CapabilityGroup, string> = {
  basic: "界面与基础",
  permission: "需要用户同意",
  agent: "Agent 与云端",
  files: "文件",
  device: "语音、设备与系统",
};

export const CAPABILITY_TEXT: Record<string, CapabilityText> = {
  "surface.main@1": { group: "basic", title: "主界面", summary: "插件在 Driver 里打开一个自己的页面。每个插件只能有这一个页面。" },
  "sidebar.item@1": { group: "basic", title: "侧栏入口", summary: "在 Driver 左侧栏放一个图标，点了打开插件。" },
  "titlebar.action@1": { group: "basic", title: "标题栏按钮", summary: "在窗口顶部放最多 3 个快捷按钮，由 Driver 负责画和响应。" },
  "surface.navigation@1": { group: "basic", title: "面包屑导航", summary: "插件进入二级页面时，让顶部显示「插件名 / 子页面」和返回。" },
  "metadata.i18n@1": { group: "basic", title: "多语言名称（旧版）", summary: "插件名称和说明提供中英文两套。" },
  "metadata.i18n@2": { group: "basic", title: "多语言名称", summary: "插件名称、说明和商店文案按语言包提供多种语言。" },
  "storage.kv@1": { group: "basic", title: "本地小数据存储", summary: "按键值保存插件自己的数据，存在这台电脑上。单条最多 256 KB，每个插件共 32 MB。" },
  "commands@1": { group: "basic", title: "可绑定的命令", summary: "声明一个命令，用户可以把键盘按键或定时任务绑到它上面。" },
  "apps.intent@1": { group: "basic", title: "打开别的插件", summary: "请 Driver 打开另一个插件并带一句话过去；只能打开自己声明过依赖的插件。" },
  "apps.service@1": { group: "basic", title: "调用别的插件的服务", summary: "调用别的插件公开的功能，比如让 Voice 插件帮忙把语音转成文字。" },
  "apps.gateway@1": { group: "basic", title: "本机程序调用入口", summary: "让这台电脑上的其他程序（不是网页）调用插件公开的功能。还需要用户单独同意。" },
  "system.tasks@1": { group: "basic", title: "读取版本、打开设置页", summary: "读取 Driver 和固件版本，或者把用户带到 Driver 的某个设置页面。" },

  "account.status@1": { group: "permission", title: "是否已登录", summary: "只告诉插件「账户功能开没开、有没有登录」，不给用户身份。" },
  "os.notification.post@1": { group: "permission", title: "系统通知", summary: "发一条纯文字的系统通知。" },
  "http.fetch@1": { group: "permission", title: "网络请求", summary: "由 Driver 代为访问插件事先声明过的 https 地址。也是插件连接外脑的唯一通道。" },

  "agent.session@2": { group: "agent", title: "Agent 会话", summary: "用 Pi、DSH 或 Codex 跑一段 Agent 对话，可带文件工具。还需要「云端模型」批准。" },
  "agent.session@1": { group: "agent", title: "Agent 会话（旧版）", summary: "旧版 Agent 接口，新插件用 2 版。" },
  "agent.dsh@1": { group: "agent", title: "DSH 引擎（旧版直连）", summary: "直接调用 DSH 引擎的旧接口。" },
  "agent.local@1": { group: "agent", title: "本机 Agent 内核", summary: "设备医生使用的本机诊断 Agent。" },
  "agent.codex@1": { group: "agent", title: "连接 Codex 桌面版", summary: "Codex Link 插件用来驱动 Codex 桌面版。" },
  "agent.codex.tasks@1": { group: "agent", title: "Codex 任务", summary: "Codex App 插件用来管理 Codex 任务。" },
  "agent.pi-management@1": { group: "agent", title: "Pi 引擎管理", summary: "Pi 插件用来查看和设置 Pi 引擎。" },
  "agent.dsh-observe@1": { group: "agent", title: "DSH 引擎观察", summary: "DSH 插件用来查看 DSH 的会话和设置。" },
  "cloud.model.invoke@1": { group: "agent", title: "云端模型", summary: "用用户账户的额度调用外脑的大模型：聊天、转写、列出模型。" },
  "cloud.workflow.invoke@1": { group: "agent", title: "云端工作流（Host 通道）", summary: "经 Driver 调用登记过的外脑工作流。目前对所有插件都不通，公开做法是用网络请求直接调外脑接口。" },
  "local.terminal.exec@1": { group: "agent", title: "Agent 受控命令", summary: "让 Agent 在用户授权的目录里执行受限命令。仅 macOS。" },
  "terminal.session@1": { group: "agent", title: "终端会话", summary: "终端插件使用的交互式 Shell，由 Driver 托管。" },

  "resources.files@1": { group: "files", title: "文件夹与云项目文件", summary: "读写用户亲手选的文件夹或确认过的外脑云项目：列目录、读、写、新建、改名、移动、删除。本地和云端是同一套接口。" },
  "system.folder-pick@1": { group: "files", title: "选择工作文件夹", summary: "弹出系统面板让用户选一个文件夹，交给 Agent 当工作目录。" },
  "local.files@1": { group: "files", title: "文本编辑器专用文件通道", summary: "只给官方文本编辑器用的文件读写通道。" },
  "surface.file-picker@1": { group: "files", title: "通用文件选择", summary: "暂未开放。插件页面里的普通「选择文件」按钮可以只读打开用户选的文件。" },

  "voice.input@1": { group: "device", title: "语音输入", summary: "Voice 插件专用：录音和本地识别。" },
  "voice.command@1": { group: "device", title: "语音命令", summary: "Voice 插件专用：语音命令。" },
  "voice.recordings@1": { group: "device", title: "录音记录", summary: "Voice 插件专用：读取录音记录。" },
  "voice.deliver@1": { group: "device", title: "文字写回输入框", summary: "把一段文字写进当前光标所在的输入框。" },
  "voice.context@1": { group: "device", title: "读取当前输入框上下文", summary: "读取光标所在控件的文字和窗口截图，给 AI 当上下文。" },
  "audio.capture@1": { group: "device", title: "共享采音", summary: "登记为 Driver 统一采音的使用者。" },
  "audio.clips@1": { group: "device", title: "音频片段", summary: "读取 Driver 签发的一段录音片段。" },
  "tts.local@1": { group: "device", title: "本地语音合成", summary: "本地 TTS 插件专用的语音合成。" },
  "browser.engine@1": { group: "device", title: "内置浏览器", summary: "浏览器插件专用：驱动 Driver 自带的 Chromium。" },
  "computer.engine@1": { group: "device", title: "电脑操控", summary: "电脑操控插件专用：截图、点鼠标、按键盘。" },
  "activation.startup@1": { group: "device", title: "开机自启", summary: "Driver 启动时自动运行插件。" },
  "surface.clipboard@1": { group: "device", title: "写剪贴板", summary: "把一段纯文字写进剪贴板。" },
  "surface.escape@1": { group: "device", title: "接管 Esc 键", summary: "插件页面显示时参与 Esc 键处理。" },
  "tasks.present@1": { group: "device", title: "后台任务胶囊", summary: "把插件的长任务显示在 Driver 的任务胶囊里。后端目前不能审批。" },
  "notifications.publish@1": { group: "device", title: "分场景通知", summary: "按场景发通知并保留通知历史。后端目前不能审批。" },
  "developer.platform@1": { group: "device", title: "开放平台管理", summary: "开发者中心插件专用：管理产品、OAuth 应用和体验者。" },
  "surface.worker@1": { group: "device", title: "后台工作线程", summary: "暂未开放。" },
  "bindings.recommended@1": { group: "device", title: "推荐键位", summary: "不会开放：键位一律由用户自己配。" },
};

export function textFor(id: string): CapabilityText {
  return CAPABILITY_TEXT[id] ?? { group: "device", title: id, summary: "这是支持矩阵里的新能力，探针还没有写它的说明。" };
}
