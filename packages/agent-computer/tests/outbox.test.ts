import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox } from "../src/outbox";

let base: string;
let stage: string;
let target: string;
let outbox: Outbox;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agent-outbox-"));
  stage = join(base, "stage");
  target = join(base, "target");
  await mkdir(stage);
  await mkdir(target);
  outbox = new Outbox({ root: stage, allowedTargets: [target], maxFileBytes: 1024 });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("Outbox", () => {
  test("未批准时目标目录没有文件；批准后出现且内容一致", async () => {
    await writeFile(join(stage, "报告.txt"), "hello");
    const [candidate] = await outbox.list();
    expect(candidate).toMatchObject({ path: "报告.txt", size: 5 });
    expect(readdirSync(target)).toEqual([]);
    const result = await outbox.approve({ candidateId: candidate!.id, sha256: candidate!.sha256, targetDir: target });
    expect(await readFile(result.path, "utf8")).toBe("hello");
    expect(readdirSync(target)).toEqual(["报告.txt"]);
  });

  test("批准后客体又改了文件：拒绝导出，不留残余", async () => {
    await writeFile(join(stage, "a.txt"), "v1");
    const [candidate] = await outbox.list();
    await writeFile(join(stage, "a.txt"), "v2-modified");
    await expect(
      outbox.approve({ candidateId: candidate!.id, sha256: candidate!.sha256, targetDir: target }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(readdirSync(target)).toEqual([]);
  });

  test("同名文件默认不覆盖", async () => {
    await writeFile(join(stage, "a.txt"), "new");
    await writeFile(join(target, "a.txt"), "old");
    const [candidate] = await outbox.list();
    await expect(
      outbox.approve({ candidateId: candidate!.id, sha256: candidate!.sha256, targetDir: target }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(target, "a.txt"), "utf8")).toBe("old");
  });

  test("符号链接不列出、不能导出（含目录被替换成链接）", async () => {
    await writeFile(join(base, "secret.txt"), "host secret");
    await symlink(join(base, "secret.txt"), join(stage, "link.txt"));
    await mkdir(join(stage, "sub"));
    await writeFile(join(stage, "sub", "ok.txt"), "ok");
    const list = await outbox.list();
    expect(list.map((c) => c.path)).toEqual([join("sub", "ok.txt")]);
    const candidate = list[0]!;
    // 列出之后把目录换成指向宿主的链接。
    await rm(join(stage, "sub"), { recursive: true });
    await mkdir(join(base, "elsewhere"));
    await writeFile(join(base, "elsewhere", "ok.txt"), "ok");
    await symlink(join(base, "elsewhere"), join(stage, "sub"));
    await expect(
      outbox.approve({ candidateId: candidate.id, sha256: candidate.sha256, targetDir: target }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(readdirSync(target)).toEqual([]);
  });

  test("伪造的候选 ID（路径穿越）被拒", async () => {
    await writeFile(join(base, "secret.txt"), "x");
    const forged = Buffer.from("../secret.txt").toString("base64url");
    await expect(outbox.approve({ candidateId: forged, sha256: "0", targetDir: target })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("目标目录不在允许列表内被拒", async () => {
    await writeFile(join(stage, "a.txt"), "x");
    const [candidate] = await outbox.list();
    await expect(
      outbox.approve({ candidateId: candidate!.id, sha256: candidate!.sha256, targetDir: base }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("目标目录他人可写：拒绝导出", async () => {
    await writeFile(join(stage, "a.txt"), "x");
    const [candidate] = await outbox.list();
    await chmod(target, 0o777);
    await expect(
      outbox.approve({ candidateId: candidate!.id, sha256: candidate!.sha256, targetDir: target }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("单次列表的摘要预算用完：大文件留到下次", async () => {
    const limited = new Outbox({ root: stage, allowedTargets: [target], maxFileBytes: 1024, maxHashBytesPerList: 100 });
    await writeFile(join(stage, "a.txt"), Buffer.alloc(60));
    await writeFile(join(stage, "b.txt"), Buffer.alloc(60));
    expect((await limited.list()).length).toBe(1);
    expect((await limited.list()).length).toBe(2); // 第一个已缓存，不再占预算
  });

  test("条目上限：超大目录只扫描到上限为止", async () => {
    const limited = new Outbox({ root: stage, allowedTargets: [target], maxFiles: 5 });
    for (let i = 0; i < 20; i += 1) await writeFile(join(stage, `f${String(i).padStart(2, "0")}.txt`), "x");
    expect((await limited.list()).length).toBeLessThanOrEqual(5);
  });

  test("超过大小上限的文件不列出", async () => {
    await writeFile(join(stage, "big.bin"), Buffer.alloc(2048));
    expect(await outbox.list()).toEqual([]);
  });

  test("拒绝：不删除宿主路径上的文件，只是不再列出这一版；内容变了会重新出现", async () => {
    await writeFile(join(stage, "a.txt"), "x");
    const [candidate] = await outbox.list();
    await outbox.reject({ candidateId: candidate!.id, sha256: candidate!.sha256 });
    expect(existsSync(join(stage, "a.txt"))).toBe(true);
    expect(await outbox.list()).toEqual([]);
    await writeFile(join(stage, "a.txt"), "y");
    expect((await outbox.list()).map((c) => c.path)).toEqual(["a.txt"]);
  });

  test("列出后把文件换成指向宿主的链接：导出被拒", async () => {
    await writeFile(join(base, "secret.txt"), "host secret");
    await writeFile(join(stage, "a.txt"), "ok");
    const [candidate] = await outbox.list();
    await rm(join(stage, "a.txt"));
    await symlink(join(base, "secret.txt"), join(stage, "a.txt"));
    await expect(
      outbox.approve({ candidateId: candidate!.id, sha256: candidate!.sha256, targetDir: target }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(readdirSync(target)).toEqual([]);
  });

  test("列出后文件长大超过上限：导出被拒且不留临时文件", async () => {
    await writeFile(join(stage, "a.bin"), Buffer.alloc(10));
    const [candidate] = await outbox.list();
    await writeFile(join(stage, "a.bin"), Buffer.alloc(4096));
    await expect(
      outbox.approve({ candidateId: candidate!.id, sha256: candidate!.sha256, targetDir: target }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(readdirSync(target)).toEqual([]);
  });
});
