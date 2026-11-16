import { Buffer } from "node:buffer";
import type { NativeContext, NativeToolResult } from "./native-entry.ts";
import {
  NATIVE_HARNESS_MAX_TASK_BYTES,
  NATIVE_HARNESS_TOOL,
  type NativeHarnessBackendStatus,
  type NativeHarnessCancellationState,
  type NativeHarnessDelegationCoordinator,
  type NativeHarnessDelegationCost,
  type NativeHarnessDelegationResult,
  type NativeHarnessDelegationSnapshot,
  type NativeHarnessExecutionState,
  type NativeHarnessOutcome,
  type NativeHarnessTermination,
} from "./native-harness-delegation.ts";
import { deepFreeze } from "./native-work.ts";

/**
 * Bounded `agent_harness` tool adapter.
 *
 * This module owns no scheduler, backend, context ledger, native observer,
 * task owner or second native entry. The trusted root resolver supplies the
 * one 2A coordinator already owned by the actual main root, and scopes the
 * actual execute context for that coordinator's fresh gates.
 */

export const NATIVE_HARNESS_ENTRY_SCHEMA = "omp-agent.native-harness-entry.v1";
export const NATIVE_HARNESS_TOOL_RESULT_SCHEMA = "omp-agent.native-harness-tool-result.v1";
export const NATIVE_HARNESS_ENTRY_INSPECTION_SCHEMA = "omp-agent.native-harness-entry-inspection.v1";
export const MAX_NATIVE_HARNESS_TOOL_RESULT_BYTES = 16 * 1024;
const MAX_TOOL_CALL_ID_CHARS = 256;
const MAX_REASON_CHARS = 320;
const MAX_LIMITATIONS = 6;

const ACTUAL_ABORTED_GETTER = (() => {
  try {
    return Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null;
  } catch {
    return null;
  }
})();

const AGENT_HARNESS_PARAMETERS = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description: "Complete implementation task for the Harness2 delegation; no paths, models, budget or host overrides.",
    },
  },
  required: ["task"],
  additionalProperties: false,
} as const;

const HARNESS_DESCRIPTION = [
  "Run one bounded, non-authoritative Harness2 delegation for the owning main root.",
  "The task may spawn real provider processes and use the host-selected input snapshot; it is not a read-only operation.",
  "This tool accepts only a task string and never model, path, auth, budget or host fields.",
  "A result is an execution fact, not task acceptance: taskAccepted is always false and semantic acceptance is not evaluated.",
].join(" ");

type StrictFields = ReadonlyMap<string, unknown>;

export interface NativeHarnessToolResult {
  readonly schema: typeof NATIVE_HARNESS_TOOL_RESULT_SCHEMA;
  readonly tool: typeof NATIVE_HARNESS_TOOL;
  readonly authority: "non-authoritative";
  readonly resultKind: "refused" | "live" | "historical";
  readonly historical: boolean;
  readonly authorityFresh: boolean;
  readonly outcome: NativeHarnessOutcome;
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
  readonly runId: string | null;
  readonly backendStatus: NativeHarnessBackendStatus | null;
  readonly executionState: NativeHarnessExecutionState;
  readonly termination: NativeHarnessTermination;
  readonly cancellation: NativeHarnessCancellationState;
  readonly cancelError: string | null;
  readonly deadlineAt: number | null;
  readonly elapsedMs: number;
  readonly cost: NativeHarnessDelegationCost;
  readonly limitations: readonly string[];
  readonly reason: string | null;
}

export interface NativeHarnessEntryInspection {
  readonly schema: typeof NATIVE_HARNESS_ENTRY_INSPECTION_SCHEMA;
  readonly authority: "non-authoritative";
  readonly available: boolean;
  readonly reason: string | null;
  readonly coordinator: NativeHarnessDelegationSnapshot | null;
  readonly backend: readonly unknown[] | null;
}

/**
 * INTERNAL trusted root handle. `runWithContext` scopes the actual execute
 * context for the coordinator's asynchronous gates; `diagnostics` exposes only
 * the existing backend inspection facts for acceptance, never authority.
 */
export interface NativeHarnessResolvedRoot {
  readonly coordinator: NativeHarnessDelegationCoordinator;
  runWithContext<T>(
    context: NativeContext,
    actualToolCallId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  readonly diagnostics: () => readonly unknown[];
}

export type NativeHarnessRootResolution =
  | { readonly ok: true; readonly root: NativeHarnessResolvedRoot }
  | { readonly ok: false; readonly reason: string };

export interface NativeHarnessEntryOptions {
  resolveRoot(context: NativeContext): NativeHarnessRootResolution;
}

export interface NativeHarnessTool {
  readonly name: typeof NATIVE_HARNESS_TOOL;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly approval: "exec";
  readonly loadMode: "discoverable";
  readonly defaultInactive: true;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: NativeContext,
  ): Promise<NativeToolResult>;
}

export interface NativeHarnessEntry {
  readonly tool: NativeHarnessTool;
  /** Host-only, non-authoritative inspection of the existing coordinator/backend. */
  inspect(context: NativeContext): NativeHarnessEntryInspection;
  /** Releases only this adapter; never disposes the root coordinator/backend. */
  dispose(): void;
}

interface EntryLifecycle {
  disposed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpaqueRef(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStrictFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): StrictFields | null {
  if (!isRecord(value)) return null;
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (keys.length > allowed.length || keys.some((key) => typeof key !== "string")) return null;
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) return null;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      return null;
    }
    fields.set(key, descriptor.value);
  }
  for (const key of required) {
    if (!fields.has(key)) return null;
  }
  return fields;
}

function boundedText(value: string, max: number): string {
  const raw = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const normalized = raw.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function publicText(value: string, max: number): string {
  // Backend/store errors can contain absolute host paths. The tool result is
  // model-visible, so keep the bounded diagnostic without those locations.
  return boundedText(value, max)
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'`<>]+/g, "[path]")
    .replace(/\b(?:api[_-]?key|token|secret|authorization)\b[^\s,;]*/gi, "[redacted]");
}

function boundedReason(value: unknown): string {
  return publicText(typeof value === "string" ? value : "the harness operation was refused", MAX_REASON_CHARS);
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOOL_CALL_ID_CHARS) return null;
  if (value.includes("\0")) return null;
  return value;
}

function parseTaskInput(value: unknown): { readonly ok: true; readonly task: string } | { readonly ok: false; readonly reason: string } {
  const fields = readStrictFields(value, ["task"], ["task"]);
  if (fields === null) {
    return { ok: false, reason: "agent_harness input must be an exact plain own-data object with only a task field" };
  }
  const task = fields.get("task");
  if (typeof task !== "string" || task.trim().length === 0) {
    return { ok: false, reason: "agent_harness task must be a nonempty string" };
  }
  if (task.includes("\0")) {
    return { ok: false, reason: "agent_harness task must not contain NUL" };
  }
  if (Buffer.byteLength(task, "utf8") > NATIVE_HARNESS_MAX_TASK_BYTES) {
    return { ok: false, reason: `agent_harness task exceeds ${NATIVE_HARNESS_MAX_TASK_BYTES} UTF-8 bytes` };
  }
  return { ok: true, task };
}

function readActualAbortSignal(signal: unknown):
  | { readonly ok: true; readonly aborted: boolean }
  | { readonly ok: false; readonly reason: string } {
  if (signal === undefined || signal === null) {
    return { ok: false, reason: "the actual host AbortSignal is missing" };
  }
  if (ACTUAL_ABORTED_GETTER === null) {
    return { ok: false, reason: "the host AbortSignal aborted getter is unavailable" };
  }
  try {
    const aborted: unknown = Reflect.apply(ACTUAL_ABORTED_GETTER, signal, []);
    if (typeof aborted !== "boolean") {
      return { ok: false, reason: "the host AbortSignal aborted state is unreadable" };
    }
    return { ok: true, aborted };
  } catch {
    return { ok: false, reason: "the supplied signal is not a readable actual host AbortSignal" };
  }
}

function isActualMainContext(context: unknown): boolean {
  try {
    return typeof context === "object"
      && context !== null
      && (context as NativeContext).agent?.kind === "main";
  } catch {
    return false;
  }
}

function zeroCost(): NativeHarnessDelegationCost {
  return Object.freeze({ allocatedUsd: 0, observedUsd: null, unknownUsd: 0, overspendUsd: 0 });
}

function refusalPayload(reason: string): NativeHarnessToolResult {
  return {
    schema: NATIVE_HARNESS_TOOL_RESULT_SCHEMA,
    tool: NATIVE_HARNESS_TOOL,
    authority: "non-authoritative",
    resultKind: "refused",
    historical: false,
    authorityFresh: false,
    outcome: "refused",
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    runId: null,
    backendStatus: null,
    executionState: "not-started",
    termination: "none",
    cancellation: "none",
    cancelError: null,
    deadlineAt: null,
    elapsedMs: 0,
    cost: zeroCost(),
    limitations: [],
    reason: boundedReason(reason),
  };
}

interface EncodedProjection {
  readonly wire: NativeToolResult;
  /** False only for a synthetic fallback that must never be registered. */
  readonly exact: boolean;
}

function encodeProjection(payload: NativeHarnessToolResult, isError: boolean): EncodedProjection {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, "utf8") > MAX_NATIVE_HARNESS_TOOL_RESULT_BYTES) {
    const fallback = refusalPayload("the bounded harness tool response did not fit");
    const fallbackText = JSON.stringify(fallback);
    return {
      wire: deepFreeze({
        content: [{ type: "text", text: fallbackText }],
        details: fallback,
        isError: true,
      }),
      exact: false,
    };
  }
  return {
    wire: deepFreeze({
      content: [{ type: "text", text }],
      details: payload,
      ...(isError ? { isError: true } : {}),
    }),
    exact: true,
  };
}

function encodeResult(payload: NativeHarnessToolResult, isError: boolean): NativeToolResult {
  return encodeProjection(payload, isError).wire;
}

function refusal(reason: string): NativeToolResult {
  return encodeResult(refusalPayload(reason), true);
}

function projectResultWire(result: NativeHarnessDelegationResult): EncodedProjection {
  if (!isRecord(result)) {
    return {
      wire: refusal("the harness coordinator returned an unreadable result"),
      exact: false,
    };
  }
  const limitations = Array.isArray(result.limitations)
    ? result.limitations
      .filter((item): item is string => typeof item === "string")
      .slice(0, MAX_LIMITATIONS)
      .map((item) => publicText(item, MAX_REASON_CHARS))
    : [];
  const cost = isRecord(result.cost)
    ? Object.freeze({
        allocatedUsd: typeof result.cost.allocatedUsd === "number" ? result.cost.allocatedUsd : 0,
        observedUsd: typeof result.cost.observedUsd === "number" ? result.cost.observedUsd : null,
        unknownUsd: typeof result.cost.unknownUsd === "number" ? result.cost.unknownUsd : 0,
        overspendUsd: typeof result.cost.overspendUsd === "number" ? result.cost.overspendUsd : 0,
      })
    : zeroCost();
  const payload: NativeHarnessToolResult = {
    schema: NATIVE_HARNESS_TOOL_RESULT_SCHEMA,
    tool: NATIVE_HARNESS_TOOL,
    authority: "non-authoritative",
    resultKind: result.resultKind === "historical"
      ? "historical"
      : result.resultKind === "live"
        ? "live"
        : "refused",
    historical: result.historical === true,
    authorityFresh: result.authorityFresh === true,
    outcome: result.outcome,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    runId: boundedId(result.runId),
    backendStatus: result.backendStatus,
    executionState: result.executionState,
    termination: result.termination,
    cancellation: result.cancellation,
    cancelError: typeof result.cancelError === "string" ? publicText(result.cancelError, MAX_REASON_CHARS) : null,
    deadlineAt: typeof result.deadlineAt === "number" && Number.isFinite(result.deadlineAt) ? result.deadlineAt : null,
    elapsedMs: typeof result.elapsedMs === "number" && Number.isFinite(result.elapsedMs) ? result.elapsedMs : 0,
    cost,
    limitations,
    reason: typeof result.reason === "string" ? publicText(result.reason, MAX_REASON_CHARS) : null,
  };
  return encodeProjection(payload, payload.resultKind === "refused");
}

function projectResult(result: NativeHarnessDelegationResult): NativeToolResult {
  return projectResultWire(result).wire;
}

function readResolution(value: unknown): NativeHarnessRootResolution {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return { ok: false, reason: "the harness root resolver returned no readable decision" };
  }
  if (value.ok === false) {
    return { ok: false, reason: boundedReason(value.reason) };
  }
  const root = value.root;
  if (!isRecord(root)
    || !isOpaqueRef(root.coordinator)
    || typeof root.runWithContext !== "function"
    || typeof root.diagnostics !== "function") {
    return { ok: false, reason: "the harness root resolver returned an unreadable root handle" };
  }
  const invoke = (root.coordinator as { invoke?: unknown }).invoke;
  if (typeof invoke !== "function") {
    return { ok: false, reason: "the harness root coordinator is unavailable" };
  }
  return { ok: true, root: root as unknown as NativeHarnessResolvedRoot };
}

function inspectRoot(
  resolveRoot: (context: NativeContext) => NativeHarnessRootResolution,
  context: NativeContext,
): NativeHarnessEntryInspection {
  let resolution: NativeHarnessRootResolution;
  try {
    resolution = readResolution(resolveRoot(context));
  } catch {
    return Object.freeze({
      schema: NATIVE_HARNESS_ENTRY_INSPECTION_SCHEMA,
      authority: "non-authoritative" as const,
      available: false,
      reason: "the harness root resolver failed",
      coordinator: null,
      backend: null,
    });
  }
  if (!resolution.ok) {
    return Object.freeze({
      schema: NATIVE_HARNESS_ENTRY_INSPECTION_SCHEMA,
      authority: "non-authoritative" as const,
      available: false,
      reason: resolution.reason,
      coordinator: null,
      backend: null,
    });
  }
  let coordinator: NativeHarnessDelegationSnapshot | null = null;
  let backend: readonly unknown[] | null = null;
  let reason: string | null = null;
  try {
    coordinator = resolution.root.coordinator.inspect();
  } catch {
    reason = "the coordinator inspection failed";
  }
  try {
    backend = Array.isArray(resolution.root.diagnostics()) ? deepFreeze([...resolution.root.diagnostics()]) : null;
    if (backend === null) reason ??= "the backend diagnostics were unreadable";
  } catch {
    reason ??= "the backend inspection failed";
  }
  return deepFreeze({
    schema: NATIVE_HARNESS_ENTRY_INSPECTION_SCHEMA,
    authority: "non-authoritative" as const,
    available: reason === null,
    reason,
    coordinator,
    backend,
  });
}

export function createNativeHarnessEntry(options: NativeHarnessEntryOptions): NativeHarnessEntry {
  if (!isRecord(options)) {
    throw new Error("Harness entry options must be an object.");
  }
  const resolveField = Object.getOwnPropertyDescriptor(options, "resolveRoot");
  if (resolveField === undefined || !("value" in resolveField) || typeof resolveField.value !== "function") {
    throw new Error("Harness entry requires a trusted resolveRoot function.");
  }
  const resolveRoot = resolveField.value as (context: NativeContext) => NativeHarnessRootResolution;
  const lifecycle: EntryLifecycle = { disposed: false };

  const tool: NativeHarnessTool = {
    name: NATIVE_HARNESS_TOOL,
    label: "Harness",
    description: HARNESS_DESCRIPTION,
    parameters: AGENT_HARNESS_PARAMETERS,
    approval: "exec",
    loadMode: "discoverable",
    defaultInactive: true,
    async execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: NativeContext,
    ): Promise<NativeToolResult> {
      if (lifecycle.disposed) return refusal("the harness entry is disposed");
      const actualToolCallId = boundedId(toolCallId);
      if (actualToolCallId === null) return refusal("the actual agent_harness tool call id is unavailable");
      const parsed = parseTaskInput(params);
      if (!parsed.ok) return refusal(parsed.reason);
      const signalRead = readActualAbortSignal(signal);
      if (!signalRead.ok) return refusal(signalRead.reason);
      if (signalRead.aborted) return refusal("the harness invocation was cancelled before admission");
      if (!isActualMainContext(context)) {
        return refusal("agent_harness is available only to the owning actual main root");
      }

      let resolution: NativeHarnessRootResolution;
      try {
        resolution = readResolution(resolveRoot(context));
      } catch {
        return refusal("the harness root resolver failed");
      }
      if (!resolution.ok) return refusal(resolution.reason);
      const resolved = resolution.root;
      let projection: NativeToolResult | null = null;
      try {
        const result = await resolved.runWithContext(
          context,
          actualToolCallId,
          () => {
            // Return the exact coordinator promise. The projection/registration
            // continuation is attached inside the scoped execute frame so ALS
            // remains available, but it must not replace the tracked promise.
            const invocation = resolved.coordinator.invoke(actualToolCallId, parsed.task, signal);
            try {
              void invocation.then(
                (delegation) => {
                  try {
                    const encoded = projectResultWire(delegation);
                    projection = encoded.wire;
                    if (!encoded.exact) return;
                    try {
                      resolved.coordinator.registerToolResultProjection?.(
                        actualToolCallId,
                        delegation,
                        encoded.wire,
                        signal as AbortSignal,
                      );
                    } catch {
                      // Output is unavailable; the valid execution result stands.
                    }
                  } catch {
                    // Projection/registration diagnostics never replace execution.
                  }
                },
                () => undefined,
              );
            } catch {
              // A malformed coordinator promise cannot be registered; execution
              // settlement still flows through the original promise.
            }
            return invocation;
          },
        );
        return projection ?? projectResult(result);
      } catch {
        return refusal("the harness coordinator invocation failed");
      }
    },
  };

  return Object.freeze({
    tool,
    inspect(context: NativeContext): NativeHarnessEntryInspection {
      try {
        return inspectRoot(resolveRoot, context);
      } catch {
        return Object.freeze({
          schema: NATIVE_HARNESS_ENTRY_INSPECTION_SCHEMA,
          authority: "non-authoritative" as const,
          available: false,
          reason: "the harness root resolver failed",
          coordinator: null,
          backend: null,
        });
      }
    },
    dispose(): void {
      lifecycle.disposed = true;
    },
  });
}
