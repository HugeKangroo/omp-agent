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
import {
  NATIVE_HARNESS_RESULT_TOOL,
  type NativeHarnessCheckSuccess,
} from "../../src/native-harness-checks.ts";
import type { NativeHarnessOutputCapture } from "../../src/native-harness-output.ts";
import {
  NATIVE_HARNESS_REPORT_MAX_FACTS_BYTES,
  createNativeHarnessReportFacts,
  normalizeNativeHarnessReportRequest,
  type NativeHarnessReportFactsInput,
  type NativeHarnessReportRequest,
} from "../../src/native-harness-report.ts";
import { fingerprintNativeJson } from "../../src/native-instance-result.ts";
import { captureWorkspaceText } from "../../src/native-work.ts";
import type { Runner, WorkerRequest, WorkerResult } from "../../vendor/harness2/index.ts";

const WORK_TASK = "do the bounded delegated task";
const PATH_A = "candidate.txt";
const PATH_B = "second.txt";
const AGENT_WORK = "agent_work";
const REPORT_ID = "report-1";

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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g53b2a2-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const host = new Host();
  const ctx: NativeContext = {
    cwd: workspace,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId() {
        return "session-g53b2a2";
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
  changes: readonly { readonly path: string; readonly snapshot: Awaited<ReturnType<typeof captureWorkspaceText>> }[],
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
    digest: "1".repeat(64),
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
  setContext(context: NativeContext | null): void;
}

function setup(
  f: Fixture,
  hooks: {
    output?: NativeHarnessOutputPort;
    getContext?: () => NativeContext;
    capture?: () => NativeHarnessOutputCapture;
    revalidateOwner?: () => string | null;
    runner?: Runner;
    native?: NativeEntryControls;
  } = {},
): Harness {
  let captureCalls = 0;
  let executeCalls = 0;
  const ownerReason = hooks.revalidateOwner ?? (() => null);
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
      return ownerReason();
    },
  };
  const runner = hooks.runner ?? runnerFor(async () => completedResult());
  let contextOverride: NativeContext | null = null;
  const baseContext = hooks.getContext ?? (() => f.ctx);
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
    getContext: () => contextOverride ?? baseContext(),
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
    enabled: true,
  });
  coordinators.push(coordinator);
  return {
    coordinator,
    captureCalls: () => captureCalls,
    executeCalls: () => executeCalls,
    setContext(context: NativeContext | null) {
      contextOverride = context;
    },
  };
}

interface CapturedSource {
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  readonly result: NativeHarnessDelegationResult;
  readonly capture: NativeHarnessOutputCapture;
}

async function captureSource(f: Fixture, h: Harness, toolCallId: string): Promise<CapturedSource> {
  await callSource(f, toolCallId);
  const controller = new AbortController();
  const signal = controller.signal;
  const result = await settle(h.coordinator.invoke(toolCallId, { task: WORK_TASK }, signal));
  expect(result.outcome, result.reason ?? "").toBe("backend-completed");
  const wire = projectionFor(result);
  const registered = h.coordinator.registerToolResultProjection(toolCallId, result, wire, signal);
  expect(registered.ok).toBe(true);
  await emitSourceResult(f, toolCallId, wire);
  const selection = await settle(h.coordinator.captureOutput(toolCallId, new AbortController().signal));
  expect(selection.ok).toBe(true);
  if (!selection.ok) throw new Error(selection.reason);
  return { signal, controller, result, capture: selection.capture };
}

function checkInput(
  sourceToolCallId: string,
  capture: NativeHarnessOutputCapture,
  filePath: string,
  conditions: readonly unknown[],
): Record<string, unknown> {
  return {
    action: "check",
    sourceToolCallId,
    captureId: capture.captureId,
    captureDigest: capture.digest,
    path: filePath,
    conditions,
  };
}

async function preflightCheck(f: Fixture, toolCallId: string, rawInput: unknown): Promise<void> {
  await f.host.emit("tool_call", {
    toolCallId,
    toolName: NATIVE_HARNESS_RESULT_TOOL,
    input: rawInput,
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

function expectCheckSuccess(value: ReturnType<NativeHarnessDelegationCoordinator["checkOutput"]>): NativeHarnessCheckSuccess {
  if (!value.ok) throw new Error(`check refused: ${value.code}: ${value.reason}`);
  expect(value.ok).toBe(true);
  return value;
}

interface RegisteredCheck {
  readonly raw: Record<string, unknown>;
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  readonly response: NativeHarnessCheckSuccess;
}

async function registerCheck(
  f: Fixture,
  h: Harness,
  sourceId: string,
  capture: NativeHarnessOutputCapture,
  filePath: string,
  checkId: string,
  conditions: readonly unknown[],
): Promise<RegisteredCheck> {
  const raw = checkInput(sourceId, capture, filePath, conditions);
  await preflightCheck(f, checkId, raw);
  const controller = new AbortController();
  const signal = controller.signal;
  const response = expectCheckSuccess(h.coordinator.checkOutput(checkId, raw, signal));
  const projection = h.coordinator.registerOutputCheckProjection(
    sourceId,
    checkId,
    response,
    checkWire(response),
    signal,
  );
  expect(projection.ok).toBe(true);
  await emitCheckResult(f, checkId, checkWire(response), raw);
  return { raw, signal, controller, response };
}

function reportArguments(outcome: string, checkIds: readonly string[]): Record<string, unknown> {
  return {
    action: "report",
    outcome,
    checks: checkIds.map((toolCallId) => ({ toolCallId, purpose: "bounded check" })),
    summary: "bounded report fixture",
    limitations: [],
  };
}

async function reportPreflight(
  f: Fixture,
  reportId: string,
  rawInput: Record<string, unknown>,
): Promise<{ readonly ref: object; readonly inputSha256: string }> {
  await f.host.emit("tool_call", {
    toolCallId: reportId,
    toolName: AGENT_WORK,
    input: rawInput,
  }, f.ctx);
  const captured = f.entry.captureCall({ toolCallId: reportId, toolName: AGENT_WORK }, f.ctx);
  if (!captured.ok) throw new Error(`report ref unavailable: ${captured.inspection.reason}`);
  const fingerprint = fingerprintNativeJson(rawInput);
  if (!fingerprint.ok) throw new Error(fingerprint.reason);
  return { ref: captured.ref, inputSha256: fingerprint.sha256 };
}

function requestFor(
  ref: object,
  inputSha256: string,
  sourceId: string,
  capture: NativeHarnessOutputCapture,
  checkIds: readonly string[],
  outcome: "completed" | "insufficient" | "blocked",
  work: NativeHarnessReportRequest["work"],
): NativeHarnessReportRequest {
  return {
    reportRef: ref as NativeHarnessReportRequest["reportRef"],
    reportInputSha256: inputSha256,
    work,
    selection: {
      sourceToolCallId: sourceId,
      captureId: capture.captureId,
      captureDigest: capture.digest,
      checkToolCallIds: checkIds,
    },
    outcome,
  };
}

function workOf(association: {
  readonly observationId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly workspaceRoot: string;
} | null): NativeHarnessReportRequest["work"] {
  if (association === null) throw new Error("source association unavailable");
  return {
    observationId: association.observationId,
    generation: association.generation,
    sessionId: association.sessionId,
    workspaceRoot: association.workspaceRoot,
  };
}

interface PreparedReportFixture {
  readonly f: Fixture;
  readonly h: Harness;
  readonly source: CapturedSource;
  readonly capture: NativeHarnessOutputCapture;
  readonly checks: readonly RegisteredCheck[];
  readonly reportRef: object;
  readonly reportInputSha256: string;
  readonly work: NativeHarnessReportRequest["work"];
  readonly request: NativeHarnessReportRequest;
  readonly signal: AbortSignal;
}

async function preparedReport(
  outcome: "completed" | "insufficient" | "blocked",
  paths: readonly {
    readonly path: string;
    readonly text: string;
    readonly conditions: readonly unknown[];
  }[],
  selectedIndexes: readonly number[],
  checkIds: string[],
  revalidateOwner: () => string | null = () => null,
): Promise<PreparedReportFixture> {
  const f = await fixture();
  const changes: { path: string; snapshot: Awaited<ReturnType<typeof captureWorkspaceText>> }[] = [];
  for (const entry of paths) {
    await writeFile(path.join(f.workspace, entry.path), entry.text, { mode: 0o600 });
    changes.push({ path: entry.path, snapshot: await captureWorkspaceText(f.workspace, entry.path) });
  }
  const capture = syntheticCapture(WORK_TASK, changes);
  const h = setup(f, { capture: () => capture, revalidateOwner });
  await startWork(f);
  const source = await captureSource(f, h, "source-1");
  const checks: RegisteredCheck[] = [];
  for (let index = 0; index < selectedIndexes.length; index++) {
    const selected = selectedIndexes[index]!;
    const entry = paths[selected]!;
    checks.push(await registerCheck(
      f,
      h,
      "source-1",
      capture,
      entry.path,
      checkIds[index]!,
      entry.conditions,
    ));
  }
  const reportInput = reportArguments(outcome, checkIds.slice(0, selectedIndexes.length));
  const report = await reportPreflight(f, REPORT_ID, reportInput);
  const work = workOf(source.result.association);
  const request = requestFor(
    report.ref,
    report.inputSha256,
    "source-1",
    capture,
    checkIds.slice(0, selectedIndexes.length),
    outcome,
    work,
  );
  return {
    f,
    h,
    source,
    capture,
    checks,
    reportRef: report.ref,
    reportInputSha256: report.inputSha256,
    work,
    request,
    signal: new AbortController().signal,
  };
}

describe("host-only typed report binding", () => {
  test("genuine source, capture and PASS checks bind frozen facts with no host effects", async () => {
    const p = await preparedReport(
      "completed",
      [
        { path: PATH_A, text: "alpha EXACT-MARKER", conditions: [{ id: "a", kind: "text-includes", value: "EXACT-MARKER" }] },
        { path: PATH_B, text: "beta", conditions: [{ id: "b", kind: "text-includes", value: "beta" }] },
      ],
      [0, 1],
      ["check-a", "check-b"],
    );
    const before = p.h.coordinator.inspect();
    const capturesBefore = p.h.captureCalls();
    const executesBefore = p.h.executeCalls();
    const result = p.h.coordinator.prepareReport(p.request, p.signal);
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    const { facts, refresh, revalidate } = result.prepared;
    expect(Object.keys(result.prepared).sort()).toEqual(["facts", "refresh", "reread", "revalidate"]);
    expect(typeof result.prepared.reread).toBe("function");
    expect(Object.isFrozen(result.prepared)).toBe(true);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(facts.schema).toBe("omp-agent.native-harness-report-binding.v1");
    expect(facts.modelDeclaredOutcome).toBe("completed");
    expect(facts.source.toolCallId).toBe("source-1");
    expect(facts.source.observationId).toBe(p.work.observationId);
    expect(facts.capture.captureId).toBe(p.capture.captureId);
    expect(facts.files).toHaveLength(2);
    expect(facts.files.map((file) => file.path).sort()).toEqual([PATH_A, PATH_B]);
    expect(facts.files[0]!.check?.receipt.outcome).toBe("pass");
    expect(facts.files[1]!.check?.receipt.outcome).toBe("pass");
    expect(facts.coverage).toMatchObject({
      capturedPathCount: 2,
      selectedPathCount: 2,
      passPathCount: 2,
      failPathCount: 0,
      missingPathCount: 0,
      completedCoverage: true,
    });
    expect(facts.coverage.missing).toEqual([]);
    expect(facts.coverage.failed).toEqual([]);
    expect(facts.filesystemFreshness).toBe("not-rechecked");
    expect(facts.taskAccepted).toBe(false);
    expect(facts.semanticAcceptance).toBe("not-evaluated");
    const encoded = JSON.stringify(facts);
    expect(encoded).not.toContain("EXACT-MARKER");
    expect(encoded).not.toContain(p.f.workspace);
    expect(encoded).not.toContain("synthetic-source");
    expect(refresh()).toBeNull();
    expect(revalidate()).toBeNull();
    const after = p.h.coordinator.inspect();
    expect(after.output.retainedCaptures).toBe(before.output.retainedCaptures);
    expect(after.output.retainedBytes).toBe(before.output.retainedBytes);
    expect(after.output.reservedBytes).toBe(before.output.reservedBytes);
    expect(after.operations[0]!.output.checks).toEqual(before.operations[0]!.output.checks);
    expect(p.h.captureCalls()).toBe(capturesBefore);
    expect(p.h.executeCalls()).toBe(executesBefore);
  });

  test("completed refuses FAIL or missing path coverage; insufficient represents them honestly", async () => {
    const fail = await preparedReport(
      "insufficient",
      [
        { path: PATH_A, text: "alpha", conditions: [{ id: "a", kind: "text-includes", value: "alpha" }] },
        { path: PATH_B, text: "beta", conditions: [{ id: "b", kind: "text-includes", value: "MISSING" }] },
      ],
      [0, 1],
      ["check-a", "check-b"],
    );
    const completedFail = fail.h.coordinator.prepareReport(
      { ...fail.request, outcome: "completed" },
      new AbortController().signal,
    );
    expect(completedFail.ok).toBe(false);
    if (!completedFail.ok) expect(completedFail.code).toBe("coverage");
    const insufficient = fail.h.coordinator.prepareReport(fail.request, fail.signal);
    if (!insufficient.ok) throw new Error(`${insufficient.code}: ${insufficient.reason}`);
    expect(insufficient.prepared.facts.modelDeclaredOutcome).toBe("insufficient");
    expect(insufficient.prepared.facts.coverage).toMatchObject({
      capturedPathCount: 2,
      selectedPathCount: 2,
      passPathCount: 1,
      failPathCount: 1,
      missingPathCount: 0,
      completedCoverage: false,
    });
    expect(insufficient.prepared.facts.coverage.failed).toHaveLength(1);

    const missing = await preparedReport(
      "insufficient",
      [
        { path: PATH_A, text: "alpha", conditions: [{ id: "a", kind: "text-includes", value: "alpha" }] },
        { path: PATH_B, text: "beta", conditions: [{ id: "b", kind: "text-includes", value: "beta" }] },
      ],
      [0],
      ["check-a"],
    );
    const completedMissing = missing.h.coordinator.prepareReport(
      { ...missing.request, outcome: "completed" },
      new AbortController().signal,
    );
    expect(completedMissing.ok).toBe(false);
    if (!completedMissing.ok) expect(completedMissing.code).toBe("coverage");
    const partial = missing.h.coordinator.prepareReport(missing.request, missing.signal);
    if (!partial.ok) throw new Error(`${partial.code}: ${partial.reason}`);
    expect(partial.prepared.facts.coverage).toMatchObject({
      capturedPathCount: 2,
      selectedPathCount: 1,
      missingPathCount: 1,
      completedCoverage: false,
    });
    expect(partial.prepared.facts.coverage.missing).toEqual([{ path: PATH_B }]);
  });

  test("pending and unregistered selected checks refuse without action or worker effects", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "alpha", { mode: 0o600 });
    const capture = syntheticCapture(WORK_TASK, [
      { path: PATH_A, snapshot: await captureWorkspaceText(f.workspace, PATH_A) },
    ]);
    const h = setup(f, { capture: () => capture });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    const raw = checkInput("source-1", capture, PATH_A, [
      { id: "a", kind: "text-includes", value: "alpha" },
    ]);
    await preflightCheck(f, "check-pending", raw);
    const checkSignal = new AbortController().signal;
    const response = expectCheckSuccess(h.coordinator.checkOutput("check-pending", raw, checkSignal));
    const report = await reportPreflight(f, REPORT_ID, reportArguments("insufficient", ["check-pending"]));
    const request = requestFor(
      report.ref,
      report.inputSha256,
      "source-1",
      capture,
      ["check-pending"],
      "insufficient",
      workOf(source.result.association),
    );
    const unregistered = h.coordinator.prepareReport(request, new AbortController().signal);
    expect(unregistered.ok).toBe(false);
    if (!unregistered.ok) expect(["not-ready", "source-conflict"]).toContain(unregistered.code);

    expect(h.coordinator.registerOutputCheckProjection(
      "source-1",
      "check-pending",
      response,
      checkWire(response),
      checkSignal,
    ).ok).toBe(true);
    const pending = h.coordinator.prepareReport(request, new AbortController().signal);
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.code).toBe("not-ready");
    expect(h.coordinator.inspect().operations[0]!.output.checks.actions).toBe(1);
    expect(h.executeCalls()).toBe(1);
  });

  test("normalization freezes copies and refuses accessors, revoked reflection and opaque refs", () => {
    const reportInput = reportArguments("insufficient", ["check-a"]);
    const fingerprint = fingerprintNativeJson(reportInput);
    if (!fingerprint.ok) throw new Error(fingerprint.reason);
    const request = requestFor(
      { observationId: "obs", generation: 1, sessionId: "s", workspaceRoot: "/w", toolCallId: "r", toolName: AGENT_WORK },
      fingerprint.sha256,
      "source-1",
      { captureId: "cap", digest: "a".repeat(64) } as unknown as NativeHarnessOutputCapture,
      ["check-a"],
      "insufficient",
      { observationId: "obs", generation: 1, sessionId: "s", workspaceRoot: "/w" },
    );
    const normalized = normalizeNativeHarnessReportRequest(request);
    if (!normalized.ok) throw new Error(`${normalized.code}: ${normalized.reason}`);
    expect(Object.isFrozen(normalized.request)).toBe(true);
    expect(Object.isFrozen(normalized.request.selection)).toBe(true);
    expect(Object.isFrozen(normalized.request.selection.checkToolCallIds)).toBe(true);
    expect(Object.isFrozen(normalized.request.work)).toBe(true);
    expect(normalized.request.reportRef).toBe(request.reportRef);

    const accessor = Object.defineProperty({ ...request }, "outcome", {
      enumerable: true,
      get: () => "insufficient",
    });
    const accessorResult = normalizeNativeHarnessReportRequest(accessor);
    expect(accessorResult.ok).toBe(false);
    if (!accessorResult.ok) expect(accessorResult.code).toBe("invalid-caller");

    const revoked = Proxy.revocable({ ...request }, {});
    revoked.revoke();
    const revokedResult = normalizeNativeHarnessReportRequest(revoked.proxy);
    expect(revokedResult.ok).toBe(false);
    if (!revokedResult.ok) expect(revokedResult.code).toBe("invalid-caller");

    // The normalizer must not inspect an opaque ref. Arrays and unrevoked
    // proxies pass through by identity; only the native issuer gate refuses.
    const arrayRef: object = [] as unknown as object;
    const arrayResult = normalizeNativeHarnessReportRequest({ ...request, reportRef: arrayRef });
    expect(arrayResult.ok).toBe(true);
    if (arrayResult.ok) expect(arrayResult.request.reportRef).toBe(arrayRef);
    const revokedRef = Proxy.revocable({}, {});
    const revokedProxy = revokedRef.proxy;
    revokedRef.revoke();
    const revokedRefResult = normalizeNativeHarnessReportRequest({ ...request, reportRef: revokedProxy });
    expect(revokedRefResult.ok).toBe(true);
    if (revokedRefResult.ok) expect(revokedRefResult.request.reportRef).toBe(revokedProxy);
  });

  test("exact facts byte bound is enforced without truncated success (data-only synthetic receipt)", () => {
    const makeInput = (detailLength: number): NativeHarnessReportFactsInput => ({
      modelDeclaredOutcome: "completed",
      source: {
        toolCallId: "source-1",
        observationId: "obs",
        generation: 1,
        taskSha256: "1".repeat(64),
        promptSha256: "2".repeat(64),
        inputSha256: "3".repeat(64),
        observedEnvelopeSha256: "4".repeat(64),
        observedEnvelopeBytes: 4,
      },
      capture: {
        captureId: "capture-1",
        captureDigest: "5".repeat(64),
        originKind: "harness2-native",
        completionId: "completion-1",
        runId: "run-1",
        baseSnapshotId: "base-1",
        manifestSha256: "6".repeat(64),
        winner: {
          candidate: "baseline",
          attempt: 1,
          artifactHash: "7".repeat(64),
          traceHash: "8".repeat(64),
        },
        observedAt: 1,
      },
      files: [{
        path: PATH_A,
        kind: "add",
        mode: 0o600,
        controllerHash: "9".repeat(64),
        fileSnapshotId: "snapshot-1",
        bytes: 1,
        sha256: "a".repeat(64),
        observedAt: 1,
        check: {
          checkToolCallId: "check-1",
          computedByToolCallId: "check-1",
          checkerId: "omp-agent.native-text-checks",
          checkerVersion: "1",
          planSource: "model-proposed-after-capture",
          planDigest: "b".repeat(64),
          receipt: {
            schemaVersion: 1,
            checkerId: "omp-agent.native-text-checks",
            checkerVersion: "1",
            planDigest: "b".repeat(64),
            snapshot: {
              captureId: "snapshot-1",
              file: { relativePath: PATH_A, bytes: 1, sha256: "a".repeat(64), observedAt: 1 },
            },
            conditions: [{ id: "only", result: "pass", detail: "x".repeat(detailLength) }],
            outcome: "pass",
            taskAccepted: false,
            semanticAcceptance: "not-evaluated",
          },
        },
      }],
    });
    const base = createNativeHarnessReportFacts(makeInput(0));
    if (!base.ok) throw new Error(`${base.code}: ${base.reason}`);
    const baseBytes = new TextEncoder().encode(JSON.stringify(base.facts)).byteLength;
    const exact = createNativeHarnessReportFacts(makeInput(NATIVE_HARNESS_REPORT_MAX_FACTS_BYTES - baseBytes));
    if (!exact.ok) throw new Error(`${exact.code}: ${exact.reason}`);
    expect(new TextEncoder().encode(JSON.stringify(exact.facts)).byteLength).toBe(NATIVE_HARNESS_REPORT_MAX_FACTS_BYTES);
    const over = createNativeHarnessReportFacts(
      makeInput(NATIVE_HARNESS_REPORT_MAX_FACTS_BYTES - baseBytes + 1),
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("too-large");
  });

  test("foreign, cloned, wrong-tool, wrong-input and wrong-signal refs refuse without effects", async () => {
    const p = await preparedReport(
      "insufficient",
      [{ path: PATH_A, text: "alpha", conditions: [{ id: "a", kind: "text-includes", value: "alpha" }] }],
      [0],
      ["check-a"],
    );
    const before = p.h.coordinator.inspect();
    const capturesBefore = p.h.captureCalls();
    const executesBefore = p.h.executeCalls();
    const prior = p.h.coordinator.prepareReport(p.request, new AbortController().signal);
    if (!prior.ok) throw new Error(`${prior.code}: ${prior.reason}`);
    const expectRefusal = (
      request: unknown,
      signal: unknown,
      codes: readonly string[],
    ): void => {
      const result = p.h.coordinator.prepareReport(request, signal);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(codes).toContain(result.code);
    };

    const clone = { ...p.reportRef } as object;
    expectRefusal({ ...p.request, reportRef: clone }, new AbortController().signal, ["authority-lost"]);
    const arrayRef: object = [] as unknown as object;
    expectRefusal({ ...p.request, reportRef: arrayRef }, new AbortController().signal, ["authority-lost"]);
    const revokedRef = Proxy.revocable({}, {});
    const revokedProxy = revokedRef.proxy;
    revokedRef.revoke();
    expectRefusal({ ...p.request, reportRef: revokedProxy }, new AbortController().signal, ["authority-lost"]);

    const sourceRef = p.f.entry.captureCall({ toolCallId: "source-1", toolName: "agent_harness" }, p.f.ctx);
    if (!sourceRef.ok) throw new Error(sourceRef.inspection.reason);
    expectRefusal(
      { ...p.request, reportRef: sourceRef.ref },
      new AbortController().signal,
      ["invalid-caller"],
    );

    expectRefusal(
      { ...p.request, reportInputSha256: "f".repeat(64) },
      new AbortController().signal,
      ["source-conflict"],
    );
    expectRefusal(
      { ...p.request, work: { ...p.work, generation: p.work.generation + 1 } },
      new AbortController().signal,
      ["source-conflict"],
    );
    expectRefusal(
      {
        ...p.request,
        selection: { ...p.request.selection, captureId: "other-capture" },
      },
      new AbortController().signal,
      ["source-conflict"],
    );
    expectRefusal(
      {
        ...p.request,
        selection: { ...p.request.selection, sourceToolCallId: "missing-source" },
      },
      new AbortController().signal,
      ["not-ready"],
    );
    expectRefusal(
      {
        ...p.request,
        selection: { ...p.request.selection, checkToolCallIds: ["check-a", "check-a"] },
      },
      new AbortController().signal,
      ["invalid-caller"],
    );
    expectRefusal(p.request, undefined, ["invalid-caller"]);
    expectRefusal(p.request, {}, ["invalid-caller"]);
    const preAborted = new AbortController();
    preAborted.abort();
    expectRefusal(p.request, preAborted.signal, ["authority-lost"]);

    expect(prior.prepared.revalidate()).toBeNull();
    expect(prior.prepared.refresh()).toBeNull();
    expect(p.h.coordinator.inspect().operations[0]!.output.checks).toEqual(
      before.operations[0]!.output.checks,
    );
    expect(p.h.captureCalls()).toBe(capturesBefore);
    expect(p.h.executeCalls()).toBe(executesBefore);
  });

  test("old source/check signal aborts do not substitute for the report signal", async () => {
    const p = await preparedReport(
      "insufficient",
      [{ path: PATH_A, text: "alpha", conditions: [{ id: "a", kind: "text-includes", value: "alpha" }] }],
      [0],
      ["check-a"],
    );
    p.checks[0]!.controller.abort();
    p.source.controller.abort();
    const result = p.h.coordinator.prepareReport(p.request, new AbortController().signal);
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    expect(result.prepared.revalidate()).toBeNull();
  });

  test("post-prepare report abort makes refresh and pure revalidate refuse", async () => {
    const p = await preparedReport(
      "insufficient",
      [{ path: PATH_A, text: "alpha", conditions: [{ id: "a", kind: "text-includes", value: "alpha" }] }],
      [0],
      ["check-a"],
    );
    const reportSignal = new AbortController();
    const result = p.h.coordinator.prepareReport(p.request, reportSignal.signal);
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    expect(result.prepared.refresh()).toBeNull();
    expect(result.prepared.revalidate()).toBeNull();
    reportSignal.abort();
    const refreshReason = result.prepared.refresh();
    expect(typeof refreshReason).toBe("string");
    expect(refreshReason).toContain("aborted");
    const revalidateReason = result.prepared.revalidate();
    expect(typeof revalidateReason).toBe("string");
    expect(revalidateReason).toContain("aborted");
  });

  test("reentrant descriptor prepare/refresh and unscoped context are bounded; later requests work", async () => {
    const p = await preparedReport(
      "insufficient",
      [{ path: PATH_A, text: "alpha", conditions: [{ id: "a", kind: "text-includes", value: "alpha" }] }],
      [0],
      ["check-a"],
    );
    const observedPrepare: { value: unknown } = { value: null };
    const probe = new Proxy(p.request, {
      ownKeys(target) {
        observedPrepare.value = p.h.coordinator.prepareReport(p.request, new AbortController().signal);
        return Reflect.ownKeys(target);
      },
    });
    const outer = p.h.coordinator.prepareReport(probe, new AbortController().signal);
    if (!outer.ok) throw new Error(`${outer.code}: ${outer.reason}`);
    const innerPrepare = observedPrepare.value as { ok: boolean; code?: string } | null;
    expect(innerPrepare).not.toBeNull();
    expect(innerPrepare?.ok).toBe(false);
    expect(innerPrepare?.code).toBe("not-ready");

    const observedRefresh: { value: unknown } = { value: null };
    const refreshProbe = new Proxy(p.request, {
      ownKeys(target) {
        observedRefresh.value = outer.prepared.refresh();
        return Reflect.ownKeys(target);
      },
    });
    const second = p.h.coordinator.prepareReport(refreshProbe, new AbortController().signal);
    if (!second.ok) throw new Error(`${second.code}: ${second.reason}`);
    expect(typeof observedRefresh.value).toBe("string");
    expect(String(observedRefresh.value)).toContain("reentrant");
    expect(outer.prepared.refresh()).toBeNull();

    p.h.setContext({ cwd: p.f.workspace, agent: { kind: "sub" } });
    const unscoped = p.h.coordinator.prepareReport(p.request, new AbortController().signal);
    expect(unscoped.ok).toBe(false);
    if (!unscoped.ok) expect(unscoped.code).toBe("authority-lost");
    p.h.setContext(null);
    const later = p.h.coordinator.prepareReport(p.request, new AbortController().signal);
    if (!later.ok) throw new Error(`${later.code}: ${later.reason}`);
  });

  test("last selected-check callback changing report preflight input refuses the final report refresh", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, PATH_A), "alpha", { mode: 0o600 });
    const capture = syntheticCapture(WORK_TASK, [
      { path: PATH_A, snapshot: await captureWorkspaceText(f.workspace, PATH_A) },
    ]);
    let getContextCalls = 0;
    let mutateLate = false;
    const h = setup(f, {
      capture: () => capture,
      getContext: () => {
        getContextCalls += 1;
        if (mutateLate && getContextCalls === 3) {
          void f.host.emit("tool_call", {
            toolCallId: REPORT_ID,
            toolName: AGENT_WORK,
            input: { ...reportArguments("insufficient", ["check-a"]), summary: "changed late" },
          }, f.ctx);
        }
        return f.ctx;
      },
    });
    await startWork(f);
    const source = await captureSource(f, h, "source-1");
    const check = await registerCheck(
      f,
      h,
      "source-1",
      capture,
      PATH_A,
      "check-a",
      [{ id: "a", kind: "text-includes", value: "alpha" }],
    );
    const report = await reportPreflight(f, REPORT_ID, reportArguments("insufficient", ["check-a"]));
    getContextCalls = 0;
    mutateLate = true;
    const request = requestFor(
      report.ref,
      report.inputSha256,
      "source-1",
      capture,
      ["check-a"],
      "insufficient",
      workOf(source.result.association),
    );
    const result = h.coordinator.prepareReport(request, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["authority-lost", "source-conflict", "not-ready"]).toContain(result.code);
    mutateLate = false;
    expect(check.response.ok).toBe(true);
  });

  test("duplicate selected paths and capture-action records refuse without changing retained counts", async () => {
    const p = await preparedReport(
      "insufficient",
      [{ path: PATH_A, text: "alpha", conditions: [{ id: "a", kind: "text-includes", value: "alpha" }] }],
      [0],
      ["check-a"],
    );
    await registerCheck(
      p.f,
      p.h,
      "source-1",
      p.capture,
      PATH_A,
      "check-b",
      [{ id: "a", kind: "text-includes", value: "alpha" }],
    );
    const before = p.h.coordinator.inspect();
    const duplicatePath = p.h.coordinator.prepareReport(
      {
        ...p.request,
        selection: { ...p.request.selection, checkToolCallIds: ["check-a", "check-b"] },
      },
      new AbortController().signal,
    );
    expect(duplicatePath.ok).toBe(false);
    if (!duplicatePath.ok) expect(duplicatePath.code).toBe("source-conflict");

    const captureRaw = { action: "capture", sourceToolCallId: "source-1" };
    await p.f.host.emit("tool_call", {
      toolCallId: "cap-action",
      toolName: NATIVE_HARNESS_RESULT_TOOL,
      input: captureRaw,
    }, p.f.ctx);
    const capSignal = new AbortController().signal;
    const captureAction = await settle(p.h.coordinator.captureOutputForCall(
      "cap-action",
      captureRaw,
      capSignal,
    ));
    expect(captureAction.ok, captureAction.ok ? "" : captureAction.reason).toBe(true);
    const afterCapture = p.h.coordinator.inspect();
    const captureRecord = p.h.coordinator.prepareReport(
      {
        ...p.request,
        selection: { ...p.request.selection, checkToolCallIds: ["cap-action"] },
      },
      new AbortController().signal,
    );
    expect(captureRecord.ok).toBe(false);
    if (!captureRecord.ok) expect(captureRecord.code).toBe("source-conflict");
    const after = p.h.coordinator.inspect();
    expect(after.operations[0]!.output.checks).toEqual(afterCapture.operations[0]!.output.checks);
    expect(after.output.retainedCaptures).toBe(before.output.retainedCaptures);
    expect(after.output.retainedBytes).toBe(before.output.retainedBytes);
  });

  test("later selected-check result changes are detected by refresh and pure revalidate", async () => {
    const p = await preparedReport(
      "insufficient",
      [{ path: PATH_A, text: "alpha", conditions: [{ id: "a", kind: "text-includes", value: "alpha" }] }],
      [0],
      ["check-a"],
    );
    const result = p.h.coordinator.prepareReport(p.request, new AbortController().signal);
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    expect(result.prepared.refresh()).toBeNull();
    expect(result.prepared.revalidate()).toBeNull();
    const check = p.checks[0]!;
    await emitCheckResult(
      p.f,
      "check-a",
      {
        content: [{ type: "text", text: "changed observed check result" }],
        details: { changed: true },
        isError: false,
      },
      check.raw,
    );
    const refreshReason = result.prepared.refresh();
    expect(typeof refreshReason).toBe("string");
    const revalidateReason = result.prepared.revalidate();
    expect(typeof revalidateReason).toBe("string");
  });

  test("pure revalidate and refresh refuse after the original output owner is lost", async () => {
    let ownerReason: string | null = null;
    const p = await preparedReport(
      "insufficient",
      [{ path: PATH_A, text: "alpha", conditions: [{ id: "a", kind: "text-includes", value: "alpha" }] }],
      [0],
      ["check-a"],
      () => ownerReason,
    );
    const result = p.h.coordinator.prepareReport(p.request, new AbortController().signal);
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    const before = p.h.coordinator.inspect();
    const capturesBefore = p.h.captureCalls();
    const executesBefore = p.h.executeCalls();
    expect(result.prepared.revalidate()).toBeNull();
    expect(result.prepared.refresh()).toBeNull();

    ownerReason = "the original output owner was revoked by the host";
    const revalidateReason = result.prepared.revalidate();
    expect(typeof revalidateReason).toBe("string");
    expect(revalidateReason).toContain("original output owner was revoked");
    const refreshReason = result.prepared.refresh();
    expect(typeof refreshReason).toBe("string");
    expect(refreshReason).toContain("original output owner was revoked");

    const after = p.h.coordinator.inspect();
    expect(after.output.retainedCaptures).toBe(before.output.retainedCaptures);
    expect(after.output.retainedBytes).toBe(before.output.retainedBytes);
    expect(after.output.reservedBytes).toBe(before.output.reservedBytes);
    expect(after.operations[0]!.output.checks).toEqual(before.operations[0]!.output.checks);
    expect(p.h.captureCalls()).toBe(capturesBefore);
    expect(p.h.executeCalls()).toBe(executesBefore);

    ownerReason = null;
    expect(result.prepared.refresh()).toBeNull();
  });
});
