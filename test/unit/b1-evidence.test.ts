import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupEvidenceFacts, exportB1Evidence } from "../harness/b1-run.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `omp-agent-b1-${label}-`));
  roots.push(root);
  return root;
}

describe("B1 evidence retention", () => {
  test("an oversized file is reported incomplete and never silently dropped", async () => {
    const root = await tempRoot("evidence-incomplete");
    const source = path.join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "small.log"), "ok");
    await writeFile(path.join(source, "large.log"), "0123456789");

    const exported = await exportB1Evidence({
      sourceRoot: source,
      evidenceRoot: path.join(root, "evidence"),
      scenario: "scenario",
      reason: "assertion failed",
      frames: [{ frame: 1 }],
      stderr: "stderr",
      budgetBytes: 4,
    });

    expect(exported.complete).toBe(false);
    expect(exported.skipped).toEqual(["large.log (10 bytes over budget)"]);
    expect(exported.copied).toContain("small.log");
    const manifest = JSON.parse(await readFile(path.join(exported.target, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      scenario: "scenario",
      reason: "assertion failed",
      originalRoot: source,
      frames: 1,
      complete: false,
    });
    expect(manifest.skipped).toEqual(["large.log (10 bytes over budget)"]);
  });

  test("a complete export says so and keeps unique attempt directories", async () => {
    const root = await tempRoot("evidence-complete");
    const source = path.join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "one.log"), "ok");
    const evidenceRoot = path.join(root, "evidence");
    const first = await exportB1Evidence({
      sourceRoot: source, evidenceRoot, scenario: "scenario", reason: "assertion failed", frames: [], stderr: "",
    });
    const second = await exportB1Evidence({
      sourceRoot: source, evidenceRoot, scenario: "scenario", reason: "assertion failed", frames: [], stderr: "",
    });
    expect(first.complete).toBe(true);
    expect(first.skipped).toEqual([]);
    expect(first.target).not.toBe(second.target);
  });

  test("a cleanup failure is a reason and preserves the original evidence", () => {
    expect(cleanupEvidenceFacts({
      testFailure: "assertion failed",
      processFailure: undefined,
      cleanupFailure: "OMP process group did not exit after SIGKILL.",
    })).toEqual({
      reason: "assertion failed\ncleanup failure: OMP process group did not exit after SIGKILL.",
      preserveSource: true,
    });
    expect(cleanupEvidenceFacts({
      testFailure: undefined,
      processFailure: undefined,
      cleanupFailure: "OMP process group did not exit after SIGKILL.",
    }).reason).toContain("cleanup failure:");
    expect(cleanupEvidenceFacts({
      testFailure: "assertion failed",
      processFailure: undefined,
      cleanupFailure: undefined,
    })).toEqual({ reason: "assertion failed", preserveSource: false });
  });
});
