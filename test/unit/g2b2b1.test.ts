import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcceptanceService } from "../../src/acceptance-service.ts";
import type { TrustedContractSpec } from "../../src/acceptance-contract.ts";
import {
  installPreparedAcceptanceRecordSync,
  MAX_ACCEPTANCE_RECORD_BYTES,
  prepareAcceptanceRecord,
  readAcceptanceRecord,
  resolveAcceptanceRoot,
} from "../../src/acceptance-record-store.ts";
import { DeliveryService } from "../../src/delivery-service.ts";
import { createDeliveryEntry, DELIVERY_TOOL, parseDeliveryArguments } from "../../src/delivery-entry.ts";
import { createExecutionEntry, type ExecutionEntryControls } from "../../src/execution-entry.ts";
import {
  clearPublishedTaskOwner,
  publishTaskOwner,
  type OmpToolContext,
} from "../../src/task-entry-port.ts";
import { TaskOwner, type TaskSubject } from "../../src/task-owner.ts";
import { requirementsDigest } from "../../src/task-requirements.ts";
import { VERIFICATION_TOOL } from "../../src/verification-entry.ts";
import type { TrustedVerifier } from "../../src/verification-service.ts";

const SESSION = "g2b2b1-session";
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

function fakePi(): FakePi {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (event: unknown) => unknown>();
  return {
    tools,
    handlers,
    pi: {
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
      on(event: string, handler: (event: unknown) => unknown) {
        handlers.set(event, handler);
      },
    } as Parameters<typeof createExecutionEntry>[0],
  };
}

let WORKSPACE = "";

function subject(branch: readonly unknown[]): TaskSubject {
  return { sessionId: SESSION, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

function guard(owner: TaskOwner, taskRevision?: number) {
  const task = owner.snapshot().currentTask;
  if (!task) throw new Error("test setup: no current task");
  return { taskId: task.taskId, taskRevision: taskRevision ?? task.taskRevision };
}

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

function modelJson(result: ToolResult): Record<string, any> {
  return JSON.parse(textOf(result)) as Record<string, any>;
}

function line(text: string, prefix: string): string | undefined {
  const found = text.split("\n").find((item) => item.startsWith(prefix));
  return found?.slice(prefix.length);
}

interface Fixture {
  root: string;
  workspace: string;
  deliveryRoot: string;
  acceptanceRoot: string;
  owner: TaskOwner;
  branch: readonly Entry[];
  live: { branch: readonly Entry[] };
  ctx: OmpToolContext;
  entry: ExecutionEntryControls;
  tools: Map<string, RegisteredTool>;
  handlers: Map<string, (event: unknown) => unknown>;
  cleanup: () => Promise<void>;
}

function passVerifier(): TrustedVerifier {
  return {
    id: "fixture-semantic",
    version: "1",
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

function passSpec(overrides: Partial<TrustedContractSpec> = {}): TrustedContractSpec {
  return {
    hostConfig: { id: "host-fixture", version: "1" },
    verifier: { id: "fixture-semantic", version: "1", parameters: { secret: "never-in-record" } },
    conditions: [{
      conditionId: "answer",
      description: "fixture semantic condition",
      kind: "semantic",
      coveredRevisions: [1],
    }],
    coverage: {
      kind: "semantic",
      complete: true,
      coveredRevisions: [1],
      statement: "host fixture binds this exact requirement",
    },
    ...overrides,
  };
}

async function fixture(options: {
  verifier?: TrustedVerifier;
  onEvent?: (event: Record<string, unknown> & { type: string }) => void;
  withAcceptance?: boolean;
  deliveryRoot?: string;
} = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-")));
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-ws-")));
  WORKSPACE = workspace;
  const deliveryRoot = options.deliveryRoot === undefined
    ? await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-del-")))
    : await realpath(options.deliveryRoot);
  const acceptanceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-acc-")));
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: workspace,
    ownerId: "owner-g2b2b1",
    authorizedCapabilities: ["local-script"],
    now: () => NOW,
    id: () => `owner-id-${++sequence}`,
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  const branch = [base(), user("user-1", "leaf-1", "Produce an accepted answer.")];
  const live = { branch };
  const ctx = context(() => live.branch);
  owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: workspace,
    source: "rpc",
    text: "Produce an accepted answer.",
    observedAt: NOW,
    baseLeafId: "leaf-1",
  });
  owner.observeAgentStart({ sessionId: SESSION, prompt: "Produce an accepted answer.", reason: "prompt" });
  owner.start(subject(branch), "Produce an accepted answer.");
  publishTaskOwner(owner);
  const fake = fakePi();
  const entry = createExecutionEntry(fake.pi, {
    root,
    capabilityId: "local-script",
    pythonPath: PYTHON,
    bunPath: BUN,
    launcherPath: LAUNCHER,
    trustedVerifiers: [options.verifier ?? passVerifier()],
    deliveryRoot,
    ...(options.withAcceptance === false ? {} : { acceptanceRoot }),
  });
  return {
    root,
    workspace,
    deliveryRoot,
    acceptanceRoot,
    owner,
    branch,
    live,
    ctx,
    entry,
    tools: fake.tools,
    handlers: fake.handlers,
    cleanup: async () => {
      entry.dispose();
      clearPublishedTaskOwner();
      await rm(root, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(deliveryRoot, { recursive: true, force: true });
      await rm(acceptanceRoot, { recursive: true, force: true });
    },
  };
}

const SOURCE = `
from pathlib import Path
Path("answer.txt").write_text("42\\n", encoding="utf-8")
print("artifact written")
`;

async function runSource(f: Fixture): Promise<{
  runId: string;
  artifacts: Array<{ artifactId: string; relativePath: string; bytes: number; sha256: string; archiveRef: string }>;
}> {
  const task = f.owner.snapshot().currentTask!;
  const result = await f.entry.adapter.run(f.ctx, {
    action: "run",
    runtime: "python",
    source: SOURCE,
    inputIds: [],
    expectedTaskId: task.taskId,
    expectedTaskRevision: task.taskRevision,
  });
  expect(result.isError).toBeUndefined();
  const details = result.details as Record<string, unknown>;
  return {
    runId: String(details.runId),
    artifacts: details.artifacts as Array<{ artifactId: string; relativePath: string; bytes: number; sha256: string; archiveRef: string }>,
  };
}

async function verify(
  f: Fixture,
  runId: string,
  artifactIds: string[],
): Promise<string> {
  const task = f.owner.snapshot().currentTask!;
  const result = await f.tools.get(VERIFICATION_TOOL)!.execute("verify", {
    action: "verify",
    expectedTaskId: task.taskId,
    expectedTaskRevision: task.taskRevision,
    runId,
    artifactIds,
  }, undefined, undefined, f.ctx);
  expect(result.isError).toBeUndefined();
  return (result.details as { receiptId: string }).receiptId;
}

async function preview(
  f: Fixture,
  runId: string,
  artifactIds: string[],
  receiptId?: string,
): Promise<{ deliveryId: string; text: string; files: Array<{ path: string; sha256: string }> }> {
  const task = f.owner.snapshot().currentTask!;
  const result = await f.tools.get(DELIVERY_TOOL)!.execute("preview", {
    action: "preview",
    expectedTaskId: task.taskId,
    expectedTaskRevision: task.taskRevision,
    runId,
    artifactIds,
    ...(receiptId === undefined ? {} : { verificationReceiptId: receiptId }),
  }, undefined, undefined, f.ctx);
  expect(result.isError).toBeUndefined();
  const text = textOf(result);
  return {
    deliveryId: line(text, "deliveryId: ")!,
    text,
    files: JSON.parse(line(text, "files: ")!) as Array<{ path: string; sha256: string }>,
  };
}

async function prepareAccepted(f: Fixture): Promise<{
  runId: string;
  artifactIds: string[];
  receiptId: string;
  deliveryId: string;
  files: Array<{ path: string; sha256: string }>;
}> {
  f.entry.bindContract(f.ctx, passSpec());
  const run = await runSource(f);
  const artifactIds = run.artifacts.map((artifact) => artifact.artifactId);
  const receiptId = await verify(f, run.runId, artifactIds);
  const delivery = await preview(f, run.runId, artifactIds, receiptId);
  return { runId: run.runId, artifactIds, receiptId, deliveryId: delivery.deliveryId, files: delivery.files };
}

function selector(f: Fixture, deliveryId: string): {
  expectedTaskId: string;
  expectedTaskRevision: number;
  deliveryId: string;
} {
  const task = f.owner.snapshot().currentTask!;
  return { expectedTaskId: task.taskId, expectedTaskRevision: task.taskRevision, deliveryId };
}

function acceptanceOf(f: Fixture): AcceptanceService {
  return f.entry.acceptance!;
}

async function submitTool(
  f: Fixture,
  deliveryId: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return f.tools.get(DELIVERY_TOOL)!.execute("submit-tool", {
    action: "submit",
    ...selector(f, deliveryId),
  }, signal, undefined, f.ctx);
}

async function inspectTool(
  f: Fixture,
  deliveryId: string,
): Promise<ToolResult> {
  return f.tools.get(DELIVERY_TOOL)!.execute("inspect-tool", {
    action: "inspect",
    ...selector(f, deliveryId),
  }, undefined, undefined, f.ctx);
}

function sha256(data: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

describe("G2-B2-B1 host acceptance transaction", () => {
  test("real complete contract and current pass are accepted exactly once with exact record bytes", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const submitted = await acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      expect(submitted.outcome).toBe("committed");
      expect(submitted.operationCommitted).toBe(true);
      expect(submitted.taskAccepted).toBe(true);
      expect(submitted.acceptance).not.toBeNull();
      const reference = submitted.acceptance!;
      expect(reference.deliveryId).toBe(prepared.deliveryId);
      expect(reference.recordDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");
      expect(f.owner.snapshot().currentTask!.acceptance).toEqual(reference);

      const recordPath = path.join(f.acceptanceRoot, `record-${reference.acceptanceId}.json`);
      const recordBytes = readFileSync(recordPath);
      expect(sha256(recordBytes)).toBe(reference.recordDigest);
      expect(recordBytes.length).toBeLessThanOrEqual(MAX_ACCEPTANCE_RECORD_BYTES);
      const record = JSON.parse(recordBytes.toString("utf8")) as Record<string, unknown>;
      expect(record.version).toBe("g2b2b1-acceptance-v1");
      expect((record.policy as Record<string, unknown>).source).toBe("automatic-host-contract");
      expect(JSON.stringify(record)).not.toContain("never-in-record");
      expect(record.receipt).toBeObject();
      const receipt = (record.receipt as Record<string, unknown>).receipt as Record<string, unknown>;
      expect(receipt.taskAccepted).toBe(false);
      expect(receipt.outcome).toBe("pass");
      const contract = record.contract as Record<string, unknown>;
      expect((contract.coverage as Record<string, unknown>).complete).toBe(true);
      const candidate = record.candidate as Record<string, unknown>;
      expect((candidate.artifacts as unknown[]).length).toBe(prepared.artifactIds.length);

      const inode = lstatSync(recordPath).ino;
      const replay = await acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      expect(replay.outcome).toBe("committed");
      expect(replay.acceptance!.acceptanceId).toBe(reference.acceptanceId);
      expect(lstatSync(recordPath).ino).toBe(inode);

      const inspected = await acceptanceOf(f).inspect(f.ctx, selector(f, prepared.deliveryId));
      expect(inspected.acceptance).toEqual(reference);
      expect(inspected.record.state).toBe("intact");
      expect(inspected.record.digestMatches).toBe(true);
      expect(inspected.delivery.state).toBe("intact");
    } finally {
      await f.cleanup();
    }
  });

  test("partial contract, fail outcome, missing receipt and changed delivery bytes are rejected", async () => {
    const noContract = await fixture();
    try {
      const run = await runSource(noContract);
      const artifactIds = run.artifacts.map((artifact) => artifact.artifactId);
      const delivery = await preview(noContract, run.runId, artifactIds);
      const submitted = await acceptanceOf(noContract).submit(noContract.ctx, selector(noContract, delivery.deliveryId));
      expect(submitted.outcome).toBe("not_committed");
      expect(submitted.operationCommitted).toBe(false);
      expect(submitted.taskAccepted).toBe(false);
      expect(noContract.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await noContract.cleanup();
    }

    const partial = await fixture();
    try {
      partial.entry.bindContract(partial.ctx, passSpec({
        coverage: { kind: "semantic", complete: false, coveredRevisions: [1], statement: "partial" },
      }));
      const run = await runSource(partial);
      const artifactIds = run.artifacts.map((artifact) => artifact.artifactId);
      const receiptId = await verify(partial, run.runId, artifactIds);
      const delivery = await preview(partial, run.runId, artifactIds, receiptId);
      const submitted = await acceptanceOf(partial).submit(partial.ctx, selector(partial, delivery.deliveryId));
      expect(submitted.outcome).toBe("not_committed");
      expect(submitted.reason).toContain("complete");
    } finally {
      await partial.cleanup();
    }

    const failing = await fixture({
      verifier: {
        id: "fixture-semantic",
        version: "1",
        check: () => ({ conditions: [{ conditionId: "answer", result: "fail", detail: "no" }] }),
      },
    });
    try {
      failing.entry.bindContract(failing.ctx, passSpec());
      const run = await runSource(failing);
      const artifactIds = run.artifacts.map((artifact) => artifact.artifactId);
      const receiptId = await verify(failing, run.runId, artifactIds);
      const delivery = await preview(failing, run.runId, artifactIds, receiptId);
      const submitted = await acceptanceOf(failing).submit(failing.ctx, selector(failing, delivery.deliveryId));
      expect(submitted.outcome).toBe("not_committed");
      expect(submitted.reason).toContain("not pass");
    } finally {
      await failing.cleanup();
    }

    const changed = await fixture();
    try {
      const prepared = await prepareAccepted(changed);
      chmodSync(prepared.files[0]!.path, 0o600);
      appendFileSync(prepared.files[0]!.path, "tampered");
      const submitted = await acceptanceOf(changed).submit(changed.ctx, selector(changed, prepared.deliveryId));
      expect(submitted.outcome).toBe("not_committed");
      expect(submitted.taskAccepted).toBe(false);
      expect(changed.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await changed.cleanup();
    }
  });

  test("busy execution blocks submit, and a reservation blocks admission and competing submits", async () => {
    const busy = await fixture();
    try {
      const prepared = await prepareAccepted(busy);
      const adapter = busy.entry.adapter as unknown as {
        dispatch: (...args: unknown[]) => Promise<Record<string, unknown>>;
      };
      const original = adapter.dispatch;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      adapter.dispatch = async (...args: unknown[]) => {
        const registerStop = args[6] as (stop: (reason: string) => void) => void;
        const onSpawned = args[7] as () => void;
        registerStop(() => undefined);
        onSpawned();
        await gate;
        return {
          spawned: true, spawnError: null, pid: 1234, pgid: 1234, exitCode: 0, signal: null,
          durationMs: 12, observedBytes: 0, retainedBytes: 0, decodedTextBytes: 0,
          droppedIncompleteBytes: 0, invalidEncoding: false, truncated: false,
          observedAfterRetentionBytes: 0, logText: "", stopReason: null,
          terminatedByHost: false, groupGone: true, groupCheckMs: 0, launchStage: "unknown",
          hostRecordError: null, childExitObserved: true,
        };
      };
      const task = busy.owner.snapshot().currentTask!;
      const running = busy.entry.adapter.run(busy.ctx, {
        action: "run", runtime: "python", source: "print('busy')\n", inputIds: [],
        expectedTaskId: task.taskId, expectedTaskRevision: task.taskRevision,
      });
      while (!busy.entry.adapter.activitySnapshot().busy) await new Promise((resolve) => setTimeout(resolve, 5));
      const submitted = await acceptanceOf(busy).submit(busy.ctx, selector(busy, prepared.deliveryId));
      expect(submitted.outcome).toBe("not_committed");
      expect(submitted.reason).toContain("busy");
      expect(busy.owner.snapshot().currentTask!.status).toBe("active");
      release();
      await running;
      adapter.dispatch = original;
    } finally {
      await busy.cleanup();
    }

    const reserved = await fixture();
    try {
      const prepared = await prepareAccepted(reserved);
      const delivery = reserved.entry.delivery!;
      const original = delivery.readAcceptanceEvidence.bind(delivery);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      delivery.readAcceptanceEvidence = async (...args) => {
        entered();
        await gate;
        return original(...args);
      };
      const first = acceptanceOf(reserved).submit(reserved.ctx, selector(reserved, prepared.deliveryId));
      await started;
      const denied = reserved.owner.admit(
        subject(reserved.branch),
        "local-script",
        guard(reserved.owner),
      );
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toContain("acceptance reservation");
      const competing = await acceptanceOf(reserved).submit(reserved.ctx, selector(reserved, prepared.deliveryId));
      expect(competing.outcome).toBe("not_committed");
      expect(competing.reason).toContain("reservation");
      release();
      const winner = await first;
      expect(winner.outcome).toBe("committed");
    } finally {
      await reserved.cleanup();
    }
  });

  test("cancel, navigation and a failing final evidence seal prevent acceptance", async () => {
    const cancelled = await fixture();
    try {
      const prepared = await prepareAccepted(cancelled);
      const delivery = cancelled.entry.delivery!;
      const original = delivery.readAcceptanceEvidence.bind(delivery);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      delivery.readAcceptanceEvidence = async (...args) => {
        entered();
        await gate;
        return original(...args);
      };
      const submitting = acceptanceOf(cancelled).submit(cancelled.ctx, selector(cancelled, prepared.deliveryId));
      await started;
      cancelled.owner.cancel(subject(cancelled.branch), guard(cancelled.owner));
      release();
      const result = await submitting;
      expect(result.outcome).toBe("not_committed");
      expect(result.taskAccepted).toBe(false);
      expect(cancelled.owner.snapshot().currentTask!.status).toBe("cancelled");
    } finally {
      await cancelled.cleanup();
    }

    const navigated = await fixture();
    try {
      const prepared = await prepareAccepted(navigated);
      const delivery = navigated.entry.delivery!;
      const original = delivery.readAcceptanceEvidence.bind(delivery);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      delivery.readAcceptanceEvidence = async (...args) => { entered(); await gate; return original(...args); };
      const submitting = acceptanceOf(navigated).submit(navigated.ctx, selector(navigated, prepared.deliveryId));
      await started;
      navigated.owner.navigate("session_switch");
      release();
      const result = await submitting;
      expect(result.outcome).toBe("not_committed");
      expect(navigated.owner.snapshot().currentTask!.status).toBe("active");
      expect(navigated.owner.bindingStatus().state).toBe("detached");
    } finally {
      await navigated.cleanup();
    }

    const sealed = await fixture();
    try {
      const prepared = await prepareAccepted(sealed);
      let mutated = false;
      const service = new AcceptanceService({
        owner: sealed.owner,
        delivery: sealed.entry.delivery!,
        activity: () => sealed.entry.adapter.activitySnapshot(),
        acceptanceRoot: sealed.acceptanceRoot,
        executionRoot: sealed.root,
        now: () => {
          if (!mutated) {
            mutated = true;
            chmodSync(prepared.files[0]!.path, 0o600);
            appendFileSync(prepared.files[0]!.path, "late mutation");
          }
          return NOW;
        },
      });
      try {
        const result = await service.submit(sealed.ctx, selector(sealed, prepared.deliveryId));
        expect(mutated).toBe(true);
        expect(result.outcome).toBe("not_committed");
        expect(result.reason).toContain("final evidence seal");
        expect(sealed.owner.snapshot().currentTask!.status).toBe("active");
        expect(() => statSync(path.join(sealed.acceptanceRoot, `record-${result.acceptance?.acceptanceId ?? "none"}.json`))).toThrow();
      } finally {
        service.dispose();
      }
    } finally {
      await sealed.cleanup();
    }
  });

  test("accepted inspect reports record and bundle damage separately while visible", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const submitted = await acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      expect(submitted.outcome).toBe("committed");
      const reference = submitted.acceptance!;
      const recordPath = path.join(f.acceptanceRoot, `record-${reference.acceptanceId}.json`);
      chmodSync(recordPath, 0o600);
      writeFileSync(recordPath, "{\"damaged\":true}");
      chmodSync(prepared.files[0]!.path, 0o600);
      rmSync(prepared.files[0]!.path);
      const inspected = await acceptanceOf(f).inspect(f.ctx, selector(f, prepared.deliveryId));
      expect(inspected.acceptance).toEqual(reference);
      expect(inspected.record.state).toBe("changed");
      expect(inspected.delivery.state).toBe("changed");
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");
    } finally {
      await f.cleanup();
    }
  });

  test("revision and abort while awaiting evidence keep the task active and never commit", async () => {
    const revised = await fixture();
    try {
      const prepared = await prepareAccepted(revised);
      revised.live.branch = [...revised.branch, user("user-2", "user-1", "Also include beta.")];
      revised.owner.sessionChanged(SESSION);
      const observed = revised.owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: revised.workspace,
        source: "rpc",
        text: "Also include beta.",
        observedAt: NOW,
        baseLeafId: "user-1",
      });
      expect(observed.accepted).toBe(true);
      expect(revised.owner.observeAgentStart({
        sessionId: SESSION, prompt: "Also include beta.", reason: "prompt",
      })).toBe(true);
      const delivery = revised.entry.delivery!;
      const original = delivery.readAcceptanceEvidence.bind(delivery);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      delivery.readAcceptanceEvidence = async (...args) => { entered(); await gate; return original(...args); };
      const submitting = acceptanceOf(revised).submit(revised.ctx, selector(revised, prepared.deliveryId));
      await started;
      const revision = revised.owner.revise(subject(revised.live.branch), guard(revised.owner), "amended");
      expect(revision.revised).toBe(true);
      release();
      const result = await submitting;
      expect(result.outcome).toBe("not_committed");
      expect(revised.owner.snapshot().currentTask!.status).toBe("active");
      expect(revised.owner.snapshot().currentTask!.taskRevision).toBe(2);
    } finally {
      await revised.cleanup();
    }

    const aborted = await fixture();
    try {
      const prepared = await prepareAccepted(aborted);
      const delivery = aborted.entry.delivery!;
      const original = delivery.readAcceptanceEvidence.bind(delivery);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      delivery.readAcceptanceEvidence = async (...args) => { entered(); await gate; return original(...args); };
      const controller = new AbortController();
      const submitting = acceptanceOf(aborted).submit(aborted.ctx, selector(aborted, prepared.deliveryId), controller.signal);
      await started;
      controller.abort();
      release();
      const result = await submitting;
      expect(result.outcome).toBe("not_committed");
      expect(result.taskAccepted).toBe(false);
      expect(aborted.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await aborted.cleanup();
    }
  });

  test("owner tokens are instance-bound, stale release cannot clear a newer reservation, and accepted replay is terminal", async () => {
    const f = await fixture();
    try {
      const task = f.owner.snapshot().currentTask!;
      const frozen = {
        ownerId: task.ownerId,
        taskId: task.taskId,
        taskRevision: task.taskRevision,
        requirementsDigest: requirementsDigest(task.requirementSources),
      };
      const first = f.owner.reserveAcceptance(subject(f.branch), frozen);
      expect(f.owner.reservationCurrent({ ...first })).toBe(false);
      const forgedPrepared = {};
      expect(() => f.owner.commitAccepted(first, forgedPrepared)).toThrow(/not issued/);
      expect(() => f.owner.reserveAcceptance(subject(f.branch), frozen)).toThrow(/reservation is active/);
      f.owner.releaseAcceptance(first);
      const second = f.owner.reserveAcceptance(subject(f.branch), frozen);
      f.owner.releaseAcceptance(first);
      expect(f.owner.reservationCurrent(second)).toBe(true);
      f.owner.releaseAcceptance(second);
      expect(f.owner.reservationCurrent(second)).toBe(false);
      const third = f.owner.reserveAcceptance(subject(f.branch), frozen);
      f.owner.sessionChanged(SESSION);
      expect(f.owner.reservationCurrent(third)).toBe(false);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await f.cleanup();
    }
  });

  test("an accepted task rejects cancel, revise, admission, execution, restart and replacement", async () => {
    const f = await fixture();
    try {
      const task = f.owner.snapshot().currentTask!;
      const prepared = await prepareAccepted(f);
      const accepted = await acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      expect(accepted.outcome).toBe("committed");
      const acceptedId = accepted.acceptance!.acceptanceId;
      expect(() => f.owner.cancel(subject(f.branch), guard(f.owner))).toThrow(/accepted.*terminal/);
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");
      const sameStart = f.owner.start(subject(f.branch));
      expect(sameStart.created).toBe(false);
      expect(sameStart.task.status).toBe("accepted");
      const denied = f.owner.admit(subject(f.branch), "local-script", guard(f.owner));
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toContain("accepted");
      const executed = await f.entry.adapter.run(f.ctx, {
        action: "run", runtime: "python", source: "print('no')\n", inputIds: [],
        expectedTaskId: task.taskId, expectedTaskRevision: task.taskRevision,
      });
      expect(executed.isError).toBe(true);
      const replay = await acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      expect(replay.outcome).toBe("committed");
      expect(replay.acceptance!.acceptanceId).toBe(acceptedId);
      const different = await acceptanceOf(f).submit(f.ctx, {
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
        deliveryId: "delivery-other",
      });
      expect(different.outcome).toBe("not_committed");
      expect(different.taskAccepted).toBe(true);
      expect(different.acceptance).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  test("an accepted task stays immutable history while a later genuine message starts a new task", async () => {
    const f = await fixture();
    try {
      const acceptedTask = f.owner.snapshot().currentTask!;
      const prepared = await prepareAccepted(f);
      const accepted = await acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      expect(accepted.outcome).toBe("committed");
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");

      const firstUser = f.branch[1] as Entry;
      const assistantEntry: Entry = {
        id: "assistant-next",
        parentId: firstUser.id,
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "accepted" }], attribution: "agent" },
      };
      const nextUser = user("user-next", "assistant-next", "Start a separate follow-up task.");
      const nextBranch = [...f.branch, assistantEntry, nextUser];
      expect(f.owner.closeTurn({
        sessionId: SESSION,
        branch: f.branch,
        messages: [{ ...(firstUser.message as Record<string, unknown>), id: firstUser.id }],
      })).toBe(true);
      expect(f.owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: f.workspace,
        source: "rpc",
        text: "Start a separate follow-up task.",
        observedAt: NOW,
        baseLeafId: "assistant-next",
      }).accepted).toBe(true);
      f.owner.observeAgentStart({
        sessionId: SESSION,
        prompt: "Start a separate follow-up task.",
        reason: "prompt",
      });
      const next = f.owner.start(subject(nextBranch));
      expect(next.created).toBe(true);
      expect(next.task.taskId).not.toBe(acceptedTask.taskId);
      expect(next.task.status).toBe("active");
      expect(f.owner.snapshot().currentTask!.taskId).toBe(next.task.taskId);

      const history = f.owner.historyPage(subject(nextBranch), 0, 16);
      expect(history.rows[0]).toMatchObject({
        taskId: acceptedTask.taskId,
        status: "accepted",
        acceptanceId: accepted.acceptance!.acceptanceId,
        current: false,
      });
      const inspected = f.owner.inspectTarget(subject(nextBranch), {
        taskId: acceptedTask.taskId,
        taskRevision: acceptedTask.taskRevision,
      });
      expect(inspected.historical).toBe(true);
      expect(inspected.target.status).toBe("accepted");
      expect(inspected.target.acceptance?.acceptanceId).toBe(accepted.acceptance!.acceptanceId);
      expect(f.owner.acceptedReference(acceptedTask.taskId)?.acceptanceId)
        .toBe(accepted.acceptance!.acceptanceId);
      expect(f.owner.snapshot().currentTask!.taskId).toBe(next.task.taskId);
    } finally {
      await f.cleanup();
    }
  });

  test("postcommit navigation keeps committed truth but loses current visibility", async () => {
    let ownerRef: TaskOwner | undefined;
    const f = await fixture({
      onEvent: (event) => {
        if (event.type === "task_accepted") ownerRef?.navigate("session_switch");
      },
    });
    ownerRef = f.owner;
    try {
      const prepared = await prepareAccepted(f);
      const submitted = await acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      expect(submitted.outcome).toBe("committed");
      expect(submitted.operationCommitted).toBe(true);
      expect(submitted.taskAccepted).toBe(true);
      expect(submitted.current.state).toBe("detached");
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");

      const reference = submitted.acceptance!;
      const withheld = await acceptanceOf(f).inspect(f.ctx, selector(f, prepared.deliveryId));
      expect(withheld.acceptance).toBeNull();
      expect(withheld.record.state).toBe("unavailable");
      expect(withheld.delivery.state).toBe("unavailable");
      expect(withheld.current.state).toBe("detached");
      expect(f.owner.acceptedReference(f.owner.snapshot().currentTask!.taskId)).toEqual(reference);
    } finally {
      await f.cleanup();
    }
  });

  test("successful installation with failing postcommit notification remains accepted and is never rewritten", async () => {
    let fail = true;
    const f = await fixture({
      onEvent: (event) => {
        if (fail && event.type === "task_accepted") throw new Error("postcommit audit failed");
      },
    });
    try {
      const prepared = await prepareAccepted(f);
      const submitted = await acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      expect(submitted.outcome).toBe("committed");
      expect(submitted.operationCommitted).toBe(true);
      expect(submitted.taskAccepted).toBe(true);
      expect(submitted.warnings.some((warning) => warning.includes("postcommit_notification_failed"))).toBe(true);
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");
      const recordPath = path.join(f.acceptanceRoot, `record-${submitted.acceptance!.acceptanceId}.json`);
      const inode = lstatSync(recordPath).ino;
      fail = false;
      const replay = await acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      expect(replay.outcome).toBe("committed");
      expect(replay.acceptance!.acceptanceId).toBe(submitted.acceptance!.acceptanceId);
      expect(lstatSync(recordPath).ino).toBe(inode);
    } finally {
      await f.cleanup();
    }
  });

  test("preexisting record collisions, root overlap and root replacement are refused without deletion", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const foreignPath = path.join(f.acceptanceRoot, "record-acceptance-fixed.json");
      writeFileSync(foreignPath, "{\"foreign\":true}", { mode: 0o400 });
      const service = new AcceptanceService({
        owner: f.owner,
        delivery: f.entry.delivery!,
        activity: () => f.entry.adapter.activitySnapshot(),
        acceptanceRoot: f.acceptanceRoot,
        executionRoot: f.root,
        id: () => "fixed",
      });
      try {
        const result = await service.submit(f.ctx, selector(f, prepared.deliveryId));
        expect(result.outcome).toBe("not_committed");
        expect(readFileSync(foreignPath, "utf8")).toBe("{\"foreign\":true}");
        expect(f.owner.snapshot().currentTask!.status).toBe("active");
      } finally {
        service.dispose();
      }
      expect(() => resolveAcceptanceRoot(f.acceptanceRoot, f.root, f.deliveryRoot)).not.toThrow();
      expect(() => resolveAcceptanceRoot(path.join(f.deliveryRoot, "nested"), f.root, f.deliveryRoot)).toThrow(/overlap/);
    } finally {
      await f.cleanup();
    }

    const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-store-")));
    const execution = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-exec-")));
    const delivery = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-dstore-")));
    try {
      const info = resolveAcceptanceRoot(root, execution, delivery);
      const prepared = prepareAcceptanceRecord({
        root: info,
        acceptanceId: "acceptance-root-swap",
        deliveryId: "delivery-root-swap",
        acceptedAt: NOW,
        task: {
          ownerId: "owner-root-swap",
          taskId: "task-root-swap",
          taskRevision: 1,
          requirementsDigest: "requirements-digest-v1:sha256:" + "a".repeat(64),
        },
        record: { version: "fixture" },
      });
      const old = `${root}-old`;
      renameSync(root, old);
      mkdirSync(root, { mode: 0o700 });
      const installed = installPreparedAcceptanceRecordSync(prepared);
      expect(installed.status).toBe("not_installed");
      expect(installed.recordPath).toBeNull();
      expect(() => lstatSync(path.join(root, "record-acceptance-root-swap.json"))).toThrow();
    } finally {
      rmSync(`${root}-old`, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(execution, { recursive: true, force: true });
      rmSync(delivery, { recursive: true, force: true });
    }
  });

  test("installed record identity rejects same-byte replacement and preserves foreign targets", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-store2-")));
    const execution = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-exec2-")));
    const delivery = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-dstore2-")));
    try {
      const info = resolveAcceptanceRoot(root, execution, delivery);
      const prepared = prepareAcceptanceRecord({
        root: info,
        acceptanceId: "acceptance-identity",
        deliveryId: "delivery-identity",
        acceptedAt: NOW,
        task: {
          ownerId: "owner-identity",
          taskId: "task-identity",
          taskRevision: 1,
          requirementsDigest: "requirements-digest-v1:sha256:" + "b".repeat(64),
        },
        record: { version: "fixture", value: 1 },
      });
      const installed = installPreparedAcceptanceRecordSync(prepared);
      expect(installed.status).toBe("installed");
      const recordPath = path.join(root, "record-acceptance-identity.json");
      expect(readAcceptanceRecord(info, "acceptance-identity").state).toBe("intact");
      const bytes = readFileSync(recordPath);
      renameSync(recordPath, `${recordPath}.old`);
      writeFileSync(recordPath, bytes, { mode: 0o400 });
      const replaced = readAcceptanceRecord(info, "acceptance-identity");
      expect(replaced.state).toBe("changed");
      expect(replaced.digest).toBe(sha256(bytes));
      void copyFileSync;

      const second = prepareAcceptanceRecord({
        root: info,
        acceptanceId: "acceptance-foreign",
        deliveryId: "delivery-foreign",
        acceptedAt: NOW,
        task: {
          ownerId: "owner-foreign",
          taskId: "task-foreign",
          taskRevision: 1,
          requirementsDigest: "requirements-digest-v1:sha256:" + "c".repeat(64),
        },
        record: { version: "fixture", value: 2 },
      });
      const foreign = path.join(root, "record-acceptance-foreign.json");
      writeFileSync(foreign, "{\"foreign\":true}", { mode: 0o400 });
      const refused = installPreparedAcceptanceRecordSync(second);
      expect(refused.status).toBe("conflict");
      expect(readFileSync(foreign, "utf8")).toBe("{\"foreign\":true}");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(execution, { recursive: true, force: true });
      rmSync(delivery, { recursive: true, force: true });
    }
  });

  test("store registration is scoped by root identity for the same acceptance id", async () => {
    const rootA = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-scope-a-")));
    const rootB = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-scope-b-")));
    const executionA = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-scope-ea-")));
    const executionB = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-scope-eb-")));
    const deliveryA = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-scope-da-")));
    const deliveryB = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-scope-db-")));
    try {
      const a = resolveAcceptanceRoot(rootA, executionA, deliveryA);
      const b = resolveAcceptanceRoot(rootB, executionB, deliveryB);
      const task = {
        ownerId: "owner-scope",
        taskId: "task-scope",
        taskRevision: 1,
        requirementsDigest: "requirements-digest-v1:sha256:" + "d".repeat(64),
      };
      const first = prepareAcceptanceRecord({
        root: a, acceptanceId: "acceptance-shared-id", deliveryId: "delivery-scope-a",
        acceptedAt: NOW, task, record: { version: "scope", root: "a" },
      });
      const second = prepareAcceptanceRecord({
        root: b, acceptanceId: "acceptance-shared-id", deliveryId: "delivery-scope-b",
        acceptedAt: NOW, task, record: { version: "scope", root: "b" },
      });
      expect(installPreparedAcceptanceRecordSync(first).status).toBe("installed");
      expect(installPreparedAcceptanceRecordSync(second).status).toBe("installed");
      const readA = readAcceptanceRecord(a, "acceptance-shared-id", task);
      const readB = readAcceptanceRecord(b, "acceptance-shared-id", task);
      expect(readA.state).toBe("intact");
      expect(readB.state).toBe("intact");
      expect(readA.digest).not.toBe(readB.digest);
      const wrongBinding = readAcceptanceRecord(a, "acceptance-shared-id", { ...task, taskId: "task-other" });
      expect(wrongBinding.state).toBe("unavailable");
    } finally {
      for (const directory of [rootA, rootB, executionA, executionB, deliveryA, deliveryB]) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test("caller-shaped acceptance roots cannot bypass canonical ancestry proof", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-forged-")));
    const execution = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-forged-e-")));
    const delivery = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-forged-d-")));
    try {
      const info = resolveAcceptanceRoot(root, execution, delivery);
      const task = {
        ownerId: "owner-forged",
        taskId: "task-forged",
        taskRevision: 1,
        requirementsDigest: "requirements-digest-v1:sha256:" + "e".repeat(64),
      };
      const truncated = { ...info, chain: info.chain.slice(0, -1) };
      expect(() => prepareAcceptanceRecord({
        root: truncated, acceptanceId: "acceptance-forged-t", deliveryId: "delivery-forged",
        acceptedAt: NOW, task, record: { version: "forged" },
      })).toThrow(/leaf|ancestry/);
      const mutatedInfo = {
        ...info,
        chain: info.chain.map((entry, index) => index === info.chain.length - 1
          ? { ...entry, ino: entry.ino + 1 }
          : entry),
      };
      expect(() => prepareAcceptanceRecord({
        root: mutatedInfo, acceptanceId: "acceptance-forged-i", deliveryId: "delivery-forged",
        acceptedAt: NOW, task, record: { version: "forged" },
      })).toThrow(/changed|ancestry/);
    } finally {
      for (const directory of [root, execution, delivery]) rmSync(directory, { recursive: true, force: true });
    }
  });

  test("active submit reserves before its first await and blocks same-stack admission", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const pending = acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      const task = f.owner.snapshot().currentTask!;
      const denied = f.owner.admit(subject(f.branch), "local-script", guard(f.owner));
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toContain("acceptance reservation");
      const result = await pending;
      expect(result.outcome).toBe("committed");
      expect(result.operationCommitted).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("unknown installation facts stay durable and are never relabeled as a known refusal", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const task = f.owner.snapshot().currentTask!;
      const reason = "injected link outcome could not be classified";
      const hazard = {
        task: {
          ownerId: task.ownerId,
          taskId: task.taskId,
          taskRevision: task.taskRevision,
          requirementsDigest: requirementsDigest(task.requirementSources),
        },
        acceptanceId: "acceptance-unknown-fixture",
        deliveryId: prepared.deliveryId,
        recordDigest: "sha256:" + "f".repeat(64),
        reason,
      };
      (f.owner as unknown as { acceptanceHazard: unknown }).acceptanceHazard = hazard;
      const snapshot = f.owner.snapshot();
      expect(snapshot.acceptanceHazard).toEqual(hazard);

      const retry = await acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      expect(retry.outcome).toBe("unknown");
      expect(retry.operationCommitted).toBeNull();
      expect(retry.taskAccepted).toBeNull();
      expect(retry.acceptance).toBeNull();
      expect(retry.unknown).toEqual(hazard);
      expect(retry.current.state).toBe("unknown");
      expect(retry.current.accepted).toBeNull();

      const different = await acceptanceOf(f).submit(f.ctx, {
        ...selector(f, prepared.deliveryId),
        deliveryId: "delivery-different",
      });
      expect(different.outcome).toBe("unknown");
      expect(different.taskAccepted).toBeNull();

      const denied = f.owner.admit(subject(f.branch), "local-script", guard(f.owner));
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toContain("unknown");

      f.owner.navigate("session_switch");
      expect(f.owner.snapshot().acceptanceHazard).toEqual(hazard);
      const inspected = await acceptanceOf(f).inspect(f.ctx, selector(f, prepared.deliveryId));
      expect(inspected.record.state).toBe("unknown");
      expect(inspected.delivery.state).toBe("unknown");
      expect(inspected.acceptance).toBeNull();
      expect(inspected.unknown?.acceptanceId).toBe(hazard.acceptanceId);
      expect(inspected.current.state).toBe("unknown");
    } finally {
      await f.cleanup();
    }
  });

  test("evidence aliases mutated after eligibility cannot change the accepted record", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const delivery = f.entry.delivery!;
      const original = delivery.readAcceptanceEvidence.bind(delivery);
      let alias: { receipt: { conditions: Array<{ conditionId: string; result: string }> } | null } | null = null;
      delivery.readAcceptanceEvidence = async (...args) => {
        const read = await original(...args);
        alias = read.evidence as unknown as typeof alias;
        return read;
      };
      const service = new AcceptanceService({
        owner: f.owner,
        delivery,
        activity: () => f.entry.adapter.activitySnapshot(),
        acceptanceRoot: f.acceptanceRoot,
        executionRoot: f.root,
        now: () => NOW,
        id: () => {
          if (alias !== null && alias.receipt !== null) alias.receipt.conditions[0]!.result = "fail";
          return "alias-mutation-id";
        },
      });
      const result = await service.submit(f.ctx, selector(f, prepared.deliveryId));
      expect(result.outcome).toBe("committed");
      expect(alias).not.toBeNull();
      expect(alias!.receipt!.conditions[0]!.result).toBe("fail");
      const recordPath = path.join(f.acceptanceRoot, `record-${result.acceptance!.acceptanceId}.json`);
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
        receipt: { receipt: { conditions: Array<{ result: string }> }; digest: string };
        contract: { digest: string };
      };
      expect(record.receipt.receipt.conditions[0]!.result).toBe("pass");
      expect(record.receipt.digest).toBe(sha256(JSON.stringify(record.receipt.receipt)));
      expect(result.acceptance!.recordDigest).toBe(sha256(readFileSync(recordPath)));
    } finally {
      await f.cleanup();
    }
  });

  test("disposing the issuing delivery before seal fails closed without a record", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const delivery = f.entry.delivery!;
      const service = new AcceptanceService({
        owner: f.owner,
        delivery,
        activity: () => f.entry.adapter.activitySnapshot(),
        acceptanceRoot: f.acceptanceRoot,
        executionRoot: f.root,
        now: () => {
          delivery.dispose();
          return NOW;
        },
        id: () => "disposed-seal-id",
      });
      const result = await service.submit(f.ctx, selector(f, prepared.deliveryId));
      expect(result.outcome).toBe("not_committed");
      expect(result.operationCommitted).toBe(false);
      expect(result.reason).toContain("seal");
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
      expect(() => lstatSync(path.join(f.acceptanceRoot, "record-acceptance-disposed-seal-id.json"))).toThrow();
    } finally {
      await f.cleanup();
    }
  });

  test("accepted inspect withholds data if the service is disposed during its await", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const service = acceptanceOf(f);
      const committed = await service.submit(f.ctx, selector(f, prepared.deliveryId));
      expect(committed.outcome).toBe("committed");
      const reference = committed.acceptance!;
      const delivery = f.entry.delivery!;
      const original = delivery.inspectAcceptedDelivery.bind(delivery);
      delivery.inspectAcceptedDelivery = async (...args) => {
        const result = await original(...args);
        service.dispose();
        return result;
      };
      const inspected = await service.inspect(f.ctx, selector(f, prepared.deliveryId));
      expect(inspected.acceptance).toBeNull();
      expect(inspected.record.state).toBe("unavailable");
      expect(inspected.delivery.state).toBe("unavailable");
      expect(inspected.current.state).toBe("unavailable");
      expect(f.owner.acceptedReference(f.owner.snapshot().currentTask!.taskId)).toEqual(reference);
    } finally {
      await f.cleanup();
    }
  });

  test("postcommit getter replacing the published owner withholds current visibility only", async () => {
    let accepted = false;
    const f = await fixture({
      onEvent: (event) => {
        if (event.type === "task_accepted") accepted = true;
      },
    });
    let replacement: TaskOwner | undefined;
    let replaced = false;
    const liveContext = context(() => {
      if (accepted && !replaced) {
        replaced = true;
        replacement = new TaskOwner({
          workspaceRoot: f.workspace,
          ownerId: "owner-replacement-fixture",
          authorizedCapabilities: ["local-script"],
          now: () => NOW,
          id: () => "replacement-id",
        });
        publishTaskOwner(replacement);
      }
      return f.live.branch;
    });
    try {
      const prepared = await prepareAccepted(f);
      const result = await acceptanceOf(f).submit(liveContext, selector(f, prepared.deliveryId));
      expect(result.outcome).toBe("committed");
      expect(result.operationCommitted).toBe(true);
      expect(result.taskAccepted).toBe(true);
      expect(result.current).toEqual({
        state: "unavailable", taskId: null, status: null, accepted: null,
        reason: "the published task owner changed",
      });
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");
      expect(replacement).toBeDefined();
    } finally {
      await f.cleanup();
    }
  });

  test("unknown early visibility is withheld after getter owner replacement or disposal", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const task = f.owner.snapshot().currentTask!;
      const hazard = {
        task: {
          ownerId: task.ownerId,
          taskId: task.taskId,
          taskRevision: task.taskRevision,
          requirementsDigest: requirementsDigest(task.requirementSources),
        },
        acceptanceId: "acceptance-early-unknown-fixture",
        deliveryId: prepared.deliveryId,
        recordDigest: "sha256:" + "b".repeat(64),
        reason: "injected postcommit unknown installation outcome",
      };
      f.owner.commitAccepted = () => {
        (f.owner as unknown as { acceptanceHazard: unknown }).acceptanceHazard = hazard;
        return {
          status: "unknown" as const,
          reason: hazard.reason,
          warnings: [],
          acceptance: null,
          operationCommitted: null,
        };
      };
      let replacement: TaskOwner | undefined;
      let replaced = false;
      const liveContext = context(() => {
        if (!replaced && f.owner.snapshot().acceptanceHazard !== null) {
          replaced = true;
          replacement = new TaskOwner({
            workspaceRoot: f.workspace,
            ownerId: "owner-early-replacement-fixture",
            authorizedCapabilities: ["local-script"],
            now: () => NOW,
            id: () => "early-replacement-id",
          });
          publishTaskOwner(replacement);
        }
        return f.live.branch;
      });
      const replacedResult = await acceptanceOf(f).submit(liveContext, selector(f, prepared.deliveryId));
      expect(replaced).toBe(true);
      expect(replacedResult.outcome).toBe("unknown");
      expect(replacedResult.operationCommitted).toBeNull();
      expect(replacedResult.taskAccepted).toBeNull();
      expect(replacedResult.acceptance).toBeNull();
      expect(replacedResult.unknown).toEqual(hazard);
      expect(replacedResult.current).toEqual({
        state: "unavailable", taskId: null, status: null, accepted: null,
        reason: "the published task owner changed",
      });
      expect(f.owner.snapshot().acceptanceHazard).toEqual(hazard);
      expect(replacement!.snapshot().currentTask).toBeNull();

      publishTaskOwner(f.owner);
      (f.owner as unknown as { acceptanceHazard: unknown }).acceptanceHazard = undefined;
      const disposing = new AcceptanceService({
        owner: f.owner,
        delivery: f.entry.delivery!,
        activity: () => f.entry.adapter.activitySnapshot(),
        acceptanceRoot: f.acceptanceRoot,
        executionRoot: f.root,
        now: () => NOW,
        id: () => "early-dispose-id",
      });
      let disposed = false;
      const disposeContext = context(() => {
        if (!disposed && f.owner.snapshot().acceptanceHazard !== null) {
          disposed = true;
          disposing.dispose();
        }
        return f.live.branch;
      });
      const disposedResult = await disposing.submit(disposeContext, selector(f, prepared.deliveryId));
      expect(disposed).toBe(true);
      expect(disposedResult.outcome).toBe("unknown");
      expect(disposedResult.operationCommitted).toBeNull();
      expect(disposedResult.taskAccepted).toBeNull();
      expect(disposedResult.acceptance).toBeNull();
      expect(disposedResult.unknown).toEqual(hazard);
      expect(disposedResult.current).toEqual({
        state: "unavailable", taskId: null, status: null, accepted: null,
        reason: "the acceptance service is disposed",
      });
      expect(f.owner.snapshot().acceptanceHazard).toEqual(hazard);
      expect(replacement!.snapshot().currentTask).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  test("stored unknown facts require the exact main task and selector on every later call", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const task = f.owner.snapshot().currentTask!;
      const hazard = {
        task: {
          ownerId: task.ownerId,
          taskId: task.taskId,
          taskRevision: task.taskRevision,
          requirementsDigest: requirementsDigest(task.requirementSources),
        },
        acceptanceId: "acceptance-hazard-authority",
        deliveryId: prepared.deliveryId,
        recordDigest: "sha256:" + "a".repeat(64),
        reason: "injected unknown installation outcome",
      };
      (f.owner as unknown as { acceptanceHazard: unknown }).acceptanceHazard = hazard;
      const service = acceptanceOf(f);
      const exact = selector(f, prepared.deliveryId);

      const authorized = await service.submit(f.ctx, exact);
      expect(authorized.outcome).toBe("unknown");
      expect(authorized.operationCommitted).toBeNull();
      expect(authorized.taskAccepted).toBeNull();
      expect(authorized.acceptance).toBeNull();
      expect(authorized.unknown).toEqual(hazard);
      expect(authorized.current.state).toBe("unknown");
      authorized.unknown!.task.taskId = "mutated-hazard-task";
      authorized.unknown!.reason = "mutated-hazard-reason";
      expect(f.owner.snapshot().acceptanceHazard).toEqual(hazard);

      const inspected = await service.inspect(f.ctx, exact);
      expect(inspected.acceptance).toBeNull();
      expect(inspected.record.state).toBe("unknown");
      expect(inspected.delivery.state).toBe("unknown");
      expect(inspected.unknown).toEqual(hazard);
      expect(inspected.current.state).toBe("unknown");
      inspected.unknown!.acceptanceId = "mutated-hazard-acceptance";
      expect(f.owner.snapshot().acceptanceHazard).toEqual(hazard);

      const wrongSession: OmpToolContext = {
        ...f.ctx,
        sessionManager: {
          getSessionId: () => "g2b2b1-other-session",
          getLeafId: () => null,
          getBranch: () => f.live.branch,
        },
      };
      const withheldSubmit = await service.submit(wrongSession, exact);
      expect(withheldSubmit.outcome).toBe("unknown");
      expect(withheldSubmit.operationCommitted).toBeNull();
      expect(withheldSubmit.taskAccepted).toBeNull();
      expect(withheldSubmit.unknown).toBeUndefined();
      expect(withheldSubmit.current.state).toBe("unavailable");
      expect(JSON.stringify(withheldSubmit)).not.toContain(hazard.acceptanceId);
      expect(JSON.stringify(withheldSubmit)).not.toContain(hazard.recordDigest);
      const withheldInspect = await service.inspect(wrongSession, exact);
      expect(withheldInspect.acceptance).toBeNull();
      expect(withheldInspect.record.state).toBe("unavailable");
      expect(withheldInspect.delivery.state).toBe("unavailable");
      expect(withheldInspect.unknown).toBeUndefined();
      expect(withheldInspect.current.state).toBe("unavailable");
      expect(JSON.stringify(withheldInspect)).not.toContain(hazard.acceptanceId);

      const subagent = await service.submit({ ...f.ctx, agent: { kind: "sub" } }, exact);
      expect(subagent.outcome).toBe("unknown");
      expect(subagent.taskAccepted).toBeNull();
      expect(subagent.unknown).toBeUndefined();
      expect(subagent.current.state).toBe("unavailable");
      expect(JSON.stringify(subagent)).not.toContain(hazard.acceptanceId);
      expect(JSON.stringify(subagent)).not.toContain(hazard.recordDigest);

      const differentSelector = await service.submit(f.ctx, { ...exact, deliveryId: "delivery-unrelated" });
      expect(differentSelector.outcome).toBe("unknown");
      expect(differentSelector.taskAccepted).toBeNull();
      expect(differentSelector.unknown).toBeUndefined();
      expect(differentSelector.current.state).toBe("unavailable");
      expect(JSON.stringify(differentSelector)).not.toContain(hazard.acceptanceId);
      expect(JSON.stringify(differentSelector)).not.toContain(hazard.recordDigest);

      const replacement = new TaskOwner({
        workspaceRoot: f.workspace,
        ownerId: "owner-hazard-foreign",
        authorizedCapabilities: ["local-script"],
        now: () => NOW,
        id: () => "hazard-foreign-id",
      });
      publishTaskOwner(replacement);
      try {
        const foreign = await service.submit(f.ctx, exact);
        expect(foreign.outcome).toBe("unknown");
        expect(foreign.taskAccepted).toBeNull();
        expect(foreign.unknown).toBeUndefined();
        expect(foreign.current.state).toBe("unavailable");
        expect(JSON.stringify(foreign)).not.toContain(hazard.acceptanceId);
        expect(JSON.stringify(foreign)).not.toContain(hazard.recordDigest);
        const foreignInspect = await service.inspect(f.ctx, exact);
        expect(foreignInspect.unknown).toBeUndefined();
        expect(foreignInspect.current.state).toBe("unavailable");
        expect(JSON.stringify(foreignInspect)).not.toContain(hazard.acceptanceId);
      } finally {
        publishTaskOwner(f.owner);
      }

      expect(f.owner.snapshot().acceptanceHazard).toEqual(hazard);
      expect(f.owner.admit(subject(f.branch), "local-script", guard(f.owner)).allowed).toBe(false);
      expect(() => f.owner.cancel(subject(f.branch), guard(f.owner))).toThrow(/unknown/i);
      expect(() => f.owner.revise(subject(f.branch), guard(f.owner))).toThrow(/unknown/i);
      f.owner.navigate("session_switch");
      const afterNavigation = await service.inspect(f.ctx, exact);
      expect(afterNavigation.unknown).toEqual(hazard);
      expect(afterNavigation.record.state).toBe("unknown");
      expect(f.owner.snapshot().acceptanceHazard).toEqual(hazard);
    } finally {
      await f.cleanup();
    }
  });

  test("resolved root ancestry is privately pinned against copied descriptors and parent replacement", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-pinned-")));
    const execution = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-pinned-e-")));
    const delivery = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-pinned-d-")));
    const parent = path.join(base, "parent");
    const root = path.join(parent, "acceptance");
    try {
      mkdirSync(parent, { mode: 0o700 });
      mkdirSync(root, { mode: 0o700 });
      const info = resolveAcceptanceRoot(root, execution, delivery);
      expect(Object.isFrozen(info)).toBe(true);
      expect(Object.isFrozen(info.chain)).toBe(true);
      expect(info.chain.every((entry) => Object.isFrozen(entry))).toBe(true);
      expect(() => { (info as unknown as { dev: number }).dev = 1; }).toThrow(TypeError);
      expect(() => {
        (info.chain[0] as unknown as { dev: number }).dev = 1;
      }).toThrow(TypeError);
      const task = {
        ownerId: "owner-pinned",
        taskId: "task-pinned",
        taskRevision: 1,
        requirementsDigest: "requirements-digest-v1:sha256:" + "f".repeat(64),
      };
      const first = prepareAcceptanceRecord({
        root: info,
        acceptanceId: "acceptance-pinned",
        deliveryId: "delivery-pinned",
        acceptedAt: NOW,
        task,
        record: { version: "pinned", value: 1 },
      });
      expect(installPreparedAcceptanceRecordSync(first).status).toBe("installed");
      expect(readAcceptanceRecord(info, "acceptance-pinned", task).state).toBe("intact");
      const second = prepareAcceptanceRecord({
        root: info,
        acceptanceId: "acceptance-pinned-late",
        deliveryId: "delivery-pinned-late",
        acceptedAt: NOW,
        task,
        record: { version: "pinned", value: 2 },
      });
      const originalParent = lstatSync(parent);
      const oldParent = path.join(base, "parent-old");
      renameSync(parent, oldParent);
      mkdirSync(parent, { mode: 0o700 });
      renameSync(path.join(oldParent, "acceptance"), root);
      const replacementParent = lstatSync(parent);
      expect(replacementParent.ino).not.toBe(originalParent.ino);
      expect(lstatSync(root).ino).toBe(info.ino);
      expect(readAcceptanceRecord(info, "acceptance-pinned", task).state).toBe("unavailable");
      expect(installPreparedAcceptanceRecordSync(second).status).toBe("not_installed");
      const forged = {
        ...info,
        chain: info.chain.map((entry) => entry.path === parent
          ? { path: parent, dev: replacementParent.dev, ino: replacementParent.ino }
          : { ...entry }),
      };
      expect(readAcceptanceRecord(forged, "acceptance-pinned", task).state).toBe("unavailable");
      expect(() => prepareAcceptanceRecord({
        root: forged,
        acceptanceId: "acceptance-pinned-forged",
        deliveryId: "delivery-pinned-forged",
        acceptedAt: NOW,
        task,
        record: { version: "forged", value: 3 },
      })).toThrow(/ancestry/);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(execution, { recursive: true, force: true });
      rmSync(delivery, { recursive: true, force: true });
    }
  });

  test("oversized host timestamps are rejected before install and every result stays under 64 KiB", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const hugeTimestamp = `${" ".repeat(70_000)}2026-11-08`;
      const service = new AcceptanceService({
        owner: f.owner,
        delivery: f.entry.delivery!,
        activity: () => f.entry.adapter.activitySnapshot(),
        acceptanceRoot: f.acceptanceRoot,
        executionRoot: f.root,
        now: () => hugeTimestamp,
        id: () => "long-timestamp",
      });
      try {
        const result = await service.submit(f.ctx, selector(f, prepared.deliveryId));
        expect(result.outcome).toBe("not_committed");
        expect(result.operationCommitted).toBe(false);
        expect(result.taskAccepted).toBe(false);
        expect(result.acceptance).toBeNull();
        expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(64 * 1024);
        expect(JSON.stringify(result)).not.toContain(" ".repeat(100));
        expect(f.owner.snapshot().currentTask!.status).toBe("active");
        expect(() => lstatSync(path.join(f.acceptanceRoot, "record-acceptance-long-timestamp.json"))).toThrow();
      } finally {
        service.dispose();
      }

      const canonical = new AcceptanceService({
        owner: f.owner,
        delivery: f.entry.delivery!,
        activity: () => f.entry.adapter.activitySnapshot(),
        acceptanceRoot: f.acceptanceRoot,
        executionRoot: f.root,
        now: () => NOW,
        id: () => "canonical-timestamp",
      });
      try {
        const committed = await canonical.submit(f.ctx, selector(f, prepared.deliveryId));
        expect(committed.outcome).toBe("committed");
        expect(committed.operationCommitted).toBe(true);
        expect(committed.acceptance!.acceptedAt).toBe(NOW);
        expect(Buffer.byteLength(JSON.stringify(committed), "utf8")).toBeLessThanOrEqual(64 * 1024);
        const recordPath = path.join(f.acceptanceRoot, `record-${committed.acceptance!.acceptanceId}.json`);
        const record = JSON.parse(readFileSync(recordPath, "utf8")) as { acceptedAt: string };
        expect(record.acceptedAt).toBe(NOW);
        const inspected = await canonical.inspect(f.ctx, selector(f, prepared.deliveryId));
        expect(inspected.acceptance!.acceptedAt).toBe(NOW);
        expect(Buffer.byteLength(JSON.stringify(inspected), "utf8")).toBeLessThanOrEqual(64 * 1024);
      } finally {
        canonical.dispose();
      }
    } finally {
      await f.cleanup();
    }
  });

  test("oversized selector diagnostics stay inside the 64 KiB UTF-8 response envelope", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const hugeKey = "差".repeat(40_000);
      const hugeSelector = { ...selector(f, prepared.deliveryId), [hugeKey]: true };
      const submitted = await acceptanceOf(f).submit(f.ctx, hugeSelector);
      expect(submitted.outcome).toBe("not_committed");
      expect(Buffer.byteLength(JSON.stringify(submitted), "utf8")).toBeLessThanOrEqual(64 * 1024);
      expect(JSON.stringify(submitted)).not.toContain("差差");
      const inspected = await acceptanceOf(f).inspect(f.ctx, hugeSelector);
      expect(Buffer.byteLength(JSON.stringify(inspected), "utf8")).toBeLessThanOrEqual(64 * 1024);
      expect(inspected.current.state).toBe("visible");
    } finally {
      await f.cleanup();
    }
  });

  test("accepted history and damaged copies are reported separately without claiming paths", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const first = modelJson(await submitTool(f, prepared.deliveryId));
      const acceptanceId = first.acceptance.acceptanceId as string;
      const recordPath = path.join(f.acceptanceRoot, `record-${acceptanceId}.json`);
      const inode = lstatSync(recordPath).ino;
      rmSync(prepared.files[0]!.path);
      const inspected = await inspectTool(f, prepared.deliveryId);
      const facts = modelJson(inspected);
      expect(facts.acceptance.historyCommitted).toBe(true);
      expect(facts.acceptance.acceptanceId).toBe(acceptanceId);
      expect(facts.taskAccepted).toBe(true);
      expect(facts.integrity.record.state).toBe("intact");
      expect(facts.integrity.delivery.state).toBe("changed");
      expect(facts.files).toBeNull();
      expect(facts.paths.available).toBe(false);
      expect(facts.paths.withheldReason).toBeTruthy();

      const replay = modelJson(await submitTool(f, prepared.deliveryId));
      expect(replay.operation.outcome).toBe("committed");
      expect(replay.operation.operationCommitted).toBe(true);
      expect(replay.operation.idempotent).toBe(true);
      expect(replay.acceptance.acceptanceId).toBe(acceptanceId);
      expect(replay.files).toBeNull();
      expect(replay.paths.available).toBe(false);
      expect(lstatSync(recordPath).ino).toBe(inode);
    } finally {
      await f.cleanup();
    }
  });

  test("postcommit formatting failure falls back to a minimum truthful envelope", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const service = acceptanceOf(f);
      const original = service.inspect.bind(service);
      service.inspect = async (...args: Parameters<AcceptanceService["inspect"]>) => {
        const result = await original(...args);
        const baseFile = result.delivery.files?.[0];
        if (baseFile !== undefined && baseFile !== null) {
          result.delivery = {
            ...result.delivery,
            files: Array.from({ length: 8 }, (_, index) => ({
              ...baseFile,
              artifactId: `artifact-budget-${index}`,
              path: `/checked/${"x".repeat(5000)}-${index}`,
            })),
          };
        }
        return result;
      };
      const submitted = await submitTool(f, prepared.deliveryId);
      const facts = modelJson(submitted);
      expect(facts.operation.outcome).toBe("committed");
      expect(facts.operation.operationCommitted).toBe(true);
      expect(facts.acceptance.acceptanceId).toMatch(/^acceptance-/);
      expect(facts.files).toBeNull();
      expect(facts.paths.available).toBe(false);
      expect(facts.paths.withheldReason).toContain("no path was checked");
      expect(facts.reason).toContain("could not be formatted");
      expect(Buffer.byteLength(textOf(submitted), "utf8")).toBeLessThanOrEqual(32 * 1024);
      expect(Buffer.byteLength(JSON.stringify(submitted), "utf8")).toBeLessThanOrEqual(64 * 1024);
    } finally {
      await f.cleanup();
    }
  });

  test("postcommit inspection visibility loss withholds paths but keeps commit facts", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const service = acceptanceOf(f);
      const original = service.inspect.bind(service);
      service.inspect = async (...args: Parameters<AcceptanceService["inspect"]>) => {
        const result = await original(...args);
        if (result.acceptance !== null) {
          // Real navigation after the awaited inspection. The wrapper must not
          // project the inspection's earlier current snapshot.
          f.owner.navigate("session_switch");
        }
        return result;
      };
      const submitted = await submitTool(f, prepared.deliveryId);
      const facts = modelJson(submitted);
      expect(facts.operation.outcome).toBe("committed");
      expect(facts.operation.operationCommitted).toBe(true);
      expect(facts.taskAccepted).toBeNull();
      expect(facts.currentTaskStatus).toBeNull();
      expect(facts.visibility.state).toBe("detached");
      expect(facts.acceptance.acceptanceId).toMatch(/^acceptance-/);
      expect(facts.files).toBeNull();
      expect(facts.paths.available).toBe(false);
      expect(facts.paths.withheldReason).toBeTruthy();
    } finally {
      await f.cleanup();
    }
  });

  test("delivery selector parser isolates submit/inspect and rejects authority fields", async () => {
    const selectorArgs = {
      action: "submit",
      expectedTaskId: "task-fixture",
      expectedTaskRevision: 1,
      deliveryId: "delivery-fixture",
    };
    expect(parseDeliveryArguments(selectorArgs)).toEqual({
      action: "submit",
      request: {
        expectedTaskId: "task-fixture",
        expectedTaskRevision: 1,
        deliveryId: "delivery-fixture",
      },
    });
    expect(parseDeliveryArguments({ ...selectorArgs, action: "inspect" })).toEqual({
      action: "inspect",
      request: {
        expectedTaskId: "task-fixture",
        expectedTaskRevision: 1,
        deliveryId: "delivery-fixture",
      },
    });
    for (const extra of [
      { runId: "run-other" },
      { artifactIds: ["artifact-other"] },
      { verificationReceiptId: "receipt-other" },
      { unknownModelField: true },
    ]) {
      expect(() => parseDeliveryArguments({ ...selectorArgs, ...extra })).toThrow(/selector/);
    }
    for (const extra of [
      { path: "/tmp/x" },
      { receipt: {} },
      { contract: {} },
      { verdict: "pass" },
      { accepted: true },
      { confirmed: true },
      { bytes: 1 },
      { sha256: "sha256:00" },
    ]) {
      expect(() => parseDeliveryArguments({ ...selectorArgs, ...extra })).toThrow(/authority/);
    }
    expect(() => parseDeliveryArguments({
      action: "describe",
      deliveryId: "delivery-fixture",
    })).toThrow(/describe/);
    expect(() => parseDeliveryArguments({
      action: "preview",
      expectedTaskId: "task-fixture",
      expectedTaskRevision: 1,
      runId: "run-fixture",
      artifactIds: ["artifact-fixture"],
      deliveryId: "delivery-fixture",
    })).toThrow(/preview/);
    expect(() => parseDeliveryArguments({
      action: "submit",
      expectedTaskId: "task-fixture",
      expectedTaskRevision: 1,
    })).toThrow(/deliveryId/);
  });

  test("submit and inspect expose checked accepted files and idempotent history", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const first = await submitTool(f, prepared.deliveryId);
      expect(first.isError).toBeUndefined();
      const firstFacts = modelJson(first);
      expect(firstFacts.format).toBe("agent-deliver-result-v1");
      expect(firstFacts.action).toBe("submit");
      expect(firstFacts.operation.outcome).toBe("committed");
      expect(firstFacts.operation.operationCommitted).toBe(true);
      expect(firstFacts.operation.idempotent).toBe(false);
      expect(firstFacts.operation.newCommit).toBe(true);
      expect(firstFacts.taskAccepted).toBe(true);
      expect(firstFacts.currentTaskStatus).toBe("accepted");
      expect(firstFacts.acceptance.historyCommitted).toBe(true);
      expect(firstFacts.acceptance.acceptanceId).toMatch(/^acceptance-/);
      expect(firstFacts.paths.available).toBe(true);
      expect(firstFacts.files).toHaveLength(1);
      expect(firstFacts.files[0].path).toBe(prepared.files[0]!.path);
      expect(firstFacts.files[0].sha256).toBe(sha256(readFileSync(firstFacts.files[0].path)));
      expect(firstFacts.integrity.delivery.state).toBe("intact");
      expect(firstFacts.integrity.archive.state).toBe("not_checked");
      expect(Buffer.byteLength(textOf(first), "utf8")).toBeLessThanOrEqual(32 * 1024);
      expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(64 * 1024);

      const acceptanceId = firstFacts.acceptance.acceptanceId as string;
      const recordPath = path.join(f.acceptanceRoot, `record-${acceptanceId}.json`);
      const inode = lstatSync(recordPath).ino;
      const replay = await submitTool(f, prepared.deliveryId);
      const replayFacts = modelJson(replay);
      expect(replayFacts.operation.outcome).toBe("committed");
      expect(replayFacts.operation.operationCommitted).toBe(true);
      expect(replayFacts.operation.idempotent).toBe(true);
      expect(replayFacts.operation.newCommit).toBe(false);
      expect(replayFacts.acceptance.acceptanceId).toBe(acceptanceId);
      expect(replayFacts.paths.available).toBe(true);
      expect(lstatSync(recordPath).ino).toBe(inode);

      const inspected = await inspectTool(f, prepared.deliveryId);
      expect(inspected.isError).toBeUndefined();
      const inspectFacts = modelJson(inspected);
      expect(inspectFacts.action).toBe("inspect");
      expect(inspectFacts.operation.performed).toBe(false);
      expect(inspectFacts.operation.readOnly).toBe(true);
      expect(inspectFacts.operation.newCommit).toBe(false);
      expect(inspectFacts.acceptance.historyCommitted).toBe(true);
      expect(inspectFacts.acceptance.acceptanceId).toBe(acceptanceId);
      expect(inspectFacts.paths.available).toBe(true);
      expect(inspectFacts.files[0].path).toBe(prepared.files[0]!.path);

      const describedAfter = await f.tools.get(DELIVERY_TOOL)!.execute(
        "describe-after-accepted", { action: "describe" }, undefined, undefined, f.ctx,
      );
      expect(describedAfter.isError).toBeUndefined();
      const describedText = textOf(describedAfter);
      expect(describedText).toContain("taskAccepted: true");
      expect(describedText).toContain("currentTaskStatus: accepted");
      expect(describedText).toContain("acceptanceConfigured: true");
      expect(describedText).toContain("submissionAvailable: false");
      expect(describedText).toContain("task_already_accepted");
      expect(describedText).not.toContain("currentTaskStatus: cancelled");

      const task = f.owner.snapshot().currentTask!;
      const previewAfter = await f.tools.get(DELIVERY_TOOL)!.execute("preview-after-accepted", {
        action: "preview",
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
        runId: prepared.runId,
        artifactIds: prepared.artifactIds,
      }, undefined, undefined, f.ctx);
      expect(previewAfter.isError).toBe(true);
      expect(textOf(previewAfter)).toContain("taskAccepted: true");
      expect(textOf(previewAfter)).toContain("accepted and terminal");
      expect(textOf(previewAfter)).not.toContain("cancelled");

      const verifyAfter = await f.tools.get(VERIFICATION_TOOL)!.execute("verify-after-accepted", {
        action: "verify",
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
        runId: prepared.runId,
        artifactIds: prepared.artifactIds,
      }, undefined, undefined, f.ctx);
      expect(verifyAfter.isError).toBe(true);
      expect(textOf(verifyAfter)).toMatch(/taskAccepted: true/);
      expect(textOf(verifyAfter)).toContain("currentTaskStatus: accepted");
      expect(textOf(verifyAfter)).toContain("verificationPerformed: false");
      expect(textOf(verifyAfter)).not.toContain("taskAccepted: false");

      const runAfter = await f.tools.get("agent_execute")!.execute("run-after-accepted", {
        action: "run",
        runtime: "python",
        source: "print('must-not-run')\n",
        inputIds: [],
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
      }, undefined, undefined, f.ctx);
      expect(runAfter.isError).toBe(true);
      expect(textOf(runAfter)).toMatch(/taskAccepted: true/);
      expect(textOf(runAfter)).toContain("currentTaskStatus: accepted");
      expect(textOf(runAfter)).not.toContain("cancelled");
    } finally {
      await f.cleanup();
    }
  });

  test("unconfigured acceptance is explicit and writes no record", async () => {
    const f = await fixture({ withAcceptance: false });
    try {
      expect(f.entry.acceptance).toBeUndefined();
      expect(f.entry.delivery).toBeDefined();
      const described = await f.tools.get(DELIVERY_TOOL)!.execute(
        "describe-unconfigured", { action: "describe" }, undefined, undefined, f.ctx,
      );
      const describedText = textOf(described);
      expect(describedText).toContain("acceptanceImplemented: true");
      expect(describedText).toContain("acceptanceConfigured: false");
      expect(describedText).toContain("submissionAvailable: false");
      expect(describedText).toContain("acceptance_not_configured");

      const run = await runSource(f);
      const artifactIds = run.artifacts.map((artifact) => artifact.artifactId);
      const previewed = await preview(f, run.runId, artifactIds);
      const submitted = await f.tools.get(DELIVERY_TOOL)!.execute("submit-unconfigured", {
        action: "submit",
        ...selector(f, previewed.deliveryId),
      }, undefined, undefined, f.ctx);
      expect(submitted.isError).toBe(true);
      const submitFacts = modelJson(submitted);
      expect(submitFacts.acceptanceConfigured).toBe(false);
      expect(submitFacts.operation.performed).toBe(false);
      expect(submitFacts.operation.outcome).toBe("not_committed");
      expect(submitFacts.operation.operationCommitted).toBe(false);
      expect(submitFacts.taskAccepted).toBe(false);
      expect(submitFacts.paths.available).toBe(false);
      expect(submitFacts.reason).toContain("acceptance root");

      const inspected = await f.tools.get(DELIVERY_TOOL)!.execute("inspect-unconfigured", {
        action: "inspect",
        ...selector(f, previewed.deliveryId),
      }, undefined, undefined, f.ctx);
      expect(inspected.isError).toBe(true);
      const inspectFacts = modelJson(inspected);
      expect(inspectFacts.acceptanceConfigured).toBe(false);
      expect(inspectFacts.operation.performed).toBe(false);
      expect(inspectFacts.operation.readOnly).toBe(true);
      expect(inspectFacts.operation.newCommit).toBe(false);
      expect(inspectFacts.paths.available).toBe(false);
      expect(readdirSync(f.acceptanceRoot).filter((name) => name.startsWith("record-"))).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });

  test("acceptance-only and overlapping root configuration fail closed", async () => {
    const f = await fixture();
    try {
      const acceptanceOnly = fakePi();
      expect(() => createExecutionEntry(acceptanceOnly.pi, {
        root: f.root,
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
        acceptanceRoot: f.acceptanceRoot,
      })).toThrow(/deliveryRoot/);
      expect(acceptanceOnly.tools.size).toBe(0);

      const overlapping = fakePi();
      expect(() => createExecutionEntry(overlapping.pi, {
        root: f.root,
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
        deliveryRoot: f.deliveryRoot,
        acceptanceRoot: f.deliveryRoot,
      })).toThrow(/overlap/);
      expect(overlapping.tools.size).toBe(1);
      const disposed = await overlapping.tools.get(VERIFICATION_TOOL)!.execute(
        "disposed-verify", { action: "describe" }, undefined, undefined, f.ctx,
      );
      expect(disposed.isError).toBe(true);
      expect(textOf(disposed)).toContain("disposed");
    } finally {
      await f.cleanup();
    }
  });

  test("postcommit navigation and abort retain commit facts but withhold paths", async () => {
    let ownerRef: TaskOwner | undefined;
    const navigated = await fixture({
      onEvent: (event) => {
        if (event.type === "task_accepted") ownerRef?.navigate("session_switch");
      },
    });
    ownerRef = navigated.owner;
    try {
      const prepared = await prepareAccepted(navigated);
      const submitted = await submitTool(navigated, prepared.deliveryId);
      const facts = modelJson(submitted);
      expect(facts.operation.outcome).toBe("committed");
      expect(facts.operation.operationCommitted).toBe(true);
      expect(facts.operation.idempotent).toBe(false);
      expect(facts.taskAccepted).toBeNull();
      expect(facts.currentTaskStatus).toBeNull();
      expect(facts.visibility.state).toBe("detached");
      expect(facts.acceptance.historyCommitted).toBe(true);
      expect(facts.acceptance.acceptanceId).toMatch(/^acceptance-/);
      expect(facts.paths.available).toBe(false);
      expect(facts.paths.withheldReason).toContain("not visible");
      expect(facts.files).toBeNull();
      expect(textOf(submitted)).not.toContain("cancelled");

      const inspected = await inspectTool(navigated, prepared.deliveryId);
      const inspectFacts = modelJson(inspected);
      expect(inspectFacts.acceptance.historyCommitted).toBeNull();
      expect(inspectFacts.acceptance.acceptanceId).toBeNull();
      expect(inspectFacts.taskAccepted).toBeNull();
      expect(inspectFacts.paths.available).toBe(false);
      expect(inspectFacts.integrity).toBeNull();

      const unauthorizedRetry = await submitTool(navigated, prepared.deliveryId);
      const retryFacts = modelJson(unauthorizedRetry);
      expect(retryFacts.operation.operationCommitted).toBe(false);
      expect(retryFacts.operation.idempotent).toBe(false);
      expect(retryFacts.acceptance.acceptanceId).toBeNull();
      expect(retryFacts.paths.available).toBe(false);
      expect(textOf(unauthorizedRetry)).not.toContain(String(facts.acceptance.acceptanceId));
    } finally {
      await navigated.cleanup();
    }

    const controller = new AbortController();
    const aborted = await fixture({
      onEvent: (event) => {
        if (event.type === "task_accepted") controller.abort();
      },
    });
    try {
      const prepared = await prepareAccepted(aborted);
      const submitted = await submitTool(aborted, prepared.deliveryId, controller.signal);
      const facts = modelJson(submitted);
      expect(facts.operation.outcome).toBe("committed");
      expect(facts.operation.operationCommitted).toBe(true);
      expect(facts.taskAccepted).toBe(true);
      expect(facts.currentTaskStatus).toBe("accepted");
      expect(facts.paths.available).toBe(false);
      expect(facts.paths.withheldReason).toContain("aborted");
      expect(facts.acceptance.acceptanceId).toMatch(/^acceptance-/);
      expect(textOf(submitted)).not.toContain("cancelled");
    } finally {
      await aborted.cleanup();
    }
  });

  test("unknown installation facts stay unclaimed through submit and inspect", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const task = f.owner.snapshot().currentTask!;
      const hazard = {
        task: {
          ownerId: task.ownerId,
          taskId: task.taskId,
          taskRevision: task.taskRevision,
          requirementsDigest: requirementsDigest(task.requirementSources),
        },
        acceptanceId: "acceptance-entry-unknown",
        deliveryId: prepared.deliveryId,
        recordDigest: "sha256:" + "a".repeat(64),
        reason: "fixture installation outcome unknown",
      };
      (f.owner as unknown as { acceptanceHazard: unknown }).acceptanceHazard = hazard;
      const submitted = await submitTool(f, prepared.deliveryId);
      const facts = modelJson(submitted);
      expect(facts.operation.outcome).toBe("unknown");
      expect(facts.operation.operationCommitted).toBeNull();
      expect(facts.operation.idempotent).toBe(false);
      expect(facts.taskAccepted).toBeNull();
      expect(facts.currentTaskStatus).toBeNull();
      expect(facts.acceptance.historyCommitted).toBeNull();
      expect(facts.acceptance.acceptanceId).toBeNull();
      expect(facts.unknown.acceptanceId).toBe(hazard.acceptanceId);
      expect(facts.unknown.recordDigest).toBe(hazard.recordDigest);
      expect(facts.paths.available).toBe(false);
      expect(facts.files).toBeNull();

      const inspected = await inspectTool(f, prepared.deliveryId);
      const inspectFacts = modelJson(inspected);
      expect(inspectFacts.operation.performed).toBe(false);
      expect(inspectFacts.acceptance.historyCommitted).toBeNull();
      expect(inspectFacts.unknown.acceptanceId).toBe(hazard.acceptanceId);
      expect(inspectFacts.paths.available).toBe(false);
      expect(inspectFacts.integrity.record.state).toBe("unknown");
      expect(inspectFacts.integrity.delivery.state).toBe("unknown");
    } finally {
      await f.cleanup();
    }
  });

  test("no-contract submit is not accepted and carries no accepted path", async () => {
    const f = await fixture();
    try {
      const run = await runSource(f);
      const artifactIds = run.artifacts.map((artifact) => artifact.artifactId);
      const previewed = await preview(f, run.runId, artifactIds);
      const submitted = await submitTool(f, previewed.deliveryId);
      expect(submitted.isError).toBe(true);
      const facts = modelJson(submitted);
      expect(facts.operation.outcome).toBe("not_committed");
      expect(facts.operation.operationCommitted).toBe(false);
      expect(facts.operation.idempotent).toBe(false);
      expect(facts.operation.newCommit).toBe(false);
      expect(facts.taskAccepted).toBe(false);
      expect(facts.currentTaskStatus).toBe("active");
      expect(facts.acceptance.historyCommitted).toBe(false);
      expect(facts.acceptance.acceptanceId).toBeNull();
      expect(facts.files).toBeNull();
      expect(facts.paths.available).toBe(false);
      expect(facts.reason).toContain("contract");
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
      expect(readdirSync(f.acceptanceRoot).filter((name) => name.startsWith("record-"))).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });

  test("record store port preserves issuance across independent loaded module graphs", async () => {
    const graphA = await import("../../src/acceptance-record-store.ts" + "?graph=owner") as typeof import("../../src/acceptance-record-store.ts");
    const graphB = await import("../../src/acceptance-record-store.ts" + "?graph=service") as typeof import("../../src/acceptance-record-store.ts");
    expect(graphA.preparedAcceptanceBinding).not.toBe(graphB.preparedAcceptanceBinding);
    expect(graphA.resolveAcceptanceRoot).not.toBe(graphB.resolveAcceptanceRoot);
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b2-graph-")));
    const executionRoot = path.join(parent, "execution");
    const deliveryRoot = path.join(parent, "delivery");
    const acceptanceRoot = path.join(parent, "acceptance");
    mkdirSync(executionRoot, { mode: 0o700 });
    mkdirSync(deliveryRoot, { mode: 0o700 });
    mkdirSync(acceptanceRoot, { mode: 0o700 });
    try {
      const root = graphA.resolveAcceptanceRoot(acceptanceRoot, executionRoot, deliveryRoot);
      const prepared = graphA.prepareAcceptanceRecord({
        root,
        acceptanceId: "acceptance-graph",
        deliveryId: "delivery-graph",
        acceptedAt: NOW,
        task: {
          ownerId: "owner-graph",
          taskId: "task-graph",
          taskRevision: 1,
          requirementsDigest: `sha256:${"a".repeat(64)}`,
        },
        record: { graph: "owner" },
      });
      const digest = graphA.preparedAcceptanceBinding(prepared).recordDigest;
      expect(digest).toMatch(/^sha256:/);
      expect(() => graphB.preparedAcceptanceBinding(prepared)).toThrow(/not issued/);

      const ownerPort = graphA.acceptanceRecordStorePort();
      const servicePort = graphB.acceptanceRecordStorePort();
      expect(ownerPort).not.toBe(servicePort);
      expect(graphA.acceptanceRecordStorePort()).toBe(ownerPort);
      expect(Object.isFrozen(ownerPort)).toBe(true);
      expect(ownerPort.binding(prepared).recordDigest).toBe(digest);
      expect(() => servicePort.binding(prepared)).toThrow(/not issued/);
      expect(servicePort.read(root, "acceptance-graph").state).toBe("unavailable");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("owner port is captured at construction and never re-read around commit", async () => {
    const f = await fixture();
    try {
      const port = f.owner.acceptanceRecordStore();
      expect(Object.isFrozen(port)).toBe(true);
      expect(f.owner.acceptanceRecordStore()).toBe(port);
      const prepared = await prepareAccepted(f);
      const delivery = f.entry.delivery!;
      const original = delivery.readAcceptanceEvidence.bind(delivery);
      let replaced = false;
      delivery.readAcceptanceEvidence = async (...args) => {
        if (!replaced) {
          replaced = true;
          Object.defineProperty(f.owner, "acceptanceRecordStore", {
            configurable: true,
            value: () => {
              throw new Error("late owner store getter must not be used");
            },
          });
        }
        return original(...args);
      };
      const result = await acceptanceOf(f).submit(f.ctx, selector(f, prepared.deliveryId));
      expect(replaced).toBe(true);
      expect(result.outcome).toBe("committed");
      expect(result.operationCommitted).toBe(true);
      expect(result.acceptance).not.toBeNull();
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");
    } finally {
      await f.cleanup();
    }
  });

  test("inspect rechecks actual visibility after the awaited service inspection", async () => {
    for (const mutation of ["navigate", "owner", "dispose"] as const) {
      const f = await fixture();
      try {
        const prepared = await prepareAccepted(f);
        const submitted = await submitTool(f, prepared.deliveryId);
        expect(modelJson(submitted).operation.operationCommitted).toBe(true);
        const service = acceptanceOf(f);
        const actual = service.inspect.bind(service);
        let reached = false;
        service.inspect = async (...args: Parameters<AcceptanceService["inspect"]>) => {
          const result = await actual(...args);
          reached = true;
          if (mutation === "navigate") f.owner.navigate("session_switch");
          if (mutation === "owner") publishTaskOwner(new TaskOwner({ workspaceRoot: f.workspace }));
          if (mutation === "dispose") f.entry.dispose();
          return result;
        };
        const response = await inspectTool(f, prepared.deliveryId);
        expect(reached).toBe(true);
        const facts = modelJson(response);
        expect(facts.taskAccepted).toBeNull();
        expect(facts.currentTaskStatus).toBeNull();
        expect(facts.visibility.state).not.toBe("visible");
        expect(facts.files).toBeNull();
        expect(facts.paths.available).toBe(false);
        expect(textOf(response)).not.toContain(prepared.files[0]!.path);
        expect(f.owner.snapshot().currentTask!.status).toBe("accepted");
      } finally {
        await f.cleanup();
      }
    }
  });

  test("submit aborted after the actual accepted inspection keeps commit but withholds paths", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const service = acceptanceOf(f);
      const actual = service.inspect.bind(service);
      const controller = new AbortController();
      let inspected = false;
      service.inspect = async (...args: Parameters<AcceptanceService["inspect"]>) => {
        const result = await actual(...args);
        if (!inspected && result.acceptance !== null && result.delivery.state === "intact") {
          inspected = true;
          controller.abort("late fixture abort after actual accepted inspection");
        }
        return result;
      };
      const submitted = await submitTool(f, prepared.deliveryId, controller.signal);
      expect(inspected).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      const facts = modelJson(submitted);
      expect(facts.operation.outcome).toBe("committed");
      expect(facts.operation.operationCommitted).toBe(true);
      expect(facts.taskAccepted).toBe(true);
      expect(facts.currentTaskStatus).toBe("accepted");
      expect(facts.visibility.state).toBe("visible");
      const task = f.owner.snapshot().currentTask!;
      expect(task.status).toBe("accepted");
      expect(facts.acceptance.acceptanceId).toBe(task.acceptance!.acceptanceId);
      expect(facts.acceptance.recordDigest).toBe(task.acceptance!.recordDigest);
      expect(sha256(readFileSync(path.join(f.acceptanceRoot, `record-${task.acceptance!.acceptanceId}.json`))))
        .toBe(task.acceptance!.recordDigest);
      expect(facts.files).toBeNull();
      expect(facts.manifest).toBeNull();
      expect(facts.requirements).toBeNull();
      expect(facts.paths.available).toBe(false);
      expect(facts.paths.withheldReason).toContain("aborted");
      expect(textOf(submitted)).not.toContain(prepared.files[0]!.path);
    } finally {
      await f.cleanup();
    }
  });

  test("standalone delivery entry disposal during actual accepted inspect hides prior record facts", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const first = modelJson(await submitTool(f, prepared.deliveryId));
      expect(first.operation.operationCommitted).toBe(true);
      const task = f.owner.snapshot().currentTask!;
      const recordPath = path.join(f.acceptanceRoot, `record-${task.acceptance!.acceptanceId}.json`);
      const recordBefore = readFileSync(recordPath);
      const inodeBefore = lstatSync(recordPath).ino;
      let standalone: RegisteredTool | undefined;
      const controls = createDeliveryEntry({
        registerTool(tool) {
          standalone = tool;
        },
      }, {
        owner: f.owner,
        service: f.entry.delivery!,
        acceptance: f.entry.acceptance!,
      });
      expect(standalone).toBeTruthy();
      const service = acceptanceOf(f);
      const actual = service.inspect.bind(service);
      let disposedAfterRealRead = false;
      service.inspect = async (...args: Parameters<AcceptanceService["inspect"]>) => {
        const result = await actual(...args);
        if (!disposedAfterRealRead && result.acceptance !== null && result.delivery.state === "intact") {
          disposedAfterRealRead = true;
          controls.dispose();
        }
        return result;
      };
      const response = await standalone!.execute(
        "standalone-late-dispose",
        { action: "inspect", ...selector(f, prepared.deliveryId) },
        undefined,
        undefined,
        f.ctx,
      );
      expect(disposedAfterRealRead).toBe(true);
      const disposedDelivery = await f.entry.delivery!.inspectAcceptedDelivery({
        ownerId: task.ownerId,
        taskId: task.taskId,
        taskRevision: task.taskRevision,
        requirementsDigest: requirementsDigest(task.requirementSources),
      }, prepared.deliveryId);
      expect(disposedDelivery.state).toBe("unavailable");
      expect(disposedDelivery.reason).toContain("disposed");
      const stillLiveAcceptance = f.entry.acceptance!.finalVisibility(f.ctx, task.taskId, task.taskRevision);
      expect(stillLiveAcceptance.state).toBe("visible");
      const facts = modelJson(response);
      expect(response.isError).toBe(true);
      expect(facts.paths.available).toBe(false);
      expect(facts.files).toBeNull();
      expect(facts.manifest).toBeNull();
      expect(facts.requirements).toBeNull();
      expect(facts.acceptance?.acceptanceId ?? null).toBeNull();
      expect(facts.integrity).toBeNull();
      expect(textOf(response)).not.toContain(prepared.files[0]!.path);
      expect(textOf(response)).not.toContain(task.acceptance!.acceptanceId);
      expect(readFileSync(recordPath)).toEqual(recordBefore);
      expect(lstatSync(recordPath).ino).toBe(inodeBefore);
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");
    } finally {
      await f.cleanup();
    }
  });

  test("submit projects a fresh current state after a late replacement owner", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const service = acceptanceOf(f);
      const actual = service.inspect.bind(service);
      let replaced = false;
      service.inspect = async (...args: Parameters<AcceptanceService["inspect"]>) => {
        const result = await actual(...args);
        if (result.acceptance !== null && !replaced) {
          replaced = true;
          publishTaskOwner(new TaskOwner({ workspaceRoot: f.workspace }));
        }
        return result;
      };
      const submitted = await submitTool(f, prepared.deliveryId);
      expect(replaced).toBe(true);
      const facts = modelJson(submitted);
      expect(facts.operation.outcome).toBe("committed");
      expect(facts.operation.operationCommitted).toBe(true);
      expect(facts.acceptance.acceptanceId).toBe(f.owner.snapshot().currentTask!.acceptance!.acceptanceId);
      expect(facts.taskAccepted).toBeNull();
      expect(facts.currentTaskId).toBeNull();
      expect(facts.currentTaskStatus).toBeNull();
      expect(facts.visibility.state).not.toBe("visible");
      expect(facts.files).toBeNull();
      expect(facts.paths.available).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("authorized idempotent replay keeps the committed reference when inspection loses visibility", async () => {
    const f = await fixture();
    try {
      const prepared = await prepareAccepted(f);
      const first = modelJson(await submitTool(f, prepared.deliveryId));
      expect(first.operation.outcome).toBe("committed");
      const reference = f.owner.snapshot().currentTask!.acceptance!;
      const delivery = f.entry.delivery!;
      const original = delivery.inspectAcceptedDelivery.bind(delivery);
      let navigated = false;
      delivery.inspectAcceptedDelivery = async (...args) => {
        const result = await original(...args);
        if (!navigated) {
          navigated = true;
          f.owner.navigate("session_switch");
        }
        return result;
      };
      const replay = await submitTool(f, prepared.deliveryId);
      expect(navigated).toBe(true);
      const facts = modelJson(replay);
      expect(facts.operation.outcome).toBe("committed");
      expect(facts.operation.operationCommitted).toBe(true);
      expect(facts.operation.idempotent).toBe(true);
      expect(facts.operation.newCommit).toBe(false);
      expect(facts.acceptance.historyCommitted).toBe(true);
      expect(facts.acceptance.acceptanceId).toBe(reference.acceptanceId);
      expect(facts.acceptance.recordDigest).toBe(reference.recordDigest);
      expect(facts.taskAccepted).toBeNull();
      expect(facts.currentTaskStatus).toBeNull();
      expect(facts.visibility.state).not.toBe("visible");
      expect(facts.paths.available).toBe(false);
      expect(facts.files).toBeNull();

      const unauthorized = await submitTool(f, prepared.deliveryId);
      const denied = modelJson(unauthorized);
      expect(denied.operation.outcome).toBe("not_committed");
      expect(denied.operation.operationCommitted).toBe(false);
      expect(denied.acceptance.acceptanceId).toBeNull();
      expect(denied.acceptance.recordDigest).toBeNull();
      expect(denied.paths.available).toBe(false);
      expect(denied.files).toBeNull();
      expect(textOf(unauthorized)).not.toContain(reference.acceptanceId);
      expect(textOf(unauthorized)).not.toContain(reference.recordDigest);
    } finally {
      await f.cleanup();
    }
  });

  test("execution early rejections project visible acceptance and unknown honestly", async () => {
    const accepted = await fixture();
    try {
      const prepared = await prepareAccepted(accepted);
      expect(modelJson(await submitTool(accepted, prepared.deliveryId)).operation.operationCommitted).toBe(true);
      const task = accepted.owner.snapshot().currentTask!;
      const base = {
        action: "run" as const,
        runtime: "python" as const,
        source: "print('must-not-run')\n",
        inputIds: [] as string[],
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
      };
      const malformed = await accepted.tools.get("agent_execute")!.execute(
        "early-malformed",
        { ...base, path: "authority-is-not-allowed" },
        undefined,
        undefined,
        accepted.ctx,
      );
      expect(malformed.isError).toBe(true);
      expect(malformed.details).toMatchObject({ taskAccepted: true, currentTaskStatus: "accepted" });
      expect(textOf(malformed)).not.toContain("taskAccepted: false");

      const controller = new AbortController();
      controller.abort();
      const aborted = await accepted.tools.get("agent_execute")!.execute(
        "early-aborted",
        base,
        controller.signal,
        undefined,
        accepted.ctx,
      );
      expect(aborted.isError).toBe(true);
      expect(aborted.details).toMatchObject({ taskAccepted: true, currentTaskStatus: "accepted" });
      expect(textOf(aborted)).not.toContain("taskAccepted: false");

      accepted.entry.dispose();
      const disposed = await accepted.tools.get("agent_execute")!.execute(
        "early-disposed",
        base,
        undefined,
        undefined,
        accepted.ctx,
      );
      expect(disposed.isError).toBe(true);
      expect(disposed.details).toMatchObject({ taskAccepted: null, currentTaskStatus: null });
      expect(textOf(disposed)).not.toContain("taskAccepted: false");
    } finally {
      await accepted.cleanup();
    }

    const unknown = await fixture();
    try {
      const task = unknown.owner.snapshot().currentTask!;
      (unknown.owner as unknown as { acceptanceHazard: unknown }).acceptanceHazard = {
        task: {
          ownerId: task.ownerId,
          taskId: task.taskId,
          taskRevision: task.taskRevision,
          requirementsDigest: requirementsDigest(task.requirementSources),
        },
        acceptanceId: "acceptance-unit-unknown",
        deliveryId: "delivery-unit-unknown",
        recordDigest: `sha256:${"a".repeat(64)}`,
        reason: "unit unknown installation",
      };
      const response = await unknown.tools.get("agent_execute")!.execute(
        "unknown-run",
        {
          action: "run",
          runtime: "python",
          source: "print('blocked')\n",
          inputIds: [],
          expectedTaskId: task.taskId,
          expectedTaskRevision: task.taskRevision,
        },
        undefined,
        undefined,
        unknown.ctx,
      );
      expect(response.isError).toBe(true);
      expect(response.details).toMatchObject({ taskAccepted: null, currentTaskStatus: "active" });
      expect(textOf(response)).not.toContain("taskAccepted: false");
    } finally {
      await unknown.cleanup();
    }

    const shutdown = await fixture();
    try {
      const prepared = await prepareAccepted(shutdown);
      expect(modelJson(await submitTool(shutdown, prepared.deliveryId)).operation.operationCommitted).toBe(true);
      const handlers = shutdown.handlers.get("session_shutdown");
      expect(handlers).toBeDefined();
      await handlers!({});
      const described = await shutdown.tools.get("agent_execute")!.execute(
        "shutdown-describe",
        { action: "describe" },
        undefined,
        undefined,
        shutdown.ctx,
      );
      expect(described.isError).toBe(true);
      expect(described.details).toMatchObject({ taskAccepted: null, currentTaskStatus: null });
      expect(textOf(described)).not.toContain("taskAccepted: false");
    } finally {
      await shutdown.cleanup();
    }
  });

  test("accepted paths round-trip exactly through JSON with format controls in the root", async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b2-bidi-")));
    const deliveryRoot = path.join(parent, "del-\u202e-root");
    mkdirSync(deliveryRoot, { mode: 0o700 });
    const f = await fixture({ deliveryRoot });
    try {
      const prepared = await prepareAccepted(f);
      const submitted = await submitTool(f, prepared.deliveryId);
      const raw = textOf(submitted);
      expect(raw).not.toContain("\u202e");
      expect(raw).toContain("\\u202e");
      const facts = modelJson(submitted);
      expect(facts.paths.available).toBe(true);
      expect(facts.files[0].path).toBe(prepared.files[0]!.path);
      expect(facts.files[0].path).toContain("\u202e");
      expect(facts.manifest.path.startsWith(f.deliveryRoot)).toBe(true);
      expect(facts.manifest.path).toContain("\u202e");
      expect(sha256(readFileSync(facts.files[0].path))).toBe(facts.files[0].sha256);
      expect(sha256(readFileSync(facts.manifest.path))).toBe(facts.manifest.sha256);
    } finally {
      await f.cleanup();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
void chmodSync;
void readFile;
