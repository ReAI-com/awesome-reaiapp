import { OPERATIONS_ROLES } from '../showcase/roles-operations';
import { PEOPLE_ROLES } from '../showcase/roles-people';
import { LEADERSHIP_ROLES } from '../showcase/roles-leadership';
import type { Priority, Role } from '../showcase/types';

export type RestaurantField = [key: string, label: string, type: 't' | 's' | 'n' | 'm' | 'p' | 'd', options?: string[]];
export type RestaurantRow = (string | number)[];
export type RestaurantCondition = [string, '=' | '<' | '>', string | number];
export interface RestaurantSection {
  oldBoardId: string; title: string; topic: string; cols: string[]; labels: string[];
  requirementIds: number[]; priority: Priority; purpose: string;
}
export interface RestaurantTask { id: string; title: string; need: string; inputs: number[]; cands: [string, string][] }
export interface RestaurantRule {
  id: string; name: string; ver: number;
  tgt: { k: 'own' | 'other' | 'phys'; label: string; ref?: { appId: string; role: string; objectType: string; objectId: string; version: number }; access?: 'ok' | 'unauthorized' | 'notInstalled' };
}
export type RestaurantResult = [ruleId: string, outcome: 'pass' | 'fail' | 'error' | 'insufficient', object: string, message: string, recordIndex: number | null, retry?: boolean, plain?: { obj?: string; msg?: string }];
export interface RestaurantBoard {
  id: string; title: string; icon: string; type: 'B' | 'C' | 'D'; purpose: string;
  sections: RestaurantSection[]; cols: string[]; actions: string[];
  metrics: { l: string; op: 'count' | 'distinct'; f?: string; w?: RestaurantCondition }[];
  chart?: { k: 'bar'; by: string }; filter?: RestaurantCondition | RestaurantCondition[];
  tasks?: RestaurantTask[]; rules?: RestaurantRule[];
  runs?: { id: string; at: string; results: RestaurantResult[] }[];
}
export interface RestaurantSource {
  name: string; kind: string; st: 'done' | 'ready' | 'issue'; preview: string;
  issues?: [number, string, string][]; yields?: RestaurantRow[];
}
export interface RestaurantRole {
  id: string; name: string; icon: string; main: string; combo: string[]; user: string;
  department: string; requirementIds: number[]; priorities: Priority[]; priority: Priority;
  scopeNote: string; scopeUncertain: boolean; summary: string;
  aDesc: string; bName: string; cdDesc: string; rule: string; ruleVer: string;
  sem: { group: string; metric: null; agg: null; owner: null; unit: string };
  fields: RestaurantField[]; rows: RestaurantRow[]; rowsSourceIndices: number[];
  sources: RestaurantSource[]; boards: RestaurantBoard[]; suggest: [string, string][];
  legacyTasks: { task: string; themeId: string; oldBoardId: string }[];
  rules: string[];
}
export interface ThemeGroup {
  roleId: string; main: string; combo: string[]; bName: string; scopeUncertain?: boolean;
  themes: { id: string; title: string; type: 'B' | 'C' | 'D'; oldBoardIds: string[] }[];
}
export interface CoverageEntry {
  roleId: string; oldBoardId: string; oldTitle: string; themeId: string; themeTitle: string;
  requirementIds: number[]; priority: Priority; rowCount: number;
}

/* Navigation groups reorganize all 83 legacy topics; no source topics or sample cells are removed. */
export const THEME_GROUPS: ThemeGroup[] = [
  { roleId: 'training', main: 'A-B-C', combo: ['D'], bName: '培训需求与资源记录', themes: [
    { id: 'training-plan', title: '培训班表', type: 'C', oldBoardIds: ['training-calendar', 'training-changes'] },
    { id: 'training-inputs', title: '需求与资源', type: 'B', oldBoardIds: ['training-resources', 'training-backlog'] },
    { id: 'training-check', title: '排班核验', type: 'D', oldBoardIds: ['training-conflicts'] },
  ] },
  { roleId: 'examiner', main: 'A-B-D', combo: ['C'], bName: '收卷与评分证据记录', themes: [
    { id: 'examiner-inputs', title: '收卷与证据', type: 'B', oldBoardIds: ['examiner-submissions', 'examiner-evidence'] },
    { id: 'examiner-feedback', title: '复核与补考', type: 'C', oldBoardIds: ['examiner-review', 'examiner-retakes'] },
    { id: 'examiner-check', title: '训练问题', type: 'D', oldBoardIds: ['examiner-patterns'] },
  ] },
  { roleId: 'operations', main: 'A-B-D', combo: ['C'], bName: '巡检与整改证据记录', themes: [
    { id: 'operations-inputs', title: '巡店与资料', type: 'B', oldBoardIds: ['operations-visits', 'operations-extraction'] },
    { id: 'operations-product-check', title: '出品检查', type: 'D', oldBoardIds: ['operations-weight', 'operations-plating'] },
    { id: 'operations-meeting-feedback', title: '训练会', type: 'C', oldBoardIds: ['operations-meetings'] },
    { id: 'operations-welcome-check', title: '迎宾复查', type: 'D', oldBoardIds: ['operations-welcome'] },
  ] },
  { roleId: 'vi', main: 'A-B-C', combo: ['D'], bName: '设计需求与规范资产记录', themes: [
    { id: 'vi-deliverables', title: '概念与审稿', type: 'C', oldBoardIds: ['vi-concepts', 'vi-reviews'] },
    { id: 'vi-inputs', title: '延展与资产', type: 'B', oldBoardIds: ['vi-extensions', 'vi-batches'] },
    { id: 'vi-check', title: '规范验收', type: 'D', oldBoardIds: ['vi-quality'] },
  ] },
  { roleId: 'space', main: 'A-B-C', combo: ['D'], bName: '空间输入与范围问题记录', scopeUncertain: true, themes: [
    { id: 'space-inputs', title: '项目与输入', type: 'B', oldBoardIds: ['space-projects', 'space-dimensions'] },
    { id: 'space-concepts', title: '布局讨论', type: 'C', oldBoardIds: ['space-plan'] },
    { id: 'space-check', title: '图纸交付', type: 'D', oldBoardIds: ['space-review'] },
  ] },
  { roleId: 'cost', main: 'A-B', combo: ['C', 'D'], bName: '工程量与计价依据记录', themes: [
    { id: 'cost-deliverables', title: '预算与变更', type: 'C', oldBoardIds: ['cost-budget', 'cost-changes'] },
    { id: 'cost-inputs', title: '价格与比选', type: 'B', oldBoardIds: ['cost-prices', 'cost-options'] },
    { id: 'cost-check', title: '结算核验', type: 'D', oldBoardIds: ['cost-settlement'] },
  ] },
  { roleId: 'supply', main: 'A-B', combo: ['C', 'D'], bName: '库存批次与计划记录', themes: [
    { id: 'supply-stock', title: '库存与补货', type: 'B', oldBoardIds: ['inventory', 'orders'] },
    { id: 'supply-check', title: '批次核验', type: 'D', oldBoardIds: ['batches', 'exceptions'] },
    { id: 'supply-arrivals', title: '到货协同', type: 'C', oldBoardIds: ['arrivals'] },
    { id: 'supply-test', title: '新品测试', type: 'B', oldBoardIds: ['new-products'] },
  ] },
  { roleId: 'dispatch', main: 'A-B-C', combo: ['D'], bName: '配送需求与运力记录', themes: [
    { id: 'dispatch-deliverables', title: '线路方案', type: 'C', oldBoardIds: ['routes', 'unassigned'] },
    { id: 'dispatch-inputs', title: '运力与约束', type: 'B', oldBoardIds: ['vehicles', 'constraints'] },
    { id: 'dispatch-check', title: '执行异常', type: 'D', oldBoardIds: ['route-exceptions'] },
  ] },
  { roleId: 'organization', main: 'A-B', combo: ['C', 'D'], bName: '岗位组织与编制记录', themes: [
    { id: 'organization-deliverables', title: '岗位说明书', type: 'C', oldBoardIds: ['descriptions', 'approvals'] },
    { id: 'organization-versions', title: '发布与联动', type: 'B', oldBoardIds: ['versions'] },
    { id: 'organization-check', title: '组织自检', type: 'D', oldBoardIds: ['structure', 'org-checks'] },
    { id: 'organization-costs', title: '人工成本口径', type: 'B', oldBoardIds: ['cost-diagnosis'] },
  ] },
  { roleId: 'performance', main: 'A-B-D', combo: ['C'], bName: '绩效来源与周期核对记录', themes: [
    { id: 'performance-submission-check', title: '周期填报', type: 'D', oldBoardIds: ['submissions', 'module-kpi'] },
    { id: 'performance-inputs', title: '战略与实际值', type: 'B', oldBoardIds: ['strategy', 'actuals'] },
    { id: 'performance-policy-check', title: '群体政策', type: 'D', oldBoardIds: ['group-rules'] },
    { id: 'performance-results', title: '结果核验', type: 'C', oldBoardIds: ['result-sync'] },
  ] },
  { roleId: 'hr', main: 'A-B', combo: ['D', 'C'], bName: '人员事件与人力服务记录', themes: [
    { id: 'hr-inputs', title: '人员与例行报表', type: 'B', oldBoardIds: ['events', 'routine-reports'] },
    { id: 'hr-payroll-check', title: '发薪数据核验', type: 'D', oldBoardIds: ['payroll-audit'] },
    { id: 'hr-feedback', title: '回访与满意度', type: 'C', oldBoardIds: ['exit-surveys', 'satisfaction'] },
    { id: 'hr-grades', title: '职级结构', type: 'B', oldBoardIds: ['grade-ratios'] },
  ] },
  { roleId: 'recruitment', main: 'A-B', combo: ['C', 'D'], bName: '招聘编制候选与渠道记录', themes: [
    { id: 'recruitment-inputs', title: '门店与候选', type: 'B', oldBoardIds: ['hiring', 'pipeline'] },
    { id: 'recruitment-interviews', title: '面试与反馈', type: 'C', oldBoardIds: ['interviews'] },
    { id: 'recruitment-channel-check', title: '渠道与费用', type: 'D', oldBoardIds: ['channels', 'expenses'] },
    { id: 'recruitment-team', title: '团队任务', type: 'B', oldBoardIds: ['weekly'] },
  ] },
  { roleId: 'legal', main: 'A-B-D', combo: ['C'], bName: '法律事务与证据档案记录', themes: [
    { id: 'legal-contract-check', title: '事务与合同', type: 'D', oldBoardIds: ['requests', 'contracts'] },
    { id: 'legal-research', title: '案件与研究', type: 'C', oldBoardIds: ['cases'] },
    { id: 'legal-rights-check', title: '权利与品牌', type: 'D', oldBoardIds: ['ip'] },
    { id: 'legal-inputs', title: '档案与对比', type: 'B', oldBoardIds: ['archives', 'compare'] },
  ] },
  { roleId: 'chairman', main: 'A-B-D', combo: ['C'], bName: '经营议题与范围问题记录', scopeUncertain: true, themes: [
    { id: 'chairman-brief', title: '经营议题室', type: 'C', oldBoardIds: ['overview'] },
    { id: 'chairman-inputs', title: '会议与协同材料', type: 'B', oldBoardIds: ['materials'] },
    { id: 'chairman-boundary-check', title: '人设、形象与边界', type: 'D', oldBoardIds: ['identity'] },
  ] },
  { roleId: 'ceo', main: 'A-B-D', combo: ['C'], bName: '经营协调与范围问题记录', scopeUncertain: true, themes: [
    { id: 'ceo-brief', title: '经营协调简报', type: 'C', oldBoardIds: ['overview'] },
    { id: 'ceo-inputs', title: '会议与协同材料', type: 'B', oldBoardIds: ['materials'] },
    { id: 'ceo-boundary-check', title: '人设、形象与边界', type: 'D', oldBoardIds: ['identity'] },
  ] },
  { roleId: 'vp1', main: 'A-B', combo: ['C', 'D'], bName: '分管范围与素材问题记录', scopeUncertain: true, themes: [
    { id: 'vp1-scope', title: '分管范围待确认', type: 'C', oldBoardIds: ['overview'] },
    { id: 'vp1-inputs', title: '资料与问题清单 1', type: 'B', oldBoardIds: ['materials'] },
    { id: 'vp1-boundary-check', title: '人设、形象与边界', type: 'D', oldBoardIds: ['identity'] },
  ] },
  { roleId: 'vp2', main: 'A-B', combo: ['C', 'D'], bName: '分管范围与素材问题记录', scopeUncertain: true, themes: [
    { id: 'vp2-scope', title: '分管范围待确认', type: 'C', oldBoardIds: ['overview'] },
    { id: 'vp2-inputs', title: '资料与问题清单 2', type: 'B', oldBoardIds: ['materials'] },
    { id: 'vp2-boundary-check', title: '人设、形象与边界', type: 'D', oldBoardIds: ['identity'] },
  ] },
];

interface DeliverySeed { title: string; need: string; inputs: [string, number][]; cands: [string, string][] }
const DELIVERIES: Record<string, DeliverySeed> = {
  training: { title: 'T-103 食安复训改期班表', need: '演示比较改期方案，保留原班表；讲师可用和场地均需人工确认，不通知人员。', inputs: [['training-calendar', 2], ['training-resources', 0], ['training-changes', 0]], cands: [
    ['周四改期讨论稿', 'T-103 拟改至10月15日09:00–10:00；训练员A该时段尚未登记可用，需补确认。保留原班表，10名伙伴及在线会议室录制条件仍待核对。'],
    ['周五可用时段草案', 'T-103 拟改至10月16日09:00–10:00；训练员A登记周五上午可用，仍需核对新增占用、场地和10名伙伴。人工确认前不覆盖原安排、不发通知。'],
  ] },
  examiner: { title: 'V-101/V-102 补证与复核反馈', need: '演示按缺失证据形成反馈候选，不发布最终成绩；缺项不能计算正式总分。', inputs: [['examiner-evidence', 1], ['examiner-review', 0], ['examiner-retakes', 1]], cands: [
    ['按提交逐项补证稿', 'V-101补拍秤屏与完整称重步骤；V-102重交连续带声接待片段。分别关联原提交，保留无法判定项；截止与补考方式交训练负责人确认。'],
    ['先人工复核再补交稿', '先由训练负责人复核V-101称重来源及V-103遮挡问题，再决定补证或补考；V-102缺音频继续待补交。暂定评分与最终结果分开，不把材料缺失写成行为违规。'],
  ] },
  operations: { title: '训练会资料补齐与跟进清单', need: '演示整理训练会资料与跟进草案；签到不等同内容全部完成，整改期限和负责人待确认。', inputs: [['operations-meetings', 0], ['operations-meetings', 1], ['operations-meetings', 2]], cands: [
    ['按证据缺项分派稿', 'M-101补充训练原视频；M-103补签到和原片段，当前不形成已召开结论。每项列明资料责任角色与待确认期限，不下发任何门店任务。'],
    ['按训练会逐场核对稿', 'M-102先核对计划8人与实到7人的差异；M-104整理2条跟进项并补人工确认。M-101/M-103仍保留待补材料，不用一份签到替代全部训练证据。'],
  ] },
  vi: { title: 'D-101 毛肚主题立牌修订概念', need: '演示根据审稿意见比较HTML概念，不使用官方Logo/真实商品图；正式素材、字体及文案授权待确认。', inputs: [['vi-concepts', 0], ['vi-reviews', 0], ['vi-reviews', 1]], cands: [
    ['标题优先的立牌概念', '600×900mm讨论稿采用上方标题、中央菜名、下方待确认说明；提高主次层级，保持素材占位。桌卡延展需另检小字可读性，未生成正式印刷或可编辑文件。'],
    ['信息分区的立牌概念', '600×900mm讨论稿分成主题区与食材说明区，门店变量单独放置；保留正式图片和Logo占位，不把HTML色块当品牌授权资产。交设计师审稿后再决定下一版。'],
  ] },
  space: { title: 'SP-101 布局范围讨论稿', need: '演示讨论新增岗位流程，CAD交付范围待确认；只提供HTML讨论内容，不生成DWG/DXF或施工图。', inputs: [['space-projects', 0], ['space-plan', 0], ['space-dimensions', 0]], cands: [
    ['先确认入口与动线', '仅讨论前厅、接待、后厨、辅助四个区域的关系；入口净宽、柱网和基底单位未齐，先列测绘问题。180㎡为虚构数据，不做真实比例、几何或消防判断。'],
    ['先确认设备与制图范围', '先补设备长宽高、净高和目标CAD软件/图层要求，再讨论标准店型适配；当前保留HTML区域占位。专业审稿及正式可编辑CAD验收均待确认。'],
  ] },
  cost: { title: 'SP-101 局部改造预算审核稿', need: '演示以工程量和报价形成可复算候选，缺失费用及计量来源必须单列，不作为完整工程总价。', inputs: [['cost-budget', 0], ['cost-budget', 1], ['cost-budget', 2], ['cost-budget', 3], ['cost-changes', 0]], cands: [
    ['保留180㎡基准清单', '地面28,440元＋吊顶照明42,480元＋设备86,500元＋消防机电42,800元＝200,220元。未含税费、设计费和预备费；设备规格、消防范围与正式核量待补。'],
    ['地面192㎡变更讨论稿', '仅将地面从180㎡改为192㎡，按158元/㎡增加1,896元，已知清单变为202,116元。增量尚无正式测量原件，仍未含税费、设计费和预备费，须先核量审核。'],
  ] },
  supply: { title: '鲜毛肚与鲜鸭血到货沟通草稿', need: '演示比较到货跟进资料包，不发送消息；现存可用与含在途覆盖分开，到货时点及批次需确认。', inputs: [['inventory', 0], ['inventory', 3], ['arrivals', 0], ['arrivals', 3]], cands: [
    ['按缺交期优先核对', '鲜鸭血现存240kg、日均80kg，仅3天现存覆盖；80kg在途无承诺时点，先补交期/生产日期/批次。含在途4天不表示当前库存已可用，不下发采购或调拨。'],
    ['按在途逐单核对', '鲜毛肚200kg在途拟10月11日08:00到仓，先核对确认稿、批次和收货证据；500kg现存覆盖5天，含在途覆盖7天。鲜鸭血缺交期继续保留阻碍，不假报风险解除。'],
  ] },
  dispatch: { title: '华中线B与插单版本讨论稿', need: '演示比较配送草案，里程与耗时是预置值；地址、时窗和运力确认前不能派车。', inputs: [['routes', 1], ['constraints', 0], ['vehicles', 1], ['unassigned', 3]], cands: [
    ['先解决门店E时窗', '华中线B模拟到门店E为11:20，超过10:00–11:00窗口；先讨论调整停靠顺序并重新求路线。V-02体积未知，不能仅按1,460/1,500kg判断可装载，当前不派车。'],
    ['插单保留独立草案', 'D-DEMO-104作为独立插单版本，列出受影响的停靠和时窗；原执行计划保留。真实地图、体积、工时与门店确认未齐，76km/3小时50分仍只是演示值。'],
  ] },
  organization: { title: '区域招聘岗核心变更说明书草稿', need: '演示对比说明书候选，岗位编码保持不变；发布、审批、敏感权限和系统联动仍未接入。', inputs: [['descriptions', 2], ['approvals', 2], ['versions', 1]], cands: [
    ['V2.0核心职责调整稿', '将原数据同步职责扩展为招聘运营，并补编制核对、渠道费用、前厅初面的人审边界；作为V2.0草稿提交相应审定角色。批准发布前旧V1.0仍有效，不同步NCC。'],
    ['先补边界再进入审定', '先核对岗位目的、完整职责、任职条件和KPI来源，再确认本次是否属于核心变化。保留对比和审定问题，不以文字草案废止旧版，也不替代正式审批权限。'],
  ] },
  performance: { title: '采购与区域招聘结果核验资料包', need: '演示核对已知分数、群体规则和缺失配置；不调整正式分数，不生成工资或NCC同步结果。', inputs: [['result-sync', 0], ['result-sync', 1], ['group-rules', 0], ['group-rules', 2]], cands: [
    ['按群体分栏核验稿', '采购82分对应需求参照系数1；区域招聘95分对应0.95。两类分开列出适用成员、来源和确认人；奖金基数、职级及现金/股权时点另配，不用分数乘薪资。'],
    ['先处理取数异常稿', '优先保留实际值空缺、说明书覆盖120%分母冲突及提前快照的阻碍，再核对群体规则。异常未解决不形成正式结果；同步回执保持未连接，不把草案写成已发薪。'],
  ] },
  hr: { title: '回访与满意度服务资料包', need: '演示根据匿名访谈与问卷样例形成候选汇总，不联系人员、不发布问卷；摘要必须保留原文依据。', inputs: [['exit-surveys', 0], ['exit-surveys', 1], ['satisfaction', 0], ['satisfaction', 1], ['satisfaction', 2], ['satisfaction', 3]], cands: [
    ['以离职回访问题为主', '按通勤与排班体验整理虚构原文、主题和待确认后续事项；缺原文的回访保持待补。问卷附82/100＝82%回收概况，不把填写率解读为满意度得分。'],
    ['以区域满意度口径为主', '分区域保留24/30、27/30、15/20、16/20及问卷版本、花名册时点；月3日前核算和季度评优仅作需求节奏。另附回访原文索引，评优规则与结论待人工确认。'],
  ] },
  recruitment: { title: '前厅初面与日程核对草案', need: '演示仅限前厅岗位，排除后厨；候选信息匿名，人工确认材料与日程，不自动录用或发出邀约。', inputs: [['interviews', 0], ['interviews', 2], ['hiring', 1]], cands: [
    ['先确认C-DEMO-001初面证据', '用岗位相关问题与回答来源整理前厅初面提纲；每条观察附证据和无法判断项，由招聘人员确认。候选人不计入在岗人数，不做正式评分、自动录用或真实联系。'],
    ['先处理C-DEMO-004日程冲突', '保留10月12日10:00的预置重叠，核对门店B编制/岗位说明书与面试角色可用时间后再拟新档。ATS、飞书快约与微信均未接入，当前不建正式简历、不发邀约。'],
  ] },
  legal: { title: '模拟争议A证据目录与研究稿', need: '演示整理涉诉/研究资料候选，由法务确认；全部案件、主体、期限为虚构，不形成正式法律意见。', inputs: [['cases', 0], ['cases', 1], ['cases', 2]], cands: [
    ['先核对诉讼材料目录', '为模拟争议A列起诉状、答辩状、证据目录、代理词与和解协议的资料位置及缺项；逐项核对编号与来源，原始证据不足时不推断案件结果。提交法务人工复核。'],
    ['分开研究与危机复盘', '将合同研究的权威来源问题和模拟危机的事后资料/预防问题分开；危机处置仍由人工负责。保留原文引用与研究假设，正式期限和法律判断另行确认。'],
  ] },
  chairman: { title: '经营议题与职责确认讨论稿', need: '演示中经营议题属于新增界面假设，持续职责、本人表达及行动权限待确认；不代表董事长观点或指令。', inputs: [['overview', 0], ['materials', 0], ['identity', 3]], cands: [
    ['先确认持续工作与产出', '把训练准备、门店资料等仅作为讨论例子，先询问应持续处理哪些议题、读取哪些材料、由谁确认结果。未批准范围不形成经营决议，也不向任何岗位下达任务。'],
    ['先确认人设与行动边界', '先列本人表达风格、肖像/声音素材授权、可访问资料与人工确认点；所有样例议题保持讨论草案。没有本人素材与职责批准时不模仿发言、不代替决策。'],
  ] },
  ceo: { title: '经营协调与职责确认讨论稿', need: '演示中协调工作为新增假设，与董事长的分工、持续职责和行动权限待确认；不发会议邀请或管理指令。', inputs: [['overview', 0], ['materials', 2], ['identity', 3]], cands: [
    ['先确认协调事项的范围', '用培训计划与门店资料作为虚构例子，列出跨部门协调需要谁提供输入、谁确认产出及哪些事项升级给人。与董事长分工尚未明确，不默认建立汇报或决策权限。'],
    ['先确认会议资料与表达', '先核对会议资料来源、人设素材、授权和表达边界，再讨论简报格式；纪要仅为待确认草案。未邀请任何人、未发布正式结论，不代表执行总裁真实意见。'],
  ] },
  vp1: { title: '高级副总裁1职责问题清单', need: '演示仅讨论范围，分管领域、与另一位副总裁分工及本人素材均待确认；不指定实际分管部门。', inputs: [['overview', 0], ['overview', 2], ['identity', 3]], cands: [
    ['先确认分工与持续产出', '请确认本岗位分管哪些业务、持续接收哪些资料、需要产出哪些草案，以及与另一位副总裁如何协作和升级。当前没有明确部门或管理责任，不构造真实指令链。'],
    ['先确认素材与人工确认点', '先收本人表达与形象素材授权、可读资料范围及必须本人确认的动作；将所有未知逐项保留。只有问题清单，没有代本人发言、审批或经营决策。'],
  ] },
  vp2: { title: '高级副总裁2职责问题清单', need: '演示仅讨论范围，编号不代表职责或权限差异；分管领域、协作关系、本人素材和行动边界待确认。', inputs: [['overview', 0], ['overview', 2], ['identity', 3]], cands: [
    ['独立确认分工与持续产出', '独立询问本岗位业务范围、输入、持续产出和与另一位副总裁的协同关系；不从编号或其他岗位继承职责、部门或资料授权，未确定的内容全部留作问题。'],
    ['独立确认素材与边界', '列本人风格与肖像素材授权、可访问资料和人审动作清单；当前只有虚构讨论资料，不能当成本人意见。没有正式审批、对外发言或代替管理者决策。'],
  ] },
};

interface CheckSeed { name: string; outcome: RestaurantResult[1]; object: string; message: string; boardId?: string; row?: number }
const CHECKS: Record<string, CheckSeed[]> = {
  'training-check': [
    { name: '讲师时段不可重叠', outcome: 'fail', object: 'T-103 / R-202讲师重叠', message: '10月14日09:00两个任务重叠，需调整后重新核对；没有通知人员。', boardId: 'training-conflicts', row: 0 },
    { name: '课程资格需有有效期依据', outcome: 'insufficient', object: 'T-102资格有效期', message: '只登记资格名称，未提供有效期，不能判定资格满足。', boardId: 'training-conflicts', row: 2 },
  ],
  'examiner-check': [
    { name: '评分项需可定位证据', outcome: 'insufficient', object: 'V-101称重来源', message: '秤屏未入镜且没有可读取称重记录，保持无法判定，不扣成违规分。', boardId: 'examiner-evidence', row: 1 },
    { name: '声音缺失不得判断接待用语', outcome: 'insufficient', object: 'V-102接待用语', message: '缺完整带声片段，需要补交；暂定分与正式结果分开。', boardId: 'examiner-review', row: 1 },
    { name: '视频识别运行需正式能力', outcome: 'error', object: '真实视频识别未接入', message: '本页只有文字证据占位，未运行真实识别，不是训练行为未通过。' },
  ],
  'operations-product-check': [
    { name: '称重记录与示例容差对照', outcome: 'fail', object: '北京悠唐毛肚268g', message: '在虚构250±10g口径下超上限8g；需核对去皮、秤校准和正式标准，结论仅属该样例。', boardId: 'operations-weight', row: 1 },
    { name: '遮挡部分不判外观通过', outcome: 'insufficient', object: '绣球菌外观', message: '当前角度不能观察完整盘面，需要补侧视照片，不把遮挡记作违规。', boardId: 'operations-plating', row: 1 },
  ],
  'operations-welcome-check': [
    { name: '迎宾观察需完整动作证据', outcome: 'insufficient', object: '等位引导动作', message: '引导动作被遮挡，保持无法判定，需补机位后人工复核。', boardId: 'operations-welcome', row: 1 },
    { name: '用语观察需可辨声音', outcome: 'insufficient', object: '礼貌用语', message: '声音不可辨，不能推断是否满足用语标准。', boardId: 'operations-welcome', row: 2 },
  ],
  'vi-check': [
    { name: '设计需正式素材与规范依据', outcome: 'insufficient', object: 'D-101正式资产', message: '正式素材权限未提供，不能给品牌一致性通过结论。98%为需求目标，未测量。', boardId: 'vi-quality', row: 0 },
    { name: '目标数据需样本与分母', outcome: 'insufficient', object: '校验覆盖及拦截目标', message: '渠道规则、偏差标注与分母未定义，不把100%/95%目标当成果。', boardId: 'vi-quality', row: 2 },
  ],
  'space-check': [
    { name: '正式制图需明确基底单位', outcome: 'insufficient', object: 'SP-101基底图单位', message: '基底单位未注明，不猜测毫米或米，HTML示意不提供几何验证。', boardId: 'space-dimensions', row: 0 },
    { name: 'CAD交付需目标软件可编辑文件', outcome: 'insufficient', object: '正式CAD交付', message: 'DWG/DXF未生成，格式、图层和专业验收仍待确认；讨论稿不能替代施工图。', boardId: 'space-review', row: 1 },
  ],
  'cost-check': [
    { name: '清单小计等于数量乘单价', outcome: 'pass', object: '地面180㎡×158元', message: '180×158=28,440，算术样例一致；不代表工程量已核实或整份预算已批准。', boardId: 'cost-budget', row: 0 },
    { name: '结算差异需原始计量依据', outcome: 'insufficient', object: '地面结算差790元', message: '结算与预算有790元差异，缺签证/核量证据，不直接认定违规或应付款。', boardId: 'cost-settlement', row: 0 },
    { name: '缺结算值不能当零差额', outcome: 'insufficient', object: '消防机电结算', message: '没有结算原件，保持无法计算，已知小计不能当项目结算总差额。', boardId: 'cost-settlement', row: 3 },
  ],
  'supply-check': [
    { name: '批次生产日期需齐备', outcome: 'insufficient', object: '鲜鸭血B-DEMO-02', message: '生产日期缺失，剩余保质期无法计算，不判批次正常可用。', boardId: 'batches', row: 1 },
    { name: '退货单与实物数量核对', outcome: 'fail', object: '菌汤配料单实差异', message: '虚构单据40kg、实物36kg差4kg，需保留收货/盘点证据并人工复核，不覆盖原单。', boardId: 'exceptions', row: 0 },
  ],
  'dispatch-check': [
    { name: '配送到达需满足收货窗口', outcome: 'fail', object: '门店E时窗', message: '预置到达11:20超过10:00–11:00窗口，需要重新讨论线路；不是地图实测。', boardId: 'constraints', row: 0 },
    { name: '签收差异需附件依据', outcome: 'insufficient', object: 'R-DEMO-01签收数量', message: '计划120箱、模拟记录118箱，附件尚缺，不关闭异常。', boardId: 'route-exceptions', row: 2 },
  ],
  'organization-check': [
    { name: '有效岗位需说明书依据（规则草案）', outcome: 'insufficient', object: '策略示例部说明书覆盖', message: '5/6份，缺1份或撤销依据；正式规则及例外待确认，不能判组织调整。', boardId: 'org-checks', row: 1 },
    { name: '组织与在岗需同一时点', outcome: 'insufficient', object: '组织/在岗快照', message: '组织09:00、在岗前日18:00，口径不一致，暂不形成超编/缺编定论。', boardId: 'org-checks', row: 3 },
  ],
  'performance-submission-check': [
    { name: '工作模块完整引用说明书原文', outcome: 'fail', object: '岗位B工作模块', message: '演示绩效表删除“调拨”部分，原文不完整，保持提交阻断；不修改正式说明书。', boardId: 'module-kpi', row: 1 },
    { name: 'KPI需与说明书来源一致', outcome: 'fail', object: '岗位C的KPI来源', message: '新增指标无生效说明书依据，先核对来源版本，不把新指标当正式要求。', boardId: 'module-kpi', row: 2 },
  ],
  'performance-policy-check': [
    { name: '群体阶梯需确认适用范围', outcome: 'insufficient', object: '采购系数规则', message: '80/70/60阶梯仅为需求参照，适用成员和优先匹配未确认，不计算正式奖金。', boardId: 'group-rules', row: 0 },
    { name: '严格大于边界不能替换', outcome: 'insufficient', object: '组织管理B+标准职员规则', message: '保留>100/>90等边界，群体和版本待批准，不能改成采购阶梯或统一公式。', boardId: 'group-rules', row: 1 },
  ],
  'hr-payroll-check': [
    { name: '人事与发薪名册岗位编码一致', outcome: 'fail', object: 'E-DEMO-001岗位字段', message: '两份虚构名册岗位编码不同，保留差异待复核；不修改工资或人事系统。', boardId: 'payroll-audit', row: 0 },
    { name: '银行卡资料需确认状态', outcome: 'insufficient', object: 'E-DEMO-002账户状态', message: '缺账户确认状态，页面没有真实卡号，先补材料，不发薪。', boardId: 'payroll-audit', row: 1 },
    { name: '外出排班重复需人工核验', outcome: 'fail', object: 'E-DEMO-003重复外出班次', message: '10月6日两个预置班次重叠，仅形成核验问题，不自动扣薪或改考勤。', boardId: 'payroll-audit', row: 2 },
  ],
  'recruitment-channel-check': [
    { name: '候选身份与渠道归因分别确认', outcome: 'insufficient', object: '费用归因差400元', message: '重复来源需确认，400元只是待核对样例，不是正式应付款，不重复结算候选。', boardId: 'expenses', row: 3 },
    { name: '外部联系需平台接口与授权', outcome: 'error', object: '招聘渠道B自动打招呼', message: '招聘平台和联系权限未接入，未运行真实联系；不能视作候选人拒绝或消息已发出。', boardId: 'channels', row: 1 },
  ],
  'legal-contract-check': [
    { name: '营销依据需在有效期内', outcome: 'fail', object: '菌汤桌卡证据A', message: '虚构证据A已过期，不可作为本次审查依据；需补证后复核，不是正式法律意见。', boardId: 'contracts', row: 2 },
    { name: '合同通知期限需有原文依据', outcome: 'insufficient', object: '租赁合同条款4.2', message: '未约定提前通知天数，先补原文和业务条件，不擅自填写期限。', boardId: 'contracts', row: 0 },
  ],
  'legal-rights-check': [
    { name: '知识产权状态需官方回执', outcome: 'insufficient', object: '虚构商标A状态', message: '没有官方监测结果，当前仅为资料待核验，不标已获权或有效。', boardId: 'ip', row: 0 },
    { name: '授权范围与使用条件需人工确认', outcome: 'insufficient', object: '虚构授权B', message: '范围/条件待核对，电子章未接入，不产生有效签章。', boardId: 'ip', row: 1 },
  ],
};

const ICONS: Record<string, string> = { training: 'calendar', examiner: 'play', operations: 'clipboard', vi: 'palette', space: 'layout', cost: 'wallet', supply: 'package', dispatch: 'network', organization: 'users', performance: 'target', hr: 'users', recruitment: 'briefcase', legal: 'shield', chairman: 'flag', ceo: 'flag', vp1: 'user', vp2: 'user' };
const ACTIONS: Record<RestaurantBoard['type'], string[]> = {
  B: ['open-record'], C: ['open-record', 'select-candidate', 'sign-candidate', 'reflow-to-b'], D: ['open-record', 'run-check', 'escalate-issue'],
};
const LEGACY = [...OPERATIONS_ROLES, ...PEOPLE_ROLES, ...LEADERSHIP_ROLES];
const keyFor = (boardId: string, columnIndex: number) => `old_${boardId.replace(/[^a-zA-Z0-9_]/g, '_')}_c${columnIndex}`;
const unique = <T>(values: T[]): T[] => [...new Set(values)];

export const COVERAGE: CoverageEntry[] = [];

function buildRole(old: Role): RestaurantRole {
  const group = THEME_GROUPS.find(x => x.roleId === old.id)!;
  if (!group) throw new Error(`Missing restaurant theme group: ${old.id}`);
  const fields: RestaurantField[] = [
    ['item', '事项', 't'], ['state', '状态', 's', unique([...old.boards.flatMap(b => b.rows.map(r => r.cells.at(-1)!)), '待确认', '回流待复核'])],
    ['topic', '工作主题', 's', [...old.boards.map(b => b.title), '交付回流']], ['details', '依据与说明', 't'], ['content', '规范内容', 't'],
  ];
  old.boards.forEach(b => b.columns.slice(1, -1).forEach((label, index) => fields.push([keyFor(b.id, index + 1), `${b.title} · ${label}`, 't'])));
  const keys = fields.map(f => f[0]);
  const rows: RestaurantRow[] = [], rowsSourceIndices: number[] = [];
  const sections = new Map<string, RestaurantSection>();
  const indices = new Map<string, number[]>();
  old.boards.forEach(b => {
    const cols = ['item', ...b.columns.slice(1, -1).map((_, i) => keyFor(b.id, i + 1)), 'state'];
    sections.set(b.id, { oldBoardId: b.id, title: b.title, topic: b.title, cols, labels: [...b.columns], requirementIds: [...(b.requirementIds ?? old.requirementIds)], priority: b.priority ?? old.priority, purpose: b.subtitle });
    indices.set(b.id, []);
    b.rows.forEach(r => {
      const values: Record<string, string> = Object.fromEntries(keys.map(key => [key, '']));
      cols.forEach((key, index) => { values[key] = r.cells[index]; });
      values.topic = b.title; values.details = r.detail;
      const sourceIndex = old.sources.findIndex(s => s.id === r.sourceId);
      if (sourceIndex < 0) throw new Error(`Missing mock source: ${old.id}/${b.id}/${r.id}`);
      indices.get(b.id)!.push(rows.length);
      rows.push([...keys.map(key => values[key]), 'i', 1]);
      rowsSourceIndices.push(sourceIndex);
    });
  });
  const indexOf = (boardId: string, row: number) => {
    const index = indices.get(boardId)?.[row];
    if (index === undefined) throw new Error(`Invalid restaurant evidence index: ${old.id}/${boardId}/${row}`);
    return index;
  };
  const sources: RestaurantSource[] = old.sources.map(s => ({
    name: s.name, kind: /\.csv$/i.test(s.name) ? 'csv' : 'txt', st: 'done',
    preview: `【内置虚构演示原件，不是客户真实业务资料】\n${s.content}`,
  }));
  /* Two extra sources demonstrate review/publish only. Their new rows are not part of the 332 legacy records. */
  const extraRow = (suffix: string): RestaurantRow => {
    const values = rows[0].slice(0, fields.length);
    values[0] = `额外样例 · ${old.boards[0].rows[0].cells[0]} · ${suffix}`;
    values[1] = '待确认';
    values[3] = '额外虚构整理记录，未加入初始332行；确认入库只影响本新页面的演示状态。';
    return values;
  };
  const ready = extraRow('待确认整理');
  const issue = extraRow('复核后整理');
  sources.push(
    { name: `${old.job}·额外新增样例.txt`, kind: 'txt', st: 'ready', preview: `【额外新增虚构样例，未入初始记录】\n事项：${ready[0]}\n工作主题：${ready[2]}\n状态：待确认\n${ready[3]}`, yields: [ready] },
    { name: `${old.job}·额外复核样例.csv`, kind: 'csv', st: 'issue', preview: `【额外新增虚构样例，未入初始记录】\n事项,状态,说明\n${issue[0]},待确认,额外有效演示行\n,待确认,这一无效样例行缺事项，复核前整批不入库`, issues: [[4, '事项', '额外样例行的事项为空，需人工复核；不是客户真实业务异常。']], yields: [issue] },
  );
  const boards: RestaurantBoard[] = group.themes.map(theme => {
    const boardSections = theme.oldBoardIds.map(id => {
      const section = sections.get(id);
      if (!section) throw new Error(`Missing legacy restaurant section: ${old.id}/${id}`);
      COVERAGE.push({ roleId: old.id, oldBoardId: id, oldTitle: section.title, themeId: theme.id, themeTitle: theme.title, requirementIds: [...section.requirementIds], priority: section.priority, rowCount: indices.get(id)!.length });
      return section;
    });
    const result: RestaurantBoard = {
      id: theme.id, title: theme.title, icon: theme.type === 'C' ? 'pen' : theme.type === 'D' ? 'shield' : ICONS[old.id], type: theme.type,
      purpose: boardSections.map(s => s.title).join('、') + '；原始业务数据和结果均为虚构演示。',
      sections: boardSections, cols: ['item', 'topic', 'state'], actions: [...ACTIONS[theme.type]],
      metrics: [{ l: '样例记录', op: 'count' }, { l: '工作主题', op: 'distinct', f: 'topic' }],
      chart: { k: 'bar', by: 'topic' },
    };
    if (theme.type === 'C') {
      const delivery = DELIVERIES[old.id];
      if (!delivery) throw new Error(`Missing restaurant delivery task: ${old.id}`);
      result.tasks = [{ id: `ct-${theme.id}-01`, title: delivery.title, need: delivery.need, inputs: delivery.inputs.map(([id, row]) => indexOf(id, row)), cands: delivery.cands.map(([title, body]) => [title, body]) }];
    }
    if (theme.type === 'D') {
      const isLeader = ['chairman', 'ceo', 'vp1', 'vp2'].includes(old.id);
      const checks: CheckSeed[] = isLeader ? [
        { name: '本人形象素材需提供并授权', outcome: 'insufficient', object: '本人形象材料', message: '只有文字头像占位，未提供肖像或声音素材，不能判断符合本人形象。', boardId: 'identity', row: 1 },
        { name: '持续职责与行动边界需确认', outcome: 'insufficient', object: '职责与行动边界', message: '持续工作和可执行动作未定义；不代表本人发言、审批或决策，范围仍待确认。', boardId: 'identity', row: 3 },
      ] : CHECKS[theme.id];
      if (!checks?.length) throw new Error(`Missing restaurant check seeds: ${theme.id}`);
      result.rules = checks.map((check, i) => ({ id: `chk-${theme.id}-${i + 1}`, name: check.name, ver: 1, tgt: { k: 'own', label: `本岗「${group.bName}」与内置虚构资料` } }));
      result.runs = [{ id: `run-${theme.id}-sample`, at: '2026-10-15 09:00', results: checks.map((check, i): RestaurantResult => [
        result.rules![i].id, check.outcome, check.object, `预置样例：${check.message}`, check.boardId === undefined ? null : indexOf(check.boardId, check.row ?? 0), false,
        { obj: check.object, msg: `预置样例：${check.message}` },
      ]) }];
    }
    return result;
  });
  const taskMap = new Map(group.themes.flatMap(theme => theme.oldBoardIds.map(id => [id, theme.id] as const)));
  const legacyTasks = old.tasks.map((task, i) => {
    const oldBoardId = old.taskBoardIds?.[i] ?? old.boards[0].id;
    const themeId = taskMap.get(oldBoardId);
    if (!themeId) throw new Error(`Missing restaurant legacy task mapping: ${old.id}/${oldBoardId}`);
    return { task, themeId, oldBoardId };
  });
  const scopeNote = old.id === 'space'
    ? `${old.scopeNote} 制图范围与专业验收待确认。`
    : ['chairman', 'ceo'].includes(old.id)
      ? `${old.scopeNote} 经营/协调范式为新增界面假设，待确认。`
      : ['vp1', 'vp2'].includes(old.id)
        ? '原需求只描述数字分身及人设形象。两位副总裁各自业务、职责差异、本人素材和行动边界均待确认；当前只展示独立的问题清单与资料核对。'
        : old.scopeNote ?? '本页仅为虚构业务数据的交互演示，真实系统、模型及外部动作未接入。';
  return {
    id: old.id, name: old.job, icon: ICONS[old.id], main: group.main, combo: [...group.combo], user: '演示岗位人员',
    department: old.department, requirementIds: [...old.requirementIds], priority: old.priority, priorities: [...(old.priorities ?? [old.priority])],
    scopeNote, scopeUncertain: !!group.scopeUncertain, summary: old.summary,
    aDesc: old.sources.map(s => s.type).join('、'), bName: group.bName,
    cdDesc: `${DELIVERIES[old.id].title}；检查结果均为预置样例`, rule: `rule-restaurant-${old.id}`, ruleVer: 'v1',
    sem: { group: 'topic', metric: null, agg: null, owner: null, unit: '' }, fields, rows, rowsSourceIndices, sources, boards, legacyTasks, rules: [...old.rules],
    suggest: [[old.prompts[0], 'analyze'], [`侧边栏加一个「待确认事项」看板，只看状态为待确认的记录`, 'board'], [`解释${boards.find(b => b.type === 'D')!.title}中的证据不足样例`, 'd']],
  };
}

export const RESTAURANT_ROLES: RestaurantRole[] = LEGACY.map(buildRole);
