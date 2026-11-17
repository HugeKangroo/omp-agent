import { constants } from "node:fs";
import path from "node:path";
import { readActualAbortSignal } from "./native-abort.ts";
import {
  NATIVE_HARNESS_ACCOUNTING_MAX_BYTES,
} from "./native-harness-accounting.ts";
import {
  NATIVE_HARNESS_DISPATCH_INVENTORY_FILE,
  NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES,
} from "./native-harness-dispatch-inventory.ts";
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

function readOptions(value: unknown): OwnedOptions {
  const fields = readPlainFields(value ?? {}, ["signal", "fileIo", "now"], "reconciliation files options");
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
  return Object.freeze({
    signal,
    io,
    clock: (nowValue ?? Date.now) as () => number,
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

interface Live {
  readonly clock: () => number;
  readonly signal: AbortSignal | null;
  readonly deadlineAt: number;
  lastTime: number;
}

function liveCheck(live: Live): void {
  const observedAt = readClock(live.clock);
  if (observedAt < live.lastTime) {
    // A backwards clock is an unavailable observation, never permission to
    // re-measure or extend the one fixed window.
    throw new ObservationFailure("io-failed");
  }
  live.lastTime = observedAt;
  if (live.signal !== null) {
    const read = readActualAbortSignal(live.signal);
    if (!read.ok) throw new ObservationFailure("io-failed");
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
}

function createCaptureIo(
  live: Live,
  io: NativeFileIo,
  pins: readonly DirectoryPin[],
  spec: FileSpec,
): CaptureIo {
  const nonBlocking = constants.O_NONBLOCK ?? 0;
  const pinsByPath = new Map(pins.map((pin) => [pin.path, pin]));
  const closes: CloseRecord[] = [];
  let openedSignature: OpenSignature | null = null;
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
      recordRefusal(error);
      if (isErrno(error, "ENOENT")) refuse("parent-changed");
      throw error;
    }
    if (resolved !== pin.path) refuse("parent-changed");
    let info: NativeFileStats;
    try {
      info = await guarded(() => io.lstat(target, { bigint: true }));
    } catch (error) {
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
        recordRefusal(error);
        throw error;
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
  /**
   * Synchronous final control seal for the public wrapper's last await
   * boundary. It reuses the one live deadline/signal, updates status and
   * revokes any provisional content, and never adds a new window.
   */
  seal: () => FixedModeFacts;
}

interface ContentBetweenPassesOutcome {
  readonly gate: ObservationGate | null;
  readonly facts: MutableContentFacts;
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
  } catch {
    facts.planner = "refused";
    facts.status = "unavailable";
    facts.provisionalStatus = "unavailable";
    return { gate: null, facts };
  }
  if (planResult.status === "not-required") {
    facts.planner = "not-required";
    facts.status = "not-required";
    facts.provisionalStatus = "not-required";
    facts.planReasons = [...planResult.reasons];
    return { gate: null, facts };
  }
  if (planResult.status === "unavailable") {
    facts.planner = "unavailable";
    facts.status = "unavailable";
    facts.provisionalStatus = "unavailable";
    facts.planReasons = [...planResult.reasons];
    return { gate: null, facts };
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
    return { gate: null, facts };
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
    return { gate: null, facts };
  }

  if (result.ok) {
    facts.status = "stable";
    facts.provisionalStatus = "stable";
    facts.observation = result.observation;
    facts.chargedBytes = result.observation.chargedBytes;
    facts.chargeLimitBytes = result.observation.chargeLimitBytes;
    facts.tracePassesStarted = 2;
    return { gate: null, facts };
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
    return { gate: new ObservationGate("aborted"), facts };
  }
  if (result.code === "deadline") {
    facts.status = "expired";
    facts.provisionalStatus = "expired";
    return { gate: new ObservationGate("deadline-expired"), facts };
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
  return { gate: null, facts };
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
  options: NativeHarnessReconciliationFileOptions,
  mode: "files" | "content",
): Promise<FixedModeFacts> {
  const owned = readExpectation(expectation);
  const resolvedOptions = readOptions(options);
  const plan = buildPlan(owned);
  const budgetMs = mode === "content"
    ? NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS
    : NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS;
  const startedAt = readClock(resolvedOptions.clock);
  const deadlineAt = startedAt > Number.MAX_SAFE_INTEGER - budgetMs
    ? Number.MAX_SAFE_INTEGER
    : startedAt + budgetMs;
  const live: Live = {
    clock: resolvedOptions.clock,
    signal: resolvedOptions.signal,
    deadlineAt,
    lastTime: startedAt,
  };
  const reasons: NativeHarnessReconciliationFilesReason[] = [];
  const captures: NativeHarnessReconciliationFileCapture[] = [];
  const firstPass = new Map<NativeHarnessReconciliationFileKey, FirstPassFacts>();
  let gate: ObservationGate | null = null;
  let unavailableFailure = false;
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
    if (!stoppedFirst) {
      if (mode === "content") {
        const outcome = await observeContentBetweenPasses(
          live,
          resolvedOptions,
          owned,
          firstPass,
        );
        Object.assign(content, outcome.facts);
        if (outcome.gate !== null) {
          gate = outcome.gate;
          addGateReason(reasons, outcome.gate);
        }
      }
      if (gate === null) await runPass(2);
    }

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
    if (mode !== "content") return;
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

  let status = evaluateStatus();
  if (status !== "stable") {
    metadata = null;
    metadataStatus = "not-observed";
  }
  finalizeContent(status);

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
    facts.status = sealedStatus;
    facts.checkedAt = live.lastTime;
    facts.reasons = [...reasons];
    facts.captures = [...captures];
    facts.metadata = metadata;
    facts.metadataStatus = metadataStatus;
    facts.content = content;
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
