import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNativeEntry,
  NATIVE_WORK_GUIDANCE,
  type NativeContext,
  type NativeEntryControls,
  type NativeOmpApi,
  type NativeToolResult,
  type NativeWorkReport,
} from "../../src/native-entry.ts";
import {
  MAX_OUTPUT_FILE_BYTES,
  MAX_OUTPUT_TOTAL_BYTES,
  NativeFileError,
  nodeFileIo,
  observeWorkspaceFile,
  validateRelativePath,
  type NativeFileHandle,
  type NativeFileIo,
  type NativeFileStats,
} from "../../src/native-work.ts";
import {
  clearPublishedTaskOwner,
  publishTaskOwner,
} from "../../src/task-entry-port.ts";
import type { TaskOwner } from "../../src/task-owner.ts";

const AGENT_WORK = "agent_work";

type RegisteredTool = Parameters<NativeOmpApi["registerTool"]>[0];
type Handler = (event: unknown, context: NativeContext) => unknown;

interface CallOptions {
  isError?: boolean;
  details?: unknown;
}

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
    text: string,
    options: CallOptions = {},
  ): Promise<void> {
    await this.emit("tool_call", { toolCallId, toolName, input: {} }, context);
    await this.emit("tool_result", {
      toolCallId,
      toolName,
      input: {},
      content: [{ type: "text", text }],
      isError: options.isError ?? false,
      details: options.details,
    }, context);
  }

  async call(
    toolCallId: string,
    params: unknown,
    context: NativeContext,
  ): Promise<NativeToolResult> {
    await this.emit("tool_call", { toolCallId, toolName: AGENT_WORK, input: params }, context);
    const tool = this.tools.get(AGENT_WORK);
    if (tool === undefined) throw new Error("agent_work was not registered");
    const result = await tool.execute(toolCallId, params, undefined, undefined, context);
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

interface FixtureOptions {
  now?: () => number;
  fileIo?: NativeFileIo;
  reminderDeadlineMs?: number;
  maxRetainedWorks?: number;
  maxCallsPerWork?: number;
  maxPendingInputs?: number;
  maxReportBindings?: number;
  maxRememberedCallIds?: number;
  sessionId?: string;
  cwd?: string;
  owner?: TaskOwner;
}

interface Fixture {
  root: string;
  workspace: string;
  host: Host;
  entry: NativeEntryControls;
  ctx: NativeContext;
  setSessionId(value: string): void;
  setCwd(value: string): void;
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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-native-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  if (options.owner !== undefined) publishTaskOwner(options.owner);

  let sessionId = options.sessionId ?? "session-native";
  let cwd = options.cwd ?? workspace;
  let liveCwd = cwd;
  const host = new Host();
  const ctx: NativeContext = {
    get cwd() {
      return cwd;
    },
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
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
    ...(options.reminderDeadlineMs === undefined ? {} : { reminderDeadlineMs: options.reminderDeadlineMs }),
    ...(options.maxRetainedWorks === undefined ? {} : { maxRetainedWorks: options.maxRetainedWorks }),
    ...(options.maxCallsPerWork === undefined ? {} : { maxCallsPerWork: options.maxCallsPerWork }),
    ...(options.maxPendingInputs === undefined ? {} : { maxPendingInputs: options.maxPendingInputs }),
    ...(options.maxReportBindings === undefined ? {} : { maxReportBindings: options.maxReportBindings }),
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
    setCwd(value) {
      cwd = value;
      liveCwd = value;
    },
    setLiveCwd(value) {
      liveCwd = value;
    },
    setAgentKind(kind) {
      ctx.agent = { kind };
    },
  };
}

async function input(host: Host, ctx: NativeContext, text: string, source = "rpc"): Promise<void> {
  await host.emit("input", { text, source }, ctx);
}

async function prepare(
  host: Host,
  ctx: NativeContext,
  prompt: string,
): Promise<{ systemPrompt?: string[] } | undefined> {
  return await host.emit("before_agent_start", {
    reason: "prompt",
    prompt,
    systemPrompt: ["base"],
  }, ctx) as { systemPrompt?: string[] } | undefined;
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

function reportArgs(
  checks: Array<{ toolCallId: string; purpose: string }> = [],
  outputFiles: string[] = [],
  outcome: "completed" | "insufficient" | "blocked" = "completed",
  summary: string | undefined = undefined,
  limitations: string[] = [],
): Record<string, unknown> {
  return {
    action: "report",
    checks,
    outputFiles,
    outcome,
    ...(summary === undefined ? {} : { summary }),
    limitations,
  };
}

function reportDetails(result: NativeToolResult): NativeWorkReport {
  expect(result.isError).not.toBe(true);
  return result.details as NativeWorkReport;
}

async function inspect(host: Host, ctx: NativeContext, toolCallId: string): Promise<any> {
  const result = await host.call(toolCallId, { action: "inspect" }, ctx);
  expect(result.isError).not.toBe(true);
  return result.details;
}

function expectError(result: NativeToolResult, pattern?: RegExp): void {
  expect(result.isError).toBe(true);
  if (pattern !== undefined) {
    expect(result.content[0]?.text ?? "").toMatch(pattern);
  }
}

function dirStats(
  ino: bigint,
  dev = 1n,
  mtimeNs = 10n,
  ctimeNs = 11n,
): NativeFileStats {
  return {
    dev,
    ino,
    size: 0n,
    mtimeNs,
    ctimeNs,
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

function fileStats(
  ino: bigint,
  size: bigint,
  dev = 1n,
  mtimeNs = 20n,
  ctimeNs = 21n,
): NativeFileStats {
  return {
    dev,
    ino,
    size,
    mtimeNs,
    ctimeNs,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
}

interface VirtualIoOptions {
  rootFirst?: NativeFileStats;
  rootAfter?: NativeFileStats;
  parentFirst?: NativeFileStats;
  parentAfter?: NativeFileStats;
  fileBefore: NativeFileStats;
  fileOpened?: NativeFileStats;
  fileAfter?: NativeFileStats;
  fileAtPath?: NativeFileStats;
}

function virtualIo(options: VirtualIoOptions): NativeFileIo {
  const rootFirst = options.rootFirst ?? dirStats(10n);
  const rootAfter = options.rootAfter ?? rootFirst;
  const parentFirst = options.parentFirst ?? dirStats(20n);
  const parentAfter = options.parentAfter ?? parentFirst;
  const fileBefore = options.fileBefore;
  const fileOpened = options.fileOpened ?? fileBefore;
  const fileAfter = options.fileAfter ?? fileOpened;
  const fileAtPath = options.fileAtPath ?? fileAfter;
  let rootReads = 0;
  let parentReads = 0;
  let fileReads = 0;
  let statReads = 0;
  return {
    O_RDONLY: 0,
    O_NOFOLLOW: 0,
    async realpath(target) {
      return target;
    },
    async lstat(target) {
      if (target === "/ws") {
        rootReads++;
        return rootReads === 1 ? rootFirst : rootAfter;
      }
      if (target === "/ws/out") {
        parentReads++;
        return parentReads === 1 ? parentFirst : parentAfter;
      }
      if (target === "/ws/out.txt" || target === "/ws/out/result.txt") {
        fileReads++;
        return fileReads === 1 ? fileBefore : fileAtPath;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async open() {
      const handle: NativeFileHandle = {
        async stat() {
          statReads++;
          return statReads === 1 ? fileOpened : fileAfter;
        },
        async read(buffer, offset, length) {
          const size = Number(fileOpened.size);
          for (let index = 0; index < size; index++) {
            buffer[offset + index] = 97 + (index % 26);
          }
          return { bytesRead: Math.min(size, length) };
        },
        async close() {
          return undefined;
        },
      };
      return handle;
    },
  };
}

async function expectChanged(run: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await run;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(NativeFileError);
  expect((failure as NativeFileError).code).toBe("changed");
}

describe("native work entry", () => {
  test("two sequential genuine requests keep separate non-authoritative work and reports", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "first request");
    const firstPrep = await prepare(f.host, f.ctx, "first request");
    expect(firstPrep?.systemPrompt?.join("\n")).toContain(NATIVE_WORK_GUIDANCE);
    expect(NATIVE_WORK_GUIDANCE).toContain("non-authoritative");
    expect(NATIVE_WORK_GUIDANCE).toContain("not the managed TaskOwner");
    expect(NATIVE_WORK_GUIDANCE).toContain("perform proportional actual checks");
    expect(NATIVE_WORK_GUIDANCE).not.toContain("checks stay optional");

    await f.host.observe(f.ctx, "a1", "read", "input looked good");
    await f.host.observe(f.ctx, "a2", "bash", "check output", { details: { exitCode: 0 } });
    const first = reportDetails(await f.host.call("report-1", reportArgs([
      { toolCallId: "a1", purpose: "inspect the input" },
      { toolCallId: "a2", purpose: "run the focused check" },
    ], [], "completed", "first request done", ["fixture evidence only"]), f.ctx));

    expect(first.authority).toBe("non-authoritative");
    expect(first.work.request.attribution).toBe("matched-user-input");
    expect(first.work.request.excerpt).toBe("first request");
    expect(first.observed.checks).toHaveLength(2);
    expect(first.observed.checks[0]?.observationScope).toBe("plugin-tool-result-after-middleware");
    expect(first.observed.checks[1]?.exitCodeFromToolDetails).toBe(0);
    expect(first.observed.outputFiles).toHaveLength(0);
    expect(first.observed.coverage.callsInWorkWithoutObservedResult).toBe(0);
    expect(JSON.stringify(first)).not.toContain("\"accepted\"");

    await terminalEnd(f.host, f.ctx);
    const afterEnd = await inspect(f.host, f.ctx, "inspect-after-end");
    expect(afterEnd.current.status).toBe("ended");
    expect(afterEnd.current.reportState).toBe("reported");
    expect(afterEnd.current.outcome).toBe("completed");
    expect(afterEnd.retainedWorks.count).toBe(1);

    await input(f.host, f.ctx, "second request");
    await prepare(f.host, f.ctx, "second request");
    await f.host.observe(f.ctx, "b1", "glob", "found the files");
    const beforeSecondReport = await inspect(f.host, f.ctx, "inspect-second");
    expect(beforeSecondReport.current.observationId).not.toBe(first.work.observationId);
    expect(beforeSecondReport.current.request.excerpt).toBe("second request");

    expectError(
      await f.host.call("report-2-bad", reportArgs([
        { toolCallId: "a1", purpose: "old work must not be selected" },
      ]), f.ctx),
      /not retained in this work/,
    );
    const second = reportDetails(await f.host.call("report-2", reportArgs([
      { toolCallId: "b1", purpose: "inspect the second request input" },
    ], [], "completed", "second request done"), f.ctx));
    expect(second.work.observationId).not.toBe(first.work.observationId);
    await terminalEnd(f.host, f.ctx);
    const final = await inspect(f.host, f.ctx, "inspect-final");
    expect(final.current.status).toBe("ended");
    expect(final.current.reportState).toBe("reported");
    expect(final.retainedWorks.count).toBe(2);
  });

  test("repeat preparation keeps the work generation and one-shot reminder state", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "repeatable request");
    await prepare(f.host, f.ctx, "repeatable request");
    await f.host.observe(f.ctx, "a1", "read", "observed");

    const initial = await inspect(f.host, f.ctx, "inspect-before");
    const workId = initial.current.observationId;
    const firstStop = await stop(f.host, f.ctx);
    expect(firstStop?.continue).toBe(true);
    expect(firstStop?.additionalContext).toContain("one-time advisory");
    expect((await stop(f.host, f.ctx))?.continue).not.toBe(true);

    const repeat = await prepare(f.host, f.ctx, "repeatable request");
    expect(repeat?.systemPrompt?.join("\n")).toContain(NATIVE_WORK_GUIDANCE);
    const afterRepeat = await inspect(f.host, f.ctx, "inspect-after");
    expect(afterRepeat.current.observationId).toBe(workId);
    expect(afterRepeat.current.calls.filter((call: any) => call.toolCallId === "a1")).toHaveLength(1);
    expect(afterRepeat.current.reminder.used).toBe(true);
    expect((await stop(f.host, f.ctx))?.continue).not.toBe(true);
  });

  test("ordinary no-tool conversation does not receive a stop continuation", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "hello, how are you?");
    await prepare(f.host, f.ctx, "hello, how are you?");
    expect((await stop(f.host, f.ctx))?.continue).not.toBe(true);
    const inspected = await inspect(f.host, f.ctx, "inspect-no-tool");
    expect(inspected.current.calls.filter((call: any) => call.toolName !== AGENT_WORK)).toHaveLength(0);
  });

  test("extension-sourced input and subagent calls are refused for work evidence", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "extension request", "extension");
    await prepare(f.host, f.ctx, "extension request");
    await f.host.observe(f.ctx, "a1", "read", "result");
    expectError(
      await f.host.call("report-extension", reportArgs([
        { toolCallId: "a1", purpose: "model-declared purpose" },
      ]), f.ctx),
      /not genuine user input/,
    );
    const inspected = await inspect(f.host, f.ctx, "inspect-extension");
    expect(inspected.current.evidence.state).toBe("unavailable");
    expect(inspected.current.request.attribution).toBe("unavailable");
    expect(inspected.current.request.excerpt).toBeNull();

    f.setAgentKind("sub");
    expect(await prepare(f.host, f.ctx, "subagent request")).toBeUndefined();
    expectError(await f.host.call("sub-report", { action: "inspect" }, f.ctx), /main session/);
  });

  test("an already-published managed owner disables the entry without registering", async () => {
    const owner = { ownerId: "fixture-owner" } as unknown as TaskOwner;
    const f = await fixture({ owner });
    expect(f.entry.enabled).toBe(false);
    expect(f.entry.disabledReason).toContain("managed TaskOwner");
    expect(f.host.tools.size).toBe(0);
    expect(f.host.handlers.size).toBe(0);
  });

  test("a managed owner appearing later disables guidance and tool operations", async () => {
    const f = await fixture();
    expect(f.entry.enabled).toBe(true);
    publishTaskOwner({ ownerId: "late-owner" } as unknown as TaskOwner);
    expect(await prepare(f.host, f.ctx, "ordinary request")).toBeUndefined();
    expect(f.entry.isEnabled()).toBe(false);
    expectError(await f.host.call("late-inspect", { action: "inspect" }, f.ctx), /managed TaskOwner/);
    clearPublishedTaskOwner();
  });

  test("a changed session or workspace is refused for report evidence", async () => {
    const session = await fixture();
    await input(session.host, session.ctx, "session request");
    await prepare(session.host, session.ctx, "session request");
    await session.host.observe(session.ctx, "s1", "read", "result");
    const sessionParams = reportArgs([{ toolCallId: "s1", purpose: "inspect session work" }]);
    await session.host.emit("tool_call", { toolCallId: "session-report", toolName: AGENT_WORK, input: sessionParams }, session.ctx);
    session.setSessionId("different-session");
    const sessionTool = session.host.tools.get(AGENT_WORK)!;
    expectError(
      await sessionTool.execute("session-report", sessionParams, undefined, undefined, session.ctx),
      /session|workspace/,
    );

    const workspace = await fixture();
    await input(workspace.host, workspace.ctx, "workspace request");
    await prepare(workspace.host, workspace.ctx, "workspace request");
    await workspace.host.observe(workspace.ctx, "w1", "read", "result");
    const workspaceParams = reportArgs([{ toolCallId: "w1", purpose: "inspect workspace work" }]);
    await workspace.host.emit("tool_call", { toolCallId: "workspace-report", toolName: AGENT_WORK, input: workspaceParams }, workspace.ctx);
    const other = path.join(workspace.root, "other");
    await mkdir(other, { mode: 0o700 });
    workspace.setCwd(other);
    const workspaceTool = workspace.host.tools.get(AGENT_WORK)!;
    expectError(
      await workspaceTool.execute("workspace-report", workspaceParams, undefined, undefined, workspace.ctx),
      /session|workspace/,
    );
  });

  test("input queued during active work does not steal later calls", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "first queued request");
    await prepare(f.host, f.ctx, "first queued request");
    await input(f.host, f.ctx, "second queued request");
    await f.host.observe(f.ctx, "a1", "read", "first work result");
    const first = reportDetails(await f.host.call("report-first", reportArgs([
      { toolCallId: "a1", purpose: "first work check" },
    ]), f.ctx));
    expect(first.work.request.excerpt).toBe("first queued request");
    await terminalEnd(f.host, f.ctx);

    await prepare(f.host, f.ctx, "second queued request");
    const secondView = await inspect(f.host, f.ctx, "inspect-second-queued");
    expect(secondView.current.request.excerpt).toBe("second queued request");
    expect(secondView.current.calls.filter((call: any) => call.toolName !== AGENT_WORK)).toHaveLength(0);
    expectError(
      await f.host.call("report-second-bad", reportArgs([
        { toolCallId: "a1", purpose: "must belong to the old work" },
      ]), f.ctx),
      /not retained in this work/,
    );
    await f.host.observe(f.ctx, "b1", "read", "second work result");
    const second = reportDetails(await f.host.call("report-second", reportArgs([
      { toolCallId: "b1", purpose: "second work check" },
    ]), f.ctx));
    expect(second.work.observationId).not.toBe(first.work.observationId);
    expect(second.work.request.excerpt).toBe("second queued request");
  });

  test("a late result for an old call cannot be selected in a new work", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "old request");
    await prepare(f.host, f.ctx, "old request");
    await f.host.emit("tool_call", { toolCallId: "old-call", toolName: "read", input: {} }, f.ctx);
    await terminalEnd(f.host, f.ctx);

    await input(f.host, f.ctx, "new request");
    await prepare(f.host, f.ctx, "new request");
    await f.host.emit("tool_result", {
      toolCallId: "old-call",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: "late old result" }],
      isError: false,
    }, f.ctx);

    const current = await inspect(f.host, f.ctx, "inspect-new-work");
    expect(current.current.calls.filter((call: any) => call.toolName !== AGENT_WORK)).toHaveLength(0);
    expectError(
      await f.host.call("report-new-bad", reportArgs([
        { toolCallId: "old-call", purpose: "stale result must not be used" },
      ]), f.ctx),
      /not retained in this work/,
    );
  });

  test("navigation invalidates live observations and stale results are not selectable", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "navigated request");
    await prepare(f.host, f.ctx, "navigated request");
    await f.host.emit("tool_call", { toolCallId: "n1", toolName: "read", input: {} }, f.ctx);
    await f.host.emit("session_switch", { reason: "resume" }, f.ctx);
    const afterNavigation = await inspect(f.host, f.ctx, "inspect-after-navigation");
    expect(afterNavigation.current).toBeNull();
    expect(afterNavigation.retainedWorks.items[0]?.status).toBe("unknown");

    await input(f.host, f.ctx, "after navigation");
    await prepare(f.host, f.ctx, "after navigation");
    await f.host.emit("tool_result", {
      toolCallId: "n1",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: "stale navigation result" }],
      isError: false,
    }, f.ctx);
    expectError(
      await f.host.call("report-after-navigation", reportArgs([
        { toolCallId: "n1", purpose: "stale result" },
      ]), f.ctx),
      /not retained in this work/,
    );
  });

  test("ambiguous pending inputs refuse evidence instead of guessing", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "same text");
    await input(f.host, f.ctx, "same text");
    await prepare(f.host, f.ctx, "same text");
    await f.host.observe(f.ctx, "a1", "read", "result");
    const inspected = await inspect(f.host, f.ctx, "inspect-ambiguous");
    expect(inspected.current.evidence.state).toBe("unavailable");
    expect(inspected.current.request.attribution).toBe("unknown");
    expect(inspected.current.evidence.unavailableReason).toContain("ambiguous");
    expect(inspected.pendingInputs.count).toBe(0);
    expectError(
      await f.host.call("report-ambiguous", reportArgs([
        { toolCallId: "a1", purpose: "ambiguous request" },
      ]), f.ctx),
      /ambiguous/,
    );
  });

  test("an unmatched prompt retains unknown attribution and still permits an honest report", async () => {
    const f = await fixture();
    await prepare(f.host, f.ctx, "prompt without ingress observation");
    await f.host.observe(f.ctx, "a1", "read", "observed result");
    const inspected = await inspect(f.host, f.ctx, "inspect-unknown");
    expect(inspected.current.request.attribution).toBe("unknown");
    expect(inspected.current.evidence.state).toBe("unknown-source");
    const reported = reportDetails(await f.host.call("report-unknown", reportArgs([
      { toolCallId: "a1", purpose: "observed call with unknown request source" },
    ], [], "insufficient", undefined, ["request source was not matched"]), f.ctx));
    expect(reported.work.request.attribution).toBe("unknown");
    expect(reported.authority).toBe("non-authoritative");
    expect(reported.modelDeclared.limitations).toEqual(["request source was not matched"]);
  });

  test("stop reminders require observed tool work, respect the deadline and stop after a report", async () => {
    let now = 1000;
    const f = await fixture({ now: () => now, reminderDeadlineMs: 1000 });
    await input(f.host, f.ctx, "tool request");
    await prepare(f.host, f.ctx, "tool request");
    await f.host.observe(f.ctx, "a1", "read", "observed");
    expect((await stop(f.host, f.ctx))?.continue).toBe(true);
    expect((await stop(f.host, f.ctx))?.continue).not.toBe(true);
    expect((await prepare(f.host, f.ctx, "tool request"))?.systemPrompt?.join("\n")).toContain(NATIVE_WORK_GUIDANCE);
    expect((await stop(f.host, f.ctx))?.continue).not.toBe(true);

    let expiredNow = 1000;
    const expired = await fixture({ now: () => expiredNow, reminderDeadlineMs: 1000 });
    await input(expired.host, expired.ctx, "expired request");
    await prepare(expired.host, expired.ctx, "expired request");
    await expired.host.observe(expired.ctx, "b1", "read", "observed");
    expiredNow = 2001;
    expect((await stop(expired.host, expired.ctx))?.continue).not.toBe(true);

    const reported = await fixture();
    await input(reported.host, reported.ctx, "reported request");
    await prepare(reported.host, reported.ctx, "reported request");
    await reported.host.observe(reported.ctx, "c1", "read", "observed");
    reportDetails(await reported.host.call("report-stop", reportArgs([
      { toolCallId: "c1", purpose: "checked work" },
    ]), reported.ctx));
    expect((await stop(reported.host, reported.ctx))?.continue).not.toBe(true);
  });

  test("agent_end continuation flags keep the work active until a terminal settle", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "continuation request");
    await prepare(f.host, f.ctx, "continuation request");
    await f.host.observe(f.ctx, "a1", "read", "result");
    await f.host.emit("agent_end", { messages: [], willContinue: true }, f.ctx);
    expect((await inspect(f.host, f.ctx, "inspect-after-nonterminal")).current.status).toBe("active");
    await f.host.emit("agent_end", { messages: [], willContinue: true, awaitingAsyncWork: true }, f.ctx);
    expect((await inspect(f.host, f.ctx, "inspect-after-async")).current.status).toBe("active");
    reportDetails(await f.host.call("report-continuation", reportArgs([
      { toolCallId: "a1", purpose: "checked the continuation work" },
    ]), f.ctx));
    await terminalEnd(f.host, f.ctx);
    const final = await inspect(f.host, f.ctx, "inspect-after-terminal");
    expect(final.current.status).toBe("ended");
    expect(final.current.reportState).toBe("reported");
  });

  test("terminal end before the stop pass reopens only the same work generation for finalization", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "finalization request");
    await prepare(f.host, f.ctx, "finalization request");
    await f.host.observe(f.ctx, "a1", "read", "observed result");
    const before = await inspect(f.host, f.ctx, "inspect-before-finalization");
    await terminalEnd(f.host, f.ctx);
    const ended = await inspect(f.host, f.ctx, "inspect-ended-before-stop");
    expect(ended.current.status).toBe("ended");

    const reminder = await stop(f.host, f.ctx);
    expect(reminder?.continue).toBe(true);
    const reopened = await inspect(f.host, f.ctx, "inspect-reopened");
    expect(reopened.current.observationId).toBe(before.current.observationId);
    expect(reopened.current.status).toBe("active");
    expect(reopened.current.reminder.used).toBe(true);

    const reported = reportDetails(await f.host.call("report-finalization", reportArgs([
      { toolCallId: "a1", purpose: "finalization check" },
    ]), f.ctx));
    expect(reported.work.observationId).toBe(before.current.observationId);
    expect((await stop(f.host, f.ctx))?.continue).not.toBe(true);
  });

  test("own stop reminder prepare preserves the original work generation for report", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "create and check alpha");
    await prepare(f.host, f.ctx, "create and check alpha");
    await f.host.observe(f.ctx, "a0", "write", "wrote alpha.txt");
    await f.host.observe(f.ctx, "a1", "bash", "CHECK_ALPHA", { details: { exitCode: 0 } });
    await f.host.call("a2", { action: "inspect" }, f.ctx);
    const before = await inspect(f.host, f.ctx, "inspect-before-own-reminder");

    const reminder = await stop(f.host, f.ctx);
    expect(reminder?.continue).toBe(true);
    const reminderText = reminder!.additionalContext!;
    expect(reminderText).toContain("one-time advisory");
    await f.host.emit("agent_end", { messages: [], willContinue: true }, f.ctx);

    const prepared = await prepare(f.host, f.ctx, reminderText);
    expect(prepared?.systemPrompt?.join("\n")).toContain(NATIVE_WORK_GUIDANCE);
    const after = await inspect(f.host, f.ctx, "inspect-after-own-reminder");
    expect(after.current.observationId).toBe(before.current.observationId);
    expect(after.current.generation).toBe(before.current.generation);
    expect(after.current.calls.filter((call: any) => call.toolName !== AGENT_WORK).map((call: any) => call.toolCallId))
      .toEqual(["a0", "a1"]);
    expect(after.current.reminder.used).toBe(true);
    expect(after.current.request.excerpt).toBe("create and check alpha");

    const reported = reportDetails(await f.host.call("report-own-reminder", reportArgs([
      { toolCallId: "a1", purpose: "original shell check after the advisory" },
    ], [], "completed", "reported the original check"), f.ctx));
    expect(reported.work.observationId).toBe(before.current.observationId);
    expect(reported.observed.checks.map((check) => check.toolCallId)).toEqual(["a1"]);
  });

  test("repeated own reminder preparations keep one generation and no extra reminder", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "repeatable own reminder request");
    await prepare(f.host, f.ctx, "repeatable own reminder request");
    await f.host.observe(f.ctx, "a1", "read", "observed");
    const before = await inspect(f.host, f.ctx, "inspect-before-repeat-own-reminder");

    const reminder = await stop(f.host, f.ctx);
    expect(reminder?.continue).toBe(true);
    const reminderText = reminder!.additionalContext!;
    await f.host.emit("agent_end", { messages: [], willContinue: true }, f.ctx);

    await prepare(f.host, f.ctx, reminderText);
    const first = await inspect(f.host, f.ctx, "inspect-first-own-reminder");
    await prepare(f.host, f.ctx, reminderText);
    const second = await inspect(f.host, f.ctx, "inspect-second-own-reminder");

    expect(first.current.observationId).toBe(before.current.observationId);
    expect(second.current.observationId).toBe(before.current.observationId);
    expect(second.current.generation).toBe(before.current.generation);
    expect(second.current.calls.filter((call: any) => call.toolName !== AGENT_WORK)).toHaveLength(1);
    expect(second.current.reminder.used).toBe(true);
    expect((await stop(f.host, f.ctx))?.continue).not.toBe(true);

    const reported = reportDetails(await f.host.call("report-repeat-own-reminder", reportArgs([
      { toolCallId: "a1", purpose: "original check after repeated advisory prepare" },
    ]), f.ctx));
    expect(reported.work.observationId).toBe(before.current.observationId);
  });

  test("fresh ingress matching the own reminder text cannot reuse the advisory work", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "own reminder collision request");
    await prepare(f.host, f.ctx, "own reminder collision request");
    await f.host.observe(f.ctx, "a1", "read", "original observed result");
    const before = await inspect(f.host, f.ctx, "inspect-before-own-reminder-collision");

    const reminder = await stop(f.host, f.ctx);
    expect(reminder?.continue).toBe(true);
    const reminderText = reminder!.additionalContext!;
    await f.host.emit("agent_end", { messages: [], willContinue: true }, f.ctx);

    await input(f.host, f.ctx, reminderText);
    await prepare(f.host, f.ctx, reminderText);
    const after = await inspect(f.host, f.ctx, "inspect-after-own-reminder-collision");
    expect(after.current.observationId).not.toBe(before.current.observationId);
    expect(after.current.evidence.state).toBe("unavailable");
    expect(
      after.retainedWorks.items.find((item: any) => item.observationId === before.current.observationId)?.status,
    ).toBe("unknown");
    expectError(
      await f.host.call("report-own-reminder-collision", reportArgs([
        { toolCallId: "a1", purpose: "old advisory work must not be reused" },
      ]), f.ctx),
      /unavailable|not retained/,
    );
  });

  test("reminder-looking prompt without an issued association is not reused by content", async () => {
    const issued = await fixture();
    await input(issued.host, issued.ctx, "issue a reminder elsewhere");
    await prepare(issued.host, issued.ctx, "issue a reminder elsewhere");
    await issued.host.observe(issued.ctx, "x1", "read", "issued work result");
    const issuedReminder = await stop(issued.host, issued.ctx);
    expect(issuedReminder?.continue).toBe(true);
    const reminderText = issuedReminder!.additionalContext!;

    const f = await fixture();
    await input(f.host, f.ctx, "content-only request");
    await prepare(f.host, f.ctx, "content-only request");
    await f.host.observe(f.ctx, "a1", "read", "content-only result");
    const before = await inspect(f.host, f.ctx, "inspect-before-content-only-reminder");

    await prepare(f.host, f.ctx, reminderText);
    const after = await inspect(f.host, f.ctx, "inspect-after-content-only-reminder");
    expect(after.current.observationId).not.toBe(before.current.observationId);
    expect(
      after.retainedWorks.items.find((item: any) => item.observationId === before.current.observationId)?.status,
    ).toBe("unknown");
    expectError(
      await f.host.call("report-content-only-reminder", reportArgs([
        { toolCallId: "a1", purpose: "content alone is not an issued association" },
      ]), f.ctx),
      /unavailable|not retained/,
    );
  });

  test("navigation and a live workspace move clear the own advisory association", async () => {
    const navigation = await fixture();
    await input(navigation.host, navigation.ctx, "navigated advisory request");
    await prepare(navigation.host, navigation.ctx, "navigated advisory request");
    await navigation.host.observe(navigation.ctx, "n1", "read", "observed");
    const navBefore = await inspect(navigation.host, navigation.ctx, "inspect-before-navigation-advisory");
    const navReminder = await stop(navigation.host, navigation.ctx);
    expect(navReminder?.continue).toBe(true);
    const navText = navReminder!.additionalContext!;
    await navigation.host.emit("session_clear", {}, navigation.ctx);
    const cleared = await inspect(navigation.host, navigation.ctx, "inspect-after-navigation-advisory");
    expect(cleared.current).toBeNull();

    await prepare(navigation.host, navigation.ctx, navText);
    const navAfter = await inspect(navigation.host, navigation.ctx, "inspect-navigation-advisory-reuse");
    expect(navAfter.current.observationId).not.toBe(navBefore.current.observationId);
    expect(
      navAfter.retainedWorks.items.find((item: any) => item.observationId === navBefore.current.observationId)?.status,
    ).toBe("unknown");
    expectError(
      await navigation.host.call("report-navigation-advisory", reportArgs([
        { toolCallId: "n1", purpose: "old navigated advisory work" },
      ]), navigation.ctx),
      /unavailable|not retained/,
    );

    const moved = await fixture();
    await input(moved.host, moved.ctx, "moved advisory request");
    await prepare(moved.host, moved.ctx, "moved advisory request");
    await moved.host.observe(moved.ctx, "m1", "read", "observed");
    const moveBefore = await inspect(moved.host, moved.ctx, "inspect-before-move-advisory");
    const moveReminder = await stop(moved.host, moved.ctx);
    expect(moveReminder?.continue).toBe(true);
    const moveText = moveReminder!.additionalContext!;
    await moved.host.emit("agent_end", { messages: [], willContinue: true }, moved.ctx);
    const other = path.join(moved.root, "moved-after-advisory");
    await mkdir(other, { mode: 0o700 });
    moved.setLiveCwd(other);

    await prepare(moved.host, moved.ctx, moveText);
    const moveAfter = await inspect(moved.host, moved.ctx, "inspect-move-advisory-reuse");
    expect(moveAfter.current.observationId).not.toBe(moveBefore.current.observationId);
    expect(
      moveAfter.retainedWorks.items.find((item: any) => item.observationId === moveBefore.current.observationId)?.status,
    ).toBe("unknown");
    expectError(
      await moved.host.call("report-move-advisory", reportArgs([
        { toolCallId: "m1", purpose: "old moved advisory work" },
      ]), moved.ctx),
      /unavailable|not retained/,
    );
  });

  test("queued ingress or an expired deadline prevents own advisory reuse", async () => {
    const queued = await fixture();
    await input(queued.host, queued.ctx, "queued advisory request");
    await prepare(queued.host, queued.ctx, "queued advisory request");
    await queued.host.observe(queued.ctx, "q1", "read", "observed");
    const queuedBefore = await inspect(queued.host, queued.ctx, "inspect-before-queued-advisory");
    await input(queued.host, queued.ctx, "next queued request");
    const queuedReminder = await stop(queued.host, queued.ctx);
    expect(queuedReminder?.continue).toBe(true);
    const queuedText = queuedReminder!.additionalContext!;

    await prepare(queued.host, queued.ctx, queuedText);
    const queuedAfter = await inspect(queued.host, queued.ctx, "inspect-after-queued-advisory");
    expect(queuedAfter.current.observationId).not.toBe(queuedBefore.current.observationId);
    expect(queuedAfter.pendingInputs.count).toBe(1);
    expect(
      queuedAfter.retainedWorks.items.find((item: any) => item.observationId === queuedBefore.current.observationId)?.status,
    ).toBe("unknown");
    expectError(
      await queued.host.call("report-queued-advisory", reportArgs([
        { toolCallId: "q1", purpose: "queued batch advisory work" },
      ]), queued.ctx),
      /unavailable|not retained/,
    );

    let now = 1000;
    const expired = await fixture({ now: () => now, reminderDeadlineMs: 1000 });
    await input(expired.host, expired.ctx, "expired advisory request");
    await prepare(expired.host, expired.ctx, "expired advisory request");
    await expired.host.observe(expired.ctx, "e1", "read", "observed");
    const expiredBefore = await inspect(expired.host, expired.ctx, "inspect-before-expired-advisory");
    const expiredReminder = await stop(expired.host, expired.ctx);
    expect(expiredReminder?.continue).toBe(true);
    const expiredText = expiredReminder!.additionalContext!;
    await expired.host.emit("agent_end", { messages: [], willContinue: true }, expired.ctx);
    now = 2001;

    await prepare(expired.host, expired.ctx, expiredText);
    const expiredAfter = await inspect(expired.host, expired.ctx, "inspect-after-expired-advisory");
    expect(expiredAfter.current.observationId).not.toBe(expiredBefore.current.observationId);
    expect(
      expiredAfter.retainedWorks.items.find((item: any) => item.observationId === expiredBefore.current.observationId)?.status,
    ).toBe("unknown");
    expectError(
      await expired.host.call("report-expired-advisory", reportArgs([
        { toolCallId: "e1", purpose: "expired advisory work" },
      ]), expired.ctx),
      /unavailable|not retained/,
    );
  });

  test("a report preflight is refused once a different work generation is current", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "preflight request");
    await prepare(f.host, f.ctx, "preflight request");
    await f.host.observe(f.ctx, "a1", "read", "observed result");
    const params = reportArgs([{ toolCallId: "a1", purpose: "preflight-bound check" }]);
    await f.host.emit("tool_call", { toolCallId: "stale-report", toolName: AGENT_WORK, input: params }, f.ctx);
    await terminalEnd(f.host, f.ctx);
    await input(f.host, f.ctx, "next request");
    await prepare(f.host, f.ctx, "next request");
    const tool = f.host.tools.get(AGENT_WORK)!;
    expectError(
      await tool.execute("stale-report", params, undefined, undefined, f.ctx),
      /no longer the current live work/,
    );
  });

  test("tool result facts are bounded middleware observations and identity mismatches are unknown", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "fact request");
    await prepare(f.host, f.ctx, "fact request");
    await f.host.observe(f.ctx, "a1", "bash", "visible result", {
      details: { exitCode: 3, privateRawField: "SECRET-VALUE" },
    });
    await f.host.observe(f.ctx, "a2", "bash", "check failed", {
      isError: true,
      details: { exitCode: 1 },
    });
    await f.host.emit("tool_call", { toolCallId: "m1", toolName: "bash", input: {} }, f.ctx);
    await f.host.emit("tool_result", {
      toolCallId: "m1",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: "mismatched" }],
      isError: false,
    }, f.ctx);
    const inspected = await inspect(f.host, f.ctx, "inspect-identity");
    const mismatch = inspected.current.calls.find((call: any) => call.toolCallId === "m1");
    expect(mismatch.resultState).toBe("unknown");
    expect(mismatch.associationConflict).toBe(true);
    expectError(
      await f.host.call("report-mismatch", reportArgs([
        { toolCallId: "m1", purpose: "identity mismatch" },
      ]), f.ctx),
      /no completed observed result/,
    );

    const reported = reportDetails(await f.host.call("report-facts", reportArgs([
      { toolCallId: "a1", purpose: "run the reported check" },
      { toolCallId: "a2", purpose: "run a check that failed" },
    ], [], "insufficient", undefined, ["detail fields are not coverage"]), f.ctx));
    const check = reported.observed.checks[0]!;
    expect(check.observationScope).toBe("plugin-tool-result-after-middleware");
    expect(check.isErrorObserved).toBe(false);
    expect(check.exitCodeFromToolDetails).toBe(3);
    expect(check.resultExcerpt).toBe("visible result");
    expect(reported.observed.checks[1]?.isErrorObserved).toBe(true);
    expect(reported.observed.checks[1]?.exitCodeFromToolDetails).toBe(1);
    expect(reported.observed.coverage.observedErrorResults).toBe(1);
    expect(JSON.stringify(reported)).not.toContain("SECRET-VALUE");
    expect(reported.observed.coverage.unverified.join(" ")).toContain("not semantic proof");
    expect(reported.observed.coverage.unverified.join(" ")).toContain("failed observation");
    expect(reported.observed.coverage.unverified.join(" ")).toContain("not semantic validation");
  });

  test("report replay is immutable while conflicting repeats are refused", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "immutable request");
    await prepare(f.host, f.ctx, "immutable request");
    await f.host.observe(f.ctx, "a1", "read", "observed result");
    const params = reportArgs([
      { toolCallId: "a1", purpose: "original purpose" },
    ], [], "completed", "original summary", ["original limitation"]);
    const first = await f.host.call("report-immutable", params, f.ctx);
    const firstDetails = reportDetails(first);

    (params.checks as Array<{ purpose: string }>)[0]!.purpose = "mutated input";
    params.summary = "mutated input summary";
    (firstDetails.observed.checks[0]!).purpose = "mutated return";
    firstDetails.modelDeclared.limitations.push("mutated return limitation");

    const replay = reportDetails(await f.host.call("report-replay", reportArgs([
      { toolCallId: "a1", purpose: "original purpose" },
    ], [], "completed", "original summary", ["original limitation"]), f.ctx));
    expect(replay.observed.checks[0]?.purpose).toBe("original purpose");
    expect(replay.modelDeclared.summary).toBe("original summary");
    expect(replay.modelDeclared.limitations).toEqual(["original limitation"]);

    expectError(
      await f.host.call("report-conflict", reportArgs([
        { toolCallId: "a1", purpose: "original purpose" },
      ], [], "completed", "different summary", ["original limitation"]), f.ctx),
      /cannot be rewritten/,
    );
    const inspected = await inspect(f.host, f.ctx, "inspect-immutable");
    expect(inspected.current.report.modelDeclared.summary).toBe("original summary");
    expect(inspected.current.report.observed.checks[0].purpose).toBe("original purpose");
  });

  test("agent_work report routing ids cannot be reused across works or after work eviction", async () => {
    const retained = await fixture();
    await input(retained.host, retained.ctx, "report reuse A");
    await prepare(retained.host, retained.ctx, "report reuse A");
    const retainedOldParams = reportArgs([], [], "insufficient", "old A report", ["A was not checked"]);
    await retained.host.emit("tool_call", {
      toolCallId: "report-reused",
      toolName: AGENT_WORK,
      input: retainedOldParams,
    }, retained.ctx);
    await terminalEnd(retained.host, retained.ctx);
    await input(retained.host, retained.ctx, "report reuse B");
    await prepare(retained.host, retained.ctx, "report reuse B");
    await retained.host.emit("tool_call", {
      toolCallId: "report-reused",
      toolName: AGENT_WORK,
      input: reportArgs([], [], "insufficient", "B report", ["B was not checked"]),
    }, retained.ctx);

    const retainedTool = retained.host.tools.get(AGENT_WORK)!;
    expectError(
      await retainedTool.execute("report-reused", retainedOldParams, undefined, undefined, retained.ctx),
      /preflight|ambiguous|conflict|overwrite|evict/,
    );
    const retainedInspect = await inspect(retained.host, retained.ctx, "inspect-report-reuse");
    expect(retainedInspect.current.reportState).toBe("not-reported");
    expect(
      retainedInspect.current.calls.find((call: any) => call.toolCallId === "report-reused").associationConflict,
    ).toBe(true);
    const valid = reportDetails(await retained.host.call("report-reuse-valid", reportArgs(
      [], [], "insufficient", "B report", ["B was not checked"],
    ), retained.ctx));
    expect(valid.work.request.excerpt).toBe("report reuse B");
    expect(valid.modelDeclared.summary).toBe("B report");

    const evicted = await fixture({ maxRetainedWorks: 1 });
    await input(evicted.host, evicted.ctx, "evicted reuse A");
    await prepare(evicted.host, evicted.ctx, "evicted reuse A");
    const evictedOldParams = reportArgs([], [], "insufficient", "evicted A report", ["A was not checked"]);
    await evicted.host.emit("tool_call", {
      toolCallId: "report-evicted-reuse",
      toolName: AGENT_WORK,
      input: evictedOldParams,
    }, evicted.ctx);
    await terminalEnd(evicted.host, evicted.ctx);
    await input(evicted.host, evicted.ctx, "evicted reuse B");
    await prepare(evicted.host, evicted.ctx, "evicted reuse B");
    await evicted.host.emit("tool_call", {
      toolCallId: "report-evicted-reuse",
      toolName: AGENT_WORK,
      input: reportArgs([], [], "insufficient", "evicted B report", ["B was not checked"]),
    }, evicted.ctx);

    const evictedTool = evicted.host.tools.get(AGENT_WORK)!;
    expectError(
      await evictedTool.execute("report-evicted-reuse", evictedOldParams, undefined, undefined, evicted.ctx),
      /preflight|ambiguous|conflict|overwrite|evict/,
    );
    const evictedInspect = await inspect(evicted.host, evicted.ctx, "inspect-report-evicted-reuse");
    expect(evictedInspect.retainedWorks.count).toBe(1);
    expect(evictedInspect.current.reportState).toBe("not-reported");
    expect(
      evictedInspect.current.calls.find((call: any) => call.toolCallId === "report-evicted-reuse").associationConflict,
    ).toBe(true);
  });

  test("report routing ids evicted from retained calls cannot regain a binding", async () => {
    const f = await fixture({ maxCallsPerWork: 2 });
    await input(f.host, f.ctx, "report call eviction");
    await prepare(f.host, f.ctx, "report call eviction");
    const params = reportArgs([], [], "insufficient", "dropped report", ["no checks"]);
    const reportId = "report-call-evicted";
    await f.host.emit("tool_call", { toolCallId: reportId, toolName: AGENT_WORK, input: params }, f.ctx);
    await f.host.emit("tool_call", { toolCallId: "later-1", toolName: "read", input: {} }, f.ctx);
    await f.host.emit("tool_call", { toolCallId: "later-2", toolName: "read", input: {} }, f.ctx);
    await f.host.emit("tool_call", { toolCallId: reportId, toolName: AGENT_WORK, input: params }, f.ctx);

    const tool = f.host.tools.get(AGENT_WORK)!;
    expectError(
      await tool.execute(reportId, params, undefined, undefined, f.ctx),
      /preflight|ambiguous|conflict|retained|evict/,
    );
    const inspected = await inspect(f.host, f.ctx, "inspect-report-call-evicted");
    expect(inspected.current.reportState).toBe("not-reported");
    const call = inspected.current.calls.find((item: any) => item.toolCallId === reportId);
    expect(call.associationConflict).toBe(true);
    expect(call.selectable).toBe(false);
    expect(call.unknownReason).toContain("no longer retained");
  });

  test("agent_work report routing identity conflicts stay refused through duplicate preflight", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "report routing identity conflict");
    await prepare(f.host, f.ctx, "report routing identity conflict");
    const params = reportArgs([], [], "insufficient", "must not record", ["conflicted routing"]);
    const reportId = "report-routing-conflict";
    await f.host.emit("tool_call", { toolCallId: reportId, toolName: AGENT_WORK, input: params }, f.ctx);
    await f.host.emit("tool_result", {
      toolCallId: reportId,
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: "wrong identity on the report routing id" }],
      isError: false,
    }, f.ctx);

    const tool = f.host.tools.get(AGENT_WORK)!;
    expectError(
      await tool.execute(reportId, params, undefined, undefined, f.ctx),
      /preflight|ambiguous|conflict|no matching/,
    );
    await f.host.emit("tool_result", {
      toolCallId: reportId,
      toolName: AGENT_WORK,
      input: {},
      content: [{ type: "text", text: "late matching identity" }],
      isError: false,
    }, f.ctx);
    await f.host.emit("tool_call", { toolCallId: reportId, toolName: AGENT_WORK, input: params }, f.ctx);
    expectError(
      await tool.execute(reportId, params, undefined, undefined, f.ctx),
      /preflight|ambiguous|conflict|no matching/,
    );

    const inspected = await inspect(f.host, f.ctx, "inspect-report-routing-conflict");
    expect(inspected.current.reportState).toBe("not-reported");
    const call = inspected.current.calls.find((item: any) => item.toolCallId === reportId);
    expect(call.associationConflict).toBe(true);
    expect(call.selectable).toBe(false);
  });

  test("agent_work report routing conflict during output observation is refused", async () => {
    let inject: (() => void) | undefined;
    const io: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        return {
          stat: (options: any) => handle.stat(options),
          close: () => handle.close(),
          async read(...args: any[]) {
            const result = await (handle.read as any)(...args);
            const current = inject;
            inject = undefined;
            current?.();
            return result;
          },
        };
      },
    };
    const f = await fixture({ fileIo: io });
    await input(f.host, f.ctx, "report routing await conflict");
    await prepare(f.host, f.ctx, "report routing await conflict");
    await writeFile(path.join(f.workspace, "output.txt"), "observed content\n", "utf8");
    const params = reportArgs([], ["output.txt"], "insufficient", "must not record", [
      "routing changed while observing outputs",
    ]);
    const reportId = "report-routing-await";
    await f.host.emit("tool_call", { toolCallId: reportId, toolName: AGENT_WORK, input: params }, f.ctx);
    inject = () => f.host.emitSync("tool_result", {
      toolCallId: reportId,
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: "conflicting identity during output await" }],
      isError: false,
    }, f.ctx);

    const tool = f.host.tools.get(AGENT_WORK)!;
    let result: NativeToolResult | undefined;
    let thrown: unknown;
    try {
      result = await tool.execute(reportId, params, undefined, undefined, f.ctx);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
    expectError(result!, /preflight|ambiguous|conflict|overwrite|evict/);
    expect((result!.details as any).kind).toBe("native-work-error");

    const inspected = await inspect(f.host, f.ctx, "inspect-report-routing-await");
    expect(inspected.current.reportState).toBe("not-reported");
    const call = inspected.current.calls.find((item: any) => item.toolCallId === reportId);
    expect(call.associationConflict).toBe(true);
    expect(call.selectable).toBe(false);
  });

  test("ordinary repeated report preflights keep the exact live binding", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "repeatable report");
    await prepare(f.host, f.ctx, "repeatable report");
    const params = reportArgs([], [], "insufficient", "repeatable summary", ["repeatable limitation"]);
    const reordered: Record<string, unknown> = {
      limitations: ["repeatable limitation"],
      summary: "repeatable summary",
      outcome: "insufficient",
      outputFiles: [],
      checks: [],
      action: "report",
    };
    const reportId = "report-repeat";
    const tool = f.host.tools.get(AGENT_WORK)!;
    await f.host.emit("tool_call", { toolCallId: reportId, toolName: AGENT_WORK, input: params }, f.ctx);
    await f.host.emit("tool_call", { toolCallId: reportId, toolName: AGENT_WORK, input: reordered }, f.ctx);
    const first = reportDetails(await tool.execute(reportId, params, undefined, undefined, f.ctx));
    expect(first.modelDeclared.summary).toBe("repeatable summary");

    await f.host.emit("tool_call", { toolCallId: reportId, toolName: AGENT_WORK, input: reordered }, f.ctx);
    const duplicate = reportDetails(await tool.execute(reportId, params, undefined, undefined, f.ctx));
    expect(duplicate.recordedAt).toBe(first.recordedAt);
    expect(duplicate.modelDeclared.summary).toBe("repeatable summary");

    const inspected = await inspect(f.host, f.ctx, "inspect-report-repeat");
    expect(inspected.current.reportState).toBe("reported");
    expect(inspected.current.calls.filter((item: any) => item.toolCallId === reportId)).toHaveLength(1);

    const changed = reportArgs([], [], "insufficient", "different summary", ["repeatable limitation"]);
    await f.host.emit("tool_call", { toolCallId: reportId, toolName: AGENT_WORK, input: changed }, f.ctx);
    expectError(
      await tool.execute(reportId, changed, undefined, undefined, f.ctx),
      /preflight|ambiguous|conflict|no matching/,
    );
    const after = await inspect(f.host, f.ctx, "inspect-report-repeat-after");
    expect(after.current.report.modelDeclared.summary).toBe("repeatable summary");
  });

  test("own agent_work calls cannot be selected as checks", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "own call request");
    await prepare(f.host, f.ctx, "own call request");
    await f.host.observe(f.ctx, "a1", "read", "observed");
    await inspect(f.host, f.ctx, "inspect-own");
    expectError(
      await f.host.call("report-own", reportArgs([
        { toolCallId: "inspect-own", purpose: "own inspect call" },
      ]), f.ctx),
      /agent_work calls cannot be checks/,
    );
    reportDetails(await f.host.call("report-base", reportArgs([
      { toolCallId: "a1", purpose: "actual check" },
    ]), f.ctx));
  });

  test("valid output files expose only bytes, hash and an explicit non-provenance note", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "file request");
    await prepare(f.host, f.ctx, "file request");
    const content = "hello native work\n";
    await writeFile(path.join(f.workspace, "out.txt"), content, "utf8");
    const reported = reportDetails(await f.host.call("report-file", reportArgs([], ["out.txt"], "insufficient", undefined, [
      "no completed check was available",
    ]), f.ctx));
    expect(reported.observed.outputFiles).toHaveLength(1);
    const file = reported.observed.outputFiles[0]!;
    expect(file.relativePath).toBe("out.txt");
    expect(file.bytes).toBe(Buffer.byteLength(content));
    expect(file.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(file.note).toContain("bytes observed now");
    expect(file.note).toContain("not managed provenance");
    expect(reported.observed.coverage.selected).toBe(0);
    expect(reported.observed.coverage.unverified.join(" ")).toContain("No completed tool calls");
  });

  test("unsafe output paths, symlinks, nonregular files and size limits are refused", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "unsafe file request");
    await prepare(f.host, f.ctx, "unsafe file request");

    for (const invalid of ["", ".", "..", "../secret", "/etc/passwd", "a\\b", "a//b", "a/./b", "a/../b", "C:drive", "a/\0b"]) {
      expect(() => validateRelativePath(invalid)).toThrow(NativeFileError);
    }

    const outsideDir = path.join(f.root, "outside");
    await mkdir(outsideDir, { mode: 0o700 });
    await writeFile(path.join(outsideDir, "secret.txt"), "outside secret", "utf8");
    await symlink(path.join(outsideDir, "secret.txt"), path.join(f.workspace, "final-link.txt"));
    await symlink(outsideDir, path.join(f.workspace, "dir-link"));
    await mkdir(path.join(f.workspace, "directory"));
    expectError(
      await f.host.call("report-final-link", reportArgs([], ["final-link.txt"]), f.ctx),
      /regular non-link|refused/,
    );
    expectError(
      await f.host.call("report-dir-link", reportArgs([], ["dir-link/secret.txt"]), f.ctx),
      /link or non-directory|refused/,
    );
    expectError(
      await f.host.call("report-directory", reportArgs([], ["directory"]), f.ctx),
      /regular non-link|refused/,
    );

    await writeFile(path.join(f.workspace, "big.txt"), Buffer.alloc(MAX_OUTPUT_FILE_BYTES + 1, 97));
    expectError(
      await f.host.call("report-big", reportArgs([], ["big.txt"]), f.ctx),
      /exceeds/,
    );

    const fileNames: string[] = [];
    for (let index = 0; index < 5; index++) {
      const name = `total-${index}.txt`;
      fileNames.push(name);
      await writeFile(path.join(f.workspace, name), Buffer.alloc(240 * 1024, 97));
    }
    expect(240 * 1024 * 5).toBeGreaterThan(MAX_OUTPUT_TOTAL_BYTES);
    expectError(
      await f.host.call("report-total", reportArgs([], fileNames), f.ctx),
      /exceed/,
    );
  });

  test("file observation refuses same-inode pre-open changes, recreated final paths and changed parent identity", async () => {
    const unchanged = fileStats(2n, 5n, 1n, 20n, 21n);
    await expectChanged(observeWorkspaceFile("/ws", "out.txt", virtualIo({
      fileBefore: unchanged,
      fileOpened: fileStats(2n, 6n, 1n, 22n, 23n),
      fileAfter: fileStats(2n, 6n, 1n, 22n, 23n),
      fileAtPath: fileStats(2n, 6n, 1n, 22n, 23n),
    }), 123));

    await expectChanged(observeWorkspaceFile("/ws", "out.txt", virtualIo({
      fileBefore: unchanged,
      fileOpened: unchanged,
      fileAfter: unchanged,
      fileAtPath: fileStats(3n, 5n, 1n, 20n, 21n),
    }), 123));

    await expectChanged(observeWorkspaceFile("/ws", "out/result.txt", virtualIo({
      parentFirst: dirStats(20n, 1n, 30n, 31n),
      parentAfter: dirStats(21n, 1n, 32n, 33n),
      fileBefore: unchanged,
      fileOpened: unchanged,
      fileAfter: unchanged,
      fileAtPath: unchanged,
    }), 123));
  });

  test("reentrant host getters after an async file read withhold the report", async () => {
    let armed = false;
    let fired = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        return {
          stat: (options) => handle.stat(options),
          close: () => handle.close(),
          async read(buffer, offset, length, position) {
            const result = await handle.read(buffer, offset, length, position);
            armed = true;
            return result;
          },
        };
      },
    };
    const f = await fixture({ fileIo: io });
    const originalGetSession = f.ctx.sessionManager!.getSessionId;
    const originalGetCwd = f.ctx.sessionManager!.getCwd;
    f.ctx.sessionManager = {
      getSessionId() {
        if (armed && !fired) {
          fired = true;
          f.host.emitSync("session_switch", { reason: "resume" }, f.ctx);
        }
        return originalGetSession.call(f.ctx.sessionManager);
      },
      getCwd: () => originalGetCwd.call(f.ctx.sessionManager),
    };
    await input(f.host, f.ctx, "race request");
    await prepare(f.host, f.ctx, "race request");
    await f.host.observe(f.ctx, "a1", "read", "observed");
    await writeFile(path.join(f.workspace, "race.txt"), "race content", "utf8");
    const params = reportArgs([{ toolCallId: "a1", purpose: "race check" }], ["race.txt"]);
    await f.host.emit("tool_call", { toolCallId: "race-report", toolName: AGENT_WORK, input: params }, f.ctx);
    const tool = f.host.tools.get(AGENT_WORK)!;
    const result = await tool.execute("race-report", params, undefined, undefined, f.ctx);
    expectError(result, /association changed|session|workspace/);
    expect((result.details as any).kind).toBe("native-work-error");
    const inspected = await inspect(f.host, f.ctx, "inspect-race");
    expect(inspected.current).toBeNull();
    expect(inspected.retainedWorks.items[0]?.status).toBe("unknown");
  });

  test("bounded retention drops old work and calls and forgotten ids cannot be selected", async () => {
    const f = await fixture({
      maxRetainedWorks: 2,
      maxCallsPerWork: 2,
      maxPendingInputs: 2,
    });
    await input(f.host, f.ctx, "one");
    await prepare(f.host, f.ctx, "one");
    await f.host.observe(f.ctx, "a1", "read", "one-a");
    await terminalEnd(f.host, f.ctx);

    await input(f.host, f.ctx, "two");
    await prepare(f.host, f.ctx, "two");
    await f.host.observe(f.ctx, "b1", "read", "two-a");
    await terminalEnd(f.host, f.ctx);

    await input(f.host, f.ctx, "three");
    await input(f.host, f.ctx, "four");
    await input(f.host, f.ctx, "five");
    await input(f.host, f.ctx, "six");
    await prepare(f.host, f.ctx, "six");
    await f.host.observe(f.ctx, "c1", "read", "three-a");
    await f.host.observe(f.ctx, "c2", "read", "three-b");
    await f.host.observe(f.ctx, "c3", "read", "three-c");

    const inspected = await inspect(f.host, f.ctx, "inspect-bounded");
    expect(inspected.retainedWorks.count).toBe(2);
    expect(inspected.retainedWorks.dropped).toBe(1);
    expect(inspected.current.calls).toHaveLength(2);
    expect(inspected.current.callsDropped).toBe(2);
    expect(inspected.pendingInputs.count).toBe(1);
    expect(inspected.pendingInputs.dropped).toBe(2);
    expectError(
      await f.host.call("report-forgotten", reportArgs([
        { toolCallId: "c1", purpose: "forgotten call" },
      ]), f.ctx),
      /not retained/,
    );
  });

  test("dispose and main-session shutdown disable hooks and tool effects", async () => {
    const disposed = await fixture();
    await input(disposed.host, disposed.ctx, "dispose request");
    await prepare(disposed.host, disposed.ctx, "dispose request");
    disposed.entry.dispose();
    expect(disposed.entry.isEnabled()).toBe(false);
    expect(await prepare(disposed.host, disposed.ctx, "dispose request")).toBeUndefined();
    expectError(await disposed.host.call("disposed-inspect", { action: "inspect" }, disposed.ctx), /disabled/);

    const shutdown = await fixture();
    await shutdown.host.emit("session_shutdown", {}, shutdown.ctx);
    expect(shutdown.entry.isEnabled()).toBe(false);
    expect(await prepare(shutdown.host, shutdown.ctx, "after shutdown")).toBeUndefined();
  });

  test("ordinary tool_call hooks do not block or revise native calls", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "native call request");
    await prepare(f.host, f.ctx, "native call request");
    const result = await f.host.emit("tool_call", {
      toolCallId: "native-1",
      toolName: "bash",
      input: { command: "printf ok" },
    }, f.ctx);
    expect(result).toBeUndefined();
    expect(f.entry.isEnabled()).toBe(true);
  });

  test("reused call ids across work generations never acquire fresh evidence", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "request A");
    await prepare(f.host, f.ctx, "request A");
    await f.host.emit("tool_call", { toolCallId: "same-id", toolName: "bash", input: {} }, f.ctx);
    await terminalEnd(f.host, f.ctx);

    await input(f.host, f.ctx, "request B");
    await prepare(f.host, f.ctx, "request B");
    await f.host.emit("tool_call", { toolCallId: "same-id", toolName: "bash", input: {} }, f.ctx);
    await f.host.emit("tool_result", {
      toolCallId: "same-id",
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: "LATE RESULT FROM REQUEST A" }],
      isError: false,
    }, f.ctx);

    const inspected = await inspect(f.host, f.ctx, "inspect-reused");
    const call = inspected.current.calls.find((item: any) => item.toolCallId === "same-id");
    expect(call.associationConflict).toBe(true);
    expect(call.selectable).toBe(false);
    expect(call.resultState).toBe("unknown");
    expect(call.resultExcerpt).toBeNull();
    expect(call.unknownReason).toContain("another work generation");
    expectError(
      await f.host.call("report-reused", reportArgs([
        { toolCallId: "same-id", purpose: "reused id must stay ambiguous" },
      ]), f.ctx),
      /no completed observed result/,
    );
    const afterReport = await inspect(f.host, f.ctx, "inspect-reused-after");
    expect(afterReport.current.reportState).toBe("not-reported");
    expect(afterReport.current.calls.find((item: any) => item.toolCallId === "same-id").selectable).toBe(false);

    await terminalEnd(f.host, f.ctx);
    await input(f.host, f.ctx, "request C");
    await prepare(f.host, f.ctx, "request C");
    // A wrapper may reuse the id with a different tool name. The result still
    // cannot establish which generation produced it.
    await f.host.emit("tool_call", { toolCallId: "same-id", toolName: "read", input: {} }, f.ctx);
    await f.host.emit("tool_result", {
      toolCallId: "same-id",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: "request C own result" }],
      isError: false,
    }, f.ctx);
    const third = await inspect(f.host, f.ctx, "inspect-reused-third");
    const thirdCall = third.current.calls.find((item: any) => item.toolCallId === "same-id");
    expect(thirdCall.associationConflict).toBe(true);
    expect(thirdCall.selectable).toBe(false);
    expect(thirdCall.resultExcerpt).toBeNull();
  });

  test("call ids evicted from visible retention cannot be reused as fresh evidence", async () => {
    const f = await fixture({ maxCallsPerWork: 3, maxRetainedWorks: 1 });
    await input(f.host, f.ctx, "one");
    await prepare(f.host, f.ctx, "one");
    await f.host.observe(f.ctx, "x", "read", "first x");
    await f.host.observe(f.ctx, "y", "read", "y");
    await f.host.observe(f.ctx, "z", "read", "z");
    await f.host.observe(f.ctx, "w", "read", "w");
    await f.host.emit("tool_call", { toolCallId: "x", toolName: "read", input: {} }, f.ctx);
    await f.host.emit("tool_result", {
      toolCallId: "x",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: "late x result" }],
      isError: false,
    }, f.ctx);

    const afterEviction = await inspect(f.host, f.ctx, "inspect-evicted-reuse");
    const evictedCall = afterEviction.current.calls.find((item: any) => item.toolCallId === "x");
    expect(evictedCall.associationConflict).toBe(true);
    expect(evictedCall.selectable).toBe(false);
    expect(evictedCall.unknownReason).toContain("no longer retained");
    expectError(
      await f.host.call("report-evicted-reuse", reportArgs([
        { toolCallId: "x", purpose: "evicted then reused" },
      ]), f.ctx),
      /no completed observed result/,
    );

    await terminalEnd(f.host, f.ctx);
    await input(f.host, f.ctx, "two");
    await prepare(f.host, f.ctx, "two");
    await f.host.observe(f.ctx, "z", "read", "new work z");
    const afterWorkDrop = await inspect(f.host, f.ctx, "inspect-work-drop-reuse");
    const droppedWorkCall = afterWorkDrop.current.calls.find((item: any) => item.toolCallId === "z");
    expect(droppedWorkCall.associationConflict).toBe(true);
    expect(droppedWorkCall.selectable).toBe(false);
    expect(droppedWorkCall.unknownReason).toContain("another work generation");
  });

  test("identity conflicts stay ambiguous after a later matching result", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "conflict request");
    await prepare(f.host, f.ctx, "conflict request");
    await f.host.emit("tool_call", { toolCallId: "check", toolName: "bash", input: {} }, f.ctx);
    await f.host.emit("tool_result", {
      toolCallId: "check",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: "wrong tool identity" }],
      isError: false,
    }, f.ctx);
    await f.host.emit("tool_result", {
      toolCallId: "check",
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: "late matching identity" }],
      isError: false,
    }, f.ctx);

    const inspected = await inspect(f.host, f.ctx, "inspect-sticky-conflict");
    const call = inspected.current.calls.find((item: any) => item.toolCallId === "check");
    expect(call.resultState).toBe("unknown");
    expect(call.associationConflict).toBe(true);
    expect(call.selectable).toBe(false);
    expect(call.resultExcerpt).toBeNull();
    expect(call.unknownReason).toMatch(/identity|does not match/);
    expectError(
      await f.host.call("report-sticky", reportArgs([
        { toolCallId: "check", purpose: "conflicted call" },
      ]), f.ctx),
      /no completed observed result/,
    );

    await f.host.emit("tool_call", { toolCallId: "check2", toolName: "bash", input: {} }, f.ctx);
    await f.host.emit("tool_call", { toolCallId: "check2", toolName: "read", input: {} }, f.ctx);
    await f.host.emit("tool_result", {
      toolCallId: "check2",
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: "matching preflight name is not enough" }],
      isError: false,
    }, f.ctx);
    const preflightConflict = (await inspect(f.host, f.ctx, "inspect-sticky-preflight"))
      .current.calls.find((item: any) => item.toolCallId === "check2");
    expect(preflightConflict.resultState).toBe("unknown");
    expect(preflightConflict.associationConflict).toBe(true);
    expect(preflightConflict.selectable).toBe(false);
    expect(preflightConflict.resultExcerpt).toBeNull();
  });

  test("selected evidence mutation during output observation is refused without throwing", async () => {
    let inject: (() => void) | undefined;
    const io: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        return {
          stat: (options: any) => handle.stat(options),
          close: () => handle.close(),
          async read(...args: any[]) {
            const result = await (handle.read as any)(...args);
            const current = inject;
            inject = undefined;
            current?.();
            return result;
          },
        };
      },
    };
    const f = await fixture({ fileIo: io });
    await input(f.host, f.ctx, "mutating report request");
    await prepare(f.host, f.ctx, "mutating report request");
    await f.host.observe(f.ctx, "check", "bash", "initial valid observation");
    await writeFile(path.join(f.workspace, "output.txt"), "observed content\n", "utf8");
    inject = () => f.host.emitSync("tool_result", {
      toolCallId: "check",
      toolName: "read",
      input: {},
      content: [{ type: "text", text: "conflict while observing files" }],
      isError: false,
    }, f.ctx);

    let result: NativeToolResult | undefined;
    let thrown: unknown;
    try {
      result = await f.host.call("report-mutation", reportArgs([
        { toolCallId: "check", purpose: "mutated during file read" },
      ], ["output.txt"]), f.ctx);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
    expectError(result!, /changed|ambiguous|selected/);
    expect((result!.details as any).kind).toBe("native-work-error");

    const inspected = await inspect(f.host, f.ctx, "inspect-mutation");
    expect(inspected.current.reportState).toBe("not-reported");
    const call = inspected.current.calls.find((item: any) => item.toolCallId === "check");
    expect(call.associationConflict).toBe(true);
    expect(call.selectable).toBe(false);
  });

  test("new same-text ingress is not silently treated as prepare reentry", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "same text");
    await prepare(f.host, f.ctx, "same text");
    await f.host.observe(f.ctx, "a1", "read", "first work result");
    const first = await inspect(f.host, f.ctx, "inspect-before-repeat");
    const firstId = first.current.observationId;

    await prepare(f.host, f.ctx, "same text");
    const repeated = await inspect(f.host, f.ctx, "inspect-policy-repeat");
    expect(repeated.current.observationId).toBe(firstId);
    expect(repeated.pendingInputs.count).toBe(0);

    await input(f.host, f.ctx, "same text");
    await prepare(f.host, f.ctx, "same text");
    const afterFreshIngress = await inspect(f.host, f.ctx, "inspect-fresh-ingress");
    expect(afterFreshIngress.current.observationId).not.toBe(firstId);
    expect(afterFreshIngress.current.request.attribution).toBe("unknown");
    expect(afterFreshIngress.current.request.excerpt).toBeNull();
    expect(afterFreshIngress.pendingInputs.count).toBe(0);
    expect(
      afterFreshIngress.retainedWorks.items.find((item: any) => item.observationId === firstId)?.status,
    ).toBe("unknown");
    expectError(
      await f.host.call("report-old-work-call", reportArgs([
        { toolCallId: "a1", purpose: "belongs to the old ambiguous work" },
      ]), f.ctx),
      /not retained/,
    );

    await f.host.observe(f.ctx, "b1", "read", "new work result");
    const reported = reportDetails(await f.host.call("report-fresh-ingress", reportArgs([
      { toolCallId: "b1", purpose: "new work observation with unknown request source" },
    ], [], "insufficient", undefined, ["same-text ingress was ambiguous"]), f.ctx));
    expect(reported.work.request.attribution).toBe("unknown");
  });

  test("bounded call-id uniqueness guard withholds new evidence and report routing when full", async () => {
    const f = await fixture({ maxRememberedCallIds: 2 });
    await input(f.host, f.ctx, "guard request");
    await prepare(f.host, f.ctx, "guard request");
    await f.host.observe(f.ctx, "a", "read", "a");
    await f.host.observe(f.ctx, "b", "read", "b");
    await f.host.observe(f.ctx, "c", "read", "c");

    const inspected = await inspect(f.host, f.ctx, "inspect-guard");
    expect(inspected.bounds.maxRememberedCallIds).toBe(2);
    expect(inspected.bounds.callIdMemorySaturated).toBe(true);
    const unverifiable = inspected.current.calls.find((item: any) => item.toolCallId === "c");
    expect(unverifiable.associationConflict).toBe(true);
    expect(unverifiable.selectable).toBe(false);
    expect(unverifiable.unknownReason).toContain("uniqueness guard is full");
    expectError(
      await f.host.call("report-unverifiable", reportArgs([
        { toolCallId: "c", purpose: "cannot prove uniqueness" },
      ]), f.ctx),
      /uniqueness|bounded|conflict|ambiguous|preflight/,
    );
    expectError(
      await f.host.call("report-after-saturation", reportArgs([
        { toolCallId: "a", purpose: "first retained call" },
        { toolCallId: "b", purpose: "second retained call" },
      ]), f.ctx),
      /uniqueness|bounded|conflict|ambiguous|preflight/,
    );
    const afterSaturation = await inspect(f.host, f.ctx, "inspect-guard-after-report");
    expect(afterSaturation.current.reportState).toBe("not-reported");

    // A report routing binding created while uniqueness was still provable
    // remains usable after the bounded memory fills.
    const early = await fixture({ maxRememberedCallIds: 3 });
    await input(early.host, early.ctx, "early guard request");
    await prepare(early.host, early.ctx, "early guard request");
    await early.host.observe(early.ctx, "a", "read", "a");
    const earlyParams = reportArgs([
      { toolCallId: "a", purpose: "pre-saturation retained call" },
    ]);
    await early.host.emit("tool_call", {
      toolCallId: "report-early",
      toolName: AGENT_WORK,
      input: earlyParams,
    }, early.ctx);
    await early.host.observe(early.ctx, "b", "read", "b");
    await early.host.observe(early.ctx, "c", "read", "c");
    const saturated = await inspect(early.host, early.ctx, "inspect-early-guard");
    expect(saturated.bounds.callIdMemorySaturated).toBe(true);
    const reported = reportDetails(await early.host.call("report-early", earlyParams, early.ctx));
    expect(reported.observed.checks).toHaveLength(1);
    expect(reported.observed.checks[0]?.toolCallId).toBe("a");
  });

  test("saturated uniqueness memory cannot be bypassed by new report routing ids", async () => {
    const f = await fixture({ maxRememberedCallIds: 2, maxRetainedWorks: 1 });
    await input(f.host, f.ctx, "saturated report reuse A");
    await prepare(f.host, f.ctx, "saturated report reuse A");
    await f.host.observe(f.ctx, "a", "read", "a");
    await f.host.observe(f.ctx, "b", "read", "b");
    const reportId = "report-saturated-reuse";
    const oldParams = reportArgs([], [], "insufficient", "old saturated report", ["A was not checked"]);
    await f.host.emit("tool_call", { toolCallId: reportId, toolName: AGENT_WORK, input: oldParams }, f.ctx);

    const tool = f.host.tools.get(AGENT_WORK)!;
    expectError(
      await tool.execute(reportId, oldParams, undefined, undefined, f.ctx),
      /uniqueness|bounded|conflict|ambiguous|preflight/,
    );
    await terminalEnd(f.host, f.ctx);
    await input(f.host, f.ctx, "saturated report reuse B");
    await prepare(f.host, f.ctx, "saturated report reuse B");
    await f.host.emit("tool_call", {
      toolCallId: reportId,
      toolName: AGENT_WORK,
      input: reportArgs([], [], "insufficient", "new saturated report", ["B was not checked"]),
    }, f.ctx);

    expectError(
      await tool.execute(reportId, oldParams, undefined, undefined, f.ctx),
      /uniqueness|bounded|conflict|ambiguous|preflight/,
    );
    const inspected = await inspect(f.host, f.ctx, "inspect-saturated-report-reuse");
    expect(inspected.current.reportState).toBe("not-reported");
    const call = inspected.current.calls.find((item: any) => item.toolCallId === reportId);
    expect(call.associationConflict).toBe(true);
    expect(call.selectable).toBe(false);
    expect(call.unknownReason).toContain("uniqueness guard is full");
  });

  test("session_clear invalidates current observations", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "clear request");
    await prepare(f.host, f.ctx, "clear request");
    await f.host.observe(f.ctx, "a1", "read", "before clear");
    await f.host.emit("session_clear", {}, f.ctx);

    const inspected = await inspect(f.host, f.ctx, "inspect-after-clear");
    expect(inspected.current).toBeNull();
    expect(inspected.retainedWorks.items[0]?.status).toBe("unknown");
    expect(inspected.retainedWorks.items[0]?.endReason).toContain("session clear");
    expectError(
      await f.host.call("report-after-clear", reportArgs([
        { toolCallId: "a1", purpose: "cleared work" },
      ]), f.ctx),
      /no matching tool_call preflight|not retained/,
    );
  });

  test("live getCwd move during output observation is refused even when ctx.cwd is stale", async () => {
    let onRead: (() => Promise<void>) | undefined;
    const io: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        return {
          stat: (options: any) => handle.stat(options),
          close: () => handle.close(),
          async read(...args: any[]) {
            const result = await (handle.read as any)(...args);
            const current = onRead;
            onRead = undefined;
            if (current !== undefined) await current();
            return result;
          },
        };
      },
    };
    const f = await fixture({ fileIo: io });
    await input(f.host, f.ctx, "move request");
    await prepare(f.host, f.ctx, "move request");
    await f.host.observe(f.ctx, "a1", "read", "observed");
    await writeFile(path.join(f.workspace, "move.txt"), "move content\n", "utf8");
    const other = path.join(f.root, "moved");
    onRead = async () => {
      await mkdir(other, { mode: 0o700 });
      f.setLiveCwd(other);
    };
    const capturedCwd = f.ctx.cwd;

    const result = await f.host.call("report-move", reportArgs([
      { toolCallId: "a1", purpose: "moved workspace" },
    ], ["move.txt"]), f.ctx);
    expectError(result, /session|workspace|association/);
    expect((result.details as any).kind).toBe("native-work-error");
    expect(f.ctx.cwd).toBe(capturedCwd);
    expect(f.ctx.sessionManager!.getCwd()).toBe(other);

    const inspected = await inspect(f.host, f.ctx, "inspect-after-move");
    expect(inspected.current).toBeNull();
    expect(inspected.retainedWorks.items[0]?.reportState).toBe("not-reported");
    expect(inspected.retainedWorks.items[0]?.status).toBe("unknown");
  });

  test("duplicate report replay refuses when a live getter moves the workspace", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "replay request");
    await prepare(f.host, f.ctx, "replay request");
    await f.host.observe(f.ctx, "a1", "read", "observed");
    const params = reportArgs([{ toolCallId: "a1", purpose: "replay check" }]);
    reportDetails(await f.host.call("report-first", params, f.ctx));

    const other = path.join(f.root, "replay-moved");
    await mkdir(other, { mode: 0o700 });
    const originalGetSession = f.ctx.sessionManager!.getSessionId;
    const originalGetCwd = f.ctx.sessionManager!.getCwd;
    let trigger = false;
    f.ctx.sessionManager = {
      getSessionId: () => originalGetSession(),
      getCwd: () => {
        const value = originalGetCwd();
        if (trigger) {
          trigger = false;
          f.setLiveCwd(other);
        }
        return value;
      },
    };
    await f.host.emit("tool_call", { toolCallId: "report-replay", toolName: AGENT_WORK, input: params }, f.ctx);
    trigger = true;
    const tool = f.host.tools.get(AGENT_WORK)!;
    const result = await tool.execute("report-replay", params, undefined, undefined, f.ctx);
    expectError(result, /session|workspace|association/);
    expect((result.details as any).kind).toBe("native-work-error");
  });

  test("duplicate report replay revalidates selected evidence instead of hiding a later conflict", async () => {
    const f = await fixture();
    await input(f.host, f.ctx, "duplicate conflict request");
    await prepare(f.host, f.ctx, "duplicate conflict request");
    await f.host.observe(f.ctx, "a1", "read", "observed");
    const params = reportArgs([{ toolCallId: "a1", purpose: "original check" }]);
    reportDetails(await f.host.call("report-original", params, f.ctx));

    await f.host.emit("tool_result", {
      toolCallId: "a1",
      toolName: "bash",
      input: {},
      content: [{ type: "text", text: "later conflicting identity" }],
      isError: false,
    }, f.ctx);

    expectError(
      await f.host.call("report-duplicate-conflict", reportArgs([
        { toolCallId: "a1", purpose: "original check" },
      ]), f.ctx),
      /no completed observed result/,
    );
    const inspected = await inspect(f.host, f.ctx, "inspect-duplicate-conflict");
    expect(inspected.current.reportState).toBe("reported");
    const call = inspected.current.calls.find((item: any) => item.toolCallId === "a1");
    expect(call.associationConflict).toBe(true);
    expect(call.selectable).toBe(false);
  });

  test("clock callback during report finalization cannot publish stale facts", async () => {
    let onNow: (() => void) | undefined;
    const f = await fixture({
      now: () => {
        const current = onNow;
        onNow = undefined;
        current?.();
        return 100;
      },
    });
    await input(f.host, f.ctx, "clock report request");
    await prepare(f.host, f.ctx, "clock report request");
    const params = reportArgs([], [], "insufficient", undefined, ["no checks selected"]);
    await f.host.emit("tool_call", { toolCallId: "report-clock", toolName: AGENT_WORK, input: params }, f.ctx);
    onNow = () => f.host.emitSync("session_clear", {}, f.ctx);

    const tool = f.host.tools.get(AGENT_WORK)!;
    const result = await tool.execute("report-clock", params, undefined, undefined, f.ctx);
    expectError(result, /session|workspace|association|cancelled/);
    expect((result.details as any).kind).toBe("native-work-error");

    const inspected = await inspect(f.host, f.ctx, "inspect-after-clock-report");
    expect(inspected.current).toBeNull();
    expect(inspected.retainedWorks.items[0]?.reportState).toBe("not-reported");
  });

  test("clock callback during inspect cannot show a cleared work as current", async () => {
    let armed = false;
    let fired = false;
    let calls = 0;
    const f = await fixture({
      now: () => {
        if (armed) {
          calls++;
          if (!fired && calls >= 2) {
            fired = true;
            f.host.emitSync("session_clear", {}, f.ctx);
          }
        }
        return 100;
      },
    });
    await input(f.host, f.ctx, "clock inspect request");
    await prepare(f.host, f.ctx, "clock inspect request");
    await f.host.observe(f.ctx, "a1", "read", "observed");
    armed = true;
    calls = 0;

    const inspected = await inspect(f.host, f.ctx, "inspect-clock");
    expect(inspected.current).toBeNull();
    expect(inspected.retainedWorks.items[0]?.status).toBe("unknown");
    expect(inspected.retainedWorks.items[0]?.endReason).toContain("session clear");
  });
});
