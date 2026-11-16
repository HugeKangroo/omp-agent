import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NativeContext, NativeToolResult } from "../../src/native-entry.ts";
import {
  MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES,
  createNativeHarnessResultEntry,
  type NativeHarnessResultEntry,
} from "../../src/native-harness-result-entry.ts";
import {
  NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES,
  NATIVE_HARNESS_RESULT_TOOL,
  createNativeHarnessCheckPathRecord,
  createNativeHarnessCheckResponse,
  normalizeNativeHarnessCaptureInput,
  normalizeNativeHarnessCheckInput,
  normalizeNativeHarnessInspectInput,
  normalizeNativeHarnessReadInput,
  type NativeHarnessCaptureInput,
  type NativeHarnessCheckInput,
  type NativeHarnessCheckSuccess,
  type NativeHarnessInspectInput,
  type NativeHarnessReadInput,
} from "../../src/native-harness-checks.ts";
import type {
  NativeHarnessDelegationCoordinator,
  NativeHarnessOutputCatalog,
  NativeHarnessOutputCatalogSuccess,
  NativeHarnessOutputSelection,
  NativeHarnessOutputSelectionSuccess,
  NativeHarnessReadSelection,
  NativeHarnessReadSuccess,
} from "../../src/native-harness-delegation.ts";
import type {
  NativeHarnessResolvedRoot,
  NativeHarnessRootResolution,
} from "../../src/native-harness-entry.ts";
import {
  NATIVE_TEXT_CHECKER_ID,
  NATIVE_TEXT_CHECKER_VERSION,
  createNativeTextCheckPlan,
  runNativeTextChecks,
} from "../../src/native-snapshot-checker.ts";
import { fingerprintExpectedCallResult } from "../../src/native-result-expectation.ts";
import {
  captureWorkspaceText,
  type NativeWorkspaceTextSnapshot,
} from "../../src/native-work.ts";

const MAIN_CONTEXT: NativeContext = {
  cwd: "/workspace",
  agent: { kind: "main" },
};
const CHILD_CONTEXT: NativeContext = {
  cwd: "/workspace",
  agent: { kind: "sub" },
};

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function actualSignal(): AbortSignal {
  return new AbortController().signal;
}

function textOf(wire: NativeToolResult): string {
  expect(wire.content).toHaveLength(1);
  expect(wire.content[0]?.type).toBe("text");
  return wire.content[0]?.text ?? "";
}

function payloadOf(wire: NativeToolResult): Record<string, unknown> {
  return JSON.parse(textOf(wire)) as Record<string, unknown>;
}

function wireBytes(wire: NativeToolResult): number {
  return Buffer.byteLength(JSON.stringify(wire), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fakeCoordinator(overrides: Record<string, unknown> = {}): NativeHarnessDelegationCoordinator {
  return Object.assign({
    enabled: true,
    disposed: false,
    invoke: async () => {
      throw new Error("unexpected invoke");
    },
    registerToolResultProjection: () => ({ ok: true, reason: null }),
    captureOutput: async () => ({ ok: false, code: "output-unavailable", reason: "unused" }),
    captureOutputForCall: async () => ({ ok: false, code: "output-unavailable", reason: "unused" }),
    readOutputForCall: () => ({ ok: false, code: "output-unavailable", reason: "unused" }),
    inspectOutputsForCall: () => ({ ok: false, code: "output-unavailable", reason: "unused" }),
    checkOutput: () => ({ ok: false, code: "check-unavailable", reason: "unused" }),
    registerOutputCheckProjection: () => ({ ok: true, reason: null }),
    registerOutputCaptureProjection: () => ({ ok: true, reason: null }),
    cancel: () => false,
    dispose: () => undefined,
    inspect: () => ({}),
  }, overrides) as unknown as NativeHarnessDelegationCoordinator;
}

function fakeRoot(
  coordinator: NativeHarnessDelegationCoordinator,
  overrides: Partial<NativeHarnessResolvedRoot> = {},
): NativeHarnessResolvedRoot {
  return {
    coordinator,
    runWithContext: (_context, _id, operation) => operation(),
    diagnostics: () => [],
    ...overrides,
  };
}

function entryFor(
  root: NativeHarnessResolvedRoot | (() => NativeHarnessRootResolution),
): NativeHarnessResultEntry {
  return createNativeHarnessResultEntry({
    resolveRoot: typeof root === "function" ? root : () => ({ ok: true, root }),
  });
}

function normalizedCapture(sourceToolCallId = "source-1"): NativeHarnessCaptureInput {
  const normalized = normalizeNativeHarnessCaptureInput({ action: "capture", sourceToolCallId });
  if (!normalized.ok) throw new Error(normalized.reason);
  return normalized.input;
}

function normalizedRead(
  sourceToolCallId = "source-1",
  captureId = "capture-1",
  captureDigest = "a".repeat(64),
  filePath = "out.txt",
): NativeHarnessReadInput {
  const normalized = normalizeNativeHarnessReadInput({
    action: "read",
    sourceToolCallId,
    captureId,
    captureDigest,
    path: filePath,
  });
  if (!normalized.ok) throw new Error(normalized.reason);
  return normalized.input;
}

function normalizedInspect(): NativeHarnessInspectInput {
  const normalized = normalizeNativeHarnessInspectInput({ action: "inspect" });
  if (!normalized.ok) throw new Error(normalized.reason);
  return normalized.input;
}

function normalizedCheck(
  sourceToolCallId = "source-1",
  captureId = "capture-1",
  captureDigest = "a".repeat(64),
  filePath = "out.txt",
  conditions: readonly unknown[] = [{ id: "has-thing", kind: "text-includes", value: "thing" }],
): NativeHarnessCheckInput {
  const normalized = normalizeNativeHarnessCheckInput({
    action: "check",
    sourceToolCallId,
    captureId,
    captureDigest,
    path: filePath,
    conditions,
  });
  if (!normalized.ok) throw new Error(normalized.reason);
  return normalized.input;
}

function snapshotFor(
  relativePath: string,
  text: string,
  fileSnapshotId = "file-snapshot-1",
): NativeWorkspaceTextSnapshot {
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    captureId: fileSnapshotId,
    file: {
      relativePath,
      bytes,
      sha256: sha256(text),
      observedAt: 17,
    },
    text,
  } as NativeWorkspaceTextSnapshot;
}

function captureSelection(
  sourceToolCallId = "source-1",
  changes: readonly { readonly path: string; readonly text?: string }[] = [{ path: "out.txt", text: "captured text" }],
): NativeHarnessOutputSelectionSuccess {
  const records = changes.map((change, index) => {
    const text = change.text ?? `captured-${index}`;
    return {
      path: change.path,
      kind: "add" as const,
      mode: 0o600,
      controllerHash: "0".repeat(64),
      snapshot: snapshotFor(change.path, text, `file-snapshot-${index + 1}`),
    };
  });
  const capture = {
    schema: "omp-agent.native-harness-output-capture.v1" as const,
    captureId: "capture-1",
    originKind: "harness2-native" as const,
    completionId: "private-completion-id",
    sourceId: "private-source-id",
    runId: "private-run-id",
    taskSha256: "a".repeat(64),
    baseSnapshotId: "base-snapshot-id",
    manifestSha256: "b".repeat(64),
    winner: {
      candidate: "private-candidate",
      attempt: 1,
      artifactHash: "c".repeat(64),
      traceHash: "d".repeat(64),
    },
    changes: records,
    sources: [{
      relativePath: "/private/workspace/source.txt",
      bytes: 10,
      sha256: "e".repeat(64),
      observedAt: 1,
    }],
    baseInputs: [],
    stages: [],
    digest: "f".repeat(64),
    observedAt: 123,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
    limitations: ["private limitation"],
  };
  return {
    ok: true,
    observation: "captured-now",
    filesystemFreshness: "observed-during-capture",
    capture,
    association: {
      observationId: "observation-1",
      generation: 1,
      sessionId: "session-1",
      workspaceRoot: "/private/workspace/root",
      toolCallId: sourceToolCallId,
      toolName: "agent_harness",
    },
    runId: "private-run-id",
    taskSha256: "a".repeat(64),
    workPromptSha256: "b".repeat(64),
    callInputSha256: "c".repeat(64),
    expectedResultSha256: "d".repeat(64),
    observedResultSha256: "e".repeat(64),
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  };
}

function readSelection(
  actualToolCallId: string,
  input: NativeHarnessReadInput,
  text: string,
  fileSnapshotId = "file-snapshot-1",
): NativeHarnessReadSuccess {
  return {
    ok: true,
    action: "read",
    readToolCallId: actualToolCallId,
    sourceToolCallId: input.sourceToolCallId,
    captureId: input.captureId,
    captureDigest: input.captureDigest,
    path: input.path,
    snapshot: snapshotFor(input.path, text, fileSnapshotId),
    observation: "cached-historical",
    filesystemFreshness: "not-rechecked",
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
  };
}

function inspectSelection(): NativeHarnessOutputCatalogSuccess {
  return {
    ok: true,
    action: "inspect",
    scope: "retained-sources-in-this-root",
    scanComplete: true,
    retainedSources: 4,
    returnedSources: 2,
    excludedNotReady: 1,
    excludedUnavailable: 1,
    rows: [
      {
        sourceToolCallId: "source-1",
        outputState: "captured",
        capture: {
          captureId: "capture-1",
          captureDigest: "a".repeat(64),
          files: [
            { path: "out.txt", kind: "add", bytes: 12, sha256: "b".repeat(64), observedAt: 17 },
          ],
        },
      },
      {
        sourceToolCallId: "source-2",
        outputState: "idle",
        capture: null,
      },
    ],
  };
}

function checkSelection(
  actualToolCallId: string,
  input: NativeHarnessCheckInput,
  outcome: "pass" | "fail",
  detail: string,
): NativeHarnessCheckSuccess {
  return {
    ok: true,
    schema: "omp-agent.native-harness-output-check.v1",
    action: "check",
    authority: "non-authoritative",
    sourceToolCallId: input.sourceToolCallId,
    checkToolCallId: actualToolCallId,
    computedByToolCallId: "original-computation-call",
    captureId: input.captureId,
    captureDigest: input.captureDigest,
    path: input.path,
    checkerId: NATIVE_TEXT_CHECKER_ID,
    checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
    planDigest: "9".repeat(64),
    planSource: "model-proposed-after-capture",
    receipt: {
      schemaVersion: 1,
      checkerId: NATIVE_TEXT_CHECKER_ID,
      checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
      planDigest: "9".repeat(64),
      snapshot: {
        captureId: "file-snapshot-1",
        file: {
          relativePath: input.path,
          bytes: 10,
          sha256: "8".repeat(64),
          observedAt: 17,
        },
      },
      conditions: [{ id: "condition-1", result: outcome, detail }],
      outcome,
      taskAccepted: false,
      semanticAcceptance: "not-evaluated",
    },
    observation: "cached-historical",
    filesystemFreshness: "not-rechecked",
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
  };
}

async function call(
  entry: NativeHarnessResultEntry,
  toolCallId: string,
  input: unknown,
  signal: AbortSignal = actualSignal(),
  context: NativeContext = MAIN_CONTEXT,
): Promise<NativeToolResult> {
  return entry.tool.execute(toolCallId, input, signal, undefined, context);
}

describe("native harness result tool identity and schema", () => {
  test("exposes the exact read-only discoverable identity and four exact branches", () => {
    const entry = entryFor(fakeRoot(fakeCoordinator()));
    expect(entry.tool.name).toBe("agent_harness_result");
    expect(entry.tool.name).toBe(NATIVE_HARNESS_RESULT_TOOL);
    expect(entry.tool.approval).toBe("read");
    expect(entry.tool.loadMode).toBe("discoverable");
    expect(entry.tool.defaultInactive).toBe(true);
    expect(entry.tool.description).toContain("sourceToolCallId is the original actual agent_harness tool call ID");
    expect(entry.tool.description).toContain("not its run ID and not a result action ID");
    expect(entry.tool.description).toContain("inspect lists eligible source and capture selectors");
    expect(entry.tool.description).toContain("capture returns exact file and version selectors");
    expect(entry.tool.description).toContain("read returns one historical captured file and is optional before fixed checking");
    expect(entry.tool.description).toContain("PASS is not task acceptance, semantic acceptance or comprehensive coverage");
    expect(entry.tool.description).toContain("starts no Harness workers");
    expect(entry.tool.description).toContain("no report endpoint");
    const schema = entry.tool.parameters as unknown as {
      type: string;
      oneOf: Array<{
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, unknown>;
      }>;
    };
    expect(schema.type).toBe("object");
    expect(schema.oneOf).toHaveLength(4);
    expect(schema.oneOf.map((branch) => branch.required)).toEqual([
      ["action"],
      ["action", "sourceToolCallId"],
      ["action", "sourceToolCallId", "captureId", "captureDigest", "path"],
      ["action", "sourceToolCallId", "captureId", "captureDigest", "path", "conditions"],
    ]);
    for (const branch of schema.oneOf) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.properties.action).toBeDefined();
    }
    const check = schema.oneOf[3]!;
    const conditions = check.properties.conditions as unknown as {
      minItems: number;
      maxItems: number;
      items: { oneOf: Array<{ properties: { kind: { const: string } } }> };
    };
    expect(conditions.minItems).toBe(1);
    expect(conditions.maxItems).toBe(32);
    expect(conditions.items.oneOf.map((branch) => branch.properties.kind.const)).toEqual([
      "text-includes",
      "json-valid",
      "json-type",
      "json-equals",
    ]);
  });

  test("rejects missing or accessor resolveRoot options without creating anything", () => {
    expect(() => createNativeHarnessResultEntry(undefined as never)).toThrow();
    const options = {};
    Object.defineProperty(options, "resolveRoot", {
      enumerable: true,
      get() {
        throw new Error("must not be read");
      },
    });
    expect(() => createNativeHarnessResultEntry(options as never)).toThrow();
  });
});

describe("native harness result input snapshot and refusals", () => {
  test("reads each caller field once and dispatches on the copied action", async () => {
    let ownKeys = 0;
    let descriptors = 0;
    const caller = new Proxy({ action: "inspect" }, {
      ownKeys() {
        ownKeys += 1;
        return ["action"];
      },
      getOwnPropertyDescriptor() {
        descriptors += 1;
        return {
          value: "inspect",
          writable: true,
          enumerable: true,
          configurable: true,
        };
      },
      get() {
        throw new Error("get must not run");
      },
    });
    let rootCalls = 0;
    const coordinator = fakeCoordinator({
      inspectOutputsForCall: () => inspectSelection(),
    });
    const entry = entryFor(() => {
      rootCalls += 1;
      return { ok: true, root: fakeRoot(coordinator) };
    });
    const wire = await call(entry, "inspect-1", caller);
    expect(wire.isError).toBeUndefined();
    expect(payloadOf(wire).action).toBe("inspect");
    expect(rootCalls).toBe(1);
    expect(ownKeys).toBe(1);
    expect(descriptors).toBe(1);
  });

  test("rejects accessors, symbols, unknown fields, arrays and exotic prototypes before root resolution", async () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "action", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "inspect";
      },
    });
    const cases: unknown[] = [
      accessor,
      { action: "inspect", [Symbol("extra")]: true },
      { action: "inspect", unexpected: true },
      ["inspect"],
      new (class Exotic {
        action = "inspect";
      })(),
      new Date(),
      null,
      "inspect",
    ];
    let rootCalls = 0;
    const entry = entryFor(() => {
      rootCalls += 1;
      return { ok: true, root: fakeRoot(fakeCoordinator()) };
    });
    for (const [index, input] of cases.entries()) {
      const wire = await call(entry, `bad-${index}`, input);
      expect(wire.isError).toBe(true);
      expect(payloadOf(wire).error).toMatchObject({ code: "invalid-input" });
    }
    expect(getterCalls).toBe(0);
    expect(rootCalls).toBe(0);
  });

  test("refuses revoked and throwing reflection inputs without reading later fields", async () => {
    const revoked = Proxy.revocable({ action: "inspect" }, {});
    revoked.revoke();
    let descriptorCalls = 0;
    const throwing = new Proxy({ action: "inspect" }, {
      getOwnPropertyDescriptor() {
        descriptorCalls += 1;
        throw new Error("reflection failed");
      },
    });
    let rootCalls = 0;
    const entry = entryFor(() => {
      rootCalls += 1;
      return { ok: true, root: fakeRoot(fakeCoordinator()) };
    });
    const first = await call(entry, "revoked-1", revoked.proxy);
    const second = await call(entry, "throwing-1", throwing);
    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
    expect(descriptorCalls).toBe(1);
    expect(rootCalls).toBe(0);
  });

  test("refuses malformed selectors and conditions with the existing normalizers", async () => {
    let rootCalls = 0;
    const entry = entryFor(() => {
      rootCalls += 1;
      return { ok: true, root: fakeRoot(fakeCoordinator()) };
    });
    const cases: unknown[] = [
      { action: "capture", sourceToolCallId: "" },
      { action: "read", sourceToolCallId: "source-1", captureId: "capture-1", captureDigest: "a".repeat(64), path: "" },
      { action: "read", sourceToolCallId: "source-1", captureId: "capture-1", captureDigest: "A".repeat(64), path: "out.txt" },
      {
        action: "check",
        sourceToolCallId: "source-1",
        captureId: "capture-1",
        captureDigest: "a".repeat(64),
        path: "out.txt",
        conditions: [
          { id: "duplicate", kind: "json-valid" },
          { id: "duplicate", kind: "json-valid" },
        ],
      },
      { action: "check", extra: true },
    ];
    for (const [index, input] of cases.entries()) {
      const wire = await call(entry, `bad-selector-${index}`, input);
      expect(wire.isError).toBe(true);
      expect(payloadOf(wire).error).toMatchObject({ code: "invalid-input" });
    }
    expect(rootCalls).toBe(0);
  });

  test("requires a real main context, a bounded actual call id and the actual host signal", async () => {
    let rootCalls = 0;
    const entry = entryFor(() => {
      rootCalls += 1;
      return { ok: true, root: fakeRoot(fakeCoordinator()) };
    });
    const inspect = { action: "inspect" };
    const child = await call(entry, "inspect-child", inspect, actualSignal(), CHILD_CONTEXT);
    const longId = await call(entry, "x".repeat(257), inspect);
    const missingSignal = await entry.tool.execute("inspect-missing", inspect, undefined, undefined, MAIN_CONTEXT);
    const fakeSignal = await call(entry, "inspect-fake", inspect, { aborted: false } as never);
    const controller = new AbortController();
    controller.abort();
    const preAborted = await call(entry, "inspect-aborted", inspect, controller.signal);
    expect(child.isError).toBe(true);
    expect(longId.isError).toBe(true);
    expect(missingSignal.isError).toBe(true);
    expect(fakeSignal.isError).toBe(true);
    expect(preAborted.isError).toBe(true);
    expect(payloadOf(preAborted).error).toMatchObject({ code: "cancelled" });
    expect(rootCalls).toBe(0);
  });

  test("refuses malformed, missing-method and failed root resolutions without fallback", async () => {
    const inspect = { action: "inspect" };
    let firstCalls = 0;
    const first = entryFor(() => {
      firstCalls += 1;
      return { ok: false, reason: "the root is not current" };
    });
    const refused = await call(first, "inspect-refused", inspect);
    expect(refused.isError).toBe(true);
    expect(payloadOf(refused).error).toMatchObject({ code: "root-unavailable" });
    expect(firstCalls).toBe(1);

    let malformedCalls = 0;
    const malformed = entryFor(() => {
      malformedCalls += 1;
      return { ok: true, root: {} as NativeHarnessResolvedRoot };
    });
    const malformedWire = await call(malformed, "inspect-malformed", inspect);
    expect(malformedWire.isError).toBe(true);
    expect(payloadOf(malformedWire).error).toMatchObject({ code: "root-unavailable" });
    expect(malformedCalls).toBe(1);

    let missingMethodCalls = 0;
    const missingMethod = entryFor(() => {
      missingMethodCalls += 1;
      return {
        ok: true,
        root: fakeRoot(fakeCoordinator({ inspectOutputsForCall: undefined })),
      };
    });
    const missingWire = await call(missingMethod, "inspect-missing-method", inspect);
    expect(missingWire.isError).toBe(true);
    expect(payloadOf(missingWire).error).toMatchObject({ code: "root-unavailable" });
    expect(missingMethodCalls).toBe(1);

    let throwingCalls = 0;
    const throwing = entryFor(() => {
      throwingCalls += 1;
      throw new Error("/private/secret/path exploded");
    });
    const throwingWire = await call(throwing, "inspect-throw", inspect);
    expect(throwingWire.isError).toBe(true);
    expect(payloadOf(throwingWire).error).toMatchObject({ code: "root-unavailable" });
    expect(textOf(throwingWire)).not.toContain("/private/secret");
    expect(throwingCalls).toBe(1);
  });
});

describe("native harness result capture operation", () => {
  test("tracks the exact capture promise, projects in ALS and registers exact identities", async () => {
    const selection = captureSelection();
    const als = new AsyncLocalStorage<string>();
    let tracked: Promise<NativeHarnessOutputSelection> | null = null;
    let scopeDuringProjection: string | undefined;
    let resolveCapture!: (value: NativeHarnessOutputSelection) => void;
    const capturePromise = new Promise<NativeHarnessOutputSelection>((resolve) => {
      resolveCapture = resolve;
    });
    const registered: Array<{
      source: unknown;
      action: unknown;
      outcome: unknown;
      wire: NativeToolResult;
      signal: unknown;
    }> = [];
    const coordinator = fakeCoordinator({
      captureOutputForCall: () => capturePromise,
      registerOutputCaptureProjection: (
        source: unknown,
        action: unknown,
        outcome: unknown,
        wire: NativeToolResult,
        signal: unknown,
      ) => {
        scopeDuringProjection = als.getStore();
        registered.push({ source, action, outcome, wire, signal });
        return { ok: true, reason: null };
      },
    });
    const root = fakeRoot(coordinator, {
      runWithContext: (_context, _id, operation) => {
        return als.run("capture-scope", () => {
          const launched = operation();
          tracked = launched as Promise<NativeHarnessOutputSelection>;
          return launched;
        });
      },
    });
    const entry = entryFor(root);
    const signal = actualSignal();
    const executing = call(entry, "capture-action-1", { action: "capture", sourceToolCallId: "source-1" }, signal);
    await Promise.resolve();
    expect(tracked === capturePromise).toBe(true);
    resolveCapture(selection);
    const wire = await executing;
    expect(scopeDuringProjection).toBe("capture-scope");
    expect(wire.isError).toBeUndefined();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.source).toBe("source-1");
    expect(registered[0]?.action).toBe("capture-action-1");
    expect(registered[0]?.outcome).toBe(selection);
    expect(registered[0]?.signal).toBe(signal);
    expect(registered[0]?.wire).toBe(wire);
    const payload = payloadOf(wire);
    expect(payload).toMatchObject({
      action: "capture",
      ok: true,
      sourceToolCallId: "source-1",
      actionToolCallId: "capture-action-1",
      captureId: "capture-1",
      captureDigest: "f".repeat(64),
      authority: "non-authoritative",
      taskAccepted: false,
      semanticAcceptance: "not-evaluated",
    });
    expect((payload.origin as Record<string, unknown>)).toMatchObject({
      kind: "harness2-native",
      observation: "captured-now",
      filesystemFreshness: "observed-during-capture",
      observedAt: 123,
    });
    expect((payload.files as Array<Record<string, unknown>>)[0]).toMatchObject({
      path: "out.txt",
      kind: "add",
      bytes: 13,
      sha256: sha256("captured text"),
      observedAt: 17,
      fileSnapshotId: "file-snapshot-1",
    });
    expect(wire.details).toBeUndefined();
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain("/private/workspace");
    expect(serialized).not.toContain("private-run-id");
    expect(serialized).not.toContain("captured text");
    expect(serialized).not.toContain("observed:true");
  });

  test("duplicate success receives byte-equivalent frozen wire", async () => {
    const selection = captureSelection();
    const wires: NativeToolResult[] = [];
    const coordinator = fakeCoordinator({
      captureOutputForCall: async () => selection,
      registerOutputCaptureProjection: (
        _source: unknown,
        _action: unknown,
        _outcome: unknown,
        wire: NativeToolResult,
      ) => {
        wires.push(wire);
        return { ok: true, reason: null };
      },
    });
    const entry = entryFor(fakeRoot(coordinator));
    const first = await call(entry, "capture-duplicate", { action: "capture", sourceToolCallId: "source-1" });
    const second = await call(entry, "capture-duplicate", { action: "capture", sourceToolCallId: "source-1" });
    expect(textOf(first)).toBe(textOf(second));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(wires).toHaveLength(2);
    expect(wires[0]).toBe(first);
    expect(wires[1]).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.content)).toBe(true);
  });

  test("refuses registration failure or throw and never returns an unregistered success", async () => {
    const refused = entryFor(fakeRoot(fakeCoordinator({
      captureOutputForCall: async () => captureSelection(),
      registerOutputCaptureProjection: () => ({ ok: false, reason: "no expectation slot" }),
    })));
    const refusedWire = await call(refused, "capture-refused", { action: "capture", sourceToolCallId: "source-1" });
    expect(refusedWire.isError).toBe(true);
    expect(payloadOf(refusedWire).error).toMatchObject({ code: "coordinator-refused" });
    expect(textOf(refusedWire)).not.toContain("captureDigest");

    const thrown = entryFor(fakeRoot(fakeCoordinator({
      captureOutputForCall: async () => captureSelection(),
      registerOutputCaptureProjection: () => {
        throw new Error("/private/secret/registration exploded");
      },
    })));
    const thrownWire = await call(thrown, "capture-thrown", { action: "capture", sourceToolCallId: "source-1" });
    expect(thrownWire.isError).toBe(true);
    expect(payloadOf(thrownWire).error).toMatchObject({ code: "coordinator-refused" });
    expect(textOf(thrownWire)).not.toContain("/private/secret");
  });

  test("refuses disposed adapters and late disposal without creating success or disposing the root", async () => {
    let disposeCalls = 0;
    let entry!: NativeHarnessResultEntry;
    let registrations = 0;
    const coordinator = fakeCoordinator({
      captureOutputForCall: async () => {
        entry.dispose();
        return captureSelection();
      },
      registerOutputCaptureProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
      dispose: () => {
        disposeCalls += 1;
      },
    });
    let rootCalls = 0;
    entry = entryFor(() => {
      rootCalls += 1;
      return { ok: true, root: fakeRoot(coordinator) };
    });
    const late = await call(entry, "capture-late", { action: "capture", sourceToolCallId: "source-1" });
    expect(late.isError).toBe(true);
    expect(registrations).toBe(0);
    expect(disposeCalls).toBe(0);
    const after = await call(entry, "capture-after-dispose", { action: "capture", sourceToolCallId: "source-1" });
    expect(after.isError).toBe(true);
    expect(payloadOf(after).error).toMatchObject({ code: "disposed" });
    expect(rootCalls).toBe(1);
  });

  test("refuses a late aborted signal before capture registration", async () => {
    const controller = new AbortController();
    let registrations = 0;
    const coordinator = fakeCoordinator({
      captureOutputForCall: async () => {
        controller.abort();
        return captureSelection();
      },
      registerOutputCaptureProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
    });
    const entry = entryFor(fakeRoot(coordinator));
    const wire = await call(entry, "capture-aborted", { action: "capture", sourceToolCallId: "source-1" }, controller.signal);
    expect(wire.isError).toBe(true);
    expect(payloadOf(wire).error).toMatchObject({ code: "cancelled" });
    expect(registrations).toBe(0);
  });

  test("returns a bounded error when the capture promise rejects", async () => {
    const coordinator = fakeCoordinator({
      captureOutputForCall: async () => {
        throw new Error("/private/secret/provider failure token abc");
      },
    });
    const entry = entryFor(fakeRoot(coordinator));
    const wire = await call(entry, "capture-rejected", { action: "capture", sourceToolCallId: "source-1" });
    expect(wire.isError).toBe(true);
    expect(payloadOf(wire).error).toMatchObject({ code: "coordinator-refused" });
    expect(textOf(wire)).not.toContain("/private/secret");
    expect(textOf(wire)).not.toContain("token abc");
  });
});

describe("native harness result read and inspect operations", () => {
  test("returns the exact historical text once with file and capture identities separated", async () => {
    const marker = "EXACT-ARTIFACT-MARKER-7f3a";
    const text = `  ${marker}\r\nquoted "value" and \\t\n\n/private/mentioned-in-artifact.txt  `;
    const captured: Array<{ id: unknown; input: unknown; signal: unknown }> = [];
    let registrations = 0;
    const coordinator = fakeCoordinator({
      readOutputForCall: (id: unknown, input: unknown, signal: unknown) => {
        captured.push({ id, input, signal });
        return readSelection(id as string, input as NativeHarnessReadInput, text, "snapshot-file-9");
      },
      registerOutputCaptureProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
      registerOutputCheckProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
    });
    const entry = entryFor(fakeRoot(coordinator));
    const signal = actualSignal();
    const wire = await call(entry, "read-action-1", {
      action: "read",
      sourceToolCallId: "source-1",
      captureId: "capture-1",
      captureDigest: "a".repeat(64),
      path: "out.txt",
    }, signal);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.id).toBe("read-action-1");
    expect(captured[0]?.signal).toBe(signal);
    expect(registrations).toBe(0);
    expect(wire.isError).toBeUndefined();
    expect(wire.details).toBeUndefined();
    const payload = payloadOf(wire);
    expect(payload.action).toBe("read");
    expect(payload.captureId).toBeUndefined();
    expect(payload.selectors).toMatchObject({
      sourceToolCallId: "source-1",
      captureId: "capture-1",
      captureDigest: "a".repeat(64),
      path: "out.txt",
    });
    expect(payload.fileSnapshotId).toBe("snapshot-file-9");
    expect(payload.text).toBe(text);
    expect((payload.file as Record<string, unknown>).relativePath).toBe("out.txt");
    expect(JSON.stringify(wire).split(marker)).toHaveLength(2);
    expect(JSON.stringify(wire)).toContain("/private/mentioned-in-artifact.txt");
    expect(payload).toMatchObject({
      observation: "cached-historical",
      filesystemFreshness: "not-rechecked",
      taskAccepted: false,
      semanticAcceptance: "not-evaluated",
    });
    expect(payload).not.toHaveProperty("understood");
    expect(payload).not.toHaveProperty("modelRead");
  });

  test("does not apply the 64 KiB observer profile to a large historical read", async () => {
    const text = "a".repeat(70 * 1024);
    const coordinator = fakeCoordinator({
      readOutputForCall: (id: unknown, input: unknown) => readSelection(
        id as string,
        input as NativeHarnessReadInput,
        text,
      ),
    });
    const entry = entryFor(fakeRoot(coordinator));
    const wire = await call(entry, "read-large", {
      action: "read",
      sourceToolCallId: "source-1",
      captureId: "capture-1",
      captureDigest: "a".repeat(64),
      path: "out.txt",
    });
    expect(wire.isError).toBeUndefined();
    const payload = payloadOf(wire);
    expect((payload.text as string).length).toBe(text.length);
    expect(wireBytes(wire)).toBeGreaterThan(64 * 1024);
    expect(wireBytes(wire)).toBeLessThanOrEqual(MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES);
  });

  test("projects the complete inspect scope, counts and rows without query registration", async () => {
    const catalog = inspectSelection();
    const withPrivate = Object.assign(catalog, {
      excludedSources: [{ sourceToolCallId: "/private/excluded-source" }],
      workspaceRoot: "/private/workspace/root",
    });
    const input = normalizedInspect();
    const calls: Array<{ id: unknown; input: unknown; signal: unknown }> = [];
    let registrations = 0;
    const coordinator = fakeCoordinator({
      inspectOutputsForCall: (id: unknown, actualInput: unknown, signal: unknown) => {
        calls.push({ id, input: actualInput, signal });
        return withPrivate;
      },
      registerOutputCaptureProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
      registerOutputCheckProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
    });
    const entry = entryFor(fakeRoot(coordinator));
    const signal = actualSignal();
    const wire = await call(entry, "inspect-action-1", { action: "inspect" }, signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe("inspect-action-1");
    expect(calls[0]?.input).toEqual(input);
    expect(calls[0]?.signal).toBe(signal);
    expect(registrations).toBe(0);
    expect(wire.isError).toBeUndefined();
    const payload = payloadOf(wire);
    expect(payload).toMatchObject({
      action: "inspect",
      scope: "retained-sources-in-this-root",
      scanComplete: true,
      retainedSources: 4,
      returnedSources: 2,
      excludedNotReady: 1,
      excludedUnavailable: 1,
      taskAccepted: false,
      semanticAcceptance: "not-evaluated",
    });
    const rows = payload.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sourceToolCallId: "source-1",
      outputState: "captured",
      capture: {
        captureId: "capture-1",
        captureDigest: "a".repeat(64),
        files: [{ path: "out.txt", kind: "add", bytes: 12, sha256: "b".repeat(64), observedAt: 17 }],
      },
    });
    expect(rows[1]).toEqual({ sourceToolCallId: "source-2", outputState: "idle", capture: null });
    expect(JSON.stringify(wire)).not.toContain("/private");
    expect(JSON.stringify(wire)).not.toContain("excludedSources");
  });

  test("does not turn an unavailable catalog into an empty complete catalog", async () => {
    const coordinator = fakeCoordinator({
      inspectOutputsForCall: () => ({ ok: false, code: "output-unavailable", reason: "catalog unavailable" }),
    });
    const entry = entryFor(fakeRoot(coordinator));
    const wire = await call(entry, "inspect-unavailable", { action: "inspect" });
    expect(wire.isError).toBe(true);
    expect(payloadOf(wire).error).toMatchObject({ code: "coordinator-refused" });
    expect(payloadOf(wire)).not.toHaveProperty("rows");
  });

  test("refuses read or inspect after late disposal or actual signal abort", async () => {
    let entry!: NativeHarnessResultEntry;
    const disposeCoordinator = fakeCoordinator({
      readOutputForCall: (id: unknown, input: unknown) => {
        entry.dispose();
        return readSelection(id as string, input as NativeHarnessReadInput, "text");
      },
    });
    entry = entryFor(fakeRoot(disposeCoordinator));
    const disposed = await call(entry, "read-disposed", {
      action: "read",
      sourceToolCallId: "source-1",
      captureId: "capture-1",
      captureDigest: "a".repeat(64),
      path: "out.txt",
    });
    expect(disposed.isError).toBe(true);
    expect(payloadOf(disposed).error).toMatchObject({ code: "disposed" });

    const controller = new AbortController();
    const abortCoordinator = fakeCoordinator({
      inspectOutputsForCall: () => {
        controller.abort();
        return inspectSelection();
      },
    });
    const abortEntry = entryFor(fakeRoot(abortCoordinator));
    const aborted = await call(abortEntry, "inspect-aborted-late", { action: "inspect" }, controller.signal);
    expect(aborted.isError).toBe(true);
    expect(payloadOf(aborted).error).toMatchObject({ code: "cancelled" });
  });
});

describe("native harness result check operation", () => {
  async function realCheck(
    actualToolCallId: string,
    text: string,
    value: string,
  ): Promise<{ input: NativeHarnessCheckInput; response: NativeHarnessCheckSuccess }> {
    const dir = await mkdtemp(path.join(tmpdir(), "omp-agent-g53b1d1-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "out.txt"), text, { mode: 0o600 });
    const snapshot = await captureWorkspaceText(dir, "out.txt");
    const normalized = normalizeNativeHarnessCheckInput({
      action: "check",
      sourceToolCallId: "source-1",
      captureId: "capture-1",
      captureDigest: "a".repeat(64),
      path: "out.txt",
      conditions: [{ id: "condition-1", kind: "text-includes", value }],
    });
    if (!normalized.ok) throw new Error(normalized.reason);
    const receipt = runNativeTextChecks(snapshot, normalized.plan);
    const pathRecord = createNativeHarnessCheckPathRecord({
      captureId: normalized.input.captureId,
      captureDigest: normalized.input.captureDigest,
      path: normalized.input.path,
      snapshot,
      plan: normalized.plan,
      receipt,
      computedByToolCallId: "original-computation-call",
    });
    if (pathRecord === null) throw new Error("check path record unavailable");
    return {
      input: normalized.input,
      response: createNativeHarnessCheckResponse(actualToolCallId, normalized.input, pathRecord),
    };
  }

  test("returns authentic PASS and FAIL receipts as successful tool executions", async () => {
    for (const expectation of [
      { text: "the thing is present", value: "thing", receipt: "pass", detail: "condition satisfied" },
      { text: "no match here", value: "thing", receipt: "fail", detail: "required text was not found in the captured text" },
    ]) {
      const actualToolCallId = `check-${expectation.receipt}`;
      const fixture = await realCheck(actualToolCallId, expectation.text, expectation.value);
      const registered: Array<{
        source: unknown;
        action: unknown;
        response: unknown;
        wire: NativeToolResult;
        signal: unknown;
      }> = [];
      const coordinator = fakeCoordinator({
        checkOutput: () => fixture.response,
        registerOutputCheckProjection: (
          source: unknown,
          action: unknown,
          response: unknown,
          wire: NativeToolResult,
          signal: unknown,
        ) => {
          registered.push({ source, action, response, wire, signal });
          return { ok: true, reason: null };
        },
      });
      const entry = entryFor(fakeRoot(coordinator));
      const signal = actualSignal();
      const wire = await call(entry, actualToolCallId, fixture.input, signal);
      expect(wire.isError).toBeUndefined();
      expect(registered).toHaveLength(1);
      expect(registered[0]?.source).toBe("source-1");
      expect(registered[0]?.action).toBe(actualToolCallId);
      expect(registered[0]?.response).toBe(fixture.response);
      expect(registered[0]?.wire).toBe(wire);
      expect(registered[0]?.signal).toBe(signal);
      const payload = payloadOf(wire);
      expect(payload.action).toBe("check");
      expect(payload.actionToolCallId).toBe(actualToolCallId);
      expect(payload.originalComputationToolCallId).toBe("original-computation-call");
      expect(payload.selectors).toMatchObject({
        sourceToolCallId: "source-1",
        captureId: "capture-1",
        captureDigest: "a".repeat(64),
        path: "out.txt",
      });
      expect(payload.checker).toEqual({ id: NATIVE_TEXT_CHECKER_ID, version: NATIVE_TEXT_CHECKER_VERSION });
      expect(payload.plan).toEqual({
        source: "model-proposed-after-capture",
        digest: (fixture.response.planDigest as string),
      });
      expect(payload).not.toHaveProperty("conditions");
      const receipt = payload.receipt as Record<string, unknown>;
      expect(receipt.outcome).toBe(expectation.receipt);
      expect(receipt.fileSnapshotId).toBe(fixture.response.receipt.snapshot.captureId);
      expect(receipt.conditions).toEqual([{
        id: "condition-1",
        result: expectation.receipt,
        detail: expectation.detail,
      }]);
      expect(textOf(wire)).toContain(`"outcome":"${expectation.receipt}"`);
      expect(textOf(wire)).toContain(expectation.detail);
      expect(payload).toMatchObject({
        observation: "cached-historical",
        filesystemFreshness: "not-rechecked",
        taskAccepted: false,
        semanticAcceptance: "not-evaluated",
      });
    }
  });

  test("refuses check registration failure or thrown registration without success", async () => {
    const input = normalizedCheck();
    const response = checkSelection("check-registration", input, "pass", "condition satisfied");
    const refused = entryFor(fakeRoot(fakeCoordinator({
      checkOutput: () => response,
      registerOutputCheckProjection: () => ({ ok: false, reason: "expectation slot unavailable" }),
    })));
    const refusedWire = await call(refused, "check-registration", input);
    expect(refusedWire.isError).toBe(true);
    expect(payloadOf(refusedWire).error).toMatchObject({ code: "coordinator-refused" });

    const thrown = entryFor(fakeRoot(fakeCoordinator({
      checkOutput: () => response,
      registerOutputCheckProjection: () => {
        throw new Error("/private/secret/check registration exploded");
      },
    })));
    const thrownWire = await call(thrown, "check-registration", input);
    expect(thrownWire.isError).toBe(true);
    expect(payloadOf(thrownWire).error).toMatchObject({ code: "coordinator-refused" });
    expect(textOf(thrownWire)).not.toContain("/private/secret");
  });

  test("refuses late disposal and late signal abort before check registration", async () => {
    const input = normalizedCheck();
    const response = checkSelection("check-late", input, "pass", "condition satisfied");
    let entry!: NativeHarnessResultEntry;
    let registrations = 0;
    const coordinator = fakeCoordinator({
      checkOutput: () => {
        entry.dispose();
        return response;
      },
      registerOutputCheckProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
    });
    entry = entryFor(fakeRoot(coordinator));
    const disposed = await call(entry, "check-late", input);
    expect(disposed.isError).toBe(true);
    expect(payloadOf(disposed).error).toMatchObject({ code: "disposed" });
    expect(registrations).toBe(0);

    const controller = new AbortController();
    let abortedRegistrations = 0;
    const abortedEntry = entryFor(fakeRoot(fakeCoordinator({
      checkOutput: () => {
        controller.abort();
        return checkSelection("check-aborted", input, "pass", "condition satisfied");
      },
      registerOutputCheckProjection: () => {
        abortedRegistrations += 1;
        return { ok: true, reason: null };
      },
    })));
    const aborted = await call(abortedEntry, "check-aborted", input, controller.signal);
    expect(aborted.isError).toBe(true);
    expect(payloadOf(aborted).error).toMatchObject({ code: "cancelled" });
    expect(abortedRegistrations).toBe(0);
  });

  test("refuses a 256 KiB complete wire overflow for check without registering", async () => {
    const input = normalizedCheck("source-1", "capture-1", "a".repeat(64), "out.txt", [
      { id: "condition-1", kind: "json-valid" },
    ]);
    const response = checkSelection("check-overflow", input, "pass", "x".repeat(300 * 1024));
    let registrations = 0;
    const coordinator = fakeCoordinator({
      checkOutput: () => response,
      registerOutputCheckProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
    });
    const entry = entryFor(fakeRoot(coordinator));
    const wire = await call(entry, "check-overflow", input);
    expect(wire.isError).toBe(true);
    expect(payloadOf(wire)).toMatchObject({
      error: { code: "encoding-overflow" },
      limit: MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES,
    });
    expect((payloadOf(wire).bytes as number)).toBeGreaterThan(MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES);
    expect(registrations).toBe(0);
    expect(textOf(wire)).not.toContain("x".repeat(100));
  });
});

describe("native harness result final resolution boundary", () => {
  async function realCheckOutcome(actualToolCallId: string): Promise<NativeHarnessCheckSuccess> {
    const dir = await mkdtemp(path.join(tmpdir(), "omp-agent-g53b1d1-boundary-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "out.txt"), "the thing is present", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(dir, "out.txt");
    const normalized = normalizeNativeHarnessCheckInput({
      action: "check",
      sourceToolCallId: "source-1",
      captureId: "capture-1",
      captureDigest: "a".repeat(64),
      path: "out.txt",
      conditions: [{ id: "condition-1", kind: "text-includes", value: "thing" }],
    });
    if (!normalized.ok) throw new Error(normalized.reason);
    const receipt = runNativeTextChecks(snapshot, normalized.plan);
    const pathRecord = createNativeHarnessCheckPathRecord({
      captureId: normalized.input.captureId,
      captureDigest: normalized.input.captureDigest,
      path: normalized.input.path,
      snapshot,
      plan: normalized.plan,
      receipt,
      computedByToolCallId: "original-computation-call",
    });
    if (pathRecord === null) throw new Error("check path record unavailable");
    return createNativeHarnessCheckResponse(actualToolCallId, normalized.input, pathRecord);
  }

  test("a scope throw after a prepared check success returns a bounded failure", async () => {
    const actualToolCallId = "scope-check-throw";
    const response = await realCheckOutcome(actualToolCallId);
    const input = normalizedCheck("source-1", response.captureId, response.captureDigest, response.path);
    let registrations = 0;
    const coordinator = fakeCoordinator({
      checkOutput: () => response,
      registerOutputCheckProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
    });
    const entry = entryFor(fakeRoot(coordinator, {
      runWithContext: (_context, _id, operation) => {
        operation();
        throw new Error("/private/secret/scope throw after success");
      },
    }));
    const wire = await call(entry, actualToolCallId, input);
    expect(registrations).toBe(1);
    expect(wire.isError).toBe(true);
    expect(payloadOf(wire).error).toMatchObject({ code: "coordinator-refused" });
    expect(textOf(wire)).not.toContain("/private/secret");
  });

  test("a scope rejection after a prepared read success returns a bounded failure", async () => {
    const actualToolCallId = "scope-read-reject";
    const input = normalizedRead();
    let reads = 0;
    const coordinator = fakeCoordinator({
      readOutputForCall: (id: unknown, actualInput: unknown) => {
        reads += 1;
        return readSelection(id as string, actualInput as NativeHarnessReadInput, "scope text");
      },
    });
    const entry = entryFor(fakeRoot(coordinator, {
      runWithContext: (_context, _id, operation) => {
        operation();
        return Promise.reject(new Error("/private/secret/scope rejection after success"));
      },
    }));
    const wire = await call(entry, actualToolCallId, input);
    expect(reads).toBe(1);
    expect(wire.isError).toBe(true);
    expect(payloadOf(wire).error).toMatchObject({ code: "coordinator-refused" });
    expect(textOf(wire)).not.toContain("/private/secret");
  });

  test("a double-microtask abort after check registration refuses the prepared success", async () => {
    const actualToolCallId = "check-double-abort";
    const response = await realCheckOutcome(actualToolCallId);
    const input = normalizedCheck("source-1", response.captureId, response.captureDigest, response.path);
    const controller = new AbortController();
    let registrations = 0;
    const coordinator = fakeCoordinator({
      checkOutput: () => response,
      registerOutputCheckProjection: () => {
        registrations += 1;
        queueMicrotask(() => {
          queueMicrotask(() => controller.abort());
        });
        return { ok: true, reason: null };
      },
    });
    const entry = entryFor(fakeRoot(coordinator));
    const wire = await call(entry, actualToolCallId, input, controller.signal);
    expect(registrations).toBe(1);
    expect(wire.isError).toBe(true);
    expect(payloadOf(wire).error).toMatchObject({ code: "cancelled" });
  });
});

describe("native harness result capture late reactions", () => {
  test("a later original-promise reaction that disposes refuses the prepared success", async () => {
    let resolveCapture!: (value: NativeHarnessOutputSelection) => void;
    const capturePromise = new Promise<NativeHarnessOutputSelection>((resolve) => {
      resolveCapture = resolve;
    });
    let entry!: NativeHarnessResultEntry;
    let registrations = 0;
    const coordinator = fakeCoordinator({
      captureOutputForCall: () => capturePromise,
      registerOutputCaptureProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
    });
    entry = entryFor(fakeRoot(coordinator));
    const executing = call(entry, "capture-late-dispose", {
      action: "capture",
      sourceToolCallId: "source-1",
    });
    // Attach the real extra reaction after the adapter attached its own
    // continuation inside the scoped operation.
    void capturePromise.then(() => entry.dispose());
    resolveCapture(captureSelection());
    const wire = await executing;
    expect(registrations).toBe(1);
    expect(wire.isError).toBe(true);
    expect(payloadOf(wire).error).toMatchObject({ code: "disposed" });
  });

  test("a registration microtask that aborts refuses the prepared success", async () => {
    const controller = new AbortController();
    let registrations = 0;
    const coordinator = fakeCoordinator({
      captureOutputForCall: async () => captureSelection(),
      registerOutputCaptureProjection: () => {
        registrations += 1;
        queueMicrotask(() => controller.abort());
        return { ok: true, reason: null };
      },
    });
    const entry = entryFor(fakeRoot(coordinator));
    const wire = await call(entry, "capture-late-abort", {
      action: "capture",
      sourceToolCallId: "source-1",
    }, controller.signal);
    expect(registrations).toBe(1);
    expect(wire.isError).toBe(true);
    expect(payloadOf(wire).error).toMatchObject({ code: "cancelled" });
  });
});

describe("native harness result encoded budgets and determinism", () => {
  test("accepts the exact 256 KiB read-wire boundary with escapes and multibyte text", async () => {
    const suffix = "\n\"\\\u0000😀";
    const input = normalizedRead();
    const coordinator = fakeCoordinator({
      readOutputForCall: (id: unknown, actualInput: unknown) => {
        const selected = actualInput as NativeHarnessReadInput;
        const outcome = readSelection(id as string, selected, coordinatorText);
        (outcome.snapshot.file as { bytes: number; sha256: string }).bytes = 1;
        (outcome.snapshot.file as { bytes: number; sha256: string }).sha256 = "b".repeat(64);
        return outcome;
      },
    });
    let coordinatorText = suffix;
    const entry = entryFor(fakeRoot(coordinator));
    const first = await call(entry, "read-b0", input);
    expect(first.isError).toBeUndefined();
    const baseBytes = wireBytes(first);
    const maxPadding = MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES - baseBytes;
    expect(maxPadding).toBeGreaterThan(0);
    coordinatorText = "a".repeat(maxPadding) + suffix;
    const exact = await call(entry, "read-b1", input);
    expect(exact.isError).toBeUndefined();
    expect(wireBytes(exact)).toBe(MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES);
    expect(payloadOf(exact).text).toBe(coordinatorText);
    coordinatorText = "a".repeat(maxPadding + 1) + suffix;
    const over = await call(entry, "read-b2", input);
    expect(over.isError).toBe(true);
    expect(payloadOf(over)).toMatchObject({
      error: { code: "encoding-overflow" },
      limit: MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES,
    });
    expect((payloadOf(over).bytes as number)).toBeGreaterThan(MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES);
    expect(payloadOf(over)).not.toHaveProperty("text");
  });

  test("refuses a capture wire over 256 KiB without registering or truncating", async () => {
    const hugePath = "x".repeat(300 * 1024);
    const selection = captureSelection("source-1", [{ path: hugePath, text: "small" }]);
    let registrations = 0;
    const entry = entryFor(fakeRoot(fakeCoordinator({
      captureOutputForCall: async () => selection,
      registerOutputCaptureProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
    })));
    const wire = await call(entry, "capture-overflow", { action: "capture", sourceToolCallId: "source-1" });
    expect(wire.isError).toBe(true);
    expect(payloadOf(wire)).toMatchObject({
      error: { code: "encoding-overflow" },
      limit: MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES,
    });
    expect(registrations).toBe(0);
    expect(payloadOf(wire)).not.toHaveProperty("files");
    expect(textOf(wire)).not.toContain("x".repeat(100));
  });

  test("accepts exactly 64 KiB excepted projection and refuses the next byte before registration", async () => {
    const input = normalizedCheck("source-1", "capture-1", "a".repeat(64), "out.txt", [
      { id: "condition-1", kind: "json-valid" },
    ]);
    const outcomeFor = (id: string, detail: string): NativeHarnessCheckSuccess =>
      checkSelection(id, input, "pass", detail);
    const outcomes = new Map<string, NativeHarnessCheckSuccess>();
    let registrations = 0;
    const coordinator = fakeCoordinator({
      checkOutput: (id: unknown) => {
        return outcomes.get(id as string) ?? outcomeFor(id as string, "");
      },
      registerOutputCheckProjection: () => {
        registrations += 1;
        return { ok: true, reason: null };
      },
    });
    const entry = entryFor(fakeRoot(coordinator));
    outcomes.set("check64a", outcomeFor("check64a", ""));
    const base = await call(entry, "check64a", input);
    expect(base.isError).toBeUndefined();
    const expected = fingerprintExpectedCallResult({ input, result: base });
    if (!expected.ok) throw new Error(expected.reason);
    const maxDetail = NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES - expected.fingerprint.bytes;
    expect(maxDetail).toBeGreaterThan(0);
    outcomes.set("check64b", outcomeFor("check64b", "a".repeat(maxDetail)));
    const exact = await call(entry, "check64b", input);
    expect(exact.isError).toBeUndefined();
    const exactExpected = fingerprintExpectedCallResult({ input, result: exact });
    if (!exactExpected.ok) throw new Error(exactExpected.reason);
    expect(exactExpected.fingerprint.bytes).toBe(NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES);
    const registrationsAtExact = registrations;
    outcomes.set("check64c", outcomeFor("check64c", "a".repeat(maxDetail + 1)));
    const over = await call(entry, "check64c", input);
    expect(over.isError).toBe(true);
    expect(payloadOf(over).error).toMatchObject({ code: "encoding-failure" });
    expect(registrations).toBe(registrationsAtExact);
  });
});
