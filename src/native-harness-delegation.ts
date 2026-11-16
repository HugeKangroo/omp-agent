import { createHash, randomUUID } from "node:crypto";
import { readActualAbortSignal } from "./native-abort.ts";
import {
  NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
  openNativeHarnessAccountingOwner,
  projectNativeHarnessAccounting,
  type NativeHarnessAccountingCheckpoint,
  type NativeHarnessAccountingHandle,
  type NativeHarnessAccountingIdentity,
  type NativeHarnessAccountingPrepared,
  type NativeHarnessAccountingProjection,
  type NativeHarnessAccountingSettlementMode,
} from "./native-harness-accounting.ts";
import type {
  CallResultExpectationRegistration,
  NativeCallCheckPreparation,
  NativeContext,
  NativeEntryControls,
  NativeWorkCallReference,
  NativeWorkCallInspection,
  ReportOutcome,
} from "./native-entry.ts";
import {
  compareNativeHarnessOutputVersion,
  type NativeHarnessOutputCapture,
  type NativeHarnessOutputCaptureResult,
  type NativeHarnessOutputRecord,
} from "./native-harness-output.ts";
import {
  NATIVE_WORK_TOOL,
  deepFreeze,
  isNativeWorkspaceTextSnapshot,
  type NativeWorkspaceTextSnapshot,
} from "./native-work.ts";
import {
  NATIVE_HARNESS_REPORT_MAX_REREAD_ATTEMPTS,
  NATIVE_HARNESS_REPORT_MAX_SELECTED_CHECKS,
  createNativeHarnessReportFailure,
  createNativeHarnessReportFacts,
  createNativeHarnessReportRereadFailure,
  createNativeHarnessReportRereadSuccess,
  normalizeNativeHarnessReportRequest,
  type NativeHarnessReportBindingFailure,
  type NativeHarnessReportBindingFacts,
  type NativeHarnessReportBindingPreparation,
  type NativeHarnessReportBindingResult,
  type NativeHarnessReportFailureCode,
  type NativeHarnessReportFileFacts,
  type NativeHarnessReportNormalizedRequest,
  type NativeHarnessReportRereadFailure,
  type NativeHarnessReportRereadFailureCode,
  type NativeHarnessReportRereadResult,
  type NativeHarnessReportSelection,
} from "./native-harness-report.ts";
import {
  NATIVE_HARNESS_MAX_CHECK_ACTIONS,
  NATIVE_HARNESS_MAX_CHECK_CONDITIONS,
  NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES,
  NATIVE_HARNESS_MAX_CHECK_PATHS,
  NATIVE_HARNESS_MAX_CHECK_PATH_CHARS,
  NATIVE_HARNESS_CHECK_PLAN_SOURCE,
  NATIVE_HARNESS_RESULT_TOOL,
  createNativeHarnessCheckActionRecord,
  createNativeHarnessCheckFailure,
  createNativeHarnessCheckPathRecord,
  createNativeHarnessCheckResponse,
  createNativeHarnessCheckState,
  createNativeHarnessCheckTerminalActionRecord,
  nativeHarnessCheckView,
  normalizeNativeHarnessCaptureInput,
  normalizeNativeHarnessCheckInput,
  normalizeNativeHarnessInspectInput,
  normalizeNativeHarnessReadInput,
  sameNativeHarnessCheckPlan,
  type NativeHarnessActionRecord,
  type NativeHarnessCaptureActionRecord,
  type NativeHarnessCaptureInput,
  type NativeHarnessCheckActionRecord,
  type NativeHarnessCheckFailure,
  type NativeHarnessCheckFailureCode,
  type NativeHarnessCheckInput,
  type NativeHarnessCheckOutcome,
  type NativeHarnessCheckPathRecord,
  type NativeHarnessCheckRetainedActionRecord,
  type NativeHarnessCheckState,
} from "./native-harness-checks.ts";
import { fingerprintNativeJson } from "./native-instance-result.ts";
import { fingerprintExpectedCallResult } from "./native-result-expectation.ts";
import {
  NATIVE_TEXT_CHECKER_ID,
  NATIVE_TEXT_CHECKER_VERSION,
  matchesNativeTextCheckReceipt,
  runNativeTextChecks,
} from "./native-snapshot-checker.ts";
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

/**
 * Trusted host-only durable accounting seam. The future original-root
 * association wrapper returns only the confirmed identity; it never returns a
 * handle, checkpoint, budget balance or execution permission. This coordinator
 * opens the existing owner itself after the callback returns.
 */
export interface NativeHarnessDelegationAccountingPort {
  /** Trusted canonical absolute, host-selected storage root. */
  readonly storageRoot: string;
  associate(
    context: NativeContext,
    signal: AbortSignal,
    deadlineAt: number,
    normalizedLimitsText: string,
  ): Promise<NativeHarnessAccountingIdentity>;
}

/** Owned durable facts handed to trusted preparation after a real reserve. */
export interface NativeHarnessPrepareAccounting {
  readonly ownerId: string;
  readonly admissionId: string;
  readonly reserveRevision: number;
  readonly sourceAssociationSha256: string;
  readonly admittedAt: number;
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
  /**
   * Present only after this coordinator confirmed a real durable reserve and
   * fresh authority. Omitted entirely by legacy coordinators.
   */
  readonly accounting?: NativeHarnessPrepareAccounting;
}

export type NativeHarnessPrepareResult =
  | {
      readonly ok: true;
      readonly backend: NativeHarnessBackend;
      /** Required for a durable preparation; exact A2a1 prepared facts. */
      readonly accountingPrepared?: NativeHarnessAccountingPrepared;
    }
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

/**
 * One host-only historical read result. `snapshot` is the authentic original
 * snapshot object retained by the capture; no text is copied or reread.
 */
export interface NativeHarnessReadSuccess {
  readonly ok: true;
  readonly action: "read";
  readonly readToolCallId: string;
  readonly sourceToolCallId: string;
  readonly captureId: string;
  readonly captureDigest: string;
  readonly path: string;
  readonly snapshot: NativeWorkspaceTextSnapshot;
  readonly observation: "cached-historical";
  readonly filesystemFreshness: "not-rechecked";
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
}

export type NativeHarnessReadSelection =
  | NativeHarnessReadSuccess
  | NativeHarnessOutputSelectionFailure;

/** One captured change as a selector fact; no text, backend path or native ref. */
export interface NativeHarnessCatalogFile {
  readonly path: string;
  readonly kind: "add" | "modify";
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
}

export interface NativeHarnessCatalogCapture {
  readonly captureId: string;
  readonly captureDigest: string;
  readonly files: readonly NativeHarnessCatalogFile[];
}

export interface NativeHarnessCatalogRow {
  readonly sourceToolCallId: string;
  readonly outputState: "idle" | "captured";
  readonly capture: NativeHarnessCatalogCapture | null;
}

/**
 * Bounded selector catalog over this coordinator's retained source Slots.
 * `scanComplete` covers the initial retained inventory only; it is not a claim
 * about persisted runs, other roots or historical task coverage.
 */
export interface NativeHarnessOutputCatalogSuccess {
  readonly ok: true;
  readonly action: "inspect";
  readonly scope: "retained-sources-in-this-root";
  readonly scanComplete: true;
  readonly retainedSources: number;
  readonly returnedSources: number;
  readonly excludedNotReady: number;
  readonly excludedUnavailable: number;
  readonly rows: readonly NativeHarnessCatalogRow[];
}

export type NativeHarnessOutputCatalog =
  | NativeHarnessOutputCatalogSuccess
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

export interface NativeHarnessSnapshotAccounting {
  /**
   * `unloaded`/`pending`/`unavailable` explicitly deny that the lifetime
   * fields below are current persistent totals. `observed` mirrors the last
   * real checkpoint projection, not a locally added balance.
   */
  readonly observation: "unloaded" | "pending" | "observed" | "unavailable";
  readonly revision: number | null;
  readonly lastCheckpoint: NativeHarnessAccountingProjection | null;
  readonly reason: string | null;
}

export interface NativeHarnessDelegationSnapshot {
  readonly schema: typeof NATIVE_HARNESS_DELEGATION_SNAPSHOT_SCHEMA;
  readonly enabled: boolean;
  readonly disposed: boolean;
  readonly limits: NativeHarnessDelegationLimits;
  readonly retainedOperations: number;
  readonly activeOperations: number;
  readonly accounting?: NativeHarnessSnapshotAccounting;
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
  /**
   * Optional trusted host-only durable accounting leaf. Absent keeps the
   * legacy in-memory accounting path exactly. Present opens the existing
   * original-root owner; it never creates or mints one.
   */
  readonly accounting?: NativeHarnessDelegationAccountingPort;
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
   * Host-only capture action for one already settled source Slot. The input is
   * exactly `{ action: "capture", sourceToolCallId }`; the actual action tool
   * call and signal are host-supplied. Reuses the existing capture pipeline.
   */
  captureOutputForCall(
    actualActionToolCallId: unknown,
    input: unknown,
    actualSignal: unknown,
  ): Promise<NativeHarnessOutputSelection>;
  /**
   * Host-only synchronous historical read of one already captured change. The
   * input is exactly `{ action: "read", sourceToolCallId, captureId,
   * captureDigest, path }`; the actual read tool call and signal are
   * host-supplied. Returns the authentic original snapshot object without any
   * new capture, filesystem read or text copy.
   */
  readOutputForCall(
    actualReadToolCallId: unknown,
    input: unknown,
    actualSignal: unknown,
  ): NativeHarnessReadSelection;
  /**
   * Host-only synchronous catalog of this coordinator's retained source Slots.
   * The input is exactly `{ action: "inspect" }`; the actual inspect call and
   * signal are host-supplied. Row facts are copied selector metadata only.
   */
  inspectOutputsForCall(
    actualInspectToolCallId: unknown,
    input: unknown,
    actualSignal: unknown,
  ): NativeHarnessOutputCatalog;
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
   * Host-only read-only preparation of one typed report binding. It
   * authenticates the issued report reference, binds the original captured
   * source and selected retained checks, and returns frozen allowlisted facts
   * with synchronous refresh and pure revalidation. It never reads files,
   * runs checks, captures output, starts workers or publishes a report.
   */
  prepareReport(request: unknown, actualSignal: unknown): NativeHarnessReportBindingResult;
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
  /**
   * Registers the exact capture-action response projection on the retained
   * action reference. Idempotent only for the equal authentic envelope.
   */
  registerOutputCaptureProjection(
    actualSourceToolCallId: unknown,
    actualActionToolCallId: unknown,
    exactCaptureResponse: unknown,
    actualProjectedResult: unknown,
    originalActionSignal: unknown,
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

/** Internal ownership binding for one admitted capture action. */
interface CaptureActionBinding {
  readonly record: NativeHarnessCaptureActionRecord;
  readonly settled: {
    readonly promise: Promise<NativeHarnessOutputSelection>;
    resolve(value: NativeHarnessOutputSelection): void;
  };
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
  actionBinding: CaptureActionBinding | null;
  /** Bounded admitted report-reread records over this original capture. */
  reportRecords: ReportRereadRecord[];
  /** Count of admitted report I/O attempts; never resets to zero. */
  reportAttempts: number;
  /** The one exact active report-read owner under this output Slot. */
  reportActive: ReportReadRuntime | null;
  /** Sticky current-use refusal after authoritative drift evidence. */
  reportCurrentUseRefusal: string | null;
}

interface AccountingRuntime {
  readonly storageRoot: string;
  readonly limitsText: string;
  readonly receiver: NativeHarnessDelegationAccountingPort;
  readonly associate: NativeHarnessDelegationAccountingPort["associate"];
}

type AccountingPendingKind = "reserve" | "bindPrepared" | "bindRun" | "blockBudget" | "settle";

interface AccountingFixedFacts {
  readonly noDispatch: boolean;
  readonly known: boolean;
  readonly observedUsd: number | null;
  readonly concurrencyHeld: boolean;
  readonly canSettle: boolean;
}

/**
 * One durable subrecord under the original Slot. It never holds a second
 * executable call, slot, promise or dollar balance; amounts come only from a
 * real checkpoint projection.
 */
interface SlotAccounting {
  readonly admissionId: string;
  identity: NativeHarnessAccountingIdentity | null;
  handle: NativeHarnessAccountingHandle | null;
  checkpoint: NativeHarnessAccountingCheckpoint | null;
  reserveRevision: number | null;
  readonly sourceAssociationSha256: string;
  preparedConfirmed: boolean;
  runConfirmed: boolean;
  phase: "idle" | "associating" | "reserved" | "unavailable";
  pending: Promise<NativeHarnessAccountingCheckpoint> | null;
  pendingKind: AccountingPendingKind | null;
  settleStarted: boolean;
  settleConfirmed: boolean;
  blockCommitted: boolean;
  finalizing: boolean;
  finalization: Promise<void> | null;
  finalFacts: AccountingFixedFacts | null;
  lateSettlementArmed: boolean;
  unavailableReason: string | null;
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
  readonly accounting: SlotAccounting;
  readonly output: SlotOutput;
}

interface CoordinatorState {
  readonly native: NativeCallPort;
  readonly output: OutputPort | null;
  readonly accounting: AccountingRuntime | null;
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
  accountingOwnerIdentity: NativeHarnessAccountingIdentity | null;
  accountingCache: {
    readonly checkpoint: NativeHarnessAccountingCheckpoint;
    readonly projection: NativeHarnessAccountingProjection;
  } | null;
  accountingUnavailableReason: string | null;
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
  outputObservationInProgress: boolean;
  reportBindingInProgress: boolean;
  /** One bounded synchronous admission/join guard for report rereads. */
  reportRereadInProgress: boolean;
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

const ACCOUNTING_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isCanonicalStorageRoot(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= 4096
    && value.startsWith("/")
    && !value.endsWith("/")
    && !/[\x00-\x1f\x7f]/.test(value)
    && !value.includes("//")
    && !value.includes("/./")
    && !value.includes("/../");
}

function normalizedLimitsText(limits: NativeHarnessDelegationLimits): string {
  // Fixed six-field order; the same normalized value is passed to the
  // association leaf and compared exactly against the stored owner limits.
  return JSON.stringify({
    maxRetainedOperations: limits.maxRetainedOperations,
    maxConcurrent: limits.maxConcurrent,
    perRunUsd: limits.perRunUsd,
    lifetimeUsd: limits.lifetimeUsd,
    maxDurationMs: limits.maxDurationMs,
    cleanupGraceMs: limits.cleanupGraceMs,
  });
}

function sameAccountingLimits(
  stored: NativeHarnessDelegationLimits,
  current: NativeHarnessDelegationLimits,
): boolean {
  return stored.maxRetainedOperations === current.maxRetainedOperations
    && stored.maxConcurrent === current.maxConcurrent
    && stored.perRunUsd === current.perRunUsd
    && stored.lifetimeUsd === current.lifetimeUsd
    && stored.maxDurationMs === current.maxDurationMs
    && stored.cleanupGraceMs === current.cleanupGraceMs;
}

function readAccountingPort(
  value: unknown,
  limits: NativeHarnessDelegationLimits,
): AccountingRuntime | null {
  if (value === undefined) return null;
  const fields = readStrictFields(value, ["storageRoot", "associate"], ["storageRoot", "associate"]);
  if (fields === null) {
    throw new NativeHarnessDelegationError(
      "Delegation accounting must be a plain own-data object with storageRoot and associate.",
    );
  }
  const storageRoot = fields.get("storageRoot");
  if (!isCanonicalStorageRoot(storageRoot)) {
    throw new NativeHarnessDelegationError(
      "Delegation accounting storageRoot must be a canonical absolute non-root path.",
    );
  }
  const associate = fields.get("associate");
  if (typeof associate !== "function") {
    throw new NativeHarnessDelegationError("Delegation accounting associate must be a function.");
  }
  return Object.freeze({
    storageRoot,
    limitsText: normalizedLimitsText(limits),
    receiver: value as NativeHarnessDelegationAccountingPort,
    associate: associate as NativeHarnessDelegationAccountingPort["associate"],
  });
}

function associationSourceSha256(association: NativeHarnessAssociation): string {
  // Fixed key order; values come only from the original capture-owned association.
  return sha256Hex(JSON.stringify({
    observationId: association.observationId,
    generation: association.generation,
    sessionId: association.sessionId,
    workspaceRoot: association.workspaceRoot,
    toolCallId: association.toolCallId,
    toolName: association.toolName,
  }));
}

function readAccountingIdentity(value: unknown): NativeHarnessAccountingIdentity | null {
  const fields = readStrictFields(value, ["ownerId", "selectorSha256"], ["ownerId", "selectorSha256"]);
  if (fields === null) return null;
  const ownerId = fields.get("ownerId");
  const selectorSha256 = fields.get("selectorSha256");
  if (typeof ownerId !== "string" || !ACCOUNTING_UUID_PATTERN.test(ownerId)) return null;
  if (!isHex64(selectorSha256)) return null;
  return Object.freeze({ ownerId, selectorSha256 });
}

const ACCOUNTING_PREPARED_KEYS = [
  "preparedRelativeRoot",
  "storeRelativeRoot",
  "inputManifestSha256",
  "sourceDescriptorSha256",
] as const;

function readAccountingPrepared(
  value: unknown,
): { readonly ok: true; readonly prepared: NativeHarnessAccountingPrepared } | { readonly ok: false; readonly reason: string } {
  const fields = readStrictFields(value, ACCOUNTING_PREPARED_KEYS, ACCOUNTING_PREPARED_KEYS);
  if (fields === null) {
    return { ok: false, reason: "trusted prepare returned missing or malformed accountingPrepared facts" };
  }
  for (const key of ["preparedRelativeRoot", "storeRelativeRoot"] as const) {
    const text = fields.get(key);
    if (typeof text !== "string"
      || text.length === 0
      || text.length > 4096
      || /[\x00-\x1f\x7f]/.test(text)
      || text.startsWith("/")
      || text.split("/").some((part) => part === ".." || part === ".")) {
      return { ok: false, reason: `trusted prepare accountingPrepared.${key} is not a relative path` };
    }
  }
  const inputManifestSha256 = fields.get("inputManifestSha256");
  const sourceDescriptorSha256 = fields.get("sourceDescriptorSha256");
  if (!isHex64(inputManifestSha256) || !isHex64(sourceDescriptorSha256)) {
    return { ok: false, reason: "trusted prepare accountingPrepared hashes must be 64 lowercase hexadecimal characters" };
  }
  return {
    ok: true,
    prepared: Object.freeze({
      preparedRelativeRoot: fields.get("preparedRelativeRoot") as string,
      storeRelativeRoot: fields.get("storeRelativeRoot") as string,
      inputManifestSha256,
      sourceDescriptorSha256,
    }),
  };
}

function observeAccountingCheckpoint(
  slot: Slot,
  checkpoint: NativeHarnessAccountingCheckpoint,
): boolean {
  const state = slotState(slot);
  if (state === null) return false;
  const expected = state.accountingOwnerIdentity;
  if (expected === null) return false;
  if (checkpoint.ownerId !== expected.ownerId || checkpoint.selectorSha256 !== expected.selectorSha256) {
    return false;
  }
  if (!sameAccountingLimits(checkpoint.limits, state.limits)) return false;
  let projection: NativeHarnessAccountingProjection;
  try {
    projection = projectNativeHarnessAccounting(checkpoint);
  } catch {
    return false;
  }
  const accounting = slot.accounting;
  if (accounting.checkpoint === null || checkpoint.revision >= accounting.checkpoint.revision) {
    accounting.checkpoint = checkpoint;
  }
  if (state.accountingCache === null || checkpoint.revision > state.accountingCache.checkpoint.revision) {
    state.accountingCache = Object.freeze({ checkpoint, projection });
  }
  state.accountingUnavailableReason = null;
  return true;
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

function outputFailureFromCheck(failure: NativeHarnessCheckFailure): NativeHarnessOutputSelectionFailure {
  const code: NativeHarnessOutputSelectionCode = failure.code === "check-unavailable"
    ? "capture-failed"
    : failure.code === "protocol"
      ? "source-conflict"
      : failure.code;
  return outputFailure(code, failure.reason);
}

interface PreparedCaptureSource {
  readonly output: OutputPort;
  readonly registration: OutputRegistration;
  readonly prepared: PreparedOutputCheck;
}

/** Source-side preparation shared by fresh, cached and replay capture paths. */
function prepareCaptureSource(
  state: CoordinatorState,
  slot: Slot,
  requireCaptured: boolean,
): PreparedCaptureSource | NativeHarnessOutputSelectionFailure {
  if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
  if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
  const out = slot.output;
  if (out.state === "failed" && out.failure !== null) return out.failure;
  if (requireCaptured) {
    if (out.state !== "captured" || out.capture === null || out.selection === null) {
      return outputFailure("not-ready", "the source output has not been captured");
    }
  } else if (out.state !== "idle") {
    return out.state === "running"
      ? outputFailure("capacity", "another output capture is already in flight for this delegation")
      : outputFailure("not-ready", "the source output state is unavailable");
  }
  if (out.actionBinding !== null) {
    return outputFailure("capacity", "another output capture action is already bound to this delegation");
  }
  const output = state.output;
  if (output === null) return outputFailure("output-unavailable", "the trusted output port is not available");
  if (out.registration === null) {
    return outputFailure(
      "output-unavailable",
      out.registrationFailure ?? "the actual source result projection is not registered",
    );
  }
  const registration = out.registration;
  const prepared = prepareOutputCheck(slot, state, registration, true);
  if (!prepared.ok) return outputFailure(prepared.code, prepared.reason);
  const source = sourceSuccessProblem(slot, slot.response);
  if (source !== null) return outputFailure("source-conflict", source);
  return { output, registration, prepared };
}

interface PreparedCaptureAction {
  readonly check: ReadyCallCheck;
  readonly inspection: NativeWorkCallInspection;
  readonly context: NativeContext;
  readonly inputSha256: string;
}

interface CaptureActionEvidence {
  readonly actionRef: NativeWorkCallReference;
  readonly inputSha256: string;
}

function captureActionRegistration(
  record: NativeHarnessCaptureActionRecord,
): { readonly sha256: string; readonly bytes: number } | null | undefined {
  if (record.registrationSha256 === null && record.registrationBytes === null) return null;
  if (record.registrationSha256 === null || record.registrationBytes === null) return undefined;
  return { sha256: record.registrationSha256, bytes: record.registrationBytes };
}

/**
 * Host-side preparation of one capture action ref. The returned inspection is
 * parsed here; callers run the pure revalidation later in their final phase.
 */
function prepareCaptureActionGate(
  state: CoordinatorState,
  slot: Slot,
  action: CaptureActionEvidence,
  context: NativeContext,
  registration: { readonly sha256: string; readonly bytes: number } | null,
): PreparedCaptureAction | NativeHarnessOutputSelectionFailure {
  const prepared = prepareCheckAction(state, slot, action.actionRef, context, registration);
  if (isCheckFailure(prepared)) return outputFailureFromCheck(prepared);
  if (prepared.inputSha256 !== action.inputSha256) {
    return outputFailure("source-conflict", "the actual capture call preflight input changed");
  }
  return prepared;
}

/** Local ownership/state checks. No host callback or input read occurs here. */
function captureActionLocalProblem(
  state: CoordinatorState,
  slot: Slot,
  binding: CaptureActionBinding,
  requireActive: boolean,
): NativeHarnessOutputSelectionFailure | null {
  const out = slot.output;
  const record = binding.record;
  if (state.slots.get(record.sourceToolCallId) !== slot) {
    return outputFailure("source-conflict", "the original source Slot was replaced");
  }
  if (binding.settled.promise !== record.promise) {
    return outputFailure("source-conflict", "the capture action promise identity changed");
  }
  if (out.actionBinding !== binding) {
    return outputFailure("source-conflict", "the output capture action binding changed");
  }
  if (out.checks === null || out.checks.actions.get(record.actionToolCallId) !== record) {
    return outputFailure("source-conflict", "the retained capture action record changed");
  }
  if (record.state === "conflicted") {
    return outputFailure(
      "source-conflict",
      record.conflictReason ?? "the output capture action was changed",
    );
  }
  if (record.state === "cancelled") {
    return outputFailure("cancelled", record.failure?.reason ?? "the output capture action was cancelled");
  }
  if (record.state !== "pending") {
    return outputFailure("source-conflict", "the output capture action is no longer pending");
  }
  if (!requireActive) return null;
  if (out.state !== "running"
    || out.controller === null
    || out.promise !== record.promise
    || out.requestSignal !== record.signal
    || out.reservedBytes !== NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES) {
    return outputFailure("cancelled", "the bound output capture is no longer active");
  }
  return null;
}

function settleCaptureAction(
  binding: CaptureActionBinding,
  selection: NativeHarnessOutputSelection,
): void {
  const record = binding.record;
  let published = selection;
  if (record.state === "pending") {
    if (selection.ok) {
      record.state = "succeeded";
      record.selection = selection;
      record.failure = null;
    } else {
      record.state = selection.code === "cancelled" ? "cancelled" : "failed";
      record.failure = selection;
      record.conflictReason = selection.reason;
      published = selection;
    }
  } else if (record.state === "conflicted") {
    published = outputFailure(
      "source-conflict",
      record.conflictReason ?? "the output capture action was changed",
    );
    record.failure = published;
  } else if (record.state === "cancelled") {
    published = record.failure ?? outputFailure("cancelled", "the output capture action was cancelled");
  } else if (record.state === "failed") {
    published = record.failure ?? outputFailure("capture-failed", "the output capture action failed");
  } else if (record.selection !== null) {
    published = record.selection;
  }
  binding.settled.resolve(published);
}

function captureEntryGate(
  state: CoordinatorState,
  slot: Slot,
  output: OutputPort,
  registration: OutputRegistration,
  captureSignal: AbortSignal,
  binding: CaptureActionBinding | null,
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
  let actionPrepared: PreparedCaptureAction | null = null;
  if (binding !== null) {
    const candidate = prepareCaptureActionGate(state, slot, binding.record, prepared.context, null);
    if (isOutputFailure(candidate)) return candidate;
    actionPrepared = candidate;
  }
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
  if (actionPrepared !== null) {
    const actionPure = pureCheckReason(actionPrepared.check);
    if (actionPure !== null) return outputFailure("source-conflict", actionPure);
  }
  if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
  if (slot.output.state !== "idle"
    || slot.output.registration !== registration
    || slot.output.actionBinding !== binding) {
    return outputFailure("not-ready", "the source output state changed during admission");
  }
  if (binding !== null) {
    const local = captureActionLocalProblem(state, slot, binding, false);
    if (local !== null) return local;
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
  binding: CaptureActionBinding | null,
): NativeHarnessOutputSelectionFailure | null {
  const local = outputLocalFailure(state, slot, captureSignal);
  if (local !== null) return local;
  const clock = outputClockFailure(state, slot, startedAt);
  if (clock !== null) return clock;
  const prepared = prepareOutputCheck(slot, state, registration, true);
  if (!prepared.ok) {
    return outputFailure(prepared.code === "not-ready" ? "source-conflict" : prepared.code, prepared.reason);
  }
  let actionPrepared: PreparedCaptureAction | null = null;
  if (binding !== null) {
    const candidate = prepareCaptureActionGate(state, slot, binding.record, prepared.context, null);
    if (isOutputFailure(candidate)) return candidate;
    actionPrepared = candidate;
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
  if (binding !== null && actionPrepared !== null) {
    const actionPure = pureCheckReason(actionPrepared.check);
    if (actionPure !== null) return outputFailure("source-conflict", actionPure);
    const actionLocal = captureActionLocalProblem(state, slot, binding, true);
    if (actionLocal !== null) return actionLocal;
  }
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
  binding: CaptureActionBinding | null,
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
  let actionPrepared: PreparedCaptureAction | null = null;
  if (binding !== null) {
    const candidate = prepareCaptureActionGate(state, slot, binding.record, prepared.context, null);
    if (isOutputFailure(candidate)) return candidate;
    actionPrepared = candidate;
  }
  const clockAfter = outputClockFailure(state, slot, startedAt);
  if (clockAfter !== null) return clockAfter;
  if (prepared.observedSha256 !== observedSha256 || prepared.observedBytes !== observedBytes) {
    return outputFailure("source-conflict", "the source result observation changed during capture");
  }

  // Final sequence, no host callback follows: pure owner predicate, actual
  // capture signal, captured native pure revalidation, then local state.
  const owner = ownerPredicateReason(output);
  if (owner !== null) return outputFailure("authority-lost", owner);
  const signal = readActualAbortSignal(captureSignal);
  if (!signal.ok) return outputFailure("invalid-caller", signal.reason);
  if (signal.aborted) return outputFailure("cancelled", "the output capture signal was aborted before retention");
  const pure = pureCheckReason(prepared.check);
  if (pure !== null) return outputFailure("source-conflict", pure);
  if (binding !== null && actionPrepared !== null) {
    const actionPure = pureCheckReason(actionPrepared.check);
    if (actionPure !== null) return outputFailure("source-conflict", actionPure);
  }
  const local = outputLocalFailure(state, slot, captureSignal);
  if (local !== null) return local;
  if (binding !== null) {
    const actionLocal = captureActionLocalProblem(state, slot, binding, true);
    if (actionLocal !== null) return actionLocal;
  }
  if (slot.output.registration !== registration) {
    return outputFailure("source-conflict", "the source result registration was replaced");
  }
  if (slot.output.guardFailure !== null) return slot.output.guardFailure;
  const source = sourceSuccessProblem(slot, slot.response);
  if (source !== null) return outputFailure("source-conflict", source);
  return null;
}

interface DecodedCaptureEnvelope {
  readonly ok: boolean;
  readonly capture: unknown;
  readonly code: unknown;
  readonly reason: unknown;
  /**
   * Trusted positive-mismatch marker. It is read before any legacy failure
   * mapping and is only valid on an `ok: false` envelope.
   */
  readonly mismatch: true | undefined;
}

/** One strict own-data decode of the trusted output capture envelope. */
function decodeCaptureEnvelope(value: unknown): DecodedCaptureEnvelope | null {
  const fields = readStrictFields(value, ["ok", "capture", "code", "reason", "observedMismatch"], ["ok"]);
  if (fields === null) return null;
  const ok = fields.get("ok");
  const hasMismatch = fields.has("observedMismatch");
  const mismatchValue = fields.get("observedMismatch");
  if (hasMismatch && (mismatchValue !== true || ok !== false)) return null;
  return {
    ok: ok === true,
    capture: fields.get("capture"),
    code: fields.get("code"),
    reason: fields.get("reason"),
    mismatch: hasMismatch ? true : undefined,
  };
}

/**
 * Validates one already-decoded capture value against the original Slot,
 * backend and result registration. No envelope field is re-read here.
 */
function readCaptureValue(
  captureValue: unknown,
  slot: Slot,
  output: OutputPort,
  registration: OutputRegistration,
): { readonly ok: true; readonly capture: NativeHarnessOutputCapture; readonly bytes: number }
  | NativeHarnessOutputSelectionFailure {
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

/**
 * Capture-caller view of the decoded envelope. The compatibility marker is
 * accepted only as an optional `true` on a refused envelope and is ignored
 * after the established failure mapping; it never mints a success or drift.
 */
function readCapturedOutput(
  value: unknown,
  slot: Slot,
  output: OutputPort,
  registration: OutputRegistration,
): { readonly ok: true; readonly capture: NativeHarnessOutputCapture; readonly bytes: number }
  | NativeHarnessOutputSelectionFailure {
  const decoded = decodeCaptureEnvelope(value);
  if (decoded === null) {
    return outputFailure("capture-failed", "the trusted output capture returned an unreadable result");
  }
  if (!decoded.ok) {
    const code = decoded.code;
    const reason = decoded.reason;
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
  return readCaptureValue(decoded.capture, slot, output, registration);
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
  out.actionBinding = null;
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
  out.actionBinding = null;
}

function cancelOutputCapture(slot: Slot, reason: string): boolean {
  const out = slot.output;
  if (out.actionBinding !== null) return false;
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
  binding: CaptureActionBinding | null,
): Promise<void> {
  const out = slot.output;
  let capture: NativeHarnessOutputCapture | null = null;
  let retainedBytes = 0;
  let failure: NativeHarnessOutputSelectionFailure | null = null;
  try {
    const guard = (): void => {
      const gate = captureGuardGate(
        state,
        slot,
        output,
        registration,
        controller.signal,
        startedAt,
        binding,
      );
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
        binding,
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
  binding: CaptureActionBinding | null,
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
    if (binding !== null && out.actionBinding !== binding) {
      return Promise.resolve(outputFailure(
        "source-conflict",
        "the admitted output capture action binding changed before launch",
      ));
    }
    if (binding === null && out.actionBinding !== null) {
      return Promise.resolve(outputFailure(
        "capacity",
        "a bound output capture action is already in flight for this delegation",
      ));
    }
    if (out.state === "failed" && out.failure !== null) {
      return Promise.resolve(out.failure);
    }
    if (out.state === "captured" && out.selection !== null) {
      if (binding !== null) {
        return Promise.resolve(outputFailure(
          "source-conflict",
          "the source output was captured before the action could start",
        ));
      }
      const cached = captureCachedOutput(state, slot, captureSignalValue);
      return Promise.resolve(cached);
    }
    if (out.state === "running" && out.promise !== null) {
      if (binding !== null || out.actionBinding !== null) {
        return Promise.resolve(outputFailure(
          "capacity",
          "another output capture is already in flight for this delegation",
        ));
      }
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
          null,
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
    const gate = captureEntryGate(
      state,
      slot,
      output,
      registration,
      captureSignalValue as AbortSignal,
      binding,
    );
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
      || out.actionBinding !== binding
      || state.slots.get(toolCallId) !== slot) {
      return Promise.resolve(outputFailure("not-ready", "the source output state changed during admission"));
    }
    const combined = createCaptureController(captureSignalValue as AbortSignal);
    if (!combined.ok) return Promise.resolve(outputFailure("invalid-caller", combined.reason));

    // Reserve and install the exact deferred promise/state before the leaf can
    // start any callback or I/O. Reentrant callers observe the same operation.
    const settled = binding === null ? deferred<NativeHarnessOutputSelection>() : binding.settled;
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
      binding,
    ).then(
      () => {
        const selection = out.selection
          ?? out.failure
          ?? outputFailure("capture-failed", "the output capture settled without a result");
        if (binding !== null) settleCaptureAction(binding, selection);
        settled.resolve(selection);
      },
      (error) => {
        const failure = outputFailure(
          "capture-failed",
          `the output capture task failed: ${outputThrownReason(error, "output operation failed")}`,
        );
        failOutput(state, slot, failure);
        if (binding !== null) settleCaptureAction(binding, failure);
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
  action: CaptureActionEvidence | null = null,
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
  let actionPrepared: PreparedCaptureAction | null = null;
  if (action !== null) {
    const candidate = prepareCaptureActionGate(state, slot, action, prepared.context, null);
    if (isOutputFailure(candidate)) return candidate;
    actionPrepared = candidate;
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
  if (actionPrepared !== null) {
    const actionPure = pureCheckReason(actionPrepared.check);
    if (actionPure !== null) return outputFailure("source-conflict", actionPure);
  }
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

interface RetainedAction {
  readonly slot: Slot;
  readonly record: NativeHarnessActionRecord;
}

/**
 * Bounded search over the existing Slot records before routing by the
 * caller-supplied source selector. A retained action id cannot move to another
 * Slot and gain a fresh preflight comparison.
 */
function findRetainedAction(
  state: CoordinatorState,
  actionToolCallId: string,
): RetainedAction | null {
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

interface PreparedActualCall {
  readonly ref: NativeWorkCallReference;
  readonly check: ReadyCallCheck;
  readonly inspection: NativeWorkCallInspection;
  readonly association: ActionAssociation;
  readonly inputSha256: string;
}

function actualCallInspectionProblem(
  inspection: NativeWorkCallInspection,
  expectedInputSha256: string,
): { readonly code: NativeHarnessOutputSelectionCode; readonly reason: string } | null {
  if (inspection.requestAttribution !== "matched-user-input") {
    return { code: "authority-lost", reason: "the actual output call is not associated with matched user input" };
  }
  if (inspection.pendingInputCount !== 0 || inspection.pendingInputsDropped !== 0) {
    return { code: "authority-lost", reason: "the actual output call work has queued or dropped inputs" };
  }
  if (!isHex64(inspection.callInputSha256) || inspection.callInputSha256 !== expectedInputSha256) {
    return {
      code: "source-conflict",
      reason: "the actual output call preflight input differs from the frozen normalized input",
    };
  }
  return null;
}

interface PreparedActualCallCheck {
  readonly check: ReadyCallCheck;
  readonly inspection: NativeWorkCallInspection;
}

/** One native prepare against an already-captured actual call ref. */
function prepareActualCallCheck(
  state: CoordinatorState,
  ref: NativeWorkCallReference,
  context: NativeContext,
  expectedInputSha256: string,
): PreparedActualCallCheck | NativeHarnessOutputSelectionFailure {
  let check: NativeCallCheckPreparation;
  try {
    check = Reflect.apply(state.native.prepareCallCheck, state.native.receiver, [ref, context]);
  } catch (error) {
    return outputFailure(
      "authority-lost",
      `native output call revalidation threw: ${outputThrownReason(error, "output operation failed")}`,
    );
  }
  if (!check.ok) {
    return outputFailure(
      projectionConflict(check.inspection) ? "source-conflict" : "authority-lost",
      nativeInspectionReason(check.inspection),
    );
  }
  const after = check.inspection;
  if (after.state !== "current" || after.evidenceState !== "available") {
    return outputFailure(
      projectionConflict(after) ? "source-conflict" : "authority-lost",
      nativeInspectionReason(after),
    );
  }
  const afterAdmission = actualCallInspectionProblem(after, expectedInputSha256);
  if (afterAdmission !== null) return outputFailure(afterAdmission.code, afterAdmission.reason);
  return { check, inspection: after };
}

/**
 * Source-independent preparation of one genuine `agent_harness_result` call.
 * The issued ref lives only in this invocation; no Slot, action record, cache
 * or ledger entry is created here. All host reads finish before the caller's
 * final pure sequence.
 */
function prepareActualToolCall(
  state: CoordinatorState,
  actualToolCallId: string,
  expectedInputSha256: string,
): PreparedActualCall | NativeHarnessOutputSelectionFailure {
  const main = readMainContext(state);
  if (!main.ok) return outputFailure("authority-lost", main.reason);
  let capture: NativeCallCapture;
  try {
    capture = Reflect.apply(state.native.captureCall, state.native.receiver, [
      { toolCallId: actualToolCallId, toolName: NATIVE_HARNESS_RESULT_TOOL },
      main.context,
    ]);
  } catch (error) {
    return outputFailure(
      "authority-lost",
      `native output call capture threw: ${outputThrownReason(error, "output operation failed")}`,
    );
  }
  if (!capture.ok) return outputFailure("authority-lost", nativeInspectionReason(capture.inspection));
  const inspection = capture.inspection;
  if (inspection.state !== "current" || inspection.evidenceState !== "available") {
    return outputFailure("authority-lost", nativeInspectionReason(inspection));
  }
  let association: ActionAssociation;
  try {
    association = actionAssociationOf(capture.ref);
  } catch {
    return outputFailure("authority-lost", "native output call capture returned unreadable association facts");
  }
  if (association.toolCallId !== actualToolCallId || association.toolName !== NATIVE_HARNESS_RESULT_TOOL) {
    return outputFailure("invalid-caller", "native output call capture returned a different actual tool call");
  }
  const admission = actualCallInspectionProblem(inspection, expectedInputSha256);
  if (admission !== null) return outputFailure(admission.code, admission.reason);

  const prepared = prepareActualCallCheck(state, capture.ref, main.context, expectedInputSha256);
  if (isOutputFailure(prepared)) return prepared;
  if (!sameActionAssociation(prepared.inspection.association, association)) {
    return outputFailure("source-conflict", "the actual output call association changed during preparation");
  }
  return {
    ref: capture.ref,
    check: prepared.check,
    inspection: prepared.inspection,
    association,
    inputSha256: prepared.inspection.callInputSha256 as string,
  };
}

/**
 * Fresh actual main-context native prepare using the one original query ref.
 * Never captures a replacement ref: an unavailable root, changed association
 * or changed frozen input rejects the whole inspection.
 */
function refreshActualToolCall(
  state: CoordinatorState,
  original: PreparedActualCall,
  expectedInputSha256: string,
): PreparedActualCall | NativeHarnessOutputSelectionFailure {
  const main = readMainContext(state);
  if (!main.ok) return outputFailure("authority-lost", main.reason);
  const prepared = prepareActualCallCheck(state, original.ref, main.context, expectedInputSha256);
  if (isOutputFailure(prepared)) return prepared;
  if (!sameActionAssociation(prepared.inspection.association, original.association)
    || prepared.inspection.callInputSha256 !== expectedInputSha256) {
    return outputFailure(
      "source-conflict",
      "the actual output call association or input changed during inspection",
    );
  }
  return {
    ref: original.ref,
    check: prepared.check,
    inspection: prepared.inspection,
    association: original.association,
    inputSha256: prepared.inspection.callInputSha256 as string,
  };
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

type ReportRegistration = { readonly sha256: string; readonly bytes: number };

interface ReportFileBinding {
  readonly path: string;
  readonly change: NativeHarnessOutputRecord;
  readonly kind: "add" | "modify";
  readonly mode: number;
  readonly controllerHash: string;
  readonly fileSnapshotId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
  record: NativeHarnessCheckRetainedActionRecord | null;
  pathRecord: NativeHarnessCheckPathRecord | null;
  registration: ReportRegistration | null;
}

interface ReportBindingCandidate {
  readonly slot: Slot;
  readonly capture: NativeHarnessOutputCapture;
  readonly outputSelection: NativeHarnessOutputSelectionSuccess;
  readonly registration: OutputRegistration;
  readonly checks: NativeHarnessCheckState | null;
  readonly files: readonly ReportFileBinding[];
  readonly observedSha256: string;
  readonly observedBytes: number;
}

interface ReportBindingRevision {
  readonly source: PreparedCheckSource;
  readonly report: ReadyCallCheck;
  readonly reportInspection: NativeWorkCallInspection;
  readonly reportAssociation: ActionAssociation;
  readonly selected: readonly {
    readonly record: NativeHarnessCheckRetainedActionRecord;
    readonly action: PreparedCheckAction;
  }[];
}

interface ReportBindingState {
  readonly slot: Slot;
  readonly sourceId: string;
  readonly reportId: string;
  readonly reportRef: object;
  readonly reportAssociation: ActionAssociation;
  readonly reportInputSha256: string;
  /** The exact brand-checked actual report signal, never a source/check signal. */
  readonly reportSignal: unknown;
  readonly request: NativeHarnessReportNormalizedRequest;
  readonly capture: NativeHarnessOutputCapture;
  readonly outputSelection: NativeHarnessOutputSelectionSuccess;
  readonly registration: OutputRegistration;
  readonly checks: NativeHarnessCheckState | null;
  readonly files: readonly ReportFileBinding[];
  readonly observedSha256: string;
  readonly observedBytes: number;
  readonly facts: NativeHarnessReportBindingFacts;
  revision: ReportBindingRevision;
}

/** Bounded selection identity retained after an attempt settles. */
interface ReportRereadSelection {
  readonly sourceToolCallId: string;
  readonly captureId: string;
  readonly captureDigest: string;
  readonly checkToolCallIds: readonly string[];
}

/**
 * One admitted report reread. Settled records keep only compact original refs,
 * the exact original Promise and its fixed result; the active runtime and
 * preparation binding are cleared when the attempt drains.
 */
interface ReportRereadRecord {
  readonly attempt: number;
  readonly sourceId: string;
  readonly reportId: string;
  readonly reportRef: object;
  readonly reportInputSha256: string;
  readonly outcome: ReportOutcome;
  readonly reportSignal: unknown;
  readonly capture: NativeHarnessOutputCapture;
  readonly outputSelection: NativeHarnessOutputSelectionSuccess;
  readonly registration: OutputRegistration;
  readonly checks: NativeHarnessCheckState | null;
  readonly selection: ReportRereadSelection;
  readonly startedAt: number;
  readonly promise: Promise<NativeHarnessReportRereadResult>;
  result: NativeHarnessReportRereadResult | null;
  /** Active-only; null once the attempt settles. */
  runtime: ReportReadRuntime | null;
}

/**
 * Active-only report-read runtime. Guards resolve this record through the
 * original Slot and read the fields below; they never close over a prepared
 * facts object. Every field is cleared when the attempt drains.
 */
interface ReportReadRuntime {
  readonly record: ReportRereadRecord;
  readonly slot: Slot;
  binding: ReportBindingState | null;
  controller: AbortController | null;
  cleanup: (() => void) | null;
  reservation: number;
  deadlineAt: number;
  lastClock: number;
  guardFailure: NativeHarnessReportRereadFailure | null;
  settled: {
    readonly promise: Promise<NativeHarnessReportRereadResult>;
    resolve(value: NativeHarnessReportRereadResult): void;
  } | null;
}

function isReportFailure(value: unknown): value is NativeHarnessReportBindingFailure {
  return typeof value === "object"
    && value !== null
    && (value as { readonly ok?: unknown }).ok === false;
}

function reportFailureFromCheckFailure(
  failure: NativeHarnessCheckFailure,
): NativeHarnessReportBindingFailure {
  const code: NativeHarnessReportFailureCode = failure.code === "source-conflict"
      || failure.code === "protocol"
    ? "source-conflict"
    : failure.code === "invalid-caller"
      ? "invalid-caller"
      : failure.code === "authority-lost"
          || failure.code === "cancelled"
          || failure.code === "deadline"
        ? "authority-lost"
        : "not-ready";
  return createNativeHarnessReportFailure(code, failure.reason);
}

function sameReportWorkIdentity(
  left: {
    readonly observationId: string;
    readonly generation: number;
    readonly sessionId: string;
    readonly workspaceRoot: string;
  },
  right: {
    readonly observationId: string;
    readonly generation: number;
    readonly sessionId: string;
    readonly workspaceRoot: string;
  },
): boolean {
  return left.observationId === right.observationId
    && left.generation === right.generation
    && left.sessionId === right.sessionId
    && left.workspaceRoot === right.workspaceRoot;
}

/**
 * Descriptor-only read of the already-authenticated issued report reference.
 * It never invokes a getter; a missing/accessor field refuses.
 */
function readReportRefAssociation(ref: object): ActionAssociation | null {
  const observationId = readOwnField(ref, "observationId");
  const generation = readOwnField(ref, "generation");
  const sessionId = readOwnField(ref, "sessionId");
  const workspaceRoot = readOwnField(ref, "workspaceRoot");
  const toolCallId = readOwnField(ref, "toolCallId");
  const toolName = readOwnField(ref, "toolName");
  if (observationId.kind !== "data"
    || generation.kind !== "data"
    || sessionId.kind !== "data"
    || workspaceRoot.kind !== "data"
    || toolCallId.kind !== "data"
    || toolName.kind !== "data") {
    return null;
  }
  const observedId = boundedString(observationId.value, MAX_TOOL_CALL_ID_CHARS);
  const observedGeneration = generation.value;
  const observedSession = boundedString(sessionId.value, 4096);
  const observedRoot = boundedString(workspaceRoot.value, 4096);
  const observedCall = boundedString(toolCallId.value, MAX_TOOL_CALL_ID_CHARS);
  const observedTool = boundedString(toolName.value, MAX_TOOL_CALL_ID_CHARS);
  if (observedId === null
    || typeof observedGeneration !== "number"
    || !Number.isSafeInteger(observedGeneration)
    || observedGeneration < 1
    || observedSession === null
    || observedRoot === null
    || observedCall === null
    || observedTool === null) {
    return null;
  }
  return {
    observationId: observedId,
    generation: observedGeneration,
    sessionId: observedSession,
    workspaceRoot: observedRoot,
    toolCallId: observedCall,
    toolName: observedTool,
  };
}

function reportInspectionProblem(
  state: CoordinatorState,
  inspection: NativeWorkCallInspection,
  request: NativeHarnessReportNormalizedRequest,
  supplied: ActionAssociation,
): NativeHarnessReportBindingFailure | null {
  if (inspection.state !== "current" || inspection.evidenceState !== "available") {
    return createNativeHarnessReportFailure("authority-lost", nativeInspectionReason(inspection));
  }
  if (!isRecord(inspection.association) || !sameActionAssociation(inspection.association, supplied)) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the report reference native association changed",
    );
  }
  if (supplied.toolName !== NATIVE_WORK_TOOL) {
    return createNativeHarnessReportFailure("invalid-caller", "the report reference is not an agent_work call");
  }
  if (!sameReportWorkIdentity(supplied, request.work)) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the report reference does not belong to the requested original work",
    );
  }
  if (inspection.requestAttribution !== "matched-user-input") {
    return createNativeHarnessReportFailure(
      "authority-lost",
      "the report reference is no longer associated with matched user input",
    );
  }
  if (inspection.pendingInputCount !== 0 || inspection.pendingInputsDropped !== 0) {
    return createNativeHarnessReportFailure("authority-lost", "the report work has queued or dropped inputs");
  }
  if (!isHex64(inspection.callInputSha256)
    || inspection.callInputSha256 !== request.reportInputSha256) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the actual report preflight input differs from reportInputSha256",
    );
  }
  if (inspection.callResultState !== "preflight") {
    return createNativeHarnessReportFailure(
      "not-ready",
      "the report reference is not an unexecuted preflight call",
    );
  }
  const projection = inspection.resultProjection;
  if (!isRecord(projection) || projection.state !== "unregistered") {
    return createNativeHarnessReportFailure(
      "not-ready",
      "the report reference already has a registered or observed result projection",
    );
  }
  if (supplied.toolCallId === request.selection.sourceToolCallId
    || request.selection.checkToolCallIds.includes(supplied.toolCallId)) {
    return createNativeHarnessReportFailure(
      "invalid-caller",
      "the report call id collides with the source or a selected check action",
    );
  }
  if (state.slots.has(supplied.toolCallId) || findRetainedAction(state, supplied.toolCallId) !== null) {
    return createNativeHarnessReportFailure(
      "invalid-caller",
      "the report call id is already retained by another source or action",
    );
  }
  return null;
}

function prepareReportRefCheck(
  state: CoordinatorState,
  ref: object,
  context: NativeContext,
  request: NativeHarnessReportNormalizedRequest,
): { readonly check: ReadyCallCheck; readonly inspection: NativeWorkCallInspection; readonly association: ActionAssociation }
  | NativeHarnessReportBindingFailure {
  let check: NativeCallCheckPreparation;
  try {
    check = Reflect.apply(state.native.prepareCallCheck, state.native.receiver, [ref, context]);
  } catch (error) {
    return createNativeHarnessReportFailure(
      "authority-lost",
      `native report revalidation threw: ${outputThrownReason(error, "report binding failed")}`,
    );
  }
  if (!check.ok) {
    return createNativeHarnessReportFailure(
      projectionConflict(check.inspection) ? "source-conflict" : "authority-lost",
      nativeInspectionReason(check.inspection),
    );
  }
  const inspection = check.inspection;
  if (inspection.state !== "current" || inspection.evidenceState !== "available") {
    return createNativeHarnessReportFailure(
      projectionConflict(inspection) ? "source-conflict" : "authority-lost",
      nativeInspectionReason(inspection),
    );
  }
  // Native membership/authenticity was established above; only now may the
  // exact supplied reference fields be read.
  const supplied = readReportRefAssociation(ref);
  if (supplied === null) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the authenticated report reference has unreadable association facts",
    );
  }
  if (!isRecord(inspection.association) || !sameActionAssociation(inspection.association, supplied)) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the report reference association is not the exact supplied association",
    );
  }
  const problem = reportInspectionProblem(state, inspection, request, supplied);
  if (problem !== null) return problem;
  return { check, inspection, association: supplied };
}

function reportFileBinding(change: NativeHarnessOutputRecord): ReportFileBinding | null {
  if (change.kind !== "add" && change.kind !== "modify") return null;
  if (!isNativeWorkspaceTextSnapshot(change.snapshot)) return null;
  const filePath = boundedString(change.path, NATIVE_HARNESS_MAX_CHECK_PATH_CHARS);
  if (filePath === null) return null;
  const file = change.snapshot.file;
  if (file === null || typeof file !== "object") return null;
  if (file.relativePath !== filePath) return null;
  if (typeof change.mode !== "number"
    || !Number.isSafeInteger(change.mode)
    || change.mode < 0
    || change.mode > 0o7777) {
    return null;
  }
  if (!isHex64(change.controllerHash)) return null;
  if (typeof file.bytes !== "number"
    || !Number.isSafeInteger(file.bytes)
    || file.bytes < 0
    || file.bytes > MAX_OUTPUT_CHANGE_BYTES) {
    return null;
  }
  if (!isHex64(file.sha256)) return null;
  if (typeof file.observedAt !== "number"
    || !Number.isSafeInteger(file.observedAt)
    || file.observedAt < 0) {
    return null;
  }
  const fileSnapshotId = boundedString(change.snapshot.captureId, MAX_TOOL_CALL_ID_CHARS);
  if (fileSnapshotId === null) return null;
  return {
    path: filePath,
    change,
    kind: change.kind,
    mode: change.mode,
    controllerHash: change.controllerHash,
    fileSnapshotId,
    bytes: file.bytes,
    sha256: file.sha256,
    observedAt: file.observedAt,
    record: null,
    pathRecord: null,
    registration: null,
  };
}

function selectedReportRecordProblem(
  sourceId: string,
  capture: NativeHarnessOutputCapture,
  checks: NativeHarnessCheckState,
  files: readonly ReportFileBinding[],
  record: NativeHarnessCheckRetainedActionRecord,
): string | null {
  if (record.kind !== "retained") return "the selected action is not a retained check record";
  if (record.state !== "admitted") return "the selected check action is not admitted";
  if (record.registrationConflict !== null) return record.registrationConflict;
  const registration = retainedRegistration(record);
  if (registration === undefined) return "the selected check registration fingerprint is incomplete";
  if (registration === null) return "the selected check result has not been registered";
  if (!isHex64(record.inputSha256)) return "the selected check input digest is unavailable";
  if (record.sourceToolCallId !== sourceId) return "the selected check belongs to another source";
  const path = record.path;
  if (record.actionToolCallId.length < 1
    || record.actionToolCallId.length > MAX_TOOL_CALL_ID_CHARS) {
    return "the selected check tool call id is unavailable";
  }
  if (path.captureId !== capture.captureId || path.captureDigest !== capture.digest) {
    return "the selected check path belongs to another capture";
  }
  if (!checks.paths.includes(path)) return "the selected check path record is not retained";
  if (path.origin !== NATIVE_HARNESS_CHECK_PLAN_SOURCE) {
    return "the selected check plan source is not the model-proposed-after-capture source";
  }
  if (path.plan.checkerId !== NATIVE_TEXT_CHECKER_ID
    || path.plan.checkerVersion !== NATIVE_TEXT_CHECKER_VERSION
    || !isHex64(path.plan.digest)) {
    return "the selected check plan identity is malformed";
  }
  if (!matchesNativeTextCheckReceipt(path.receipt, path.snapshot, path.plan)) {
    return "the selected check receipt is not authentic for the retained snapshot and plan";
  }
  const row = files.find((candidate) => candidate.path === path.path);
  if (row === undefined) return "the selected check path is not in the original capture";
  if (row.change.snapshot !== path.snapshot) {
    return "the selected check snapshot is not the original capture snapshot";
  }
  const response = record.response;
  if (response.checkToolCallId !== record.actionToolCallId
    || response.computedByToolCallId !== path.computedByToolCallId
    || response.sourceToolCallId !== sourceId
    || response.captureId !== capture.captureId
    || response.captureDigest !== capture.digest
    || response.path !== path.path
    || response.planDigest !== path.plan.digest
    || response.planSource !== path.origin
    || response.checkerId !== NATIVE_TEXT_CHECKER_ID
    || response.checkerVersion !== NATIVE_TEXT_CHECKER_VERSION
    || response.receipt !== path.receipt) {
    return "the retained check response does not bind the original path, plan and receipt";
  }
  if (files.some((candidate) => candidate !== row && candidate.record === record)) {
    return "the same selected check record appears on more than one path";
  }
  return null;
}

/**
 * Local-only resolution of the original Slot, capture, selected records and
 * authentic receipts. No host callback, clock or file read occurs here.
 */
function resolveReportBindingCandidate(
  state: CoordinatorState,
  request: NativeHarnessReportNormalizedRequest,
): ReportBindingCandidate | NativeHarnessReportBindingFailure {
  const sourceId = request.selection.sourceToolCallId;
  const slot = state.slots.get(sourceId);
  if (slot === undefined) {
    return createNativeHarnessReportFailure("not-ready", "no retained delegation operation has this source id");
  }
  if (slot.toolCallId !== sourceId) {
    return createNativeHarnessReportFailure("source-conflict", "the original source Slot id changed");
  }
  if (!sameReportWorkIdentity(slot.association, request.work)) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the requested work identity is not the original source work",
    );
  }
  const out = slot.output;
  if (out.reportCurrentUseRefusal !== null) {
    return createNativeHarnessReportFailure("source-conflict", out.reportCurrentUseRefusal);
  }
  if (out.state !== "captured" || out.capture === null || out.selection === null) {
    return createNativeHarnessReportFailure("not-ready", "the source output has not been captured");
  }
  const capture = out.capture;
  const selection = out.selection;
  if (out.registration === null) {
    return createNativeHarnessReportFailure(
      "not-ready",
      out.registrationFailure ?? "the source result projection is not registered",
    );
  }
  if (out.registrationFailure !== null) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the source registration also retains a failure state",
    );
  }
  const registration = out.registration;
  if (request.selection.captureId !== capture.captureId
    || request.selection.captureDigest !== capture.digest) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the report selection does not exactly match the retained source capture",
    );
  }
  if (selection.capture !== capture) {
    return createNativeHarnessReportFailure("source-conflict", "the retained capture selection identity changed");
  }
  if (selection.runId !== capture.runId
    || selection.taskSha256 !== capture.taskSha256
    || registration.runId !== capture.runId
    || registration.taskSha256 !== capture.taskSha256) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the capture run or task identity does not match the original source registration",
    );
  }
  const sourceProblem = sourceSuccessProblem(slot, slot.response);
  if (sourceProblem !== null) {
    return createNativeHarnessReportFailure("source-conflict", sourceProblem);
  }
  if (!isHex64(registration.taskSha256)
    || !isHex64(registration.workPromptSha256)
    || !isHex64(registration.callInputSha256)
    || !isHex64(registration.expectedSha256)
    || typeof registration.expectedBytes !== "number"
    || !Number.isSafeInteger(registration.expectedBytes)
    || registration.expectedBytes < 0) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the original source registration fingerprint is incomplete",
    );
  }
  const observedSha256 = out.observedSha256;
  const observedBytes = out.observedBytes;
  if (!isHex64(observedSha256)
    || typeof observedBytes !== "number"
    || !Number.isSafeInteger(observedBytes)
    || observedBytes < 0
    || observedSha256 !== registration.expectedSha256
    || observedBytes !== registration.expectedBytes
    || selection.observedResultSha256 !== observedSha256) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the observed source result fingerprint is not the registered match",
    );
  }
  if (capture.changes.length > MAX_OUTPUT_CHANGES) {
    return createNativeHarnessReportFailure("source-conflict", "the capture has too many output changes");
  }
  const files: ReportFileBinding[] = [];
  const seenPaths = new Set<string>();
  for (const change of capture.changes) {
    const row = reportFileBinding(change);
    if (row === null) {
      return createNativeHarnessReportFailure("source-conflict", "the capture contains an unusable output file row");
    }
    if (seenPaths.has(row.path)) {
      return createNativeHarnessReportFailure("source-conflict", "the capture contains duplicate output paths");
    }
    seenPaths.add(row.path);
    files.push(row);
  }

  const checks = out.checks;
  const selectedCount = request.selection.checkToolCallIds.length;
  if (selectedCount > 0 && checks === null) {
    return createNativeHarnessReportFailure("not-ready", "the selected check records are not retained");
  }
  if (checks !== null && selectedCount > NATIVE_HARNESS_REPORT_MAX_SELECTED_CHECKS) {
    return createNativeHarnessReportFailure("coverage", "too many selected checks");
  }
  if (checks !== null) {
    const selectedPaths = new Set<string>();
    for (const checkToolCallId of request.selection.checkToolCallIds) {
      const record = checks.actions.get(checkToolCallId);
      if (record === undefined) {
        return createNativeHarnessReportFailure(
          "not-ready",
          "a selected check id is not retained in this exact source",
        );
      }
      if (record.kind !== "retained") {
        return createNativeHarnessReportFailure(
          "source-conflict",
          "a selected check id is a capture or terminal record",
        );
      }
      const problem = selectedReportRecordProblem(sourceId, capture, checks, files, record);
      if (problem !== null) {
        return createNativeHarnessReportFailure(
          problem.includes("not registered") || problem.includes("not retained")
            ? "not-ready"
            : "source-conflict",
          problem,
        );
      }
      const row = files.find((candidate) => candidate.path === record.path.path);
      if (row === undefined) {
        return createNativeHarnessReportFailure("source-conflict", "a selected check path disappeared");
      }
      if (selectedPaths.has(row.path)) {
        return createNativeHarnessReportFailure("source-conflict", "duplicate selected check paths are refused");
      }
      selectedPaths.add(row.path);
      const registrationForCheck = retainedRegistration(record);
      if (registrationForCheck === null || registrationForCheck === undefined) {
        return createNativeHarnessReportFailure("not-ready", "a selected check registration is unavailable");
      }
      row.record = record;
      row.pathRecord = record.path;
      row.registration = registrationForCheck;
    }
  }

  const selectedRows = files.filter((row) => row.record !== null);
  if (request.outcome === "completed") {
    if (files.length === 0 || selectedRows.length !== files.length) {
      return createNativeHarnessReportFailure(
        "coverage",
        "completed requires one selected check for every captured path",
      );
    }
    for (const row of selectedRows) {
      if (row.pathRecord === null || row.pathRecord.receipt.outcome !== "pass") {
        return createNativeHarnessReportFailure(
          "coverage",
          "completed requires an authentic PASS receipt for every captured path",
        );
      }
    }
  }

  return {
    slot,
    capture,
    outputSelection: selection,
    registration,
    checks,
    files: Object.freeze(files.map((row) => Object.freeze(row))),
    observedSha256,
    observedBytes,
  };
}

function createReportFacts(
  candidate: ReportBindingCandidate,
  request: NativeHarnessReportNormalizedRequest,
): NativeHarnessReportBindingFacts | NativeHarnessReportBindingFailure {
  const files: NativeHarnessReportFileFacts[] = candidate.files.map((row) => Object.freeze({
    path: row.path,
    kind: row.kind,
    mode: row.mode,
    controllerHash: row.controllerHash,
    fileSnapshotId: row.fileSnapshotId,
    bytes: row.bytes,
    sha256: row.sha256,
    observedAt: row.observedAt,
    check: row.record === null || row.pathRecord === null
      ? null
      : Object.freeze({
        checkToolCallId: row.record.actionToolCallId,
        computedByToolCallId: row.pathRecord.computedByToolCallId,
        checkerId: NATIVE_TEXT_CHECKER_ID,
        checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
        planSource: row.pathRecord.origin,
        planDigest: row.pathRecord.plan.digest,
        receipt: row.pathRecord.receipt,
      }),
  }));
  const result = createNativeHarnessReportFacts({
    modelDeclaredOutcome: request.outcome,
    source: {
      toolCallId: request.selection.sourceToolCallId,
      observationId: request.work.observationId,
      generation: request.work.generation,
      taskSha256: candidate.registration.taskSha256,
      promptSha256: candidate.registration.workPromptSha256,
      inputSha256: candidate.registration.callInputSha256,
      observedEnvelopeSha256: candidate.observedSha256,
      observedEnvelopeBytes: candidate.observedBytes,
    },
    capture: {
      captureId: candidate.capture.captureId,
      captureDigest: candidate.capture.digest,
      originKind: candidate.capture.originKind,
      completionId: candidate.capture.completionId,
      runId: candidate.capture.runId,
      baseSnapshotId: candidate.capture.baseSnapshotId,
      manifestSha256: candidate.capture.manifestSha256,
      winner: {
        candidate: candidate.capture.winner.candidate,
        attempt: candidate.capture.winner.attempt,
        artifactHash: candidate.capture.winner.artifactHash,
        traceHash: candidate.capture.winner.traceHash,
      },
      observedAt: candidate.capture.observedAt,
    },
    files,
  });
  return result.ok ? result.facts : result;
}

function selectedActionProblem(
  state: CoordinatorState,
  slot: Slot,
  record: NativeHarnessCheckRetainedActionRecord,
  registration: ReportRegistration,
  action: PreparedCheckAction,
): NativeHarnessReportBindingFailure | null {
  if (action.inputSha256 !== record.inputSha256) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the selected check preflight input changed",
    );
  }
  if (!isRecord(action.inspection.association)
    || !sameActionAssociation(action.inspection.association, {
      observationId: slot.association.observationId,
      generation: slot.association.generation,
      sessionId: slot.association.sessionId,
      workspaceRoot: slot.association.workspaceRoot,
      toolCallId: record.actionRef.toolCallId,
      toolName: NATIVE_HARNESS_RESULT_TOOL,
    })) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the selected check now has an incompatible native association",
    );
  }
  if (action.inspection.callResultState !== "observed") {
    return createNativeHarnessReportFailure(
      "not-ready",
      "the selected check result has not been observed",
    );
  }
  const projection = action.inspection.resultProjection;
  if (!isRecord(projection) || projection.state !== "matched") {
    return createNativeHarnessReportFailure(
      "not-ready",
      "the selected check result projection is not matched",
    );
  }
  if (projection.expectedSha256 !== registration.sha256
    || projection.expectedBytes !== registration.bytes
    || projection.observedSha256 !== registration.sha256
    || projection.observedBytes !== registration.bytes) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      "the selected check observed result fingerprint is not the retained registration",
    );
  }
  if (state.slots.get(record.sourceToolCallId) !== slot) {
    return createNativeHarnessReportFailure("source-conflict", "the original source Slot was replaced");
  }
  return null;
}

function prepareReportSelections(
  state: CoordinatorState,
  binding: ReportBindingState,
  context: NativeContext,
): readonly {
  readonly record: NativeHarnessCheckRetainedActionRecord;
  readonly action: PreparedCheckAction;
}[] | NativeHarnessReportBindingFailure {
  const selected: { record: NativeHarnessCheckRetainedActionRecord; action: PreparedCheckAction }[] = [];
  for (const row of binding.files) {
    if (row.record === null || row.registration === null) continue;
    const action = prepareCheckAction(state, binding.slot, row.record.actionRef, context, row.registration);
    if (isCheckFailure(action)) return reportFailureFromCheckFailure(action);
    const problem = selectedActionProblem(state, binding.slot, row.record, row.registration, action);
    if (problem !== null) return problem;
    selected.push(Object.freeze({ record: row.record, action }));
  }
  return Object.freeze(selected);
}

function localReportIdentityProblem(
  state: CoordinatorState,
  binding: ReportBindingState,
): string | null {
  if (state.disposed) return "the delegation coordinator was disposed";
  if (!state.enabled) return "the delegation coordinator is disabled";
  if (state.slots.get(binding.sourceId) !== binding.slot) {
    return "the original source Slot was replaced";
  }
  if (binding.slot.toolCallId !== binding.sourceId
    || !sameReportWorkIdentity(binding.slot.association, binding.request.work)) {
    return "the original source work identity changed";
  }
  const out = binding.slot.output;
  const selectedCheckStateRequired = binding.files.some((row) => row.record !== null);
  const checkStateChanged = out.checks !== binding.checks
    && (selectedCheckStateRequired || binding.checks !== null);
  if (out.state !== "captured"
    || out.capture !== binding.capture
    || out.selection !== binding.outputSelection
    || out.registration !== binding.registration
    || checkStateChanged) {
    return "the retained source capture or check state changed";
  }
  if (out.observedSha256 !== binding.observedSha256
    || out.observedBytes !== binding.observedBytes
    || binding.capture.captureId !== binding.request.selection.captureId
    || binding.capture.digest !== binding.request.selection.captureDigest) {
    return "the retained source observed fingerprint changed";
  }
  const checks = binding.checks;
  for (const row of binding.files) {
    if (row.record === null || row.pathRecord === null || row.registration === null) continue;
    if (checks === null) return "the retained check state disappeared";
    if (checks.actions.get(row.record.actionToolCallId) !== row.record) {
      return "a selected check action record was replaced";
    }
    if (!checks.paths.includes(row.pathRecord)) {
      return "a selected check path record was removed";
    }
    if (row.record.state !== "admitted"
      || row.record.registrationConflict !== null
      || row.record.path !== row.pathRecord
      || row.record.sourceToolCallId !== binding.sourceId
      || row.record.response.receipt !== row.pathRecord.receipt
      || row.pathRecord.snapshot !== row.change.snapshot) {
      return "a selected check record changed";
    }
    const registration = retainedRegistration(row.record);
    if (registration === null
      || registration === undefined
      || registration.sha256 !== row.registration.sha256
      || registration.bytes !== row.registration.bytes) {
      return "a selected check registration changed";
    }
  }
  if (state.slots.has(binding.reportId)
    || findRetainedAction(state, binding.reportId) !== null) {
    return "the report call id now collides with another retained source or action";
  }
  if (!Object.isFrozen(binding.facts)) return "the report facts are not frozen";
  return null;
}

/**
 * Final initial-preparation sequence: pure original owner, actual report
 * signal, every captured native pure check, then local exact identities.
 * Nothing after the pure checks reads a host object.
 */
function finalReportGate(
  state: CoordinatorState,
  binding: ReportBindingState,
  revision: ReportBindingRevision,
  signalValue: unknown,
): NativeHarnessReportBindingFailure | null {
  if (binding.slot.output.reportCurrentUseRefusal !== null) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      binding.slot.output.reportCurrentUseRefusal,
    );
  }
  const owner = ownerPredicateReason(revision.source.output);
  if (owner !== null) {
    return createNativeHarnessReportFailure("authority-lost", owner);
  }
  if (signalValue !== null) {
    const signal = readActualAbortSignal(signalValue);
    if (!signal.ok) {
      return createNativeHarnessReportFailure("invalid-caller", signal.reason);
    }
    if (signal.aborted) {
      return createNativeHarnessReportFailure("authority-lost", "the actual report signal was aborted");
    }
  }
  const sourcePure = pureCheckReason(revision.source.prepared.check);
  if (sourcePure !== null) {
    return createNativeHarnessReportFailure("source-conflict", sourcePure);
  }
  for (const selected of revision.selected) {
    const pure = pureCheckReason(selected.action.check);
    if (pure !== null) {
      return createNativeHarnessReportFailure("source-conflict", pure);
    }
  }
  const reportPure = pureCheckReason(revision.report);
  if (reportPure !== null) {
    return createNativeHarnessReportFailure("source-conflict", reportPure);
  }
  const local = localReportIdentityProblem(state, binding);
  if (local !== null) return createNativeHarnessReportFailure("source-conflict", local);
  return null;
}

/**
 * Repeats the bounded host reads for one existing preparation. It never
 * rebuilds facts, mints refs, rereads files or changes retained action state.
 */
function refreshReportPreparation(
  state: CoordinatorState,
  binding: ReportBindingState,
): string | null {
  try {
    return refreshReportPreparationUnchecked(state, binding);
  } catch {
    return "the host-only report refresh failed unexpectedly";
  }
}

function refreshReportPreparationUnchecked(
  state: CoordinatorState,
  binding: ReportBindingState,
): string | null {
  if (state.disposed) return "the delegation coordinator was disposed";
  if (!state.enabled) return "the delegation coordinator is disabled";
  if (state.reportBindingInProgress) {
    return "reentrant report binding preparation or refresh was refused";
  }
  state.reportBindingInProgress = true;
  try {
    if (binding.slot.output.reportCurrentUseRefusal !== null) {
      return binding.slot.output.reportCurrentUseRefusal;
    }
    const local = localReportIdentityProblem(state, binding);
    if (local !== null) return local;
    const reportSignal = readActualAbortSignal(binding.reportSignal);
    if (!reportSignal.ok) return reportSignal.reason;
    if (reportSignal.aborted) return "the actual report signal was aborted";
    const main = readMainContext(state);
    if (!main.ok) return main.reason;
    const source = prepareCheckSource(state, binding.slot);
    if (isCheckFailure(source)) return source.reason;
    if (source.capture !== binding.capture
      || source.registration !== binding.registration
      || source.prepared.observedSha256 !== binding.observedSha256
      || source.prepared.observedBytes !== binding.observedBytes) {
      return "the original source capture or observation changed";
    }
    const report = prepareReportRefCheck(state, binding.reportRef, source.prepared.context, binding.request);
    if (isReportFailure(report)) return report.reason;
    const selected = prepareReportSelections(state, binding, source.prepared.context);
    if (isReportFailure(selected)) return selected.reason;
    const lateMain = readMainContext(state);
    if (!lateMain.ok) return lateMain.reason;
    const lateReport = prepareReportRefCheck(state, binding.reportRef, lateMain.context, binding.request);
    if (isReportFailure(lateReport)) return lateReport.reason;
    if (!sameActionAssociation(report.association, lateReport.association)
      || report.inspection.callInputSha256 !== lateReport.inspection.callInputSha256
      || lateReport.inspection.callInputSha256 !== binding.reportInputSha256
      || lateReport.association.toolCallId !== binding.reportId) {
      return "the report reference association or input changed during refresh";
    }
    const revision: ReportBindingRevision = {
      source,
      report: lateReport.check,
      reportInspection: lateReport.inspection,
      reportAssociation: lateReport.association,
      selected,
    };
    const final = finalReportGate(state, binding, revision, binding.reportSignal);
    if (final !== null) return final.reason;
    binding.revision = revision;
    return null;
  } finally {
    state.reportBindingInProgress = false;
  }
}

/**
 * Captured-identity check. Only the declared pure original owner predicate,
 * the exact retained report signal, the captured native pure validators and
 * local exact identities run; no current host-context read, I/O, clock or
 * encoding is performed. Returns only null or a bounded primitive refusal.
 */
function revalidateReportPreparation(
  state: CoordinatorState,
  binding: ReportBindingState,
): string | null {
  try {
    return revalidateReportPreparationUnchecked(state, binding);
  } catch {
    return "the host-only report revalidation failed unexpectedly";
  }
}

function revalidateReportPreparationUnchecked(
  state: CoordinatorState,
  binding: ReportBindingState,
): string | null {
  if (state.disposed) return "the delegation coordinator was disposed";
  if (!state.enabled) return "the delegation coordinator is disabled";
  const revision = binding.revision;
  const owner = ownerPredicateReason(revision.source.output);
  if (owner !== null) return owner;
  const reportSignal = readActualAbortSignal(binding.reportSignal);
  if (!reportSignal.ok) return reportSignal.reason;
  if (reportSignal.aborted) return "the actual report signal was aborted";
  const sourcePure = pureCheckReason(revision.source.prepared.check);
  if (sourcePure !== null) return sourcePure;
  for (const selected of revision.selected) {
    const pure = pureCheckReason(selected.action.check);
    if (pure !== null) return pure;
  }
  const reportPure = pureCheckReason(revision.report);
  if (reportPure !== null) return reportPure;
  const local = localReportIdentityProblem(state, binding);
  if (local !== null) return local;
  if (!isRecord(revision.reportInspection.association)
    || !sameActionAssociation(revision.reportInspection.association, revision.reportAssociation)
    || revision.reportInspection.callInputSha256 !== binding.reportInputSha256) {
    return "the captured report reference identity changed";
  }
  return null;
}

/**
 * Fixed sticky current-use refusal. It is set only by positive evidence from
 * an admitted authoritative reread and is never cleared by restoration,
 * another report id or a caller-held preparation.
 */
const REPORT_REREAD_DRIFT_REASON = "an authenticated report reread observed a changed current source";

function reportRereadFailure(
  code: NativeHarnessReportRereadFailureCode,
  reason: string,
  attempt?: number,
): NativeHarnessReportRereadFailure {
  return createNativeHarnessReportRereadFailure(code, reason, attempt);
}

function reportRereadSelectionOf(binding: ReportBindingState): ReportRereadSelection {
  return Object.freeze({
    sourceToolCallId: binding.request.selection.sourceToolCallId,
    captureId: binding.request.selection.captureId,
    captureDigest: binding.request.selection.captureDigest,
    checkToolCallIds: Object.freeze([...binding.request.selection.checkToolCallIds]),
  });
}

function sameReportRereadSelection(
  left: ReportRereadSelection,
  right: NativeHarnessReportSelection,
): boolean {
  if (left.sourceToolCallId !== right.sourceToolCallId
    || left.captureId !== right.captureId
    || left.captureDigest !== right.captureDigest
    || left.checkToolCallIds.length !== right.checkToolCallIds.length) {
    return false;
  }
  for (let index = 0; index < left.checkToolCallIds.length; index += 1) {
    if (left.checkToolCallIds[index] !== right.checkToolCallIds[index]) return false;
  }
  return true;
}

/**
 * Exact immutable admission inputs of one retained reread. Changed
 * authenticated input or a different actual signal can only be refused.
 */
function sameReportRereadRecord(
  record: ReportRereadRecord,
  binding: ReportBindingState,
): boolean {
  return record.sourceId === binding.sourceId
    && record.reportId === binding.reportId
    && record.reportRef === binding.reportRef
    && record.reportInputSha256 === binding.reportInputSha256
    && record.outcome === binding.request.outcome
    && record.reportSignal === binding.reportSignal
    && record.capture === binding.capture
    && record.outputSelection === binding.outputSelection
    && record.registration === binding.registration
    && record.checks === binding.checks
    && sameReportRereadSelection(record.selection, binding.request.selection);
}

function findReportRereadRecord(slot: Slot, reportId: string): ReportRereadRecord | null {
  const records = slot.output.reportRecords;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record !== undefined && record.reportId === reportId) return record;
  }
  return null;
}

/** Bounded cross-Slot scan for a report id already retained elsewhere. */
function findForeignReportRereadRecord(
  state: CoordinatorState,
  sourceSlot: Slot,
  reportId: string,
): ReportRereadRecord | null {
  for (const slot of state.slots.values()) {
    if (slot === sourceSlot) continue;
    const record = findReportRereadRecord(slot, reportId);
    if (record !== null) return record;
  }
  return null;
}

function markReportCurrentUseRefusal(slot: Slot): void {
  if (slot.output.reportCurrentUseRefusal === null) {
    slot.output.reportCurrentUseRefusal = REPORT_REREAD_DRIFT_REASON;
  }
}

function readReportRereadClock(
  state: CoordinatorState,
  runtime: ReportReadRuntime,
): { readonly ok: true; readonly now: number }
  | { readonly ok: false; readonly failure: NativeHarnessReportRereadFailure } {
  const record = runtime.record;
  const now = readClock(state.now);
  if (now === null) {
    return {
      ok: false,
      failure: reportRereadFailure("deadline", "the report reread clock is unavailable", record.attempt),
    };
  }
  if (now < record.startedAt || now < runtime.lastClock) {
    return {
      ok: false,
      failure: reportRereadFailure(
        "deadline",
        "the report reread clock moved backwards",
        record.attempt,
      ),
    };
  }
  if (now > runtime.deadlineAt) {
    return {
      ok: false,
      failure: reportRereadFailure("deadline", "the report reread budget expired", record.attempt),
    };
  }
  runtime.lastClock = now;
  return { ok: true, now };
}

function sameReportRereadRuntimeIdentity(
  record: ReportRereadRecord,
  binding: ReportBindingState,
  runtime: ReportReadRuntime,
): boolean {
  const slot = runtime.slot;
  return runtime.binding === binding
    && record.runtime === runtime
    && binding.slot === slot
    && binding.reportRef === record.reportRef
    && binding.reportInputSha256 === record.reportInputSha256
    && binding.reportSignal === record.reportSignal
    && binding.capture === record.capture
    && binding.outputSelection === record.outputSelection
    && binding.registration === record.registration
    && binding.checks === record.checks
    && sameReportRereadSelection(record.selection, binding.request.selection)
    && slot.output.capture === record.capture
    && slot.output.selection === record.outputSelection
    && slot.output.registration === record.registration
    && slot.output.checks === record.checks;
}

/**
 * Cooperative leaf guard: fresh current binding and clock, then the final
 * pure owner/signal/native checks and exact report ownership. It reads the
 * runtime through the retained record and never retains facts itself.
 */
function reportRereadGuard(
  state: CoordinatorState,
  runtime: ReportReadRuntime,
): NativeHarnessReportRereadFailure | null {
  const record = runtime.record;
  const slot = runtime.slot;
  const binding = runtime.binding;
  const attempt = record.attempt;
  if (runtime.guardFailure !== null) return runtime.guardFailure;
  if (state.disposed) {
    return reportRereadFailure("authority-lost", "the delegation coordinator was disposed", attempt);
  }
  if (!state.enabled) {
    return reportRereadFailure("authority-lost", "the delegation coordinator is disabled", attempt);
  }
  if (state.slots.get(record.sourceId) !== slot) {
    return reportRereadFailure("authority-lost", "the original source Slot was replaced", attempt);
  }
  if (slot.output.reportActive !== runtime) {
    return reportRereadFailure("authority-lost", "the report reread owner changed", attempt);
  }
  if (state.outputActive !== slot || state.outputReservedBytes !== runtime.reservation) {
    return reportRereadFailure("authority-lost", "the report reread reservation was replaced", attempt);
  }
  const signal = readActualAbortSignal(record.reportSignal);
  if (!signal.ok) return reportRereadFailure("invalid-caller", signal.reason, attempt);
  if (signal.aborted) {
    return reportRereadFailure("cancelled", "the actual report signal was aborted during the reread", attempt);
  }
  if (binding === null) {
    return reportRereadFailure("authority-lost", "the report reread binding was cleared", attempt);
  }
  // Complete the fresh host refresh before the bounded clock read so a late
  // prepare/getContext callback cannot leave a stale admitted interval.
  const refresh = refreshReportPreparation(state, binding);
  if (refresh !== null) return reportRereadFailure("authority-lost", refresh, attempt);
  const clock = readReportRereadClock(state, runtime);
  if (!clock.ok) return clock.failure;
  const revalidated = revalidateReportPreparation(state, binding);
  if (revalidated !== null) return reportRereadFailure("authority-lost", revalidated, attempt);
  if (!sameReportRereadRuntimeIdentity(record, binding, runtime)) {
    return reportRereadFailure("authority-lost", "the retained report reread identity changed", attempt);
  }
  return null;
}

/**
 * Final settlement gate. It reuses the accepted binding-only validator for
 * the original owner/signal/native/local authority, then adds only the exact
 * active runtime, record and held-reservation ownership facts.
 */
function reportRereadFinalGate(
  state: CoordinatorState,
  runtime: ReportReadRuntime,
): NativeHarnessReportRereadFailure | null {
  const record = runtime.record;
  const binding = runtime.binding;
  const slot = runtime.slot;
  const attempt = record.attempt;
  // A cancellation/control refusal that landed in any last host callback wins.
  if (runtime.guardFailure !== null) return runtime.guardFailure;
  if (binding === null) {
    return reportRereadFailure("authority-lost", "the report reread binding was cleared", attempt);
  }
  const revalidated = revalidateReportPreparation(state, binding);
  if (revalidated !== null) {
    return reportRereadFailure("authority-lost", revalidated, attempt);
  }
  if (state.slots.get(record.sourceId) !== slot) {
    return reportRereadFailure("authority-lost", "the original source Slot was replaced", attempt);
  }
  if (state.outputActive !== slot
    || slot.output.reportActive !== runtime
    || state.outputReservedBytes !== runtime.reservation) {
    return reportRereadFailure("authority-lost", "the report reread reservation was released", attempt);
  }
  if (!sameReportRereadRuntimeIdentity(record, binding, runtime)) {
    return reportRereadFailure("authority-lost", "the report reread identity changed before settlement", attempt);
  }
  return null;
}

/**
 * Admission final sequence: owner predicate, actual report signal, every
 * prepared native pure check, then local refs/capacity/attempt facts.
 */
function reportRereadAdmissionGate(
  state: CoordinatorState,
  binding: ReportBindingState,
  slot: Slot,
  out: SlotOutput,
): NativeHarnessReportRereadFailure | null {
  const revision = binding.revision;
  const owner = ownerPredicateReason(revision.source.output);
  if (owner !== null) return reportRereadFailure("authority-lost", owner);
  const signal = readActualAbortSignal(binding.reportSignal);
  if (!signal.ok) return reportRereadFailure("invalid-caller", signal.reason);
  if (signal.aborted) {
    return reportRereadFailure("cancelled", "the actual report signal was aborted before the reread");
  }
  const sourcePure = pureCheckReason(revision.source.prepared.check);
  if (sourcePure !== null) return reportRereadFailure("authority-lost", sourcePure);
  for (const selected of revision.selected) {
    const pure = pureCheckReason(selected.action.check);
    if (pure !== null) return reportRereadFailure("authority-lost", pure);
  }
  const reportPure = pureCheckReason(revision.report);
  if (reportPure !== null) return reportRereadFailure("authority-lost", reportPure);
  if (state.disposed) {
    return reportRereadFailure("authority-lost", "the delegation coordinator was disposed");
  }
  if (!state.enabled) {
    return reportRereadFailure("authority-lost", "the delegation coordinator is disabled");
  }
  if (state.slots.get(binding.sourceId) !== slot) {
    return reportRereadFailure("authority-lost", "the original source Slot was replaced");
  }
  if (state.outputActive !== null) {
    return reportRereadFailure("capacity", "another output capture or report reread is in flight");
  }
  if (state.outputBytes + state.outputReservedBytes + NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES
    > NATIVE_HARNESS_MAX_OUTPUT_BYTES) {
    return reportRereadFailure("capacity", "the retained output byte budget is exhausted or reserved");
  }
  if (out.reportAttempts >= NATIVE_HARNESS_REPORT_MAX_REREAD_ATTEMPTS) {
    return reportRereadFailure("capacity", "the bounded report reread attempt budget is exhausted");
  }
  if (out.reportRecords.length >= NATIVE_HARNESS_REPORT_MAX_REREAD_ATTEMPTS) {
    return reportRereadFailure("capacity", "the bounded report reread record budget is exhausted");
  }
  if (out.reportCurrentUseRefusal !== null) {
    return reportRereadFailure("version-mismatch", out.reportCurrentUseRefusal);
  }
  if (out.capture !== binding.capture
    || out.selection !== binding.outputSelection
    || out.registration !== binding.registration
    || out.checks !== binding.checks) {
    return reportRereadFailure("authority-lost", "the original capture or selected refs changed");
  }
  return null;
}

function reportRereadFailureFromEnvelope(
  decoded: DecodedCaptureEnvelope,
  attempt: number,
): NativeHarnessReportRereadFailure {
  const reason = typeof decoded.reason === "string"
    ? decoded.reason
    : "the trusted output reread refused";
  const code: NativeHarnessReportRereadFailureCode = decoded.code === "aborted"
    ? "cancelled"
    : decoded.code === "deadline"
      ? "deadline"
      : decoded.code === "authority-lost"
        ? "authority-lost"
        : decoded.code === "invalid-control"
          ? "invalid-caller"
          : "reread-unavailable";
  return reportRereadFailure(code, reason, attempt);
}

function reportRereadFailureFromOutput(
  failure: NativeHarnessOutputSelectionFailure,
  attempt: number,
): NativeHarnessReportRereadFailure {
  const code: NativeHarnessReportRereadFailureCode = failure.code === "cancelled"
    ? "cancelled"
    : failure.code === "deadline"
      ? "deadline"
      : failure.code === "authority-lost"
        ? "authority-lost"
        : failure.code === "invalid-caller"
          ? "invalid-caller"
          : failure.code === "capacity"
            ? "capacity"
            : "reread-unavailable";
  return reportRereadFailure(code, failure.reason, attempt);
}

type ReportRereadEvaluation =
  | { readonly kind: "failure"; readonly failure: NativeHarnessReportRereadFailure }
  | { readonly kind: "match" }
  | { readonly kind: "drift"; readonly failure: NativeHarnessReportRereadFailure };

function reportRereadFailureEvaluation(
  failure: NativeHarnessReportRereadFailure,
): ReportRereadEvaluation {
  return { kind: "failure", failure };
}

/** Control codes can never become positive drift evidence. */
function isReportRereadControlEnvelopeCode(code: unknown): boolean {
  return code === "aborted"
    || code === "deadline"
    || code === "authority-lost"
    || code === "invalid-control";
}

/**
 * Decodes the trusted envelope once and compares a genuine issued capture with
 * the original through the A1 helper. It deliberately performs no clock,
 * refresh, final gate or sticky write: those belong to the settlement seal.
 * Comparison invalid-binding is unavailability, not drift.
 */
function evaluateReportRereadLeaf(
  runtime: ReportReadRuntime,
  leaf: unknown,
): ReportRereadEvaluation {
  const record = runtime.record;
  const binding = runtime.binding;
  const attempt = record.attempt;
  if (runtime.guardFailure !== null) {
    return reportRereadFailureEvaluation(runtime.guardFailure);
  }
  if (binding === null) {
    return reportRereadFailureEvaluation(
      reportRereadFailure("authority-lost", "the report reread binding was cleared", attempt),
    );
  }
  const decoded = decodeCaptureEnvelope(leaf);
  if (decoded === null) {
    return reportRereadFailureEvaluation(reportRereadFailure(
      "reread-unavailable",
      "the trusted output reread returned an unreadable result",
      attempt,
    ));
  }
  if (!decoded.ok) {
    if (decoded.mismatch === true && isReportRereadControlEnvelopeCode(decoded.code)) {
      // An inconsistent marker on a control refusal never proves drift.
      return reportRereadFailureEvaluation(reportRereadFailureFromEnvelope(decoded, attempt));
    }
    if (decoded.mismatch === true) {
      return {
        kind: "drift",
        failure: reportRereadFailure(
          "version-mismatch",
          "the reread returned a trusted observed-mismatch marker",
          attempt,
        ),
      };
    }
    return reportRereadFailureEvaluation(reportRereadFailureFromEnvelope(decoded, attempt));
  }
  const read = readCaptureValue(
    decoded.capture,
    runtime.slot,
    binding.revision.source.output,
    record.registration,
  );
  if (!read.ok) {
    return reportRereadFailureEvaluation(reportRereadFailureFromOutput(read, attempt));
  }
  const backend = runtime.slot.backend === null ? undefined : runtime.slot.backend.receiver;
  if (backend === undefined) {
    return reportRereadFailureEvaluation(reportRereadFailure(
      "authority-lost",
      "the original output backend is unavailable",
      attempt,
    ));
  }
  const comparison = compareNativeHarnessOutputVersion(
    backend,
    record.capture,
    read.capture,
  );
  if (comparison.ok) return { kind: "match" };
  if (comparison.code === "version-mismatch") {
    return {
      kind: "drift",
      failure: reportRereadFailure(
        "version-mismatch",
        `the reread capture differs at the ${comparison.section} section`,
        attempt,
      ),
    };
  }
  return reportRereadFailureEvaluation(reportRereadFailure(
    "reread-unavailable",
    "the reread capture binding could not be compared",
    attempt,
  ));
}

async function captureReportRereadLeaf(
  state: CoordinatorState,
  runtime: ReportReadRuntime,
  output: OutputPort,
): Promise<ReportRereadEvaluation> {
  const record = runtime.record;
  const controller = runtime.controller;
  if (controller === null) {
    return reportRereadFailureEvaluation(
      reportRereadFailure("authority-lost", "the report reread controller was cleared", record.attempt),
    );
  }
  const guard = (): void => {
    const gate = reportRereadGuard(state, runtime);
    if (gate !== null) {
      if (runtime.guardFailure === null) runtime.guardFailure = gate;
      throw new NativeHarnessDelegationError(gate.reason);
    }
  };
  let raw: unknown;
  let threw = false;
  try {
    raw = Reflect.apply(output.capture, output.receiver, [
      runtime.slot.backend === null ? null : runtime.slot.backend.receiver,
      guard,
      controller.signal,
    ]);
  } catch {
    threw = true;
  }
  if (threw) {
    return reportRereadFailureEvaluation(runtime.guardFailure ?? reportRereadFailure(
      "reread-unavailable",
      "the trusted output reread threw",
      record.attempt,
    ));
  }
  if (!consumeNativePromise(raw)) {
    return reportRereadFailureEvaluation(runtime.guardFailure ?? reportRereadFailure(
      "reread-unavailable",
      "the trusted output reread did not return a native Promise",
      record.attempt,
    ));
  }
  let leaf: unknown;
  let rejected = false;
  try {
    leaf = await (raw as Promise<unknown>);
  } catch {
    rejected = true;
  }
  if (rejected) {
    return reportRereadFailureEvaluation(runtime.guardFailure ?? reportRereadFailure(
      "reread-unavailable",
      "the trusted output reread rejected",
      record.attempt,
    ));
  }
  return evaluateReportRereadLeaf(runtime, leaf);
}

/**
 * Exact-owner release. BOTH the Slot's exact report owner and the root shared
 * gate must still name this runtime before either owner is cleared or the
 * runtime reservation is subtracted. A stale runtime never releases another
 * same-Slot report owner's gate.
 */
function releaseReportReadReservation(
  state: CoordinatorState,
  runtime: ReportReadRuntime,
): void {
  if (runtime.reservation === 0) return;
  const slot = runtime.slot;
  if (slot.output.reportActive !== runtime || state.outputActive !== slot) return;
  slot.output.reportActive = null;
  state.outputReservedBytes = Math.max(0, state.outputReservedBytes - runtime.reservation);
  state.outputActive = null;
  runtime.reservation = 0;
}

/** Removes the report-signal listener and drops its controller reference. */
function removeReportRereadListener(runtime: ReportReadRuntime): void {
  const cleanup = runtime.cleanup;
  runtime.cleanup = null;
  runtime.controller = null;
  if (cleanup === null) return;
  try {
    cleanup();
  } catch {
    // Best-effort listener removal.
  }
}

/**
 * Settlement seal. It runs at the actual record.result/deferred boundary after
 * the leaf's async continuation, completes the fresh host refresh, performs
 * the final bounded clock read and listener cleanup, then runs the last pure
 * owner/signal/native/local gates. No host callback follows that gate; only
 * owned metadata, the sticky current-use fact and the deferred resolution.
 */
function sealReportReread(
  state: CoordinatorState,
  runtime: ReportReadRuntime,
  evaluation: ReportRereadEvaluation,
): NativeHarnessReportRereadResult {
  const record = runtime.record;
  const attempt = record.attempt;
  if (runtime.guardFailure !== null) {
    removeReportRereadListener(runtime);
    return runtime.guardFailure;
  }
  const binding = runtime.binding;
  if (binding === null) {
    removeReportRereadListener(runtime);
    return reportRereadFailure("authority-lost", "the report reread binding was cleared", attempt);
  }
  // External preparation reads finish first so the final clock cannot be stale.
  const refresh = refreshReportPreparation(state, binding);
  if (runtime.guardFailure !== null) {
    removeReportRereadListener(runtime);
    return runtime.guardFailure;
  }
  if (state.disposed) {
    removeReportRereadListener(runtime);
    return reportRereadFailure("authority-lost", "the delegation coordinator was disposed", attempt);
  }
  if (refresh !== null) {
    removeReportRereadListener(runtime);
    const signal = readActualAbortSignal(record.reportSignal);
    return signal.ok && signal.aborted
      ? reportRereadFailure("cancelled", "the actual report signal was aborted before sealing", attempt)
      : reportRereadFailure("authority-lost", refresh, attempt);
  }
  // The final bounded clock read includes the outer async continuation.
  const clock = readReportRereadClock(state, runtime);
  if (runtime.guardFailure !== null) {
    removeReportRereadListener(runtime);
    return runtime.guardFailure;
  }
  if (state.disposed) {
    removeReportRereadListener(runtime);
    return reportRereadFailure("authority-lost", "the delegation coordinator was disposed", attempt);
  }
  if (!clock.ok) {
    removeReportRereadListener(runtime);
    return clock.failure;
  }
  // Listener cleanup is the last external callback before the pure gate.
  removeReportRereadListener(runtime);
  const final = reportRereadFinalGate(state, runtime);
  if (final !== null) return final;
  let result: NativeHarnessReportRereadResult;
  if (evaluation.kind === "match") {
    const success = createNativeHarnessReportRereadSuccess({
      sourceToolCallId: record.sourceId,
      reportToolCallId: record.reportId,
      reportInputSha256: record.reportInputSha256,
      captureId: record.capture.captureId,
      captureDigest: record.capture.digest,
      attempt,
      startedAt: record.startedAt,
      finishedAt: clock.now,
    });
    result = success ?? reportRereadFailure(
      "reread-unavailable",
      "the reread success metadata was malformed",
      attempt,
    );
  } else {
    result = evaluation.failure;
  }
  // Sticky drift becomes visible only after every final gate passed and no
  // control failure won. Historical data and the interval result are unchanged.
  if (evaluation.kind === "drift") markReportCurrentUseRefusal(runtime.slot);
  return result;
}

/**
 * Drains exactly once: clear every active runtime ref, release the held
 * reservation only for the exact two-owner match, then resolve the original
 * deferred Promise. The settled record keeps compact refs only.
 */
function settleReportReread(
  state: CoordinatorState,
  runtime: ReportReadRuntime,
  result: NativeHarnessReportRereadResult,
): void {
  const record = runtime.record;
  if (record.runtime !== runtime) return;
  // Normal sealing removed this before the last pure gate; this only covers
  // an unexpected task rejection that never reached the seal.
  if (runtime.cleanup !== null) removeReportRereadListener(runtime);
  const settled = runtime.settled;
  runtime.controller = null;
  runtime.binding = null;
  runtime.guardFailure = null;
  runtime.settled = null;
  record.result = result;
  record.runtime = null;
  releaseReportReadReservation(state, runtime);
  settled?.resolve(result);
}

async function runReportReread(
  state: CoordinatorState,
  runtime: ReportReadRuntime,
): Promise<void> {
  const record = runtime.record;
  let evaluation: ReportRereadEvaluation;
  try {
    const binding = runtime.binding;
    const output = binding === null ? null : binding.revision.source.output;
    if (output === null) {
      evaluation = reportRereadFailureEvaluation(reportRereadFailure(
        "authority-lost",
        "the trusted output port is unavailable",
        record.attempt,
      ));
    } else {
      evaluation = await captureReportRereadLeaf(state, runtime, output);
    }
  } catch (error) {
    evaluation = reportRereadFailureEvaluation(runtime.guardFailure ?? reportRereadFailure(
      "reread-unavailable",
      `the report reread failed unexpectedly: ${outputThrownReason(error, "report reread failed")}`,
      record.attempt,
    ));
  }
  // Recheck at the actual record.result / deferred boundary, then seal with no
  // await or external callback between the final gate and the resolution.
  const result = sealReportReread(state, runtime, evaluation);
  settleReportReread(state, runtime, result);
}

function reportRereadCancelled(
  runtime: ReportReadRuntime,
  reason: string,
): boolean {
  if (runtime.guardFailure !== null) return false;
  runtime.guardFailure = reportRereadFailure("cancelled", reason, runtime.record.attempt);
  const controller = runtime.controller;
  if (controller !== null) {
    try {
      controller.abort(new Error(reason));
    } catch {
      // The local reread signal is already aborted.
    }
  }
  return true;
}

/** Exact active report-id cancellation; it never scans or steals a source id. */
function cancelReportReread(state: CoordinatorState, reportId: string): boolean {
  for (const slot of state.slots.values()) {
    const out = slot.output;
    for (const record of out.reportRecords) {
      if (record.reportId !== reportId) continue;
      const runtime = record.runtime;
      if (runtime === null || out.reportActive !== runtime) continue;
      return reportRereadCancelled(runtime, "the report reread was cancelled by the host");
    }
  }
  return false;
}

/** Independent disposal path; it is not nested under capture-action cleanup. */
function cancelSlotReportReread(state: CoordinatorState, slot: Slot): void {
  for (const record of slot.output.reportRecords) {
    const runtime = record.runtime;
    if (runtime === null) continue;
    reportRereadCancelled(runtime, "the report reread was cancelled by coordinator disposal");
  }
}

type ReportRereadStart =
  | { readonly kind: "failure"; readonly failure: NativeHarnessReportRereadFailure }
  | {
    readonly kind: "join";
    readonly record: ReportRereadRecord;
    readonly promise: Promise<NativeHarnessReportRereadResult>;
  }
  | {
    readonly kind: "admit";
    readonly runtime: ReportReadRuntime;
    readonly dispatch: () => void;
  };

/**
 * Synchronous admission or exact join. All host reads finish before the final
 * pure gate; the listener exists before it and is cleaned on refusal.
 */
function startReportReread(
  state: CoordinatorState,
  binding: ReportBindingState,
): ReportRereadStart {
  if (state.disposed) {
    return { kind: "failure", failure: reportRereadFailure("authority-lost", "the delegation coordinator was disposed") };
  }
  if (!state.enabled) {
    return { kind: "failure", failure: reportRereadFailure("authority-lost", "the delegation coordinator is disabled") };
  }
  const slot = state.slots.get(binding.sourceId);
  if (slot === undefined || slot !== binding.slot) {
    return { kind: "failure", failure: reportRereadFailure("authority-lost", "the original source Slot was replaced") };
  }
  if (slot.toolCallId !== binding.sourceId) {
    return { kind: "failure", failure: reportRereadFailure("authority-lost", "the original source Slot id changed") };
  }
  const out = slot.output;
  if (findForeignReportRereadRecord(state, slot, binding.reportId) !== null) {
    return {
      kind: "failure",
      failure: reportRereadFailure("invalid-caller", "the report id is retained by another source"),
    };
  }
  if (out.reportCurrentUseRefusal !== null) {
    return { kind: "failure", failure: reportRereadFailure("version-mismatch", out.reportCurrentUseRefusal) };
  }

  const existing = findReportRereadRecord(slot, binding.reportId);
  if (existing !== null) {
    if (!sameReportRereadRecord(existing, binding)) {
      return {
        kind: "failure",
        failure: reportRereadFailure(
          "invalid-caller",
          "different report inputs cannot join or restart the retained reread",
        ),
      };
    }
    if (existing.runtime === null && existing.result === null) {
      return {
        kind: "failure",
        failure: reportRereadFailure("authority-lost", "the retained report reread lost its active runtime"),
      };
    }
    const refresh = refreshReportPreparation(state, binding);
    if (refresh !== null) {
      return { kind: "failure", failure: reportRereadFailure("authority-lost", refresh) };
    }
    const revalidated = revalidateReportPreparation(state, binding);
    if (revalidated !== null) {
      return { kind: "failure", failure: reportRereadFailure("authority-lost", revalidated) };
    }
    if (state.slots.get(binding.sourceId) !== slot
      || slot.output.reportRecords.indexOf(existing) < 0
      || !sameReportRereadRecord(existing, binding)) {
      return {
        kind: "failure",
        failure: reportRereadFailure("authority-lost", "the retained report reread record changed"),
      };
    }
    return { kind: "join", record: existing, promise: existing.promise };
  }

  if (out.reportAttempts >= NATIVE_HARNESS_REPORT_MAX_REREAD_ATTEMPTS
    || out.reportRecords.length >= NATIVE_HARNESS_REPORT_MAX_REREAD_ATTEMPTS) {
    return {
      kind: "failure",
      failure: reportRereadFailure("capacity", "the bounded report reread attempt budget is exhausted"),
    };
  }
  const signal = readActualAbortSignal(binding.reportSignal);
  if (!signal.ok) {
    return { kind: "failure", failure: reportRereadFailure("invalid-caller", signal.reason) };
  }
  if (signal.aborted) {
    return {
      kind: "failure",
      failure: reportRereadFailure("cancelled", "the actual report signal was aborted before the reread"),
    };
  }
  const startedAt = readClock(state.now);
  if (startedAt === null) {
    return { kind: "failure", failure: reportRereadFailure("deadline", "the report reread clock is unavailable") };
  }
  const initialCapacity = reportRereadAdmissionCapacity(state);
  if (initialCapacity !== null) return { kind: "failure", failure: initialCapacity };

  const refresh = refreshReportPreparation(state, binding);
  if (refresh !== null) {
    return { kind: "failure", failure: reportRereadFailure("authority-lost", refresh) };
  }
  const revalidated = revalidateReportPreparation(state, binding);
  if (revalidated !== null) {
    return { kind: "failure", failure: reportRereadFailure("authority-lost", revalidated) };
  }

  // Callbacks may reenter. Recheck local capacity before creating the listener.
  if (state.disposed || !state.enabled || state.slots.get(binding.sourceId) !== slot) {
    return {
      kind: "failure",
      failure: reportRereadFailure("authority-lost", "the original source Slot changed during admission"),
    };
  }
  if (out.reportAttempts >= NATIVE_HARNESS_REPORT_MAX_REREAD_ATTEMPTS
    || out.reportRecords.length >= NATIVE_HARNESS_REPORT_MAX_REREAD_ATTEMPTS) {
    return {
      kind: "failure",
      failure: reportRereadFailure("capacity", "the bounded report reread attempt budget is exhausted"),
    };
  }
  const lateCapacity = reportRereadAdmissionCapacity(state);
  if (lateCapacity !== null) return { kind: "failure", failure: lateCapacity };

  const combined = createCaptureController(binding.reportSignal as AbortSignal);
  if (!combined.ok) {
    return { kind: "failure", failure: reportRereadFailure("invalid-caller", combined.reason) };
  }
  let final: NativeHarnessReportRereadFailure | null;
  try {
    final = reportRereadAdmissionGate(state, binding, slot, out);
  } catch (error) {
    try {
      combined.cleanup();
    } catch {
      // Best-effort listener removal.
    }
    return {
      kind: "failure",
      failure: reportRereadFailure(
        "reread-unavailable",
        `the report reread admission gate failed: ${outputThrownReason(error, "report reread failed")}`,
      ),
    };
  }
  if (final !== null) {
    try {
      combined.cleanup();
    } catch {
      // Best-effort listener removal.
    }
    return { kind: "failure", failure: final };
  }

  // Reserve and install the exact owner/deferred Promise before the leaf can
  // run any callback. No capture-specific field on the output is changed.
  const attempt = out.reportAttempts + 1;
  const pending = deferred<NativeHarnessReportRereadResult>();
  const record: ReportRereadRecord = {
    attempt,
    sourceId: binding.sourceId,
    reportId: binding.reportId,
    reportRef: binding.reportRef,
    reportInputSha256: binding.reportInputSha256,
    outcome: binding.request.outcome,
    reportSignal: binding.reportSignal,
    capture: binding.capture,
    outputSelection: binding.outputSelection,
    registration: binding.registration,
    checks: binding.checks,
    selection: reportRereadSelectionOf(binding),
    startedAt,
    promise: pending.promise,
    result: null,
    runtime: null,
  };
  const runtime: ReportReadRuntime = {
    record,
    slot,
    binding,
    controller: combined.controller,
    cleanup: combined.cleanup,
    reservation: NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES,
    deadlineAt: startedAt + NATIVE_HARNESS_OUTPUT_CAPTURE_BUDGET_MS,
    lastClock: startedAt,
    guardFailure: null,
    settled: pending,
  };
  record.runtime = runtime;
  out.reportRecords.push(record);
  out.reportAttempts = attempt;
  out.reportActive = runtime;
  state.outputReservedBytes += runtime.reservation;
  state.outputActive = slot;
  return {
    kind: "admit",
    runtime,
    dispatch: () => {
      void runReportReread(state, runtime).then(undefined, () => {
        settleReportReread(
          state,
          runtime,
          reportRereadFailure(
            "reread-unavailable",
            "the report reread task failed unexpectedly",
            record.attempt,
          ),
        );
      });
    },
  };
}

function reportRereadAdmissionCapacity(
  state: CoordinatorState,
): NativeHarnessReportRereadFailure | null {
  if (state.outputActive !== null) {
    return reportRereadFailure("capacity", "another output capture or report reread is in flight");
  }
  if (state.outputBytes + state.outputReservedBytes + NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES
    > NATIVE_HARNESS_MAX_OUTPUT_BYTES) {
    return reportRereadFailure("capacity", "the retained output byte budget is exhausted or reserved");
  }
  return null;
}

/**
 * One bounded synchronous admission/join guard before any external callback.
 * A reentrant refusal consumes zero and cannot clear the outer owner's guard.
 */
function beginReportReread(
  state: CoordinatorState,
  binding: ReportBindingState,
  onAdmitted: (record: ReportRereadRecord) => void,
): Promise<NativeHarnessReportRereadResult> {
  if (state.reportRereadInProgress) {
    return Promise.resolve(reportRereadFailure(
      "not-ready",
      "reentrant report reread admission or join was refused",
    ));
  }
  state.reportRereadInProgress = true;
  let start: ReportRereadStart;
  try {
    start = startReportReread(state, binding);
  } catch (error) {
    start = {
      kind: "failure",
      failure: reportRereadFailure(
        "reread-unavailable",
        `the report reread admission failed: ${outputThrownReason(error, "report reread failed")}`,
      ),
    };
  } finally {
    state.reportRereadInProgress = false;
  }
  if (start.kind === "failure") return Promise.resolve(start.failure);
  if (start.kind === "join") {
    onAdmitted(start.record);
    return start.promise;
  }
  onAdmitted(start.runtime.record);
  start.dispatch();
  return start.runtime.record.promise;
}

/**
 * Publication readiness layered on the binding-only validator. Before any
 * admitted/joined reread it adds nothing; afterwards pending or failed
 * attempts cannot authorize publication, and the exact success must match
 * the retained record.
 */
function reportPublicationReadiness(
  state: CoordinatorState,
  binding: ReportBindingState,
  record: ReportRereadRecord | null,
): string | null {
  if (record === null) return null;
  const slot = binding.slot;
  if (state.slots.get(record.sourceId) !== slot) return "the original source Slot was replaced";
  if (slot.output.reportRecords.indexOf(record) < 0) return "the report reread record was not retained";
  if (!sameReportRereadRecord(record, binding)) return "the report reread record is not this preparation";
  const result = record.result;
  if (result === null) return "the report reread is still pending";
  if (!result.ok) return "the report reread did not establish the current version";
  if (result.sourceToolCallId !== record.sourceId
    || result.reportToolCallId !== record.reportId
    || result.reportInputSha256 !== record.reportInputSha256
    || result.captureId !== record.capture.captureId
    || result.captureDigest !== record.capture.digest
    || result.attempt !== record.attempt
    || result.startedAt !== record.startedAt) {
    return "the report reread result is not the retained observation";
  }
  if (state.outputActive !== null) return "another output observation is still in flight";
  return null;
}

function prepareReportInternal(
  state: CoordinatorState,
  requestValue: unknown,
  signalValue: unknown,
): NativeHarnessReportBindingResult {
  if (state.disposed) {
    return createNativeHarnessReportFailure("authority-lost", "the delegation coordinator was disposed");
  }
  if (!state.enabled) {
    return createNativeHarnessReportFailure("authority-lost", "the delegation coordinator is disabled");
  }
  if (state.reportBindingInProgress) {
    return createNativeHarnessReportFailure(
      "not-ready",
      "reentrant report binding preparation or refresh was refused",
    );
  }
  // The guard covers caller descriptor/Proxy reflection and every later host
  // callback. Only this owning call clears it.
  state.reportBindingInProgress = true;
  try {
    const normalized = normalizeNativeHarnessReportRequest(requestValue);
    if (!normalized.ok) return normalized;
    const request = normalized.request;
    const signal = readActualAbortSignal(signalValue);
    if (!signal.ok) return createNativeHarnessReportFailure("invalid-caller", signal.reason);
    if (signal.aborted) {
      return createNativeHarnessReportFailure("authority-lost", "the actual report signal was aborted before preparation");
    }

    // Caller reflection and facts encoding finish before any host prepare.
    const candidate = resolveReportBindingCandidate(state, request);
    if (isReportFailure(candidate)) return candidate;
    const facts = createReportFacts(candidate, request);
    if (isReportFailure(facts)) return facts;

    const main = readMainContext(state);
    if (!main.ok) return createNativeHarnessReportFailure("authority-lost", main.reason);
    // Authenticate the opaque report ref before reading any of its fields or
    // performing any source-side native preparation.
    const firstReport = prepareReportRefCheck(state, request.reportRef, main.context, request);
    if (isReportFailure(firstReport)) return firstReport;

    const source = prepareCheckSource(state, candidate.slot);
    if (isCheckFailure(source)) return reportFailureFromCheckFailure(source);
    if (source.capture !== candidate.capture
      || source.registration !== candidate.registration
      || source.prepared.observedSha256 !== candidate.observedSha256
      || source.prepared.observedBytes !== candidate.observedBytes) {
      return createNativeHarnessReportFailure(
        "source-conflict",
        "the original source capture or observation changed during preparation",
      );
    }

    const provisional: ReportBindingState = {
      slot: candidate.slot,
      sourceId: request.selection.sourceToolCallId,
      reportId: firstReport.association.toolCallId,
      reportRef: request.reportRef,
      reportAssociation: firstReport.association,
      reportInputSha256: request.reportInputSha256,
      reportSignal: signalValue,
      request,
      capture: candidate.capture,
      outputSelection: candidate.outputSelection,
      registration: candidate.registration,
      checks: candidate.checks,
      files: candidate.files,
      observedSha256: candidate.observedSha256,
      observedBytes: candidate.observedBytes,
      facts,
      revision: {
        source,
        report: firstReport.check,
        reportInspection: firstReport.inspection,
        reportAssociation: firstReport.association,
        selected: Object.freeze([]),
      },
    };
    const selected = prepareReportSelections(state, provisional, source.prepared.context);
    if (isReportFailure(selected)) return selected;

    // Refresh the actual report ref after the last selected-record callback.
    const lateMain = readMainContext(state);
    if (!lateMain.ok) return createNativeHarnessReportFailure("authority-lost", lateMain.reason);
    const lateReport = prepareReportRefCheck(state, request.reportRef, lateMain.context, request);
    if (isReportFailure(lateReport)) return lateReport;
    if (!sameActionAssociation(firstReport.association, lateReport.association)
      || firstReport.inspection.callInputSha256 !== lateReport.inspection.callInputSha256
      || lateReport.inspection.callInputSha256 !== request.reportInputSha256
      || lateReport.association.toolCallId !== provisional.reportId) {
      return createNativeHarnessReportFailure(
        "source-conflict",
        "the report reference association or input changed during preparation",
      );
    }

    const revision: ReportBindingRevision = {
      source,
      report: lateReport.check,
      reportInspection: lateReport.inspection,
      reportAssociation: lateReport.association,
      selected,
    };
    const final = finalReportGate(state, provisional, revision, signalValue);
    if (final !== null) return final;
    provisional.revision = revision;
    let admittedRecord: ReportRereadRecord | null = null;
    const prepared: NativeHarnessReportBindingPreparation = Object.freeze({
      facts,
      refresh(): string | null {
        return refreshReportPreparation(state, provisional);
      },
      revalidate(): string | null {
        if (provisional.slot.output.reportCurrentUseRefusal !== null) {
          return provisional.slot.output.reportCurrentUseRefusal;
        }
        const bindingReason = revalidateReportPreparation(state, provisional);
        if (bindingReason !== null) return bindingReason;
        return reportPublicationReadiness(state, provisional, admittedRecord);
      },
      reread(): Promise<NativeHarnessReportRereadResult> {
        return beginReportReread(state, provisional, (record) => {
          admittedRecord = record;
        });
      },
    });
    return Object.freeze({ ok: true as const, prepared });
  } catch (error) {
    return createNativeHarnessReportFailure(
      "source-conflict",
      `the host-only report binding failed unexpectedly: ${outputThrownReason(error, "report binding failed")}`,
    );
  } finally {
    state.reportBindingInProgress = false;
  }
}

function isCheckFailure(value: unknown): value is NativeHarnessCheckFailure {
  return typeof value === "object"
    && value !== null
    && (value as { readonly ok?: unknown }).ok === false;
}

function isOutputFailure(value: unknown): value is NativeHarnessOutputSelectionFailure {
  return typeof value === "object"
    && value !== null
    && (value as { readonly ok?: unknown }).ok === false;
}

function captureActionTerminalFailure(
  record: NativeHarnessCaptureActionRecord,
): NativeHarnessOutputSelectionFailure | null {
  if (record.state === "conflicted") {
    return outputFailure(
      "source-conflict",
      record.conflictReason ?? "the output capture action was changed",
    );
  }
  if (record.state === "cancelled") {
    return record.failure ?? outputFailure("cancelled", "the output capture action was cancelled");
  }
  if (record.state === "failed") {
    return record.failure ?? outputFailure("capture-failed", "the output capture action failed");
  }
  if (record.state === "succeeded") {
    return record.selection === null
      ? outputFailure("source-conflict", "the retained capture action response is unavailable")
      : null;
  }
  return null;
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

    const retainedAny = findRetainedAction(state, actionToolCallId);
    let retained: { readonly slot: Slot; readonly record: NativeHarnessCheckActionRecord } | null = null;
    if (retainedAny !== null) {
      const candidate = retainedAny.record;
      if (candidate.kind === "capture") {
        return refuseCrossTypeCheckRequest(state, retainedAny.slot, candidate, signalValue);
      }
      retained = { slot: retainedAny.slot, record: candidate };
    }
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

/**
 * Copies only complete selector metadata from one authentic captured change.
 * Returns null for a non-issued snapshot or an out-of-contract file fact, so
 * the caller excludes the row instead of publishing a partial list.
 */
function catalogFiles(capture: NativeHarnessOutputCapture): readonly NativeHarnessCatalogFile[] | null {
  if (capture.changes.length > MAX_OUTPUT_CHANGES) return null;
  const files: NativeHarnessCatalogFile[] = [];
  for (const change of capture.changes) {
    if (change.kind !== "add" && change.kind !== "modify") return null;
    if (!isNativeWorkspaceTextSnapshot(change.snapshot)) return null;
    if (boundedString(change.path, NATIVE_HARNESS_MAX_CHECK_PATH_CHARS) === null) return null;
    const file = change.snapshot.file;
    if (file === null || typeof file !== "object") return null;
    if (boundedString(file.relativePath, NATIVE_HARNESS_MAX_CHECK_PATH_CHARS) !== change.path) return null;
    if (typeof file.bytes !== "number"
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || file.bytes > MAX_OUTPUT_CHANGE_BYTES) {
      return null;
    }
    if (!isHex64(file.sha256)) return null;
    if (typeof file.observedAt !== "number" || !Number.isSafeInteger(file.observedAt) || file.observedAt < 0) {
      return null;
    }
    files.push(Object.freeze({
      path: change.path,
      kind: change.kind,
      bytes: file.bytes,
      sha256: file.sha256,
      observedAt: file.observedAt,
    }));
  }
  return Object.freeze(files);
}

function readOutputForCallInternal(
  state: CoordinatorState,
  actualReadToolCallIdValue: unknown,
  inputValue: unknown,
  signalValue: unknown,
): NativeHarnessReadSelection {
  let busy = false;
  try {
    if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
    if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
    if (state.outputObservationInProgress) {
      return outputFailure("capacity", "another host output observation is already in progress");
    }
    state.outputObservationInProgress = true;
    busy = true;

    const readToolCallId = boundedString(actualReadToolCallIdValue, MAX_TOOL_CALL_ID_CHARS);
    if (readToolCallId === null) {
      return outputFailure("invalid-caller", "the actual read tool call id is unavailable");
    }
    const normalized = normalizeNativeHarnessReadInput(inputValue);
    if (!normalized.ok) return outputFailureFromCheck(normalized);
    const signal = readActualAbortSignal(signalValue);
    if (!signal.ok) return outputFailure("invalid-caller", signal.reason);
    if (signal.aborted) return outputFailure("cancelled", "the actual read signal was aborted before admission");

    // A read call never borrows an existing source/capture/check ref identity.
    if (state.slots.has(readToolCallId) || findRetainedAction(state, readToolCallId) !== null) {
      return outputFailure("source-conflict", "the actual read tool call id is already retained by another action");
    }
    const input = normalized.input;
    const slot = state.slots.get(input.sourceToolCallId);
    if (slot === undefined) {
      return outputFailure("not-ready", "no retained delegation operation has this source id");
    }

    const source = prepareCaptureSource(state, slot, true);
    if (isOutputFailure(source)) return source;
    const out = slot.output;
    const capture = out.capture;
    const selection = out.selection;
    if (capture === null || selection === null) {
      return outputFailure("source-conflict", "the retained historical capture is unavailable");
    }
    if (input.captureId !== capture.captureId || input.captureDigest !== capture.digest) {
      return outputFailure("source-conflict", "the read selectors do not exactly match the retained source capture");
    }
    const change = capture.changes.find((record) => record.path === input.path);
    if (change === undefined) {
      return outputFailure("source-conflict", "the read path is not one of the retained capture changes");
    }
    if (!isNativeWorkspaceTextSnapshot(change.snapshot)) {
      return outputFailure("source-conflict", "the selected read path has no authentic native snapshot");
    }
    const backend = slot.backend?.receiver;
    if (backend === undefined || !outputMatches(source.output, backend, capture)) {
      return outputFailure("source-conflict", "the retained output capture is no longer bound to this backend");
    }
    if (selection.capture !== capture) {
      return outputFailure("source-conflict", "the retained capture selection identity changed");
    }
    if (source.prepared.observedSha256 === null
      || source.prepared.observedSha256 !== selection.observedResultSha256) {
      return outputFailure("source-conflict", "the source result observation changed after capture");
    }

    const actual = prepareActualToolCall(state, readToolCallId, normalized.digest);
    if (isOutputFailure(actual)) return actual;
    if (!sameActionWorkIdentity(slot, actual.association)) {
      return outputFailure("source-conflict", "the read call does not belong to the original source work identity");
    }

    // Final sequence: pure original owner, actual read signal, prepared source
    // pure revalidation, prepared read-call pure revalidation, then local
    // exact identity only. No host data is read after the pure checks begin.
    const owner = ownerPredicateReason(source.output);
    if (owner !== null) return outputFailure("authority-lost", owner);
    const finalSignal = readActualAbortSignal(signalValue);
    if (!finalSignal.ok) return outputFailure("invalid-caller", finalSignal.reason);
    if (finalSignal.aborted) return outputFailure("cancelled", "the actual read signal was aborted");
    const sourcePure = pureCheckReason(source.prepared.check);
    if (sourcePure !== null) return outputFailure("source-conflict", sourcePure);
    const actualPure = pureCheckReason(actual.check);
    if (actualPure !== null) return outputFailure("source-conflict", actualPure);

    if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
    if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
    if (state.slots.get(input.sourceToolCallId) !== slot) {
      return outputFailure("source-conflict", "the original source Slot was replaced");
    }
    if (out.state !== "captured"
      || out.capture !== capture
      || out.selection !== selection
      || out.registration !== source.registration
      || change.path !== input.path) {
      return outputFailure("source-conflict", "the retained historical capture changed during the read");
    }
    if (slot.toolCallId !== input.sourceToolCallId
      || slot.association.observationId !== actual.association.observationId
      || slot.association.generation !== actual.association.generation
      || slot.association.sessionId !== actual.association.sessionId
      || slot.association.workspaceRoot !== actual.association.workspaceRoot) {
      return outputFailure("source-conflict", "the original source work identity changed during the read");
    }
    return Object.freeze({
      ok: true as const,
      action: "read" as const,
      readToolCallId,
      sourceToolCallId: input.sourceToolCallId,
      captureId: capture.captureId,
      captureDigest: capture.digest,
      path: change.path,
      snapshot: change.snapshot,
      observation: "cached-historical" as const,
      filesystemFreshness: "not-rechecked" as const,
      taskAccepted: false as const,
      semanticAcceptance: "not-evaluated" as const,
    });
  } catch (error) {
    return outputFailure(
      "output-unavailable",
      `the host-only read failed unexpectedly: ${outputThrownReason(error, "output operation failed")}`,
    );
  } finally {
    if (busy) state.outputObservationInProgress = false;
  }
}

interface InspectedSourceCandidate {
  readonly slot: Slot;
  readonly key: string;
  readonly outputState: "idle" | "captured";
  readonly source: PreparedCaptureSource;
  readonly capture: NativeHarnessOutputCapture | null;
  readonly selection: NativeHarnessOutputSelectionSuccess | null;
  readonly files: readonly NativeHarnessCatalogFile[] | null;
}

type InspectedSourceState = "not-ready" | "unavailable" | "idle" | "captured";

/**
 * Locally known running/failed/non-selectable states are not-ready. A
 * successful settled source whose selectable evidence is missing or conflicted
 * is unavailable. Neither classification exposes the source identity.
 */
function inspectSourceState(slot: Slot): InspectedSourceState {
  if (slot.state !== "settled") return "not-ready";
  if (sourceSuccessProblem(slot, slot.response) !== null) return "not-ready";
  const out = slot.output;
  if (out.actionBinding !== null) return "not-ready";
  if (out.state === "idle") {
    if (out.registrationFailure !== null) return "unavailable";
    return out.registration === null ? "unavailable" : "idle";
  }
  if (out.state === "captured") {
    if (out.capture === null
      || out.selection === null
      || out.registration === null
      || out.registrationFailure !== null) {
      return "unavailable";
    }
    return "captured";
  }
  return "not-ready";
}

function inspectRowLocalProblem(
  state: CoordinatorState,
  candidate: InspectedSourceCandidate,
): boolean {
  const slot = candidate.slot;
  const out = slot.output;
  if (state.slots.get(candidate.key) !== slot || slot.toolCallId !== candidate.key) return true;
  if (out.registration !== candidate.source.registration || out.actionBinding !== null) return true;
  if (candidate.outputState === "idle") {
    return out.state !== "idle" || out.capture !== null;
  }
  return out.state !== "captured"
    || out.capture !== candidate.capture
    || out.selection !== candidate.selection;
}

function catalogRow(candidate: InspectedSourceCandidate): NativeHarnessCatalogRow {
  if (candidate.outputState === "idle") {
    return Object.freeze({
      sourceToolCallId: candidate.key,
      outputState: "idle" as const,
      capture: null,
    });
  }
  const capture = candidate.capture as NativeHarnessOutputCapture;
  const files = candidate.files as readonly NativeHarnessCatalogFile[];
  return Object.freeze({
    sourceToolCallId: candidate.key,
    outputState: "captured" as const,
    capture: Object.freeze({
      captureId: capture.captureId,
      captureDigest: capture.digest,
      files,
    }),
  });
}

function inspectOutputsForCallInternal(
  state: CoordinatorState,
  actualInspectToolCallIdValue: unknown,
  inputValue: unknown,
  signalValue: unknown,
): NativeHarnessOutputCatalog {
  let busy = false;
  try {
    if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
    if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
    if (state.outputObservationInProgress) {
      return outputFailure("capacity", "another host output observation is already in progress");
    }
    state.outputObservationInProgress = true;
    busy = true;

    const inspectToolCallId = boundedString(actualInspectToolCallIdValue, MAX_TOOL_CALL_ID_CHARS);
    if (inspectToolCallId === null) {
      return outputFailure("invalid-caller", "the actual inspect tool call id is unavailable");
    }
    const normalized = normalizeNativeHarnessInspectInput(inputValue);
    if (!normalized.ok) return outputFailureFromCheck(normalized);
    const signal = readActualAbortSignal(signalValue);
    if (!signal.ok) return outputFailure("invalid-caller", signal.reason);
    if (signal.aborted) return outputFailure("cancelled", "the actual inspect signal was aborted before admission");

    if (state.slots.has(inspectToolCallId) || findRetainedAction(state, inspectToolCallId) !== null) {
      return outputFailure("source-conflict", "the actual inspect tool call id is already retained by another action");
    }
    if (state.output === null) {
      return outputFailure("output-unavailable", "the trusted output port is not available");
    }
    const actual = prepareActualToolCall(state, inspectToolCallId, normalized.digest);
    if (isOutputFailure(actual)) return actual;

    // Take the initial bounded inventory by original Slot reference before any
    // per-row host callback. The final phase refuses any key/object change.
    const inventory = Array.from(state.slots.entries());
    const candidates: InspectedSourceCandidate[] = [];
    let excludedNotReady = 0;
    let excludedUnavailable = 0;
    for (const [key, slot] of inventory) {
      if (slot.toolCallId !== key || !sameActionWorkIdentity(slot, actual.association)) {
        excludedUnavailable += 1;
        continue;
      }
      const outputState = inspectSourceState(slot);
      if (outputState === "not-ready") {
        excludedNotReady += 1;
        continue;
      }
      if (outputState === "unavailable") {
        excludedUnavailable += 1;
        continue;
      }
      const source = prepareCaptureSource(state, slot, outputState === "captured");
      if (isOutputFailure(source)) {
        if (source.code === "not-ready" || source.code === "capacity" || source.code === "cancelled") {
          excludedNotReady += 1;
        } else {
          excludedUnavailable += 1;
        }
        continue;
      }
      const out = slot.output;
      if (outputState === "captured") {
        const capture = out.capture;
        const selection = out.selection;
        const backend = slot.backend?.receiver;
        if (capture === null
          || selection === null
          || selection.capture !== capture
          || backend === undefined
          || !outputMatches(source.output, backend, capture)
          || source.prepared.observedSha256 === null
          || source.prepared.observedSha256 !== selection.observedResultSha256) {
          excludedUnavailable += 1;
          continue;
        }
        const files = catalogFiles(capture);
        if (files === null) {
          excludedUnavailable += 1;
          continue;
        }
        candidates.push({
          slot,
          key,
          outputState,
          source,
          capture,
          selection,
          files,
        });
        continue;
      }
      candidates.push({
        slot,
        key,
        outputState,
        source,
        capture: null,
        selection: null,
        files: null,
      });
    }

    // Refresh the actual inspection query after every row/matcher/copy
    // callback, reusing the one original locally-issued ref. The refresh is a
    // host read and may invalidate a prepared source, so every source pure gate
    // below follows it.
    const refreshed = refreshActualToolCall(state, actual, normalized.digest);
    if (isOutputFailure(refreshed)) return refreshed;

    // Final phase: pure owner, actual inspect signal, refreshed actual-call
    // pure revalidation, then every prospective row's pure/local identity
    // check. No host callback or caller input read follows this point.
    const owner = ownerPredicateReason(state.output);
    if (owner !== null) return outputFailure("authority-lost", owner);
    const finalSignal = readActualAbortSignal(signalValue);
    if (!finalSignal.ok) return outputFailure("invalid-caller", finalSignal.reason);
    if (finalSignal.aborted) return outputFailure("cancelled", "the actual inspect signal was aborted");
    const actualPure = pureCheckReason(refreshed.check);
    if (actualPure !== null) return outputFailure("source-conflict", actualPure);

    const rows: NativeHarnessCatalogRow[] = [];
    for (const candidate of candidates) {
      const sourcePure = pureCheckReason(candidate.source.prepared.check);
      if (sourcePure !== null || inspectRowLocalProblem(state, candidate)) {
        excludedUnavailable += 1;
        continue;
      }
      rows.push(catalogRow(candidate));
    }

    if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
    if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
    if (state.slots.size !== inventory.length) {
      return outputFailure("source-conflict", "the retained source inventory changed during inspection");
    }
    for (const [key, slot] of inventory) {
      if (state.slots.get(key) !== slot) {
        return outputFailure("source-conflict", "the retained source inventory changed during inspection");
      }
    }
    return Object.freeze({
      ok: true as const,
      action: "inspect" as const,
      scope: "retained-sources-in-this-root" as const,
      scanComplete: true as const,
      retainedSources: inventory.length,
      returnedSources: rows.length,
      excludedNotReady,
      excludedUnavailable,
      rows: Object.freeze(rows),
    });
  } catch (error) {
    return outputFailure(
      "output-unavailable",
      `the host-only inspection failed unexpectedly: ${outputThrownReason(error, "output operation failed")}`,
    );
  } finally {
    if (busy) state.outputObservationInProgress = false;
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
    const retainedAny = findRetainedAction(state, actionToolCallId);
    if (retainedAny === null) return registrationFailure("no retained check action has this tool call id");
    const candidateRecord = retainedAny.record;
    if (candidateRecord.kind === "capture") {
      return registrationFailure("the retained action is an output capture action");
    }
    const slot = retainedAny.slot;
    const record: NativeHarnessCheckActionRecord = candidateRecord;
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

function markCaptureActionConflicted(
  slot: Slot,
  record: NativeHarnessCaptureActionRecord,
  reason: string,
): void {
  const text = boundedReason(reason, "the output capture action changed");
  if (record.state === "pending" || record.state === "succeeded") {
    record.state = "conflicted";
    record.conflictReason = text;
  }
  const out = slot.output;
  const binding = out.actionBinding;
  if (binding !== null && binding.record === record && out.state === "running") {
    if (out.guardFailure === null) out.guardFailure = outputFailure("source-conflict", text);
    try {
      out.controller?.abort(new Error(text));
    } catch {
      // The local capture signal is already aborted.
    }
  }
}

/**
 * Authenticates the retained capture action ref, original owner/source and
 * signal before any sticky mutation. All host inspection happens first; the
 * final pure/local sequence has no further host callback.
 */
function authenticateCaptureActionRecord(
  state: CoordinatorState,
  slot: Slot,
  record: NativeHarnessCaptureActionRecord,
  signalValue: unknown,
): NativeHarnessOutputSelectionFailure | null {
  if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
  if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
  if (record.signal !== signalValue) {
    return outputFailure("invalid-caller", "the actual capture signal is not the original action signal");
  }
  const out = slot.output;
  const output = state.output;
  if (output === null) return outputFailure("output-unavailable", "the trusted output port is not available");
  if (out.registration === null) return outputFailure("not-ready", "the source result projection is not registered");
  const prepared = prepareOutputCheck(slot, state, out.registration, true);
  if (!prepared.ok) return outputFailure(prepared.code, prepared.reason);
  const registration = captureActionRegistration(record);
  if (registration === undefined) {
    return outputFailure("source-conflict", "the retained capture registration fingerprint is incomplete");
  }
  const action = prepareCaptureActionGate(state, slot, record, prepared.context, registration);
  if (isOutputFailure(action)) return action;
  const source = sourceSuccessProblem(slot, slot.response);
  if (source !== null) return outputFailure("source-conflict", source);
  const owner = ownerPredicateReason(output);
  if (owner !== null) return outputFailure("authority-lost", owner);
  const signal = readActualAbortSignal(signalValue);
  if (!signal.ok) return outputFailure("invalid-caller", signal.reason);
  if (signal.aborted) return outputFailure("cancelled", "the actual capture signal was aborted");
  const sourcePure = pureCheckReason(prepared.check);
  if (sourcePure !== null) return outputFailure("source-conflict", sourcePure);
  const actionPure = pureCheckReason(action.check);
  if (actionPure !== null) return outputFailure("source-conflict", actionPure);
  if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
  if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
  if (state.slots.get(record.sourceToolCallId) !== slot) {
    return outputFailure("source-conflict", "the original source Slot was replaced");
  }
  if (out.checks === null || out.checks.actions.get(record.actionToolCallId) !== record) {
    return outputFailure("source-conflict", "the retained capture action record changed");
  }
  return null;
}

/** A genuine check request on a capture action id is a sticky changed input. */
function refuseCrossTypeCheckRequest(
  state: CoordinatorState,
  slot: Slot,
  record: NativeHarnessCaptureActionRecord,
  signalValue: unknown,
): NativeHarnessCheckFailure {
  if (record.signal !== signalValue) {
    return createNativeHarnessCheckFailure(
      "invalid-caller",
      "the actual check signal is not the retained capture action signal",
    );
  }
  const checks = slot.output.checks;
  if (checks === null) {
    return createNativeHarnessCheckFailure("source-conflict", "the retained action state is unavailable");
  }
  if (checks.busy) {
    return createNativeHarnessCheckFailure("not-ready", "an action operation is already in progress for this source Slot");
  }
  checks.busy = true;
  try {
    const auth = authenticateCaptureActionRecord(state, slot, record, signalValue);
    if (auth !== null) return checkFailureFromOutput(auth);
    markCaptureActionConflicted(
      slot,
      record,
      "the same actual action call changed to a check request",
    );
    return createNativeHarnessCheckFailure(
      "source-conflict",
      "the same actual action call changed to a check request",
    );
  } finally {
    checks.busy = false;
  }
}

/** A genuine capture request on a check action id is a sticky changed input. */
function refuseCrossTypeCaptureRequest(
  state: CoordinatorState,
  slot: Slot,
  record: NativeHarnessCheckActionRecord,
  signalValue: unknown,
): NativeHarnessOutputSelectionFailure {
  if (record.signal !== signalValue) {
    return outputFailure("invalid-caller", "the actual capture signal is not the retained check action signal");
  }
  const checks = slot.output.checks;
  if (checks === null) {
    return outputFailure("source-conflict", "the retained check action state is unavailable");
  }
  if (checks.busy) {
    return outputFailure("not-ready", "an action operation is already in progress for this source Slot");
  }
  checks.busy = true;
  try {
    if (record.kind === "terminal") {
      return outputFailure("source-conflict", record.reason);
    }
    const source = prepareCheckSource(state, slot);
    if (isCheckFailure(source)) return outputFailureFromCheck(source);
    const registration = retainedRegistration(record);
    if (registration === undefined) {
      return outputFailure("source-conflict", "the retained check registration fingerprint is incomplete");
    }
    const action = prepareCheckAction(
      state,
      slot,
      record.actionRef,
      source.prepared.context,
      registration,
    );
    if (isCheckFailure(action)) return outputFailureFromCheck(action);
    const final = finalCheckGate(state, slot, source, action, signalValue, checks);
    if (final !== null) return outputFailureFromCheck(final);
    record.state = "conflicted";
    record.conflictReason = boundedReason(
      "the same actual action call changed to a capture request",
      "the check action changed",
    );
    return outputFailure(
      "source-conflict",
      "the same actual action call changed to a capture request",
    );
  } finally {
    checks.busy = false;
  }
}

type RetainedCaptureOutcome =
  | NativeHarnessOutputSelection
  | Promise<NativeHarnessOutputSelection>;

/** Replay/join for an already retained capture action. */
function handleRetainedCaptureAction(
  state: CoordinatorState,
  slot: Slot,
  record: NativeHarnessCaptureActionRecord,
  normalized: Extract<ReturnType<typeof normalizeNativeHarnessCaptureInput>, { readonly ok: true }>,
  signalValue: unknown,
): RetainedCaptureOutcome {
  if (record.signal !== signalValue) {
    return outputFailure("invalid-caller", "the actual capture signal is not the original action signal");
  }
  const checks = slot.output.checks;
  if (checks === null) return outputFailure("source-conflict", "the retained action state is unavailable");
  if (checks.busy) {
    return outputFailure("not-ready", "an action operation is already in progress for this source Slot");
  }
  checks.busy = true;
  try {
    if (record.state === "conflicted") {
      return outputFailure(
        "source-conflict",
        record.conflictReason ?? "the output capture action was changed",
      );
    }
    if (record.state === "cancelled") {
      return record.failure ?? outputFailure("cancelled", "the output capture action was cancelled");
    }
    if (record.state === "failed") {
      return record.failure ?? outputFailure("capture-failed", "the output capture action failed");
    }
    if (normalized.digest !== record.inputSha256) {
      const auth = authenticateCaptureActionRecord(state, slot, record, signalValue);
      if (auth !== null) return auth;
      markCaptureActionConflicted(
        slot,
        record,
        "the same output capture action call changed its input",
      );
      return outputFailure(
        "source-conflict",
        "the same output capture action call changed its input",
      );
    }
    if (record.state === "succeeded") {
      if (record.selection === null) {
        return outputFailure("source-conflict", "the retained capture action response is unavailable");
      }
      if (record.registrationConflict !== null) {
        return outputFailure("source-conflict", record.registrationConflict);
      }
      const auth = authenticateCaptureActionRecord(state, slot, record, signalValue);
      if (auth !== null) return auth;
      const cached = captureCachedOutput(state, slot, signalValue);
      if (!cached.ok) return cached;
      if (cached.capture !== record.selection.capture) {
        return outputFailure("source-conflict", "the retained capture object was replaced");
      }
      return record.selection;
    }
    // Pending: fresh gates share the exact original deferred promise.
    const out = slot.output;
    const output = state.output;
    if (output === null) return outputFailure("output-unavailable", "the trusted output port is not available");
    if (out.registration === null || out.startedAt === null) {
      return outputFailure("not-ready", "the in-flight output capture is incomplete");
    }
    if (out.actionBinding === null || out.actionBinding.record !== record) {
      return outputFailure("source-conflict", "the output capture action binding changed");
    }
    if (state.outputJoinValidating) {
      return outputFailure("not-ready", "reentrant output capture join validation was refused");
    }
    state.outputJoinValidating = true;
    let admitted: NativeHarnessOutputSelectionFailure | null;
    try {
      admitted = captureGuardGate(
        state,
        slot,
        output,
        out.registration,
        signalValue as AbortSignal,
        out.startedAt,
        out.actionBinding,
      );
    } finally {
      state.outputJoinValidating = false;
    }
    if (admitted !== null) return admitted;
    const terminal = captureActionTerminalFailure(record);
    if (terminal !== null) return terminal;
    if (record.selection !== null) return record.selection;
    if (out.promise === null || out.promise !== record.promise) {
      return outputFailure("not-ready", "the in-flight output capture changed during join validation");
    }
    return record.promise;
  } finally {
    checks.busy = false;
  }
}

function initialCaptureActionAdmission(
  state: CoordinatorState,
  slot: Slot,
  source: PreparedCaptureSource,
  actionPrepared: PreparedCaptureAction,
  checks: NativeHarnessCheckState,
  actionToolCallId: string,
  signalValue: unknown,
  requireCaptured: boolean,
): NativeHarnessOutputSelectionFailure | null {
  const owner = ownerPredicateReason(source.output);
  if (owner !== null) return outputFailure("authority-lost", owner);
  const signal = readActualAbortSignal(signalValue);
  if (!signal.ok) return outputFailure("invalid-caller", signal.reason);
  if (signal.aborted) return outputFailure("cancelled", "the actual capture signal was aborted");
  const sourcePure = pureCheckReason(source.prepared.check);
  if (sourcePure !== null) return outputFailure("source-conflict", sourcePure);
  const actionPure = pureCheckReason(actionPrepared.check);
  if (actionPure !== null) return outputFailure("source-conflict", actionPure);
  if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
  if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
  if (state.slots.get(slot.toolCallId) !== slot) {
    return outputFailure("source-conflict", "the original source Slot was replaced");
  }
  const out = slot.output;
  if (requireCaptured) {
    if (out.state !== "captured"
      || out.capture === null
      || out.selection === null
      || out.registration !== source.registration
      || out.checks !== checks
      || out.actionBinding !== null) {
      return outputFailure("source-conflict", "the retained source capture changed during the action");
    }
  } else if (out.state !== "idle"
    || out.registration !== source.registration
    || out.checks !== checks
    || out.actionBinding !== null) {
    return outputFailure("source-conflict", "the source output state changed during the action");
  }
  if (checks.actions.size >= NATIVE_HARNESS_MAX_CHECK_ACTIONS) {
    return outputFailure("capacity", "the retained action count is exhausted");
  }
  if (checks.actions.has(actionToolCallId)) {
    return outputFailure("source-conflict", "the actual capture action id is already retained");
  }
  return null;
}

function startBoundOutputCapture(
  state: CoordinatorState,
  slot: Slot,
  binding: CaptureActionBinding,
  signalValue: unknown,
): void {
  const started = captureOutputInternal(state, slot.toolCallId, signalValue, binding);
  void started.then(
    (selection) => {
      if (binding.record.state === "pending") settleCaptureAction(binding, selection);
      if (slot.output.actionBinding === binding) slot.output.actionBinding = null;
    },
    (error) => {
      const failure = outputFailure(
        "capture-failed",
        `the output capture action task failed: ${outputThrownReason(error, "output operation failed")}`,
      );
      if (slot.output.state === "running") failOutput(state, slot, failure);
      settleCaptureAction(binding, failure);
      if (slot.output.actionBinding === binding) slot.output.actionBinding = null;
    },
  );
}

/**
 * One authenticated admission point for a genuine capture action. Every host
 * inspection (main context, source preflight, action capture, action preflight
 * and clock) happens before the pure owner/signal/source/action sequence and
 * the local capacity/state commit. No host I/O occurs here.
 */
function admitNewCaptureAction(
  state: CoordinatorState,
  slot: Slot,
  actionToolCallId: string,
  normalized: Extract<ReturnType<typeof normalizeNativeHarnessCaptureInput>, { readonly ok: true }>,
  signalValue: unknown,
): Promise<NativeHarnessOutputSelection> {
  const out = slot.output;
  if (out.state === "failed" && out.failure !== null) return Promise.resolve(out.failure);
  if (out.state === "running") {
    return Promise.resolve(outputFailure(
      "capacity",
      "another output capture is already in flight for this delegation",
    ));
  }
  if (out.checks === null) out.checks = createNativeHarnessCheckState();
  const checks = out.checks;
  if (checks.busy) {
    return Promise.resolve(outputFailure(
      "not-ready",
      "an action operation is already in progress for this source Slot",
    ));
  }
  checks.busy = true;
  let launch: CaptureActionBinding | null = null;
  try {
    const requireCaptured = out.state === "captured";
    if (!requireCaptured && out.state !== "idle") {
      return Promise.resolve(outputFailure("not-ready", "the source output state is unavailable"));
    }
    const source = prepareCaptureSource(state, slot, requireCaptured);
    if ("ok" in source) return Promise.resolve(source);
    const captured = captureCheckAction(state, slot, source.prepared.context, actionToolCallId);
    if (isCheckFailure(captured)) return Promise.resolve(outputFailureFromCheck(captured));
    if (captured.inputSha256 !== normalized.digest) {
      return Promise.resolve(outputFailure(
        "source-conflict",
        "the actual capture call preflight input differs from the frozen normalized input",
      ));
    }
    const actionPrepared = prepareCaptureActionGate(
      state,
      slot,
      { actionRef: captured.ref, inputSha256: normalized.digest },
      source.prepared.context,
      null,
    );
    if (isOutputFailure(actionPrepared)) return Promise.resolve(actionPrepared);
    const now = readClock(state.now);
    if (now === null) return Promise.resolve(outputFailure("deadline", "the delegation clock is unavailable"));
    const initial = initialCaptureActionAdmission(
      state,
      slot,
      source,
      actionPrepared,
      checks,
      actionToolCallId,
      signalValue,
      requireCaptured,
    );
    if (initial !== null) return Promise.resolve(initial);

    const settled = deferred<NativeHarnessOutputSelection>();
    const record: NativeHarnessCaptureActionRecord = {
      kind: "capture",
      actionRef: captured.ref,
      actionToolCallId,
      sourceToolCallId: normalized.input.sourceToolCallId,
      input: normalized.input,
      inputSha256: normalized.digest,
      signal: signalValue as AbortSignal,
      state: "pending",
      conflictReason: null,
      promise: settled.promise,
      selection: null,
      failure: null,
      registrationSha256: null,
      registrationBytes: null,
      registrationConflict: null,
    };

    if (requireCaptured) {
      if (checks.actions.size >= NATIVE_HARNESS_MAX_CHECK_ACTIONS) {
        return Promise.resolve(outputFailure("capacity", "the retained action count is exhausted"));
      }
      if (checks.actions.has(actionToolCallId)) {
        return Promise.resolve(outputFailure("source-conflict", "the actual capture action id is already retained"));
      }
      // Install the original action record and cancellable pending promise
      // before any cached-selection host read. Late owner loss or an actual
      // id cancellation is terminal for this ref/signal/input even though no
      // output I/O or reservation is created.
      const binding: CaptureActionBinding = { record, settled };
      checks.actions.set(actionToolCallId, record);
      out.actionBinding = binding;
      try {
        const cached = captureCachedOutput(state, slot, signalValue, record);
        if (record.state !== "pending") {
          const terminal = captureActionTerminalFailure(record)
            ?? outputFailure("cancelled", "the output capture action changed during cached selection");
          settleCaptureAction(binding, terminal);
          return settled.promise;
        }
        if (!cached.ok) {
          settleCaptureAction(binding, cached);
          return settled.promise;
        }
        if (checks.actions.get(actionToolCallId) !== record
          || out.state !== "captured"
          || out.capture !== cached.capture
          || out.actionBinding !== binding) {
          settleCaptureAction(
            binding,
            outputFailure("source-conflict", "the retained source capture changed during cached selection"),
          );
          return settled.promise;
        }
        record.state = "succeeded";
        record.selection = cached;
        settled.resolve(cached);
        return settled.promise;
      } catch (error) {
        settleCaptureAction(
          binding,
          outputFailure(
            "capture-failed",
            `the cached capture action failed: ${outputThrownReason(error, "output operation failed")}`,
          ),
        );
        return settled.promise;
      } finally {
        if (out.actionBinding === binding) out.actionBinding = null;
      }
    }

    if (checks.actions.size >= NATIVE_HARNESS_MAX_CHECK_ACTIONS) {
      return Promise.resolve(outputFailure("capacity", "the retained action count is exhausted"));
    }
    if (checks.actions.has(actionToolCallId)) {
      return Promise.resolve(outputFailure("source-conflict", "the actual capture action id is already retained"));
    }
    if (out.state !== "idle" || out.actionBinding !== null || state.slots.get(slot.toolCallId) !== slot) {
      return Promise.resolve(outputFailure("not-ready", "the source output state changed during admission"));
    }
    const binding: CaptureActionBinding = { record, settled };
    checks.actions.set(actionToolCallId, record);
    out.actionBinding = binding;
    launch = binding;
    return settled.promise;
  } catch (error) {
    return Promise.resolve(outputFailure(
      "capture-failed",
      `the capture action admission failed: ${outputThrownReason(error, "output operation failed")}`,
    ));
  } finally {
    checks.busy = false;
    if (launch !== null) startBoundOutputCapture(state, slot, launch, signalValue);
  }
}

function captureOutputForCallInternal(
  state: CoordinatorState,
  actualActionToolCallId: unknown,
  inputValue: unknown,
  signalValue: unknown,
): Promise<NativeHarnessOutputSelection> {
  try {
    if (state.disposed) {
      return Promise.resolve(outputFailure("authority-lost", "the delegation coordinator was disposed"));
    }
    if (!state.enabled) {
      return Promise.resolve(outputFailure("authority-lost", "the delegation coordinator is disabled"));
    }
    const actionToolCallId = boundedString(actualActionToolCallId, MAX_TOOL_CALL_ID_CHARS);
    if (actionToolCallId === null) {
      return Promise.resolve(outputFailure("invalid-caller", "the actual capture tool call id is unavailable"));
    }
    const normalized = normalizeNativeHarnessCaptureInput(inputValue);
    if (!normalized.ok) return Promise.resolve(outputFailureFromCheck(normalized));
    const signal = readActualAbortSignal(signalValue);
    if (!signal.ok) return Promise.resolve(outputFailure("invalid-caller", signal.reason));

    const retainedAny = findRetainedAction(state, actionToolCallId);
    if (retainedAny !== null) {
      const retainedRecord = retainedAny.record;
      if (retainedRecord.kind !== "capture") {
        return Promise.resolve(refuseCrossTypeCaptureRequest(
          state,
          retainedAny.slot,
          retainedRecord,
          signalValue,
        ));
      }
      const outcome = handleRetainedCaptureAction(
        state,
        retainedAny.slot,
        retainedRecord,
        normalized,
        signalValue,
      );
      return Promise.resolve(outcome);
    }
    if (signal.aborted) {
      return Promise.resolve(outputFailure("cancelled", "the actual capture signal was aborted before admission"));
    }
    if (actionToolCallId === normalized.input.sourceToolCallId) {
      return Promise.resolve(outputFailure(
        "invalid-caller",
        "the capture action must use a different actual tool call id than the source",
      ));
    }
    const slot = state.slots.get(normalized.input.sourceToolCallId);
    if (slot === undefined) {
      return Promise.resolve(outputFailure(
        "not-ready",
        "no retained delegation operation has this source id",
      ));
    }
    return admitNewCaptureAction(state, slot, actionToolCallId, normalized, signalValue);
  } catch (error) {
    return Promise.resolve(outputFailure(
      "capture-failed",
      `the capture action failed unexpectedly: ${outputThrownReason(error, "output operation failed")}`,
    ));
  }
}

function cancelCaptureBinding(slot: Slot, binding: CaptureActionBinding, reason: string): boolean {
  const record = binding.record;
  if (record.state !== "pending") return false;
  const failure = outputFailure("cancelled", reason);
  record.state = "cancelled";
  record.failure = failure;
  record.conflictReason = failure.reason;
  const out = slot.output;
  if (out.actionBinding === binding && out.state === "running" && out.controller !== null) {
    // The actual leaf is already running. Latch the cancelled state and abort
    // only its owned capture; the exact action promise settles after the
    // existing capture task handles cleanup and releases the reservation.
    if (out.guardFailure === null) out.guardFailure = failure;
    try {
      out.controller.abort(new Error(failure.reason));
    } catch {
      // The local capture signal is already aborted.
    }
    return true;
  }
  // No leaf was launched: no further launch can occur, so the bounded failure
  // can settle the action promise immediately.
  binding.settled.resolve(failure);
  return true;
}

function cancelBoundCaptureAction(state: CoordinatorState, actionToolCallId: string): boolean {
  const retained = findRetainedAction(state, actionToolCallId);
  if (retained === null || retained.record.kind !== "capture") return false;
  const binding = retained.slot.output.actionBinding;
  if (binding === null || binding.record !== retained.record) return false;
  return cancelCaptureBinding(retained.slot, binding, "the output capture action was cancelled");
}

function finalCaptureActionGate(
  state: CoordinatorState,
  slot: Slot,
  source: PreparedCaptureSource,
  action: PreparedCaptureAction,
  record: NativeHarnessCaptureActionRecord,
  signalValue: unknown,
): NativeHarnessOutputSelectionFailure | null {
  const owner = ownerPredicateReason(source.output);
  if (owner !== null) return outputFailure("authority-lost", owner);
  const signal = readActualAbortSignal(signalValue);
  if (!signal.ok) return outputFailure("invalid-caller", signal.reason);
  if (signal.aborted) return outputFailure("cancelled", "the original capture action signal was aborted");
  const sourcePure = pureCheckReason(source.prepared.check);
  if (sourcePure !== null) return outputFailure("source-conflict", sourcePure);
  const actionPure = pureCheckReason(action.check);
  if (actionPure !== null) return outputFailure("source-conflict", actionPure);
  if (state.disposed) return outputFailure("authority-lost", "the delegation coordinator was disposed");
  if (!state.enabled) return outputFailure("authority-lost", "the delegation coordinator is disabled");
  if (state.slots.get(record.sourceToolCallId) !== slot) {
    return outputFailure("source-conflict", "the original source Slot was replaced");
  }
  const out = slot.output;
  if (out.state !== "captured"
    || out.capture === null
    || out.selection === null
    || out.registration !== source.registration
    || out.actionBinding !== null) {
    return outputFailure("source-conflict", "the retained source capture changed during registration");
  }
  if (out.checks === null || out.checks.actions.get(record.actionToolCallId) !== record) {
    return outputFailure("source-conflict", "the retained capture action record changed");
  }
  if (record.state !== "succeeded" || record.selection === null) {
    return outputFailure("source-conflict", "the capture action is not a successful retained response");
  }
  return null;
}

function registerOutputCaptureProjectionInternal(
  state: CoordinatorState,
  actualSourceToolCallId: unknown,
  actualActionToolCallId: unknown,
  exactCaptureResponse: unknown,
  actualProjectedResult: unknown,
  originalActionSignal: unknown,
): { readonly ok: boolean; readonly reason: string | null } {
  let checks: NativeHarnessCheckState | null = null;
  let busyAcquired = false;
  try {
    if (state.disposed) return registrationFailure("the delegation coordinator was disposed");
    if (!state.enabled) return registrationFailure("the delegation coordinator is disabled");
    const sourceToolCallId = boundedString(actualSourceToolCallId, MAX_TOOL_CALL_ID_CHARS);
    if (sourceToolCallId === null) return registrationFailure("the actual source tool call id is unavailable");
    const actionToolCallId = boundedString(actualActionToolCallId, MAX_TOOL_CALL_ID_CHARS);
    if (actionToolCallId === null) return registrationFailure("the actual capture tool call id is unavailable");
    const retained = findRetainedAction(state, actionToolCallId);
    if (retained === null || retained.record.kind !== "capture") {
      return registrationFailure("no retained output capture action has this tool call id");
    }
    const slot = retained.slot;
    const record = retained.record;
    if (slot.toolCallId !== sourceToolCallId || record.sourceToolCallId !== sourceToolCallId) {
      return registrationFailure("the capture action does not belong to this source tool call");
    }
    if (record.state !== "succeeded" || record.selection === null) {
      return registrationFailure(record.conflictReason ?? "the capture action has no successful retained response");
    }
    if (exactCaptureResponse !== record.selection) {
      return registrationFailure("the capture response is not the exact retained action response");
    }
    if (originalActionSignal !== record.signal) {
      return registrationFailure("the original capture signal is not the retained action signal");
    }
    const signal = readActualAbortSignal(originalActionSignal);
    if (!signal.ok) return registrationFailure(signal.reason);
    if (signal.aborted) {
      return registrationFailure("the original capture action signal was aborted at registration");
    }
    if (record.registrationConflict !== null) return registrationFailure(record.registrationConflict);
    checks = slot.output.checks;
    if (checks === null) return registrationFailure("the retained action state is unavailable");
    if (checks.busy) return registrationFailure("an action operation is already in progress for this source Slot");

    // The caller-supplied wire is fingerprinted once before any native call.
    checks.busy = true;
    busyAcquired = true;
    const expected = fingerprintExpectedCallResult({ input: record.input, result: actualProjectedResult });
    if (!expected.ok) {
      return registrationFailure(`result expectation unavailable: ${expected.reason}`);
    }
    if (expected.fingerprint.bytes > NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES) {
      return registrationFailure("the capture result projection envelope exceeds the 64 KiB bound");
    }
    if (expected.inputFingerprint.sha256 !== record.inputSha256) {
      return registrationFailure("the projected input fingerprint is not the retained capture input");
    }

    const source = prepareCaptureSource(state, slot, true);
    if ("ok" in source) return registrationFailure(source.reason);
    const existing = captureActionRegistration(record);
    if (existing === undefined) {
      return registrationFailure("the retained capture registration fingerprint is incomplete");
    }
    const action = prepareCaptureActionGate(state, slot, record, source.prepared.context, existing);
    if (isOutputFailure(action)) return registrationFailure(action.reason);
    const registrationChanged = existing !== null
      && (existing.sha256 !== expected.fingerprint.sha256
        || existing.bytes !== expected.fingerprint.bytes);
    if (registrationChanged) {
      const beforeMutation = finalCaptureActionGate(
        state,
        slot,
        source,
        action,
        record,
        originalActionSignal,
      );
      if (beforeMutation !== null) return registrationFailure(beforeMutation.reason);
      record.registrationConflict = "a different result projection was already registered for this capture action";
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
      return registrationFailure("the native registered fingerprint is not the precomputed capture projection");
    }

    // Registration replaced the native expectation identity. Refresh source and
    // action prepared checks; the pre-registration pure checks are stale.
    const refreshedSource = prepareCaptureSource(state, slot, true);
    if ("ok" in refreshedSource) return registrationFailure(refreshedSource.reason);
    if (refreshedSource.prepared.workPromptSha256 !== source.prepared.workPromptSha256
      || refreshedSource.prepared.callInputSha256 !== source.prepared.callInputSha256) {
      return registrationFailure("the original source work prompt or call input changed during registration");
    }
    const refreshedAction = prepareCaptureActionGate(
      state,
      slot,
      record,
      refreshedSource.prepared.context,
      expected.fingerprint,
    );
    if (isOutputFailure(refreshedAction)) return registrationFailure(refreshedAction.reason);
    const final = finalCaptureActionGate(
      state,
      slot,
      refreshedSource,
      refreshedAction,
      record,
      originalActionSignal,
    );
    if (final !== null) return registrationFailure(final.reason);
    if (state.disposed || !state.enabled) {
      return registrationFailure("the delegation coordinator changed during capture registration");
    }
    if (state.slots.get(sourceToolCallId) !== slot
      || slot.output.checks !== checks
      || checks.actions.get(actionToolCallId) !== record
      || record.state !== "succeeded"
      || record.selection !== exactCaptureResponse
      || record.signal !== originalActionSignal
      || record.registrationConflict !== null) {
      return registrationFailure("the retained capture action changed during registration");
    }
    if (record.registrationSha256 !== null || record.registrationBytes !== null) {
      if (record.registrationSha256 !== expected.fingerprint.sha256
        || record.registrationBytes !== expected.fingerprint.bytes) {
        record.registrationConflict = "a different result projection was already registered for this capture action";
        return registrationFailure(record.registrationConflict);
      }
      return registrationSuccess();
    }
    record.registrationSha256 = expected.fingerprint.sha256;
    record.registrationBytes = expected.fingerprint.bytes;
    record.registrationConflict = null;
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

type PreparedBackendOutcome =
  | {
      readonly ok: true;
      readonly backend: BackendPort;
      readonly accountingPrepared: NativeHarnessAccountingPrepared | null;
    }
  | { readonly ok: false; readonly reason: string };

function readPreparedBackend(raw: unknown, durable: boolean): PreparedBackendOutcome {
  const allowed = durable
    ? ["ok", "backend", "reason", "accountingPrepared"]
    : ["ok", "backend", "reason"];
  const fields = readStrictFields(raw, allowed, ["ok"]);
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
  let accountingPrepared: NativeHarnessAccountingPrepared | null = null;
  if (durable) {
    const prepared = readAccountingPrepared(fields.get("accountingPrepared"));
    if (!prepared.ok) return { ok: false, reason: prepared.reason };
    accountingPrepared = prepared.prepared;
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
    accountingPrepared,
  };
}

type PrepareOutcome =
  | {
      readonly kind: "backend";
      readonly backend: BackendPort;
      readonly accountingPrepared: NativeHarnessAccountingPrepared | null;
    }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "expired" };

async function invokePrepare(
  slot: Slot,
  context: NativeContext | null,
  accountingFacts: NativeHarnessPrepareAccounting | null,
): Promise<PrepareOutcome> {
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
    ...(accountingFacts === null ? {} : { accounting: accountingFacts }),
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
  const backend = readPreparedBackend(value, accountingFacts !== null);
  return backend.ok
    ? {
        kind: "backend",
        backend: backend.backend,
        accountingPrepared: backend.accountingPrepared,
      }
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

function accountingErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, "code");
  } catch {
    return null;
  }
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

type AccountingCommitFailure = {
  readonly ok: false;
  readonly reason: string;
  readonly ambiguous: boolean;
  readonly code: string | null;
};

type AccountingCommitOutcome =
  | { readonly ok: true; readonly checkpoint: NativeHarnessAccountingCheckpoint }
  | AccountingCommitFailure;

function accountingCommitFailure(error: unknown): AccountingCommitFailure {
  const code = accountingErrorCode(error);
  return {
    ok: false,
    reason: `durable accounting commit failed: ${boundedReason(error, "unreadable accounting failure")}`,
    // Only A2a1 `ambiguous` (or an unreadable foreign failure) may have written.
    ambiguous: code === null || code === "ambiguous",
    code,
  };
}

function markAccountingUnavailable(slot: Slot, reason: string): void {
  const state = slotState(slot);
  if (state !== null) state.accountingUnavailableReason = reason;
  slot.accounting.unavailableReason = reason;
  slot.accounting.phase = "unavailable";
}

/**
 * One bounded CAS commit on the exact current handle revision. The original
 * commit promise stays attached after a grace expiry; no retry is attempted.
 */
async function commitAccounting(
  slot: Slot,
  kind: AccountingPendingKind,
  transition: Record<string, unknown>,
): Promise<AccountingCommitOutcome> {
  const state = slotState(slot);
  const accounting = slot.accounting;
  if (state === null || state.accounting === null
    || accounting.handle === null || accounting.checkpoint === null) {
    const reason = "durable accounting is unavailable for this admission";
    markAccountingUnavailable(slot, reason);
    return {
      ok: false,
      reason,
      ambiguous: false,
      code: "unavailable",
    };
  }
  const expectedRevision = accounting.checkpoint.revision;
  let promise: Promise<NativeHarnessAccountingCheckpoint>;
  try {
    promise = accounting.handle.commit(
      expectedRevision,
      JSON.stringify(transition),
    ) as Promise<NativeHarnessAccountingCheckpoint>;
  } catch (error) {
    const failure = accountingCommitFailure(error);
    markAccountingUnavailable(slot, failure.reason);
    return failure;
  }
  if (!consumeNativePromise(promise)) {
    const reason = "durable accounting commit did not return a native Promise";
    markAccountingUnavailable(slot, reason);
    return {
      ok: false,
      reason,
      ambiguous: true,
      code: null,
    };
  }
  void promise.catch(() => undefined);
  accounting.pending = promise;
  accounting.pendingKind = kind;
  void promise.then(
    (value) => {
      if (accounting.pending === promise) {
        accounting.pending = null;
        accounting.pendingKind = null;
      }
      if (!observeAccountingCheckpoint(slot, value)) {
        markAccountingUnavailable(
          slot,
          "accounting acknowledgement did not match the fixed owner, limits and projection",
        );
      }
    },
    () => {
      if (accounting.pending === promise) {
        accounting.pending = null;
        accounting.pendingKind = null;
      }
    },
  );
  const waited = await awaitWithCleanup(slot, promise);
  if (waited.kind === "expired") {
    const reason = `durable accounting ${kind} did not settle within the cleanup grace window`;
    markAccountingUnavailable(slot, reason);
    return { ok: false, reason, ambiguous: true, code: null };
  }
  if (waited.kind === "error") {
    const failure = accountingCommitFailure(waited.error);
    markAccountingUnavailable(slot, failure.reason);
    return failure;
  }
  if (waited.value.revision !== expectedRevision + 1) {
    const reason = "accounting commit returned an unexpected revision";
    markAccountingUnavailable(slot, reason);
    return { ok: false, reason, ambiguous: true, code: null };
  }
  if (!observeAccountingCheckpoint(slot, waited.value)) {
    const reason = "accounting commit returned facts outside the fixed owner and limits";
    markAccountingUnavailable(slot, reason);
    return { ok: false, reason, ambiguous: true, code: null };
  }
  return { ok: true, checkpoint: waited.value };
}

function reserveTransition(slot: Slot): Record<string, unknown> {
  const state = slotState(slot);
  if (state === null) return {};
  return {
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "reserve",
    admissionId: slot.accounting.admissionId,
    sourceAssociationSha256: slot.accounting.sourceAssociationSha256,
    admittedAt: slot.admittedAt,
    deadlineAt: slot.deadlineAt,
    allocatedUsd: state.limits.perRunUsd,
  };
}

function bindPreparedTransition(
  slot: Slot,
  prepared: NativeHarnessAccountingPrepared,
): Record<string, unknown> {
  return {
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "bindPrepared",
    admissionId: slot.accounting.admissionId,
    prepared: { ...prepared },
  };
}

function bindRunTransition(slot: Slot, runId: string): Record<string, unknown> {
  return {
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "bindRun",
    admissionId: slot.accounting.admissionId,
    runId,
  };
}

function blockBudgetTransition(slot: Slot): Record<string, unknown> {
  return {
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "blockBudget",
    admissionId: slot.accounting.admissionId,
  };
}

function settleTransition(
  slot: Slot,
  facts: AccountingFixedFacts,
): Record<string, unknown> {
  const mode: NativeHarnessAccountingSettlementMode = facts.noDispatch
    ? "no-dispatch"
    : facts.known
      ? "known"
      : "unknown";
  return {
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "settle",
    admissionId: slot.accounting.admissionId,
    mode,
    observedUsd: mode === "unknown" ? facts.observedUsd : (facts.observedUsd ?? 0),
    concurrencyHeld: mode === "unknown" ? facts.concurrencyHeld : false,
  };
}

function closeAccountingHandle(slot: Slot): void {
  const accounting = slot.accounting;
  if (accounting.handle === null) return;
  const handle = accounting.handle;
  if (accounting.pending !== null) {
    // The in-flight write owns the handle until it really settles.
    void accounting.pending.then(
      () => {
        try {
          handle.close();
        } catch {
          // Already closed.
        }
      },
      () => {
        try {
          handle.close();
        } catch {
          // Already closed.
        }
      },
    );
    return;
  }
  try {
    handle.close();
  } catch {
    // Already closed.
  }
}

/**
 * After an already-published unknown/unconfirmed terminal wire, observe only
 * the original in-flight promise and close the handle when it really settles.
 * Never start a new reserve/link/block/settle write and never release local
 * occupancy from late evidence.
 */
function armLateAccountingCompletion(slot: Slot): void {
  const accounting = slot.accounting;
  if (accounting.lateSettlementArmed || accounting.pending === null) return;
  accounting.lateSettlementArmed = true;
  const pending = accounting.pending;
  void pending.then(
    (value) => {
      // The original write may have succeeded after the grace window. Mirror
      // the real checkpoint but do not publish, refund or start another write.
      observeAccountingCheckpoint(slot, value);
      closeAccountingHandle(slot);
    },
    () => {
      closeAccountingHandle(slot);
    },
  );
}

function factsForAccounting(
  slot: Slot,
  args: {
    readonly noDispatch: boolean;
    readonly knownObservedCost: boolean;
    readonly backendStatus: NativeHarnessBackendStatus | null;
    readonly executionState: NativeHarnessExecutionState;
    readonly releaseConcurrency: boolean;
  },
): AccountingFixedFacts {
  // Read actual prepare/cleanup facts before the finalization latch clears the
  // preparation gate for later effect prevention.
  const prepareOpen = slot.prepareOpen;
  const noDispatch = args.noDispatch
    && args.executionState === "not-started"
    && slot.runId === null
    && !slot.createStarted
    && !slot.executionStarted
    && !prepareOpen
    && slot.accounting.pending === null;
  const known = args.knownObservedCost
    && !noDispatch
    && slot.runId !== null
    && slot.accounting.runConfirmed
    && slot.executionSettled
    && slot.workerPromises.size === 0
    && slot.workerCount > 0
    && slot.workerAllKnownCompleted
    && !slot.workerUnknownUsage
    && !slot.cancelRequested
    && args.backendStatus === "completed";
  const observedUsd = noDispatch
    ? 0
    : slot.observedAny
      ? money(slot.observedCostUsd)
      : null;
  let concurrencyHeld = false;
  if (!noDispatch && !known) {
    concurrencyHeld = true;
    if (slot.runId === null) {
      // An in-flight preparation or a create that may have taken effect is
      // never proof that cleanup settled. A thrown create stays held.
      concurrencyHeld = slot.createStarted ? true : prepareOpen;
    } else if (!slot.executionStarted) {
      concurrencyHeld = !(slot.cancelSettled && slot.cancelState !== "request-failed");
    } else {
      concurrencyHeld = !(slot.executionSettled && slot.workerPromises.size === 0);
    }
    // The caller's own execution/cleanup classification is authoritative when
    // it says the wait expired or local occupancy must remain conservative.
    if (args.executionState === "pending-unknown" || !args.releaseConcurrency) {
      concurrencyHeld = true;
    }
  }
  return Object.freeze({ noDispatch, known, observedUsd, concurrencyHeld, canSettle: true });
}

async function attemptAccountingSettlement(
  slot: Slot,
  facts: AccountingFixedFacts,
): Promise<boolean> {
  const state = slotState(slot);
  const accounting = slot.accounting;
  if (state === null || accounting.reserveRevision === null || accounting.handle === null) {
    return false;
  }
  if (accounting.settleStarted) return accounting.settleConfirmed;
  accounting.settleStarted = true;
  if (state.budgetBlocked
    && !accounting.blockCommitted
    && state.accountingCache?.projection.budgetBlocked !== true) {
    const blocked = await commitAccounting(slot, "blockBudget", blockBudgetTransition(slot));
    if (!blocked.ok) {
      accounting.phase = "unavailable";
      accounting.unavailableReason = blocked.reason;
      return false;
    }
    accounting.blockCommitted = true;
  }
  const settled = await commitAccounting(slot, "settle", settleTransition(slot, facts));
  if (!settled.ok) {
    accounting.phase = "unavailable";
    accounting.unavailableReason = settled.reason;
    return false;
  }
  accounting.settleConfirmed = true;
  accounting.phase = "reserved";
  return true;
}

function finishSlotDurable(
  slot: Slot,
  args: SlotFinishArgs,
): Promise<void> {
  const state = slotState(slot);
  if (state === null) return Promise.resolve();
  const accounting = slot.accounting;
  if (accounting.finalization !== null) return accounting.finalization;
  // Snapshot the original cleanup facts before mutating any effect gate.
  const facts = factsForAccounting(slot, args);
  // One synchronous latch promise is installed before every callback-rich
  // clock/native read below. A reentrant finish returns this exact promise.
  const completion = deferred<void>();
  accounting.finalization = completion.promise;
  accounting.finalFacts = facts;
  accounting.finalizing = true;
  slot.dispatchClosed = true;
  slot.prepareOpen = false;

  void (async (): Promise<void> => {
    let settlementUnavailable = false;
    try {
      if (accounting.pending !== null) {
        const waited = await awaitWithCleanup(slot, accounting.pending);
        if (waited.kind === "expired") {
          settlementUnavailable = true;
          accounting.phase = "unavailable";
          accounting.unavailableReason = "durable accounting write did not settle within the cleanup grace window";
        }
      }
      if (!settlementUnavailable && accounting.reserveRevision !== null) {
        const confirmed = await attemptAccountingSettlement(slot, facts);
        if (!confirmed) settlementUnavailable = true;
      }
      const finishedAt = readClock(state.now) ?? slot.admittedAt;
      // Settlement facts are fixed; authority/clock facts are read fresh again.
      const finalGate = authorityGate(slot, "effect");
      if (slot.state !== "running" || !accounting.finalizing) return;
      if (accounting.identity !== null
        && state.accountingOwnerIdentity !== null
        && (accounting.identity.ownerId !== state.accountingOwnerIdentity.ownerId
          || accounting.identity.selectorSha256 !== state.accountingOwnerIdentity.selectorSha256)) {
        settlementUnavailable = true;
        accounting.unavailableReason = "durable accounting owner identity changed before publication";
      }
      const unresolved = settlementUnavailable
        || (accounting.reserveRevision !== null && !accounting.settleConfirmed);
      if (unresolved) {
        const unresolvedReason = accounting.unavailableReason ?? "durable accounting settlement is unconfirmed";
        state.accountingUnavailableReason = unresolvedReason;
        const retainedLimitations = [
          ...(args.extraLimitations ?? []),
          "Durable accounting settlement was not confirmed; local concurrency and allocation conservatively remain retained.",
        ];
        publishSlotResult(slot, {
          outcome: "unknown",
          reason: unresolvedReason,
          authorityFresh: false,
          executionState: "pending-unknown",
          termination: terminationFor(slot, finalGate, slot.backendStatus),
          backendStatus: slot.backendStatus,
          knownObservedCost: false,
          noDispatch: false,
          releaseConcurrency: false,
          finishedAt,
          extraLimitations: retainedLimitations,
        });
        return;
      }
      const backendStatus = slot.backendStatus;
      const outcomeAtGate = outcomeFor(slot, backendStatus, finalGate);
      const outcome = finalGate === null && args.outcome === "refused"
        ? "refused"
        : finalGate === null && args.outcome === "unknown"
          ? "unknown"
          : outcomeAtGate;
      const release = accounting.reserveRevision === null
        ? args.releaseConcurrency
        : facts.noDispatch || facts.known || !facts.concurrencyHeld;
      publishSlotResult(slot, {
        outcome,
        reason: finalGate ?? args.reason ?? (backendStatus === "completed"
          ? "the Harness2 backend reported completion; task acceptance was not evaluated"
          : `backend status ${backendStatus ?? "unknown"}`),
        authorityFresh: finalGate === null
          && args.executionState === "settled"
          && args.outcome !== "unknown",
        executionState: args.executionState,
        termination: terminationFor(slot, finalGate, backendStatus),
        backendStatus,
        knownObservedCost: facts.known,
        noDispatch: facts.noDispatch,
        releaseConcurrency: release,
        finishedAt,
        ...(args.extraLimitations === undefined ? {} : { extraLimitations: args.extraLimitations }),
      });
    } catch (error) {
      const reason = `durable accounting finalization failed: ${boundedReason(error, "unreadable failure")}`;
      markAccountingUnavailable(slot, reason);
      if (slot.state === "running") {
        publishSlotResult(slot, {
          outcome: "unknown",
          reason,
          authorityFresh: false,
          executionState: "pending-unknown",
          termination: terminationFor(slot, null, slot.backendStatus),
          backendStatus: slot.backendStatus,
          knownObservedCost: false,
          noDispatch: false,
          releaseConcurrency: false,
          finishedAt: readClock(state.now) ?? slot.admittedAt,
          ...(args.extraLimitations === undefined ? {} : { extraLimitations: args.extraLimitations }),
        });
      }
    } finally {
      accounting.finalizing = false;
      if (accounting.pending !== null) armLateAccountingCompletion(slot);
      else closeAccountingHandle(slot);
      completion.resolve();
    }
  })();
  return completion.promise;
}

interface SlotFinishArgs {
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
}

function finishSlot(
  slot: Slot,
  args: SlotFinishArgs,
): void | Promise<void> {
  const state = slotState(slot);
  if (state === null) return;
  if (state.accounting === null) {
    publishSlotResult(slot, args);
    return;
  }
  return finishSlotDurable(slot, args);
}

function publishSlotResult(
  slot: Slot,
  args: SlotFinishArgs,
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

  if (state.accounting === null) {
    settleLifetime(slot, args.knownObservedCost, observedUsd ?? 0, args.noDispatch);
  }
  slot.state = "settled";
  if (state.accounting !== null
    && slot.accounting.reserveRevision === null
    && slot.accounting.phase === "associating") {
    // A pre-reserve refusal is terminal and no association/open is in flight.
    slot.accounting.phase = "idle";
  }
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
    await finishSlot(slot, {
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
      await finishSlot(slot, {
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
    await finishSlot(slot, {
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
    await finishSlot(slot, {
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
  await finishSlot(slot, {
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

async function reserveDurableAdmission(
  slot: Slot,
  state: CoordinatorState,
  context: NativeContext,
): Promise<{ readonly kind: "ready" } | { readonly kind: "finished" }> {
  const runtime = state.accounting;
  if (runtime === null) return { kind: "ready" };
  const refuse = async (
    reason: string,
    noDispatch: boolean,
    releaseConcurrency: boolean,
    outcome: NativeHarnessOutcome = "refused",
  ): Promise<{ readonly kind: "finished" }> => {
    await finishSlot(slot, {
      outcome,
      reason,
      authorityFresh: false,
      executionState: noDispatch ? "not-started" : "pending-unknown",
      termination: terminationFor(slot, null, null),
      backendStatus: null,
      knownObservedCost: false,
      noDispatch,
      releaseConcurrency,
    });
    return { kind: "finished" };
  };
  if (!Number.isSafeInteger(slot.admittedAt) || !Number.isSafeInteger(slot.deadlineAt)) {
    return refuse(
      "durable accounting requires safe-integer admittedAt and deadlineAt facts; no rounding was applied",
      true,
      true,
    );
  }

  let rawAssociation: unknown;
  try {
    rawAssociation = Reflect.apply(runtime.associate, runtime.receiver, [
      context,
      slot.signal,
      slot.deadlineAt,
      runtime.limitsText,
    ]);
  } catch (error) {
    return refuse(`trusted accounting association threw: ${boundedReason(error, "unreadable failure")}`, true, true);
  }
  if (!consumeNativePromise(rawAssociation)) {
    return refuse("trusted accounting association did not return a native Promise", true, true);
  }
  const associationPromise = rawAssociation as Promise<unknown>;
  void associationPromise.catch(() => undefined);
  const associated = await awaitWithCleanup(slot, associationPromise);
  if (associated.kind === "expired") {
    return refuse("trusted accounting association did not settle within the cleanup grace window", true, true);
  }
  if (associated.kind === "error") {
    return refuse(
      `trusted accounting association rejected: ${boundedReason(associated.error, "unreadable failure")}`,
      true,
      true,
    );
  }
  const identity = readAccountingIdentity(associated.value);
  if (identity === null) {
    return refuse("trusted accounting association returned no exact owner identity", true, true);
  }
  if (state.accountingOwnerIdentity === null) {
    state.accountingOwnerIdentity = identity;
  } else if (state.accountingOwnerIdentity.ownerId !== identity.ownerId
    || state.accountingOwnerIdentity.selectorSha256 !== identity.selectorSha256) {
    return refuse("trusted accounting association returned a different owner identity", true, true);
  }
  slot.accounting.identity = identity;
  slot.accounting.phase = "associating";

  const afterAssociation = authorityGate(slot, "effect");
  if (afterAssociation !== null) return refuse(afterAssociation, true, true);

  let rawOpen: unknown;
  try {
    rawOpen = openNativeHarnessAccountingOwner({
      storageRoot: runtime.storageRoot,
      selectorSha256: identity.selectorSha256,
      ownerId: identity.ownerId,
    });
  } catch (error) {
    const reason = `durable accounting owner open threw: ${boundedReason(error, "unreadable failure")}`;
    markAccountingUnavailable(slot, reason);
    return refuse(reason, true, true);
  }
  if (!consumeNativePromise(rawOpen)) {
    const reason = "durable accounting owner open did not return a native Promise";
    markAccountingUnavailable(slot, reason);
    return refuse(reason, true, true);
  }
  const openPromise = rawOpen as Promise<NativeHarnessAccountingHandle>;
  void openPromise.catch(() => undefined);
  const opened = await awaitWithCleanup(slot, openPromise);
  if (opened.kind === "expired") {
    // A late handle owns no reservation and must close without another effect.
    void openPromise.then(
      (handle) => {
        try {
          handle.close();
        } catch {
          // Already closed.
        }
      },
      () => undefined,
    );
    const reason = "durable accounting owner open did not settle within the cleanup grace window";
    markAccountingUnavailable(slot, reason);
    return refuse(reason, true, true);
  }
  if (opened.kind === "error") {
    const reason = `durable accounting owner open was refused: ${boundedReason(opened.error, "unreadable failure")}`;
    markAccountingUnavailable(slot, reason);
    return refuse(reason, true, true);
  }
  const handle = opened.value;
  slot.accounting.handle = handle;
  const checkpoint = handle.snapshot();
  if (checkpoint.ownerId !== identity.ownerId || checkpoint.selectorSha256 !== identity.selectorSha256) {
    closeAccountingHandle(slot);
    const reason = "durable accounting owner identity changed before reserve";
    markAccountingUnavailable(slot, reason);
    return refuse(reason, true, true);
  }
  if (!sameAccountingLimits(checkpoint.limits, state.limits)) {
    closeAccountingHandle(slot);
    const reason = "stored durable accounting limits differ from this coordinator's normalized limits";
    markAccountingUnavailable(slot, reason);
    return refuse(reason, true, true);
  }
  let projection: NativeHarnessAccountingProjection;
  try {
    projection = projectNativeHarnessAccounting(checkpoint);
  } catch (error) {
    closeAccountingHandle(slot);
    const reason = `durable accounting checkpoint is unreadable: ${boundedReason(error, "unreadable failure")}`;
    markAccountingUnavailable(slot, reason);
    return refuse(reason, true, true);
  }
  if (!observeAccountingCheckpoint(slot, checkpoint)) {
    closeAccountingHandle(slot);
    const reason = "durable accounting checkpoint did not match the fixed owner and limits";
    markAccountingUnavailable(slot, reason);
    return refuse(reason, true, true);
  }
  if (state.budgetBlocked || projection.budgetBlocked) {
    closeAccountingHandle(slot);
    return refuse("the durable accounting budget is blocked", true, true);
  }
  if (projection.retainedOperations >= state.limits.maxRetainedOperations) {
    closeAccountingHandle(slot);
    return refuse("the durable accounting retained-operation limit is exhausted", true, true);
  }
  if (projection.activeOperations >= state.limits.maxConcurrent) {
    closeAccountingHandle(slot);
    return refuse("the durable accounting concurrency is already retained", true, true);
  }
  if (projection.accountedUsd + state.limits.perRunUsd > state.limits.lifetimeUsd + USD_EPSILON) {
    closeAccountingHandle(slot);
    return refuse("the durable accounting lifetime budget is exhausted or reserved", true, true);
  }

  const beforeReserve = authorityGate(slot, "effect");
  if (beforeReserve !== null) {
    closeAccountingHandle(slot);
    return refuse(beforeReserve, true, true);
  }

  const reserved = await commitAccounting(slot, "reserve", reserveTransition(slot));
  if (!reserved.ok) {
    if (reserved.ambiguous) {
      slot.accounting.phase = "unavailable";
      return refuse(reserved.reason, false, false, "unknown");
    }
    closeAccountingHandle(slot);
    return refuse(reserved.reason, true, true);
  }
  slot.accounting.reserveRevision = reserved.checkpoint.revision;
  slot.accounting.phase = "reserved";
  return { kind: "ready" };
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
      await finishSlot(slot, {
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

    let prepareAccounting: NativeHarnessPrepareAccounting | null = null;
    if (state.accounting !== null) {
      if (prepareContext === null) {
        await finishSlot(slot, {
          outcome: "refused",
          reason: "the gated main context is unavailable",
          authorityFresh: false,
          executionState: "not-started",
          termination: terminationFor(slot, null, null),
          backendStatus: null,
          knownObservedCost: false,
          noDispatch: true,
          releaseConcurrency: true,
        });
        return;
      }
      const reserved = await reserveDurableAdmission(slot, state, prepareContext);
      if (reserved.kind === "finished") return;
      const identity = slot.accounting.identity;
      const reserveRevision = slot.accounting.reserveRevision;
      if (identity === null || reserveRevision === null) {
        await finishSlot(slot, {
          outcome: "unknown",
          reason: "durable accounting reserve facts are unavailable before preparation",
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
      prepareAccounting = Object.freeze({
        ownerId: identity.ownerId,
        admissionId: slot.accounting.admissionId,
        reserveRevision,
        sourceAssociationSha256: slot.accounting.sourceAssociationSha256,
        admittedAt: slot.admittedAt,
      });
      const afterReserve = authorityGate(slot, "effect", (context) => {
        prepareContext = context;
      });
      if (afterReserve !== null) {
        await finishSlot(slot, {
          outcome: "refused",
          reason: afterReserve,
          authorityFresh: false,
          executionState: "not-started",
          termination: terminationFor(slot, afterReserve, null),
          backendStatus: null,
          knownObservedCost: false,
          noDispatch: true,
          releaseConcurrency: true,
        });
        return;
      }
      if (prepareContext === null) {
        await finishSlot(slot, {
          outcome: "refused",
          reason: "the post-reserve main context is unavailable",
          authorityFresh: false,
          executionState: "not-started",
          termination: terminationFor(slot, null, null),
          backendStatus: null,
          knownObservedCost: false,
          noDispatch: true,
          releaseConcurrency: true,
        });
        return;
      }
    }

    const prepared = await invokePrepare(slot, prepareContext, prepareAccounting);
    if (prepared.kind === "expired") {
      await finishSlot(slot, {
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
      await finishSlot(slot, {
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

    if (state.accounting === null) {
      const afterPrepare = authorityGate(slot, "effect");
      if (afterPrepare !== null) {
        await finishSlot(slot, {
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
    } else {
      const accountingPrepared = prepared.accountingPrepared;
      if (accountingPrepared === null) {
        await finishSlot(slot, {
          outcome: "refused",
          reason: "trusted prepare returned no durable accountingPrepared facts",
          authorityFresh: false,
          executionState: "not-started",
          termination: terminationFor(slot, null, null),
          backendStatus: null,
          knownObservedCost: false,
          noDispatch: true,
          releaseConcurrency: true,
        });
        return;
      }
      const beforeBind = authorityGate(slot, "effect");
      if (beforeBind !== null) {
        await finishSlot(slot, {
          outcome: "refused",
          reason: beforeBind,
          authorityFresh: false,
          executionState: "not-started",
          termination: terminationFor(slot, beforeBind, null),
          backendStatus: null,
          knownObservedCost: false,
          noDispatch: true,
          releaseConcurrency: true,
        });
        return;
      }
      const bound = await commitAccounting(
        slot,
        "bindPrepared",
        bindPreparedTransition(slot, accountingPrepared),
      );
      if (!bound.ok) {
        await finishSlot(slot, {
          outcome: "unknown",
          reason: bound.reason,
          authorityFresh: false,
          executionState: "not-started",
          termination: terminationFor(slot, null, null),
          backendStatus: null,
          knownObservedCost: false,
          noDispatch: !bound.ambiguous,
          releaseConcurrency: !bound.ambiguous,
        });
        return;
      }
      slot.accounting.preparedConfirmed = true;
      if (slot.cancelRequested) {
        await finishCancelledWithoutExecution(slot);
        return;
      }
      const afterBind = authorityGate(slot, "effect");
      if (afterBind !== null) {
        await finishSlot(slot, {
          outcome: "refused",
          reason: afterBind,
          authorityFresh: false,
          executionState: "not-started",
          termination: terminationFor(slot, afterBind, null),
          backendStatus: null,
          knownObservedCost: false,
          noDispatch: true,
          releaseConcurrency: true,
        });
        return;
      }
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
      await finishSlot(slot, {
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
      await finishSlot(slot, {
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
      await finishSlot(slot, {
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

    // A cancellation requested before create had no actual target. As soon as
    // the original Slot retains a real runId, dispatch the original cancel
    // before any durable link await so the request is not delayed.
    if (slot.cancelRequested) requestBackendCancel(slot);

    if (state.accounting !== null) {
      const linked = await commitAccounting(slot, "bindRun", bindRunTransition(slot, runId));
      if (!linked.ok) {
        if (slot.cancelState === "none") requestBackendCancel(slot);
        await finishSlot(slot, {
          outcome: "unknown",
          reason: linked.reason,
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
      slot.accounting.runConfirmed = true;
    }

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
      await finishSlot(slot, {
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

    const finishedAt = readClock(state.now) ?? slot.admittedAt;
    if (state.accounting !== null) {
      const knownObservedCost = slot.backendStatus === "completed"
        && slot.workerCount > 0
        && slot.workerAllKnownCompleted
        && !slot.workerUnknownUsage
        && !slot.cancelRequested
        && slot.executionSettled
        && slot.workerPromises.size === 0;
      await finishSlot(slot, {
        outcome: outcomeFor(slot, slot.backendStatus, null),
        reason: executionError ?? (slot.backendStatus === "completed"
          ? "the Harness2 backend reported completion; task acceptance was not evaluated"
          : `backend status ${slot.backendStatus ?? "unknown"}`),
        authorityFresh: false,
        executionState: "settled",
        termination: terminationFor(slot, null, slot.backendStatus),
        backendStatus: slot.backendStatus,
        knownObservedCost,
        noDispatch: false,
        releaseConcurrency: true,
        finishedAt,
      });
      return;
    }

    // Legacy path: all callback facts, including the finish clock, are read
    // before the final fresh/pure gate. Nothing invokes a host callback
    // between that gate and result publication.
    const finalGate = authorityGate(slot, "effect");
    const backendStatus = slot.backendStatus;
    const authorityFresh = finalGate === null;
    const knownObservedCost = backendStatus === "completed"
      && slot.workerCount > 0
      && slot.workerAllKnownCompleted
      && !slot.workerUnknownUsage
      && !slot.cancelRequested
      && slot.executionSettled
      && slot.workerPromises.size === 0;
    await finishSlot(slot, {
      outcome: outcomeFor(slot, backendStatus, finalGate),
      reason: finalGate ?? executionError ?? (backendStatus === "completed"
        ? "the Harness2 backend reported completion; task acceptance was not evaluated"
        : `backend status ${backendStatus ?? "unknown"}`),
      authorityFresh,
      executionState: "settled",
      termination: terminationFor(slot, finalGate, backendStatus),
      backendStatus,
      knownObservedCost,
      noDispatch: false,
      releaseConcurrency: true,
      finishedAt,
    });
  } catch (error) {
    await finishSlot(slot, {
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
    accounting: state.accounting === null
      ? {
          admissionId: "",
          identity: null,
          handle: null,
          checkpoint: null,
          reserveRevision: null,
          sourceAssociationSha256: "",
          preparedConfirmed: false,
          runConfirmed: false,
          phase: "idle",
          pending: null,
          pendingKind: null,
          settleStarted: false,
          settleConfirmed: false,
          blockCommitted: false,
          finalizing: false,
          finalization: null,
          finalFacts: null,
          lateSettlementArmed: false,
          unavailableReason: null,
        }
      : {
          admissionId: randomUUID(),
          identity: null,
          handle: null,
          checkpoint: null,
          reserveRevision: null,
          sourceAssociationSha256: associationSourceSha256(association),
          preparedConfirmed: false,
          runConfirmed: false,
          phase: "idle",
          pending: null,
          pendingKind: null,
          settleStarted: false,
          settleConfirmed: false,
          blockCommitted: false,
          finalizing: false,
          finalization: null,
          finalFacts: null,
          lateSettlementArmed: false,
          unavailableReason: null,
        },
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
      actionBinding: null,
      reportRecords: [],
      reportAttempts: 0,
      reportActive: null,
      reportCurrentUseRefusal: null,
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
  let accountingView: NativeHarnessSnapshotAccounting | undefined;
  let lifetime: NativeHarnessDelegationSnapshot["lifetime"] = {
    limitUsd: state.limits.lifetimeUsd,
    accountedUsd: state.lifetimeAccountedUsd,
    observedUsd: state.lifetimeObservedUsd,
    unknownUsd: state.lifetimeUnknownUsd,
    overspendUsd: state.lifetimeOverspendUsd,
    budgetBlocked: state.budgetBlocked,
  };
  if (state.accounting !== null) {
    const cache = state.accountingCache;
    let pending = false;
    for (const slot of state.slots.values()) {
      if (slot.state !== "running") continue;
      if (slot.accounting.pending !== null
        || slot.accounting.finalizing
        || slot.accounting.phase === "associating") {
        pending = true;
        break;
      }
    }
    const observation = pending
      ? "pending"
      : state.accountingUnavailableReason !== null
        ? "unavailable"
        : cache === null
          ? "unloaded"
          : "observed";
    accountingView = Object.freeze({
      observation,
      revision: cache === null ? null : cache.checkpoint.revision,
      lastCheckpoint: cache === null ? null : cache.projection,
      reason: state.accountingUnavailableReason,
    });
    // Lifetime fields mirror the last real checkpoint projection. Unloaded or
    // stale zeros are explicitly not claimed as persistent totals.
    lifetime = {
      limitUsd: state.limits.lifetimeUsd,
      accountedUsd: cache === null ? 0 : cache.projection.accountedUsd,
      observedUsd: cache === null ? 0 : cache.projection.observedUsd,
      unknownUsd: cache === null ? 0 : cache.projection.unknownUsd,
      overspendUsd: cache === null ? 0 : cache.projection.overspendUsd,
      budgetBlocked: cache === null ? state.budgetBlocked : cache.projection.budgetBlocked,
    };
  }
  return deepFreeze({
    schema: NATIVE_HARNESS_DELEGATION_SNAPSHOT_SCHEMA,
    enabled: state.enabled,
    disposed: state.disposed,
    limits: state.limits,
    retainedOperations: state.slots.size,
    activeOperations: state.activeOperations,
    ...(accountingView === undefined ? {} : { accounting: accountingView }),
    output: {
      retainedCaptures: state.outputRetained,
      retainedBytes: state.outputBytes,
      reservedBytes: state.outputReservedBytes,
      active: state.outputActive !== null,
      maxCaptures: NATIVE_HARNESS_MAX_OUTPUT_CAPTURES,
      maxBytes: NATIVE_HARNESS_MAX_OUTPUT_BYTES,
      reservationBytes: NATIVE_HARNESS_OUTPUT_RESERVATION_BYTES,
    },
    lifetime,
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
  if (state.accounting === null) state.lifetimeAccountedUsd += state.limits.perRunUsd;
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
  if (state.accounting !== null) {
    // Persistent active/balance/retained facts are checked only after a fresh
    // exact-open for each new admission. The cache is last-observation
    // metadata, never a permit or refusal authority.
    return null;
  }
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
    ["native", "policy", "getContext", "prepare", "runner", "now", "enabled", "output", "accounting"],
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
  const accounting = readAccountingPort(fields.get("accounting"), limits);
  const state: CoordinatorState = {
    native: {
      receiver: nativeValue as NativeEntryControls,
      captureCall: captureCall as NativeCallPort["captureCall"],
      prepareCallCheck: prepareCallCheck as NativeCallPort["prepareCallCheck"],
      registerCallResultExpectation: registerCallResultExpectation as NativeCallPort["registerCallResultExpectation"],
    },
    output: readOutputPort(fields.get("output")),
    accounting,
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
    accountingOwnerIdentity: null,
    accountingCache: null,
    accountingUnavailableReason: null,
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
    outputObservationInProgress: false,
    reportBindingInProgress: false,
    reportRereadInProgress: false,
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
      return captureOutputInternal(state, actualSourceToolCallId, captureSignal, null);
    },
    captureOutputForCall(
      actualActionToolCallId: unknown,
      input: unknown,
      actualSignal: unknown,
    ): Promise<NativeHarnessOutputSelection> {
      return captureOutputForCallInternal(
        state,
        actualActionToolCallId,
        input,
        actualSignal,
      );
    },
    readOutputForCall(
      actualReadToolCallId: unknown,
      input: unknown,
      actualSignal: unknown,
    ): NativeHarnessReadSelection {
      return readOutputForCallInternal(
        state,
        actualReadToolCallId,
        input,
        actualSignal,
      );
    },
    inspectOutputsForCall(
      actualInspectToolCallId: unknown,
      input: unknown,
      actualSignal: unknown,
    ): NativeHarnessOutputCatalog {
      return inspectOutputsForCallInternal(
        state,
        actualInspectToolCallId,
        input,
        actualSignal,
      );
    },
    checkOutput(
      actualCheckToolCallId: unknown,
      input: unknown,
      actualSignal: unknown,
    ): NativeHarnessCheckOutcome {
      return checkOutputInternal(state, actualCheckToolCallId, input, actualSignal);
    },
    prepareReport(
      request: unknown,
      actualSignal: unknown,
    ): NativeHarnessReportBindingResult {
      return prepareReportInternal(state, request, actualSignal);
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
    registerOutputCaptureProjection(
      actualSourceToolCallId: unknown,
      actualActionToolCallId: unknown,
      exactCaptureResponse: unknown,
      actualProjectedResult: unknown,
      originalActionSignal: unknown,
    ): { readonly ok: boolean; readonly reason: string | null } {
      return registerOutputCaptureProjectionInternal(
        state,
        actualSourceToolCallId,
        actualActionToolCallId,
        exactCaptureResponse,
        actualProjectedResult,
        originalActionSignal,
      );
    },
    cancel(actualToolCallId: unknown): boolean {
      const toolCallId = boundedString(actualToolCallId, MAX_TOOL_CALL_ID_CHARS);
      if (toolCallId === null) return false;
      let cancelled = false;
      const slot = state.slots.get(toolCallId);
      if (slot !== undefined) {
        if (slot.state === "running" && !slot.cancelRequested) {
          beginCancellation(slot, "cancel-requested");
          cancelled = true;
        }
        // A settled source may still have an independent legacy capture in
        // flight. A bound capture action owns its own cancellation and is never
        // stopped by the completed source id.
        if (slot.output.actionBinding === null
          && cancelOutputCapture(slot, "the output capture was cancelled")) {
          cancelled = true;
        }
      }
      // The actual action id selects only the record it authenticates.
      if (cancelBoundCaptureAction(state, toolCallId)) cancelled = true;
      // An actual report id selects only its exact active admitted reread. A
      // source-id cancellation above never steals that owner.
      if (cancelReportReread(state, toolCallId)) cancelled = true;
      return cancelled;
    },
    dispose(): void {
      if (state.disposed) return;
      state.disposed = true;
      for (const slot of state.slots.values()) {
        if (slot.state === "running") beginCancellation(slot, "disposed");
        const binding = slot.output.actionBinding;
        if (binding !== null) {
          cancelCaptureBinding(slot, binding, "the output capture was disposed");
        } else {
          cancelOutputCapture(slot, "the output capture was disposed");
        }
        // Independent report cleanup: never nested under capture-action state.
        cancelSlotReportReread(state, slot);
      }
    },
    inspect(): NativeHarnessDelegationSnapshot {
      return buildSnapshot(state);
    },
  });
  return coordinator;
}
