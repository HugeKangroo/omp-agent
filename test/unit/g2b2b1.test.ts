import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
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
import { createDeliveryEntry, DELIVERY_TOOL } from "../../src/delivery-entry.ts";
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
} = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-")));
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-ws-")));
  WORKSPACE = workspace;
  const deliveryRoot = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2b1-del-")));
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
    acceptanceRoot,
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
      const task = reserved.owner.snapshot().currentTask!;
      const denied = reserved.owner.admit(
        subject(reserved.branch),
        "local-script",
        task.taskRevision,
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
      cancelled.owner.cancel(subject(cancelled.branch));
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
      const revision = revised.owner.revise(subject(revised.live.branch), "amended");
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
      expect(() => f.owner.cancel(subject(f.branch))).toThrow(/accepted.*terminal/);
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");
      const sameStart = f.owner.start(subject(f.branch));
      expect(sameStart.created).toBe(false);
      expect(sameStart.task.status).toBe("accepted");
      const denied = f.owner.admit(subject(f.branch), "local-script", task.taskRevision);
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
      const denied = f.owner.admit(subject(f.branch), "local-script", task.taskRevision);
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

      const denied = f.owner.admit(subject(f.branch), "local-script", task.taskRevision);
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
      expect(f.owner.admit(subject(f.branch), "local-script", task.taskRevision).allowed).toBe(false);
      expect(() => f.owner.cancel(subject(f.branch))).toThrow(/unknown/i);
      expect(() => f.owner.revise(subject(f.branch))).toThrow(/unknown/i);
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
});

// Keep chmod import referenced for platforms where the same-byte replacement
// test adjusts permissions in future fixtures.
void chmodSync;
void readFile;
