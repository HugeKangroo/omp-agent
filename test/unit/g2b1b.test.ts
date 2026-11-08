import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createExecutionEntry,
  type ExecutionEntryControls,
} from "../../src/execution-entry.ts";
import { writeJsonAtomicSync } from "../../src/host-record.ts";
import {
  clearPublishedTaskOwner,
  publishTaskOwner,
  type OmpToolContext,
} from "../../src/task-entry-port.ts";
import { TaskOwner, type TaskSubject } from "../../src/task-owner.ts";
import { requirementsDigest } from "../../src/task-requirements.ts";
import type { TrustedContractSpec } from "../../src/acceptance-contract.ts";
import {
  createVerificationEntry,
  parseVerificationArguments,
  VERIFICATION_TOOL,
  type VerificationHostControls,
} from "../../src/verification-entry.ts";
import type { TrustedVerifier } from "../../src/verification-service.ts";
import { ExecutionAdapter, parseExecutionArguments } from "../../src/execution-adapter.ts";

const SESSION = "g2b1b-session";
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
    message: { role: "user", content: [{ type: "text", text }], attribution: "user" },
  };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: OmpToolContext,
  ): Promise<ToolResult>;
}

interface FakePi {
  tools: Map<string, RegisteredTool>;
  handlers: Map<string, (event: unknown) => unknown>;
  pi: Parameters<typeof createExecutionEntry>[0];
}

function fakePi(options: { throwOn?: string; throwOnSession?: boolean } = {}): FakePi {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (event: unknown) => unknown>();
  return {
    tools,
    handlers,
    pi: {
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
        if (tool.name === options.throwOn) throw new Error("fixture registration failure");
      },
      on(event: string, handler: (event: unknown) => unknown) {
        if (options.throwOnSession === true) throw new Error("fixture session registration failure");
        handlers.set(event, handler);
      },
    } as Parameters<typeof createExecutionEntry>[0],
  };
}

function subject(branch: readonly unknown[]): TaskSubject {
  return { sessionId: SESSION, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

let WORKSPACE = "";

function context(branchSource: readonly unknown[] | (() => readonly unknown[])): OmpToolContext {
  const branch = typeof branchSource === "function" ? branchSource : () => branchSource;
  return {
    cwd: WORKSPACE,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => SESSION,
      getLeafId: () => null,
      getBranch: branch,
    },
  };
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

interface Fixture {
  root: string;
  workspace: string;
  owner: TaskOwner;
  branch: readonly Entry[];
  live: { branch: readonly Entry[] };
  ctx: OmpToolContext;
  adapter: ExecutionAdapter;
  cleanup: () => Promise<void>;
}

async function baseFixture(options: { sequence?: () => string } = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b1b-")));
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b1b-ws-")));
  WORKSPACE = workspace;
  const fixtures = path.join(root, "fixtures");
  await mkdir(fixtures);
  const alphaPath = path.join(fixtures, "alpha.txt");
  await writeFile(alphaPath, "authorized alpha input\n", { mode: 0o600 });
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: workspace,
    ownerId: "owner-g2b1b",
    authorizedCapabilities: ["local-script"],
    now: () => NOW,
    id: () => `owner-id-${++sequence}`,
  });
  const branch = [base(), user("user-1", "leaf-1", "Produce a candidate artifact.")];
  const live = { branch };
  const ctx = context(() => live.branch);
  owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: workspace,
    source: "rpc",
    text: "Produce a candidate artifact.",
    observedAt: NOW,
    baseLeafId: "leaf-1",
  });
  owner.observeAgentStart({ sessionId: SESSION, prompt: "Produce a candidate artifact.", reason: "prompt" });
  owner.start(subject(branch), "Produce a candidate artifact.");
  const adapter = new ExecutionAdapter(owner, {
    root,
    inputs: [{ id: "alpha", path: alphaPath }],
    capabilityId: "local-script",
    pythonPath: PYTHON,
    bunPath: BUN,
    launcherPath: LAUNCHER,
    recordWriter: writeJsonAtomicSync,
    id: () => options.sequence?.() ?? `run-${++sequence}`,
    now: () => NOW,
  });
  return {
    root,
    workspace,
    owner,
    branch,
    live,
    ctx,
    adapter,
    cleanup: async () => {
      adapter.dispose();
      clearPublishedTaskOwner();
      await rm(root, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

function passVerifier(id = "fixture-semantic", version = "1"): TrustedVerifier {
  return {
    id,
    version,
    check(input) {
      const artifact = input.candidate.artifacts.find((item) => item.relativePath === "answer.txt");
      return {
        conditions: [{
          conditionId: "answer",
          result: artifact?.data.toString("utf8").includes("42") ? "pass" : "fail",
          detail: "fixture check detail",
        }],
      };
    },
  };
}

function passSpec(overrides: { description?: string; parameters?: unknown } = {}): TrustedContractSpec {
  return {
    hostConfig: { id: "host-fixture", version: "1" },
    verifier: { id: "fixture-semantic", version: "1", parameters: overrides.parameters ?? { fixture: true } },
    conditions: [{
      conditionId: "answer",
      description: overrides.description ?? "fixture semantic condition",
      kind: "semantic",
      coveredRevisions: [1],
    }],
    coverage: {
      kind: "semantic",
      complete: true,
      coveredRevisions: [1],
      statement: "host fixture binds this exact requirement",
    },
  };
}

const ANSWER_SOURCE = `
open("answer.txt", "w").write("42\\n")
print("answer written")
`;

async function runAnswer(f: Fixture): Promise<{ result: ToolResult; runId: string; artifactIds: string[] }> {
  const task = f.owner.snapshot().currentTask!;
  const result = await f.adapter.run(f.ctx, {
    action: "run",
    runtime: "python",
    source: ANSWER_SOURCE,
    inputIds: [],
    expectedTaskId: task.taskId,
    expectedTaskRevision: task.taskRevision,
  });
  const details = result.details as Record<string, unknown>;
  expect(result.isError).toBeUndefined();
  return {
    result,
    runId: String(details.runId),
    artifactIds: (details.artifacts as Array<{ artifactId: string }>).map((item) => item.artifactId),
  };
}

interface EntryFixture extends Fixture {
  entry: ExecutionEntryControls;
  tools: Map<string, RegisteredTool>;
}

async function entryFixture(options: {
  verifier?: TrustedVerifier;
  throwOn?: string;
  sequence?: () => string;
} = {}): Promise<EntryFixture> {
  const f = await baseFixture({ ...(options.sequence === undefined ? {} : { sequence: options.sequence }) });
  f.adapter.dispose();
  publishTaskOwner(f.owner);
  const fake = fakePi({ ...(options.throwOn === undefined ? {} : { throwOn: options.throwOn }) });
  const entry = createExecutionEntry(fake.pi, {
    root: f.root,
    inputs: [],
    capabilityId: "local-script",
    pythonPath: PYTHON,
    bunPath: BUN,
    launcherPath: LAUNCHER,
    ...(options.verifier === undefined ? {} : { trustedVerifiers: [options.verifier] }),
  });
  return {
    ...f,
    adapter: entry.adapter,
    entry,
    tools: fake.tools,
    cleanup: async () => {
      entry.dispose();
      await f.cleanup();
    },
  };
}

async function verifyTool(
  f: EntryFixture,
  request: { runId: string; artifactIds: string[] },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const task = f.owner.snapshot().currentTask!;
  return f.tools.get(VERIFICATION_TOOL)!.execute("verify", {
    action: "verify",
    expectedTaskId: task.taskId,
    expectedTaskRevision: task.taskRevision,
    runId: request.runId,
    artifactIds: request.artifactIds,
  }, signal, undefined, f.ctx);
}

describe("G2-B1b verification entry", () => {
  test("parser accepts describe/verify and rejects missing, unknown and authority-shaped fields", () => {
    expect(parseVerificationArguments({ action: "describe" })).toEqual({ action: "describe" });
    const request = {
      action: "verify",
      expectedTaskId: "task-1",
      expectedTaskRevision: 2,
      runId: "run-1",
      artifactIds: ["artifact-1"],
    };
    expect(parseVerificationArguments(request)).toMatchObject({
      action: "verify",
      request: {
        expectedTaskId: "task-1",
        expectedTaskRevision: 2,
        runId: "run-1",
        artifactIds: ["artifact-1"],
      },
    });
    for (const invalid of [
      { action: "verify", expectedTaskRevision: 2, runId: "run-1", artifactIds: ["artifact-1"] },
      { action: "verify", expectedTaskId: "task-1", runId: "run-1", artifactIds: ["artifact-1"] },
      { action: "verify", expectedTaskId: "task-1", expectedTaskRevision: 2, artifactIds: ["artifact-1"] },
      { action: "verify", expectedTaskId: "task-1", expectedTaskRevision: 2, runId: "run-1" },
      { ...request, artifactIds: [] },
      { ...request, artifactIds: ["a", "a"] },
      { ...request, artifactIds: Array.from({ length: 9 }, (_, index) => `a-${index}`) },
      { ...request, ownerId: "owner-1" },
      { ...request, digest: "requirements-digest-v1:sha256:00" },
      { ...request, contractId: "contract-1" },
      { ...request, profile: "host" },
      { ...request, coverage: "complete" },
      { ...request, receipt: {} },
      { ...request, archiveRef: "run-1/artifacts/artifact-1.bin" },
      { ...request, taskAccepted: true },
      { action: "describe", expectedTaskId: "task-1" },
    ]) {
      expect(() => parseVerificationArguments(invalid)).toThrow();
    }
  });

  test("default entry registers agent_verify beside agent_execute and has no contract", async () => {
    const f = await entryFixture();
    try {
      expect([...f.tools.keys()].sort()).toEqual(["agent_execute", VERIFICATION_TOOL]);
      const described = await f.tools.get(VERIFICATION_TOOL)!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx);
      const describeText = textOf(described);
      expect(described.isError).toBeUndefined();
      expect(describeText).toContain("taskAccepted: false");
      expect(describeText).toContain("contract: none");
      expect(describeText).toContain("configuredVerifiers:");
      expect(describeText).toContain("no immutable acceptance contract is bound");
      expect(new TextEncoder().encode(describeText).byteLength).toBeLessThanOrEqual(16 * 1024);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");

      const run = await runAnswer(f);
      const verified = await verifyTool(f, run);
      const verifyText = textOf(verified);
      expect(verifyText).toContain("taskAccepted: false");
      expect(verifyText).toContain("outcome: insufficient");
      expect(verifyText).toContain("no immutable acceptance contract");
      expect(verified.details).toMatchObject({ action: "verify", taskAccepted: false, outcome: "insufficient" });
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await f.cleanup();
    }
  });

  test("serial gate rejects a second verify and host lookup while describe uses only its own context", async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const verifier: TrustedVerifier = {
      ...passVerifier(),
      async check() {
        entered();
        await blocked;
        return { conditions: [{ conditionId: "answer", result: "pass", detail: "after barrier" }] };
      },
    };
    const f = await entryFixture({ verifier });
    try {
      f.entry.bindContract(f.ctx, passSpec());
      const run = await runAnswer(f);
      const first = verifyTool(f, run);
      await enteredPromise;

      const second = await verifyTool(f, run);
      expect(second.isError).toBe(true);
      expect(textOf(second)).toContain("already owns the live context");
      await expect(f.entry.lookup(f.ctx, "verification-unknown")).rejects.toThrow(/owns the live context/);

      const described = await f.tools.get(VERIFICATION_TOOL)!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx);
      expect(textOf(described)).toContain("host contract is bound");
      const wrongBranchContext = context([]);
      const wrongDescribe = await f.tools.get(VERIFICATION_TOOL)!.execute("describe", { action: "describe" }, undefined, undefined, wrongBranchContext);
      expect(wrongDescribe.isError).toBe(true);
      expect(textOf(wrongDescribe)).not.toContain("contractId");
      expect(textOf(wrongDescribe)).toContain("taskAccepted: false");

      release();
      const verified = await first;
      expect(verified.isError).toBeUndefined();
      expect(textOf(verified)).toContain("outcome: pass");
      expect(textOf(verified)).toContain("taskAccepted: false");
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await f.cleanup();
    }
  });

  test("post-service window: live branch change hides the model view but retains the receipt", async () => {
    const f = await baseFixture();
    const fake = fakePi();
    publishTaskOwner(f.owner);
    let mutate = false;
    let receiptId = "";
    let sequence = 0;
    const controls: VerificationHostControls = createVerificationEntry(fake.pi as unknown as Parameters<typeof createVerificationEntry>[0], {
      owner: f.owner,
      candidates: f.adapter.candidates,
      workspaceRoot: f.owner.workspaceRoot,
      trustedVerifiers: [passVerifier()],
      now: () => NOW,
      id: () => {
        const value = ++sequence;
        if (mutate) {
          mutate = false;
          receiptId = `verification-fixture-${value}`;
          queueMicrotask(() => { f.live.branch = []; });
        }
        return `fixture-${value}`;
      },
    });
    try {
      controls.bindContract(f.ctx, passSpec());
      const run = await runAnswer(f);
      const task = f.owner.snapshot().currentTask!;
      mutate = true;
      const result = await fake.tools.get(VERIFICATION_TOOL)!.execute("verify", {
        action: "verify",
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
        runId: run.runId,
        artifactIds: run.artifactIds,
      }, undefined, undefined, f.ctx);
      const text = textOf(result);
      expect(result.isError).toBe(true);
      expect(text).toContain("taskAccepted: false");
      expect(text).toContain("withheld");
      expect(text).not.toContain("outcome: pass");
      expect(text).not.toContain(receiptId);

      f.live.branch = f.branch;
      const found = await controls.lookup(f.ctx, receiptId);
      expect(found).not.toBeNull();
      expect(found!.receipt.outcome).toBe("pass");
      expect(found!.usable).toBe(true);
      expect(found!.modelView).toContain("outcome: pass");
    } finally {
      controls.dispose();
      await f.cleanup();
    }
  });

  test("describe bounds oversized contracts explicitly and withholds verifier parameters", async () => {
    const secret = "SECRET_VERIFIER_PARAMETER";
    const description = "D".repeat(2000);
    const f = await entryFixture({ verifier: passVerifier() });
    try {
      const spec = passSpec({ description, parameters: { secret } });
      spec.conditions = Array.from({ length: 8 }, (_, index) => ({
        conditionId: `condition-${index}`,
        description,
        kind: "semantic" as const,
        coveredRevisions: [1],
      }));
      f.entry.bindContract(f.ctx, spec);
      const described = await f.tools.get(VERIFICATION_TOOL)!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx);
      const text = textOf(described);
      try {
        const contractLine = text.split("\n").find((line) => line.startsWith("contract: "))!;
        const contract = JSON.parse(contractLine.slice("contract: ".length));
        expect(contract.contractId).toMatch(/^contract-/);
        expect(contract.coverage.kind).toBe("semantic");
        expect(contract.coverage.complete).toBe(true);
      } catch {
        throw new Error(`describe contract facts are not machine-readable: ${text.slice(0, 400)}`);
      }
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(16 * 1024);
      expect(text).toContain("taskAccepted: false");
      expect(text).toContain("truncated: true");
      expect(text).toContain("descriptionOmitted");
      expect(text).not.toContain(secret);
    } finally {
      await f.cleanup();
    }
  });

  test("dispose and owner replacement make retained handlers and host controls fail closed", async () => {
    const f = await entryFixture({ verifier: passVerifier() });
    try {
      const contract = f.entry.bindContract(f.ctx, passSpec());
      const before = textOf(await f.tools.get(VERIFICATION_TOOL)!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx));
      expect(before).toContain(contract.contractId);

      const replacement = new TaskOwner({ workspaceRoot: f.workspace });
      publishTaskOwner(replacement);
      const replaced = await f.tools.get(VERIFICATION_TOOL)!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx);
      expect(replaced.isError).toBe(true);
      expect(textOf(replaced)).toContain("owner");
      const replacedExecute = await f.tools.get("agent_execute")!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx);
      expect(replacedExecute.isError).toBe(true);
      expect(textOf(replacedExecute)).toContain("owner");

      publishTaskOwner(f.owner);
      f.entry.dispose();
      const after = await f.tools.get(VERIFICATION_TOOL)!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx);
      expect(after.isError).toBe(true);
      expect(textOf(after)).toContain("disposed");
      expect(textOf(after)).not.toContain(contract.contractId);
      await expect(f.entry.lookup(f.ctx, "verification-any")).rejects.toThrow(/disposed/);
      const exec = await f.tools.get("agent_execute")!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx);
      expect(exec.isError).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("partial registration failure disposes created components and retained tools reject", async () => {
    const f = await baseFixture();
    try {
      const fake = fakePi({ throwOn: "agent_execute" });
      publishTaskOwner(f.owner);
      expect(() => createExecutionEntry(fake.pi, {
        root: f.root,
        inputs: [],
        capabilityId: "local-script",
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
      })).toThrow(/fixture registration failure/);
      expect([...fake.tools.keys()].sort()).toEqual(["agent_execute", VERIFICATION_TOOL]);
      const verify = await fake.tools.get(VERIFICATION_TOOL)!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx);
      expect(verify.isError).toBe(true);
      expect(textOf(verify)).toContain("disposed");
      const execute = await fake.tools.get("agent_execute")!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx);
      expect(execute.isError).toBe(true);
    } finally {
      clearPublishedTaskOwner();
      await f.cleanup();
    }
  });

  test("session event registration failure disposes both tools' live state", async () => {
    const f = await baseFixture();
    try {
      const fake = fakePi({ throwOnSession: true });
      publishTaskOwner(f.owner);
      expect(() => createExecutionEntry(fake.pi, {
        root: f.root,
        inputs: [],
        capabilityId: "local-script",
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
      })).toThrow(/fixture session registration failure/);
      expect([...fake.tools.keys()].sort()).toEqual(["agent_execute", VERIFICATION_TOOL]);
      const verify = await fake.tools.get(VERIFICATION_TOOL)!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx);
      expect(verify.isError).toBe(true);
      expect(textOf(verify)).toContain("disposed");
      const execute = await fake.tools.get("agent_execute")!.execute("describe", { action: "describe" }, undefined, undefined, f.ctx);
      expect(execute.isError).toBe(true);
      expect(textOf(execute)).toContain("disposed");
    } finally {
      clearPublishedTaskOwner();
      await f.cleanup();
    }
  });

  test("direct adapter run rejects missing, wrong, other-task and stale guards with taskAccepted:false", async () => {
    const f = await baseFixture();
    try {
      const task = f.owner.snapshot().currentTask!;
      const missing = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('never')",
        inputIds: [],
        expectedTaskRevision: task.taskRevision,
      } as never);
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("expectedTaskId is required");

      const wrong = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('never')",
        inputIds: [],
        expectedTaskId: "task-other",
        expectedTaskRevision: task.taskRevision,
      });
      expect(wrong.isError).toBe(true);
      expect(textOf(wrong)).toContain("does not match the current task");

      const other = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('never')",
        inputIds: [],
        expectedTaskId: "task-different",
        expectedTaskRevision: task.taskRevision,
      });
      expect(other.isError).toBe(true);

      const stale = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('never')",
        inputIds: [],
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision + 1,
      });
      expect(stale.isError).toBe(true);
      expect(textOf(stale)).toContain("stale expectedTaskRevision");

      for (const result of [missing, wrong, other, stale]) {
        expect(textOf(result)).toMatch(/taskAccepted\s*:\s*false/);
        expect(result.details).toMatchObject({ taskAccepted: false });
      }
      expect(f.owner.snapshot().currentTask!.admissions).toBe(0);
      const described = await f.adapter.describe(f.ctx);
      expect(described.details!.dispatchBudget).toMatchObject({ attempted: 0, dispatched: 0, reserved: 0 });
    } finally {
      await f.cleanup();
    }
  });

  test("schemas pass unknown fields to strict parsers and entry rejections state taskAccepted:false", async () => {
    let verifierCalls = 0;
    const verifier: TrustedVerifier = {
      id: "fixture-semantic",
      version: "1",
      check() {
        verifierCalls += 1;
        return { conditions: [] };
      },
    };
    const f = await entryFixture({ verifier });
    try {
      const execute = f.tools.get("agent_execute")!;
      const verify = f.tools.get(VERIFICATION_TOOL)!;
      expect(execute.parameters.additionalProperties).toBe(true);
      expect(verify.parameters.additionalProperties).toBe(true);

      const task = f.owner.snapshot().currentTask!;
      const run = {
        action: "run",
        runtime: "python",
        source: "print('never')",
        inputIds: [],
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
      };
      expect(() => parseExecutionArguments({ ...run, path: "/etc/passwd" })).toThrow(/host authority/);
      expect(() => parseExecutionArguments({ ...run, unknownModelField: true })).toThrow(/unsupported field/);

      const rejected = await execute.execute("rejected-execute", { ...run, path: "/etc/passwd" }, undefined, undefined, f.ctx);
      expect(rejected.isError).toBe(true);
      expect(textOf(rejected)).toContain("host authority");
      expect(textOf(rejected)).toMatch(/taskAccepted\s*:\s*false/);
      expect(rejected.details).toMatchObject({ taskAccepted: false });

      const request = {
        action: "verify",
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
        runId: "run-missing",
        artifactIds: ["artifact-1"],
      };
      for (const extra of [
        { path: "/etc/passwd" },
        { contractId: "contract-1" },
        { coverage: "complete" },
        { receipt: {} },
        { threshold: 1 },
        { unknownModelField: true },
      ]) {
        expect(() => parseVerificationArguments({ ...request, ...extra })).toThrow();
        const result = await verify.execute("rejected-verify", { ...request, ...extra }, undefined, undefined, f.ctx);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/taskAccepted\s*:\s*false/);
        expect(result.details).toMatchObject({ action: "verify", taskAccepted: false });
      }
      expect(verifierCalls).toBe(0);
      expect(f.owner.snapshot().currentTask!.admissions).toBe(0);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await f.cleanup();
    }
  });
});
