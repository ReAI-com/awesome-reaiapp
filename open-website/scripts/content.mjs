import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';

export const groups = {
  productivity: '效率工具', agent: 'AI 与 Agent', developer: '开发工具', system: '系统与设备', other: '其他',
};
const categories = {
  'voice': 'productivity', 'browser': 'productivity', 'text-editor': 'productivity', 'podcast': 'productivity',
  'wishing-wall': 'productivity', 'agents-im': 'agent', 'agents-tasks': 'agent', 'code-worker': 'agent',
  'pi-agent': 'agent', 'dsh-agent': 'agent', 'codex-app': 'agent', 'codex-link': 'developer',
  'terminal': 'developer', 'computer': 'system', 'device-doctor': 'system',
};
export const featured = ['voice', 'browser', 'terminal', 'code-worker', 'agents-tasks', 'text-editor'];

export const cases = [
  { slug: 'writing', category: '内容创作', title: '说出来，再把它打磨好。', description: '用语音捕捉想法，在编辑器里整理成文。', plugins: ['voice', 'text-editor'], className: 'writing-art', short: 'Voice + Editor', headline: '把刚才的想法，变成下一步行动。',
    context: '想法往往在走动、讨论或查看资料时出现。这个场景展示如何先留下文字，再整理成一份可读的文档。',
    steps: ['在语音输入法中选择识别方式，核对当前权限和模型状态。', '在需要写入的应用中放好光标，口述想法并完成识别。', '在文本编辑器中整理段落、补充细节并保存本地文件。'],
    outcome: '期望得到一份由你确认和整理的文字稿。插件间自动交接和效果仍需实际验证；这里不提供已验证的客户案例或效率数据。' },
  { slug: 'research', category: '研究与开发', title: '让发现，成为下一步。', description: '围绕网页资料，把信息探索接到 Agent 工作中。', plugins: ['browser', 'codex-link', 'terminal'], className: 'research-art', short: 'Browser + Agent', headline: '从一个问题，到下一步行动。',
    context: '查阅技术资料时，浏览、理解和动手通常交替发生。这个场景用浏览器、Agent 和终端组织这三个环节。',
    steps: ['通过浏览器查看相关资料，确认来源和任务范围。', '在 Agent 任务中提供你确认过的材料与明确目标；按要求完成授权。', '在终端或对应工具中检查输出，验证后再采用修改。'],
    outcome: '期望得到有来源、有边界、可验证的下一步方案。跨插件数据传递与自动执行需按实际合同验收；本页是场景说明。' },
  { slug: 'device-care', category: '设备与日常', title: '遇到问题，先把状态看清。', description: '从连接、权限和运行环境开始定位设备问题。', plugins: ['device-doctor'], className: 'device-art', short: 'Device Doctor', headline: '少一点猜测，多一点清楚。',
    context: '设备没有按预期工作时，先辨认是连接、权限还是版本问题。诊断工具把本机状态整理成可行动的信息。',
    steps: ['打开设备诊断助手，查看连接与系统权限提示。', '根据需要查看脱敏日志摘要；涉及云端分析时先确认授权。', '依照诊断结果处理具体问题，再复核设备状态。'],
    outcome: '期望得到清晰的故障方向和下一步操作。页面中的说明来自插件声明，未模拟诊断成功或证明具体设备已修好。' },
];

export function safeAsset(directory, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\')) throw new Error('Invalid asset path');
  const candidate = resolve(directory, relative);
  if (!candidate.startsWith(resolve(directory) + sep)) throw new Error('Asset escapes plugin directory');
  return candidate;
}

export function parseChangelog(markdown) {
  const entries = [];
  const pattern = /^##[ \t]+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\]?(?:[ \t].*)?$/gm;
  const matches = [...markdown.matchAll(pattern)];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const notes = markdown.slice(start, matches[i + 1]?.index ?? markdown.length).trim();
    if (!notes) throw new Error(`Empty changelog entry: ${matches[i][1]}`);
    if (entries.some(e => e.version === matches[i][1])) throw new Error(`Duplicate changelog version: ${matches[i][1]}`);
    entries.push({ version: matches[i][1], notes });
  }
  return entries;
}

export async function loadCatalog(repo) {
  const catalog = [];
  const folders = (await readdir(join(repo, 'plugins'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const slug of folders) {
    const folder = join(repo, 'plugins', slug);
    let manifest;
    try { manifest = JSON.parse(await readFile(join(folder, 'app.manifest.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(manifest.appId)) throw new Error(`Invalid appId: ${slug}`);
    if (catalog.some(p => p.appId === manifest.appId)) throw new Error(`Duplicate appId: ${manifest.appId}`);
    const iconSource = safeAsset(folder, manifest.icon);
    await access(iconSource);
    const listing = manifest.storeListing ?? {};
    let changelog = [];
    try { changelog = parseChangelog(await readFile(join(folder, 'CHANGELOG.md'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const category = categories[slug] ?? 'productivity';
    catalog.push({ slug, appId: manifest.appId, name: manifest.name, version: manifest.version,
      category, label: groups[category], description: listing.tagline ?? manifest.description,
      longDescription: listing.longDescription || manifest.description, icon: `/assets/${slug}.png`,
      iconSource, capabilities: listing.capabilities ?? [], permissions: manifest.permissions ?? [],
      hostApi: manifest.hostApi?.range ?? '未声明', targets: manifest.targets ?? [],
      changelog, changelogSource: changelog.length ? `plugins/${slug}/CHANGELOG.md` : null,
      source: `plugins/${slug}/app.manifest.json`, status: 'local-preview',
    });
  }
  return catalog;
}
