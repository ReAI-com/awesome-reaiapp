import { t } from "./voice-i18n";
/**
 * Voice 插件自己的应用层合同。
 *
 * 这里故意不出现 URL、OAuth token、provider、模型密钥或外脑 DTO。Voice 只声明
 * 自己想完成的结果；未来可以用 Driver Host 的统一 AI Broker 在本地编排，也可以用
 * 统一 Workflow Broker 在云端编排，两种适配器都实现同一个 ProcessorPort。
 *
 * 核心模型：**只有一套 Voice Command 运行时**。
 * 纯转写、翻译、交给 Agent 都不是并列的“模式”，而是同一条运行时上的不同命令类型。
 * 它们只在两件事上有差别：
 *   1. 识别之后还要做什么（steps；润色只作用于转文本，2026-09-27 定稿）；
 *   2. 结果落到哪里（delivery：直接写回目标应用，还是弹面板给人看/确认）。
 * 哪一档硬件触发跑哪种命令，由 Host 的按键绑定配置决定，Voice 只消费绑定表。
 */

export const VOICE_COMMAND_CONTRACT_VERSION = "voice-command.app.v1" as const;

/**
 * 命令类型 ID。
 *
 * 故意是 string 而不是封闭联合：命令集要能被配置和扩展，写死枚举会让“加一种命令”
 * 变成改合同。内置的几种在 BUILTIN_VOICE_COMMANDS 里给出稳定 ID。
 */
export type VoiceCommandId = string;

export const BUILTIN_VOICE_COMMANDS = {
  /** 说什么写什么：润色后直接写回目标应用（语音输入法的命令形态）。 */
  transcribe: "voice.command.transcribe",
  /** 说母语、写外语：翻译（不润色）→ 直接写回目标应用；翻译失败不写原文。 */
  translate: "voice.command.translate",
  /** 交给 Agent：整理成提示词 → Agent 执行，结果走只读面板，永不写回。 */
  agent: "voice.command.agent",
} as const;

export type VoiceCommandStage =
  | "capture.listening"
  | "stt.transcribing"
  | "text.polishing"
  | "text.translating"
  | "prompt.refining"
  | "agent.waiting"
  | "agent.reasoning"
  | "tool.web_search"
  | "tool.knowledge_search"
  | "answer.generating"
  | "delivery.writing";

export const VOICE_COMMAND_STAGE_LABELS: Readonly<Record<VoiceCommandStage, string>> = {
  get "capture.listening"() { return t("contract.message1"); },
  get "stt.transcribing"() { return t("contract.message2"); },
  get "text.polishing"() { return t("contract.message3"); },
  get "text.translating"() { return t("contract.message4"); },
  get "prompt.refining"() { return t("contract.message5"); },
  get "agent.waiting"() { return t("contract.message6"); },
  get "agent.reasoning"() { return t("contract.message7"); },
  get "tool.web_search"() { return t("contract.message8"); },
  get "tool.knowledge_search"() { return t("contract.message9"); },
  get "answer.generating"() { return t("contract.message10"); },
  get "delivery.writing"() { return t("contract.message11"); },
};

export interface VoicePromptRef {
  /** 由 Voice App 持有的稳定提示词 ID。 */
  id: string;
  /** 提示词语义版本；修改既有语义时必须升级。 */
  version: string;
}

export const DEFAULT_VOICE_PROMPTS = {
  polish: { id: "voice.polish.spoken-text", version: "3" },
  translate: { id: "voice.translate.realtime", version: "1" },
  promptify: { id: "voice.promptify.agent-request", version: "1" },
  digest: { id: "voice.digest.day-summary", version: "2" },
  segmentSummary: { id: "voice.digest.segment-summary", version: "1" },
} as const satisfies Readonly<
  Record<"polish" | "translate" | "promptify" | "digest" | "segmentSummary", VoicePromptRef>
>;

/* ═══ 命令定义：一种命令 = 识别之后做什么 + 结果落到哪 ═══ */

/**
 * 识别之后的处理步骤。
 *
 * 润色本身不在这里 —— 它只作用于转文本（语音输入法），见 VoiceCommandRequest.preprocess；
 * 翻译与 Agent 不润色，交给后续步骤的就是识别原文（2026-09-27 定稿）。
 */
export type VoiceCommandStep =
  | {
      kind: "translate";
      prompt: VoicePromptRef;
      /** BCP 47；必须显式给出，不能由失败回退伪装成翻译成功。 */
      targetLanguage: string;
    }
  | {
      kind: "promptify";
      prompt: VoicePromptRef;
    }
  | {
      kind: "agent";
      agentProfileId: string;
      /** 只是意图提示；最终可用工具仍由 Host 权限与 Agent 策略决定。 */
      capabilityHints?: readonly ("web_search" | "knowledge_search")[];
    };

/**
 * 结果落点。这是命令之间唯一真正影响用户感知的差别。
 *
 * - write_back：说完直接进目标应用，零点击。转写与翻译走这条。
 * - panel：结果需要人看一眼，弹面板。
 *
 * 面板里是「直接给答案」还是「先给一份待执行计划」，由运行时事件决定 ——
 * 收到 plan.proposed 就是计划面板，没收到就是答案面板。同一句「帮我查下 X」
 * 可能立刻答完，也可能需要先出计划，所以这件事不能在命令定义时写死。
 */
export type VoiceCommandDelivery =
  | {
      kind: "write_back";
      behavior: "insert" | "replace_selection";
    }
  | {
      kind: "panel";
      /**
       * 出现计划面板时，停留多久自动开始执行；null = 必须由用户显式确认。
       *
       * 自动开始只允许用于用户已授权的低风险命令；任何会产生外部副作用的计划
       * 都应该给 null，让确认成为真实动作而不是超时默认值。
       */
      autoStartMs: number | null;
    };

export interface VoiceCommandDefinition {
  id: VoiceCommandId;
  /** 胶囊与面板上的短标签，如「翻译」「Agent」。 */
  label: string;
  /** 识别之后还要做什么；空数组 = 润色完就交付（纯转写）。 */
  steps: readonly VoiceCommandStep[];
  delivery: VoiceCommandDelivery;
}

/**
 * 硬件触发 → 命令类型的绑定。
 *
 * bindingId 是 Host 按键/拨杆绑定产生的不透明事件 ID，Voice 不解释它的物理含义，
 * 也不假设「拨杆一定是三档」。换绑、加档、把长按分出去都只改这张表，不改运行时。
 */
export interface VoiceCommandBinding {
  bindingId: string;
  commandId: VoiceCommandId;
}

export interface VoiceTranscript {
  /** 本地或云端 STT 的最终文本；空文本不得进入 AI 处理。 */
  text: string;
  /** BCP 47 语言标签；无法可靠判断时使用 `und`。 */
  language: string;
  source: "local" | "cloud";
  durationMs: number;
}

/** Host 托管的短时音频引用。插件拿不到本地路径，也不能把引用发送给任意端点。 */
export interface VoiceAudioInputRef {
  id: string;
  expiresAt: string;
  durationMs: number;
  format: "pcm_s16le_16khz_mono" | "wav" | "webm";
}

/**
 * 本地 STT 走 transcript；云端 ASR 或“ASR + 润色”工作流可走 audio。
 * 适配器可以把声明的多个语义步骤合并成一次云端工作流，但不能改变最终语义。
 */
export type VoiceCommandInput =
  | { kind: "transcript"; transcript: VoiceTranscript }
  | { kind: "audio"; audio: VoiceAudioInputRef; languageHint?: string };

export interface VoiceContextEnvelope {
  /** Host 采集并裁剪后的不透明上下文版本，方便审计与失效处理。 */
  version: "1";
  /** 用户明确允许发送时才出现；Voice 不主动读取其他 App。 */
  nearbyText?: string;
  /** 触发瞬间的有界焦点窗口截图；只用于当次模型请求，不进历史。 */
  images?: Array<{
    mime: "image/jpeg";
    dataBase64: string;
    width: number;
    height: number;
  }>;
  /**
   * 只用于语气和格式提示，不包含窗口标题或文件路径。
   *
   * `terminal` 是 V-2 加的一档：终端里该写的是命令而不是句子，语气提示不一样；
   * 更要紧的是宿主对这一档**根本不采窗口文字**（整屏命令行上常有刚 export 的
   * token），所以它经常是「只有分类、没有文字」的那种上下文。
   */
  appCategory?: "editor" | "chat" | "email" | "browser" | "terminal" | "other";
}

export interface VoiceCommandRequest {
  requestId: string;
  /** 本次要跑哪种命令；通常由 bindingId 查绑定表得到。 */
  command: VoiceCommandDefinition;
  input: VoiceCommandInput;
  context?: VoiceContextEnvelope;
  /** 选择应用内的编排配置；它不是 provider、URL 或模型 ID。 */
  profileId: string;
  /**
   * 口语转写润色前置：只有转文本（语音输入法）带；翻译与 Agent 不润色（2026-09-27
   * 定稿）。适配器可以和 ASR 合并调用。
   */
  preprocess?: {
    kind: "polish";
    prompt: VoicePromptRef;
    required: true;
  };
}

/* ═══ 运行时事件 ═══ */

interface VoiceRunEventBase {
  runId: string;
  /** 同一次 run 内严格递增；客户端用它丢弃迟到、重复或乱序事件。 */
  sequence: number;
  /** 从本次 run 开始计算；不知道终点时只显示已运行时间，不猜百分比。 */
  elapsedMs: number;
}

/** 计划型命令在等待确认时的快照；面板直接渲染它，不另建一份数据。 */
export interface VoiceCommandPlan {
  title: string;
  steps: readonly string[];
  /** 到点自动开始的剩余毫秒；null = 必须显式确认。 */
  autoStartMs: number | null;
  /** 命令类型徽章（面板头部的短标签，稿 .cmd-badge）；缺省时面板不渲染徽章。 */
  badge?: string;
}

/**
 * 转入后台后，胶囊收进角落时携带的引用。
 *
 * ⚠️ 这条是产品约定，不是可选优化：
 *
 * **角落里的胶囊不是进度条，是一个真实 Agent 会话的门。**
 * 它背后必须有一条能打开、能继续说话的会话；胶囊只是把「到哪了、要不要你管」
 * 这几个关键信号映射到表面。任何「只显示进度、点进去没有会话」或「进度由计时器
 * 编出来」的实现都违反本约定 —— 那是无源的动画，不是有源的任务。
 *
 * 由此派生的三条硬要求：
 * 1. 运行中就能进去看和继续对话，**不必等它跑完**（见 interactiveWhileRunning）；
 * 2. 任务一收进角落，用户就腾出手了，必须能立刻用语音起下一个 —— 后台任务
 *    天然是多条并存的，不是单例；
 * 3. 进去是可选的。胶囊上的信息够用时就别逼人打开对话 —— 让人无感拿到结果，
 *    比把人拽进产品里更重要。
 */
export interface VoiceBackgroundTaskRef {
  taskId: string;
  label: string;
  /**
   * 背后那条真实会话。点胶囊 = 打开它。
   *
   * 没有会话就不该产生后台任务：宁可让这次运行停在前台，也不要造一个
   * 点进去空无一物的假任务。
   */
  conversationId: string;
  /**
   * 恒为 true，写成字面量是为了让「运行中不可进入」的实现无法通过类型检查。
   * 用户可以在 Agent 还在跑的时候进去看它此刻在做什么，并追加要求。
   */
  interactiveWhileRunning: true;
}

export type VoiceCommandEvent =
  | (VoiceRunEventBase & {
      type: "run.started";
      commandId: VoiceCommandId;
    })
  | (VoiceRunEventBase & {
      type: "stage.started" | "stage.completed";
      stage: VoiceCommandStage;
      /** 循环或并发时用于配对同一阶段实例。 */
      instanceId: string;
    })
  | (VoiceRunEventBase & {
      type: "output.delta";
      channel: "transcript" | "answer";
      delta: string;
    })
  | (VoiceRunEventBase & {
      /** 计划已生成，正在等用户确认或等自动开始倒计时。 */
      type: "plan.proposed";
      plan: VoiceCommandPlan;
    })
  | (VoiceRunEventBase & {
      type: "plan.confirmed";
      /** 区分「人点了确认」和「倒计时到点」，两者的后续追责口径不同。 */
      by: "user" | "auto_start";
    })
  | (VoiceRunEventBase & {
      /**
       * 这次运行要跑久，胶囊从眼前收进角落继续驻留。
       *
       * 只是呈现位置变了，run 没有结束 —— 后续事件照常发，直到 completed/failed。
       */
      type: "run.backgrounded";
      task: VoiceBackgroundTaskRef;
    })
  | (VoiceRunEventBase & {
      type: "run.completed";
    })
  | (VoiceRunEventBase & {
      type: "run.failed";
      error: VoiceCommandError;
    })
  | (VoiceRunEventBase & {
      type: "run.cancelled";
      reason: "user" | "superseded" | "host_shutdown";
    });

export interface VoiceCommandError {
  code:
    | "not_logged_in"
    | "permission_denied"
    | "invalid_request"
    | "unavailable"
    | "timeout"
    | "rate_limited"
    | "tool_failed"
    | "cancelled"
    | "unknown";
  message: string;
  retryable: boolean;
}

export interface VoiceSourceCitation {
  id: string;
  title: string;
  /** 由 Host/Workflow 审核后的安全 URL；没有真实来源时不要构造。 */
  url?: string;
}

/**
 * 命令结果。
 *
 * text 是「可以交付的最终文本」：转写命令是润色稿，翻译命令是译文，Agent 命令是答案。
 * 交付端只认 text，不需要知道中间跑了几步 —— 中间产物放在 trace 里供审阅与调试。
 */
export interface VoiceCommandResult {
  runId: string;
  commandId: VoiceCommandId;
  text: string;
  /** 用户实际说出口的话，润色前；结果面板的对照区靠它。 */
  originalText: string;
  /** 润色/翻译/整理提示词等中间产物；面板按需展示，交付端忽略。 */
  trace: VoiceCommandTrace;
  citations: readonly VoiceSourceCitation[];
}

export interface VoiceCommandTrace {
  /** 交付前的文本：转文本是润色稿；翻译与 Agent 不润色，就是识别原文。 */
  polishedText: string;
  /** 润色是否真的改动了原文；没改就别在界面上假装有 diff。 */
  polishChanged: boolean;
  /** 翻译命令才有。 */
  translation?: {
    sourceLanguage: string;
    targetLanguage: string;
  };
  /** Agent 命令才有：交给 Agent 的那份提示词。 */
  refinedPrompt?: string;
}

export interface VoiceCommandRun {
  runId: string;
  /** 真实阶段流；UI 不得用定时器自行猜“搜索/知识库/推理”。 */
  events: AsyncIterable<VoiceCommandEvent>;
  result: Promise<VoiceCommandResult>;
  cancel(reason?: "user" | "superseded"): Promise<void>;
  /** 计划型命令专用：面板上点 Confirm 或倒计时到点时调用。 */
  confirmPlan(by: "user" | "auto_start"): Promise<void>;
}

/**
 * Voice UI 唯一依赖的处理口。
 *
 * - Host AI 适配器可在本地组合多次模型/Agent 调用；
 * - Host Workflow 适配器可把同一请求交给云端编排；
 * - Fixture 适配器给静态页与测试使用。
 */
export interface VoiceCommandProcessorPort {
  start(request: VoiceCommandRequest, options?: { signal?: AbortSignal }): Promise<VoiceCommandRun>;
}

/** 录音开始时由 Host 捕获的不透明写入目标；插件不能伪造或反解。 */
export interface VoiceDeliveryTargetRef {
  id: string;
  expiresAt: string;
}

export interface VoiceTextDeliveryPort {
  commit(
    input: {
      runId: string;
      target: VoiceDeliveryTargetRef;
      text: string;
      behavior: "insert" | "replace_selection";
    },
    options?: { signal?: AbortSignal },
  ): Promise<
    | { committed: true }
    | {
        committed: false;
        /**
         * 失败原因。**每一种都要如实告诉用户**，不能把没写进去说成写进去了。
         *
         * - `expired` —— 目标超时、已消费或已被新录音替换。
         * - `focus_changed` —— 无法恢复或确认这条录音的目标输入控件。
         * - `own_overlay_focused` —— 旧 Host 的 PID 写回路径检测到自身浮层抢焦点。
         *   新 macOS Host 校验具体外部输入控件并向其 PID 投递，不使用这一判定。
         * - `unknown_target` —— 目标不存在或已被用过（一次性，拒绝也消费）。
         * - `no_input_target` —— 录音时就没有可写入的前台应用。
         * - `denied` —— 系统拒绝，通常是缺辅助功能权限。
         * - `insert_failed` —— 注入本身失败。
         */
        reason:
          | "expired"
          | "focus_changed"
          | "own_overlay_focused"
          | "unknown_target"
          | "no_input_target"
          | "denied"
          | "insert_failed";
      }
  >;
}

/**
 * Host 承载同一枚胶囊、命令面板与角落驻留态；Voice 只发送有界事件和结果。
 *
 * 胶囊、面板、角落驻留是同一个东西的三种形态，不是三个组件 —— 所以这里没有
 * 「显示角落指示器」这种独立入口，位置迁移由 run.backgrounded 事件驱动。
 *
 * **角落是多任务区，不是单个槽位。** 多条后台任务各占一枚胶囊、从下往上堆成一列，
 * 每一枚点下去直接进它自己的会话。所以这里的每个方法都按 runId / taskId 寻址，
 * 不存在「当前那一个」的隐含单例 —— 任何用单变量存住「正在跑的任务」的实现，
 * 都会在用户起第二个任务时把第一个顶掉。
 *
 * **没有「待命态」这一档。** 胶囊由快捷键 / 语音键唤起，走完流程就消失；屏幕上
 * 不存在一枚常驻的「开始语音」浮层。begin() 之前什么都不该显示 —— 静态交互稿里
 * 那枚虚线胶囊只是给评审的可点入口，不是产品形态。
 *
 * **角落任务卡只承载基本信息**：标题、运行时间、执行计划、执行进度。它是让人扫
 * 一眼就知道该不该管的卡片，不是干活的地方 —— 要补要求、要追问、要叫停，一律进
 * App 里的任务对话（openConversation）。不要往卡片上放输入框：太重，也不是好的
 * 交互场景。
 *
 * **角落胶囊贴边收起。** 用户的常态不是「想看进度」，而是「知道有这么回事就行」：
 * 一枚胶囊保持同一状态超过 3 秒就滑到屏幕边上，只留一个头 —— 一枚左平右圆、
 * 带 padding 的半个圆角按钮，icon 直接表明在跑还是已完成。鼠标移上去展开看标题
 * 与进度，移开重新倒计时 3 秒收回。
 *
 * 三条容易做错的地方：
 * 1. **时间读数在跳不算「状态变了」** —— 把它算进去，运行中的任务永远收不回去，
 *    贴边设计就白做了。只有阶段/状态真的换了才重新探头。
 * 2. **需要人处理的不收**（失败等）—— 那正是它该被看见的时候。
 * 3. 承载它的 DOM 要按 taskId 复用。这块每半秒刷一次时间，整片重建会把收起/展开
 *    的过渡永远打断在第一帧。
 */
export interface VoiceCommandPresentationPort {
  begin(input: { runId: string; command: VoiceCommandDefinition }): Promise<void>;
  publish(event: VoiceCommandEvent): Promise<void>;
  present(result: VoiceCommandResult): Promise<void>;
  /**
   * 打开这条后台任务背后的会话 —— 点角落胶囊就是调它。
   *
   * 运行中和已完成都必须可调：用户想在 Agent 干活的中途进去看一眼、补一句要求，
   * 是这套设计的核心，不是完成后才解锁的功能。
   */
  openConversation(taskId: string): Promise<void>;
  /**
   * 撤下某次运行的呈现。
   *
   * ⚠️ 完成 **不等于** 该撤下：后台任务跑完后角落胶囊要一直留着，直到用户真的
   * 看过（打开会话或显式收掉）。用户可能正在开会或写东西，几秒后自动消失
   * 等于把辛苦跑出来的结果弄丢了。所以不要给它挂定时器。
   */
  dismiss(runId: string): Promise<void>;
}

export interface VoiceCommandAppPorts {
  processor: VoiceCommandProcessorPort;
  delivery: VoiceTextDeliveryPort;
  presentation: VoiceCommandPresentationPort;
}

/* ═══ 内置命令目录 ═══ */

export const VOICE_COMMAND_CATALOG: Readonly<Record<string, VoiceCommandDefinition>> = {
  transcribe: {
    id: BUILTIN_VOICE_COMMANDS.transcribe,
    get label() { return t("contract.message12"); },
    steps: [],
    delivery: { kind: "write_back", behavior: "insert" },
  },
  translate: {
    id: BUILTIN_VOICE_COMMANDS.translate,
    get label() { return t("contract.message13"); },
    steps: [
      {
        kind: "translate",
        prompt: DEFAULT_VOICE_PROMPTS.translate,
        targetLanguage: "en-US",
      },
    ],
    delivery: { kind: "write_back", behavior: "insert" },
  },
  agent: {
    id: BUILTIN_VOICE_COMMANDS.agent,
    label: "Agent",
    steps: [
      { kind: "promptify", prompt: DEFAULT_VOICE_PROMPTS.promptify },
      { kind: "agent", agentProfileId: "default", capabilityHints: ["web_search", "knowledge_search"] },
    ],
    // 会产生外部副作用，所以不给自动开始 —— 确认必须是真实动作。
    delivery: { kind: "panel", autoStartMs: null },
  },
};
