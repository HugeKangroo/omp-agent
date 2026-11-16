import { describe, expect, test } from "bun:test";
import {
  NATIVE_HARNESS_HISTORY_HOST_SCHEMA,
  NATIVE_HARNESS_HISTORY_TOOL,
  NATIVE_HARNESS_HISTORY_TOOL_RESULT_SCHEMA,
  MAX_NATIVE_HARNESS_HISTORY_WIRE_BYTES,
  createNativeHarnessHistoryEntry,
  type NativeHarnessHistoryEntry,
  type NativeHarnessHistoryResolvedRoot,
} from "../../src/native-harness-history-entry.ts";
import type { NativeHarnessHistoryInspection } from "../../src/native-harness-history.ts";
import type {
  NativeHarnessHistoryListResult,
  NativeHarnessHistorySession,
  NativeHarnessHistorySessionInspection,
} from "../../src/native-harness-history-session.ts";
import type { NativeContext, NativeToolResult } from "../../src/native-entry.ts";

const CONTEXT = {
  cwd: "/workspace",
  agent: { kind: "main" as const },
} as unknown as NativeContext;

function payload(wire: NativeToolResult): Record<string, any> {
  expect(wire.content).toHaveLength(1);
  expect(wire.content[0]!.text.startsWith("agent_harness_history ")).toBe(true);
  return wire.details as Record<string, any>;
}

function listResult(rows = 0): NativeHarnessHistoryListResult {
  return {
    schema: "omp-agent.native-harness-history-session.v1",
    state: "complete",
    rows: Array.from({ length: rows }, (_, index) => ({
      entryId: `locator-${index}`,
      decode: "ok" as const,
      locatorSha256: "a".repeat(64),
      runId: `run-${index}`,
      toolCallId: `call-${index}`,
      labelCompatibility: "match" as const,
    })),
    page: { offset: 0, limit: 16, total: rows, returned: rows, nextOffset: null },
    reasons: [],
  };
}

function inspection(
  locator: NativeHarnessHistorySessionInspection["locator"],
  leaf: NativeHarnessHistoryInspection | null = null,
): NativeHarnessHistorySessionInspection {
  return {
    schema: "omp-agent.native-harness-history-session.v1",
    state: "partial",
    selector: { entryId: "locator-0", locatorSha256: "a".repeat(64) },
    locator,
    labels: { originSession: "match", workspace: "match" },
    evidence: { source: "match", report: "not-present" },
    declaration: {
      state: "absent",
      files: 0,
      reportEntryId: null,
      problem: null,
    },
    current: true,
    inspection: leaf,
    reasons: [],
  };
}

function projection(): NativeHarnessHistoryInspection {
  const budget = {
    limitBytes: 256 * 1024,
    chargedBytes: 0,
    observedBytes: 0,
    failedReads: 0,
    outcome: "within-budget" as const,
  };
  return {
    schema: "omp-agent.native-harness-history-projection.v1",
    version: 1,
    state: "observed",
    query: {
      runId: "run-fixture-1",
      storeRelativePath: "omp-harness-abc123/store/runs/run-fixture-1",
      storageRoot: "/workspace",
      startedAt: 1,
      completedAt: 2,
      observedBytes: 0,
      readBudget: budget,
      artifactReadBudget: budget,
      rootState: "pinned",
      declaration: "recorded-history-only",
    },
    recorded: {
      state: "observed",
      runId: "run-fixture-1",
      format: "harness2-run-json-v1-or-v2",
      status: "completed",
      revision: 3,
      createdAt: null,
      updatedAt: null,
      statusBasis: "recorded-run-json-only",
      stages: [],
      runFile: null,
      events: { state: "empty", rows: 0, file: null, problem: null },
      observationsAtomicity: "sequential-not-atomic",
      limitations: [],
    },
    originCompatibility: {
      basis: "declared-labels-versus-recorded-labels-only",
      runId: { declared: "run-fixture-1", recorded: "run-fixture-1", result: "match", basis: "label-only" },
      workspace: { declared: "/workspace", recorded: null, result: "unavailable", basis: "label-only" },
      workspaceLayout: "match",
      definitionVersion: { declared: "main-v2", recorded: null, result: "unavailable", basis: "label-only" },
      backendSourceId: { declared: null, recorded: null, result: "unavailable", basis: "label-only" },
      configurationSha256: { declared: null, recorded: null, result: "unavailable", basis: "label-only" },
      inputManifestSha256: { declared: null, recorded: null, result: "unavailable", basis: "label-only" },
      currentAdoption: false,
      limitations: [],
    },
    processObservation: {
      inspected: false,
      controller: { state: "unknown", coverage: "unknown", observedAt: null, source: "not-inspected-in-r1a" },
      workers: { state: "unknown", coverage: "unknown", observedAt: null, source: "not-inspected-in-r1a" },
      limitations: [],
    },
    artifactIntegrity: {
      state: "declared-files-matched",
      coverage: "declared-files-only",
      manifest: "present",
      complete: true,
      mode: "not-checked",
      tree: "not-checked",
      traces: "not-checked",
      provenance: "not-restored",
      declaredCount: 1,
      observedCount: 1,
      matchedCount: 1,
      totalDeclaredBytes: 3,
      totalObservedBytes: 3,
      winner: "baseline",
      results: [{
        relativePath: "dist/out.txt",
        declaredBytes: 3,
        declaredSha256: "d".repeat(64),
        declaredAt: null,
        declaredByEntryId: null,
        observedBytes: 3,
        observedSha256: "d".repeat(64),
        observedAt: 2,
        bytesMatch: true,
        hashMatch: true,
        status: "match",
        problem: null,
      }],
      problem: null,
      limitations: [],
    },
    accounting: {
      basis: "recorded-stage-fields-only",
      costTotal: { usd: null, source: "unknown" },
      outerLifetime: "unknown",
      originalDeadline: "unknown",
      stages: [{
        stage: "baseline",
        observed: { usd: null, source: "unknown" },
        reserved: { usd: null, source: "unknown" },
        accounted: { usd: null, source: "unknown" },
        resultKnown: false,
        usageEstimated: null,
      }],
      limitations: [],
    },
    eligibility: {
      readOnly: true,
      authorityRestored: false,
      resumeAvailable: false,
      liveAttach: "unsupported",
      recoverableFormat: false,
      missingForResume: [],
      limitations: [],
    },
    reasons: [{ code: "recorded", detail: "the run record was observed" }],
  };
}

function locator(overrides: Record<string, unknown> = {}): NonNullable<NativeHarnessHistorySessionInspection["locator"]> {
  return {
    schema: "omp-agent.native-harness-history-locator.v1",
    version: 1,
    originSessionId: "session-root",
    workspacePath: "/workspace",
    source: { toolCallId: "call-0", observationId: "work-0", generation: 1 },
    runId: "run-fixture-1",
    storeRelativePath: "omp-harness-abc123/store/runs/run-fixture-1",
    inputManifestSha256: null,
    definitionVersion: "main-v1",
    backendSourceId: "b".repeat(64),
    configurationSha256: "c".repeat(64),
    evidence: null,
    ...overrides,
  } as NonNullable<NativeHarnessHistorySessionInspection["locator"]>;
}

function fakeRoot(overrides: {
  readonly list?: () => NativeHarnessHistoryListResult;
  readonly inspect?: () => Promise<NativeHarnessHistorySessionInspection>;
  readonly labels?: NativeHarnessHistoryResolvedRoot["labels"];
  readonly revalidate?: () => string | null;
} = {}): { root: NativeHarnessHistoryResolvedRoot; calls: { list: number; inspect: number } } {
  const calls = { list: 0, inspect: 0 };
  const session = {
    list() {
      calls.list += 1;
      return overrides.list?.() ?? listResult();
    },
    async inspect() {
      calls.inspect += 1;
      return await (overrides.inspect?.() ?? inspection(locator()));
    },
    async publishTerminal() {
      throw new Error("transport must not publish");
    },
    status() {
      throw new Error("transport must not own status");
    },
    dispose() {},
  } as unknown as NativeHarnessHistorySession;
  return {
    calls,
    root: {
      session,
      labels: overrides.labels ?? {
        definitionVersion: "main-v1",
        backendSourceId: "b".repeat(64),
        configurationSha256: "c".repeat(64),
      },
      revalidate: overrides.revalidate ?? (() => null),
    },
  };
}

describe("agent_harness_history transport", () => {
  test("registers readonly list/inspect only and refuses unavailable inputs before session IO", async () => {
    const fake = fakeRoot();
    const entry = createNativeHarnessHistoryEntry({
      resolveRoot: () => ({ ok: true, root: fake.root }),
    });
    expect(entry.tool.name).toBe(NATIVE_HARNESS_HISTORY_TOOL);
    expect(entry.tool.approval).toBe("read");
    expect(entry.tool.defaultInactive).toBe(true);
    expect(JSON.stringify(entry.tool.parameters)).not.toMatch(/path|pid|signal|run/i);

    const revoked = Proxy.revocable({ action: "list" }, {});
    revoked.revoke();
    for (const params of [
      revoked.proxy,
      { action: "list", entryId: "locator-0", locatorSha256: "a".repeat(64) },
      { action: "inspect", offset: 0, entryId: "locator-0", locatorSha256: "a".repeat(64) },
      { action: "inspect", entryId: "locator-0" },
      { action: "inspect", entryId: "locator-0", locatorSha256: "nope" },
      { action: "list", limit: 17 },
      { action: "run", entryId: "locator-0" },
      { action: "list", extra: true },
      { action: "inspect", entryId: "/tmp/escape", locatorSha256: "a".repeat(64) },
    ]) {
      const result = await entry.tool.execute("call-1", params, undefined, undefined, CONTEXT);
      expect(result.isError).toBe(true);
      expect(payload(result).state).toBe("unavailable");
    }
    expect(fake.calls).toEqual({ list: 0, inspect: 0 });
  });

  test("list content is bounded structured JSON with exact row selectors", async () => {
    const rows = listResult(20);
    const fake = fakeRoot({
      list: () => ({
        ...rows,
        rows: rows.rows.map((row, index) => (index === 0 ? { ...row, entryId: "locator/token-0" } : row)),
      }),
    });
    const entry = createNativeHarnessHistoryEntry({
      resolveRoot: () => ({ ok: true, root: fake.root }),
    });
    const result = await entry.tool.execute("call-list", { action: "list", limit: 16 }, undefined, undefined, CONTEXT);
    expect(result.isError).not.toBe(true);
    const body = payload(result);
    expect(body.schema).toBe(NATIVE_HARNESS_HISTORY_TOOL_RESULT_SCHEMA);
    expect(body.action).toBe("list");
    expect(body.history.rows).toHaveLength(20);
    expect(body.recoveredAuthority).toBe(false);
    expect(body.resume).toBe(false);
    expect(body.processObservation).toBe("unknown/not-inspected");

    const text = result.content[0]!.text;
    expect(text.startsWith("agent_harness_history ")).toBe(true);
    const visible = JSON.parse(text.slice("agent_harness_history ".length));
    expect(visible.state).toBe("complete");
    expect(visible.page).toEqual({ offset: 0, limit: 16, total: 20, returned: 20, nextOffset: null });
    expect(visible.rows).toHaveLength(16);
    expect(visible.rows[0]).toEqual({
      entryId: "locator/token-0",
      locatorSha256: "a".repeat(64),
      runId: "run-0",
    });
    expect(visible.rows[15]).toEqual({
      entryId: "locator-15",
      locatorSha256: "a".repeat(64),
      runId: "run-15",
    });
    expect(visible.reasons).toEqual([]);
    expect(visible.authority).toBe("non-authoritative");
    expect(visible.executionAuthority).toBe(false);
    expect(visible.semanticAcceptance).toBe("not-evaluated");
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MAX_NATIVE_HARNESS_HISTORY_WIRE_BYTES,
    );
  });

  test("inspect content alone carries the exact selector and selected history facts", async () => {
    const selector = { entryId: "locator/token/0", locatorSha256: "a".repeat(64) };
    const leaf = {
      ...inspection(locator({ definitionVersion: "main-v2", backendSourceId: null }), projection()),
      selector,
    };
    const fake = fakeRoot({ inspect: async () => leaf });
    const entry = createNativeHarnessHistoryEntry({
      resolveRoot: () => ({ ok: true, root: fake.root }),
    });
    const params = { action: "inspect", ...selector };
    const result = await entry.tool.execute(
      "call-inspect",
      params,
      new AbortController().signal,
      undefined,
      CONTEXT,
    );
    const body = payload(result);
    expect(body.history.schema).toBe(NATIVE_HARNESS_HISTORY_HOST_SCHEMA);
    expect(body.history.versions.definitionVersion).toBe("mismatch");
    expect(body.history.versions.backendSourceId).toBe("unknown");
    expect(body.history.versions.configurationSha256).toBe("match");
    expect(body.history.history.locator.definitionVersion).toBe("main-v2");
    expect(body.history.recoveredAuthority).toBe(false);
    expect(body.history.resume).toBe(false);
    expect(body.history.processObservation).toBe("unknown/not-inspected");

    // The caller's selector survives byte-for-byte; content is the only text
    // the fixed openai-completions provider exposes to the model.
    expect(selector).toEqual({ entryId: "locator/token/0", locatorSha256: "a".repeat(64) });
    expect(params).toEqual({ action: "inspect", ...selector });
    const text = result.content[0]!.text;
    const visible = JSON.parse(text.slice("agent_harness_history ".length));
    const details = body.history.history;
    expect(visible.selector).toEqual(selector);
    expect(visible.state).toBe(body.history.state);
    expect(visible.current).toBe(body.history.current);
    expect(visible.versions).toEqual(body.history.versions);
    expect(visible.runId).toBe(details.locator.runId);
    expect(visible.recorded).toEqual({
      state: details.inspection.recorded.state,
      runId: details.inspection.recorded.runId,
      status: details.inspection.recorded.status,
      revision: details.inspection.recorded.revision,
      stageCount: details.inspection.recorded.stages.length,
      eventsState: details.inspection.recorded.events.state,
      eventsRows: details.inspection.recorded.events.rows,
    });
    expect(visible.artifactCoverage).toEqual({
      state: details.inspection.artifactIntegrity.state,
      coverage: details.inspection.artifactIntegrity.coverage,
      complete: details.inspection.artifactIntegrity.complete,
      declaredCount: details.inspection.artifactIntegrity.declaredCount,
      observedCount: details.inspection.artifactIntegrity.observedCount,
      matchedCount: details.inspection.artifactIntegrity.matchedCount,
      totalDeclaredBytes: details.inspection.artifactIntegrity.totalDeclaredBytes,
      totalObservedBytes: details.inspection.artifactIntegrity.totalObservedBytes,
    });
    expect(visible.matchedFiles).toEqual([{
      relativePath: "dist/out.txt",
      declaredBytes: 3,
      declaredSha256: "d".repeat(64),
      observedBytes: 3,
      observedSha256: "d".repeat(64),
    }]);
    expect(visible.accounting.costTotal).toEqual({ usd: null, source: "unknown" });
    expect(visible.accounting.stages[0]!.observed).toEqual({ usd: null, source: "unknown" });
    expect(visible.accounting.costTotal.usd).toBeNull();
    expect(visible.accounting.costTotal.usd).not.toBe(0);
    expect(visible.processObservation).toEqual({ inspected: false, controller: "unknown", workers: "unknown" });
    expect(visible.originCompatibility.definitionVersion).toBe("unavailable");
    expect(visible.reasons).toEqual([{ code: "recorded", detail: "the run record was observed" }]);
    expect(visible.authority).toBe("non-authoritative");
    expect(visible.executionAuthority).toBe(false);
    expect(visible.recoveredAuthority).toBe(false);
    expect(visible.resume).toBe(false);
    expect(visible.semanticAcceptance).toBe("not-evaluated");
  });

  test("inspect host and model views carry the same limited process summary", async () => {
    const leafProcess = {
      inspected: true as const,
      platform: "darwin" as const,
      controller: {
        state: "unknown" as const,
        coverage: "controller-lock-only" as const,
        presence: "unknown" as const,
        owner: {
          state: "missing" as const,
          bytes: null,
          sha256: null,
          observedAt: null,
          pid: null,
          pgid: null,
          basis: null,
          problem: null,
        },
        os: {
          presence: "unknown" as const,
          pid: null,
          pgid: null,
          stat: null,
          processState: "unknown" as const,
          startedAt: null,
          observedAt: null,
          pgidComparison: "unknown" as const,
          markerComparison: "unknown" as const,
          problem: null,
        },
        identity: "unknown" as const,
      },
      workers: {
        state: "unknown" as const,
        coverage: "current-recorded-attempts-only" as const,
        rows: [],
        counts: {
          targeted: 0,
          present: 0,
          notObserved: 0,
          unknown: 0,
          zombies: 0,
          markerConsistent: 0,
          markerMismatch: 0,
        },
        groupCoverage: "not-inspected" as const,
        historicalAttempts: "incomplete" as const,
      },
      coverage: {
        basis: "current-recorded-attempts-only" as const,
        group: "not-inspected" as const,
        historicalAttempts: "incomplete" as const,
      },
      osInspection: {
        executed: false,
        state: "not-run" as const,
        requestedPids: 0,
        observedPids: 0,
        cleanup: "not-needed" as const,
        observedAt: null,
        problem: null,
      },
      summary: {
        ownerReads: { attempted: 0, observed: 0, failed: 0, notAttempted: 0 },
        osQueries: 0 as const,
        presence: { present: 0, notObserved: 0, unknown: 0 },
        stopProof: "not-established" as const,
      },
      observedAt: null,
      limitations: [],
    };
    const selector = { entryId: "locator/token/0", locatorSha256: "a".repeat(64) };
    const leaf = {
      ...inspection(locator(), { ...projection(), processObservation: leafProcess }),
      selector,
    };
    const fake = fakeRoot({ inspect: async () => leaf });
    const entry = createNativeHarnessHistoryEntry({
      resolveRoot: () => ({ ok: true, root: fake.root }),
    });
    const result = await entry.tool.execute(
      "call-inspect-process",
      { action: "inspect", ...selector },
      new AbortController().signal,
      undefined,
      CONTEXT,
    );
    const body = payload(result);
    expect(body.history.processObservation).toEqual({
      inspected: true,
      platform: "darwin",
      osQuery: "not-run",
      osQueryExecuted: false,
      controllerPresence: "unknown",
      workerPresence: { present: 0, notObserved: 0, unknown: 0 },
      workerCoverage: "current-recorded-attempts-only",
      groupCoverage: "not-inspected",
      historicalAttempts: "incomplete",
      stopProof: "not-established",
    });
    expect(body.processObservation).toEqual(body.history.processObservation);
    const visible = JSON.parse(result.content[0]!.text.slice("agent_harness_history ".length));
    expect(visible.processObservation.inspected).toBe(true);
    expect(visible.processObservation.osQuery).toBe("not-run");
    expect(visible.processObservation.stopProof).toBe("not-established");
    expect(visible.hostProcessObservation).toEqual(body.history.processObservation);
  });

  test("late currentness failure returns unavailable, never a stale current view", async () => {
    const fake = fakeRoot({ revalidate: () => "the root navigation changed" });
    const entry = createNativeHarnessHistoryEntry({
      resolveRoot: () => ({ ok: true, root: fake.root }),
    });
    const result = await entry.tool.execute(
      "call-late",
      { action: "inspect", entryId: "locator-0", locatorSha256: "a".repeat(64) },
      new AbortController().signal,
      undefined,
      CONTEXT,
    );
    const body = payload(result);
    expect(result.isError).toBe(true);
    expect(body.state).toBe("unavailable");
    expect(body.history).toBeNull();
    expect(body.reason).toMatch(/navigation/);
  });

  test("foreign root and missing/aborted signals perform no leaf IO", async () => {
    const fake = fakeRoot();
    const denied = createNativeHarnessHistoryEntry({
      resolveRoot: () => ({ ok: false, reason: "the actual history context is not the owning main root" }),
    });
    const deniedResult = await denied.tool.execute("call-foreign", { action: "list" }, undefined, undefined, CONTEXT);
    expect(deniedResult.isError).toBe(true);
    expect(fake.calls).toEqual({ list: 0, inspect: 0 });

    const entry = createNativeHarnessHistoryEntry({
      resolveRoot: () => ({ ok: true, root: fake.root }),
    });
    const selector = { action: "inspect", entryId: "locator-0", locatorSha256: "a".repeat(64) };
    expect((await entry.tool.execute("call-missing", selector, undefined, undefined, CONTEXT)).isError).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect((await entry.tool.execute("call-aborted", selector, controller.signal, undefined, CONTEXT)).isError).toBe(true);
    expect(fake.calls.inspect).toBe(0);
  });

  test("late disposal and late aborts withhold a held current view", async () => {
    let release!: (value: NativeHarnessHistorySessionInspection) => void;
    let started!: () => void;
    const inspectStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fake = fakeRoot({
      inspect: () => new Promise<NativeHarnessHistorySessionInspection>((resolve) => {
        release = resolve;
        started();
      }),
    });
    const entry = createNativeHarnessHistoryEntry({
      resolveRoot: () => ({ ok: true, root: fake.root }),
    });
    const selector = { action: "inspect", entryId: "locator-0", locatorSha256: "a".repeat(64) };
    const controller = new AbortController();
    const held = entry.tool.execute("call-held", selector, controller.signal, undefined, CONTEXT);
    await inspectStarted;
    entry.dispose();
    release(inspection(locator()));
    const disposed = await held;
    expect(disposed.isError).toBe(true);
    expect(payload(disposed).state).toBe("unavailable");

    const second = createNativeHarnessHistoryEntry({
      resolveRoot: () => ({ ok: true, root: fake.root }),
    });
    let releaseSecond!: (value: NativeHarnessHistorySessionInspection) => void;
    let startedSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      startedSecond = resolve;
    });
    const fakeSecond = fakeRoot({
      inspect: () => new Promise<NativeHarnessHistorySessionInspection>((resolve) => {
        releaseSecond = resolve;
        startedSecond();
      }),
    });
    const third = createNativeHarnessHistoryEntry({
      resolveRoot: () => ({ ok: true, root: fakeSecond.root }),
    });
    const aborter = new AbortController();
    const heldSecond = third.tool.execute("call-held-2", selector, aborter.signal, undefined, CONTEXT);
    await secondStarted;
    aborter.abort();
    releaseSecond(inspection(locator()));
    const aborted = await heldSecond;
    expect(aborted.isError).toBe(true);
    expect(payload(aborted).state).toBe("unavailable");
    expect(second.tool.name).toBe(NATIVE_HARNESS_HISTORY_TOOL);
  });

  test("synchronous resolver disposal and inspect abort query nothing and return no current view", async () => {
    const fake = fakeRoot();
    let disposedEntry!: NativeHarnessHistoryEntry;
    disposedEntry = createNativeHarnessHistoryEntry({
      resolveRoot: () => {
        disposedEntry.dispose();
        return { ok: true, root: fake.root };
      },
    });
    const list = await disposedEntry.tool.execute(
      "call-disposed-list",
      { action: "list" },
      undefined,
      undefined,
      CONTEXT,
    );
    const inspect = await disposedEntry.tool.execute(
      "call-disposed-inspect",
      { action: "inspect", entryId: "locator-0", locatorSha256: "a".repeat(64) },
      new AbortController().signal,
      undefined,
      CONTEXT,
    );
    for (const result of [list, inspect]) {
      expect(result.isError).toBe(true);
      expect(payload(result).state).toBe("unavailable");
      expect(payload(result).history).toBeNull();
    }
    expect(fake.calls).toEqual({ list: 0, inspect: 0 });

    const aborter = new AbortController();
    const abortingEntry = createNativeHarnessHistoryEntry({
      resolveRoot: () => {
        aborter.abort();
        return { ok: true, root: fake.root };
      },
    });
    const aborted = await abortingEntry.tool.execute(
      "call-resolver-abort",
      { action: "inspect", entryId: "locator-0", locatorSha256: "a".repeat(64) },
      aborter.signal,
      undefined,
      CONTEXT,
    );
    expect(aborted.isError).toBe(true);
    expect(payload(aborted).state).toBe("unavailable");
    expect(payload(aborted).history).toBeNull();
    expect(fake.calls).toEqual({ list: 0, inspect: 0 });
  });

  test("an oversized response becomes bounded unavailable without partial history", async () => {
    const huge = "x".repeat(MAX_NATIVE_HARNESS_HISTORY_WIRE_BYTES);
    const fake = fakeRoot({
      list: () => ({
        ...listResult(1),
        reasons: [{ code: "huge", detail: huge }],
      }) as unknown as NativeHarnessHistoryListResult,
    });
    const entry = createNativeHarnessHistoryEntry({
      resolveRoot: () => ({ ok: true, root: fake.root }),
    });
    const result = await entry.tool.execute("call-huge", { action: "list" }, undefined, undefined, CONTEXT);
    const body = payload(result);
    expect(result.isError).toBe(true);
    expect(body.state).toBe("unavailable");
    expect(body.history).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MAX_NATIVE_HARNESS_HISTORY_WIRE_BYTES,
    );
  });
});
