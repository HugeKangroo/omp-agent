import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNativeEntry,
  type NativeContext,
  type NativeEntryControls,
  type NativeOmpApi,
  type NativeToolResult,
} from "../../src/native-entry.ts";
import {
  createNativeHarnessDelegation,
  type NativeHarnessBackend,
  type NativeHarnessDelegationCoordinator,
  type NativeHarnessOutputPort,
  type NativeHarnessOutputSelection,
  type NativeHarnessPrepareResult,
  type NativeHarnessDelegationResult,
} from "../../src/native-harness-delegation.ts";
import type { NativeHarnessOutputCapture } from "../../src/native-harness-output.ts";
import {
  NATIVE_HARNESS_MAX_CHECK_ACTIONS,
  NATIVE_HARNESS_RESULT_TOOL,
  normalizeNativeHarnessCaptureInput,
  normalizeNativeHarnessCheckInput,
  type NativeHarnessCheckOutcome,
  type NativeHarnessCheckSuccess,
} from "../../src/native-harness-checks.ts";
import {
  captureWorkspaceText,
  type NativeWorkspaceTextSnapshot,
} from "../../src/native-work.ts";
import type { NativeTextCheckCondition } from "../../src/native-snapshot-checker.ts";
import type { Runner, WorkerRequest, WorkerResult } from "../../vendor/harness2/index.ts";

const WORK_TASK = "do the bounded delegated task";
const PATH_A = "candidate.txt";

type RegisteredTool = Parameters<NativeOmpApi["registerTool"]>[0];
type Handler = (event: unknown, context: NativeContext) => unknown;

class Host {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, RegisteredTool>();
  readonly pi: NativeOmpApi;

  constructor() {
    const handlers = this.handlers;
    const tools = this.tools;
    this.pi = {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
    };
  }

  async emit(type: string, event: Record<string, unknown>, context: NativeContext): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(type) ?? []) {
      result = await handler({ ...event, type }, context);
    }
    return result;
  }
}

interface Fixture {
  root: string;
  workspace: string;
  host: Host;
  entry: NativeEntryControls;
  ctx: NativeContext;
}

const roots: string[] = [];
const entries: NativeEntryControls[] = [];
const coordinators: NativeHarnessDelegationCoordinator[] = [];

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
  for (const entry of entries.splice(0)) entry.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g53b1a-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const host = new Host();
  const ctx: NativeContext = {
    cwd: workspace,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId() {
        return "session-g53b1a";
      },
      getCwd() {
        return workspace;
      },
    },
  };
  const entry = createNativeEntry(host.pi);
  entries.push(entry);
  return { root, workspace, host, entry, ctx };
}

async function startWork(f: Fixture, prompt = "delegate this"): Promise<void> {
  await f.host.emit("input", { text: prompt, source: "rpc" }, f.ctx);
  await f.host.emit("before_agent_start", {
    reason: "prompt",
    prompt,
    systemPrompt: ["base"],
  }, f.ctx);
}

async function callSource(f: Fixture, toolCallId: string): Promise<void> {
  await f.host.emit("tool_call", {
    toolCallId,
    toolName: "agent_harness",
    input: { task: WORK_TASK },
  }, f.ctx);
}

function harnessBundle(): WorkerRequest["harness"] {
  return {
    schemaVersion: 1,
    id: "harness-1",
    promptAppend: "",
    toolGuidance: "",
    skills: [],
    rationale: "test",
  };
}

function completedResult(): WorkerResult {
  return {
    text: "worker text",
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
    startedAt: "2026-11-16T00:00:00.000Z",
    endedAt: "2026-11-16T00:00:01.000Z",
    eventsPath: "/tmp/events.jsonl",
    status: "completed",
  };
}

function runnerFor(handler: (request: WorkerRequest) => Promise<WorkerResult>): Runner {
  return { run: handler };
}

function projectionFor(result: NativeHarnessDelegationResult): NativeToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: result,
    isError: false,
  };
}

async function emitSourceResult(f: Fixture, toolCallId: string, wire: NativeToolResult): Promise<void> {
  await f.host.emit("tool_result", {
    toolCallId,
    toolName: "agent_harness",
    input: { task: WORK_TASK },
    content: wire.content,
    details: wire.details,
    isError: false,
  }, f.ctx);
}

async function settle<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("test promise timed out")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function syntheticCapture(
  task: string,
  changes: readonly { readonly path: string; readonly snapshot: NativeWorkspaceTextSnapshot }[],
): NativeHarnessOutputCapture {
  const first = changes[0];
  if (first === undefined) throw new Error("synthetic capture needs one change");
  return {
    schema: "omp-agent.native-harness-output-capture.v1",
    captureId: `synthetic-${first.snapshot.captureId}`,
    originKind: "harness2-native",
    completionId: "synthetic-completion",
    sourceId: "synthetic-source",
    runId: "run-1",
    taskSha256: createHash("sha256").update(task, "utf8").digest("hex"),
    baseSnapshotId: "synthetic-base",
    manifestSha256: "0".repeat(64),
    winner: { candidate: "baseline", attempt: 1, artifactHash: "0".repeat(64), traceHash: "0".repeat(64) },
    changes: changes.map((change) => ({
      path: change.path,
      kind: "add" as const,
      mode: 0o600,
      controllerHash: "0".repeat(64),
      snapshot: change.snapshot,
    })),
    sources: [],
    baseInputs: [],
    stages: [],
    digest: "0".repeat(64),
    observedAt: 1,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    limitations: [],
  };
}

interface Harness {
  coordinator: NativeHarnessDelegationCoordinator;
  captureCalls(): number;
  executeCalls(): number;
}

function setup(
  f: Fixture,
  hooks: {
    output?: NativeHarnessOutputPort;
    getContext?: () => NativeContext;
    capture?: () => NativeHarnessOutputCapture;
    runner?: Runner;
    native?: NativeEntryControls;
    now?: () => number;
  } = {},
): Harness {
  let captureCalls = 0;
  let executeCalls = 0;
  const output = hooks.output ?? {
    async capture(): Promise<{ ok: true; capture: NativeHarnessOutputCapture }> {
      captureCalls += 1;
      if (hooks.capture === undefined) throw new Error("missing capture fixture");
      return { ok: true as const, capture: hooks.capture() };
    },
    matches() {
      return true;
    },
    revalidateOwner() {
      return null;
    },
  };
  const runner = hooks.runner ?? runnerFor(async () => completedResult());
  const coordinator = createNativeHarnessDelegation({
    native: hooks.native ?? f.entry,
    policy: {
      maxRetainedOperations: 16,
      maxConcurrent: 1,
      perRunUsd: 1,
      lifetimeUsd: 5,
      maxDurationMs: 5000,
      cleanupGraceMs: 20,
    },
    getContext: hooks.getContext ?? (() => f.ctx),
    prepare: (request): NativeHarnessPrepareResult => {
      request.guard();
      const backend: NativeHarnessBackend = {
        async create() {
          return { runId: "run-1" };
        },
        async execute() {
          executeCalls += 1;
          return { status: "completed" };
        },
        async cancel() {
          return undefined;
        },
      };
      return { ok: true, backend };
    },
    runner,
    output,
    ...(hooks.now === undefined ? {} : { now: hooks.now }),
    enabled: true,
  });
  coordinators.push(coordinator);
  return { coordinator, captureCalls: () => captureCalls, executeCalls: () => executeCalls };
}

interface CapturedSource {
  readonly signal: AbortSignal;
  readonly result: NativeHarnessDelegationResult;
  readonly capture: NativeHarnessOutputCapture;
}

async function captureSource(f: Fixture, h: Harness, toolCallId: string): Promise<CapturedSource> {
  await callSource(f, toolCallId);
  const signal = new AbortController().signal;
  const result = await settle(h.coordinator.invoke(toolCallId, { task: WORK_TASK }, signal));
  expect(result.outcome).toBe("backend-completed");
  const wire = projectionFor(result);
  const registered = h.coordinator.registerToolResultProjection(toolCallId, result, wire, signal);
  expect(registered.ok).toBe(true);
  await emitSourceResult(f, toolCallId, wire);
  const selection = await settle(h.coordinator.captureOutput(toolCallId, new AbortController().signal));
  expect(selection.ok).toBe(true);
  if (!selection.ok) throw new Error(selection.reason);
  return { signal, result, capture: selection.capture };
}

function checkInput(
  sourceToolCallId: string,
  capture: NativeHarnessOutputCapture,
  path: string,
  conditions: readonly unknown[],
): Record<string, unknown> {
  return {
    action: "check",
    sourceToolCallId,
    captureId: capture.captureId,
    captureDigest: capture.digest,
    path,
    conditions,
  };
}

async function preflightCheck(
  f: Fixture,
  toolCallId: string,
  rawInput: unknown,
): Promise<void> {
  const normalized = normalizeNativeHarnessCheckInput(rawInput);
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error(normalized.reason);
  await f.host.emit("tool_call", {
    toolCallId,
    toolName: NATIVE_HARNESS_RESULT_TOOL,
    input: normalized.input,
  }, f.ctx);
}

function checkWire(response: NativeHarnessCheckSuccess): NativeToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    details: response,
    isError: false,
  };
}

async function emitCheckResult(
  f: Fixture,
  toolCallId: string,
  wire: NativeToolResult,
  input: unknown,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await f.host.emit("tool_result", {
    toolCallId,
    toolName: NATIVE_HARNESS_RESULT_TOOL,
    input,
    content: wire.content,
    details: wire.details,
    isError: false,
    ...overrides,
  }, f.ctx);
}

function expectCheckSuccess(value: NativeHarnessCheckOutcome): NativeHarnessCheckSuccess {
  if (!value.ok) throw new Error(`check refused: ${value.code}: ${value.reason}`);
  expect(value.ok).toBe(true);
  return value;
}

function inspectProjection(f: Fixture, toolCallId: string): string | null {
  const captured = f.entry.captureCall({ toolCallId, toolName: NATIVE_HARNESS_RESULT_TOOL }, f.ctx);
  if (!captured.ok) return null;
  return captured.inspection.resultProjection?.state ?? null;
}

async function checkedFixture(
  conditions: readonly unknown[] = [{ id: "has-thing", kind: "text-includes", value: "thing" }],
  text = "the thing is present",
): Promise<{
  f: Fixture;
  h: Harness;
  source: CapturedSource;
  raw: Record<string, unknown>;
  normalizedInput: unknown;
}> {
  const f = await fixture();
  await writeFile(path.join(f.workspace, PATH_A), text, { mode: 0o600 });
  const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
  const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
  const h = setup(f, { capture: () => capture });
  await startWork(f);
  const source = await captureSource(f, h, "source-1");
  const raw = checkInput("source-1", capture, PATH_A, conditions);
  await preflightCheck(f, "check-1", raw);
  const normalized = normalizeNativeHarnessCheckInput(raw);
  if (!normalized.ok) throw new Error(normalized.reason);
  return { f, h, source, raw, normalizedInput: normalized.input };
}

function captureActionInput(sourceToolCallId: string): Record<string, unknown> {
  return { action: "capture", sourceToolCallId };
}

async function preflightCaptureAction(
  f: Fixture,
  toolCallId: string,
  rawInput: unknown,
): Promise<void> {
  const normalized = normalizeNativeHarnessCaptureInput(rawInput);
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error(normalized.reason);
  await f.host.emit("tool_call", {
    toolCallId,
    toolName: NATIVE_HARNESS_RESULT_TOOL,
    input: normalized.input,
  }, f.ctx);
}

function captureWire(selection: NativeHarnessOutputSelection): NativeToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(selection) }],
    details: selection,
    isError: false,
  };
}

async function emitCaptureResult(
  f: Fixture,
  toolCallId: string,
  wire: NativeToolResult,
  input: unknown,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await f.host.emit("tool_result", {
    toolCallId,
    toolName: NATIVE_HARNESS_RESULT_TOOL,
    input,
    content: wire.content,
    details: wire.details,
    isError: false,
    ...overrides,
  }, f.ctx);
}

async function registeredSource(
  f: Fixture,
  h: Harness,
  toolCallId: string,
): Promise<NativeHarnessDelegationResult> {
  await callSource(f, toolCallId);
  const signal = new AbortController().signal;
  const result = await settle(h.coordinator.invoke(toolCallId, { task: WORK_TASK }, signal));
  expect(result.outcome).toBe("backend-completed");
  const wire = projectionFor(result);
  expect(h.coordinator.registerToolResultProjection(toolCallId, result, wire, signal).ok).toBe(true);
  await emitSourceResult(f, toolCallId, wire);
  return result;
}

async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, ms = 1000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await tick(2);
  }
}

describe("host-only bounded checks over a captured Harness Slot", () => {
  test("real snapshot checks return authentic PASS/FAIL without capture, backend or FS effects", async () => {
    const f = await fixture();
    const pathB = "other.txt";
    await writeFile(path.join(f.workspace, PATH_A), '{"ok":true,"name":"candidate"}', { mode: 0o600 });
    await writeFile(path.join(f.workspace, pathB), "unrelated text", { mode: 0o600 });
    const snapshotA = await captureWorkspaceText(f.workspace, PATH_A);
    const snapshotB = await captureWorkspaceText(f.workspace, pathB);
    const capture = syntheticCapture(WORK_TASK, [
      { path: PATH_A, snapshot: snapshotA },
      { path: pathB, snapshot: snapshotB },
    ]);
    const h = setup(f, { capture: () => capture });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    expect(source.capture.captureId).toBe(capture.captureId);
    expect(h.captureCalls()).toBe(1);
    expect(h.executeCalls()).toBe(1);

    const passRaw = checkInput("source-1", capture, PATH_A, [
      { id: "ok", kind: "text-includes", value: '"ok":true' },
    ]);
    await preflightCheck(f, "check-pass", passRaw);
    const signal = new AbortController().signal;
    const pass = expectCheckSuccess(h.coordinator.checkOutput("check-pass", passRaw, signal));
    expect(pass.receipt.outcome).toBe("pass");
    expect(pass.receipt.snapshot.captureId).toBe(snapshotA.captureId);
    expect(pass.receipt.snapshot.file).toEqual(snapshotA.file);
    expect(pass.checkerId).toBe("omp-agent.native-text-checks");
    expect(pass.checkerVersion).toBe("1");
    expect(pass.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(pass.planSource).toBe("model-proposed-after-capture");
    expect(pass.observation).toBe("cached-historical");
    expect(pass.filesystemFreshness).toBe("not-rechecked");
    expect(pass.taskAccepted).toBe(false);
    expect(pass.semanticAcceptance).toBe("not-evaluated");
    expect(pass.computedByToolCallId).toBe("check-pass");
    expect(JSON.stringify(pass)).not.toContain(snapshotA.text);
    expect(Object.isFrozen(pass)).toBe(true);
    expect(Object.isFrozen(pass.receipt)).toBe(true);

    const failRaw = checkInput("source-1", capture, pathB, [
      { id: "absent", kind: "text-includes", value: "NOT-PRESENT" },
    ]);
    await preflightCheck(f, "check-fail", failRaw);
    const fail = expectCheckSuccess(h.coordinator.checkOutput("check-fail", failRaw, signal));
    expect(fail.receipt.outcome).toBe("fail");
    expect(fail.receipt.snapshot.captureId).toBe(snapshotB.captureId);
    expect(fail.ok).toBe(true);

    expect(h.captureCalls()).toBe(1);
    expect(h.executeCalls()).toBe(1);
    const snapshotState = h.coordinator.inspect();
    expect(snapshotState.output.retainedCaptures).toBe(1);
    expect(snapshotState.output.reservedBytes).toBe(0);
    expect(snapshotState.operations[0]!.output.checks).toMatchObject({
      paths: 2,
      actions: 2,
    });
    expect(snapshotState.operations[0]!.output.checks.retainedBytes).toBeGreaterThan(0);
  });

  test("same action/input returns the exact response; another action reuses the historical receipt", async () => {
    const { f, h, source, raw, normalizedInput } = await checkedFixture();
    const signal = new AbortController().signal;
    const first = expectCheckSuccess(h.coordinator.checkOutput("check-1", raw, signal));
    const again = h.coordinator.checkOutput("check-1", raw, signal);
    expect(again).toBe(first);

    const rawSecond = checkInput("source-1", source.capture, PATH_A, [
      { id: "has-thing", kind: "text-includes", value: "thing" },
    ]);
    await preflightCheck(f, "check-2", rawSecond);
    const second = expectCheckSuccess(h.coordinator.checkOutput("check-2", rawSecond, signal));
    expect(second).not.toBe(first);
    expect(second.receipt).toBe(first.receipt);
    expect(second.planDigest).toBe(first.planDigest);
    expect(second.computedByToolCallId).toBe("check-1");
    expect(second.checkToolCallId).toBe("check-2");

    // A different plan for the same captured path refuses and cannot replace
    // the retained receipt or create another path/action record.
    const differentRaw = checkInput("source-1", source.capture, PATH_A, [
      { id: "different", kind: "json-valid" },
    ]);
    await preflightCheck(f, "check-3", differentRaw);
    const refused = h.coordinator.checkOutput("check-3", differentRaw, signal);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("source-conflict");
    const replay = h.coordinator.checkOutput("check-1", raw, signal);
    expect(replay).toBe(first);
    const state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.paths).toBe(1);
    expect(state.actions).toBe(2);
    void normalizedInput;
  });

  test("foreign selectors, mismatched effective input and malformed reflection refuse without records", async () => {
    const { f, h, source, raw } = await checkedFixture();
    const signal = new AbortController().signal;

    const wrongCapture = {
      ...raw,
      captureId: "another-capture",
    };
    const wrongCaptureOutcome = h.coordinator.checkOutput("check-foreign", wrongCapture, signal);
    expect(wrongCaptureOutcome.ok).toBe(false);
    if (!wrongCaptureOutcome.ok) expect(wrongCaptureOutcome.code).toBe("source-conflict");

    const wrongPath = { ...raw, path: "missing.txt" };
    const wrongPathOutcome = h.coordinator.checkOutput("check-foreign", wrongPath, signal);
    expect(wrongPathOutcome.ok).toBe(false);
    if (!wrongPathOutcome.ok) expect(wrongPathOutcome.code).toBe("source-conflict");

    const unknownSource = { ...raw, sourceToolCallId: "source-foreign" };
    const unknownSourceOutcome = h.coordinator.checkOutput("check-foreign", unknownSource, signal);
    expect(unknownSourceOutcome.ok).toBe(false);
    if (!unknownSourceOutcome.ok) expect(unknownSourceOutcome.code).toBe("not-ready");

    // The retained source capture has no second path; a new selector path is
    // refused before any action record or metadata is committed.
    const before = h.coordinator.inspect().operations[0]!.output.checks;
    expect(before.paths).toBe(0);
    expect(before.actions).toBe(0);

    // Effective preflight input differs from the frozen normalized input.
    const preflightRaw = checkInput("source-1", source.capture, PATH_A, [
      { id: "ok", kind: "text-includes", value: "thing" },
    ]);
    const callerRaw = checkInput("source-1", source.capture, PATH_A, [
      { id: "ok", kind: "text-includes", value: "different" },
    ]);
    await preflightCheck(f, "check-mismatch", preflightRaw);
    const mismatch = h.coordinator.checkOutput("check-mismatch", callerRaw, signal);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("protocol");
    // A genuine ref with a different effective input is not admission: it
    // consumes no action slot and does not poison the correct input.
    const afterMismatch = h.coordinator.inspect().operations[0]!.output.checks;
    expect(afterMismatch.paths).toBe(0);
    expect(afterMismatch.actions).toBe(0);
    expect(afterMismatch.retainedBytes).toBe(0);
    const corrected = expectCheckSuccess(h.coordinator.checkOutput("check-mismatch", preflightRaw, signal));
    expect(corrected.receipt.outcome).toBe("pass");

    // Accessor and throwing reflection are refused without executing getters.
    let getterCalls = 0;
    const accessorInput = Object.defineProperty({}, "action", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "check";
      },
    });
    const accessorOutcome = h.coordinator.checkOutput("check-malformed", accessorInput, signal);
    expect(accessorOutcome.ok).toBe(false);
    expect(getterCalls).toBe(0);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const revokedOutcome = h.coordinator.checkOutput("check-malformed", revoked.proxy, signal);
    expect(revokedOutcome.ok).toBe(false);
    const afterMalformed = h.coordinator.inspect().operations[0]!.output.checks;
    expect(afterMalformed.paths).toBe(1);
    expect(afterMalformed.actions).toBe(1);
    expect(afterMalformed.retainedBytes).toBeGreaterThan(0);
  });

  test("pending input and pre-aborted signals refuse without partial commit", async () => {
    const { f, h, raw } = await checkedFixture();
    const signal = new AbortController().signal;

    await f.host.emit("input", { text: "queued follow-up", source: "rpc" }, f.ctx);
    const pending = h.coordinator.checkOutput("check-1", raw, signal);
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.code).toBe("authority-lost");
    let state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.paths).toBe(0);
    expect(state.actions).toBe(0);

    const aborted = new AbortController();
    aborted.abort();
    const abortedOutcome = h.coordinator.checkOutput("check-2", raw, aborted.signal);
    expect(abortedOutcome.ok).toBe(false);
    if (!abortedOutcome.ok) expect(abortedOutcome.code).toBe("cancelled");
    state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.paths).toBe(0);
    expect(state.actions).toBe(0);
  });

  test("source observation conflict refuses access without deleting historical check records", async () => {
    const { f, h, source, raw } = await checkedFixture();
    const signal = new AbortController().signal;
    const first = expectCheckSuccess(h.coordinator.checkOutput("check-1", raw, signal));

    const sourceWire = projectionFor(source.result);
    await emitSourceResult(f, "source-1", {
      ...sourceWire,
      content: [{ type: "text", text: "changed" }],
    });
    const conflicted = h.coordinator.checkOutput("check-2", raw, signal);
    expect(conflicted.ok).toBe(false);
    if (!conflicted.ok) expect(conflicted.code).toBe("source-conflict");
    const state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.paths).toBe(1);
    expect(state.actions).toBe(1);
    expect(first.receipt.outcome).toBe("pass");
  });

  test("source work drift and disposal refuse without rewriting completed check evidence", async () => {
    const { f, h, raw } = await checkedFixture();
    const signal = new AbortController().signal;
    const first = expectCheckSuccess(h.coordinator.checkOutput("check-1", raw, signal));

    await f.host.emit("session_switch", {}, f.ctx);
    const drifted = h.coordinator.checkOutput("check-2", raw, signal);
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(drifted.code).toBe("authority-lost");

    h.coordinator.dispose();
    const disposed = h.coordinator.checkOutput("check-1", raw, signal);
    expect(disposed.ok).toBe(false);
    if (!disposed.ok) expect(disposed.code).toBe("authority-lost");
    const state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.paths).toBe(1);
    expect(state.actions).toBe(1);
    expect(first.receipt.outcome).toBe("pass");
  });

  test("reused path retains the original plan conditions and computation identity", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "thing", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    const collected: unknown[] = [];
    const nativePort = {
      captureCall: (selector: unknown, context: NativeContext) =>
        f.entry.captureCall(selector as { toolCallId: string; toolName: string }, context),
      prepareCallCheck: (ref: unknown, context: NativeContext) =>
        f.entry.prepareCallCheck(ref, context),
      registerCallResultExpectation: (
        ref: unknown,
        expected: { readonly input: unknown; readonly result: unknown },
        context: NativeContext,
      ) => {
        collected.push(expected.input);
        return f.entry.registerCallResultExpectation!(ref, expected, context);
      },
    } as unknown as NativeEntryControls;
    const h = setup(f, { capture: () => capture, native: nativePort });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    const signal = new AbortController().signal;
    const conditions = [{ id: "has-thing", kind: "text-includes", value: "thing" }];
    const raw = checkInput("source-1", source.capture, PATH_A, conditions);

    await preflightCheck(f, "check-1", raw);
    const first = expectCheckSuccess(h.coordinator.checkOutput("check-1", raw, signal));
    await preflightCheck(f, "check-2", raw);
    const second = expectCheckSuccess(h.coordinator.checkOutput("check-2", raw, signal));
    expect(second.receipt).toBe(first.receipt);
    expect(second.computedByToolCallId).toBe(first.computedByToolCallId);
    expect(second.planDigest).toBe(first.planDigest);

    expect(h.coordinator.registerOutputCheckProjection("source-1", "check-1", first, checkWire(first), signal).ok).toBe(true);
    expect(h.coordinator.registerOutputCheckProjection("source-1", "check-2", second, checkWire(second), signal).ok).toBe(true);
    const checkInputs = collected.filter((input) =>
      (input as { readonly action?: unknown }).action === "check");
    expect(checkInputs).toHaveLength(2);
    const firstInput = checkInputs[0] as { readonly conditions: readonly unknown[] };
    const secondInput = checkInputs[1] as { readonly conditions: readonly unknown[] };
    expect(firstInput).not.toBe(secondInput);
    expect(firstInput.conditions).toBe(secondInput.conditions);
    expect(Object.isFrozen(firstInput.conditions)).toBe(true);
  });

  test("caller-wire reflection reentry sees the owned lock and cannot register twice", async () => {
    const { f, h, raw } = await checkedFixture();
    const signal = new AbortController().signal;
    const response = expectCheckSuccess(h.coordinator.checkOutput("check-1", raw, signal));
    const wire = checkWire(response);
    let reentries = 0;
    const nested: Array<{ readonly ok: boolean; readonly reason: string | null }> = [];
    let tricky!: NativeToolResult;
    tricky = new Proxy(wire, {
      getOwnPropertyDescriptor(target, property) {
        if (reentries < 4) {
          reentries += 1;
          nested.push(h.coordinator.registerOutputCheckProjection(
            "source-1",
            "check-1",
            response,
            tricky,
            signal,
          ));
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const outer = h.coordinator.registerOutputCheckProjection("source-1", "check-1", response, tricky, signal);
    expect(outer.ok).toBe(true);
    expect(reentries).toBeGreaterThan(0);
    expect(nested.length).toBe(reentries);
    for (const refusal of nested) {
      expect(refusal.ok).toBe(false);
      expect(refusal.reason).toContain("already in progress");
    }
    expect(inspectProjection(f, "check-1")).toBe("pending");
  });

  test("post-capture abort keeps a terminal action and never retries the same call", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "thing", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    const controller = new AbortController();
    let armed = false;
    const nativePort = {
      captureCall: (selector: unknown, context: NativeContext) =>
        f.entry.captureCall(selector as { toolCallId: string; toolName: string }, context),
      registerCallResultExpectation: (
        ref: unknown,
        expected: { readonly input: unknown; readonly result: unknown },
        context: NativeContext,
      ) => f.entry.registerCallResultExpectation!(ref, expected, context),
      prepareCallCheck: (ref: unknown, context: NativeContext) => {
        if (armed
          && (ref as { readonly toolCallId?: unknown }).toolCallId === "check-1"
          && !controller.signal.aborted) {
          controller.abort();
        }
        return f.entry.prepareCallCheck(ref, context);
      },
    } as unknown as NativeEntryControls;
    const h = setup(f, { capture: () => capture, native: nativePort });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    const raw = checkInput("source-1", source.capture, PATH_A, [
      { id: "has-thing", kind: "text-includes", value: "thing" },
    ]);
    await preflightCheck(f, "check-1", raw);
    armed = true;
    const refused = h.coordinator.checkOutput("check-1", raw, controller.signal);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("cancelled");
    let state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state).toEqual({ paths: 0, actions: 1, retainedBytes: 0 });

    // Neither a new signal nor the original aborted signal can take over the
    // same actual action call, and no replacement action ref is captured.
    const newSignal = new AbortController().signal;
    const newSignalRetry = h.coordinator.checkOutput("check-1", raw, newSignal);
    expect(newSignalRetry.ok).toBe(false);
    if (!newSignalRetry.ok) expect(newSignalRetry.code).toBe("invalid-caller");
    const abortedRetry = h.coordinator.checkOutput("check-1", raw, controller.signal);
    expect(abortedRetry.ok).toBe(false);
    if (!abortedRetry.ok) expect(abortedRetry.code).toBe("cancelled");
    state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state).toEqual({ paths: 0, actions: 1, retainedBytes: 0 });

    // A new real action may still use the untouched original capture.
    await preflightCheck(f, "check-2", raw);
    const allowed = expectCheckSuccess(h.coordinator.checkOutput("check-2", raw, newSignal));
    expect(allowed.computedByToolCallId).toBe("check-2");
    state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.paths).toBe(1);
    expect(state.actions).toBe(2);
    expect(state.retainedBytes).toBeGreaterThan(0);
  });

  test("owner loss after action capture keeps a terminal action and never retries the same call", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "thing", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    let ownerRefused = false;
    let armed = false;
    let fired = false;
    let capturesAtTrigger = 0;
    let actionCaptures = 0;
    const nativePort = {
      captureCall: (selector: unknown, context: NativeContext) => {
        if ((selector as { readonly toolCallId?: unknown }).toolCallId === "check-1") {
          actionCaptures += 1;
        }
        return f.entry.captureCall(selector as { toolCallId: string; toolName: string }, context);
      },
      registerCallResultExpectation: (
        ref: unknown,
        expected: { readonly input: unknown; readonly result: unknown },
        context: NativeContext,
      ) => f.entry.registerCallResultExpectation!(ref, expected, context),
      prepareCallCheck: (ref: unknown, context: NativeContext) => {
        if (armed
          && !fired
          && (ref as { readonly toolCallId?: unknown }).toolCallId === "check-1") {
          fired = true;
          capturesAtTrigger = actionCaptures;
          ownerRefused = true;
        }
        return f.entry.prepareCallCheck(ref, context);
      },
    } as unknown as NativeEntryControls;
    const h = setup(f, {
      capture: () => capture,
      native: nativePort,
      output: {
        async capture() {
          return { ok: true as const, capture };
        },
        matches() {
          return true;
        },
        revalidateOwner() {
          return ownerRefused ? "owner lost after original real action capture" : null;
        },
      },
    });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    const signal = new AbortController().signal;
    const raw = checkInput("source-1", source.capture, PATH_A, [
      { id: "has-thing", kind: "text-includes", value: "thing" },
    ]);
    await preflightCheck(f, "check-1", raw);

    // The owner flips during the later native check preparation, after the
    // original action was captured with the exact frozen input.
    armed = true;
    const refused = h.coordinator.checkOutput("check-1", raw, signal);
    expect(fired).toBe(true);
    expect(capturesAtTrigger).toBe(1);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("authority-lost");
      expect(refused.reason).toContain("owner lost after original real action capture");
    }
    let state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state).toEqual({ paths: 0, actions: 1, retainedBytes: 0 });

    // The authenticated action is terminal: the original signal replays the
    // recorded refusal and a replacement signal cannot take over the call.
    // Neither retry may capture or prepare the action reference again.
    ownerRefused = false;
    armed = false;
    const originalRetry = h.coordinator.checkOutput("check-1", raw, signal);
    expect(originalRetry.ok).toBe(false);
    if (!originalRetry.ok) expect(originalRetry.reason).toBe("owner lost after original real action capture");
    const newSignalRetry = h.coordinator.checkOutput("check-1", raw, new AbortController().signal);
    expect(newSignalRetry.ok).toBe(false);
    if (!newSignalRetry.ok) expect(newSignalRetry.code).toBe("invalid-caller");
    expect(actionCaptures).toBe(1);
    state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state).toEqual({ paths: 0, actions: 1, retainedBytes: 0 });

    // A genuinely new actual action may still use the untouched original capture.
    await preflightCheck(f, "check-2", raw);
    const allowed = expectCheckSuccess(h.coordinator.checkOutput("check-2", raw, new AbortController().signal));
    expect(allowed.computedByToolCallId).toBe("check-2");
    state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.paths).toBe(1);
    expect(state.actions).toBe(2);
    expect(state.retainedBytes).toBeGreaterThan(0);
  });

  test("owner refusal with a changed path cannot poison a successful action", async () => {
    const f = await fixture();
    const pathB = "other.txt";
    await writeFile(path.join(f.workspace, PATH_A), "thing", { mode: 0o600 });
    await writeFile(path.join(f.workspace, pathB), "other", { mode: 0o600 });
    const snapshotA = await captureWorkspaceText(f.workspace, PATH_A);
    const snapshotB = await captureWorkspaceText(f.workspace, pathB);
    const capture = syntheticCapture(WORK_TASK, [
      { path: PATH_A, snapshot: snapshotA },
      { path: pathB, snapshot: snapshotB },
    ]);
    let ownerRefused = false;
    const h = setup(f, {
      output: {
        async capture() {
          return { ok: true as const, capture };
        },
        matches() {
          return true;
        },
        revalidateOwner() {
          return ownerRefused ? "the owner was replaced" : null;
        },
      },
    });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    const signal = new AbortController().signal;
    const conditions = [{ id: "has-thing", kind: "text-includes", value: "thing" }];
    const rawA = checkInput("source-1", source.capture, PATH_A, conditions);
    await preflightCheck(f, "check-1", rawA);
    const first = expectCheckSuccess(h.coordinator.checkOutput("check-1", rawA, signal));

    ownerRefused = true;
    const changed = checkInput("source-1", source.capture, pathB, conditions);
    const refused = h.coordinator.checkOutput("check-1", changed, signal);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("authority-lost");

    ownerRefused = false;
    const replay = h.coordinator.checkOutput("check-1", rawA, signal);
    expect(replay).toBe(first);
    const state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.paths).toBe(1);
    expect(state.actions).toBe(1);
  });

  test("initial owner refusal consumes no action slot and does not poison the same call", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "thing", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    let ownerRefused = false;
    const h = setup(f, {
      output: {
        async capture() {
          return { ok: true as const, capture };
        },
        matches() {
          return true;
        },
        revalidateOwner() {
          return ownerRefused ? "the owner was replaced" : null;
        },
      },
    });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    const signal = new AbortController().signal;
    const raw = checkInput("source-1", source.capture, PATH_A, [
      { id: "has-thing", kind: "text-includes", value: "thing" },
    ]);
    await preflightCheck(f, "check-1", raw);

    ownerRefused = true;
    const refused = h.coordinator.checkOutput("check-1", raw, signal);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("authority-lost");
    let state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state).toEqual({ paths: 0, actions: 0, retainedBytes: 0 });

    ownerRefused = false;
    const accepted = expectCheckSuccess(h.coordinator.checkOutput("check-1", raw, signal));
    expect(accepted.receipt.outcome).toBe("pass");
    state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.paths).toBe(1);
    expect(state.actions).toBe(1);
  });

  test("owner refusal with a changed wire cannot mark registration unusable", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "thing", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    let ownerRefused = false;
    const h = setup(f, {
      output: {
        async capture() {
          return { ok: true as const, capture };
        },
        matches() {
          return true;
        },
        revalidateOwner() {
          return ownerRefused ? "the owner was replaced" : null;
        },
      },
    });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    const signal = new AbortController().signal;
    const raw = checkInput("source-1", source.capture, PATH_A, [
      { id: "has-thing", kind: "text-includes", value: "thing" },
    ]);
    await preflightCheck(f, "check-1", raw);
    const response = expectCheckSuccess(h.coordinator.checkOutput("check-1", raw, signal));
    const wire = checkWire(response);
    expect(h.coordinator.registerOutputCheckProjection("source-1", "check-1", response, wire, signal).ok).toBe(true);

    ownerRefused = true;
    const changedWire: NativeToolResult = {
      content: [{ type: "text", text: "changed" }],
      details: response,
      isError: false,
    };
    const refused = h.coordinator.registerOutputCheckProjection(
      "source-1",
      "check-1",
      response,
      changedWire,
      signal,
    );
    expect(refused.ok).toBe(false);
    if (refused.reason !== null) expect(refused.reason).toContain("owner");
    ownerRefused = false;
    const again = h.coordinator.registerOutputCheckProjection("source-1", "check-1", response, wire, signal);
    expect(again.ok).toBe(true);
    expect(inspectProjection(f, "check-1")).toBe("pending");
  });

  test("retained action selector A to B to A is sticky; different signal/context do not poison", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "thing", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    let foreignContext = false;
    const h = setup(f, {
      capture: () => capture,
      getContext: () => {
        if (!foreignContext) return f.ctx;
        return {
          ...f.ctx,
          sessionManager: {
            getSessionId() {
              return "foreign-session";
            },
            getCwd() {
              return f.workspace;
            },
          },
        };
      },
    });
    await startWork(f);
    await callSource(f, "source-a");
    const sourceA = await captureSource(f, h, "source-a");
    await callSource(f, "source-b");
    const sourceB = await captureSource(f, h, "source-b");

    const conditions = [{ id: "has-thing", kind: "text-includes", value: "thing" }];
    const rawA = checkInput("source-a", sourceA.capture, PATH_A, conditions);
    const rawB = checkInput("source-b", sourceB.capture, PATH_A, conditions);
    await preflightCheck(f, "check-a", rawA);
    const signal = new AbortController().signal;
    const admitted = expectCheckSuccess(h.coordinator.checkOutput("check-a", rawA, signal));

    // A different signal cannot join or poison the retained action.
    const wrongSignal = h.coordinator.checkOutput("check-a", rawB, new AbortController().signal);
    expect(wrongSignal.ok).toBe(false);
    if (!wrongSignal.ok) expect(wrongSignal.code).toBe("invalid-caller");
    const afterWrongSignal = h.coordinator.checkOutput("check-a", rawA, signal);
    expect(afterWrongSignal).toBe(admitted);

    // A foreign context is refused before the retained action is marked.
    foreignContext = true;
    const wrongContext = h.coordinator.checkOutput("check-a", rawB, signal);
    expect(wrongContext.ok).toBe(false);
    if (!wrongContext.ok) expect(wrongContext.code).toBe("authority-lost");
    foreignContext = false;
    const afterWrongContext = h.coordinator.checkOutput("check-a", rawA, signal);
    expect(afterWrongContext).toBe(admitted);

    // The same authenticated action changing its source selector is sticky.
    const changed = h.coordinator.checkOutput("check-a", rawB, signal);
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.code).toBe("source-conflict");
    const restored = h.coordinator.checkOutput("check-a", rawA, signal);
    expect(restored.ok).toBe(false);
    if (!restored.ok) expect(restored.code).toBe("source-conflict");
    const state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.paths).toBe(1);
    expect(state.actions).toBe(1);
    expect(admitted.receipt.outcome).toBe("pass");
  });

  test("registration is pending until the native observer matches the exact wire", async () => {
    const { f, h, source, raw, normalizedInput } = await checkedFixture([
      { id: "absent", kind: "text-includes", value: "NOT-PRESENT" },
    ], "nothing matches");
    const signal = new AbortController().signal;
    const response = expectCheckSuccess(h.coordinator.checkOutput("check-1", raw, signal));
    expect(response.receipt.outcome).toBe("fail");
    const wire = checkWire(response);

    expect(h.coordinator.registerOutputCheckProjection("source-1", "check-1", { ...response }, wire, signal).ok).toBe(false);
    expect(h.coordinator.registerOutputCheckProjection("source-1", "check-1", response, wire, new AbortController().signal).ok).toBe(false);
    expect(h.coordinator.registerOutputCheckProjection("source-2", "check-1", response, wire, signal).ok).toBe(false);
    expect(h.coordinator.registerOutputCheckProjection("source-1", "check-2", response, wire, signal).ok).toBe(false);
    expect(h.coordinator.registerOutputCheckProjection("source-1", "check-1", response, wire, signal).ok).toBe(true);
    expect(h.coordinator.registerOutputCheckProjection("source-1", "check-1", response, wire, signal).ok).toBe(true);

    expect(inspectProjection(f, "check-1")).toBe("pending");
    await emitCheckResult(f, "check-1", wire, normalizedInput);
    expect(inspectProjection(f, "check-1")).toBe("matched");
    const matchedCapture = f.entry.captureCall({ toolCallId: "check-1", toolName: NATIVE_HARNESS_RESULT_TOOL }, f.ctx);
    expect(matchedCapture.ok).toBe(true);
    if (!matchedCapture.ok) throw new Error("the observed check action was not retained");
    await emitCheckResult(f, "check-1", {
      ...wire,
      content: [{ type: "text", text: "changed" }],
    }, normalizedInput);
    const conflicted = f.entry.inspectCall(matchedCapture.ref, f.ctx);
    expect(conflicted.resultProjection?.state).toBe("conflicted");
    expect(response.receipt.outcome).toBe("fail");

    // A differing projection is sticky unusable for this action, but the
    // historical check evidence stays retained.
    expect(h.coordinator.registerOutputCheckProjection("source-1", "check-1", response, wire, signal).ok).toBe(false);
    const state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.paths).toBe(1);
    expect(state.actions).toBe(1);
    expect(source.capture.captureId).toBe(response.captureId);
  });

  test("oversized normalized registration is refused while the check remains retained", async () => {
    const { h, raw } = await checkedFixture();
    const signal = new AbortController().signal;
    const response = expectCheckSuccess(h.coordinator.checkOutput("check-1", raw, signal));
    const huge = {
      content: [{ type: "text", text: "x".repeat(70 * 1024) }],
      details: response,
      isError: false,
    };
    const refused = h.coordinator.registerOutputCheckProjection("source-1", "check-1", response, huge, signal);
    expect(refused.ok).toBe(false);
    if (refused.reason !== null) expect(refused.reason).toContain("result expectation unavailable");
    expect(h.coordinator.inspect().operations[0]!.output.checks.actions).toBe(1);
  });

  test("reentrant identity and registration callbacks refuse busy without replacing the outer record", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "thing", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    let coordinatorRef: NativeHarnessDelegationCoordinator | null = null;
    let nesting = false;
    const reentry: {
      armed: boolean;
      raw: Record<string, unknown> | null;
      signal: AbortSignal | null;
      response: NativeHarnessCheckSuccess | null;
      wire: NativeToolResult | null;
      admission: NativeHarnessCheckOutcome | null;
      registration: ReturnType<NativeHarnessDelegationCoordinator["registerOutputCheckProjection"]> | null;
    } = {
      armed: false,
      raw: null,
      signal: null,
      response: null,
      wire: null,
      admission: null,
      registration: null,
    };
    const h = setup(f, {
      capture: () => capture,
      getContext: () => {
        if (reentry.armed
          && !nesting
          && coordinatorRef !== null
          && reentry.raw !== null
          && reentry.signal !== null) {
          nesting = true;
          try {
            if (reentry.admission === null) {
              reentry.admission = coordinatorRef.checkOutput("check-1", reentry.raw, reentry.signal);
            } else if (reentry.registration === null && reentry.response !== null && reentry.wire !== null) {
              reentry.registration = coordinatorRef.registerOutputCheckProjection(
                "source-1",
                "check-1",
                reentry.response,
                reentry.wire,
                reentry.signal,
              );
            }
          } finally {
            nesting = false;
          }
        }
        return f.ctx;
      },
    });
    coordinatorRef = h.coordinator;
    await startWork(f);
    await captureSource(f, h, "source-1");
    const raw = checkInput("source-1", capture, PATH_A, [
      { id: "has-thing", kind: "text-includes", value: "thing" },
    ]);
    await preflightCheck(f, "check-1", raw);
    const signal = new AbortController().signal;
    reentry.raw = raw;
    reentry.signal = signal;
    reentry.armed = true;
    const response = expectCheckSuccess(h.coordinator.checkOutput("check-1", raw, signal));
    const nestedAdmission = reentry.admission as NativeHarnessCheckOutcome | null;
    expect(nestedAdmission).not.toBeNull();
    if (nestedAdmission !== null) {
      expect(nestedAdmission.ok).toBe(false);
      if (!nestedAdmission.ok) expect(nestedAdmission.reason).toContain("already in progress");
    }
    reentry.response = response;
    const wire = checkWire(response);
    reentry.wire = wire;
    const registered = h.coordinator.registerOutputCheckProjection(
      "source-1",
      "check-1",
      response,
      wire,
      signal,
    );
    expect(registered.ok).toBe(true);
    const nestedRegistration = reentry.registration as ReturnType<
      NativeHarnessDelegationCoordinator["registerOutputCheckProjection"]
    > | null;
    expect(nestedRegistration).not.toBeNull();
    if (nestedRegistration !== null) expect(nestedRegistration.ok).toBe(false);
    expect(h.coordinator.inspect().operations[0]!.output.checks.actions).toBe(1);
  });

  test("check action capacity is bounded at sixteen retained actions", async () => {
    const { f, h, source, normalizedInput } = await checkedFixture();
    const signal = new AbortController().signal;
    const raw = checkInput("source-1", source.capture, PATH_A, [
      { id: "has-thing", kind: "text-includes", value: "thing" },
    ]);
    expect(normalizedInput).toBeDefined();
    for (let index = 0; index < NATIVE_HARNESS_MAX_CHECK_ACTIONS; index++) {
      const id = `action-${index}`;
      await preflightCheck(f, id, raw);
      const response = h.coordinator.checkOutput(id, raw, signal);
      expect(response.ok).toBe(true);
    }
    await preflightCheck(f, "action-17", raw);
    const overflow = h.coordinator.checkOutput("action-17", raw, signal);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.code).toBe("capacity");
    const state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.actions).toBe(NATIVE_HARNESS_MAX_CHECK_ACTIONS);
    expect(state.paths).toBe(1);
  });

  test("check metadata is bounded at 32 conditions and 64 KiB combined plans and receipts", async () => {
    const f = await fixture();
    const paths = Array.from({ length: 6 }, (_, index) => `nested/file-${index}.txt`);
    for (const relative of paths) {
      await mkdir(path.join(f.workspace, "nested"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(f.workspace, relative), "x", { mode: 0o600 });
    }
    const snapshots = [];
    for (const relative of paths) {
      snapshots.push({ path: relative, snapshot: await captureWorkspaceText(f.workspace, relative) });
    }
    const capture = syntheticCapture(WORK_TASK, snapshots);
    const h = setup(f, { capture: () => capture });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    const signal = new AbortController().signal;

    // 32-condition total budget: one retained path with 20, a second with 13.
    const firstConditions = Array.from({ length: 20 }, (_, index) => ({
      id: `c${index}`,
      kind: "json-valid" as const,
    }));
    const secondConditions = Array.from({ length: 13 }, (_, index) => ({
      id: `d${index}`,
      kind: "json-valid" as const,
    }));
    const firstRaw = checkInput("source-1", source.capture, paths[0]!, firstConditions);
    await preflightCheck(f, "check-conditions-1", firstRaw);
    expect(h.coordinator.checkOutput("check-conditions-1", firstRaw, signal).ok).toBe(true);
    const secondRaw = checkInput("source-1", source.capture, paths[1]!, secondConditions);
    await preflightCheck(f, "check-conditions-2", secondRaw);
    const conditionOverflow = h.coordinator.checkOutput("check-conditions-2", secondRaw, signal);
    expect(conditionOverflow.ok).toBe(false);
    if (!conditionOverflow.ok) expect(conditionOverflow.code).toBe("capacity");
    expect(h.coordinator.inspect().operations[0]!.output.checks.paths).toBe(1);

    // 64 KiB combined metadata: four 4096-byte text conditions per path.
    const largeConditions = (prefix: string) => [0, 1, 2].map((index) => ({
      id: `${prefix}${index}`,
      kind: "text-includes" as const,
      value: "a".repeat(4096),
    }));
    let accepted = 1;
    let capacitySeen = false;
    for (let index = 1; index < paths.length; index++) {
      const raw = checkInput("source-1", source.capture, paths[index]!, largeConditions(`p${index}c`));
      await preflightCheck(f, `check-large-${index}`, raw);
      const response = h.coordinator.checkOutput(`check-large-${index}`, raw, signal);
      if (!response.ok && response.code === "capacity") {
        capacitySeen = true;
        break;
      }
      expect(response.ok).toBe(true);
      accepted += 1;
    }
    expect(capacitySeen).toBe(true);
    expect(accepted).toBeGreaterThan(1);
    const state = h.coordinator.inspect().operations[0]!.output.checks;
    expect(state.retainedBytes).toBeLessThanOrEqual(64 * 1024);
    expect(state.paths).toBe(accepted);
  });

  test("capture action performs one guarded capture and registers the exact projection", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "capture action text\n", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    const h = setup(f, { capture: () => capture });
    await startWork(f);
    await registeredSource(f, h, "source-1");
    const raw = captureActionInput("source-1");
    await preflightCaptureAction(f, "cap-1", raw);
    const signal = new AbortController().signal;
    const first = h.coordinator.captureOutputForCall("cap-1", raw, signal);
    const joined = h.coordinator.captureOutputForCall("cap-1", raw, signal);
    expect(joined).toBe(first);
    const selection = await settle(first);
    expect(selection.ok).toBe(true);
    if (!selection.ok) throw new Error(selection.reason);
    expect(selection.capture).toBe(capture);
    expect(selection.association).toMatchObject({
      toolCallId: "source-1",
      toolName: "agent_harness",
    });
    expect(selection.observation).toBe("captured-now");
    expect(h.captureCalls()).toBe(1);
    expect(h.executeCalls()).toBe(1);

    const wire = captureWire(selection);
    const copiedResponse = { ...selection };
    expect(h.coordinator.registerOutputCaptureProjection(
      "source-1",
      "cap-1",
      copiedResponse,
      wire,
      signal,
    ).ok).toBe(false);
    expect(h.coordinator.registerOutputCaptureProjection(
      "source-1",
      "cap-1",
      selection,
      wire,
      new AbortController().signal,
    ).ok).toBe(false);
    expect(h.coordinator.registerOutputCaptureProjection(
      "source-2",
      "cap-1",
      selection,
      wire,
      signal,
    ).ok).toBe(false);
    const oversized: NativeToolResult = {
      content: [{ type: "text", text: "a".repeat(70 * 1024) }],
      details: selection,
      isError: false,
    };
    expect(h.coordinator.registerOutputCaptureProjection(
      "source-1",
      "cap-1",
      selection,
      oversized,
      signal,
    ).ok).toBe(false);
    expect(h.coordinator.registerOutputCaptureProjection(
      "source-1",
      "cap-1",
      selection,
      wire,
      signal,
    ).ok).toBe(true);
    expect(h.coordinator.registerOutputCaptureProjection(
      "source-1",
      "cap-1",
      selection,
      wire,
      signal,
    ).ok).toBe(true);
    await emitCaptureResult(f, "cap-1", wire, raw);
    const replay = await settle(h.coordinator.captureOutputForCall("cap-1", raw, signal));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.capture).toBe(capture);
      expect(replay.observation).toBe("captured-now");
    }
    expect(h.captureCalls()).toBe(1);

    // An altered duplicate action result remains a source conflict.
    await emitCaptureResult(f, "cap-1", wire, raw, {
      content: [{ type: "text", text: "changed action result" }],
    });
    const alteredReplay = await settle(h.coordinator.captureOutputForCall("cap-1", raw, signal));
    expect(alteredReplay.ok).toBe(false);
    if (!alteredReplay.ok) expect(alteredReplay.code).toBe("source-conflict");
    expect(h.captureCalls()).toBe(1);
  });

  test("invalid capture actions perform zero I/O and consume zero action slots", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "reject me\n", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    const h = setup(f, { capture: () => capture });
    await startWork(f);
    await registeredSource(f, h, "source-1");
    const signal = new AbortController().signal;
    const accessor = Object.defineProperty({}, "action", {
      enumerable: true,
      get() {
        throw new Error("getter must not run");
      },
    });
    const rejected: unknown[] = [
      null,
      { action: "check", sourceToolCallId: "source-1" },
      { action: "capture", sourceToolCallId: "source-1", extra: true },
      accessor,
      captureActionInput("source-missing"),
      captureActionInput("source-1"),
    ];
    for (const [index, value] of rejected.entries()) {
      const actionId = index === rejected.length - 1 ? "source-1" : `bad-${index}`;
      const outcome = await settle(h.coordinator.captureOutputForCall(actionId, value, signal));
      expect(outcome.ok).toBe(false);
    }
    expect(h.captureCalls()).toBe(0);
    expect(h.coordinator.inspect().operations[0]!.output.checks.actions).toBe(0);
    expect(h.coordinator.inspect().output.reservedBytes).toBe(0);
  });

  test("cancel through the actual action id keeps the launched promise pending until leaf settlement", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "cancelled leaf\n", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captureCalls = 0;
    const port: NativeHarnessOutputPort = {
      capture() {
        captureCalls += 1;
        return gate.then(() => ({ ok: true as const, capture }));
      },
      matches() {
        return true;
      },
      revalidateOwner() {
        return null;
      },
    };
    const h = setup(f, { output: port });
    await startWork(f);
    await registeredSource(f, h, "source-1");
    const raw = captureActionInput("source-1");
    await preflightCaptureAction(f, "cap-1", raw);
    const signal = new AbortController().signal;
    const pending = h.coordinator.captureOutputForCall("cap-1", raw, signal);
    expect(captureCalls).toBe(1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    expect(h.coordinator.cancel("cap-1")).toBe(true);
    await tick(10);
    expect(settled).toBe(false);
    expect(h.coordinator.cancel("cap-1")).toBe(false);
    expect(h.coordinator.inspect().output.reservedBytes).toBe(1024 * 1024);
    expect(h.executeCalls()).toBe(1);
    release();
    const outcome = await settle(pending);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("cancelled");
    await waitFor(() => h.coordinator.inspect().output.reservedBytes === 0, "reservation release");
    expect(h.coordinator.inspect().output.retainedCaptures).toBe(0);
    expect(captureCalls).toBe(1);
    expect(h.executeCalls()).toBe(1);
  });

  test("a cooperative guard checkpoint expires the bound action budget without retention", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "expired leaf\n", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    let clock = 1000;
    let captureCalls = 0;
    const port: NativeHarnessOutputPort = {
      capture(_backend: unknown, guard: () => void) {
        captureCalls += 1;
        clock += 31_000;
        try {
          guard();
        } catch (error) {
          return Promise.reject(error);
        }
        return Promise.resolve({ ok: true as const, capture });
      },
      matches() {
        return true;
      },
      revalidateOwner() {
        return null;
      },
    };
    const h = setup(f, { output: port, now: () => clock });
    await startWork(f);
    await registeredSource(f, h, "source-1");
    const raw = captureActionInput("source-1");
    await preflightCaptureAction(f, "cap-1", raw);
    const outcome = await settle(h.coordinator.captureOutputForCall(
      "cap-1",
      raw,
      new AbortController().signal,
    ));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("deadline");
    expect(captureCalls).toBe(1);
    expect(h.coordinator.inspect().output.retainedCaptures).toBe(0);
    expect(h.coordinator.inspect().output.reservedBytes).toBe(0);
  });

  test("dispose settles a bound capture and does not start a new run", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "disposed leaf\n", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port: NativeHarnessOutputPort = {
      capture() {
        return gate.then(() => ({ ok: true as const, capture }));
      },
      matches() {
        return true;
      },
      revalidateOwner() {
        return null;
      },
    };
    const h = setup(f, { output: port });
    await startWork(f);
    await registeredSource(f, h, "source-1");
    const raw = captureActionInput("source-1");
    await preflightCaptureAction(f, "cap-1", raw);
    const pending = h.coordinator.captureOutputForCall("cap-1", raw, new AbortController().signal);
    h.coordinator.dispose();
    expect(h.coordinator.inspect().output.reservedBytes).toBe(1024 * 1024);
    release();
    const outcome = await settle(pending);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("cancelled");
    await waitFor(() => h.coordinator.inspect().output.reservedBytes === 0, "disposed reservation release");
    expect(h.executeCalls()).toBe(1);
  });

  test("cross-type action ids are sticky without poisoning foreign calls", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "the thing is present\n", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    const h = setup(f, { capture: () => capture });
    await startWork(f);
    await registeredSource(f, h, "source-1");
    const rawCapture = captureActionInput("source-1");
    await preflightCaptureAction(f, "cap-1", rawCapture);
    const actionSignal = new AbortController().signal;
    const captured = await settle(h.coordinator.captureOutputForCall("cap-1", rawCapture, actionSignal));
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error(captured.reason);
    const checkRaw = checkInput("source-1", captured.capture, PATH_A, [
      { id: "thing", kind: "text-includes", value: "thing" },
    ]);
    const wrongSignal = h.coordinator.checkOutput(
      "cap-1",
      checkRaw,
      new AbortController().signal,
    );
    expect(wrongSignal.ok).toBe(false);
    const crossType = h.coordinator.checkOutput("cap-1", checkRaw, actionSignal);
    expect(crossType.ok).toBe(false);
    if (!crossType.ok) expect(crossType.code).toBe("source-conflict");
    const replay = await settle(h.coordinator.captureOutputForCall("cap-1", rawCapture, actionSignal));
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe("source-conflict");
  });

  test("a capture request on a check action id is a sticky changed type", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "the thing is present\n", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    const h = setup(f, { capture: () => capture });
    await startWork(f);
    await captureSource(f, h, "source-1");
    const rawCheck = checkInput("source-1", capture, PATH_A, [
      { id: "thing", kind: "text-includes", value: "thing" },
    ]);
    await preflightCheck(f, "check-1", rawCheck);
    const signal = new AbortController().signal;
    expect(h.coordinator.checkOutput("check-1", rawCheck, signal).ok).toBe(true);
    const rawCapture = captureActionInput("source-1");
    const refused = await settle(h.coordinator.captureOutputForCall("check-1", rawCapture, signal));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("source-conflict");
    const replay = h.coordinator.checkOutput("check-1", rawCheck, signal);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe("source-conflict");
    expect(h.captureCalls()).toBe(1);
  });

  test("cached late owner loss is terminal for the original action and preserves history", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "cached history\n", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    let ownerCalls = 0;
    let loseAfter = -1;
    let captureCalls = 0;
    const port: NativeHarnessOutputPort = {
      async capture() {
        captureCalls += 1;
        return { ok: true as const, capture };
      },
      matches() {
        return true;
      },
      revalidateOwner() {
        ownerCalls += 1;
        return loseAfter >= 0 && ownerCalls > loseAfter ? "the owner was lost" : null;
      },
    };
    const h = setup(f, { output: port });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    const retainedBytes = h.coordinator.inspect().operations[0]!.output.retainedBytes;
    const raw = captureActionInput("source-1");
    await preflightCaptureAction(f, "cap-1", raw);
    loseAfter = ownerCalls + 1;
    const originalSignal = new AbortController().signal;
    const failed = await settle(h.coordinator.captureOutputForCall("cap-1", raw, originalSignal));
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe("authority-lost");
    expect(captureCalls).toBe(1);
    expect(h.coordinator.inspect().output.reservedBytes).toBe(0);
    expect(h.coordinator.inspect().output.retainedCaptures).toBe(1);
    expect(h.coordinator.inspect().operations[0]!.output.retainedBytes).toBe(retainedBytes);
    expect(h.coordinator.inspect().operations[0]!.output.captureId).toBe(source.capture.captureId);

    loseAfter = -1;
    const retryNewSignal = await settle(h.coordinator.captureOutputForCall(
      "cap-1",
      raw,
      new AbortController().signal,
    ));
    expect(retryNewSignal.ok).toBe(false);
    if (!retryNewSignal.ok) expect(retryNewSignal.code).toBe("invalid-caller");
    const retryOriginal = await settle(h.coordinator.captureOutputForCall(
      "cap-1",
      raw,
      originalSignal,
    ));
    expect(retryOriginal.ok).toBe(false);
    if (!retryOriginal.ok) expect(retryOriginal.code).toBe("authority-lost");
    expect(captureCalls).toBe(1);
    expect(h.coordinator.inspect().operations[0]!.output.captureId).toBe(source.capture.captureId);
  });

  test("cancel through the actual id during cached selection prevents success", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "cached cancel\n", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    let coordinatorRef!: NativeHarnessDelegationCoordinator;
    let ownerCalls = 0;
    let cancelAt = -1;
    let cancelResult: boolean | null = null;
    let captureCalls = 0;
    const port: NativeHarnessOutputPort = {
      async capture() {
        captureCalls += 1;
        return { ok: true as const, capture };
      },
      matches() {
        return true;
      },
      revalidateOwner() {
        ownerCalls += 1;
        if (cancelAt >= 0 && ownerCalls === cancelAt) {
          cancelResult = coordinatorRef.cancel("cap-1");
        }
        return null;
      },
    };
    const h = setup(f, { output: port });
    coordinatorRef = h.coordinator;
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    const retainedBytes = h.coordinator.inspect().operations[0]!.output.retainedBytes;
    const raw = captureActionInput("source-1");
    await preflightCaptureAction(f, "cap-1", raw);
    cancelAt = ownerCalls + 2;
    const outcome = await settle(h.coordinator.captureOutputForCall(
      "cap-1",
      raw,
      new AbortController().signal,
    ));
    expect(cancelResult as boolean | null).toBe(true);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("cancelled");
    expect(captureCalls).toBe(1);
    expect(h.coordinator.inspect().output.reservedBytes).toBe(0);
    expect(h.coordinator.inspect().output.retainedCaptures).toBe(1);
    expect(h.coordinator.inspect().operations[0]!.output.retainedBytes).toBe(retainedBytes);
    expect(h.coordinator.inspect().operations[0]!.output.captureId).toBe(source.capture.captureId);
  });

  test("a completed source id never cancels a current cached action", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "cached source cancel\n", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    let coordinatorRef!: NativeHarnessDelegationCoordinator;
    let ownerCalls = 0;
    let cancelAt = -1;
    let cancelResult: boolean | null = null;
    let captureCalls = 0;
    const port: NativeHarnessOutputPort = {
      async capture() {
        captureCalls += 1;
        return { ok: true as const, capture };
      },
      matches() {
        return true;
      },
      revalidateOwner() {
        ownerCalls += 1;
        if (cancelAt >= 0 && ownerCalls === cancelAt) {
          cancelResult = coordinatorRef.cancel("source-1");
        }
        return null;
      },
    };
    const h = setup(f, { output: port });
    coordinatorRef = h.coordinator;
    await startWork(f);
    await captureSource(f, h, "source-1");
    const raw = captureActionInput("source-1");
    await preflightCaptureAction(f, "cap-1", raw);
    cancelAt = ownerCalls + 2;
    const outcome = await settle(h.coordinator.captureOutputForCall(
      "cap-1",
      raw,
      new AbortController().signal,
    ));
    expect(cancelResult as boolean | null).toBe(false);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.capture).toBe(capture);
      expect(outcome.observation).toBe("cached-historical");
    }
    expect(h.captureCalls()).toBe(0);
    expect(captureCalls).toBe(1);
    expect(h.coordinator.inspect().output.reservedBytes).toBe(0);
  });

  test("sixteen mixed action slots are shared and cached captures add no I/O", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "shared budget\n", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, PATH_A);
    const capture = syntheticCapture(WORK_TASK, [{ path: PATH_A, snapshot }]);
    const h = setup(f, { capture: () => capture });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    expect(h.captureCalls()).toBe(1);
    const retainedBytes = h.coordinator.inspect().operations[0]!.output.retainedBytes;
    const signal = new AbortController().signal;
    const raw = captureActionInput("source-1");
    for (let index = 0; index < NATIVE_HARNESS_MAX_CHECK_ACTIONS; index++) {
      const id = `cap-${index}`;
      await preflightCaptureAction(f, id, raw);
      const selected = await settle(h.coordinator.captureOutputForCall(id, raw, signal));
      expect(selected.ok).toBe(true);
      if (selected.ok) {
        expect(selected.capture).toBe(source.capture);
        expect(selected.observation).toBe("cached-historical");
      }
    }
    expect(h.captureCalls()).toBe(1);
    expect(h.coordinator.inspect().operations[0]!.output.checks.actions).toBe(16);
    const overflowRaw = captureActionInput("source-1");
    await preflightCaptureAction(f, "cap-overflow", overflowRaw);
    const overflow = await settle(h.coordinator.captureOutputForCall("cap-overflow", overflowRaw, signal));
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.code).toBe("capacity");
    expect(h.captureCalls()).toBe(1);
    expect(h.coordinator.inspect().operations[0]!.output.retainedBytes).toBe(retainedBytes);
  });
});
