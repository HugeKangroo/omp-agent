import { describe, expect, test } from "bun:test";
import type { NativeContext, NativeToolResult } from "../../src/native-entry.ts";
import {
  createNativeHarnessEntry,
  MAX_NATIVE_HARNESS_TOOL_RESULT_BYTES,
  NATIVE_HARNESS_ENTRY_INSPECTION_SCHEMA,
  NATIVE_HARNESS_TOOL_RESULT_SCHEMA,
  type NativeHarnessEntry,
} from "../../src/native-harness-entry.ts";
import {
  NATIVE_HARNESS_DELEGATION_SCHEMA,
  NATIVE_HARNESS_MAX_TASK_BYTES,
  NATIVE_HARNESS_TOOL,
  type NativeHarnessDelegationCoordinator,
  type NativeHarnessDelegationResult,
  type NativeHarnessDelegationSnapshot,
} from "../../src/native-harness-delegation.ts";

const MAIN_CONTEXT: NativeContext = {
  cwd: "/workspace",
  agent: { kind: "main" },
  sessionManager: {
    getSessionId: () => "session-main",
    getCwd: () => "/workspace",
  },
};

const CHILD_CONTEXT: NativeContext = {
  ...MAIN_CONTEXT,
  agent: { kind: "sub" },
};

interface Invocation {
  readonly toolCallId: string;
  readonly input: unknown;
  readonly signal: unknown;
}

function sampleResult(overrides: Partial<NativeHarnessDelegationResult> = {}): NativeHarnessDelegationResult {
  return {
    schema: NATIVE_HARNESS_DELEGATION_SCHEMA,
    tool: NATIVE_HARNESS_TOOL,
    authority: "non-authoritative",
    resultKind: "live",
    historical: false,
    authorityFresh: true,
    outcome: "backend-completed",
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    association: {
      observationId: "observation-1",
      generation: 1,
      sessionId: "session-main",
      workspaceRoot: "/private/secret-workspace",
      toolCallId: "call-1",
      toolName: NATIVE_HARNESS_TOOL,
    },
    runId: "run-1",
    backendStatus: "completed",
    executionState: "settled",
    termination: "none",
    cancellation: "none",
    cancelError: null,
    deadlineAt: 1_000,
    elapsedMs: 12,
    cost: { allocatedUsd: 1, observedUsd: null, unknownUsd: 1, overspendUsd: 0 },
    limitations: ["controller-owned scheduling"],
    reason: "the Harness2 backend reported completion; task acceptance was not evaluated",
    ...overrides,
  };
}

function sampleSnapshot(): NativeHarnessDelegationSnapshot {
  return {
    schema: "omp-agent.native-harness-delegation-snapshot.v1",
    enabled: true,
    disposed: false,
    limits: {
      maxRetainedOperations: 16,
      maxConcurrent: 1,
      perRunUsd: 1,
      lifetimeUsd: 5,
      maxDurationMs: 300_000,
      cleanupGraceMs: 30_000,
    },
    retainedOperations: 0,
    activeOperations: 0,
    lifetime: {
      limitUsd: 5,
      accountedUsd: 0,
      observedUsd: 0,
      unknownUsd: 0,
      overspendUsd: 0,
      budgetBlocked: false,
    },
    operations: [],
  };
}

interface HarnessFixture {
  entry: NativeHarnessEntry;
  readonly invocations: Invocation[];
  readonly scopes: { context: NativeContext; toolCallId: string }[];
  result: NativeHarnessDelegationResult;
  refuse: string | null;
  throwCoordinator: boolean;
  coordinatorCalls: number;
}

function fixture(): HarnessFixture {
  const invocations: Invocation[] = [];
  const scopes: { context: NativeContext; toolCallId: string }[] = [];
  const fixtureState: HarnessFixture = {
    entry: null as unknown as NativeHarnessEntry,
    invocations,
    scopes,
    result: sampleResult(),
    refuse: null,
    throwCoordinator: false,
    coordinatorCalls: 0,
  };
  const coordinator = {
    invoke(toolCallId: string, input: unknown, signal: unknown): Promise<NativeHarnessDelegationResult> {
      fixtureState.coordinatorCalls += 1;
      fixtureState.invocations.push({ toolCallId, input, signal });
      if (fixtureState.throwCoordinator) throw new Error("/private/secret path failure");
      return Promise.resolve(fixtureState.result);
    },
    inspect(): NativeHarnessDelegationSnapshot {
      return sampleSnapshot();
    },
    dispose(): void {},
    get enabled(): boolean {
      return true;
    },
    get disposed(): boolean {
      return false;
    },
  } as unknown as NativeHarnessDelegationCoordinator;
  fixtureState.entry = createNativeHarnessEntry({
    resolveRoot(context: NativeContext) {
      if (fixtureState.refuse !== null) return { ok: false, reason: fixtureState.refuse };
      return {
        ok: true,
        root: {
          coordinator,
          runWithContext<T>(scoped: NativeContext, toolCallId: string, operation: () => Promise<T>): Promise<T> {
            fixtureState.scopes.push({ context: scoped, toolCallId });
            return operation();
          },
          diagnostics: () => ["backend-diagnostic"],
        },
      };
    },
  });
  return fixtureState;
}

function details(result: NativeToolResult): Record<string, any> {
  return result.details as Record<string, any>;
}

function expectRefused(result: NativeToolResult, pattern: RegExp): void {
  expect(result.isError).toBe(true);
  expect(details(result).resultKind).toBe("refused");
  expect(details(result).taskAccepted).toBe(false);
  expect(details(result).semanticAcceptance).toBe("not-evaluated");
  expect(String(details(result).reason)).toMatch(pattern);
}

describe("native harness tool adapter", () => {
  test("registers bounded task-only exec metadata", async () => {
    const state = fixture();
    const tool = state.entry.tool;
    expect(tool.name).toBe("agent_harness");
    expect(tool.approval).toBe("exec");
    expect(tool.loadMode).toBe("discoverable");
    expect(tool.defaultInactive).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["task"],
      additionalProperties: false,
    });
    const properties = tool.parameters.properties as Record<string, any>;
    expect(properties.task.type).toBe("string");
    expect(Object.keys(properties)).toEqual(["task"]);
  });

  test("refuses malformed, extra, accessor and inherited task input before any resolver effect", async () => {
    const state = fixture();
    const signal = new AbortController().signal;
    const inherited = Object.create({ task: "inherited" }) as Record<string, unknown>;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "task", {
      enumerable: true,
      get() {
        return "getter";
      },
    });
    const hidden: Record<string, unknown> = {};
    Object.defineProperty(hidden, "task", {
      enumerable: false,
      value: "hidden",
    });
    const cases: unknown[] = [
      null,
      "task string is not the exact object",
      [],
      {},
      { task: 1 },
      { task: "ok", extra: true },
      inherited,
      accessor,
      hidden,
      { task: "   " },
      { task: "bad\0task" },
      { task: "a".repeat(NATIVE_HARNESS_MAX_TASK_BYTES + 1) },
    ];
    for (const params of cases) {
      const result = await state.entry.tool.execute("call-1", params, signal, undefined, MAIN_CONTEXT);
      expectRefused(result, /agent_harness|task/);
    }
    expect(state.scopes).toHaveLength(0);
    expect(state.coordinatorCalls).toBe(0);
  });

  test("passes the original call id, parsed task and actual signal through the scoped root", async () => {
    const state = fixture();
    const controller = new AbortController();
    const result = await state.entry.tool.execute(
      "actual-call-9",
      { task: "implement the bounded task" },
      controller.signal,
      undefined,
      MAIN_CONTEXT,
    );
    expect(result.isError).toBeUndefined();
    expect(state.scopes).toEqual([{ context: MAIN_CONTEXT, toolCallId: "actual-call-9" }]);
    expect(state.invocations).toHaveLength(1);
    expect(state.invocations[0]!.toolCallId).toBe("actual-call-9");
    expect(state.invocations[0]!.input).toBe("implement the bounded task");
    expect(state.invocations[0]!.signal).toBe(controller.signal);
    expect(details(result).schema).toBe(NATIVE_HARNESS_TOOL_RESULT_SCHEMA);
    expect(details(result).taskAccepted).toBe(false);
    expect(details(result).semanticAcceptance).toBe("not-evaluated");
    expect(details(result).runId).toBe("run-1");
    expect(details(result).outcome).toBe("backend-completed");
  });

  test("does not expose the coordinator association, workspace paths or backend raw result", async () => {
    const state = fixture();
    state.result = sampleResult({
      reason: "preparation failed below /private/secret-workspace/input.txt",
    });
    const result = await state.entry.tool.execute(
      "call-1",
      { task: "bounded task" },
      new AbortController().signal,
      undefined,
      MAIN_CONTEXT,
    );
    const text = result.content[0]!.text;
    expect(text).not.toContain("/private/secret-workspace");
    expect(text).not.toContain("observationId");
    expect(details(result).reason).toContain("[path]");
    const projected = details(result);
    expect(projected.association).toBeUndefined();
    expect(projected.workspaceRoot).toBeUndefined();
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_NATIVE_HARNESS_TOOL_RESULT_BYTES);
  });

  test("bounds resolver refusal, missing/aborted signals and child context as isError", async () => {
    const state = fixture();
    state.refuse = "the Harness capability is not explicitly selected";
    let result = await state.entry.tool.execute(
      "call-1",
      { task: "bounded task" },
      new AbortController().signal,
      undefined,
      MAIN_CONTEXT,
    );
    expectRefused(result, /explicitly selected/);
    expect(state.coordinatorCalls).toBe(0);

    state.refuse = null;
    result = await state.entry.tool.execute("call-2", { task: "bounded task" }, undefined, undefined, MAIN_CONTEXT);
    expectRefused(result, /AbortSignal/);

    const aborted = new AbortController();
    aborted.abort();
    result = await state.entry.tool.execute("call-3", { task: "bounded task" }, aborted.signal, undefined, MAIN_CONTEXT);
    expectRefused(result, /cancelled/);

    result = await state.entry.tool.execute(
      "call-4",
      { task: "bounded task" },
      new AbortController().signal,
      undefined,
      CHILD_CONTEXT,
    );
    expectRefused(result, /owning actual main root/);
    expect(state.coordinatorCalls).toBe(0);
  });

  test("refuses after disposal without resolving the root", async () => {
    const state = fixture();
    state.entry.dispose();
    const result = await state.entry.tool.execute(
      "call-1",
      { task: "bounded task" },
      new AbortController().signal,
      undefined,
      MAIN_CONTEXT,
    );
    expectRefused(result, /disposed/);
    expect(state.scopes).toHaveLength(0);
  });

  test("fails closed when the coordinator throws or returns an unreadable result", async () => {
    const state = fixture();
    state.throwCoordinator = true;
    let result = await state.entry.tool.execute(
      "call-1",
      { task: "bounded task" },
      new AbortController().signal,
      undefined,
      MAIN_CONTEXT,
    );
    expectRefused(result, /coordinator invocation failed/);
    expect(result.content[0]!.text).not.toContain("/private/secret path failure");

    state.throwCoordinator = false;
    state.result = null as unknown as NativeHarnessDelegationResult;
    result = await state.entry.tool.execute(
      "call-1",
      { task: "bounded task" },
      new AbortController().signal,
      undefined,
      MAIN_CONTEXT,
    );
    expectRefused(result, /unreadable result/);
  });

  test("inspect exposes only non-authoritative existing diagnostics", () => {
    const state = fixture();
    const inspection = state.entry.inspect(MAIN_CONTEXT);
    expect(inspection.schema).toBe(NATIVE_HARNESS_ENTRY_INSPECTION_SCHEMA);
    expect(inspection.authority).toBe("non-authoritative");
    expect(inspection.available).toBe(true);
    expect(inspection.coordinator?.enabled).toBe(true);
    expect(inspection.backend).toEqual(["backend-diagnostic"]);
  });
});
