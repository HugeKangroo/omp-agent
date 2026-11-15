import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNativeEntry,
  type NativeContext,
  type NativeEntryControls,
  type NativeOmpApi,
  type NativeWorkCallCapture,
} from "../../src/native-entry.ts";
import {
  clearPublishedTaskOwner,
  publishTaskOwner,
} from "../../src/task-entry-port.ts";
import type { TaskOwner } from "../../src/task-owner.ts";

const AGENT_WORK = "agent_work";

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

  async observe(
    context: NativeContext,
    toolCallId: string,
    toolName: string,
    text = "observed result",
  ): Promise<void> {
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
}

interface FixtureOptions {
  maxRetainedWorks?: number;
  maxCallsPerWork?: number;
  maxPendingInputs?: number;
  maxRememberedCallIds?: number;
  sessionId?: string;
  owner?: TaskOwner;
}

interface Fixture {
  root: string;
  workspace: string;
  host: Host;
  entry: NativeEntryControls;
  ctx: NativeContext;
  setSessionId(value: string): void;
  setLiveCwd(value: string): void;
  setAgentKind(kind: "main" | "sub"): void;
}

const roots: string[] = [];
const entries: NativeEntryControls[] = [];

afterEach(async () => {
  clearPublishedTaskOwner();
  for (const entry of entries.splice(0)) entry.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-native-call-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  if (options.owner !== undefined) publishTaskOwner(options.owner);

  let sessionId = options.sessionId ?? "session-native";
  const liveCwd = workspace;
  const host = new Host();
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
    ...(options.maxRetainedWorks === undefined ? {} : { maxRetainedWorks: options.maxRetainedWorks }),
    ...(options.maxCallsPerWork === undefined ? {} : { maxCallsPerWork: options.maxCallsPerWork }),
    ...(options.maxPendingInputs === undefined ? {} : { maxPendingInputs: options.maxPendingInputs }),
    ...(options.maxRememberedCallIds === undefined ? {} : { maxRememberedCallIds: options.maxRememberedCallIds }),
  });
  entries.push(entry);
  return {
    root,
    workspace,
    host,
    entry,
    ctx,
    setSessionId(value) {
      sessionId = value;
    },
    setLiveCwd(value) {
      (ctx.sessionManager as { getCwd(): string }).getCwd = () => value;
    },
    setAgentKind(kind) {
      ctx.agent = { kind };
    },
  };
}

async function input(host: Host, ctx: NativeContext, text: string, source = "rpc"): Promise<void> {
  await host.emit("input", { text, source }, ctx);
}

async function prepare(host: Host, ctx: NativeContext, prompt: string): Promise<void> {
  await host.emit("before_agent_start", {
    reason: "prompt",
    prompt,
    systemPrompt: ["base"],
  }, ctx);
}

async function terminalEnd(host: Host, ctx: NativeContext): Promise<void> {
  await host.emit("agent_end", { messages: [], willContinue: false }, ctx);
}

async function stop(host: Host, ctx: NativeContext): Promise<{ continue?: boolean; additionalContext?: string } | undefined> {
  return await host.emit("session_stop", {
    messages: [],
    turn_id: 1,
    session_id: "session-native",
    stop_hook_active: false,
    signal: new AbortController().signal,
  }, ctx) as { continue?: boolean; additionalContext?: string } | undefined;
}

async function observedWork(
  f: Fixture,
  prompt: string,
  toolCallId = "c1",
  toolName = "read",
): Promise<void> {
  await input(f.host, f.ctx, prompt);
  await prepare(f.host, f.ctx, prompt);
  await f.host.observe(f.ctx, toolCallId, toolName);
}

function expectCaptureOk(capture: NativeWorkCallCapture): Extract<NativeWorkCallCapture, { ok: true }> {
  expect(capture.ok).toBe(true);
  if (!capture.ok) throw new Error(`capture failed: ${capture.inspection.state}/${capture.inspection.reason}`);
  return capture;
}

function expectCaptureFailure(capture: NativeWorkCallCapture): Extract<NativeWorkCallCapture, { ok: false }> {
  expect(capture.ok).toBe(false);
  if (capture.ok) throw new Error("capture unexpectedly succeeded");
  expect(capture.ref).toBeNull();
  return capture;
}

describe("native work call association port", () => {
  test("capture requires an already-observed exact call in the live main context", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "inspect the request");
    await prepare(f.host, f.ctx, "inspect the request");

    const absent = expectCaptureFailure(f.entry.captureCall({ toolCallId: "missing", toolName: "read" }, f.ctx));
    expect(absent.inspection).toMatchObject({
      state: "unavailable",
      reason: "call-not-observed",
      association: null,
    });

    await f.host.emit("tool_call", { toolCallId: "c1", toolName: "read", input: {} }, f.ctx);
    const preflight = expectCaptureOk(f.entry.captureCall({ toolCallId: "c1", toolName: "read" }, f.ctx));
    expect(preflight.inspection).toMatchObject({
      state: "current",
      reason: "current-work",
      workPhase: "active",
      requestAttribution: "matched-user-input",
      evidenceState: "available",
      callResultState: "preflight",
      pendingInputCount: 0,
      pendingInputsDropped: 0,
    });

    expect(expectCaptureFailure(f.entry.captureCall({ toolCallId: "c1", toolName: "write" }, f.ctx)).inspection)
      .toMatchObject({ state: "unavailable", reason: "call-not-observed" });

    await f.host.emit("tool_result", {
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "observed" }],
      isError: false,
      details: undefined,
    }, f.ctx);
    expect(f.entry.inspectCall(preflight.ref, f.ctx)).toMatchObject({
      state: "current",
      reason: "current-work",
      callResultState: "observed",
    });

    f.setAgentKind("sub");
    expect(expectCaptureFailure(f.entry.captureCall({ toolCallId: "c1", toolName: "read" }, f.ctx)).inspection)
      .toMatchObject({ state: "unavailable", reason: "not-main-context" });
    f.setAgentKind("main");

    const unknownContext = { cwd: f.workspace, agent: { kind: "main" } } as NativeContext;
    expect(expectCaptureFailure(f.entry.captureCall({ toolCallId: "c1", toolName: "read" }, unknownContext)).inspection)
      .toMatchObject({ state: "unavailable", reason: "live-identity-unavailable" });

    const throwingContext = {
      cwd: f.workspace,
      get agent(): never {
        throw new Error("agent getter");
      },
      sessionManager: {
        getSessionId(): never {
          throw new Error("session getter");
        },
        getCwd(): never {
          throw new Error("cwd getter");
        },
      },
    } as NativeContext;
    expect(() => f.entry.captureCall({ toolCallId: "c1", toolName: "read" }, throwingContext)).not.toThrow();
    expect(f.entry.captureCall({ toolCallId: "c1", toolName: "read" }, throwingContext))
      .toMatchObject({ ok: false, inspection: { state: "unavailable" } });

    const throwingSelector = {
      get toolCallId(): never {
        throw new Error("selector id getter");
      },
      get toolName(): never {
        throw new Error("selector name getter");
      },
    };
    expect(() => f.entry.captureCall(throwingSelector, f.ctx)).not.toThrow();
    expect(f.entry.captureCall(throwingSelector, f.ctx))
      .toMatchObject({ ok: false, inspection: { state: "unavailable", reason: "invalid-selector" } });
  });

  test("references and inspections are frozen primitive copies; foreign refs are rejected before getters", async () => {
    const f = await fixture();
    await observedWork(f, "freeze the association");
    const capture = expectCaptureOk(f.entry.captureCall({ toolCallId: "c1", toolName: "read" }, f.ctx));
    const ref = capture.ref;

    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.isFrozen(ref)).toBe(true);
    expect(Object.isFrozen(capture.inspection)).toBe(true);
    expect(Object.isFrozen(capture.inspection.association)).toBe(true);
    expect(capture.inspection.association).not.toBe(ref);
    expect(Object.keys(ref).sort()).toEqual([
      "generation",
      "observationId",
      "sessionId",
      "toolCallId",
      "toolName",
      "workspaceRoot",
    ]);
    expect(() => {
      (ref as { toolCallId: string }).toolCallId = "other";
    }).toThrow();

    const second = f.entry.inspectCall(ref, f.ctx);
    const third = f.entry.inspectCall(ref, f.ctx);
    expect(second).not.toBe(third);
    expect(second.association).not.toBe(third.association);
    expect(second).toEqual(third);

    expect(f.entry.inspectCall(structuredClone(ref), f.ctx)).toMatchObject({
      state: "unavailable",
      reason: "foreign-reference",
      association: null,
    });
    expect(f.entry.inspectCall({ ...ref }, f.ctx)).toMatchObject({
      state: "unavailable",
      reason: "foreign-reference",
    });
    expect(f.entry.inspectCall(ref, { cwd: f.workspace } as NativeContext)).toMatchObject({
      state: "unavailable",
      reason: "not-main-context",
    });

    const getterTrap = {
      get observationId(): never {
        throw new Error("ref getter");
      },
      get generation(): never {
        throw new Error("ref getter");
      },
    };
    expect(() => f.entry.inspectCall(getterTrap, f.ctx)).not.toThrow();
    expect(f.entry.inspectCall(getterTrap, f.ctx)).toMatchObject({
      state: "unavailable",
      reason: "foreign-reference",
    });
    expect(f.entry.inspectCall(null, f.ctx).reason).toBe("foreign-reference");
    expect(f.entry.inspectCall(7, f.ctx).reason).toBe("foreign-reference");

    const other = await fixture();
    expect(other.entry.inspectCall(ref, other.ctx)).toMatchObject({
      state: "unavailable",
      reason: "foreign-reference",
    });
  });

  test("pending input, unknown source and truncated history suspend without consuming state", async () => {
    const pending = await fixture();
    await observedWork(pending, "first request");
    const queued = expectCaptureOk(pending.entry.captureCall({ toolCallId: "c1", toolName: "read" }, pending.ctx));
    await input(pending.host, pending.ctx, "second request");
    const suspended = pending.entry.inspectCall(queued.ref, pending.ctx);
    expect(suspended).toMatchObject({
      state: "suspended",
      reason: "pending-input",
      pendingInputCount: 1,
    });
    const actual = await pending.host.emit("tool_call", {
      toolCallId: "pending-inspect",
      toolName: AGENT_WORK,
      input: { action: "inspect" },
    }, pending.ctx);
    expect(actual).toBeUndefined();
    const tool = pending.host.tools.get(AGENT_WORK)!;
    const result = await tool.execute("pending-inspect", { action: "inspect" }, undefined, undefined, pending.ctx);
    const details = result.details as Record<string, any>;
    expect(details.pendingInputs).toEqual({ count: 1, dropped: 0 });
    expect(pending.entry.inspectCall(queued.ref, pending.ctx).reason).toBe("pending-input");

    const unknown = await fixture();
    await prepare(unknown.host, unknown.ctx, "direct prompt without ingress");
    await unknown.host.observe(unknown.ctx, "u1", "read");
    const unknownCapture = expectCaptureOk(unknown.entry.captureCall({ toolCallId: "u1", toolName: "read" }, unknown.ctx));
    expect(unknownCapture.inspection).toMatchObject({
      state: "suspended",
      reason: "unknown-input-source",
      requestAttribution: "unknown",
      evidenceState: "unknown-source",
    });

    const dropped = await fixture({ maxPendingInputs: 1 });
    await input(dropped.host, dropped.ctx, "old request");
    await input(dropped.host, dropped.ctx, "new request");
    await prepare(dropped.host, dropped.ctx, "new request");
    await dropped.host.observe(dropped.ctx, "d1", "read");
    const droppedCapture = expectCaptureOk(dropped.entry.captureCall({ toolCallId: "d1", toolName: "read" }, dropped.ctx));
    expect(droppedCapture.inspection).toMatchObject({
      state: "suspended",
      reason: "input-history-truncated",
      pendingInputCount: 0,
      pendingInputsDropped: 1,
    });
    const toolDropped = dropped.host.tools.get(AGENT_WORK)!;
    const droppedResult = await toolDropped.execute("dropped-inspect", { action: "inspect" }, undefined, undefined, dropped.ctx);
    expect((droppedResult.details as Record<string, any>).pendingInputs).toEqual({ count: 0, dropped: 1 });
  });

  test("terminal end is ended, the issued advisory reopens the same generation, fresh same text replaces", async () => {
    const f = await fixture();
    await observedWork(f, "finalize this request", "a1");
    const before = expectCaptureOk(f.entry.captureCall({ toolCallId: "a1", toolName: "read" }, f.ctx));

    await terminalEnd(f.host, f.ctx);
    expect(f.entry.inspectCall(before.ref, f.ctx)).toMatchObject({
      state: "ended",
      reason: "work-ended",
      workPhase: "ended",
      callResultState: "observed",
    });
    expect(expectCaptureOk(f.entry.captureCall({ toolCallId: "a1", toolName: "read" }, f.ctx)).inspection)
      .toMatchObject({ state: "ended", reason: "work-ended" });

    const reminder = await stop(f.host, f.ctx);
    expect(reminder?.continue).toBe(true);
    const reminderText = reminder!.additionalContext!;
    const reopened = f.entry.inspectCall(before.ref, f.ctx);
    expect(reopened).toMatchObject({ state: "current", reason: "current-work" });
    expect(reopened.association?.generation).toBe(before.ref.generation);
    expect(reopened.association?.observationId).toBe(before.ref.observationId);

    await prepare(f.host, f.ctx, reminderText);
    const afterAdvisory = f.entry.inspectCall(before.ref, f.ctx);
    expect(afterAdvisory).toMatchObject({ state: "current", reason: "current-work" });
    expect(afterAdvisory.association?.generation).toBe(before.ref.generation);

    const reportParams = {
      action: "report",
      checks: [{ toolCallId: "a1", purpose: "advisory continuation check" }],
      outcome: "completed",
      limitations: [],
    };
    await f.host.emit("tool_call", {
      toolCallId: "report-after-advisory",
      toolName: AGENT_WORK,
      input: reportParams,
    }, f.ctx);
    const report = await f.host.tools.get(AGENT_WORK)!.execute(
      "report-after-advisory",
      reportParams,
      undefined,
      undefined,
      f.ctx,
    );
    expect(report.isError).not.toBe(true);
    expect((report.details as Record<string, any>).work.observationId).toBe(before.ref.observationId);

    const fresh = await fixture();
    await input(fresh.host, fresh.ctx, "same text");
    await prepare(fresh.host, fresh.ctx, "same text");
    await fresh.host.observe(fresh.ctx, "s1", "read");
    const old = expectCaptureOk(fresh.entry.captureCall({ toolCallId: "s1", toolName: "read" }, fresh.ctx));
    await terminalEnd(fresh.host, fresh.ctx);
    await input(fresh.host, fresh.ctx, "same text");
    await prepare(fresh.host, fresh.ctx, "same text");

    const oldInspection = fresh.entry.inspectCall(old.ref, fresh.ctx);
    expect(oldInspection.state).toBe("stale");
    expect(oldInspection.reason).toBe("work-replaced");
    expect(expectCaptureFailure(fresh.entry.captureCall({ toolCallId: "s1", toolName: "read" }, fresh.ctx)).inspection)
      .toMatchObject({ state: "stale", reason: "work-replaced" });

    await fresh.host.observe(fresh.ctx, "s2", "read");
    const replacement = expectCaptureOk(fresh.entry.captureCall({ toolCallId: "s2", toolName: "read" }, fresh.ctx));
    expect(replacement.inspection.state).toBe("current");
    expect(replacement.ref.generation).toBeGreaterThan(old.ref.generation);
  });

  test("call and work pruning and reused ids never resurrect an old association", async () => {
    const calls = await fixture({ maxCallsPerWork: 1 });
    await observedWork(calls, "prune calls", "c1");
    const callRef = expectCaptureOk(calls.entry.captureCall({ toolCallId: "c1", toolName: "read" }, calls.ctx));
    await calls.host.emit("tool_call", { toolCallId: "c2", toolName: "read", input: {} }, calls.ctx);

    expect(calls.entry.inspectCall(callRef.ref, calls.ctx)).toMatchObject({
      state: "stale",
      reason: "call-not-retained",
    });
    expect(expectCaptureFailure(calls.entry.captureCall({ toolCallId: "c1", toolName: "read" }, calls.ctx)).inspection)
      .toMatchObject({ state: "unavailable", reason: "call-not-observed" });

    await calls.host.emit("tool_call", { toolCallId: "c1", toolName: "read", input: {} }, calls.ctx);
    expect(expectCaptureFailure(calls.entry.captureCall({ toolCallId: "c1", toolName: "read" }, calls.ctx)).inspection)
      .toMatchObject({ state: "stale", reason: "call-conflicted" });
    expect(calls.entry.inspectCall(callRef.ref, calls.ctx)).toMatchObject({
      state: "stale",
      reason: "call-conflicted",
    });

    const works = await fixture({ maxRetainedWorks: 1 });
    await observedWork(works, "prune work", "w1");
    const workRef = expectCaptureOk(works.entry.captureCall({ toolCallId: "w1", toolName: "read" }, works.ctx));
    await input(works.host, works.ctx, "next work");
    await prepare(works.host, works.ctx, "next work");
    await works.host.observe(works.ctx, "w2", "read");
    expect(works.entry.inspectCall(workRef.ref, works.ctx)).toMatchObject({
      state: "stale",
      reason: "work-not-retained",
    });

    const reused = await fixture();
    await observedWork(reused, "first generation", "same-id");
    const reuseRef = expectCaptureOk(reused.entry.captureCall({ toolCallId: "same-id", toolName: "read" }, reused.ctx));
    await input(reused.host, reused.ctx, "second generation");
    await prepare(reused.host, reused.ctx, "second generation");
    await reused.host.emit("tool_call", { toolCallId: "same-id", toolName: "read", input: {} }, reused.ctx);
    expect(expectCaptureFailure(reused.entry.captureCall({ toolCallId: "same-id", toolName: "read" }, reused.ctx)).inspection)
      .toMatchObject({ state: "stale", reason: "call-conflicted" });
    expect(reused.entry.inspectCall(reuseRef.ref, reused.ctx)).toMatchObject({ state: "stale" });
  });

  test("navigation, live identity changes, dispose and TaskOwner fail closed without mutation", async () => {
    const navigated = await fixture();
    await observedWork(navigated, "navigate away", "n1");
    const navRef = expectCaptureOk(navigated.entry.captureCall({ toolCallId: "n1", toolName: "read" }, navigated.ctx));
    await navigated.host.emit("session_switch", { reason: "resume" }, navigated.ctx);
    expect(navigated.entry.inspectCall(navRef.ref, navigated.ctx)).toMatchObject({
      state: "stale",
      reason: "work-invalidated",
    });

    const moved = await fixture();
    await observedWork(moved, "move workspace", "m1");
    const moveRef = expectCaptureOk(moved.entry.captureCall({ toolCallId: "m1", toolName: "read" }, moved.ctx));
    moved.setLiveCwd(path.join(moved.root, "moved"));
    expect(moved.entry.inspectCall(moveRef.ref, moved.ctx)).toMatchObject({
      state: "stale",
      reason: "live-workspace-changed",
    });
    expect(moved.entry.isEnabled()).toBe(true);

    const session = await fixture();
    await observedWork(session, "switch session", "s1");
    const sessionRef = expectCaptureOk(session.entry.captureCall({ toolCallId: "s1", toolName: "read" }, session.ctx));
    session.setSessionId("different-session");
    expect(session.entry.inspectCall(sessionRef.ref, session.ctx)).toMatchObject({
      state: "stale",
      reason: "live-session-changed",
    });

    const disposed = await fixture();
    await observedWork(disposed, "dispose entry", "x1");
    const disposedRef = expectCaptureOk(disposed.entry.captureCall({ toolCallId: "x1", toolName: "read" }, disposed.ctx));
    disposed.entry.dispose();
    expect(disposed.entry.inspectCall(disposedRef.ref, disposed.ctx)).toMatchObject({
      state: "unavailable",
      reason: "entry-disposed",
    });
    expect(expectCaptureFailure(disposed.entry.captureCall({ toolCallId: "x1", toolName: "read" }, disposed.ctx)).inspection)
      .toMatchObject({ state: "unavailable", reason: "entry-disposed" });

    const owned = await fixture();
    await observedWork(owned, "late owner", "o1");
    const ownerRef = expectCaptureOk(owned.entry.captureCall({ toolCallId: "o1", toolName: "read" }, owned.ctx));
    publishTaskOwner({ ownerId: "late-owner" } as unknown as TaskOwner);
    expect(expectCaptureFailure(owned.entry.captureCall({ toolCallId: "o1", toolName: "read" }, owned.ctx)).inspection)
      .toMatchObject({ state: "unavailable", reason: "managed-owner-present" });
    expect(owned.entry.inspectCall(ownerRef.ref, owned.ctx)).toMatchObject({
      state: "unavailable",
      reason: "managed-owner-present",
    });
    expect(owned.entry.isEnabled()).toBe(true);

    const preOwned = await fixture({ owner: { ownerId: "pre-owner" } as unknown as TaskOwner });
    expect(preOwned.entry.enabled).toBe(false);
    expect(expectCaptureFailure(preOwned.entry.captureCall({ toolCallId: "any", toolName: "read" }, preOwned.ctx)).inspection)
      .toMatchObject({ state: "unavailable", reason: "entry-disabled" });
  });

  test("reentrant host getters cannot return a stale pre-read success", async () => {
    const navigated = await fixture();
    await observedWork(navigated, "reentrant navigation", "r1");
    const navRef = expectCaptureOk(navigated.entry.captureCall({ toolCallId: "r1", toolName: "read" }, navigated.ctx));
    const original = navigated.ctx.sessionManager!;
    navigated.ctx.sessionManager = {
      getSessionId() {
        navigated.host.emitSync("session_switch", { reason: "reentrant" }, navigated.ctx);
        return original.getSessionId();
      },
      getCwd() {
        return original.getCwd();
      },
    };
    expect(navigated.entry.inspectCall(navRef.ref, navigated.ctx)).toMatchObject({
      state: "stale",
      reason: "work-invalidated",
    });

    const disposed = await fixture();
    await observedWork(disposed, "reentrant disposal", "r2");
    const disposeRef = expectCaptureOk(disposed.entry.captureCall({ toolCallId: "r2", toolName: "read" }, disposed.ctx));
    const disposedOriginal = disposed.ctx.sessionManager!;
    disposed.ctx.sessionManager = {
      getSessionId() {
        disposed.entry.dispose();
        return disposedOriginal.getSessionId();
      },
      getCwd() {
        return disposedOriginal.getCwd();
      },
    };
    expect(disposed.entry.inspectCall(disposeRef.ref, disposed.ctx)).toMatchObject({
      state: "unavailable",
      reason: "entry-disposed",
    });
  });

  test("a reentrant getter publishing a TaskOwner is caught by the final ownership read without mutation", async () => {
    const inspected = await fixture();
    await observedWork(inspected, "owner published from inspect getter", "p1");
    const inspectRef = expectCaptureOk(inspected.entry.captureCall({ toolCallId: "p1", toolName: "read" }, inspected.ctx));
    const inspectOriginal = inspected.ctx.sessionManager!;
    inspected.ctx.sessionManager = {
      getSessionId() {
        return inspectOriginal.getSessionId();
      },
      getCwd() {
        publishTaskOwner({ ownerId: "getter-inspect-owner" } as unknown as TaskOwner);
        return inspectOriginal.getCwd();
      },
    };
    expect(inspected.entry.inspectCall(inspectRef.ref, inspected.ctx)).toMatchObject({
      state: "unavailable",
      reason: "managed-owner-present",
    });
    expect(inspected.entry.isEnabled()).toBe(true);
    inspected.ctx.sessionManager = inspectOriginal;
    clearPublishedTaskOwner();
    expect(inspected.entry.inspectCall(inspectRef.ref, inspected.ctx)).toMatchObject({
      state: "current",
      reason: "current-work",
    });

    const captured = await fixture();
    await observedWork(captured, "owner published from capture getter", "p2");
    const captureOriginal = captured.ctx.sessionManager!;
    captured.ctx.sessionManager = {
      getSessionId() {
        return captureOriginal.getSessionId();
      },
      getCwd() {
        publishTaskOwner({ ownerId: "getter-capture-owner" } as unknown as TaskOwner);
        return captureOriginal.getCwd();
      },
    };
    expect(expectCaptureFailure(captured.entry.captureCall({ toolCallId: "p2", toolName: "read" }, captured.ctx)).inspection)
      .toMatchObject({ state: "unavailable", reason: "managed-owner-present" });
    expect(captured.entry.isEnabled()).toBe(true);
    captured.ctx.sessionManager = captureOriginal;
    clearPublishedTaskOwner();
    expect(expectCaptureOk(captured.entry.captureCall({ toolCallId: "p2", toolName: "read" }, captured.ctx)).inspection.state)
      .toBe("current");
  });

  test("a valid retained reference survives uniqueness saturation while new ids cannot capture", async () => {
    const f = await fixture({ maxRememberedCallIds: 2 });
    await input(f.host, f.ctx, "saturate call id memory");
    await prepare(f.host, f.ctx, "saturate call id memory");
    await f.host.observe(f.ctx, "c1", "read");
    await f.host.observe(f.ctx, "c2", "read");

    const existing = expectCaptureOk(f.entry.captureCall({ toolCallId: "c1", toolName: "read" }, f.ctx));
    expect(existing.inspection.state).toBe("current");
    expect(f.entry.inspectCall(existing.ref, f.ctx)).toMatchObject({
      state: "current",
      reason: "current-work",
    });

    await f.host.emit("tool_call", { toolCallId: "c3", toolName: "read", input: {} }, f.ctx);
    expect(expectCaptureFailure(f.entry.captureCall({ toolCallId: "c3", toolName: "read" }, f.ctx)).inspection)
      .toMatchObject({ state: "stale", reason: "call-conflicted" });
    expect(f.entry.inspectCall(existing.ref, f.ctx).state).toBe("current");
  });
});
