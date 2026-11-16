import path from "node:path";
import {
  NATIVE_HARNESS_ACCOUNTING_MAX_BYTES,
  NativeHarnessAccountingError,
  decodeNativeHarnessAccountingText,
  projectNativeHarnessAccounting,
  type NativeHarnessAccountingAdmission,
  type NativeHarnessAccountingCheckpoint,
  type NativeHarnessAccountingProjection,
} from "./native-harness-accounting.ts";
import {
  NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES,
  NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_DISPATCHES,
  NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2,
  NativeHarnessDispatchInventoryError,
  decodeNativeHarnessDispatchInventoryText,
  type NativeHarnessDispatchInventory,
  type NativeHarnessDispatchInventoryFixed,
  type NativeHarnessDispatchInventoryV2,
  type NativeHarnessDispatchRow,
} from "./native-harness-dispatch-inventory.ts";
import {
  NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES,
  NativeHarnessRecoverySourceError,
  decodeNativeHarnessRecoverySourceText,
  type NativeHarnessRecoverySourceDocument,
} from "./native-harness-recovery-source.ts";
import { deepFreeze } from "./native-work.ts";
import { decodeRunHistoryText, StoreCorruptionError } from "../vendor/harness2/upstream/src/store.ts";
import {
  STAGE_IDS,
  type RunRecoverySeed,
  type RunRecord,
  type RunStatus,
  type StageId,
  type StageRecord,
} from "../vendor/harness2/upstream/src/types.ts";

/**
 * Pure, bounded B2a metadata reconciliation for one already-read original run,
 * recovery-source, dispatch-inventory and accounting-owner text group.
 *
 * It performs no filesystem, process, signal, write, controller, network,
 * model or registry effect. The four texts are caller-supplied observations,
 * not proof they came from actual original files. A compatible result is only
 * metadata consistency: it is not a completion handle, lease, recovery or
 * resume permission. Actual pinned-file double reads, complete historical
 * attempt/group observation and artifact/trace provenance remain later B2
 * work.
 */

export const NATIVE_HARNESS_RECONCILIATION_SCHEMA =
  "omp-agent.native-harness-reconciliation.v1" as const;

const RUN_TEXT_MAX_BYTES = 256 * 1024;
const MAX_PATH_CHARS = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

export type NativeHarnessReconciliationReason =
  | "run-invalid"
  | "run-too-large"
  | "run-origin-missing"
  | "run-origin-mismatch"
  | "run-created-at-invalid"
  | "run-created-at-outside-admission"
  | "run-owner-mismatch"
  | "run-workspace-mismatch"
  | "run-allocation-mismatch"
  | "run-duration-incompatible"
  | "run-profile-mismatch"
  | "source-invalid"
  | "source-too-large"
  | "source-identity-mismatch"
  | "source-unsafe-path"
  | "source-owner-mismatch"
  | "source-admission-mismatch"
  | "source-reserve-revision-mismatch"
  | "source-association-mismatch"
  | "source-descriptor-sha-mismatch"
  | "source-manifest-sha-mismatch"
  | "source-admitted-at-mismatch"
  | "source-deadline-mismatch"
  | "source-allocation-mismatch"
  | "source-prepared-root-mismatch"
  | "accounting-invalid"
  | "accounting-too-large"
  | "accounting-identity-mismatch"
  | "accounting-admission-mismatch"
  | "accounting-prepared-mismatch"
  | "accounting-run-mismatch"
  | "inventory-invalid"
  | "inventory-too-large"
  | "inventory-identity-mismatch"
  | "inventory-v1-diagnostic-only"
  | "inventory-origin-mismatch"
  | "inventory-fixed-mismatch"
  | "inventory-inner-deadline-mismatch"
  | "inventory-run-association-mismatch"
  | "coverage-unavailable"
  | "coverage-row-association-mismatch"
  | "attempt-missing"
  | "attempt-extra"
  | "attempt-gap"
  | "attempt-duplicate"
  | "stage-record-missing"
  | "latest-stage-mismatch"
  | "latest-path-mismatch"
  | "latest-layout-mismatch"
  | "latest-artifact-path-mismatch"
  | "stage-reservation-mismatch";

export interface NativeHarnessReconciliationExpectation {
  readonly runId: string;
  readonly ownerId: string;
  readonly selectorSha256: string;
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly preparedRelativeRoot: string;
  /** Trusted current build label; build-label compatibility only. */
  readonly backendBuildSourceId: string;
}

export interface NativeHarnessReconciliationInput {
  readonly runText: string;
  readonly sourceText: string;
  readonly inventoryText: string;
  readonly ownerText: string;
  readonly expected: NativeHarnessReconciliationExpectation;
  /** Finite integer observation time; never written back as a new deadline. */
  readonly now: number;
}

export interface NativeHarnessReconciliationMetadata {
  readonly compatible: boolean;
  readonly reasons: readonly NativeHarnessReconciliationReason[];
}

export interface NativeHarnessReconciliationRunSummary {
  readonly id: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly status: RunStatus;
  readonly maxCostUsd: number;
  readonly maxDurationMs: number;
  readonly stageTimeoutMs: number;
  readonly stageCount: number;
  readonly origin: {
    readonly nonce: string;
    readonly createdAt: string;
    readonly seed: RunRecoverySeed;
  } | null;
}

export interface NativeHarnessReconciliationSourceSummary {
  readonly sha256: string;
  readonly bytes: number;
  readonly ownerId: string;
  readonly admissionId: string;
  readonly reserveRevision: number;
  readonly sourceAssociationSha256: string;
  readonly inputManifestSha256: string;
  readonly admittedAt: number;
  readonly deadlineAt: number;
  readonly allocatedCostUsd: number;
  readonly maxDurationMs: number;
  readonly preparedRelativeRoot: string;
  readonly storeRelativeRoot: string;
  readonly sourceRoot: string;
  readonly inputCount: number;
  readonly backendProfile: NativeHarnessRecoverySourceDocument["backendProfile"];
  readonly backendBuild: NativeHarnessRecoverySourceDocument["backendBuild"];
}

export interface NativeHarnessReconciliationInventorySummary {
  readonly schema: "v1" | "v2";
  readonly revision: number;
  readonly rowCount: number;
  readonly maxRunRevision: number;
  readonly latestOrdinal: number | null;
  readonly latestStage: StageId | null;
  readonly latestAttempt: number | null;
  readonly latestState: string | null;
  readonly originNonce: string;
  readonly originCreatedAt: string;
  readonly fixed: NativeHarnessDispatchInventoryFixed;
}

export interface NativeHarnessReconciliationAdmissionSummary {
  readonly admissionId: string;
  readonly reserveRevision: number;
  readonly sourceAssociationSha256: string;
  readonly admittedAt: number;
  readonly deadlineAt: number;
  readonly allocatedUsd: number;
  readonly prepared: NativeHarnessAccountingAdmission["prepared"];
  readonly runId: string | null;
  readonly settlement: NativeHarnessAccountingAdmission["settlement"];
}

export interface NativeHarnessReconciliationOwnerSummary {
  readonly ownerId: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly admissionCount: number;
  readonly projection: NativeHarnessAccountingProjection;
  readonly admission: NativeHarnessReconciliationAdmissionSummary | null;
}

export interface NativeHarnessReconciliationStageCoverage {
  readonly stage: StageId;
  readonly actualAttempt: number | null;
  readonly actualStatus: StageRecord["status"] | null;
  readonly inventoryAttempts: readonly number[];
  readonly latestAttempt: number | null;
  readonly cwdMatches: boolean | null;
  readonly layoutMatches: boolean | null;
  readonly artifactPathMatches: boolean | null;
  readonly complete: boolean;
}

export interface NativeHarnessReconciliationLatest {
  readonly ordinal: number;
  readonly stage: StageId;
  readonly attempt: number;
  readonly state: string;
  readonly actualAttempt: number | null;
  readonly actualStatus: StageRecord["status"] | null;
  readonly cwdMatches: boolean;
  readonly layoutMatches: boolean;
  readonly artifactPathMatches: boolean;
  readonly resultObserved: boolean | null;
  readonly resultStatus: string | null;
  readonly terminalOutcome: string | null;
}

export interface NativeHarnessReconciliationCoverage {
  readonly status: "complete" | "unknown";
  readonly reasons: readonly NativeHarnessReconciliationReason[];
  readonly rows: number;
  readonly stages: readonly NativeHarnessReconciliationStageCoverage[];
  readonly latest: NativeHarnessReconciliationLatest | null;
}

export interface NativeHarnessReconciliationReservationCheck {
  readonly stage: StageId;
  readonly attempt: number;
  readonly actualReservedCostUsd: number | null;
  readonly inventoryAllocatedCostUsd: number | null;
  readonly matches: boolean | null;
}

export interface NativeHarnessReconciliationReservation {
  readonly status: "checked" | "mismatch" | "not-applicable" | "unknown";
  readonly stage: StageId | null;
  readonly attempt: number | null;
  readonly actualReservedCostUsd: number | null;
  readonly inventoryAllocatedCostUsd: number | null;
  readonly matches: boolean | null;
  readonly checks: readonly NativeHarnessReconciliationReservationCheck[];
}

export interface NativeHarnessReconciliationDeadline {
  readonly innerDeadlineAt: number | null;
  readonly outerDeadlineAt: number | null;
  readonly gateDeadlineAt: number | null;
  readonly observedAt: number;
  readonly expired: boolean | null;
}

export interface NativeHarnessReconciliationBuild {
  readonly sourceId: string | null;
  readonly expectedSourceId: string;
  readonly sourceIntegrity: "build-label-only";
  readonly labelCompatible: boolean | null;
}

export interface NativeHarnessReconciliationResult {
  readonly schema: typeof NATIVE_HARNESS_RECONCILIATION_SCHEMA;
  readonly readOnly: true;
  readonly resumeAvailable: false;
  readonly processes: "not-inspected";
  readonly artifacts: "not-inspected";
  readonly metadata: NativeHarnessReconciliationMetadata;
  readonly run: NativeHarnessReconciliationRunSummary | null;
  readonly source: NativeHarnessReconciliationSourceSummary | null;
  readonly inventory: NativeHarnessReconciliationInventorySummary | null;
  readonly owner: NativeHarnessReconciliationOwnerSummary | null;
  readonly coverage: NativeHarnessReconciliationCoverage;
  readonly reservation: NativeHarnessReconciliationReservation;
  readonly deadline: NativeHarnessReconciliationDeadline;
  readonly build: NativeHarnessReconciliationBuild;
}

export class NativeHarnessReconciliationInputError extends Error {
  override name = "NativeHarnessReconciliationInputError";
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

interface OwnedInput {
  readonly runText: string;
  readonly sourceText: string;
  readonly inventoryText: string;
  readonly ownerText: string;
  readonly expected: OwnedExpectation;
  readonly now: number;
}

function inputFail(message: string): never {
  throw new NativeHarnessReconciliationInputError(message);
}

function readOwnFields(
  value: unknown,
  allowed: readonly string[],
  label: string,
): ReadonlyMap<string, unknown> {
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      inputFail(`${label} must be an exact plain object.`);
    }
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    if (error instanceof NativeHarnessReconciliationInputError) throw error;
    inputFail(`${label} could not be inspected.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    inputFail(`${label} must be an exact plain object.`);
  }
  if (keys.length !== allowed.length || keys.some((key) => typeof key !== "string")) {
    inputFail(`${label} must contain exactly its fixed fields.`);
  }
  const fields = new Map<string, unknown>();
  for (const key of allowed) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      inputFail(`${label}.${key} could not be inspected.`);
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      inputFail(`${label}.${key} must be an enumerable own data field.`);
    }
    fields.set(key, descriptor.value);
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

function readAbsolutePath(value: unknown, label: string): string {
  const text = readBoundedString(value, label, MAX_PATH_CHARS);
  if (!path.isAbsolute(text)) inputFail(`${label} must be an absolute path.`);
  return text;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readRelativePath(value: unknown, label: string): string {
  const text = readBoundedString(value, label, MAX_PATH_CHARS);
  if (
    path.isAbsolute(text)
    || text === "."
    || text.split("/").some((part) => part === "" || part === "." || part === "..")
    || text.includes("\\")
  ) {
    inputFail(`${label} must be a confined relative path.`);
  }
  return text;
}

function readInput(value: unknown): OwnedInput {
  const fields = readOwnFields(
    value,
    ["runText", "sourceText", "inventoryText", "ownerText", "expected", "now"],
    "reconciliation input",
  );
  const expectedFields = readOwnFields(
    fields.get("expected"),
    [
      "runId",
      "ownerId",
      "selectorSha256",
      "storageRoot",
      "sourceRoot",
      "preparedRelativeRoot",
      "backendBuildSourceId",
    ],
    "reconciliation expectation",
  );
  const runId = readBoundedString(expectedFields.get("runId"), "expected.runId", 128);
  if (!RUN_ID_PATTERN.test(runId)) inputFail("expected.runId is not a bounded run ID.");
  const ownerId = readBoundedString(expectedFields.get("ownerId"), "expected.ownerId", 36);
  if (!UUID_PATTERN.test(ownerId)) inputFail("expected.ownerId must be a canonical lowercase UUID.");
  const selectorSha256 = readBoundedString(
    expectedFields.get("selectorSha256"),
    "expected.selectorSha256",
    64,
  );
  if (!SHA256_PATTERN.test(selectorSha256)) {
    inputFail("expected.selectorSha256 must be 64 lowercase hexadecimal characters.");
  }
  const storageRoot = readAbsolutePath(expectedFields.get("storageRoot"), "expected.storageRoot");
  const sourceRoot = readAbsolutePath(expectedFields.get("sourceRoot"), "expected.sourceRoot");
  if (isContained(storageRoot, sourceRoot) || isContained(sourceRoot, storageRoot)) {
    inputFail("expected.storageRoot and expected.sourceRoot must be disjoint.");
  }
  const preparedRelativeRoot = readRelativePath(
    expectedFields.get("preparedRelativeRoot"),
    "expected.preparedRelativeRoot",
  );
  if (!path.basename(preparedRelativeRoot).startsWith("omp-harness-")) {
    inputFail("expected.preparedRelativeRoot must use the omp-harness- owned prefix.");
  }
  const backendBuildSourceId = readBoundedString(
    expectedFields.get("backendBuildSourceId"),
    "expected.backendBuildSourceId",
    64,
  );
  if (!SHA256_PATTERN.test(backendBuildSourceId)) {
    inputFail("expected.backendBuildSourceId must be 64 lowercase hexadecimal characters.");
  }
  const now = fields.get("now");
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
    inputFail("now must be a nonnegative safe integer.");
  }
  const readText = (key: string, label: string): string => {
    const text = fields.get(key);
    if (typeof text !== "string") inputFail(`${label} must be UTF-8 text.`);
    return text;
  };
  return {
    runText: readText("runText", "runText"),
    sourceText: readText("sourceText", "sourceText"),
    inventoryText: readText("inventoryText", "inventoryText"),
    ownerText: readText("ownerText", "ownerText"),
    expected: {
      runId,
      ownerId,
      selectorSha256,
      storageRoot,
      sourceRoot,
      preparedRelativeRoot,
      backendBuildSourceId,
    },
    now,
  };
}

function addReason(
  list: NativeHarnessReconciliationReason[],
  reason: NativeHarnessReconciliationReason,
): void {
  if (!list.includes(reason)) list.push(reason);
}

function exceedsUtf8Cap(text: string, cap: number): boolean {
  // A string's UTF-16 length is never greater than its UTF-8 wire length.
  // Refuse an obviously huge caller string without scanning it first.
  return text.length > cap || Buffer.byteLength(text, "utf8") > cap;
}

function classifyRunDecodeError(error: unknown): NativeHarnessReconciliationReason {
  if (error instanceof RangeError) return "run-too-large";
  if (error instanceof StoreCorruptionError) return "run-invalid";
  return "run-invalid";
}

function classifySourceDecodeError(error: unknown): NativeHarnessReconciliationReason {
  if (error instanceof NativeHarnessRecoverySourceError) {
    if (error.code === "too-large") return "source-too-large";
    if (error.code === "identity-changed") return "source-identity-mismatch";
    if (error.code === "unsafe-path") return "source-unsafe-path";
  }
  return "source-invalid";
}

function classifyAccountingDecodeError(error: unknown): NativeHarnessReconciliationReason {
  if (error instanceof NativeHarnessAccountingError) {
    if (error.code === "too-large") return "accounting-too-large";
    if (error.code === "identity-mismatch") return "accounting-identity-mismatch";
  }
  return "accounting-invalid";
}

function classifyInventoryDecodeError(error: unknown): NativeHarnessReconciliationReason {
  if (error instanceof NativeHarnessDispatchInventoryError) {
    if (error.code === "too-large") return "inventory-too-large";
    if (error.code === "identity-mismatch") return "inventory-identity-mismatch";
  }
  return "inventory-invalid";
}

function summarizeRun(run: RunRecord): NativeHarnessReconciliationRunSummary {
  const origin = run.recoveryOrigin;
  return {
    id: run.id,
    revision: run.revision,
    createdAt: run.createdAt,
    status: run.status,
    maxCostUsd: run.config.maxCostUsd,
    maxDurationMs: run.config.maxDurationMs,
    stageTimeoutMs: run.config.stageTimeoutMs,
    stageCount: Object.keys(run.stages).length,
    origin: origin === undefined
      ? null
      : {
        nonce: origin.nonce,
        createdAt: origin.createdAt,
        seed: origin.seed,
      },
  };
}

function summarizeSource(
  source: NativeHarnessRecoverySourceDocument,
): NativeHarnessReconciliationSourceSummary {
  return {
    sha256: source.sha256,
    bytes: source.bytes,
    ownerId: source.accounting.ownerId,
    admissionId: source.accounting.admissionId,
    reserveRevision: source.accounting.reserveRevision,
    sourceAssociationSha256: source.accounting.sourceAssociationSha256,
    inputManifestSha256: source.inputManifestSha256,
    admittedAt: source.accounting.admittedAt,
    deadlineAt: source.budget.deadlineAt,
    allocatedCostUsd: source.budget.maxCostUsd,
    maxDurationMs: source.budget.maxDurationMs,
    preparedRelativeRoot: source.workspace.preparedRelativeRoot,
    storeRelativeRoot: source.workspace.storeRelativeRoot,
    sourceRoot: source.workspace.sourceRoot,
    inputCount: source.inputs.length,
    backendProfile: source.backendProfile,
    backendBuild: source.backendBuild,
  };
}

function summarizeInventory(
  inventory: NativeHarnessDispatchInventory,
): NativeHarnessReconciliationInventorySummary {
  const latest = inventory.dispatches.at(-1);
  return {
    schema: inventory.schema === NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2 ? "v2" : "v1",
    revision: inventory.revision,
    rowCount: inventory.dispatches.length,
    maxRunRevision: inventory.dispatches.reduce(
      (maximum, row) => Math.max(maximum, row.runRevision),
      0,
    ),
    latestOrdinal: latest?.ordinal ?? null,
    latestStage: latest?.stage ?? null,
    latestAttempt: latest?.attempt ?? null,
    latestState: latest?.state ?? null,
    originNonce: inventory.origin.nonce,
    originCreatedAt: inventory.origin.createdAt,
    fixed: inventory.fixed,
  };
}

function summarizeAdmission(
  admission: NativeHarnessAccountingAdmission,
): NativeHarnessReconciliationAdmissionSummary {
  return {
    admissionId: admission.admissionId,
    reserveRevision: admission.reserveRevision,
    sourceAssociationSha256: admission.sourceAssociationSha256,
    admittedAt: admission.admittedAt,
    deadlineAt: admission.deadlineAt,
    allocatedUsd: admission.allocatedUsd,
    prepared: admission.prepared,
    runId: admission.runId,
    settlement: admission.settlement,
  };
}

function stageLayoutMatches(
  storageRoot: string,
  preparedRelativeRoot: string,
  runId: string,
  stage: StageId,
  attempt: number,
  cwd: string,
): boolean {
  if (
    !path.isAbsolute(cwd)
    || path.normalize(cwd) !== cwd
    || cwd === path.parse(cwd).root
  ) {
    return false;
  }
  const relative = path.relative(storageRoot, cwd);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  const attemptDirectory = segments[6];
  if (attemptDirectory === undefined) return false;
  const expectedAttemptPrefix = `attempt-${attempt}-`;
  // <prepared>/store/runs/<runId>/stages/<stage>/attempt-<n>-<uuid>/workspace
  return segments.length === 8
    && segments[0] === preparedRelativeRoot
    && segments[1] === "store"
    && segments[2] === "runs"
    && segments[3] === runId
    && segments[4] === "stages"
    && segments[5] === stage
    && attemptDirectory.startsWith(expectedAttemptPrefix)
    && UUID_PATTERN.test(attemptDirectory.slice(expectedAttemptPrefix.length))
    && segments[7] === "workspace";
}

function sameSeed(left: RunRecoverySeed, right: RunRecoverySeed): boolean {
  return left.schema === right.schema
    && left.profile === right.profile
    && left.accountingOwnerId === right.accountingOwnerId
    && left.admissionId === right.admissionId
    && left.accountingOwnerRevision === right.accountingOwnerRevision
    && left.sourceAssociationSha256 === right.sourceAssociationSha256
    && left.sourceDescriptorSha256 === right.sourceDescriptorSha256
    && left.inputManifestSha256 === right.inputManifestSha256
    && left.admittedAt === right.admittedAt
    && left.deadlineAt === right.deadlineAt
    && left.allocatedCostUsd === right.allocatedCostUsd;
}

function sameOrigin(
  left: NonNullable<RunRecord["recoveryOrigin"]>,
  right: NonNullable<RunRecord["recoveryOrigin"]>,
): boolean {
  return left.schema === right.schema
    && left.nonce === right.nonce
    && left.runId === right.runId
    && left.createdAt === right.createdAt
    && left.recordIdentitySha256 === right.recordIdentitySha256
    && sameSeed(left.seed, right.seed);
}

function sameAdaptation(
  left: RunRecord["config"]["adaptation"],
  right: NativeHarnessRecoverySourceDocument["backendProfile"]["adaptation"],
): boolean {
  return left !== undefined
    && left.capabilities === right.capabilities
    && left.reuse === right.reuse
    && left.learnMethods === right.learnMethods;
}

function stageRecordOf(run: RunRecord, stage: StageId): StageRecord | undefined {
  return run.stages[stage];
}

/**
 * Pure bounded metadata reconciliation. It decodes each supplied text with the
 * existing original decoder, then compares only persisted association facts.
 * Missing, oversized, malformed or unsupported data is reported through
 * bounded reason codes; the function never parses attempts out of paths,
 * invents historical StageRecords, settles or refunds accounting, rewrites a
 * deadline or treats a missing usage value as zero.
 */
export function reconcileNativeHarnessMetadata(
  input: NativeHarnessReconciliationInput,
): NativeHarnessReconciliationResult {
  const owned = readInput(input);
  const metadataReasons: NativeHarnessReconciliationReason[] = [];
  const coverageReasons: NativeHarnessReconciliationReason[] = [];

  let run: RunRecord | null = null;
  let source: NativeHarnessRecoverySourceDocument | null = null;
  let inventory: NativeHarnessDispatchInventory | null = null;
  let owner: NativeHarnessAccountingCheckpoint | null = null;
  let projection: NativeHarnessAccountingProjection | null = null;

  if (exceedsUtf8Cap(owned.runText, RUN_TEXT_MAX_BYTES)) {
    addReason(metadataReasons, "run-too-large");
  } else {
    try {
      run = decodeRunHistoryText(owned.runText, owned.expected.runId);
    } catch (error) {
      addReason(metadataReasons, classifyRunDecodeError(error));
    }
  }

  if (exceedsUtf8Cap(owned.sourceText, NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES)) {
    addReason(metadataReasons, "source-too-large");
  } else {
    try {
      source = decodeNativeHarnessRecoverySourceText(owned.sourceText, {
        storageRoot: owned.expected.storageRoot,
        sourceRoot: owned.expected.sourceRoot,
        preparedRelativeRoot: owned.expected.preparedRelativeRoot,
      });
    } catch (error) {
      addReason(metadataReasons, classifySourceDecodeError(error));
    }
  }

  if (exceedsUtf8Cap(owned.ownerText, NATIVE_HARNESS_ACCOUNTING_MAX_BYTES)) {
    addReason(metadataReasons, "accounting-too-large");
  } else {
    try {
      owner = decodeNativeHarnessAccountingText(owned.ownerText, {
        ownerId: owned.expected.ownerId,
        selectorSha256: owned.expected.selectorSha256,
      });
      projection = projectNativeHarnessAccounting(owner);
    } catch (error) {
      addReason(metadataReasons, classifyAccountingDecodeError(error));
      owner = null;
      projection = null;
    }
  }

  if (exceedsUtf8Cap(owned.inventoryText, NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES)) {
    addReason(metadataReasons, "inventory-too-large");
  } else {
    try {
      inventory = decodeNativeHarnessDispatchInventoryText(owned.inventoryText, {
        runId: owned.expected.runId,
      });
    } catch (error) {
      addReason(metadataReasons, classifyInventoryDecodeError(error));
    }
  }

  const inventoryV2 = inventory?.schema === NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2
    ? inventory as NativeHarnessDispatchInventoryV2
    : null;
  if (inventory !== null && inventoryV2 === null) {
    addReason(metadataReasons, "inventory-v1-diagnostic-only");
  }

  const origin = run?.recoveryOrigin ?? null;
  if (run !== null && origin === null) {
    addReason(metadataReasons, "run-origin-missing");
  }
  if (run !== null && origin !== null && origin.createdAt !== run.createdAt) {
    addReason(metadataReasons, "run-origin-mismatch");
  }
  if (run !== null && origin !== null && origin.runId !== run.id) {
    addReason(metadataReasons, "run-origin-mismatch");
  }
  const runCreatedAtMs = run === null ? null : Date.parse(run.createdAt);
  if (run !== null && (runCreatedAtMs === null || !Number.isSafeInteger(runCreatedAtMs))) {
    addReason(metadataReasons, "run-created-at-invalid");
  }

  if (run !== null && source !== null) {
    if (run.config.maxCostUsd !== source.budget.maxCostUsd) {
      addReason(metadataReasons, "run-allocation-mismatch");
    }
    if (
      run.config.maxDurationMs < 1
      || run.config.maxDurationMs > source.budget.maxDurationMs
      || run.config.stageTimeoutMs > source.budget.maxDurationMs
    ) {
      addReason(metadataReasons, "run-duration-incompatible");
    }
    if (
      run.config.model !== source.backendProfile.model
      || run.config.improverModel !== source.backendProfile.improverModel
      || run.config.ompCommand !== source.backendProfile.ompCommand
      || run.config.mode !== source.backendProfile.mode
      || run.config.strategy !== source.backendProfile.strategy
      || run.config.domain !== source.backendProfile.domain
      || !sameAdaptation(run.config.adaptation, source.backendProfile.adaptation)
    ) {
      addReason(metadataReasons, "run-profile-mismatch");
    }
    if (
      run.workspace
      !== path.join(owned.expected.storageRoot, source.workspace.workspaceRelativeRoot)
    ) {
      addReason(metadataReasons, "run-workspace-mismatch");
    }
  }

  if (source !== null) {
    if (source.accounting.ownerId !== owned.expected.ownerId) {
      addReason(metadataReasons, "source-owner-mismatch");
    }
    if (source.workspace.preparedRelativeRoot !== owned.expected.preparedRelativeRoot) {
      addReason(metadataReasons, "source-prepared-root-mismatch");
    }
  }

  if (run !== null && origin !== null) {
    if (origin.seed.accountingOwnerId !== owned.expected.ownerId) {
      addReason(metadataReasons, "run-owner-mismatch");
    }
    if (source !== null) {
      if (origin.seed.accountingOwnerId !== source.accounting.ownerId) {
        addReason(metadataReasons, "source-owner-mismatch");
      }
      if (origin.seed.admissionId !== source.accounting.admissionId) {
        addReason(metadataReasons, "source-admission-mismatch");
      }
      if (origin.seed.accountingOwnerRevision !== source.accounting.reserveRevision) {
        addReason(metadataReasons, "source-reserve-revision-mismatch");
      }
      if (origin.seed.sourceAssociationSha256 !== source.accounting.sourceAssociationSha256) {
        addReason(metadataReasons, "source-association-mismatch");
      }
      if (origin.seed.sourceDescriptorSha256 !== source.sha256) {
        addReason(metadataReasons, "source-descriptor-sha-mismatch");
      }
      if (origin.seed.inputManifestSha256 !== source.inputManifestSha256) {
        addReason(metadataReasons, "source-manifest-sha-mismatch");
      }
      if (origin.seed.admittedAt !== source.accounting.admittedAt) {
        addReason(metadataReasons, "source-admitted-at-mismatch");
      }
      if (origin.seed.deadlineAt !== source.budget.deadlineAt) {
        addReason(metadataReasons, "source-deadline-mismatch");
      }
      if (
        origin.seed.allocatedCostUsd !== source.budget.maxCostUsd
        || origin.seed.allocatedCostUsd !== run.config.maxCostUsd
      ) {
        addReason(metadataReasons, "run-allocation-mismatch");
      }
      if (
        runCreatedAtMs !== null
        && (runCreatedAtMs < origin.seed.admittedAt || runCreatedAtMs >= origin.seed.deadlineAt)
      ) {
        addReason(metadataReasons, "run-created-at-outside-admission");
      }
    }
  }

  let matchedAdmission: NativeHarnessAccountingAdmission | null = null;
  if (owner !== null && source !== null && run !== null) {
    const matches = owner.admissions.filter(
      (admission) => admission.admissionId === source.accounting.admissionId,
    );
    if (matches.length !== 1) {
      addReason(metadataReasons, "accounting-admission-mismatch");
    } else {
      const admission = matches[0]!;
      matchedAdmission = admission;
      if (
        admission.reserveRevision !== source.accounting.reserveRevision
        || admission.sourceAssociationSha256 !== source.accounting.sourceAssociationSha256
        || admission.admittedAt !== source.accounting.admittedAt
        || admission.deadlineAt !== source.budget.deadlineAt
        || admission.allocatedUsd !== source.budget.maxCostUsd
      ) {
        addReason(metadataReasons, "accounting-admission-mismatch");
      }
      if (
        admission.prepared === null
        || admission.prepared.preparedRelativeRoot !== source.workspace.preparedRelativeRoot
        || admission.prepared.storeRelativeRoot !== source.workspace.storeRelativeRoot
        || admission.prepared.inputManifestSha256 !== source.inputManifestSha256
        || admission.prepared.sourceDescriptorSha256 !== source.sha256
      ) {
        addReason(metadataReasons, "accounting-prepared-mismatch");
      }
      if (admission.runId !== run.id) {
        addReason(metadataReasons, "accounting-run-mismatch");
      }
    }
    const runMatches = owner.admissions.filter((admission) => admission.runId === run.id);
    if (runMatches.length !== 1
      || matchedAdmission === null
      || runMatches[0]!.admissionId !== matchedAdmission.admissionId) {
      addReason(metadataReasons, "accounting-run-mismatch");
    }
  } else if (owner !== null && source !== null) {
    const matches = owner.admissions.filter(
      (admission) => admission.admissionId === source.accounting.admissionId,
    );
    matchedAdmission = matches.length === 1 ? matches[0]! : null;
  }

  if (run !== null && origin !== null && inventoryV2 !== null) {
    if (!sameOrigin(origin, inventoryV2.origin)) {
      addReason(metadataReasons, "inventory-origin-mismatch");
    }
    if (
      inventoryV2.fixed.stageTimeoutMs !== run.config.stageTimeoutMs
      || inventoryV2.fixed.maxDurationMs !== run.config.maxDurationMs
      || inventoryV2.fixed.maxCostUsd !== run.config.maxCostUsd
    ) {
      addReason(metadataReasons, "inventory-fixed-mismatch");
    }
  }

  let innerDeadlineAt: number | null = null;
  let outerDeadlineAt: number | null = null;
  let gateDeadlineAt: number | null = null;
  let expired: boolean | null = null;
  if (run !== null && origin !== null && runCreatedAtMs !== null) {
    const candidateInner = runCreatedAtMs + run.config.maxDurationMs;
    if (Number.isSafeInteger(candidateInner) && candidateInner >= 1) {
      innerDeadlineAt = candidateInner;
    }
    outerDeadlineAt = origin.seed.deadlineAt;
    if (innerDeadlineAt !== null) {
      gateDeadlineAt = Math.min(innerDeadlineAt, outerDeadlineAt);
      expired = owned.now >= gateDeadlineAt;
    }
  }

  const rowAssociationProblems = new Set<StageId>();
  if (
    run !== null
    && origin !== null
    && inventoryV2 !== null
    && innerDeadlineAt !== null
  ) {
    for (const row of inventoryV2.dispatches) {
      if (row.innerDeadlineAt !== innerDeadlineAt) {
        rowAssociationProblems.add(row.stage);
        addReason(metadataReasons, "inventory-inner-deadline-mismatch");
        addReason(coverageReasons, "coverage-row-association-mismatch");
        break;
      }
    }
    for (const row of inventoryV2.dispatches) {
      if (
        row.outerDeadlineAt !== origin.seed.deadlineAt
        || row.originNonce !== origin.nonce
        || row.sourceAssociationSha256 !== origin.seed.sourceAssociationSha256
      ) {
        rowAssociationProblems.add(row.stage);
        addReason(metadataReasons, "inventory-run-association-mismatch");
        addReason(coverageReasons, "coverage-row-association-mismatch");
        break;
      }
    }
  }

  const stageCoverage: NativeHarnessReconciliationStageCoverage[] = [];
  let latest: NativeHarnessReconciliationLatest | null = null;

  if (run !== null && inventoryV2 !== null) {
    const expectedPreparedRoot = source?.workspace.preparedRelativeRoot
      ?? owned.expected.preparedRelativeRoot;
    const rowsByStage = new Map<StageId, {
      readonly attempts: number[];
      readonly uniqueAttempts: Set<number>;
      readonly rows: NativeHarnessDispatchRow[];
    }>();
    const seen = new Set<string>();
    for (const row of inventoryV2.dispatches) {
      if (seen.has(`${row.stage}:${row.attempt}`)) {
        addReason(coverageReasons, "attempt-duplicate");
      }
      seen.add(`${row.stage}:${row.attempt}`);
      const record = rowsByStage.get(row.stage);
      if (record === undefined) {
        rowsByStage.set(row.stage, {
          attempts: [row.attempt],
          uniqueAttempts: new Set([row.attempt]),
          rows: [row],
        });
      } else {
        record.attempts.push(row.attempt);
        record.uniqueAttempts.add(row.attempt);
        record.rows.push(row);
      }
      const rowLayoutMatches = stageLayoutMatches(
        owned.expected.storageRoot,
        expectedPreparedRoot,
        run.id,
        row.stage,
        row.attempt,
        row.cwd,
      );
      const rowArtifactSibling = row.artifactDir
        === path.join(path.dirname(row.cwd), "artifacts");
      if (row.runRevision > run.revision || !rowLayoutMatches || !rowArtifactSibling) {
        rowAssociationProblems.add(row.stage);
        addReason(coverageReasons, "coverage-row-association-mismatch");
      }
      if (stageRecordOf(run, row.stage) === undefined) {
        addReason(coverageReasons, "stage-record-missing");
      }
    }

    for (const stage of STAGE_IDS) {
      const actual = stageRecordOf(run, stage);
      if (actual === undefined) continue;
      const record = rowsByStage.get(stage);
      const inventoryAttempts = record === undefined
        ? []
        : [...record.uniqueAttempts].sort((left, right) => left - right);
      const latestRow = record?.rows.at(-1) ?? null;
      const latestAttempt = latestRow?.attempt ?? null;
      const cwdMatches = latestRow === null ? null : latestRow.cwd === actual.cwd;
      const layoutMatches = latestRow === null
        ? null
        : stageLayoutMatches(
          owned.expected.storageRoot,
          expectedPreparedRoot,
          run.id,
          stage,
          actual.attempt,
          latestRow.cwd,
        );
      const artifactPathMatches = latestRow === null
        ? null
        : latestRow.artifactDir === path.join(path.dirname(latestRow.cwd), "artifacts");
      let complete = true;
      if (rowAssociationProblems.has(stage)) {
        complete = false;
        addReason(coverageReasons, "coverage-row-association-mismatch");
      }
      if (record === undefined || inventoryAttempts.length === 0) {
        complete = false;
        addReason(coverageReasons, "attempt-missing");
      } else {
        if (record.attempts.length !== record.uniqueAttempts.size) {
          complete = false;
          addReason(coverageReasons, "attempt-duplicate");
        }
        if (inventoryAttempts[0] !== 1) {
          complete = false;
          addReason(coverageReasons, "attempt-gap");
        }
        if (inventoryAttempts[inventoryAttempts.length - 1]! > actual.attempt) {
          complete = false;
          addReason(coverageReasons, "attempt-extra");
        }
        for (let index = 1; index < inventoryAttempts.length; index++) {
          if (inventoryAttempts[index]! !== inventoryAttempts[index - 1]! + 1) {
            complete = false;
            addReason(coverageReasons, "attempt-gap");
          }
        }
        // Never loop to the declared attempt. At most one row per attempt and
        // at most 32 rows exist, so a larger declared attempt is a gap.
        if (
          actual.attempt > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_DISPATCHES
          || inventoryAttempts.length !== actual.attempt
        ) {
          complete = false;
          addReason(coverageReasons, "attempt-gap");
        }
        if (latestAttempt !== actual.attempt) {
          complete = false;
          addReason(coverageReasons, "latest-stage-mismatch");
        }
        if (cwdMatches === false) {
          complete = false;
          addReason(coverageReasons, "latest-path-mismatch");
        }
        if (layoutMatches === false) {
          complete = false;
          addReason(coverageReasons, "latest-layout-mismatch");
        }
        if (artifactPathMatches === false) {
          complete = false;
          addReason(coverageReasons, "latest-artifact-path-mismatch");
        }
      }
      stageCoverage.push({
        stage,
        actualAttempt: actual.attempt,
        actualStatus: actual.status,
        inventoryAttempts,
        latestAttempt,
        cwdMatches,
        layoutMatches,
        artifactPathMatches,
        complete,
      });
    }

    const lastRow = inventoryV2.dispatches.at(-1);
    if (lastRow !== undefined) {
      const actual = stageRecordOf(run, lastRow.stage);
      const cwdMatches = actual !== undefined && actual.cwd === lastRow.cwd;
      const layoutMatches = actual !== undefined && stageLayoutMatches(
        owned.expected.storageRoot,
        expectedPreparedRoot,
        run.id,
        lastRow.stage,
        actual.attempt,
        lastRow.cwd,
      );
      const artifactPathMatches = lastRow.artifactDir
        === path.join(path.dirname(path.resolve(lastRow.cwd)), "artifacts");
      if (actual === undefined) {
        addReason(coverageReasons, "latest-stage-mismatch");
      }
      latest = {
        ordinal: lastRow.ordinal,
        stage: lastRow.stage,
        attempt: lastRow.attempt,
        state: lastRow.state,
        actualAttempt: actual?.attempt ?? null,
        actualStatus: actual?.status ?? null,
        cwdMatches,
        layoutMatches,
        artifactPathMatches,
        resultObserved: actual === undefined ? null : actual.result !== undefined,
        resultStatus: actual?.result?.status ?? null,
        terminalOutcome: lastRow.terminal?.outcome ?? null,
      };
    }
  } else {
    addReason(coverageReasons, "coverage-unavailable");
  }

  let reservation: NativeHarnessReconciliationReservation = {
    status: "not-applicable",
    stage: null,
    attempt: null,
    actualReservedCostUsd: null,
    inventoryAllocatedCostUsd: null,
    matches: null,
    checks: [],
  };
  if (run !== null && inventoryV2 !== null) {
    const running = STAGE_IDS
      .map((stage) => stageRecordOf(run, stage))
      .filter((stage): stage is StageRecord => stage !== undefined)
      .filter((stage) => stage.status === "running" && stage.result === undefined);
    const checks: NativeHarnessReconciliationReservationCheck[] = [];
    for (const stage of running) {
      const rows = inventoryV2.dispatches
        .filter((row) => row.stage === stage.id && row.attempt === stage.attempt);
      const row = rows.at(-1);
      const actualReserved = typeof stage.reservedCostUsd === "number"
        && Number.isFinite(stage.reservedCostUsd)
        ? stage.reservedCostUsd
        : null;
      const inventoryAllocated = row?.stageAllocatedCostUsd ?? null;
      const matches = actualReserved === null || row === undefined
        ? null
        : actualReserved === row.stageAllocatedCostUsd;
      if (matches === false) addReason(coverageReasons, "stage-reservation-mismatch");
      checks.push({
        stage: stage.id,
        attempt: stage.attempt,
        actualReservedCostUsd: actualReserved,
        inventoryAllocatedCostUsd: inventoryAllocated,
        matches,
      });
    }
    const anyMismatch = checks.some((check) => check.matches === false);
    const anyUnknown = checks.some((check) => check.matches === null);
    const status = checks.length === 0
      ? "not-applicable"
      : anyMismatch
        ? "mismatch"
        : anyUnknown
          ? "unknown"
          : "checked";
    const single = checks.length === 1 ? checks[0]! : null;
    reservation = {
      status,
      stage: single?.stage ?? null,
      attempt: single?.attempt ?? null,
      actualReservedCostUsd: single?.actualReservedCostUsd ?? null,
      inventoryAllocatedCostUsd: single?.inventoryAllocatedCostUsd ?? null,
      matches: checks.length === 0 ? null : anyMismatch ? false : anyUnknown ? null : true,
      checks,
    };
  }

  const coverage: NativeHarnessReconciliationCoverage = {
    status: run !== null && inventoryV2 !== null && coverageReasons.length === 0
      ? "complete"
      : "unknown",
    reasons: coverageReasons,
    rows: inventoryV2?.dispatches.length ?? 0,
    stages: stageCoverage,
    latest,
  };

  const ownerSummary = owner === null || projection === null
    ? null
    : {
      ownerId: owner.ownerId,
      revision: owner.revision,
      createdAt: owner.createdAt,
      admissionCount: owner.admissions.length,
      projection,
      admission: matchedAdmission === null ? null : summarizeAdmission(matchedAdmission),
    };

  const buildCompatible = source === null
    ? null
    : source.backendBuild.sourceId === owned.expected.backendBuildSourceId;

  return deepFreeze({
    schema: NATIVE_HARNESS_RECONCILIATION_SCHEMA,
    readOnly: true,
    resumeAvailable: false,
    processes: "not-inspected",
    artifacts: "not-inspected",
    metadata: {
      compatible: metadataReasons.length === 0,
      reasons: metadataReasons,
    },
    run: run === null ? null : summarizeRun(run),
    source: source === null ? null : summarizeSource(source),
    inventory: inventory === null ? null : summarizeInventory(inventory),
    owner: ownerSummary,
    coverage,
    reservation,
    deadline: {
      innerDeadlineAt,
      outerDeadlineAt,
      gateDeadlineAt,
      observedAt: owned.now,
      expired,
    },
    build: {
      sourceId: source?.backendBuild.sourceId ?? null,
      expectedSourceId: owned.expected.backendBuildSourceId,
      sourceIntegrity: "build-label-only",
      labelCompatible: buildCompatible,
    },
  });
}
