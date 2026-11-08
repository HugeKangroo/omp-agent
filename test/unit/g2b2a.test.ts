import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, lstatSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TrustedContractSpec } from "../../src/acceptance-contract.ts";
import { ExecutionAdapter } from "../../src/execution-adapter.ts";
import {
  createDeliveryEntry,
  DELIVERY_TOOL,
  parseDeliveryArguments,
} from "../../src/delivery-entry.ts";
import {
  DeliveryService,
  MAX_DELIVERY_CONTENT_BYTES,
  MAX_DELIVERY_RESPONSE_BYTES,
} from "../../src/delivery-service.ts";
import {
  createExecutionEntry,
  type ExecutionEntryControls,
} from "../../src/execution-entry.ts";
import {
  clearPublishedTaskOwner,
  publishTaskOwner,
  type OmpToolContext,
} from "../../src/task-entry-port.ts";
import { TaskOwner, type TaskSubject } from "../../src/task-owner.ts";
import { VERIFICATION_TOOL } from "../../src/verification-entry.ts";
import type { TrustedVerifier } from "../../src/verification-service.ts";

const SESSION = "g2b2a-session";
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

function sha256(data: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function line(text: string, prefix: string): string | undefined {
  const found = text.split("\n").find((item) => item.startsWith(prefix));
  return found?.slice(prefix.length);
}

interface Fixture {
  root: string;
  workspace: string;
  deliveryRoot: string;
  inputPath: string;
  owner: TaskOwner;
  branch: readonly Entry[];
  live: { branch: readonly Entry[] };
  ctx: OmpToolContext;
  entry: ExecutionEntryControls;
  tools: Map<string, RegisteredTool>;
  cleanup: () => Promise<void>;
}

async function fixture(options: {
  withDelivery?: boolean;
  capabilities?: string[];
  verifier?: TrustedVerifier;
  deliveryRoot?: string;
} = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2a-")));
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2a-ws-")));
  WORKSPACE = workspace;
  const deliveryRoot = options.deliveryRoot ?? await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2a-del-")));
  const fixtures = path.join(root, "fixtures");
  await mkdir(fixtures);
  const inputPath = path.join(fixtures, "alpha.txt");
  await writeFile(inputPath, "authorized alpha input\n", { mode: 0o600 });
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: workspace,
    ownerId: "owner-g2b2a",
    authorizedCapabilities: options.capabilities ?? ["local-script"],
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
  publishTaskOwner(owner);
  const fake = fakePi();
  const entry = createExecutionEntry(fake.pi, {
    root,
    inputs: [{ id: "alpha", path: inputPath }],
    capabilityId: "local-script",
    pythonPath: PYTHON,
    bunPath: BUN,
    launcherPath: LAUNCHER,
    ...(options.verifier === undefined ? {} : { trustedVerifiers: [options.verifier] }),
    ...(options.withDelivery === true ? { deliveryRoot } : {}),
  });
  return {
    root,
    workspace,
    deliveryRoot,
    inputPath,
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
    },
  };
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

function passSpec(): TrustedContractSpec {
  return {
    hostConfig: { id: "host-fixture", version: "1" },
    verifier: { id: "fixture-semantic", version: "1", parameters: { secret: "fixture-only" } },
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
  };
}

const SOURCE = `
from pathlib import Path
Path("answer.txt").write_text("42\\n", encoding="utf-8")
Path("escape.txt").write_text("\\x1b[31mnot-a-button\\x1b[0m\\n", encoding="utf-8")
Path("binary.bin").write_bytes(bytes([0, 255, 1, 254]))
Path("DATA.CSV").write_text("a,b\\n1,2\\n", encoding="utf-8")
Path("long.txt").write_text("x" * 3000, encoding="utf-8")
print("artifacts written")
`;

async function runSource(
  f: Fixture,
  source = SOURCE,
  inputIds: string[] = [],
): Promise<{
  result: ToolResult;
  runId: string;
  artifacts: Array<{ artifactId: string; relativePath: string; bytes: number; sha256: string }>;
}> {
  const task = f.owner.snapshot().currentTask!;
  const result = await f.entry.adapter.run(f.ctx, {
    action: "run",
    runtime: "python",
    source,
    inputIds,
    expectedTaskId: task.taskId,
    expectedTaskRevision: task.taskRevision,
  });
  const details = result.details as Record<string, unknown>;
  return {
    result,
    runId: String(details.runId),
    artifacts: details.artifacts as Array<{ artifactId: string; relativePath: string; bytes: number; sha256: string }>,
  };
}

async function preview(
  f: Fixture,
  selection: { runId: string; artifactIds: string[]; verificationReceiptId?: string },
): Promise<ToolResult> {
  const task = f.owner.snapshot().currentTask!;
  return f.tools.get(DELIVERY_TOOL)!.execute("preview", {
    action: "preview",
    expectedTaskId: task.taskId,
    expectedTaskRevision: task.taskRevision,
    runId: selection.runId,
    artifactIds: selection.artifactIds,
    ...(selection.verificationReceiptId === undefined
      ? {}
      : { verificationReceiptId: selection.verificationReceiptId }),
  }, undefined, undefined, f.ctx);
}

function dispatchOutcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spawned: true,
    spawnError: null,
    pid: 1234,
    pgid: 1234,
    exitCode: 0,
    signal: null,
    durationMs: 12,
    observedBytes: 0,
    retainedBytes: 0,
    decodedTextBytes: 0,
    droppedIncompleteBytes: 0,
    invalidEncoding: false,
    truncated: false,
    observedAfterRetentionBytes: 0,
    logText: "",
    stopReason: null,
    terminatedByHost: false,
    groupGone: true,
    groupCheckMs: 0,
    launchStage: "unknown",
    hostRecordError: null,
    childExitObserved: true,
    watchdog: {
      protocol: "g2a2-watchdog-v1",
      armed: true,
      watchdogPid: 1235,
      watchdogSid: 1235,
      scriptPid: 1234,
      supervisorPid: process.pid,
      deadlineBasis: "python-monotonic",
      durationMs: 1000,
      graceMs: 100,
      armedAtMonotonic: 1,
      deadlineMonotonic: 1000,
      handshakeMs: 5,
      handshakeError: null,
      ackAttempted: true,
      ackSent: true,
      triggerReason: "script_exit",
      termSent: false,
      killSent: false,
      watchdogExitObserved: true,
      watchdogExitConfirmed: true,
      childExitObserved: true,
      controlEnded: true,
      controlError: null,
      unexpectedControlEof: false,
      controlEventLimit: 16,
      controlEventsRejected: 0,
      controlStreamBytes: 0,
      controlBytesDiscarded: 0,
      controlEvents: [],
      logRef: "fixture/watchdog.jsonl",
      logAvailable: false,
      pidGone: true,
      watchdogTerminated: true,
      watchdogKilledByHost: false,
      pidReuseCaveat: "fixture",
    },
    ...overrides,
  };
}

async function runWithoutDispatch(f: Fixture, outcome: Record<string, unknown>): Promise<ToolResult> {
  const adapter = f.entry.adapter as unknown as {
    dispatch: (...args: unknown[]) => Promise<Record<string, unknown>>;
  };
  const original = adapter.dispatch;
  adapter.dispatch = async (...args: unknown[]) => {
    const registerStop = args[6] as (stop: (reason: string) => void) => void;
    const onSpawned = args[7] as () => void;
    registerStop(() => undefined);
    onSpawned();
    return outcome;
  };
  try {
    const task = f.owner.snapshot().currentTask!;
    return await f.entry.adapter.run(f.ctx, {
      action: "run",
      runtime: "python",
      source: "print('fixture')\n",
      inputIds: [],
      expectedTaskId: task.taskId,
      expectedTaskRevision: task.taskRevision,
    });
  } finally {
    adapter.dispatch = original;
  }
}

describe("G2-B2-A delivery", () => {
  test("delivery tool is opt-in and describe reports honest coverage", async () => {
    const noDelivery = await fixture();
    try {
      expect([...noDelivery.tools.keys()].sort()).toEqual(["agent_execute", VERIFICATION_TOOL]);
    } finally {
      await noDelivery.cleanup();
    }
    const f = await fixture({ withDelivery: true, capabilities: ["local-script", "external-jobs"] });
    try {
      expect([...f.tools.keys()].sort()).toEqual(["agent_deliver", "agent_execute", VERIFICATION_TOOL]);
      const described = await f.tools.get(DELIVERY_TOOL)!.execute(
        "describe", { action: "describe" }, undefined, undefined, f.ctx,
      );
      expect(described.isError).toBeUndefined();
      const text = textOf(described);
      expect(text).toContain("taskAccepted: false");
      expect(text).toContain("acceptanceImplemented: true");
      expect(text).toContain("acceptanceConfigured: false");
      expect(text).toContain("submissionAvailable: false");
      expect(text).toContain("submissionReason: host_acceptance_root_not_configured");
      expect(text).toContain("candidateEligibility: not_checked");
      const coverage = JSON.parse(line(text, "activityCoverage: ")!) as {
        unsupportedCapabilityIds: string[];
        supportedCapabilityIds: string[];
      };
      expect(coverage.supportedCapabilityIds).toEqual(["local-script"]);
      expect(coverage.unsupportedCapabilityIds).toEqual(["external-jobs"]);
      const blocks = JSON.parse(line(text, "submissionBlockers: ")!) as string[];
      expect(blocks).toContain("acceptance_not_configured");
      expect(blocks).toContain("activity_coverage_unsupported");
      expect(text).not.toContain("ready-to-accept");
    } finally {
      await f.cleanup();
    }
  });

  test("real candidate files are frozen, rechecked, idempotent and tamper-evident", async () => {
    const f = await fixture({ withDelivery: true });
    try {
      const run = await runSource(f, SOURCE, ["alpha"]);
      expect(run.result.isError).toBeUndefined();
      const selection = run.artifacts.map((artifact) => artifact.artifactId);
      const first = await preview(f, { runId: run.runId, artifactIds: selection });
      expect(first.isError).toBeUndefined();
      const text = textOf(first);
      expect(text).toContain("taskAccepted: false");
      expect(text).toContain("submissionAvailable: false");
      const deliveryId = line(text, "deliveryId: ")!;
      expect(deliveryId).toMatch(/^delivery-/);
      const files = JSON.parse(line(text, "files: ")!) as Array<{
        artifactId: string;
        relativePath: string;
        name: string;
        path: string;
        bytes: number;
        sha256: string;
        preview: { inline?: boolean; text?: string; truncated?: boolean };
      }>;
      expect(files.length).toBe(run.artifacts.length);
      for (const row of files) {
        const bytes = await readFile(row.path);
        expect(bytes.length).toBe(row.bytes);
        expect(sha256(bytes)).toBe(row.sha256);
        const source = run.artifacts.find((artifact) => artifact.artifactId === row.artifactId)!;
        expect(source.sha256).toBe(row.sha256);
      }
      const escape = files.find((row) => row.relativePath === "escape.txt")!;
      expect(escape.preview.inline).toBe(true);
      expect(escape.preview.text).toContain("\\x1b");
      expect(escape.preview.text).not.toContain("\x1b");
      const binary = files.find((row) => row.relativePath === "binary.bin")!;
      expect(binary.preview.inline).toBe(false);
      const csv = files.find((row) => row.relativePath === "DATA.CSV")!;
      expect(csv.name.endsWith(".csv")).toBe(true);
      const long = files.find((row) => row.relativePath === "long.txt")!;
      expect(long.preview.inline).toBe(true);
      expect(long.preview.truncated).toBe(true);
      expect((long.preview as unknown as { shownBytes: number }).shownBytes).toBe(2048);
      expect((long.preview as unknown as { omittedBytes: number }).omittedBytes).toBeGreaterThan(0);

      const manifest = JSON.parse(line(text, "manifest: ")!) as { path: string };
      const manifestValue = JSON.parse(await readFile(manifest.path, "utf8")) as Record<string, unknown>;
      expect(manifestValue.deliveryId).toBe(deliveryId);
      expect((manifestValue.task as { taskId: string }).taskId).toBe(f.owner.snapshot().currentTask!.taskId);
      const sourceRow = manifestValue.source as { bytes: number; sha256: string };
      expect(sourceRow.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      const inputBytes = await readFile(f.inputPath);
      const inputRows = manifestValue.inputs as Array<{ id: string; bytes: number; sha256: string }>;
      expect(inputRows).toHaveLength(1);
      expect(inputRows[0]!.id).toBe("alpha");
      expect(inputRows[0]!.bytes).toBe(inputBytes.length);
      expect(inputRows[0]!.sha256).toBe(sha256(inputBytes));
      expect(manifestValue.receiptState).toBe("not_referenced");
      expect(manifestValue.contractState).toBe("none");

      const requirementsLine = line(text, "requirements: ") as string;
      const requirementsRef = JSON.parse(requirementsLine) as { path: string; sha256: string };
      const requirementsBytes = await readFile(requirementsRef.path);
      expect(sha256(requirementsBytes)).toBe(requirementsRef.sha256);
      const requirements = JSON.parse(requirementsBytes.toString("utf8")) as {
        sources: Array<{ text: string }>;
      };
      expect(requirements.sources[0]!.text).toBe("Produce a candidate artifact.");

      const firstInode = lstatSync(files[0]!.path).ino;
      const [concurrentA, concurrentB] = await Promise.all([
        preview(f, { runId: run.runId, artifactIds: selection }),
        preview(f, { runId: run.runId, artifactIds: selection }),
      ]);
      const concurrent = [concurrentA, concurrentB];
      expect(concurrent.filter((item) => item.isError === true)).toHaveLength(1);
      const concurrentSuccess = concurrent.find((item) => item.isError === undefined)!;
      expect((concurrentSuccess.details as { activity: { busy: boolean } }).activity.busy).toBe(false);
      expect(textOf(concurrent.find((item) => item.isError === true)!)).toContain("busy: true");
      expect(line(textOf(concurrentSuccess), "deliveryId: ")).toBe(deliveryId);

      const second = await preview(f, { runId: run.runId, artifactIds: selection });
      expect(second.isError).toBeUndefined();
      expect(line(textOf(second), "deliveryId: ")).toBe(deliveryId);
      expect(lstatSync(files[0]!.path).ino).toBe(firstInode);

      const wrongRun = await preview(f, { runId: "run-other-fixture", artifactIds: [selection[0]!] });
      expect(wrongRun.isError).toBe(true);
      expect(textOf(wrongRun)).not.toContain(f.deliveryRoot);

      const recheck = await f.entry.delivery!.recheck(f.ctx, {
        expectedTaskId: f.owner.snapshot().currentTask!.taskId,
        expectedTaskRevision: f.owner.snapshot().currentTask!.taskRevision,
        deliveryId,
      });
      expect(recheck.deliveryId).toBe(deliveryId);
      expect(recheck.files.length).toBe(files.length);

      chmodSync(files[0]!.path, 0o600);
      appendFileSync(files[0]!.path, "tampered");
      await expect(f.entry.delivery!.recheck(f.ctx, {
        expectedTaskId: f.owner.snapshot().currentTask!.taskId,
        expectedTaskRevision: f.owner.snapshot().currentTask!.taskRevision,
        deliveryId,
      })).rejects.toThrow(/changed|unexpected/i);
    } finally {
      await f.cleanup();
    }
  });

  test("receipt-linked preview validates the exact candidate set and reports honest outcome", async () => {
    const f = await fixture({ withDelivery: true, verifier: passVerifier() });
    try {
      f.entry.bindContract(f.ctx, passSpec());
      const run = await runSource(f);
      const selection = run.artifacts.map((artifact) => artifact.artifactId);
      const verified = await f.tools.get(VERIFICATION_TOOL)!.execute("verify", {
        action: "verify",
        expectedTaskId: f.owner.snapshot().currentTask!.taskId,
        expectedTaskRevision: f.owner.snapshot().currentTask!.taskRevision,
        runId: run.runId,
        artifactIds: selection,
      }, undefined, undefined, f.ctx);
      expect(verified.isError).toBeUndefined();
      const receiptId = (verified.details as { receiptId: string }).receiptId;

      const withReceipt = await preview(f, {
        runId: run.runId,
        artifactIds: selection,
        verificationReceiptId: receiptId,
      });
      expect(withReceipt.isError).toBeUndefined();
      const text = textOf(withReceipt);
      expect(text).toContain('"state":"referenced"');
      expect(text).toContain('"outcome":"pass"');
      expect(text).toContain(receiptId);

      const unknown = await preview(f, {
        runId: run.runId,
        artifactIds: selection,
        verificationReceiptId: "verification-unknown-fixture",
      });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toContain("unknown");
      expect(textOf(unknown)).not.toContain(f.deliveryRoot);

      const partial = await preview(f, {
        runId: run.runId,
        artifactIds: [selection[0]!],
        verificationReceiptId: receiptId,
      });
      expect(partial.isError).toBe(true);
      expect(textOf(partial)).toContain("candidate set");
    } finally {
      await f.cleanup();
    }
  });

  test("activity reports staging task, ignores clean unknown-stage completion and latches real anomalies", async () => {
    const f = await fixture();
    try {
      const task = f.owner.snapshot().currentTask!;
      const adapter = f.entry.adapter as unknown as {
        prepare: (...args: unknown[]) => Promise<unknown>;
      };
      const originalPrepare = adapter.prepare;
      let releasePrepare!: () => void;
      const gate = new Promise<void>((resolve) => {
        releasePrepare = resolve;
      });
      adapter.prepare = async (...args: unknown[]) => {
        await gate;
        return originalPrepare.apply(adapter, args);
      };
      const running = f.entry.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "open('staged.txt','w').write('ok')\n",
        inputIds: [],
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
      });
      const staging = f.entry.adapter.activitySnapshot();
      expect(staging.busy).toBe(true);
      expect(staging.busyTask).toEqual({ taskId: task.taskId, taskRevision: task.taskRevision });
      expect(staging.activeRunId).toBeNull();
      releasePrepare();
      const completed = await running;
      expect(completed.isError).toBeUndefined();
      adapter.prepare = originalPrepare;
      const idle = f.entry.adapter.activitySnapshot();
      expect(idle.busy).toBe(false);
      expect(idle.busyTask).toBeNull();
      expect(idle.unresolvedCompletions).toEqual([]);

      // launchStage "unknown" after a clean acknowledged run is an observation
      // boundary, not an unresolved completion.
      const cleanUnknown = await runWithoutDispatch(f, dispatchOutcome());
      expect(cleanUnknown.isError).toBeUndefined();
      expect(f.entry.adapter.activitySnapshot().unresolvedCompletions).toEqual([]);

      const anomalous = await runWithoutDispatch(f, dispatchOutcome({ groupGone: false }));
      expect(anomalous.isError).toBe(true);
      const afterAnomaly = await (async () => {
        const taskNow = f.owner.snapshot().currentTask!;
        return { taskNow };
      })();
      const latched = f.entry.adapter.activitySnapshot();
      expect(latched.busy).toBe(false);
      expect(latched.unresolvedCompletions.length).toBe(1);
      expect(latched.unresolvedCompletions[0]!.taskId).toBe(afterAnomaly.taskNow.taskId);
      expect(latched.unresolvedCompletions[0]!.taskRevision).toBe(afterAnomaly.taskNow.taskRevision);
      expect(latched.unresolvedCompletions[0]!.reasonCodes).toContain("process_group_unconfirmed");

      const throwing = f.entry.adapter as unknown as {
        dispatch: (...args: unknown[]) => Promise<Record<string, unknown>>;
      };
      const originalDispatch = throwing.dispatch;
      throwing.dispatch = async () => {
        throw new Error("fixture dispatch failure");
      };
      const taskNow = f.owner.snapshot().currentTask!;
      const failed = await f.entry.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('x')\n",
        inputIds: [],
        expectedTaskId: taskNow.taskId,
        expectedTaskRevision: taskNow.taskRevision,
      });
      throwing.dispatch = originalDispatch;
      expect(failed.isError).toBe(true);
      expect(f.entry.adapter.activitySnapshot().unresolvedCompletions.some(
        (item) => item.reasonCodes.includes("dispatch_outcome_unconfirmed"),
      )).toBe(true);

      f.entry.dispose();
      const disposed = f.entry.adapter.activitySnapshot();
      expect(disposed.disposed).toBe(true);
      expect(disposed.unresolvedCompletions.length).toBeGreaterThan(0);

      const nonzero = await (async () => {
        const scratch = await fixture();
        try {
          const result = await runSource(scratch, "raise SystemExit(3)\n");
          return { result, activity: scratch.entry.adapter.activitySnapshot() };
        } finally {
          await scratch.cleanup();
        }
      })();
      expect(nonzero.result.result.isError).toBe(true);
      expect(nonzero.activity.unresolvedCompletions).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("currentContract is read-only and preview rejects stale selectors before allocation", async () => {
    const f = await fixture({ withDelivery: true, verifier: passVerifier() });
    try {
      const before = f.entry.currentContract(f.ctx);
      expect(before.contract).toBeNull();
      expect(before.task.taskId).toBe(f.owner.snapshot().currentTask!.taskId);

      const bound = f.entry.bindContract(f.ctx, passSpec());
      const first = f.entry.currentContract(f.ctx);
      expect(first.contract!.contractId).toBe(bound.contractId);
      expect(first.contract!.digest).toBe(bound.digest);
      first.contract!.conditions[0]!.coveredRevisions.push(99);
      first.contract!.coverage.coveredRevisions.push(99);
      const second = f.entry.currentContract(f.ctx);
      expect(second.contract!.conditions[0]!.coveredRevisions).toEqual([1]);
      expect(second.contract!.coverage.coveredRevisions).toEqual([1]);
      expect(second.contract!.digest).toBe(bound.digest);

      const run = await runSource(f);
      const stale = await f.tools.get(DELIVERY_TOOL)!.execute("preview", {
        action: "preview",
        expectedTaskId: f.owner.snapshot().currentTask!.taskId,
        expectedTaskRevision: f.owner.snapshot().currentTask!.taskRevision + 1,
        runId: run.runId,
        artifactIds: [run.artifacts[0]!.artifactId],
      }, undefined, undefined, f.ctx);
      expect(stale.isError).toBe(true);
      expect(textOf(stale)).toContain("stale expectedTaskRevision");
      expect(textOf(stale)).not.toContain(f.deliveryRoot);
      expect(textOf(stale)).not.toContain("deliveryId");
    } finally {
      await f.cleanup();
    }
  });

  test("authority-shaped arguments and unsafe delivery roots are refused", async () => {
    const f = await fixture();
    try {
      const task = f.owner.snapshot().currentTask!;
      const baseArgs = {
        action: "preview",
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
        runId: "run-fixture",
        artifactIds: ["artifact-fixture"],
      };
      for (const extra of [
        { path: "/tmp/x" },
        { archiveRef: "run-fixture/artifact.bin" },
        { digest: "sha256:00" },
        { contract: {} },
        { manifest: {} },
        { deliveryRoot: "/tmp/elsewhere" },
      ]) {
        expect(() => parseDeliveryArguments({ ...baseArgs, ...extra })).toThrow(/authority/);
      }

      const fake = fakePi();
      expect(() => createExecutionEntry(fake.pi, {
        root: f.root,
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
        deliveryRoot: path.join(f.root, "nested-delivery"),
      })).toThrow(/overlap/);

      const real = path.join(f.workspace, "real-delivery");
      const link = path.join(f.workspace, "linked-delivery");
      await mkdir(real);
      await symlink(real, link);
      const fakeLink = fakePi();
      expect(() => createExecutionEntry(fakeLink.pi, {
        root: f.root,
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
        deliveryRoot: link,
      })).toThrow(/symbolic link/);

      const fakeRelative = fakePi();
      expect(() => createExecutionEntry(fakeRelative.pi, {
        root: f.root,
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
        deliveryRoot: "relative-delivery",
      })).toThrow(/absolute/);
    } finally {
      await f.cleanup();
    }
  });

  test("bidi controls are encoded in content while real bytes and requirements stay raw", async () => {
    const f = await fixture({ withDelivery: true });
    try {
      const source = [
        "from pathlib import Path",
        'Path("bidi.txt").write_bytes("safe\\u202eSpoof\\u202c\\x9b\\n".encode("utf-8"))',
        'Path("plain.txt").write_text("ok", encoding="utf-8")',
        "",
      ].join("\n");
      const run = await runSource(f, source);
      const first = await preview(f, {
        runId: run.runId,
        artifactIds: run.artifacts.map((artifact) => artifact.artifactId),
      });
      expect(first.isError).toBeUndefined();
      const text = textOf(first);
      expect(text).not.toContain("\u202e");
      expect(text).toContain("\\u202e");
      expect(text).toContain("\\x9b");
      const files = JSON.parse(line(text, "files: ")!) as Array<{
        relativePath: string;
        path: string;
        preview: { inline: boolean; text?: string };
      }>;
      const bidi = files.find((row) => row.relativePath === "bidi.txt")!;
      expect(bidi.preview.inline).toBe(true);
      expect(bidi.preview.text).toContain("\\u202e");
      expect(await readFile(bidi.path)).toEqual(Buffer.from("safe\u202eSpoof\u202c\u009b\n", "utf8"));

      const manifestRef = JSON.parse(line(text, "manifest: ")!) as { path: string };
      const manifest = JSON.parse(await readFile(manifestRef.path, "utf8")) as {
        previewDigest: string;
        previewPayload: Record<string, unknown>;
      };
      expect(manifest.previewDigest).toBe(sha256(JSON.stringify(manifest.previewPayload)));
      expect(JSON.stringify(manifest.previewPayload)).not.toContain("\u202e");
      expect(JSON.stringify(manifest.previewPayload)).not.toContain("activity\"");
      expect(text).toContain("previewDigestScope");
      const requirementsRef = JSON.parse(line(text, "requirements: ")!) as { path: string };
      const requirements = JSON.parse(await readFile(requirementsRef.path, "utf8")) as {
        sources: Array<{ text: string }>;
      };
      expect(requirements.sources[0]!.text).toBe("Produce a candidate artifact.");
      expect(text).not.toMatch(/(?:artifact|file):\/\/[^\s,;"')]+/);
    } finally {
      await f.cleanup();
    }
  });

  test("same-bytes metadata inode replacement is rejected", async () => {
    const f = await fixture({ withDelivery: true });
    try {
      const run = await runSource(f);
      const first = await preview(f, {
        runId: run.runId,
        artifactIds: run.artifacts.map((artifact) => artifact.artifactId),
      });
      expect(first.isError).toBeUndefined();
      const text = textOf(first);
      const deliveryId = line(text, "deliveryId: ")!;
      const task = f.owner.snapshot().currentTask!;
      const targets = [
        JSON.parse(line(text, "manifest: ")!).path,
        JSON.parse(line(text, "requirements: ")!).path,
      ] as string[];
      for (const [index, target] of targets.entries()) {
        const before = lstatSync(target);
        const bytes = await readFile(target);
        await rename(target, path.join(f.root, `metadata-${index}-original.json`));
        await writeFile(target, bytes, { flag: "wx", mode: 0o400 });
        expect(lstatSync(target).ino).not.toBe(before.ino);
        await expect(f.entry.delivery!.recheck(f.ctx, {
          expectedTaskId: task.taskId,
          expectedTaskRevision: task.taskRevision,
          deliveryId,
        })).rejects.toThrow(/changed/i);
      }
      const rejected = await preview(f, {
        runId: run.runId,
        artifactIds: run.artifacts.map((artifact) => artifact.artifactId),
      });
      expect(rejected.isError).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("staging collisions and metadata replacements never authorize recursive deletion", async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2a-collision-")));
    const f = await fixture();
    try {
      const run = await runSource(f);
      const isolatedRoot = path.join(parent, "collision-delivery");
      const service = new DeliveryService({
        owner: f.owner,
        candidates: f.entry.adapter.candidates,
        activity: () => f.entry.adapter.activitySnapshot(),
        currentContract: f.entry.currentContract,
        lookup: f.entry.lookup,
        deliveryRoot: isolatedRoot,
        executionRoot: f.root,
        id: () => "collision",
      });
      const preexisting = path.join(isolatedRoot, ".staging-delivery-collision");
      await mkdir(preexisting);
      const sentinel = path.join(preexisting, "existing-sentinel.txt");
      await writeFile(sentinel, "preexisting-not-created-by-current-preview");
      const task = f.owner.snapshot().currentTask!;
      try {
        const outcome = await service.preview(f.ctx, {
          expectedTaskId: task.taskId,
          expectedTaskRevision: task.taskRevision,
          runId: run.runId,
          artifactIds: run.artifacts.map((artifact) => artifact.artifactId),
        });
        expect(outcome.result.isError).toBe(true);
        expect(await readFile(sentinel, "utf8")).toBe("preexisting-not-created-by-current-preview");
      } finally {
        service.dispose();
      }
    } finally {
      await f.cleanup();
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("describe hides a task that navigates during currentContract", async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2a-describe-")));
    const f = await fixture();
    try {
      const old = f.owner.snapshot().currentTask!;
      let triggered = false;
      const service = new DeliveryService({
        owner: f.owner,
        candidates: f.entry.adapter.candidates,
        activity: () => f.entry.adapter.activitySnapshot(),
        currentContract: (ctx) => {
          const current = f.entry.currentContract(ctx);
          f.owner.navigate("session_tree", SESSION);
          triggered = true;
          return current;
        },
        lookup: f.entry.lookup,
        deliveryRoot: path.join(parent, "describe-race"),
        executionRoot: f.root,
      });
      const captured = new Map<string, RegisteredTool>();
      const entry = createDeliveryEntry({
        registerTool: (tool: RegisteredTool) => captured.set(tool.name, tool),
      } as Parameters<typeof createDeliveryEntry>[0], { owner: f.owner, service });
      try {
        const result = await captured.get(DELIVERY_TOOL)!.execute(
          "describe-race", { action: "describe" }, undefined, undefined, f.ctx,
        );
        expect(triggered).toBe(true);
        expect(f.owner.bindingStatus().state).toBe("detached");
        expect(textOf(result)).not.toContain(old.taskId);
        expect(JSON.stringify(result.details ?? {})).not.toContain(old.taskId);
      } finally {
        entry.dispose();
        service.dispose();
      }
    } finally {
      await f.cleanup();
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("abort after candidate and tool completion revokes delivery authority", async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2a-abort-")));
    const f = await fixture();
    try {
      const run = await runSource(f);
      const actual = f.entry.adapter.candidates;
      const controller = new AbortController();
      let armed = false;
      let triggered = false;
      const wrapped = {
        resolveSnapshot: (task: Parameters<typeof actual.resolveSnapshot>[0], selection: Parameters<typeof actual.resolveSnapshot>[1]) =>
          actual.resolveSnapshot(task, selection),
        async recheckSnapshot(snapshotId: string, task: Parameters<typeof actual.recheckSnapshot>[1]) {
          const value = await actual.recheckSnapshot(snapshotId, task);
          if (armed && !triggered) {
            triggered = true;
            controller.abort();
          }
          return value;
        },
      };
      const service = new DeliveryService({
        owner: f.owner,
        candidates: wrapped,
        activity: () => f.entry.adapter.activitySnapshot(),
        currentContract: f.entry.currentContract,
        lookup: f.entry.lookup,
        deliveryRoot: path.join(parent, "abort-delivery"),
        executionRoot: f.root,
      });
      const captured = new Map<string, RegisteredTool>();
      const entry = createDeliveryEntry({
        registerTool: (tool: RegisteredTool) => captured.set(tool.name, tool),
      } as Parameters<typeof createDeliveryEntry>[0], { owner: f.owner, service });
      const task = f.owner.snapshot().currentTask!;
      const guards = { expectedTaskId: task.taskId, expectedTaskRevision: task.taskRevision };
      try {
        const first = await service.preview(f.ctx, {
          ...guards,
          runId: run.runId,
          artifactIds: run.artifacts.map((artifact) => artifact.artifactId),
        });
        expect(first.result.isError).toBeUndefined();
        const deliveryId = line(textOf(first.result), "deliveryId: ")!;
        armed = true;
        await expect(service.recheck(f.ctx, { ...guards, deliveryId }, controller.signal))
          .rejects.toThrow(/aborted/i);
        expect(triggered).toBe(true);

        const toolController = new AbortController();
        const realPreview = service.preview.bind(service);
        service.preview = async (ctx, request, signal) => {
          const outcome = await realPreview(ctx, request, signal);
          toolController.abort();
          return outcome;
        };
        const result = await captured.get(DELIVERY_TOOL)!.execute("abort-after-service", {
          action: "preview",
          ...guards,
          runId: run.runId,
          artifactIds: run.artifacts.map((artifact) => artifact.artifactId),
        }, toolController.signal, undefined, f.ctx);
        expect(result.isError).toBe(true);
        expect(textOf(result)).not.toContain("bundleDir:");
      } finally {
        entry.dispose();
        service.dispose();
      }
    } finally {
      await f.cleanup();
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("new bundle preview re-reads live activity after its final candidate recheck", async () => {
    const f = await fixture();
    try {
      const run = await runSource(f);
      const actual = f.entry.adapter.candidates;
      let pending: Promise<unknown> | undefined;
      let triggered = false;
      const candidates = {
        resolveSnapshot: (
          task: Parameters<typeof actual.resolveSnapshot>[0],
          selection: Parameters<typeof actual.resolveSnapshot>[1],
        ) => actual.resolveSnapshot(task, selection),
        async recheckSnapshot(snapshotId: string, task: Parameters<typeof actual.recheckSnapshot>[1]) {
          const snapshot = await actual.recheckSnapshot(snapshotId, task);
          if (!triggered) {
            triggered = true;
            const current = f.owner.snapshot().currentTask!;
            pending = f.entry.adapter.run(f.ctx, {
              action: "run",
              runtime: "python",
              source: "import time\ntime.sleep(0.7)\n",
              inputIds: [],
              expectedTaskId: current.taskId,
              expectedTaskRevision: current.taskRevision,
            });
          }
          return snapshot;
        },
      };
      const service = new DeliveryService({
        owner: f.owner,
        candidates,
        activity: () => f.entry.adapter.activitySnapshot(),
        currentContract: f.entry.currentContract,
        lookup: f.entry.lookup,
        deliveryRoot: f.deliveryRoot,
        executionRoot: f.root,
      });
      try {
        const task = f.owner.snapshot().currentTask!;
        const preview = await service.preview(f.ctx, {
          expectedTaskId: task.taskId,
          expectedTaskRevision: task.taskRevision,
          runId: run.runId,
          artifactIds: run.artifacts.map((artifact) => artifact.artifactId),
        });
        expect(triggered).toBe(true);
        expect(f.entry.adapter.activitySnapshot().busy).toBe(true);
        expect(preview.result.isError).toBeUndefined();
        const activity = JSON.parse(line(textOf(preview.result), "activity: ")!) as { busy: boolean };
        expect(activity.busy).toBe(true);
        expect((preview.result.details as { activity: { busy: boolean } }).activity.busy).toBe(true);
      } finally {
        if (pending !== undefined) await pending;
        service.dispose();
      }
    } finally {
      await f.cleanup();
    }
  });

  test("post-dispatch host read failure latches the original unconfirmed completion", async () => {
    const f = await fixture();
    try {
      f.entry.dispose();
      const root = path.join(f.root, "post-dispatch-fault");
      await mkdir(root);
      const records: Array<Record<string, unknown>> = [];
      const adapter = new ExecutionAdapter(f.owner, {
        root,
        inputs: [],
        capabilityId: "local-script",
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
        dispatchWallMs: 2500,
        recordWriter: (filePath, value) => {
          records.push(value as Record<string, unknown>);
          writeFileSync(filePath, JSON.stringify(value));
        },
      });
      const original = f.owner.bindingStatus.bind(f.owner);
      let injected = false;
      f.owner.bindingStatus = () => {
        const activity = adapter.activitySnapshot();
        if (!injected && records.some((record) => record.phase === "running")
          && activity.busy && activity.activeRunId === null) {
          injected = true;
          throw new Error("fixture post-dispatch public host read fault");
        }
        return original();
      };
      const task = f.owner.snapshot().currentTask!;
      try {
        const result = await adapter.run(f.ctx, {
          action: "run",
          runtime: "python",
          source: "open('ok.txt','w').write('ok')\n",
          inputIds: [],
          expectedTaskId: task.taskId,
          expectedTaskRevision: task.taskRevision,
        });
        expect(injected).toBe(true);
        expect(result.isError).toBe(true);
        expect(records.some((record) => record.phase === "completed")).toBe(false);
        const activity = adapter.activitySnapshot();
        expect(activity.busy).toBe(false);
        expect(activity.unresolvedCompletions).toHaveLength(1);
        expect(activity.unresolvedCompletions[0]!.taskId).toBe(task.taskId);
        expect(activity.unresolvedCompletions[0]!.taskRevision).toBe(task.taskRevision);
      } finally {
        f.owner.bindingStatus = original;
        adapter.dispose();
      }
    } finally {
      await f.cleanup();
    }
  });

  test("simulated known no-spawn outcome plus final record fault stays a host diagnostic", async () => {
    const f = await fixture();
    try {
      f.entry.dispose();
      const root = path.join(f.root, "known-no-spawn-record-fault");
      await mkdir(root);
      const records: Array<Record<string, unknown>> = [];
      const adapter = new ExecutionAdapter(f.owner, {
        root,
        inputs: [],
        capabilityId: "local-script",
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
        recordWriter: (filePath, value) => {
          const record = value as Record<string, unknown>;
          records.push(record);
          if (record.phase === "completed") {
            throw new Error("fixture completed-record fault with known no spawn");
          }
          writeFileSync(filePath, JSON.stringify(value));
        },
      });
      const seam = adapter as unknown as {
        dispatch: (...args: unknown[]) => Promise<Record<string, unknown>>;
      };
      const watchdog = dispatchOutcome().watchdog as Record<string, unknown>;
      let dispatchCalls = 0;
      // Simulated local control seam: the trusted dispatch result reports that
      // no process was spawned, so this fixture creates no OS child.
      seam.dispatch = async () => {
        dispatchCalls += 1;
        return dispatchOutcome({
          spawned: false,
          spawnError: "fixture simulated synchronous spawn rejection",
          pid: null,
          pgid: null,
          exitCode: null,
          signal: null,
          durationMs: 0,
          stopReason: null,
          groupGone: true,
          groupCheckMs: 0,
          launchStage: "spawn_failed",
          childExitObserved: false,
          watchdog: {
            ...watchdog,
            armed: false,
            watchdogPid: null,
            watchdogSid: null,
            scriptPid: null,
            ackAttempted: false,
            ackSent: false,
            triggerReason: null,
            watchdogExitObserved: false,
            watchdogExitConfirmed: false,
            childExitObserved: false,
            controlEnded: false,
            logRef: "none",
            pidGone: null,
            watchdogTerminated: null,
          },
        });
      };
      const task = f.owner.snapshot().currentTask!;
      try {
        const result = await adapter.run(f.ctx, {
          action: "run",
          runtime: "python",
          source: "print('must not execute')\n",
          inputIds: [],
          expectedTaskId: task.taskId,
          expectedTaskRevision: task.taskRevision,
        });
        expect(dispatchCalls).toBe(1);
        const dispatch = (result.details as {
          dispatch: { spawned: boolean; pid: number | null };
        }).dispatch;
        expect(dispatch.spawned).toBe(false);
        expect(dispatch.pid).toBeNull();
        expect(result.isError).toBe(true);
        expect(records.some((record) => record.phase === "completed")).toBe(true);
        const activity = adapter.activitySnapshot();
        expect(activity.busy).toBe(false);
        expect(activity.unresolvedCompletions).toEqual([]);
      } finally {
        adapter.dispose();
      }
    } finally {
      await f.cleanup();
    }
  });

  test("partial semantic coverage and verifier explanations remain explicit", async () => {
    const detail = "fixture verifier says the semantic condition is insufficient";
    const verifier: TrustedVerifier = {
      id: "fixture-partial",
      version: "1",
      check() {
        return { conditions: [{ conditionId: "semantic", result: "insufficient", detail }] };
      },
    };
    const f = await fixture({ withDelivery: true, verifier });
    try {
      const task = f.owner.snapshot().currentTask!;
      f.entry.bindContract(f.ctx, {
        hostConfig: { id: "host-partial", version: "1" },
        verifier: { id: verifier.id, version: verifier.version, parameters: { secret: "PRIVATE_PARTIAL_871234" } },
        conditions: [{
          conditionId: "semantic",
          description: "partial semantic condition description",
          kind: "semantic",
          coveredRevisions: [task.taskRevision],
        }],
        coverage: {
          kind: "semantic",
          complete: false,
          coveredRevisions: [task.taskRevision],
          statement: "host says this is partial semantic coverage only",
        },
      });
      const run = await runSource(f);
      const selection = run.artifacts.map((artifact) => artifact.artifactId);
      const verified = await f.tools.get(VERIFICATION_TOOL)!.execute("verify", {
        action: "verify",
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
        runId: run.runId,
        artifactIds: selection,
      }, undefined, undefined, f.ctx);
      const receiptId = (verified.details as { receiptId: string }).receiptId;
      const first = await preview(f, { runId: run.runId, artifactIds: selection, verificationReceiptId: receiptId });
      expect(first.isError).toBeUndefined();
      const text = textOf(first);
      expect(text).toContain("host says this is partial semantic coverage only");
      expect(text).toContain("partial semantic condition description");
      expect(text).toContain(detail);
      expect(text).toContain("partial semantic coverage");
      expect(text).toContain("insufficient");
      expect(text).not.toContain("PRIVATE_PARTIAL_871234");
      const manifestRef = JSON.parse(line(text, "manifest: ")!) as { path: string };
      const manifest = JSON.parse(await readFile(manifestRef.path, "utf8")) as {
        previewDigest: string;
        previewPayload: {
          contract: { summary: { coverage: { statement: string; complete: boolean } } };
          verification: { receipt: { conditions: Array<{ detail: string }> } };
        };
      };
      expect(manifest.previewDigest).toBe(sha256(JSON.stringify(manifest.previewPayload)));
      expect(manifest.previewPayload.contract.summary.coverage.statement)
        .toBe("host says this is partial semantic coverage only");
      expect(manifest.previewPayload.contract.summary.coverage.complete).toBe(false);
      expect(manifest.previewPayload.verification.receipt.conditions[0]!.detail).toBe(detail);
    } finally {
      await f.cleanup();
    }
  });

  test("entry errors and describe explanations obey UTF-8 response budgets", async () => {
    const f = await fixture({ withDelivery: true, verifier: passVerifier() });
    try {
      const hugeKey = "中".repeat(12_000);
      const rejected = await f.tools.get(DELIVERY_TOOL)!.execute(
        "huge-key", { action: "preview", [hugeKey]: true }, undefined, undefined, f.ctx,
      );
      expect(rejected.isError).toBe(true);
      expect(Buffer.byteLength(textOf(rejected), "utf8")).toBeLessThanOrEqual(MAX_DELIVERY_CONTENT_BYTES);
      expect(Buffer.byteLength(JSON.stringify(rejected), "utf8")).toBeLessThanOrEqual(MAX_DELIVERY_RESPONSE_BYTES);

      const task = f.owner.snapshot().currentTask!;
      const description = "长".repeat(500);
      const conditions = Array.from({ length: 16 }, (_, index) => ({
        conditionId: `condition-${index}`,
        description,
        kind: "semantic" as const,
        coveredRevisions: [task.taskRevision],
      }));
      f.entry.bindContract(f.ctx, {
        hostConfig: { id: "host-budget", version: "1" },
        verifier: { id: "fixture-semantic", version: "1", parameters: {} },
        conditions,
        coverage: {
          kind: "semantic",
          complete: true,
          coveredRevisions: [task.taskRevision],
          statement: description,
        },
      });
      const described = await f.tools.get(DELIVERY_TOOL)!.execute(
        "describe-budget", { action: "describe" }, undefined, undefined, f.ctx,
      );
      expect(described.isError).toBeUndefined();
      expect(Buffer.byteLength(textOf(described), "utf8")).toBeLessThanOrEqual(MAX_DELIVERY_CONTENT_BYTES);
      expect(Buffer.byteLength(JSON.stringify(described), "utf8")).toBeLessThanOrEqual(MAX_DELIVERY_RESPONSE_BYTES);
      const contract = JSON.parse(line(textOf(described), "contract: ")!) as {
        state: string;
        summary: {
          coverage: { statementTruncated: boolean; statementOmittedBytes: number };
          conditions: Array<{ descriptionTruncated: boolean; descriptionOmittedBytes: number }>;
        };
      };
      expect(contract.state).toBe("bound");
      expect(contract.summary.coverage.statementTruncated).toBe(true);
      expect(contract.summary.coverage.statementOmittedBytes).toBeGreaterThan(0);
      expect(contract.summary.conditions[0]!.descriptionTruncated).toBe(true);
      expect(contract.summary.conditions[0]!.descriptionOmittedBytes).toBeGreaterThan(0);
    } finally {
      await f.cleanup();
    }
  });

  test("renaming a canonical delivery parent and linking it back is rejected", async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2a-parent-")));
    const deliveryRoot = path.join(parent, "root");
    const f = await fixture({ withDelivery: true, deliveryRoot });
    const saved = `${parent}-saved`;
    try {
      const run = await runSource(f);
      const first = await preview(f, {
        runId: run.runId,
        artifactIds: run.artifacts.map((artifact) => artifact.artifactId),
      });
      expect(first.isError).toBeUndefined();
      const files = JSON.parse(line(textOf(first), "files: ")!) as Array<{ path: string; bytes: number }>;
      const task = f.owner.snapshot().currentTask!;
      const deliveryId = line(textOf(first), "deliveryId: ")!;
      await rename(parent, saved);
      await symlink(saved, parent);
      const described = f.entry.delivery!.describe(f.ctx);
      expect(described.isError).toBeUndefined();
      expect(JSON.stringify(described.details ?? {})).not.toContain("rootChainVerified");
      expect(textOf(described)).not.toMatch(/rootChainVerified\s*:\s*true/);
      await expect(f.entry.delivery!.recheck(f.ctx, {
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
        deliveryId,
      })).rejects.toThrow(/ancestor|root|replaced/i);
      const rejected = await preview(f, {
        runId: run.runId,
        artifactIds: run.artifacts.map((artifact) => artifact.artifactId),
      });
      expect(rejected.isError).toBe(true);
      expect(textOf(rejected)).not.toContain(files[0]!.path);
      expect((await readFile(files[0]!.path)).length).toBe(files[0]!.bytes);
    } finally {
      await f.cleanup();
      await rm(saved, { recursive: true, force: true });
    }
  });
});
