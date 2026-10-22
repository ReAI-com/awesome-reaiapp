/**
 * GitHub Actions 排队编排工具：看清 runner 压力、合并重复任务、检查工作流并发配置。
 * 依赖已登录的 gh CLI（≥2.63，需 --slurp）与 Bun ≥1.2.21（Bun.YAML）；默认只读，取消任务必须显式加 --apply。远端返回的名称一律视为不可信文本。
 *
 *   bun scripts/ci-queue.ts status (--org <org> [--since 7] | --repo <owner/name>)  排队/运行任务与 runner 分组压力
 *   bun scripts/ci-queue.ts dedupe --repo <owner/name> [--apply] [--zombie-hours 6]
 *     （--apply 只提交取消请求，GitHub 异步处理；再跑一次 status 确认结果）
 *   bun scripts/ci-queue.ts plan   --repo <owner/name>                             找出缺少「新提交取消旧任务」的工作流
 */

type Run = {
  id: number; name: string; workflow_id: number; head_branch: string; head_sha: string;
  head_repository: { id: number } | null; pull_requests: { number: number }[];
  event: string; status: string; created_at: string; run_started_at: string;
};
type Job = {
  name: string; status: string; labels: string[]; runner_id: number | null; runner_name: string | null; created_at: string;
};
type Candidate = { run: Run; reason: string; zombie: boolean };

// waiting / requested / pending 可能是审批或部署定时等待，不算 runner 排队，也不当僵尸
const ACTIVE = ["queued", "in_progress", "waiting", "pending", "requested"];
const STATUS_RANK: Record<string, number> = { requested: 0, pending: 1, waiting: 2, queued: 3, in_progress: 4 };

class UsageError extends Error {}

function gh(args: string[]): string {
  const r = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`gh ${args.join(" ")}\n${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}
const api = <T>(path: string): T => JSON.parse(gh(["api", path]));
/** 拉取全部分页；key 为列表字段名（如 workflow_runs），数组型接口传 null。 */
function apiAll<T>(path: string, key: string | null): T[] {
  const pages = JSON.parse(gh(["api", "--paginate", "--slurp", path])) as unknown[];
  return pages.flatMap((p) => (key ? (p as Record<string, T[]>)[key] : (p as T[])) ?? []);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} 缺少取值`);
  return v;
}
function positive(name: string, fallback: number): number {
  const raw = flag(name);
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} 必须是正数`);
  return n;
}
function requireRepo(cmd: string): string {
  const repo = flag("repo");
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UsageError(`${cmd} 需要 --repo owner/name`);
  return repo;
}
const has = (name: string) => process.argv.includes(`--${name}`);
/** 去掉控制字符，避免远端文本伪造多行输出。 */
const clean = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const mins = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
const age = (m: number) => (m >= 120 ? `${Math.round(m / 60)}h` : `${m}m`);
/** 本次尝试的开始时间：重跑后 run_started_at 会刷新，created_at 不会。 */
const attemptAge = (r: Run) => mins(r.run_started_at || r.created_at);

/** 按状态分别查询会因状态迁移拿到同一 run 两次，按 id 去重并保留更靠后的状态。 */
function activeRuns(repo: string): Run[] {
  const byId = new Map<number, Run>();
  for (const s of ACTIVE) {
    for (const r of apiAll<Run>(`repos/${repo}/actions/runs?status=${s}&per_page=100`, "workflow_runs")) {
      const cur = byId.get(r.id);
      if (!cur || (STATUS_RANK[r.status] ?? 0) > (STATUS_RANK[cur.status] ?? 0)) byId.set(r.id, r);
    }
  }
  return [...byId.values()];
}

/** 同一来源：PR 用编号区分（不同 fork 的同名分支不会混），其余用来源仓库+分支。 */
function sourceKey(r: Run): string {
  const pr = r.pull_requests?.[0]?.number;
  return pr ? `pr#${pr}` : `${r.head_repository?.id ?? "?"}:${r.head_branch}`;
}
const newer = (a: Run, b: Run) => a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id);

/** 判定可合并（取消）的任务：同工作流+来源+事件只保留最新一次；PR 已推新提交；排队过久的僵尸。 */
function findRedundant(repo: string, runs: Run[], zombieHours: number): Candidate[] {
  const defaultBranch = api<{ default_branch: string }>(`repos/${repo}`).default_branch;
  const prHeads = new Map(
    runs.some((r) => r.event === "pull_request")
      ? apiAll<{ number: number; head: { sha: string } }>(`repos/${repo}/pulls?state=open&per_page=100`, null)
          .map((p) => [p.number, p.head.sha])
      : [],
  );
  const key = (r: Run) => `${r.workflow_id}|${sourceKey(r)}|${r.event}`;
  const newest = new Map<string, Run>();
  for (const r of runs) {
    const cur = newest.get(key(r));
    if (!cur || newer(r, cur)) newest.set(key(r), r);
  }
  const out: Candidate[] = [];
  for (const r of runs) {
    const waited = attemptAge(r);
    if (r.status === "queued" && waited > zombieHours * 60) {
      out.push({ run: r, reason: `本次排队 ${age(waited)} 未被接走（僵尸）`, zombie: true });
      continue;
    }
    // 默认分支的 push 可能是发版构建，不自动合并
    if (r.event === "push" && r.head_branch === defaultBranch) continue;
    const pr = r.pull_requests?.[0]?.number;
    if (newest.get(key(r))?.id !== r.id) {
      out.push({ run: r, reason: "同一来源已有更新的同名任务", zombie: false });
    } else if (r.event === "pull_request" && pr && prHeads.has(pr) && prHeads.get(pr) !== r.head_sha) {
      out.push({ run: r, reason: `PR #${pr} 已推新提交 ${prHeads.get(pr)!.slice(0, 7)}`, zombie: false });
    }
  }
  return out;
}

function status() {
  const repoArg = flag("repo");
  const org = flag("org");
  if (!repoArg && !org) throw new UsageError("status 需要 --org <org> 或 --repo owner/name");
  const since = positive("since", 7);
  const cutoff = new Date(Date.now() - since * 86400000).toISOString();
  // 按最近活动筛仓库只是为了少发请求；长期不推代码但有定时任务的仓库请用 --repo 单独查
  const repos: string[] = repoArg
    ? [repoArg]
    : (JSON.parse(gh(["repo", "list", org!, "--limit", "1000", "--json", "nameWithOwner,pushedAt,updatedAt"])) as
        { nameWithOwner: string; pushedAt: string; updatedAt: string }[])
        .filter((r) => r.pushedAt > cutoff || r.updatedAt > cutoff)
        .map((r) => r.nameWithOwner);
  if (!repos.length) return console.log(`最近 ${since} 天没有活动的仓库（可用 --repo 指定）`);

  const pools = new Map<string, { queued: Job[]; running: Job[] }>();
  for (const repo of repos) {
    const runs = activeRuns(repo);
    if (!runs.length) continue;
    console.log(`\n■ ${repo}  进行中 ${runs.length} 个任务`);
    for (const r of runs.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      const holding = r.status === "queued" || r.status === "in_progress";
      const note = holding ? "" : "  （等待审批/并发，不占 runner）";
      console.log(`  ${r.status.padEnd(11)} ${age(attemptAge(r)).padStart(4)}  ${clean(r.name)} · ${clean(r.head_branch)} · ${r.head_sha.slice(0, 7)}  #${r.id}${note}`);
      if (!holding) continue;
      const jobs = apiAll<Job>(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`, "jobs")
        .filter((j) => j.status === "queued" || j.status === "in_progress");
      for (const j of jobs) {
        const pool = clean([...j.labels].sort().join(",")) || "(未知)";
        const p = pools.get(pool) ?? { queued: [], running: [] };
        (j.status === "in_progress" ? p.running : p.queued).push(j);
        pools.set(pool, p);
        const where = j.runner_name ? ` @${clean(j.runner_name)}` : "";
        console.log(`      ${j.status === "in_progress" ? "▶" : "…"} ${clean(j.name)}  [${pool}]${where}`);
      }
    }
  }
  console.log("\n■ runner 分组压力（排队多、运行少的就是瓶颈）");
  for (const [pool, p] of [...pools].sort((a, b) => b[1].queued.length - a[1].queued.length)) {
    const oldest = p.queued.reduce((m, j) => Math.max(m, mins(j.created_at)), 0);
    const runners = new Set(p.running.map((j) => j.runner_id ?? j.runner_name)).size;
    console.log(`  ${pool}\n    排队 ${p.queued.length} · 运行 ${p.running.length}（${runners} 台在忙）· 最久等待 ${age(oldest)}`);
  }
}

/** 执行前重新读取状态，条件已不成立（已结束、僵尸已被接走）就跳过。 */
function stillCancellable(repo: string, c: Candidate): string | null {
  const now = api<Run>(`repos/${repo}/actions/runs/${c.run.id}`);
  if (now.status === "completed") return "已结束";
  if (c.zombie && now.status !== "queued") return "已被 runner 接走";
  if (now.run_started_at !== c.run.run_started_at) return "已被重跑";
  return null;
}

function dedupe(): number {
  const repo = requireRepo("dedupe");
  const list = findRedundant(repo, activeRuns(repo), positive("zombie-hours", 6));
  if (!list.length) { console.log("没有可合并的重复任务"); return 0; }
  for (const { run, reason } of list) {
    console.log(`  #${run.id} ${clean(run.name)} · ${clean(run.head_branch)} · ${run.head_sha.slice(0, 7)} — ${reason}`);
  }
  if (!has("apply")) {
    console.log(`\n共 ${list.length} 个可取消。确认后加 --apply 执行（被取消的任务可在网页上重跑）。`);
    return 0;
  }
  let failed = 0;
  for (const c of list) {
    const id = c.run.id;
    const skip = stillCancellable(repo, c);
    if (skip) { console.log(`  跳过 #${id}：${skip}`); continue; }
    try { gh(["run", "cancel", String(id), "-R", repo]); console.log(`  已提交取消 #${id}`); continue; }
    catch { /* 卡死的任务普通取消会报错，改用强制取消 */ }
    try { gh(["api", "-X", "POST", `repos/${repo}/actions/runs/${id}/force-cancel`]); console.log(`  已提交强制取消 #${id}`); }
    catch (e) { failed++; console.log(`  取消失败 #${id}：${clean((e as Error).message.split("\n").pop())}`); }
  }
  return failed ? 1 : 0;
}

type Workflow = {
  on?: unknown; true?: unknown; // YAML 1.1 解析器可能把 on 读成 true
  concurrency?: string | { group?: unknown; "cancel-in-progress"?: unknown };
  jobs?: Record<string, { "runs-on"?: unknown }>;
};

function triggers(on: unknown): string[] {
  if (on === undefined) return ["push", "pull_request"]; // 省略 on 时 GitHub 按默认事件触发
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return on && typeof on === "object" ? Object.keys(on) : [];
}
const PER_COMMIT = /github\.sha|head\.sha|github\.run_id|github\.run_number/;
const PER_SOURCE = /github\.ref|github\.head_ref|pull_request\.number|github\.event\.number/;

/** 检查 PR/push 触发的工作流有没有按来源设置 cancel-in-progress。 */
function plan() {
  const repo = requireRepo("plan");
  let listing: { path: string }[];
  try { listing = api<{ path: string }[]>(`repos/${repo}/contents/.github/workflows`); }
  catch (e) {
    if (/HTTP 404/.test((e as Error).message)) return console.log("该仓库没有 .github/workflows 目录");
    throw e;
  }
  const files = listing.filter((f) => /\.ya?ml$/.test(f.path));
  let issues = 0;
  let skipped = 0;
  for (const f of files) {
    const text = Buffer.from(api<{ content: string }>(`repos/${repo}/contents/${f.path}`).content, "base64").toString();
    let wf: Workflow;
    try { wf = Bun.YAML.parse(text) as Workflow; }
    catch { skipped++; console.log(`\n? ${clean(f.path)}\n  YAML 解析失败，跳过`); continue; }
    if (!triggers(wf.on ?? wf.true).some((t) => t === "pull_request" || t === "push")) continue;

    const conc = typeof wf.concurrency === "string" ? { group: wf.concurrency } : wf.concurrency;
    const group = conc?.group === undefined ? undefined : String(conc.group);
    const cancel = conc?.["cancel-in-progress"];
    const cancelOn = cancel === true
      || (typeof cancel === "string" && !/^(false|\$\{\{\s*false\s*\}\})$/i.test(cancel.trim()));
    const selfHosted = Object.values(wf.jobs ?? {}).some((j) => /self-?hosted/i.test(JSON.stringify(j?.["runs-on"] ?? "")));

    let problem = "";
    if (group === undefined) problem = "没有顶层 concurrency，同分支连续推送会全部排队";
    else if (PER_COMMIT.test(group)) problem = `group 按提交区分（${clean(group)}），新提交不会取消旧任务`;
    else if (!PER_SOURCE.test(group)) problem = `group 不区分分支/PR（${clean(group)}），所有分支共用一条队列`;
    else if (!cancelOn) problem = "有 concurrency 但没开 cancel-in-progress";
    if (!problem) continue;
    issues++;
    console.log(`\n✗ ${clean(f.path)}${selfHosted ? "（占自托管机器）" : ""}\n  ${problem}`);
  }
  const unchecked = skipped ? `（另有 ${skipped} 个文件解析失败未检查）` : "";
  if (!issues) return console.log(`已检查的 PR/push 工作流都已按分支自动取消旧任务${unchecked}`);
  if (skipped) console.log(`\n注意：${skipped} 个文件解析失败未检查`);
  console.log(`\n建议在上面的文件顶层加入（默认分支不取消，其余分支与 PR 新提交取消旧任务）：
concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: \${{ github.ref != format('refs/heads/{0}', github.event.repository.default_branch) }}`);
}

const USAGE = "用法：bun scripts/ci-queue.ts <status|dedupe|plan> [--org x | --repo owner/name] [--apply]";
try {
  const cmd = process.argv[2];
  if (cmd === "status") status();
  else if (cmd === "dedupe") process.exitCode = dedupe();
  else if (cmd === "plan") plan();
  else throw new UsageError(USAGE);
} catch (e) {
  console.error(clean((e as Error).message).trim() || e);
  process.exit(e instanceof UsageError ? 2 : 1);
}
