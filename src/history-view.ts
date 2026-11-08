import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  createHistoryProjectionReader,
  HISTORY_FILE_BYTES_LIMIT,
  HistoryProjectionError,
  type HistoryInspectSelector,
  type HistoryItem,
} from "./history-projection.ts";
import {
  HISTORY_LOCATOR_CUSTOM_TYPE,
  HISTORY_LOCATOR_DATA_BYTES_LIMIT,
  HISTORY_LOCATOR_VERSION,
  HISTORY_RUN_ARTIFACT_LIMIT,
  HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
  HISTORY_RUN_LOCATOR_DATA_BYTES_LIMIT,
  HISTORY_RUN_LOCATOR_VERSION,
  HISTORY_SESSION_BRANCH_ENTRY_LIMIT,
  type HistoryLocatorData,
  type HistoryRunLocatorData,
} from "./history-session.ts";
import {
  checkRunEvidence,
  RUN_RECORD_FILE_NAME,
  type HistoryItemReference,
  type RunEvidenceResult,
} from "./history-evidence.ts";
import { genuineUserText, parseBranch, type BranchEntry } from "./task-branch.ts";
import {
  canonicalWorkspaceRoot,
  type OmpSessionManager,
  type OmpToolContext,
} from "./task-entry-port.ts";
import type { TaskStatus } from "./task-owner.ts";

/**
 * G3-B2a read-only view over B1 native locators on the actual selected branch.
 *
 * The view is a bounded metadata index, not a filesystem snapshot. Each query
 * re-reads the real branch, session identity and every selected projection
 * file, then compares all selected index/parent identities after the final
 * host getters. Observable changes discard the page; undetectable concurrent
 * mutation is outside this claim.
 */

export const HISTORY_VIEW_SCHEMA_VERSION = "agent-history-view-v1" as const;
/** One page is at most this many candidate locator occurrences. */
export const HISTORY_QUERY_PAGE_LIMIT = 16 as const;
/** The complete selected view is refused above this many locator occurrences. */
export const HISTORY_QUERY_CANDIDATE_LIMIT = 128 as const;
/** Reuses B1's complete-branch traversal bound. */
export const HISTORY_QUERY_BRANCH_ENTRY_LIMIT = HISTORY_SESSION_BRANCH_ENTRY_LIMIT;
/** Every A.inspect is precharged the complete-file worst case. */
export const HISTORY_QUERY_INSPECTION_LIMIT = 16 as const;
export const HISTORY_QUERY_READ_BUDGET_BYTES = HISTORY_FILE_BYTES_LIMIT * HISTORY_QUERY_INSPECTION_LIMIT;

export const HISTORY_CURSOR_PATTERN = /^hcur_[0-9a-f]{32}$/;
export const HISTORY_SELECTOR_PATTERN = /^hsel_[0-9a-f]{32}$/;
/** Run selectors and cursors use namespaces distinct from task selectors. */
export const HISTORY_RUN_SELECTOR_PATTERN = /^hrun_[0-9a-f]{32}$/;
export const HISTORY_RUN_CURSOR_PATTERN = /^hrcur_[0-9a-f]{32}$/;
/** Complete selected-branch run-locator occurrence bound. */
export const HISTORY_QUERY_RUN_CANDIDATE_LIMIT = 128 as const;
/**
 * Conservative precharge for one inspect_run, not measured IO. It exceeds the
 * derived worst case: 3 task reads + two record/source/input/artifact scans.
 */
export const HISTORY_RUN_EVIDENCE_PRECHARGE_BYTES = 12 * 1024 * 1024;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_INSTANCE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_RUN_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BOUNDED_RUN_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const NATIVE_ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

/**
 * Reads the actual host abort flag through the native brand-checked getter.
 * An arbitrary `aborted` property is never executed or trusted: a value that
 * is not a real AbortSignal is refused as aborted.
 */
function hostAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (NATIVE_ABORTED_GETTER === undefined) return true;
  try {
    return NATIVE_ABORTED_GETTER.call(signal) === true;
  } catch {
    return true;
  }
}
const LOCATOR_KEYS = [
  "version",
  "instanceId",
  "ownerId",
  "historyId",
  "digest",
  "taskId",
  "taskRevision",
  "originSessionId",
] as const;
const SOURCE_LEDGER_KEYS = [
  "revision",
  "kind",
  "messageId",
  "sessionId",
  "source",
  "text",
  "observedAt",
  "committedAt",
  "previousRevision",
] as const;
const RUN_LOCATOR_KEYS = [
  "version",
  "instanceId",
  "ownerId",
  "historyId",
  "digest",
  "taskId",
  "taskRevision",
  "requirementsDigest",
  "originSessionId",
  "runId",
  "callId",
  "runDirectory",
  "artifactIds",
  "recordWriteReturned",
  "byteIntegrity",
  "authorityRestored",
] as const;

export type HistoryViewErrorCode =
  | "aborted"
  | "branch_invalid"
  | "budget_exhausted"
  | "composition_changed"
  | "cursor_invalid"
  | "disposed"
  | "invalid_arguments"
  | "limit"
  | "main_only"
  | "new_list_required"
  | "scope_changed"
  | "session_unavailable"
  | "too_large"
  | "unavailable"
  | "unknown_selector"
  | "withheld"
  | "workspace_mismatch";

export type HistoryWithheldReason =
  | "budget_exhausted"
  | "history_changed"
  | "history_conflict"
  | "history_invalid"
  | "history_limit"
  | "history_missing"
  | "history_mismatch"
  | "history_too_large"
  | "history_unavailable"
  | "history_unknown"
  | "history_unsupported"
  | "instance_changed"
  | "instance_unavailable"
  | "instance_unsafe"
  | "locator_conflict"
  | "locator_invalid"
  | "locator_unsupported"
  | "session_mismatch"
  | "source_mismatch";

export type HistoryRunWithheldReason =
  | "run_conflict"
  | "run_locator_invalid"
  | "run_locator_unsupported"
  | "run_session_mismatch"
  | "run_source_mismatch"
  | "run_task_inactive"
  | "run_task_locator_conflict"
  | "run_task_locator_missing"
  | "run_task_mismatch"
  | "run_task_order";

const RUN_WITHHELD_REASONS: readonly HistoryRunWithheldReason[] = [
  "run_conflict",
  "run_locator_invalid",
  "run_locator_unsupported",
  "run_session_mismatch",
  "run_source_mismatch",
  "run_task_inactive",
  "run_task_locator_conflict",
  "run_task_locator_missing",
  "run_task_mismatch",
  "run_task_order",
];

const WITHHELD_REASONS: readonly HistoryWithheldReason[] = [
  "budget_exhausted",
  "history_changed",
  "history_conflict",
  "history_invalid",
  "history_limit",
  "history_missing",
  "history_mismatch",
  "history_too_large",
  "history_unavailable",
  "history_unknown",
  "history_unsupported",
  "instance_changed",
  "instance_unavailable",
  "instance_unsafe",
  "locator_conflict",
  "locator_invalid",
  "locator_unsupported",
  "session_mismatch",
  "source_mismatch",
];

export interface HistoryViewEvidence {
  historical: true;
  authorityRestored: false;
  evidence: "local-record";
  recordedStatusScope: "at_capture";
  presentExecution: "not_checked";
  acceptanceEvidence: "not_checked";
  candidateRegistration: "not_checked";
  projection: {
    source: "local-record";
    branchVisibility: "not_checked";
    acceptanceEvidence: "not_checked";
    candidateRegistration: "not_checked";
  };
  bridge: {
    selectedBranch: "checked";
    requirementLedger: "checked";
    runEvidence: "checked" | "not_checked";
  };
}

export interface HistoryListSummary {
  selector: string;
  historyId: string;
  digest: string;
  taskId: string;
  taskRevision: number;
  recordedStatus: TaskStatus;
  createdAt: string;
  cancelledAt: string | null;
  sourceCount: number;
  amendmentCount: number;
  requirementsDigest: string;
}

export interface HistoryListCoverage {
  candidates: number;
  evaluated: number;
  inspected: number;
  returned: number;
  withheld: number;
  duplicatesCollapsed: number;
  more: boolean;
  withheldReasons: Readonly<Record<HistoryWithheldReason, number>>;
}

export interface HistoryQueryBudgetView {
  inspections: number;
  inspectionLimit: number;
  prechargedBytes: number;
  bytesLimit: number;
}

export interface HistoryListView {
  schemaVersion: typeof HISTORY_VIEW_SCHEMA_VERSION;
  action: "list";
  scope: "selected_branch";
  result: "visible_history" | "no_visible_history";
  items: HistoryListSummary[];
  nextCursor: string | null;
  coverage: HistoryListCoverage;
  budget: HistoryQueryBudgetView;
  evidence: HistoryViewEvidence;
}

export interface HistoryInspectView {
  schemaVersion: typeof HISTORY_VIEW_SCHEMA_VERSION;
  action: "inspect";
  scope: "selected_branch";
  item: HistoryItem;
  budget: HistoryQueryBudgetView;
  evidence: HistoryViewEvidence;
}

export interface HistoryRunAssociation {
  historyId: string;
  digest: string;
  taskId: string;
  taskRevision: number;
  requirementsDigest: string;
  runId: string;
  callId: string;
  runDirectory: string;
  artifactIds: string[];
  recordWriteReturned: true;
  byteIntegrity: "not_checked";
  authorityRestored: false;
}

export interface HistoryRunListSummary extends HistoryRunAssociation {
  selector: string;
}

export interface HistoryRunListCoverage {
  candidates: number;
  evaluated: number;
  inspected: number;
  returned: number;
  withheld: number;
  duplicatesCollapsed: number;
  more: boolean;
  withheldReasons: Readonly<Record<HistoryRunWithheldReason, number>>;
}

export interface HistoryRunListBudgetView extends HistoryQueryBudgetView {}

export interface HistoryRunInspectBudgetView {
  taskInspections: number;
  runEvidenceCalls: number;
  /** Conservative whole-action precharge, not measured IO. */
  prechargedBytes: number;
  precharge: "conservative_not_measured";
  bytesLimit: number;
}

export interface HistoryRunListView {
  schemaVersion: typeof HISTORY_VIEW_SCHEMA_VERSION;
  action: "list_runs";
  scope: "selected_branch";
  result: "visible_runs" | "no_visible_runs";
  items: HistoryRunListSummary[];
  nextCursor: string | null;
  coverage: HistoryRunListCoverage;
  budget: HistoryRunListBudgetView;
  evidence: HistoryViewEvidence;
}

export interface HistoryRunVerification {
  instance: "exact" | "mismatch";
  history: "exact" | "mismatch";
  run: "exact" | "mismatch";
  metadata: RunEvidenceResult["metadata"]["state"];
  /** Exact set equality, not only A.selection.allPresent. */
  artifactSet: "exact" | "mismatch";
}

export interface HistoryRunInspectView {
  schemaVersion: typeof HISTORY_VIEW_SCHEMA_VERSION;
  action: "inspect_run";
  scope: "selected_branch";
  /** Association-level failure state; A's own state remains in runEvidence. */
  state: RunEvidenceResult["state"];
  /** Archived facts, never a success or current-process claim. */
  result: "archived_run_evidence" | "withheld_archived_run_evidence";
  association: HistoryRunAssociation;
  verification: HistoryRunVerification;
  runEvidence: RunEvidenceResult;
  budget: HistoryRunInspectBudgetView;
  evidence: HistoryViewEvidence;
}

export interface HistoryRunListRequest {
  taskSelector: string;
  limit?: number;
  cursor?: string;
}

export type HistoryRunListOutcome =
  | { ok: true; view: HistoryRunListView }
  | {
    ok: false;
    code: HistoryViewErrorCode;
    reason?: HistoryWithheldReason | HistoryRunWithheldReason;
  };

export type HistoryRunInspectOutcome =
  | { ok: true; view: HistoryRunInspectView }
  | {
    ok: false;
    code: HistoryViewErrorCode;
    reason?: HistoryWithheldReason | HistoryRunWithheldReason;
  };

export interface HistoryListRequest {
  limit: number;
  cursor?: string;
}

export type HistoryListOutcome =
  | { ok: true; view: HistoryListView }
  | { ok: false; code: HistoryViewErrorCode };

export type HistoryInspectOutcome =
  | { ok: true; view: HistoryInspectView }
  | { ok: false; code: HistoryViewErrorCode; reason?: HistoryWithheldReason };

export interface HistoryQueryStatus {
  disposed: boolean;
  view: "none" | "active";
  selectors: number;
  generation: number;
  lastError: HistoryViewErrorCode | null;
}

export interface HistoryViewOptions {
  /** Existing private daily state root; instance roots are derived only here. */
  stateRoot: string;
  /** Canonical daily workspace root. */
  workspaceRoot: string;
  /** True only while the same actual published owner remains current. */
  isCurrentComposition: () => boolean;
}

export interface HistoryViewControls {
  list(
    context: OmpToolContext,
    request: HistoryListRequest,
    signal?: AbortSignal,
  ): HistoryListOutcome;
  inspect(
    context: OmpToolContext,
    selector: string,
    signal?: AbortSignal,
  ): HistoryInspectOutcome;
  listRuns(
    context: OmpToolContext,
    request: HistoryRunListRequest,
    signal?: AbortSignal,
  ): HistoryRunListOutcome;
  inspectRun(
    context: OmpToolContext,
    runSelector: string,
    signal?: AbortSignal,
  ): HistoryRunInspectOutcome;
  navigate(event: string): void;
  dispose(): void;
  status(): HistoryQueryStatus;
}

interface QueryScope {
  context: OmpToolContext;
  manager: OmpSessionManager;
  sessionId: string;
  file: string;
  entries: BranchEntry[];
  generation: number;
}

interface CandidateOccurrence {
  entryId: string;
  entryIndex: number;
  data: HistoryLocatorData | null;
  key: string | null;
  preReason: HistoryWithheldReason | null;
}

interface CandidateCollection {
  occurrences: CandidateOccurrence[];
  signature: string;
}

interface RunOccurrence {
  entryId: string;
  entryIndex: number;
  data: HistoryRunLocatorData | null;
  key: string | null;
  runKey: string | null;
  claimedHistoryId: string | null;
  preReason: HistoryRunWithheldReason | null;
}

interface RunCollection {
  occurrences: RunOccurrence[];
  signature: string;
}

interface IssuedRunSelector {
  entryId: string;
  key: string;
  runKey: string;
  taskSelector: string;
  taskEntryId: string;
  taskKey: string;
  signature: string;
  manager: OmpSessionManager;
}

interface RunCursorEntry {
  position: number;
  taskEntryId: string;
  taskKey: string;
  signature: string;
  manager: OmpSessionManager;
}

interface RunListingState {
  primaryByKey: Map<string, string>;
  cursors: Map<string, RunCursorEntry>;
}

interface RunSeal {
  collection: RunCollection;
  taskOccurrence: CandidateOccurrence;
  item: HistoryItem;
  runs: readonly RunOccurrence[];
}

interface RunAssociation {
  ok: boolean;
  reason?: HistoryRunWithheldReason;
}

interface TargetMetadata {
  path: string;
  kind: "directory" | "file" | "missing" | "other";
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface RootBase {
  stateRoot: string;
  instancesRoot: string;
  metadata: TargetMetadata[];
}

interface InstanceTarget {
  instanceId: string;
  instanceRoot: string;
  indexPath: string;
  metadata: TargetMetadata[];
}

interface InspectionCacheEntry {
  ok: boolean;
  reason?: HistoryWithheldReason;
  item?: HistoryItem;
  target?: InstanceTarget;
}

interface IssuedSelector {
  entryId: string;
  key: string;
}

interface ListingState {
  primaryByKey: Map<string, string>;
  cursors: Map<string, number>;
}

interface CurrentView {
  signature: string;
  generation: number;
  sessionId: string;
  file: string;
  selectors: Map<string, IssuedSelector>;
  selectorByKey: Map<string, string>;
  listing: ListingState;
  runSignature: string | undefined;
  runManager: OmpSessionManager | undefined;
  runSelectors: Map<string, IssuedRunSelector>;
  runSelectorByKey: Map<string, string>;
  runListing: RunListingState;
}

interface BudgetState {
  inspections: number;
  prechargedBytes: number;
  /** The precharge already covers this read as part of a whole action. */
  wholeActionPrecharge?: boolean;
}

interface SelectedRow {
  occurrence: CandidateOccurrence;
  item: HistoryItem;
}

interface Evaluated {
  ok: boolean;
  reason?: HistoryWithheldReason;
  item?: HistoryItem;
  fatal?: HistoryViewErrorCode;
}

function emptyWithheldReasons(): Record<HistoryWithheldReason, number> {
  return Object.fromEntries(WITHHELD_REASONS.map((reason) => [reason, 0])) as
    Record<HistoryWithheldReason, number>;
}

function emptyRunWithheldReasons(): Record<HistoryRunWithheldReason, number> {
  return Object.fromEntries(RUN_WITHHELD_REASONS.map((reason) => [reason, 0])) as
    Record<HistoryRunWithheldReason, number>;
}

function evidence(runEvidence: "checked" | "not_checked" = "not_checked"): HistoryViewEvidence {
  return {
    historical: true,
    authorityRestored: false,
    evidence: "local-record",
    recordedStatusScope: "at_capture",
    presentExecution: "not_checked",
    acceptanceEvidence: "not_checked",
    candidateRegistration: "not_checked",
    projection: {
      source: "local-record",
      branchVisibility: "not_checked",
      acceptanceEvidence: "not_checked",
      candidateRegistration: "not_checked",
    },
    bridge: {
      selectedBranch: "checked",
      requirementLedger: "checked",
      runEvidence,
    },
  };
}

function budgetView(budget: BudgetState): HistoryQueryBudgetView {
  return {
    inspections: budget.inspections,
    inspectionLimit: HISTORY_QUERY_INSPECTION_LIMIT,
    prechargedBytes: budget.prechargedBytes,
    bytesLimit: HISTORY_QUERY_READ_BUDGET_BYTES,
  };
}

function withinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function metadataOf(target: string): TargetMetadata {
  let info;
  try {
    info = lstatSync(target);
  } catch (error) {
    return {
      path: target,
      kind: errorCode(error) === "ENOENT" ? "missing" : "other",
      dev: 0,
      ino: 0,
      nlink: 0,
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
    };
  }
  return {
    path: target,
    kind: info.isSymbolicLink() ? "other" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function sameMetadata(left: TargetMetadata, right: TargetMetadata): boolean {
  return left.path === right.path
    && left.kind === right.kind
    && left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameMetadataList(left: readonly TargetMetadata[], right: readonly TargetMetadata[]): boolean {
  return left.length === right.length && left.every((entry, index) => sameMetadata(entry, right[index]!));
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  const expected = new Set(keys);
  return actual.every((key) => expected.has(key));
}

type ParsedLocator =
  | { ok: true; data: HistoryLocatorData }
  | { ok: false; reason: HistoryWithheldReason };

/**
 * Shape and length checks run before serializing the payload. This keeps a
 * hostile oversized value from forcing an unbounded JSON measurement.
 */
function parseLocatorData(value: unknown): ParsedLocator {
  const record = plainObject(value);
  if (record === null || !exactKeys(record, LOCATOR_KEYS)) {
    return { ok: false, reason: "locator_invalid" };
  }
  const version = record.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    return { ok: false, reason: "locator_invalid" };
  }
  if (version !== HISTORY_LOCATOR_VERSION) {
    return { ok: false, reason: "locator_unsupported" };
  }
  const instanceId = record.instanceId;
  if (typeof instanceId !== "string" || !SAFE_INSTANCE_COMPONENT.test(instanceId)) {
    return { ok: false, reason: "locator_invalid" };
  }
  const strings: Array<[string, string]> = [];
  for (const key of ["ownerId", "historyId", "digest", "taskId", "originSessionId"] as const) {
    const candidate = record[key];
    if (typeof candidate !== "string" || !IDENTIFIER.test(candidate)) {
      return { ok: false, reason: "locator_invalid" };
    }
    strings.push([key, candidate]);
  }
  const taskRevision = record.taskRevision;
  if (typeof taskRevision !== "number" || !Number.isSafeInteger(taskRevision) || taskRevision < 1) {
    return { ok: false, reason: "locator_invalid" };
  }
  const data: HistoryLocatorData = {
    version: HISTORY_LOCATOR_VERSION,
    instanceId,
    ownerId: strings[0]![1],
    historyId: strings[1]![1],
    digest: strings[2]![1],
    taskId: strings[3]![1],
    taskRevision,
    originSessionId: strings[4]![1],
  };
  let encoded: string;
  try {
    encoded = JSON.stringify(data);
  } catch {
    return { ok: false, reason: "locator_invalid" };
  }
  if (Buffer.byteLength(encoded, "utf8") > HISTORY_LOCATOR_DATA_BYTES_LIMIT) {
    return { ok: false, reason: "locator_invalid" };
  }
  return { ok: true, data };
}

function collectCandidates(
  entries: readonly BranchEntry[],
  sessionId: string,
): { ok: true; collection: CandidateCollection } | { ok: false; code: HistoryViewErrorCode } {
  const locatorEntries: Array<{ entry: BranchEntry; index: number }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const value = entry.value;
    if (entry.type === "custom" && value.customType === HISTORY_LOCATOR_CUSTOM_TYPE) {
      locatorEntries.push({ entry, index });
    }
  }
  if (locatorEntries.length > HISTORY_QUERY_CANDIDATE_LIMIT) {
    return { ok: false, code: "limit" };
  }
  const occurrences: CandidateOccurrence[] = locatorEntries.map(({ entry, index }) => {
    const parsed = parseLocatorData(entry.value.data);
    if (!parsed.ok) {
      return {
        entryId: entry.id,
        entryIndex: index,
        data: null,
        key: null,
        preReason: parsed.reason,
      };
    }
    if (parsed.data.originSessionId !== sessionId) {
      return {
        entryId: entry.id,
        entryIndex: index,
        data: null,
        key: null,
        preReason: "session_mismatch" as const,
      };
    }
    return {
      entryId: entry.id,
      entryIndex: index,
      data: parsed.data,
      key: JSON.stringify(parsed.data),
      preReason: null,
    };
  });

  // Every later occurrence is inspected before a page can mint a selector.
  const byHistoryId = new Map<string, CandidateOccurrence[]>();
  for (const occurrence of occurrences) {
    if (occurrence.data === null || occurrence.preReason !== null) continue;
    const list = byHistoryId.get(occurrence.data.historyId) ?? [];
    list.push(occurrence);
    byHistoryId.set(occurrence.data.historyId, list);
  }
  for (const list of byHistoryId.values()) {
    if (new Set(list.map((occurrence) => occurrence.key)).size <= 1) continue;
    for (const occurrence of list) occurrence.preReason = "locator_conflict";
  }

  const signature = occurrences.map((occurrence) =>
    `${occurrence.entryId}\0${occurrence.entryIndex}\0${occurrence.key ?? occurrence.preReason ?? "invalid"}`,
  ).join("\n");
  return { ok: true, collection: { occurrences, signature } };
}

function parseRunLocatorData(
  value: unknown,
): { ok: true; data: HistoryRunLocatorData } | { ok: false; reason: HistoryRunWithheldReason } {
  const record = plainObject(value);
  if (record === null || !exactKeys(record, RUN_LOCATOR_KEYS)) {
    return { ok: false, reason: "run_locator_invalid" };
  }
  const version = record.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    return { ok: false, reason: "run_locator_invalid" };
  }
  if (version !== HISTORY_RUN_LOCATOR_VERSION) {
    return { ok: false, reason: "run_locator_unsupported" };
  }
  const instanceId = record.instanceId;
  if (typeof instanceId !== "string" || !SAFE_INSTANCE_COMPONENT.test(instanceId)) {
    return { ok: false, reason: "run_locator_invalid" };
  }
  const identifiers: Array<[string, string]> = [];
  for (const key of ["ownerId", "historyId", "digest", "taskId", "originSessionId"] as const) {
    const candidate = record[key];
    if (typeof candidate !== "string" || !IDENTIFIER.test(candidate)) {
      return { ok: false, reason: "run_locator_invalid" };
    }
    identifiers.push([key, candidate]);
  }
  const taskRevision = record.taskRevision;
  if (typeof taskRevision !== "number" || !Number.isSafeInteger(taskRevision) || taskRevision < 1) {
    return { ok: false, reason: "run_locator_invalid" };
  }
  const requirementsDigest = record.requirementsDigest;
  if (typeof requirementsDigest !== "string" || !BOUNDED_RUN_IDENTITY.test(requirementsDigest)) {
    return { ok: false, reason: "run_locator_invalid" };
  }
  const runId = record.runId;
  const callId = record.callId;
  const runDirectory = record.runDirectory;
  if (typeof runId !== "string" || !SAFE_RUN_TOKEN.test(runId)
    || typeof callId !== "string" || !SAFE_RUN_TOKEN.test(callId)
    || typeof runDirectory !== "string" || !SAFE_RUN_TOKEN.test(runDirectory)) {
    return { ok: false, reason: "run_locator_invalid" };
  }
  const artifactIdsValue = record.artifactIds;
  if (!Array.isArray(artifactIdsValue) || artifactIdsValue.length > HISTORY_RUN_ARTIFACT_LIMIT) {
    return { ok: false, reason: "run_locator_invalid" };
  }
  const artifactIds: string[] = [];
  const seen = new Set<string>();
  for (const artifactId of artifactIdsValue) {
    if (typeof artifactId !== "string" || !SAFE_RUN_TOKEN.test(artifactId) || seen.has(artifactId)) {
      return { ok: false, reason: "run_locator_invalid" };
    }
    seen.add(artifactId);
    artifactIds.push(artifactId);
  }
  if (record.recordWriteReturned !== true
    || record.byteIntegrity !== "not_checked"
    || record.authorityRestored !== false) {
    return { ok: false, reason: "run_locator_invalid" };
  }
  const data: HistoryRunLocatorData = {
    version: HISTORY_RUN_LOCATOR_VERSION,
    instanceId,
    ownerId: identifiers[0]![1],
    historyId: identifiers[1]![1],
    digest: identifiers[2]![1],
    taskId: identifiers[3]![1],
    taskRevision,
    requirementsDigest,
    originSessionId: identifiers[4]![1],
    runId,
    callId,
    runDirectory,
    artifactIds,
    recordWriteReturned: true,
    byteIntegrity: "not_checked",
    authorityRestored: false,
  };
  let encoded: string;
  try {
    encoded = JSON.stringify(data);
  } catch {
    return { ok: false, reason: "run_locator_invalid" };
  }
  if (Buffer.byteLength(encoded, "utf8") > HISTORY_RUN_LOCATOR_DATA_BYTES_LIMIT) {
    return { ok: false, reason: "run_locator_invalid" };
  }
  return { ok: true, data };
}

function runReferenceKey(data: HistoryRunLocatorData): string {
  return [data.ownerId, data.taskId, data.taskRevision, data.runId, data.callId].join("\u0000");
}

/** Diagnostics only; malformed locator payloads are still strictly refused. */
function claimedHistoryIdOf(value: unknown): string | null {
  const record = plainObject(value);
  if (record === null) return null;
  const historyId = record.historyId;
  return typeof historyId === "string"
    && historyId.length > 0
    && historyId.length <= 128
    && !historyId.includes("\u0000")
    ? historyId
    : null;
}

function collectRunCandidates(
  entries: readonly BranchEntry[],
  sessionId: string,
): { ok: true; collection: RunCollection } | { ok: false; code: HistoryViewErrorCode } {
  const runEntries: Array<{ entry: BranchEntry; index: number }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type === "custom" && entry.value.customType === HISTORY_RUN_LOCATOR_CUSTOM_TYPE) {
      runEntries.push({ entry, index });
    }
  }
  if (runEntries.length > HISTORY_QUERY_RUN_CANDIDATE_LIMIT) {
    return { ok: false, code: "limit" };
  }
  const occurrences: RunOccurrence[] = runEntries.map(({ entry, index }) => {
    const parsed = parseRunLocatorData(entry.value.data);
    if (!parsed.ok) {
      return {
        entryId: entry.id,
        entryIndex: index,
        data: null,
        key: null,
        runKey: null,
        claimedHistoryId: claimedHistoryIdOf(entry.value.data),
        preReason: parsed.reason,
      };
    }
    if (parsed.data.originSessionId !== sessionId) {
      return {
        entryId: entry.id,
        entryIndex: index,
        data: parsed.data,
        key: JSON.stringify(parsed.data),
        runKey: runReferenceKey(parsed.data),
        claimedHistoryId: parsed.data.historyId,
        preReason: "run_session_mismatch",
      };
    }
    return {
      entryId: entry.id,
      entryIndex: index,
      data: parsed.data,
      key: JSON.stringify(parsed.data),
      runKey: runReferenceKey(parsed.data),
      claimedHistoryId: parsed.data.historyId,
      preReason: null,
    };
  });

  // The complete bounded run collection is parsed and conflict-checked before
  // any page mints a selector, so a later conflict cannot hide behind paging.
  const byReference = new Map<string, RunOccurrence[]>();
  for (const occurrence of occurrences) {
    if (occurrence.data === null || occurrence.runKey === null) continue;
    const list = byReference.get(occurrence.runKey) ?? [];
    list.push(occurrence);
    byReference.set(occurrence.runKey, list);
  }
  for (const list of byReference.values()) {
    if (new Set(list.map((occurrence) => occurrence.key)).size <= 1) continue;
    for (const occurrence of list) occurrence.preReason = "run_conflict";
  }

  // A malformed locator's claimed history still assigns it to a selected
  // task, so the bounded claim is part of the complete run collection.
  const signature = occurrences.map((occurrence) =>
    `${occurrence.entryId}\0${occurrence.entryIndex}\0${JSON.stringify(occurrence.claimedHistoryId)}\0${occurrence.key ?? occurrence.preReason ?? "invalid"}`,
  ).join("\n");
  return { ok: true, collection: { occurrences, signature } };
}

function rawHistoryId(value: unknown): unknown {
  const record = plainObject(value);
  return record === null ? undefined : record.historyId;
}

/** Task identity excluding origin session, which has its own explicit reason. */
function runClaimsTask(
  item: HistoryItem,
  taskData: HistoryLocatorData,
  data: HistoryRunLocatorData,
): boolean {
  return data.instanceId === taskData.instanceId
    && data.ownerId === taskData.ownerId
    && data.historyId === item.historyId
    && data.digest === item.digest
    && data.taskId === item.taskId
    && data.taskRevision === item.taskRevision
    && data.requirementsDigest === item.requirementsDigest;
}

function sameTaskLocatorData(
  value: unknown,
  expected: Record<string, unknown>,
): boolean {
  const record = plainObject(value);
  if (record === null || !exactKeys(record, LOCATOR_KEYS)) return false;
  return LOCATOR_KEYS.every((key) => record[key] === expected[key]);
}

function taskLocatorForRun(
  item: HistoryItem,
  taskData: HistoryLocatorData,
  entries: readonly BranchEntry[],
  sessionId: string,
  runIndex: number,
): RunAssociation {
  const expected: Record<string, unknown> = {
    version: HISTORY_LOCATOR_VERSION,
    instanceId: taskData.instanceId,
    ownerId: taskData.ownerId,
    historyId: item.historyId,
    digest: item.digest,
    taskId: item.taskId,
    taskRevision: item.taskRevision,
    originSessionId: item.anchor.sessionId,
  };
  const exact: number[] = [];
  const claiming: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || entry.value.customType !== HISTORY_LOCATOR_CUSTOM_TYPE) continue;
    if (sameTaskLocatorData(entry.value.data, expected)) exact.push(index);
    if (rawHistoryId(entry.value.data) === item.historyId) claiming.push(index);
  }
  if (exact.length === 0 && claiming.length === 0) {
    return { ok: false, reason: "run_task_locator_missing" };
  }
  if (exact.length !== 1 || claiming.length !== exact.length) {
    return { ok: false, reason: "run_task_locator_conflict" };
  }
  const index = exact[0]!;
  if (!ledgerMatches(item, entries, index, sessionId)) {
    return { ok: false, reason: "run_source_mismatch" };
  }
  if (index >= runIndex) return { ok: false, reason: "run_task_order" };
  return { ok: true };
}

function associateRun(
  item: HistoryItem,
  taskData: HistoryLocatorData,
  occurrence: RunOccurrence,
  entries: readonly BranchEntry[],
  sessionId: string,
): RunAssociation {
  if (occurrence.data === null) {
    return { ok: false, reason: occurrence.preReason ?? "run_locator_invalid" };
  }
  if (!runClaimsTask(item, taskData, occurrence.data)) {
    return { ok: false, reason: "run_task_mismatch" };
  }
  if (occurrence.preReason !== null) return { ok: false, reason: occurrence.preReason };
  return taskLocatorForRun(item, taskData, entries, sessionId, occurrence.entryIndex);
}

function associatedRunOccurrences(
  collection: RunCollection,
  item: HistoryItem,
  taskData: HistoryLocatorData,
  entries: readonly BranchEntry[],
  sessionId: string,
): RunOccurrence[] {
  const candidates: RunOccurrence[] = [];
  for (const occurrence of collection.occurrences) {
    if (occurrence.claimedHistoryId !== item.historyId) continue;
    const association = associateRun(item, taskData, occurrence, entries, sessionId);
    candidates.push(association.ok ? occurrence : { ...occurrence, preReason: association.reason! });
  }
  return candidates;
}

function exactlyEqualStringSets(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function pairKey(taskEntryId: string, runKey: string): string {
  return `${taskEntryId}\u0000${runKey}`;
}

function ledgerMatches(
  item: HistoryItem,
  entries: readonly BranchEntry[],
  locatorIndex: number,
  sessionId: string,
): boolean {
  if (item.anchor.sessionId !== sessionId) return false;
  const sources = item.requirementSources;
  if (sources.length < 1 || sources.length !== item.taskRevision) return false;
  const original = sources[0]!;
  if (original.kind !== "original"
    || original.revision !== 1
    || original.previousRevision !== null
    || original.messageId !== item.anchor.messageId
    || original.sessionId !== item.anchor.sessionId
    || original.source !== item.anchor.source
    || original.observedAt !== item.anchor.observedAt) {
    return false;
  }
  const byId = new Map<string, { entry: BranchEntry; index: number }>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    byId.set(entry.id, { entry, index });
  }
  const seen = new Set<string>();
  let previousIndex = -1;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    if (index === 0) {
      if (source.kind !== "original") return false;
    } else if (source.kind !== "amendment"
      || source.revision !== index + 1
      || source.previousRevision !== index) {
      return false;
    }
    if (source.sessionId !== sessionId) return false;
    if (seen.has(source.messageId)) return false;
    seen.add(source.messageId);
    const found = byId.get(source.messageId);
    if (found === undefined) return false;
    // The complete ledger must come strictly before this occurrence.
    if (found.index >= locatorIndex) return false;
    if (found.index <= previousIndex) return false;
    previousIndex = found.index;
    const text = genuineUserText(found.entry);
    if (text === undefined) return false;
    if (text.trim() !== source.text.trim()) return false;
  }
  return true;
}

function mapProjectionError(error: unknown): HistoryWithheldReason {
  if (!(error instanceof HistoryProjectionError)) return "history_unknown";
  switch (error.code) {
    case "not-found": return "history_missing";
    case "conflict": return "history_conflict";
    case "limit": return "history_limit";
    case "too-large": return "history_too_large";
    case "unsupported": return "history_unsupported";
    case "unavailable": return "history_unavailable";
    case "changed": return "history_changed";
    case "mismatch": return "history_mismatch";
    case "invalid": return "history_invalid";
    case "write-failed": return "history_unavailable";
    case "unknown": return "history_unknown";
    default: return "history_unknown";
  }
}

function sameLocatorIdentity(item: HistoryItem, data: HistoryLocatorData): boolean {
  return item.historyId === data.historyId
    && item.digest === data.digest
    && item.taskId === data.taskId
    && item.taskRevision === data.taskRevision
    && item.anchor.sessionId === data.originSessionId;
}

function readScope(workspaceRoot: string, context: OmpToolContext): { ok: true; scope: QueryScope } | { ok: false; code: HistoryViewErrorCode } {
  if (context.agent?.kind !== "main") return { ok: false, code: "main_only" };
  let cwd: string;
  try {
    cwd = canonicalWorkspaceRoot(context.cwd);
  } catch {
    return { ok: false, code: "workspace_mismatch" };
  }
  if (cwd !== workspaceRoot) return { ok: false, code: "workspace_mismatch" };
  const manager = context.sessionManager;
  if (manager === undefined
    || typeof manager.getSessionId !== "function"
    || typeof manager.getLeafId !== "function"
    || typeof manager.getBranch !== "function"
    || typeof manager.getSessionFile !== "function") {
    return { ok: false, code: "session_unavailable" };
  }
  try {
    const sessionId = manager.getSessionId();
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return { ok: false, code: "session_unavailable" };
    }
    const file = manager.getSessionFile();
    if (typeof file !== "string" || file.length === 0) {
      return { ok: false, code: "session_unavailable" };
    }
    const leafId = manager.getLeafId();
    if (typeof leafId !== "string" || leafId.length === 0) {
      return { ok: false, code: "session_unavailable" };
    }
    const branch = manager.getBranch();
    // A getBranch implementation may synchronously switch the real session or
    // file. The values sampled before that call are not trusted for the final
    // comparison without one post-getter identity read.
    let afterSessionId: string;
    let afterFile: string | undefined;
    try {
      afterSessionId = manager.getSessionId();
      afterFile = manager.getSessionFile();
    } catch {
      return { ok: false, code: "scope_changed" };
    }
    if (context.sessionManager !== manager
      || afterSessionId !== sessionId
      || afterFile !== file) {
      return { ok: false, code: "scope_changed" };
    }
    if (!Array.isArray(branch) || branch.length === 0) {
      return { ok: false, code: "branch_invalid" };
    }
    if (branch.length > HISTORY_QUERY_BRANCH_ENTRY_LIMIT) {
      return { ok: false, code: "limit" };
    }
    let entries: BranchEntry[];
    try {
      entries = parseBranch(branch);
    } catch {
      return { ok: false, code: "branch_invalid" };
    }
    for (let index = 0; index < entries.length; index += 1) {
      const expectedParent = index === 0 ? null : entries[index - 1]!.id;
      if (entries[index]!.parentId !== expectedParent) {
        return { ok: false, code: "branch_invalid" };
      }
    }
    if (entries[entries.length - 1]!.id !== leafId) {
      return { ok: false, code: "branch_invalid" };
    }
    return {
      ok: true,
      scope: { context, manager, sessionId, file, entries, generation: 0 },
    };
  } catch {
    return { ok: false, code: "session_unavailable" };
  }
}

function readRootBase(stateRoot: string): { ok: true; base: RootBase } | { ok: false } {
  const stateMeta = metadataOf(stateRoot);
  if (stateMeta.kind !== "directory") return { ok: false };
  try {
    if (realpathSync(stateRoot) !== stateRoot) return { ok: false };
  } catch {
    return { ok: false };
  }
  const instancesRoot = path.join(stateRoot, "instances");
  if (!withinOrEqual(stateRoot, instancesRoot)) return { ok: false };
  const instancesMeta = metadataOf(instancesRoot);
  if (instancesMeta.kind !== "directory") return { ok: false };
  try {
    if (realpathSync(instancesRoot) !== instancesRoot) return { ok: false };
  } catch {
    return { ok: false };
  }
  return {
    ok: true,
    base: { stateRoot, instancesRoot, metadata: [stateMeta, instancesMeta] },
  };
}

function readInstanceTarget(
  base: RootBase,
  instanceId: string,
): { ok: true; target: InstanceTarget } | { ok: false; reason: HistoryWithheldReason } {
  if (!SAFE_INSTANCE_COMPONENT.test(instanceId)) {
    return { ok: false, reason: "locator_invalid" };
  }
  const instanceRoot = path.join(base.instancesRoot, instanceId);
  if (path.dirname(instanceRoot) !== base.instancesRoot
    || !withinOrEqual(base.stateRoot, instanceRoot)
    || !withinOrEqual(base.instancesRoot, instanceRoot)) {
    return { ok: false, reason: "instance_unsafe" };
  }
  let canonical: string;
  try {
    canonical = realpathSync(instanceRoot);
  } catch (error) {
    return {
      ok: false,
      reason: errorCode(error) === "ENOENT" ? "instance_unavailable" : "instance_unsafe",
    };
  }
  if (canonical !== instanceRoot) return { ok: false, reason: "instance_unsafe" };
  const rootMeta = metadataOf(instanceRoot);
  if (rootMeta.kind === "missing") return { ok: false, reason: "instance_unavailable" };
  if (rootMeta.kind !== "directory") return { ok: false, reason: "instance_unsafe" };
  const indexPath = path.join(instanceRoot, "history-index.json");
  const fileMeta = metadataOf(indexPath);
  if (fileMeta.kind === "missing") return { ok: false, reason: "history_missing" };
  if (fileMeta.kind !== "file" || fileMeta.nlink !== 1) {
    return { ok: false, reason: "instance_unsafe" };
  }
  try {
    if (realpathSync(indexPath) !== indexPath) return { ok: false, reason: "instance_unsafe" };
  } catch {
    return { ok: false, reason: "instance_unsafe" };
  }
  return {
    ok: true,
    target: {
      instanceId,
      instanceRoot,
      indexPath,
      metadata: [...base.metadata, rootMeta, fileMeta],
    },
  };
}

function finalTargetMetadata(
  base: RootBase,
  target: InstanceTarget,
): TargetMetadata[] | undefined {
  const rootMeta = metadataOf(target.instanceRoot);
  if (rootMeta.kind !== "directory") return undefined;
  const fileMeta = metadataOf(target.indexPath);
  if (fileMeta.kind !== "file" || fileMeta.nlink !== 1) return undefined;
  return [...base.metadata, rootMeta, fileMeta];
}

function encodeSelector(): string {
  return `hsel_${randomUUID().replaceAll("-", "")}`;
}

function encodeCursor(): string {
  return `hcur_${randomUUID().replaceAll("-", "")}`;
}

function encodeRunSelector(): string {
  return `hrun_${randomUUID().replaceAll("-", "")}`;
}

function encodeRunCursor(): string {
  return `hrcur_${randomUUID().replaceAll("-", "")}`;
}

function uniqueRunSelector(existing: ReadonlyMap<string, unknown>): string | undefined {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const selector = encodeRunSelector();
    if (!existing.has(selector)) return selector;
  }
  return undefined;
}

function runCursorForPosition(
  listing: RunListingState,
  position: number,
  taskEntryId: string,
  taskKey: string,
  signature: string,
  manager: OmpSessionManager,
): string | undefined {
  for (const [cursor, value] of listing.cursors) {
    if (value.position === position
      && value.taskEntryId === taskEntryId
      && value.taskKey === taskKey
      && value.signature === signature) {
      return cursor;
    }
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const cursor = encodeRunCursor();
    if (listing.cursors.has(cursor)) continue;
    listing.cursors.set(cursor, { position, taskEntryId, taskKey, signature, manager });
    return cursor;
  }
  return undefined;
}

function cursorForPosition(listing: ListingState, position: number): string {
  for (const [cursor, value] of listing.cursors) {
    if (value === position) return cursor;
  }
  const cursor = encodeCursor();
  listing.cursors.set(cursor, position);
  return cursor;
}

function ledgerSourceComplete(item: HistoryItem): boolean {
  if (!Array.isArray(item.requirementSources) || item.requirementSources.length < 1) return false;
  if (item.requirementSources.length !== item.taskRevision) return false;
  return item.requirementSources.every((source) => {
    const record = plainObject(source);
    return record !== null && exactKeys(record, SOURCE_LEDGER_KEYS);
  });
}

class HistoryView implements HistoryViewControls {
  private readonly stateRoot: string;
  private readonly workspaceRoot: string;
  private readonly isCurrentComposition: () => boolean;
  private disposed = false;
  private generation = 0;
  private current: CurrentView | undefined;
  private lastError: HistoryViewErrorCode | null = null;

  constructor(options: HistoryViewOptions) {
    this.stateRoot = options.stateRoot;
    this.workspaceRoot = options.workspaceRoot;
    this.isCurrentComposition = options.isCurrentComposition;
  }

  status(): HistoryQueryStatus {
    return {
      disposed: this.disposed,
      view: this.current === undefined ? "none" : "active",
      selectors: (this.current?.selectors.size ?? 0) + (this.current?.runSelectors.size ?? 0),
      generation: this.generation,
      lastError: this.lastError,
    };
  }

  navigate(_event: string): void {
    if (this.disposed) return;
    this.generation += 1;
    this.current = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.current = undefined;
  }

  private fail(code: HistoryViewErrorCode): { ok: false; code: HistoryViewErrorCode } {
    this.lastError = code;
    return { ok: false, code };
  }

  private compositionActive(): boolean {
    try {
      return this.isCurrentComposition() === true;
    } catch {
      return false;
    }
  }

  private checkComposition(): { ok: true } | { ok: false; code: HistoryViewErrorCode } {
    if (this.disposed) return { ok: false, code: "disposed" };
    if (!this.compositionActive()) {
      this.current = undefined;
      return { ok: false, code: "composition_changed" };
    }
    return { ok: true };
  }

  private invalidateForFailure(failure: HistoryViewErrorCode): void {
    if (failure !== "aborted" && failure !== "budget_exhausted") this.current = undefined;
  }

  private inspectOccurrence(
    occurrence: CandidateOccurrence,
    scope: QueryScope,
    base: RootBase,
    budget: BudgetState,
    cache: Map<string, InspectionCacheEntry>,
  ): Evaluated {
    if (occurrence.preReason !== null) {
      return { ok: false, reason: occurrence.preReason };
    }
    const data = occurrence.data!;
    const key = occurrence.key!;
    let cached = cache.get(key);
    if (cached === undefined) {
      const resolved = readInstanceTarget(base, data.instanceId);
      if (!resolved.ok) {
        cached = { ok: false, reason: resolved.reason };
      } else if (budget.inspections >= HISTORY_QUERY_INSPECTION_LIMIT
        || budget.prechargedBytes
          + (budget.wholeActionPrecharge === true ? 0 : HISTORY_FILE_BYTES_LIMIT)
          > HISTORY_QUERY_READ_BUDGET_BYTES) {
        return { ok: false, fatal: "budget_exhausted" };
      } else {
        // The whole-action precharge already includes this task read; do not
        // double count it, but still account for the inspection itself.
        budget.inspections += 1;
        if (budget.wholeActionPrecharge !== true) {
          budget.prechargedBytes += HISTORY_FILE_BYTES_LIMIT;
        }
        const target = resolved.target;
        const selector: HistoryInspectSelector = {
          historyId: data.historyId,
          digest: data.digest,
          expectedOwnerId: data.ownerId,
          expectedTaskId: data.taskId,
          expectedTaskRevision: data.taskRevision,
        };
        let item: HistoryItem;
        try {
          const reader = createHistoryProjectionReader({
            instanceRoot: target.instanceRoot,
            instanceId: data.instanceId,
            ownerId: data.ownerId,
            workspaceRoot: this.workspaceRoot,
          });
          const inspection = reader.inspect(selector);
          if (inspection.itemDigestMatchesContent !== true
            || inspection.instance !== data.instanceId
            || inspection.owner !== data.ownerId
            || inspection.workspace !== this.workspaceRoot
            || !sameLocatorIdentity(inspection.item, data)) {
            cached = { ok: false, reason: "history_mismatch" };
          } else {
            item = inspection.item;
            const after = finalTargetMetadata(base, target);
            if (after === undefined || !sameMetadataList(target.metadata, after)) {
              cached = { ok: false, reason: "history_changed" };
            } else {
              cached = { ok: true, item, target };
            }
          }
        } catch (error) {
          cached = { ok: false, reason: mapProjectionError(error) };
        }
      }
      cache.set(key, cached);
    }
    if (cached.reason !== undefined || cached.item === undefined) {
      return { ok: false, reason: cached.reason ?? "history_unavailable" };
    }
    if (!ledgerSourceComplete(cached.item)
      || !ledgerMatches(cached.item, scope.entries, occurrence.entryIndex, scope.sessionId)) {
      return { ok: false, reason: "source_mismatch" };
    }
    return { ok: true, item: cached.item };
  }

  private verifyFresh(
    scope: QueryScope,
    base: RootBase,
    collection: CandidateCollection,
    view: CurrentView,
    rows: readonly SelectedRow[],
    cache: ReadonlyMap<string, InspectionCacheEntry>,
    signal: AbortSignal | undefined,
    runSeal?: RunSeal,
  ): HistoryViewErrorCode | undefined {
    if (this.disposed) return "disposed";
    if (hostAborted(signal)) return "aborted";
    if (this.generation !== view.generation) return "new_list_required";

    // The last host callback runs here. Returning true does not prove it left
    // the actual branch, session or projection file unchanged, so every final
    // read and comparison below happens after it. No host callback runs after
    // those checks; only internal state and the native abort flag remain.
    if (!this.compositionActive()) return "composition_changed";
    if (this.generation !== view.generation) return "new_list_required";

    const direct = readScope(this.workspaceRoot, scope.context);
    if (!direct.ok) return "scope_changed";
    const finalScope = direct.scope;
    if (finalScope.manager !== scope.manager
      || finalScope.sessionId !== scope.sessionId
      || finalScope.file !== scope.file) {
      return "scope_changed";
    }

    for (let index = 0; index < scope.entries.length; index += 1) {
      const finalEntry = finalScope.entries[index];
      if (finalEntry === undefined
        || finalEntry.id !== scope.entries[index]!.id
        || finalEntry.parentId !== scope.entries[index]!.parentId) {
        return "scope_changed";
      }
    }

    const finalCollection = collectCandidates(finalScope.entries, finalScope.sessionId);
    if (!finalCollection.ok) {
      return finalCollection.code === "limit" ? "limit" : "scope_changed";
    }
    if (finalCollection.collection.signature !== collection.signature
      || finalCollection.collection.signature !== view.signature) {
      return "new_list_required";
    }

    for (const row of rows) {
      const finalOccurrence = finalCollection.collection.occurrences.find(
        (occurrence) => occurrence.entryId === row.occurrence.entryId,
      );
      if (finalOccurrence === undefined
        || finalOccurrence.key !== row.occurrence.key
        || !ledgerMatches(row.item, finalScope.entries, finalOccurrence.entryIndex, finalScope.sessionId)) {
        return "scope_changed";
      }
    }

    if (runSeal !== undefined) {
      if (view.runSignature !== runSeal.collection.signature) return "new_list_required";
      const finalRuns = collectRunCandidates(finalScope.entries, finalScope.sessionId);
      if (!finalRuns.ok) return finalRuns.code === "limit" ? "limit" : "scope_changed";
      if (finalRuns.collection.signature !== runSeal.collection.signature) {
        return "new_list_required";
      }
      const finalTask = finalCollection.collection.occurrences.find(
        (occurrence) => occurrence.entryId === runSeal.taskOccurrence.entryId,
      );
      if (finalTask === undefined
        || finalTask.key !== runSeal.taskOccurrence.key
        || finalTask.data === null
        || !ledgerMatches(runSeal.item, finalScope.entries, finalTask.entryIndex, finalScope.sessionId)) {
        return "scope_changed";
      }
      for (const run of runSeal.runs) {
        const finalRun = finalRuns.collection.occurrences.find(
          (occurrence) => occurrence.entryId === run.entryId,
        );
        if (finalRun === undefined || finalRun.key !== run.key) return "scope_changed";
        const association = associateRun(
          runSeal.item,
          finalTask.data,
          finalRun,
          finalScope.entries,
          finalScope.sessionId,
        );
        if (!association.ok) return "scope_changed";
      }
    }

    const finalBase = readRootBase(this.stateRoot);
    if (!finalBase.ok || !sameMetadataList(base.metadata, finalBase.base.metadata)) {
      return "scope_changed";
    }
    for (const cached of cache.values()) {
      if (!cached.ok || cached.target === undefined) continue;
      const metadata = finalTargetMetadata(finalBase.base, cached.target);
      if (metadata === undefined || !sameMetadataList(cached.target.metadata, metadata)) {
        return "scope_changed";
      }
    }

    // The native abort fact is sampled after the final host getter and file
    // metadata checks; only pure internal state remains afterwards.
    if (hostAborted(signal)) return "aborted";
    if (this.disposed) return "disposed";
    if (this.generation !== view.generation) return "new_list_required";
    return undefined;
  }

  private resetRunState(view: CurrentView, signature: string): void {
    view.runSignature = signature;
    view.runSelectors.clear();
    view.runSelectorByKey.clear();
    view.runListing.primaryByKey.clear();
    view.runListing.cursors.clear();
  }

  private resolveTaskSelection(
    taskSelector: string,
    scope: QueryScope,
    base: RootBase,
    budget: BudgetState,
    cache: Map<string, InspectionCacheEntry>,
  ): {
    ok: true;
    occurrence: CandidateOccurrence;
    item: HistoryItem;
    taskData: HistoryLocatorData;
    target: InstanceTarget;
  } | {
    ok: false;
    code: HistoryViewErrorCode;
    reason?: HistoryWithheldReason | HistoryRunWithheldReason;
  } {
    if (!HISTORY_SELECTOR_PATTERN.test(taskSelector)) {
      return { ok: false, code: "unknown_selector" };
    }
    const view = this.current;
    if (view === undefined) return { ok: false, code: "new_list_required" };
    const issued = view.selectors.get(taskSelector);
    if (issued === undefined) return { ok: false, code: "unknown_selector" };
    const taskCollection = collectCandidates(scope.entries, scope.sessionId);
    if (!taskCollection.ok) return { ok: false, code: taskCollection.code };
    const occurrence = taskCollection.collection.occurrences.find(
      (candidate) => candidate.entryId === issued.entryId && candidate.key === issued.key,
    );
    if (occurrence === undefined) {
      this.current = undefined;
      return { ok: false, code: "new_list_required" };
    }
    const evaluated = this.inspectOccurrence(occurrence, scope, base, budget, cache);
    if (evaluated.fatal !== undefined) return { ok: false, code: evaluated.fatal };
    if (!evaluated.ok) {
      return {
        ok: false,
        code: "withheld",
        reason: evaluated.reason ?? "history_unavailable",
      };
    }
    if (evaluated.item!.recordedStatus !== "active") {
      return { ok: false, code: "withheld", reason: "run_task_inactive" };
    }
    if (occurrence.data === null) {
      return { ok: false, code: "withheld", reason: "run_task_locator_missing" };
    }
    const cached = cache.get(occurrence.key!);
    if (cached === undefined || !cached.ok || cached.target === undefined) {
      return { ok: false, code: "withheld", reason: "run_task_locator_missing" };
    }
    return {
      ok: true,
      occurrence,
      item: evaluated.item!,
      taskData: occurrence.data,
      target: cached.target,
    };
  }

  list(
    context: OmpToolContext,
    request: HistoryListRequest,
    signal?: AbortSignal,
  ): HistoryListOutcome {
    if (this.disposed) return this.fail("disposed");
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > HISTORY_QUERY_PAGE_LIMIT) {
      return this.fail("invalid_arguments");
    }
    if (request.cursor !== undefined && !HISTORY_CURSOR_PATTERN.test(request.cursor)) {
      return this.fail("cursor_invalid");
    }
    if (hostAborted(signal)) return this.fail("aborted");
    const composition = this.checkComposition();
    if (!composition.ok) return this.fail(composition.code);

    const startGeneration = this.generation;
    const scopeResult = readScope(this.workspaceRoot, context);
    if (!scopeResult.ok) return this.fail(scopeResult.code);
    if (this.generation !== startGeneration) {
      this.current = undefined;
      return this.fail("new_list_required");
    }
    const scope = { ...scopeResult.scope, generation: this.generation };
    const baseResult = readRootBase(this.stateRoot);
    if (!baseResult.ok) {
      this.current = undefined;
      return this.fail("unavailable");
    }
    const collection = collectCandidates(scope.entries, scope.sessionId);
    if (!collection.ok) {
      this.current = undefined;
      return this.fail(collection.code);
    }

    let view = this.current;
    if (view !== undefined
      && (view.generation !== this.generation
        || view.signature !== collection.collection.signature
        || view.sessionId !== scope.sessionId
        || view.file !== scope.file)) {
      this.current = undefined;
      view = undefined;
    }
    let start: number;
    if (request.cursor !== undefined) {
      if (view === undefined) return this.fail("new_list_required");
      const position = view.listing.cursors.get(request.cursor);
      if (position === undefined) return this.fail("cursor_invalid");
      start = position;
    } else {
      if (view === undefined) {
        view = {
          signature: collection.collection.signature,
          generation: this.generation,
          sessionId: scope.sessionId,
          file: scope.file,
          selectors: new Map(),
          selectorByKey: new Map(),
          listing: { primaryByKey: new Map(), cursors: new Map() },
          runSignature: undefined,
          runManager: undefined,
          runSelectors: new Map(),
          runSelectorByKey: new Map(),
          runListing: { primaryByKey: new Map(), cursors: new Map() },
        };
        this.current = view;
      }
      start = 0;
    }
    const occurrences = collection.collection.occurrences;
    if (start > occurrences.length || (request.cursor !== undefined && start >= occurrences.length)) {
      return this.fail("cursor_invalid");
    }
    const window = occurrences.slice(start, start + request.limit);
    const budget: BudgetState = { inspections: 0, prechargedBytes: 0 };
    const cache = new Map<string, InspectionCacheEntry>();
    const primary = new Map(view.listing.primaryByKey);
    const withheldReasons = emptyWithheldReasons();
    const rows: SelectedRow[] = [];
    let withheld = 0;
    let duplicates = 0;
    let fatal: HistoryViewErrorCode | undefined;

    for (const occurrence of window) {
      if (hostAborted(signal)) {
        fatal = "aborted";
        break;
      }
      const evaluated = this.inspectOccurrence(occurrence, scope, baseResult.base, budget, cache);
      if (evaluated.fatal !== undefined) {
        fatal = evaluated.fatal;
        break;
      }
      if (!evaluated.ok) {
        const reason = evaluated.reason ?? "history_unavailable";
        withheldReasons[reason] += 1;
        withheld += 1;
        if (occurrence.key !== null && primary.get(occurrence.key) === occurrence.entryId) {
          // A row already returned in this listing cannot silently turn into
          // a withheld duplicate; the observable view changed.
          fatal = "scope_changed";
          break;
        }
        continue;
      }
      const key = occurrence.key!;
      const existing = primary.get(key);
      if (existing === undefined) {
        primary.set(key, occurrence.entryId);
        rows.push({ occurrence, item: evaluated.item! });
      } else if (existing === occurrence.entryId) {
        // Repeated cursor rereads the same primary page row.
        rows.push({ occurrence, item: evaluated.item! });
      } else {
        duplicates += 1;
      }
    }

    if (fatal !== undefined) {
      if (fatal === "scope_changed") this.current = undefined;
      return this.fail(fatal);
    }

    const failure = this.verifyFresh(
      scope,
      baseResult.base,
      collection.collection,
      view,
      rows,
      cache,
      signal,
    );
    if (failure !== undefined) {
      this.invalidateForFailure(failure);
      return this.fail(failure);
    }

    view.listing.primaryByKey = primary;
    const items: HistoryListSummary[] = rows.map((row) => {
      const key = row.occurrence.key!;
      let selector = view!.selectorByKey.get(key);
      const issued = selector === undefined ? undefined : view!.selectors.get(selector);
      if (selector === undefined || issued === undefined || issued.entryId !== row.occurrence.entryId) {
        selector = encodeSelector();
        view!.selectorByKey.set(key, selector);
        view!.selectors.set(selector, { entryId: row.occurrence.entryId, key });
      }
      return {
        selector,
        historyId: row.item.historyId,
        digest: row.item.digest,
        taskId: row.item.taskId,
        taskRevision: row.item.taskRevision,
        recordedStatus: row.item.recordedStatus,
        createdAt: row.item.createdAt,
        cancelledAt: row.item.cancelledAt,
        sourceCount: row.item.requirementSources.length,
        amendmentCount: row.item.requirementSources.filter((source) => source.kind === "amendment").length,
        requirementsDigest: row.item.requirementsDigest,
      };
    });
    const nextPosition = start + window.length;
    const more = nextPosition < occurrences.length;
    const nextCursor = more ? cursorForPosition(view.listing, nextPosition) : null;

    this.lastError = null;
    return {
      ok: true,
      view: {
        schemaVersion: HISTORY_VIEW_SCHEMA_VERSION,
        action: "list",
        scope: "selected_branch",
        result: rows.length > 0 ? "visible_history" : "no_visible_history",
        items,
        nextCursor,
        coverage: {
          candidates: occurrences.length,
          evaluated: window.length,
          inspected: budget.inspections,
          returned: rows.length,
          withheld,
          duplicatesCollapsed: duplicates,
          more,
          withheldReasons,
        },
        budget: budgetView(budget),
        evidence: evidence(),
      },
    };
  }

  inspect(
    context: OmpToolContext,
    selector: string,
    signal?: AbortSignal,
  ): HistoryInspectOutcome {
    if (this.disposed) return this.fail("disposed");
    if (!HISTORY_SELECTOR_PATTERN.test(selector)) {
      return this.fail("unknown_selector");
    }
    if (hostAborted(signal)) return this.fail("aborted");
    const composition = this.checkComposition();
    if (!composition.ok) return this.fail(composition.code);

    const startGeneration = this.generation;
    const scopeResult = readScope(this.workspaceRoot, context);
    if (!scopeResult.ok) return this.fail(scopeResult.code);
    if (this.generation !== startGeneration) {
      this.current = undefined;
      return this.fail("new_list_required");
    }
    const scope = { ...scopeResult.scope, generation: this.generation };
    const baseResult = readRootBase(this.stateRoot);
    if (!baseResult.ok) {
      this.current = undefined;
      return this.fail("unavailable");
    }
    const collection = collectCandidates(scope.entries, scope.sessionId);
    if (!collection.ok) {
      this.current = undefined;
      return this.fail(collection.code);
    }
    const view = this.current;
    if (view === undefined
      || view.generation !== this.generation
      || view.signature !== collection.collection.signature
      || view.sessionId !== scope.sessionId
      || view.file !== scope.file) {
      this.current = undefined;
      return this.fail("new_list_required");
    }
    const issued = view.selectors.get(selector);
    if (issued === undefined) return this.fail("unknown_selector");
    const occurrence = collection.collection.occurrences.find(
      (candidate) => candidate.entryId === issued.entryId && candidate.key === issued.key,
    );
    if (occurrence === undefined) {
      this.current = undefined;
      return this.fail("new_list_required");
    }

    const budget: BudgetState = { inspections: 0, prechargedBytes: 0 };
    const cache = new Map<string, InspectionCacheEntry>();
    const evaluated = this.inspectOccurrence(occurrence, scope, baseResult.base, budget, cache);
    if (evaluated.fatal !== undefined) return this.fail(evaluated.fatal);
    if (!evaluated.ok) {
      // The row that the earlier list described can no longer be proven.
      this.current = undefined;
      return {
        ok: false,
        code: "withheld",
        reason: evaluated.reason ?? "history_unavailable",
      };
    }
    const rows: SelectedRow[] = [{ occurrence, item: evaluated.item! }];
    const failure = this.verifyFresh(
      scope,
      baseResult.base,
      collection.collection,
      view,
      rows,
      cache,
      signal,
    );
    if (failure !== undefined) {
      this.invalidateForFailure(failure);
      return this.fail(failure);
    }
    this.lastError = null;
    return {
      ok: true,
      view: {
        schemaVersion: HISTORY_VIEW_SCHEMA_VERSION,
        action: "inspect",
        scope: "selected_branch",
        item: evaluated.item!,
        budget: budgetView(budget),
        evidence: evidence(),
      },
    };
  }

  listRuns(
    context: OmpToolContext,
    request: HistoryRunListRequest,
    signal?: AbortSignal,
  ): HistoryRunListOutcome {
    if (this.disposed) return this.fail("disposed");
    const limit = request.limit ?? HISTORY_QUERY_PAGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HISTORY_QUERY_PAGE_LIMIT) {
      return this.fail("invalid_arguments");
    }
    if (!HISTORY_SELECTOR_PATTERN.test(request.taskSelector)) {
      return this.fail("invalid_arguments");
    }
    if (request.cursor !== undefined && !HISTORY_RUN_CURSOR_PATTERN.test(request.cursor)) {
      return this.fail("cursor_invalid");
    }
    if (hostAborted(signal)) return this.fail("aborted");
    const composition = this.checkComposition();
    if (!composition.ok) return this.fail(composition.code);

    const startGeneration = this.generation;
    const scopeResult = readScope(this.workspaceRoot, context);
    if (!scopeResult.ok) return this.fail(scopeResult.code);
    if (this.generation !== startGeneration) {
      this.current = undefined;
      return this.fail("new_list_required");
    }
    const scope = { ...scopeResult.scope, generation: this.generation };
    const baseResult = readRootBase(this.stateRoot);
    if (!baseResult.ok) {
      this.current = undefined;
      return this.fail("unavailable");
    }
    const collection = collectCandidates(scope.entries, scope.sessionId);
    if (!collection.ok) {
      this.current = undefined;
      return this.fail(collection.code);
    }
    const runCollection = collectRunCandidates(scope.entries, scope.sessionId);
    if (!runCollection.ok) {
      this.current = undefined;
      return this.fail(runCollection.code);
    }
    const view = this.current;
    if (view === undefined
      || view.generation !== this.generation
      || view.signature !== collection.collection.signature
      || view.sessionId !== scope.sessionId
      || view.file !== scope.file) {
      this.current = undefined;
      return this.fail("new_list_required");
    }
    if (view.runManager !== scope.manager) {
      // Run tokens are bound to the actual manager object. Task selectors and
      // cursors retain their existing behavior.
      this.resetRunState(view, view.runSignature ?? runCollection.collection.signature);
      view.runManager = scope.manager;
      if (request.cursor !== undefined) return this.fail("new_list_required");
    }
    if (view.runSignature !== runCollection.collection.signature) {
      // A changed or extended run-locator collection invalidates old run
      // selectors and cursors, but not the task selectors from the same view.
      this.resetRunState(view, runCollection.collection.signature);
      if (request.cursor !== undefined) return this.fail("new_list_required");
    }

    const budget: BudgetState = { inspections: 0, prechargedBytes: 0 };
    const cache = new Map<string, InspectionCacheEntry>();
    const task = this.resolveTaskSelection(
      request.taskSelector,
      scope,
      baseResult.base,
      budget,
      cache,
    );
    if (!task.ok) {
      if (task.code === "withheld") {
        return { ok: false, code: "withheld", reason: task.reason ?? "run_task_mismatch" };
      }
      return this.fail(task.code);
    }

    const candidates = associatedRunOccurrences(
      runCollection.collection,
      task.item,
      task.taskData,
      scope.entries,
      scope.sessionId,
    );
    let start = 0;
    if (request.cursor !== undefined) {
      const cursor = view.runListing.cursors.get(request.cursor);
      if (cursor === undefined
        || cursor.taskEntryId !== task.occurrence.entryId
        || cursor.taskKey !== task.occurrence.key
        || cursor.signature !== runCollection.collection.signature
        || cursor.manager !== scope.manager) {
        return this.fail("cursor_invalid");
      }
      start = cursor.position;
    }
    if (start > candidates.length
      || (request.cursor !== undefined && start >= candidates.length)) {
      return this.fail("cursor_invalid");
    }
    const window = candidates.slice(start, start + limit);
    const primary = new Map(view.runListing.primaryByKey);
    const withheldReasons = emptyRunWithheldReasons();
    const rows: RunOccurrence[] = [];
    let withheld = 0;
    let duplicates = 0;
    let fatal: HistoryViewErrorCode | undefined;
    for (const occurrence of window) {
      if (hostAborted(signal)) {
        fatal = "aborted";
        break;
      }
      if (occurrence.preReason !== null || occurrence.runKey === null) {
        withheldReasons[occurrence.preReason ?? "run_locator_invalid"] += 1;
        withheld += 1;
        continue;
      }
      const key = pairKey(task.occurrence.entryId, occurrence.runKey);
      const existing = primary.get(key);
      if (existing === undefined) {
        primary.set(key, occurrence.entryId);
        rows.push(occurrence);
      } else if (existing === occurrence.entryId) {
        rows.push(occurrence);
      } else {
        duplicates += 1;
      }
    }
    if (fatal !== undefined) return this.fail(fatal);

    const failure = this.verifyFresh(
      scope,
      baseResult.base,
      collection.collection,
      view,
      [],
      cache,
      signal,
      {
        collection: runCollection.collection,
        taskOccurrence: task.occurrence,
        item: task.item,
        runs: rows,
      },
    );
    if (failure !== undefined) {
      if (failure === "new_list_required") {
        this.resetRunState(view, runCollection.collection.signature);
      } else {
        this.invalidateForFailure(failure);
      }
      return this.fail(failure);
    }

    const items: HistoryRunListSummary[] = [];
    let selectorOverflow = false;
    for (const occurrence of rows) {
      const data = occurrence.data!;
      const key = pairKey(task.occurrence.entryId, occurrence.runKey!);
      let selector = view.runSelectorByKey.get(key);
      const issued = selector === undefined ? undefined : view.runSelectors.get(selector);
      if (selector === undefined
        || issued === undefined
        || issued.entryId !== occurrence.entryId
        || issued.key !== occurrence.key
        || issued.taskSelector !== request.taskSelector
        || issued.taskEntryId !== task.occurrence.entryId
        || issued.signature !== runCollection.collection.signature
        || issued.manager !== scope.manager) {
        if (view.runSelectors.size >= HISTORY_QUERY_RUN_CANDIDATE_LIMIT) {
          selectorOverflow = true;
          break;
        }
        const minted = uniqueRunSelector(view.runSelectors);
        if (minted === undefined) return this.fail("unavailable");
        selector = minted;
        view.runSelectorByKey.set(key, selector);
        view.runSelectors.set(selector, {
          entryId: occurrence.entryId,
          key: occurrence.key!,
          runKey: occurrence.runKey!,
          taskSelector: request.taskSelector,
          taskEntryId: task.occurrence.entryId,
          taskKey: task.occurrence.key!,
          signature: runCollection.collection.signature,
          manager: scope.manager,
        });
      }
      items.push({
        selector,
        historyId: data.historyId,
        digest: data.digest,
        taskId: data.taskId,
        taskRevision: data.taskRevision,
        requirementsDigest: data.requirementsDigest,
        runId: data.runId,
        callId: data.callId,
        runDirectory: data.runDirectory,
        artifactIds: [...data.artifactIds],
        recordWriteReturned: true,
        byteIntegrity: "not_checked",
        authorityRestored: false,
      });
    }
    if (selectorOverflow) return this.fail("limit");

    const nextPosition = start + window.length;
    const more = nextPosition < candidates.length;
    const nextCursor = more
      ? runCursorForPosition(
        view.runListing,
        nextPosition,
        task.occurrence.entryId,
        task.occurrence.key!,
        runCollection.collection.signature,
        scope.manager,
      )
      : null;
    if (nextCursor === undefined) return this.fail("unavailable");
    view.runListing.primaryByKey = primary;

    this.lastError = null;
    return {
      ok: true,
      view: {
        schemaVersion: HISTORY_VIEW_SCHEMA_VERSION,
        action: "list_runs",
        scope: "selected_branch",
        result: items.length > 0 ? "visible_runs" : "no_visible_runs",
        items,
        nextCursor,
        coverage: {
          candidates: candidates.length,
          evaluated: window.length,
          inspected: budget.inspections,
          returned: items.length,
          withheld,
          duplicatesCollapsed: duplicates,
          more,
          withheldReasons,
        },
        budget: budgetView(budget),
        evidence: evidence(),
      },
    };
  }

  inspectRun(
    context: OmpToolContext,
    runSelector: string,
    signal?: AbortSignal,
  ): HistoryRunInspectOutcome {
    if (this.disposed) return this.fail("disposed");
    if (!HISTORY_RUN_SELECTOR_PATTERN.test(runSelector)) {
      return this.fail("unknown_selector");
    }
    if (hostAborted(signal)) return this.fail("aborted");
    const composition = this.checkComposition();
    if (!composition.ok) return this.fail(composition.code);

    const startGeneration = this.generation;
    const scopeResult = readScope(this.workspaceRoot, context);
    if (!scopeResult.ok) return this.fail(scopeResult.code);
    if (this.generation !== startGeneration) {
      this.current = undefined;
      return this.fail("new_list_required");
    }
    const scope = { ...scopeResult.scope, generation: this.generation };
    const baseResult = readRootBase(this.stateRoot);
    if (!baseResult.ok) {
      this.current = undefined;
      return this.fail("unavailable");
    }
    const collection = collectCandidates(scope.entries, scope.sessionId);
    if (!collection.ok) {
      this.current = undefined;
      return this.fail(collection.code);
    }
    const runCollection = collectRunCandidates(scope.entries, scope.sessionId);
    if (!runCollection.ok) {
      this.current = undefined;
      return this.fail(runCollection.code);
    }
    const view = this.current;
    if (view === undefined
      || view.generation !== this.generation
      || view.signature !== collection.collection.signature
      || view.sessionId !== scope.sessionId
      || view.file !== scope.file) {
      this.current = undefined;
      return this.fail("new_list_required");
    }
    if (view.runManager !== scope.manager) {
      this.resetRunState(view, runCollection.collection.signature);
      view.runManager = scope.manager;
      return this.fail("new_list_required");
    }
    if (view.runSignature !== runCollection.collection.signature) {
      this.resetRunState(view, runCollection.collection.signature);
      return this.fail("new_list_required");
    }
    const issued = view.runSelectors.get(runSelector);
    if (issued === undefined) return this.fail("unknown_selector");
    if (issued.signature !== runCollection.collection.signature
      || issued.manager !== scope.manager) {
      this.resetRunState(view, runCollection.collection.signature);
      return this.fail("new_list_required");
    }
    const occurrence = runCollection.collection.occurrences.find(
      (candidate) => candidate.entryId === issued.entryId && candidate.key === issued.key,
    );
    if (occurrence === undefined) {
      this.resetRunState(view, runCollection.collection.signature);
      return this.fail("new_list_required");
    }

    // Reserve and check the complete conservative whole-action envelope before
    // the outer task inspection reads any history file. A is called at most
    // once below and its initial/final reads are included in this amount.
    const budget: BudgetState = {
      inspections: 0,
      prechargedBytes: HISTORY_RUN_EVIDENCE_PRECHARGE_BYTES,
      wholeActionPrecharge: true,
    };
    const cache = new Map<string, InspectionCacheEntry>();
    const task = this.resolveTaskSelection(
      issued.taskSelector,
      scope,
      baseResult.base,
      budget,
      cache,
    );
    if (!task.ok) {
      if (task.code === "withheld") {
        return {
          ok: false,
          code: "withheld",
          reason: task.reason as HistoryWithheldReason | HistoryRunWithheldReason,
        };
      }
      return this.fail(task.code);
    }
    if (task.occurrence.entryId !== issued.taskEntryId
      || task.occurrence.key !== issued.taskKey) {
      this.current = undefined;
      return this.fail("new_list_required");
    }
    const association = associateRun(
      task.item,
      task.taskData,
      occurrence,
      scope.entries,
      scope.sessionId,
    );
    if (!association.ok) {
      return {
        ok: false,
        code: "withheld",
        reason: association.reason ?? "run_task_mismatch",
      };
    }

    const failure = this.verifyFresh(
      scope,
      baseResult.base,
      collection.collection,
      view,
      [],
      cache,
      signal,
      {
        collection: runCollection.collection,
        taskOccurrence: task.occurrence,
        item: task.item,
        runs: [occurrence],
      },
    );
    if (failure !== undefined) {
      if (failure === "new_list_required") {
        this.resetRunState(view, runCollection.collection.signature);
      } else {
        this.invalidateForFailure(failure);
      }
      return this.fail(failure);
    }

    const data = occurrence.data!;
    const itemReference: HistoryItemReference = {
      historyId: task.item.historyId,
      digest: task.item.digest,
      taskId: task.item.taskId,
      taskRevision: task.item.taskRevision,
    };
    let runEvidence: RunEvidenceResult;
    try {
      runEvidence = checkRunEvidence({
        instance: {
          instanceRoot: task.target.instanceRoot,
          instanceId: data.instanceId,
          ownerId: data.ownerId,
          workspaceRoot: this.workspaceRoot,
        },
        item: itemReference,
        expectedRunId: data.runId,
        expectedCallId: data.callId,
        runLocator: `${data.runDirectory}/${RUN_RECORD_FILE_NAME}`,
        artifactIds: data.artifactIds,
      });
    } catch {
      return this.fail("unavailable");
    }

    // All host callbacks and file inspection are over. Only pure result
    // binding runs below; A's own state axes are preserved unflattened.
    const historyExact = runEvidence.history !== null
      && runEvidence.history.historyId === task.item.historyId
      && runEvidence.history.digest === task.item.digest
      && runEvidence.history.taskId === task.item.taskId
      && runEvidence.history.taskRevision === task.item.taskRevision
      && runEvidence.history.requirementsDigest === task.item.requirementsDigest
      && runEvidence.history.recordedStatus === task.item.recordedStatus;
    const runExact = runEvidence.run !== null
      && runEvidence.run.runId === data.runId
      && runEvidence.run.callId === data.callId
      && runEvidence.run.locator === `${data.runDirectory}/${RUN_RECORD_FILE_NAME}`;
    const instanceExact = runEvidence.instance !== null
      && runEvidence.instance.instance === data.instanceId
      && runEvidence.instance.owner === data.ownerId
      && runEvidence.instance.workspace === this.workspaceRoot;
    const metadataExact = runEvidence.metadata.state === "matched";
    const selection = runEvidence.selection;
    const artifactSetExact = selection !== null
      && selection.allPresent
      && exactlyEqualStringSets(data.artifactIds, selection.requested)
      && exactlyEqualStringSets(data.artifactIds, selection.recorded);
    const exact = historyExact && runExact && instanceExact && metadataExact && artifactSetExact;
    const state = exact
      ? runEvidence.state
      : runEvidence.state === "consistent" || runEvidence.state === "incomplete"
        ? "mismatch"
        : runEvidence.state;

    // Only native abort and internal lifecycle state may be consulted after A.
    // No composition callback or host scope getter runs here.
    if (hostAborted(signal)) return this.fail("aborted");
    if (this.disposed) return this.fail("disposed");
    if (this.current !== view || this.generation !== view.generation) {
      return this.fail("new_list_required");
    }

    this.lastError = null;
    return {
      ok: true,
      view: {
        schemaVersion: HISTORY_VIEW_SCHEMA_VERSION,
        action: "inspect_run",
        scope: "selected_branch",
        state,
        result: exact ? "archived_run_evidence" : "withheld_archived_run_evidence",
        association: {
          historyId: data.historyId,
          digest: data.digest,
          taskId: data.taskId,
          taskRevision: data.taskRevision,
          requirementsDigest: data.requirementsDigest,
          runId: data.runId,
          callId: data.callId,
          runDirectory: data.runDirectory,
          artifactIds: [...data.artifactIds],
          recordWriteReturned: true,
          byteIntegrity: "not_checked",
          authorityRestored: false,
        },
        verification: {
          instance: instanceExact ? "exact" : "mismatch",
          history: historyExact ? "exact" : "mismatch",
          run: runExact ? "exact" : "mismatch",
          metadata: runEvidence.metadata.state,
          artifactSet: artifactSetExact ? "exact" : "mismatch",
        },
        runEvidence,
        budget: {
          taskInspections: budget.inspections,
          runEvidenceCalls: 1,
          prechargedBytes: budget.prechargedBytes,
          precharge: "conservative_not_measured",
          bytesLimit: HISTORY_QUERY_READ_BUDGET_BYTES,
        },
        evidence: evidence("checked"),
      },
    };
  }
}

export function createHistoryView(options: HistoryViewOptions): HistoryViewControls {
  return new HistoryView(options);
}
