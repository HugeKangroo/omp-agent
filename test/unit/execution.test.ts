import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXECUTION_LIMITS,
  ExecutionAdapter,
  executionErrorResult,
  parseExecutionArguments,
  sandboxProfile,
  type ExecutionToolContext,
} from "../../src/execution-adapter.ts";
import { requirementsDigest } from "../../src/task-requirements.ts";
import { TaskOwner, type TaskSubject } from "../../src/task-owner.ts";

const WORKSPACE = path.join(tmpdir(), "omp-agent-g2a1-unit-workspace");
const SESSION = "g2a1-session";
const NOW = "2026-11-08T00:00:00.000Z";
const PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";
const BUN = process.execPath;
const LAUNCHER = path.resolve(import.meta.dir, "../../scripts/isolated-exec.py");

type Entry = Record<string, unknown> & { id: string; parentId: string | null };

function base(): Entry {
  return { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} };
}

function user(id: string, parentId: string, text: string): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      attribution: "user",
    },
  };
}

function assistant(id: string, parentId: string): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "working" }],
    },
  };
}

function subject(branch: readonly unknown[]): TaskSubject {
  return { sessionId: SESSION, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

function guard(owner: TaskOwner, taskRevision?: number) {
  const task = owner.snapshot().currentTask;
  if (!task) throw new Error("test setup: no current task");
  return { taskId: task.taskId, taskRevision: taskRevision ?? task.taskRevision };
}

function context(branch: readonly unknown[], leafId: string): ExecutionToolContext {
  return {
    cwd: WORKSPACE,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => SESSION,
      getLeafId: () => leafId,
      getBranch: () => branch,
    },
  };
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function currentTaskId(owner: TaskOwner): string {
  const task = owner.snapshot().currentTask;
  if (!task) throw new Error("test fixture: no current task");
  return task.taskId;
}

interface Fixture {
  root: string;
  fixtures: string;
  alphaPath: string;
  alphaBytes: Buffer;
  owner: TaskOwner;
  branch: readonly Entry[];
  ctx: ExecutionToolContext;
  adapter: ExecutionAdapter;
  runDirs: () => Promise<string[]>;
  cleanup: () => Promise<void>;
}

async function fixture(options: {
  dispatchWallMs?: number;
  terminationGraceMs?: number;
  extraInputs?: Array<{ id: string; path: string }>;
  badInputs?: boolean;
  launcherPath?: string;
  recordWriter?: (filePath: string, value: unknown) => void;
  now?: () => string;
} = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2a1-unit-")));
  const fixtures = path.join(root, "fixtures");
  await mkdir(fixtures);
  const alphaPath = path.join(fixtures, "alpha.txt");
  const alphaBytes = Buffer.from("authorized alpha input\nsecond line\n", "utf8");
  await writeFile(alphaPath, alphaBytes, { mode: 0o600 });
  const extraInputs = [...(options.extraInputs ?? [])];
  if (options.badInputs === true) {
    const symlinkPath = path.join(fixtures, "symlink.txt");
    const hardlinkPath = path.join(fixtures, "hardlink.txt");
    await symlink(alphaPath, symlinkPath);
    await link(alphaPath, hardlinkPath);
    extraInputs.push({ id: "symlink", path: symlinkPath }, { id: "hardlink", path: hardlinkPath });
  }
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: WORKSPACE,
    ownerId: "owner-g2a1-unit",
    authorizedCapabilities: ["local-script"],
    now: () => NOW,
    id: () => `id-${++sequence}`,
  });
  const branch = [base(), user("user-1", "leaf-1", "Run the local candidate.")];
  const ctx = context(branch, "user-1");
  owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text: "Run the local candidate.",
    observedAt: NOW,
    baseLeafId: "leaf-1",
  });
  owner.observeAgentStart({ sessionId: SESSION, prompt: "Run the local candidate.", reason: "prompt" });
  owner.start(subject(branch), "unit execution");
  const adapter = new ExecutionAdapter(owner, {
    root,
    inputs: [{ id: "alpha", path: alphaPath }, ...extraInputs],
    capabilityId: "local-script",
    id: () => `run-${++sequence}`,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.dispatchWallMs === undefined ? {} : { dispatchWallMs: options.dispatchWallMs }),
    ...(options.terminationGraceMs === undefined ? {} : { terminationGraceMs: options.terminationGraceMs }),
    ...(options.launcherPath === undefined ? {} : { launcherPath: options.launcherPath }),
    ...(options.recordWriter === undefined ? {} : { recordWriter: options.recordWriter }),
  });
  return {
    root,
    fixtures,
    alphaPath,
    alphaBytes,
    owner,
    branch,
    ctx,
    adapter,
    runDirs: async () => (await readdir(root)).filter((name) => name.startsWith("run-")).sort(),
    cleanup: async () => {
      adapter.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function detailsOf(result: { details?: unknown }): Record<string, any> {
  return result.details as Record<string, any>;
}

function contentOf(result: { content: Array<{ type: "text"; text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

const PYTHON_INPUT_ARTIFACT = `
import hashlib, json, os
manifest = json.load(open(os.environ["OMP_INPUTS_MANIFEST"], encoding="utf-8"))
source = open(manifest["handles"]["alpha"]["path"], "rb").read()
digest = hashlib.sha256(source).hexdigest().encode("ascii")
open("computed.txt", "wb").write(digest + b"\\n" + source)
print("python input bytes", len(source))
`;

const BUN_INPUT_ARTIFACT = `
import { cpus } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const manifest = JSON.parse(readFileSync(process.env.OMP_INPUTS_MANIFEST!, "utf8"));
const source = readFileSync(manifest.handles.alpha.path);
const digest = createHash("sha256").update(source).digest("hex");
writeFileSync("computed.txt", digest + "\\n" + source.toString("utf8"));
writeFileSync("cpus.txt", String(cpus().length));
console.log("bun input bytes", source.length);
`;

const SYSCTL_PROBE = `
import ctypes

def sysctl_query(pid, selector):
    libc = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, selector, pid)
    size = ctypes.c_size_t(0)
    ctypes.set_errno(0)
    rc = libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0)
    errno_first = ctypes.get_errno()
    if rc != 0:
        return {"rc": rc, "errno": errno_first}
    buffer = ctypes.create_string_buffer(size.value)
    ctypes.set_errno(0)
    rc = libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0)
    errno_second = ctypes.get_errno()
    if rc != 0:
        return {"rc": rc, "errno": errno_second}
    data = buffer.raw[:size.value]
    return {
        "rc": 0,
        "errno": 0,
        "argvMarker": b"SYNTHETIC_ARGV_MARKER" in data,
        "envMarker": b"SYNTHETIC_ENV_MARKER" in data,
    }
`;

describe("agent_execute argument parsing", () => {
  test("accepts describe and bounded run arguments", () => {
    expect(parseExecutionArguments({ action: "describe" })).toEqual({ action: "describe" });
    expect(parseExecutionArguments({
      action: "run",
      runtime: "python",
      source: "print('x')",
      inputIds: ["alpha"],
      expectedTaskId: "task-1",
      expectedTaskRevision: 1,
    })).toMatchObject({ action: "run", runtime: "python", inputIds: ["alpha"], expectedTaskId: "task-1", expectedTaskRevision: 1 });
  });

  test("describe accepts either no guard or one complete positive pair", () => {
    expect(parseExecutionArguments({ action: "describe" })).toEqual({ action: "describe" });
    expect(parseExecutionArguments({
      action: "describe",
      expectedTaskId: "task-1",
      expectedTaskRevision: 2,
    })).toEqual({ action: "describe", expectedTaskId: "task-1", expectedTaskRevision: 2 });
  });

  test("describe rejects half pairs, nulls, invalid guards and authority fields", () => {
    const invalid = [
      { action: "describe", expectedTaskId: "task-1" },
      { action: "describe", expectedTaskRevision: 1 },
      { action: "describe", expectedTaskId: null, expectedTaskRevision: 1 },
      { action: "describe", expectedTaskId: "task-1", expectedTaskRevision: null },
      { action: "describe", expectedTaskId: null, expectedTaskRevision: null },
      { action: "describe", expectedTaskId: 42, expectedTaskRevision: 1 },
      { action: "describe", expectedTaskId: "task-1", expectedTaskRevision: "1" },
      { action: "describe", expectedTaskId: "", expectedTaskRevision: 1 },
      { action: "describe", expectedTaskId: "../task", expectedTaskRevision: 1 },
      { action: "describe", expectedTaskId: "task-1", expectedTaskRevision: 0 },
      { action: "describe", expectedTaskId: "task-1", expectedTaskRevision: -1 },
      { action: "describe", expectedTaskId: "task-1", expectedTaskRevision: 1.5 },
      { action: "describe", expectedTaskId: "task-1", expectedTaskRevision: Number.MAX_SAFE_INTEGER + 1 },
      { action: "describe", expectedTaskId: "task-1", expectedTaskRevision: 1, taskId: "task-1" },
      { action: "describe", expectedTaskId: "task-1", expectedTaskRevision: 1, revision: 1 },
      { action: "describe", expectedTaskId: "task-1", expectedTaskRevision: 1, path: "/etc/passwd" },
    ];
    for (const value of invalid) expect(() => parseExecutionArguments(value)).toThrow();
  });

  test("rejects host authority, paths, environment and duplicate handles", () => {
    const forbidden = [
      { action: "run", runtime: "python", source: "x", expectedTaskRevision: 1 },
      { action: "run", runtime: "python", source: "x", expectedTaskId: "../task", expectedTaskRevision: 1 },
      { action: "run", runtime: "python", source: "x", expectedTaskId: "", expectedTaskRevision: 1 },
      { action: "run", runtime: "python", source: "x", expectedTaskId: "task-1", expectedTaskRevision: 1, path: "/etc/passwd" },
      { action: "run", runtime: "python", source: "x", expectedTaskId: "task-1", expectedTaskRevision: 1, env: { A: "B" } },
      { action: "run", runtime: "python", source: "x", expectedTaskId: "task-1", expectedTaskRevision: 1, taskId: "task-1" },
      { action: "run", runtime: "python", source: "x", expectedTaskId: "task-1", expectedTaskRevision: 1, interpreter: "/bin/sh" },
      { action: "run", runtime: "python", source: "x", inputIds: ["a", "a"], expectedTaskId: "task-1", expectedTaskRevision: 1 },
      { action: "describe", taskId: "task-1" },
    ];
    for (const value of forbidden) expect(() => parseExecutionArguments(value)).toThrow();
  });

  test("source byte limit is enforced before any execution", () => {
    expect(() => parseExecutionArguments({
      action: "run",
      runtime: "python",
      source: "x".repeat(EXECUTION_LIMITS.maxSourceBytes + 1),
      expectedTaskId: "task-1",
      expectedTaskRevision: 1,
    })).toThrow();
  });

  test("oversized error diagnostics stay bounded and retain taskAccepted:false", () => {
    const result = executionErrorResult(`diagnostic ${"x".repeat(20_000)}`);
    expect(result.isError).toBe(true);
    const text = result.content.map((part) => part.text).join("\n");
    expect(text).toContain("…");
    expect(text.endsWith("taskAccepted: false")).toBe(true);
    expect(result.details).toMatchObject({ taskAccepted: false });
    expect(String(result.details!.error).length).toBe(2000);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(EXECUTION_LIMITS.maxToolResponseBytes);
  });
});

describe("agent_execute describe", () => {
  test("reports actual runtimes, truthful limits and authorized handles without full paths", async () => {
    const f = await fixture();
    try {
      const result = await f.adapter.describe(f.ctx);
      expect(result.isError).toBeUndefined();
      const details = detailsOf(result);
      expect(details.action).toBe("describe");
      expect(details.taskRevision).toBe(1);
      expect(details.taskAccepted).toBe(false);
      expect(details.runtimes.python.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(details.runtimes.bun.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(details.limits.version).toBe(EXECUTION_LIMITS.version);
      expect(details.limits.maxInputs).toBe(8);
      expect(details.limits.dispatchWallMs).toBe(EXECUTION_LIMITS.dispatchWallMs);
      expect(details.authorizedInputs).toEqual([
        expect.objectContaining({ id: "alpha", name: "alpha.txt", available: true }),
      ]);
      expect(JSON.stringify(details)).not.toContain(f.fixtures);
    } finally {
      await f.cleanup();
    }
  });

  test("returned runtime facts are detached from later describe and actual run evidence", async () => {
    const f = await fixture();
    try {
      const first = await f.adapter.describe(f.ctx);
      const original = detailsOf(first).runtimes.python.version;
      expect(original).toMatch(/^\d+\.\d+\.\d+$/);
      detailsOf(first).runtimes.python.version = "FORGED-VERSION";
      detailsOf(first).runtimes.python.executable = "forged-python";

      const fresh = await f.adapter.describe(f.ctx);
      expect(detailsOf(fresh).runtimes.python.version).toBe(original);
      expect(detailsOf(fresh).runtimes.python.executable).not.toBe("forged-python");

      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('trusted runtime remains')",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      expect(result.isError).toBeUndefined();
      expect(detailsOf(result).runtimeVersion).toBe(original);
      const runContent = contentOf(result);
      expect(runContent).toContain(`version="${original}"`);
      expect(runContent).not.toContain("FORGED-VERSION");
      const record = JSON.parse(await readFile(path.join(f.root, String(detailsOf(result).hostRecordRef)), "utf8"));
      expect(record.runtimeVersion).toBe(original);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("describe content alone carries task, runtimes, authorized inputs, limits, attempts and the generic I/O guide", async () => {
    const f = await fixture();
    try {
      const content = contentOf(await f.adapter.describe(f.ctx));
      expect(content).toContain("model-visible execution view g2a3-model-view-v1");
      expect(content).toContain("action=describe");
      expect(content).toMatch(/task taskId="task-[^"]+" taskRevision=1 taskStatus="active"/);
      expect(content).toMatch(/- name="python" version="\d+\.\d+\.\d+" hostSelected=true available=true/);
      expect(content).toMatch(/- name="bun" version="\d+\.\d+\.\d+" hostSelected=true available=true/);
      expect(content).toContain(`- id="alpha" name="alpha.txt" bytes=${f.alphaBytes.length} sha256="${sha256(f.alphaBytes)}" writable=false available=true`);
      expect(content).toContain("limits: version=\"g2a2-v1\" maxInputs=8");
      expect(content).toContain("attempts: limit=8 attempted=0 dispatched=0 reserved=0 remaining=8");
      expect(content).toContain("authority candidateOnly=true taskAccepted=false");
      expect(content).toContain("OMP_WORK_DIR");
      expect(content).toContain("OMP_INPUTS_MANIFEST");
      expect(content).toContain("manifest.handles[inputId] is {path, bytes, sha256, writable:false}");
      expect(content).toContain("never guess a host workspace, private archive or previous-run directory");
      expect(content).toContain("Write intended candidate files as ordinary top-level files");
      expect(content).toContain("Previous-run artifacts/archives are not automatically readable or writable inputs");
      expect(content).not.toContain(f.fixtures);
      expect(content).not.toContain(f.root);
    } finally {
      await f.cleanup();
    }
  });

  test("describe withholds task and input metadata when the binding detaches during inspection", async () => {
    const f = await fixture();
    try {
      const pending = f.adapter.describe(f.ctx);
      f.owner.navigate("session_tree", SESSION);
      const result = await pending;
      expect(result.isError === true || (detailsOf(result).authorizedInputs === undefined)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(f.fixtures);
      expect(JSON.stringify(result)).not.toContain("alpha.txt");
    } finally {
      await f.cleanup();
    }
  });

  test("unguarded describe and a valid current pair return the same facts without attempts, admissions or runs", async () => {
    const f = await fixture();
    try {
      const unguarded = await f.adapter.describe(f.ctx);
      const task = f.owner.snapshot().currentTask!;
      const args = {
        action: "describe" as const,
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
      };
      const pending = f.adapter.describe(f.ctx, args);
      // Caller mutation after the call must not retarget the copied primitives.
      args.expectedTaskId = "forged-task";
      args.expectedTaskRevision = 99;
      const paired = await pending;
      expect(paired.isError).toBeUndefined();
      expect(detailsOf(paired)).toEqual(detailsOf(unguarded));
      expect(contentOf(paired)).toBe(contentOf(unguarded));
      expect(detailsOf(paired).dispatchBudget).toEqual({ limit: 8, attempted: 0, dispatched: 0, reserved: 0 });
      expect(f.owner.snapshot().currentTask).toMatchObject({ admissions: 0, acceptance: null, status: "active" });
      expect(await f.runDirs()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("wrong task id and future revision reject before input metadata without effects", async () => {
    const f = await fixture();
    try {
      const task = f.owner.snapshot().currentTask!;
      for (const args of [
        { action: "describe" as const, expectedTaskId: "task-other", expectedTaskRevision: task.taskRevision },
        { action: "describe" as const, expectedTaskId: task.taskId, expectedTaskRevision: task.taskRevision + 1 },
      ]) {
        const result = await f.adapter.describe(f.ctx, args);
        expect(result.isError).toBe(true);
        expect((result.details as Record<string, unknown>).authorizedInputs).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain("alpha.txt");
        expect(JSON.stringify(result)).not.toContain(f.fixtures);
      }
      const after = await f.adapter.describe(f.ctx);
      expect(detailsOf(after).dispatchBudget).toEqual({ limit: 8, attempted: 0, dispatched: 0, reserved: 0 });
      expect(f.owner.snapshot().currentTask).toMatchObject({ admissions: 0, acceptance: null, taskRevision: 1 });
      expect(await f.runDirs()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("a stale revision rejects after a genuine revision while the current pair succeeds", async () => {
    const f = await fixture();
    try {
      const amended = "Amend the current task requirements.";
      f.owner.sessionChanged();
      expect(f.owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: WORKSPACE,
        source: "rpc",
        text: amended,
        observedAt: NOW,
        baseLeafId: "user-1",
      }).accepted).toBe(true);
      f.owner.observeAgentStart({ sessionId: SESSION, prompt: amended, reason: "prompt" });
      const branch2 = [...f.branch, user("user-2", "user-1", amended)];
      expect(f.owner.revise(subject(branch2), guard(f.owner), "amended").revised).toBe(true);
      const task = f.owner.snapshot().currentTask!;
      expect(task.taskRevision).toBe(2);

      const stale = await f.adapter.describe(f.ctx, {
        action: "describe",
        expectedTaskId: task.taskId,
        expectedTaskRevision: 1,
      });
      expect(stale.isError).toBe(true);
      expect((stale.details as Record<string, unknown>).authorizedInputs).toBeUndefined();
      expect(JSON.stringify(stale)).not.toContain("alpha.txt");

      const current = await f.adapter.describe(f.ctx, {
        action: "describe",
        expectedTaskId: task.taskId,
        expectedTaskRevision: 2,
      });
      expect(current.isError).toBeUndefined();
      expect(detailsOf(current)).toMatchObject({ taskId: task.taskId, taskRevision: 2, taskStatus: "active" });
      expect(f.owner.snapshot().currentTask).toMatchObject({ admissions: 0, acceptance: null, taskRevision: 2 });
      expect(await f.runDirs()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("a cancelled current task remains visible to unguarded and matching-pair describe", async () => {
    const f = await fixture();
    try {
      const task = f.owner.snapshot().currentTask!;
      f.owner.cancel(subject(f.branch), guard(f.owner));
      const unguarded = await f.adapter.describe(f.ctx);
      const paired = await f.adapter.describe(f.ctx, {
        action: "describe",
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
      });
      expect(unguarded.isError).toBeUndefined();
      expect(paired.isError).toBeUndefined();
      expect(detailsOf(unguarded)).toMatchObject({ taskId: task.taskId, taskStatus: "cancelled", taskAccepted: false });
      expect(contentOf(paired)).toContain('taskStatus="cancelled"');
      expect(detailsOf(paired)).toEqual(detailsOf(unguarded));
      const wrong = await f.adapter.describe(f.ctx, {
        action: "describe",
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision + 1,
      });
      expect(wrong.isError).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("a retained old task pair cannot select history after a new task starts", async () => {
    const f = await fixture();
    try {
      const taskA = f.owner.snapshot().currentTask!;
      const cancelText = "Cancel task A.";
      const cancelBranch = [...f.branch, assistant("assistant-1", "user-1"), user("user-2", "assistant-1", cancelText)];
      f.owner.sessionChanged();
      f.owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: WORKSPACE,
        source: "rpc",
        text: cancelText,
        observedAt: NOW,
        baseLeafId: "assistant-1",
      });
      f.owner.observeAgentStart({ sessionId: SESSION, prompt: cancelText, reason: "prompt" });
      expect(f.owner.cancel(subject(cancelBranch), { taskId: taskA.taskId, taskRevision: taskA.taskRevision }).status)
        .toBe("cancelled");

      const startText = "Start task B.";
      const branchB = [...cancelBranch, assistant("assistant-2", "user-2"), user("user-3", "assistant-2", startText)];
      f.owner.sessionChanged();
      f.owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: WORKSPACE,
        source: "rpc",
        text: startText,
        observedAt: NOW,
        baseLeafId: "assistant-2",
      });
      f.owner.observeAgentStart({ sessionId: SESSION, prompt: startText, reason: "prompt" });
      const started = f.owner.start(subject(branchB), "task B");
      expect(started.created).toBe(true);
      const ctxB = context(branchB, "user-3");
      const taskB = f.owner.snapshot().currentTask!;
      expect(taskB.taskId).not.toBe(taskA.taskId);

      const old = await f.adapter.describe(ctxB, {
        action: "describe",
        expectedTaskId: taskA.taskId,
        expectedTaskRevision: taskA.taskRevision,
      });
      expect(old.isError).toBe(true);
      expect((old.details as Record<string, unknown>).authorizedInputs).toBeUndefined();
      expect(JSON.stringify(old)).not.toContain("alpha.txt");

      const current = await f.adapter.describe(ctxB, {
        action: "describe",
        expectedTaskId: taskB.taskId,
        expectedTaskRevision: taskB.taskRevision,
      });
      expect(current.isError).toBeUndefined();
      expect(detailsOf(current)).toMatchObject({ taskId: taskB.taskId, taskRevision: 1, taskStatus: "active" });
      expect(f.owner.snapshot().currentTask).toMatchObject({ taskId: taskB.taskId, admissions: 0, acceptance: null });
      expect(await f.runDirs()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("a real revision during the input await rejects the copied pair even after caller mutation", async () => {
    const f = await fixture();
    try {
      const task = f.owner.snapshot().currentTask!;
      const amended = "Revise while describe is awaiting input inspection.";
      f.owner.sessionChanged();
      f.owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: WORKSPACE,
        source: "rpc",
        text: amended,
        observedAt: NOW,
        baseLeafId: "user-1",
      });
      f.owner.observeAgentStart({ sessionId: SESSION, prompt: amended, reason: "prompt" });
      const branch2 = [...f.branch, user("user-2", "user-1", amended)];

      const args = {
        action: "describe" as const,
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
      };
      const pending = f.adapter.describe(f.ctx, args);
      // The caller's revision and the actual task revision both move to 2. A
      // post-await reread of the caller object would falsely match; only the
      // copied parsed pair can prove the stale revision still rejects.
      args.expectedTaskRevision = 2;
      const revised = f.owner.revise(subject(branch2), guard(f.owner), "revised during describe");
      expect(revised.revised).toBe(true);

      const result = await pending;
      expect(result.isError).toBe(true);
      expect((result.details as Record<string, unknown>).authorizedInputs).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("alpha.txt");
      expect(f.owner.snapshot().currentTask).toMatchObject({ taskId: task.taskId, taskRevision: 2, admissions: 0 });
      expect(await f.runDirs()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("disposal during the input await withholds describe", async () => {
    const f = await fixture();
    try {
      const task = f.owner.snapshot().currentTask!;
      const pending = f.adapter.describe(f.ctx, {
        action: "describe",
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
      });
      f.adapter.dispose();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect((result.details as Record<string, unknown>).authorizedInputs).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("alpha.txt");
    } finally {
      await f.cleanup();
    }
  });

  test("a final getBranch disposal withholds stale describe metadata", async () => {
    const f = await fixture();
    let reads = 0;
    let disposedByGetter = false;
    const racingContext: ExecutionToolContext = {
      cwd: WORKSPACE,
      agent: { kind: "main" },
      sessionManager: {
        getSessionId: () => SESSION,
        getLeafId: () => "user-1",
        getBranch: () => {
          reads += 1;
          if (reads === 2) {
            disposedByGetter = true;
            f.adapter.dispose();
          }
          return f.branch;
        },
      },
    };
    try {
      const result = await f.adapter.describe(racingContext);
      expect(disposedByGetter).toBe(true);
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(result.isError).toBe(true);
      expect((result.details as Record<string, unknown>).authorizedInputs).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("alpha.txt");
      expect(result.details).toMatchObject({ taskAccepted: null, currentTaskStatus: null });
    } finally {
      await f.cleanup();
    }
  });

  test("a final getBranch cancellation is reported from the fresh snapshot", async () => {
    const f = await fixture();
    let reads = 0;
    let cancelledByGetter = 0;
    const racingContext: ExecutionToolContext = {
      cwd: WORKSPACE,
      agent: { kind: "main" },
      sessionManager: {
        getSessionId: () => SESSION,
        getLeafId: () => "user-1",
        getBranch: () => {
          reads += 1;
          if (reads === 2) {
            f.owner.cancel(subject(f.branch), guard(f.owner));
            cancelledByGetter += 1;
          }
          return f.branch;
        },
      },
    };
    try {
      const result = await f.adapter.describe(racingContext);
      expect(cancelledByGetter).toBe(1);
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(result.isError).toBeUndefined();
      expect(detailsOf(result)).toMatchObject({ taskStatus: "cancelled", taskAccepted: false, taskRevision: 1 });
      expect(contentOf(result)).toContain('taskStatus="cancelled"');
      expect(f.owner.snapshot().currentTask?.status).toBe("cancelled");
    } finally {
      await f.cleanup();
    }
  });
});

describe("generic Python and Bun execution", () => {
  test("Python reads the authorized input and writes a host-verifiable artifact", async () => {
    const f = await fixture();
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: PYTHON_INPUT_ARTIFACT,
        inputIds: ["alpha"],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(result.isError).toBeUndefined();
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.dispatch.spawned).toBe(true);
      expect(details.dispatch.pid).toBeNumber();
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.taskAccepted).toBe(false);
      const artifact = details.artifacts.find((item: any) => item.relativePath === "computed.txt");
      expect(artifact).toBeTruthy();
      const archived = await readFile(path.join(f.root, artifact.archiveRef));
      expect(sha256(archived)).toBe(artifact.sha256);
      expect(archived.toString("utf8")).toBe(`${sha256(f.alphaBytes).slice(7)}\n${f.alphaBytes.toString("utf8")}`);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("Bun reads the same authorized input and writes an independently verified artifact", async () => {
    const f = await fixture();
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "bun",
        source: BUN_INPUT_ARTIFACT,
        inputIds: ["alpha"],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(result.isError).toBeUndefined();
      expect(details.dispatch.exitCode).toBe(0);
      const artifact = details.artifacts.find((item: any) => item.relativePath === "computed.txt");
      expect(artifact).toBeTruthy();
      const archived = await readFile(path.join(f.root, artifact.archiveRef));
      expect(sha256(archived)).toBe(artifact.sha256);
      expect(archived.toString("utf8")).toContain(sha256(f.alphaBytes).slice(7));
      const cpus = details.artifacts.find((item: any) => item.relativePath === "cpus.txt");
      expect(cpus).toBeTruthy();
      expect(Number(await readFile(path.join(f.root, cpus.archiveRef), "utf8"))).toBeGreaterThan(0);
    } finally {
      await f.cleanup();
    }
  }, 20_000);
});

describe("model-visible execution view", () => {
  test("run content alone carries the I/O guide, actual input metadata, a sentinel beyond 500 bytes and returned artifact refs", async () => {
    const f = await fixture();
    try {
      const source = `
import hashlib, json, os
manifest = json.load(open(os.environ["OMP_INPUTS_MANIFEST"], encoding="utf-8"))
source = open(manifest["handles"]["alpha"]["path"], "rb").read()
open("computed.txt", "w", encoding="utf-8").write(hashlib.sha256(source).hexdigest())
print("A" * 600 + "SENTINEL_BEYOND_500")
`;
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source,
        inputIds: ["alpha"],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const content = contentOf(result);
      expect(content).toContain("model-visible execution view g2a3-model-view-v1");
      expect(content).toContain("action=run");
      expect(content).toMatch(/run runId="run-[^"]+" callId="call-[^"]+" taskId="task-[^"]+" taskRevision=1 ownerId="owner-g2a1-unit"/);
      expect(content).toMatch(/runtime name="python" version="\d+\.\d+\.\d+"/);
      expect(content).toMatch(/availableRuntimes: python="\d+\.\d+\.\d+" bun="\d+\.\d+\.\d+"/);
      expect(content).toContain('limits: version="g2a2-v1" maxInputs=8');
      expect(content).toContain(`- id="alpha" bytes=${f.alphaBytes.length} sha256="${sha256(f.alphaBytes)}" writable=false`);
      expect(content).toContain("SENTINEL_BEYOND_500");
      expect(content).toContain("outputPreviewBegin");
      expect(content).toContain("outputPreviewEnd");
      expect(content).toMatch(/output observedBytes=\d+ retainedBytes=\d+ decodedTextBytes=\d+ shownBytes=\d+ omittedBytes=0 truncated=false observedAfterRetentionBytes=0 previewTruncated=false droppedIncompleteBytes=0 invalidEncoding=false/);
      expect(content).toContain("artifacts total=1 shown=1 omitted=0 withheld=false");
      expect(content).toContain('- artifactId="artifact-1" relativePath="computed.txt"');
      expect(content).toMatch(/archiveRef="run-[^"]+\/artifacts\/artifact-1\.bin"/);
      expect(content).toMatch(/sha256="sha256:[0-9a-f]{64}" verified=true/);
      expect(content).toContain("artifactRejections total=0 shown=0 omitted=0 withheld=false");
      expect(content).toContain("attempts limit=8 attempted=1 dispatched=1 reserved=0 remaining=7");
      expect(content).toContain("authority candidateOnly=true taskAccepted=false toolIsError=false");
      expect(content).toContain("note: exit code 0 and exported artifacts are candidate generation only; the task is not accepted.");
      expect(content).toContain("OMP_INPUTS_MANIFEST");
      expect(content).not.toContain(f.fixtures);
      expect(content).not.toContain(f.root);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("run content truncates a preview on a UTF-8 boundary and counts actual emitted bytes", async () => {
    const f = await fixture();
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import sys\nsys.stdout.write(\"€\" * 2000 + \"TAIL_BEYOND_PREVIEW\")\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const content = contentOf(result);
      expect(content).toContain("€");
      expect(content).not.toContain("TAIL_BEYOND_PREVIEW");
      expect(content).not.toContain("\uFFFD");
      expect(content).toMatch(/shownBytes=4095 omittedBytes=\d+ truncated=false/);
      expect(content).toMatch(/omittedBytes=(\d+)/);
      expect(Number(/omittedBytes=(\d+)/.exec(content)?.[1])).toBeGreaterThan(0);
      expect(content).toContain("previewTruncated=true");
      const previewSection = content.split("outputPreviewBegin")[1]!.split("outputPreviewEnd")[0]!;
      const preview = previewSection.slice(previewSection.indexOf("\n") + 1).replace(/\n$/, "");
      expect(Buffer.byteLength(preview, "utf8")).toBe(4095);
      expect(content).not.toContain("\uFFFD");
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("invalid UTF-8 keeps raw capture bytes and computes preview omission in the decoded text domain", async () => {
    const f = await fixture();
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import os\nos.write(1, b'\\xff' * 2000)\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.output.observedBytes).toBe(2000);
      expect(details.output.retainedBytes).toBe(2000);
      expect(details.output.decodedTextBytes).toBe(6000);
      expect(details.output.droppedIncompleteBytes).toBe(0);
      expect(details.output.invalidEncoding).toBe(true);
      expect(details.output.shownBytes).toBe(4095);
      expect(details.output.omittedBytes).toBe(1905);
      expect(details.output.previewTruncated).toBe(true);
      const content = contentOf(result);
      expect(content).toContain("observedBytes=2000 retainedBytes=2000 decodedTextBytes=6000");
      expect(content).toContain("shownBytes=4095 omittedBytes=1905");
      expect(content).toContain("previewTruncated=true droppedIncompleteBytes=0 invalidEncoding=true");
      expect(content).toContain('decodingPolicy="utf8-invalid-to-replacement; incomplete-trailing-capture-dropped"');
      const previewSection = content.split("outputPreviewBegin")[1]!.split("outputPreviewEnd")[0]!;
      const preview = previewSection.slice(previewSection.indexOf("\n") + 1).replace(/\n$/, "");
      expect(Buffer.byteLength(preview, "utf8")).toBe(4095);
      const record = JSON.parse(await readFile(path.join(f.root, String(details.hostRecordRef)), "utf8"));
      expect(record.output.observedBytes).toBe(2000);
      expect(record.output.retainedBytes).toBe(2000);
      expect(record.output.decodedTextBytes).toBe(6000);
      expect(record.output.droppedIncompleteBytes).toBe(0);
      expect(record.output.invalidEncoding).toBe(true);
      expect(Buffer.byteLength(record.output.text, "utf8")).toBe(6000);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("a complete invalid trailing byte is replaced and flagged, not dropped as a cap split", async () => {
    const f = await fixture();
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import os\nos.write(1, b'\\xc0')\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.output.observedBytes).toBe(1);
      expect(details.output.retainedBytes).toBe(1);
      expect(details.output.decodedTextBytes).toBe(3);
      expect(details.output.droppedIncompleteBytes).toBe(0);
      expect(details.output.invalidEncoding).toBe(true);
      expect(details.output.text).toBe("\uFFFD");
      const record = JSON.parse(await readFile(path.join(f.root, String(details.hostRecordRef)), "utf8"));
      expect(record.output.decodedTextBytes).toBe(3);
      expect(record.output.droppedIncompleteBytes).toBe(0);
      expect(record.output.invalidEncoding).toBe(true);
      expect(record.output.text).toBe("\uFFFD");
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("literal U+FFFD in valid UTF-8 is not reported as invalid encoding", async () => {
    const f = await fixture();
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import sys\nsys.stdout.write('\\uFFFD' * 2000)\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.output.decodedTextBytes).toBe(6000);
      expect(details.output.droppedIncompleteBytes).toBe(0);
      expect(details.output.invalidEncoding).toBe(false);
      expect(details.output.shownBytes).toBe(4095);
      expect(details.output.omittedBytes).toBe(1905);
      expect(details.output.previewTruncated).toBe(true);
      const content = contentOf(result);
      expect(content).toContain("decodedTextBytes=6000");
      expect(content).toContain("droppedIncompleteBytes=0 invalidEncoding=false");
      expect(content).toContain("\uFFFD");
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("a multi-byte code point split by the capture cap is counted, not replaced", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import sys\nsys.stdout.write('\\u20ac' * 30000)\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.output.truncated).toBe(true);
      expect(details.output.retainedBytes).toBe(EXECUTION_LIMITS.maxRetainedOutputBytes);
      expect(details.output.droppedIncompleteBytes).toBe(1);
      expect(details.output.decodedTextBytes).toBe(EXECUTION_LIMITS.maxRetainedOutputBytes - 1);
      expect(details.output.invalidEncoding).toBe(false);
      expect(Buffer.byteLength(details.output.text, "utf8")).toBe(4095);
      expect(contentOf(result)).not.toContain("\uFFFD");
      const content = contentOf(result);
      expect(content).toContain(`droppedIncompleteBytes=1 invalidEncoding=false`);
      expect(content).toContain("previewTruncated=true");
      const record = JSON.parse(await readFile(path.join(f.root, String(details.hostRecordRef)), "utf8"));
      expect(record.output.retainedBytes).toBe(EXECUTION_LIMITS.maxRetainedOutputBytes);
      expect(record.output.droppedIncompleteBytes).toBe(1);
      expect(record.output.decodedTextBytes).toBe(EXECUTION_LIMITS.maxRetainedOutputBytes - 1);
      expect(record.output.text).not.toContain("\uFFFD");
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("an invalid partial sequence at the capture cap is replaced, not dropped as valid pending UTF-8", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import os\nos.write(1, b'A' * 65534)\nos.write(1, b'\\xe0\\x80')\nos.write(1, b'TAIL')\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.output.truncated).toBe(true);
      expect(details.output.retainedBytes).toBe(EXECUTION_LIMITS.maxRetainedOutputBytes);
      expect(details.output.droppedIncompleteBytes).toBe(0);
      expect(details.output.decodedTextBytes).toBe(EXECUTION_LIMITS.maxRetainedOutputBytes + 4);
      expect(details.output.invalidEncoding).toBe(true);
      const record = JSON.parse(await readFile(path.join(f.root, String(details.hostRecordRef)), "utf8"));
      expect(record.output.droppedIncompleteBytes).toBe(0);
      expect(record.output.decodedTextBytes).toBe(EXECUTION_LIMITS.maxRetainedOutputBytes + 4);
      expect(record.output.invalidEncoding).toBe(true);
      expect(record.output.text.endsWith("\uFFFD\uFFFD")).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 20_000);
});

describe("admission and concurrency boundaries", () => {
  test("unauthorized input, stale revision and pre-aborted calls never spawn", async () => {
    const f = await fixture();
    try {
      const unauthorized = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('never')",
        inputIds: ["not-authorized"],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      expect(unauthorized.isError).toBe(true);

      const stale = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('never')",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 99,
      });
      expect(stale.isError).toBe(true);

      const controller = new AbortController();
      controller.abort();
      const aborted = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('never')",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      }, controller.signal);
      expect(aborted.isError).toBe(true);
      expect((await f.runDirs())).toEqual([]);
      expect(f.owner.snapshot().currentTask?.admissions).toBe(0);
      expect(f.owner.snapshot().currentTask?.taskRevision).toBe(1);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("initial symlink and multilink inputs are rejected before any spawn", async () => {
    const f = await fixture({ badInputs: true });
    try {
      for (const inputId of ["symlink", "hardlink"]) {
        const result = await f.adapter.run(f.ctx, {
          action: "run",
          runtime: "python",
          source: "print('never')",
          inputIds: [inputId],
          expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
        });
        expect(result.isError).toBe(true);
        expect(String(detailsOf(result).error)).toMatch(/symbolic link|hard links/);
      }
      expect(await f.runDirs()).toEqual([]);
      expect((await readFile(f.alphaPath)).toString("base64")).toBe(f.alphaBytes.toString("base64"));
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("dispose from the prepared-record host callback prevents spawn and records not_dispatched", async () => {
    let adapter: ExecutionAdapter | undefined;
    const f = await fixture({
      recordWriter: (filePath, value) => {
        writeFileSync(filePath, JSON.stringify(value));
        if ((value as { phase?: unknown }).phase === "prepared") adapter?.dispose();
      },
    });
    adapter = f.adapter;
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "open('did-run.txt', 'w').write('side effect')\nprint('must not run')\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      expect(result.isError).toBe(true);
      expect(detailsOf(result).dispatch).toBeUndefined();
      const dirs = await f.runDirs();
      expect(dirs.length).toBe(1);
      const record = JSON.parse(await readFile(path.join(f.root, dirs[0]!, "record.json"), "utf8"));
      expect(record.phase).toBe("not_dispatched");
      expect(record.process).toBeNull();
      expect(record.dispatch).toMatchObject({ spawned: false, pid: null, reason: "not_dispatched" });
      expect(String(record.notDispatchedReason)).toContain("disposed");
      expect(await readdir(path.join(f.root, dirs[0]!, "work"))).toEqual(["tmp"]);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("two concurrent calls yield one busy rejection, one actual spawn and no double budget", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const source = "import time\ntime.sleep(0.4)\nprint('slow done')\n";
      const args = {
        action: "run" as const,
        runtime: "python" as const,
        source,
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      };
      const first = f.adapter.run(f.ctx, args);
      const second = f.adapter.run(f.ctx, args);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(secondResult.isError).toBe(true);
      expect(String(detailsOf(secondResult).error)).toContain("already active");
      const details = detailsOf(firstResult);
      expect(details.dispatch.spawned).toBe(true);
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.attemptBudget).toMatchObject({ attempted: 1, dispatched: 1, reserved: 0 });
      expect(f.owner.snapshot().currentTask?.admissions).toBe(1);
      expect((await f.runDirs()).length).toBe(1);
      const describe = detailsOf(await f.adapter.describe(f.ctx));
      expect(describe.dispatchBudget).toMatchObject({ attempted: 1, dispatched: 1 });
    } finally {
      await f.cleanup();
    }
  }, 20_000);
});

describe("actual OS sandbox controls", () => {
  test("outside read/write, network, fork, hardlink and external signal are denied; own output works", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "omp-agent-g2a1-outside-"));
    const outsideFile = path.join(outsideDir, "outside.txt");
    await writeFile(outsideFile, "outside artificial content\n");
    const dummy = spawn(PYTHON, ["-I", "-B", "-c", "import time\ntime.sleep(20)", "SYNTHETIC_ARGV_MARKER"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, OMP_SYSCTL_DUMMY_ENV: "SYNTHETIC_ENV_MARKER" },
    });
    let accepted = 0;
    const server = createServer((socket) => {
      accepted += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const metaPath = path.join(outsideDir, "meta.json");
    await writeFile(metaPath, JSON.stringify({
      outside: outsideFile,
      port,
      dummyPid: dummy.pid,
    }));
    await Bun.sleep(150);
    const f = await fixture({ extraInputs: [{ id: "meta", path: metaPath }] });
    const previousSecret = process.env.OMP_TEST_SECRET;
    process.env.OMP_TEST_SECRET = "ARTIFICIAL_SECRET_MUST_NOT_LEAK";
    try {
      const source = `
import json, os, socket, threading
${SYSCTL_PROBE}
manifest = json.load(open(os.environ["OMP_INPUTS_MANIFEST"], encoding="utf-8"))
meta = json.load(open(manifest["handles"]["meta"]["path"], encoding="utf-8"))
report = {}
report["sysctl_external"] = {
    str(selector): sysctl_query(int(meta["dummyPid"]), selector) for selector in (38, 49)
}
report["sysctl_self"] = {
    str(selector): sysctl_query(os.getpid(), selector) for selector in (38, 49)
}
try:
    open(meta["outside"], "rb").read()
    report["outside_read"] = "allowed"
except OSError as error:
    report["outside_read"] = error.errno
try:
    with open(meta["outside"], "wb") as handle:
        handle.write(b"attack")
    report["outside_write"] = "allowed"
except OSError as error:
    report["outside_write"] = error.errno
try:
    socket.create_connection(("127.0.0.1", meta["port"]), 0.3)
    report["network"] = "allowed"
except OSError as error:
    report["network"] = error.errno
try:
    os.fork()
    report["fork"] = "allowed"
except OSError as error:
    report["fork"] = error.errno
try:
    os.posix_spawn("/bin/echo", ["echo", "x"], {})
    report["posix_spawn"] = "allowed"
except OSError as error:
    report["posix_spawn"] = error.errno
try:
    import subprocess
    subprocess.Popen(["/bin/echo", "x"], start_new_session=True)
    report["detached_spawn"] = "allowed"
except OSError as error:
    report["detached_spawn"] = error.errno
try:
    os.link("own.txt", "link.txt")
    report["hardlink"] = "allowed"
except OSError as error:
    report["hardlink"] = error.errno
try:
    os.kill(meta["dummyPid"], 30)
    report["signal"] = "allowed"
except OSError as error:
    report["signal"] = error.errno
try:
    os.fstat(6000)
    report["fd6000"] = "open"
except OSError as error:
    report["fd6000"] = error.errno
report["secret"] = os.environ.get("OMP_TEST_SECRET", "<absent>")
thread_totals = []
def worker():
    thread_totals.append(sum(range(1000)))
workers = [threading.Thread(target=worker) for _ in range(8)]
for worker_thread in workers:
    worker_thread.start()
for worker_thread in workers:
    worker_thread.join()
report["threads"] = sum(thread_totals)
with open(os.path.join(os.environ["OMP_WORK_DIR"], "report.json"), "w", encoding="utf-8") as handle:
    json.dump(report, handle)
with open("own.txt", "w", encoding="utf-8") as handle:
    handle.write("own output works")
`;
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source,
        inputIds: ["meta"],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      const artifact = details.artifacts.find((item: any) => item.relativePath === "report.json");
      expect(artifact).toBeTruthy();
      const report = JSON.parse(await readFile(path.join(f.root, artifact.archiveRef), "utf8"));
      expect(report.outside_read).not.toBe("allowed");
      expect(report.outside_write).not.toBe("allowed");
      expect(report.network).not.toBe("allowed");
      expect(report.fork).not.toBe("allowed");
      expect(report.posix_spawn).not.toBe("allowed");
      expect(report.detached_spawn).not.toBe("allowed");
      expect(report.hardlink).not.toBe("allowed");
      expect(report.signal).not.toBe("allowed");
      expect(() => process.kill(dummy.pid!, 0)).not.toThrow();
      expect(report.fd6000).not.toBe("open");
      expect(report.secret).toBe("<absent>");
      expect(report.threads).toBe(8 * 499500);
      for (const selector of ["38", "49"]) {
        const external = report.sysctl_external[selector];
        expect(external.rc).toBe(-1);
        expect(external.errno).toBe(1);
        expect(external.argvMarker).toBeUndefined();
        expect(external.envMarker).toBeUndefined();
        // The runtime's own process-info exception remains available.
        expect(report.sysctl_self[selector].rc).toBe(0);
      }
      // Unsandboxed positive control against the same artificial dummy proves
      // the syscall is functional on this host, not merely denied by a broken
      // probe. Only the known dummy PID and synthetic markers are touched.
      const positive = spawnSync(PYTHON, [
        "-I", "-B", "-c",
        `${SYSCTL_PROBE}\nimport json, sys\nprint(json.dumps({str(selector): sysctl_query(int(sys.argv[1]), selector) for selector in (38, 49)}))`,
        String(dummy.pid),
      ], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 });
      expect(positive.status, positive.stderr).toBe(0);
      const positiveReport = JSON.parse(positive.stdout);
      for (const selector of ["38", "49"]) {
        expect(positiveReport[selector].rc).toBe(0);
        expect(positiveReport[selector].argvMarker).toBe(true);
        expect(positiveReport[selector].envMarker).toBe(true);
      }
      expect(accepted).toBe(0);
      const own = details.artifacts.find((item: any) => item.relativePath === "own.txt");
      expect(own).toBeTruthy();
      expect(await readFile(path.join(f.root, own.archiveRef), "utf8")).toBe("own output works");
      expect(await readFile(outsideFile, "utf8")).toBe("outside artificial content\n");
    } finally {
      if (previousSecret === undefined) delete process.env.OMP_TEST_SECRET;
      else process.env.OMP_TEST_SECRET = previousSecret;
      server.close();
      if (dummy.pid) {
        try { process.kill(-dummy.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await f.cleanup();
      await rm(outsideDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("limits, cancellation and evidence", () => {
  test("timeout kills an ignore-SIGTERM process group and reports the reason honestly", async () => {
    const f = await fixture({ dispatchWallMs: 300, terminationGraceMs: 100 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import signal, time\nsignal.signal(signal.SIGTERM, lambda *args: None)\ntime.sleep(20)\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(result.isError).toBe(true);
      expect(details.dispatch.reason).toBe("timeout");
      expect(details.dispatch.terminatedByHost).toBe(true);
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.dispatch.durationMs).toBeLessThan(5000);
      expect(() => process.kill(details.dispatch.pid, 0)).toThrow();
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("output flood is bounded, explicitly truncated and terminates the process", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import os, time\nos.write(1, b'x' * 200000)\ntime.sleep(5)\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.output.truncated).toBe(true);
      expect(details.output.retainedBytes).toBe(EXECUTION_LIMITS.maxRetainedOutputBytes);
      expect(details.output.observedBytes).toBeGreaterThan(EXECUTION_LIMITS.maxRetainedOutputBytes);
      expect(details.dispatch.reason).toBe("output_limit");
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.output.text.length).toBeLessThanOrEqual(4096);
      expect(details.output.omittedFromResponseBytes).toBeGreaterThan(0);
      const content = contentOf(result);
      expect(content).toMatch(/shownBytes=\d+ omittedBytes=\d+ truncated=true/);
      expect(content).toContain("previewTruncated=true");
      expect(content).toContain("outputPreviewBegin");
      expect(content).not.toContain("x".repeat(EXECUTION_LIMITS.maxRetainedOutputBytes));
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("RLIMIT_FSIZE soft and hard both cap writes at 256 KiB", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: `
import json, resource
report = {}
try:
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
    report["raised"] = "allowed"
except (OSError, ValueError) as error:
    report["raised"] = getattr(error, "errno", None)
soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
report["soft"] = soft
report["hard"] = hard
try:
    with open("big.bin", "wb") as handle:
        handle.write(b"x" * (300 * 1024))
    report["write"] = "allowed"
except OSError as error:
    report["write"] = error.errno
with open("fsize.json", "w", encoding="utf-8") as handle:
    json.dump(report, handle)
`,
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.dispatch.exitCode).toBe(0);
      const artifact = details.artifacts.find((item: any) => item.relativePath === "fsize.json");
      expect(artifact).toBeTruthy();
      const report = JSON.parse(await readFile(path.join(f.root, artifact.archiveRef), "utf8"));
      expect(report.raised).not.toBe("allowed");
      expect(report.soft).toBe(EXECUTION_LIMITS.maxFileSizeBytes);
      expect(report.hard).toBe(EXECUTION_LIMITS.maxFileSizeBytes);
      expect(report.write).toBe(27);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("untrusted exit code 111 is reported as an uncertain launch stage, not as proof no code ran", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "open('marker.txt', 'w', encoding='utf-8').write('untrusted-code-ran')\nimport sys\nsys.exit(111)\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.dispatch.exitCode).toBe(111);
      expect(details.dispatch.launchStage).toBe("unknown");
      expect(details.dispatch.launchStageNote).toContain("not proof");
      expect(result.isError).toBe(true);
      const marker = details.artifacts.find((item: any) => item.relativePath === "marker.txt");
      expect(marker).toBeTruthy();
      expect(await readFile(path.join(f.root, marker.archiveRef), "utf8")).toBe("untrusted-code-ran");
      expect(String(details.error ?? "")).not.toContain("no process was started");
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("a host record failure after spawn still terminates the owned process and keeps actual facts", async () => {
    let writes = 0;
    const f = await fixture({
      dispatchWallMs: 5000,
      terminationGraceMs: 100,
      recordWriter: (filePath, value) => {
        writes += 1;
        if (writes >= 2) throw new Error("injected record fault");
        writeFileSync(filePath, JSON.stringify(value));
      },
    });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import time\ntime.sleep(10)\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(result.isError).toBe(true);
      expect(details.dispatch.spawned).toBe(true);
      expect(details.dispatch.pid).toBeNumber();
      expect(details.dispatch.reason).toBe("host_record_failure");
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(String(details.hostRecordErrors.afterSpawn)).toContain("injected record fault");
      expect(String(details.hostRecordErrors.finalRecord)).toContain("injected record fault");
      expect(writes).toBe(3);
      expect(() => process.kill(details.dispatch.pid, 0)).toThrow();
      const content = contentOf(result);
      expect(content).toContain('stopReason="host_record_failure"');
      expect(content).toContain('afterSpawn="host record write failed after spawn: injected record fault"');
      expect(content).toContain('finalRecord="final host record write failed: injected record fault"');
      expect(content).toContain("toolIsError=true");
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("a final host record failure preserves executed facts and both cleanups", async () => {
    let writes = 0;
    const f = await fixture({
      dispatchWallMs: 5000,
      terminationGraceMs: 100,
      recordWriter: (filePath, value) => {
        writes += 1;
        if (writes >= 3) throw new Error("injected final record fault");
        writeFileSync(filePath, JSON.stringify(value));
      },
    });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "open('done.txt', 'w').write('actual execution')\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(result.isError).toBe(true);
      expect(writes).toBe(3);
      expect(details.dispatch.spawned).toBe(true);
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.watchdog.armed).toBe(true);
      expect(details.watchdog.watchdogTerminated).toBe(true);
      expect(String(details.hostRecordErrors.finalRecord)).toContain("injected final record fault");
      expect(details.artifacts.some((item: any) => item.relativePath === "done.txt")).toBe(true);
      expect(() => process.kill(details.dispatch.pid, 0)).toThrow();
      expect(() => process.kill(details.watchdog.watchdogPid, 0)).toThrow();
      const content = contentOf(result);
      expect(content).toContain('finalRecord="final host record write failed: injected final record fault"');
      expect(content).toContain('artifactRejections total=0 shown=0 omitted=0 withheld=false');
      expect(content).toContain('relativePath="done.txt"');
      expect(content).toContain("archiveRef=");
      expect(content).toContain("toolIsError=true");
      expect(content).toContain("taskAccepted=false");
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("artifact total byte cap rejects the next oversize file without reading it", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: `
for index in range(8):
    with open("big%d.bin" % index, "wb") as handle:
        handle.write(b"x" * 150000)
`,
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.artifactLimitReached).toBe(true);
      expect(details.artifacts.length).toBe(6);
      expect(details.artifactTotalBytes).toBeLessThanOrEqual(EXECUTION_LIMITS.maxArtifactTotalBytes);
      expect(details.artifactRejections.some((item: any) => item.reason.includes("total byte limit"))).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("artifact export is bounded to top-level ordinary files and rejects directories and FIFOs", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: `
import os
for index in range(10):
    with open("f%d.txt" % index, "w", encoding="utf-8") as handle:
        handle.write(str(index))
os.mkdir("subdir")
with open("subdir/nested.txt", "w", encoding="utf-8") as handle:
    handle.write("nested")
os.mkfifo("pipe")
try:
    os.symlink("/etc/passwd", "link.txt")
except OSError:
    pass
`,
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.artifacts.length).toBe(EXECUTION_LIMITS.maxArtifacts);
      expect(details.artifactRejections.some((item: any) => item.reason.includes("subdirectories"))).toBe(true);
      expect(details.artifactRejections.some((item: any) => item.reason.includes("FIFO"))).toBe(true);
      expect(details.artifactRejections.some((item: any) => item.reason.includes("hard links") || item.reason.includes("symbolic link"))).toBe(true);
      expect(details.artifactRejections.some((item: any) => item.reason.includes("artifact count"))).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("escaped adversarial artifact names trim only the response window and stay full in the host record", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const source = `
for index in range(260):
    with open(chr(1) * 200 + str(index) + ".txt", "w", encoding="utf-8") as handle:
        handle.write("x")
print("completed candidate artifacts")
`;
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source,
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(EXECUTION_LIMITS.maxToolResponseBytes);
      const content = contentOf(result);
      expect(content).toContain("artifacts total=8 shown=8 omitted=0 withheld=false");
      expect(content).toMatch(/artifactRejections total=248 shown=8 omitted=240 withheld=false/);
      expect(content).toContain("\\u0001\\u0001\\u0001");
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(EXECUTION_LIMITS.maxToolResponseBytes);
      expect(details.runId).toBeString();
      expect(details.dispatch.spawned).toBe(true);
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.taskAccepted).toBe(false);
      expect(details.hostRecordRef).toBeString();
      expect(details.artifactRejectionsShown).toBe(8);
      expect(details.artifactRejections.length).toBe(8);
      expect(details.artifactRejectionsOmitted).toBeGreaterThan(200);
      expect(details.artifactRejectionsRecordRef).toBe(details.hostRecordRef);
      expect(details.artifactRejections.every((item: any) => item.relativePath.startsWith("\u0001".repeat(200)))).toBe(true);
      expect(details.output.shownBytes).toBe(Buffer.byteLength(details.output.text, "utf8"));
      expect(details.output.omittedBytes).toBe(Math.max(0, details.output.decodedTextBytes - details.output.shownBytes));

      const record = JSON.parse(await readFile(path.join(f.root, String(details.hostRecordRef)), "utf8"));
      expect(record.phase).toBe("completed");
      expect(record.output.decodedTextBytes).toBe(Buffer.byteLength(record.output.text, "utf8"));
      expect(record.output.invalidEncoding).toBe(false);
      expect(record.artifactRejections.length).toBe(248);
      expect(details.artifactRejectionsShown + details.artifactRejectionsOmitted).toBe(record.artifactRejections.length);
      const rejected = record.artifactRejections.find((item: any) => item.reason === "artifact count limit");
      expect(rejected).toBeTruthy();
      expect(rejected.relativePath.startsWith("\u0001".repeat(200))).toBe(true);
      expect(rejected.relativePath.endsWith(".txt")).toBe(true);
      expect(record.artifacts.length).toBe(EXECUTION_LIMITS.maxArtifacts);
      expect(record.artifacts.every((item: any) => item.relativePath.startsWith("\u0001".repeat(200)))).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 20_000);
});

describe("owner authority changes during a run", () => {
  test("task-specific owner events route by taskId; a stale A cancel does not stop B", async () => {
    const f = await fixture();
    try {
      const adapter = f.adapter as unknown as {
        active: { taskId: string; runId: string; taskRevision: number; stop(reason: string): void } | null;
        ownerEvent(event: { type: string; ownerId: string; taskId: string }): void;
      };
      let stopped: string | null = null;
      adapter.active = {
        taskId: "task-b",
        runId: "run-b",
        taskRevision: 1,
        stop(reason: string) {
          stopped = reason;
        },
      };
      adapter.ownerEvent({ type: "task_cancelled", ownerId: "owner-fixture", taskId: "task-a" });
      expect(stopped).toBeNull();
      adapter.ownerEvent({ type: "task_revised", ownerId: "owner-fixture", taskId: "task-a" });
      expect(stopped).toBeNull();
      adapter.ownerEvent({ type: "task_cancelled", ownerId: "owner-fixture", taskId: "task-b" });
      expect(stopped as string | null).toBe("owner_cancelled");
      adapter.active = null;
    } finally {
      await f.cleanup();
    }
  });

  const LONG = "import time\ntime.sleep(0.6)\nopen('late.txt','w').write('late output')\n";

  test("a genuine cancel stops the running child and keeps the result at revision 1 with no restored authority", async () => {
    // Real adapter/launcher execution with an artificial OMP context; this is
    // not actual OMP TUI evidence.
    const f = await fixture({ dispatchWallMs: 5000, terminationGraceMs: 100 });
    try {
      const original = f.owner.snapshot().currentTask!;
      const originalDigest = requirementsDigest(original.requirementSources);
      const running = f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: LONG,
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      await Bun.sleep(150);
      f.owner.cancel(subject(f.branch), guard(f.owner));
      const result = await running;
      const details = detailsOf(result);
      expect(details.taskRevision).toBe(1);
      expect(details.dispatch.reason).toBe("owner_cancelled");
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      const snapshot = f.adapter.runReferenceSnapshot();
      expect(snapshot.references).toHaveLength(1);
      const reference = snapshot.references[0]!;
      expect(reference).toMatchObject({
        taskId: original.taskId,
        taskRevision: 1,
        requirementsDigest: originalDigest,
        recordWriteReturned: true,
        byteIntegrity: "not_checked",
        authorityRestored: false,
      });
      const record = JSON.parse(await readFile(
        path.join(f.root, reference.runDirectory, "record.json"),
        "utf8",
      ));
      expect(record.taskId).toBe(original.taskId);
      expect(record.taskRevision).toBe(1);
      expect(record.requirementsDigest).toBe(originalDigest);
      expect(reference.artifactIds).toEqual(record.artifacts.map((artifact: any) => artifact.artifactId));
      expect(f.owner.snapshot().currentTask?.status).toBe("cancelled");
      const admissions = f.owner.snapshot().currentTask?.admissions;
      const after = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('no')",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      expect(after.isError).toBe(true);
      expect(f.owner.snapshot().currentTask?.admissions).toBe(admissions);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("a genuine revision conservatively stops the old run and withholds its output", async () => {
    // Real adapter/launcher execution with an artificial OMP context; this is
    // not actual OMP TUI evidence.
    const f = await fixture({ dispatchWallMs: 5000, terminationGraceMs: 100 });
    try {
      const original = f.owner.snapshot().currentTask!;
      const originalDigest = requirementsDigest(original.requirementSources);
      const running = f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: LONG,
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      await Bun.sleep(150);
      f.owner.sessionChanged();
      const amended = "Amend the requirements with a second genuine turn.";
      expect(f.owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: WORKSPACE,
        source: "rpc",
        text: amended,
        observedAt: NOW,
        baseLeafId: "user-1",
      }).accepted).toBe(true);
      f.owner.observeAgentStart({ sessionId: SESSION, prompt: amended, reason: "prompt" });
      const branch2 = [...f.branch, user("user-2", "user-1", amended)];
      expect(f.owner.revise(subject(branch2), guard(f.owner), "amended understanding").revised).toBe(true);
      const result = await running;
      const details = detailsOf(result);
      expect(details.taskRevision).toBe(1);
      expect(details.dispatch.reason).toBe("task_revised");
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.artifactsWithheld).toBe(true);
      expect(details.artifacts).toEqual([]);
      const content = contentOf(result);
      expect(content).toContain("visible=false");
      expect(content).toContain("outputPreviewWithheld=true");
      expect(content).toMatch(/artifacts total=\d+ shown=0 omitted=\d+ withheld=true/);
      expect(content).toMatch(/artifactRejections total=\d+ shown=0 omitted=\d+ withheld=true/);
      expect(content).not.toContain("late.txt");
      expect(content).not.toContain("late output");
      expect(content).toContain("taskAccepted=false");
      expect(f.owner.snapshot().currentTask?.taskRevision).toBe(2);
      const snapshot = f.adapter.runReferenceSnapshot();
      expect(snapshot.references).toHaveLength(1);
      const reference = snapshot.references[0]!;
      expect(reference).toMatchObject({
        taskId: original.taskId,
        taskRevision: 1,
        requirementsDigest: originalDigest,
        recordWriteReturned: true,
        byteIntegrity: "not_checked",
        authorityRestored: false,
      });
      const record = JSON.parse(await readFile(
        path.join(f.root, reference.runDirectory, "record.json"),
        "utf8",
      ));
      expect(record.taskId).toBe(original.taskId);
      expect(record.taskRevision).toBe(1);
      expect(record.requirementsDigest).toBe(originalDigest);
      expect(reference.artifactIds).toEqual(record.artifacts.map((artifact: any) => artifact.artifactId));
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("navigation detach stops the child and withholds output", async () => {
    const f = await fixture({ dispatchWallMs: 5000, terminationGraceMs: 100 });
    try {
      const running = f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: LONG,
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      await Bun.sleep(150);
      f.owner.navigate("session_switch", SESSION);
      const result = await running;
      const details = detailsOf(result);
      expect(details.dispatch.reason).toBe("binding_detached");
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.bindingAfter.state).toBe("detached");
      expect(details.artifactsWithheld).toBe(true);
      expect(details.withheldReason).toContain("host record");
      const content = contentOf(result);
      expect(content).toContain('bindingAfter="detached"');
      expect(content).toContain("visible=false");
      expect(content).toContain("outputPreviewWithheld=true");
      expect(content).not.toContain("late.txt");
      expect(content).not.toContain("late output");
    } finally {
      await f.cleanup();
    }
  }, 20_000);
  test("a final record callback that detaches the live binding conceals output and artifact paths while the raw record survives", async () => {
    let writes = 0;
    let f: Fixture;
    f = await fixture({
      dispatchWallMs: 5000,
      recordWriter: (filePath, value) => {
        writes += 1;
        writeFileSync(filePath, JSON.stringify(value));
        if (writes === 3) f.owner.navigate("session_tree", SESSION);
      },
    });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('visible-before-detach')\nopen('secret.txt', 'w', encoding='utf-8').write('secret-output')\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      expect(writes).toBe(3);
      const content = contentOf(result);
      expect(content).toContain('bindingAfter="detached"');
      expect(content).toContain("visible=false");
      expect(content).toContain("outputPreviewWithheld=true");
      expect(content).toMatch(/artifacts total=1 shown=0 omitted=1 withheld=true/);
      expect(content).not.toContain("visible-before-detach");
      expect(content).not.toContain("secret.txt");
      expect(content).not.toContain("secret-output");
      const recordPath = path.join(f.root, (await f.runDirs())[0]!, "record.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      expect(record.output.text).toContain("visible-before-detach");
      expect(record.artifacts.some((item: any) => item.relativePath === "secret.txt")).toBe(true);
      expect(record.artifactRejections).toEqual([]);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("an execution_completed audit callback that detaches conceals output and artifact paths after the final check", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    const auditSeam = f.adapter as unknown as { audit: (event: Record<string, unknown>) => void };
    const originalAudit = auditSeam.audit;
    let detachedInAudit = false;
    auditSeam.audit = (event) => {
      originalAudit(event);
      if (event.type === "execution_completed") {
        detachedInAudit = true;
        f.owner.navigate("session_tree", SESSION);
      }
    };
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import os\nprint('AUDIT_PRIVATE_STDOUT')\nopen('audit-private-artifact.txt', 'w', encoding='utf-8').write('ok')\nos.mkdir('audit-private-rejection')\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      expect(detachedInAudit).toBe(true);
      expect(f.owner.bindingStatus().state).toBe("detached");
      const details = detailsOf(result);
      expect(details.bindingAfter.state).toBe("detached");
      expect(details.visible).toBe(false);
      expect(details.output.text).toBe("");
      expect(details.artifacts).toEqual([]);
      expect(details.artifactRejections).toEqual([]);
      expect(details.artifactsWithheld).toBe(true);
      expect(details.artifactRejectionsWithheld).toBe(true);
      const content = contentOf(result);
      expect(content).toContain('bindingAfter="detached"');
      expect(content).toContain("visible=false");
      expect(content).toContain("outputPreviewWithheld=true");
      expect(content).toMatch(/artifacts total=1 shown=0 omitted=1 withheld=true/);
      expect(content).toMatch(/artifactRejections total=1 shown=0 omitted=1 withheld=true/);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("AUDIT_PRIVATE_STDOUT");
      expect(serialized).not.toContain("audit-private-artifact.txt");
      expect(serialized).not.toContain("audit-private-rejection");
      const recordPath = path.join(f.root, (await f.runDirs())[0]!, "record.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      expect(record.output.text).toContain("AUDIT_PRIVATE_STDOUT");
      expect(record.artifacts.some((item: any) => item.relativePath === "audit-private-artifact.txt")).toBe(true);
      expect(record.artifactRejections.some((item: any) => item.relativePath === "audit-private-rejection")).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 20_000);
});

describe("trusted launcher descriptor boundary", () => {
  test("an inherited descriptor 6000 does not survive into the sandbox", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2a1-fd-")));
    try {
      const sourceRoot = path.join(root, "source");
      const inputRoot = path.join(root, "inputs");
      const workRoot = path.join(root, "work");
      await mkdir(sourceRoot);
      await mkdir(inputRoot);
      await mkdir(workRoot);
      const script = path.join(sourceRoot, "script.py");
      await writeFile(script, `
import json, os
report = {}
try:
    os.fstat(6000)
    report["fd6000"] = "open"
except OSError as error:
    report["fd6000"] = error.errno
with open(os.path.join(os.environ["OMP_WORK_DIR"], "fd-report.json"), "w", encoding="utf-8") as handle:
    json.dump(report, handle)
`);
      const interpreter = await realpath(PYTHON);
      const profile = path.join(root, "profile.sb");
      const watchdogLog = path.join(root, "watchdog.jsonl");
      await writeFile(profile, sandboxProfile({ interpreterPath: interpreter, sourceRoot, inputRoot, workRoot }));
      const parentCode = `
import os, sys
os.dup2(0, 6000)
os.set_inheritable(6000, True)
os.execv(sys.executable, [
    sys.executable, "-I", "-B", sys.argv[1],
    "--profile", sys.argv[2], "--fsize", "262144",
    "--supervisor-pid", sys.argv[3], "--deadline-ms", "5000", "--grace-ms", "250",
    "--control-fd", "3", "--ack-fd", "4",
    "--watchdog-log", sys.argv[4], "--config-token", "fd-test-token", "--runtime", "python",
    "--", sys.argv[5], sys.argv[6],
])
`;
      const child = spawn(PYTHON, [
        "-I", "-B", "-c", parentCode, LAUNCHER, profile, String(process.pid), watchdogLog, interpreter, script,
      ], {
        detached: true,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          OMP_WORK_DIR: workRoot,
          OMP_INPUTS_MANIFEST: path.join(inputRoot, "manifest.json"),
        },
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      });
      const control = child.stdio[3] as any;
      const acknowledgement = child.stdio[4] as any;
      let controlBuffer = "";
      let acknowledged = false;
      const armed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("launcher did not arm")), 5000);
        control.on("data", (bytes: Buffer) => {
          controlBuffer += bytes.toString("utf8");
          while (controlBuffer.includes("\n")) {
            const index = controlBuffer.indexOf("\n");
            const line = controlBuffer.slice(0, index);
            controlBuffer = controlBuffer.slice(index + 1);
            if (!line) continue;
            const message = JSON.parse(line);
            if (message.type === "armed" && !acknowledged) {
              acknowledged = true;
              expect(message.scriptPid).toBe(child.pid);
              acknowledgement.write(`${JSON.stringify({
                type: "ack",
                protocol: "g2a2-watchdog-v1",
                configToken: "fd-test-token",
                scriptPid: child.pid,
                supervisorPid: process.pid,
              })}\n`);
              acknowledgement.end();
              clearTimeout(timer);
              resolve();
            }
          }
        });
      });
      await armed;
      const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(exitCode).toBe(0);
      const report = JSON.parse(await readFile(path.join(workRoot, "fd-report.json"), "utf8"));
      expect(report.fd6000).not.toBe("open");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  async function directLauncher(options: {
    source: string;
    runtime: "python" | "bun";
    deadlineMs: number;
    logPath: string;
    configToken: string;
    ack: boolean;
    beforeAck?: (workRoot: string, armed: Record<string, any>) => void | Promise<void>;
  }): Promise<{
    root: string;
    child: ReturnType<typeof spawn>;
    workRoot: string;
    control: any;
    acknowledgement: any;
    armed: Promise<Record<string, any>>;
  }> {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2a2-direct-")));
    const sourceRoot = path.join(root, "source");
    const inputRoot = path.join(root, "inputs");
    const workRoot = path.join(root, "work");
    await mkdir(sourceRoot);
    await mkdir(inputRoot);
    await mkdir(workRoot);
    const extension = options.runtime === "python" ? "py" : "ts";
    const script = path.join(sourceRoot, `script.${extension}`);
    await writeFile(script, options.source);
    const interpreter = await realpath(options.runtime === "python" ? PYTHON : BUN);
    const profile = path.join(root, "profile.sb");
    await writeFile(profile, sandboxProfile({ interpreterPath: interpreter, sourceRoot, inputRoot, workRoot }));
    const child = spawn(PYTHON, [
      "-I", "-B", LAUNCHER,
      "--profile", profile, "--fsize", "262144",
      "--supervisor-pid", String(process.pid),
      "--deadline-ms", String(options.deadlineMs),
      "--grace-ms", "100",
      "--control-fd", "3", "--ack-fd", "4",
      "--watchdog-log", options.logPath,
      "--config-token", options.configToken,
      "--runtime", options.runtime,
      "--", interpreter,
      ...(options.runtime === "python" ? ["-I", "-B", script] : ["--no-env-file", script]),
    ], {
      cwd: workRoot,
      detached: true,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        OMP_WORK_DIR: workRoot,
        OMP_INPUTS_MANIFEST: path.join(inputRoot, "manifest.json"),
      },
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });
    const control = child.stdio[3] as any;
    const acknowledgement = child.stdio[4] as any;
    const armed = new Promise<Record<string, any>>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("launcher did not arm")), 5000);
      control.on("data", async (bytes: Buffer) => {
        buffer += bytes.toString("utf8");
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.type === "armed") {
            clearTimeout(timer);
            await options.beforeAck?.(workRoot, message);
            if (options.ack) {
              acknowledgement.write(`${JSON.stringify({
                type: "ack",
                protocol: "g2a2-watchdog-v1",
                configToken: options.configToken,
                scriptPid: child.pid,
                supervisorPid: process.pid,
              })}\n`);
              acknowledgement.end();
            }
            resolve(message);
          }
        }
      });
    });
    return { root, child, workRoot, control, acknowledgement, armed };
  }

  test("missing supervisor acknowledgement executes no untrusted code", async () => {
    const logPath = path.join(await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2a2-nack-log-"))), "watchdog.jsonl");
    const probe = await directLauncher({
      source: "open('did-run.txt', 'w').write('must not run')\n",
      runtime: "python",
      deadlineMs: 5000,
      logPath,
      configToken: "missing-ack",
      ack: false,
    });
    try {
      const armed = await probe.armed;
      expect(armed.armed).toBe(true);
      probe.acknowledgement.destroy();
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        probe.child.on("close", (code, signal) => resolve({ code, signal }));
      });
      expect(result.code === 111 || result.signal !== null).toBe(true);
      expect(await Bun.file(path.join(probe.workRoot, "did-run.txt")).exists()).toBe(false);
    } finally {
      try { process.kill(-probe.child.pid!, "SIGKILL"); } catch { /* gone */ }
      await rm(path.dirname(logPath), { recursive: true, force: true });
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 20_000);

  test("Python and Bun cannot signal the watchdog, write its control fd, or lose normal computation", async () => {
    const pythonSource = `
import json, os, signal
watchdog = int(open("watchdog.pid", encoding="utf-8").read())
report = {}
for name, number in (("zero", 0), ("term", signal.SIGTERM)):
    try:
        os.kill(watchdog, number)
        report[name] = "allowed"
    except OSError as error:
        report[name] = error.errno
try:
    os.write(3, b"forged")
    report["fd3"] = "allowed"
except OSError as error:
    report["fd3"] = error.errno
report["computed"] = sum(range(10000))
with open("report.json", "w", encoding="utf-8") as handle:
    json.dump(report, handle)
`;
    const bunSource = `
import { readFileSync, writeFileSync, writeSync } from "node:fs";
const watchdog = Number(readFileSync("watchdog.pid", "utf8"));
const report = {};
for (const [name, signal] of [["zero", 0], ["term", "SIGTERM"]]) {
  try {
    process.kill(watchdog, signal);
    report[name] = "allowed";
  } catch (error) {
    report[name] = error.code;
  }
}
try {
  writeSync(3, Buffer.from("forged"));
  report.fd3 = "allowed";
} catch (error) {
  report.fd3 = error.code;
}
let computed = 0;
for (let value = 0; value < 10000; value += 1) computed += value;
report.computed = computed;
writeFileSync("report.json", JSON.stringify(report));
`;
    for (const runtime of ["python", "bun"] as const) {
      const evidenceRoot = await realpath(await mkdtemp(path.join(tmpdir(), `omp-agent-g2a2-signal-${runtime}-`)));
      const logPath = path.join(evidenceRoot, "watchdog.jsonl");
      const probe = await directLauncher({
        source: runtime === "python" ? pythonSource : bunSource,
        runtime,
        deadlineMs: 5000,
        logPath,
        configToken: `signal-${runtime}`,
        ack: true,
        beforeAck: async (workRoot, armed) => {
          await writeFile(path.join(workRoot, "watchdog.pid"), String(armed.watchdogPid));
        },
      });
      try {
        await probe.armed;
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          probe.child.on("close", (code, signal) => resolve({ code, signal }));
        });
        expect(result.code).toBe(0);
        const report = JSON.parse(await readFile(path.join(probe.workRoot, "report.json"), "utf8"));
        if (runtime === "python") {
          expect(report.zero).toBe(1);
          expect(report.term).toBe(1);
          expect(report.fd3).toBe(9);
        } else {
          expect(report.zero).toBe("EPERM");
          expect(report.term).toBe("EPERM");
          expect(["EBADF", "ENXIO"]).toContain(report.fd3);
        }
        expect(report.computed).toBe(49995000);
      } finally {
        try { process.kill(-probe.child.pid!, "SIGKILL"); } catch { /* gone */ }
        await rm(evidenceRoot, { recursive: true, force: true });
        await rm(probe.root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("closed control stream and unwritable watchdog log do not prevent deadline kill", async () => {
    const evidenceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2a2-broken-control-")));
    const logPath = path.join(evidenceRoot, "log-is-a-directory");
    await mkdir(logPath);
    const started = Date.now();
    const probe = await directLauncher({
      source: "import signal, time\nsignal.signal(signal.SIGTERM, lambda *args: None)\ntime.sleep(5)\nopen('finished.txt', 'w').write('late')\n",
      runtime: "python",
      deadlineMs: 600,
      logPath,
      configToken: "broken-control",
      ack: true,
    });
    try {
      await probe.armed;
      probe.control.destroy();
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        probe.child.on("close", (code, signal) => resolve({ code, signal }));
      });
      expect(Date.now() - started).toBeLessThan(4000);
      expect(result.code === 0 && result.signal === null).toBe(false);
      expect(await Bun.file(path.join(probe.workRoot, "finished.txt")).exists()).toBe(false);
      expect((await import("node:fs")).statSync(logPath).isDirectory()).toBe(true);
    } finally {
      try { process.kill(-probe.child.pid!, "SIGKILL"); } catch { /* gone */ }
      await rm(evidenceRoot, { recursive: true, force: true });
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("bounded watchdog control protocol under host-selected launcher faults", () => {
  const INJECTION_ANCHOR = "        armed_wfd = -1\n";
  const EVENT_BASE = '{"protocol": CONTROL_PROTOCOL, "watchdogPid": os.getpid(), "scriptPid": script_pid, "supervisorPid": host_pid}';
  const COMPLETES_AT_500MS = 'import time\ntime.sleep(0.5)\nopen("completed.txt", "w").write("completed")\nprint("completed")\n';

  // Fault injection only replaces a host-selected trusted launcher copy. The
  // ordinary sandboxed source cannot open or forge this control descriptor.
  async function faultyLauncher(root: string, name: string, code: string): Promise<string> {
    const source = await readFile(LAUNCHER, "utf8");
    if (source.split(INJECTION_ANCHOR).length !== 2) {
      throw new Error("trusted launcher injection anchor is not unique");
    }
    const indented = code.split("\n").map((line) => `        ${line}`).join("\n");
    const target = path.join(root, `${name}-launcher.py`);
    await writeFile(target, source.replace(INJECTION_ANCHOR, `${INJECTION_ANCHOR}\n${indented}\n`), { mode: 0o600 });
    return target;
  }

  function artifactNames(result: { details?: unknown }): string[] {
    return (detailsOf(result).artifacts as Array<{ relativePath: string }>).map((item) => item.relativePath);
  }

  test("extra post-armed event keys fail closed before any completion", async () => {
    const f = await fixture();
    try {
      const launcherPath = await faultyLauncher(f.root, "extra-key", `
time.sleep(0.10)
e = ${EVENT_BASE}
e.update({"type": "trigger", "reason": "script_exit", "scriptExitObserved": False, "unrecognizedAuthority": True})
safe_control_write(control_fd, e)
`);
      f.adapter.dispose();
      const faulty = await fixture({ launcherPath });
      try {
        const result = await faulty.adapter.run(faulty.ctx, {
          action: "run", runtime: "python", source: COMPLETES_AT_500MS, inputIds: [], expectedTaskId: currentTaskId(faulty.owner), expectedTaskRevision: 1,
        });
        const details = detailsOf(result);
        expect(result.isError).toBe(true);
        expect(details.dispatch.reason).toBe("watchdog_lost");
        expect(String(details.watchdog.controlError)).toContain("schema");
        expect(details.watchdog.controlEvents).toEqual([]);
        expect(details.dispatch.processGroupVerifiedGone).toBe(true);
        expect(artifactNames(result)).not.toContain("completed.txt");
      } finally {
        await faulty.cleanup();
      }
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("duplicate out-of-order signal events are rejected without shifting retained history", async () => {
    const f = await fixture();
    try {
      const launcherPath = await faultyLauncher(f.root, "event-flood", `
time.sleep(0.10)
e = ${EVENT_BASE}
e.update({"type": "trigger", "reason": "supervisor_exit", "scriptExitObserved": False})
safe_control_write(control_fd, e)
for _ in range(20):
    e = ${EVENT_BASE}
    e.update({"type": "term_sent", "sent": False})
    safe_control_write(control_fd, e)
`);
      f.adapter.dispose();
      const faulty = await fixture({ launcherPath });
      try {
        const result = await faulty.adapter.run(faulty.ctx, {
          action: "run", runtime: "python", source: COMPLETES_AT_500MS, inputIds: [], expectedTaskId: currentTaskId(faulty.owner), expectedTaskRevision: 1,
        });
        const details = detailsOf(result);
        expect(result.isError).toBe(true);
        expect(String(details.watchdog.controlError)).toContain("duplicate term_sent");
        expect(details.watchdog.controlEvents.map((event: any) => event.type)).toEqual(["trigger", "term_sent"]);
        expect(details.watchdog.controlEvents.length).toBeLessThanOrEqual(details.watchdog.controlEventLimit);
        expect(details.watchdog.controlEventsRejected).toBeGreaterThanOrEqual(1);
        expect(details.watchdog.controlEventLimit).toBe(16);
        expect(details.dispatch.processGroupVerifiedGone).toBe(true);
        expect(artifactNames(result)).not.toContain("completed.txt");
      } finally {
        await faulty.cleanup();
      }
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("coherent ordered false exit claim cannot suppress actual live child cleanup", async () => {
    const f = await fixture();
    try {
      const launcherPath = await faultyLauncher(f.root, "ordered-false-exit", `
time.sleep(0.15)
e = ${EVENT_BASE}
e.update({"type": "trigger", "reason": "script_exit", "scriptExitObserved": True})
safe_control_write(control_fd, e)
e["type"] = "watchdog_exit"
safe_control_write(control_fd, e)
os.close(control_fd)
os._exit(0)
`);
      f.adapter.dispose();
      const faulty = await fixture({ launcherPath });
      try {
        const result = await faulty.adapter.run(faulty.ctx, {
          action: "run", runtime: "python", source: COMPLETES_AT_500MS, inputIds: [], expectedTaskId: currentTaskId(faulty.owner), expectedTaskRevision: 1,
        });
        const details = detailsOf(result);
        expect(result.isError).toBe(true);
        expect(details.dispatch.reason).toBe("watchdog_lost");
        expect(details.dispatch.terminatedByHost).toBe(true);
        expect(details.dispatch.childExitObserved).toBe(true);
        expect(String(details.watchdog.controlError)).toContain("actual child");
        expect(details.watchdog.watchdogExitObserved).toBe(true);
        expect(details.watchdog.watchdogExitConfirmed).toBe(false);
        expect(details.watchdog.unexpectedControlEof).toBe(true);
        expect(details.dispatch.processGroupVerifiedGone).toBe(true);
        expect(artifactNames(result)).not.toContain("completed.txt");
      } finally {
        await faulty.cleanup();
      }
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("abrupt control EOF without a terminal claim stops the still-live child", async () => {
    const f = await fixture();
    try {
      const launcherPath = await faultyLauncher(f.root, "abrupt-eof", `
time.sleep(0.15)
os.close(control_fd)
os._exit(0)
`);
      f.adapter.dispose();
      const faulty = await fixture({ launcherPath });
      try {
        const result = await faulty.adapter.run(faulty.ctx, {
          action: "run", runtime: "python", source: COMPLETES_AT_500MS, inputIds: [], expectedTaskId: currentTaskId(faulty.owner), expectedTaskRevision: 1,
        });
        const details = detailsOf(result);
        expect(result.isError).toBe(true);
        expect(details.dispatch.reason).toBe("watchdog_lost");
        expect(details.dispatch.terminatedByHost).toBe(true);
        expect(details.watchdog.watchdogExitObserved).toBe(false);
        expect(details.watchdog.unexpectedControlEof).toBe(true);
        expect(String(details.watchdog.controlError)).toContain("without a terminal event");
        expect(details.dispatch.processGroupVerifiedGone).toBe(true);
        expect(artifactNames(result)).not.toContain("completed.txt");
      } finally {
        await faulty.cleanup();
      }
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("malformed terminal event after a valid trigger fails closed and stops the child", async () => {
    const f = await fixture();
    try {
      const launcherPath = await faultyLauncher(f.root, "malformed-terminal", `
time.sleep(0.15)
e = ${EVENT_BASE}
e.update({"type": "trigger", "reason": "script_exit", "scriptExitObserved": True})
safe_control_write(control_fd, e)
e = ${EVENT_BASE}
e.update({"type": "watchdog_exit", "reason": "script_exit", "scriptExitObserved": "yes"})
safe_control_write(control_fd, e)
os.close(control_fd)
os._exit(0)
`);
      f.adapter.dispose();
      const faulty = await fixture({ launcherPath });
      try {
        const result = await faulty.adapter.run(faulty.ctx, {
          action: "run", runtime: "python", source: COMPLETES_AT_500MS, inputIds: [], expectedTaskId: currentTaskId(faulty.owner), expectedTaskRevision: 1,
        });
        const details = detailsOf(result);
        expect(result.isError).toBe(true);
        expect(details.dispatch.reason).toBe("watchdog_lost");
        expect(String(details.watchdog.controlError)).toContain("exit observation");
        expect(details.watchdog.controlEvents.map((event: any) => event.type)).toEqual(["trigger"]);
        expect(details.dispatch.processGroupVerifiedGone).toBe(true);
        expect(artifactNames(result)).not.toContain("completed.txt");
      } finally {
        await faulty.cleanup();
      }
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("invalid UTF-8 and oversized control lines fail closed while retaining prior events", async () => {
    for (const [name, line] of [
      ["invalid-utf8", 'os.write(control_fd, b"\\xff\\n")'],
      ["oversized-line", 'os.write(control_fd, b"x" * 4200 + b"\\n")'],
    ] as const) {
      const f = await fixture();
      try {
        const launcherPath = await faultyLauncher(f.root, name, `
time.sleep(0.10)
e = ${EVENT_BASE}
e.update({"type": "trigger", "reason": "supervisor_exit", "scriptExitObserved": False})
safe_control_write(control_fd, e)
${line}
`);
        f.adapter.dispose();
        const faulty = await fixture({ launcherPath });
        try {
          const result = await faulty.adapter.run(faulty.ctx, {
            action: "run", runtime: "python", source: COMPLETES_AT_500MS, inputIds: [], expectedTaskId: currentTaskId(faulty.owner), expectedTaskRevision: 1,
          });
          const details = detailsOf(result);
          expect(result.isError).toBe(true);
          expect(String(details.watchdog.controlError)).toContain(name === "invalid-utf8" ? "UTF-8" : "byte limit");
          expect(details.watchdog.controlEvents.map((event: any) => event.type)).toEqual(["trigger"]);
          expect(details.watchdog.controlStreamBytes).toBeGreaterThan(0);
          expect(details.dispatch.processGroupVerifiedGone).toBe(true);
          expect(artifactNames(result)).not.toContain("completed.txt");
        } finally {
          await faulty.cleanup();
        }
      } finally {
        await f.cleanup();
      }
    }
  }, 30_000);

  test("actual normal Python and Bun runs confirm child exit without numeric term or kill", async () => {
    for (const runtime of ["python", "bun"] as const) {
      const f = await fixture();
      try {
        const result = await f.adapter.run(f.ctx, {
          action: "run",
          runtime,
          source: runtime === "python" ? "print('normal python')" : "console.log('normal bun')",
          inputIds: [],
          expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
        });
        const details = detailsOf(result);
        expect(result.isError).toBeUndefined();
        expect(details.dispatch.exitCode).toBe(0);
        expect(details.dispatch.terminatedByHost).toBe(false);
        expect(details.dispatch.childExitObserved).toBe(true);
        expect(details.watchdog.armed).toBe(true);
        expect(details.watchdog.ackSent).toBe(true);
        expect(details.watchdog.triggerReason).toBe("script_exit");
        expect(details.watchdog.watchdogExitObserved).toBe(true);
        expect(details.watchdog.watchdogExitConfirmed).toBe(true);
        expect(details.watchdog.termSent).toBe(false);
        expect(details.watchdog.killSent).toBe(false);
        expect(details.watchdog.controlEvents).toEqual([
          { type: "trigger", reason: "script_exit", scriptExitObserved: true },
          { type: "watchdog_exit", reason: "script_exit", scriptExitObserved: true },
        ]);
      } finally {
        await f.cleanup();
      }
    }
  }, 20_000);
});

describe("host run references from actual execution facts", () => {
  test("a real completed run exposes one immutable reference matching record identity and archived artifact ids", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const knownBytes = Buffer.from("known artifact bytes\n", "utf8");
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "open('known.txt', 'wb').write(b'known artifact bytes\\n')\nprint('reference fixture')\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(result.isError).toBeUndefined();
      const runDirs = await f.runDirs();
      expect(runDirs).toHaveLength(1);
      const snapshot = f.adapter.runReferenceSnapshot();
      expect(snapshot.ownerId).toBe(f.owner.ownerId);
      expect(snapshot.references).toHaveLength(1);
      expect(snapshot.diagnostics).toMatchObject({
        retained: 1,
        limit: 128,
        bytesLimit: 512 * 1024,
        rejectedByCount: 0,
        rejectedByBytes: 0,
        conflicts: 0,
        invalid: 0,
        finalRecordWriteUnconfirmed: 0,
        possiblyDispatchedWithoutConfirmedFinalRecord: 0,
        limitReached: false,
      });
      const reference = snapshot.references[0]!;
      const record = JSON.parse(await readFile(path.join(f.root, reference.runDirectory, "record.json"), "utf8"));
      expect(reference).toMatchObject({
        ownerId: f.owner.ownerId,
        taskId: details.taskId,
        taskRevision: 1,
        requirementsDigest: record.requirementsDigest,
        runId: record.runId,
        callId: record.callId,
        runDirectory: runDirs[0],
        recordWriteReturned: true,
        byteIntegrity: "not_checked",
        authorityRestored: false,
      });
      expect(record.phase).toBe("completed");
      expect(record.process.exitCode).toBe(0);
      expect(reference.artifactIds).toEqual(details.artifacts.map((artifact: any) => artifact.artifactId));
      expect(record.artifacts.map((artifact: any) => artifact.artifactId)).toEqual(reference.artifactIds);
      const archived = details.artifacts.find((artifact: any) => artifact.relativePath === "known.txt");
      expect(await readFile(path.join(f.root, archived.archiveRef))).toEqual(knownBytes);
      expect(Object.isFrozen(reference)).toBe(true);
      expect(Object.isFrozen(reference.artifactIds)).toBe(true);
      const second = f.adapter.runReferenceSnapshot();
      expect(second.references).toEqual(snapshot.references);
      expect(second.references).not.toBe(snapshot.references);
      expect(() => (snapshot.references as unknown as ExecutionRunReferenceLike[]).push({} as any)).toThrow();
      expect(() => (reference.artifactIds as string[]).push("artifact-9")).toThrow();
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("nonzero exit with no artifacts is referenced without success labels or byte claims", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import sys\nsys.exit(3)\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(result.isError).toBe(true);
      expect(details.dispatch.exitCode).toBe(3);
      expect(details.artifacts).toEqual([]);
      const snapshot = f.adapter.runReferenceSnapshot();
      expect(snapshot.references).toHaveLength(1);
      const reference = snapshot.references[0]!;
      expect(reference.artifactIds).toEqual([]);
      expect(reference.recordWriteReturned).toBe(true);
      expect(reference.byteIntegrity).toBe("not_checked");
      expect(reference.authorityRestored).toBe(false);
      expect(reference).not.toHaveProperty("settled");
      expect(reference).not.toHaveProperty("success");
      const record = JSON.parse(await readFile(path.join(f.root, reference.runDirectory, "record.json"), "utf8"));
      expect(record.phase).toBe("completed");
      expect(record.process.exitCode).toBe(3);
      expect(record.artifacts).toEqual([]);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("no reference is claimable during any writer callback and a normal void return is not a disk claim", async () => {
    let adapter: ExecutionAdapter | undefined;
    const callbackFacts: Array<{ phase: unknown; refs: number }> = [];
    let writes = 0;
    const f = await fixture({
      dispatchWallMs: 5000,
      recordWriter: (_filePath, value) => {
        writes += 1;
        callbackFacts.push({
          phase: (value as { phase?: unknown }).phase,
          refs: adapter?.runReferenceSnapshot().references.length ?? -1,
        });
      },
    });
    adapter = f.adapter;
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('void writer')\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      expect(result.isError).toBeUndefined();
      expect(writes).toBe(3);
      expect(callbackFacts).toEqual([
        { phase: "prepared", refs: 0 },
        { phase: "running", refs: 0 },
        { phase: "completed", refs: 0 },
      ]);
      const snapshot = f.adapter.runReferenceSnapshot();
      expect(snapshot.references).toHaveLength(1);
      expect(snapshot.references[0]!.recordWriteReturned).toBe(true);
      expect(snapshot.references[0]!.byteIntegrity).toBe("not_checked");
      const recordExists = await readFile(path.join(f.root, snapshot.references[0]!.runDirectory, "record.json"))
        .then(() => true, () => false);
      expect(recordExists).toBe(false);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("mutating the completed record passed to the writer cannot relabel the frozen reference", async () => {
    const f = await fixture({
      dispatchWallMs: 5000,
      recordWriter: (filePath, value) => {
        const record = value as Record<string, unknown>;
        if (record.phase === "completed") {
          record.taskId = "tampered-task";
          record.runId = "run-tampered";
          record.ownerId = "tampered-owner";
          (record.artifacts as Array<Record<string, unknown>>)[0]!.artifactId = "artifact-tampered";
        }
        writeFileSync(filePath, JSON.stringify(value));
      },
    });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "open('tamper.txt', 'w').write('actual')\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      const snapshot = f.adapter.runReferenceSnapshot();
      const reference = snapshot.references[0]!;
      expect(reference.ownerId).toBe(f.owner.ownerId);
      expect(reference.taskId).toBe(details.taskId);
      expect(reference.runId).toBe(details.runId);
      expect(reference.artifactIds).toEqual(details.artifacts.map((artifact: any) => artifact.artifactId));
      expect(reference.artifactIds).not.toContain("artifact-tampered");
      expect(reference.recordWriteReturned).toBe(true);
      expect(reference.byteIntegrity).toBe("not_checked");
      expect(reference.authorityRestored).toBe(false);
      const tampered = JSON.parse(await readFile(path.join(f.root, reference.runDirectory, "record.json"), "utf8"));
      expect(tampered.taskId).toBe("tampered-task");
      expect(tampered.runId).toBe("run-tampered");
      expect(tampered.artifacts[0].artifactId).toBe("artifact-tampered");
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("a final writer throw cannot upgrade the run to a retained reference", async () => {
    let writes = 0;
    const f = await fixture({
      dispatchWallMs: 5000,
      recordWriter: (filePath, value) => {
        writes += 1;
        if (writes >= 3) throw new Error("injected final reference fault");
        writeFileSync(filePath, JSON.stringify(value));
      },
    });
    try {
      expect(f.adapter.runReferenceSnapshot().diagnostics).toMatchObject({
        retained: 0,
        finalRecordWriteUnconfirmed: 0,
        possiblyDispatchedWithoutConfirmedFinalRecord: 0,
      });
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "open('thrown.txt', 'w').write('ran')\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      expect(result.isError).toBe(true);
      expect(writes).toBe(3);
      expect(detailsOf(result).hostRecordErrors.finalRecord).toContain("injected final reference fault");
      const snapshot = f.adapter.runReferenceSnapshot();
      expect(snapshot.references).toEqual([]);
      expect(snapshot.diagnostics).toMatchObject({
        retained: 0,
        finalRecordWriteUnconfirmed: 1,
        possiblyDispatchedWithoutConfirmedFinalRecord: 1,
        rejectedByCount: 0,
        rejectedByBytes: 0,
        invalid: 0,
      });
      expect(f.adapter.activitySnapshot().unresolvedCompletions).toContainEqual(expect.objectContaining({
        runId: detailsOf(result).runId,
        reasonCodes: ["final_host_record_unconfirmed"],
      }));
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("a dispatched run that never reaches the final writer is counted as missing, not no-effect", async () => {
    let clockCalls = 0;
    const f = await fixture({
      dispatchWallMs: 5000,
      now: () => {
        clockCalls += 1;
        if (clockCalls === 3) throw new Error("injected completed-record clock fault");
        return NOW;
      },
    });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "open('clock.txt', 'w').write('ran')\n",
        inputIds: [],
        expectedTaskId: currentTaskId(f.owner),
        expectedTaskRevision: 1,
      });
      expect(result.isError).toBe(true);
      expect(clockCalls).toBe(3);
      const snapshot = f.adapter.runReferenceSnapshot();
      expect(snapshot.references).toEqual([]);
      expect(snapshot.diagnostics).toMatchObject({
        retained: 0,
        finalRecordWriteUnconfirmed: 0,
        possiblyDispatchedWithoutConfirmedFinalRecord: 1,
        invalid: 0,
      });
      const unresolved = f.adapter.activitySnapshot().unresolvedCompletions;
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]!.reasonCodes).toContain("final_host_record_unconfirmed");
    } finally {
      await f.cleanup();
    }
  }, 20_000);
});

type ExecutionRunReferenceLike = ReturnType<ExecutionAdapter["runReferenceSnapshot"]>["references"][number];
