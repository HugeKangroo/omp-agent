import path from "node:path";
import { CANDIDATE_IDS, STAGE_IDS, type RunRecord, type StageId, type StageRecord } from "../vendor/harness2/upstream/src/types.ts";
import { decodeRunHistoryText } from "../vendor/harness2/upstream/src/store.ts";
import { copyWitnessBase } from "./native-harness-completion.ts";
import { canonicalWorkerResultSha256 } from "./native-harness-delegation.ts";
import {
  NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2,
  decodeNativeHarnessDispatchInventoryText,
  type NativeHarnessDispatchInventoryV2,
  type NativeHarnessDispatchRow,
} from "./native-harness-dispatch-inventory.ts";
import {
  reconcileNativeHarnessMetadata,
  type NativeHarnessReconciliationExpectation,
  type NativeHarnessReconciliationReason,
  type NativeHarnessReconciliationResult,
} from "./native-harness-reconciliation.ts";
import {
  NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE,
  decodeNativeHarnessRecoverySourceText,
  type NativeHarnessRecoverySourceDocument,
} from "./native-harness-recovery-source.ts";
import { deepFreeze, sha256Hex, validateRelativePath } from "./native-work.ts";

/**
 * Pure, bounded planning for the latest reusable original Harness2 stage
 * contents.
 *
 * This module performs no filesystem, process, signal, write, controller,
 * network or model effect. It decodes the same four caller-supplied recovery
 * texts as B2a, joins only the latest completed StageRecord contents, and
 * returns bounded roots/identities/digests/manifests for the fixed, read-only
 * byte observer. It never returns task text, a prompt, auth material or raw
 * WorkerResult text.
 *
 * Every reconstructed base association is a declaration derived from the
 * original run/source/manifest facts. A byte observer only yields independent
 * readonly byte facts; this declaration never becomes an issued witness,
 * authority or resume permission.
 */

export const NATIVE_HARNESS_RECONCILIATION_CONTENT_SCHEMA =
  "omp-agent.native-harness-reconciliation-content.v1" as const;
export const NATIVE_HARNESS_RECONCILIATION_CONTENT_PLAN_SCHEMA =
  "omp-agent.native-harness-reconciliation-content-plan.v1" as const;
export const NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS = 30_000 as const;
export const NATIVE_HARNESS_RECONCILIATION_CONTENT_MAX_METADATA_BYTES = 128 * 1024;

const KIB = 1024;
const MIB = 1024 * KIB;
const MAX_SOURCE_FILES = 8;
const MAX_SOURCE_FILE_BYTES = 256 * KIB;
const MAX_SOURCE_TOTAL_BYTES = 256 * KIB;
const MAX_SOLVER_TREE_FILES = 16;
const MAX_SOLVER_TREE_FILE_BYTES = 256 * KIB;
const MAX_SOLVER_TREE_TOTAL_BYTES = 1024 * KIB + 256 * KIB;
const MAX_ORIGIN_MARKER_BYTES = 16 * KIB;
const MAX_STAGES = 15;
const MAX_SOLVERS = 8;
const MAX_TRACE_BYTES_TOTAL = 128 * MIB;

/**
 * Fixed ceiling for actual source/base/solver/trace bytes read by the two
 * content passes. B2b's primary-document charge is reported separately.
 */
export const NATIVE_HARNESS_RECONCILIATION_CONTENT_CHARGE_LIMIT_BYTES =
  2 * (
    MAX_SOURCE_TOTAL_BYTES
    + MAX_SOURCE_TOTAL_BYTES
    + 8 * MAX_SOLVER_TREE_TOTAL_BYTES
    + 8 * MAX_ORIGIN_MARKER_BYTES
  )
  + MAX_TRACE_BYTES_TOTAL;

const MAX_PATH_CHARS = 4096;
const BUFFER_BYTES = 64 * KIB;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SNAPSHOT_DIRECTORY_PATTERN =
  /^snapshot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

export type NativeHarnessReconciliationContentReason =
  | "metadata-incompatible"
  | "coverage-incomplete"
  | "build-label-mismatch"
  | "profile-unsupported"
  | "source-invalid"
  | "source-manifest-mismatch"
  | "source-manifest-digest-mismatch"
  | "snapshot-not-required"
  | "snapshot-missing"
  | "snapshot-invalid"
  | "snapshot-layout-mismatch"
  | "snapshot-source-root-mismatch"
  | "base-snapshot-digest-mismatch"
  | "base-manifest-mismatch"
  | "stage-row-missing"
  | "stage-row-mismatch"
  | "stage-result-missing"
  | "stage-result-mismatch"
  | "stage-terminal-mismatch"
  | "stage-trace-path-mismatch"
  | "stage-trace-hash-missing"
  | "stage-artifact-hash-missing"
  | "stage-layout-mismatch"
  | "parent-mismatch"
  | "parent-cycle";

export type NativeHarnessReconciliationContentControlReason =
  | "aborted"
  | "deadline-expired"
  | "control-unavailable";

/** Internal fixed-mode control translation, shared with the byte observer. */
export class NativeHarnessReconciliationContentControlError extends Error {
  override name = "NativeHarnessReconciliationContentControlError";
  constructor(readonly reason: NativeHarnessReconciliationContentControlReason) {
    super(reason);
  }
}

export interface NativeHarnessReconciliationContentSourceFact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface NativeHarnessReconciliationContentBaseEntryFact {
  readonly path: string;
  readonly bytes: number;
  /** Plain UTF-8 content SHA from the original input manifest. */
  readonly sha256: string;
  readonly mode: number;
  /** Original sorted mode-aware Controller hash. */
  readonly controllerHash: string;
}

export interface NativeHarnessReconciliationContentBaseFact {
  readonly snapshotId: string;
  readonly root: string;
  readonly sourceRoot: string;
  readonly createdAt: string;
  readonly manifestSha256: string;
  /** sha256(canonicalJson(copyWitnessBase shape)); compared to inventory rows. */
  readonly snapshotSha256: string;
  readonly entries: readonly NativeHarnessReconciliationContentBaseEntryFact[];
}

export interface NativeHarnessReconciliationContentParentFact {
  readonly stage: StageId;
  readonly artifactHash: string;
}

export interface NativeHarnessReconciliationContentStageFact {
  readonly stage: StageId;
  readonly solver: boolean;
  readonly attempt: number;
  readonly cwd: string;
  readonly artifactDir: string;
  /** Fixed original trace path: artifactDir/worker-events.jsonl. */
  readonly eventsPath: string;
  readonly traceHash: string;
  /** Present exactly for completed solvers. */
  readonly artifactHash: string | null;
  readonly resultDigest: string;
  readonly usageCostUsd: number;
  readonly usageEstimated: boolean;
  readonly endedAt: string;
  /** Original terminal observedAt: Date.parse(result.endedAt). */
  readonly terminalObservedAt: number;
  readonly terminalObservationKind: "runner-observation";
  readonly parent: NativeHarnessReconciliationContentParentFact | null;
}

export interface NativeHarnessReconciliationContentPlan {
  readonly schema: typeof NATIVE_HARNESS_RECONCILIATION_CONTENT_PLAN_SCHEMA;
  readonly readOnly: true;
  readonly resumeAvailable: false;
  readonly processes: "not-inspected";
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly preparedRoot: string;
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly runRoot: string;
  readonly sources: readonly NativeHarnessReconciliationContentSourceFact[];
  readonly base: NativeHarnessReconciliationContentBaseFact;
  readonly stages: readonly NativeHarnessReconciliationContentStageFact[];
}

export interface NativeHarnessReconciliationContentInput {
  readonly runText: string;
  readonly sourceText: string;
  readonly inventoryText: string;
  readonly ownerText: string;
  readonly expected: NativeHarnessReconciliationExpectation;
  readonly now: number;
}

export type NativeHarnessReconciliationContentPlanResult =
  | {
    readonly status: "planned";
    readonly reasons: readonly [];
    readonly metadata: NativeHarnessReconciliationResult;
    readonly plan: NativeHarnessReconciliationContentPlan;
  }
  | {
    readonly status: "not-required";
    readonly reasons: readonly NativeHarnessReconciliationContentReason[];
    readonly metadata: NativeHarnessReconciliationResult;
  }
  | {
    readonly status: "unavailable";
    readonly reasons: readonly NativeHarnessReconciliationContentReason[];
    readonly metadata: NativeHarnessReconciliationResult;
  };

export type NativeHarnessReconciliationContentPlanInputErrorCode =
  | "invalid-input"
  | "too-large";

export class NativeHarnessReconciliationContentPlanInputError extends Error {
  override name = "NativeHarnessReconciliationContentPlanInputError";
  constructor(message: string, readonly code: NativeHarnessReconciliationContentPlanInputErrorCode = "invalid-input") {
    super(message);
  }
}

function failInput(message: string, code: NativeHarnessReconciliationContentPlanInputErrorCode = "invalid-input"): never {
  throw new NativeHarnessReconciliationContentPlanInputError(message, code);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isStrictlyContained(root: string, candidate: string): boolean {
  return candidate !== root && isContained(root, candidate);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function addReason(
  reasons: NativeHarnessReconciliationContentReason[],
  reason: NativeHarnessReconciliationContentReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function unavailable(
  metadata: NativeHarnessReconciliationResult,
  reasons: readonly NativeHarnessReconciliationContentReason[],
): NativeHarnessReconciliationContentPlanResult {
  return deepFreeze({
    status: "unavailable" as const,
    reasons: Object.freeze([...new Set(reasons)]),
    metadata,
  });
}

function hex64(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !CONTROL_PATTERN.test(value)
    ? value
    : null;
}

function canonicalPath(value: unknown): string | null {
  const text = boundedText(value, MAX_PATH_CHARS);
  return text !== null
    && path.isAbsolute(text)
    && path.normalize(text) === text
    && text !== path.parse(text).root
    ? text
    : null;
}

function relativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return validateRelativePath(value);
  } catch {
    return null;
  }
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareLocale(left: string, right: string): number {
  return left.localeCompare(right);
}

function isSolver(stage: StageId): boolean {
  return (CANDIDATE_IDS as readonly string[]).includes(stage);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

interface SnapshotFile {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly hash: string;
}

function readSnapshotFiles(snapshot: NonNullable<RunRecord["snapshot"]>): SnapshotFile[] | null {
  if (!Array.isArray(snapshot.files)) return null;
  if (snapshot.files.length < 1 || snapshot.files.length > MAX_SOURCE_FILES) return null;
  const files: SnapshotFile[] = [];
  const seen = new Set<string>();
  for (const raw of snapshot.files) {
    if (typeof raw !== "object" || raw === null) return null;
    const relative = relativePath((raw as { path?: unknown }).path);
    const size = (raw as { size?: unknown }).size;
    const mode = (raw as { mode?: unknown }).mode;
    const hash = (raw as { hash?: unknown }).hash;
    if (
      relative === null
      || !Number.isSafeInteger(size)
      || (size as number) < 0
      || (size as number) > MAX_SOURCE_FILE_BYTES
      || !Number.isSafeInteger(mode)
      || (mode as number) < 0
      || (mode as number) > 0o777
      || !hex64(hash)
      || seen.has(relative)
    ) {
      return null;
    }
    seen.add(relative);
    files.push({ path: relative, size: size as number, mode: mode as number, hash });
  }
  return files;
}

function sourceManifestDigest(source: NativeHarnessRecoverySourceDocument): string {
  const sorted = [...source.inputs]
    .map((input) => [input.relativePath, input.bytes, input.sha256] as const)
    .sort((left, right) => compareCodeUnit(left[0], right[0]));
  return sha256Hex(JSON.stringify(sorted));
}

function stageAttemptDirectoryMatches(
  runRoot: string,
  stage: StageId,
  attempt: number,
  cwd: string,
): boolean {
  if (!isStrictlyContained(runRoot, cwd)) return false;
  const segments = path.relative(runRoot, cwd).split(path.sep);
  if (segments.length !== 4) return false;
  const [stages, stageSegment, attemptSegment, workspace] = segments;
  return stages === "stages"
    && stageSegment === stage
    && attemptSegment?.startsWith(`attempt-${attempt}-`) === true
    && UUID_PATTERN.test(attemptSegment.slice(`attempt-${attempt}-`.length))
    && workspace === "workspace";
}

function stageRowFor(
  inventory: NativeHarnessDispatchInventoryV2,
  stage: StageId,
  attempt: number,
): NativeHarnessDispatchRow | null {
  const rows = inventory.dispatches.filter((row) => row.stage === stage && row.attempt === attempt);
  return rows.length === 1 ? rows[0]! : null;
}

function terminalFactsMatch(stage: StageRecord, row: NativeHarnessDispatchRow): {
  readonly resultDigest: string;
  readonly usageCostUsd: number;
  readonly usageEstimated: boolean;
  readonly endedAt: string;
  readonly observedAt: number;
  readonly observationKind: "runner-observation";
} | null {
  const result = stage.result;
  const terminal = row.terminal;
  const cleanup = row.cleanup;
  if (result === undefined || terminal === undefined || cleanup === undefined) return null;
  if (row.state !== "terminal" || terminal.outcome !== "completed") return null;
  if (result.status !== "completed") return null;
  if (cleanup.observationKind !== terminal.observationKind) return null;
  if (stage.status !== "completed") return null;
  // Reusable latest contents require the original runner-observation terminal
  // chain. A synthetic-fixture receipt is test fixture data, never a product
  // path that this planner silently promotes.
  if (terminal.observationKind !== "runner-observation") return null;
  if (
    result.usage.inputTokens < 0
    || !finiteNonNegative(result.usage.inputTokens)
    || !finiteNonNegative(result.usage.outputTokens)
    || !finiteNonNegative(result.usage.costUsd)
  ) {
    return null;
  }
  if (typeof result.startedAt !== "string" || typeof result.endedAt !== "string") return null;
  const endedAtMs = Date.parse(result.endedAt);
  if (!Number.isSafeInteger(endedAtMs) || endedAtMs < 0) return null;
  if (stage.endedAt !== undefined && stage.endedAt !== result.endedAt) return null;
  if (terminal.observedAt !== endedAtMs) return null;
  if (terminal.usageCostUsd !== result.usage.costUsd) return null;
  if (terminal.usageEstimated !== (result.usageEstimated === true)) return null;
  if (terminal.resultSha256 === null) return null;
  let digest: string;
  try {
    digest = canonicalWorkerResultSha256(result);
  } catch {
    return null;
  }
  if (terminal.resultSha256 !== digest) return null;
  return {
    resultDigest: digest,
    usageCostUsd: result.usage.costUsd,
    usageEstimated: result.usageEstimated === true,
    endedAt: result.endedAt,
    observedAt: terminal.observedAt,
    observationKind: terminal.observationKind,
  };
}

function planStages(
  run: RunRecord,
  inventory: NativeHarnessDispatchInventoryV2,
  runRoot: string,
  baseSnapshotSha256: string,
  reasons: NativeHarnessReconciliationContentReason[],
): NativeHarnessReconciliationContentStageFact[] {
  const completed = new Map<StageId, {
    readonly record: StageRecord;
    readonly row: NativeHarnessDispatchRow;
    readonly terminal: ReturnType<typeof terminalFactsMatch>;
  }>();
  let solverCount = 0;

  for (const stageId of STAGE_IDS) {
    const record = run.stages[stageId];
    if (record === undefined || record.status !== "completed") continue;
    if (completed.size >= MAX_STAGES) {
      addReason(reasons, "profile-unsupported");
      break;
    }
    if (record.id !== stageId || !positiveInteger(record.attempt)) {
      addReason(reasons, "stage-row-mismatch");
      continue;
    }
    const solver = isSolver(stageId);
    if (solver) solverCount += 1;
    if (solverCount > MAX_SOLVERS) {
      addReason(reasons, "profile-unsupported");
      continue;
    }
    const cwd = canonicalPath(record.cwd);
    if (cwd === null || !stageAttemptDirectoryMatches(runRoot, stageId, record.attempt, cwd)) {
      addReason(reasons, "stage-layout-mismatch");
      continue;
    }
    const artifactDir = path.join(path.dirname(cwd), "artifacts");
    const row = stageRowFor(inventory, stageId, record.attempt);
    if (row === null) {
      addReason(reasons, "stage-row-missing");
      continue;
    }
    if (row.cwd !== cwd || row.artifactDir !== artifactDir) {
      addReason(reasons, "stage-row-mismatch");
      continue;
    }
    if (row.snapshotSha256 !== baseSnapshotSha256) {
      addReason(reasons, "base-snapshot-digest-mismatch");
      continue;
    }
    const result = record.result;
    if (result === undefined) {
      addReason(reasons, "stage-result-missing");
      continue;
    }
    const eventsPath = path.join(artifactDir, "worker-events.jsonl");
    if (result.eventsPath !== eventsPath) {
      addReason(reasons, "stage-trace-path-mismatch");
      continue;
    }
    if (!hex64(record.traceHash)) {
      addReason(reasons, "stage-trace-hash-missing");
      continue;
    }
    if (solver && !hex64(record.artifactHash)) {
      addReason(reasons, "stage-artifact-hash-missing");
      continue;
    }
    const terminal = terminalFactsMatch(record, row);
    if (terminal === null) {
      addReason(reasons, "stage-terminal-mismatch");
      continue;
    }
    const hasParent = record.parentStage !== undefined || record.parentArtifactHash !== undefined;
    let parent: NativeHarnessReconciliationContentParentFact | null = null;
    if (hasParent) {
      if (record.parentStage === undefined || record.parentArtifactHash === undefined) {
        addReason(reasons, "parent-mismatch");
        continue;
      }
      if (
        !(CANDIDATE_IDS as readonly string[]).includes(record.parentStage)
        || !hex64(record.parentArtifactHash)
      ) {
        addReason(reasons, "parent-mismatch");
        continue;
      }
      parent = Object.freeze({
        stage: record.parentStage as StageId,
        artifactHash: record.parentArtifactHash,
      });
    }
    if (stageId === "refine" && parent === null) {
      addReason(reasons, "parent-mismatch");
      continue;
    }
    completed.set(stageId, { record, row, terminal });
  }

  for (const [stageId, facts] of completed) {
    const parent = facts.record.parentStage;
    if (parent === undefined) continue;
    const parentFacts = completed.get(parent as StageId);
    if (
      parentFacts === undefined
      || parentFacts.record.artifactHash === undefined
      || facts.record.parentArtifactHash !== parentFacts.record.artifactHash
    ) {
      addReason(reasons, "parent-mismatch");
      completed.delete(stageId);
    }
  }

  for (const stageId of completed.keys()) {
    const visited = new Set<StageId>([stageId]);
    let cursor = completed.get(stageId)?.record.parentStage as StageId | undefined;
    let depth = 0;
    while (cursor !== undefined) {
      if (visited.has(cursor) || depth >= MAX_SOLVERS) {
        addReason(reasons, "parent-cycle");
        completed.clear();
        return [];
      }
      visited.add(cursor);
      cursor = completed.get(cursor)?.record.parentStage as StageId | undefined;
      depth += 1;
    }
  }

  const facts: NativeHarnessReconciliationContentStageFact[] = [];
  for (const stageId of STAGE_IDS) {
    const stageFacts = completed.get(stageId);
    if (stageFacts === undefined || stageFacts.terminal === null) continue;
    const solver = isSolver(stageId);
    const record = stageFacts.record;
    const cwd = record.cwd;
    const artifactDir = path.join(path.dirname(cwd), "artifacts");
    const parent = record.parentStage === undefined
      ? null
      : Object.freeze({
        stage: record.parentStage as StageId,
        artifactHash: record.parentArtifactHash!,
      });
    facts.push(Object.freeze({
      stage: stageId,
      solver,
      attempt: record.attempt,
      cwd,
      artifactDir,
      eventsPath: path.join(artifactDir, "worker-events.jsonl"),
      traceHash: record.traceHash!,
      artifactHash: solver ? record.artifactHash! : null,
      resultDigest: stageFacts.terminal.resultDigest,
      usageCostUsd: stageFacts.terminal.usageCostUsd,
      usageEstimated: stageFacts.terminal.usageEstimated,
      endedAt: stageFacts.terminal.endedAt,
      terminalObservedAt: stageFacts.terminal.observedAt,
      terminalObservationKind: stageFacts.terminal.observationKind,
      parent,
    }));
  }
  return facts;
}

interface OwnedContentInput {
  readonly runText: string;
  readonly sourceText: string;
  readonly inventoryText: string;
  readonly ownerText: string;
  readonly expected: NativeHarnessReconciliationExpectation;
  readonly now: number;
}

function ownDataField(value: unknown, key: string, label: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failInput(`${label} must be an exact plain object.`);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    failInput(`${label}.${key} could not be inspected.`);
  }
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || descriptor.get !== undefined
    || descriptor.set !== undefined
    || descriptor.enumerable !== true
  ) {
    failInput(`${label}.${key} must be an enumerable own data field.`);
  }
  return descriptor.value;
}

/**
 * One bounded own-data snapshot for the whole pure planner. Neither B2a nor
 * the later decoders can observe a second caller value for the same input.
 */
function copyOwnedInput(value: unknown): OwnedContentInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failInput("reconciliation content input must be an exact plain object.");
  }
  let keys: (string | symbol)[];
  let prototype: object | null;
  try {
    keys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    failInput("reconciliation content input could not be inspected.");
  }
  const allowed = ["runText", "sourceText", "inventoryText", "ownerText", "expected", "now"] as const;
  if (
    (prototype !== Object.prototype && prototype !== null)
    || keys.length !== allowed.length
    || keys.some((key) => typeof key !== "string" || !allowed.includes(key as typeof allowed[number]))
  ) {
    failInput("reconciliation content input must contain exactly its fixed fields.");
  }
  const rawExpected = ownDataField(value, "expected", "reconciliation content input");
  const expectedKeys = [
    "runId",
    "ownerId",
    "selectorSha256",
    "storageRoot",
    "sourceRoot",
    "preparedRelativeRoot",
    "backendBuildSourceId",
  ] as const;
  if (typeof rawExpected !== "object" || rawExpected === null || Array.isArray(rawExpected)) {
    failInput("reconciliation content expected must be an exact plain object.");
  }
  let expectedActualKeys: (string | symbol)[];
  try {
    expectedActualKeys = Reflect.ownKeys(rawExpected);
  } catch {
    failInput("reconciliation content expected could not be inspected.");
  }
  if (
    expectedActualKeys.length !== expectedKeys.length
    || expectedActualKeys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key as typeof expectedKeys[number]),
    )
  ) {
    failInput("reconciliation content expected must contain exactly its fixed fields.");
  }
  const stringField = (target: unknown, key: string, label: string): string => {
    const field = ownDataField(target, key, label);
    if (typeof field !== "string") failInput(`${label}.${key} must be a string.`);
    return field;
  };
  const now = ownDataField(value, "now", "reconciliation content input");
  if (typeof now !== "number") failInput("reconciliation content input.now must be a number.");
  const expected: NativeHarnessReconciliationExpectation = {
    runId: stringField(rawExpected, "runId", "reconciliation content expected"),
    ownerId: stringField(rawExpected, "ownerId", "reconciliation content expected"),
    selectorSha256: stringField(rawExpected, "selectorSha256", "reconciliation content expected"),
    storageRoot: stringField(rawExpected, "storageRoot", "reconciliation content expected"),
    sourceRoot: stringField(rawExpected, "sourceRoot", "reconciliation content expected"),
    preparedRelativeRoot: stringField(
      rawExpected,
      "preparedRelativeRoot",
      "reconciliation content expected",
    ),
    backendBuildSourceId: stringField(
      rawExpected,
      "backendBuildSourceId",
      "reconciliation content expected",
    ),
  };
  return Object.freeze({
    runText: stringField(value, "runText", "reconciliation content input"),
    sourceText: stringField(value, "sourceText", "reconciliation content input"),
    inventoryText: stringField(value, "inventoryText", "reconciliation content input"),
    ownerText: stringField(value, "ownerText", "reconciliation content input"),
    expected: Object.freeze(expected),
    now,
  });
}

/**
 * Plans only latest completed stage contents. Invalid metadata, incomplete
 * coverage, unsupported profiles, bad source/base joins or any required stage
 * mismatch refuse before any content path is selected.
 */
export function planNativeHarnessReconciliationContent(
  input: NativeHarnessReconciliationContentInput,
): NativeHarnessReconciliationContentPlanResult {
  const owned = copyOwnedInput(input);
  let metadata: NativeHarnessReconciliationResult;
  try {
    metadata = reconcileNativeHarnessMetadata(owned);
  } catch (error) {
    if (error instanceof TypeError) {
      failInput("reconciliation content input is not an exact bounded object.");
    }
    throw error;
  }

  const preliminary: NativeHarnessReconciliationContentReason[] = [];
  if (!metadata.metadata.compatible) addReason(preliminary, "metadata-incompatible");
  if (metadata.coverage.status !== "complete") addReason(preliminary, "coverage-incomplete");
  if (metadata.inventory?.schema !== "v2") addReason(preliminary, "profile-unsupported");
  if (metadata.build.labelCompatible !== true) addReason(preliminary, "build-label-mismatch");
  if (metadata.run === null || metadata.source === null || metadata.owner === null) {
    addReason(preliminary, "profile-unsupported");
  }
  if (preliminary.length !== 0) return unavailable(metadata, preliminary);

  let run: RunRecord;
  let source: NativeHarnessRecoverySourceDocument;
  let inventory: NativeHarnessDispatchInventoryV2;
  try {
    run = decodeRunHistoryText(owned.runText, owned.expected.runId);
    source = decodeNativeHarnessRecoverySourceText(owned.sourceText, {
      storageRoot: owned.expected.storageRoot,
      sourceRoot: owned.expected.sourceRoot,
      preparedRelativeRoot: owned.expected.preparedRelativeRoot,
    });
    const decoded = decodeNativeHarnessDispatchInventoryText(owned.inventoryText, {
      runId: owned.expected.runId,
    });
    if (decoded.schema !== NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2) {
      return unavailable(metadata, ["profile-unsupported"]);
    }
    inventory = decoded;
  } catch {
    return unavailable(metadata, ["source-invalid"]);
  }

  if (
    source.profile !== NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE
    || run.config.strategy !== "auto"
    || run.config.mode !== "product"
    || run.config.domain !== "generic"
  ) {
    return unavailable(metadata, ["profile-unsupported"]);
  }

  const preparedRoot = path.join(owned.expected.storageRoot, source.workspace.preparedRelativeRoot);
  const workspaceRoot = path.join(owned.expected.storageRoot, source.workspace.workspaceRelativeRoot);
  const storeRoot = path.join(owned.expected.storageRoot, source.workspace.storeRelativeRoot);
  const runRoot = path.join(storeRoot, "runs", owned.expected.runId);
  if (
    source.workspace.sourceRoot !== owned.expected.sourceRoot
    || run.workspace !== workspaceRoot
    || !isStrictlyContained(preparedRoot, workspaceRoot)
    || !isStrictlyContained(preparedRoot, storeRoot)
    || !isStrictlyContained(storeRoot, runRoot)
    || !isContained(owned.expected.storageRoot, preparedRoot)
  ) {
    return unavailable(metadata, ["profile-unsupported"]);
  }

  if (source.inputs.length < 1
    || source.inputs.length > MAX_SOURCE_FILES
    || new Set(source.inputs.map((entry) => entry.relativePath)).size !== source.inputs.length) {
    return unavailable(metadata, ["source-manifest-mismatch"]);
  }
  let sourceTotalBytes = 0;
  for (const entry of source.inputs) {
    if (
      relativePath(entry.relativePath) === null
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || entry.bytes > MAX_SOURCE_FILE_BYTES
      || !hex64(entry.sha256)
    ) {
      return unavailable(metadata, ["source-manifest-mismatch"]);
    }
    sourceTotalBytes += entry.bytes;
  }
  if (sourceTotalBytes > MAX_SOURCE_TOTAL_BYTES) {
    return unavailable(metadata, ["source-manifest-mismatch"]);
  }
  if (sourceManifestDigest(source) !== source.inputManifestSha256) {
    return unavailable(metadata, ["source-manifest-digest-mismatch"]);
  }

  const snapshot = run.snapshot;
  const anyStageRecord = STAGE_IDS.some((stage) => run.stages[stage] !== undefined);
  const anyDispatch = inventory.dispatches.length > 0;
  if (snapshot === undefined) {
    if (anyStageRecord || anyDispatch) {
      return unavailable(metadata, ["snapshot-missing"]);
    }
    return deepFreeze({
      status: "not-required" as const,
      reasons: Object.freeze(["snapshot-not-required"] as const),
      metadata,
    });
  }

  const snapshotRoot = canonicalPath(snapshot.root);
  const snapshotSourceRoot = canonicalPath(snapshot.sourceRoot);
  if (
    snapshotRoot === null
    || snapshotSourceRoot === null
    || typeof snapshot.id !== "string"
    || !UUID_PATTERN.test(snapshot.id)
    || typeof snapshot.createdAt !== "string"
    || !Number.isSafeInteger(Date.parse(snapshot.createdAt))
    || Date.parse(snapshot.createdAt) < 0
  ) {
    return unavailable(metadata, ["snapshot-invalid"]);
  }
  if (
    path.dirname(snapshotRoot) !== runRoot
    || !SNAPSHOT_DIRECTORY_PATTERN.test(path.basename(snapshotRoot))
  ) {
    return unavailable(metadata, ["snapshot-layout-mismatch"]);
  }
  if (snapshotSourceRoot !== workspaceRoot) {
    return unavailable(metadata, ["snapshot-source-root-mismatch"]);
  }

  const snapshotFiles = readSnapshotFiles(snapshot);
  if (snapshotFiles === null) return unavailable(metadata, ["snapshot-invalid"]);
  const inputByPath = new Map(source.inputs.map((entry) => [entry.relativePath, entry]));
  if (snapshotFiles.length !== inputByPath.size) {
    return unavailable(metadata, ["base-manifest-mismatch"]);
  }
  const checked: Array<{
    readonly path: string;
    readonly size: number;
    readonly mode: number;
    readonly contentSha256: string;
    readonly controllerHash: string;
  }> = [];
  for (const file of snapshotFiles) {
    const input = inputByPath.get(file.path);
    if (input === undefined || input.bytes !== file.size) {
      return unavailable(metadata, ["base-manifest-mismatch"]);
    }
    checked.push({
      path: file.path,
      size: file.size,
      mode: file.mode,
      contentSha256: input.sha256,
      controllerHash: file.hash,
    });
  }
  const base = copyWitnessBase({
    snapshotId: snapshot.id,
    root: snapshotRoot,
    sourceRoot: snapshotSourceRoot,
    createdAt: snapshot.createdAt,
    checked,
    inputs: source.inputs,
    manifestSha256: source.inputManifestSha256,
  });
  if (base === null) return unavailable(metadata, ["base-manifest-mismatch"]);
  const snapshotSha256 = sha256Hex(canonicalJson(base));
  for (const row of inventory.dispatches) {
    if (row.snapshotSha256 !== snapshotSha256) {
      return unavailable(metadata, ["base-snapshot-digest-mismatch"]);
    }
  }

  const reasons: NativeHarnessReconciliationContentReason[] = [];
  const stages = planStages(run, inventory, runRoot, snapshotSha256, reasons);
  if (reasons.length !== 0) return unavailable(metadata, reasons);

  const sourceFacts: NativeHarnessReconciliationContentSourceFact[] = [...source.inputs]
    .map((entry) => Object.freeze({
      path: entry.relativePath,
      bytes: entry.bytes,
      sha256: entry.sha256,
    }))
    .sort((left, right) => compareLocale(left.path, right.path));
  const baseEntries: NativeHarnessReconciliationContentBaseEntryFact[] = base.entries.map((entry) => {
    const input = inputByPath.get(entry.path)!;
    return Object.freeze({
      path: entry.path,
      bytes: entry.size,
      sha256: input.sha256,
      mode: entry.mode,
      controllerHash: entry.hash,
    });
  });
  const plan = deepFreeze({
    schema: NATIVE_HARNESS_RECONCILIATION_CONTENT_PLAN_SCHEMA,
    readOnly: true as const,
    resumeAvailable: false as const,
    processes: "not-inspected" as const,
    storageRoot: owned.expected.storageRoot,
    sourceRoot: owned.expected.sourceRoot,
    preparedRoot,
    workspaceRoot,
    storeRoot,
    runRoot,
    sources: Object.freeze(sourceFacts),
    base: Object.freeze({
      snapshotId: snapshot.id,
      root: snapshotRoot,
      sourceRoot: snapshotSourceRoot,
      createdAt: snapshot.createdAt,
      manifestSha256: source.inputManifestSha256,
      snapshotSha256,
      entries: Object.freeze(baseEntries),
    }),
    stages: Object.freeze(stages),
  });
  return deepFreeze({
    status: "planned" as const,
    reasons: Object.freeze([] as const),
    metadata,
    plan,
  });
}
