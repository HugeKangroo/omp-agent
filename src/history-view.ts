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
  HISTORY_SESSION_BRANCH_ENTRY_LIMIT,
  type HistoryLocatorData,
} from "./history-session.ts";
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

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_INSTANCE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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
    runEvidence: "not_checked";
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
}

interface BudgetState {
  inspections: number;
  prechargedBytes: number;
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

function evidence(): HistoryViewEvidence {
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
      runEvidence: "not_checked",
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
      selectors: this.current?.selectors.size ?? 0,
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
        || budget.prechargedBytes + HISTORY_FILE_BYTES_LIMIT > HISTORY_QUERY_READ_BUDGET_BYTES) {
        return { ok: false, fatal: "budget_exhausted" };
      } else {
        budget.inspections += 1;
        budget.prechargedBytes += HISTORY_FILE_BYTES_LIMIT;
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
}

export function createHistoryView(options: HistoryViewOptions): HistoryViewControls {
  return new HistoryView(options);
}
