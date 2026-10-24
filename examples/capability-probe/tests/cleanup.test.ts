import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanCloud, cleanLocal } from "../src/cleanup";
import { MANUAL_KEY } from "../src/kv-manual";
import { createPreviewPort } from "../src/preview-port";
import { PING_KEY, probeById, runProbe } from "../src/probes";
import { SAVED_RESULTS_KEY } from "../src/saved-results";
import { mountProbeView } from "../src/view";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register({ settings: { disableJavaScriptFileLoading: true, disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true } });
    ownsDom = true;
  }
});
afterAll(() => {
  if (ownsDom) GlobalRegistrator.unregister();
});

const signal = () => new AbortController().signal;

/** 等到条件成立（最多 3 秒），不靠固定时长，机器忙时也稳。 */
async function until(check: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("清理测试数据", () => {
  test("本地：删 probe.* 和 page.* 的键，测试结果留给清空流程，别的键不碰", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    await port.kv.set(PING_KEY, { at: "x" });
    await port.kv.set(MANUAL_KEY, { code: "ABCDEF" });
    await port.kv.set("page.visitor", "名字");
    await port.kv.set(SAVED_RESULTS_KEY, { clearedAt: null, results: [], log: [] });
    await port.kv.set("other.key", 1);
    const item = await cleanLocal(port.kv);
    expect(item.status).toBe("deleted");
    expect(item.summary).toContain("删了 3 条");
    expect((await port.kv.keys()).sort()).toEqual(["other.key", SAVED_RESULTS_KEY].sort());
    expect((await cleanLocal(port.kv)).status).toBe("none");
  });

  test("外脑：删掉探针写的知识库内容和测试行，文件和工作流如实说删不了；别人的数据不碰", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    for (const id of ["cloud-kb", "cloud-data", "cloud-data", "cloud-files-upload"]) {
      expect((await runProbe(probeById(id)!, { port, document, signal: signal() })).outcome).toBe("ok");
    }
    // 别人的数据：内容不以标记开头的知识库节点、名字不是测试行的数据行。
    await port.fetch("https://block2-api.wainao.chat/projects/p-test/kb/nodes", { endpointId: "wainao-api", method: "POST", body: JSON.stringify({ content: "用户自己的知识 能力探针知识库测试" }) });
    await port.fetch("https://block2-api.wainao.chat/projects/p-test/data", { endpointId: "wainao-api", method: "POST", body: JSON.stringify({ collectionId: "c1", data: { name: "用户的行" } }) });

    const deletes: string[] = [];
    const original = port.fetch.bind(port);
    port.fetch = async (url, init) => {
      if (init.method === "DELETE") deletes.push(new URL(url).pathname);
      return original(url, init);
    };
    const items = await cleanCloud(port, signal());
    const by = Object.fromEntries(items.map((item) => [item.id, item]));
    expect(by.kb!.status).toBe("deleted");
    expect(by.kb!.summary).toContain("删了 1 条");
    expect(by.rows!.status).toBe("deleted");
    expect(by.rows!.summary).toContain("删了 2 行");
    expect(by.files!.status).toBe("manual");
    expect(by.files!.summary).toMatch(/有 \d+ 个「capability-probe\.txt」/);
    expect(by.workflows!.status).toBe("manual");
    // 只删了探针自己的 3 条，没有尝试删文件。
    expect(deletes).toHaveLength(3);
    expect(deletes.every((path) => !path.startsWith("/storage/"))).toBe(true);

    const again = Object.fromEntries((await cleanCloud(port, signal())).map((item) => [item.id, item.status]));
    expect(again.kb).toBe("none");
    expect(again.rows).toBe("none");
    const left = JSON.parse((await original("https://block2-api.wainao.chat/projects/p-test/data?collectionId=c1", { endpointId: "wainao-api", method: "GET" })).text).data;
    expect(left.map((row: { data: { name: string } }) => row.data.name)).toEqual(["用户的行"]);
  }, 20000);

  test("外脑：没有 test 项目时一项都不删，如实说没清理", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    const original = port.fetch.bind(port);
    const touched: string[] = [];
    port.fetch = async (url, init) => {
      touched.push(`${init.method} ${new URL(url).pathname}`);
      if (url.endsWith("/projects")) return { status: 200, text: JSON.stringify({ data: [{ id: "p-other", name: "别的项目" }] }) };
      return original(url, init);
    };
    const items = await cleanCloud(port, signal());
    expect(touched).toEqual(["GET /projects"]);
    expect(items.filter((item) => item.id !== "workflows").every((item) => item.status === "skipped")).toBe(true);
  });

  test("外脑拒绝删除时如实报失败", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    await runProbe(probeById("cloud-kb")!, { port, document, signal: signal() });
    const original = port.fetch.bind(port);
    port.fetch = async (url, init) => (init.method === "DELETE" ? { status: 403, text: "{\"error\":\"insufficient_scope\"}" } : original(url, init));
    const kb = (await cleanCloud(port, signal())).find((item) => item.id === "kb")!;
    expect(kb.status).toBe("failed");
    expect(kb.summary).toContain("HTTP 403");
  }, 20000);

  test("翻页：跨页找到探针数据只删一次；扫到上限还没扫完时如实说没扫完", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    const add = (content: string) => port.fetch("https://block2-api.wainao.chat/projects/p-test/kb/nodes", { endpointId: "wainao-api", method: "POST", body: JSON.stringify({ content }) });
    for (let i = 0; i < 150; i += 1) await add(`用户的知识 ${i}`);
    await add("能力探针知识库测试 跨页");
    const deletes: string[] = [];
    const original = port.fetch.bind(port);
    port.fetch = async (url, init) => {
      if (init.method === "DELETE") deletes.push(new URL(url).pathname);
      return original(url, init);
    };
    const first = (await cleanCloud(port, signal())).find((item) => item.id === "kb")!;
    expect(first.status).toBe("deleted");
    expect(deletes).toHaveLength(1);
    for (let i = 150; i < 1000; i += 1) await add(`用户的知识 ${i}`);
    await add("能力探针知识库测试 第 1001 条之后");
    const second = (await cleanCloud(port, signal())).find((item) => item.id === "kb")!;
    expect(second.status).toBe("partial");
    expect(second.summary).toContain("后面的没查");
  }, 30000);

  test("清理进行中不能开始新测试", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const port = createPreviewPort({ delayMs: 5 });
    const view = mountProbeView(root, { port, hostVersion: Promise.resolve({ ok: true as const, version: "1.0.5" }), jumpDelayMs: 0 });
    view.show("records");
    const find = (label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
    find("清理测试数据")!.click();
    find("确认清理")!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    view.show("cloud");
    const button = root.querySelector<HTMLButtonElement>("[data-probe='cloud-data'] button")!;
    expect(button.disabled).toBe(true);
    await view.runEverything();
    // 声明式页面的写入在清理中被拒绝。
    view.show("page");
    const name = root.querySelector<HTMLInputElement>(".cp-spec-canvas input")!;
    name.value = "清理中写入";
    [...root.querySelectorAll<HTMLButtonElement>(".cp-spec-canvas button")].find((item) => item.textContent === "保存")!.click();
    await until(() => root.querySelector(".cp-spec-canvas")?.textContent?.includes("正在清理测试数据") === true);
    view.show("records");
    expect(root.textContent).toContain("清理中…");
    await until(() => root.querySelectorAll(".cp-cleanup [data-cleanup]").length === 5);
    // 清理完没有新的测试记录：runEverything 在清理中直接返回。
    view.show("records");
    expect(root.textContent).toContain("还没有测试记录");
    expect(await port.kv.get("page.visitor")).toBeUndefined();
    view.dispose();
  });

  test("界面：先确认再清理，清完逐项列出结果，测试结果也清空", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const port = createPreviewPort({ delayMs: 0 });
    const view = mountProbeView(root, { port, hostVersion: Promise.resolve({ ok: true as const, version: "1.0.5" }), jumpDelayMs: 0 });
    view.show("cloud");
    root.querySelector<HTMLButtonElement>("[data-probe='cloud-data'] button")!.click();
    await until(() => root.querySelector("[data-probe='cloud-data'] .cp-result") !== null);
    view.show("records");
    const find = (label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
    find("清理测试数据")!.click();
    expect(root.querySelector(".cp-cleanup-plan")?.textContent).toContain("删不了");
    find("确认清理")!.click();
    await until(() => root.querySelectorAll(".cp-cleanup [data-cleanup]").length === 5);
    const rows = [...root.querySelectorAll(".cp-cleanup [data-cleanup]")].map((row) => `${row.getAttribute("data-cleanup")}:${row.getAttribute("data-status")}`);
    expect(rows).toEqual(["local:none", "kb:none", "rows:deleted", "files:none", "workflows:manual"]);
    // 测试结果也一起清空了。
    expect(root.textContent).toContain("还没有测试记录");
    view.dispose();
  });
});
