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
  type NativeWorkReport,
} from "../../src/native-entry.ts";
import {
  boundNativeInstanceReportCatalog,
  snapshotNativeInstanceReportFacts,
  type NativeInstanceReportCatalog,
  type NativeInstanceReportFacts,
  type NativeInstanceReportPort,
  type NativeInstanceReportPreparation,
  type NativeInstanceReportSelection,
  type NativeReportWorkIdentity,
} from "../../src/native-instance-report.ts";
import {
  nodeFileIo,
  type NativeFileHandle,
  type NativeFileIo,
} from "../../src/native-work.ts";
import { clearPublishedTaskOwner } from "../../src/task-entry-port.ts";

const AGENT_WORK = "agent_work";
const DIGEST = createHash("sha256").update("observed-envelope").digest("hex");

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

  async call(
    toolCallId: string,
    params: unknown,
    context: NativeContext,
    signal: AbortSignal | undefined,
  ): Promise<NativeToolResult> {
    await this.emit("tool_call", { toolCallId, toolName: AGENT_WORK, input: params }, context);
    const tool = this.tools.get(AGENT_WORK);
    if (tool === undefined) throw new Error("agent_work was not registered");
    const result = await tool.execute(toolCallId, params, signal, undefined, context);
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

function makeFacts(
  selection: NativeInstanceReportSelection,
  work: NativeReportWorkIdentity,
): NativeInstanceReportFacts {
  return {
    result: {
      instanceId: selection.instanceId,
      parentToolCallId: selection.parentToolCallId,
      index: 0,
      childId: "child-1",
      childSessionId: "child-session-1",
      agentName: "reviewer",
      parentSessionId: work.sessionId,
      workspaceRoot: work.workspaceRoot,
      rootEpoch: 1,
      definitionVersion: "1.0.0",
    },
    work: {
      observationId: work.observationId,
      generation: work.generation,
      sessionId: work.sessionId,
      workspaceRoot: work.workspaceRoot,
      toolCallId: selection.parentToolCallId,
      toolName: "task",
    },
    envelope: { sha256: selection.envelopeSha256, bytes: 256, scope: "tool-result-middleware" },
    artifactBasis: "observed-during-report",
    semanticAcceptance: "not-evaluated",
  };
}

type AnyHook = (...args: any[]) => unknown;

class FakePort implements NativeInstanceReportPort {
  prepareCalls = 0;
  inspectCalls = 0;
  refreshCalls = 0;
  revalidateCalls = 0;
  conflict = false;
  prepareHook: AnyHook | null = null;
  refreshHook: AnyHook | null = null;
  revalidateHook: AnyHook | null = null;
  inspectHook: AnyHook | null = null;
  factsHook: ((facts: NativeInstanceReportFacts) => unknown) | null = null;
  lastSelection: NativeInstanceReportSelection | null = null;
  lastWork: NativeReportWorkIdentity | null = null;
  lastInspectWork: NativeReportWorkIdentity | null = null;
  lastPreparation: NativeInstanceReportPreparation | null = null;

  prepare(
    selection: NativeInstanceReportSelection,
    work: NativeReportWorkIdentity,
    context: NativeContext,
  ): any {
    this.prepareCalls += 1;
    this.lastSelection = selection;
    this.lastWork = work;
    if (this.prepareHook !== null) return this.prepareHook(selection, work, context);
    if (this.conflict) return { ok: false, reason: "a later instance result conflict was observed" };
    const facts = makeFacts(selection, work);
    const prepared: NativeInstanceReportPreparation = {
      facts: (this.factsHook === null ? facts : this.factsHook(facts)) as NativeInstanceReportFacts,
      refresh: () => {
        this.refreshCalls += 1;
        return this.refreshHook === null ? { ok: true } : this.refreshHook(context) as any;
      },
      revalidate: () => {
        this.revalidateCalls += 1;
        return this.revalidateHook === null ? null : this.revalidateHook() as any;
      },
    };
    this.lastPreparation = prepared;
    return { ok: true, prepared };
  }

  inspect(context: NativeContext, work: NativeReportWorkIdentity | null): any {
    this.inspectCalls += 1;
    this.lastInspectWork = work;
    if (this.inspectHook !== null) return this.inspectHook(context, work);
    return {
      state: "available",
      reason: null,
      items: [{
        instanceId: "instance-1",
        parentToolCallId: "task-1",
        envelopeSha256: DIGEST,
        available: true,
        reason: null,
      }],
      total: 1,
      omitted: 0,
      complete: true,
    };
  }
}

interface Fixture {
  root: string;
  workspace: string;
  host: Host;
  port: FakePort;
  entry: NativeEntryControls;
  ctx: NativeContext;
  setSessionId(value: string): void;
  setLiveCwd(value: string): void;
  setNow(value: () => number): void;
  setCwdGetterHook(value: (() => void) | null): void;
  signal(): AbortSignal;
}

interface FixtureOptions {
  port?: FakePort | null;
  fileIo?: NativeFileIo;
  now?: () => number;
  maxPendingInputs?: number;
}

const roots: string[] = [];
const entries: NativeEntryControls[] = [];

afterEach(async () => {
  clearPublishedTaskOwner();
  for (const entry of entries.splice(0)) entry.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-instance-report-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const host = new Host();
  const port = options.port === null ? null : options.port ?? new FakePort();
  let sessionId = "session-native";
  let liveCwd = workspace;
  let now = options.now ?? (() => 1000);
  let cwdGetterHook: (() => void) | null = null;
  const ctx: NativeContext = {
    cwd: workspace,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      getCwd() {
        cwdGetterHook?.();
        return liveCwd;
      },
    },
  };
  const entry = createNativeEntry(host.pi, {
    now: () => now(),
    ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
    ...(options.maxPendingInputs === undefined ? {} : { maxPendingInputs: options.maxPendingInputs }),
    ...(port === null ? {} : { instanceReports: port }),
  });
  entries.push(entry);
  return {
    root,
    workspace,
    host,
    port: port ?? new FakePort(),
    entry,
    ctx,
    setSessionId(value) {
      sessionId = value;
    },
    setLiveCwd(value) {
      liveCwd = value;
    },
    setNow(value) {
      now = value;
    },
    setCwdGetterHook(value) {
      cwdGetterHook = value;
    },
    signal() {
      return new AbortController().signal;
    },
  };
}

function reportArgs(
  checks: Array<{ toolCallId: string; purpose: string }>,
  outputFiles: string[] = [],
  selection?: Record<string, unknown>,
  summary = "selected result report",
): Record<string, unknown> {
  return {
    action: "report",
    checks,
    outputFiles,
    outcome: "completed",
    summary,
    limitations: ["semantic acceptance was not evaluated"],
    ...(selection === undefined ? {} : { instanceResult: selection }),
  };
}

function selector(
  parentToolCallId = "task-1",
  instanceId = "instance-1",
  digest = DIGEST,
): Record<string, unknown> {
  return { instanceId, parentToolCallId, envelopeSha256: digest };
}

async function prepareRequest(f: Fixture, text = "selected report request"): Promise<void> {
  await f.host.emit("input", { text, source: "rpc" }, f.ctx);
  await f.host.emit("before_agent_start", {
    reason: "prompt",
    prompt: text,
    systemPrompt: ["base"],
  }, f.ctx);
}

async function observeTask(f: Fixture, taskCallId = "task-1"): Promise<void> {
  await f.host.observe(f.ctx, taskCallId, "task", "child completed envelope");
}

function expectError(result: NativeToolResult, pattern?: RegExp): void {
  expect(result.isError).toBe(true);
  if (pattern !== undefined) expect(result.content[0]?.text ?? "").toMatch(pattern);
}

function reportDetails(result: NativeToolResult): NativeWorkReport {
  expect(result.isError).not.toBe(true);
  return result.details as NativeWorkReport;
}

async function inspect(f: Fixture): Promise<any> {
  const result = await f.host.call("inspect-selected", { action: "inspect" }, f.ctx, f.signal());
  expect(result.isError).not.toBe(true);
  return result.details;
}

async function successfulReport(
  f: Fixture,
  toolCallId = "report-selected",
  params = reportArgs([{ toolCallId: "task-1", purpose: "delegated work" }], [], selector()),
): Promise<NativeWorkReport> {
  return reportDetails(await f.host.call(toolCallId, params, f.ctx, f.signal()));
}

async function taskWork(f: Fixture): Promise<void> {
  await prepareRequest(f);
  await observeTask(f);
}

function gateIo(expectedReads: number): {
  io: NativeFileIo;
  waitForReads: Promise<void>;
  release(): void;
} {
  let entered = 0;
  let resolveEntered!: () => void;
  const waitForReads = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const io: NativeFileIo = {
    ...nodeFileIo,
    async open(target, flags) {
      const handle = await nodeFileIo.open(target, flags);
      return {
        stat: (options) => handle.stat(options),
        async read(
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ) {
          entered += 1;
          if (entered >= expectedReads) resolveEntered();
          await gate;
          return handle.read(buffer, offset, length, position);
        },
        close: () => handle.close(),
      } satisfies NativeFileHandle;
    },
  };
  return { io, waitForReads, release };
}

describe("C2 fixed instance report preparation", () => {
  test("publishes exact frozen result facts and associates selected output files", async () => {
    const f = await fixture();
    await taskWork(f);
    await writeFile(path.join(f.workspace, "out.txt"), "selected bytes\n", "utf8");
    const report = await successfulReport(f, "report-selected", reportArgs(
      [{ toolCallId: "task-1", purpose: "delegated work" }],
      ["out.txt"],
      selector(),
    ));

    expect(report.instanceResult).toEqual(makeFacts(
      selector() as unknown as NativeInstanceReportSelection,
      {
        observationId: report.work.observationId,
        generation: report.work.generation,
        sessionId: report.work.sessionId,
        workspaceRoot: report.work.workspaceRoot,
      },
    ));
    expect(report.instanceResult?.artifactBasis).toBe("observed-during-report");
    expect(report.instanceResult?.semanticAcceptance).toBe("not-evaluated");
    expect(report.instanceResult?.envelope.sha256).toBe(DIGEST);
    expect(report.observed.outputFiles[0]?.relativePath).toBe("out.txt");
    expect(report.observed.outputFiles[0]?.bytes).toBe(15);
    const snapshot = snapshotNativeInstanceReportFacts(
      report.instanceResult,
      selector() as unknown as NativeInstanceReportSelection,
      {
        observationId: report.work.observationId,
        generation: report.work.generation,
        sessionId: report.work.sessionId,
        workspaceRoot: report.work.workspaceRoot,
      },
    );
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(Object.isFrozen(snapshot.facts)).toBe(true);
      expect(Object.isFrozen(snapshot.facts.result)).toBe(true);
      expect(Object.isFrozen(snapshot.facts.work)).toBe(true);
      expect(Object.isFrozen(snapshot.facts.envelope)).toBe(true);
    }
    expect(f.port.prepareCalls).toBe(1);
    expect(f.port.refreshCalls).toBe(2);
    expect(f.port.revalidateCalls).toBe(2);

    const replayResult = await f.host.call(
      "report-selected-replay",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated work" }], ["out.txt"], selector()),
      f.ctx,
      f.signal(),
    );
    const replay = reportDetails(replayResult);
    expect(replay.recordedAt).toBe(report.recordedAt);
    expect(replay.instanceResult).toEqual(report.instanceResult);
    expect(replayResult.content[0]?.text ?? "").toContain("files were not reread");

    f.port.conflict = true;
    expectError(await f.host.call(
      "report-selected-later-conflict",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated work" }], [], selector()),
      f.ctx,
      f.signal(),
    ), /later instance result conflict/);
    expect((await inspect(f)).current.report.recordedAt).toBe(report.recordedAt);
  });

  test("ordinary reports remain selector-free and byte-identical in shape", async () => {
    const f = await fixture();
    await taskWork(f);
    const ordinary = reportDetails(await f.host.call(
      "report-ordinary",
      {
        action: "report",
        checks: [{ toolCallId: "task-1", purpose: "ordinary check" }],
        outputFiles: [],
        outcome: "completed",
        summary: "ordinary",
        limitations: [],
      },
      f.ctx,
      undefined,
    ));
    expect(Object.hasOwn(ordinary, "instanceResult")).toBe(false);
    expect(f.port.prepareCalls).toBe(0);
  });

  test("refuses missing composition, malformed selection and missing task check before file I/O", async () => {
    const noPort = await fixture({ port: null });
    await taskWork(noPort);
    expectError(await noPort.host.call(
      "report-no-port",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      noPort.ctx,
      noPort.signal(),
    ), /no instance result composition/);
    const noPortInspect = await inspect(noPort);
    expect(noPortInspect.current.report).toBeNull();
    expect(noPortInspect.instanceResults.state).toBe("unavailable");
    expect(noPortInspect.instanceResults.total).toBeNull();
    expect(noPortInspect.instanceResults.omitted).toBeNull();

    const f = await fixture();
    await taskWork(f);
    for (const [index, bad] of [
      { ...selector(), extra: "no" },
      { ...selector(), envelopeSha256: DIGEST.toUpperCase() },
      { ...selector(), instanceId: "" },
      { ...selector(), parentToolCallId: "x".repeat(257) },
    ].entries()) {
      expectError(await f.host.call(
        `report-bad-selector-${index}`,
        reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], bad),
        f.ctx,
        f.signal(),
      ), /instanceResult/);
    }
    expectError(await f.host.call(
      "report-missing-task-check",
      reportArgs([], [], selector()),
      f.ctx,
      f.signal(),
    ), /must be selected in checks/);
    await f.host.observe(f.ctx, "bash-1", "bash", "bash completed");
    expectError(await f.host.call(
      "report-nontask-check",
      reportArgs([{ toolCallId: "bash-1", purpose: "not a task" }], [], selector("bash-1")),
      f.ctx,
      f.signal(),
    ), /actual observed task call/);
    expect(f.port.prepareCalls).toBe(0);
    expect((await inspect(f)).current.report).toBeNull();
  });

  test("requires the actual native abort signal and ignores an own aborted getter", async () => {
    const f = await fixture();
    await taskWork(f);
    const params = reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector());
    expectError(await f.host.call("report-missing-signal", params, f.ctx, undefined), /AbortSignal is missing/);
    expectError(await f.host.call("report-duck-signal", params, f.ctx, { aborted: false } as any), /not a readable actual host AbortSignal/);
    const aborted = new AbortController();
    aborted.abort();
    expectError(await f.host.call("report-aborted-signal", params, f.ctx, aborted.signal), /cancelled/);

    const maskingFalse = new AbortController();
    let ownFalseReads = 0;
    Object.defineProperty(maskingFalse.signal, "aborted", {
      configurable: true,
      get() {
        ownFalseReads += 1;
        return true;
      },
    });
    const first = reportDetails(await f.host.call(
      "report-own-getter-false",
      params,
      f.ctx,
      maskingFalse.signal,
    ));
    expect(ownFalseReads).toBe(0);
    expect(first.instanceResult?.semanticAcceptance).toBe("not-evaluated");

    // A fresh work is needed because the first success made this work reported.
    const f2 = await fixture();
    await taskWork(f2);
    const maskingTrue = new AbortController();
    maskingTrue.abort();
    let ownTrueReads = 0;
    Object.defineProperty(maskingTrue.signal, "aborted", {
      configurable: true,
      get() {
        ownTrueReads += 1;
        return false;
      },
    });
    expectError(await f2.host.call("report-own-getter-true", params, f2.ctx, maskingTrue.signal), /cancelled/);
    expect(ownTrueReads).toBe(0);
  });

  test("rejects wrong or aliased facts and unusable preparations", async () => {
    const cases: Array<[(facts: NativeInstanceReportFacts) => unknown, RegExp]> = [
      [(facts) => ({ ...facts, result: { ...facts.result, instanceId: "other" } }), /does not match|selector/],
      [(facts) => ({ ...facts, result: { ...facts.result, childId: null } }), /child id/],
      [(facts) => ({ ...facts, result: { ...facts.result, index: 1 } }), /index 0|child id/],
      [(facts) => ({ ...facts, envelope: { ...facts.envelope, sha256: DIGEST.replace(/^./, "0") } }), /does not match|selector/],
      [(facts) => ({ ...facts, work: { ...facts.work, toolName: "bash" } }), /work reference/],
      [(facts) => ({ ...facts, semanticAcceptance: "accepted" }), /semantic acceptance/],
    ];
    for (const [index, [mutate, pattern]] of cases.entries()) {
      const f = await fixture();
      await taskWork(f);
      f.port.factsHook = mutate;
      expectError(await f.host.call(
        `report-bad-facts-${index}`,
        reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
        f.ctx,
        f.signal(),
      ), pattern);
      expect((await inspect(f)).current.report).toBeNull();
    }

    const alias = await fixture();
    await taskWork(alias);
    let aliasFacts: NativeInstanceReportFacts | null = null;
    alias.port.factsHook = (facts) => {
      aliasFacts = facts;
      return facts;
    };
    const promise = alias.host.call(
      "report-facts-alias",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      alias.ctx,
      alias.signal(),
    );
    await Promise.resolve();
    if (aliasFacts !== null) {
      const mutable = aliasFacts as unknown as { result: { childId: string } };
      mutable.result.childId = "mutated-after-copy";
    }
    const published = reportDetails(await promise);
    expect(published.instanceResult?.result.childId).toBe("child-1");
  });

  test("port cannot mutate the copied report work identity to match altered facts", async () => {
    const f = await fixture();
    await taskWork(f);
    f.port.prepareHook = (selection: NativeInstanceReportSelection, work: NativeReportWorkIdentity) => {
      try {
        (work as { sessionId: string }).sessionId = "attacker-session";
      } catch {
        // Frozen primitive copy refuses the mutation.
      }
      const altered = {
        ...makeFacts(selection, work),
        result: {
          ...makeFacts(selection, work).result,
          parentSessionId: "attacker-session",
        },
      };
      return {
        ok: true,
        prepared: {
          facts: altered,
          refresh: () => ({ ok: true }),
          revalidate: () => null,
        },
      };
    };
    expectError(await f.host.call(
      "report-identity-mutation",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      f.ctx,
      f.signal(),
    ), /does not match/);
    expect((await inspect(f)).current.report).toBeNull();
  });

  test("port throws, promises and malformed checks fail bounded without publication", async () => {
    const scenarios: Array<[string, (port: FakePort) => void, RegExp]> = [
      ["prepare-throw", (port) => {
        port.prepareHook = () => {
          throw new Error("prepare exploded");
        };
      }, /prepare exploded/],
      ["prepare-promise-reject", (port) => {
        port.prepareHook = () => Promise.reject(new Error("prepare rejected"));
      }, /promise|synchronous/],
      ["refresh-throw", (port) => {
        port.refreshHook = () => {
          throw new Error("refresh exploded");
        };
      }, /refresh exploded/],
      ["refresh-promise", (port) => {
        port.refreshHook = () => Promise.resolve({ ok: true });
      }, /refresh returned a promise/],
      ["revalidate-throw", (port) => {
        port.revalidateHook = () => {
          throw new Error("revalidate exploded");
        };
      }, /revalidate exploded/],
      ["revalidate-promise-reject", (port) => {
        port.revalidateHook = () => Promise.reject(new Error("revalidate rejected"));
      }, /promise|synchronous/],
      ["malformed-check", (port) => {
        port.revalidateHook = () => ({ ok: "yes" });
      }, /non-primitive/],
      ["string-refusal", (port) => {
        port.revalidateHook = () => "later result conflict";
      }, /later result conflict/],
    ];
    for (const [index, [name, apply, pattern]] of scenarios.entries()) {
      const f = await fixture();
      await taskWork(f);
      apply(f.port);
      expectError(await f.host.call(
        `report-${name}-${index}`,
        reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
        f.ctx,
        f.signal(),
      ), pattern);
      expect((await inspect(f)).current.report).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  test("rejects thenable and accessor responses without executing them", async () => {
    type StrictRuns = {
      getterRuns(): number;
      thenRuns(): number;
    };
    const cases: Array<[string, (port: FakePort) => StrictRuns, RegExp]> = [
      ["prepare-thenable-body", (port) => {
        let thenRuns = 0;
        port.prepareHook = () => ({
          ok: true,
          then() {
            thenRuns += 1;
          },
        });
        return { getterRuns: () => 0, thenRuns: () => thenRuns };
      }, /thenable/],
      ["prepare-then-getter", (port) => {
        let getterRuns = 0;
        let thenRuns = 0;
        const response: Record<string, unknown> = { ok: true };
        Object.defineProperty(response, "then", {
          configurable: true,
          get() {
            getterRuns += 1;
            return () => {
              thenRuns += 1;
            };
          },
        });
        port.prepareHook = () => response;
        return { getterRuns: () => getterRuns, thenRuns: () => thenRuns };
      }, /thenable/],
      ["prepare-accessor", (port) => {
        let getterRuns = 0;
        const response: Record<string, unknown> = {
          ok: true,
          prepared: { facts: {}, refresh: () => ({ ok: true }), revalidate: () => null },
        };
        Object.defineProperty(response, "reason", {
          configurable: true,
          get() {
            getterRuns += 1;
            return "late reason";
          },
        });
        port.prepareHook = () => response;
        return { getterRuns: () => getterRuns, thenRuns: () => 0 };
      }, /accessor/],
      ["prepared-accessor", (port) => {
        let getterRuns = 0;
        const prepared: Record<string, unknown> = { facts: {}, revalidate: () => null };
        Object.defineProperty(prepared, "refresh", {
          configurable: true,
          get() {
            getterRuns += 1;
            return () => ({ ok: true });
          },
        });
        port.prepareHook = () => ({ ok: true, prepared });
        return { getterRuns: () => getterRuns, thenRuns: () => 0 };
      }, /accessor/],
      ["prepared-promise-reject", (port) => {
        port.prepareHook = () => ({ ok: true, prepared: Promise.reject(new Error("prepared rejected")) });
        return { getterRuns: () => 0, thenRuns: () => 0 };
      }, /promise|synchronous/],
      ["prepare-revoked-proxy", (port) => {
        const revocable = Proxy.revocable({}, {});
        revocable.revoke();
        port.prepareHook = () => revocable.proxy;
        return { getterRuns: () => 0, thenRuns: () => 0 };
      }, /unreadable/],
      ["prepare-self-prototype", (port) => {
        const proxy: object = new Proxy({}, {
          getPrototypeOf() {
            return proxy;
          },
        });
        port.prepareHook = () => proxy;
        return { getterRuns: () => 0, thenRuns: () => 0 };
      }, /unreadable/],
      ["refresh-thenable-body", (port) => {
        let thenRuns = 0;
        let calls = 0;
        port.refreshHook = () => {
          calls += 1;
          if (calls === 1) return { ok: true };
          return {
            ok: true,
            then() {
              thenRuns += 1;
            },
          };
        };
        return { getterRuns: () => 0, thenRuns: () => thenRuns };
      }, /thenable/],
      ["refresh-then-getter", (port) => {
        let getterRuns = 0;
        let thenRuns = 0;
        let calls = 0;
        const response: Record<string, unknown> = { ok: true };
        Object.defineProperty(response, "then", {
          configurable: true,
          get() {
            getterRuns += 1;
            return () => {
              thenRuns += 1;
            };
          },
        });
        port.refreshHook = () => {
          calls += 1;
          return calls === 1 ? { ok: true } : response;
        };
        return { getterRuns: () => getterRuns, thenRuns: () => thenRuns };
      }, /thenable/],
      ["refresh-accessor", (port) => {
        let getterRuns = 0;
        let calls = 0;
        const response: Record<string, unknown> = {};
        Object.defineProperty(response, "ok", {
          configurable: true,
          get() {
            getterRuns += 1;
            return true;
          },
        });
        port.refreshHook = () => {
          calls += 1;
          return calls === 1 ? { ok: true } : response;
        };
        return { getterRuns: () => getterRuns, thenRuns: () => 0 };
      }, /accessor/],
      ["refresh-promise-reject", (port) => {
        let calls = 0;
        port.refreshHook = () => {
          calls += 1;
          return calls === 1 ? { ok: true } : Promise.reject(new Error("refresh rejected late"));
        };
        return { getterRuns: () => 0, thenRuns: () => 0 };
      }, /promise|synchronous/],
      ["revalidate-thenable", (port) => {
        let thenRuns = 0;
        let calls = 0;
        port.revalidateHook = () => {
          calls += 1;
          if (calls === 1) return null;
          return {
            then() {
              thenRuns += 1;
            },
          };
        };
        return { getterRuns: () => 0, thenRuns: () => thenRuns };
      }, /non-primitive/],
      ["revalidate-accessor", (port) => {
        let getterRuns = 0;
        let calls = 0;
        const response: Record<string, unknown> = {};
        Object.defineProperty(response, "ok", {
          configurable: true,
          get() {
            getterRuns += 1;
            return true;
          },
        });
        port.revalidateHook = () => {
          calls += 1;
          return calls === 1 ? null : response;
        };
        return { getterRuns: () => getterRuns, thenRuns: () => 0 };
      }, /non-primitive/],
      ["revalidate-promise-reject", (port) => {
        let calls = 0;
        port.revalidateHook = () => {
          calls += 1;
          return calls === 1 ? null : Promise.reject(new Error("revalidate rejected late"));
        };
        return { getterRuns: () => 0, thenRuns: () => 0 };
      }, /promise|synchronous/],
    ];
    for (const [index, [name, apply, pattern]] of cases.entries()) {
      const f = await fixture();
      await taskWork(f);
      const runs = apply(f.port);
      expectError(await f.host.call(
        `report-strict-${name}-${index}`,
        reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
        f.ctx,
        f.signal(),
      ), pattern);
      expect(runs.getterRuns()).toBe(0);
      expect(runs.thenRuns()).toBe(0);
      expect((await inspect(f)).current.report).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  test("port errors with throwing message/toString stay bounded", async () => {
    const f = await fixture();
    await taskWork(f);
    f.port.prepareHook = () => {
      throw {
        get message() {
          throw new Error("message getter exploded");
        },
        toString() {
          throw new Error("toString exploded");
        },
      };
    };
    expectError(await f.host.call(
      "report-throwing-error",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      f.ctx,
      f.signal(),
    ), /unreadable failure|threw/);
    expect((await inspect(f)).current.report).toBeNull();
  });
});

describe("C2 selected fresh-work gates and final ordering", () => {
  test("pending ingress, identical re-entry, unknown source and dropped ingress refuse selected reports", async () => {
    const pending = await fixture();
    await taskWork(pending);
    await pending.host.emit("input", { text: "queued new input", source: "rpc" }, pending.ctx);
    expectError(await pending.host.call(
      "report-pending",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      pending.ctx,
      pending.signal(),
    ), /pending/);
    expect((await inspect(pending)).current.report).toBeNull();

    const identical = await fixture();
    await prepareRequest(identical, "same text");
    await observeTask(identical);
    await identical.host.emit("input", { text: "same text", source: "rpc" }, identical.ctx);
    expectError(await identical.host.call(
      "report-identical-reentry",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      identical.ctx,
      identical.signal(),
    ), /pending/);

    const unknown = await fixture();
    await unknown.host.emit("input", { text: "unknown source", source: "synthetic" }, unknown.ctx);
    await unknown.host.emit("before_agent_start", {
      reason: "prompt",
      prompt: "unknown source",
      systemPrompt: [],
    }, unknown.ctx);
    await observeTask(unknown);
    expectError(await unknown.host.call(
      "report-unknown-source",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      unknown.ctx,
      unknown.signal(),
    ), /genuine|evidence/);

    const dropped = await fixture({ maxPendingInputs: 1 });
    await taskWork(dropped);
    await dropped.host.emit("input", { text: "one", source: "rpc" }, dropped.ctx);
    await dropped.host.emit("input", { text: "two", source: "rpc" }, dropped.ctx);
    expectError(await dropped.host.call(
      "report-dropped",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      dropped.ctx,
      dropped.signal(),
    ), /dropped/);
  });

  test("abort or work change during a read prevents publication", async () => {
    for (const mode of ["abort", "work"] as const) {
      const gate = gateIo(1);
      const f = await fixture({ fileIo: gate.io });
      await taskWork(f);
      await writeFile(path.join(f.workspace, "out.txt"), "bytes during report\n", "utf8");
      const controller = new AbortController();
      const running = f.host.call(
        `report-${mode}-during-read`,
        reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], ["out.txt"], selector()),
        f.ctx,
        controller.signal,
      );
      await gate.waitForReads;
      if (mode === "abort") controller.abort();
      else f.setSessionId("changed-during-read");
      gate.release();
      expectError(await running, mode === "abort" ? /cancelled/ : /session or workspace changed/);
      expect((await inspect(f)).current?.report ?? null).toBeNull();
    }
  });

  test("final clock mutation and reentrant getter failure are caught before publication", async () => {
    const clock = await fixture();
    await taskWork(clock);
    clock.setNow(() => {
      clock.setSessionId("changed-by-final-clock");
      return 5000;
    });
    expectError(await clock.host.call(
      "report-clock-mutation",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      clock.ctx,
      clock.signal(),
    ), /session or workspace changed|current live work/);
    clock.setNow(() => 6000);
    expect((await inspect(clock)).current?.report ?? null).toBeNull();

    const reentrant = await fixture();
    await taskWork(reentrant);
    let getterCount = 0;
    let conflictSeen = false;
    reentrant.port.revalidateHook = () => conflictSeen
      ? "revalidate saw the final host read mutation"
      : null;
    reentrant.setCwdGetterHook(() => {
      getterCount += 1;
      // One getter read belongs to the report tool_call preflight, one to the
      // pre-I/O live snapshot, and the third to the final live snapshot.
      if (getterCount >= 3) conflictSeen = true;
    });
    expectError(await reentrant.host.call(
      "report-reentrant-revalidate",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      reentrant.ctx,
      reentrant.signal(),
    ), /final host read mutation/);
    expect((await inspect(reentrant)).current?.report ?? null).toBeNull();

    const ended = await fixture();
    await taskWork(ended);
    let refreshCount = 0;
    ended.port.refreshHook = (context: NativeContext) => {
      refreshCount += 1;
      if (refreshCount === 2) {
        ended.host.emitSync("agent_end", { messages: [], willContinue: false }, context);
      }
      return { ok: true };
    };
    expectError(await ended.host.call(
      "report-work-ended-during-refresh",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      ended.ctx,
      ended.signal(),
    ), /no longer selectable|no longer current|no longer the current live work/);
    expect((await inspect(ended)).current?.report ?? null).toBeNull();
  });

  test("final refresh shape refuses before the final clock read", async () => {
    const f = await fixture();
    await taskWork(f);
    let clockReads = 0;
    f.setNow(() => {
      clockReads += 1;
      return 9000;
    });
    let refreshCount = 0;
    let clockReadsAtFinalRefresh = -1;
    f.port.refreshHook = () => {
      refreshCount += 1;
      if (refreshCount === 1) return { ok: true };
      clockReadsAtFinalRefresh = clockReads;
      const response: Record<string, unknown> = {};
      Object.defineProperty(response, "ok", {
        configurable: true,
        get() {
          throw new Error("final refresh accessor executed");
        },
      });
      return response;
    };
    expectError(await f.host.call(
      "report-final-refresh-shape",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], [], selector()),
      f.ctx,
      f.signal(),
    ), /accessor/);
    // One clock read is the report tool_call preflight. A recordedAt read
    // before the final refresh shape check would make this two.
    expect(clockReadsAtFinalRefresh).toBe(1);
    expect((await inspect(f)).current.report).toBeNull();
  });

  test("historical replay refuses when a non-parent check changes after early selection", async () => {
    const f = await fixture();
    await taskWork(f);
    await f.host.observe(f.ctx, "read-1", "read", "secondary check");
    const params = reportArgs([
      { toolCallId: "task-1", purpose: "delegated work" },
      { toolCallId: "read-1", purpose: "secondary check" },
    ], [], selector());
    const original = reportDetails(await f.host.call("report-secondary-original", params, f.ctx, f.signal()));
    let mutated = false;
    f.port.refreshHook = (context: NativeContext) => {
      if (!mutated) {
        mutated = true;
        f.host.emitSync("tool_call", {
          toolCallId: "read-1",
          toolName: "bash",
          input: {},
        }, context);
      }
      return { ok: true };
    };
    expectError(await f.host.call("report-secondary-replay", params, f.ctx, f.signal()), /selected call evidence changed|conflicting|ambiguous/);
    expect((await inspect(f)).current.report.recordedAt).toBe(original.recordedAt);
  });

  test("concurrent identical reports replay the first immutable first receipt and conflicts refuse", async () => {
    const gate = gateIo(2);
    const f = await fixture({ fileIo: gate.io });
    await taskWork(f);
    await writeFile(path.join(f.workspace, "out.txt"), "shared bytes\n", "utf8");
    const firstParams = reportArgs(
      [{ toolCallId: "task-1", purpose: "delegated" }],
      ["out.txt"],
      selector(),
      "same report",
    );
    const first = f.host.call("report-concurrent-a", firstParams, f.ctx, f.signal());
    const second = f.host.call("report-concurrent-b", firstParams, f.ctx, f.signal());
    await gate.waitForReads;
    gate.release();
    const aResult = await first;
    const bResult = await second;
    const a = reportDetails(aResult);
    const b = reportDetails(bResult);
    expect(b.recordedAt).toBe(a.recordedAt);
    expect(b.observed).toEqual(a.observed);
    const concurrentTexts = [aResult, bResult].map((result) => result.content[0]?.text ?? "");
    expect(concurrentTexts.filter((text) => text.includes(
      "this invocation's file reads were not published",
    ))).toHaveLength(1);

    const gate2 = gateIo(2);
    const conflict = await fixture({ fileIo: gate2.io });
    await taskWork(conflict);
    await writeFile(path.join(conflict.workspace, "out.txt"), "conflict bytes\n", "utf8");
    const conflictA = conflict.host.call(
      "report-conflict-a",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], ["out.txt"], selector(), "A"),
      conflict.ctx,
      conflict.signal(),
    );
    const conflictB = conflict.host.call(
      "report-conflict-b",
      reportArgs([{ toolCallId: "task-1", purpose: "delegated" }], ["out.txt"], selector(), "B"),
      conflict.ctx,
      conflict.signal(),
    );
    await gate2.waitForReads;
    gate2.release();
    const conflictResults = [await conflictA, await conflictB];
    const publishedResults = conflictResults.filter((result) => result.isError !== true);
    const refusedResults = conflictResults.filter((result) => result.isError === true);
    expect(publishedResults).toHaveLength(1);
    expect(refusedResults).toHaveLength(1);
    const published = reportDetails(publishedResults[0]!);
    expectError(refusedResults[0]!, /cannot be rewritten/);
    const unchanged = await inspect(conflict);
    expect(unchanged.current.report.recordedAt).toBe(published.recordedAt);
    expect(unchanged.current.report.modelDeclared.summary).toBe(published.modelDeclared.summary);
  });
});

describe("C2 inspect catalog boundary", () => {
  test("inspect exposes bounded selectors and unavailable rows without fake identities", async () => {
    const f = await fixture();
    await taskWork(f);
    f.port.inspectHook = () => ({
      state: "available",
      reason: null,
      items: [
        {
          instanceId: "instance-ready",
          parentToolCallId: "task-1",
          envelopeSha256: DIGEST,
          available: true,
          reason: null,
        },
        {
          instanceId: "instance-pending",
          parentToolCallId: "task-2",
          envelopeSha256: null,
          available: false,
          reason: "no complete C1 envelope was observed",
        },
      ],
      total: 2,
      omitted: 0,
      complete: true,
    });
    const inspected = await inspect(f);
    expect(inspected.instanceResults.state).toBe("available");
    expect(inspected.instanceResults.items).toHaveLength(2);
    expect(inspected.instanceResults.items[1].envelopeSha256).toBeNull();
    expect(inspected.instanceResults.total).toBe(2);
    expect(inspected.instanceResults.omitted).toBe(0);
    expect(inspected.instanceResults.complete).toBe(true);
    expect(inspected.instanceResults.items[0].envelopeSha256).toBe(DIGEST);

    f.port.inspectHook = () => ({
      state: "available",
      reason: null,
      items: [{
        instanceId: "bad",
        parentToolCallId: "task-1",
        envelopeSha256: null,
        available: true,
        reason: null,
      }],
      total: 1,
      omitted: 0,
      complete: true,
    });
    const malformed = await inspect(f);
    expect(malformed.instanceResults.state).toBe("unavailable");
    expect(malformed.instanceResults.total).toBeNull();
    expect(malformed.instanceResults.omitted).toBeNull();
    expect(malformed.instanceResults.items).toHaveLength(0);
  });

  test("inspect port reentry cannot return a stale base view", async () => {
    const f = await fixture();
    await taskWork(f);
    f.port.inspectHook = () => {
      f.setSessionId("changed-during-inspect-port");
      return {
        state: "available",
        reason: null,
        items: [{
          instanceId: "instance-1",
          parentToolCallId: "task-1",
          envelopeSha256: DIGEST,
          available: true,
          reason: null,
        }],
        total: 1,
        omitted: 0,
        complete: true,
      };
    };
    const inspected = await inspect(f);
    expect(inspected.instanceResults.state).toBe("unavailable");
    expect(inspected.instanceResults.total).toBeNull();
    expect(inspected.current).toBeNull();
  });

  test("inspect withholds an available catalog when a port or final getter queues ingress", async () => {
    for (const mode of ["port", "final"] as const) {
      const f = await fixture();
      await taskWork(f);
      let cwdReads = 0;
      let queued = false;
      const queuePending = (): void => {
        if (queued) return;
        queued = true;
        f.host.emitSync("input", { text: `late ${mode} input`, source: "rpc" }, f.ctx);
      };
      f.setCwdGetterHook(() => {
        cwdReads += 1;
        if (cwdReads === 2) queuePending();
      });
      f.port.inspectHook = (context: NativeContext) => {
        if (mode === "port") context.sessionManager?.getCwd();
        return {
          state: "available",
          reason: null,
          items: [{
            instanceId: "instance-1",
            parentToolCallId: "task-1",
            envelopeSha256: DIGEST,
            available: true,
            reason: null,
          }],
          total: 1,
          omitted: 0,
          complete: true,
        };
      };
      const inspected = await inspect(f);
      expect(queued).toBe(true);
      // The work identity itself is unchanged; only the final pure state fails.
      expect(inspected.current.observationId).toBeTruthy();
      expect(inspected.pendingInputs.count).toBe(1);
      expect(inspected.instanceResults.state).toBe("unavailable");
      expect(inspected.instanceResults.total).toBeNull();
      expect(inspected.instanceResults.omitted).toBeNull();
      expect(inspected.instanceResults.reason).toMatch(/pending|ingress|trusted/);
    }
  });

  test("inspect remains usable when the port throws or returns a rejected promise", async () => {
    const f = await fixture();
    await taskWork(f);
    f.port.inspectHook = () => {
      throw new Error("inspect exploded");
    };
    const thrown = await inspect(f);
    expect(thrown.instanceResults.state).toBe("unavailable");
    expect(thrown.instanceResults.reason).toContain("inspect exploded");
    expect(thrown.current.observationId).toBeTruthy();

    f.port.inspectHook = () => Promise.reject(new Error("inspect rejected"));
    const promised = await inspect(f);
    expect(promised.instanceResults.state).toBe("unavailable");
    expect(promised.current.observationId).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("catalog encoding counts the complete wrapper and rejects accessor items", () => {
    const longEscapedId = "\\".repeat(256);
    const items = Array.from({ length: 64 }, () => ({
      instanceId: longEscapedId,
      parentToolCallId: longEscapedId,
      envelopeSha256: DIGEST,
      available: true as const,
      reason: null,
    }));
    const catalog = boundNativeInstanceReportCatalog({
      state: "available",
      reason: "x".repeat(500),
      items,
      total: 64,
      omitted: 0,
      complete: true,
    });
    expect(catalog.state).toBe("available");
    if (catalog.state !== "available") throw new Error("expected available catalog");
    expect(catalog.items.length).toBeLessThan(64);
    expect(catalog.total).toBe(64);
    expect(catalog.omitted).toBe(64 - catalog.items.length);
    expect(catalog.complete).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(catalog), "utf8")).toBeLessThanOrEqual(64 * 1024);

    const accessorItems = [{
      instanceId: "instance-1",
      parentToolCallId: "task-1",
      envelopeSha256: DIGEST,
      available: false,
      reason: "pending",
    }];
    Object.defineProperty(accessorItems, "0", {
      configurable: true,
      get() {
        throw new Error("array accessor ran");
      },
    });
    const refused = boundNativeInstanceReportCatalog({
      state: "available",
      reason: null,
      items: accessorItems,
      total: 1,
      omitted: 0,
      complete: true,
    });
    expect(refused.state).toBe("unavailable");
    expect(refused.reason).toContain("malformed");

    const missingCounts = boundNativeInstanceReportCatalog({
      state: "available",
      reason: null,
      items,
    });
    expect(missingCounts.state).toBe("unavailable");
    expect(missingCounts.total).toBeNull();
    expect(missingCounts.omitted).toBeNull();
    expect(missingCounts.complete).toBe(false);
    expect(missingCounts.reason).toContain("inconsistent");
  });
});
