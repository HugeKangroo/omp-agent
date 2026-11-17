import { constants } from "node:fs";
import path from "node:path";
import { readActualAbortSignal } from "./native-abort.ts";
import {
  NATIVE_HARNESS_ACCOUNTING_MAX_BYTES,
} from "./native-harness-accounting.ts";
import {
  NATIVE_HARNESS_DISPATCH_INVENTORY_FILE,
  NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES,
  NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2,
  decodeNativeHarnessDispatchInventoryText,
  type NativeHarnessDispatchInventoryV2,
} from "./native-harness-dispatch-inventory.ts";
import {
  NATIVE_HARNESS_HISTORY_RECOVERY_LIMITS,
  bindNativeHarnessHistoryRecoveryWorker,
  decodeNativeHarnessHistoryProcessOwner,
  deriveNativeHarnessHistoryRecoveryTargets,
  nativeHarnessHistorySignalQuery,
  probeNativeHarnessHistoryRecoveryController,
  probeNativeHarnessHistoryRecoveryGroup,
  processReason,
  projectNativeHarnessHistoryRecoveryLifecycle,
  type NativeHarnessHistoryProcessReason,
  type NativeHarnessHistoryProcessTarget,
  type NativeHarnessHistoryRecoveryAttemptSummaryInput,
  type NativeHarnessHistoryRecoveryAttemptTarget,
  type NativeHarnessHistoryRecoveryAuxFact,
  type NativeHarnessHistoryRecoveryAuxState,
  type NativeHarnessHistoryRecoveryAuxTarget,
  type NativeHarnessHistoryRecoveryCancelSummaryInput,
  type NativeHarnessHistoryRecoveryComparison,
  type NativeHarnessHistoryRecoveryControllerSummaryInput,
  type NativeHarnessHistoryRecoveryLifecycleFacts,
  type NativeHarnessHistoryRecoveryProbeFact,
  type NativeHarnessHistoryRecoveryProjectionInput,
  type NativeHarnessHistoryRecoveryWorkerBinding,
  type NativeHarnessHistorySignalQuery,
} from "./native-harness-history-process.ts";
import {
  NATIVE_HARNESS_RECOVERY_SOURCE_FILE,
  NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES,
} from "./native-harness-recovery-source.ts";
import {
  reconcileNativeHarnessMetadata,
  type NativeHarnessReconciliationExpectation,
  type NativeHarnessReconciliationResult,
} from "./native-harness-reconciliation.ts";
import {
  NATIVE_HARNESS_RECONCILIATION_CONTENT_CHARGE_LIMIT_BYTES,
  NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS,
  NATIVE_HARNESS_RECONCILIATION_CONTENT_MAX_METADATA_BYTES,
  NATIVE_HARNESS_RECONCILIATION_CONTENT_SCHEMA,
  planNativeHarnessReconciliationContent,
  type NativeHarnessReconciliationContentReason,
  type NativeHarnessReconciliationContentPlanResult,
} from "./native-harness-reconciliation-content.ts";
import {
  createNativeHarnessContentControlFailure,
  observeNativeHarnessReconciliationContentBytes,
  type NativeHarnessOutputFailure,
  type NativeHarnessReconciliationContentByteObservation,
  type NativeHarnessReconciliationContentByteResult,
} from "./native-harness-output.ts";
import {
  NativeFileError,
  captureWorkspaceText,
  deepFreeze,
  nodeFileIo,
  type NativeFileHandle,
  type NativeFileIo,
  type NativeFileStats,
} from "./native-work.ts";

/**
 * B2b bounded, read-only double observation of the four original native
 * recovery documents.
 *
 * This leaf owns no lock, ledger, scheduler, executable handle, controller,
 * resume path, process query, artifact walk or byte reader. It pins the seven
 * original parent directories, reads each of the four exact primaries in a
 * fixed order twice through the existing `captureWorkspaceText` reader, and
 * returns bounded file facts plus the pure B2a metadata join only after both
 * passes and the final pins agree.
 *
 * Stable files are not a recoverable result: a compatible metadata join is
 * still only metadata consistency. A stable observation with incompatible
 * metadata reports `status: "stable"` and `metadataStatus: "incompatible"`,
 * never a recoverable/eligible boolean. The 5000 ms window is a soft
 * observation deadline; actual I/O and close are always observed to
 * settlement and cleanup may finish after the window.
 */

export const NATIVE_HARNESS_RECONCILIATION_FILES_SCHEMA =
  "omp-agent.native-harness-reconciliation-files.v1" as const;
export const NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS = 5_000 as const;
export const NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES = 1_212_416 as const;

const RUN_MAX_BYTES = 256 * 1024;
const MAX_PATH_CHARS = 4096;
const MAX_RELATIVE_PATH_CHARS = 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PREPARED_ROOT_PATTERN = /^omp-harness-[A-Za-z0-9]{6}$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

export type NativeHarnessReconciliationFileKey = "run" | "source" | "inventory" | "owner";

export type NativeHarnessReconciliationFilesReason =
  | "missing"
  | "unsafe-path"
  | "too-large"
  | "non-text"
  | "changed"
  | "parent-changed"
  | "close-failed"
  | "io-failed"
  | "aborted"
  | "deadline-expired";

export type NativeHarnessReconciliationFilesStatus =
  | "stable"
  | "different"
  | "unavailable"
  | "unknown"
  | "aborted"
  | "expired";

export interface NativeHarnessReconciliationFileOptions {
  /** Optional actual host AbortSignal; an already-aborted signal starts no I/O. */
  readonly signal?: AbortSignal;
  /** Existing narrow file IO test seam; production callers omit it. */
  readonly fileIo?: NativeFileIo;
  /** Existing clock test seam. It never extends or resets the one deadline. */
  readonly now?: () => number;
}

export interface NativeHarnessReconciliationFileCloseFacts {
  readonly attempted: boolean;
  readonly settled: boolean;
  readonly succeeded: boolean;
}

export interface NativeHarnessReconciliationFileCapture {
  readonly ordinal: number;
  readonly pass: 1 | 2;
  readonly file: NativeHarnessReconciliationFileKey;
  /** Charged from the fixed per-file cap before the capture entry. Never actual bytes read. */
  readonly chargedBytes: number;
  readonly outcome: "captured" | "refused";
  readonly reason: NativeHarnessReconciliationFilesReason | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly matchesFirstPass: boolean | null;
  readonly openedFiles: 0 | 1;
  readonly close: NativeHarnessReconciliationFileCloseFacts;
}

export interface NativeHarnessReconciliationFilesResult {
  readonly schema: typeof NATIVE_HARNESS_RECONCILIATION_FILES_SCHEMA;
  readonly readOnly: true;
  readonly resumeAvailable: false;
  readonly processes: "not-inspected";
  readonly artifacts: "not-inspected";
  readonly status: NativeHarnessReconciliationFilesStatus;
  readonly observation: "two-pass" | "partial";
  readonly reasons: readonly NativeHarnessReconciliationFilesReason[];
  readonly captures: readonly NativeHarnessReconciliationFileCapture[];
  /** Sum of full primary per-file caps charged before each started capture. */
  readonly chargedBytes: number;
  readonly chargeLimitBytes: typeof NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES;
  /** Primary-document capture handles only; content byte I/O is not counted. */
  readonly openedFiles: number;
  readonly maxConcurrentOpenedFiles: 1;
  /** Primary-document capture closes only; content closes are internal. */
  readonly close: {
    readonly attempted: number;
    readonly settled: number;
    readonly succeeded: number;
  };
  readonly pins: {
    readonly directoryCount: 7;
    readonly checkedAtEnd: boolean;
    readonly stable: boolean;
  };
  readonly deadline: {
    readonly budgetMs: typeof NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS;
    readonly deadlineAt: number;
    readonly checkedAt: number;
    readonly expired: boolean;
    /** Soft observation window: actual I/O/close may finish later. */
    readonly soft: true;
    readonly cleanupMayExceedDeadline: true;
  };
  /** Present only after both passes and the seven final pins agree. */
  readonly metadata: NativeHarnessReconciliationResult | null;
  readonly metadataStatus: "not-observed" | "compatible" | "incompatible";
}

export type NativeHarnessReconciliationContentPresentationStatus =
  | "stable"
  | "different"
  | "unavailable"
  | "not-required"
  | "not-observed"
  | "aborted"
  | "expired"
  | "revoked";

export interface NativeHarnessReconciliationContentFailureFact {
  readonly code: NativeHarnessOutputFailure;
  readonly reason: string;
  /**
   * Positive evidence that an observed/reconstructed fact differs. Its absence
   * means unavailable/uncertain, never equality; legacy readers may report
   * `changed` without this proof.
   */
  readonly observedMismatch?: true;
}

export interface NativeHarnessReconciliationContentFacts {
  readonly status: NativeHarnessReconciliationContentPresentationStatus;
  /** The plan/byte conclusion before the final primary and pin checks. */
  readonly provisionalStatus: Exclude<NativeHarnessReconciliationContentPresentationStatus, "revoked">;
  readonly revoked: boolean;
  readonly revokedReasons: readonly NativeHarnessReconciliationFilesReason[];
  readonly planner: "not-run" | "planned" | "not-required" | "unavailable" | "refused";
  readonly planReasons: readonly NativeHarnessReconciliationContentReason[];
  readonly failure: NativeHarnessReconciliationContentFailureFact | null;
  /** Never retained as a stable nested observation once final files are refused. */
  readonly observation: NativeHarnessReconciliationContentByteObservation | null;
  /** Actual source/base/solver/tree/trace bytes; separate from primary caps. */
  readonly chargedBytes: number;
  /** Ceiling for those actual content bytes; not the primary-document cap. */
  readonly chargeLimitBytes: number;
  readonly tracePassesStarted: 0 | 1 | 2;
}

export interface NativeHarnessReconciliationContentObservationResult {
  readonly schema: typeof NATIVE_HARNESS_RECONCILIATION_CONTENT_SCHEMA;
  readonly readOnly: true;
  readonly resumeAvailable: false;
  readonly processes: "not-inspected";
  readonly artifacts:
    | "not-inspected"
    | "latest-completed-bytes-checked"
    | "partial-bytes-not-retained"
    | "not-retained-after-primary-refusal";
  /** Old attempt result/turn contents are never read or reused by this mode. */
  readonly discardedAttemptContents: "not-verified-not-reused";
  /** Original primary-document observation axis, independent of content bytes. */
  readonly status: NativeHarnessReconciliationFilesStatus;
  readonly observation: "two-pass" | "partial";
  readonly reasons: readonly NativeHarnessReconciliationFilesReason[];
  readonly captures: readonly NativeHarnessReconciliationFileCapture[];
  /** Primary-document caps only; actual content bytes are under content. */
  readonly chargedBytes: number;
  readonly chargeLimitBytes: typeof NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES;
  /** Primary-document capture handles only; content byte I/O is separate. */
  readonly openedFiles: number;
  readonly maxConcurrentOpenedFiles: 1;
  /** Primary-document capture closes only; content closes are internal. */
  readonly close: {
    readonly attempted: number;
    readonly settled: number;
    readonly succeeded: number;
  };
  readonly pins: {
    readonly directoryCount: 7;
    readonly checkedAtEnd: boolean;
    readonly stable: boolean;
  };
  readonly deadline: {
    readonly budgetMs: typeof NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS;
    readonly deadlineAt: number;
    readonly checkedAt: number;
    readonly expired: boolean;
    /** Soft observation window: actual I/O/close may finish later. */
    readonly soft: true;
    readonly cleanupMayExceedDeadline: true;
  };
  readonly metadata: NativeHarnessReconciliationResult | null;
  readonly metadataStatus: "not-observed" | "compatible" | "incompatible";
  readonly content: NativeHarnessReconciliationContentFacts;
}

export const NATIVE_HARNESS_RECONCILIATION_LIFECYCLE_SCHEMA =
  "omp-agent.native-harness-reconciliation-lifecycle.v1" as const;
export const NATIVE_HARNESS_RECONCILIATION_LIFECYCLE_DEADLINE_MS = 5_000 as const;
export const NATIVE_HARNESS_RECONCILIATION_LIFECYCLE_CHARGED_BYTES = 1_081_472 as const;

export interface NativeHarnessReconciliationLifecycleOptions extends NativeHarnessReconciliationFileOptions {
  /**
   * Narrow synchronous test seam for the fixed signal-0 query. Production
   * callers omit it. It cannot select a signal, start a child or grant
   * authority.
   */
  readonly signalQuery?: NativeHarnessHistorySignalQuery;
}

export interface NativeHarnessReconciliationLifecycleResult {
  readonly schema: typeof NATIVE_HARNESS_RECONCILIATION_LIFECYCLE_SCHEMA;
  readonly readOnly: true;
  readonly resumeAvailable: false;
  readonly processes:
    | "not-inspected"
    | "partial-signal0-observed"
    | "two-round-signal0-observed"
    | "not-retained-after-primary-refusal"
    | "not-retained-after-result-bound";
  readonly artifacts:
    | "not-inspected"
    | "auxiliary-owner-and-cancel-files-checked"
    | "partial-auxiliary-not-retained"
    | "not-retained-after-primary-refusal"
    | "not-retained-after-result-bound";
  readonly discardedAttemptContents: "not-verified-not-reused";
  readonly status: NativeHarnessReconciliationFilesStatus;
  readonly observation: "two-pass" | "partial";
  readonly reasons: readonly NativeHarnessReconciliationFilesReason[];
  readonly captures: readonly NativeHarnessReconciliationFileCapture[];
  readonly chargedBytes: number;
  readonly chargeLimitBytes: typeof NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES;
  readonly openedFiles: number;
  readonly maxConcurrentOpenedFiles: 1;
  readonly close: {
    readonly attempted: number;
    readonly settled: number;
    readonly succeeded: number;
  };
  readonly pins: {
    readonly directoryCount: 7;
    readonly checkedAtEnd: boolean;
    readonly stable: boolean;
  };
  readonly deadline: {
    readonly budgetMs: typeof NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS;
    readonly deadlineAt: number;
    readonly checkedAt: number;
    readonly expired: boolean;
    readonly soft: true;
    readonly cleanupMayExceedDeadline: true;
    readonly lifecycle: NativeHarnessHistoryRecoveryLifecycleFacts["window"];
  };
  readonly metadata: NativeHarnessReconciliationResult | null;
  readonly metadataStatus: "not-observed" | "compatible" | "incompatible";
  readonly content: NativeHarnessReconciliationContentFacts;
  readonly lifecycle: NativeHarnessHistoryRecoveryLifecycleFacts;
}

export class NativeHarnessReconciliationFilesInputError extends Error {
  override name = "NativeHarnessReconciliationFilesInputError";
}

class ObservationFailure extends Error {
  override name = "ObservationFailure";
  constructor(readonly reason: NativeHarnessReconciliationFilesReason) {
    super(reason);
  }
}

class ObservationGate extends Error {
  override name = "ObservationGate";
  constructor(
    readonly reason: "aborted" | "deadline-expired",
    readonly secondary: NativeHarnessReconciliationFilesReason | null = null,
  ) {
    super(reason);
  }
}

interface OwnedExpectation {
  readonly runId: string;
  readonly ownerId: string;
  readonly selectorSha256: string;
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly preparedRelativeRoot: string;
  readonly backendBuildSourceId: string;
}

interface OwnedOptions {
  readonly signal: AbortSignal | null;
  readonly io: NativeFileIo;
  readonly clock: () => number;
  readonly signalQuery: NativeHarnessHistorySignalQuery;
}

interface FileSpec {
  readonly key: NativeHarnessReconciliationFileKey;
  readonly capBytes: number;
  readonly relativePath: string;
  readonly absolutePath: string;
}

interface FilePlan {
  readonly expected: OwnedExpectation;
  readonly files: readonly FileSpec[];
  readonly pins: readonly string[];
  readonly preparedRoot: string;
  readonly storeRoot: string;
  readonly runsRoot: string;
  readonly runRoot: string;
  readonly accountingRoot: string;
  readonly selectorRoot: string;
}

interface DirectoryPin {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface CloseRecord {
  attempted: boolean;
  settled: boolean;
  succeeded: boolean;
  calls: number;
  promise: Promise<void> | null;
}

interface FirstPassFacts {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly opened: OpenSignature;
}

interface OpenSignature {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

type ContentPresentationStatus = NativeHarnessReconciliationContentPresentationStatus;
type ProvisionalContentStatus = Exclude<ContentPresentationStatus, "revoked">;

interface MutableContentFacts {
  planner: NativeHarnessReconciliationContentFacts["planner"];
  status: ContentPresentationStatus;
  provisionalStatus: ProvisionalContentStatus;
  revoked: boolean;
  revokedReasons: NativeHarnessReconciliationFilesReason[];
  planReasons: NativeHarnessReconciliationContentReason[];
  failure: NativeHarnessReconciliationContentFailureFact | null;
  observation: NativeHarnessReconciliationContentByteObservation | null;
  chargedBytes: number;
  chargeLimitBytes: number;
  tracePassesStarted: 0 | 1 | 2;
}

function initialContentFacts(): MutableContentFacts {
  return {
    planner: "not-run",
    status: "not-observed",
    provisionalStatus: "not-observed",
    revoked: false,
    revokedReasons: [],
    planReasons: [],
    failure: null,
    observation: null,
    chargedBytes: 0,
    chargeLimitBytes: NATIVE_HARNESS_RECONCILIATION_CONTENT_CHARGE_LIMIT_BYTES,
    tracePassesStarted: 0,
  };
}

function inputFail(message: string): never {
  throw new NativeHarnessReconciliationFilesInputError(message);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readPlainFields(
  value: unknown,
  allowed: readonly string[],
  label: string,
): ReadonlyMap<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputFail(`${label} must be an exact plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    inputFail(`${label} must be an exact plain object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length || keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    inputFail(`${label} contains an unsupported field.`);
  }
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      inputFail(`${label}.${String(key)} must be an enumerable own data field.`);
    }
    fields.set(key as string, descriptor.value);
  }
  return fields;
}

function readBoundedString(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || CONTROL_PATTERN.test(value)
  ) {
    inputFail(`${label} must be a bounded string.`);
  }
  return value;
}

function readCanonicalRoot(value: unknown, label: string): string {
  const text = readBoundedString(value, label, MAX_PATH_CHARS);
  if (
    !path.isAbsolute(text)
    || path.normalize(text) !== text
    || text === path.parse(text).root
  ) {
    inputFail(`${label} must be a canonical non-root absolute path.`);
  }
  return text;
}

function readExpectation(value: unknown): OwnedExpectation {
  const fields = readPlainFields(
    value,
    [
      "runId",
      "ownerId",
      "selectorSha256",
      "storageRoot",
      "sourceRoot",
      "preparedRelativeRoot",
      "backendBuildSourceId",
    ],
    "reconciliation files expectation",
  );
  for (const key of [
    "runId",
    "ownerId",
    "selectorSha256",
    "storageRoot",
    "sourceRoot",
    "preparedRelativeRoot",
    "backendBuildSourceId",
  ]) {
    if (!fields.has(key)) inputFail(`reconciliation files expectation is missing ${key}.`);
  }
  const runId = readBoundedString(fields.get("runId"), "expected.runId", 128);
  if (!RUN_ID_PATTERN.test(runId)) inputFail("expected.runId is not a bounded run ID.");
  const ownerId = readBoundedString(fields.get("ownerId"), "expected.ownerId", 36);
  if (!UUID_PATTERN.test(ownerId)) inputFail("expected.ownerId must be a canonical lowercase UUID.");
  const selectorSha256 = readBoundedString(fields.get("selectorSha256"), "expected.selectorSha256", 64);
  if (!SHA256_PATTERN.test(selectorSha256)) {
    inputFail("expected.selectorSha256 must be 64 lowercase hexadecimal characters.");
  }
  const storageRoot = readCanonicalRoot(fields.get("storageRoot"), "expected.storageRoot");
  const sourceRoot = readCanonicalRoot(fields.get("sourceRoot"), "expected.sourceRoot");
  if (isContained(storageRoot, sourceRoot) || isContained(sourceRoot, storageRoot)) {
    inputFail("expected.storageRoot and expected.sourceRoot must be disjoint.");
  }
  const preparedRelativeRootRaw = fields.get("preparedRelativeRoot");
  if (typeof preparedRelativeRootRaw !== "string" || preparedRelativeRootRaw.length > MAX_RELATIVE_PATH_CHARS) {
    inputFail("expected.preparedRelativeRoot must be a bounded relative path.");
  }
  if (!PREPARED_ROOT_PATTERN.test(preparedRelativeRootRaw)) {
    inputFail("expected.preparedRelativeRoot must be omp-harness- plus six ASCII alphanumerics.");
  }
  const preparedRelativeRoot = preparedRelativeRootRaw;
  const preparedRoot = path.join(storageRoot, preparedRelativeRoot);
  if (path.dirname(preparedRoot) !== storageRoot) {
    inputFail("expected.preparedRelativeRoot must be a direct child of storageRoot.");
  }
  const backendBuildSourceId = readBoundedString(
    fields.get("backendBuildSourceId"),
    "expected.backendBuildSourceId",
    64,
  );
  if (!SHA256_PATTERN.test(backendBuildSourceId)) {
    inputFail("expected.backendBuildSourceId must be 64 lowercase hexadecimal characters.");
  }
  return Object.freeze({
    runId,
    ownerId,
    selectorSha256,
    storageRoot,
    sourceRoot,
    preparedRelativeRoot,
    backendBuildSourceId,
  });
}

function readOptions(value: unknown, mode: "files" | "content" | "lifecycle"): OwnedOptions {
  const allowed = mode === "lifecycle"
    ? ["signal", "fileIo", "now", "signalQuery"]
    : ["signal", "fileIo", "now"];
  const fields = readPlainFields(value ?? {}, allowed, "reconciliation files options");
  const signalValue = fields.get("signal");
  let signal: AbortSignal | null = null;
  if (signalValue !== undefined) {
    const read = readActualAbortSignal(signalValue);
    if (!read.ok) inputFail("options.signal must be a readable actual host AbortSignal.");
    signal = signalValue as AbortSignal;
  }
  const ioValue = fields.get("fileIo");
  let io: NativeFileIo = nodeFileIo;
  if (ioValue !== undefined) {
    if (typeof ioValue !== "object" || ioValue === null) {
      inputFail("options.fileIo must be a native file IO seam.");
    }
    const candidate = ioValue as NativeFileIo;
    if (
      typeof candidate.O_RDONLY !== "number"
      || typeof candidate.O_NOFOLLOW !== "number"
      || typeof candidate.realpath !== "function"
      || typeof candidate.lstat !== "function"
      || typeof candidate.open !== "function"
    ) {
      inputFail("options.fileIo must be a native file IO seam.");
    }
    io = candidate;
  }
  const nowValue = fields.get("now");
  if (nowValue !== undefined && typeof nowValue !== "function") {
    inputFail("options.now must be a clock function.");
  }
  const signalQueryValue = fields.get("signalQuery");
  if (signalQueryValue !== undefined && typeof signalQueryValue !== "function") {
    inputFail("options.signalQuery must be a narrow synchronous function.");
  }
  return Object.freeze({
    signal,
    io,
    clock: (nowValue ?? Date.now) as () => number,
    signalQuery: (signalQueryValue ?? nativeHarnessHistorySignalQuery) as NativeHarnessHistorySignalQuery,
  });
}

function readClock(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ObservationFailure("io-failed");
  }
  return value;
}

function buildPlan(owned: OwnedExpectation): FilePlan {
  const preparedRoot = path.join(owned.storageRoot, owned.preparedRelativeRoot);
  const storeRoot = path.join(preparedRoot, "store");
  const runsRoot = path.join(storeRoot, "runs");
  const runRoot = path.join(runsRoot, owned.runId);
  const accountingRoot = path.join(owned.storageRoot, "accounting-owners");
  const selectorRoot = path.join(accountingRoot, owned.selectorSha256);
  const pins = Object.freeze([
    owned.storageRoot,
    preparedRoot,
    storeRoot,
    runsRoot,
    runRoot,
    accountingRoot,
    selectorRoot,
  ]);
  const relativePaths = Object.freeze([
    `${owned.preparedRelativeRoot}/store/runs/${owned.runId}/run.json`,
    `${owned.preparedRelativeRoot}/${NATIVE_HARNESS_RECOVERY_SOURCE_FILE}`,
    `${owned.preparedRelativeRoot}/store/runs/${owned.runId}/${NATIVE_HARNESS_DISPATCH_INVENTORY_FILE}`,
    `accounting-owners/${owned.selectorSha256}/owner.json`,
  ]);
  const caps = Object.freeze([
    RUN_MAX_BYTES,
    NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES,
    NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES,
    NATIVE_HARNESS_ACCOUNTING_MAX_BYTES,
  ]);
  const keys: readonly NativeHarnessReconciliationFileKey[] = Object.freeze([
    "run",
    "source",
    "inventory",
    "owner",
  ]);
  const files: FileSpec[] = [];
  for (let index = 0; index < relativePaths.length; index++) {
    const relativePath = relativePaths[index]!;
    if (relativePath.length > MAX_RELATIVE_PATH_CHARS) {
      inputFail("A composed relative primary path exceeds the reader path bound.");
    }
    const segments = relativePath.split("/");
    const absolutePath = path.join(owned.storageRoot, ...segments);
    if (
      absolutePath.length > MAX_PATH_CHARS
      || !isContained(owned.storageRoot, absolutePath)
      || absolutePath === owned.storageRoot
    ) {
      inputFail("A composed absolute primary path exceeds the fixed root bound.");
    }
    files.push(Object.freeze({
      key: keys[index]!,
      capBytes: caps[index]!,
      relativePath,
      absolutePath,
    }));
  }
  if (files.reduce((sum, file) => sum + file.capBytes, 0) * 2
    !== NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES) {
    inputFail("The fixed primary caps no longer match the admitted charge bound.");
  }
  return Object.freeze({
    expected: owned,
    files: Object.freeze(files),
    pins,
    preparedRoot,
    storeRoot,
    runsRoot,
    runRoot,
    accountingRoot,
    selectorRoot,
  });
}

function sameDirectoryPin(pin: DirectoryPin, info: NativeFileStats): boolean {
  return info.dev === pin.dev
    && info.ino === pin.ino
    && info.mtimeNs === pin.mtimeNs
    && info.ctimeNs === pin.ctimeNs;
}

function signatureOf(info: NativeFileStats): OpenSignature {
  return Object.freeze({
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  });
}

function sameSignature(left: OpenSignature, right: OpenSignature): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

interface LiveControl {
  /**
   * One sticky cell shared by the outer thirty-second window and the nested
   * lifecycle window. Only an invalid, throwing or backwards clock or an
   * unusable abort signal sets it; ordinary file EIO does not. Once set, every
   * later guard refuses even if the caller clock recovers.
   */
  failure: ObservationFailure | null;
}

interface Live {
  readonly clock: () => number;
  readonly signal: AbortSignal | null;
  readonly deadlineAt: number;
  readonly control: LiveControl;
  lastTime: number;
}

function liveCheck(live: Live): void {
  if (live.control.failure !== null) throw live.control.failure;
  let observedAt: number;
  try {
    observedAt = readClock(live.clock);
  } catch {
    const failure = new ObservationFailure("io-failed");
    live.control.failure = failure;
    throw failure;
  }
  if (observedAt < live.lastTime) {
    // A backwards clock is an unavailable observation, never permission to
    // re-measure or extend the one fixed window.
    const failure = new ObservationFailure("io-failed");
    live.control.failure = failure;
    throw failure;
  }
  live.lastTime = observedAt;
  if (live.signal !== null) {
    const read = readActualAbortSignal(live.signal);
    if (!read.ok) {
      const failure = new ObservationFailure("io-failed");
      live.control.failure = failure;
      throw failure;
    }
    if (read.aborted) throw new ObservationGate("aborted");
  }
  if (observedAt >= live.deadlineAt) throw new ObservationGate("deadline-expired");
}

function signalOnlyCheck(live: Live): void {
  if (live.signal === null) return;
  const read = readActualAbortSignal(live.signal);
  if (!read.ok) throw new ObservationFailure("io-failed");
  if (read.aborted) throw new ObservationGate("aborted");
}

function secondaryReasonFor(error: unknown): NativeHarnessReconciliationFilesReason {
  if (error instanceof ObservationGate) return error.secondary ?? "io-failed";
  if (error instanceof ObservationFailure) return error.reason;
  if (error instanceof NativeFileError) return classifyCaptureError(error).reason;
  if (isErrno(error, "ENOENT")) return "missing";
  return "io-failed";
}

async function checked<T>(live: Live, operation: () => Promise<T>): Promise<T> {
  liveCheck(live);
  let rejected = false;
  let rejection: unknown;
  let value: T | undefined;
  try {
    value = await operation();
  } catch (error) {
    rejected = true;
    rejection = error;
  }
  // Observe the clock/signal after a settled rejection too. A known crossed
  // deadline must not be reported as an unexpired unavailable observation.
  try {
    liveCheck(live);
  } catch (error) {
    if (rejected && error instanceof ObservationGate) {
      throw new ObservationGate(error.reason, secondaryReasonFor(rejection));
    }
    throw error;
  }
  if (rejected) throw rejection;
  return value as T;
}

async function pinDirectory(live: Live, io: NativeFileIo, directory: string): Promise<DirectoryPin> {
  let resolved: string;
  try {
    resolved = await checked(live, () => io.realpath(directory));
  } catch (error) {
    if (error instanceof ObservationGate || error instanceof ObservationFailure) throw error;
    if (isErrno(error, "ENOENT")) throw new ObservationFailure("missing");
    throw new ObservationFailure("parent-changed");
  }
  if (resolved !== directory) throw new ObservationFailure("unsafe-path");
  let info: NativeFileStats;
  try {
    info = await checked(live, () => io.lstat(directory, { bigint: true }));
  } catch (error) {
    if (error instanceof ObservationGate || error instanceof ObservationFailure) throw error;
    if (isErrno(error, "ENOENT")) throw new ObservationFailure("missing");
    throw new ObservationFailure("parent-changed");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ObservationFailure("unsafe-path");
  return Object.freeze({
    path: directory,
    dev: info.dev,
    ino: info.ino,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  });
}

type PinVerification =
  | { readonly status: "stable" }
  | { readonly status: "different" }
  | { readonly status: "unavailable"; readonly reason: "missing" | "io-failed" };

async function verifyPinsAtEnd(
  live: Live,
  io: NativeFileIo,
  pins: readonly DirectoryPin[],
): Promise<PinVerification> {
  for (const pin of pins) {
    let resolved: string;
    try {
      resolved = await checked(live, () => io.realpath(pin.path));
    } catch (error) {
      if (error instanceof ObservationGate) throw error;
      if (error instanceof ObservationFailure) {
        return { status: "unavailable", reason: error.reason === "missing" ? "missing" : "io-failed" };
      }
      return { status: "unavailable", reason: isErrno(error, "ENOENT") ? "missing" : "io-failed" };
    }
    if (resolved !== pin.path) return { status: "different" };
    let info: NativeFileStats;
    try {
      info = await checked(live, () => io.lstat(pin.path, { bigint: true }));
    } catch (error) {
      if (error instanceof ObservationGate) throw error;
      if (error instanceof ObservationFailure) {
        return { status: "unavailable", reason: error.reason === "missing" ? "missing" : "io-failed" };
      }
      return { status: "unavailable", reason: isErrno(error, "ENOENT") ? "missing" : "io-failed" };
    }
    if (info.isSymbolicLink() || !info.isDirectory() || !sameDirectoryPin(pin, info)) {
      return { status: "different" };
    }
  }
  return { status: "stable" };
}

/**
 * Seals the already-pinned parents immediately before the actual open. The
 * preceding callback-rich guard is intentionally first; this seal uses only
 * the intrinsic AbortSignal and pure identity comparisons, so no caller clock
 * callback can run between the last pin check and open. It closes that
 * callback window; it is not an OS-atomic openat sandbox. The post-open guard
 * still refuses eventual expiry/abort and closes the acquired handle before
 * capture can read it.
 */
async function sealPins(
  live: Live,
  io: NativeFileIo,
  pins: readonly DirectoryPin[],
): Promise<void> {
  for (const pin of pins) {
    signalOnlyCheck(live);
    let resolved: string | undefined;
    let rejected = false;
    let rejection: unknown;
    try {
      resolved = await io.realpath(pin.path);
    } catch (error) {
      rejected = true;
      rejection = error;
    }
    try {
      signalOnlyCheck(live);
    } catch (error) {
      if (rejected && error instanceof ObservationGate) {
        throw new ObservationGate(error.reason, secondaryReasonFor(rejection));
      }
      throw error;
    }
    if (rejected) {
      if (isErrno(rejection, "ENOENT")) throw new ObservationFailure("missing");
      throw new ObservationFailure("io-failed");
    }
    if (resolved !== pin.path) throw new ObservationFailure("parent-changed");
    signalOnlyCheck(live);
    let info: NativeFileStats | undefined;
    rejected = false;
    rejection = undefined;
    try {
      info = await io.lstat(pin.path, { bigint: true });
    } catch (error) {
      rejected = true;
      rejection = error;
    }
    try {
      signalOnlyCheck(live);
    } catch (error) {
      if (rejected && error instanceof ObservationGate) {
        throw new ObservationGate(error.reason, secondaryReasonFor(rejection));
      }
      throw error;
    }
    if (rejected) {
      if (isErrno(rejection, "ENOENT")) throw new ObservationFailure("missing");
      throw new ObservationFailure("io-failed");
    }
    if (
      info === undefined
      || info.isSymbolicLink()
      || !info.isDirectory()
      || !sameDirectoryPin(pin, info)
    ) {
      throw new ObservationFailure("parent-changed");
    }
  }
  signalOnlyCheck(live);
}

function createCloseRecord(): CloseRecord {
  return { attempted: false, settled: false, succeeded: false, calls: 0, promise: null };
}

function closeOnce(handle: NativeFileHandle, record: CloseRecord): Promise<void> {
  if (record.calls === 1) return record.promise!;
  record.calls = 1;
  record.attempted = true;
  record.promise = (async () => {
    try {
      await handle.close();
      record.settled = true;
      record.succeeded = true;
    } catch (error) {
      record.settled = true;
      record.succeeded = false;
      throw error;
    }
  })();
  return record.promise;
}

interface CaptureIo {
  readonly io: NativeFileIo;
  readonly closes: readonly CloseRecord[];
  readonly opened: () => OpenSignature | null;
  readonly refusal: () => ObservationGate | ObservationFailure | null;
  readonly missingPath: () => string | null;
  readonly targetLstatSucceeded: () => boolean;
  readonly targetLstatMissing: () => boolean;
  readonly targetSignature: () => OpenSignature | null;
}

function createCaptureIo(
  live: Live,
  io: NativeFileIo,
  pins: readonly DirectoryPin[],
  spec: { readonly capBytes: number; readonly absolutePath: string },
): CaptureIo {
  const nonBlocking = constants.O_NONBLOCK ?? 0;
  const pinsByPath = new Map(pins.map((pin) => [pin.path, pin]));
  const closes: CloseRecord[] = [];
  let openedSignature: OpenSignature | null = null;
  let targetSignature: OpenSignature | null = null;
  let targetLstatSeen = false;
  let targetLstatMissing = false;
  let missingPath: string | null = null;
  let refusal: ObservationGate | ObservationFailure | null = null;

  const recordRefusal = (error: unknown): void => {
    if (refusal === null && (error instanceof ObservationGate || error instanceof ObservationFailure)) {
      refusal = error;
    }
  };

  const refuse = (reason: NativeHarnessReconciliationFilesReason): never => {
    const failure = new ObservationFailure(reason);
    recordRefusal(failure);
    throw failure;
  };

  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      liveCheck(live);
    } catch (error) {
      recordRefusal(error);
      throw error;
    }
    let rejected = false;
    let rejection: unknown;
    let value: T | undefined;
    try {
      value = await operation();
    } catch (error) {
      rejected = true;
      rejection = error;
    }
    // A settled rejection is still observed for clock/signal crossing.
    try {
      liveCheck(live);
    } catch (error) {
      if (rejected && error instanceof ObservationGate) {
        const combined = new ObservationGate(error.reason, secondaryReasonFor(rejection));
        recordRefusal(combined);
        throw combined;
      }
      recordRefusal(error);
      throw error;
    }
    if (rejected) {
      recordRefusal(rejection);
      throw rejection;
    }
    return value as T;
  }

  async function assertPinnedIdentity(target: string): Promise<void> {
    const pin = pinsByPath.get(target);
    if (pin === undefined) return;
    let resolved: string;
    try {
      resolved = await guarded(() => io.realpath(target));
    } catch (error) {
      if (isErrno(error, "ENOENT") && missingPath === null) missingPath = target;
      recordRefusal(error);
      if (isErrno(error, "ENOENT")) refuse("parent-changed");
      throw error;
    }
    if (resolved !== pin.path) refuse("parent-changed");
    let info: NativeFileStats;
    try {
      info = await guarded(() => io.lstat(target, { bigint: true }));
    } catch (error) {
      if (isErrno(error, "ENOENT") && missingPath === null) missingPath = target;
      recordRefusal(error);
      if (isErrno(error, "ENOENT")) refuse("parent-changed");
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory() || !sameDirectoryPin(pin, info)) {
      refuse("parent-changed");
    }
  }

  const wrapped: NativeFileIo = {
    O_RDONLY: io.O_RDONLY,
    O_NOFOLLOW: io.O_NOFOLLOW,
    realpath: async (target: string): Promise<string> => {
      if (!pinsByPath.has(target)) refuse("unsafe-path");
      try {
        const resolved = await guarded(() => io.realpath(target));
        await assertPinnedIdentity(target);
        return resolved;
      } catch (error) {
        recordRefusal(error);
        throw error;
      }
    },
    lstat: async (target: string, options: { bigint: true }): Promise<NativeFileStats> => {
      const pin = pinsByPath.get(target);
      if (pin === undefined && target !== spec.absolutePath) refuse("unsafe-path");
      let info: NativeFileStats;
      try {
        info = await guarded(() => io.lstat(target, options));
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          if (target === spec.absolutePath) targetLstatMissing = true;
          else if (missingPath === null) missingPath = target;
        }
        recordRefusal(error);
        throw error;
      }
      if (target === spec.absolutePath) {
        targetLstatSeen = true;
        targetSignature = signatureOf(info);
      }
      if (pin !== undefined) {
        if (info.isSymbolicLink() || !info.isDirectory() || !sameDirectoryPin(pin, info)) {
          refuse("parent-changed");
        }
      } else if (info.isFile() && info.size > BigInt(spec.capBytes)) {
        refuse("too-large");
      }
      return info;
    },
    open: async (target: string, flags: number): Promise<NativeFileHandle> => {
      if (target !== spec.absolutePath) refuse("unsafe-path");
      // Callback-rich guard first, then a signal-only parent seal with no
      // caller clock callback immediately before the actual open.
      try {
        liveCheck(live);
      } catch (error) {
        recordRefusal(error);
        throw error;
      }
      try {
        await sealPins(live, io, pins);
      } catch (error) {
        recordRefusal(error);
        throw error;
      }
      // The helper's final signal check completes one microtask before this
      // continuation. Recheck the intrinsic signal synchronously here; no
      // caller clock callback runs between this check and the actual open.
      try {
        signalOnlyCheck(live);
      } catch (error) {
        recordRefusal(error);
        throw error;
      }
      let handle: NativeFileHandle | null = null;
      let rejection: unknown;
      try {
        handle = await io.open(target, flags | nonBlocking);
      } catch (error) {
        if (isErrno(error, "ENOENT") && target === spec.absolutePath && missingPath === null) {
          missingPath = target;
        }
        rejection = error;
      }
      if (handle !== null) {
        const closeRecord = createCloseRecord();
        closes.push(closeRecord);
        try {
          liveCheck(live);
        } catch (error) {
          recordRefusal(error);
          await closeOnce(handle, closeRecord).catch(() => undefined);
          throw error;
        }
        return {
          stat: async (options: { bigint: true }): Promise<NativeFileStats> => {
            const info = await guarded(() => handle!.stat(options));
            if (!info.isFile()) refuse("unsafe-path");
            if (info.size > BigInt(spec.capBytes)) refuse("too-large");
            if (openedSignature === null) openedSignature = signatureOf(info);
            return info;
          },
          read: (
            buffer: Uint8Array,
            offset: number,
            length: number,
            position: number,
          ): Promise<{ bytesRead: number }> => guarded(
            () => handle!.read(buffer, offset, length, position),
          ),
          close: (): Promise<void> => closeOnce(handle!, closeRecord),
        };
      }
      // Observe a settled open rejection for a known clock/signal crossing.
      try {
        liveCheck(live);
      } catch (error) {
        if (error instanceof ObservationGate) {
          const combined = new ObservationGate(error.reason, secondaryReasonFor(rejection));
          recordRefusal(combined);
          throw combined;
        }
        recordRefusal(error);
        throw error;
      }
      recordRefusal(rejection);
      throw rejection;
    },
  };

  return Object.freeze({
    io: wrapped,
    closes,
    opened: () => openedSignature,
    refusal: () => refusal,
    missingPath: () => missingPath,
    targetLstatSucceeded: () => targetLstatSeen,
    targetLstatMissing: () => targetLstatMissing,
    targetSignature: () => targetSignature,
  });
}

function classifyCaptureError(error: unknown): ObservationGate | ObservationFailure {
  if (error instanceof ObservationGate || error instanceof ObservationFailure) return error;
  if (error instanceof NativeFileError) {
    if (error.code === "missing") return new ObservationFailure("missing");
    if (error.code === "too-large") return new ObservationFailure("too-large");
    if (error.code === "unsafe-path" || error.code === "invalid-path") {
      return new ObservationFailure("unsafe-path");
    }
    if (error.code === "non-text") return new ObservationFailure("non-text");
    if (error.code === "changed") return new ObservationFailure("changed");
  }
  return new ObservationFailure("io-failed");
}

function addReason(
  reasons: NativeHarnessReconciliationFilesReason[],
  reason: NativeHarnessReconciliationFilesReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function addGateReason(
  reasons: NativeHarnessReconciliationFilesReason[],
  gate: ObservationGate,
): void {
  addReason(reasons, gate.reason);
  if (gate.secondary !== null) addReason(reasons, gate.secondary);
}

function summarizeCloses(records: readonly CloseRecord[]): {
  readonly attempted: boolean;
  readonly settled: boolean;
  readonly succeeded: boolean;
  readonly openedFiles: 0 | 1;
} {
  if (records.length === 0) {
    return { attempted: false, settled: false, succeeded: false, openedFiles: 0 };
  }
  return {
    attempted: records.every((record) => record.attempted),
    settled: records.every((record) => record.settled),
    succeeded: records.every((record) => record.succeeded),
    openedFiles: 1,
  };
}

function freezeCapture(capture: NativeHarnessReconciliationFileCapture): NativeHarnessReconciliationFileCapture {
  return Object.freeze({
    ...capture,
    close: Object.freeze({ ...capture.close }),
  });
}

interface FixedModeFacts {
  status: NativeHarnessReconciliationFilesStatus;
  observation: "two-pass" | "partial";
  reasons: NativeHarnessReconciliationFilesReason[];
  captures: NativeHarnessReconciliationFileCapture[];
  chargedBytes: number;
  openedFiles: number;
  closeAttempted: number;
  closeSettled: number;
  closeSucceeded: number;
  pinsStable: boolean;
  pinsCheckedAtEnd: boolean;
  deadlineAt: number;
  checkedAt: number;
  metadata: NativeHarnessReconciliationResult | null;
  metadataStatus: NativeHarnessReconciliationFilesResult["metadataStatus"];
  content: MutableContentFacts;
  lifecycle: MutableLifecycleFacts;
  /**
   * Synchronous final control seal for the public wrapper's last await
   * boundary. It reuses the one live deadline/signal, updates status and
   * revokes any provisional content/lifecycle presentation, and never adds a
   * new window.
   */
  seal: () => FixedModeFacts;
}

interface ContentBetweenPassesOutcome {
  readonly gate: ObservationGate | null;
  readonly facts: MutableContentFacts;
  readonly metadata: NativeHarnessReconciliationResult | null;
}

type LifecycleProjectionBase = Omit<
  NativeHarnessHistoryRecoveryProjectionInput,
  "finalPrimaryStatus" | "revokedReasons"
>;

interface MutableLifecycleFacts {
  raw: LifecycleProjectionBase | null;
  projected: NativeHarnessHistoryRecoveryLifecycleFacts | null;
}

function initialLifecycleFacts(): MutableLifecycleFacts {
  return { raw: null, projected: null };
}

interface AuxInternal {
  readonly fact: NativeHarnessHistoryRecoveryAuxFact;
  /** Internal exact bytes for round comparison; never projected. */
  readonly text: string | null;
  readonly openedSignature: OpenSignature | null;
  readonly targetSignature: OpenSignature | null;
  readonly ancestorPins: readonly DirectoryPin[];
  readonly missingAncestor: string | null;
  /** Internal decoded owner declaration; never projected. */
  readonly ownerRead: ReturnType<typeof decodeNativeHarnessHistoryProcessOwner> | null;
}

interface LifecycleRoundInternal {
  readonly round: 1 | 2;
  readonly groups: ReadonlyMap<string, NativeHarnessHistoryRecoveryProbeFact>;
  readonly workers: ReadonlyMap<string, AuxInternal>;
  readonly controller: AuxInternal | null;
  readonly controllerProbe: NativeHarnessHistoryRecoveryProbeFact | null;
  readonly cancel: AuxInternal | null;
  readonly auxAttempts: number;
  readonly auxCharged: number;
  readonly probes: number;
  readonly gate: "aborted" | "deadline-expired" | null;
  readonly controlFailure: NativeHarnessHistoryProcessReason | null;
  readonly halt: NativeHarnessHistoryProcessReason | null;
}

function sameDirectoryPins(left: readonly DirectoryPin[], right: readonly DirectoryPin[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.path !== b.path
      || a.dev !== b.dev
      || a.ino !== b.ino
      || a.mtimeNs !== b.mtimeNs
      || a.ctimeNs !== b.ctimeNs
    ) return false;
  }
  return true;
}

function auxFact(
  target: NativeHarnessHistoryRecoveryAuxTarget,
  state: NativeHarnessHistoryRecoveryAuxState,
  fields: Partial<Omit<NativeHarnessHistoryRecoveryAuxFact, "kind" | "state">> = {},
): NativeHarnessHistoryRecoveryAuxFact {
  return Object.freeze({
    kind: target.kind,
    state,
    exists: fields.exists ?? null,
    bytes: fields.bytes ?? null,
    sha256: fields.sha256 ?? null,
    openedFiles: fields.openedFiles ?? 0,
    closeAttempted: fields.closeAttempted ?? false,
    closeSettled: fields.closeSettled ?? false,
    closeSucceeded: fields.closeSucceeded ?? false,
    missingAt: fields.missingAt ?? null,
    ownerState: fields.ownerState ?? null,
    ownerPid: fields.ownerPid ?? null,
    ownerPgid: fields.ownerPgid ?? null,
    ownerSha256: fields.ownerSha256 ?? null,
    problem: fields.problem ?? null,
  });
}

function auxInternal(
  target: NativeHarnessHistoryRecoveryAuxTarget,
  state: NativeHarnessHistoryRecoveryAuxState,
  fields: Partial<Omit<NativeHarnessHistoryRecoveryAuxFact, "kind" | "state">> = {},
  extras: {
    readonly text?: string | null;
    readonly openedSignature?: OpenSignature | null;
    readonly targetSignature?: OpenSignature | null;
    readonly ancestorPins?: readonly DirectoryPin[];
    readonly missingAncestor?: string | null;
    readonly ownerRead?: ReturnType<typeof decodeNativeHarnessHistoryProcessOwner> | null;
  } = {},
): AuxInternal {
  return Object.freeze({
    fact: auxFact(target, state, fields),
    text: extras.text ?? null,
    openedSignature: extras.openedSignature ?? null,
    targetSignature: extras.targetSignature ?? null,
    ancestorPins: Object.freeze([...(extras.ancestorPins ?? [])]),
    missingAncestor: extras.missingAncestor ?? null,
    ownerRead: extras.ownerRead ?? null,
  });
}

function comparisonFromAux(left: AuxInternal | null, right: AuxInternal | null): NativeHarnessHistoryRecoveryComparison {
  if (left === null || right === null) return "not-attempted";
  const a = left.fact;
  const b = right.fact;
  if (a.state === "aborted" || b.state === "aborted" || a.state === "expired" || b.state === "expired") {
    return "not-attempted";
  }
  if (a.state === "not-attempted" || b.state === "not-attempted") return "not-attempted";
  if (a.state === "unsafe" || b.state === "unsafe" || a.state === "too-large" || b.state === "too-large"
    || a.state === "unavailable" || b.state === "unavailable") {
    return "unavailable";
  }
  if (a.state !== b.state) return "different";
  if (a.state === "observed") {
    if (
      left.text !== right.text
      || a.bytes !== b.bytes
      || a.sha256 !== b.sha256
      || left.openedSignature === null
      || right.openedSignature === null
      || !sameSignature(left.openedSignature, right.openedSignature)
      || !sameDirectoryPins(left.ancestorPins, right.ancestorPins)
      || a.ownerState !== b.ownerState
      || a.ownerPid !== b.ownerPid
      || a.ownerPgid !== b.ownerPgid
      || a.ownerSha256 !== b.ownerSha256
    ) return "different";
    return "stable";
  }
  if (a.state === "missing" || a.state === "ancestor-missing" || a.state === "lock-directory-missing") {
    if (left.missingAncestor !== right.missingAncestor) return "different";
    if (!sameDirectoryPins(left.ancestorPins, right.ancestorPins)) return "different";
    return "stable";
  }
  return "unavailable";
}

function comparisonFromGroup(
  left: NativeHarnessHistoryRecoveryProbeFact | null,
  right: NativeHarnessHistoryRecoveryProbeFact | null,
): NativeHarnessHistoryRecoveryComparison {
  if (left === null || right === null) return "not-attempted";
  if (!left.applicable && !right.applicable) return "stable";
  if (left.refused || right.refused) return "unavailable";
  if (!left.called || !right.called) return "not-attempted";
  if (left.presence !== right.presence) {
    return left.presence === "unknown" || right.presence === "unknown" ? "unavailable" : "different";
  }
  return left.presence === "unknown" ? "unavailable" : "stable";
}

function lockDirectoryState(fact: AuxInternal | null): "present" | "missing" | "unsafe" | "unknown" | "not-attempted" {
  if (fact === null) return "not-attempted";
  if (fact.fact.state === "not-attempted") return "not-attempted";
  if (fact.fact.state === "lock-directory-missing") return "missing";
  if (fact.fact.state === "observed" || fact.fact.state === "missing" || fact.fact.state === "too-large") return "present";
  if (fact.fact.state === "unsafe") return "unsafe";
  return "unknown";
}

function notAttemptedGroup(attempt: NativeHarnessHistoryRecoveryAttemptTarget, detail: string): NativeHarnessHistoryRecoveryProbeFact {
  return Object.freeze({
    kind: "process-group" as const,
    targetId: attempt.targetId,
    ordinal: attempt.ordinal,
    nonce: attempt.nonce,
    stage: attempt.stage,
    attempt: attempt.attempt,
    pid: attempt.pid,
    pgid: attempt.pgid,
    queryPid: null,
    signal: 0 as const,
    applicable: attempt.pgid !== null,
    called: false,
    presence: "unknown" as const,
    refused: false,
    problem: {
      code: "probe-not-attempted-control",
      detail,
    },
  });
}

async function pinAuxAncestors(
  live: Live,
  io: NativeFileIo,
  storageRoot: string,
  target: NativeHarnessHistoryRecoveryAuxTarget,
): Promise<
  | { readonly ok: true; readonly pins: readonly DirectoryPin[] }
  | {
    readonly ok: false;
    readonly pins: readonly DirectoryPin[];
    readonly missingAncestor: string | null;
    readonly failure: ObservationGate | ObservationFailure;
  }
> {
  const pins: DirectoryPin[] = [];
  for (const relative of target.ancestorRelativePaths) {
    const absolute = path.join(storageRoot, ...relative.split("/"));
    if (!isContained(storageRoot, absolute) || absolute === storageRoot) {
      return {
        ok: false,
        pins: Object.freeze(pins),
        missingAncestor: null,
        failure: new ObservationFailure("unsafe-path"),
      };
    }
    try {
      pins.push(await pinDirectory(live, io, absolute));
    } catch (error) {
      const failure = error instanceof ObservationGate || error instanceof ObservationFailure
        ? error
        : new ObservationFailure("io-failed");
      return {
        ok: false,
        pins: Object.freeze(pins),
        missingAncestor: failure instanceof ObservationFailure && failure.reason === "missing" ? absolute : null,
        failure,
      };
    }
  }
  return { ok: true, pins: Object.freeze(pins) };
}

async function observeAuxTarget(
  live: Live,
  io: NativeFileIo,
  primaryPins: readonly DirectoryPin[],
  storageRoot: string,
  runId: string,
  target: NativeHarnessHistoryRecoveryAuxTarget,
  attempt: NativeHarnessHistoryRecoveryAttemptTarget | null,
): Promise<AuxInternal> {
  let resolved: Awaited<ReturnType<typeof pinAuxAncestors>>;
  try {
    resolved = await pinAuxAncestors(live, io, storageRoot, target);
  } catch (error) {
    const gate = error instanceof ObservationGate ? error : null;
    if (gate !== null) {
      return auxInternal(target, gate.reason === "aborted" ? "aborted" : "expired", {
        problem: { code: `aux-${gate.reason}`, detail: "The auxiliary observation window stopped before its ancestors were pinned." },
      });
    }
    return auxInternal(target, "unavailable", {
      problem: { code: "aux-unavailable", detail: "The auxiliary ancestors could not be observed." },
    });
  }
  if (!resolved.ok) {
    const failure = resolved.failure;
    if (failure instanceof ObservationGate) {
      return auxInternal(target, failure.reason === "aborted" ? "aborted" : "expired", {
        problem: { code: `aux-${failure.reason}`, detail: "The auxiliary observation window stopped during ancestor pinning." },
      }, { ancestorPins: resolved.pins });
    }
    if (failure.reason === "missing") {
      const state = target.kind === "controller-owner" ? "lock-directory-missing" as const : "ancestor-missing" as const;
      return auxInternal(target, state, {
        missingAt: target.kind === "controller-owner" ? "lock-directory" : "ancestor",
        problem: {
          code: state,
          detail: target.kind === "controller-owner"
            ? "The fixed .run.lock directory is missing; this is not a dead-controller claim."
            : "A fixed auxiliary ancestor is missing; the target absence is not established.",
        },
      }, { ancestorPins: resolved.pins, missingAncestor: resolved.missingAncestor });
    }
    return auxInternal(target, "unavailable", {
      problem: { code: "aux-ancestor-unavailable", detail: "An auxiliary ancestor was unsafe or could not be inspected." },
    }, { ancestorPins: resolved.pins });
  }

  const pinsByPath = new Map<string, DirectoryPin>();
  for (const pin of [...primaryPins, ...resolved.pins]) pinsByPath.set(pin.path, pin);
  const pins = Object.freeze([...pinsByPath.values()]);
  const absolutePath = path.join(storageRoot, ...target.relativePath.split("/"));
  const captureIo = createCaptureIo(live, io, pins, {
    capBytes: target.capBytes,
    absolutePath,
  });
  let snapshot: Awaited<ReturnType<typeof captureWorkspaceText>> | null = null;
  let failure: ObservationGate | ObservationFailure | null = null;
  try {
    snapshot = await captureWorkspaceText(
      storageRoot,
      target.relativePath,
      captureIo.io,
      live.lastTime,
    );
  } catch (error) {
    failure = captureIo.refusal() ?? classifyCaptureError(error);
  }
  const closeFacts = summarizeCloses(captureIo.closes);
  const closeFailed = captureIo.closes.some((record) => record.attempted && (!record.settled || !record.succeeded));
  const openedSignature = captureIo.opened();
  const targetSignature = captureIo.targetSignature();
  const exists = captureIo.targetLstatSucceeded() ? true : captureIo.targetLstatMissing() ? false : null;
  const common = {
    exists,
    openedFiles: closeFacts.openedFiles,
    closeAttempted: closeFacts.attempted,
    closeSettled: closeFacts.settled,
    closeSucceeded: closeFacts.succeeded,
  } as const;

  if (closeFailed) {
    return auxInternal(target, "unavailable", {
      ...common,
      problem: { code: "aux-close-failed", detail: "The auxiliary read handle did not settle successfully; no stable fact is presented." },
    }, { targetSignature, ancestorPins: resolved.pins });
  }
  if (failure !== null) {
    if (failure instanceof ObservationGate) {
      return auxInternal(target, failure.reason === "aborted" ? "aborted" : "expired", {
        ...common,
        problem: { code: `aux-${failure.reason}`, detail: "The fixed lifecycle window stopped the auxiliary observation." },
      }, { targetSignature, ancestorPins: resolved.pins });
    }
    if (failure.reason === "missing") {
      const missing = captureIo.missingPath();
      if (captureIo.targetLstatMissing()) {
        return auxInternal(target, "missing", {
          ...common,
          missingAt: "target",
          problem: {
            code: target.kind === "cancel" ? "cancel-not-observed" : "aux-target-missing",
            detail: target.kind === "cancel"
              ? "The cancel.request target was checked absent under pinned parents; this is an interval observation."
              : "The auxiliary target was checked absent under pinned parents.",
          },
        }, { targetSignature, ancestorPins: resolved.pins });
      }
      if (captureIo.targetLstatSucceeded()) {
        return auxInternal(target, "unavailable", {
          ...common,
          problem: { code: "aux-changed-after-lstat", detail: "The target was seen and then became unavailable; absence is not established." },
        }, { targetSignature, ancestorPins: resolved.pins });
      }
      const missingAncestor = missing !== null && missing !== absolutePath ? missing : null;
      const state = target.kind === "controller-owner" ? "lock-directory-missing" as const : "ancestor-missing" as const;
      return auxInternal(target, missingAncestor === null ? "unavailable" as const : state, {
        ...common,
        missingAt: missingAncestor === null
          ? null
          : target.kind === "controller-owner" ? "lock-directory" : "ancestor",
        problem: {
          code: missingAncestor === null ? "aux-missing-unattributed" : state,
          detail: missingAncestor === null
            ? "A missing error did not identify the exact target or fixed ancestor; it is not stable absence."
            : "A fixed auxiliary parent disappeared after pinning; it is not stable target absence.",
        },
      }, { targetSignature, ancestorPins: resolved.pins, missingAncestor });
    }
    if (failure.reason === "too-large") {
      return auxInternal(target, "too-large", {
        ...common,
        problem: { code: "aux-too-large", detail: "The auxiliary target exceeds its fixed narrow cap and was not read." },
      }, { targetSignature, ancestorPins: resolved.pins });
    }
    if (failure.reason === "unsafe-path" || failure.reason === "non-text") {
      return auxInternal(target, "unsafe", {
        ...common,
        problem: { code: "aux-unsafe", detail: "The auxiliary target is a link, nonregular file or unsupported text shape." },
      }, { targetSignature, ancestorPins: resolved.pins });
    }
    return auxInternal(target, "unavailable", {
      ...common,
      problem: { code: "aux-unavailable", detail: "The auxiliary target could not be observed as a stable regular file." },
    }, { targetSignature, ancestorPins: resolved.pins });
  }
  if (snapshot === null || openedSignature === null) {
    return auxInternal(target, "unavailable", {
      ...common,
      problem: { code: "aux-unconfirmed", detail: "No complete auxiliary snapshot was confirmed." },
    }, { targetSignature, ancestorPins: resolved.pins });
  }

  let ownerRead: ReturnType<typeof decodeNativeHarnessHistoryProcessOwner> | null = null;
  if (target.kind !== "cancel") {
    const decodeTarget: NativeHarnessHistoryProcessTarget = {
      targetId: target.targetId,
      kind: target.kind === "controller-owner" ? "controller" : "stage",
      stage: target.kind === "controller-owner" ? null : attempt?.stage ?? null,
      attempt: target.kind === "controller-owner" ? null : attempt?.attempt ?? null,
      recordedStatus: null,
      ownerRelativePath: target.relativePath,
    };
    ownerRead = decodeNativeHarnessHistoryProcessOwner(decodeTarget, runId, {
      text: snapshot.text,
      bytes: snapshot.file.bytes,
      sha256: snapshot.file.sha256,
      observedAt: live.lastTime,
    });
  }
  const declaration = ownerRead?.declaration ?? null;
  return auxInternal(target, "observed", {
    ...common,
    exists: true,
    bytes: snapshot.file.bytes,
    sha256: snapshot.file.sha256,
    ownerState: ownerRead?.state ?? null,
    ownerPid: declaration?.pid ?? null,
    ownerPgid: declaration !== null && declaration.kind === "worker" ? declaration.pgid : null,
    ownerSha256: ownerRead?.sha256 ?? null,
    problem: ownerRead?.problem ?? null,
  }, {
    text: snapshot.text,
    openedSignature,
    targetSignature,
    ancestorPins: resolved.pins,
    ownerRead,
  });
}

async function runLifecycleRound(
  live: Live,
  options: OwnedOptions,
  primaryPins: readonly DirectoryPin[],
  storageRoot: string,
  runId: string,
  targets: ReturnType<typeof deriveNativeHarnessHistoryRecoveryTargets>,
  round: 1 | 2,
): Promise<LifecycleRoundInternal> {
  const groups = new Map<string, NativeHarnessHistoryRecoveryProbeFact>();
  const workers = new Map<string, AuxInternal>();
  let controller: AuxInternal | null = null;
  let controllerProbe: NativeHarnessHistoryRecoveryProbeFact | null = null;
  let cancel: AuxInternal | null = null;
  let auxAttempts = 0;
  let auxCharged = 0;
  let probes = 0;
  let gate: "aborted" | "deadline-expired" | null = null;
  let controlFailure: NativeHarnessHistoryProcessReason | null = null;
  let halt: NativeHarnessHistoryProcessReason | null = null;

  const stop = (error: unknown): void => {
    if (error instanceof ObservationGate) gate = error.reason;
    else if (controlFailure === null) {
      controlFailure = processReason(
        "lifecycle-clock-unavailable",
        "The shared lifecycle clock/control became invalid, throwing or non-monotonic; no later lifecycle effect was started.",
      );
    }
  };
  const stopped = (): boolean => gate !== null || controlFailure !== null || halt !== null;
  const stopReason = "The fixed lifecycle window stopped before this query.";
  for (const attempt of targets.attempts) {
    if (stopped()) break;
    try {
      liveCheck(live);
    } catch (error) {
      stop(error);
      break;
    }
    const fact = probeNativeHarnessHistoryRecoveryGroup(attempt, options.signalQuery);
    if (fact.called) probes += 1;
    groups.set(attempt.targetId, fact);
  }
  if (stopped()) {
    for (const attempt of targets.attempts) {
      if (!groups.has(attempt.targetId)) groups.set(attempt.targetId, notAttemptedGroup(attempt, stopReason));
    }
    return Object.freeze({
      round,
      groups,
      workers,
      controller,
      controllerProbe,
      cancel,
      auxAttempts,
      auxCharged,
      probes,
      gate,
      controlFailure,
      halt,
    });
  }

  const auxOrder: Array<{ target: NativeHarnessHistoryRecoveryAuxTarget; attempt: NativeHarnessHistoryRecoveryAttemptTarget | null }> = [];
  for (const attempt of targets.attempts) {
    if (attempt.workerOwner !== null) auxOrder.push({ target: attempt.workerOwner, attempt });
  }
  auxOrder.push({ target: targets.controllerOwner, attempt: null });
  auxOrder.push({ target: targets.cancel, attempt: null });

  for (const item of auxOrder) {
    if (stopped()) break;
    try {
      liveCheck(live);
    } catch (error) {
      stop(error);
      break;
    }
    if (auxCharged + item.target.capBytes > NATIVE_HARNESS_HISTORY_RECOVERY_LIMITS.auxChargeLimitBytes) {
      controlFailure = processReason(
        "lifecycle-charge-refused",
        "The fixed auxiliary charge bound refused another attempt; no later lifecycle effect was started.",
      );
      break;
    }
    auxCharged += item.target.capBytes;
    auxAttempts += 1;
    let observed: AuxInternal;
    try {
      observed = await observeAuxTarget(
        live,
        options.io,
        primaryPins,
        storageRoot,
        runId,
        item.target,
        item.attempt,
      );
    } catch {
      controlFailure = processReason(
        "lifecycle-aux-unexpected",
        "An auxiliary observation failed without a serializable result; later lifecycle effects were stopped.",
      );
      break;
    }
    if (item.target.kind === "worker-owner") workers.set(item.attempt!.targetId, observed);
    else if (item.target.kind === "controller-owner") controller = observed;
    else cancel = observed;
    if (
      observed.fact.openedFiles === 1
      && (!observed.fact.closeAttempted || !observed.fact.closeSettled || !observed.fact.closeSucceeded)
    ) {
      halt = processReason(
        "lifecycle-close-unconfirmed",
        "An opened auxiliary handle did not settle successfully; no later auxiliary, round-two or final-primary open was started.",
      );
      break;
    }
    // The full auxiliary operation, including an actually held close, has
    // settled. Recheck the same five-second live window now; never race or
    // claim an early close.
    try {
      liveCheck(live);
    } catch (error) {
      stop(error);
      break;
    }
    if (item.target.kind === "controller-owner"
      && observed.fact.state === "observed"
      && observed.fact.ownerPid !== null) {
      try {
        liveCheck(live);
        controllerProbe = probeNativeHarnessHistoryRecoveryController(observed.fact.ownerPid, options.signalQuery);
        if (controllerProbe.called) probes += 1;
      } catch (error) {
        stop(error);
      }
    }
  }
  if (!stopped()) {
    try {
      liveCheck(live);
    } catch (error) {
      stop(error);
    }
  }

  return Object.freeze({
    round,
    groups,
    workers,
    controller,
    controllerProbe,
    cancel,
    auxAttempts,
    auxCharged,
    probes,
    gate,
    controlFailure,
    halt,
  });
}

function buildAttemptSummary(
  attempt: NativeHarnessHistoryRecoveryAttemptTarget,
  runId: string,
  round1: LifecycleRoundInternal,
  round2: LifecycleRoundInternal,
): NativeHarnessHistoryRecoveryAttemptSummaryInput {
  const worker1 = round1.workers.get(attempt.targetId) ?? null;
  const worker2 = round2.workers.get(attempt.targetId) ?? null;
  const group1 = round1.groups.get(attempt.targetId) ?? null;
  const group2 = round2.groups.get(attempt.targetId) ?? null;
  const workerComparison = comparisonFromAux(worker1, worker2);
  const groupComparison = comparisonFromGroup(group1, group2);
  let coverage: "complete" | "partial" | "unavailable";
  if (attempt.workerOwner === null) {
    coverage = "unavailable";
  } else if (worker1 === null || worker2 === null) {
    coverage = "partial";
  } else if (
    ["unsafe", "unavailable", "too-large", "aborted", "expired", "not-attempted"].includes(worker1.fact.state)
    || ["unsafe", "unavailable", "too-large", "aborted", "expired", "not-attempted"].includes(worker2.fact.state)
  ) {
    coverage = worker1.fact.state === "not-attempted" || worker2.fact.state === "not-attempted"
      ? "partial"
      : "unavailable";
  } else if (attempt.pgid !== null) {
    coverage = group1?.called === true && group2?.called === true ? "complete" : "partial";
  } else {
    coverage = "complete";
  }
  return Object.freeze({
    target: attempt,
    round1Worker: worker1?.fact ?? null,
    round2Worker: worker2?.fact ?? null,
    binding1: bindNativeHarnessHistoryRecoveryWorker(attempt, runId, worker1?.ownerRead ?? null),
    binding2: bindNativeHarnessHistoryRecoveryWorker(attempt, runId, worker2?.ownerRead ?? null),
    group1,
    group2,
    workerComparison,
    groupComparison,
    coverage,
  });
}

type LifecyclePrerequisites =
  | { readonly ok: true; readonly inventory: NativeHarnessDispatchInventoryV2; readonly runRelativeRoot: string }
  | { readonly ok: false; readonly problem: NativeHarnessHistoryProcessReason };

function lifecyclePrerequisites(
  metadata: NativeHarnessReconciliationResult | null,
  firstPass: ReadonlyMap<NativeHarnessReconciliationFileKey, FirstPassFacts>,
  owned: OwnedExpectation,
): LifecyclePrerequisites {
  if (metadata === null) {
    return {
      ok: false,
      problem: processReason(
        "lifecycle-metadata-unavailable",
        "The original reconciliation metadata join did not produce a result; no lifecycle paths were selected.",
      ),
    };
  }
  if (
    metadata.metadata.compatible !== true
    || metadata.coverage.status !== "complete"
    || metadata.build.labelCompatible !== true
    || metadata.inventory?.schema !== "v2"
    || metadata.run === null
    || metadata.source === null
    || metadata.owner === null
  ) {
    return {
      ok: false,
      problem: processReason(
        "lifecycle-metadata-refused",
        "Compatible metadata, complete coverage, the build label join, v2 inventory and the run/source/owner joins are required before lifecycle IO.",
      ),
    };
  }
  const inventoryText = firstPass.get("inventory")?.text;
  if (inventoryText === undefined) {
    return {
      ok: false,
      problem: processReason(
        "lifecycle-inventory-missing",
        "The first-pass inventory text is unavailable; no lifecycle paths were selected.",
      ),
    };
  }
  let inventory: NativeHarnessDispatchInventoryV2;
  try {
    const decoded = decodeNativeHarnessDispatchInventoryText(inventoryText, { runId: owned.runId });
    if (decoded.schema !== NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2) {
      return {
        ok: false,
        problem: processReason(
          "lifecycle-inventory-schema",
          "The inventory is not the admitted v2 schema; lifecycle IO was refused.",
        ),
      };
    }
    inventory = decoded;
  } catch {
    return {
      ok: false,
      problem: processReason(
        "lifecycle-inventory-invalid",
        "The original inventory v2 decoder refused the inventory; lifecycle IO was refused.",
      ),
    };
  }
  const storeRelativeRoot = metadata.source.storeRelativeRoot;
  if (
    typeof storeRelativeRoot !== "string"
    || storeRelativeRoot.length === 0
    || storeRelativeRoot.length > 1024
    || CONTROL_PATTERN.test(storeRelativeRoot)
    || path.isAbsolute(storeRelativeRoot)
    || storeRelativeRoot.split("/").includes("..")
  ) {
    return {
      ok: false,
      problem: processReason(
        "lifecycle-run-root",
        "The validated source store root is not a bounded relative path; lifecycle IO was refused.",
      ),
    };
  }
  return {
    ok: true,
    inventory,
    runRelativeRoot: `${storeRelativeRoot}/runs/${owned.runId}`,
  };
}

function lifecycleWindowBase(
  startedAt: number,
  deadlineAt: number,
  globalDeadlineAt: number,
): LifecycleProjectionBase["window"] {
  return Object.freeze({
    budgetMs: 5_000 as const,
    startedAt,
    deadlineAt,
    checkedAt: startedAt,
    expired: startedAt >= deadlineAt,
    globalDeadlineAt,
    roundsStarted: 0 as const,
  });
}

/**
 * Fixed two-round lifecycle observation. It starts one five-second sub-window
 * before the first auxiliary directory/file observation, never renews it from
 * the outer thirty-second window, and stops starting new IO on control/time.
 */
async function observeLifecycleBetweenPasses(
  live: Live,
  options: OwnedOptions,
  owned: OwnedExpectation,
  primaryPins: readonly DirectoryPin[],
  firstPass: ReadonlyMap<NativeHarnessReconciliationFileKey, FirstPassFacts>,
  outcome: ContentBetweenPassesOutcome | null,
  mutable: MutableLifecycleFacts,
  globalGate: ObservationGate | null,
): Promise<{ readonly gate: ObservationGate | null; readonly halt: NativeHarnessHistoryProcessReason | null }> {
  const globalDeadlineAt = live.deadlineAt;
  let startedAt = live.lastTime;
  let entryGate: "aborted" | "deadline-expired" | null = globalGate?.reason ?? null;
  let entryControlFailure: NativeHarnessHistoryProcessReason | null = null;
  if (globalGate === null) {
    try {
      // Validate the original shared live clock/signal/monotonic state before
      // any lifecycle effect. The owned checked time is the only start value.
      liveCheck(live);
      startedAt = live.lastTime;
    } catch (error) {
      if (error instanceof ObservationGate) entryGate = error.reason;
      else {
        entryControlFailure = processReason(
          "lifecycle-clock-unavailable",
          "The shared clock/control was invalid, throwing or non-monotonic at lifecycle entry; no lifecycle effect was started.",
        );
      }
    }
  }
  const deadlineAt = Math.min(globalDeadlineAt, startedAt + NATIVE_HARNESS_RECONCILIATION_LIFECYCLE_DEADLINE_MS);
  const base = {
    attempts: Object.freeze([]),
    controller: Object.freeze({
      round1Owner: null,
      round2Owner: null,
      probe1: null,
      probe2: null,
      ownerComparison: "not-attempted" as const,
      probeComparison: "not-attempted" as const,
      lockDirectory1: "not-attempted" as const,
      lockDirectory2: "not-attempted" as const,
    }),
    cancel: Object.freeze({
      round1: null,
      round2: null,
      status: "not-attempted" as const,
      comparison: "not-attempted" as const,
    }),
    inventoryRows: 0,
    auxAttemptsRound1: 0,
    auxAttemptsRound2: 0,
    auxChargedBytes: 0,
    probesRound1: 0,
    probesRound2: 0,
    window: lifecycleWindowBase(startedAt, deadlineAt, globalDeadlineAt),
    gate: null,
    prerequisiteFailure: null,
    derivationProblems: Object.freeze([]),
  };

  if (entryGate !== null) {
    mutable.raw = Object.freeze({
      ...base,
      window: Object.freeze({
        ...base.window,
        checkedAt: live.lastTime,
        expired: entryGate === "deadline-expired" || live.lastTime >= deadlineAt,
      }),
      gate: entryGate,
    });
    return { gate: null, halt: null };
  }
  if (entryControlFailure !== null) {
    mutable.raw = Object.freeze({
      ...base,
      prerequisiteFailure: entryControlFailure,
    });
    return { gate: null, halt: null };
  }
  if (outcome === null) {
    mutable.raw = Object.freeze({
      ...base,
      prerequisiteFailure: processReason(
        "lifecycle-primary-incomplete",
        "The four first-pass primaries were not completely observed; no lifecycle path or probe was started.",
      ),
    });
    return { gate: null, halt: null };
  }
  const prerequisites = lifecyclePrerequisites(outcome.metadata, firstPass, owned);
  if (!prerequisites.ok) {
    mutable.raw = Object.freeze({
      ...base,
      prerequisiteFailure: prerequisites.problem,
    });
    return { gate: null, halt: null };
  }
  const targets = deriveNativeHarnessHistoryRecoveryTargets(
    owned.storageRoot,
    prerequisites.runRelativeRoot,
    owned.runId,
    prerequisites.inventory.dispatches.map((row) => ({
      ordinal: row.ordinal,
      nonce: row.nonce,
      stage: row.stage,
      attempt: row.attempt,
      cwd: row.cwd,
      artifactDir: row.artifactDir,
      state: row.state,
      launchRuntimeRoot: row.launch?.runtimeRoot ?? null,
      pid: row.process?.pid ?? null,
      pgid: row.process?.pgid ?? null,
      processIdentitySha256: row.process?.identitySha256 ?? null,
      cleanup: row.cleanup === undefined
        ? null
        : row.cleanup.observationKind === "synthetic-fixture"
          ? { observationKind: "synthetic-fixture" as const }
          : {
            observationKind: "runner-observation" as const,
            spawnAttempted: row.cleanup.observation.spawnAttempted,
            closeSeen: row.cleanup.observation.closeSeen,
            groupObservation: row.cleanup.observation.groupObservation,
            hostWorkSettled: row.cleanup.observation.hostWorkSettled,
            approvalWorkSettled: row.cleanup.observation.approvalWorkSettled,
            logFlush: row.cleanup.observation.logFlush,
          },
    })),
  );
  if (targets.refused) {
    mutable.raw = Object.freeze({
      ...base,
      inventoryRows: targets.inventoryRows,
      prerequisiteFailure: targets.problems[0] ?? processReason(
        "lifecycle-target-refused",
        "The lifecycle target derivation refused the inventory without selecting a path.",
      ),
      derivationProblems: targets.problems,
    });
    return { gate: null, halt: null };
  }

  const lifecycleLive: Live = {
    clock: options.clock,
    signal: options.signal,
    deadlineAt,
    control: live.control,
    lastTime: startedAt,
  };
  const emptyRound = (round: 1 | 2): LifecycleRoundInternal => Object.freeze({
    round,
    groups: new Map(),
    workers: new Map(),
    controller: null,
    controllerProbe: null,
    cancel: null,
    auxAttempts: 0,
    auxCharged: 0,
    probes: 0,
    gate: null,
    controlFailure: null,
    halt: null,
  });
  let round1 = emptyRound(1);
  let round2 = emptyRound(2);
  let roundsStarted: 0 | 1 | 2 = 0;
  let phaseGate: "aborted" | "deadline-expired" | null = null;
  let phaseControlFailure: NativeHarnessHistoryProcessReason | null = null;
  let phaseHalt: NativeHarnessHistoryProcessReason | null = null;
  const stopPhase = (error: unknown): void => {
    if (error instanceof ObservationGate) phaseGate = error.reason;
    else if (phaseControlFailure === null) {
      phaseControlFailure = processReason(
        "lifecycle-clock-unavailable",
        "The shared lifecycle clock/control became invalid, throwing or non-monotonic; no later lifecycle effect was started.",
      );
    }
  };
  const phaseStopped = (): boolean => phaseGate !== null || phaseControlFailure !== null || phaseHalt !== null;

  try {
    liveCheck(lifecycleLive);
  } catch (error) {
    stopPhase(error);
  }
  if (!phaseStopped()) {
    roundsStarted = 1;
    round1 = await runLifecycleRound(
      lifecycleLive,
      options,
      primaryPins,
      owned.storageRoot,
      owned.runId,
      targets,
      1,
    );
    if (round1.gate !== null) phaseGate = round1.gate;
    if (round1.controlFailure !== null) phaseControlFailure = round1.controlFailure;
    if (round1.halt !== null) phaseHalt = round1.halt;
    if (!phaseStopped()) {
      try {
        liveCheck(lifecycleLive);
      } catch (error) {
        stopPhase(error);
      }
    }
    if (!phaseStopped()) {
      roundsStarted = 2;
      round2 = await runLifecycleRound(
        lifecycleLive,
        options,
        primaryPins,
        owned.storageRoot,
        owned.runId,
        targets,
        2,
      );
      if (round2.gate !== null) phaseGate = round2.gate;
      if (round2.controlFailure !== null) phaseControlFailure = round2.controlFailure;
      if (round2.halt !== null) phaseHalt = round2.halt;
      if (!phaseStopped()) {
        try {
          liveCheck(lifecycleLive);
        } catch (error) {
          stopPhase(error);
        }
      }
    }
  }
  live.lastTime = Math.max(live.lastTime, lifecycleLive.lastTime);
  const controlFailure = phaseControlFailure;
  const phaseWindowExpired = phaseGate === "deadline-expired" || lifecycleLive.lastTime >= deadlineAt;
  if (phaseGate !== null || controlFailure !== null) {
    // Preserve every already-observed round fact and counter. Only new effects
    // are stopped; no refund or zeroed retry is performed.
  }

  const attempts = targets.attempts.map((attempt) => buildAttemptSummary(
    attempt,
    owned.runId,
    round1,
    round2,
  ));
  const ownerComparison = comparisonFromAux(round1.controller, round2.controller);
  const ownerMissingBoth = round1.controller?.fact.state === "missing"
    && round2.controller?.fact.state === "missing";
  const lockMissingBoth = lockDirectoryState(round1.controller) === "missing"
    && lockDirectoryState(round2.controller) === "missing";
  const probeComparison = round1.controllerProbe === null && round2.controllerProbe === null
    ? ownerMissingBoth || lockMissingBoth ? "stable" as const : "not-attempted" as const
    : comparisonFromGroup(round1.controllerProbe, round2.controllerProbe);
  let cancelStatus: "requested" | "not-observed" | "unknown" | "not-attempted";
  const anyCancelExists = round1.cancel?.fact.exists === true || round2.cancel?.fact.exists === true;
  const bothCancelAbsent = round1.cancel?.fact.state === "missing"
    && round2.cancel?.fact.state === "missing"
    && round1.cancel.fact.exists === false
    && round2.cancel.fact.exists === false;
  const anyCancelNotAttempted = round1.cancel === null
    || round2.cancel === null
    || round1.cancel.fact.state === "not-attempted"
    || round2.cancel.fact.state === "not-attempted";
  if (anyCancelExists) cancelStatus = "requested";
  else if (bothCancelAbsent) cancelStatus = "not-observed";
  else if (anyCancelNotAttempted) cancelStatus = "not-attempted";
  else cancelStatus = "unknown";
  const gate = phaseGate;
  const checkedAt = lifecycleLive.lastTime;
  mutable.raw = Object.freeze({
    attempts: Object.freeze(attempts),
    controller: Object.freeze({
      round1Owner: round1.controller?.fact ?? null,
      round2Owner: round2.controller?.fact ?? null,
      probe1: round1.controllerProbe,
      probe2: round2.controllerProbe,
      ownerComparison,
      probeComparison,
      lockDirectory1: lockDirectoryState(round1.controller),
      lockDirectory2: lockDirectoryState(round2.controller),
    }),
    cancel: Object.freeze({
      round1: round1.cancel?.fact ?? null,
      round2: round2.cancel?.fact ?? null,
      status: cancelStatus,
      comparison: comparisonFromAux(round1.cancel, round2.cancel),
    }),
    inventoryRows: targets.inventoryRows,
    auxAttemptsRound1: round1.auxAttempts,
    auxAttemptsRound2: round2.auxAttempts,
    auxChargedBytes: round1.auxCharged + round2.auxCharged,
    probesRound1: round1.probes,
    probesRound2: round2.probes,
    window: Object.freeze({
      ...lifecycleWindowBase(startedAt, deadlineAt, globalDeadlineAt),
      checkedAt,
      expired: phaseWindowExpired,
      roundsStarted,
    }),
    gate,
    prerequisiteFailure: gate !== null ? null : phaseHalt ?? controlFailure,
    derivationProblems: targets.problems,
  });
  return {
    gate: gate === "aborted" ? new ObservationGate("aborted") : null,
    halt: phaseHalt,
  };
}

/**
 * Runs once between the two primary passes. The plan is pure and therefore
 * selects no content path before all four first-pass texts exist. The byte
 * observer shares the outer live guard, actual signal and one deadline; it is
 * never an issued output capture.
 */
async function observeContentBetweenPasses(
  live: Live,
  options: OwnedOptions,
  owned: OwnedExpectation,
  firstPass: ReadonlyMap<NativeHarnessReconciliationFileKey, FirstPassFacts>,
): Promise<ContentBetweenPassesOutcome> {
  const facts = initialContentFacts();
  let metadata: NativeHarnessReconciliationResult | null = null;
  let planResult: NativeHarnessReconciliationContentPlanResult;
  try {
    planResult = planNativeHarnessReconciliationContent({
      runText: firstPass.get("run")!.text,
      sourceText: firstPass.get("source")!.text,
      inventoryText: firstPass.get("inventory")!.text,
      ownerText: firstPass.get("owner")!.text,
      expected: owned,
      now: live.lastTime,
    });
    metadata = planResult.metadata;
  } catch {
    facts.planner = "refused";
    facts.status = "unavailable";
    facts.provisionalStatus = "unavailable";
    return { gate: null, facts, metadata };
  }
  if (planResult.status === "not-required") {
    facts.planner = "not-required";
    facts.status = "not-required";
    facts.provisionalStatus = "not-required";
    facts.planReasons = [...planResult.reasons];
    return { gate: null, facts, metadata };
  }
  if (planResult.status === "unavailable") {
    facts.planner = "unavailable";
    facts.status = "unavailable";
    facts.provisionalStatus = "unavailable";
    facts.planReasons = [...planResult.reasons];
    return { gate: null, facts, metadata };
  }

  facts.planner = "planned";
  const guard = (): void => {
    try {
      liveCheck(live);
    } catch (error) {
      if (error instanceof ObservationGate) {
        throw createNativeHarnessContentControlFailure(
          error.reason === "aborted" ? "aborted" : "deadline-expired",
        );
      }
      throw createNativeHarnessContentControlFailure("control-unavailable");
    }
  };
  let signal: AbortSignal;
  if (options.signal !== null) {
    signal = options.signal;
  } else if (typeof AbortController === "function") {
    signal = new AbortController().signal;
  } else {
    facts.status = "unavailable";
    facts.provisionalStatus = "unavailable";
    facts.failure = {
      code: "invalid-control",
      reason: "A fixed content signal is unavailable.",
    };
    return { gate: null, facts, metadata };
  }

  let result: NativeHarnessReconciliationContentByteResult;
  try {
    result = await observeNativeHarnessReconciliationContentBytes(planResult.plan, {
      guard,
      signal,
      chargeLimitBytes: NATIVE_HARNESS_RECONCILIATION_CONTENT_CHARGE_LIMIT_BYTES,
      fileIo: options.io,
    });
  } catch {
    facts.status = "unavailable";
    facts.provisionalStatus = "unavailable";
    facts.failure = {
      code: "io-failure",
      reason: "The content byte observation failed without a serializable host error.",
    };
    return { gate: null, facts, metadata };
  }

  if (result.ok) {
    facts.status = "stable";
    facts.provisionalStatus = "stable";
    facts.observation = result.observation;
    facts.chargedBytes = result.observation.chargedBytes;
    facts.chargeLimitBytes = result.observation.chargeLimitBytes;
    facts.tracePassesStarted = 2;
    return { gate: null, facts, metadata };
  }

  facts.chargedBytes = result.chargedBytes;
  facts.chargeLimitBytes = result.chargeLimitBytes;
  facts.tracePassesStarted = result.tracePassesStarted;
  facts.failure = {
    code: result.code,
    reason: result.reason,
    ...(result.observedMismatch === true ? { observedMismatch: true as const } : {}),
  };
  if (result.code === "aborted") {
    facts.status = "aborted";
    facts.provisionalStatus = "aborted";
    return { gate: new ObservationGate("aborted"), facts, metadata };
  }
  if (result.code === "deadline") {
    facts.status = "expired";
    facts.provisionalStatus = "expired";
    return { gate: new ObservationGate("deadline-expired"), facts, metadata };
  }
  // Only explicit positive mismatch evidence is presented as a byte
  // difference. A legacy reader code such as `changed` without that flag is an
  // unavailable observation, not an asserted inequality.
  if (result.observedMismatch === true) {
    facts.status = "different";
    facts.provisionalStatus = "different";
  } else {
    facts.status = "unavailable";
    facts.provisionalStatus = "unavailable";
  }
  return { gate: null, facts, metadata };
}

/**
 * One private fixed-mode loop for both public observations. It always reads
 * the four exact original recovery primaries twice and rechecks all seven
 * parent pins. The content mode additionally plans and byte-observes latest
 * completed contents between the two primary passes. Invalid
 * expectations/options are refused before the first await or file-system call;
 * each primary's full cap is charged before its capture with no refund/retry.
 */
async function observeFixedMode(
  expectation: NativeHarnessReconciliationExpectation,
  options: NativeHarnessReconciliationFileOptions | NativeHarnessReconciliationLifecycleOptions,
  mode: "files" | "content" | "lifecycle",
): Promise<FixedModeFacts> {
  const owned = readExpectation(expectation);
  const resolvedOptions = readOptions(options, mode);
  const plan = buildPlan(owned);
  const budgetMs = mode === "files"
    ? NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS
    : NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS;
  const startedAt = readClock(resolvedOptions.clock);
  const deadlineAt = startedAt > Number.MAX_SAFE_INTEGER - budgetMs
    ? Number.MAX_SAFE_INTEGER
    : startedAt + budgetMs;
  const liveControl: LiveControl = { failure: null };
  const live: Live = {
    clock: resolvedOptions.clock,
    signal: resolvedOptions.signal,
    deadlineAt,
    control: liveControl,
    lastTime: startedAt,
  };
  const reasons: NativeHarnessReconciliationFilesReason[] = [];
  const captures: NativeHarnessReconciliationFileCapture[] = [];
  const firstPass = new Map<NativeHarnessReconciliationFileKey, FirstPassFacts>();
  let gate: ObservationGate | null = null;
  let unavailableFailure = false;
  let lifecycleHalt: NativeHarnessHistoryProcessReason | null = null;
  let closeFailure = false;
  let crossPassMismatch = false;
  let chargedBytes = 0;
  let openedFiles = 0;
  let closeAttempted = 0;
  let closeSettled = 0;
  let closeSucceeded = 0;
  let pinsStable = false;
  let pinsDifferent = false;
  let pinsUnknown = false;
  let pinsCheckedAtEnd = false;
  let metadata: NativeHarnessReconciliationResult | null = null;
  let metadataStatus: NativeHarnessReconciliationFilesResult["metadataStatus"] = "not-observed";

  let pins: readonly DirectoryPin[] = [];
  let pinsInitial = false;
  try {
    liveCheck(live);
    const pinned: DirectoryPin[] = [];
    for (const directory of plan.pins) {
      pinned.push(await pinDirectory(live, resolvedOptions.io, directory));
    }
    pins = Object.freeze(pinned);
    pinsInitial = true;
  } catch (error) {
    if (error instanceof ObservationGate) {
      gate = error;
      addGateReason(reasons, error);
    } else {
      const failure = classifyCaptureError(error);
      addReason(reasons, failure.reason);
      unavailableFailure = true;
    }
  }

  const content = initialContentFacts();
  const lifecycle = initialLifecycleFacts();

  if (pinsInitial) {
    const runPass = async (pass: 1 | 2): Promise<boolean> => {
      let stopped = false;
      for (let index = 0; index < plan.files.length; index++) {
        const spec = plan.files[index]!;
        const ordinal = pass === 1 ? index + 1 : plan.files.length + index + 1;
        try {
          liveCheck(live);
        } catch (error) {
          if (error instanceof ObservationGate) {
            gate = error;
            addGateReason(reasons, error);
          } else {
            const failure = classifyCaptureError(error);
            addReason(reasons, failure.reason);
            unavailableFailure = true;
          }
          stopped = true;
          break;
        }
        chargedBytes += spec.capBytes;
        const captureIo = createCaptureIo(live, resolvedOptions.io, pins, spec);
        let snapshot: Awaited<ReturnType<typeof captureWorkspaceText>> | null = null;
        let failure: ObservationGate | ObservationFailure | null = null;
        try {
          snapshot = await captureWorkspaceText(
            owned.storageRoot,
            spec.relativePath,
            captureIo.io,
            live.lastTime,
          );
        } catch (error) {
          failure = captureIo.refusal() ?? classifyCaptureError(error);
        }

        const closeFacts = summarizeCloses(captureIo.closes);
        openedFiles += captureIo.closes.length;
        closeAttempted += captureIo.closes.filter((record) => record.attempted).length;
        closeSettled += captureIo.closes.filter((record) => record.settled).length;
        closeSucceeded += captureIo.closes.filter((record) => record.succeeded).length;
        if (captureIo.closes.some((record) => record.attempted && (!record.settled || !record.succeeded))) {
          closeFailure = true;
          addReason(reasons, "close-failed");
          if (!(failure instanceof ObservationGate)) {
            failure = new ObservationFailure("close-failed");
          }
        }
        const opened = captureIo.opened();
        if (snapshot !== null && opened === null && failure === null) {
          failure = new ObservationFailure("io-failed");
        }
        if (snapshot !== null && opened !== null && failure === null) {
          const bytes = snapshot.file.bytes;
          const sha256 = snapshot.file.sha256;
          let matchesFirstPass: boolean | null = null;
          if (pass === 1) {
            firstPass.set(spec.key, { text: snapshot.text, bytes, sha256, opened });
          } else {
            const first = firstPass.get(spec.key);
            matchesFirstPass = first !== undefined
              && first.bytes === bytes
              && first.sha256 === sha256
              && sameSignature(first.opened, opened);
            if (matchesFirstPass !== true) {
              crossPassMismatch = true;
              addReason(reasons, "changed");
            }
          }
          captures.push(freezeCapture({
            ordinal,
            pass,
            file: spec.key,
            chargedBytes: spec.capBytes,
            outcome: "captured",
            reason: null,
            bytes,
            sha256,
            matchesFirstPass,
            openedFiles: closeFacts.openedFiles,
            close: {
              attempted: closeFacts.attempted,
              settled: closeFacts.settled,
              succeeded: closeFacts.succeeded,
            },
          }));
        }
        if (failure !== null) {
          const reason = failure.reason;
          addReason(reasons, reason);
          if (!(failure instanceof ObservationGate)) unavailableFailure = true;
          captures.push(freezeCapture({
            ordinal,
            pass,
            file: spec.key,
            chargedBytes: spec.capBytes,
            outcome: "refused",
            reason,
            bytes: null,
            sha256: null,
            matchesFirstPass: null,
            openedFiles: closeFacts.openedFiles,
            close: {
              attempted: closeFacts.attempted,
              settled: closeFacts.settled,
              succeeded: closeFacts.succeeded,
            },
          }));
        }
        try {
          liveCheck(live);
        } catch (error) {
          if (error instanceof ObservationGate) {
            gate = error;
            addGateReason(reasons, error);
          } else {
            const terminal = classifyCaptureError(error);
            addReason(reasons, terminal.reason);
            unavailableFailure = true;
            stopped = true;
          }
        }
        if (failure instanceof ObservationGate) {
          gate = failure;
          addGateReason(reasons, failure);
        }
        if (gate !== null || failure !== null || stopped || crossPassMismatch) {
          stopped = true;
          break;
        }
      }
      return stopped;
    };

    const stoppedFirst = await runPass(1);
    let contentOutcome: ContentBetweenPassesOutcome | null = null;
    if (!stoppedFirst && (mode === "content" || mode === "lifecycle")) {
      contentOutcome = await observeContentBetweenPasses(
        live,
        resolvedOptions,
        owned,
        firstPass,
      );
      Object.assign(content, contentOutcome.facts);
      if (contentOutcome.gate !== null) {
        gate = contentOutcome.gate;
        addGateReason(reasons, contentOutcome.gate);
      }
    }
    if (mode === "lifecycle") {
      const lifecycleOutcome = await observeLifecycleBetweenPasses(
        live,
        resolvedOptions,
        owned,
        pins,
        firstPass,
        contentOutcome,
        lifecycle,
        gate,
      );
      if (lifecycleOutcome.gate !== null) {
        gate = lifecycleOutcome.gate;
        addGateReason(reasons, lifecycleOutcome.gate);
      }
      if (lifecycleOutcome.halt !== null) {
        lifecycleHalt = lifecycleOutcome.halt;
        unavailableFailure = true;
        addReason(reasons, "io-failed");
      }
    }
    if (!stoppedFirst && gate === null && lifecycleHalt === null) await runPass(2);

    if (gate === null) {
      try {
        const verified = await verifyPinsAtEnd(live, resolvedOptions.io, pins);
        if (verified.status === "stable") {
          pinsStable = true;
          pinsCheckedAtEnd = true;
        } else if (verified.status === "different") {
          pinsDifferent = true;
          pinsCheckedAtEnd = true;
          addReason(reasons, "parent-changed");
        } else {
          pinsUnknown = true;
          pinsCheckedAtEnd = false;
          addReason(reasons, verified.reason);
        }
      } catch (error) {
        if (error instanceof ObservationGate) {
          gate = error;
          addGateReason(reasons, error);
          pinsCheckedAtEnd = false;
        } else {
          pinsUnknown = true;
          pinsCheckedAtEnd = false;
          addReason(reasons, "io-failed");
        }
      }
    }

    const allCaptured = captures.length === plan.files.length * 2
      && captures.every((capture) => capture.outcome === "captured");
    const allClosesSucceeded = closeFailure === false
      && captures.every(
        (capture) => capture.openedFiles === 1
          && capture.close.attempted
          && capture.close.settled
          && capture.close.succeeded,
      );
    if (
      gate === null
      && pinsStable
      && allCaptured
      && allClosesSucceeded
      && !crossPassMismatch
      && !unavailableFailure
    ) {
      try {
        liveCheck(live);
        metadata = reconcileNativeHarnessMetadata({
          runText: firstPass.get("run")!.text,
          sourceText: firstPass.get("source")!.text,
          inventoryText: firstPass.get("inventory")!.text,
          ownerText: firstPass.get("owner")!.text,
          expected: owned,
          now: live.lastTime,
        });
        liveCheck(live);
        metadataStatus = metadata.metadata.compatible ? "compatible" : "incompatible";
      } catch (error) {
        if (error instanceof ObservationGate) {
          gate = error;
          addGateReason(reasons, error);
        } else {
          addReason(reasons, "io-failed");
          unavailableFailure = true;
        }
        metadata = null;
        metadataStatus = "not-observed";
      }
    }
  }

  const evaluateStatus = (): NativeHarnessReconciliationFilesStatus => {
    if (gate !== null) return gate.reason === "aborted" ? "aborted" : "expired";
    if (closeFailure) return "unknown";
    if (crossPassMismatch || pinsDifferent) return "different";
    if (unavailableFailure || pinsUnknown) return "unavailable";
    if (
      pinsInitial
      && pinsStable
      && captures.length === plan.files.length * 2
      && captures.every((capture) => capture.outcome === "captured")
    ) {
      return "stable";
    }
    return "unavailable";
  };

  const finalizeContent = (finalStatus: NativeHarnessReconciliationFilesStatus): void => {
    if (mode === "files") return;
    const boundFacts = {
      planner: content.planner,
      status: content.status,
      provisionalStatus: content.provisionalStatus,
      revoked: content.revoked,
      revokedReasons: content.revokedReasons,
      planReasons: content.planReasons,
      failure: content.failure,
      observation: content.observation,
      chargedBytes: content.chargedBytes,
      chargeLimitBytes: content.chargeLimitBytes,
      tracePassesStarted: content.tracePassesStarted,
    };
    if (Buffer.byteLength(JSON.stringify(boundFacts), "utf8")
      > NATIVE_HARNESS_RECONCILIATION_CONTENT_MAX_METADATA_BYTES) {
      content.observation = null;
      content.status = "unavailable";
      content.provisionalStatus = "unavailable";
      content.revoked = false;
      content.failure = {
        code: "too-large",
        reason: "The composed content facts exceed their fixed metadata byte bound.",
      };
    }
    // Final primary/pin instability revokes any earlier stable or not-required
    // conclusion. Byte charges and actual failure facts are retained; the
    // nested stable observation is removed so no reusable claim survives.
    if (finalStatus !== "stable" && (content.status === "stable" || content.status === "not-required")) {
      content.status = "revoked";
      content.revoked = true;
      content.revokedReasons = [...reasons];
      content.observation = null;
    }
  };

  const finalizeLifecycle = (finalStatus: NativeHarnessReconciliationFilesStatus): void => {
    if (mode !== "lifecycle") return;
    const fallbackWindow = {
      budgetMs: 5_000 as const,
      startedAt: live.lastTime,
      deadlineAt: live.deadlineAt,
      checkedAt: live.lastTime,
      expired: finalStatus === "expired",
      globalDeadlineAt: live.deadlineAt,
      roundsStarted: 0 as const,
    };
    const input: LifecycleProjectionBase = lifecycle.raw ?? {
      attempts: [],
      controller: {
        round1Owner: null,
        round2Owner: null,
        probe1: null,
        probe2: null,
        ownerComparison: "not-attempted",
        probeComparison: "not-attempted",
        lockDirectory1: "not-attempted",
        lockDirectory2: "not-attempted",
      },
      cancel: {
        round1: null,
        round2: null,
        status: "not-attempted",
        comparison: "not-attempted",
      },
      inventoryRows: 0,
      auxAttemptsRound1: 0,
      auxAttemptsRound2: 0,
      auxChargedBytes: 0,
      probesRound1: 0,
      probesRound2: 0,
      window: fallbackWindow,
      gate: finalStatus === "aborted" ? "aborted" : finalStatus === "expired" ? "deadline-expired" : null,
      prerequisiteFailure: processReason(
        "lifecycle-not-started",
        "The collector did not reach the lifecycle phase; no auxiliary read or probe was started.",
      ),
      derivationProblems: [],
    };
    lifecycle.projected = projectNativeHarnessHistoryRecoveryLifecycle({
      ...input,
      finalPrimaryStatus: finalStatus,
      revokedReasons: [...reasons],
    });
  };

  let status = evaluateStatus();
  if (status !== "stable") {
    metadata = null;
    metadataStatus = "not-observed";
  }
  finalizeContent(status);
  finalizeLifecycle(status);

  let facts!: FixedModeFacts;
  const seal = (): FixedModeFacts => {
    // This runs after the public wrapper's final await, synchronously before
    // result assembly. It reuses the same clock/signal/deadline; a queued abort
    // or crossed deadline after the last pin check still refuses the result.
    try {
      liveCheck(live);
    } catch (error) {
      if (error instanceof ObservationGate) {
        gate = error;
        addGateReason(reasons, error);
      } else {
        const failure = classifyCaptureError(error);
        addReason(reasons, failure.reason);
        unavailableFailure = true;
      }
    }
    const sealedStatus = evaluateStatus();
    if (sealedStatus !== "stable") {
      metadata = null;
      metadataStatus = "not-observed";
    }
    finalizeContent(sealedStatus);
    finalizeLifecycle(sealedStatus);
    facts.status = sealedStatus;
    facts.checkedAt = live.lastTime;
    facts.reasons = [...reasons];
    facts.captures = [...captures];
    facts.metadata = metadata;
    facts.metadataStatus = metadataStatus;
    facts.content = content;
    facts.lifecycle = lifecycle;
    return facts;
  };

  facts = {
    status,
    observation: captures.length === plan.files.length * 2
      && captures.every((capture) => capture.outcome === "captured")
      ? "two-pass"
      : "partial",
    reasons: [...reasons],
    captures: [...captures],
    chargedBytes,
    openedFiles,
    closeAttempted,
    closeSettled,
    closeSucceeded,
    pinsStable,
    pinsCheckedAtEnd,
    deadlineAt,
    checkedAt: live.lastTime,
    metadata,
    metadataStatus,
    content,
    lifecycle,
    seal,
  };
  return facts;
}

/**
 * Observes the four exact original recovery primaries twice under one fixed
 * storage root. Invalid expectations/options are refused synchronously before
 * the first await or file-system call. Each file's full cap is charged before
 * its capture; a refusal stops all later captures with no refund or retry.
 */
export async function observeNativeHarnessReconciliationFiles(
  expectation: NativeHarnessReconciliationExpectation,
  options: NativeHarnessReconciliationFileOptions = {},
): Promise<NativeHarnessReconciliationFilesResult> {
  const facts = (await observeFixedMode(expectation, options, "files")).seal();
  return deepFreeze({
    schema: NATIVE_HARNESS_RECONCILIATION_FILES_SCHEMA,
    readOnly: true,
    resumeAvailable: false,
    processes: "not-inspected",
    artifacts: "not-inspected",
    status: facts.status,
    observation: facts.observation,
    reasons: Object.freeze([...facts.reasons]),
    captures: Object.freeze([...facts.captures]),
    chargedBytes: facts.chargedBytes,
    chargeLimitBytes: NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES,
    openedFiles: facts.openedFiles,
    maxConcurrentOpenedFiles: 1,
    close: Object.freeze({
      attempted: facts.closeAttempted,
      settled: facts.closeSettled,
      succeeded: facts.closeSucceeded,
    }),
    pins: Object.freeze({
      directoryCount: 7 as const,
      checkedAtEnd: facts.pinsCheckedAtEnd,
      stable: facts.pinsStable,
    }),
    deadline: Object.freeze({
      budgetMs: NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS,
      deadlineAt: facts.deadlineAt,
      checkedAt: facts.checkedAt,
      expired: facts.checkedAt >= facts.deadlineAt,
      soft: true as const,
      cleanupMayExceedDeadline: true as const,
    }),
    metadata: facts.metadata,
    metadataStatus: facts.metadataStatus,
  });
}

/**
 * Composes the unchanged five-second files observation with one shared
 * thirty-second window: the same four first-pass primary captures, a pure
 * bounded content plan, the fixed non-issuing byte observer, then the same
 * four second-pass captures and all seven final pins. A final primary/pin
 * difference, refusal, abort or expiry revokes any earlier stable content.
 */
export async function observeNativeHarnessReconciliationContent(
  expectation: NativeHarnessReconciliationExpectation,
  options: NativeHarnessReconciliationFileOptions = {},
): Promise<NativeHarnessReconciliationContentObservationResult> {
  const facts = (await observeFixedMode(expectation, options, "content")).seal();
  const content = facts.content;
  const contentDraft = {
    status: content.status,
    provisionalStatus: content.provisionalStatus,
    revoked: content.revoked,
    revokedReasons: [...content.revokedReasons],
    planner: content.planner,
    planReasons: [...content.planReasons],
    failure: content.failure === null
      ? null
      : {
        code: content.failure.code,
        reason: content.failure.reason,
        ...(content.failure.observedMismatch === true ? { observedMismatch: true as const } : {}),
      },
    observation: content.observation,
    chargedBytes: content.chargedBytes,
    chargeLimitBytes: content.chargeLimitBytes,
    tracePassesStarted: content.tracePassesStarted,
  };
  let metadataDraft = facts.metadata;
  let metadataStatusDraft = facts.metadataStatus;
  const artifactLabel = (): NativeHarnessReconciliationContentObservationResult["artifacts"] =>
    contentDraft.observation !== null
      ? "latest-completed-bytes-checked"
      : contentDraft.revoked
        ? "not-retained-after-primary-refusal"
        : contentDraft.chargedBytes > 0 ? "partial-bytes-not-retained" : "not-inspected";
  const build = (): NativeHarnessReconciliationContentObservationResult => ({
    schema: NATIVE_HARNESS_RECONCILIATION_CONTENT_SCHEMA,
    readOnly: true,
    resumeAvailable: false,
    processes: "not-inspected",
    artifacts: artifactLabel(),
    discardedAttemptContents: "not-verified-not-reused",
    status: facts.status,
    observation: facts.observation,
    reasons: [...facts.reasons],
    captures: [...facts.captures],
    chargedBytes: facts.chargedBytes,
    chargeLimitBytes: NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES,
    openedFiles: facts.openedFiles,
    maxConcurrentOpenedFiles: 1,
    close: {
      attempted: facts.closeAttempted,
      settled: facts.closeSettled,
      succeeded: facts.closeSucceeded,
    },
    pins: {
      directoryCount: 7 as const,
      checkedAtEnd: facts.pinsCheckedAtEnd,
      stable: facts.pinsStable,
    },
    deadline: {
      budgetMs: NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS,
      deadlineAt: facts.deadlineAt,
      checkedAt: facts.checkedAt,
      expired: facts.checkedAt >= facts.deadlineAt,
      soft: true as const,
      cleanupMayExceedDeadline: true as const,
    },
    metadata: metadataDraft,
    metadataStatus: metadataStatusDraft,
    content: contentDraft,
  });
  let result = build();
  if (Buffer.byteLength(JSON.stringify(result), "utf8")
    > NATIVE_HARNESS_RECONCILIATION_CONTENT_MAX_METADATA_BYTES) {
    // Final plain-result projection bound. Drop the optional heavy observation
    // and metadata, retain primary counts plus a bounded content failure
    // summary, and never present the content as available.
    contentDraft.observation = null;
    contentDraft.status = "unavailable";
    contentDraft.revoked = false;
    contentDraft.revokedReasons = [];
    contentDraft.failure = {
      code: "too-large",
      reason: "The composed content result exceeds its fixed metadata byte bound.",
    };
    metadataDraft = null;
    metadataStatusDraft = "not-observed";
    result = build();
    if (Buffer.byteLength(JSON.stringify(result), "utf8")
      > NATIVE_HARNESS_RECONCILIATION_CONTENT_MAX_METADATA_BYTES) {
      // This fixed-size projection contains only counters, small enums and one
      // bounded reason; it cannot exceed the bound.
      result = {
        ...result,
        metadata: null,
        metadataStatus: "not-observed",
        reasons: [],
        captures: [],
        content: {
          status: "unavailable",
          provisionalStatus: contentDraft.provisionalStatus,
          revoked: false,
          revokedReasons: [],
          planner: contentDraft.planner,
          planReasons: [],
          failure: {
            code: "too-large",
            reason: "The composed content result exceeds its fixed metadata byte bound.",
          },
          observation: null,
          chargedBytes: contentDraft.chargedBytes,
          chargeLimitBytes: contentDraft.chargeLimitBytes,
          tracePassesStarted: contentDraft.tracePassesStarted,
        },
      };
    }
  }
  return deepFreeze(result);
}

/**
 * Full read-only reconciliation: the same four primary documents, the existing
 * content byte observation, two fixed synchronous lifecycle rounds and the
 * same final primary/pin seal in one shared thirty-second window. The nested
 * lifecycle five-second window never resets the outer window and never grants
 * lock, cancel, resume or process authority.
 */
export async function observeNativeHarnessReconciliation(
  expectation: NativeHarnessReconciliationExpectation,
  options: NativeHarnessReconciliationLifecycleOptions = {},
): Promise<NativeHarnessReconciliationLifecycleResult> {
  const facts = (await observeFixedMode(expectation, options, "lifecycle")).seal();
  const lifecycle = facts.lifecycle.projected!;
  const content = facts.content;
  const contentDraft: NativeHarnessReconciliationContentFacts = {
    status: content.status,
    provisionalStatus: content.provisionalStatus,
    revoked: content.revoked,
    revokedReasons: [...content.revokedReasons],
    planner: content.planner,
    planReasons: [...content.planReasons],
    failure: content.failure === null
      ? null
      : {
        code: content.failure.code,
        reason: content.failure.reason,
        ...(content.failure.observedMismatch === true ? { observedMismatch: true as const } : {}),
      },
    observation: content.observation,
    chargedBytes: content.chargedBytes,
    chargeLimitBytes: content.chargeLimitBytes,
    tracePassesStarted: content.tracePassesStarted,
  };
  const processLabel = (
    lifecycleFacts: NativeHarnessHistoryRecoveryLifecycleFacts,
  ): NativeHarnessReconciliationLifecycleResult["processes"] => {
    const probes = lifecycleFacts.coverage.probesRound1 + lifecycleFacts.coverage.probesRound2;
    if (lifecycleFacts.status === "revoked") {
      return probes > 0 ? "not-retained-after-primary-refusal" : "not-inspected";
    }
    if (probes === 0) return "not-inspected";
    if (
      lifecycleFacts.window.roundsStarted === 2
      && lifecycleFacts.coverage.probesRound1 > 0
      && lifecycleFacts.coverage.probesRound2 > 0
    ) {
      return "two-round-signal0-observed";
    }
    return "partial-signal0-observed";
  };
  const artifactLabel = (
    lifecycleFacts: NativeHarnessHistoryRecoveryLifecycleFacts,
  ): NativeHarnessReconciliationLifecycleResult["artifacts"] => {
    const auxAttempts = lifecycleFacts.coverage.auxAttemptsRound1
      + lifecycleFacts.coverage.auxAttemptsRound2;
    if (lifecycleFacts.status === "revoked") {
      return auxAttempts > 0 ? "not-retained-after-primary-refusal" : "not-inspected";
    }
    if (auxAttempts === 0) return "not-inspected";
    return lifecycleFacts.status === "stable" || lifecycleFacts.status === "different"
      ? "auxiliary-owner-and-cancel-files-checked"
      : "partial-auxiliary-not-retained";
  };
  const build = (): NativeHarnessReconciliationLifecycleResult => ({
    schema: NATIVE_HARNESS_RECONCILIATION_LIFECYCLE_SCHEMA,
    readOnly: true,
    resumeAvailable: false,
    processes: processLabel(lifecycle),
    artifacts: artifactLabel(lifecycle),
    discardedAttemptContents: "not-verified-not-reused",
    status: facts.status,
    observation: facts.observation,
    reasons: [...facts.reasons],
    captures: [...facts.captures],
    chargedBytes: facts.chargedBytes,
    chargeLimitBytes: NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES,
    openedFiles: facts.openedFiles,
    maxConcurrentOpenedFiles: 1,
    close: {
      attempted: facts.closeAttempted,
      settled: facts.closeSettled,
      succeeded: facts.closeSucceeded,
    },
    pins: {
      directoryCount: 7 as const,
      checkedAtEnd: facts.pinsCheckedAtEnd,
      stable: facts.pinsStable,
    },
    deadline: {
      budgetMs: NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS,
      deadlineAt: facts.deadlineAt,
      checkedAt: facts.checkedAt,
      expired: facts.checkedAt >= facts.deadlineAt,
      soft: true as const,
      cleanupMayExceedDeadline: true as const,
      lifecycle: lifecycle.window,
    },
    metadata: facts.metadata,
    metadataStatus: facts.metadataStatus,
    content: contentDraft,
    lifecycle,
  });
  let result = build();
  if (Buffer.byteLength(JSON.stringify(result), "utf8")
    > NATIVE_HARNESS_RECONCILIATION_CONTENT_MAX_METADATA_BYTES) {
    // Fixed small projection: no attempt arrays, owner/cancel facts, capture
    // list, metadata or free-form reason strings remain. Only bounded counters,
    // enums, windows and one constant failure detail are serialized, so this
    // object cannot approach the 128 KiB bound.
    const compactLifecycle: NativeHarnessHistoryRecoveryLifecycleFacts = {
      ...lifecycle,
      status: "unavailable",
      provisionalStatus: "unavailable",
      revoked: false,
      revokedReasons: [],
      failure: lifecycle.failure ?? {
        code: "lifecycle-too-large",
        detail: "The composed lifecycle result exceeded its fixed 128 KiB bound; proof fields were not retained.",
      },
      attempts: [],
      currentGroups: {
        ...lifecycle.currentGroups,
        status: "unavailable",
        absenceObservation: "unknown",
      },
      controllerLease: {
        ...lifecycle.controllerLease,
        status: "unavailable",
        ownerRound1: null,
        ownerRound2: null,
        ownerComparison: "unavailable",
        probe1: null,
        probe2: null,
        probeComparison: "unavailable",
        ownerPid: null,
      },
      cancel: {
        ...lifecycle.cancel,
        status: "unknown",
        round1: null,
        round2: null,
        comparison: "unavailable",
      },
      observationStability: {
        ...lifecycle.observationStability,
        status: "unavailable",
        workerAuxStable: null,
        groupsStable: null,
        controllerStable: null,
        cancelStable: null,
        reasons: [],
      },
    };
    const compactContent: NativeHarnessReconciliationContentFacts = {
      ...contentDraft,
      status: "unavailable",
      provisionalStatus: "unavailable",
      revoked: false,
      revokedReasons: [],
      planReasons: [],
      failure: {
        code: "too-large",
        reason: "The composed reconciliation result exceeded its fixed metadata byte bound.",
      },
      observation: null,
    };
    result = {
      schema: NATIVE_HARNESS_RECONCILIATION_LIFECYCLE_SCHEMA,
      readOnly: true,
      resumeAvailable: false,
      processes: "not-retained-after-result-bound",
      artifacts: "not-retained-after-result-bound",
      discardedAttemptContents: "not-verified-not-reused",
      status: "unavailable",
      observation: facts.observation,
      reasons: [],
      captures: [],
      chargedBytes: facts.chargedBytes,
      chargeLimitBytes: NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES,
      openedFiles: facts.openedFiles,
      maxConcurrentOpenedFiles: 1,
      close: {
        attempted: facts.closeAttempted,
        settled: facts.closeSettled,
        succeeded: facts.closeSucceeded,
      },
      pins: {
        directoryCount: 7 as const,
        checkedAtEnd: facts.pinsCheckedAtEnd,
        stable: facts.pinsStable,
      },
      deadline: {
        budgetMs: NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS,
        deadlineAt: facts.deadlineAt,
        checkedAt: facts.checkedAt,
        expired: facts.checkedAt >= facts.deadlineAt,
        soft: true as const,
        cleanupMayExceedDeadline: true as const,
        lifecycle: compactLifecycle.window,
      },
      metadata: null,
      metadataStatus: "not-observed",
      content: compactContent,
      lifecycle: compactLifecycle,
    };
  }
  return deepFreeze(result);
}
