import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNativeEntry,
  type NativeContext,
  type NativeEntryControls,
  type NativeOmpApi,
  type NativeToolResult,
  type NativeWorkCallReference,
  type NativeWorkReport,
} from "../../src/native-entry.ts";
import {
  NATIVE_HARNESS_REPORT_BINDING_SCHEMA,
  NATIVE_HARNESS_REPORT_MAX_FACTS_BYTES,
  NATIVE_HARNESS_REPORT_REREAD_SCHEMA,
  createNativeHarnessReportFacts,
  type NativeHarnessReportBindingFacts,
  type NativeHarnessReportRequest,
  type NativeHarnessReportRereadResult,
  type NativeHarnessReportRereadSuccess,
  type NativeHarnessReportSelection,
} from "../../src/native-harness-report.ts";
import type { NativeHarnessReportPort } from "../../src/native-harness-report-protocol.ts";
import {
  NATIVE_HARNESS_CHECK_PLAN_SOURCE,
} from "../../src/native-harness-checks.ts";
import {
  NATIVE_TEXT_CHECK_SCHEMA_VERSION,
  NATIVE_TEXT_CHECKER_ID,
  NATIVE_TEXT_CHECKER_VERSION,
  type NativeTextCheckReceipt,
} from "../../src/native-snapshot-checker.ts";
import type { NativeReportWorkIdentity } from "../../src/native-instance-report.ts";
import type { NativeObservedFile } from "../../src/native-work.ts";
import type { NativeHarnessReportFileFacts } from "../../src/native-harness-report.ts";
import { clearPublishedTaskOwner } from "../../src/task-entry-port.ts";

const AGENT_WORK = "agent_work";
const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const CAPTURE_ORDER = ["check-1", "check-2"] as const;

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

  emitSync(type: string, event: Record<string, unknown>, context: NativeContext): void {
    for (const handler of this.handlers.get(type) ?? []) {
      const result = handler({ ...event, type }, context);
      if (result instanceof Promise) throw new Error(`unexpected async handler for ${type}`);
    }
  }

  async observe(context: NativeContext, toolCallId: string, toolName: string, text: string): Promise<void> {
    await this.emit("tool_call", { toolCallId, toolName, input: {} }, context);
    await this.emit("tool_result", {
      toolCallId,
      toolName,
      input: {},
      content: [{ type: "text", text }],
      isError: false,
      details: undefined,
    }, context);
  }

  async execute(
    toolCallId: string,
    params: unknown,
    context: NativeContext,
    signal: AbortSignal | undefined,
  ): Promise<NativeToolResult> {
    const tool = this.tools.get(AGENT_WORK);
    if (tool === undefined) throw new Error("agent_work was not registered");
    return await tool.execute(toolCallId, params, signal, undefined, context);
  }

  async call(
    toolCallId: string,
    params: unknown,
    context: NativeContext,
    signal: AbortSignal | undefined,
  ): Promise<NativeToolResult> {
    await this.emit("tool_call", { toolCallId, toolName: AGENT_WORK, input: params }, context);
    const result = await this.execute(toolCallId, params, context, signal);
    await this.emit("tool_result", {
      toolCallId,
      toolName: AGENT_WORK,
      input: params,
      content: result.content,
      isError: result.isError === true,
      details: result.details,
    }, context);
    return result;
  }
}

const receipts = new Map<string, NativeTextCheckReceipt>();

function receiptFor(checkToolCallId: string): NativeTextCheckReceipt {
  const existing = receipts.get(checkToolCallId);
  if (existing !== undefined) return existing;
  const file: NativeObservedFile = {
    relativePath: `captured-${checkToolCallId}.txt`,
    bytes: 1,
    sha256: DIGEST,
    observedAt: 900,
  };
  const receipt: NativeTextCheckReceipt = Object.freeze({
    schemaVersion: NATIVE_TEXT_CHECK_SCHEMA_VERSION,
    checkerId: NATIVE_TEXT_CHECKER_ID,
    checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
    planDigest: DIGEST,
    snapshot: Object.freeze({ captureId: "capture-1", file: Object.freeze(file) }),
    conditions: Object.freeze([
      Object.freeze({ id: "exists", result: "pass" as const, detail: "observed" }),
    ]),
    outcome: "pass" as const,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  });
  receipts.set(checkToolCallId, receipt);
  return receipt;
}

interface FactsOptions {
  readonly fileDigest?: string;
  readonly extraFiles?: number;
}

function makeFacts(
  request: NativeHarnessReportRequest,
  options: FactsOptions = {},
): NativeHarnessReportBindingFacts {
  const selected = new Set(request.selection.checkToolCallIds);
  const ordered = [
    ...CAPTURE_ORDER.filter((id) => selected.has(id)),
    ...[...selected].filter((id) => !CAPTURE_ORDER.includes(id as typeof CAPTURE_ORDER[number])),
  ];
  const files: NativeHarnessReportFileFacts[] = ordered.map((checkToolCallId, index) => ({
    path: `captured-${checkToolCallId}-${index}.txt`,
    kind: "add" as const,
    mode: 0o644,
    controllerHash: DIGEST,
    fileSnapshotId: "file-snapshot-1",
    bytes: 1,
    sha256: options.fileDigest ?? DIGEST,
    observedAt: 900,
    check: {
      checkToolCallId,
      computedByToolCallId: `compute-${checkToolCallId}`,
      checkerId: NATIVE_TEXT_CHECKER_ID,
      checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
      planSource: NATIVE_HARNESS_CHECK_PLAN_SOURCE,
      planDigest: DIGEST,
      receipt: receiptFor(checkToolCallId),
    },
  }));
  for (let index = 0; index < (options.extraFiles ?? 0); index++) {
    files.push({
      path: `padding/${index}-${"\\".repeat(1000)}.txt`,
      kind: "modify" as const,
      mode: 0o644,
      controllerHash: DIGEST,
      fileSnapshotId: `padding-${index}`,
      bytes: index,
      sha256: DIGEST,
      observedAt: 900 + index,
      check: null,
    });
  }
  const created = createNativeHarnessReportFacts({
    modelDeclaredOutcome: request.outcome,
    source: {
      toolCallId: request.selection.sourceToolCallId,
      observationId: request.work.observationId,
      generation: request.work.generation,
      taskSha256: DIGEST,
      promptSha256: DIGEST,
      inputSha256: DIGEST,
      observedEnvelopeSha256: DIGEST,
      observedEnvelopeBytes: 256,
    },
    capture: {
      captureId: request.selection.captureId,
      captureDigest: request.selection.captureDigest,
      originKind: "capture",
      completionId: "completion-1",
      runId: "run-1",
      baseSnapshotId: "base-1",
      manifestSha256: DIGEST,
      winner: {
        candidate: "candidate-1",
        attempt: 1,
        artifactHash: DIGEST,
        traceHash: DIGEST,
      },
      observedAt: 900,
    },
    files,
  });
  if (!created.ok) throw new Error(created.reason);
  return created.facts;
}

function rereadSuccess(request: NativeHarnessReportRequest): NativeHarnessReportRereadSuccess {
  return Object.freeze({
    ok: true as const,
    schema: NATIVE_HARNESS_REPORT_REREAD_SCHEMA,
    sourceToolCallId: request.selection.sourceToolCallId,
    reportToolCallId: request.reportRef.toolCallId,
    reportInputSha256: request.reportInputSha256,
    captureId: request.selection.captureId,
    captureDigest: request.selection.captureDigest,
    attempt: 1,
    startedAt: 1000,
    finishedAt: 2000,
    sameVersion: true as const,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  });
}

type AnyHook = (...args: any[]) => unknown;

class FakePort implements NativeHarnessReportPort {
  prepareCalls = 0;
  refreshCalls = 0;
  revalidateCalls = 0;
  rereadCalls = 0;
  requests: NativeHarnessReportRequest[] = [];
  lastRequest: NativeHarnessReportRequest | null = null;
  lastFacts: NativeHarnessReportBindingFacts | null = null;
  prepareHook: AnyHook | null = null;
  refreshHook: AnyHook | null = null;
  revalidateHook: AnyHook | null = null;
  rereadHook: AnyHook | null = null;
  factsFactory: (request: NativeHarnessReportRequest) => NativeHarnessReportBindingFacts;

  constructor(factsFactory: (request: NativeHarnessReportRequest) => NativeHarnessReportBindingFacts = makeFacts) {
    this.factsFactory = factsFactory;
  }

  prepare(
    request: NativeHarnessReportRequest,
    signal: unknown,
    context: NativeContext,
  ): any {
    this.prepareCalls += 1;
    this.requests.push(request);
    this.lastRequest = request;
    if (this.prepareHook !== null) return this.prepareHook(request, signal, context);
    const facts = this.factsFactory(request);
    this.lastFacts = facts;
    return {
      ok: true,
      prepared: {
        facts,
        refresh: () => {
          this.refreshCalls += 1;
          return this.refreshHook === null ? null : this.refreshHook(request);
        },
        revalidate: () => {
          this.revalidateCalls += 1;
          return this.revalidateHook === null ? null : this.revalidateHook(request);
        },
        reread: () => {
          this.rereadCalls += 1;
          return this.rereadHook === null ? Promise.resolve(rereadSuccess(request)) : this.rereadHook(request);
        },
      },
    };
  }
}

interface Fixture {
  root: string;
  workspace: string;
  host: Host;
  port: FakePort | null;
  entry: NativeEntryControls;
  ctx: NativeContext;
  setSessionId(value: string): void;
  setLiveCwd(value: string): void;
  signal(): AbortSignal;
}

interface FixtureOptions {
  port?: FakePort | null;
  now?: () => number;
  maxReportBindings?: number;
}

const roots: string[] = [];
const entries: NativeEntryControls[] = [];

afterEach(async () => {
  clearPublishedTaskOwner();
  for (const entry of entries.splice(0)) entry.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-harness-report-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const host = new Host();
  const port = options.port === null ? null : options.port ?? new FakePort();
  let sessionId = "session-native";
  let liveCwd = workspace;
  let now = options.now ?? (() => 1000);
  const ctx: NativeContext = {
    cwd: workspace,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      getCwd() {
        return liveCwd;
      },
    },
  };
  const entry = createNativeEntry(host.pi, {
    now: () => now(),
    ...(port === null ? {} : { harnessReports: port }),
    ...(options.maxReportBindings === undefined ? {} : { maxReportBindings: options.maxReportBindings }),
  });
  entries.push(entry);
  return {
    root,
    workspace,
    host,
    port,
    entry,
    ctx,
    setSessionId(value) {
      sessionId = value;
    },
    setLiveCwd(value) {
      liveCwd = value;
    },
    signal() {
      return new AbortController().signal;
    },
  };
}

function selection(
  checkToolCallIds: string[] = ["check-1"],
  sourceToolCallId = "source-1",
): NativeHarnessReportSelection {
  return Object.freeze({
    sourceToolCallId,
    captureId: "capture-1",
    captureDigest: DIGEST,
    checkToolCallIds: Object.freeze([...checkToolCallIds]),
  });
}

function reportArgs(
  selector: NativeHarnessReportSelection,
  options: {
    checks?: Array<{ toolCallId: string; purpose: string }>;
    summary?: string;
    outcome?: "completed" | "insufficient" | "blocked";
    limitations?: string[];
    outputFiles?: string[];
    extra?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const checks = options.checks ?? [
    { toolCallId: "source-1", purpose: "captured the source output" },
    { toolCallId: "check-1", purpose: "checked the captured output" },
    ...(selector.checkToolCallIds.includes("check-2")
      ? [{ toolCallId: "check-2", purpose: "checked the second captured output" }]
      : []),
  ];
  return {
    action: "report",
    checks,
    outputFiles: options.outputFiles ?? [],
    outcome: options.outcome ?? "completed",
    summary: options.summary ?? "same semantic summary",
    limitations: options.limitations ?? ["semantic acceptance was not evaluated"],
    harnessResult: selector,
    ...(options.extra ?? {}),
  };
}

async function prepareWork(f: Fixture, text = "harness report request"): Promise<void> {
  await f.host.emit("input", { text, source: "rpc" }, f.ctx);
  await f.host.emit("before_agent_start", {
    reason: "prompt",
    prompt: text,
    systemPrompt: ["base"],
  }, f.ctx);
}

async function observe(f: Fixture, toolCallId: string, toolName = "read"): Promise<void> {
  await f.host.observe(f.ctx, toolCallId, toolName, `${toolName} completed`);
}

async function prime(f: Fixture, toolCallId: string, params: unknown): Promise<void> {
  await f.host.emit("tool_call", { toolCallId, toolName: AGENT_WORK, input: params }, f.ctx);
}

async function execute(f: Fixture, toolCallId: string, params: unknown, signal?: AbortSignal): Promise<NativeToolResult> {
  return await f.host.execute(toolCallId, params, f.ctx, signal ?? f.signal());
}

function expectError(result: NativeToolResult, pattern?: RegExp): void {
  expect(result.isError).toBe(true);
  if (pattern !== undefined) expect(result.content[0]?.text ?? "").toMatch(pattern);
}

function reportDetails(result: NativeToolResult): NativeWorkReport {
  if (result.isError === true) throw new Error(result.content[0]?.text ?? "report refused");
  return result.details as NativeWorkReport;
}

async function inspectCurrent(f: Fixture): Promise<any> {
  const result = await f.host.call(
    `inspect-${Math.random().toString(16).slice(2)}`,
    { action: "inspect" },
    f.ctx,
    f.signal(),
  );
  expect(result.isError).not.toBe(true);
  return (result.details as any).current;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

async function preparedWithSource(f: Fixture, extraCheck = true): Promise<void> {
  await prepareWork(f);
  await observe(f, "source-1", "task");
  if (extraCheck) await observe(f, "check-1");
}

describe("native Harness report publication", () => {
  test("one selected report rereads once, preserves trusted facts by identity and publishes empty outputFiles", async () => {
    const f = await fixture();
    await preparedWithSource(f);
    await prime(f, "report-a", reportArgs(selection()));
    const result = await execute(f, "report-a", reportArgs(selection()));
    const report = reportDetails(result);

    expect(f.port!.prepareCalls).toBe(1);
    expect(f.port!.rereadCalls).toBe(1);
    expect(f.port!.requests[0]!.reportInputSha256).toHaveLength(64);
    expect(report.observed.outputFiles).toEqual([]);
    expect(report.harnessResult?.facts).toBe(f.port!.lastFacts!);
    expect(report.harnessResult?.reread.schema).toBe(NATIVE_HARNESS_REPORT_REREAD_SCHEMA);
    expect(report.harnessResult?.reread.reportToolCallId).toBe("report-a");
    expect(report.harnessResult?.reread.startedAt).toBe(1000);
    expect(report.harnessResult?.reread.finishedAt).toBe(2000);
    expect(report.recordedAt).toBe(1000);
    expect(report.caveats.join(" ")).toContain("not task acceptance");
    expect(f.entry.inspectCall(f.port!.requests[0]!.reportRef, f.ctx).state).toBe("current");
    expect(f.entry.inspectCall({ ...f.port!.requests[0]!.reportRef }, f.ctx).reason).toBe("foreign-reference");
  });

  test("failed duplicate before tool_result reuses the cached ref; wrong input refuses before prepare/reread", async () => {
    const f = await fixture();
    let attempt = 0;
    f.port!.rereadHook = (request) => {
      attempt += 1;
      return attempt === 1
        ? Promise.resolve({ ok: false, code: "not-ready", reason: "first reread refused" } satisfies NativeHarnessReportRereadResult)
        : Promise.resolve(rereadSuccess(request));
    };
    await preparedWithSource(f);
    const params = reportArgs(selection());
    await prime(f, "report-a", params);
    expectError(await execute(f, "report-a", params), /first reread refused/);
    expect(f.port!.rereadCalls).toBe(1);

    const second = await execute(f, "report-a", params);
    reportDetails(second);
    expect(f.port!.prepareCalls).toBe(2);
    expect(f.port!.rereadCalls).toBe(2);
    expect(f.port!.requests[1]!.reportRef).toBe(f.port!.requests[0]!.reportRef);

    const beforePrepare = f.port!.prepareCalls;
    const beforeReread = f.port!.rereadCalls;
    await prime(f, "report-b", params);
    const changed = reportArgs(selection(), { summary: "different raw summary" });
    expectError(await execute(f, "report-b", changed), /bytes\/sha256/);
    expect(f.port!.prepareCalls).toBe(beforePrepare);
    expect(f.port!.rereadCalls).toBe(beforeReread);
  });

  test("unconfigured, malformed, mixed, nonempty outputFiles and missing generic ids refuse without fallback", async () => {
    const unconfigured = await fixture({ port: null });
    await preparedWithSource(unconfigured);
    await prime(unconfigured, "report-a", reportArgs(selection()));
    expectError(await execute(unconfigured, "report-a", reportArgs(selection())), /no Harness report composition/);

    const f = await fixture();
    await preparedWithSource(f);
    await prime(f, "report-a", reportArgs(selection()));
    expectError(await execute(f, "report-a", reportArgs(selection(), { extra: { harnessResult: null } })), /bounded|selection|plain/);
    expectError(await execute(f, "report-a", reportArgs(selection(), { extra: { instanceResult: {} } })), /report arguments|unsupported/);
    expectError(await execute(f, "report-a", reportArgs(selection(), { outputFiles: ["out.txt"] })), /outputFiles/);
    expect(f.port!.prepareCalls).toBe(0);
    expect(f.port!.rereadCalls).toBe(0);

    const missingSource = reportArgs(selection(), {
      checks: [{ toolCallId: "check-1", purpose: "checked" }],
    });
    await prime(f, "report-missing-source", missingSource);
    expectError(await execute(f, "report-missing-source", missingSource), /sourceToolCallId/);
    const missingCheck = reportArgs(selection(), {
      checks: [{ toolCallId: "source-1", purpose: "source" }],
    });
    await prime(f, "report-missing-check", missingCheck);
    expectError(await execute(f, "report-missing-check", missingCheck), /checkToolCallIds/);
    expect(f.port!.prepareCalls).toBe(0);
    expect(f.port!.rereadCalls).toBe(0);
  });

  test("evicted and rebound report routing refuses before prepare or reread", async () => {
    const evicted = await fixture({ maxReportBindings: 4 });
    await preparedWithSource(evicted);
    const params = reportArgs(selection());
    await prime(evicted, "report-old", params);
    for (let index = 0; index < 4; index++) {
      await prime(evicted, `report-new-${index}`, params);
    }
    expectError(await execute(evicted, "report-old", params), /no matching tool_call preflight/);
    expect(evicted.port!.prepareCalls).toBe(0);
    expect(evicted.port!.rereadCalls).toBe(0);

    const rebound = await fixture();
    await preparedWithSource(rebound);
    await prime(rebound, "report-rebound", params);
    await rebound.host.emit("tool_call", {
      toolCallId: "report-rebound",
      toolName: AGENT_WORK,
      input: reportArgs(selection(), { summary: "a conflicting preflight input" }),
    }, rebound.ctx);
    expectError(await execute(rebound, "report-rebound", params), /no matching tool_call preflight/);
    expect(rebound.port!.prepareCalls).toBe(0);
    expect(rebound.port!.rereadCalls).toBe(0);
  });

  test("a selector added by an ordinary action getter refuses instead of falling back", async () => {
    const f = await fixture();
    await prepareWork(f);
    const late = { outcome: "completed", summary: "ordinary-looking" } as Record<string, unknown>;
    let added = false;
    Object.defineProperty(late, "action", {
      enumerable: true,
      configurable: true,
      get() {
        if (!added) {
          added = true;
          Object.defineProperty(late, "harnessResult", {
            value: selection(),
            enumerable: false,
            configurable: true,
          });
        }
        return "report";
      },
    });
    const result = await execute(f, "report-late", late);
    expectError(result, /appeared after ordinary parsing|explicit harnessResult/);
    expect(added).toBe(true);
    expect((await inspectCurrent(f))?.report ?? null).toBeNull();
  });

  test("new actual call replays the same semantic report with zero reread, original timestamp and interval", async () => {
    const f = await fixture();
    await preparedWithSource(f);
    await observe(f, "check-2");
    const firstSelector = selection(["check-1", "check-2"]);
    const firstParams = reportArgs(firstSelector);
    const first = reportDetails(await f.host.call("report-a", firstParams, f.ctx, f.signal()));
    expect(f.port!.rereadCalls).toBe(1);

    const secondSelector = selection(["check-2", "check-1"]);
    const secondParams = reportArgs(secondSelector, { summary: "  same semantic summary  " });
    const second = reportDetails(await f.host.call("report-b", secondParams, f.ctx, f.signal()));

    expect(f.port!.prepareCalls).toBe(2);
    expect(f.port!.rereadCalls).toBe(1);
    expect(f.port!.requests[1]!.reportInputSha256).not.toBe(f.port!.requests[0]!.reportInputSha256);
    expect(second).toBe(first);
    expect(second.recordedAt).toBe(first.recordedAt);
    expect(second.harnessResult?.reread).toBe(first.harnessResult?.reread);
    expect(second.harnessResult?.reread.reportToolCallId).toBe("report-a");
  });

  test("changed historical facts or a different signature preserves the original report", async () => {
    const f = await fixture();
    await preparedWithSource(f);
    const original = reportDetails(await f.host.call("report-a", reportArgs(selection()), f.ctx, f.signal()));
    const rereads = f.port!.rereadCalls;

    f.port!.factsFactory = (request) => makeFacts(request, { fileDigest: OTHER_DIGEST });
    expectError(
      await f.host.call("report-b", reportArgs(selection()), f.ctx, f.signal()),
      /different Harness facts/,
    );
    expect(f.port!.rereadCalls).toBe(rereads);
    const still = await inspectCurrent(f);
    expect(still.report).toEqual(original);

    f.port!.factsFactory = makeFacts;
    const prepares = f.port!.prepareCalls;
    expectError(
      await f.host.call(
        "report-c",
        reportArgs(selection(), { outcome: "blocked", summary: "different semantic report" }),
        f.ctx,
        f.signal(),
      ),
      /different report/,
    );
    expect(f.port!.prepareCalls).toBe(prepares);
    expect((await inspectCurrent(f)).report).toEqual(original);
  });

  test("reread failure, pending/rejection, late abort, pending ingress and work change never publish", async () => {
    const failed = await fixture();
    failed.port!.rereadHook = () => Promise.resolve({
      ok: false,
      code: "not-ready",
      reason: "reread was not ready",
    } satisfies NativeHarnessReportRereadResult);
    await preparedWithSource(failed);
    await prime(failed, "report-a", reportArgs(selection()));
    expectError(await execute(failed, "report-a", reportArgs(selection())), /reread was not ready/);
    expect((await inspectCurrent(failed)).report).toBeNull();

    const pending = await fixture();
    let rejectPending!: (error: unknown) => void;
    const pendingPromise = new Promise<unknown>((_resolve, reject) => {
      rejectPending = reject;
    });
    pending.port!.rereadHook = () => pendingPromise;
    await preparedWithSource(pending);
    const pendingParams = reportArgs(selection());
    await prime(pending, "report-a", pendingParams);
    const running = execute(pending, "report-a", pendingParams);
    await waitFor(() => pending.port!.rereadCalls === 1);
    expect((await inspectCurrent(pending)).report).toBeNull();
    rejectPending(new Error("late reread rejection"));
    expectError(await running, /rejected/);
    expect((await inspectCurrent(pending)).report).toBeNull();

    const aborted = await fixture();
    const controller = new AbortController();
    aborted.port!.rereadHook = (request) => {
      controller.abort();
      return Promise.resolve(rereadSuccess(request));
    };
    await preparedWithSource(aborted);
    await prime(aborted, "report-a", reportArgs(selection()));
    expectError(await execute(aborted, "report-a", reportArgs(selection()), controller.signal), /cancelled/);
    expect((await inspectCurrent(aborted)).report).toBeNull();

    const ingress = await fixture();
    ingress.port!.rereadHook = (request) => {
      ingress.host.emitSync("input", { text: "late input", source: "rpc" }, ingress.ctx);
      return Promise.resolve(rereadSuccess(request));
    };
    await preparedWithSource(ingress);
    await prime(ingress, "report-a", reportArgs(selection()));
    expectError(await execute(ingress, "report-a", reportArgs(selection())), /pending|current|changed/);
    expect((await inspectCurrent(ingress)).report).toBeNull();

    const workChanged = await fixture();
    workChanged.port!.rereadHook = (request) => {
      workChanged.host.emitSync("session_switch", {}, workChanged.ctx);
      return Promise.resolve(rereadSuccess(request));
    };
    await preparedWithSource(workChanged);
    await prime(workChanged, "report-a", reportArgs(selection()));
    expectError(await execute(workChanged, "report-a", reportArgs(selection())), /work|current|preflight/);
    expect((await inspectCurrent(workChanged))?.report ?? null).toBeNull();
  });

  test("concurrent same-signature winner is returned unchanged; a different winner refuses", async () => {
    const same = await fixture();
    await preparedWithSource(same);
    const sameParams = reportArgs(selection());
    await prime(same, "report-a", sameParams);
    await prime(same, "report-b", sameParams);
    let releaseA!: (value: unknown) => void;
    same.port!.rereadHook = (request) => {
      if (request.reportRef.toolCallId === "report-a") {
        return new Promise((resolve) => {
          releaseA = resolve;
        });
      }
      return Promise.resolve(rereadSuccess(request));
    };
    const runningA = execute(same, "report-a", sameParams);
    await waitFor(() => same.port!.rereadCalls === 1);
    const winner = reportDetails(await execute(same, "report-b", sameParams));
    expect(winner.harnessResult?.reread.reportToolCallId).toBe("report-b");
    releaseA(rereadSuccess(same.port!.requests[0]!));
    const loser = reportDetails(await runningA);
    expect(loser).toBe(winner);
    expect(loser.harnessResult?.reread.reportToolCallId).toBe("report-b");
    expect((await inspectCurrent(same)).report).toEqual(winner);

    const different = await fixture();
    await preparedWithSource(different);
    const firstParams = reportArgs(selection());
    const winnerParams = reportArgs(selection(), { summary: "a different concurrent report" });
    await prime(different, "report-a", firstParams);
    await prime(different, "report-b", winnerParams);
    let releaseLoser!: (value: unknown) => void;
    different.port!.rereadHook = (request) => {
      if (request.reportRef.toolCallId === "report-a") {
        return new Promise((resolve) => {
          releaseLoser = resolve;
        });
      }
      return Promise.resolve(rereadSuccess(request));
    };
    const runningLoser = execute(different, "report-a", firstParams);
    await waitFor(() => different.port!.rereadCalls === 1);
    const differentWinner = reportDetails(await execute(different, "report-b", winnerParams));
    releaseLoser(rereadSuccess(different.port!.requests[0]!));
    expectError(await runningLoser, /different report/);
    expect((await inspectCurrent(different)).report).toEqual(differentWinner);
  });

  test("complete-wire overflow refuses before publication and preserves the original report", async () => {
    const f = await fixture();
    const actor = f.port!;
    const overflowSelection = selection(
      Array.from({ length: 8 }, (_, index) => `check-${index + 1}`),
    );
    actor.factsFactory = (request) => makeFacts(request, { extraFiles: 11 });
    await preparedWithSource(f);
    for (let index = 2; index <= 23; index++) {
      await f.host.observe(f.ctx, `check-${index}`, "read", "r".repeat(1000));
    }
    const longPurpose = "p".repeat(500);
    const checks = [
      { toolCallId: "source-1", purpose: longPurpose },
      ...Array.from({ length: 23 }, (_, index) => ({
        toolCallId: `check-${index + 1}`,
        purpose: longPurpose,
      })),
    ];
    const params = reportArgs(overflowSelection, {
      checks,
      summary: "s".repeat(2000),
      limitations: Array.from({ length: 8 }, () => "l".repeat(500)),
    });
    const facts = actor.factsFactory({
      reportRef: {} as NativeWorkCallReference,
      reportInputSha256: DIGEST,
      work: {
        observationId: "native-work-1",
        generation: 1,
        sessionId: "session-native",
        workspaceRoot: f.workspace,
      } as NativeReportWorkIdentity,
      selection: overflowSelection,
      outcome: "completed",
    });
    expect(Buffer.byteLength(JSON.stringify(facts), "utf8")).toBeLessThanOrEqual(NATIVE_HARNESS_REPORT_MAX_FACTS_BYTES);
    await prime(f, "report-overflow", params);
    expectError(await execute(f, "report-overflow", params), /256|too large|exceeds/);
    expect((await inspectCurrent(f)).report).toBeNull();

    actor.factsFactory = makeFacts;
    const normal = reportDetails(await f.host.call("report-normal", reportArgs(selection()), f.ctx, f.signal()));
    expect(normal.harnessResult?.reread.reportToolCallId).toBe("report-normal");
  });
});
