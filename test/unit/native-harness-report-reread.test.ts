import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  type NativeHarnessDelegationResult,
  type NativeHarnessOutputPort,
  type NativeHarnessPrepareResult,
} from "../../src/native-harness-delegation.ts";
import {
  createNativeHarnessBackend,
  readNativeHarnessBackendCompletion,
} from "../../src/native-harness-backend.ts";
import type { NativeHarnessBackendCompletion } from "../../src/native-harness-completion.ts";
import {
  captureNativeHarnessOutput,
  matchesNativeHarnessOutputCapture,
  type NativeHarnessOutputCapture,
  type NativeHarnessOutputCaptureResult,
} from "../../src/native-harness-output.ts";
import {
  NATIVE_HARNESS_RESULT_TOOL,
  type NativeHarnessCheckSuccess,
} from "../../src/native-harness-checks.ts";
import {
  NATIVE_HARNESS_REPORT_REREAD_SCHEMA,
  type NativeHarnessReportRequest,
  type NativeHarnessReportRereadResult,
} from "../../src/native-harness-report.ts";
import { fingerprintNativeJson } from "../../src/native-instance-result.ts";
import type { Runner, WorkerRequest, WorkerResult } from "../../vendor/harness2/index.ts";

const WORK_TASK = "do the bounded delegated task";
const FILE_PATH = "candidate.txt";
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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g53b2a3-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(path.join(workspace, "a.txt"), "alpha\n", { mode: 0o600 });
  const host = new Host();
  const ctx: NativeContext = {
    cwd: workspace,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId() {
        return "session-g53b2a3";
      },
      getCwd() {
        return workspace;
      },
    },
  };
  const entry = createNativeEntry(host.pi);
  entries.push(entry);
  const f: Fixture = { root, workspace, host, entry, ctx };
  await startWork(f);
  return f;
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

function directPlan(): string {
  return JSON.stringify({
    decision: "direct",
    reason: "Bounded output reread fixture.",
    criteria: [{ id: "task", description: "Fulfill the requested bounded task.", kind: "requirement" }],
    routes: [],
  });
}

interface RunnerState {
  readonly runner: Runner;
  readonly requests: WorkerRequest[];
}

function candidateRunner(bytes = 0, extraFile = false, bulkFiles = 0): RunnerState {
  const requests: WorkerRequest[] = [];
  let index = 0;
  const runner: Runner = {
    async run(request: WorkerRequest): Promise<WorkerResult> {
      requests.push(request);
      await mkdir(request.artifactDir, { recursive: true, mode: 0o700 });
      const eventsPath = path.join(request.artifactDir, "worker-events.jsonl");
      await writeFile(eventsPath, `${JSON.stringify({ type: "fixture", stage: request.stage })}\n`, { mode: 0o600 });
      let text = "stage completed";
      if (request.stage === "plan") {
        text = directPlan();
      } else if (request.stage === "baseline") {
        const content = bytes > 0
          ? `${"x".repeat(bytes)}${index}`
          : `candidate ${index}\n`;
        await writeFile(path.join(request.cwd, FILE_PATH), content, { mode: 0o600 });
        if (extraFile) {
          await writeFile(path.join(request.cwd, "second.txt"), "second candidate\n", { mode: 0o600 });
        }
        for (let bulk = 0; bulk < bulkFiles; bulk += 1) {
          await writeFile(
            path.join(request.cwd, `bulk-${bulk}.txt`),
            `${"y".repeat(bytes)}${bulk}`,
            { mode: 0o600 },
          );
        }
        index += 1;
        text = "baseline completed";
      }
      return {
        text,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        eventsPath,
        status: "completed",
      };
    },
  };
  return { runner, requests };
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

async function settle<T>(promise: Promise<T>, ms = 4000): Promise<T> {
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

interface PortControl {
  calls: number;
  hook: ((
    call: number,
    backend: unknown,
    guard: () => void,
    signal: AbortSignal,
  ) => NativeHarnessOutputCaptureResult | Promise<NativeHarnessOutputCaptureResult> | undefined) | null;
}

interface GenuinePort {
  readonly port: NativeHarnessOutputPort;
  readonly control: PortControl;
}

function genuinePort(): GenuinePort {
  const control: PortControl = { calls: 0, hook: null };
  const port: NativeHarnessOutputPort = {
    capture(backend: unknown, guard: () => void, signal: AbortSignal) {
      control.calls += 1;
      const injected = control.hook?.(control.calls, backend, guard, signal);
      if (injected !== undefined) return injected as Promise<NativeHarnessOutputCaptureResult>;
      return captureNativeHarnessOutput(backend, guard, signal);
    },
    matches(backend: unknown, capture: unknown) {
      return matchesNativeHarnessOutputCapture(backend, capture);
    },
    revalidateOwner() {
      return null;
    },
  };
  return { port, control };
}

interface Calls {
  capture: number;
  clock: number;
  prepare: number;
  getContext: number;
}

interface Harness {
  coordinator: NativeHarnessDelegationCoordinator;
  control: PortControl;
  calls: Calls;
  runnerState: RunnerState;
  backend: () => NativeHarnessBackend | null;
  completion: () => NativeHarnessBackendCompletion | null;
  setContext(context: NativeContext | null): void;
  setClock(now: () => number): void;
  onContext(callback: (() => void) | null): void;
}

function setup(
  f: Fixture,
  options: {
    readonly runnerState?: RunnerState;
    readonly now?: () => number;
    readonly genuine?: GenuinePort;
  } = {},
): Harness {
  const runnerState = options.runnerState ?? candidateRunner();
  const storageRoot = path.join(f.root, "private");
  void mkdir(storageRoot, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const factory = createNativeHarnessBackend({
    model: "deepseek/deepseek-chat",
    ompCommand: "/usr/bin/fake-omp",
    storageRoot,
    inputFiles: ["a.txt"],
  }, { deterministicRunner: runnerState.runner });
  const genuine = options.genuine ?? genuinePort();
  const calls: Calls = { capture: 0, clock: 0, prepare: 0, getContext: 0 };
  let contextOverride: NativeContext | null = null;
  let clockNow = options.now ?? Date.now;
  let contextCallback: (() => void) | null = null;
  let backend: NativeHarnessBackend | null = null;
  const coordinator = createNativeHarnessDelegation({
    native: f.entry,
    policy: {
      maxRetainedOperations: 16,
      maxConcurrent: 1,
      perRunUsd: 1,
      lifetimeUsd: 5,
      maxDurationMs: 5000,
      cleanupGraceMs: 20,
    },
    getContext: () => {
      calls.getContext += 1;
      contextCallback?.();
      return contextOverride ?? f.ctx;
    },
    prepare: (request, context): NativeHarnessPrepareResult | Promise<NativeHarnessPrepareResult> => {
      calls.prepare += 1;
      request.guard();
      return factory.prepare(request, context).then((prepared) => {
        if (prepared.ok) backend = prepared.backend;
        return prepared;
      });
    },
    runner: runnerState.runner,
    output: genuine.port,
    now: () => {
      calls.clock += 1;
      return clockNow();
    },
    enabled: true,
  });
  coordinators.push(coordinator);
  return {
    coordinator,
    control: genuine.control,
    calls,
    runnerState,
    backend: () => backend,
    completion: () => {
      if (backend === null) return null;
      const observed = readNativeHarnessBackendCompletion(backend);
      return observed.ok ? observed.completion : null;
    },
    setContext(context) {
      contextOverride = context;
    },
    setClock(now) {
      clockNow = now;
    },
    onContext(callback) {
      contextCallback = callback;
    },
  };
}

interface CapturedSource {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly result: NativeHarnessDelegationResult;
  readonly capture: NativeHarnessOutputCapture;
}

async function captureSource(f: Fixture, h: Harness, toolCallId: string): Promise<CapturedSource> {
  await callSource(f, toolCallId);
  const controller = new AbortController();
  const result = await settle(h.coordinator.invoke(toolCallId, { task: WORK_TASK }, controller.signal));
  expect(result.outcome, result.reason ?? "").toBe("backend-completed");
  const wire = projectionFor(result);
  expect(h.coordinator.registerToolResultProjection(toolCallId, result, wire, controller.signal).ok).toBe(true);
  await emitSourceResult(f, toolCallId, wire);
  const captureController = new AbortController();
  const selection = await settle(h.coordinator.captureOutput(toolCallId, captureController.signal));
  expect(selection.ok, selection.ok ? "" : selection.reason).toBe(true);
  if (!selection.ok) throw new Error(selection.reason);
  return { controller, signal: controller.signal, result, capture: selection.capture };
}

function checkInput(
  sourceToolCallId: string,
  capture: NativeHarnessOutputCapture,
  conditions: readonly unknown[],
  filePath = FILE_PATH,
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

function checkWire(response: NativeHarnessCheckSuccess): NativeToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    details: response,
    isError: false,
  };
}

interface RegisteredCheck {
  readonly controller: AbortController;
  readonly raw: Record<string, unknown>;
  readonly response: NativeHarnessCheckSuccess;
}

async function registerCheck(
  f: Fixture,
  h: Harness,
  sourceId: string,
  capture: NativeHarnessOutputCapture,
  checkId: string,
  conditions: readonly unknown[],
  filePath = FILE_PATH,
): Promise<RegisteredCheck> {
  const raw = checkInput(sourceId, capture, conditions, filePath);
  await f.host.emit("tool_call", {
    toolCallId: checkId,
    toolName: NATIVE_HARNESS_RESULT_TOOL,
    input: raw,
  }, f.ctx);
  const controller = new AbortController();
  const response = h.coordinator.checkOutput(checkId, raw, controller.signal);
  if (!response.ok) throw new Error(`${response.code}: ${response.reason}`);
  const wire = checkWire(response);
  expect(h.coordinator.registerOutputCheckProjection(sourceId, checkId, response, wire, controller.signal).ok).toBe(true);
  await f.host.emit("tool_result", {
    toolCallId: checkId,
    toolName: NATIVE_HARNESS_RESULT_TOOL,
    input: raw,
    content: wire.content,
    details: wire.details,
    isError: false,
  }, f.ctx);
  return { controller, raw, response };
}

function reportArguments(outcome: string, checkIds: readonly string[]): Record<string, unknown> {
  return {
    action: "report",
    outcome,
    checks: checkIds.map((toolCallId) => ({ toolCallId, purpose: "bounded check" })),
    summary: "bounded report reread fixture",
    limitations: [],
  };
}

function workOf(association: NativeHarnessDelegationResult["association"]): NativeHarnessReportRequest["work"] {
  if (association === null) throw new Error("source association unavailable");
  return {
    observationId: association.observationId,
    generation: association.generation,
    sessionId: association.sessionId,
    workspaceRoot: association.workspaceRoot,
  };
}

interface PreparedReport {
  readonly prepared: {
    readonly facts: unknown;
    readonly refresh: () => string | null;
    readonly revalidate: () => string | null;
    readonly reread: () => Promise<NativeHarnessReportRereadResult>;
  };
  readonly request: NativeHarnessReportRequest;
  readonly signal: AbortController;
  readonly rawInput: Record<string, unknown>;
}

interface ReportPreflight {
  readonly request: NativeHarnessReportRequest;
  readonly rawInput: Record<string, unknown>;
}

async function reportPreflight(
  f: Fixture,
  source: CapturedSource,
  checkIds: readonly string[],
  outcome: "completed" | "insufficient" | "blocked",
  reportId: string,
): Promise<ReportPreflight> {
  const rawInput = reportArguments(outcome, checkIds);
  await f.host.emit("tool_call", {
    toolCallId: reportId,
    toolName: AGENT_WORK,
    input: rawInput,
  }, f.ctx);
  const captured = f.entry.captureCall({ toolCallId: reportId, toolName: AGENT_WORK }, f.ctx);
  if (!captured.ok) throw new Error(`report ref unavailable: ${captured.inspection.reason}`);
  const fingerprint = fingerprintNativeJson(rawInput);
  if (!fingerprint.ok) throw new Error(fingerprint.reason);
  const association = source.result.association;
  if (association === null) throw new Error("source association unavailable");
  return {
    rawInput,
    request: {
      reportRef: captured.ref as NativeHarnessReportRequest["reportRef"],
      reportInputSha256: fingerprint.sha256,
      work: workOf(association),
      selection: {
        sourceToolCallId: association.toolCallId,
        captureId: source.capture.captureId,
        captureDigest: source.capture.digest,
        checkToolCallIds: [...checkIds],
      },
      outcome,
    },
  };
}

async function preparedReport(
  f: Fixture,
  h: Harness,
  source: CapturedSource,
  checkIds: readonly string[],
  outcome: "completed" | "insufficient" | "blocked" = "insufficient",
  reportId = REPORT_ID,
): Promise<PreparedReport> {
  const preflight = await reportPreflight(f, source, checkIds, outcome, reportId);
  const signal = new AbortController();
  const result = h.coordinator.prepareReport(preflight.request, signal.signal);
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  return {
    prepared: result.prepared,
    request: preflight.request,
    signal,
    rawInput: preflight.rawInput,
  };
}

function inspectHistory(h: Harness) {
  return h.coordinator.inspect();
}

describe("bounded native Harness report reread", () => {
  test("authentic matched reread is one interval and preserves every original identity", async () => {
    const f = await fixture();
    const h = setup(f);
    const source = await captureSource(f, h, "source-1");
    const check = await registerCheck(
      f,
      h,
      "source-1",
      source.capture,
      "check-a",
      [{ id: "a", kind: "text-includes", value: "candidate" }],
    );
    const before = inspectHistory(h);
    const clockBefore = h.calls.clock;
    const captureBefore = h.control.calls;
    const workerBefore = h.runnerState.requests.length;
    const report = await preparedReport(f, h, source, ["check-a"]);
    expect(h.calls.clock).toBe(clockBefore);
    expect(h.control.calls).toBe(captureBefore);
    expect(h.runnerState.requests.length).toBe(workerBefore);
    expect(before.output.reservedBytes).toBe(0);
    expect(report.prepared.revalidate()).toBeNull();

    const first = report.prepared.reread();
    const duplicate = report.prepared.reread();
    expect(duplicate).toBe(first);
    const result = await settle(first);
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.schema).toBe(NATIVE_HARNESS_REPORT_REREAD_SCHEMA);
    expect(result.sourceToolCallId).toBe("source-1");
    expect(result.reportToolCallId).toBe(REPORT_ID);
    expect(result.reportInputSha256).toBe(report.request.reportInputSha256);
    expect(result.captureId).toBe(source.capture.captureId);
    expect(result.captureDigest).toBe(source.capture.digest);
    expect(result.attempt).toBe(1);
    expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.sameVersion).toBe(true);
    expect(result.taskAccepted).toBe(false);
    expect(result.semanticAcceptance).toBe("not-evaluated");
    expect(Object.isFrozen(result)).toBe(true);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("candidate 0");
    expect(encoded).not.toContain(f.workspace);
    expect(await settle(duplicate)).toBe(result);
    expect(await settle(report.prepared.reread())).toBe(result);
    expect(h.control.calls).toBe(captureBefore + 1);
    expect(h.calls.clock).toBeGreaterThan(clockBefore);
    expect(h.runnerState.requests.length).toBe(workerBefore);
    expect(h.calls.prepare).toBe(1);

    const after = inspectHistory(h);
    expect(after.output.retainedCaptures).toBe(before.output.retainedCaptures);
    expect(after.output.retainedBytes).toBe(before.output.retainedBytes);
    expect(after.output.reservedBytes).toBe(0);
    expect(after.output.active).toBe(false);
    expect(after.operations[0]!.output.state).toBe("captured");
    expect(after.operations[0]!.output.captureId).toBe(source.capture.captureId);
    expect(after.operations[0]!.output.checks).toEqual(before.operations[0]!.output.checks);
    expect(source.capture.changes[0]!.snapshot.text).toBe("candidate 0\n");
    expect(report.prepared.revalidate()).toBeNull();
    // Observation-time-only interval facts never become semantic acceptance.
    expect(report.prepared.facts).toBeTruthy();
    expect(check.response.ok).toBe(true);
  });

  test("real drift classifies by A1 and stays refused after restoration", async () => {
    const drifts = [
      {
        name: "winner content",
        mutate: async (f: Fixture, h: Harness) => {
          const completion = h.completion();
          if (completion === null) throw new Error("completion unavailable");
          await writeFile(path.join(completion.winner.cwd, FILE_PATH), "drifted winner\n", { mode: 0o600 });
          return async () => {
            await writeFile(path.join(completion.winner.cwd, FILE_PATH), "candidate 0\n", { mode: 0o600 });
          };
        },
      },
      {
        name: "empty output directory",
        mutate: async (_f: Fixture, h: Harness) => {
          const completion = h.completion();
          if (completion === null) throw new Error("completion unavailable");
          const added = path.join(completion.winner.cwd, "empty-output-directory");
          await mkdir(added, { mode: 0o700 });
          return async () => {
            await rm(added, { recursive: true, force: true });
          };
        },
      },
      {
        name: "original source",
        mutate: async (_f: Fixture, h: Harness) => {
          const completion = h.completion();
          if (completion === null) throw new Error("completion unavailable");
          const sourcePath = path.join(completion.prepared.sourceRoot, "a.txt");
          await writeFile(sourcePath, "drifted source\n", { mode: 0o600 });
          return async () => {
            await writeFile(sourcePath, "alpha\n", { mode: 0o600 });
          };
        },
      },
      {
        name: "base input",
        mutate: async (_f: Fixture, h: Harness) => {
          const completion = h.completion();
          if (completion === null) throw new Error("completion unavailable");
          const basePath = path.join(completion.base.root, "a.txt");
          await writeFile(basePath, "drifted base\n", { mode: 0o600 });
          return async () => {
            await writeFile(basePath, "alpha\n", { mode: 0o600 });
          };
        },
      },
      {
        name: "stage trace",
        mutate: async (_f: Fixture, h: Harness) => {
          const completion = h.completion();
          if (completion === null) throw new Error("completion unavailable");
          const tracePath = completion.winner.eventsPath;
          const original = await readFile(tracePath);
          await writeFile(tracePath, `${original.toString("utf8")}${JSON.stringify({ type: "drift" })}\n`, { mode: 0o600 });
          return async () => {
            await writeFile(tracePath, original, { mode: 0o600 });
          };
        },
      },
    ];

    for (const drift of drifts) {
      const f = await fixture();
      const h = setup(f);
      const source = await captureSource(f, h, "source-1");
      await registerCheck(
        f,
        h,
        "source-1",
        source.capture,
        "check-a",
        [{ id: "a", kind: "text-includes", value: "candidate" }],
      );
      const report = await preparedReport(f, h, source, ["check-a"]);
      const before = inspectHistory(h);
      const restore = await drift.mutate(f, h);
      const result = await settle(report.prepared.reread());
      expect(result.ok, `${drift.name} unexpectedly matched`).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("version-mismatch");
        expect(result.attempt).toBe(1);
      }
      await restore();
      expect(report.prepared.refresh()).not.toBeNull();
      expect(report.prepared.revalidate()).not.toBeNull();
      const failedAgain = await settle(report.prepared.reread());
      expect(failedAgain.ok).toBe(false);
      if (!failedAgain.ok) expect(failedAgain.code).toBe("version-mismatch");
      const after = inspectHistory(h);
      expect(after.output.retainedCaptures).toBe(before.output.retainedCaptures);
      expect(after.output.retainedBytes).toBe(before.output.retainedBytes);
      expect(after.output.reservedBytes).toBe(0);
      expect(source.capture.changes[0]!.snapshot.text).toBe("candidate 0\n");
      // A new report id or restored bytes cannot clear the sticky refusal.
      const next = await reportPreflight(f, source, ["check-a"], "insufficient", "report-2");
      const nextPrepare = h.coordinator.prepareReport(next.request, new AbortController().signal);
      expect(nextPrepare.ok).toBe(false);
      if (!nextPrepare.ok) expect(nextPrepare.code).toBe("source-conflict");
    }
  });

  test("unmarked uncertainty retries under a new report id; an explicit marker is sticky", async () => {
    const f = await fixture();
    const h = setup(f);
    const source = await captureSource(f, h, "source-1");
    await registerCheck(
      f,
      h,
      "source-1",
      source.capture,
      "check-a",
      [{ id: "a", kind: "text-includes", value: "candidate" }],
    );
    const first = await preparedReport(f, h, source, ["check-a"]);
    h.control.hook = (call) => {
      if (call !== 2) return undefined;
      return Promise.resolve({ ok: false as const, code: "io-failure" as const, reason: "injected uncertain I/O" });
    };
    const uncertain = await settle(first.prepared.reread());
    expect(uncertain.ok).toBe(false);
    if (!uncertain.ok) {
      expect(uncertain.code).toBe("reread-unavailable");
      expect(uncertain.attempt).toBe(1);
    }
    expect(inspectHistory(h).output.reservedBytes).toBe(0);
    h.control.hook = null;
    const retry = await preparedReport(f, h, source, ["check-a"], "insufficient", "report-2");
    const matched = await settle(retry.prepared.reread());
    expect(matched.ok, matched.ok ? "" : matched.reason).toBe(true);
    if (matched.ok) expect(matched.attempt).toBe(2);

    const markerFixture = await fixture();
    const markerHarness = setup(markerFixture);
    const markerSource = await captureSource(markerFixture, markerHarness, "source-1");
    await registerCheck(
      markerFixture,
      markerHarness,
      "source-1",
      markerSource.capture,
      "check-a",
      [{ id: "a", kind: "text-includes", value: "candidate" }],
    );
    const markerReport = await preparedReport(markerFixture, markerHarness, markerSource, ["check-a"]);
    markerHarness.control.hook = (call) => {
      if (call !== 2) return undefined;
      return Promise.resolve({
        ok: false as const,
        code: "changed" as const,
        reason: "trusted observed mismatch",
        observedMismatch: true as const,
      });
    };
    const marked = await settle(markerReport.prepared.reread());
    expect(marked.ok).toBe(false);
    if (!marked.ok) {
      expect(marked.code).toBe("version-mismatch");
      expect(marked.attempt).toBe(1);
    }
    const refused = await reportPreflight(
      markerFixture,
      markerSource,
      ["check-a"],
      "insufficient",
      "report-2",
    );
    const refusedPrepare = markerHarness.coordinator.prepareReport(
      refused.request,
      new AbortController().signal,
    );
    expect(refusedPrepare.ok).toBe(false);
    if (!refusedPrepare.ok) expect(refusedPrepare.code).toBe("source-conflict");
  });

  test("deferred reread joins exactly, cancels by report id and disposes independently", async () => {
    const f = await fixture();
    const h = setup(f);
    const source = await captureSource(f, h, "source-1");
    await registerCheck(
      f,
      h,
      "source-1",
      source.capture,
      "check-a",
      [{ id: "a", kind: "text-includes", value: "candidate" }],
    );
    const report = await preparedReport(f, h, source, ["check-a"]);
    const beforeOperation = inspectHistory(h).operations[0]!;
    const gate = deferred<NativeHarnessOutputCaptureResult>();
    let nested: Promise<NativeHarnessReportRereadResult> | null = null;
    h.control.hook = (call, backend, guard, signal) => {
      if (call !== 2) return undefined;
      nested = report.prepared.reread();
      return gate.promise.then(() => captureNativeHarnessOutput(backend, guard, signal));
    };
    const first = report.prepared.reread();
    expect(nested !== null).toBe(true);
    expect(nested === first).toBe(true);
    expect(inspectHistory(h).output.reservedBytes).toBe(1024 * 1024);
    expect(inspectHistory(h).output.active).toBe(true);
    // A source id cannot steal the report owner or its reservation.
    expect(h.coordinator.cancel("source-1")).toBe(false);
    expect(inspectHistory(h).output.reservedBytes).toBe(1024 * 1024);
    expect(h.coordinator.cancel(REPORT_ID)).toBe(true);
    expect(inspectHistory(h).output.reservedBytes).toBe(1024 * 1024);
    gate.resolve({ ok: false as const, code: "aborted" as const, reason: "fixture drain" });
    const result = await settle(first);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cancelled");
      expect(result.attempt).toBe(1);
    }
    expect(await settle(nested!)).toBe(result);
    expect(inspectHistory(h).output.reservedBytes).toBe(0);
    expect(inspectHistory(h).output.active).toBe(false);
    const afterOperation = inspectHistory(h).operations[0]!;
    expect(afterOperation.outcome).toBe(beforeOperation.outcome);
    expect(afterOperation.executionState).toBe(beforeOperation.executionState);
    expect(afterOperation.termination).toBe(beforeOperation.termination);
    expect(afterOperation.cancellation).toBe(beforeOperation.cancellation);
    expect(afterOperation.cost).toEqual(beforeOperation.cost);
    expect(afterOperation.output.state).toBe("captured");
    expect(afterOperation.output.captureId).toBe(beforeOperation.output.captureId);
    expect(source.capture.changes[0]!.snapshot.text).toBe("candidate 0\n");

    // Dispose must cancel a report owner even while a cached capture action
    // binding is installed on the same Slot.
    const disposeFixture = await fixture();
    const disposeHarness = setup(disposeFixture);
    const disposeSource = await captureSource(disposeFixture, disposeHarness, "source-1");
    await registerCheck(
      disposeFixture,
      disposeHarness,
      "source-1",
      disposeSource.capture,
      "check-a",
      [{ id: "a", kind: "text-includes", value: "candidate" }],
    );
    const disposeReport = await preparedReport(disposeFixture, disposeHarness, disposeSource, ["check-a"]);
    const disposeGate = deferred<NativeHarnessOutputCaptureResult>();
    let disposeNested: Promise<NativeHarnessReportRereadResult> | null = null;
    disposeHarness.control.hook = (call, backend, guard, signal) => {
      if (call !== 2) return undefined;
      disposeNested = disposeReport.prepared.reread();
      return disposeGate.promise.then(() => captureNativeHarnessOutput(backend, guard, signal));
    };
    const disposeFirst = disposeReport.prepared.reread();
    const actionRaw = { action: "capture", sourceToolCallId: "source-1" };
    await disposeFixture.host.emit("tool_call", {
      toolCallId: "cap-action",
      toolName: NATIVE_HARNESS_RESULT_TOOL,
      input: actionRaw,
    }, disposeFixture.ctx);
    let actionContextCalls = 0;
    let disposedFromAction = false;
    disposeHarness.onContext(() => {
      actionContextCalls += 1;
      if (actionContextCalls !== 2 || disposedFromAction) return;
      disposedFromAction = true;
      disposeHarness.coordinator.dispose();
    });
    const actionSelection = await settle(disposeHarness.coordinator.captureOutputForCall(
      "cap-action",
      actionRaw,
      new AbortController().signal,
    ));
    expect(disposedFromAction).toBe(true);
    expect(actionSelection.ok).toBe(false);
    // The cancelled action record proves dispose ran while the capture action
    // binding was installed, yet report cleanup still ran independently.
    if (!actionSelection.ok) expect(actionSelection.code).toBe("cancelled");
    disposeHarness.onContext(null);
    disposeGate.resolve({ ok: false as const, code: "aborted" as const, reason: "fixture drain" });
    const disposeResult = await settle(disposeFirst);
    expect(disposeResult.ok).toBe(false);
    if (!disposeResult.ok) {
      expect(disposeResult.code).toBe("cancelled");
      expect(disposeResult.attempt).toBe(1);
    }
    expect(await settle(disposeNested!)).toBe(disposeResult);
    expect(inspectHistory(disposeHarness).output.reservedBytes).toBe(0);
  });

  test("shared busy gates, 2MiB headroom, four attempts and zero-consumption refusals", async () => {
    const f = await fixture();
    const h = setup(f);
    const source = await captureSource(f, h, "source-1");
    await registerCheck(
      f,
      h,
      "source-1",
      source.capture,
      "check-a",
      [{ id: "a", kind: "text-includes", value: "candidate" }],
    );
    await callSource(f, "source-2");
    const secondSignal = new AbortController();
    const secondResult = await settle(h.coordinator.invoke("source-2", { task: WORK_TASK }, secondSignal.signal));
    expect(secondResult.outcome).toBe("backend-completed");
    const secondWire = projectionFor(secondResult);
    expect(h.coordinator.registerToolResultProjection("source-2", secondResult, secondWire, secondSignal.signal).ok).toBe(true);
    await emitSourceResult(f, "source-2", secondWire);

    const report = await preparedReport(f, h, source, ["check-a"]);
    const secondReport = await preparedReport(f, h, source, ["check-a"], "insufficient", "report-2");
    const gate = deferred<NativeHarnessOutputCaptureResult>();
    h.control.hook = (call, backend, guard, signal) => {
      if (call !== 2) return undefined;
      return gate.promise.then(() => captureNativeHarnessOutput(backend, guard, signal));
    };
    const first = report.prepared.reread();
    const secondBusy = await settle(secondReport.prepared.reread());
    expect(secondBusy.ok).toBe(false);
    if (!secondBusy.ok) expect(secondBusy.code).toBe("capacity");
    expect(secondBusy.attempt).toBeUndefined();
    const captureBusy = await settle(h.coordinator.captureOutput("source-2", new AbortController().signal));
    expect(captureBusy.ok).toBe(false);
    if (!captureBusy.ok) expect(captureBusy.code).toBe("capacity");
    gate.resolve({ ok: false as const, code: "aborted" as const, reason: "fixture drain" });
    const firstResult = await settle(first);
    expect(firstResult.ok, firstResult.ok ? "" : firstResult.reason).toBe(true);
    if (firstResult.ok) expect(firstResult.attempt).toBe(1);
    expect(inspectHistory(h).output.reservedBytes).toBe(0);
    h.control.hook = null;

    // Reverse busy: an admitted capture blocks a new report reread.
    const captureGate = deferred<NativeHarnessOutputCaptureResult>();
    h.control.hook = (call, backend, guard, signal) => {
      if (call !== 3) return undefined;
      return captureGate.promise.then(() => captureNativeHarnessOutput(backend, guard, signal));
    };
    const capturePromise = h.coordinator.captureOutput("source-2", new AbortController().signal);
    const thirdReport = await preparedReport(f, h, source, ["check-a"], "insufficient", "report-3");
    const captureBusyReread = await settle(thirdReport.prepared.reread());
    expect(captureBusyReread.ok).toBe(false);
    if (!captureBusyReread.ok) expect(captureBusyReread.code).toBe("capacity");
    captureGate.resolve({ ok: false as const, code: "aborted" as const, reason: "fixture drain" });
    await settle(capturePromise);
    h.control.hook = null;

    // The same report id cannot be re-admitted through another source Slot.
    const sourceTwoSelection = await h.coordinator.captureOutput("source-2", new AbortController().signal);
    expect(sourceTwoSelection.ok).toBe(true);
    if (!sourceTwoSelection.ok) return;
    const crossPrepared = h.coordinator.prepareReport({
      ...report.request,
      selection: {
        sourceToolCallId: "source-2",
        captureId: sourceTwoSelection.capture.captureId,
        captureDigest: sourceTwoSelection.capture.digest,
        checkToolCallIds: [],
      },
      outcome: "insufficient",
    }, new AbortController().signal);
    expect(crossPrepared.ok).toBe(true);
    if (crossPrepared.ok) {
      const cross = await settle(crossPrepared.prepared.reread());
      expect(cross.ok).toBe(false);
      if (!cross.ok) {
        expect(cross.code).toBe("invalid-caller");
        expect(cross.attempt).toBeUndefined();
      }
    }

    // Aborted actual report signal consumes zero attempts.
    const abortedReport = await preparedReport(f, h, source, ["check-a"], "insufficient", "report-4");
    abortedReport.signal.abort();
    const aborted = await settle(abortedReport.prepared.reread());
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) {
      expect(aborted.code).toBe("cancelled");
      expect(aborted.attempt).toBeUndefined();
    }
    expect(inspectHistory(h).output.reservedBytes).toBe(0);
    const retried = await preparedReport(f, h, source, ["check-a"], "insufficient", "report-4");
    const retriedResult = await settle(retried.prepared.reread());
    expect(retriedResult.ok, retriedResult.ok ? "" : retriedResult.reason).toBe(true);
    // The aborted admission consumed zero, so this is the second admitted
    // attempt after the first report's successful observation.
    if (retriedResult.ok) expect(retriedResult.attempt).toBe(2);
    expect(inspectHistory(h).output.reservedBytes).toBe(0);

    // 2MiB headroom: two ~600KB captures leave no room for another 1MiB.
    const bigFixture = await fixture();
    const bigHarness = setup(bigFixture, {
      runnerState: candidateRunner(200 * 1024, false, 3),
    });
    const bigOne = await captureSource(bigFixture, bigHarness, "source-1");
    const bigTwo = await captureSource(bigFixture, bigHarness, "source-2");
    const retainedText = [...bigOne.capture.changes, ...bigTwo.capture.changes].reduce(
      (total, change) => total + (change.snapshot.file?.bytes ?? 0),
      0,
    );
    expect(retainedText).toBeGreaterThan(1024 * 1024);
    const bigReport = await preparedReport(bigFixture, bigHarness, bigOne, []);
    const over = await settle(bigReport.prepared.reread());
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.code).toBe("capacity");
      expect(over.attempt).toBeUndefined();
    }
    expect(inspectHistory(bigHarness).output.reservedBytes).toBe(0);
    expect(inspectHistory(bigHarness).operations[0]!.output.state).toBe("captured");
  });

  test("four admitted uncertain attempts exhaust the fifth; throws and deadlines drain once", async () => {
    const f = await fixture();
    const h = setup(f);
    const source = await captureSource(f, h, "source-1");
    h.control.hook = (call) => {
      if (call < 2 || call > 5) return undefined;
      return Promise.resolve({ ok: false as const, code: "io-failure" as const, reason: "injected uncertain I/O" });
    };
    for (let index = 1; index <= 4; index += 1) {
      const report = await preparedReport(
        f,
        h,
        source,
        [],
        "insufficient",
        `report-${index}`,
      );
      const result = await settle(report.prepared.reread());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("reread-unavailable");
        expect(result.attempt).toBe(index);
      }
      expect(inspectHistory(h).output.reservedBytes).toBe(0);
    }
    const fifth = await preparedReport(f, h, source, [], "insufficient", "report-5");
    const refused = await settle(fifth.prepared.reread());
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("capacity");
      expect(refused.attempt).toBeUndefined();
    }
    h.control.hook = null;

    const drainFixture = await fixture();
    const drainHarness = setup(drainFixture);
    const drainSource = await captureSource(drainFixture, drainHarness, "source-1");
    const drains: Array<(call: number) => NativeHarnessOutputCaptureResult | Promise<NativeHarnessOutputCaptureResult> | undefined> = [
      () => {
        throw new Error("injected throw");
      },
      () => Promise.reject(new Error("injected rejection")),
      () => ({ ok: true as const, capture: {} as unknown as NativeHarnessOutputCapture }),
      () => Promise.resolve({
        ok: false as const,
        code: "changed" as const,
        reason: "unmarked changed",
      }),
    ];
    for (let index = 0; index < drains.length; index += 1) {
      const report = await preparedReport(
        drainFixture,
        drainHarness,
        drainSource,
        [],
        "insufficient",
        `report-${index + 1}`,
      );
      const targetCall = index + 2;
      drainHarness.control.hook = (call) => (call === targetCall ? drains[index]!(call) : undefined);
      const result = await settle(report.prepared.reread());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.attempt).toBe(index + 1);
      expect(inspectHistory(drainHarness).output.reservedBytes).toBe(0);
      expect(inspectHistory(drainHarness).output.active).toBe(false);
    }
    drainHarness.control.hook = null;

    // Cooperative deadline: the first guard reads a clock past the budget.
    const deadlineFixture = await fixture();
    const deadlineBase = Date.now();
    const deadlineHarness = setup(deadlineFixture, { now: () => deadlineBase });
    const deadlineSource = await captureSource(deadlineFixture, deadlineHarness, "source-1");
    const deadlineReport = await preparedReport(deadlineFixture, deadlineHarness, deadlineSource, []);
    let deadlineClock = deadlineBase + 31_000;
    deadlineHarness.setClock(() => {
      const value = deadlineClock;
      deadlineClock += 31_000;
      return value;
    });
    deadlineHarness.control.hook = (call, _backend, guard) => {
      if (call !== 2) return undefined;
      guard();
      return Promise.resolve({ ok: false as const, code: "aborted" as const, reason: "unreachable" });
    };
    const deadline = await settle(deadlineReport.prepared.reread());
    expect(deadline.ok).toBe(false);
    if (!deadline.ok) {
      expect(deadline.code).toBe("deadline");
      expect(deadline.attempt).toBe(1);
    }
    expect(inspectHistory(deadlineHarness).output.reservedBytes).toBe(0);
    expect(inspectHistory(deadlineHarness).output.active).toBe(false);
  });

  test("cancellation precedence, original captures and late invalidation never mint success", async () => {
    const precedenceFixture = await fixture();
    const precedenceHarness = setup(precedenceFixture);
    const precedenceSource = await captureSource(precedenceFixture, precedenceHarness, "source-1");
    const precedenceReport = await preparedReport(precedenceFixture, precedenceHarness, precedenceSource, []);
    precedenceHarness.control.hook = (call) => {
      if (call !== 2) return undefined;
      precedenceHarness.coordinator.cancel(REPORT_ID);
      return Promise.resolve({
        ok: false as const,
        code: "changed" as const,
        reason: "concurrent marker",
        observedMismatch: true as const,
      });
    };
    const cancelled = await settle(precedenceReport.prepared.reread());
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.code).toBe("cancelled");
    expect(inspectHistory(precedenceHarness).output.reservedBytes).toBe(0);
    // The concurrent marker did not become sticky drift.
    precedenceHarness.control.hook = null;
    const afterCancel = await preparedReport(
      precedenceFixture,
      precedenceHarness,
      precedenceSource,
      [],
      "insufficient",
      "report-2",
    );
    const afterCancelResult = await settle(afterCancel.prepared.reread());
    expect(afterCancelResult.ok).toBe(true);

    // The exact original capture cannot stand in for a newly issued reread.
    const originalFixture = await fixture();
    const originalHarness = setup(originalFixture);
    const originalSource = await captureSource(originalFixture, originalHarness, "source-1");
    const originalReport = await preparedReport(originalFixture, originalHarness, originalSource, []);
    originalHarness.control.hook = (call) => {
      if (call !== 2) return undefined;
      return Promise.resolve({ ok: true as const, capture: originalSource.capture });
    };
    const originalResult = await settle(originalReport.prepared.reread());
    expect(originalResult.ok).toBe(false);
    if (!originalResult.ok) {
      expect(originalResult.code).toBe("reread-unavailable");
      expect(originalResult.attempt).toBe(1);
    }
    originalHarness.control.hook = null;
    expect(originalHarness.coordinator.prepareReport(
      originalReport.request,
      new AbortController().signal,
    ).ok).toBe(true);

    // A changed selected check observation refuses before any success.
    const checkFixture = await fixture();
    const checkHarness = setup(checkFixture);
    const checkSource = await captureSource(checkFixture, checkHarness, "source-1");
    const registered = await registerCheck(
      checkFixture,
      checkHarness,
      "source-1",
      checkSource.capture,
      "check-a",
      [{ id: "a", kind: "text-includes", value: "candidate" }],
    );
    const checkReport = await preparedReport(checkFixture, checkHarness, checkSource, ["check-a"]);
    await checkFixture.host.emit("tool_result", {
      toolCallId: "check-a",
      toolName: NATIVE_HARNESS_RESULT_TOOL,
      input: registered.raw,
      content: [{ type: "text", text: "changed observed check result" }],
      details: { changed: true },
      isError: false,
    }, checkFixture.ctx);
    const changedCheck = await settle(checkReport.prepared.reread());
    expect(changedCheck.ok).toBe(false);
    expect(inspectHistory(checkHarness).output.reservedBytes).toBe(0);

    // Old source/check aborts do not replace the report signal; a later actual
    // report-signal abort refuses publication without rewriting the interval.
    const signalFixture = await fixture();
    const signalHarness = setup(signalFixture);
    const signalSource = await captureSource(signalFixture, signalHarness, "source-1");
    const signalCheck = await registerCheck(
      signalFixture,
      signalHarness,
      "source-1",
      signalSource.capture,
      "check-a",
      [{ id: "a", kind: "text-includes", value: "candidate" }],
    );
    const signalReport = await preparedReport(signalFixture, signalHarness, signalSource, ["check-a"]);
    const signalResult = await settle(signalReport.prepared.reread());
    expect(signalResult.ok).toBe(true);
    signalCheck.controller.abort();
    signalSource.controller.abort();
    expect(signalReport.prepared.revalidate()).toBeNull();
    signalReport.signal.abort();
    expect(typeof signalReport.prepared.revalidate()).toBe("string");
    expect(signalResult.ok).toBe(true);
    if (signalResult.ok) {
      expect(signalResult.finishedAt).toBeGreaterThanOrEqual(signalResult.startedAt);
      expect(signalResult.attempt).toBe(1);
    }
  });

  test("late report-input invalidation during admission refuses without a record", async () => {
    const f = await fixture();
    const h = setup(f);
    const source = await captureSource(f, h, "source-1");
    await registerCheck(
      f,
      h,
      "source-1",
      source.capture,
      "check-a",
      [{ id: "a", kind: "text-includes", value: "candidate" }],
    );
    const report = await preparedReport(f, h, source, ["check-a"]);
    let mutated = false;
    let contextCalls = 0;
    h.onContext(() => {
      contextCalls += 1;
      if (mutated || contextCalls < 2) return;
      mutated = true;
      void f.host.emit("tool_call", {
        toolCallId: REPORT_ID,
        toolName: AGENT_WORK,
        input: { ...report.rawInput, summary: "changed late" },
      }, f.ctx);
    });
    const result = await settle(report.prepared.reread());
    expect(mutated).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["authority-lost", "source-conflict", "not-ready"]).toContain(result.code);
    }
    expect(inspectHistory(h).output.reservedBytes).toBe(0);
    expect(inspectHistory(h).output.active).toBe(false);
  });

  test("a control failure in the async settlement gap cannot publish stale success", async () => {
    const f = await fixture();
    const h = setup(f);
    const source = await captureSource(f, h, "source-1");
    const report = await preparedReport(f, h, source, []);
    h.control.hook = (call, backend, guard, signal) => {
      if (call !== 2) return undefined;
      const real = captureNativeHarnessOutput(backend, guard, signal);
      return real.then((capture) => {
        // Runs before the coordinator's await continuation resumes, i.e. after
        // the leaf observation but before the settlement seal.
        queueMicrotask(() => h.coordinator.dispose());
        return capture;
      });
    };
    const result = await settle(report.prepared.reread());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["cancelled", "authority-lost"]).toContain(result.code);
      expect(result.attempt).toBe(1);
    }
    expect(inspectHistory(h).output.reservedBytes).toBe(0);
    expect(inspectHistory(h).output.active).toBe(false);
    expect(source.capture.changes[0]!.snapshot.text).toBe("candidate 0\n");
  });

  test("owner loss before sealing suppresses sticky drift and stale success", async () => {
    const f = await fixture();
    const base = genuinePort();
    let ownerReason: string | null = null;
    let armMatches = false;
    const port: NativeHarnessOutputPort = {
      capture: base.port.capture,
      matches(backend: unknown, capture: unknown) {
        const result = base.port.matches(backend, capture);
        if (armMatches) {
          armMatches = false;
          // Runs after the leaf comparison but before the settlement seal.
          queueMicrotask(() => {
            ownerReason = "the original output owner was lost during settlement";
          });
        }
        return result;
      },
      revalidateOwner() {
        return ownerReason;
      },
    };
    const h = setup(f, { genuine: { port, control: base.control } });
    const source = await captureSource(f, h, "source-1");
    const report = await preparedReport(f, h, source, []);
    const completion = h.completion();
    if (completion === null) throw new Error("completion unavailable");
    await writeFile(path.join(completion.winner.cwd, FILE_PATH), "drifted winner\n", { mode: 0o600 });
    const running = report.prepared.reread();
    armMatches = true;
    const result = await settle(running);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["authority-lost", "cancelled"]).toContain(result.code);
    expect(inspectHistory(h).output.reservedBytes).toBe(0);
    await writeFile(path.join(completion.winner.cwd, FILE_PATH), "candidate 0\n", { mode: 0o600 });
    ownerReason = null;
    armMatches = false;
    const next = await reportPreflight(f, source, [], "insufficient", "report-2");
    const prepared = h.coordinator.prepareReport(next.request, new AbortController().signal);
    expect(prepared.ok).toBe(true);
  });

  test("a control-coded marker is not drift evidence and is never sticky", async () => {
    const f = await fixture();
    const h = setup(f);
    const source = await captureSource(f, h, "source-1");
    const report = await preparedReport(f, h, source, []);
    h.control.hook = (call) => {
      if (call !== 2) return undefined;
      return Promise.resolve({
        ok: false as const,
        code: "aborted" as const,
        reason: "control won over a malformed marker",
        observedMismatch: true as const,
      });
    };
    const result = await settle(report.prepared.reread());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cancelled");
      expect(result.attempt).toBe(1);
    }
    expect(inspectHistory(h).output.reservedBytes).toBe(0);
    h.control.hook = null;
    const next = await preparedReport(f, h, source, [], "insufficient", "report-2");
    const matched = await settle(next.prepared.reread());
    expect(matched.ok, matched.ok ? "" : matched.reason).toBe(true);
    if (matched.ok) expect(matched.attempt).toBe(2);
  });

  test("new unselected checks cannot join a frozen selection while waiting", async () => {
    const f = await fixture();
    const h = setup(f, { runnerState: candidateRunner(0, true) });
    const source = await captureSource(f, h, "source-1");
    await registerCheck(
      f,
      h,
      "source-1",
      source.capture,
      "check-a",
      [{ id: "a", kind: "text-includes", value: "candidate" }],
    );
    const report = await preparedReport(f, h, source, ["check-a"]);
    const gate = deferred<NativeHarnessOutputCaptureResult>();
    h.control.hook = (call, backend, guard, signal) => {
      if (call !== 2) return undefined;
      return gate.promise.then(() => captureNativeHarnessOutput(backend, guard, signal));
    };
    const first = report.prepared.reread();
    await registerCheck(
      f,
      h,
      "source-1",
      source.capture,
      "check-b",
      [{ id: "b", kind: "text-includes", value: "second" }],
      "second.txt",
    );
    gate.resolve({ ok: false as const, code: "aborted" as const, reason: "fixture drain" });
    const result = await settle(first);
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (result.ok) expect(result.attempt).toBe(1);
    const facts = report.prepared.facts as {
      readonly files: readonly {
        readonly path: string;
        readonly check: { readonly checkToolCallId: string } | null;
      }[];
    };
    const selected = facts.files.find((file) => file.path === FILE_PATH);
    expect(selected?.check?.checkToolCallId).toBe("check-a");
    const unselected = facts.files.find((file) => file.path === "second.txt");
    expect(unselected?.check).toBeNull();
  });
});
