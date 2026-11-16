import { createHash } from "node:crypto";
import type {
  CallResultExpectationRegistration,
  NativeCallCheckPreparation,
  NativeContext,
  NativeEntryControls,
  NativeWorkCallReference,
  NativeWorkCallInspection,
} from "./native-entry.ts";
import type {
  NativeHarnessOutputCapture,
  NativeHarnessOutputCaptureResult,
} from "./native-harness-output.ts";
import { deepFreeze, isNativeWorkspaceTextSnapshot } from "./native-work.ts";
import {
  NATIVE_HARNESS_MAX_CHECK_ACTIONS,
  NATIVE_HARNESS_MAX_CHECK_CONDITIONS,
  NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES,
  NATIVE_HARNESS_MAX_CHECK_PATHS,
  NATIVE_HARNESS_RESULT_TOOL,
  createNativeHarnessCheckActionRecord,
  createNativeHarnessCheckFailure,
  createNativeHarnessCheckPathRecord,
  createNativeHarnessCheckResponse,
  createNativeHarnessCheckState,
  createNativeHarnessCheckTerminalActionRecord,
  nativeHarnessCheckView,
  normalizeNativeHarnessCheckInput,
  sameNativeHarnessCheckPlan,
  type NativeHarnessCheckActionRecord,
  type NativeHarnessCheckFailure,
  type NativeHarnessCheckFailureCode,
  type NativeHarnessCheckInput,
  type NativeHarnessCheckOutcome,
  type NativeHarnessCheckRetainedActionRecord,
  type NativeHarnessCheckState,
} from "./native-harness-checks.ts";
import { fingerprintNativeJson } from "./native-instance-result.ts";
import { fingerprintExpectedCallResult } from "./native-result-expectation.ts";
import { runNativeTextChecks } from "./native-snapshot-checker.ts";
import type {
  Runner,
  WorkerRequest,
  WorkerResult,
} from "../vendor/harness2/index.ts";

/**
 * Host-only, default-off, one-shot Harness2 delegation coordinator.
 *
 * This module owns no OMP entry, tool registration, task owner, scheduler,
 * graph, candidate acceptance, apply or recovery path. It reuses the existing
 * native call controls for actual main-call authority and the trusted Harness2
 * Controller/Runner supplied by the caller. The 2A ports are protocol tests,
 * not proof of the real OMP host composition.
 */

export const NATIVE_HARNESS_DELEGATION_SCHEMA = "omp-agent.native-harness-delegation.v1";
export const NATIVE_HARNESS_DELEGATION_SNAPSHOT_SCHEMA = "omp-agent.native-harness-delegation-snapshot.v1";
export const NATIVE_HARNESS_TOOL = "agent_harness";
export const NATIVE_HARNESS_MAX_TASK_BYTES = 16 * 1024;
export const NATIVE_HARNESS_MAX_OPERATIONS = 16;
export const NATIVE_HARNESS_MAX_CONCURRENCY = 1;
export const NATIVE_HARNESS_MAX_PER_RUN_USD = 1;
export const NATIVE_HARNESS_MAX_LIFETIME_USD = 5;
export const NATIVE_HARNESS_MAX_DURATION_MS = 300_000;
export const NATIVE_HARNESS_MAX_CLEANUP_GRACE_MS = 30_000;
export const NATIVE_HARNESS_MAX_OUTPUT_CAPTURES = 8;
export const NATIVE_HARNESS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES = 1024 * 1024;
export const NATIVE_HARNESS_OUTPUT_CAPTURE_BUDGET_MS = 30_000;
const MAX_OUTPUT_CHANGES = 8;
const MAX_OUTPUT_CHANGE_BYTES = 1024 * 1024;
const MAX_TOOL_CALL_ID_CHARS = 256;
const MAX_RUN_ID_CHARS = 256;
const MAX_REASON_CHARS = 320;
const MAX_LIMITATION_CHARS = 240;
const MAX_LIMITATIONS = 6;
const MAX_INFLIGHT_WORKERS = 4;
const USD_EPSILON = 1e-9;

/** Fixed precision for public USD accounting; the epsilon comparisons stay conservative. */
function money(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

const DEFAULT_POLICY = Object.freeze({
  maxRetainedOperations: NATIVE_HARNESS_MAX_OPERATIONS,
  maxConcurrent: NATIVE_HARNESS_MAX_CONCURRENCY,
  perRunUsd: NATIVE_HARNESS_MAX_PER_RUN_USD,
  lifetimeUsd: NATIVE_HARNESS_MAX_LIFETIME_USD,
  maxDurationMs: NATIVE_HARNESS_MAX_DURATION_MS,
  cleanupGraceMs: NATIVE_HARNESS_MAX_CLEANUP_GRACE_MS,
});

export class NativeHarnessDelegationError extends Error {
  override name = "NativeHarnessDelegationError";
}

export interface NativeHarnessDelegationPolicy {
  readonly maxRetainedOperations?: number;
  readonly maxConcurrent?: number;
  readonly perRunUsd?: number;
  readonly lifetimeUsd?: number;
  readonly maxDurationMs?: number;
  readonly cleanupGraceMs?: number;
}

export interface NativeHarnessDelegationLimits {
  readonly maxRetainedOperations: number;
  readonly maxConcurrent: number;
  readonly perRunUsd: number;
  readonly lifetimeUsd: number;
  readonly maxDurationMs: number;
  readonly cleanupGraceMs: number;
}

/** Stable diagnostic facts. This is not an authority token. */
export interface NativeHarnessAssociation {
  readonly observationId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly toolCallId: string;
  readonly toolName: typeof NATIVE_HARNESS_TOOL;
}

export interface NativeHarnessAdmittedBudget {
  readonly maxCostUsd: number;
  readonly deadlineAt: number;
  readonly maxDurationMs: number;
}

/** Narrow backend supplied by trusted 2B composition. Create is called once. */
export interface NativeHarnessBackend {
  create(task: string): Promise<unknown>;
  execute(runId: string): Promise<unknown>;
  cancel(runId: string): Promise<unknown>;
  /** Optional bounded status observation; never used to create or resume a run. */
  get?(runId: string): Promise<unknown>;
}

export interface NativeHarnessPrepareRequest {
  readonly association: NativeHarnessAssociation;
  readonly budget: NativeHarnessAdmittedBudget;
  readonly signal: AbortSignal;
  readonly runner: Runner;
  /**
   * Synchronous authority guard. The prepare callback must call it at every
   * preparation effect and must not retain it after returning.
   */
  readonly guard: () => void;
}

export type NativeHarnessPrepareResult =
  | { readonly ok: true; readonly backend: NativeHarnessBackend }
  | { readonly ok: false; readonly reason: string };

export type NativeHarnessBackendStatus =
  | "queued"
  | "running"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled"
  | "applied";

export type NativeHarnessOutcome =
  | "refused"
  | "backend-completed"
  | "backend-failed"
  | "backend-cancelled"
  | "cancelled"
  | "timed-out"
  | "incomplete"
  | "unknown";

export type NativeHarnessExecutionState = "not-started" | "settled" | "pending-unknown";
export type NativeHarnessCancellationState = "none" | "requested" | "request-failed";
export type NativeHarnessTermination =
  | "none"
  | "cancelled"
  | "deadline"
  | "disposed"
  | "authority-lost"
  | "backend-failed";

export interface NativeHarnessDelegationCost {
  readonly allocatedUsd: number;
  readonly observedUsd: number | null;
  readonly unknownUsd: number;
  readonly overspendUsd: number;
}

export interface NativeHarnessDelegationResult {
  readonly schema: typeof NATIVE_HARNESS_DELEGATION_SCHEMA;
  readonly tool: typeof NATIVE_HARNESS_TOOL;
  readonly authority: "non-authoritative";
  readonly resultKind: "refused" | "live" | "historical";
  readonly historical: boolean;
  readonly authorityFresh: boolean;
  readonly outcome: NativeHarnessOutcome;
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
  readonly association: NativeHarnessAssociation | null;
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

export type NativeHarnessOutputSelectionCode =
  | "output-unavailable"
  | "not-ready"
  | "source-conflict"
  | "authority-lost"
  | "capacity"
  | "cancelled"
  | "deadline"
  | "invalid-caller"
  | "capture-failed";

export interface NativeHarnessOutputSelectionFailure {
  readonly ok: false;
  readonly code: NativeHarnessOutputSelectionCode;
  readonly reason: string;
}

export interface NativeHarnessOutputSelectionSuccess {
  readonly ok: true;
  readonly observation: "captured-now" | "cached-historical";
  readonly filesystemFreshness: "observed-during-capture" | "not-rechecked";
  readonly capture: NativeHarnessOutputCapture;
  readonly association: NativeHarnessAssociation;
  readonly runId: string;
  readonly taskSha256: string;
  readonly workPromptSha256: string;
  readonly callInputSha256: string;
  readonly expectedResultSha256: string;
  readonly observedResultSha256: string;
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
}

export type NativeHarnessOutputSelection =
  | NativeHarnessOutputSelectionSuccess
  | NativeHarnessOutputSelectionFailure;

/** Trusted host-only output port. Missing or malformed ports mean output unavailable. */
export interface NativeHarnessOutputPort {
  capture(
    backend: unknown,
    guard: () => void,
    signal: AbortSignal,
  ): Promise<NativeHarnessOutputCaptureResult>;
  matches(backend: unknown, capture: unknown): boolean;
  /** Pure, synchronous original-owner predicate: exactly null on success. */
  revalidateOwner(): string | null;
}

export interface NativeHarnessSnapshotOutput {
  readonly state: "idle" | "running" | "captured" | "failed";
  readonly registered: boolean;
  readonly registrationFailure: string | null;
  readonly captureId: string | null;
  readonly captureDigest: string | null;
  readonly taskSha256: string | null;
  readonly workPromptSha256: string | null;
  readonly callInputSha256: string | null;
  readonly expectedResultSha256: string | null;
  readonly observedResultSha256: string | null;
  readonly retainedBytes: number;
  readonly code: NativeHarnessOutputSelectionCode | null;
  readonly reason: string | null;
  readonly checks: {
    readonly paths: number;
    readonly actions: number;
    readonly retainedBytes: number;
  };
}

export interface NativeHarnessSnapshotOperation {
  readonly association: NativeHarnessAssociation | null;
  readonly runId: string | null;
  readonly state: "running" | "settled";
  readonly outcome: NativeHarnessOutcome | null;
  readonly authorityFresh: boolean | null;
  readonly executionState: NativeHarnessExecutionState;
  readonly termination: NativeHarnessTermination;
  readonly cancellation: NativeHarnessCancellationState;
  readonly deadlineAt: number;
  readonly elapsedMs: number;
  readonly cost: NativeHarnessDelegationCost;
  readonly concurrencyHeld: boolean;
  readonly historical: boolean;
  readonly output: NativeHarnessSnapshotOutput;
}

export interface NativeHarnessDelegationSnapshot {
  readonly schema: typeof NATIVE_HARNESS_DELEGATION_SNAPSHOT_SCHEMA;
  readonly enabled: boolean;
  readonly disposed: boolean;
  readonly limits: NativeHarnessDelegationLimits;
  readonly retainedOperations: number;
  readonly activeOperations: number;
  readonly output: {
    readonly retainedCaptures: number;
    readonly retainedBytes: number;
    readonly reservedBytes: number;
    readonly active: boolean;
    readonly maxCaptures: number;
    readonly maxBytes: number;
    readonly reservationBytes: number;
  };
  readonly lifetime: {
    readonly limitUsd: number;
    readonly accountedUsd: number;
    readonly observedUsd: number;
    readonly unknownUsd: number;
    readonly overspendUsd: number;
    readonly budgetBlocked: boolean;
  };
  readonly operations: readonly NativeHarnessSnapshotOperation[];
}

export interface NativeHarnessDelegationOptions {
  readonly native: NativeEntryControls;
  readonly policy?: NativeHarnessDelegationPolicy;
  /** Fresh actual main execute context supplier. */
  readonly getContext: () => NativeContext;
  /** Trusted preparation, possibly async. Must not create a run. */
  readonly prepare: (
    request: NativeHarnessPrepareRequest,
    context: NativeContext,
  ) => NativeHarnessPrepareResult | Promise<NativeHarnessPrepareResult>;
  readonly runner: Runner;
  readonly now?: () => number;
  /** Defaults false. True only creates an inert enabled coordinator. */
  readonly enabled?: boolean;
  /** Optional trusted host-only output leaf; missing/malformed means output unavailable. */
  readonly output?: NativeHarnessOutputPort;
}

export interface NativeHarnessDelegationCoordinator {
  readonly enabled: boolean;
  readonly disposed: boolean;
  /**
   * A tool execute adapter may pass string task or `{ task }`. The actual call
   * id and signal are host-supplied; no parent/model/budget/path selector is
   * accepted from the model.
   */
  invoke(actualToolCallId: unknown, input: unknown, signal: unknown): Promise<NativeHarnessDelegationResult>;
  /**
   * Registers the tool wire projection created by the entry inside the actual
   * execute scope. Idempotent for the exact retained source response; never
   * changes execution history and never throws for unavailable output.
   */
  registerToolResultProjection(
    actualSourceToolCallId: unknown,
    actualDelegationResponse: unknown,
    actualProjectedResult: unknown,
    originalSignal: unknown,
  ): { readonly ok: boolean; readonly reason: string | null };
  /**
   * Host-only capture of the frozen original output. Missing output support is
   * returned as an `ok: false` selection rather than thrown.
   */
  captureOutput(
    actualSourceToolCallId: unknown,
    captureSignal: unknown,
  ): Promise<NativeHarnessOutputSelection>;
  /**
   * Host-only synchronous check over one already captured output Slot. The
   * selectors must exactly match the retained capture and one changed path;
   * no file is opened and no capture, backend or I/O is started.
   */
  checkOutput(
    actualCheckToolCallId: unknown,
    input: unknown,
    actualSignal: unknown,
  ): NativeHarnessCheckOutcome;
  /**
   * Host-only registration of the exact check response's frozen input and
   * projected tool wire on the retained action reference.
   */
  registerOutputCheckProjection(
    actualSourceToolCallId: unknown,
    actualCheckToolCallId: unknown,
    exactCheckResponse: unknown,
    actualProjectedResult: unknown,
    originalCheckSignal: unknown,
  ): { readonly ok: boolean; readonly reason: string | null };
  /** Idempotent local cancellation request for one retained operation. */
  cancel(actualToolCallId: unknown): boolean;
  /** Idempotent local disposal; never disposes the native controls/owner. */
  dispose(): void;
  inspect(): NativeHarnessDelegationSnapshot;
}

type NativeCallCapture = ReturnType<NativeEntryControls["captureCall"]>;
type NativeCaptureResult =
  | {
      readonly ok: true;
      readonly ref: NativeWorkCallReference;
      readonly association: NativeHarnessAssociation;
    }
  | { readonly ok: false; readonly reason: string };

interface NativeCallPort {
  readonly receiver: NativeEntryControls;
  readonly captureCall: (this: NativeEntryControls, selector: unknown, context: NativeContext) => NativeCallCapture;
  readonly prepareCallCheck: (this: NativeEntryControls, ref: unknown, context: NativeContext) => NativeCallCheckPreparation;
  readonly registerCallResultExpectation:
    | ((this: NativeEntryControls, ref: unknown, expected: { readonly input: unknown; readonly result: unknown }, context: NativeContext) => CallResultExpectationRegistration)
    | null;
}

interface OutputPort {
  readonly receiver: NativeHarnessOutputPort;
  readonly capture: (this: NativeHarnessOutputPort, backend: unknown, guard: () => void, signal: AbortSignal) => Promise<NativeHarnessOutputCaptureResult>;
  readonly matches: (this: NativeHarnessOutputPort, backend: unknown, capture: unknown) => boolean;
  readonly revalidateOwner: (this: NativeHarnessOutputPort) => unknown;
}

interface RunnerPort {
  readonly receiver: Runner;
  readonly run: (this: Runner, request: WorkerRequest) => Promise<WorkerResult>;
}

interface BackendPort {
  readonly receiver: NativeHarnessBackend;
  readonly create: (this: NativeHarnessBackend, task: string) => unknown;
  readonly execute: (this: NativeHarnessBackend, runId: string) => unknown;
  readonly cancel: (this: NativeHarnessBackend, runId: string) => unknown;
  readonly get: ((this: NativeHarnessBackend, runId: string) => unknown) | null;
}

type SlotCancelReason =
  | "invocation-aborted"
  | "deadline-expired"
  | "disposed"
  | "cancel-requested"
  | "authority-lost"
  | "budget-refused";

interface OutputRegistration {
  readonly expectedSha256: string;
  readonly expectedBytes: number;
  readonly workPromptSha256: string;
  readonly callInputSha256: string;
  readonly taskSha256: string;
  readonly runId: string;
}

interface SlotOutput {
  registration: OutputRegistration | null;
  registrationFailure: string | null;
  registering: boolean;
  state: "idle" | "running" | "captured" | "failed";
  promise: Promise<NativeHarnessOutputSelection> | null;
  requestSignal: AbortSignal | null;
  controller: AbortController | null;
  cleanup: (() => void) | null;
  capture: NativeHarnessOutputCapture | null;
  selection: NativeHarnessOutputSelectionSuccess | null;
  failure: NativeHarnessOutputSelectionFailure | null;
  guardFailure: NativeHarnessOutputSelectionFailure | null;
  observedSha256: string | null;
  observedBytes: number | null;
  reservedBytes: number;
  retainedBytes: number;
  startedAt: number | null;
  lastClock: number | null;
  checks: NativeHarnessCheckState | null;
}

interface Slot {
  readonly toolCallId: string;
  readonly originalRef: NativeWorkCallReference;
  readonly association: NativeHarnessAssociation;
  readonly task: string;
  readonly invocationSignal: AbortSignal;
  readonly signal: AbortSignal;
  readonly admittedAt: number;
  readonly deadlineAt: number;
  readonly abortController: AbortController;
  readonly cleanupExpired: ReturnType<typeof deferred<void>>;
  readonly promise: Promise<NativeHarnessDelegationResult>;
  readonly resolve: (result: NativeHarnessDelegationResult) => void;
  readonly abortListener: () => void;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  state: "running" | "settled";
  concurrencyHeld: boolean;
  reservationActive: boolean;
  cancelRequested: boolean;
  cancelReason: SlotCancelReason | null;
  cancelState: NativeHarnessCancellationState;
  cancelError: string | null;
  cancelSettled: boolean;
  cancelPromise: Promise<void> | null;
  backend: BackendPort | null;
  prepareOpen: boolean;
  guardCalls: number;
  backendEffectStarted: boolean;
  createStarted: boolean;
  createSettled: boolean;
  executionStarted: boolean;
  executionSettled: boolean;
  dispatchClosed: boolean;
  runId: string | null;
  backendStatus: NativeHarnessBackendStatus | null;
  executionError: string | null;
  workerPromises: Set<Promise<WorkerResult>>;
  workerDispatches: number;
  workerCount: number;
  workerAllKnownCompleted: boolean;
  workerUnknownUsage: boolean;
  observedCostUsd: number;
  observedAny: boolean;
  runnerAccountedUsd: number;
  runnerInflightUsd: number;
  overspendUsd: number;
  lateSettlementObserved: boolean;
  response: NativeHarnessDelegationResult | null;
  finalOutcome: NativeHarnessOutcome | null;
  finalAuthorityFresh: boolean | null;
  finalExecutionState: NativeHarnessExecutionState;
  finalTermination: NativeHarnessTermination;
  finalCost: NativeHarnessDelegationCost | null;
  readonly output: SlotOutput;
}

interface CoordinatorState {
  readonly native: NativeCallPort;
  readonly output: OutputPort | null;
  readonly limits: NativeHarnessDelegationLimits;
  readonly getContext: () => NativeContext;
  readonly prepare: (
    request: NativeHarnessPrepareRequest,
    context: NativeContext,
  ) => NativeHarnessPrepareResult | Promise<NativeHarnessPrepareResult>;
  readonly runner: RunnerPort;
  readonly now: () => number;
  readonly enabled: boolean;
  disposed: boolean;
  readonly slots: Map<string, Slot>;
  admissionInProgress: boolean;
  revalidationInProgress: boolean;
  activeOperations: number;
  lifetimeAccountedUsd: number;
  lifetimeObservedUsd: number;
  lifetimeUnknownUsd: number;
  lifetimeOverspendUsd: number;
  budgetBlocked: boolean;
  outputRetained: number;
  outputBytes: number;
  outputReservedBytes: number;
  outputActive: Slot | null;
  outputJoinValidating: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpaqueRef(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number, minimum = 1): string | null {
  if (typeof value !== "string" || value.length < minimum || value.length > max) return null;
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

function boundedReason(value: unknown, fallback: string): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      if (value instanceof Error && typeof value.message === "string") text = value.message;
      else text = String(value);
    } catch {
      text = fallback;
    }
  }
  const normalized = text.replace(/[^\x20-\x7e]+/g, "?").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return fallback;
  return normalized.length <= MAX_REASON_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_REASON_CHARS - 3)}...`;
}

function boundedLimitation(value: string): string {
  const normalized = value.replace(/[^\x20-\x7e]+/g, "?").replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_LIMITATION_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_LIMITATION_CHARS - 3)}...`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function outputFailure(
  code: NativeHarnessOutputSelectionCode,
  reason: string,
): NativeHarnessOutputSelectionFailure {
  return deepFreeze({ ok: false as const, code, reason: boundedReason(reason, "output capture refused") });
}

/**
 * New output diagnostics must not run arbitrary Error.message getters, `then`,
 * `toString` or coercion while normalizing a refusal. Only a string value or an
 * own data message field is read; everything else gets a constant fallback.
 */
function outputThrownReason(error: unknown, fallback: string): string {
  if (typeof error === "string") return boundedReason(error, fallback);
  const message = readOwnField(error, "message");
  if (message.kind === "data" && typeof message.value === "string") {
    return boundedReason(message.value, fallback);
  }
  return fallback;
}

function boundedOutputReason(value: string): string {
  return boundedReason(value, "output unavailable")
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'`<>]+/g, "[path]");
}

type OwnField =
  | { readonly kind: "missing" }
  | { readonly kind: "accessor" }
  | { readonly kind: "data"; readonly value: unknown };

/** One bounded own-data read; getters, proxies that throw and inherited fields fail closed. */
function readOwnField(target: unknown, key: string): OwnField {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) {
    return { kind: "missing" };
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key);
  } catch {
    return { kind: "accessor" };
  }
  if (descriptor === undefined) return { kind: "missing" };
  if (!("value" in descriptor)) return { kind: "accessor" };
  return { kind: "data", value: descriptor.value };
}

type StrictFields = ReadonlyMap<string, unknown>;

/** Strict own data fields; accessors, symbols, extra keys and exotic prototypes are refused. */
function readStrictFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  accessorAsMissing?: string,
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
      if (key === accessorAsMissing) continue;
      return null;
    }
    fields.set(key, descriptor.value);
  }
  for (const key of required) {
    if (!fields.has(key)) return null;
  }
  return fields;
}

const NATIVE_PROMISE_THEN = Promise.prototype.then;

/** Brand-consume a native Promise without reading an arbitrary `then`. */
function consumeNativePromise(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    Reflect.apply(NATIVE_PROMISE_THEN, value, [() => undefined, () => undefined]);
    return true;
  } catch {
    return false;
  }
}

const ACTUAL_ABORTED_GETTER = (() => {
  try {
    return Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null;
  } catch {
    return null;
  }
})();

const ACTUAL_ADD_EVENT_LISTENER = (() => {
  try {
    return EventTarget.prototype.addEventListener;
  } catch {
    return null;
  }
})();

const ACTUAL_REMOVE_EVENT_LISTENER = (() => {
  try {
    return EventTarget.prototype.removeEventListener;
  } catch {
    return null;
  }
})();

type ActualAbortRead =
  | { readonly ok: true; readonly aborted: boolean }
  | { readonly ok: false; readonly reason: string };

function readActualAbortSignal(signal: unknown): ActualAbortRead {
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

function readCallable(value: unknown, key: string): Function | null {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
  let current: object | null = value as object;
  for (let depth = 0; current !== null && depth < 4; depth++) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      return null;
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
      return descriptor.value;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return null;
    }
    if (current === Object.prototype || current === Function.prototype) return null;
  }
  return null;
}

/** Malformed output ports are treated as unavailable, never as constructor failure. */
function readOutputPort(value: unknown): OutputPort | null {
  if (value === undefined) return null;
  const fields = readStrictFields(value, ["capture", "matches", "revalidateOwner"], [
    "capture",
    "matches",
    "revalidateOwner",
  ]);
  if (fields === null) return null;
  const capture = fields.get("capture");
  const matches = fields.get("matches");
  const revalidateOwner = fields.get("revalidateOwner");
  if (typeof capture !== "function" || typeof matches !== "function" || typeof revalidateOwner !== "function") {
    return null;
  }
  return {
    receiver: value as NativeHarnessOutputPort,
    capture: capture as OutputPort["capture"],
    matches: matches as OutputPort["matches"],
    revalidateOwner: revalidateOwner as OutputPort["revalidateOwner"],
  };
}

function ownerPredicateReason(output: OutputPort): string | null {
  let raw: unknown;
  try {
    raw = Reflect.apply(output.revalidateOwner, output.receiver, []);
  } catch (error) {
    return `the trusted output owner predicate threw: ${outputThrownReason(error, "output operation failed")}`;
  }
  if (raw === null) return null;
  if (typeof raw === "string") {
    return boundedReason(raw, "the trusted output owner predicate refused the original owner");
  }
  // Observe a genuine native Promise (including a rejection) so it cannot
  // surface as an unhandled rejection. Never read an arbitrary then/toString.
  if (consumeNativePromise(raw)) {
    return "the trusted output owner predicate returned a promise";
  }
  return "the trusted output owner predicate did not confirm the original owner";
}

function outputMatches(output: OutputPort, backend: unknown, capture: unknown): boolean {
  let raw: unknown;
  try {
    raw = Reflect.apply(output.matches, output.receiver, [backend, capture]);
  } catch {
    return false;
  }
  if (raw === true) return true;
  // A promise is invalid synchrony. Consuming only the captured intrinsic
  // attaches rejection handlers without invoking an arbitrary `then`.
  if (raw !== null && (typeof raw === "object" || typeof raw === "function")) {
    consumeNativePromise(raw);
  }
  return false;
}

function readLimit(
  value: unknown,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
  integer: boolean,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new NativeHarnessDelegationError(`${name} must be a finite number.`);
  }
  if (integer && !Number.isSafeInteger(value)) {
    throw new NativeHarnessDelegationError(`${name} must be a safe integer.`);
  }
  if (value < minimum || value > maximum) {
    throw new NativeHarnessDelegationError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function normalizePolicy(value: unknown): NativeHarnessDelegationLimits {
  let fields: StrictFields;
  if (value === undefined) {
    fields = new Map();
  } else {
    const read = readStrictFields(
      value,
      ["maxRetainedOperations", "maxConcurrent", "perRunUsd", "lifetimeUsd", "maxDurationMs", "cleanupGraceMs"],
      [],
    );
    if (read === null) {
      throw new NativeHarnessDelegationError("Delegation policy must be a plain own-data object.");
    }
    fields = read;
  }
  const maxRetainedOperations = readLimit(
    fields.get("maxRetainedOperations"),
    DEFAULT_POLICY.maxRetainedOperations,
    "maxRetainedOperations",
    1,
    NATIVE_HARNESS_MAX_OPERATIONS,
    true,
  );
  const maxConcurrent = readLimit(
    fields.get("maxConcurrent"),
    DEFAULT_POLICY.maxConcurrent,
    "maxConcurrent",
    1,
    NATIVE_HARNESS_MAX_CONCURRENCY,
    true,
  );
  const perRunUsd = readLimit(
    fields.get("perRunUsd"),
    DEFAULT_POLICY.perRunUsd,
    "perRunUsd",
    Number.MIN_VALUE,
    NATIVE_HARNESS_MAX_PER_RUN_USD,
    false,
  );
  if (!(perRunUsd > 0)) {
    throw new NativeHarnessDelegationError("perRunUsd must be positive and finite.");
  }
  const lifetimeUsd = readLimit(
    fields.get("lifetimeUsd"),
    DEFAULT_POLICY.lifetimeUsd,
    "lifetimeUsd",
    perRunUsd,
    NATIVE_HARNESS_MAX_LIFETIME_USD,
    false,
  );
  const maxDurationMs = readLimit(
    fields.get("maxDurationMs"),
    DEFAULT_POLICY.maxDurationMs,
    "maxDurationMs",
    Number.MIN_VALUE,
    NATIVE_HARNESS_MAX_DURATION_MS,
    false,
  );
  const cleanupGraceMs = readLimit(
    fields.get("cleanupGraceMs"),
    DEFAULT_POLICY.cleanupGraceMs,
    "cleanupGraceMs",
    Number.MIN_VALUE,
    NATIVE_HARNESS_MAX_CLEANUP_GRACE_MS,
    false,
  );
  return Object.freeze({
    maxRetainedOperations,
    maxConcurrent,
    perRunUsd,
    lifetimeUsd,
    maxDurationMs,
    cleanupGraceMs,
  });
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

function associationOf(reference: NativeWorkCallReference): NativeHarnessAssociation {
  return deepFreeze({
    observationId: reference.observationId,
    generation: reference.generation,
    sessionId: reference.sessionId,
    workspaceRoot: reference.workspaceRoot,
    toolCallId: reference.toolCallId,
    toolName: reference.toolName,
  }) as NativeHarnessAssociation;
}

function sameAssociation(left: NativeHarnessAssociation, right: NativeHarnessAssociation): boolean {
  return left.observationId === right.observationId
    && left.generation === right.generation
    && left.sessionId === right.sessionId
    && left.workspaceRoot === right.workspaceRoot
    && left.toolCallId === right.toolCallId
    && left.toolName === right.toolName;
}

function zeroCost(): NativeHarnessDelegationCost {
  return Object.freeze({
    allocatedUsd: 0,
    observedUsd: 0,
    unknownUsd: 0,
    overspendUsd: 0,
  });
}

function limitationsFor(extra: readonly string[] = []): readonly string[] {
  const base = [
    "Backend completion is not task acceptance or semantic verification.",
    "2A does not apply candidates, recover runs, or prove process-group exit or OS isolation.",
    "Authority is only as current as the actual OMP main call and native controls; injected ports are not host proof.",
  ];
  const all = [...base, ...extra].slice(0, MAX_LIMITATIONS).map((item) => boundedLimitation(item));
  return deepFreeze(all);
}

function refusedResult(
  reason: string,
  association: NativeHarnessAssociation | null = null,
): NativeHarnessDelegationResult {
  return deepFreeze({
    schema: NATIVE_HARNESS_DELEGATION_SCHEMA,
    tool: NATIVE_HARNESS_TOOL,
    authority: "non-authoritative" as const,
    resultKind: "refused" as const,
    historical: false,
    authorityFresh: false,
    outcome: "refused" as const,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
    association: association === null ? null : associationOf(association as NativeWorkCallReference),
    runId: null,
    backendStatus: null,
    executionState: "not-started" as const,
    termination: "none" as const,
    cancellation: "none" as const,
    cancelError: null,
    deadlineAt: null,
    elapsedMs: 0,
    cost: zeroCost(),
    limitations: limitationsFor(),
    reason: boundedReason(reason, "the delegation invocation was refused"),
  });
}

function historicalResult(cached: NativeHarnessDelegationResult): NativeHarnessDelegationResult {
  return deepFreeze({
    ...cached,
    resultKind: "historical" as const,
    historical: true,
    authorityFresh: true,
  });
}

function parseTaskInput(value: unknown): { readonly ok: true; readonly task: string } | { readonly ok: false; readonly reason: string } {
  let task: unknown;
  if (typeof value === "string") {
    task = value;
  } else {
    const fields = readStrictFields(value, ["task"], ["task"]);
    if (fields === null) {
      return { ok: false, reason: "agent_harness input must be a task string or a plain object with only an own data task field" };
    }
    task = fields.get("task");
  }
  if (typeof task !== "string" || task.trim().length === 0) {
    return { ok: false, reason: "agent_harness task must be a nonempty string" };
  }
  if (task.includes("\0")) {
    return { ok: false, reason: "agent_harness task must not contain NUL" };
  }
  if (new TextEncoder().encode(task).byteLength > NATIVE_HARNESS_MAX_TASK_BYTES) {
    return { ok: false, reason: `agent_harness task exceeds ${NATIVE_HARNESS_MAX_TASK_BYTES} UTF-8 bytes` };
  }
  return { ok: true, task };
}

function readClock(now: () => number): number | null {
  try {
    const value = now();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function readNativeCapture(
  native: NativeCallPort,
  toolCallId: string,
  context: NativeContext,
): NativeCaptureResult {
  let capture: NativeCallCapture;
  try {
    capture = Reflect.apply(native.captureCall, native.receiver, [
      { toolCallId, toolName: NATIVE_HARNESS_TOOL },
      context,
    ]);
  } catch (error) {
    return { ok: false, reason: `native capture threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (!capture.ok) {
    return { ok: false, reason: nativeInspectionReason(capture.inspection) };
  }
  if (capture.inspection.state !== "current" || capture.inspection.evidenceState !== "available") {
    return { ok: false, reason: nativeInspectionReason(capture.inspection) };
  }
  const ref = capture.ref;
  let association: NativeHarnessAssociation;
  try {
    association = associationOf(ref);
  } catch {
    return { ok: false, reason: "native capture returned unreadable association facts" };
  }
  if (association.toolCallId !== toolCallId || association.toolName !== NATIVE_HARNESS_TOOL) {
    return { ok: false, reason: "native capture returned a different actual tool call" };
  }
  return { ok: true, ref, association };
}

function nativeInspectionReason(inspection: NativeWorkCallInspection): string {
  return `native call authority is ${inspection.state}: ${inspection.reason}`;
}

function readMainContext(state: CoordinatorState): { readonly ok: true; readonly context: NativeContext } | { readonly ok: false; readonly reason: string } {
  let context: unknown;
  try {
    context = state.getContext();
  } catch (error) {
    return { ok: false, reason: `the actual main context threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (consumeNativePromise(context)) {
    return { ok: false, reason: "the actual main context must be synchronous" };
  }
  if (!isActualMainContext(context)) {
    return { ok: false, reason: "the actual execute context is unavailable, stale or not a main context" };
  }
  return { ok: true, context: context as NativeContext };
}

/**
 * Fresh host reads, then a fresh native prepared check, then its pure check
 * last. No authority callback runs after the pure gate before a caller effect.
 */
function authorityGate(
  slot: Slot,
  mode: "effect" | "replay",
  contextSink?: (context: NativeContext) => void,
): string | null {
  const state = slotState(slot);
  if (state === null) return "the delegation coordinator state is unavailable";
  if (state.disposed) return "the delegation coordinator was disposed";
  if (!state.enabled) return "the delegation coordinator is disabled";
  if (mode === "effect") {
    if (slot.state !== "running") return "the delegation operation is already settled";
    if (slot.cancelRequested) return `the delegation operation was cancelled (${slot.cancelReason ?? "requested"})`;
  }
  const firstTime = readClock(state.now);
  if (firstTime === null) return "the delegation clock is unavailable";
  if (firstTime >= slot.deadlineAt) return "the original delegation deadline expired";
  const firstSignal = readActualAbortSignal(slot.invocationSignal);
  if (!firstSignal.ok) return firstSignal.reason;
  if (firstSignal.aborted) return "the original invocation signal was aborted";

  const main = readMainContext(state);
  if (!main.ok) return main.reason;

  let check: NativeCallCheckPreparation;
  try {
    check = Reflect.apply(state.native.prepareCallCheck, state.native.receiver, [
      slot.originalRef,
      main.context,
    ]);
  } catch (error) {
    return `native call revalidation threw: ${boundedReason(error, "unreadable failure")}`;
  }
  if (!check.ok) return nativeInspectionReason(check.inspection);
  if (check.inspection.state !== "current" || check.inspection.evidenceState !== "available") {
    return nativeInspectionReason(check.inspection);
  }

  // Re-read mutable local/host facts after context and native callbacks.
  if (state.disposed) return "the delegation coordinator was disposed";
  if (mode === "effect" && slot.cancelRequested) {
    return `the delegation operation was cancelled (${slot.cancelReason ?? "requested"})`;
  }
  const secondTime = readClock(state.now);
  if (secondTime === null) return "the delegation clock is unavailable";
  if (secondTime >= slot.deadlineAt) return "the original delegation deadline expired";
  // The clock is a host callback and may have reentered disposal/cancellation.
  // This local gate has no callbacks and runs after all callback facts.
  if (state.disposed) return "the delegation coordinator was disposed";
  if (!state.enabled) return "the delegation coordinator is disabled";
  if (mode === "effect" && slot.state !== "running") {
    return "the delegation operation is already settled";
  }
  if (mode === "effect" && slot.cancelRequested) {
    return `the delegation operation was cancelled (${slot.cancelReason ?? "requested"})`;
  }
  const secondSignal = readActualAbortSignal(slot.invocationSignal);
  if (!secondSignal.ok) return secondSignal.reason;
  if (secondSignal.aborted) return "the original invocation signal was aborted";

  contextSink?.(main.context);

  // Exactly the captured pure check is last before the caller's effect.
  let raw: unknown;
  try {
    raw = check.revalidate();
  } catch (error) {
    return `native call pure revalidation threw: ${boundedReason(error, "unreadable failure")}`;
  }
  if (raw === null) return null;
  if (typeof raw === "string") return boundedReason(raw, "native call pure revalidation refused");
  if (consumeNativePromise(raw)) return "native call pure revalidation returned a promise";
  return "native call pure revalidation returned an invalid result";
}

const slotStates = new WeakMap<object, CoordinatorState>();

function slotState(slot: Slot): CoordinatorState | null {
  return slotStates.get(slot) ?? null;
}

type ReadyCallCheck = Extract<NativeCallCheckPreparation, { readonly ok: true }>;
type OutputCheckFailure = { readonly ok: false; readonly code: NativeHarnessOutputSelectionCode; readonly reason: string };

interface PreparedOutputCheck {
  readonly ok: true;
  readonly check: ReadyCallCheck;
  readonly inspection: NativeWorkCallInspection;
  readonly context: NativeContext;
  readonly workPromptSha256: string;
  readonly callInputSha256: string;
  readonly observedSha256: string | null;
  readonly observedBytes: number | null;
}

function registrationFailure(reason: unknown): { readonly ok: false; readonly reason: string } {
  return Object.freeze({
    ok: false as const,
    reason: outputThrownReason(reason, "output result registration refused"),
  });
}

function registrationSuccess(): { readonly ok: true; readonly reason: null } {
  return Object.freeze({ ok: true as const, reason: null });
}

function readRegistrationFingerprint(value: unknown):
  | { readonly ok: true; readonly bytes: number; readonly sha256: string }
  | { readonly ok: false; readonly reason: string } {
  const fields = readStrictFields(value, ["ok", "fingerprint", "reason"], ["ok"]);
  if (fields === null) {
    return { ok: false, reason: "native result expectation registration returned an unreadable result" };
  }
  if (fields.get("ok") !== true) {
    const reason = fields.get("reason");
    return {
      ok: false,
      reason: typeof reason === "string" ? reason : "native result expectation registration refused",
    };
  }
  const fingerprint = readStrictFields(fields.get("fingerprint"), ["bytes", "sha256"], ["bytes", "sha256"]);
  if (fingerprint === null) {
    return { ok: false, reason: "native result expectation registration returned no usable fingerprint" };
  }
  const bytes = fingerprint.get("bytes");
  const sha256 = fingerprint.get("sha256");
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || !isHex64(sha256)) {
    return { ok: false, reason: "native result expectation registration returned an invalid fingerprint" };
  }
  return { ok: true, bytes, sha256 };
}

function sameInspectionAssociation(value: unknown, expected: NativeHarnessAssociation): boolean {
  if (!isRecord(value)) return false;
  try {
    return value.observationId === expected.observationId
      && value.generation === expected.generation
      && value.sessionId === expected.sessionId
      && value.workspaceRoot === expected.workspaceRoot
      && value.toolCallId === expected.toolCallId
      && value.toolName === expected.toolName;
  } catch {
    return false;
  }
}

function inspectionReasonCode(_inspection: NativeWorkCallInspection): NativeHarnessOutputSelectionCode {
  return "authority-lost";
}

function projectionConflict(inspection: NativeWorkCallInspection): boolean {
  const projection = inspection.resultProjection;
  return isRecord(projection)
    && (projection.state === "conflicted" || projection.state === "unavailable");
}

function prepareOutputCheck(
  slot: Slot,
  state: CoordinatorState,
  registration: OutputRegistration | null,
  requireMatched: boolean,
): PreparedOutputCheck | OutputCheckFailure {
  // The original source invocation signal and deadline control execution only.
  // A late abort after a successful settlement does not cancel this new read.
  const main = readMainContext(state);
  if (!main.ok) return { ok: false, code: "authority-lost", reason: main.reason };

  let check: NativeCallCheckPreparation;
  try {
    check = Reflect.apply(state.native.prepareCallCheck, state.native.receiver, [
      slot.originalRef,
      main.context,
    ]);
  } catch (error) {
    return {
      ok: false,
      code: "authority-lost",
      reason: `native call revalidation threw: ${outputThrownReason(error, "output operation failed")}`,
    };
  }
  if (!check.ok) {
    return {
      ok: false,
      code: projectionConflict(check.inspection) ? "source-conflict" : inspectionReasonCode(check.inspection),
      reason: nativeInspectionReason(check.inspection),
    };
  }
  const inspection = check.inspection;
  if (inspection.state !== "current" || inspection.evidenceState !== "available") {
    return {
      ok: false,
      code: projectionConflict(inspection) ? "source-conflict" : inspectionReasonCode(inspection),
      reason: nativeInspectionReason(inspection),
    };
  }
  if (inspection.requestAttribution !== "matched-user-input") {
    return {
      ok: false,
      code: "authority-lost",
      reason: "the original source call is no longer associated with matched user input",
    };
  }
  if (inspection.pendingInputCount !== 0 || inspection.pendingInputsDropped !== 0) {
    return {
      ok: false,
      code: "authority-lost",
      reason: "the original source work has queued or dropped inputs",
    };
  }
  if (!sameInspectionAssociation(inspection.association, slot.association)) {
    return {
      ok: false,
      code: "authority-lost",
      reason: "the original source call now has an incompatible native association",
    };
  }
  const workPromptSha256 = inspection.workPromptSha256;
  const callInputSha256 = inspection.callInputSha256;
  if (!isHex64(workPromptSha256) || !isHex64(callInputSha256)) {
    return {
      ok: false,
      code: "output-unavailable",
      reason: "the original source work prompt or call input digest is unavailable",
    };
  }
  if (registration !== null) {
    if (workPromptSha256 !== registration.workPromptSha256) {
      return { ok: false, code: "source-conflict", reason: "the original native work prompt changed" };
    }
    if (callInputSha256 !== registration.callInputSha256) {
      return { ok: false, code: "source-conflict", reason: "the original native call input changed" };
    }
  }
  let observedSha256: string | null = null;
  let observedBytes: number | null = null;
  if (requireMatched) {
    if (registration === null) {
      return { ok: false, code: "not-ready", reason: "the source result projection is not registered" };
    }
    const projection = inspection.resultProjection;
    if (!isRecord(projection)) {
      return { ok: false, code: "not-ready", reason: "the source result projection is unavailable" };
    }
    if (projection.state === "unregistered" || projection.state === "pending") {
      return {
        ok: false,
        code: "not-ready",
        reason: "the actual source tool result has not been observed yet",
      };
    }
    if (projection.state !== "matched") {
      return {
        ok: false,
        code: "source-conflict",
        reason: `the source result projection is ${String(projection.state)}`,
      };
    }
    if (projection.expectedSha256 !== registration.expectedSha256
      || projection.expectedBytes !== registration.expectedBytes) {
      return {
        ok: false,
        code: "source-conflict",
        reason: "the source result expectation fingerprint changed",
      };
    }
    if (projection.observedSha256 !== registration.expectedSha256
      || projection.observedBytes !== registration.expectedBytes
      || !isHex64(projection.observedSha256)
      || typeof projection.observedBytes !== "number"
      || !Number.isSafeInteger(projection.observedBytes)
      || projection.observedBytes < 0) {
      return {
        ok: false,
        code: "source-conflict",
        reason: "the observed source result fingerprint is not the registered expectation",
      };
    }
    if (slot.output.observedSha256 !== null
      && (slot.output.observedSha256 !== projection.observedSha256
        || slot.output.observedBytes !== projection.observedBytes)) {
      return {
        ok: false,
        code: "source-conflict",
        reason: "the observed source result fingerprint changed for this capture",
      };
    }
    observedSha256 = projection.observedSha256;
    observedBytes = projection.observedBytes;
  }
  return {
    ok: true,
    check,
    inspection,
    context: main.context,
    workPromptSha256,
    callInputSha256,
    observedSha256,
    observedBytes,
  };
}

function readRegisteredProjection(
  inspection: NativeWorkCallInspection,
  fingerprint: { readonly bytes: number; readonly sha256: string },
  priorObservedSha256: string | null,
  priorObservedBytes: number | null,
): { readonly ok: true; readonly observedSha256: string | null; readonly observedBytes: number | null }
  | { readonly ok: false; readonly reason: string } {
  const projection = inspection.resultProjection;
  if (!isRecord(projection)) return { ok: false, reason: "the native result projection is unavailable" };
  if (projection.state === "pending") {
    if (projection.expectedSha256 !== fingerprint.sha256
      || projection.expectedBytes !== fingerprint.bytes) {
      return { ok: false, reason: "the pending source result expectation is not the registered fingerprint" };
    }
    return { ok: true, observedSha256: null, observedBytes: null };
  }
  if (projection.state !== "matched") {
    return { ok: false, reason: `the source result projection is ${String(projection.state)}` };
  }
  if (projection.expectedSha256 !== fingerprint.sha256
    || projection.expectedBytes !== fingerprint.bytes
    || projection.observedSha256 !== fingerprint.sha256
    || projection.observedBytes !== fingerprint.bytes) {
    return { ok: false, reason: "the matched source result fingerprint is not the registered fingerprint" };
  }
  if (priorObservedSha256 !== null
    && (priorObservedSha256 !== projection.observedSha256
      || priorObservedBytes !== projection.observedBytes)) {
    return { ok: false, reason: "the source result fingerprint changed after registration" };
  }
  return {
    ok: true,
    observedSha256: projection.observedSha256,
    observedBytes: projection.observedBytes,
  };
}

function pureCheckReason(check: ReadyCallCheck): string | null {
  let raw: unknown;
  try {
    raw = check.revalidate();
  } catch (error) {
    return `native call pure revalidation threw: ${outputThrownReason(error, "output operation failed")}`;
  }
  if (raw === null) return null;
  if (typeof raw === "string") return boundedReason(raw, "native call pure revalidation refused");
  // Any non-null non-string, including a Promise, refuses without reading an
  // arbitrary `then` or `toString` from the pure-check result.
  return "native call pure revalidation returned an invalid result";
}

function sourceSuccessProblem(slot: Slot, responseValue: unknown): string | null {
  if (slot.response === null || responseValue !== slot.response) {
    return "the delegation response is not the exact retained original result";
  }
  if (slot.state !== "settled") return "the delegation operation is not settled";
  if (slot.finalOutcome !== "backend-completed") return "the retained delegation outcome is not backend completion";
  if (slot.finalExecutionState !== "settled") return "the retained delegation execution is not settled";
  if (slot.finalAuthorityFresh !== true) return "the retained delegation authority is not fresh";
  if (slot.finalTermination !== "none") return "the retained delegation terminated abnormally";
  if (!slot.backendEffectStarted || !slot.createSettled || !slot.executionStarted || !slot.executionSettled) {
    return "the backend execution did not settle as a completed live run";
  }
  if (!slot.dispatchClosed || slot.workerPromises.size !== 0) {
    return "the backend execution still has outstanding worker work";
  }
  if (slot.concurrencyHeld) return "the delegation execution concurrency is still held";
  if (slot.cancelRequested || slot.cancelState !== "none" || slot.cancelError !== null) {
    return "the delegation execution was cancelled or its cancellation was unresolved";
  }
  if (slot.backend === null || slot.runId === null) return "the delegation backend or run identity is unavailable";
  const response = responseValue as NativeHarnessDelegationResult;
  if (response.resultKind !== "live"
    || response.historical
    || response.authorityFresh !== true
    || response.outcome !== "backend-completed"
    || response.backendStatus !== "completed"
    || response.executionState !== "settled"
    || response.termination !== "none"
    || response.cancellation !== "none"
    || response.cancelError !== null) {
    return "the original delegation result is not a successful settled live completion";
  }
  if (response.runId !== slot.runId || slot.backendStatus !== "completed" || !slot.executionSettled) {
    return "the original delegation result does not match the retained run";
  }
  if (response.association === null || !sameAssociation(response.association, slot.association)) {
    return "the original delegation result association changed";
  }
  return null;
}

function outputClockFailure(
  state: CoordinatorState,
  slot: Slot,
  startedAt: number,
): NativeHarnessOutputSelectionFailure | null {
  const now = readClock(state.now);
  if (now === null) {
    return outputFailure("deadline", "the output capture clock is unavailable");
  }
  if (now < startedAt || (slot.output.lastClock !== null && now < slot.output.lastClock)) {
    return outputFailure("deadline", "the output capture clock moved backwards");
  }
  slot.output.lastClock = now;
  if (now - startedAt > NATIVE_HARNESS_OUTPUT_CAPTURE_BUDGET_MS) {
    return outputFailure("deadline", "the output capture budget expired");
  }
  return null;
}

function outputLocalFailure(
  state: CoordinatorState,
  slot: Slot,
  captureSignal: AbortSignal,
): NativeHarnessOutputSelectionFailure | null {
  if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
  if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
  if (slot.output.state !== "running") {
    return outputFailure("cancelled", "the output capture is no longer active");
  }
  if (state.outputActive !== slot) {
    return outputFailure("cancelled", "the output capture reservation was replaced");
  }
  if (slot.output.reservedBytes !== NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES) {
    return outputFailure("cancelled", "the output capture reservation was released");
  }
  const signal = readActualAbortSignal(captureSignal);
  if (!signal.ok) return outputFailure("invalid-caller", signal.reason);
  if (signal.aborted) return outputFailure("cancelled", "the output capture signal was aborted");
  return null;
}

function captureEntryGate(
  state: CoordinatorState,
  slot: Slot,
  output: OutputPort,
  registration: OutputRegistration,
  captureSignal: AbortSignal,
): { readonly ok: true; readonly now: number; readonly observedSha256: string; readonly observedBytes: number }
  | NativeHarnessOutputSelectionFailure {
  if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
  if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
  const signal = readActualAbortSignal(captureSignal);
  if (!signal.ok) return outputFailure("invalid-caller", signal.reason);
  if (signal.aborted) return outputFailure("cancelled", "the output capture signal was aborted");
  const before = readClock(state.now);
  if (before === null) return outputFailure("not-ready", "the delegation clock is unavailable");
  const prepared = prepareOutputCheck(slot, state, registration, true);
  if (!prepared.ok) return outputFailure(prepared.code, prepared.reason);
  const after = readClock(state.now);
  if (after === null) return outputFailure("deadline", "the output capture clock is unavailable");
  if (before !== null && after < before) return outputFailure("deadline", "the output capture clock moved backwards");
  const source = sourceSuccessProblem(slot, slot.response);
  if (source !== null) return outputFailure("source-conflict", source);
  const owner = ownerPredicateReason(output);
  if (owner !== null) return outputFailure("authority-lost", owner);
  const signalAfter = readActualAbortSignal(captureSignal);
  if (!signalAfter.ok) return outputFailure("invalid-caller", signalAfter.reason);
  if (signalAfter.aborted) return outputFailure("cancelled", "the output capture signal was aborted");
  const pure = pureCheckReason(prepared.check);
  if (pure !== null) return outputFailure("source-conflict", pure);
  if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
  if (slot.output.state !== "idle" || slot.output.registration !== registration) {
    return outputFailure("not-ready", "the source output state changed during admission");
  }
  if (prepared.observedSha256 === null || prepared.observedBytes === null) {
    return outputFailure("not-ready", "the actual source result has not been observed yet");
  }
  return {
    ok: true,
    now: after,
    observedSha256: prepared.observedSha256,
    observedBytes: prepared.observedBytes,
  };
}

function captureGuardGate(
  state: CoordinatorState,
  slot: Slot,
  output: OutputPort,
  registration: OutputRegistration,
  captureSignal: AbortSignal,
  startedAt: number,
): NativeHarnessOutputSelectionFailure | null {
  const local = outputLocalFailure(state, slot, captureSignal);
  if (local !== null) return local;
  const clock = outputClockFailure(state, slot, startedAt);
  if (clock !== null) return clock;
  const prepared = prepareOutputCheck(slot, state, registration, true);
  if (!prepared.ok) {
    return outputFailure(prepared.code === "not-ready" ? "source-conflict" : prepared.code, prepared.reason);
  }
  const clockAfter = outputClockFailure(state, slot, startedAt);
  if (clockAfter !== null) return clockAfter;
  const source = sourceSuccessProblem(slot, slot.response);
  if (source !== null) return outputFailure("source-conflict", source);
  const owner = ownerPredicateReason(output);
  if (owner !== null) return outputFailure("authority-lost", owner);
  const signal = readActualAbortSignal(captureSignal);
  if (!signal.ok) return outputFailure("invalid-caller", signal.reason);
  if (signal.aborted) return outputFailure("cancelled", "the output capture signal was aborted");
  const pure = pureCheckReason(prepared.check);
  if (pure !== null) return outputFailure("source-conflict", pure);
  return outputLocalFailure(state, slot, captureSignal)
    ?? (prepared.observedSha256 === null || prepared.observedBytes === null
      ? outputFailure("source-conflict", "the actual source result observation is unavailable")
      : null);
}

function captureFinalGate(
  state: CoordinatorState,
  slot: Slot,
  output: OutputPort,
  registration: OutputRegistration,
  capture: NativeHarnessOutputCapture,
  captureSignal: AbortSignal,
  startedAt: number,
  observedSha256: string,
  observedBytes: number,
): NativeHarnessOutputSelectionFailure | null {
  const clock = outputClockFailure(state, slot, startedAt);
  if (clock !== null) return clock;
  const backend = slot.backend?.receiver;
  if (backend === undefined || !outputMatches(output, backend, capture)) {
    return outputFailure("source-conflict", "the issued output capture is no longer bound to this backend");
  }
  const prepared = prepareOutputCheck(slot, state, registration, true);
  if (!prepared.ok) {
    return outputFailure(prepared.code === "not-ready" ? "source-conflict" : prepared.code, prepared.reason);
  }
  const clockAfter = outputClockFailure(state, slot, startedAt);
  if (clockAfter !== null) return clockAfter;
  if (prepared.observedSha256 !== observedSha256 || prepared.observedBytes !== observedBytes) {
    return outputFailure("source-conflict", "the source result observation changed during capture");
  }

  // Final sequence, no host callback follows: pure owner predicate, actual
  // capture signal, captured native pure revalidation, then local source state.
  const owner = ownerPredicateReason(output);
  if (owner !== null) return outputFailure("authority-lost", owner);
  const signal = readActualAbortSignal(captureSignal);
  if (!signal.ok) return outputFailure("invalid-caller", signal.reason);
  if (signal.aborted) return outputFailure("cancelled", "the output capture signal was aborted before retention");
  const pure = pureCheckReason(prepared.check);
  if (pure !== null) return outputFailure("source-conflict", pure);
  const local = outputLocalFailure(state, slot, captureSignal);
  if (local !== null) return local;
  if (slot.output.registration !== registration) {
    return outputFailure("source-conflict", "the source result registration was replaced");
  }
  if (slot.output.guardFailure !== null) return slot.output.guardFailure;
  const source = sourceSuccessProblem(slot, slot.response);
  if (source !== null) return outputFailure("source-conflict", source);
  return null;
}

function readCapturedOutput(
  value: unknown,
  slot: Slot,
  output: OutputPort,
  registration: OutputRegistration,
): { readonly ok: true; readonly capture: NativeHarnessOutputCapture; readonly bytes: number }
  | NativeHarnessOutputSelectionFailure {
  const fields = readStrictFields(value, ["ok", "capture", "code", "reason"], ["ok"]);
  if (fields === null) {
    return outputFailure("capture-failed", "the trusted output capture returned an unreadable result");
  }
  if (fields.get("ok") !== true) {
    const code = fields.get("code");
    const reason = fields.get("reason");
    const mapped: NativeHarnessOutputSelectionCode = code === "aborted"
      ? "cancelled"
      : code === "deadline"
        ? "deadline"
        : code === "authority-lost"
          ? "authority-lost"
          : code === "invalid-control"
            ? "invalid-caller"
            : code === "source-unavailable" || code === "changed" || code === "missing"
              ? "source-conflict"
              : "capture-failed";
    return outputFailure(
      mapped,
      typeof reason === "string" ? reason : "the trusted output capture refused",
    );
  }
  const captureValue = fields.get("capture");
  if (!isRecord(captureValue)) {
    return outputFailure("capture-failed", "the trusted output capture returned no capture object");
  }
  const runId = readOwnField(captureValue, "runId");
  const taskSha256 = readOwnField(captureValue, "taskSha256");
  const changes = readOwnField(captureValue, "changes");
  if (runId.kind !== "data"
    || taskSha256.kind !== "data"
    || changes.kind !== "data"
    || typeof runId.value !== "string"
    || !isHex64(taskSha256.value)
    || !Array.isArray(changes.value)) {
    return outputFailure("capture-failed", "the trusted output capture has unreadable identity facts");
  }
  if (runId.value !== registration.runId || taskSha256.value !== registration.taskSha256) {
    return outputFailure("source-conflict", "the issued output capture does not match the original run and task");
  }
  if (changes.value.length < 1 || changes.value.length > MAX_OUTPUT_CHANGES) {
    return outputFailure("capture-failed", "the issued output capture change count is outside the bound");
  }
  let totalBytes = 0;
  for (const change of changes.value) {
    const snapshot = readOwnField(change, "snapshot");
    if (snapshot.kind !== "data" || !isNativeWorkspaceTextSnapshot(snapshot.value)) {
      return outputFailure("capture-failed", "the issued output capture contains a non-native snapshot");
    }
    const file = readOwnField(snapshot.value, "file");
    const bytes = file.kind === "data" ? readOwnField(file.value, "bytes") : { kind: "missing" as const };
    if (bytes.kind !== "data"
      || typeof bytes.value !== "number"
      || !Number.isSafeInteger(bytes.value)
      || bytes.value < 0
      || bytes.value > 256 * 1024) {
      return outputFailure("capture-failed", "the issued output capture snapshot exceeds its byte bound");
    }
    totalBytes += bytes.value;
    if (totalBytes > MAX_OUTPUT_CHANGE_BYTES) {
      return outputFailure("capture-failed", "the issued output capture text exceeds the retained byte bound");
    }
  }
  const backend = slot.backend?.receiver;
  if (backend === undefined || !outputMatches(output, backend, captureValue)) {
    return outputFailure("source-conflict", "the issued output capture is not bound to the original backend");
  }
  return { ok: true, capture: captureValue as unknown as NativeHarnessOutputCapture, bytes: totalBytes };
}

function releaseOutputReservation(state: CoordinatorState, slot: Slot): void {
  const reserved = slot.output.reservedBytes;
  if (reserved > 0) {
    slot.output.reservedBytes = 0;
    state.outputReservedBytes = Math.max(0, state.outputReservedBytes - reserved);
  }
  if (state.outputActive === slot) state.outputActive = null;
}

function retainOutputSuccess(
  state: CoordinatorState,
  slot: Slot,
  registration: OutputRegistration,
  capture: NativeHarnessOutputCapture,
  bytes: number,
  observedSha256: string,
  observedBytes: number,
): NativeHarnessOutputSelectionFailure | null {
  if (state.outputBytes + bytes > NATIVE_HARNESS_MAX_OUTPUT_BYTES) {
    return outputFailure("capacity", "the retained output byte budget would be exceeded");
  }
  const out = slot.output;
  releaseOutputReservation(state, slot);
  state.outputRetained += 1;
  state.outputBytes += bytes;
  out.retainedBytes = bytes;
  out.capture = capture;
  out.observedSha256 = observedSha256;
  out.observedBytes = observedBytes;
  out.state = "captured";
  out.promise = null;
  out.requestSignal = null;
  out.controller = null;
  out.cleanup = null;
  out.failure = null;
  out.selection = Object.freeze({
    ok: true as const,
    observation: "captured-now" as const,
    filesystemFreshness: "observed-during-capture" as const,
    capture,
    association: slot.association,
    runId: registration.runId,
    taskSha256: registration.taskSha256,
    workPromptSha256: registration.workPromptSha256,
    callInputSha256: registration.callInputSha256,
    expectedResultSha256: registration.expectedSha256,
    observedResultSha256: observedSha256,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  });
  return null;
}

function failOutput(
  state: CoordinatorState,
  slot: Slot,
  failure: NativeHarnessOutputSelectionFailure,
): void {
  const out = slot.output;
  releaseOutputReservation(state, slot);
  out.state = "failed";
  out.failure = failure;
  out.promise = null;
  out.requestSignal = null;
  out.controller = null;
  out.cleanup = null;
  out.selection = null;
  out.capture = null;
  out.retainedBytes = 0;
}

function cancelOutputCapture(slot: Slot, reason: string): boolean {
  const out = slot.output;
  if (out.state !== "running" || out.controller === null || out.guardFailure !== null) return false;
  out.guardFailure = outputFailure("cancelled", reason);
  try {
    out.controller.abort(new Error(reason));
  } catch {
    // The local capture signal is already aborted.
  }
  return true;
}

function createCaptureController(requestSignal: AbortSignal):
  | { readonly ok: true; readonly controller: AbortController; readonly cleanup: () => void }
  | { readonly ok: false; readonly reason: string } {
  if (ACTUAL_ADD_EVENT_LISTENER === null || ACTUAL_REMOVE_EVENT_LISTENER === null) {
    return { ok: false, reason: "host abort listeners are unavailable" };
  }
  const controller = new AbortController();
  const listener = (): void => {
    try {
      controller.abort(new Error("output capture cancelled"));
    } catch {
      // Already aborted.
    }
  };
  try {
    Reflect.apply(ACTUAL_ADD_EVENT_LISTENER, requestSignal, ["abort", listener, { once: true }]);
  } catch (error) {
    return { ok: false, reason: `output capture listener failed: ${outputThrownReason(error, "output operation failed")}` };
  }
  const read = readActualAbortSignal(requestSignal);
  if (!read.ok) {
    try {
      Reflect.apply(ACTUAL_REMOVE_EVENT_LISTENER, requestSignal, ["abort", listener]);
    } catch {
      // Best effort.
    }
    return { ok: false, reason: read.reason };
  }
  if (read.aborted) {
    try {
      controller.abort(new Error("output capture signal already aborted"));
    } catch {
      // Already aborted.
    }
  }
  return {
    ok: true,
    controller,
    cleanup(): void {
      try {
        Reflect.apply(ACTUAL_REMOVE_EVENT_LISTENER as EventTarget["removeEventListener"], requestSignal, ["abort", listener]);
      } catch {
        // Best-effort listener removal.
      }
    },
  };
}

async function runOutputCapture(
  state: CoordinatorState,
  slot: Slot,
  output: OutputPort,
  registration: OutputRegistration,
  controller: AbortController,
  cleanup: () => void,
  startedAt: number,
  observedSha256: string,
  observedBytes: number,
): Promise<void> {
  const out = slot.output;
  let capture: NativeHarnessOutputCapture | null = null;
  let retainedBytes = 0;
  let failure: NativeHarnessOutputSelectionFailure | null = null;
  try {
    const guard = (): void => {
      const gate = captureGuardGate(state, slot, output, registration, controller.signal, startedAt);
      if (gate !== null) {
        out.guardFailure = gate;
        throw new NativeHarnessDelegationError(gate.reason);
      }
    };
    let raw: unknown;
    try {
      raw = Reflect.apply(output.capture, output.receiver, [
        slot.backend === null ? null : slot.backend.receiver,
        guard,
        controller.signal,
      ]);
    } catch (error) {
      failure = out.guardFailure
        ?? outputFailure("capture-failed", `the trusted output capture threw: ${outputThrownReason(error, "output operation failed")}`);
    }
    if (failure === null) {
      if (!consumeNativePromise(raw)) {
        failure = out.guardFailure
          ?? outputFailure("capture-failed", "the trusted output capture did not return a native Promise");
      } else {
        let leaf: unknown;
        try {
          leaf = await (raw as Promise<unknown>);
        } catch (error) {
          failure = out.guardFailure
            ?? outputFailure("capture-failed", `the trusted output capture rejected: ${outputThrownReason(error, "output operation failed")}`);
        }
        if (failure === null) {
          const read = readCapturedOutput(leaf, slot, output, registration);
          if (!read.ok) {
            failure = out.guardFailure ?? read;
          } else {
            capture = read.capture;
            retainedBytes = read.bytes;
          }
        }
      }
    }
    if (failure === null && capture !== null) {
      const final = captureFinalGate(
        state,
        slot,
        output,
        registration,
        capture,
        controller.signal,
        startedAt,
        observedSha256,
        observedBytes,
      );
      if (final !== null) failure = final;
    }
  } catch (error) {
    failure = out.guardFailure
      ?? outputFailure("capture-failed", `the output capture failed unexpectedly: ${outputThrownReason(error, "output operation failed")}`);
  } finally {
    try {
      cleanup();
    } catch {
      // Best effort.
    }
    if (failure === null && capture !== null) {
      const retained = retainOutputSuccess(
        state,
        slot,
        registration,
        capture,
        retainedBytes,
        observedSha256,
        observedBytes,
      );
      if (retained === null) return;
      failure = retained;
    }
    failOutput(
      state,
      slot,
      failure ?? outputFailure("capture-failed", "the output capture settled without a result"),
    );
  }
}

function captureOutputInternal(
  state: CoordinatorState,
  actualSourceToolCallId: unknown,
  captureSignalValue: unknown,
): Promise<NativeHarnessOutputSelection> {
  try {
    if (state.disposed) {
      return Promise.resolve(outputFailure("authority-lost", "the delegation coordinator was disposed"));
    }
    if (!state.enabled) {
      return Promise.resolve(outputFailure("authority-lost", "the delegation coordinator is disabled"));
    }
    const toolCallId = boundedString(actualSourceToolCallId, MAX_TOOL_CALL_ID_CHARS);
    if (toolCallId === null) {
      return Promise.resolve(outputFailure("invalid-caller", "the actual source tool call id is unavailable"));
    }
    const slot = state.slots.get(toolCallId);
    if (slot === undefined) {
      return Promise.resolve(outputFailure("not-ready", "no retained delegation operation has this source id"));
    }
    const out = slot.output;
    if (out.state === "failed" && out.failure !== null) {
      return Promise.resolve(out.failure);
    }
    if (out.state === "captured" && out.selection !== null) {
      const cached = captureCachedOutput(state, slot, captureSignalValue);
      return Promise.resolve(cached);
    }
    if (out.state === "running" && out.promise !== null) {
      if (out.requestSignal !== captureSignalValue) {
        return Promise.resolve(outputFailure(
          "capacity",
          "another output capture is already in flight for this delegation",
        ));
      }
      const signal = readActualAbortSignal(captureSignalValue);
      if (!signal.ok) return Promise.resolve(outputFailure("invalid-caller", signal.reason));
      if (signal.aborted) {
        return Promise.resolve(outputFailure("cancelled", "the output capture signal was aborted"));
      }
      if (state.disposed) {
        return Promise.resolve(outputFailure("authority-lost", "the delegation coordinator was disposed"));
      }
      const output = state.output;
      const registration = out.registration;
      if (output === null || registration === null || out.startedAt === null) {
        return Promise.resolve(outputFailure("not-ready", "the in-flight output capture is incomplete"));
      }
      // Sharing the owner promise still requires a fresh caller scope. The
      // validation itself is bounded so a reentrant host callback cannot loop.
      if (state.outputJoinValidating) {
        return Promise.resolve(outputFailure(
          "not-ready",
          "reentrant output capture join validation was refused",
        ));
      }
      state.outputJoinValidating = true;
      try {
        const admitted = captureGuardGate(
          state,
          slot,
          output,
          registration,
          captureSignalValue as AbortSignal,
          out.startedAt,
        );
        if (admitted !== null) return Promise.resolve(admitted);
        if (out.state !== "running" || out.promise === null || out.requestSignal !== captureSignalValue) {
          return Promise.resolve(outputFailure(
            "not-ready",
            "the in-flight output capture changed during join validation",
          ));
        }
        return out.promise;
      } catch (error) {
        return Promise.resolve(outputFailure(
          "authority-lost",
          `the output capture join validation failed: ${outputThrownReason(error, "output operation failed")}`,
        ));
      } finally {
        state.outputJoinValidating = false;
      }
    }
    if (out.state !== "idle") {
      return Promise.resolve(outputFailure("not-ready", "the source output state is unavailable"));
    }
    const signal = readActualAbortSignal(captureSignalValue);
    if (!signal.ok) return Promise.resolve(outputFailure("invalid-caller", signal.reason));
    if (signal.aborted) return Promise.resolve(outputFailure("cancelled", "the output capture signal was aborted"));
    const output = state.output;
    if (output === null) {
      return Promise.resolve(outputFailure(
        "output-unavailable",
        "the trusted output port is not available",
      ));
    }
    const registration = out.registration;
    if (registration === null) {
      return Promise.resolve(outputFailure(
        "output-unavailable",
        out.registrationFailure ?? "the actual source result projection is not registered",
      ));
    }
    if (state.outputActive !== null) {
      return Promise.resolve(outputFailure("capacity", "another output capture is already in flight"));
    }
    if (state.outputRetained >= NATIVE_HARNESS_MAX_OUTPUT_CAPTURES) {
      return Promise.resolve(outputFailure("capacity", "the retained output capture count is exhausted"));
    }
    if (state.outputBytes + state.outputReservedBytes + NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES
      > NATIVE_HARNESS_MAX_OUTPUT_BYTES) {
      return Promise.resolve(outputFailure("capacity", "the retained output byte budget is exhausted or reserved"));
    }
    const gate = captureEntryGate(state, slot, output, registration, captureSignalValue as AbortSignal);
    if (!gate.ok) return Promise.resolve(gate);

    // Gate callbacks may reenter and admit another Slot. Recheck the original
    // local operation and all capacity facts immediately before reservation.
    if (state.outputActive !== null) {
      return Promise.resolve(outputFailure("capacity", "another output capture is already in flight"));
    }
    if (state.outputRetained >= NATIVE_HARNESS_MAX_OUTPUT_CAPTURES) {
      return Promise.resolve(outputFailure("capacity", "the retained output capture count is exhausted"));
    }
    if (state.outputBytes + state.outputReservedBytes + NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES
      > NATIVE_HARNESS_MAX_OUTPUT_BYTES) {
      return Promise.resolve(outputFailure("capacity", "the retained output byte budget is exhausted or reserved"));
    }
    if (state.disposed
      || out.state !== "idle"
      || out.registration !== registration
      || state.slots.get(toolCallId) !== slot) {
      return Promise.resolve(outputFailure("not-ready", "the source output state changed during admission"));
    }
    const combined = createCaptureController(captureSignalValue as AbortSignal);
    if (!combined.ok) return Promise.resolve(outputFailure("invalid-caller", combined.reason));

    // Reserve and install the exact deferred promise/state before the leaf can
    // start any callback or I/O. Reentrant callers observe the same operation.
    const settled = deferred<NativeHarnessOutputSelection>();
    state.outputReservedBytes += NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES;
    state.outputActive = slot;
    out.state = "running";
    out.promise = settled.promise;
    out.requestSignal = captureSignalValue as AbortSignal;
    out.controller = combined.controller;
    out.cleanup = combined.cleanup;
    out.guardFailure = null;
    out.reservedBytes = NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES;
    out.observedSha256 = gate.observedSha256;
    out.observedBytes = gate.observedBytes;
    out.startedAt = gate.now;
    out.lastClock = gate.now;
    void runOutputCapture(
      state,
      slot,
      output,
      registration,
      combined.controller,
      combined.cleanup,
      gate.now,
      gate.observedSha256,
      gate.observedBytes,
    ).then(
      () => {
        settled.resolve(
          out.selection
            ?? out.failure
            ?? outputFailure("capture-failed", "the output capture settled without a result"),
        );
      },
      (error) => {
        const failure = outputFailure(
          "capture-failed",
          `the output capture task failed: ${outputThrownReason(error, "output operation failed")}`,
        );
        failOutput(state, slot, failure);
        settled.resolve(failure);
      },
    );
    return settled.promise;
  } catch (error) {
    return Promise.resolve(outputFailure(
      "capture-failed",
      `the output capture admission failed: ${outputThrownReason(error, "output operation failed")}`,
    ));
  }
}

function captureCachedOutput(
  state: CoordinatorState,
  slot: Slot,
  captureSignalValue: unknown,
): NativeHarnessOutputSelection {
  const out = slot.output;
  if (out.capture === null || out.selection === null || out.registration === null) {
    return outputFailure("not-ready", "the retained output capture is unavailable");
  }
  if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
  if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
  const signal = readActualAbortSignal(captureSignalValue);
  if (!signal.ok) return outputFailure("invalid-caller", signal.reason);
  if (signal.aborted) return outputFailure("cancelled", "the output capture signal was aborted");
  const output = state.output;
  if (output === null) return outputFailure("output-unavailable", "the trusted output port is not available");
  const registration = out.registration;
  const prepared = prepareOutputCheck(slot, state, registration, true);
  if (!prepared.ok) {
    return outputFailure(prepared.code === "not-ready" ? "source-conflict" : prepared.code, prepared.reason);
  }
  const backend = slot.backend?.receiver;
  if (backend === undefined || !outputMatches(output, backend, out.capture)) {
    return outputFailure("source-conflict", "the retained output capture is no longer bound to this backend");
  }
  const source = sourceSuccessProblem(slot, slot.response);
  if (source !== null) return outputFailure("source-conflict", source);
  if (prepared.observedSha256 !== out.selection.observedResultSha256) {
    return outputFailure("source-conflict", "the source result observation changed after capture");
  }
  // All matcher/native reads are complete. Final pure owner/signal/native/local
  // sequence; the retained historical snapshot is never mutated by refusal.
  const owner = ownerPredicateReason(output);
  if (owner !== null) return outputFailure("authority-lost", owner);
  const signalAfter = readActualAbortSignal(captureSignalValue);
  if (!signalAfter.ok) return outputFailure("invalid-caller", signalAfter.reason);
  if (signalAfter.aborted) return outputFailure("cancelled", "the output capture signal was aborted");
  const pure = pureCheckReason(prepared.check);
  if (pure !== null) return outputFailure("source-conflict", pure);
  if (state.disposed
    || !state.enabled
    || out.state !== "captured"
    || out.capture !== out.selection.capture
    || out.registration !== registration) {
    return outputFailure("authority-lost", "the retained output capture state changed during the fresh check");
  }
  return Object.freeze({
    ...out.selection,
    observation: "cached-historical" as const,
    filesystemFreshness: "not-rechecked" as const,
  });
}

function registerToolResultProjectionInternal(
  state: CoordinatorState,
  actualSourceToolCallId: unknown,
  actualDelegationResponse: unknown,
  actualProjectedResult: unknown,
  originalSignal: unknown,
): { readonly ok: boolean; readonly reason: string | null } {
  let slot: Slot | null = null;
  let lockAcquired = false;
  try {
    if (state.disposed) return registrationFailure("the delegation coordinator was disposed");
    if (!state.enabled) return registrationFailure("the delegation coordinator is disabled");
    const toolCallId = boundedString(actualSourceToolCallId, MAX_TOOL_CALL_ID_CHARS);
    if (toolCallId === null) return registrationFailure("the actual source tool call id is unavailable");
    slot = state.slots.get(toolCallId) ?? null;
    if (slot === null) return registrationFailure("no retained delegation operation has this source id");
    const out = slot.output;
    if (out.registering) return registrationFailure("source result registration is already in progress");
    if (originalSignal !== slot.invocationSignal) {
      return registrationFailure("the original invocation signal is not the retained source signal");
    }
    const signal = readActualAbortSignal(originalSignal);
    if (!signal.ok) return registrationFailure(signal.reason);
    if (signal.aborted) return registrationFailure("the original invocation signal was aborted at registration");
    const source = sourceSuccessProblem(slot, actualDelegationResponse);
    if (source !== null) {
      out.registrationFailure = boundedReason(source, "output unavailable");
      return registrationFailure(source);
    }
    if (out.state !== "idle") {
      return registrationFailure("source output capture has already started");
    }
    const output = state.output;
    if (output === null) {
      out.registrationFailure = "the trusted output port is unavailable";
      return registrationFailure(out.registrationFailure);
    }
    const register = state.native.registerCallResultExpectation;
    if (register === null) {
      out.registrationFailure = "native result expectation registration is unavailable";
      return registrationFailure(out.registrationFailure);
    }
    out.registering = true;
    lockAcquired = true;

    const initial = prepareOutputCheck(slot, state, null, false);
    if (!initial.ok) {
      out.registrationFailure = boundedReason(initial.reason, "output unavailable");
      return registrationFailure(initial.reason);
    }
    const initialPure = pureCheckReason(initial.check);
    if (initialPure !== null) {
      out.registrationFailure = boundedReason(initialPure, "output unavailable");
      return registrationFailure(initialPure);
    }
    let rawRegistration: unknown;
    try {
      rawRegistration = Reflect.apply(register, state.native.receiver, [
        slot.originalRef,
        { input: { task: slot.task }, result: actualProjectedResult },
        initial.context,
      ]);
    } catch (error) {
      out.registrationFailure = outputThrownReason(error, "native result expectation registration threw");
      return registrationFailure(out.registrationFailure);
    }
    const fingerprint = readRegistrationFingerprint(rawRegistration);
    if (!fingerprint.ok) {
      out.registrationFailure = boundedReason(fingerprint.reason, "output unavailable");
      return registrationFailure(fingerprint.reason);
    }

    // Registration replaced the native expectation identity. The old prepared
    // check is stale by design and must not authorize this commit.
    const after = prepareOutputCheck(slot, state, null, false);
    if (!after.ok) {
      out.registrationFailure = boundedReason(after.reason, "output unavailable");
      return registrationFailure(after.reason);
    }
    if (after.workPromptSha256 !== initial.workPromptSha256
      || after.callInputSha256 !== initial.callInputSha256) {
      out.registrationFailure = "the original source work prompt or call input changed during registration";
      return registrationFailure(out.registrationFailure);
    }
    const projection = readRegisteredProjection(
      after.inspection,
      fingerprint,
      out.observedSha256,
      out.observedBytes,
    );
    if (!projection.ok) {
      out.registrationFailure = boundedReason(projection.reason, "output unavailable");
      return registrationFailure(projection.reason);
    }
    const owner = ownerPredicateReason(output);
    if (owner !== null) {
      out.registrationFailure = boundedReason(owner, "output unavailable");
      return registrationFailure(owner);
    }
    const finalSignal = readActualAbortSignal(slot.invocationSignal);
    if (!finalSignal.ok) {
      out.registrationFailure = boundedReason(finalSignal.reason, "output unavailable");
      return registrationFailure(finalSignal.reason);
    }
    if (finalSignal.aborted) {
      out.registrationFailure = "the original invocation signal was aborted during registration";
      return registrationFailure(out.registrationFailure);
    }
    const afterPure = pureCheckReason(after.check);
    if (afterPure !== null) {
      out.registrationFailure = boundedReason(afterPure, "output unavailable");
      return registrationFailure(afterPure);
    }
    if (state.disposed
      || !state.enabled
      || slot.output.state !== "idle"
      || slot.output.registering !== true
      || slot.response === null
      || sourceSuccessProblem(slot, slot.response) !== null) {
      out.registrationFailure = "the original source state changed during registration";
      return registrationFailure(out.registrationFailure);
    }
    const taskSha256 = sha256Hex(slot.task);
    const existing = out.registration;
    if (existing !== null) {
      if (existing.expectedSha256 !== fingerprint.sha256
        || existing.expectedBytes !== fingerprint.bytes
        || existing.workPromptSha256 !== initial.workPromptSha256
        || existing.callInputSha256 !== initial.callInputSha256
        || existing.taskSha256 !== taskSha256
        || existing.runId !== slot.runId) {
        out.registrationFailure = "a different result projection was already registered for this source";
        return registrationFailure(out.registrationFailure);
      }
      out.registrationFailure = null;
      return registrationSuccess();
    }
    out.registration = Object.freeze({
      expectedSha256: fingerprint.sha256,
      expectedBytes: fingerprint.bytes,
      workPromptSha256: initial.workPromptSha256,
      callInputSha256: initial.callInputSha256,
      taskSha256,
      runId: slot.runId as string,
    });
    out.observedSha256 = projection.observedSha256;
    out.observedBytes = projection.observedBytes;
    out.registrationFailure = null;
    return registrationSuccess();
  } catch (error) {
    if (slot !== null) {
      slot.output.registrationFailure = outputThrownReason(error, "output unavailable");
    }
    return registrationFailure(error);
  } finally {
    if (slot !== null && lockAcquired) slot.output.registering = false;
  }
}

function checkFailureFromOutput(failure: NativeHarnessOutputSelectionFailure): NativeHarnessCheckFailure {
  const code = failure.code === "output-unavailable" || failure.code === "capture-failed"
    ? "check-unavailable"
    : failure.code;
  return createNativeHarnessCheckFailure(code, failure.reason);
}

interface PreparedCheckSource {
  readonly output: OutputPort;
  readonly registration: OutputRegistration;
  readonly capture: NativeHarnessOutputCapture;
  readonly prepared: PreparedOutputCheck;
}

interface RetainedCheckAction {
  readonly slot: Slot;
  readonly record: NativeHarnessCheckActionRecord;
}

/**
 * Bounded search over the existing Slot records before routing by the
 * caller-supplied source selector. A retained action id cannot move to another
 * Slot and gain a fresh preflight comparison.
 */
function findRetainedCheckAction(
  state: CoordinatorState,
  actionToolCallId: string,
): RetainedCheckAction | null {
  for (const slot of state.slots.values()) {
    const checks = slot.output.checks;
    if (checks === null) continue;
    const record = checks.actions.get(actionToolCallId);
    if (record !== undefined) return { slot, record };
  }
  return null;
}

interface ActionAssociation {
  readonly observationId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

function actionAssociationOf(reference: NativeWorkCallReference): ActionAssociation {
  return {
    observationId: reference.observationId,
    generation: reference.generation,
    sessionId: reference.sessionId,
    workspaceRoot: reference.workspaceRoot,
    toolCallId: reference.toolCallId,
    toolName: reference.toolName,
  };
}

function sameActionWorkIdentity(slot: Slot, association: ActionAssociation): boolean {
  return association.observationId === slot.association.observationId
    && association.generation === slot.association.generation
    && association.sessionId === slot.association.sessionId
    && association.workspaceRoot === slot.association.workspaceRoot;
}

function sameActionAssociation(value: unknown, expected: ActionAssociation): boolean {
  if (!isRecord(value)) return false;
  try {
    return value.observationId === expected.observationId
      && value.generation === expected.generation
      && value.sessionId === expected.sessionId
      && value.workspaceRoot === expected.workspaceRoot
      && value.toolCallId === expected.toolCallId
      && value.toolName === expected.toolName;
  } catch {
    return false;
  }
}

function prepareCheckSource(
  state: CoordinatorState,
  slot: Slot,
): PreparedCheckSource | NativeHarnessCheckFailure {
  if (state.disposed) {
    return createNativeHarnessCheckFailure("authority-lost", "the delegation coordinator was disposed");
  }
  if (!state.enabled) {
    return createNativeHarnessCheckFailure("authority-lost", "the delegation coordinator is disabled");
  }
  const out = slot.output;
  if (out.state !== "captured" || out.capture === null || out.registration === null) {
    return createNativeHarnessCheckFailure("not-ready", "the source output has not been captured");
  }
  const output = state.output;
  if (output === null) {
    return createNativeHarnessCheckFailure("check-unavailable", "the trusted output port is unavailable");
  }
  const prepared = prepareOutputCheck(slot, state, out.registration, true);
  if (!prepared.ok) return checkFailureFromOutput(prepared);
  const source = sourceSuccessProblem(slot, slot.response);
  if (source !== null) {
    return createNativeHarnessCheckFailure("source-conflict", source);
  }
  const backend = slot.backend?.receiver;
  if (backend === undefined || !outputMatches(output, backend, out.capture)) {
    return createNativeHarnessCheckFailure(
      "source-conflict",
      "the issued output capture is no longer bound to this backend",
    );
  }
  return {
    output,
    registration: out.registration,
    capture: out.capture,
    prepared,
  };
}

function captureCheckAction(
  state: CoordinatorState,
  slot: Slot,
  context: NativeContext,
  actionToolCallId: string,
): { readonly ref: NativeWorkCallReference; readonly inputSha256: string } | NativeHarnessCheckFailure {
  let capture: NativeCallCapture;
  try {
    capture = Reflect.apply(state.native.captureCall, state.native.receiver, [
      { toolCallId: actionToolCallId, toolName: NATIVE_HARNESS_RESULT_TOOL },
      context,
    ]);
  } catch (error) {
    return createNativeHarnessCheckFailure(
      "authority-lost",
      `native check action capture threw: ${outputThrownReason(error, "check action capture failed")}`,
    );
  }
  if (!capture.ok) {
    return createNativeHarnessCheckFailure("authority-lost", nativeInspectionReason(capture.inspection));
  }
  const inspection = capture.inspection;
  if (inspection.state !== "current" || inspection.evidenceState !== "available") {
    return createNativeHarnessCheckFailure("authority-lost", nativeInspectionReason(inspection));
  }
  let association: ActionAssociation;
  try {
    association = actionAssociationOf(capture.ref);
  } catch {
    return createNativeHarnessCheckFailure(
      "authority-lost",
      "native check action capture returned unreadable association facts",
    );
  }
  if (association.toolCallId !== actionToolCallId || association.toolName !== NATIVE_HARNESS_RESULT_TOOL) {
    return createNativeHarnessCheckFailure(
      "invalid-caller",
      "native check action capture returned a different actual tool call",
    );
  }
  if (!sameActionWorkIdentity(slot, association)) {
    return createNativeHarnessCheckFailure(
      "source-conflict",
      "the check action does not belong to the original source work identity",
    );
  }
  if (!isHex64(inspection.callInputSha256)) {
    return createNativeHarnessCheckFailure(
      "source-conflict",
      "the check action preflight input digest is unavailable or ambiguous",
    );
  }
  return { ref: capture.ref, inputSha256: inspection.callInputSha256 };
}

interface PreparedCheckAction {
  readonly check: ReadyCallCheck;
  readonly inspection: NativeWorkCallInspection;
  readonly context: NativeContext;
  readonly inputSha256: string;
}

function prepareCheckAction(
  state: CoordinatorState,
  slot: Slot,
  actionRef: NativeWorkCallReference,
  context: NativeContext,
  registration: { readonly sha256: string; readonly bytes: number } | null,
): PreparedCheckAction | NativeHarnessCheckFailure {
  let check: NativeCallCheckPreparation;
  try {
    check = Reflect.apply(state.native.prepareCallCheck, state.native.receiver, [actionRef, context]);
  } catch (error) {
    return createNativeHarnessCheckFailure(
      "authority-lost",
      `native check action revalidation threw: ${outputThrownReason(error, "check action revalidation failed")}`,
    );
  }
  if (!check.ok) {
    return createNativeHarnessCheckFailure(
      projectionConflict(check.inspection) ? "source-conflict" : "authority-lost",
      nativeInspectionReason(check.inspection),
    );
  }
  const inspection = check.inspection;
  if (inspection.state !== "current" || inspection.evidenceState !== "available") {
    return createNativeHarnessCheckFailure(
      projectionConflict(inspection) ? "source-conflict" : "authority-lost",
      nativeInspectionReason(inspection),
    );
  }
  if (inspection.requestAttribution !== "matched-user-input") {
    return createNativeHarnessCheckFailure(
      "authority-lost",
      "the check action is no longer associated with matched user input",
    );
  }
  if (inspection.pendingInputCount !== 0 || inspection.pendingInputsDropped !== 0) {
    return createNativeHarnessCheckFailure("authority-lost", "the check action work has queued or dropped inputs");
  }
  if (!sameActionAssociation(inspection.association, {
    observationId: slot.association.observationId,
    generation: slot.association.generation,
    sessionId: slot.association.sessionId,
    workspaceRoot: slot.association.workspaceRoot,
    toolCallId: actionRef.toolCallId,
    toolName: NATIVE_HARNESS_RESULT_TOOL,
  })) {
    return createNativeHarnessCheckFailure(
      "source-conflict",
      "the check action now has an incompatible native association",
    );
  }
  const inputSha256 = inspection.callInputSha256;
  if (!isHex64(inputSha256)) {
    return createNativeHarnessCheckFailure(
      "source-conflict",
      "the check action preflight input digest is unavailable or ambiguous",
    );
  }
  const projection = inspection.resultProjection;
  if (!isRecord(projection)) {
    return createNativeHarnessCheckFailure("source-conflict", "the check action result projection is unavailable");
  }
  if (registration === null) {
    if (projection.state !== "unregistered") {
      return createNativeHarnessCheckFailure(
        "source-conflict",
        `the check action result projection is ${String(projection.state)}`,
      );
    }
  } else {
    if (projection.expectedSha256 !== registration.sha256
      || projection.expectedBytes !== registration.bytes) {
      return createNativeHarnessCheckFailure(
        "source-conflict",
        "the check action expected result fingerprint is not the retained registration",
      );
    }
    if (projection.state === "pending") {
      // The registered expectation has not been observed yet.
    } else if (projection.state === "matched") {
      if (projection.observedSha256 !== registration.sha256
        || projection.observedBytes !== registration.bytes) {
        return createNativeHarnessCheckFailure(
          "source-conflict",
          "the observed check action result is not the retained registration",
        );
      }
    } else {
      return createNativeHarnessCheckFailure(
        "source-conflict",
        `the check action result projection is ${String(projection.state)}`,
      );
    }
  }
  return { check, inspection, context, inputSha256 };
}

/**
 * Authenticated admission point for one genuine check action. All host
 * inspection parsing (source revalidation, action capture, preflight input
 * digest) must already be complete: every check below is pure or reads local
 * coordinator state only. A refusal here creates no action record, so an
 * initially invalid owner, signal, work or capacity stays correctable.
 */
function initialCheckAdmission(
  state: CoordinatorState,
  slot: Slot,
  source: PreparedCheckSource,
  checks: NativeHarnessCheckState,
  signalValue: unknown,
): NativeHarnessCheckFailure | null {
  const owner = ownerPredicateReason(source.output);
  if (owner !== null) return createNativeHarnessCheckFailure("authority-lost", owner);
  const signal = readActualAbortSignal(signalValue);
  if (!signal.ok) return createNativeHarnessCheckFailure("invalid-caller", signal.reason);
  if (signal.aborted) {
    return createNativeHarnessCheckFailure("cancelled", "the actual check signal was aborted");
  }
  const sourcePure = pureCheckReason(source.prepared.check);
  if (sourcePure !== null) return createNativeHarnessCheckFailure("source-conflict", sourcePure);
  if (state.disposed) {
    return createNativeHarnessCheckFailure("authority-lost", "the delegation coordinator was disposed");
  }
  if (!state.enabled) {
    return createNativeHarnessCheckFailure("authority-lost", "the delegation coordinator is disabled");
  }
  if (state.slots.get(slot.toolCallId) !== slot) {
    return createNativeHarnessCheckFailure("source-conflict", "the original source Slot was replaced");
  }
  const out = slot.output;
  if (out.state !== "captured"
    || out.capture !== source.capture
    || out.registration !== source.registration
    || out.checks !== checks) {
    return createNativeHarnessCheckFailure("source-conflict", "the retained source capture changed during the check");
  }
  if (checks.actions.size >= NATIVE_HARNESS_MAX_CHECK_ACTIONS) {
    return createNativeHarnessCheckFailure("capacity", "the retained check action count is exhausted");
  }
  return null;
}

function finalCheckGate(
  state: CoordinatorState,
  slot: Slot,
  source: PreparedCheckSource,
  action: PreparedCheckAction,
  signalValue: unknown,
  checks: NativeHarnessCheckState,
): NativeHarnessCheckFailure | null {
  // Final sequence, no host data read after the pure checks except the listed
  // actual signal check: original pure owner, actual action signal, prepared
  // source pure check, prepared action pure check, then local exact state.
  const owner = ownerPredicateReason(source.output);
  if (owner !== null) return createNativeHarnessCheckFailure("authority-lost", owner);
  const signal = readActualAbortSignal(signalValue);
  if (!signal.ok) return createNativeHarnessCheckFailure("invalid-caller", signal.reason);
  if (signal.aborted) {
    return createNativeHarnessCheckFailure("cancelled", "the actual check signal was aborted");
  }
  const sourcePure = pureCheckReason(source.prepared.check);
  if (sourcePure !== null) return createNativeHarnessCheckFailure("source-conflict", sourcePure);
  const actionPure = pureCheckReason(action.check);
  if (actionPure !== null) return createNativeHarnessCheckFailure("source-conflict", actionPure);
  if (state.disposed) {
    return createNativeHarnessCheckFailure("authority-lost", "the delegation coordinator was disposed");
  }
  if (!state.enabled) {
    return createNativeHarnessCheckFailure("authority-lost", "the delegation coordinator is disabled");
  }
  if (state.slots.get(slot.toolCallId) !== slot) {
    return createNativeHarnessCheckFailure("source-conflict", "the original source Slot was replaced");
  }
  const out = slot.output;
  if (out.state !== "captured"
    || out.capture !== source.capture
    || out.registration !== source.registration
    || out.checks !== checks) {
    return createNativeHarnessCheckFailure("source-conflict", "the retained source capture changed during the check");
  }
  return null;
}

function isCheckFailure(value: unknown): value is NativeHarnessCheckFailure {
  return typeof value === "object"
    && value !== null
    && (value as { readonly ok?: unknown }).ok === false;
}

/**
 * Consumes one bounded action slot for a genuine action ref whose admission
 * failed after capture. No prospective path, plan conditions or receipt are
 * retained; the same actual call becomes terminal for its original signal.
 */
function retainTerminalCheckAction(
  state: CoordinatorState,
  checks: NativeHarnessCheckState,
  actionToolCallId: string,
  sourceToolCallId: string,
  actionRef: NativeWorkCallReference,
  inputSha256: string,
  signal: AbortSignal,
  failure: NativeHarnessCheckFailure,
): void {
  if (state.disposed || !state.enabled) return;
  if (checks.actions.has(actionToolCallId)) return;
  if (checks.actions.size >= NATIVE_HARNESS_MAX_CHECK_ACTIONS) return;
  checks.actions.set(actionToolCallId, createNativeHarnessCheckTerminalActionRecord({
    actionRef,
    actionToolCallId,
    sourceToolCallId,
    inputSha256,
    signal,
    failureCode: failure.code,
    reason: failure.reason,
  }));
}

function retainedRegistration(
  record: NativeHarnessCheckRetainedActionRecord,
): { readonly sha256: string; readonly bytes: number } | null | undefined {
  if (record.registrationSha256 === null && record.registrationBytes === null) return null;
  if (record.registrationSha256 === null || record.registrationBytes === null) return undefined;
  return { sha256: record.registrationSha256, bytes: record.registrationBytes };
}

function admitCheckOutput(
  state: CoordinatorState,
  slot: Slot,
  actionToolCallId: string,
  normalized: Extract<ReturnType<typeof normalizeNativeHarnessCheckInput>, { readonly ok: true }>,
  signalValue: unknown,
): NativeHarnessCheckOutcome {
  const input = normalized.input;
  const out = slot.output;
  if (out.state !== "captured" || out.capture === null || out.registration === null) {
    return createNativeHarnessCheckFailure("not-ready", "the source output has not been captured");
  }
  const capture = out.capture;
  if (input.captureId !== capture.captureId || input.captureDigest !== capture.digest) {
    return createNativeHarnessCheckFailure(
      "source-conflict",
      "the check selectors do not exactly match the retained source capture",
    );
  }
  const change = capture.changes.find((record) => record.path === input.path);
  if (change === undefined) {
    return createNativeHarnessCheckFailure(
      "source-conflict",
      "the check path is not one of the retained capture changes",
    );
  }
  if (!isNativeWorkspaceTextSnapshot(change.snapshot)) {
    return createNativeHarnessCheckFailure("source-conflict", "the selected capture path has no native snapshot");
  }
  if (out.checks === null) out.checks = createNativeHarnessCheckState();
  const checks = out.checks;
  if (checks.busy) {
    return createNativeHarnessCheckFailure("not-ready", "a check operation is already in progress for this source Slot");
  }
  checks.busy = true;
  try {
    const source = prepareCheckSource(state, slot);
    if (isCheckFailure(source)) return source;

    let path = checks.paths.find((record) =>
      record.captureId === capture.captureId && record.path === input.path) ?? null;
    let newPath = false;
    if (path !== null) {
      if (!sameNativeHarnessCheckPlan(path.plan, normalized.plan)) {
        return createNativeHarnessCheckFailure(
          "source-conflict",
          "different check conditions already exist for this captured path",
        );
      }
      if (path.captureDigest !== capture.digest || path.snapshot !== change.snapshot) {
        return createNativeHarnessCheckFailure(
          "source-conflict",
          "the retained path record no longer matches the original capture snapshot",
        );
      }
    } else {
      if (checks.paths.length >= NATIVE_HARNESS_MAX_CHECK_PATHS) {
        return createNativeHarnessCheckFailure("capacity", "the retained check path count is exhausted");
      }
      const conditions = checks.paths.reduce((total, record) => total + record.plan.conditions.length, 0);
      if (conditions + normalized.plan.conditions.length > NATIVE_HARNESS_MAX_CHECK_CONDITIONS) {
        return createNativeHarnessCheckFailure("capacity", "the retained check condition budget is exhausted");
      }
      let receipt;
      try {
        receipt = runNativeTextChecks(change.snapshot, normalized.plan);
      } catch (error) {
        return createNativeHarnessCheckFailure(
          "check-unavailable",
          `the fixed text checks refused: ${outputThrownReason(error, "check computation failed")}`,
        );
      }
      const candidate = createNativeHarnessCheckPathRecord({
        captureId: capture.captureId,
        captureDigest: capture.digest,
        path: input.path,
        snapshot: change.snapshot,
        plan: normalized.plan,
        receipt,
        computedByToolCallId: actionToolCallId,
      });
      if (candidate === null) {
        return createNativeHarnessCheckFailure(
          "check-unavailable",
          "the fixed text check receipt is not authentic for the retained snapshot and plan",
        );
      }
      if (checks.retainedMetadataBytes + candidate.planBytes + candidate.receiptBytes
        > NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES) {
        return createNativeHarnessCheckFailure("capacity", "the retained check metadata byte budget is exhausted");
      }
      path = candidate;
      newPath = true;
    }

    // A temporary candidate plan is discarded for an existing path. The
    // retained action input is rebuilt from the once-copied selectors and the
    // original path plan's frozen conditions, then re-fingerprinted. The
    // canonical digest must be identical to the candidate normalization.
    let retainedInput: NativeHarnessCheckInput = normalized.input;
    let retainedDigest = normalized.digest;
    if (!newPath) {
      const stable: NativeHarnessCheckInput = Object.freeze({
        action: "check" as const,
        sourceToolCallId: input.sourceToolCallId,
        captureId: input.captureId,
        captureDigest: input.captureDigest,
        path: input.path,
        conditions: path.plan.conditions,
      });
      const fingerprint = fingerprintNativeJson(stable);
      if (!fingerprint.ok || fingerprint.sha256 !== normalized.digest) {
        return createNativeHarnessCheckFailure(
          "source-conflict",
          "the retained path plan does not describe the same frozen check input",
        );
      }
      retainedInput = stable;
      retainedDigest = fingerprint.sha256;
    }

    const captured = captureCheckAction(state, slot, source.prepared.context, actionToolCallId);
    if (isCheckFailure(captured)) return captured;
    // A captured ref is not authenticated admission. The genuine native
    // preflight input must equal the frozen normalized input before this call
    // can consume an action slot or become terminal.
    if (captured.inputSha256 !== retainedDigest) {
      return createNativeHarnessCheckFailure(
        "protocol",
        "the actual check call preflight input differs from the frozen normalized input",
      );
    }
    // Explicit authenticated admission before the later action preparation
    // callbacks: source gates, authentic capture and exact input proof are
    // above; the pure owner/signal/source-purecheck, local Slot and capacity
    // gates are here. No host inspection is parsed after this point.
    const initial = initialCheckAdmission(state, slot, source, checks, signalValue);
    if (initial !== null) return initial;

    // Authenticated. Any later terminal refusal retains only the first action
    // ref/signal/digest for this actual call; no successful path, plan
    // conditions or receipt is committed.
    const failAfterCapture = (failure: NativeHarnessCheckFailure): NativeHarnessCheckFailure => {
      retainTerminalCheckAction(
        state,
        checks,
        actionToolCallId,
        input.sourceToolCallId,
        captured.ref,
        retainedDigest,
        signalValue as AbortSignal,
        failure,
      );
      return failure;
    };
    const action = prepareCheckAction(state, slot, captured.ref, source.prepared.context, null);
    if (isCheckFailure(action)) return failAfterCapture(action);
    if (action.inputSha256 !== retainedDigest) {
      return failAfterCapture(createNativeHarnessCheckFailure(
        "protocol",
        "the actual check call preflight input differs from the frozen normalized input",
      ));
    }

    const response = createNativeHarnessCheckResponse(actionToolCallId, retainedInput, path);
    const final = finalCheckGate(state, slot, source, action, signalValue, checks);
    if (final !== null) return failAfterCapture(final);

    // One local commit. No host getter, callback, clock or input reread follows.
    if (state.disposed || !state.enabled) {
      return failAfterCapture(createNativeHarnessCheckFailure(
        "authority-lost",
        "the delegation coordinator changed during the check",
      ));
    }
    if (state.slots.get(input.sourceToolCallId) !== slot || slot.toolCallId !== input.sourceToolCallId) {
      return failAfterCapture(createNativeHarnessCheckFailure(
        "source-conflict",
        "the original source Slot was replaced",
      ));
    }
    if (out.state !== "captured"
      || out.capture !== capture
      || out.registration !== source.registration
      || out.checks !== checks
      || checks.busy !== true
      || checks.actions.has(actionToolCallId)) {
      return failAfterCapture(createNativeHarnessCheckFailure(
        "source-conflict",
        "the retained check state changed during admission",
      ));
    }
    if (newPath) {
      if (checks.paths.length >= NATIVE_HARNESS_MAX_CHECK_PATHS) {
        return failAfterCapture(createNativeHarnessCheckFailure(
          "capacity",
          "the retained check path count is exhausted",
        ));
      }
      const conditions = checks.paths.reduce((total, record) => total + record.plan.conditions.length, 0);
      if (conditions + path.plan.conditions.length > NATIVE_HARNESS_MAX_CHECK_CONDITIONS) {
        return failAfterCapture(createNativeHarnessCheckFailure(
          "capacity",
          "the retained check condition budget is exhausted",
        ));
      }
      if (checks.retainedMetadataBytes + path.planBytes + path.receiptBytes
        > NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES) {
        return failAfterCapture(createNativeHarnessCheckFailure(
          "capacity",
          "the retained check metadata byte budget is exhausted",
        ));
      }
      checks.paths.push(path);
      checks.retainedMetadataBytes += path.planBytes + path.receiptBytes;
    } else if (!checks.paths.includes(path)) {
      return failAfterCapture(createNativeHarnessCheckFailure(
        "source-conflict",
        "the retained check path record disappeared",
      ));
    }
    checks.actions.set(actionToolCallId, createNativeHarnessCheckActionRecord({
      actionRef: captured.ref,
      input: retainedInput,
      inputSha256: retainedDigest,
      signal: signalValue as AbortSignal,
      path,
      response,
    }));
    return response;
  } finally {
    checks.busy = false;
  }
}

function checkOutputInternal(
  state: CoordinatorState,
  actualCheckToolCallIdValue: unknown,
  inputValue: unknown,
  signalValue: unknown,
): NativeHarnessCheckOutcome {
  try {
    if (state.disposed) {
      return createNativeHarnessCheckFailure("authority-lost", "the delegation coordinator was disposed");
    }
    if (!state.enabled) {
      return createNativeHarnessCheckFailure("authority-lost", "the delegation coordinator is disabled");
    }
    const actionToolCallId = boundedString(actualCheckToolCallIdValue, MAX_TOOL_CALL_ID_CHARS);
    if (actionToolCallId === null) {
      return createNativeHarnessCheckFailure("invalid-caller", "the actual check tool call id is unavailable");
    }
    const normalized = normalizeNativeHarnessCheckInput(inputValue);
    if (!normalized.ok) return normalized;
    const input = normalized.input;
    const signal = readActualAbortSignal(signalValue);
    if (!signal.ok) return createNativeHarnessCheckFailure("invalid-caller", signal.reason);

    const retained = findRetainedCheckAction(state, actionToolCallId);
    if (retained === null) {
      if (signal.aborted) {
        return createNativeHarnessCheckFailure("cancelled", "the actual check signal was aborted before admission");
      }
      if (actionToolCallId === input.sourceToolCallId) {
        return createNativeHarnessCheckFailure(
          "invalid-caller",
          "the check action must use a different actual tool call id than the source",
        );
      }
      const slot = state.slots.get(input.sourceToolCallId);
      if (slot === undefined) {
        return createNativeHarnessCheckFailure(
          "not-ready",
          "no retained delegation operation has this source id",
        );
      }
      return admitCheckOutput(state, slot, actionToolCallId, normalized, signalValue);
    }

    const slot = retained.slot;
    const record = retained.record;
    if (record.signal !== signalValue) {
      return createNativeHarnessCheckFailure(
        "invalid-caller",
        "the actual check signal is not the original action signal",
      );
    }
    const checks = slot.output.checks;
    if (checks === null) {
      return createNativeHarnessCheckFailure("source-conflict", "the retained check state is unavailable");
    }
    if (checks.busy) {
      return createNativeHarnessCheckFailure("not-ready", "a check operation is already in progress for this source Slot");
    }
    if (record.kind === "terminal") {
      return createNativeHarnessCheckFailure(
        record.state === "cancelled" ? "cancelled" : "source-conflict",
        record.reason,
      );
    }
    if (record.state !== "admitted") {
      return createNativeHarnessCheckFailure(
        record.state === "cancelled" ? "cancelled" : "source-conflict",
        record.conflictReason ?? `the retained check action is ${record.state}`,
      );
    }
    checks.busy = true;
    try {
      const source = prepareCheckSource(state, slot);
      if (isCheckFailure(source)) return source;
      const registration = retainedRegistration(record);
      if (registration === undefined) {
        return createNativeHarnessCheckFailure(
          "source-conflict",
          "the retained check registration fingerprint is incomplete",
        );
      }
      const action = prepareCheckAction(state, slot, record.actionRef, source.prepared.context, registration);
      if (isCheckFailure(action)) return action;

      const inputChanged = normalized.digest !== record.inputSha256
        || action.inputSha256 !== record.inputSha256;
      const selectorsChanged = record.input.sourceToolCallId !== input.sourceToolCallId
        || record.input.captureId !== input.captureId
        || record.input.captureDigest !== input.captureDigest
        || record.input.path !== input.path;
      const capture = slot.output.capture;
      const pathInvalid = capture === null
        || record.path.captureId !== capture.captureId
        || record.path.captureDigest !== capture.digest
        || !checks.paths.includes(record.path);

      // Authenticate the retained action and its original owner/signal/pure
      // refs before changing any existing record state. A foreign or
      // authority-lost caller only refuses and cannot poison this action.
      const final = finalCheckGate(state, slot, source, action, signalValue, checks);
      if (final !== null) {
        if (final.code === "cancelled" && record.state === "admitted") {
          record.state = "cancelled";
          record.conflictReason = final.reason;
        }
        return final;
      }

      // The retained action is authenticated. A changed effective input is
      // sticky for this actual call even if the caller later restores it.
      if (inputChanged) {
        record.state = "conflicted";
        record.conflictReason = "the same check action call changed its input";
        return createNativeHarnessCheckFailure(
          "source-conflict",
          "the same check action call changed its input",
        );
      }
      if (selectorsChanged) {
        record.state = "conflicted";
        record.conflictReason = "the same check action call changed its selectors";
        return createNativeHarnessCheckFailure(
          "source-conflict",
          "the same check action call changed its selectors",
        );
      }
      if (pathInvalid) {
        record.state = "conflicted";
        record.conflictReason = "the retained check path no longer matches the original capture";
        return createNativeHarnessCheckFailure(
          "source-conflict",
          "the retained check path no longer matches the original capture",
        );
      }
      if (record.registrationConflict !== null) {
        return createNativeHarnessCheckFailure("source-conflict", record.registrationConflict);
      }
      return record.response;
    } finally {
      checks.busy = false;
    }
  } catch (error) {
    return createNativeHarnessCheckFailure(
      "check-unavailable",
      `the host-only check failed unexpectedly: ${outputThrownReason(error, "check operation failed")}`,
    );
  }
}

function registerOutputCheckProjectionInternal(
  state: CoordinatorState,
  actualSourceToolCallId: unknown,
  actualCheckToolCallId: unknown,
  exactCheckResponse: unknown,
  actualProjectedResult: unknown,
  originalCheckSignal: unknown,
): { readonly ok: boolean; readonly reason: string | null } {
  let checks: NativeHarnessCheckState | null = null;
  let busyAcquired = false;
  try {
    if (state.disposed) return registrationFailure("the delegation coordinator was disposed");
    if (!state.enabled) return registrationFailure("the delegation coordinator is disabled");
    const sourceToolCallId = boundedString(actualSourceToolCallId, MAX_TOOL_CALL_ID_CHARS);
    if (sourceToolCallId === null) return registrationFailure("the actual source tool call id is unavailable");
    const actionToolCallId = boundedString(actualCheckToolCallId, MAX_TOOL_CALL_ID_CHARS);
    if (actionToolCallId === null) return registrationFailure("the actual check tool call id is unavailable");
    const retained = findRetainedCheckAction(state, actionToolCallId);
    if (retained === null) return registrationFailure("no retained check action has this tool call id");
    const slot = retained.slot;
    const record = retained.record;
    if (record.kind === "terminal") {
      return registrationFailure(record.reason);
    }
    if (slot.toolCallId !== sourceToolCallId || record.sourceToolCallId !== sourceToolCallId) {
      return registrationFailure("the check action does not belong to this source tool call");
    }
    if (exactCheckResponse !== record.response) {
      return registrationFailure("the check response is not the exact retained action response");
    }
    if (originalCheckSignal !== record.signal) {
      return registrationFailure("the original check signal is not the retained action signal");
    }
    const signal = readActualAbortSignal(originalCheckSignal);
    if (!signal.ok) return registrationFailure(signal.reason);
    if (signal.aborted) {
      // Registration does not change record state here. Only a fresh
      // authenticated check admission may make the aborted call terminal.
      return registrationFailure("the original check action signal was aborted at registration");
    }
    checks = slot.output.checks;
    if (checks === null) return registrationFailure("the retained check state is unavailable");
    if (record.state !== "admitted") {
      return registrationFailure(record.conflictReason ?? `the retained check action is ${record.state}`);
    }
    if (record.registrationConflict !== null) return registrationFailure(record.registrationConflict);
    if (checks.busy) return registrationFailure("a check operation is already in progress for this source Slot");

    // Acquire this Slot's owned lock before any caller-wire reflection. A
    // getter/Proxy trap that reenters sees busy and cannot start a second
    // registration. The whole projection is still fingerprinted once before
    // any host callback below.
    checks.busy = true;
    busyAcquired = true;
    const expected = fingerprintExpectedCallResult({ input: record.input, result: actualProjectedResult });
    if (!expected.ok) {
      return registrationFailure(`result expectation unavailable: ${expected.reason}`);
    }
    if (expected.inputFingerprint.sha256 !== record.inputSha256) {
      return registrationFailure("the projected input fingerprint is not the retained check input");
    }

    const source = prepareCheckSource(state, slot);
    if (isCheckFailure(source)) return registrationFailure(source.reason);
    const preRegistration = retainedRegistration(record);
    if (preRegistration === undefined) {
      return registrationFailure("the retained check registration fingerprint is incomplete");
    }
    const action = prepareCheckAction(state, slot, record.actionRef, source.prepared.context, preRegistration);
    if (isCheckFailure(action)) return registrationFailure(action.reason);
    const existing = retainedRegistration(record);
    const inputChanged = action.inputSha256 !== record.inputSha256;
    const registrationChanged = existing !== null && existing !== undefined
      && (existing.sha256 !== expected.fingerprint.sha256 || existing.bytes !== expected.fingerprint.bytes);
    if (inputChanged || registrationChanged) {
      // Authenticate the retained action and original owner/signal/pure refs
      // before turning this action conflicted or registration-unusable.
      const beforeMutation = finalCheckGate(state, slot, source, action, originalCheckSignal, checks);
      if (beforeMutation !== null) return registrationFailure(beforeMutation.reason);
      if (inputChanged) {
        record.state = "conflicted";
        record.conflictReason = "the same check action call changed its input";
        return registrationFailure(record.conflictReason);
      }
      record.registrationConflict = "a different result projection was already registered for this check action";
      return registrationFailure(record.registrationConflict);
    }
    const register = state.native.registerCallResultExpectation;
    if (register === null) {
      return registrationFailure("native result expectation registration is unavailable");
    }
    let raw: unknown;
    try {
      raw = Reflect.apply(register, state.native.receiver, [
        record.actionRef,
        { input: record.input, result: actualProjectedResult },
        source.prepared.context,
      ]);
    } catch (error) {
      return registrationFailure(`native result expectation registration threw: ${outputThrownReason(error, "registration failed")}`);
    }
    const fingerprint = readRegistrationFingerprint(raw);
    if (!fingerprint.ok) return registrationFailure(fingerprint.reason);
    if (fingerprint.sha256 !== expected.fingerprint.sha256
      || fingerprint.bytes !== expected.fingerprint.bytes) {
      return registrationFailure("the native registered fingerprint is not the precomputed check projection");
    }

    // Registration replaced the native expectation identity. Both prepared
    // checks must be refreshed; the pre-registration pure checks are stale.
    const refreshedSource = prepareCheckSource(state, slot);
    if (isCheckFailure(refreshedSource)) return registrationFailure(refreshedSource.reason);
    if (refreshedSource.prepared.workPromptSha256 !== source.prepared.workPromptSha256
      || refreshedSource.prepared.callInputSha256 !== source.prepared.callInputSha256) {
      return registrationFailure("the original source work prompt or call input changed during registration");
    }
    const refreshedAction = prepareCheckAction(
      state,
      slot,
      record.actionRef,
      refreshedSource.prepared.context,
      expected.fingerprint,
    );
    if (isCheckFailure(refreshedAction)) return registrationFailure(refreshedAction.reason);
    if (refreshedAction.inputSha256 !== record.inputSha256) {
      const beforeMutation = finalCheckGate(
        state,
        slot,
        refreshedSource,
        refreshedAction,
        originalCheckSignal,
        checks,
      );
      if (beforeMutation !== null) return registrationFailure(beforeMutation.reason);
      record.state = "conflicted";
      record.conflictReason = "the same check action call changed its input";
      return registrationFailure(record.conflictReason);
    }
    const final = finalCheckGate(state, slot, refreshedSource, refreshedAction, originalCheckSignal, checks);
    if (final !== null) return registrationFailure(final.reason);
    if (state.disposed || !state.enabled) {
      return registrationFailure("the delegation coordinator changed during check registration");
    }
    if (state.slots.get(sourceToolCallId) !== slot
      || slot.output.checks !== checks
      || checks.actions.get(actionToolCallId) !== record
      || record.state !== "admitted"
      || record.registrationConflict !== null
      || record.response !== exactCheckResponse
      || record.signal !== originalCheckSignal) {
      return registrationFailure("the retained check action state changed during registration");
    }
    record.registrationSha256 = expected.fingerprint.sha256;
    record.registrationBytes = expected.fingerprint.bytes;
    return registrationSuccess();
  } catch (error) {
    return registrationFailure(error);
  } finally {
    if (busyAcquired && checks !== null) checks.busy = false;
  }
}

function beginCancellation(slot: Slot, reason: SlotCancelReason): void {
  if (slot.state !== "running" || slot.cancelRequested) return;
  slot.cancelRequested = true;
  slot.cancelReason = reason;
  try {
    slot.abortController.abort(new Error(`delegation ${reason}`));
  } catch {
    // The local signal is already aborted or unavailable; state still changed.
  }
  slot.cleanupTimer = setTimeout(() => {
    slot.cleanupExpired.resolve(undefined);
  }, slotState(slot)?.limits.cleanupGraceMs ?? DEFAULT_POLICY.cleanupGraceMs);
  if (slot.runId !== null) requestBackendCancel(slot);
}

function requestBackendCancel(slot: Slot): void {
  if (slot.runId === null || slot.backend === null) return;
  if (slot.cancelState !== "none") return;
  slot.cancelState = "requested";
  let raw: unknown;
  try {
    raw = Reflect.apply(slot.backend.cancel, slot.backend.receiver, [slot.runId]);
  } catch (error) {
    slot.cancelState = "request-failed";
    slot.cancelSettled = true;
    slot.cancelError = boundedReason(error, "the backend cancellation request failed");
    return;
  }
  if (!consumeNativePromise(raw)) {
    slot.cancelSettled = true;
    return;
  }
  slot.cancelPromise = (raw as Promise<unknown>).then(
    () => {
      slot.cancelSettled = true;
    },
    (error) => {
      slot.cancelSettled = true;
      slot.cancelState = "request-failed";
      slot.cancelError = boundedReason(error, "the backend cancellation request failed");
    },
  );
}

type WaitOutcome<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "expired" };

/**
 * Wait for a port while allowing cleanup grace to bound an abandoned wait.
 * The underlying settlement handlers remain attached after expiry.
 */
async function awaitWithCleanup<T>(slot: Slot, promise: Promise<T>): Promise<WaitOutcome<T>> {
  let settled = false;
  const observed = promise.then(
    (value) => {
      settled = true;
      return { kind: "value" as const, value };
    },
    (error) => {
      settled = true;
      return { kind: "error" as const, error };
    },
  );
  const expired = slot.cleanupExpired.promise.then(() => ({ kind: "expired" as const }));
  const first = await Promise.race([observed, expired]);
  if (first.kind === "expired") {
    if (settled) return await observed;
    return { kind: "expired" };
  }
  return first;
}

function callBackendCreate(slot: Slot, backend: BackendPort): Promise<unknown> {
  try {
    const raw = Reflect.apply(backend.create, backend.receiver, [slot.task]);
    if (!consumeNativePromise(raw)) {
      return Promise.reject(new NativeHarnessDelegationError("backend create did not return a native Promise"));
    }
    return raw as Promise<unknown>;
  } catch (error) {
    return Promise.reject(error);
  }
}

function callBackendExecute(slot: Slot, backend: BackendPort, runId: string): Promise<unknown> {
  try {
    const raw = Reflect.apply(backend.execute, backend.receiver, [runId]);
    if (!consumeNativePromise(raw)) {
      return Promise.reject(new NativeHarnessDelegationError("backend execute did not return a native Promise"));
    }
    return raw as Promise<unknown>;
  } catch (error) {
    return Promise.reject(error);
  }
}

function readBackendRunId(value: unknown): string | null {
  const fields = readStrictFields(value, ["runId"], ["runId"]);
  if (fields === null) return null;
  return boundedString(fields.get("runId"), MAX_RUN_ID_CHARS);
}

const BACKEND_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
  "applied",
]);

function readBackendStatus(value: unknown): NativeHarnessBackendStatus | null {
  if (!isRecord(value)) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "status");
  } catch {
    return null;
  }
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
  return BACKEND_STATUSES.has(descriptor.value)
    ? descriptor.value as NativeHarnessBackendStatus
    : null;
}

interface WorkerFacts {
  readonly status: string | null;
  readonly costUsd: number | null;
  readonly estimated: boolean;
  readonly validUsage: boolean;
  readonly knownCompleted: boolean;
}

function readWorkerFacts(value: unknown): WorkerFacts {
  if (!isRecord(value)) {
    return { status: null, costUsd: null, estimated: false, validUsage: false, knownCompleted: false };
  }
  let statusDescriptor: PropertyDescriptor | undefined;
  let estimatedDescriptor: PropertyDescriptor | undefined;
  let usageDescriptor: PropertyDescriptor | undefined;
  try {
    statusDescriptor = Object.getOwnPropertyDescriptor(value, "status");
    estimatedDescriptor = Object.getOwnPropertyDescriptor(value, "usageEstimated");
    usageDescriptor = Object.getOwnPropertyDescriptor(value, "usage");
  } catch {
    return { status: null, costUsd: null, estimated: false, validUsage: false, knownCompleted: false };
  }
  const status = statusDescriptor !== undefined
    && "value" in statusDescriptor
    && typeof statusDescriptor.value === "string"
    ? statusDescriptor.value
    : null;
  let estimated = false;
  let estimatedReadable = true;
  if (estimatedDescriptor !== undefined) {
    if (!("value" in estimatedDescriptor)) estimatedReadable = false;
    else estimated = estimatedDescriptor.value === true;
  }
  let costUsd: number | null = null;
  if (usageDescriptor !== undefined && "value" in usageDescriptor && isRecord(usageDescriptor.value)) {
    let costDescriptor: PropertyDescriptor | undefined;
    try {
      costDescriptor = Object.getOwnPropertyDescriptor(usageDescriptor.value, "costUsd");
    } catch {
      costDescriptor = undefined;
    }
    if (costDescriptor !== undefined
      && "value" in costDescriptor
      && typeof costDescriptor.value === "number"
      && Number.isFinite(costDescriptor.value)
      && costDescriptor.value >= 0) {
      costUsd = costDescriptor.value;
    }
  }
  const validUsage = costUsd !== null && estimatedReadable && !estimated;
  return {
    status,
    costUsd,
    estimated,
    validUsage,
    knownCompleted: validUsage && status === "completed",
  };
}

function readWorkerRequest(request: unknown): { readonly ok: true; readonly request: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  if (!isRecord(request)) return { ok: false, reason: "worker request is not an object" };
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(request);
    keys = Reflect.ownKeys(request);
  } catch {
    return { ok: false, reason: "worker request could not be inspected" };
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: "worker request uses an unsupported prototype" };
  }
  if (keys.some((key) => typeof key !== "string")) {
    return { ok: false, reason: "worker request contains symbol properties" };
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(request, key);
    } catch {
      return { ok: false, reason: "worker request could not be inspected" };
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      return { ok: false, reason: "worker request contains an accessor property" };
    }
    Object.defineProperty(copy, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ok: true, request: copy };
}

function combineSignals(
  slot: Slot,
  workerSignal: unknown,
): { readonly ok: true; readonly signal: AbortSignal; readonly cleanup: () => void } | { readonly ok: false; readonly reason: string } {
  if (workerSignal !== undefined && workerSignal !== null) {
    const read = readActualAbortSignal(workerSignal);
    if (!read.ok) return { ok: false, reason: `worker signal is invalid: ${read.reason}` };
  }
  const sources: AbortSignal[] = [slot.signal];
  if (workerSignal !== undefined && workerSignal !== null) sources.push(workerSignal as AbortSignal);
  if (ACTUAL_ADD_EVENT_LISTENER === null || ACTUAL_REMOVE_EVENT_LISTENER === null) {
    return { ok: false, reason: "host abort listeners are unavailable" };
  }
  const controller = new AbortController();
  const listeners: Array<{ readonly source: AbortSignal; readonly listener: () => void }> = [];
  for (const source of sources) {
    const read = readActualAbortSignal(source);
    if (!read.ok) {
      cleanup();
      return { ok: false, reason: read.reason };
    }
    if (read.aborted) {
      controller.abort(new Error("delegation combined signal aborted"));
      break;
    }
    const listener = () => {
      try {
        controller.abort(new Error("delegation combined signal aborted"));
      } catch {
        // Already aborted.
      }
    };
    try {
      Reflect.apply(ACTUAL_ADD_EVENT_LISTENER, source, ["abort", listener, { once: true }]);
      listeners.push({ source, listener });
    } catch (error) {
      cleanup();
      return { ok: false, reason: `worker signal listener failed: ${boundedReason(error, "unreadable failure")}` };
    }
  }
  // A signal can abort between the first and second attach.
  for (const source of sources) {
    const read = readActualAbortSignal(source);
    if (read.ok && read.aborted) controller.abort(new Error("delegation combined signal aborted"));
  }
  return {
    ok: true,
    signal: controller.signal,
    cleanup(): void {
      cleanup();
    },
  };

  function cleanup(): void {
    for (const item of listeners) {
      try {
        Reflect.apply(ACTUAL_REMOVE_EVENT_LISTENER as EventTarget["removeEventListener"], item.source, ["abort", item.listener]);
      } catch {
        // Best-effort listener removal only.
      }
    }
  }
}

function recordDispatchResult(
  slot: Slot,
  requestedUsd: number,
  facts: WorkerFacts | null,
): void {
  const state = slotState(slot);
  slot.runnerInflightUsd = Math.max(0, slot.runnerInflightUsd - requestedUsd);
  if (facts !== null && facts.knownCompleted && !slot.cancelRequested) {
    const cost = facts.costUsd as number;
    slot.runnerAccountedUsd = money(slot.runnerAccountedUsd + cost);
    slot.observedCostUsd = money(slot.observedCostUsd + cost);
    slot.observedAny = true;
    if (cost > requestedUsd + USD_EPSILON) {
      slot.overspendUsd = money(slot.overspendUsd + cost - requestedUsd);
      if (state !== null) state.budgetBlocked = true;
    }
    return;
  }
  slot.workerAllKnownCompleted = false;
  slot.workerUnknownUsage = true;
  const cost = facts?.costUsd ?? null;
  if (cost !== null && !facts?.estimated) {
    slot.observedCostUsd = money(slot.observedCostUsd + cost);
    slot.observedAny = true;
  }
  const charged = Math.max(requestedUsd, cost ?? 0);
  slot.runnerAccountedUsd = money(slot.runnerAccountedUsd + charged);
  if (charged > requestedUsd + USD_EPSILON) {
    slot.overspendUsd = money(slot.overspendUsd + charged - requestedUsd);
    if (state !== null) state.budgetBlocked = true;
  }
}

function dispatchWorker(slot: Slot, requestValue: WorkerRequest): Promise<WorkerResult> {
  const state = slotState(slot);
  if (state === null) return Promise.reject(new NativeHarnessDelegationError("delegation state is unavailable"));
  if (slot.dispatchClosed) {
    return Promise.reject(new NativeHarnessDelegationError(
      "worker dispatch is closed because backend execution already settled",
    ));
  }
  if (!slot.executionStarted || slot.state !== "running") {
    return Promise.reject(new NativeHarnessDelegationError("worker dispatch is not active"));
  }
  if (slot.workerPromises.size >= MAX_INFLIGHT_WORKERS) {
    return Promise.reject(new NativeHarnessDelegationError("worker dispatch exceeds the in-flight bound"));
  }
  const read = readWorkerRequest(requestValue);
  if (!read.ok) return Promise.reject(new NativeHarnessDelegationError(read.reason));
  const request = read.request;
  if (request.runId !== slot.runId) {
    return Promise.reject(new NativeHarnessDelegationError("worker request runId is not the actual created run"));
  }
  const requestedUsd = request.maxCostUsd;
  if (typeof requestedUsd !== "number" || !Number.isFinite(requestedUsd) || requestedUsd <= 0) {
    return Promise.reject(new NativeHarnessDelegationError("worker request maxCostUsd must be positive and finite"));
  }
  const timeoutMs = request.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new NativeHarnessDelegationError("worker request timeoutMs must be positive and finite"));
  }
  const remainingReservation = state.limits.perRunUsd - slot.runnerAccountedUsd - slot.runnerInflightUsd;
  if (state.budgetBlocked || requestedUsd > remainingReservation + USD_EPSILON) {
    return Promise.reject(new NativeHarnessDelegationError(
      "worker request allocation exceeds the operation's remaining delegation reservation",
    ));
  }
  const time = readClock(state.now);
  if (time === null) return Promise.reject(new NativeHarnessDelegationError("delegation clock is unavailable"));
  const remainingDeadlineMs = slot.deadlineAt - time;
  if (remainingDeadlineMs <= 0) {
    beginCancellation(slot, "deadline-expired");
    return Promise.reject(new NativeHarnessDelegationError("the original delegation deadline expired"));
  }
  const effectiveTimeoutMs = Math.min(timeoutMs, remainingDeadlineMs);
  const combined = combineSignals(slot, request.signal);
  if (!combined.ok) return Promise.reject(new NativeHarnessDelegationError(combined.reason));

  // Reserve the dispatch locally before the final pure gate; release on refusal.
  slot.runnerInflightUsd += requestedUsd;
  const gate = authorityGate(slot, "effect");
  if (gate !== null) {
    slot.runnerInflightUsd = Math.max(0, slot.runnerInflightUsd - requestedUsd);
    combined.cleanup();
    // Losing authority must still clean up the already bound actual run. This
    // only requests cancellation of this operation's run; it never dispatches.
    beginCancellation(slot, cancelReasonForGate(gate));
    return Promise.reject(new NativeHarnessDelegationError(gate));
  }
  // The Controller or a reentrant callback may have aborted its worker signal
  // while the authority getters/pure gate ran. Never dispatch an already
  // aborted combined signal; read the captured native getter only, no callback.
  const combinedAbort = readActualAbortSignal(combined.signal);
  if (!combinedAbort.ok || combinedAbort.aborted) {
    slot.runnerInflightUsd = Math.max(0, slot.runnerInflightUsd - requestedUsd);
    combined.cleanup();
    return Promise.reject(new NativeHarnessDelegationError(
      combinedAbort.ok
        ? "the combined worker signal was aborted before dispatch"
        : combinedAbort.reason,
    ));
  }

  request.timeoutMs = effectiveTimeoutMs;
  request.signal = combined.signal;
  slot.workerDispatches += 1;
  slot.workerCount += 1;

  let tracked: Promise<WorkerResult> | null = null;
  let settledBeforeTracking = false;
  const promise = (async (): Promise<WorkerResult> => {
    try {
      const result = await Reflect.apply(state.runner.run, state.runner.receiver, [request as unknown as WorkerRequest]);
      recordDispatchResult(slot, requestedUsd, readWorkerFacts(result));
      return result;
    } catch (error) {
      recordDispatchResult(slot, requestedUsd, null);
      throw error;
    } finally {
      combined.cleanup();
      // A synchronous Runner throw runs this finally before the returned
      // promise can be assigned to `tracked`. Never retain an already settled
      // promise in the in-flight set, or it would consume the dispatch bound
      // forever.
      if (tracked === null) settledBeforeTracking = true;
      else slot.workerPromises.delete(tracked);
    }
  })();
  tracked = promise;
  if (!settledBeforeTracking) slot.workerPromises.add(promise);
  // Keep a rejection handler attached even when a cleanup grace abandons the wait.
  void promise.catch(() => undefined);
  return promise;
}

function makeGuardedRunner(slot: Slot): Runner {
  return Object.freeze({
    run(request: WorkerRequest): Promise<WorkerResult> {
      return dispatchWorker(slot, request);
    },
  });
}

function readPreparedBackend(raw: unknown): { readonly ok: true; readonly backend: BackendPort } | { readonly ok: false; readonly reason: string } {
  const fields = readStrictFields(raw, ["ok", "backend", "reason"], ["ok"]);
  if (fields === null) return { ok: false, reason: "trusted prepare returned an unreadable result" };
  if (fields.get("ok") !== true) {
    const reason = fields.get("reason");
    return {
      ok: false,
      reason: boundedReason(reason, "trusted prepare refused the delegation"),
    };
  }
  const backend = fields.get("backend");
  if (!isOpaqueRef(backend)) return { ok: false, reason: "trusted prepare returned no backend object" };
  const create = readCallable(backend, "create");
  const execute = readCallable(backend, "execute");
  const cancel = readCallable(backend, "cancel");
  const get = readCallable(backend, "get");
  if (create === null || execute === null || cancel === null) {
    return { ok: false, reason: "trusted prepare backend is missing create, execute or cancel" };
  }
  return {
    ok: true,
    backend: {
      receiver: backend as NativeHarnessBackend,
      create: create as BackendPort["create"],
      execute: execute as BackendPort["execute"],
      cancel: cancel as BackendPort["cancel"],
      get: get as BackendPort["get"] | null,
    },
  };
}

type PrepareOutcome =
  | { readonly kind: "backend"; readonly backend: BackendPort }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "expired" };

async function invokePrepare(slot: Slot, context: NativeContext | null): Promise<PrepareOutcome> {
  const state = slotState(slot);
  if (state === null) return { kind: "failed", reason: "delegation state is unavailable" };
  if (context === null) return { kind: "failed", reason: "the gated main context is unavailable" };
  const guard = (): void => {
    if (!slot.prepareOpen) {
      throw new NativeHarnessDelegationError("the preparation guard is no longer open");
    }
    slot.guardCalls += 1;
    const problem = authorityGate(slot, "effect");
    if (problem !== null) throw new NativeHarnessDelegationError(problem);
  };
  const request: NativeHarnessPrepareRequest = Object.freeze({
    association: slot.association,
    budget: Object.freeze({
      maxCostUsd: state.limits.perRunUsd,
      deadlineAt: slot.deadlineAt,
      maxDurationMs: state.limits.maxDurationMs,
    }),
    signal: slot.signal,
    runner: makeGuardedRunner(slot),
    guard,
  });
  slot.prepareOpen = true;
  let raw: unknown;
  try {
    // The context came from the immediately preceding fresh gate; no host
    // callback runs between that gate's pure check and this preparation call.
    raw = state.prepare(request, context);
  } catch (error) {
    slot.prepareOpen = false;
    return { kind: "failed", reason: `trusted prepare threw: ${boundedReason(error, "unreadable failure")}` };
  }

  let value: unknown;
  if (consumeNativePromise(raw)) {
    const promise = raw as Promise<unknown>;
    void promise.catch(() => undefined);
    const waited = await awaitWithCleanup(slot, promise);
    // The guard is open only while preparation can still affect delegation.
    // At cancellation/deadline grace expiry a late backend must not create.
    slot.prepareOpen = false;
    if (waited.kind === "expired") return { kind: "expired" };
    if (waited.kind === "error") {
      return {
        kind: "failed",
        reason: `trusted prepare rejected: ${boundedReason(waited.error, "unreadable failure")}`,
      };
    }
    value = waited.value;
  } else {
    slot.prepareOpen = false;
    value = raw;
  }
  if (slot.guardCalls === 0) {
    return { kind: "failed", reason: "trusted prepare did not call the authority guard" };
  }
  const backend = readPreparedBackend(value);
  return backend.ok
    ? { kind: "backend", backend: backend.backend }
    : { kind: "failed", reason: backend.reason };
}

function outcomeFor(
  slot: Slot,
  backendStatus: NativeHarnessBackendStatus | null,
  finalGate: string | null,
): NativeHarnessOutcome {
  if (finalGate !== null) {
    if (slot.cancelReason === "deadline-expired") return "timed-out";
    if (slot.cancelReason === "authority-lost") return "incomplete";
    if (slot.cancelRequested) return "cancelled";
    return "incomplete";
  }
  if (backendStatus === "completed") return "backend-completed";
  if (backendStatus === "failed") return "backend-failed";
  if (backendStatus === "cancelled") return "backend-cancelled";
  if (slot.cancelReason === "deadline-expired") return "timed-out";
  if (slot.cancelRequested) return "cancelled";
  return "incomplete";
}

function cancelReasonForGate(gate: string): SlotCancelReason {
  if (gate.includes("deadline")) return "deadline-expired";
  if (gate.includes("aborted") || gate.includes("cancelled")) return "invocation-aborted";
  if (gate.includes("disposed")) return "disposed";
  return "authority-lost";
}

function terminationFor(
  slot: Slot,
  finalGate: string | null,
  backendStatus: NativeHarnessBackendStatus | null,
): NativeHarnessTermination {
  if (slot.cancelReason === "disposed") return "disposed";
  if (slot.cancelReason === "deadline-expired") return "deadline";
  if (slot.cancelReason === "authority-lost") return "authority-lost";
  if (slot.cancelReason === "invocation-aborted"
    || slot.cancelReason === "cancel-requested"
    || slot.cancelReason === "budget-refused") return "cancelled";
  if (finalGate !== null) return "authority-lost";
  if (backendStatus === "failed") return "backend-failed";
  return "none";
}

function settleLifetime(slot: Slot, knownObserved: boolean, observedUsd: number, noDispatch: boolean): void {
  const state = slotState(slot);
  if (state === null || !slot.reservationActive) return;
  slot.reservationActive = false;
  if (noDispatch) {
    state.lifetimeAccountedUsd = money(Math.max(0, state.lifetimeAccountedUsd - state.limits.perRunUsd));
    return;
  }
  if (knownObserved) {
    // Admission reserved one inclusive whole-run allocation, not a base plus
    // observed subtotal. Replace the reservation with the observed subtotal:
    // the observed amount must not be added on top of the already-inclusive
    // allocation.
    state.lifetimeAccountedUsd = money(state.lifetimeAccountedUsd + observedUsd - state.limits.perRunUsd);
    state.lifetimeObservedUsd = money(state.lifetimeObservedUsd + observedUsd);
    const extra = Math.max(0, observedUsd - state.limits.perRunUsd);
    if (extra > 0) {
      state.lifetimeOverspendUsd = money(state.lifetimeOverspendUsd + extra);
      state.budgetBlocked = true;
    }
    if (state.lifetimeAccountedUsd < 0) state.lifetimeAccountedUsd = 0;
    return;
  }
  const extra = Math.max(0, observedUsd - state.limits.perRunUsd);
  state.lifetimeAccountedUsd = money(state.lifetimeAccountedUsd + extra);
  state.lifetimeObservedUsd = money(state.lifetimeObservedUsd + observedUsd);
  state.lifetimeUnknownUsd = money(state.lifetimeUnknownUsd + state.limits.perRunUsd);
  if (extra > 0) {
    state.lifetimeOverspendUsd = money(state.lifetimeOverspendUsd + extra);
    state.budgetBlocked = true;
  }
}

function finishSlot(
  slot: Slot,
  args: {
    readonly outcome: NativeHarnessOutcome;
    readonly reason: string | null;
    readonly authorityFresh: boolean;
    readonly executionState: NativeHarnessExecutionState;
    readonly termination: NativeHarnessTermination;
    readonly backendStatus: NativeHarnessBackendStatus | null;
    readonly knownObservedCost: boolean;
    readonly noDispatch: boolean;
    readonly releaseConcurrency: boolean;
    readonly finishedAt?: number;
    readonly extraLimitations?: readonly string[];
  },
): void {
  if (slot.state !== "running") return;
  const state = slotState(slot);
  if (state === null) return;
  const finishedAt = args.finishedAt ?? readClock(state.now) ?? slot.admittedAt;
  const elapsedMs = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, finishedAt - slot.admittedAt));
  const observedUsd = args.noDispatch
    ? 0
    : slot.observedAny
      ? money(slot.observedCostUsd)
      : null;
  const unknownUsd = args.knownObservedCost || args.noDispatch ? 0 : state.limits.perRunUsd;
  const overspendUsd = observedUsd !== null ? money(Math.max(0, observedUsd - state.limits.perRunUsd)) : 0;
  const cost: NativeHarnessDelegationCost = Object.freeze({
    allocatedUsd: args.noDispatch ? 0 : state.limits.perRunUsd,
    observedUsd,
    unknownUsd,
    overspendUsd,
  });
  const extra = [...(args.extraLimitations ?? [])];
  if (args.executionState === "pending-unknown") {
    extra.push("Cleanup did not settle within the grace window; concurrency and cost allocation remain retained.");
  }
  if (slot.cancelRequested) {
    extra.push("Cancellation resolution is only a request; process-group exit and OS isolation are not proven.");
  }
  const result: NativeHarnessDelegationResult = deepFreeze({
    schema: NATIVE_HARNESS_DELEGATION_SCHEMA,
    tool: NATIVE_HARNESS_TOOL,
    authority: "non-authoritative" as const,
    resultKind: "live" as const,
    historical: false,
    authorityFresh: args.authorityFresh,
    outcome: args.outcome,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
    association: slot.association,
    runId: slot.runId,
    backendStatus: args.backendStatus,
    executionState: args.executionState,
    termination: args.termination,
    cancellation: slot.cancelState,
    cancelError: slot.cancelError,
    deadlineAt: slot.deadlineAt,
    elapsedMs,
    cost,
    limitations: limitationsFor(extra),
    reason: args.reason === null ? null : boundedReason(args.reason, "delegation incomplete"),
  });

  settleLifetime(slot, args.knownObservedCost, observedUsd ?? 0, args.noDispatch);
  slot.state = "settled";
  slot.response = result;
  slot.finalOutcome = args.outcome;
  slot.finalAuthorityFresh = args.authorityFresh;
  slot.finalExecutionState = args.executionState;
  slot.finalTermination = args.termination;
  slot.finalCost = cost;
  slot.prepareOpen = false;
  if (slot.deadlineTimer !== null) {
    clearTimeout(slot.deadlineTimer);
    slot.deadlineTimer = null;
  }
  if (args.executionState !== "pending-unknown" && slot.cleanupTimer !== null) {
    clearTimeout(slot.cleanupTimer);
    slot.cleanupTimer = null;
  }
  try {
    Reflect.apply(ACTUAL_REMOVE_EVENT_LISTENER as EventTarget["removeEventListener"], slot.invocationSignal, [
      "abort",
      slot.abortListener,
    ]);
  } catch {
    // Host listener removal is best effort.
  }
  if (args.releaseConcurrency && slot.concurrencyHeld) {
    slot.concurrencyHeld = false;
    state.activeOperations = Math.max(0, state.activeOperations - 1);
  }
  slot.resolve(result);
}

function releasedAfterNoExecution(slot: Slot): boolean {
  if (!slot.cancelRequested) return true;
  return slot.cancelSettled && slot.cancelState !== "request-failed";
}

function cancelledWithoutExecutionOutcome(slot: Slot): NativeHarnessOutcome {
  if (slot.cancelReason === "deadline-expired") return "timed-out";
  if (slot.cancelReason === "authority-lost") return "incomplete";
  return "cancelled";
}

function cancelledWithoutExecutionReason(slot: Slot): string {
  if (slot.cancelReason === "authority-lost") {
    return "authority was lost after a run was created; execution was not dispatched and cancellation was requested";
  }
  if (slot.cancelReason === "deadline-expired") {
    return "the original delegation deadline expired after a run was created; execution was not dispatched";
  }
  return "delegation was cancelled after a run was created but before worker execution";
}

async function finishCancelledWithoutExecution(slot: Slot): Promise<void> {
  const state = slotState(slot);
  if (state === null) return;
  if (slot.cancelSettled) {
    finishSlot(slot, {
      outcome: cancelledWithoutExecutionOutcome(slot),
      reason: cancelledWithoutExecutionReason(slot),
      authorityFresh: false,
      executionState: "not-started",
      termination: terminationFor(slot, null, null),
      backendStatus: slot.backendStatus,
      knownObservedCost: false,
      noDispatch: false,
      releaseConcurrency: releasedAfterNoExecution(slot),
    });
    return;
  }
  if (slot.cancelPromise !== null) {
    const waited = await awaitWithCleanup(slot, slot.cancelPromise);
    if (waited.kind === "expired") {
      finishSlot(slot, {
        outcome: cancelledWithoutExecutionOutcome(slot),
        reason: "the cancellation request did not resolve within the cleanup grace window",
        authorityFresh: false,
        executionState: "pending-unknown",
        termination: terminationFor(slot, null, null),
        backendStatus: slot.backendStatus,
        knownObservedCost: false,
        noDispatch: false,
        releaseConcurrency: false,
      });
      return;
    }
    finishSlot(slot, {
      outcome: cancelledWithoutExecutionOutcome(slot),
      reason: slot.cancelError ?? cancelledWithoutExecutionReason(slot),
      authorityFresh: false,
      executionState: "not-started",
      termination: terminationFor(slot, null, null),
      backendStatus: slot.backendStatus,
      knownObservedCost: false,
      noDispatch: false,
      releaseConcurrency: releasedAfterNoExecution(slot),
    });
    return;
  }
  if (slot.cancelState === "request-failed") {
    finishSlot(slot, {
      outcome: cancelledWithoutExecutionOutcome(slot),
      reason: slot.cancelError ?? "the backend cancellation request failed",
      authorityFresh: false,
      executionState: "not-started",
      termination: terminationFor(slot, null, null),
      backendStatus: slot.backendStatus,
      knownObservedCost: false,
      noDispatch: false,
      releaseConcurrency: false,
    });
    return;
  }
  // No runId or backend, so there is no cancellation target and no worker.
  finishSlot(slot, {
    outcome: cancelledWithoutExecutionOutcome(slot),
    reason: "delegation was cancelled before backend run creation",
    authorityFresh: false,
    executionState: "not-started",
    termination: terminationFor(slot, null, null),
    backendStatus: null,
    knownObservedCost: false,
    noDispatch: true,
    releaseConcurrency: true,
  });
}

async function awaitExecution(
  slot: Slot,
  execution: Promise<unknown>,
): Promise<
  | { readonly kind: "expired" }
  | { readonly kind: "settled"; readonly execution: WaitOutcome<unknown> }
> {
  const first = await awaitWithCleanup(slot, execution);
  // Once the underlying execution promise settles (or its wait expires), the
  // port has no legitimate reason to dispatch another worker. Closing
  // admission makes the set below monotonically shrink.
  slot.dispatchClosed = true;
  if (first.kind === "expired") {
    if (!slot.cancelRequested) beginCancellation(slot, "deadline-expired");
    return { kind: "expired" };
  }
  // Runner.run resolves after its cleanup, but a port may return execute before
  // a worker promise settles. Do not publish success until the set is actually
  // empty; admission is closed above, and every wait is still bounded by the
  // original deadline plus cleanup grace. Exhaustion can only mean the grace
  // window expired, which runSlot reports as pending-unknown with capacity and
  // allocation retained.
  while (slot.workerPromises.size > 0) {
    const workers = [...slot.workerPromises];
    const waited = await awaitWithCleanup(slot, Promise.allSettled(workers).then(() => undefined));
    if (waited.kind === "expired") {
      if (!slot.cancelRequested) beginCancellation(slot, "deadline-expired");
      return { kind: "expired" };
    }
  }
  return { kind: "settled", execution: first };
}

async function runSlot(slot: Slot): Promise<void> {
  const state = slotState(slot);
  if (state === null) return;
  try {
    let prepareContext: NativeContext | null = null;
    const beforePrepare = authorityGate(slot, "effect", (context) => {
      prepareContext = context;
    });
    if (beforePrepare !== null) {
      finishSlot(slot, {
        outcome: "refused",
        reason: beforePrepare,
        authorityFresh: false,
        executionState: "not-started",
        termination: terminationFor(slot, beforePrepare, null),
        backendStatus: null,
        knownObservedCost: false,
        noDispatch: true,
        releaseConcurrency: true,
      });
      return;
    }

    const prepared = await invokePrepare(slot, prepareContext);
    if (prepared.kind === "expired") {
      finishSlot(slot, {
        outcome: "unknown",
        reason: "trusted preparation did not settle within the cleanup grace window; no run was created",
        authorityFresh: false,
        executionState: "pending-unknown",
        termination: terminationFor(slot, null, null),
        backendStatus: null,
        knownObservedCost: false,
        noDispatch: false,
        releaseConcurrency: false,
      });
      return;
    }
    if (prepared.kind === "failed") {
      finishSlot(slot, {
        outcome: "refused",
        reason: prepared.reason,
        authorityFresh: false,
        executionState: "not-started",
        termination: terminationFor(slot, prepared.reason, null),
        backendStatus: null,
        knownObservedCost: false,
        noDispatch: true,
        releaseConcurrency: true,
      });
      return;
    }
    slot.backend = prepared.backend;

    if (slot.cancelRequested) {
      await finishCancelledWithoutExecution(slot);
      return;
    }
    const afterPrepare = authorityGate(slot, "effect");
    if (afterPrepare !== null) {
      finishSlot(slot, {
        outcome: "refused",
        reason: afterPrepare,
        authorityFresh: false,
        executionState: "not-started",
        termination: terminationFor(slot, afterPrepare, null),
        backendStatus: null,
        knownObservedCost: false,
        noDispatch: true,
        releaseConcurrency: true,
      });
      return;
    }

    slot.backendEffectStarted = true;
    slot.createStarted = true;
    const createPromise = callBackendCreate(slot, prepared.backend);
    void createPromise.catch(() => undefined);
    const created = await awaitWithCleanup(slot, createPromise);
    if (created.kind === "expired") {
      // A late create still yields an actual runId and a cancel request, but it
      // must never upgrade this already-returned unknown result or dispatch.
      void createPromise.then(
        (value) => {
          const runId = readBackendRunId(value);
          if (runId === null) return;
          if (slot.runId === null) slot.runId = runId;
          if (slot.cancelRequested) requestBackendCancel(slot);
        },
        () => undefined,
      );
      finishSlot(slot, {
        outcome: "unknown",
        reason: "backend run creation did not settle within the cleanup grace window",
        authorityFresh: false,
        executionState: "pending-unknown",
        termination: terminationFor(slot, null, null),
        backendStatus: null,
        knownObservedCost: false,
        noDispatch: false,
        releaseConcurrency: false,
      });
      return;
    }
    if (created.kind === "error") {
      slot.createSettled = true;
      finishSlot(slot, {
        outcome: slot.cancelReason === "deadline-expired" ? "timed-out" : slot.cancelRequested ? "cancelled" : "unknown",
        reason: `backend run creation failed: ${boundedReason(created.error, "unreadable failure")}`,
        authorityFresh: false,
        executionState: "not-started",
        termination: terminationFor(slot, null, null),
        backendStatus: null,
        knownObservedCost: false,
        noDispatch: false,
        releaseConcurrency: true,
      });
      return;
    }
    slot.createSettled = true;
    const runId = readBackendRunId(created.value);
    if (runId === null) {
      finishSlot(slot, {
        outcome: slot.cancelRequested ? "cancelled" : "unknown",
        reason: "backend run creation returned no valid bounded runId",
        authorityFresh: false,
        executionState: "not-started",
        termination: terminationFor(slot, null, null),
        backendStatus: null,
        knownObservedCost: false,
        noDispatch: false,
        releaseConcurrency: false,
      });
      return;
    }
    slot.runId = runId;

    if (slot.cancelRequested) {
      requestBackendCancel(slot);
      await finishCancelledWithoutExecution(slot);
      return;
    }

    const beforeExecute = authorityGate(slot, "effect");
    if (beforeExecute !== null) {
      beginCancellation(slot, cancelReasonForGate(beforeExecute));
      requestBackendCancel(slot);
      await finishCancelledWithoutExecution(slot);
      return;
    }
    if (slot.cancelRequested) {
      requestBackendCancel(slot);
      await finishCancelledWithoutExecution(slot);
      return;
    }

    slot.executionStarted = true;
    const execution = callBackendExecute(slot, prepared.backend, runId);
    void execution.catch(() => undefined);
    const waited = await awaitExecution(slot, execution);
    if (waited.kind === "expired") {
      void execution.then(
        () => {
          slot.lateSettlementObserved = true;
        },
        () => {
          slot.lateSettlementObserved = true;
        },
      );
      finishSlot(slot, {
        outcome: "unknown",
        reason: "backend execution or worker cleanup did not settle within the cleanup grace window",
        authorityFresh: false,
        executionState: "pending-unknown",
        termination: terminationFor(slot, null, null),
        backendStatus: null,
        knownObservedCost: false,
        noDispatch: false,
        releaseConcurrency: false,
      });
      return;
    }

    let executionError: string | null = null;
    if (waited.execution.kind === "error") {
      executionError = boundedReason(waited.execution.error, "backend execution failed");
    } else if (waited.execution.kind === "value") {
      slot.backendStatus = readBackendStatus(waited.execution.value);
    } else {
      executionError = "backend execution ended in an unreadable state";
    }
    slot.executionSettled = true;
    slot.executionError = executionError;

    // All callback facts, including the finish clock, are read before the
    // final fresh/pure gate. Nothing invokes a host callback between that gate
    // and result publication.
    const finishedAt = readClock(state.now) ?? slot.admittedAt;
    const finalGate = authorityGate(slot, "effect");
    const backendStatus = slot.backendStatus;
    const authorityFresh = finalGate === null;
    // Native freshness is an authority fact, not a usage fact. Execution and
    // every accepted worker have settled here; when the backend completed with
    // fully known worker usage and no cancellation, the observed subtotal is
    // known even if the final native gate rejects (for example navigation).
    const knownObservedCost = backendStatus === "completed"
      && slot.workerCount > 0
      && slot.workerAllKnownCompleted
      && !slot.workerUnknownUsage
      && !slot.cancelRequested
      && slot.executionSettled
      && slot.workerPromises.size === 0;
    const outcome = outcomeFor(slot, backendStatus, finalGate);
    const termination = terminationFor(slot, finalGate, backendStatus);
    finishSlot(slot, {
      outcome,
      reason: finalGate ?? executionError ?? (backendStatus === "completed"
        ? "the Harness2 backend reported completion; task acceptance was not evaluated"
        : `backend status ${backendStatus ?? "unknown"}`),
      authorityFresh,
      executionState: "settled",
      termination,
      backendStatus,
      knownObservedCost,
      noDispatch: false,
      releaseConcurrency: true,
      finishedAt,
    });
  } catch (error) {
    finishSlot(slot, {
      outcome: "unknown",
      reason: `delegation failed unexpectedly: ${boundedReason(error, "unreadable failure")}`,
      authorityFresh: false,
      executionState: "pending-unknown",
      termination: terminationFor(slot, null, null),
      backendStatus: null,
      knownObservedCost: false,
      noDispatch: !slot.backendEffectStarted,
      releaseConcurrency: false,
    });
  }
}

function createSlot(
  state: CoordinatorState,
  toolCallId: string,
  originalRef: NativeWorkCallReference,
  association: NativeHarnessAssociation,
  task: string,
  invocationSignal: AbortSignal,
  admittedAt: number,
): Slot {
  const abortController = new AbortController();
  const pending = deferred<NativeHarnessDelegationResult>();
  const cleanupExpired = deferred<void>();
  const deadlineAt = admittedAt + state.limits.maxDurationMs;
  const slot: Slot = {
    toolCallId,
    originalRef,
    association,
    task,
    invocationSignal,
    signal: abortController.signal,
    admittedAt,
    deadlineAt,
    abortController,
    cleanupExpired,
    promise: pending.promise,
    resolve: pending.resolve,
    abortListener: () => undefined,
    deadlineTimer: null,
    cleanupTimer: null,
    state: "running",
    concurrencyHeld: true,
    reservationActive: true,
    cancelRequested: false,
    cancelReason: null,
    cancelState: "none",
    cancelError: null,
    cancelSettled: false,
    cancelPromise: null,
    backend: null,
    prepareOpen: false,
    guardCalls: 0,
    backendEffectStarted: false,
    createStarted: false,
    createSettled: false,
    executionStarted: false,
    executionSettled: false,
    dispatchClosed: false,
    runId: null,
    backendStatus: null,
    executionError: null,
    workerPromises: new Set(),
    workerDispatches: 0,
    workerCount: 0,
    workerAllKnownCompleted: true,
    workerUnknownUsage: false,
    observedCostUsd: 0,
    observedAny: false,
    runnerAccountedUsd: 0,
    runnerInflightUsd: 0,
    overspendUsd: 0,
    lateSettlementObserved: false,
    response: null,
    finalOutcome: null,
    finalAuthorityFresh: null,
    finalExecutionState: "not-started",
    finalTermination: "none",
    finalCost: null,
    output: {
      registration: null,
      registrationFailure: null,
      registering: false,
      state: "idle",
      promise: null,
      requestSignal: null,
      controller: null,
      cleanup: null,
      capture: null,
      selection: null,
      failure: null,
      guardFailure: null,
      observedSha256: null,
      observedBytes: null,
      reservedBytes: 0,
      retainedBytes: 0,
      startedAt: null,
      lastClock: null,
      checks: null,
    },
  };
  // The listener is assigned after the slot exists so it can identify itself.
  const listener = () => beginCancellation(slot, "invocation-aborted");
  (slot as { abortListener: () => void }).abortListener = listener;
  try {
    if (ACTUAL_ADD_EVENT_LISTENER === null) throw new Error("abort listener unavailable");
    Reflect.apply(ACTUAL_ADD_EVENT_LISTENER, invocationSignal, ["abort", listener, { once: true }]);
  } catch {
    // A missing listener is caught by the sealed signal and deadline checks.
  }
  slot.deadlineTimer = setTimeout(() => {
    beginCancellation(slot, "deadline-expired");
  }, state.limits.maxDurationMs);
  slotStates.set(slot, state);
  return slot;
}

function currentCost(slot: Slot, state: CoordinatorState): NativeHarnessDelegationCost {
  if (slot.finalCost !== null) return slot.finalCost;
  const observedUsd = slot.observedAny ? money(slot.observedCostUsd) : null;
  return Object.freeze({
    allocatedUsd: state.limits.perRunUsd,
    observedUsd,
    unknownUsd: state.limits.perRunUsd,
    overspendUsd: observedUsd === null ? 0 : money(Math.max(0, observedUsd - state.limits.perRunUsd)),
  });
}

function buildSnapshot(state: CoordinatorState): NativeHarnessDelegationSnapshot {
  const now = readClock(state.now) ?? 0;
  const operations: NativeHarnessSnapshotOperation[] = [];
  for (const slot of state.slots.values()) {
    const out = slot.output;
    const outputFailure = out.failure ?? out.guardFailure;
    operations.push(Object.freeze({
      association: slot.association,
      runId: slot.runId,
      state: slot.state,
      outcome: slot.state === "settled" ? slot.finalOutcome : null,
      authorityFresh: slot.state === "settled" ? slot.finalAuthorityFresh : null,
      executionState: slot.state === "settled" ? slot.finalExecutionState : "pending-unknown",
      termination: slot.state === "settled" ? slot.finalTermination : (slot.cancelRequested ? "cancelled" : "none"),
      cancellation: slot.cancelState,
      deadlineAt: slot.deadlineAt,
      elapsedMs: Math.max(0, now - slot.admittedAt),
      cost: currentCost(slot, state),
      concurrencyHeld: slot.concurrencyHeld,
      historical: slot.state === "settled",
      output: Object.freeze({
        state: out.state,
        registered: out.registration !== null,
        registrationFailure: out.registrationFailure === null
          ? null
          : boundedOutputReason(out.registrationFailure),
        captureId: out.capture === null ? null : out.capture.captureId,
        captureDigest: out.capture === null ? null : out.capture.digest,
        taskSha256: out.registration?.taskSha256 ?? null,
        workPromptSha256: out.registration?.workPromptSha256 ?? null,
        callInputSha256: out.registration?.callInputSha256 ?? null,
        expectedResultSha256: out.registration?.expectedSha256 ?? null,
        observedResultSha256: out.observedSha256,
        retainedBytes: out.retainedBytes,
        code: outputFailure?.code ?? null,
        reason: outputFailure === null ? null : boundedOutputReason(outputFailure.reason),
        checks: nativeHarnessCheckView(out.checks),
      }),
    }));
  }
  return deepFreeze({
    schema: NATIVE_HARNESS_DELEGATION_SNAPSHOT_SCHEMA,
    enabled: state.enabled,
    disposed: state.disposed,
    limits: state.limits,
    retainedOperations: state.slots.size,
    activeOperations: state.activeOperations,
    output: {
      retainedCaptures: state.outputRetained,
      retainedBytes: state.outputBytes,
      reservedBytes: state.outputReservedBytes,
      active: state.outputActive !== null,
      maxCaptures: NATIVE_HARNESS_MAX_OUTPUT_CAPTURES,
      maxBytes: NATIVE_HARNESS_MAX_OUTPUT_BYTES,
      reservationBytes: NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES,
    },
    lifetime: {
      limitUsd: state.limits.lifetimeUsd,
      accountedUsd: state.lifetimeAccountedUsd,
      observedUsd: state.lifetimeObservedUsd,
      unknownUsd: state.lifetimeUnknownUsd,
      overspendUsd: state.lifetimeOverspendUsd,
      budgetBlocked: state.budgetBlocked,
    },
    operations,
  });
}

function handleExisting(
  state: CoordinatorState,
  slot: Slot,
  toolCallId: string,
  task: string,
  signal: AbortSignal,
): Promise<NativeHarnessDelegationResult> {
  if (task !== slot.task) {
    return Promise.resolve(refusedResult(
      "the same actual agent_harness call was reused with a different task",
      slot.association,
    ));
  }
  if (signal !== slot.invocationSignal) {
    return Promise.resolve(refusedResult(
      "the same actual agent_harness call was reused with a different invocation signal",
      slot.association,
    ));
  }
  const main = readMainContext(state);
  if (!main.ok) return Promise.resolve(refusedResult(main.reason, slot.association));
  const capture = readNativeCapture(state.native, toolCallId, main.context);
  if (!capture.ok) return Promise.resolve(refusedResult(capture.reason, slot.association));
  if (!sameAssociation(capture.association, slot.association)) {
    return Promise.resolve(refusedResult(
      "the same actual agent_harness call id now has an incompatible native association",
      slot.association,
    ));
  }
  const gate = authorityGate(slot, "replay");
  if (gate !== null) return Promise.resolve(refusedResult(gate, slot.association));
  if (slot.state === "running") return slot.promise;
  if (slot.response === null) {
    return Promise.resolve(refusedResult(
      "the retained delegation operation has no settled result",
      slot.association,
    ));
  }
  return Promise.resolve(historicalResult(slot.response));
}

function admitNew(
  state: CoordinatorState,
  toolCallId: string,
  task: string,
  signal: AbortSignal,
  capture: Extract<NativeCaptureResult, { ok: true }>,
  admittedAt: number,
): Promise<NativeHarnessDelegationResult> {
  state.lifetimeAccountedUsd += state.limits.perRunUsd;
  state.activeOperations += 1;
  const slot = createSlot(
    state,
    toolCallId,
    capture.ref,
    capture.association,
    task,
    signal,
    admittedAt,
  );
  state.slots.set(toolCallId, slot);
  void runSlot(slot);
  return slot.promise;
}

function canAdmit(state: CoordinatorState): string | null {
  if (state.disposed) return "the delegation coordinator was disposed";
  if (!state.enabled) return "the delegation coordinator is disabled";
  if (state.slots.size >= state.limits.maxRetainedOperations) {
    return "the bounded delegation retention is exhausted; no tombstone was evicted";
  }
  if (state.activeOperations >= state.limits.maxConcurrent) {
    return "the bounded delegation concurrency is already reserved";
  }
  if (state.budgetBlocked) return "a prior observed cost overspend stopped further delegation dispatch";
  if (state.lifetimeAccountedUsd + state.limits.perRunUsd > state.limits.lifetimeUsd + USD_EPSILON) {
    return "the lifetime delegation budget is exhausted or reserved";
  }
  return null;
}

export function createNativeHarnessDelegation(
  options: NativeHarnessDelegationOptions,
): NativeHarnessDelegationCoordinator {
  const fields = readStrictFields(
    options,
    ["native", "policy", "getContext", "prepare", "runner", "now", "enabled", "output"],
    ["native", "getContext", "prepare", "runner"],
    "output",
  );
  if (fields === null) {
    throw new NativeHarnessDelegationError(
      "Delegation options must be a plain own-data object with native, getContext, prepare and runner.",
    );
  }
  const nativeValue = fields.get("native");
  if (!isOpaqueRef(nativeValue)) {
    throw new NativeHarnessDelegationError("Delegation native controls must be an opaque object.");
  }
  const captureCall = readCallable(nativeValue, "captureCall");
  const prepareCallCheck = readCallable(nativeValue, "prepareCallCheck");
  if (captureCall === null || prepareCallCheck === null) {
    throw new NativeHarnessDelegationError("Delegation native controls are missing captureCall or prepareCallCheck.");
  }
  const registerCallResultExpectation = readCallable(nativeValue, "registerCallResultExpectation");
  const getContext = fields.get("getContext");
  const prepare = fields.get("prepare");
  const runnerValue = fields.get("runner");
  if (typeof getContext !== "function" || typeof prepare !== "function") {
    throw new NativeHarnessDelegationError("Delegation getContext and prepare must be functions.");
  }
  if (!isOpaqueRef(runnerValue)) {
    throw new NativeHarnessDelegationError("Delegation runner must be an object with a run method.");
  }
  const runnerRun = readCallable(runnerValue, "run");
  if (runnerRun === null) throw new NativeHarnessDelegationError("Delegation runner is missing run.");
  const nowValue = fields.get("now");
  if (nowValue !== undefined && typeof nowValue !== "function") {
    throw new NativeHarnessDelegationError("Delegation now must be a function when present.");
  }
  const enabledValue = fields.get("enabled");
  if (enabledValue !== undefined && typeof enabledValue !== "boolean") {
    throw new NativeHarnessDelegationError("Delegation enabled must be a boolean when present.");
  }
  const limits = normalizePolicy(fields.get("policy"));
  const state: CoordinatorState = {
    native: {
      receiver: nativeValue as NativeEntryControls,
      captureCall: captureCall as NativeCallPort["captureCall"],
      prepareCallCheck: prepareCallCheck as NativeCallPort["prepareCallCheck"],
      registerCallResultExpectation: registerCallResultExpectation as NativeCallPort["registerCallResultExpectation"],
    },
    output: readOutputPort(fields.get("output")),
    limits,
    getContext: getContext as () => NativeContext,
    prepare: prepare as CoordinatorState["prepare"],
    runner: {
      receiver: runnerValue as Runner,
      run: runnerRun as RunnerPort["run"],
    },
    now: (nowValue as (() => number) | undefined) ?? Date.now,
    enabled: enabledValue === true,
    disposed: false,
    slots: new Map(),
    admissionInProgress: false,
    revalidationInProgress: false,
    activeOperations: 0,
    lifetimeAccountedUsd: 0,
    lifetimeObservedUsd: 0,
    lifetimeUnknownUsd: 0,
    lifetimeOverspendUsd: 0,
    budgetBlocked: false,
    outputRetained: 0,
    outputBytes: 0,
    outputReservedBytes: 0,
    outputActive: null,
    outputJoinValidating: false,
  };

  const coordinator: NativeHarnessDelegationCoordinator = Object.freeze({
    get enabled(): boolean {
      return state.enabled;
    },
    get disposed(): boolean {
      return state.disposed;
    },
    invoke(actualToolCallId: unknown, input: unknown, signal: unknown): Promise<NativeHarnessDelegationResult> {
      if (state.disposed) {
        return Promise.resolve(refusedResult("the delegation coordinator was disposed"));
      }
      if (!state.enabled) {
        return Promise.resolve(refusedResult("the delegation coordinator is disabled"));
      }
      const toolCallId = boundedString(actualToolCallId, MAX_TOOL_CALL_ID_CHARS);
      if (toolCallId === null) {
        return Promise.resolve(refusedResult("the actual agent_harness tool call id is unavailable"));
      }
      const parsedTask = parseTaskInput(input);
      if (!parsedTask.ok) return Promise.resolve(refusedResult(parsedTask.reason));
      const signalRead = readActualAbortSignal(signal);
      if (!signalRead.ok) return Promise.resolve(refusedResult(signalRead.reason));
      if (signalRead.aborted) {
        return Promise.resolve(refusedResult("the delegation invocation was cancelled before admission"));
      }
      const invocationSignal = signal as AbortSignal;

      const existing = state.slots.get(toolCallId);
      if (existing !== undefined) {
        if (state.revalidationInProgress) {
          return Promise.resolve(refusedResult(
            "reentrant delegation revalidation was refused before recursion",
            existing.association,
          ));
        }
        state.revalidationInProgress = true;
        try {
          return handleExisting(state, existing, toolCallId, parsedTask.task, invocationSignal);
        } finally {
          state.revalidationInProgress = false;
        }
      }
      if (state.admissionInProgress) {
        return Promise.resolve(refusedResult(
          "reentrant delegation admission was refused before any new run was reserved",
        ));
      }

      const preAdmission = canAdmit(state);
      if (preAdmission !== null) return Promise.resolve(refusedResult(preAdmission));
      const admittedAt = readClock(state.now);
      if (admittedAt === null) {
        return Promise.resolve(refusedResult("the delegation clock is unavailable"));
      }
      state.admissionInProgress = true;
      try {
        const main = readMainContext(state);
        if (!main.ok) return Promise.resolve(refusedResult(main.reason));
        const capture = readNativeCapture(state.native, toolCallId, main.context);
        if (!capture.ok) return Promise.resolve(refusedResult(capture.reason));

        // Capture and getContext callbacks are trusted but can still reenter;
        // a reentrant admission is refused by the lock above, and all facts are
        // re-read synchronously before reservation.
        const after = canAdmit(state);
        if (after !== null) return Promise.resolve(refusedResult(after, capture.association));
        const afterSignal = readActualAbortSignal(invocationSignal);
        if (!afterSignal.ok) return Promise.resolve(refusedResult(afterSignal.reason, capture.association));
        if (afterSignal.aborted) {
          return Promise.resolve(refusedResult("the delegation invocation was cancelled before reservation", capture.association));
        }
        const raced = state.slots.get(toolCallId);
        if (raced !== undefined) {
          return handleExisting(state, raced, toolCallId, parsedTask.task, invocationSignal);
        }
        return admitNew(state, toolCallId, parsedTask.task, invocationSignal, capture, admittedAt);
      } finally {
        state.admissionInProgress = false;
      }
    },
    registerToolResultProjection(
      actualSourceToolCallId: unknown,
      actualDelegationResponse: unknown,
      actualProjectedResult: unknown,
      originalSignal: unknown,
    ): { readonly ok: boolean; readonly reason: string | null } {
      return registerToolResultProjectionInternal(
        state,
        actualSourceToolCallId,
        actualDelegationResponse,
        actualProjectedResult,
        originalSignal,
      );
    },
    captureOutput(
      actualSourceToolCallId: unknown,
      captureSignal: unknown,
    ): Promise<NativeHarnessOutputSelection> {
      return captureOutputInternal(state, actualSourceToolCallId, captureSignal);
    },
    checkOutput(
      actualCheckToolCallId: unknown,
      input: unknown,
      actualSignal: unknown,
    ): NativeHarnessCheckOutcome {
      return checkOutputInternal(state, actualCheckToolCallId, input, actualSignal);
    },
    registerOutputCheckProjection(
      actualSourceToolCallId: unknown,
      actualCheckToolCallId: unknown,
      exactCheckResponse: unknown,
      actualProjectedResult: unknown,
      originalCheckSignal: unknown,
    ): { readonly ok: boolean; readonly reason: string | null } {
      return registerOutputCheckProjectionInternal(
        state,
        actualSourceToolCallId,
        actualCheckToolCallId,
        exactCheckResponse,
        actualProjectedResult,
        originalCheckSignal,
      );
    },
    cancel(actualToolCallId: unknown): boolean {
      const toolCallId = boundedString(actualToolCallId, MAX_TOOL_CALL_ID_CHARS);
      if (toolCallId === null) return false;
      const slot = state.slots.get(toolCallId);
      if (slot === undefined) return false;
      let cancelled = false;
      if (slot.state === "running" && !slot.cancelRequested) {
        beginCancellation(slot, "cancel-requested");
        cancelled = true;
      }
      // A settled source may still have an independent capture in flight.
      // This aborts only that capture and never calls backend.cancel.
      if (cancelOutputCapture(slot, "the output capture was cancelled")) cancelled = true;
      return cancelled;
    },
    dispose(): void {
      if (state.disposed) return;
      state.disposed = true;
      for (const slot of state.slots.values()) {
        if (slot.state === "running") beginCancellation(slot, "disposed");
        cancelOutputCapture(slot, "the output capture was disposed");
      }
    },
    inspect(): NativeHarnessDelegationSnapshot {
      return buildSnapshot(state);
    },
  });
  return coordinator;
}
