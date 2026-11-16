import { Buffer } from "node:buffer";
import { readActualAbortSignal } from "./native-abort.ts";
import {
  NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
  type NativeHarnessHistoryListPage,
  type NativeHarnessHistoryListResult,
  type NativeHarnessHistorySelector,
  type NativeHarnessHistorySession,
  type NativeHarnessHistorySessionInspection,
} from "./native-harness-history-session.ts";
import type {
  NativeHarnessHistoryLocator,
  NativeHarnessHistoryProcessObservation,
} from "./native-harness-history.ts";
import { deepFreeze } from "./native-work.ts";
import type { NativeContext, NativeToolResult } from "./native-entry.ts";

/**
 * Thin readonly transport for one explicit `agent_harness_history` tool.
 *
 * It owns no state, ledger or executor: list/inspect call the supplied R1b1
 * session view, then revalidate the original root. The result projection is
 * non-authoritative metadata; process observation stays unknown/not-inspected
 * and no historical locator grants execution authority or resume.
 */

export const NATIVE_HARNESS_HISTORY_TOOL = "agent_harness_history" as const;
export const NATIVE_HARNESS_HISTORY_TOOL_RESULT_SCHEMA =
  "omp-agent.native-harness-history-tool-result.v1" as const;
export const NATIVE_HARNESS_HISTORY_HOST_SCHEMA =
  "omp-agent.native-harness-history-host-view.v1" as const;
export const MAX_NATIVE_HARNESS_HISTORY_WIRE_BYTES = 256 * 1024;

const MAX_REASON_CHARS = 320;
const MAX_SELECTOR_ID_CHARS = 256;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;
const PAGE_MAX_OFFSET = 128;
const PAGE_MAX_LIMIT = 16;

export type NativeHarnessHistoryLabelComparison = "match" | "mismatch" | "unknown";

export interface NativeHarnessHistoryRootLabels {
  readonly definitionVersion: string | null;
  readonly backendSourceId: string | null;
  readonly configurationSha256: string | null;
}

export interface NativeHarnessHistoryVersionComparison {
  readonly definitionVersion: NativeHarnessHistoryLabelComparison;
  readonly backendSourceId: NativeHarnessHistoryLabelComparison;
  readonly configurationSha256: NativeHarnessHistoryLabelComparison;
}

/**
 * Bounded inspect-only process summary. Counts and labels only: no PID,
 * command, token, runtime path or environment value is copied here.
 */
export interface NativeHarnessHistoryHostProcessSummary {
  readonly inspected: true;
  readonly platform: "darwin" | "unsupported";
  readonly osQuery:
    | "completed"
    | "not-observed"
    | "limited-unknown"
    | "not-run"
    | "unsupported"
    | "aborted";
  readonly osQueryExecuted: boolean;
  readonly controllerPresence: "present" | "not-observed" | "unknown";
  readonly workerPresence: {
    readonly present: number;
    readonly notObserved: number;
    readonly unknown: number;
  };
  readonly workerCoverage: "current-recorded-attempts-only";
  readonly groupCoverage: "not-inspected";
  readonly historicalAttempts: "incomplete";
  readonly stopProof: "not-established";
}

export type NativeHarnessHistoryHostProcessObservation =
  | "unknown/not-inspected"
  | NativeHarnessHistoryHostProcessSummary;

export interface NativeHarnessHistoryHostInspection {
  readonly schema: typeof NATIVE_HARNESS_HISTORY_HOST_SCHEMA;
  readonly authority: "non-authoritative";
  readonly state: NativeHarnessHistorySessionInspection["state"] | "unavailable";
  readonly current: boolean;
  readonly selector: NativeHarnessHistorySelector | null;
  readonly versions: NativeHarnessHistoryVersionComparison;
  readonly rootLabels: NativeHarnessHistoryRootLabels | null;
  readonly recoveredAuthority: false;
  readonly resume: false;
  readonly processObservation: NativeHarnessHistoryHostProcessObservation;
  readonly history: NativeHarnessHistorySessionInspection | null;
  readonly reason: string | null;
}

export interface NativeHarnessHistoryResolvedRoot {
  readonly session: NativeHarnessHistorySession;
  readonly labels: NativeHarnessHistoryRootLabels;
  /** Re-runs the caller's current root/tool gate after awaited history I/O. */
  revalidate(context: NativeContext): string | null;
}

export type NativeHarnessHistoryRootResolution =
  | { readonly ok: true; readonly root: NativeHarnessHistoryResolvedRoot }
  | { readonly ok: false; readonly reason: string };

export interface NativeHarnessHistoryEntryOptions {
  resolveRoot(context: NativeContext): NativeHarnessHistoryRootResolution;
}

export interface NativeHarnessHistoryTool {
  readonly name: typeof NATIVE_HARNESS_HISTORY_TOOL;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly approval: "read";
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

export interface NativeHarnessHistoryEntry {
  readonly tool: NativeHarnessHistoryTool;
  dispose(): void;
}

export type NativeHarnessHistoryToolState =
  | NativeHarnessHistoryListResult["state"]
  | NativeHarnessHistoryHostInspection["state"];

interface NativeHarnessHistoryToolResult {
  readonly schema: typeof NATIVE_HARNESS_HISTORY_TOOL_RESULT_SCHEMA;
  readonly tool: typeof NATIVE_HARNESS_HISTORY_TOOL;
  readonly authority: "non-authoritative";
  readonly action: "list" | "inspect" | null;
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
  readonly recoveredAuthority: false;
  readonly resume: false;
  readonly processObservation: NativeHarnessHistoryHostProcessObservation;
  readonly state: NativeHarnessHistoryToolState;
  readonly history: NativeHarnessHistoryListResult | NativeHarnessHistoryHostInspection | null;
  readonly reason: string | null;
}

type ParsedInput =
  | { readonly ok: true; readonly action: "list"; readonly page: NativeHarnessHistoryListPage }
  | { readonly ok: true; readonly action: "inspect"; readonly selector: NativeHarnessHistorySelector }
  | { readonly ok: false; readonly reason: string };

interface EntryLifecycle {
  disposed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, max: number): string {
  const raw = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const normalized = raw.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function publicText(value: string, max: number): string {
  return boundedText(value, max)
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'`<>]+/g, "[path]")
    .replace(/\b(?:api[_-]?key|token|secret|authorization)\b[^\s,;]*/gi, "[redacted]");
}

function reasonText(value: unknown, fallback: string): string {
  return publicText(typeof value === "string" && value.length > 0 ? value : fallback, MAX_REASON_CHARS);
}

function readOwnDataFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): ReadonlyMap<string, unknown> | null {
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

function readPageNumber(
  value: unknown,
  maximum: number,
  minimum: number,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return null;
  }
  return value;
}

function parseInput(value: unknown): ParsedInput {
  try {
    return parseInputInner(value);
  } catch {
    return { ok: false, reason: "agent_harness_history input must be an exact plain own-data object." };
  }
}

function parseInputInner(value: unknown): ParsedInput {
  const fields = readOwnDataFields(
    value,
    ["action", "offset", "limit", "entryId", "locatorSha256"],
    ["action"],
  );
  if (fields === null) {
    return { ok: false, reason: "agent_harness_history input must be an exact plain own-data object." };
  }
  const action = fields.get("action");
  if (action === "list") {
    if (fields.has("entryId") || fields.has("locatorSha256")) {
      return { ok: false, reason: "agent_harness_history list accepts only bounded pagination." };
    }
    const offset = readPageNumber(fields.get("offset"), PAGE_MAX_OFFSET, 0);
    const limit = readPageNumber(fields.get("limit"), PAGE_MAX_LIMIT, 1);
    if (offset === null || limit === null) {
      return { ok: false, reason: "agent_harness_history pagination is outside its fixed bound." };
    }
    return {
      ok: true,
      action: "list",
      page: deepFreeze({
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      }),
    };
  }
  if (action === "inspect") {
    if (fields.has("offset") || fields.has("limit")) {
      return { ok: false, reason: "agent_harness_history inspect accepts only one entry selector." };
    }
    const entryId = fields.get("entryId");
    const locatorSha256 = fields.get("locatorSha256");
    if (typeof entryId !== "string"
      || entryId.length === 0
      || entryId.length > MAX_SELECTOR_ID_CHARS
      || CONTROL_PATTERN.test(entryId)) {
      return { ok: false, reason: "agent_harness_history inspect requires a bounded entryId." };
    }
    if (typeof locatorSha256 !== "string" || !SHA256_PATTERN.test(locatorSha256)) {
      return { ok: false, reason: "agent_harness_history inspect requires a locatorSha256." };
    }
    return {
      ok: true,
      action: "inspect",
      selector: deepFreeze({ entryId, locatorSha256 }),
    };
  }
  return { ok: false, reason: "agent_harness_history action must be list or inspect." };
}

function compareLabel(left: string | null, right: string | null): NativeHarnessHistoryLabelComparison {
  if (left === null || right === null) return "unknown";
  return left === right ? "match" : "mismatch";
}

export function compareNativeHarnessHistoryLabels(
  locator: Pick<NativeHarnessHistoryLocator, "definitionVersion" | "backendSourceId" | "configurationSha256"> | null,
  labels: NativeHarnessHistoryRootLabels | null,
): NativeHarnessHistoryVersionComparison {
  return deepFreeze({
    definitionVersion: compareLabel(locator?.definitionVersion ?? null, labels?.definitionVersion ?? null),
    backendSourceId: compareLabel(locator?.backendSourceId ?? null, labels?.backendSourceId ?? null),
    configurationSha256: compareLabel(locator?.configurationSha256 ?? null, labels?.configurationSha256 ?? null),
  });
}

function buildHostProcessObservation(
  history: NativeHarnessHistorySessionInspection,
): NativeHarnessHistoryHostProcessObservation {
  const process = history.inspection?.processObservation ?? null;
  if (process === null || process.inspected === false) return "unknown/not-inspected";
  return {
    inspected: true,
    platform: process.platform,
    osQuery: process.osInspection.state,
    osQueryExecuted: process.osInspection.executed,
    controllerPresence: process.controller.presence,
    workerPresence: {
      present: process.workers.counts.present,
      notObserved: process.workers.counts.notObserved,
      unknown: process.workers.counts.unknown,
    },
    workerCoverage: process.workers.coverage,
    groupCoverage: process.workers.groupCoverage,
    historicalAttempts: process.workers.historicalAttempts,
    stopProof: process.summary.stopProof,
  };
}

export function buildNativeHarnessHistoryHostInspection(
  history: NativeHarnessHistorySessionInspection,
  labels: NativeHarnessHistoryRootLabels,
): NativeHarnessHistoryHostInspection {
  const rootLabels = deepFreeze({
    definitionVersion: labels.definitionVersion,
    backendSourceId: labels.backendSourceId,
    configurationSha256: labels.configurationSha256,
  });
  return deepFreeze({
    schema: NATIVE_HARNESS_HISTORY_HOST_SCHEMA,
    authority: "non-authoritative" as const,
    state: history.state,
    current: history.current === true,
    selector: history.selector,
    versions: compareNativeHarnessHistoryLabels(history.locator, rootLabels),
    rootLabels,
    recoveredAuthority: false as const,
    resume: false as const,
    processObservation: buildHostProcessObservation(history),
    history,
    reason: null,
  });
}

export function unavailableNativeHarnessHistoryHostInspection(
  reason: string,
): NativeHarnessHistoryHostInspection {
  return deepFreeze({
    schema: NATIVE_HARNESS_HISTORY_HOST_SCHEMA,
    authority: "non-authoritative" as const,
    state: "unavailable" as const,
    current: false,
    selector: null,
    versions: compareNativeHarnessHistoryLabels(null, null),
    rootLabels: null,
    recoveredAuthority: false as const,
    resume: false as const,
    processObservation: "unknown/not-inspected" as const,
    history: null,
    reason: reasonText(reason, "the history query is unavailable"),
  });
}

export function unavailableNativeHarnessHistoryList(reason: string): NativeHarnessHistoryListResult {
  return deepFreeze({
    schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
    state: "unavailable" as const,
    rows: [],
    page: { offset: 0, limit: 0, total: 0, returned: 0, nextOffset: null },
    reasons: [{
      code: "host-unavailable",
      detail: reasonText(reason, "the history query is unavailable"),
    }],
  });
}

function unavailableProjection(
  action: "list" | "inspect" | null,
  reason: string,
): NativeHarnessHistoryToolResult {
  return deepFreeze({
    schema: NATIVE_HARNESS_HISTORY_TOOL_RESULT_SCHEMA,
    tool: NATIVE_HARNESS_HISTORY_TOOL,
    authority: "non-authoritative" as const,
    action,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
    recoveredAuthority: false as const,
    resume: false as const,
    processObservation: "unknown/not-inspected" as const,
    state: "unavailable" as const,
    history: null,
    reason: reasonText(reason, "the history query is unavailable"),
  });
}

function listProjection(list: NativeHarnessHistoryListResult): NativeHarnessHistoryToolResult {
  return deepFreeze({
    schema: NATIVE_HARNESS_HISTORY_TOOL_RESULT_SCHEMA,
    tool: NATIVE_HARNESS_HISTORY_TOOL,
    authority: "non-authoritative" as const,
    action: "list" as const,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
    recoveredAuthority: false as const,
    resume: false as const,
    processObservation: "unknown/not-inspected" as const,
    state: list.state,
    history: list,
    reason: null,
  });
}

function inspectProjection(host: NativeHarnessHistoryHostInspection): NativeHarnessHistoryToolResult {
  return deepFreeze({
    schema: NATIVE_HARNESS_HISTORY_TOOL_RESULT_SCHEMA,
    tool: NATIVE_HARNESS_HISTORY_TOOL,
    authority: "non-authoritative" as const,
    action: "inspect" as const,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
    recoveredAuthority: false as const,
    resume: false as const,
    processObservation: host.processObservation,
    state: host.state,
    history: host,
    reason: null,
  });
}

const MAX_MODEL_ROWS = 16;
const MAX_MODEL_REASONS = 16;

interface ModelReason {
  readonly code: string;
  readonly detail: string;
}

function modelReasons(
  reasons: readonly { readonly code: string; readonly detail: string }[],
): ModelReason[] {
  return reasons.slice(0, MAX_MODEL_REASONS).map((item) => ({
    code: boundedText(item.code, 64),
    detail: reasonText(item.detail, "no reason detail"),
  }));
}

function modelAuthorityFields(): {
  readonly authority: "non-authoritative";
  readonly executionAuthority: false;
  readonly recoveredAuthority: false;
  readonly resume: false;
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
} {
  return {
    authority: "non-authoritative",
    executionAuthority: false,
    recoveredAuthority: false,
    resume: false,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
  };
}

function listModelView(list: NativeHarnessHistoryListResult): Record<string, unknown> {
  return {
    tool: NATIVE_HARNESS_HISTORY_TOOL,
    action: "list",
    state: list.state,
    page: {
      offset: list.page.offset,
      limit: list.page.limit,
      total: list.page.total,
      returned: list.page.returned,
      nextOffset: list.page.nextOffset,
    },
    // Entry IDs are caller-visible selectors: keep their exact bytes instead
    // of path/token redaction so another inspect can name the same row.
    rows: list.rows.slice(0, MAX_MODEL_ROWS).map((row) => ({
      entryId: row.entryId,
      locatorSha256: row.locatorSha256,
      runId: row.runId,
    })),
    reasons: modelReasons(list.reasons),
    processObservation: "unknown/not-inspected" as const,
    ...modelAuthorityFields(),
  };
}

function modelProcessObservation(
  process: NativeHarnessHistoryProcessObservation | null,
): Record<string, unknown> | null {
  if (process === null) return null;
  if (process.inspected === false) {
    return { inspected: false, controller: "unknown", workers: "unknown" };
  }
  return {
    inspected: true,
    platform: process.platform,
    osQuery: process.osInspection.state,
    osQueryExecuted: process.osInspection.executed,
    requestedPids: process.osInspection.requestedPids,
    observedPids: process.osInspection.observedPids,
    cleanup: process.osInspection.cleanup,
    controllerPresence: process.controller.presence,
    workerPresence: process.workers.counts,
    workerCoverage: process.workers.coverage,
    groupCoverage: process.workers.groupCoverage,
    historicalAttempts: process.workers.historicalAttempts,
    stopProof: process.summary.stopProof,
  };
}

function inspectModelView(host: NativeHarnessHistoryHostInspection): Record<string, unknown> {
  const leaf = host.history;
  const projection = leaf?.inspection ?? null;
  const recorded = projection?.recorded ?? null;
  const artifacts = projection?.artifactIntegrity ?? null;
  const accounting = projection?.accounting ?? null;
  const origin = projection?.originCompatibility ?? null;
  const process = projection?.processObservation ?? null;
  return {
    tool: NATIVE_HARNESS_HISTORY_TOOL,
    action: "inspect",
    state: host.state,
    current: host.current,
    // The selector is the exact caller-visible entryId/locatorSha256 pair.
    selector: host.selector,
    runId: leaf?.locator?.runId ?? null,
    rootLabels: host.rootLabels,
    labels: leaf?.labels ?? null,
    evidence: leaf?.evidence ?? null,
    declaration: leaf === null ? null : {
      state: leaf.declaration.state,
      files: leaf.declaration.files,
      reportEntryId: leaf.declaration.reportEntryId,
    },
    versions: host.versions,
    originCompatibility: origin === null ? null : {
      runId: origin.runId.result,
      workspace: origin.workspace.result,
      workspaceLayout: origin.workspaceLayout,
      definitionVersion: origin.definitionVersion.result,
      backendSourceId: origin.backendSourceId.result,
      configurationSha256: origin.configurationSha256.result,
      inputManifestSha256: origin.inputManifestSha256.result,
    },
    recorded: recorded === null ? null : {
      state: recorded.state,
      runId: recorded.runId,
      status: recorded.status,
      revision: recorded.revision,
      stageCount: recorded.stages.length,
      eventsState: recorded.events.state,
      eventsRows: recorded.events.rows,
    },
    artifactCoverage: artifacts === null ? null : {
      state: artifacts.state,
      coverage: artifacts.coverage,
      complete: artifacts.complete,
      declaredCount: artifacts.declaredCount,
      observedCount: artifacts.observedCount,
      matchedCount: artifacts.matchedCount,
      totalDeclaredBytes: artifacts.totalDeclaredBytes,
      totalObservedBytes: artifacts.totalObservedBytes,
    },
    matchedFiles: artifacts === null ? [] : artifacts.results
      .filter((item) => item.status === "match")
      .map((item) => ({
        relativePath: item.relativePath,
        declaredBytes: item.declaredBytes,
        declaredSha256: item.declaredSha256,
        observedBytes: item.observedBytes,
        observedSha256: item.observedSha256,
      })),
    accounting: accounting === null ? null : {
      basis: accounting.basis,
      costTotal: accounting.costTotal,
      outerLifetime: accounting.outerLifetime,
      originalDeadline: accounting.originalDeadline,
      stages: accounting.stages.map((stage) => ({
        stage: stage.stage,
        observed: stage.observed,
        reserved: stage.reserved,
        accounted: stage.accounted,
        resultKnown: stage.resultKnown,
        usageEstimated: stage.usageEstimated,
      })),
    },
    processObservation: modelProcessObservation(process),
    hostProcessObservation: host.processObservation,
    reasons: modelReasons([...(leaf?.reasons ?? []), ...(projection?.reasons ?? [])]),
    reason: host.reason,
    ...modelAuthorityFields(),
  };
}

function modelTextFor(projection: NativeHarnessHistoryToolResult): string {
  try {
    let view: Record<string, unknown>;
    if (projection.action === "list" && projection.history !== null) {
      view = listModelView(projection.history as NativeHarnessHistoryListResult);
    } else if (projection.action === "inspect" && projection.history !== null) {
      view = inspectModelView(projection.history as NativeHarnessHistoryHostInspection);
    } else {
      view = {
        tool: NATIVE_HARNESS_HISTORY_TOOL,
        action: projection.action,
        state: projection.state,
        reason: projection.reason,
        processObservation: "unknown/not-inspected" as const,
        ...modelAuthorityFields(),
      };
    }
    return `${NATIVE_HARNESS_HISTORY_TOOL} ${JSON.stringify(view)}`;
  } catch {
    return `${NATIVE_HARNESS_HISTORY_TOOL} ${JSON.stringify({
      tool: NATIVE_HARNESS_HISTORY_TOOL,
      action: projection.action,
      state: "unavailable",
      reason: "the bounded history text could not be encoded",
      ...modelAuthorityFields(),
    })}`;
  }
}

function encodeProjection(projection: NativeHarnessHistoryToolResult): NativeToolResult {
  const wire = {
    content: [{ type: "text" as const, text: modelTextFor(projection) }],
    details: projection,
    ...(projection.state === "unavailable" ? { isError: true } : {}),
  };
  let text: string | null = null;
  try {
    text = JSON.stringify(wire);
  } catch {
    text = null;
  }
  if (text !== null && Buffer.byteLength(text, "utf8") <= MAX_NATIVE_HARNESS_HISTORY_WIRE_BYTES) {
    return deepFreeze(wire);
  }
  const fallback = unavailableProjection(projection.action, "the bounded history response did not fit");
  return deepFreeze({
    content: [{ type: "text" as const, text: modelTextFor(fallback) }],
    details: fallback,
    isError: true,
  });
}

function readResolution(value: unknown): NativeHarnessHistoryRootResolution {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return { ok: false, reason: "the history root resolver returned no readable decision" };
  }
  if (value.ok === false) {
    return { ok: false, reason: reasonText(value.reason, "the history root is unavailable") };
  }
  const root = value.root;
  if (!isRecord(root)
    || !isRecord(root.session)
    || typeof root.session.list !== "function"
    || typeof root.session.inspect !== "function"
    || typeof root.revalidate !== "function") {
    return { ok: false, reason: "the history root resolver returned no readable view" };
  }
  const labels = root.labels;
  if (!isRecord(labels)) {
    return { ok: false, reason: "the history root labels are unavailable" };
  }
  const definitionVersion = labels.definitionVersion;
  const backendSourceId = labels.backendSourceId;
  const configurationSha256 = labels.configurationSha256;
  if (
    (definitionVersion !== null && typeof definitionVersion !== "string")
    || (backendSourceId !== null && typeof backendSourceId !== "string")
    || (configurationSha256 !== null && typeof configurationSha256 !== "string")
  ) {
    return { ok: false, reason: "the history root labels are malformed" };
  }
  return {
    ok: true,
    root: {
      session: root.session as unknown as NativeHarnessHistorySession,
      labels: {
        definitionVersion,
        backendSourceId,
        configurationSha256,
      },
      revalidate: root.revalidate as (context: NativeContext) => string | null,
    },
  };
}

const HISTORY_DESCRIPTION = [
  "List or inspect bounded, non-authoritative native Harness history locators in the owning main session.",
  "This readonly tool accepts only list pagination or one entryId plus locatorSha256; it never accepts paths, process ids, run actions or signals.",
  "History is metadata from earlier terminal observations: it grants no execution authority, resume or process observation.",
].join(" ");

const AGENT_HARNESS_HISTORY_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "inspect"] },
    offset: { type: "integer", minimum: 0, maximum: PAGE_MAX_OFFSET },
    limit: { type: "integer", minimum: 1, maximum: PAGE_MAX_LIMIT },
    entryId: { type: "string", minLength: 1, maxLength: MAX_SELECTOR_ID_CHARS },
    locatorSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export function createNativeHarnessHistoryEntry(
  options: NativeHarnessHistoryEntryOptions,
): NativeHarnessHistoryEntry {
  if (!isRecord(options)) {
    throw new Error("Harness history entry options must be an object.");
  }
  const resolveField = Object.getOwnPropertyDescriptor(options, "resolveRoot");
  if (resolveField === undefined || !("value" in resolveField) || typeof resolveField.value !== "function") {
    throw new Error("Harness history entry requires a trusted resolveRoot function.");
  }
  const resolveRoot = resolveField.value as (context: NativeContext) => NativeHarnessHistoryRootResolution;
  const lifecycle: EntryLifecycle = { disposed: false };

  const tool: NativeHarnessHistoryTool = {
    name: NATIVE_HARNESS_HISTORY_TOOL,
    label: "Harness history",
    description: HISTORY_DESCRIPTION,
    parameters: AGENT_HARNESS_HISTORY_PARAMETERS,
    approval: "read",
    loadMode: "discoverable",
    defaultInactive: true,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: NativeContext,
    ): Promise<NativeToolResult> {
      if (lifecycle.disposed) return encodeProjection(unavailableProjection(null, "the history entry is disposed"));
      const parsed = parseInput(params);
      if (!parsed.ok) return encodeProjection(unavailableProjection(null, parsed.reason));
      let signalValue: AbortSignal | null = null;
      if (parsed.action === "inspect") {
        const read = readActualAbortSignal(signal);
        if (!read.ok) return encodeProjection(unavailableProjection("inspect", read.reason));
        if (read.aborted) {
          return encodeProjection(unavailableProjection("inspect", "the history inspect signal was already aborted"));
        }
        signalValue = signal as AbortSignal;
      }
      let resolution: NativeHarnessHistoryRootResolution;
      try {
        resolution = readResolution(resolveRoot(context));
      } catch {
        return encodeProjection(unavailableProjection(parsed.action, "the history root resolver failed"));
      }
      if (!resolution.ok) {
        return encodeProjection(unavailableProjection(parsed.action, resolution.reason));
      }
      const root = resolution.root;
      // The resolver itself can synchronously dispose this transport or abort
      // the caller's actual inspect signal. Re-check both before any query.
      if (lifecycle.disposed) {
        return encodeProjection(unavailableProjection(parsed.action, "the history entry was disposed before the query"));
      }
      if (parsed.action === "inspect") {
        const earlySignal = readActualAbortSignal(signal);
        if (!earlySignal.ok || earlySignal.aborted) {
          return encodeProjection(unavailableProjection("inspect", "the history inspect signal was aborted before the query"));
        }
      }
      try {
        if (parsed.action === "list") {
          const list = root.session.list(context, parsed.page);
          if (lifecycle.disposed) {
            return encodeProjection(unavailableProjection("list", "the history entry was disposed during the list query"));
          }
          const late = root.revalidate(context);
          if (late !== null) return encodeProjection(unavailableProjection("list", late));
          if (lifecycle.disposed) {
            return encodeProjection(unavailableProjection("list", "the history entry was disposed during revalidation"));
          }
          return encodeProjection(listProjection(list));
        }
        const leaf = await root.session.inspect(context, parsed.selector, signalValue);
        if (lifecycle.disposed) {
          return encodeProjection(unavailableProjection("inspect", "the history entry was disposed during the inspection"));
        }
        const late = root.revalidate(context);
        if (late !== null) return encodeProjection(unavailableProjection("inspect", late));
        if (lifecycle.disposed) {
          return encodeProjection(unavailableProjection("inspect", "the history entry was disposed during revalidation"));
        }
        const lateSignal = readActualAbortSignal(signal);
        if (!lateSignal.ok || lateSignal.aborted) {
          return encodeProjection(unavailableProjection("inspect", "the history inspect signal was aborted before the current view was returned"));
        }
        return encodeProjection(inspectProjection(buildNativeHarnessHistoryHostInspection(leaf, root.labels)));
      } catch {
        return encodeProjection(unavailableProjection(parsed.action, "the history query failed"));
      }
    },
  };

  return Object.freeze({
    tool,
    dispose(): void {
      lifecycle.disposed = true;
    },
  });
}
