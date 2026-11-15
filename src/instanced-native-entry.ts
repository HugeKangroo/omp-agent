import { Buffer } from "node:buffer";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  loadNativeChildDefinitionSnapshot,
  type DefinitionModelRef,
  type DefinitionSkillMetadata,
  type DefinitionSnapshot,
  type ParseAgentPort,
  type ParseFrontmatterPort,
  type ResolveModelPort,
} from "./agent-definition.ts";
import {
  AGENT_DEFINITION_TOOL,
  DEFINITION_BINDING_COMPANION_TOOLS,
  type DefinitionLoader,
} from "./definition-binding.ts";
import {
  createDefinedNativeEntry,
  type DefinedNativeContext,
  type DefinedNativeEntryOptions,
  type DefinedNativePorts,
  type DefinedOmpApi,
} from "./defined-native-entry.ts";
import type {
  NativeContext,
  NativeOmpApi,
  NativeWorkCallInspection,
  NativeWorkCallReference,
} from "./native-entry.ts";
import {
  observeNativeInstanceResult,
  type NativeInstanceResultAssociation,
  type NativeInstanceResultObservation,
} from "./native-instance-result.ts";
import {
  verifyNativeAutoloadSkills,
  verifyNativeChildRole,
  type NativeChildSkillExpectation,
} from "./native-child-text.ts";
import { deepFreeze, NATIVE_WORK_TOOL, sha256Hex } from "./native-work.ts";
import { canonicalWorkspaceRoot, currentTaskOwner } from "./task-entry-port.ts";

/**
 * Opt-in native instance entry.
 *
 * This module composes the unchanged explicit main-definition entry with a
 * bounded in-memory association table for native `task` children. It registers
 * no task tool, executor, model loop or persistence. Native discovery selects
 * the host's explicit child Markdown paths; the frozen child snapshot is
 * checked against actual child sessions, full Role/Skill text, model, tools
 * and the supported scoped-settings profile.
 *
 * One live main root is supported per process. The module-scoped root slot is
 * never reset by a child factory. A second main root is refused rather than
 * allowed to steal or reset the first.
 */

export const INSTANCED_NATIVE_ENTRY_VERSION = "0.1.0-instanced-native.1";
export const INSTANCED_NATIVE_ENTRY_SCHEMA = "omp-agent.instanced-native-entry.v1";
export const AGENT_CHILD_DEFINITIONS_FLAG = "agent-child-definitions";
export const AGENT_INSTANCES_STATUS_COMMAND = "agent-instances-status";

const COMPANION_TOOLS = new Set<string>(DEFINITION_BINDING_COMPANION_TOOLS);
const NATIVE_AGENTS_SPECIFIER = "@oh-my-pi/pi-coding-agent/task/agents";
const NATIVE_DISCOVERY_SPECIFIER = "@oh-my-pi/pi-coding-agent/task/discovery";
const NATIVE_UTILS_SPECIFIER = "@oh-my-pi/pi-utils";
const NATIVE_SKILLS_SPECIFIER = "@oh-my-pi/pi-coding-agent/extensibility/skills";
const NATIVE_SETTINGS_SPECIFIER = "@oh-my-pi/pi-coding-agent/config/settings";
const NATIVE_REGISTRY_SPECIFIER = "@oh-my-pi/pi-coding-agent/config/registry";
const ROLE_FRAME = "\u2042 Role\n{{agent}}\n\u2042 Coop";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const MAX_STARTUP_TIMEOUT_MS = 25_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 20_000;
const MAX_ADMISSION_TIMEOUT_MS = 25_000;
const MAX_TASK_BYTES = 64 * 1024;
const MAX_DESCRIPTIVE_CHARS = 16 * 1024;
const MAX_ID_CHARS = 256;
const MAX_PATH_CHARS = 4096;
const MAX_MESSAGE_CHARS = 320;
const MAX_TOOL_NAMES = 128;
const MAX_SKILL_RENDER_BYTES = 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024;

const DEFAULT_LIMITS: InstancedLimits = Object.freeze({
  maxDefinitions: 8,
  maxPending: 16,
  maxRecords: 64,
  maxRetainedTextBytes: 8 * 1024 * 1024,
});

const SUPPORTED_SETTING_IDS = [
  ["async.enabled", "boolean", "asyncEnabled"],
  ["task.batch", "boolean", "taskBatch"],
  ["task.speculativeLaunch", "boolean", "taskSpeculativeLaunch"],
  ["task.workerThreads", "number", "taskWorkerThreads"],
  ["task.structured", "boolean", "taskStructured"],
] as const;

type SettingId = typeof SUPPORTED_SETTING_IDS[number][0];
type SettingType = typeof SUPPORTED_SETTING_IDS[number][1];

export interface InstancedModel {
  readonly provider: string;
  readonly id: string;
  readonly api?: string;
}

export interface InstancedNativeContext extends NativeContext {
  readonly agent?: {
    readonly kind?: "main" | "sub";
    readonly id?: string;
    readonly name?: string;
    readonly parentId?: string | null;
    readonly depth?: number;
  } | null;
  readonly hasUI?: boolean;
  readonly ui?: {
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
  readonly model?: InstancedModel | undefined;
  readonly models?: {
    resolve?(spec: string): InstancedModel | undefined;
    current?(): InstancedModel | undefined;
  };
  abort?(): void;
}

export interface InstancedOmpApi extends DefinedOmpApi {
  readonly events?: {
    on?(event: string, handler: (data: unknown) => void): void;
  } | null;
}

interface InstancedEventBus {
  on(event: string, handler: (data: unknown) => void): void;
}

export interface InstancedSupportedSettings {
  readonly asyncEnabled: boolean;
  readonly taskBatch: boolean;
  readonly taskSpeculativeLaunch: boolean;
  readonly taskWorkerThreads: number;
  readonly taskStructured: boolean;
}

export type InstancedSettingsResult =
  | { readonly ok: true; readonly settings: InstancedSupportedSettings }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface InstancedDiscoveredAgent {
  readonly name: string;
  readonly filePath: string;
  readonly source: string;
}

export interface InstancedSkillRenderInput {
  readonly name: string;
  readonly filePath: string;
  readonly baseDir: string;
}

export interface InstancedNativePorts {
  readonly parseAgent: ParseAgentPort;
  readonly parseFrontmatter: ParseFrontmatterPort;
  readonly getActiveSkills: () => readonly unknown[];
  readonly discoverAgents: (cwd: string) => Promise<readonly InstancedDiscoveredAgent[]>;
  readonly renderRoleFrame: (body: string) => string;
  readonly renderSkillMessage: (skill: InstancedSkillRenderInput, body: string) => unknown;
  readonly readScopedSettings: () => InstancedSettingsResult;
}

export interface InstancedChildSnapshotInput {
  readonly definitionPath: string;
  readonly workspaceRoot: string;
  readonly availableTools: readonly string[];
  readonly currentModel: DefinitionModelRef;
  readonly resolveModel: ResolveModelPort;
}

export interface InstancedLimits {
  /** At most eight; the remaining caps can only be reduced from the defaults. */
  readonly maxDefinitions: number;
  readonly maxPending: number;
  readonly maxRecords: number;
  readonly maxRetainedTextBytes: number;
}

export interface InstancedDiagnostic {
  readonly type: string;
  readonly message: string;
  readonly phase: "unselected" | "starting" | "ready" | "failed" | "closed";
  readonly factoryId: number;
  readonly rootId: number | null;
  readonly instanceId: string | null;
  readonly definitionName: string | null;
  readonly version: string | null;
}

export interface InstancedNativeEntryOptions {
  /** Test/integration seam; production reads the registered string flag once. */
  readonly mainDefinitionPath?: string;
  /** Test seam; production reads the JSON string flag once at first main start. */
  readonly childDefinitions?: string | readonly string[];
  /** Injected native parser/discovery/renderer/settings ports. */
  readonly nativePorts?: InstancedNativePorts;
  readonly loadMainDefinition?: DefinitionLoader;
  readonly loadChildDefinition?: (input: InstancedChildSnapshotInput) => Promise<DefinitionSnapshot>;
  readonly startupTimeoutMs?: number;
  readonly admissionTimeoutMs?: number;
  readonly limits?: Partial<InstancedLimits>;
  readonly diagnostic?: (event: InstancedDiagnostic) => void;
}

export type InstancedStatusPhaseCounts = Readonly<Record<"admitted" | "bound" | "refused" | "closed", number>>;

export type InstancedStatusView =
  | {
      readonly complete: true;
      readonly budgetBytes: number;
      readonly detailBytes: number;
      readonly detailSha256: string;
    }
  | {
      readonly complete: false;
      readonly reason: "encoded-size-limit";
      readonly budgetBytes: number;
      readonly detailBytes: number;
      readonly detailSha256: string;
      readonly omitted: {
        readonly selections: number;
        readonly pending: number;
        readonly instances: number;
        readonly instancePhases: InstancedStatusPhaseCounts;
      };
      /** Present only when the bounded summary itself needed a compact tier. */
      readonly omittedFields?: readonly string[];
    }
  | {
      readonly complete: false;
      readonly reason: "status-unavailable";
      readonly budgetBytes: number;
      /** No full detail was built; these measurements are not available. */
      readonly detailBytes: null;
      readonly detailSha256: null;
      /** Encoded measurements of the fallback payload only, never full state. */
      readonly fallbackBytes: number;
      readonly fallbackSha256: string;
      /** Unknown because snapshot construction threw; null is not observed zero. */
      readonly omitted: {
        readonly selections: null;
        readonly pending: null;
        readonly instances: null;
        readonly instancePhases: null;
      };
      /** Snapshot fields replaced by explicit unavailable placeholders. */
      readonly unavailable: readonly string[];
      readonly omittedFields?: readonly string[];
    };

export type InstancedWorkObservationHook =
  | "tool_call"
  | "input"
  | "before_agent_start"
  | "tool_result"
  | "agent_end"
  | "session_stop";

export interface InstancedWorkObservationStatus {
  /**
   * The last real owner-main hook that stored this work observation, with its
   * hook label. This is observation time, never live currentness.
   */
  readonly scope: "last-owner-main-hook";
  readonly capture: "captured" | "unavailable";
  readonly captureReason: string | null;
  readonly hook: InstancedWorkObservationHook | null;
  readonly error: string | null;
  readonly invalidatedReason: string | null;
  readonly inspection: NativeWorkCallInspection | null;
}

export interface InstancedResultObservationStatus {
  readonly observation: NativeInstanceResultObservation | null;
  readonly error: string | null;
}

export interface InstancedLifecycleEvidenceStatus {
  readonly completed: boolean;
  readonly failed: boolean;
  readonly aborted: boolean;
}

export interface InstancedInstanceObservationStatus {
  /**
   * Stored facts only. getStatus replays these fields; it never queries the
   * live host, current work or a cached context.
   */
  readonly work: InstancedWorkObservationStatus;
  readonly result: InstancedResultObservationStatus;
  /** Sticky native lifecycle callback evidence, separate from the work hook. */
  readonly lifecycleEvidence: InstancedLifecycleEvidenceStatus;
  readonly conflict: { readonly code: string; readonly message: string } | null;
}

export interface InstancedEntryStatus {
  readonly schema: typeof INSTANCED_NATIVE_ENTRY_SCHEMA;
  readonly authority: "non-authoritative";
  readonly version: typeof INSTANCED_NATIVE_ENTRY_VERSION;
  readonly phase: "unselected" | "starting" | "ready" | "failed" | "closed";
  readonly failure: string | null;
  readonly closeReason: string | null;
  readonly restartRequired: boolean;
  readonly factory: {
    readonly id: number;
    readonly ownsRoot: boolean;
    readonly refusedReason: string | null;
    readonly disposed: boolean;
  };
  readonly main: {
    readonly phase: string;
    readonly failure: string | null;
    readonly bindingId: string | null;
    readonly version: string | null;
  };
  readonly root: {
    readonly agentId: string | null;
    readonly sessionId: string | null;
    readonly workspaceRoot: string | null;
    readonly epoch: number;
    readonly workEpoch: number;
  } | null;
  readonly settings: {
    readonly profile: "supported";
    readonly values: InstancedSupportedSettings;
  } | null;
  readonly selections: readonly {
    readonly name: string;
    readonly definitionPath: string;
    readonly canonicalPath: string;
    readonly version: string;
    readonly model: DefinitionModelRef;
    readonly tools: readonly string[];
  }[];
  readonly capacity: {
    readonly definitions: { readonly used: number | null; readonly limit: number };
    readonly pending: { readonly used: number | null; readonly limit: number };
    readonly records: { readonly used: number | null; readonly limit: number };
    readonly retainedTextBytes: { readonly used: number | null; readonly limit: number };
    readonly usedToolCallIds: number | null;
    readonly toolCallIdLimit: number;
  };
  readonly pending: readonly {
    readonly parentToolCallId: string;
    readonly agentName: string;
    readonly state: string;
    readonly startedAt: number;
  }[];
  readonly instances: readonly {
    readonly id: string;
    readonly definitionName: string;
    readonly definitionPath: string;
    readonly canonicalPath: string;
    readonly version: string;
    readonly parentToolCallId: string;
    readonly index: 0;
    readonly inputDigest: string;
    readonly phase: string;
    readonly childId: string | null;
    readonly childSessionId: string | null;
    readonly childCwd: string | null;
    readonly childDepth: number | null;
    readonly model: DefinitionModelRef;
    readonly tools: readonly string[];
    readonly roleGate: string;
    readonly skillGate: string;
    readonly roleVerifications: number;
    readonly skillVerifications: number;
    readonly roleRefusalCode: string | null;
    readonly skillRefusalCode: string | null;
    readonly refusalCode: string | null;
    readonly refusalMessage: string | null;
    readonly lifecycle: string;
    readonly lifecycleTerminal: boolean;
    readonly taskResultObserved: boolean;
    readonly observation: InstancedInstanceObservationStatus;
    readonly closedReason: string | null;
    readonly retainedBytes: number;
  }[];
  readonly lastRefusal: { readonly code: string; readonly message: string } | null;
  readonly nativeEventBus: "subscribed" | "unavailable";
  readonly view: InstancedStatusView;
}

type InstancedStatusDetail = Omit<InstancedEntryStatus, "view">;

export interface InstancedNativeEntryControls {
  readonly controller: ReturnType<typeof createDefinedNativeEntry>["controller"];
  readonly nativeEntry: ReturnType<typeof createDefinedNativeEntry>["nativeEntry"];
  getStatus(): InstancedEntryStatus;
  dispose(): void;
}

type DefinedControls = ReturnType<typeof createDefinedNativeEntry>;
type NativeTool = Parameters<DefinedOmpApi["registerTool"]>[0];

interface HostFacts {
  readonly agentKind: "main" | "sub" | "unknown";
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly parentId: string | null;
  readonly depth: number | null;
  readonly sessionId: string | null;
  readonly workspaceRoot: string | null;
}

interface SelectedDefinition {
  readonly name: string;
  readonly definitionPath: string;
  readonly canonicalPath: string;
  readonly version: string;
  readonly model: DefinitionModelRef;
  readonly tools: readonly string[];
}

interface PendingAdmission {
  readonly parentToolCallId: string;
  readonly agentName: string;
  readonly token: object;
  readonly admittedEpoch: number;
  readonly workEpoch: number;
  readonly startedAt: number;
  readonly workRef: NativeWorkCallReference | null;
  readonly workCaptureReason: string | null;
  readonly workInspection: NativeWorkCallInspection | null;
  readonly workInspectionHook: InstancedWorkObservationHook | null;
  state: "loading" | "invalidated" | "timedout";
}

interface InstanceRecord {
  readonly id: string;
  readonly definition: SelectedDefinition;
  readonly snapshot: DefinitionSnapshot;
  readonly skillExpectations: readonly NativeChildSkillExpectation[];
  readonly parentToolCallId: string;
  readonly index: 0;
  readonly inputDigest: string;
  readonly admittedEpoch: number;
  readonly admittedRootToken: symbol;
  readonly admittedWorkEpoch: number;
  readonly retainedBytes: number;
  phase: "admitted" | "bound" | "refused" | "closed";
  childId: string | null;
  childFactoryId: number | null;
  childRootToken: symbol | null;
  childSessionId: string | null;
  childCwd: string | null;
  childDepth: number | null;
  childParentId: string | null;
  childName: string | null;
  lifecycleSessionFile: string | null;
  roleGate: "unobserved" | "verified" | "refused";
  skillGate: "unobserved" | "verified" | "refused";
  roleVerifications: number;
  skillVerifications: number;
  roleRefusalCode: string | null;
  skillRefusalCode: string | null;
  refusalCode: string | null;
  refusalMessage: string | null;
  lifecycle: string;
  lifecycleTerminal: boolean;
  taskResultObserved: boolean;
  workRef: NativeWorkCallReference | null;
  workCaptureReason: string | null;
  workInspection: NativeWorkCallInspection | null;
  workInspectionHook: InstancedWorkObservationHook | null;
  workObservationError: string | null;
  workInvalidatedReason: string | null;
  resultObservation: NativeInstanceResultObservation | null;
  resultObservationError: string | null;
  readonly lifecycleEvidence: { completed: boolean; failed: boolean; aborted: boolean };
  resultLifecycleConflict: { code: string; message: string } | null;
  closedReason: string | null;
}

interface RootState {
  readonly token: symbol;
  readonly id: number;
  readonly factoryId: number;
  readonly bus: InstancedEventBus | null;
  phase: "starting" | "ready" | "failed" | "closed";
  open: boolean;
  failure: string | null;
  closeReason: string | null;
  restartRequired: boolean;
  epoch: number;
  workEpoch: number;
  agentId: string | null;
  sessionId: string | null;
  workspaceRoot: string | null;
  settings: InstancedSupportedSettings | null;
  selections: readonly SelectedDefinition[];
  selectionByName: Map<string, SelectedDefinition>;
  ports: InstancedNativePorts | null;
  pending: Map<string, PendingAdmission>;
  records: InstanceRecord[];
  recordByToolCall: Map<string, InstanceRecord>;
  recordByChildId: Map<string, InstanceRecord>;
  seenToolCalls: Set<string>;
  seenLifecycle: WeakSet<object>;
  retainedBytes: number;
  refusalCount: number;
  lastRefusal: { code: string; message: string } | null;
}

interface FactoryContext {
  readonly id: number;
  readonly bus: InstancedEventBus | null;
  /**
   * Root generation that existed when this factory was constructed. A factory
   * created under an old root can never bind or adopt a later root generation.
   */
  readonly homeRootToken: symbol | null;
  /**
   * One factory may freeze at most one child record. This is the reverse of
   * InstanceRecord.childFactoryId and prevents a reused child factory from
   * claiming a second native child identity in the same root.
   */
  childRecordId: string | null;
  readonly limits: InstancedLimits;
  readonly startupTimeoutMs: number;
  readonly rootStartupTimeoutMs: number;
  readonly admissionTimeoutMs: number;
  readonly definitionEntry: DefinedControls;
  readonly portsPromise: Promise<InstancedNativePorts>;
  readonly loadChildDefinition: ((input: InstancedChildSnapshotInput) => Promise<DefinitionSnapshot>) | undefined;
  readonly diagnostic: ((event: InstancedDiagnostic) => void) | undefined;
  statusCommandRegistered: boolean;
  eventBusSubscribed: boolean;
  rootToken: symbol | null;
  refusedReason: string | null;
  disposed: boolean;
}

let moduleRoot: RootState | null = null;
let nextFactoryId = 1;
let nextRootId = 1;
let nextInstanceId = 1;
// Bounded by object liveness: a retired bus cannot be used for a replacement
// root. The same bus has no event generation marker, so reused parent call IDs
// cannot be isolated after dispose; a fresh process/bus is required.
const retiredBuses = new WeakSet<object>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedMessage(value: string): string {
  const normalized = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_MESSAGE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_MESSAGE_CHARS - 3)}...`;
}

function boundedId(value: string): string | null {
  if (value.length === 0 || value.length > MAX_ID_CHARS || value.includes("\0")) return null;
  return value;
}

function boundedString(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function stderr(message: string, details?: unknown): void {
  try {
    process.stderr.write(`${JSON.stringify({
      type: "omp_agent_instanced_native_entry",
      message,
      ...(details === undefined ? {} : { details }),
    })}\n`);
  } catch {
    // Observability must not break the host.
  }
}

function asModel(value: unknown): InstancedModel | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.provider !== "string" || value.provider.length === 0) return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  return {
    provider: value.provider,
    id: value.id,
    ...(typeof value.api === "string" ? { api: value.api } : {}),
  };
}

function readHostFacts(context: NativeContext): HostFacts {
  const ctx = context as InstancedNativeContext;
  let sessionId: string | null = null;
  let workspaceRoot: string | null = null;
  try {
    const value = ctx.sessionManager?.getSessionId();
    if (typeof value === "string" && value.length > 0) sessionId = boundedId(value);
  } catch {
    // Identity unavailable; callers fail closed.
  }
  try {
    const value = ctx.sessionManager?.getCwd();
    if (typeof value === "string" && value.length > 0) workspaceRoot = canonicalWorkspaceRoot(value);
  } catch {
    // Fall through to the construction-time cwd below.
  }
  try {
    if (workspaceRoot === null && typeof ctx.cwd === "string" && ctx.cwd.length > 0) {
      workspaceRoot = canonicalWorkspaceRoot(ctx.cwd);
    }
  } catch {
    // Identity unavailable.
  }
  const agent = ctx.agent;
  const agentKind = agent?.kind === "main" ? "main" : agent?.kind === "sub" ? "sub" : "unknown";
  const rawDepth = agent?.depth;
  return {
    agentKind,
    agentId: typeof agent?.id === "string" && agent.id.length > 0 ? boundedId(agent.id) : null,
    agentName: typeof agent?.name === "string" && agent.name.length > 0 ? boundedString(agent.name, 256) : null,
    parentId: typeof agent?.parentId === "string" && agent.parentId.length > 0 ? boundedId(agent.parentId) : null,
    depth: typeof rawDepth === "number" && Number.isInteger(rawDepth) ? rawDepth : null,
    sessionId,
    workspaceRoot,
  };
}

/**
 * Ordinary parent-hook observation requires the complete bound owner identity.
 * A foreign main context with the same agent id but another live session or
 * cwd neither refreshes records nor acts as the owner work-ending hook.
 */
function matchesOwnerIdentity(root: RootState, facts: HostFacts): boolean {
  return facts.agentKind === "main"
    && root.agentId !== null
    && facts.agentId === root.agentId
    && root.sessionId !== null
    && facts.sessionId === root.sessionId
    && root.workspaceRoot !== null
    && facts.workspaceRoot === root.workspaceRoot;
}

function readCurrentModel(context: NativeContext): InstancedModel | undefined {
  const ctx = context as InstancedNativeContext;
  try {
    const value = asModel(ctx.models?.current?.());
    if (value !== undefined) return value;
  } catch {
    // Fall through to the direct host model field.
  }
  try {
    return asModel(ctx.model);
  } catch {
    return undefined;
  }
}

function resolveModelFromContext(context: NativeContext, selector: string): DefinitionModelRef | undefined {
  const ctx = context as InstancedNativeContext;
  try {
    const value = asModel(ctx.models?.resolve?.(selector));
    if (value === undefined) return undefined;
    return { provider: value.provider, id: value.id };
  } catch {
    return undefined;
  }
}

function readActiveTools(pi: DefinedOmpApi): string[] | null {
  if (typeof pi.getActiveTools !== "function") return null;
  try {
    const tools = pi.getActiveTools();
    if (!Array.isArray(tools) || tools.length > MAX_TOOL_NAMES) return null;
    if (tools.some((tool) => typeof tool !== "string" || tool.length === 0)) return null;
    return [...new Set(tools)];
  } catch {
    return null;
  }
}

function readEventBus(pi: InstancedOmpApi): InstancedEventBus | null {
  const bus = pi.events;
  if (!isRecord(bus) || typeof bus.on !== "function") return null;
  return bus as unknown as InstancedEventBus;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameModel(left: InstancedModel | undefined, right: DefinitionModelRef): boolean {
  return left !== undefined && left.provider === right.provider && left.id === right.id;
}

function abortNow(context: NativeContext): void {
  try {
    (context as InstancedNativeContext).abort?.();
  } catch {
    // Synchronous best effort; refusal state is already sticky.
  }
}

function readSkillMetadata(raw: unknown): DefinitionSkillMetadata[] {
  if (!Array.isArray(raw)) throw new Error("getActiveSkills() did not return the native Skill array.");
  return raw.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Active Skill[${index}] metadata is not an object.`);
    const { name, description, filePath } = entry;
    if (typeof name !== "string" || name.length === 0
      || typeof description !== "string"
      || typeof filePath !== "string" || filePath.length === 0) {
      throw new Error(`Active Skill[${index}] lacks native name/filePath/description metadata.`);
    }
    return { name, description, filePath };
  });
}

function clampTimeout(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function readLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, fallback);
}

function normalizeLimits(limits: Partial<InstancedLimits> | undefined): InstancedLimits {
  return {
    maxDefinitions: readLimit(limits?.maxDefinitions, DEFAULT_LIMITS.maxDefinitions),
    maxPending: readLimit(limits?.maxPending, DEFAULT_LIMITS.maxPending),
    maxRecords: readLimit(limits?.maxRecords, DEFAULT_LIMITS.maxRecords),
    maxRetainedTextBytes: readLimit(limits?.maxRetainedTextBytes, DEFAULT_LIMITS.maxRetainedTextBytes),
  };
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ readonly ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
  });
  try {
    return await Promise.race([promise.then((value) => ({ ok: true as const, value })), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function checkSupportedSettings(result: InstancedSettingsResult):
  | { readonly ok: true; readonly settings: InstancedSupportedSettings }
  | { readonly ok: false; readonly message: string } {
  if (!result.ok) return { ok: false, message: `${result.code}: ${result.message}` };
  const settings = result.settings;
  if (settings.asyncEnabled !== false) return { ok: false, message: "async.enabled must be false." };
  if (settings.taskBatch !== false) return { ok: false, message: "task.batch must be false." };
  if (settings.taskSpeculativeLaunch !== false) return { ok: false, message: "task.speculativeLaunch must be false." };
  if (settings.taskWorkerThreads !== 0) return { ok: false, message: "task.workerThreads must be 0." };
  if (settings.taskStructured !== false) return { ok: false, message: "task.structured must be false." };
  return {
    ok: true,
    settings: {
      asyncEnabled: false,
      taskBatch: false,
      taskSpeculativeLaunch: false,
      taskWorkerThreads: 0,
      taskStructured: false,
    },
  };
}

function readSupportedSettings(ports: InstancedNativePorts):
  | { readonly ok: true; readonly settings: InstancedSupportedSettings }
  | { readonly ok: false; readonly message: string } {
  try {
    const result = ports.readScopedSettings();
    if (!isRecord(result)) return { ok: false, message: "Scoped settings reader returned no result." };
    return checkSupportedSettings(result as InstancedSettingsResult);
  } catch (error) {
    return { ok: false, message: `Scoped settings read failed: ${errorMessage(error)}` };
  }
}

function parseChildSelection(raw: unknown, maxDefinitions: number): string[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("--agent-child-definitions must be a JSON array of absolute Agent Markdown paths.");
    }
  }
  if (!Array.isArray(value)) {
    throw new Error("--agent-child-definitions must be a JSON array of absolute Agent Markdown paths.");
  }
  if (value.length < 1 || value.length > maxDefinitions) {
    throw new Error(`--agent-child-definitions must select 1-${maxDefinitions} paths.`);
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_PATH_CHARS || item.includes("\0")) {
      throw new Error("Every --agent-child-definitions entry must be a bounded path string.");
    }
    if (!path.isAbsolute(item) || path.resolve(item) !== item || !item.toLowerCase().endsWith(".md")) {
      throw new Error(`Selected child definition path must be a normalized absolute .md path: ${JSON.stringify(item)}.`);
    }
    if (seen.has(item)) throw new Error(`Duplicate child definition path ${JSON.stringify(item)}.`);
    seen.add(item);
    paths.push(item);
  }
  return paths;
}

function selectionFromSnapshot(
  definitionPath: string,
  snapshot: DefinitionSnapshot,
): SelectedDefinition {
  const model = { provider: snapshot.definition.model.provider, id: snapshot.definition.model.id };
  return deepFreeze({
    name: snapshot.definition.name,
    definitionPath,
    canonicalPath: snapshot.definition.canonicalPath,
    version: snapshot.version,
    model,
    tools: [...snapshot.definition.effectiveTools],
  });
}

function validateSnapshotHeader(snapshot: DefinitionSnapshot, workspaceRoot: string): void {
  if (snapshot.workspaceRoot !== workspaceRoot) {
    throw new Error("The child snapshot workspace differs from the live main workspace.");
  }
  if (snapshot.definition.model.selector === null) {
    throw new Error("A child definition must declare an explicit model.");
  }
  if (!path.isAbsolute(snapshot.definition.canonicalPath)) {
    throw new Error("The child definition canonical path is not absolute.");
  }
  if (snapshot.definition.effectiveTools.some((tool) => COMPANION_TOOLS.has(tool))) {
    throw new Error("A child definition cannot select plugin companion tools.");
  }
}

function assertToolsWithinCeiling(tools: readonly string[], ceiling: readonly string[]): void {
  const allowed = new Set(ceiling);
  if (tools.some((tool) => !allowed.has(tool))) {
    throw new Error("The child definition tool set is not a subset of the actual main native tool ceiling.");
  }
}

function discoveryFailure(snapshot: DefinitionSnapshot, discovered: readonly InstancedDiscoveredAgent[]): string | null {
  const name = snapshot.definition.name;
  const canonicalPath = snapshot.definition.canonicalPath;
  const exact = discovered.filter((agent) => agent.filePath === canonicalPath);
  if (exact.length !== 1) {
    return exact.length === 0
      ? "Native discovery did not select the exact explicit child path."
      : "Native discovery returned the explicit child path more than once.";
  }
  const selected = exact[0]!;
  if (selected.name !== name) {
    return "Native discovery selected a different name than the explicit child snapshot.";
  }
  if (selected.source !== "project" && selected.source !== "user") {
    return `Native discovery source ${JSON.stringify(selected.source)} is not an allowed project/user definition.`;
  }
  const sameName = discovered.filter((agent) => agent.name === name);
  if (sameName.length !== 1 || sameName[0]!.filePath !== canonicalPath) {
    return "Another native definition with the same name won discovery; the selected path is not authoritative.";
  }
  return null;
}

function defaultChildLoader(ports: InstancedNativePorts) {
  return async (input: InstancedChildSnapshotInput): Promise<DefinitionSnapshot> => {
    return await loadNativeChildDefinitionSnapshot({
      definitionPath: input.definitionPath,
      workspaceRoot: input.workspaceRoot,
      parseAgent: ports.parseAgent,
      parseFrontmatter: ports.parseFrontmatter,
      availableSkills: readSkillMetadata(ports.getActiveSkills()),
      availableTools: input.availableTools,
      currentModel: input.currentModel,
      resolveModel: input.resolveModel,
      nativeSource: "explicit",
    });
  };
}

function buildSkillExpectations(
  snapshot: DefinitionSnapshot,
  ports: InstancedNativePorts,
): readonly NativeChildSkillExpectation[] {
  const expectations: NativeChildSkillExpectation[] = [];
  for (const skill of snapshot.skills) {
    const rendered = ports.renderSkillMessage({
      name: skill.name,
      filePath: skill.canonicalPath,
      baseDir: path.dirname(skill.canonicalPath),
    }, skill.body.trim());
    if (!isRecord(rendered)
      || typeof rendered.message !== "string"
      || rendered.message.length === 0
      || Buffer.byteLength(rendered.message) > MAX_SKILL_RENDER_BYTES) {
      throw new Error(`Native Skill renderer returned no supported message for ${JSON.stringify(skill.name)}.`);
    }
    if (!isRecord(rendered.details)
      || rendered.details.name !== skill.name
      || rendered.details.path !== skill.canonicalPath) {
      throw new Error(`Native Skill renderer metadata disagreed for ${JSON.stringify(skill.name)}.`);
    }
    expectations.push({
      name: skill.name,
      path: skill.canonicalPath,
      content: rendered.message,
    });
  }
  return deepFreeze(expectations);
}

function retainedTextBytes(snapshot: DefinitionSnapshot, skills: readonly NativeChildSkillExpectation[]): number {
  let bytes = Buffer.byteLength(snapshot.definition.body);
  for (const skill of snapshot.skills) bytes += Buffer.byteLength(skill.body);
  for (const skill of skills) bytes += Buffer.byteLength(skill.content);
  return bytes;
}

function diagnose(
  factory: FactoryContext,
  type: string,
  message: string,
  details: { readonly instanceId?: string; readonly definitionName?: string; readonly version?: string } = {},
): void {
  const root = moduleRoot;
  try {
    factory.diagnostic?.({
      type,
      message: boundedMessage(message),
      phase: root === null ? "unselected" : root.phase,
      factoryId: factory.id,
      rootId: root === null ? null : root.id,
      instanceId: details.instanceId ?? null,
      definitionName: details.definitionName ?? null,
      version: details.version ?? null,
    });
  } catch {
    // Diagnostics cannot affect the gate.
  }
}

function markRefused(root: RootState, record: InstanceRecord, code: string, message: string): void {
  if (record.phase === "refused" || record.phase === "closed") return;
  record.phase = "refused";
  record.refusalCode = boundedString(code, 64);
  record.refusalMessage = boundedMessage(message);
  root.refusalCount += 1;
  root.lastRefusal = { code: record.refusalCode, message: record.refusalMessage };
}

function closeRecord(record: InstanceRecord, reason: string): void {
  if (record.phase !== "refused") record.phase = "closed";
  record.closedReason = boundedMessage(reason);
}

function invalidatePending(root: RootState, reason: string): void {
  for (const pending of root.pending.values()) pending.state = "invalidated";
  if (root.pending.size > 0) {
    root.lastRefusal = { code: "pending-invalidated", message: boundedMessage(reason) };
    root.pending.clear();
  }
}

/**
 * Native can prepare a task call and then skip execution after the parent work
 * ends. A published admission that never bound a child is therefore not live
 * authority: keep its bounded tombstone but refuse late lifecycle/session start.
 * Bound child sessions are deliberately outside this D2-B work-end scope.
 */
function invalidateUnboundAdmissions(root: RootState, reason: string): void {
  for (const record of root.records) {
    if (record.phase === "admitted") {
      markRefused(root, record, "work-ended", reason);
    }
  }
}

function ownsRoot(factory: FactoryContext, root: RootState): boolean {
  return !factory.disposed
    && moduleRoot === root
    && root.factoryId === factory.id
    && factory.rootToken !== null
    && root.token === factory.rootToken;
}

/**
 * Root disposal/navigation has no live parent context. Mark every stored work
 * observation unavailable instead of inventing a fresh inspection. Result
 * observations are historical facts and stay untouched.
 */
function invalidateWorkObservations(root: RootState, reason: string): void {
  const text = boundedMessage(reason);
  for (const record of root.records) {
    if (record.workRef === null && record.workInspection === null && record.workObservationError === null) continue;
    record.workInvalidatedReason = text;
    record.workInspection = null;
  }
}

function failRoot(factory: FactoryContext, root: RootState, code: string, message: string): void {
  if (root.phase === "closed" || root.phase === "failed") return;
  root.open = false;
  root.phase = "failed";
  root.failure = boundedMessage(message);
  root.restartRequired = true;
  root.lastRefusal = { code: boundedString(code, 64), message: root.failure };
  root.epoch += 1;
  invalidatePending(root, "the instance root failed");
  invalidateWorkObservations(root, "the instance root failed");
  for (const record of root.records) closeRecord(record, "the instance root failed");
  diagnose(factory, "root-failed", `${code}: ${message}`);
}

function closeRoot(factory: FactoryContext, root: RootState, reason: string): void {
  if (root.phase === "closed") return;
  root.open = false;
  root.phase = "closed";
  root.closeReason = boundedMessage(reason);
  root.restartRequired = true;
  root.epoch += 1;
  invalidatePending(root, reason);
  invalidateWorkObservations(root, reason);
  for (const record of root.records) closeRecord(record, reason);
  diagnose(factory, "root-closed", reason);
}

function refreshRoot(
  factory: FactoryContext,
  root: RootState,
  pi: DefinedOmpApi,
  context: NativeContext,
): boolean {
  if (!root.open || root.phase !== "ready") return false;
  const facts = readHostFacts(context);
  if (facts.agentKind !== "main"
    || root.agentId === null
    || facts.agentId !== root.agentId
    || root.sessionId === null
    || facts.sessionId !== root.sessionId
    || root.workspaceRoot === null
    || facts.workspaceRoot !== root.workspaceRoot) {
    failRoot(factory, root, "root-identity", "The live main session, workspace or root agent changed.");
    return false;
  }
  if (currentTaskOwner() !== undefined) {
    failRoot(factory, root, "owner-conflict", "A managed TaskOwner is now published; the native instance entry is refused.");
    return false;
  }
  if (root.ports === null) {
    failRoot(factory, root, "native-ports", "Native instance ports are unavailable.");
    return false;
  }
  const settings = readSupportedSettings(root.ports);
  if (!settings.ok) {
    failRoot(factory, root, "settings-drift", `Supported scoped settings drifted: ${settings.message}`);
    return false;
  }
  if (root.settings === null
    || settings.settings.asyncEnabled !== root.settings.asyncEnabled
    || settings.settings.taskBatch !== root.settings.taskBatch
    || settings.settings.taskSpeculativeLaunch !== root.settings.taskSpeculativeLaunch
    || settings.settings.taskWorkerThreads !== root.settings.taskWorkerThreads
    || settings.settings.taskStructured !== root.settings.taskStructured) {
    failRoot(factory, root, "settings-drift", "The supported scoped settings profile changed.");
    return false;
  }
  const allowed = factory.definitionEntry.controller.allowsObservation({
    agentKind: facts.agentKind,
    sessionId: facts.sessionId,
    workspaceRoot: facts.workspaceRoot,
    hasUI: (context as InstancedNativeContext).hasUI === true,
    hasPendingMessages: null,
  });
  if (!allowed) {
    const status = factory.definitionEntry.controller.getStatus();
    failRoot(factory, root, "main-binding", `D1 main binding is no longer valid: ${status.failure ?? status.phase}.`);
    return false;
  }
  return true;
}

function ensureChildSettings(factory: FactoryContext, root: RootState): boolean {
  if (root.ports === null) {
    failRoot(factory, root, "native-ports", "Native instance ports are unavailable for the child.");
    return false;
  }
  const settings = readSupportedSettings(root.ports);
  if (!settings.ok) {
    failRoot(factory, root, "settings-drift", `Child scoped settings are unsupported: ${settings.message}`);
    return false;
  }
  if (root.settings === null
    || settings.settings.asyncEnabled !== root.settings.asyncEnabled
    || settings.settings.taskBatch !== root.settings.taskBatch
    || settings.settings.taskSpeculativeLaunch !== root.settings.taskSpeculativeLaunch
    || settings.settings.taskWorkerThreads !== root.settings.taskWorkerThreads
    || settings.settings.taskStructured !== root.settings.taskStructured) {
    failRoot(factory, root, "settings-drift", "Child scoped settings differ from the supported root profile.");
    return false;
  }
  return true;
}

async function importInstancedPorts(): Promise<InstancedNativePorts> {
  // Literal specifiers are required for the fixed host rewrite. These modules
  // are supplied at runtime and are deliberately absent from package deps.
  const [agents, discovery, utils, skills, settings, registry] = await Promise.all([
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-coding-agent/task/agents"),
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-coding-agent/task/discovery"),
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-utils"),
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-coding-agent/extensibility/skills"),
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-coding-agent/config/registry"),
  ]);

  const parseAgent = agents?.parseAgent;
  const parseFrontmatter = utils?.parseFrontmatter;
  const getActiveSkills = skills?.getActiveSkills;
  const discoverAgentsNative = discovery?.discoverAgents;
  const renderSkillPromptMessage = skills?.renderSkillPromptMessage;
  const prompt = utils?.prompt;
  const findScopedSettings = settings?.findScopedSettings;
  const lookup = registry?.lookup;

  if (typeof parseAgent !== "function") throw new Error(`${NATIVE_AGENTS_SPECIFIER} does not export parseAgent.`);
  if (typeof parseFrontmatter !== "function") throw new Error(`${NATIVE_UTILS_SPECIFIER} does not export parseFrontmatter.`);
  if (typeof getActiveSkills !== "function") throw new Error(`${NATIVE_SKILLS_SPECIFIER} does not export getActiveSkills.`);
  if (typeof discoverAgentsNative !== "function") throw new Error(`${NATIVE_DISCOVERY_SPECIFIER} does not export discoverAgents.`);
  if (typeof renderSkillPromptMessage !== "function") {
    throw new Error(`${NATIVE_SKILLS_SPECIFIER} does not export renderSkillPromptMessage.`);
  }
  if (!isRecord(prompt) || typeof prompt.render !== "function") throw new Error(`${NATIVE_UTILS_SPECIFIER} does not export prompt.render.`);
  if (typeof findScopedSettings !== "function") throw new Error(`${NATIVE_SETTINGS_SPECIFIER} does not export findScopedSettings.`);
  if (typeof lookup !== "function") throw new Error(`${NATIVE_REGISTRY_SPECIFIER} does not export lookup.`);

  const readScopedSettings = (): InstancedSettingsResult => {
    const instance = findScopedSettings();
    if (instance === undefined || instance === null) {
      return { ok: false, code: "settings-instance-missing", message: "findScopedSettings() returned no active instance." };
    }
    const values: Record<string, boolean | number> = {};
    for (const [id, expectedType, key] of SUPPORTED_SETTING_IDS) {
      const handle = lookup(id);
      if (!isRecord(handle) || handle.type !== expectedType || typeof handle.get !== "function") {
        return { ok: false, code: "settings-handle-invalid", message: `Setting ${id} has no supported handle.` };
      }
      let value: unknown;
      try {
        value = (handle.get as (scope: unknown) => unknown)(instance);
      } catch (error) {
        return { ok: false, code: "settings-read-failed", message: `Setting ${id} read failed: ${errorMessage(error)}` };
      }
      if (expectedType === "boolean") {
        if (typeof value !== "boolean") {
          return { ok: false, code: "settings-type-invalid", message: `Setting ${id} is not a boolean.` };
        }
      } else if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, code: "settings-type-invalid", message: `Setting ${id} is not a finite number.` };
      }
      values[key] = value;
    }
    return {
      ok: true,
      settings: {
        asyncEnabled: values.asyncEnabled as boolean,
        taskBatch: values.taskBatch as boolean,
        taskSpeculativeLaunch: values.taskSpeculativeLaunch as boolean,
        taskWorkerThreads: values.taskWorkerThreads as number,
        taskStructured: values.taskStructured as boolean,
      },
    };
  };

  const discoverAgents = async (cwd: string): Promise<readonly InstancedDiscoveredAgent[]> => {
    const result = await (discoverAgentsNative as (cwd: string) => Promise<unknown>)(cwd);
    if (!isRecord(result) || !Array.isArray(result.agents)) {
      throw new Error("Native discoverAgents returned no supported agent list.");
    }
    const output: InstancedDiscoveredAgent[] = [];
    for (const agent of result.agents) {
      if (!isRecord(agent)
        || typeof agent.name !== "string"
        || agent.name.length === 0
        || typeof agent.filePath !== "string"
        || agent.filePath.length === 0
        || typeof agent.source !== "string") {
        throw new Error("Native discoverAgents returned an unsupported agent entry.");
      }
      try {
        output.push({
          name: agent.name,
          filePath: await realpath(agent.filePath),
          source: agent.source,
        });
      } catch {
        // An unreadable unrelated definition is not an authority candidate.
      }
    }
    return output;
  };

  return {
    parseAgent: parseAgent as ParseAgentPort,
    parseFrontmatter: parseFrontmatter as ParseFrontmatterPort,
    getActiveSkills: () => (getActiveSkills as () => readonly unknown[])(),
    discoverAgents,
    renderRoleFrame: (body: string): string => {
      const rendered = (prompt.render as (template: string, vars: Record<string, unknown>) => unknown)(ROLE_FRAME, { agent: body });
      if (typeof rendered !== "string") {
        throw new Error("Native prompt.render did not return the Role frame string.");
      }
      return rendered;
    },
    renderSkillMessage: (skill, body) => {
      return (renderSkillPromptMessage as (
        value: InstancedSkillRenderInput,
        args: { readonly args: string },
        content: string,
        mode: "autoload",
      ) => unknown)(skill, { args: "" }, body, "autoload");
    },
    readScopedSettings,
  };
}

function injectDefaultInactive(tool: NativeTool): NativeTool {
  if (tool.name !== AGENT_DEFINITION_TOOL && tool.name !== NATIVE_WORK_TOOL) return tool;
  return { ...tool, defaultInactive: true } as unknown as NativeTool;
}

/**
 * Composition adapter: only the new entry adds native `defaultInactive:true`
 * to the two D1 plugin companions. D1's unchanged main controller explicitly
 * activates them through setActiveTools after a successful bind.
 */
function compositionApi(pi: InstancedOmpApi): DefinedOmpApi {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: NativeTool) => target.registerTool(injectDefaultInactive(tool));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DefinedOmpApi;
}

function showInstanceStatus(factory: FactoryContext, context: DefinedNativeContext): void {
  let text: string;
  try {
    text = JSON.stringify(buildStatus(factory));
  } catch (error) {
    text = JSON.stringify(buildStatusFailure(factory, error));
  }
  try {
    if (context.hasUI === true && typeof context.ui?.notify === "function") {
      context.ui.notify(text, "info");
      return;
    }
    // Never write raw JSON to stdout: the host owns that stream in RPC.
    stderr("agent_instances_status", { text });
  } catch {
    // Display failure is not a gate decision.
  }
}

function registerStatusCommand(pi: InstancedOmpApi, factory: FactoryContext): boolean {
  if (typeof pi.registerCommand !== "function") return false;
  try {
    pi.registerCommand(AGENT_INSTANCES_STATUS_COMMAND, {
      description: "Show read-only bounded native child instance status.",
      handler(_args, context) {
        showInstanceStatus(factory, context);
      },
    });
    return true;
  } catch (error) {
    stderr("status_command_registration_failed", { reason: errorMessage(error) });
    return false;
  }
}

function subscribeLifecycle(factory: FactoryContext): boolean {
  const bus = factory.bus;
  if (bus === null) return false;
  try {
    bus.on("task:subagent:lifecycle", (data: unknown) => onLifecycleEvent(factory, bus, data));
    return true;
  } catch {
    return false;
  }
}

function readLifecycleSessionFile(data: Record<string, unknown>): string | null {
  const value = data.sessionFile;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS) return null;
  return value;
}

function onLifecycleEvent(factory: FactoryContext, bus: InstancedEventBus, data: unknown): void {
  try {
    if (factory.disposed) return;
    const root = moduleRoot;
    if (root === null || !root.open || root.phase !== "ready" || !isRecord(data)) return;
    // Only the factory that owns this exact root through this exact bus may
    // consume lifecycle events. A listener left on an old bus cannot mutate a
    // replacement root even when a parent call ID is reused.
    if (root.factoryId !== factory.id
      || factory.rootToken === null
      || root.token !== factory.rootToken
      || root.bus !== bus) {
      return;
    }
    if (root.seenLifecycle.has(data)) return;
    root.seenLifecycle.add(data);
    const status = typeof data.status === "string" ? boundedString(data.status, 64) : "";
    const id = typeof data.id === "string" ? boundedId(data.id) : null;
    const parentToolCallId = typeof data.parentToolCallId === "string" ? boundedId(data.parentToolCallId) : null;
    const sessionFile = readLifecycleSessionFile(data);
    const index = data.index;
    if (status === "started") {
      if (id === null || parentToolCallId === null || index !== 0) {
        root.lastRefusal = {
          code: "lifecycle-invalid",
          message: "A lifecycle started event lacked a supported child id, parent tool call id and index 0.",
        };
        return;
      }
      const record = root.recordByToolCall.get(parentToolCallId);
      if (record === undefined) {
        root.lastRefusal = {
          code: "lifecycle-unknown",
          message: "A lifecycle started event did not match an admission; it created no authority.",
        };
        return;
      }
      if (record.admittedRootToken !== root.token || record.admittedEpoch !== root.epoch) {
        markRefused(root, record, "lifecycle-stale", "The lifecycle event belongs to an invalidated root generation.");
        return;
      }
      if (record.admittedWorkEpoch !== root.workEpoch) {
        markRefused(root, record, "lifecycle-stale-work", "The lifecycle event arrived after the parent work that admitted the task ended.");
        return;
      }
      if (record.lifecycleSessionFile !== null
        && sessionFile !== null
        && record.lifecycleSessionFile !== sessionFile) {
        markRefused(root, record, "lifecycle-conflict", "A duplicate lifecycle event reported a conflicting session file.");
        return;
      }
      if (typeof data.agent === "string" && data.agent !== record.definition.name) {
        markRefused(root, record, "lifecycle-agent", "The lifecycle agent name differs from the selected definition.");
        return;
      }
      if (record.childId !== null) {
        if (record.childId === id) {
          if (record.lifecycleSessionFile === null && sessionFile !== null) {
            record.lifecycleSessionFile = sessionFile;
          }
          return;
        }
        markRefused(root, record, "lifecycle-conflict", "A second, different lifecycle child id was observed for this admission.");
        return;
      }
      if (record.phase !== "admitted") {
        markRefused(root, record, "lifecycle-not-admitted", "A lifecycle child id cannot attach to a refused or closed admission.");
        return;
      }
      const occupant = root.recordByChildId.get(id);
      if (occupant !== undefined && occupant !== record) {
        markRefused(root, record, "lifecycle-conflict", "The lifecycle child id is already attached to another admission.");
        return;
      }
      record.childId = id;
      if (sessionFile !== null) record.lifecycleSessionFile = sessionFile;
      record.lifecycle = "started";
      root.recordByChildId.set(id, record);
      return;
    }
    if (id === null) return;
    const record = root.recordByChildId.get(id);
    if (record === undefined) return;
    if (record.admittedRootToken !== root.token) return;
    // A terminal event may carry the same available parentToolCallId/index
    // identity. A conflicting event cannot close a different admitted call or
    // report it as completed.
    if (record.lifecycleSessionFile !== null
      && sessionFile !== null
      && record.lifecycleSessionFile !== sessionFile) {
      root.lastRefusal = {
        code: "lifecycle-terminal-conflict",
        message: "A lifecycle termination session file conflicted with the admitted child binding.",
      };
      return;
    }
    if (parentToolCallId !== null && parentToolCallId !== record.parentToolCallId) {
      root.lastRefusal = {
        code: "lifecycle-terminal-conflict",
        message: "A lifecycle termination parent tool call id conflicted with the admitted child binding.",
      };
      return;
    }
    if (index !== undefined && index !== record.index) {
      root.lastRefusal = {
        code: "lifecycle-terminal-conflict",
        message: "A lifecycle termination index conflicted with the admitted child binding.",
      };
      return;
    }
    if (typeof data.agent === "string" && data.agent !== record.definition.name) {
      root.lastRefusal = {
        code: "lifecycle-terminal-conflict",
        message: "A lifecycle termination agent name conflicted with the admitted child binding.",
      };
      return;
    }
    record.lifecycle = status.length === 0 ? "unknown" : status;
    if (status === "failed" || status === "aborted" || status === "completed") {
      record.lifecycleTerminal = true;
      // A later terminal status may overwrite `lifecycle`, but evidence of an
      // earlier observed abort/failure/completion remains explicit.
      if (status === "completed") record.lifecycleEvidence.completed = true;
      if (status === "failed") record.lifecycleEvidence.failed = true;
      if (status === "aborted") record.lifecycleEvidence.aborted = true;
      closeRecord(record, `native lifecycle ${status}`);
      assessResultLifecycleConflict(record);
    }
  } catch {
    // EventBus callbacks are not awaited and must never throw into the host.
  }
}

function claimRoot(factory: FactoryContext, context: NativeContext): RootState | null {
  if (factory.disposed) {
    return null;
  }
  if (factory.homeRootToken !== null) {
    factory.refusedReason = "This factory was constructed under an existing instance root and cannot become a replacement main root.";
    return null;
  }
  if (moduleRoot !== null) {
    factory.refusedReason = "A main root already owns this process; a second root is refused and cannot steal it.";
    if (moduleRoot.factoryId === factory.id) {
      closeRoot(factory, moduleRoot, "a second main session start was refused");
    }
    return null;
  }
  if (factory.refusedReason !== null) {
    // An earlier unknown scope or composition failure stays terminal for this
    // factory; it cannot later assume main-root authority.
    return null;
  }
  if (factory.bus !== null && retiredBuses.has(factory.bus)) {
    factory.refusedReason = "The native EventBus belonged to a disposed instance root; this process requires a fresh bus/process before a replacement root can be admitted.";
    diagnose(factory, "root-bus-retired", "A replacement root was refused because its EventBus generation was already retired.");
    return null;
  }
  const facts = readHostFacts(context);
  const root: RootState = {
    token: Symbol(`instanced-root-${nextRootId}`),
    id: nextRootId++,
    factoryId: factory.id,
    bus: factory.bus,
    phase: "starting",
    open: true,
    failure: null,
    closeReason: null,
    restartRequired: false,
    epoch: 0,
    workEpoch: 0,
    agentId: facts.agentId,
    sessionId: facts.sessionId,
    workspaceRoot: facts.workspaceRoot,
    settings: null,
    selections: [],
    selectionByName: new Map(),
    ports: null,
    pending: new Map(),
    records: [],
    recordByToolCall: new Map(),
    recordByChildId: new Map(),
    seenToolCalls: new Set(),
    seenLifecycle: new WeakSet(),
    retainedBytes: 0,
    refusalCount: 0,
    lastRefusal: null,
  };
  moduleRoot = root;
  factory.rootToken = root.token;
  return root;
}

async function prepareSelections(
  factory: FactoryContext,
  root: RootState,
  context: NativeContext,
  loader: (input: InstancedChildSnapshotInput) => Promise<DefinitionSnapshot>,
  ceiling: readonly string[],
  currentModel: DefinitionModelRef,
  rawSelection: string | readonly string[] | undefined,
): Promise<SelectedDefinition[]> {
  if (root.workspaceRoot === null || root.ports === null) throw new Error("Root workspace or native ports are unavailable.");
  if (rawSelection === undefined) throw new Error("No --agent-child-definitions selection was provided.");
  const paths = parseChildSelection(rawSelection, factory.limits.maxDefinitions);
  const resolveModel: ResolveModelPort = (selector) => resolveModelFromContext(context, selector);
  const discovered = await root.ports.discoverAgents(root.workspaceRoot);
  const snapshots: { definitionPath: string; snapshot: DefinitionSnapshot }[] = [];
  for (const definitionPath of paths) {
    const snapshot = await loader({
      definitionPath,
      workspaceRoot: root.workspaceRoot,
      availableTools: ceiling,
      currentModel,
      resolveModel,
    });
    validateSnapshotHeader(snapshot, root.workspaceRoot);
    assertToolsWithinCeiling(snapshot.definition.effectiveTools, ceiling);
    snapshots.push({ definitionPath, snapshot });
    const failure = discoveryFailure(snapshot, discovered);
    if (failure !== null) throw new Error(failure);
    // Validate the native Skill renderer now so a broken renderer cannot look
    // like a valid selection until the first delegation.
    buildSkillExpectations(snapshot, root.ports);
  }
  const names = new Set<string>();
  const selections = snapshots.map(({ definitionPath, snapshot }) => {
    if (names.has(snapshot.definition.name)) {
      throw new Error(`Duplicate selected child definition name ${JSON.stringify(snapshot.definition.name)}.`);
    }
    names.add(snapshot.definition.name);
    return selectionFromSnapshot(definitionPath, snapshot);
  });
  return deepFreeze(selections);
}

async function startRoot(
  factory: FactoryContext,
  root: RootState,
  pi: DefinedOmpApi,
  context: NativeContext,
  readChildDefinitions: () => string | readonly string[] | undefined,
): Promise<void> {
  const deadline = Date.now() + factory.rootStartupTimeoutMs;
  try {
    const facts = readHostFacts(context);
    if (facts.agentKind !== "main" || facts.agentId === null || facts.sessionId === null || facts.workspaceRoot === null) {
      throw new Error("The main root session, workspace or agent identity is unavailable.");
    }
    if (root.agentId !== facts.agentId || root.sessionId !== facts.sessionId || root.workspaceRoot !== facts.workspaceRoot) {
      throw new Error("The main root identity changed before startup validation.");
    }
    if (!factory.eventBusSubscribed) {
      throw new Error("The native task lifecycle EventBus is unavailable; child association cannot bind.");
    }
    const portsOutcome = await withDeadline(factory.portsPromise, remainingMs(deadline));
    if (!portsOutcome.ok) throw new Error("Native instance port loading timed out.");
    root.ports = portsOutcome.value;
    const idleOutcome = await withDeadline(factory.definitionEntry.controller.whenIdle(), remainingMs(deadline));
    if (!idleOutcome.ok) throw new Error("The D1 main definition binding did not settle within the startup bound.");
    const main = factory.definitionEntry.controller.getStatus();
    if (main.phase !== "bound") {
      throw new Error(`The required explicit D1 main definition is not bound: ${main.failure ?? main.phase}.`);
    }
    if (main.sessionId !== root.sessionId || main.workspaceRoot !== root.workspaceRoot || main.model === null) {
      throw new Error("The D1 main binding identity differs from the live native root session.");
    }
    const currentModel = readCurrentModel(context);
    if (currentModel === undefined || !sameModel(currentModel, main.model)) {
      throw new Error("The live main model differs from the D1 binding.");
    }
    if (currentTaskOwner() !== undefined) {
      throw new Error("A managed TaskOwner is published; the native instance entry is refused.");
    }
    const settings = readSupportedSettings(root.ports);
    if (!settings.ok) throw new Error(`Supported scoped settings are unavailable: ${settings.message}`);
    const activeTools = readActiveTools(pi);
    if (activeTools === null) throw new Error("The native main active tools are unavailable.");
    const ceiling = activeTools.filter((tool) => !COMPANION_TOOLS.has(tool));
    if (!sameSet(main.roleTools, ceiling) || !sameSet(main.effectiveTools, [...ceiling, ...COMPANION_TOOLS])) {
      throw new Error("The D1 main binding tools do not match the actual native main tool ceiling.");
    }
    if (ceiling.length === 0) throw new Error("The main native tool ceiling is empty; child definitions cannot be validated.");
    const selectionRaw = readChildDefinitions();
    const loader = factory.loadChildDefinition ?? defaultChildLoader(root.ports);
    const prepared = await withDeadline(
      prepareSelections(
        factory,
        root,
        context,
        loader,
        ceiling,
        { provider: currentModel.provider, id: currentModel.id },
        selectionRaw,
      ),
      remainingMs(deadline),
    );
    if (!prepared.ok) throw new Error("Child definition selection loading timed out.");
    const selections = prepared.value;

    if (!root.open || root.epoch !== 0) throw new Error("The root was invalidated while child selections were loading.");
    const finalFacts = readHostFacts(context);
    if (finalFacts.agentKind !== "main"
      || finalFacts.agentId !== root.agentId
      || finalFacts.sessionId !== root.sessionId
      || finalFacts.workspaceRoot !== root.workspaceRoot) {
      throw new Error("The main root identity changed while child selections were loading.");
    }
    if (currentTaskOwner() !== undefined) throw new Error("A managed TaskOwner was published during startup.");
    const finalSettings = readSupportedSettings(root.ports);
    if (!finalSettings.ok) throw new Error(`Supported scoped settings changed during startup: ${finalSettings.message}`);
    const finalTools = readActiveTools(pi);
    if (finalTools === null || !sameSet(finalTools, activeTools)) {
      throw new Error("The main active tools changed while child selections were loading.");
    }
    const finalModel = readCurrentModel(context);
    if (finalModel === undefined || finalModel.provider !== currentModel.provider || finalModel.id !== currentModel.id) {
      throw new Error("The main model changed while child selections were loading.");
    }
    if (!factory.definitionEntry.controller.allowsObservation({
      agentKind: "main",
      sessionId: finalFacts.sessionId,
      workspaceRoot: finalFacts.workspaceRoot,
      hasUI: (context as InstancedNativeContext).hasUI === true,
      hasPendingMessages: null,
    })) {
      throw new Error("The D1 main binding became invalid while child selections were loading.");
    }

    const selectionMap = new Map<string, SelectedDefinition>();
    for (const selection of selections) selectionMap.set(selection.name, selection);
    root.selections = selections;
    root.selectionByName = selectionMap;
    root.settings = settings.settings;
    root.phase = "ready";
    root.open = true;
    root.restartRequired = false;
    root.failure = null;
    diagnose(factory, "root-ready", `Selected ${selections.length} native child definition(s).`);
  } catch (error) {
    failRoot(factory, root, "startup-refused", errorMessage(error));
  }
}

function readTaskInput(raw: unknown):
  | {
    readonly ok: true;
    readonly agent: string;
    readonly task: string;
    readonly digest: string;
  }
  | { readonly ok: false; readonly reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "task input must be one flat object." };
  const allowed = new Set(["agent", "task", "description", "solutionSpace", "i"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    return { ok: false, reason: `task input has unsupported field(s): ${unknown.slice(0, 8).join(", ")}.` };
  }
  const agent = raw.agent;
  const task = raw.task;
  if (typeof agent !== "string" || agent.length === 0 || agent.length > 256) {
    return { ok: false, reason: "task input requires an explicit selected agent name." };
  }
  if (typeof task !== "string" || task.trim().length === 0 || Buffer.byteLength(task) > MAX_TASK_BYTES) {
    return { ok: false, reason: `task input requires non-empty task text of at most ${MAX_TASK_BYTES} bytes.` };
  }
  for (const key of ["description", "solutionSpace", "i"] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== "string" || value.length > MAX_DESCRIPTIVE_CHARS)) {
      return { ok: false, reason: `task input ${key} must be a string of at most ${MAX_DESCRIPTIVE_CHARS} characters.` };
    }
  }
  const digest = sha256Hex(JSON.stringify({
    agent,
    task,
    description: raw.description ?? null,
    solutionSpace: raw.solutionSpace ?? null,
    i: raw.i ?? null,
  }));
  return { ok: true, agent, task, digest };
}

async function loadAdmissionSnapshot(
  root: RootState,
  selected: SelectedDefinition,
  loader: (input: InstancedChildSnapshotInput) => Promise<DefinitionSnapshot>,
  ceiling: readonly string[],
  currentModel: DefinitionModelRef,
  resolveModel: ResolveModelPort,
): Promise<{ readonly snapshot: DefinitionSnapshot; readonly skills: readonly NativeChildSkillExpectation[] }> {
  if (root.workspaceRoot === null || root.ports === null) throw new Error("Root workspace or native ports are unavailable.");
  const snapshot = await loader({
    definitionPath: selected.definitionPath,
    workspaceRoot: root.workspaceRoot,
    availableTools: ceiling,
    currentModel,
    resolveModel,
  });
  validateSnapshotHeader(snapshot, root.workspaceRoot);
  assertToolsWithinCeiling(snapshot.definition.effectiveTools, ceiling);
  if (snapshot.definition.canonicalPath !== selected.canonicalPath) {
    throw new Error("The explicit child definition canonical path changed; the selection is no longer native-authoritative.");
  }
  if (snapshot.definition.name !== selected.name) {
    throw new Error("The explicit child definition name changed; a fresh root is required.");
  }
  const discovered = await root.ports.discoverAgents(root.workspaceRoot);
  const failure = discoveryFailure(snapshot, discovered);
  if (failure !== null) throw new Error(failure);
  return { snapshot, skills: buildSkillExpectations(snapshot, root.ports) };
}

function block(reason: string): { readonly block: true; readonly reason: string } {
  return { block: true, reason: boundedMessage(reason) };
}

interface CapturedWorkObservation {
  readonly ref: NativeWorkCallReference | null;
  readonly reason: string | null;
  readonly inspection: NativeWorkCallInspection | null;
}

function captureWorkObservation(
  factory: FactoryContext,
  toolCallId: string,
  context: NativeContext,
): CapturedWorkObservation {
  try {
    const captured = factory.definitionEntry.nativeEntry.captureCall(
      { toolCallId, toolName: "task" },
      context,
    );
    if (!captured.ok) {
      return {
        ref: null,
        reason: boundedMessage(`native work capture unavailable (${captured.inspection.reason})`),
        inspection: captured.inspection,
      };
    }
    return { ref: captured.ref, reason: null, inspection: captured.inspection };
  } catch (error) {
    return {
      ref: null,
      reason: boundedMessage(`native work capture failed: ${errorMessage(error)}`),
      inspection: null,
    };
  }
}

function inspectWorkObservation(
  factory: FactoryContext,
  ref: NativeWorkCallReference,
  context: NativeContext,
): { readonly ok: true; readonly inspection: NativeWorkCallInspection }
  | { readonly ok: false; readonly error: string } {
  try {
    return {
      ok: true,
      inspection: factory.definitionEntry.nativeEntry.inspectCall(ref, context),
    };
  } catch (error) {
    return { ok: false, error: boundedMessage(`native work inspection failed: ${errorMessage(error)}`) };
  }
}

/**
 * Re-observe every retained work reference with the actual parent context.
 * Each write is revalidated against the same module root, root token, factory
 * and record after the inspection because host getters may reenter navigation
 * or disposal. Read-only: no lock, queue or new record is created.
 */
function refreshWorkObservations(
  factory: FactoryContext,
  root: RootState,
  context: NativeContext,
  hook: InstancedWorkObservationHook,
): void {
  if (!ownsRoot(factory, root) || !root.open || root.phase !== "ready") return;
  let facts: HostFacts;
  try {
    facts = readHostFacts(context);
  } catch {
    return;
  }
  // A foreign main context with the same agent id must not write any record.
  if (!matchesOwnerIdentity(root, facts)) return;
  const rootToken = root.token;
  let scanned = 0;
  for (const record of root.records) {
    if (scanned >= factory.limits.maxRecords) break;
    scanned += 1;
    const ref = record.workRef;
    if (ref === null || record.admittedRootToken !== rootToken) continue;
    const outcome = inspectWorkObservation(factory, ref, context);
    if (!ownsRoot(factory, root) || root.token !== rootToken || !root.open || root.phase !== "ready") return;
    if (!root.records.includes(record)
      || root.recordByToolCall.get(record.parentToolCallId) !== record
      || record.admittedRootToken !== rootToken
      || record.workRef !== ref) {
      continue;
    }
    record.workInspectionHook = hook;
    if (!outcome.ok) {
      record.workInspection = null;
      record.workObservationError = outcome.error;
      continue;
    }
    record.workInspection = outcome.inspection;
    record.workObservationError = null;
  }
}

function expectedResultAssociation(
  record: InstanceRecord,
  root: RootState,
): NativeInstanceResultAssociation | null {
  if (root.sessionId === null || root.workspaceRoot === null) return null;
  return Object.freeze({
    instanceId: record.id,
    parentToolCallId: record.parentToolCallId,
    index: record.index,
    childId: record.childId,
    childSessionId: record.childSessionId,
    agentName: record.definition.name,
    parentSessionId: root.sessionId,
    workspaceRoot: root.workspaceRoot,
    rootEpoch: record.admittedEpoch,
    definitionVersion: record.definition.version,
  });
}

/**
 * One sticky diagnostic when an observed envelope and a known native lifecycle
 * terminal disagree. A normal close or a missing parent cancellation is never
 * treated as evidence by itself.
 */
function assessResultLifecycleConflict(record: InstanceRecord): void {
  if (record.resultLifecycleConflict !== null) return;
  const observation = record.resultObservation;
  if (observation === null || observation.state !== "observed") return;
  let code: string | null = null;
  let message: string | null = null;
  if (observation.outcome === "completed-envelope" && record.lifecycleEvidence.aborted) {
    code = "lifecycle-aborted-result-completed";
    message = "The native child lifecycle reported an abort, but the observed result envelope was complete.";
  } else if (observation.outcome === "completed-envelope" && record.lifecycleEvidence.failed) {
    code = "lifecycle-failed-result-completed";
    message = "The native child lifecycle reported failure, but the observed result envelope was complete.";
  } else if (observation.outcome === "aborted-envelope" && record.lifecycleEvidence.completed) {
    code = "lifecycle-completed-result-aborted";
    message = "The native child lifecycle reported completion, but the observed result envelope reported an abort.";
  } else if (observation.outcome === "failed-envelope" && record.lifecycleEvidence.completed) {
    code = "lifecycle-completed-result-failed";
    message = "The native child lifecycle reported completion, but the observed result envelope reported failure.";
  }
  if (code !== null && message !== null) {
    record.resultLifecycleConflict = { code, message: boundedMessage(message) };
  }
}

function recordAdmissionFailure(root: RootState, code: string, message: string): void {
  root.refusalCount += 1;
  root.lastRefusal = { code: boundedString(code, 64), message: boundedMessage(message) };
}

async function admitTask(
  factory: FactoryContext,
  root: RootState,
  pi: DefinedOmpApi,
  event: unknown,
  context: NativeContext,
): Promise<unknown> {
  try {
    if (!isRecord(event) || typeof event.toolCallId !== "string") {
      return block("task tool call has no usable call id.");
    }
    const toolCallId = boundedId(event.toolCallId);
    if (toolCallId === null) return block("task tool call id is unsupported.");
    const input = readTaskInput(event.input);
    if (!input.ok) {
      recordAdmissionFailure(root, "task-input", input.reason);
      return block(input.reason);
    }
    const selected = root.selectionByName.get(input.agent);
    if (selected === undefined) {
      const reason = `task input agent ${JSON.stringify(input.agent)} is not in the explicit child selection.`;
      recordAdmissionFailure(root, "task-agent", reason);
      return block(reason);
    }
    if (root.seenToolCalls.has(toolCallId)) {
      const reason = `task tool call id ${JSON.stringify(toolCallId)} was already used; a duplicate cannot overwrite a prior admission.`;
      recordAdmissionFailure(root, "duplicate-tool-call", reason);
      return block(reason);
    }
    if (!root.open || root.phase !== "ready") {
      return block(`The native instance root is not ready (${root.failure ?? root.phase}); no delegation was admitted.`);
    }
    if (root.pending.size >= factory.limits.maxPending) {
      const reason = `Instance pending-admission capacity (${factory.limits.maxPending}) is full; restart OMP to admit new delegation.`;
      recordAdmissionFailure(root, "capacity-pending", reason);
      return block(reason);
    }
    if (root.records.length + root.pending.size >= factory.limits.maxRecords) {
      const reason = `Instance record capacity (${factory.limits.maxRecords}) is full; restart OMP to admit new delegation.`;
      recordAdmissionFailure(root, "capacity-records", reason);
      return block(reason);
    }
    if (root.seenToolCalls.size >= factory.limits.maxRecords + factory.limits.maxPending) {
      const reason = "Instance tool-call identity capacity is full; restart OMP to admit new delegation.";
      recordAdmissionFailure(root, "capacity-calls", reason);
      return block(reason);
    }
    if (!refreshRoot(factory, root, pi, context)) {
      return block(root.failure ?? "The native instance root is no longer valid.");
    }
    const facts = readHostFacts(context);
    if (facts.agentKind !== "main" || facts.agentId !== root.agentId || facts.sessionId !== root.sessionId) {
      failRoot(factory, root, "root-identity", "The parent task call is not on the bound main root.");
      return block(root.failure ?? "The parent task call identity changed.");
    }
    const currentModel = readCurrentModel(context);
    if (currentModel === undefined) {
      failRoot(factory, root, "model-missing", "The live main model is unavailable.");
      return block(root.failure ?? "The live main model is unavailable.");
    }
    const activeTools = readActiveTools(pi);
    if (activeTools === null) {
      failRoot(factory, root, "tools-missing", "The live main active tools are unavailable.");
      return block(root.failure ?? "The live main active tools are unavailable.");
    }
    const ceiling = activeTools.filter((tool) => !COMPANION_TOOLS.has(tool));
    if (ceiling.length === 0) {
      failRoot(factory, root, "tools-empty", "The main native tool ceiling is empty.");
      return block(root.failure ?? "The main native tool ceiling is empty.");
    }
    const modelRef: DefinitionModelRef = { provider: currentModel.provider, id: currentModel.id };
    const resolveModel: ResolveModelPort = (selector) => resolveModelFromContext(context, selector);
    // Observation only: the native observer's earlier tool_call hook already
    // recorded this exact call. A missing/failed association never blocks an
    // otherwise valid admission and never falls back to current work.
    const workObservation = captureWorkObservation(factory, toolCallId, context);
    if (!ownsRoot(factory, root) || !root.open || root.phase !== "ready") {
      return block("The native instance root was invalidated while the task call was observed.");
    }
    const pending: PendingAdmission = {
      parentToolCallId: toolCallId,
      agentName: selected.name,
      token: {},
      admittedEpoch: root.epoch,
      workEpoch: root.workEpoch,
      startedAt: Date.now(),
      workRef: workObservation.ref,
      workCaptureReason: workObservation.reason,
      workInspection: workObservation.inspection,
      workInspectionHook: "tool_call",
      state: "loading",
    };
    root.seenToolCalls.add(toolCallId);
    root.pending.set(toolCallId, pending);
    const ports = root.ports;
    if (ports === null) {
      root.pending.delete(toolCallId);
      failRoot(factory, root, "native-ports", "Native instance ports are unavailable at admission.");
      return block(root.failure ?? "Native instance ports are unavailable.");
    }
    const childLoader = factory.loadChildDefinition ?? defaultChildLoader(ports);
    const load = loadAdmissionSnapshot(root, selected, childLoader, ceiling, modelRef, resolveModel);
    try {
      const outcome = await withDeadline(load, factory.admissionTimeoutMs);
      if (!outcome.ok) {
        if (root.pending.get(toolCallId) === pending) {
          pending.state = "timedout";
          root.pending.delete(toolCallId);
        }
        const reason = "Child snapshot admission timed out; no authority was published and a late load is ignored.";
        recordAdmissionFailure(root, "admission-timeout", reason);
        return block(reason);
      }
      const loaded = outcome.value;
      if (root.pending.get(toolCallId) !== pending
        || pending.state !== "loading"
        || !root.open
        || root.phase !== "ready"
        || root.epoch !== pending.admittedEpoch
        || root.workEpoch !== pending.workEpoch) {
        if (root.pending.get(toolCallId) === pending) root.pending.delete(toolCallId);
        const reason = "The child snapshot load became stale after the parent work, root or navigation changed; it was not published.";
        recordAdmissionFailure(root, "admission-stale", reason);
        return block(reason);
      }
      if (!refreshRoot(factory, root, pi, context)) {
        root.pending.delete(toolCallId);
        return block(root.failure ?? "The native instance root became invalid during admission.");
      }
      // Observe the original pre-await reference before the final host
      // validations. Host getters read by inspection can mutate identity or
      // tools without emitting navigation; those validations below catch the
      // reads. Observation unavailability itself never gates admission.
      let workInspection = pending.workInspection;
      let workObservationError: string | null = null;
      let workInspectionHook = pending.workInspectionHook;
      if (pending.workRef !== null) {
        const observed = inspectWorkObservation(factory, pending.workRef, context);
        if (root.pending.get(toolCallId) !== pending
          || pending.state !== "loading"
          || !ownsRoot(factory, root)
          || !root.open
          || root.phase !== "ready"
          || root.epoch !== pending.admittedEpoch
          || root.workEpoch !== pending.workEpoch) {
          if (root.pending.get(toolCallId) === pending) root.pending.delete(toolCallId);
          const reason = "The task work observation became stale after admission; the admission was not published.";
          recordAdmissionFailure(root, "admission-stale", reason);
          return block(reason);
        }
        workInspectionHook = "tool_call";
        if (observed.ok) {
          workInspection = observed.inspection;
          workObservationError = null;
        } else {
          workInspection = null;
          workObservationError = observed.error;
        }
      }
      const finalFacts = readHostFacts(context);
      if (finalFacts.agentKind !== "main"
        || finalFacts.agentId !== root.agentId
        || finalFacts.sessionId !== root.sessionId
        || finalFacts.workspaceRoot !== root.workspaceRoot) {
        root.pending.delete(toolCallId);
        failRoot(factory, root, "root-identity", "The parent task call identity changed during child snapshot loading.");
        return block(root.failure ?? "The parent task call identity changed.");
      }
      const finalTools = readActiveTools(pi);
      if (finalTools === null || !sameSet(finalTools, activeTools)) {
        root.pending.delete(toolCallId);
        failRoot(factory, root, "tools-drift", "The main active tools changed during child snapshot loading.");
        return block(root.failure ?? "The main active tools changed.");
      }
      const finalModel = readCurrentModel(context);
      if (finalModel === undefined
        || finalModel.provider !== currentModel.provider
        || finalModel.id !== currentModel.id) {
        root.pending.delete(toolCallId);
        failRoot(factory, root, "model-drift", "The main model changed during child snapshot loading.");
        return block(root.failure ?? "The main model changed.");
      }
      if (root.records.length >= factory.limits.maxRecords) {
        root.pending.delete(toolCallId);
        const reason = `Instance record capacity (${factory.limits.maxRecords}) filled during admission; restart OMP.`;
        recordAdmissionFailure(root, "capacity-records", reason);
        return block(reason);
      }
      const bytes = retainedTextBytes(loaded.snapshot, loaded.skills);
      if (root.retainedBytes + bytes > factory.limits.maxRetainedTextBytes) {
        root.pending.delete(toolCallId);
        const reason = `Instance retained initial-text capacity (${factory.limits.maxRetainedTextBytes} bytes) is full; restart OMP.`;
        recordAdmissionFailure(root, "capacity-text", reason);
        return block(reason);
      }
      root.pending.delete(toolCallId);
      const record: InstanceRecord = {
        id: `instance-${nextInstanceId++}`,
        definition: selectionFromSnapshot(selected.definitionPath, loaded.snapshot),
        snapshot: loaded.snapshot,
        skillExpectations: loaded.skills,
        parentToolCallId: toolCallId,
        index: 0,
        inputDigest: input.digest,
        admittedEpoch: root.epoch,
        admittedRootToken: root.token,
        admittedWorkEpoch: root.workEpoch,
        retainedBytes: bytes,
        phase: "admitted",
        childId: null,
        childFactoryId: null,
        childRootToken: null,
        childSessionId: null,
        childCwd: null,
        childDepth: null,
        childParentId: null,
        childName: null,
        lifecycleSessionFile: null,
        roleGate: "unobserved",
        skillGate: "unobserved",
        roleVerifications: 0,
        skillVerifications: 0,
        roleRefusalCode: null,
        skillRefusalCode: null,
        refusalCode: null,
        refusalMessage: null,
        lifecycle: "none",
        lifecycleTerminal: false,
        taskResultObserved: false,
        workRef: pending.workRef,
        workCaptureReason: pending.workCaptureReason,
        workInspection,
        workInspectionHook,
        workObservationError,
        workInvalidatedReason: null,
        resultObservation: null,
        resultObservationError: null,
        lifecycleEvidence: { completed: false, failed: false, aborted: false },
        resultLifecycleConflict: null,
        closedReason: null,
      };
      root.records.push(record);
      root.recordByToolCall.set(toolCallId, record);
      root.retainedBytes += bytes;
      diagnose(factory, "admission", `Admitted ${selected.name} version ${loaded.snapshot.version}.`, {
        instanceId: record.id,
        definitionName: record.definition.name,
        version: record.definition.version,
      });
      return undefined;
    } catch (error) {
      if (root.pending.get(toolCallId) === pending) root.pending.delete(toolCallId);
      const reason = `Child snapshot admission was refused: ${errorMessage(error)}`;
      recordAdmissionFailure(root, "admission-refused", reason);
      return block(reason);
    }
  } catch (error) {
    recordAdmissionFailure(root, "admission-error", errorMessage(error));
    return block(`Child snapshot admission failed closed: ${errorMessage(error)}`);
  }
}

interface OwnedChild {
  readonly record: InstanceRecord;
  readonly facts: HostFacts;
}

function sameChildIdentity(record: InstanceRecord, facts: HostFacts): boolean {
  return record.childSessionId === facts.sessionId
    && record.childCwd === facts.workspaceRoot
    && record.childParentId === facts.parentId
    && record.childDepth === facts.depth
    && record.childName === facts.agentName;
}

/**
 * Locate a frozen child binding owned by this factory on this exact root
 * generation. An unfrozen admission is never returned to a later gate.
 */
function locateOwnedChild(
  factory: FactoryContext,
  root: RootState,
  context: NativeContext,
): OwnedChild | null {
  if (factory.disposed || factory.refusedReason !== null || !root.open || root.phase !== "ready") return null;
  if (factory.homeRootToken !== null && factory.homeRootToken !== root.token) return null;
  const facts = readHostFacts(context);
  if (facts.agentKind !== "sub" || facts.agentId === null) return null;
  const record = root.recordByChildId.get(facts.agentId);
  if (record === undefined) return null;
  if (factory.childRecordId !== null && factory.childRecordId !== record.id) return null;
  if (record.admittedRootToken !== root.token) return null;
  if (record.childFactoryId === null || record.childFactoryId !== factory.id) return null;
  if (record.childRootToken !== root.token) return null;
  return { record, facts };
}

function matchingOwnedChild(
  factory: FactoryContext,
  root: RootState,
  context: NativeContext,
): InstanceRecord | null {
  const owned = locateOwnedChild(factory, root, context);
  if (owned === null || !sameChildIdentity(owned.record, owned.facts)) return null;
  return owned.record;
}

/**
 * Every later child gate must match the UUID/cwd/parent/depth/name frozen at
 * the first child session start, and must come from the factory that froze it
 * on this root generation. A foreign factory gets no record and cannot mutate
 * or close it; a drifted context from the owning factory is refused sticky.
 */
function childRecord(
  factory: FactoryContext,
  root: RootState,
  context: NativeContext,
): InstanceRecord | null {
  const owned = locateOwnedChild(factory, root, context);
  if (owned === null) return null;
  if (!sameChildIdentity(owned.record, owned.facts)) {
    markRefused(
      root,
      owned.record,
      "child-identity",
      "The child session UUID, cwd, parent id, depth or name changed from the frozen binding.",
    );
    return null;
  }
  return owned.record;
}

function bindChild(factory: FactoryContext, pi: DefinedOmpApi, context: NativeContext): void {
  const root = moduleRoot;
  if (factory.disposed || root === null || root.phase !== "ready" || !root.open) {
    abortNow(context);
    return;
  }
  const facts = readHostFacts(context);
  if (facts.agentKind !== "sub" || facts.agentId === null) {
    abortNow(context);
    return;
  }
  if (factory.refusedReason !== null) {
    root.lastRefusal = {
      code: "child-factory-refused",
      message: "A factory that already failed terminal scope validation cannot bind a native child.",
    };
    abortNow(context);
    return;
  }
  const record = root.recordByChildId.get(facts.agentId);
  if (record === undefined) {
    root.lastRefusal = {
      code: "child-unknown",
      message: "A child session start had no native lifecycle admission; it created no authority.",
    };
    abortNow(context);
    return;
  }
  if (factory.childRecordId !== null && factory.childRecordId !== record.id) {
    root.lastRefusal = {
      code: "child-factory-conflict",
      message: "This child factory is already frozen to a different native child record.",
    };
    abortNow(context);
    return;
  }
  if (record.admittedRootToken !== root.token) {
    root.lastRefusal = {
      code: "child-stale-root",
      message: "A child session start belonged to an invalidated root generation.",
    };
    abortNow(context);
    return;
  }
  if (factory.homeRootToken !== null && factory.homeRootToken !== root.token) {
    root.lastRefusal = {
      code: "child-stale-factory",
      message: "A child factory created under an invalidated root cannot adopt a later root generation.",
    };
    abortNow(context);
    return;
  }
  if (record.childFactoryId !== null) {
    if (record.childFactoryId !== factory.id || record.childRootToken !== root.token) {
      // A foreign or stale factory cannot borrow, mutate or close this record.
      abortNow(context);
      return;
    }
    if (!sameChildIdentity(record, facts)) {
      markRefused(root, record, "child-identity", "A repeated child session start changed the frozen child identity.");
      abortNow(context);
      return;
    }
    markRefused(root, record, "child-reentry", "A child session start was refused because the binding is already bound, refused or closed.");
    abortNow(context);
    return;
  }
  // Freeze factory/root identity and observed child identity only for a live
  // admitted task. A tombstone can never be revived by a late session start.
  if (record.phase !== "admitted") {
    abortNow(context);
    return;
  }
  if (record.admittedEpoch !== root.epoch) {
    markRefused(root, record, "child-stale", "The child admission was invalidated by a navigation or root close.");
    abortNow(context);
    return;
  }
  if (record.admittedWorkEpoch !== root.workEpoch) {
    markRefused(root, record, "child-stale-work", "The child admission was invalidated by the parent work ending before binding.");
    abortNow(context);
    return;
  }
  record.childFactoryId = factory.id;
  record.childRootToken = root.token;
  factory.childRecordId = record.id;
  record.childSessionId = facts.sessionId;
  record.childCwd = facts.workspaceRoot;
  record.childDepth = facts.depth;
  record.childParentId = facts.parentId;
  record.childName = facts.agentName;
  if (facts.agentName === null || facts.agentName !== record.definition.name) {
    markRefused(root, record, "child-name", "The actual child agent name differs from the selected definition.");
    abortNow(context);
    return;
  }
  if (facts.parentId !== root.agentId) {
    markRefused(root, record, "child-parent", "The child parent id differs from the bound main root agent.");
    abortNow(context);
    return;
  }
  if (facts.depth !== 1) {
    markRefused(root, record, "child-depth", "The supported profile admits only direct depth-1 children.");
    abortNow(context);
    return;
  }
  if (facts.sessionId === null) {
    markRefused(root, record, "child-session", "The child session UUID is unavailable.");
    abortNow(context);
    return;
  }
  if (root.workspaceRoot === null || facts.workspaceRoot !== root.workspaceRoot) {
    markRefused(root, record, "child-workspace", "The child cwd differs from the fixed main workspace.");
    abortNow(context);
    return;
  }
  if (currentTaskOwner() !== undefined) {
    failRoot(factory, root, "owner-conflict", "A managed TaskOwner was published before child binding.");
    abortNow(context);
    return;
  }
  if (!ensureChildSettings(factory, root)) {
    abortNow(context);
    return;
  }
  const model = readCurrentModel(context);
  if (!sameModel(model, record.snapshot.definition.model)) {
    markRefused(root, record, "child-model", "The actual child model differs from the frozen child snapshot.");
    abortNow(context);
    return;
  }
  const tools = readActiveTools(pi);
  if (tools === null || !sameSet(tools, record.snapshot.definition.effectiveTools)) {
    markRefused(root, record, "child-tools", "The actual child active tools differ exactly from the frozen child snapshot.");
    abortNow(context);
    return;
  }
  record.phase = "bound";
  diagnose(factory, "child-bound", `Bound child ${facts.agentId} to ${record.definition.name}.`, {
    instanceId: record.id,
    definitionName: record.definition.name,
    version: record.definition.version,
  });
}

function childGuard(
  factory: FactoryContext,
  pi: DefinedOmpApi,
  root: RootState,
  record: InstanceRecord | null,
  context: NativeContext,
): boolean {
  if (factory.disposed || !root.open || root.phase !== "ready") return false;
  if (record === null || record.phase === "refused" || record.phase === "closed") return false;
  if (record.childFactoryId !== factory.id
    || record.childRootToken !== root.token
    || record.admittedRootToken !== root.token) {
    return false;
  }
  if (record.phase !== "bound") {
    markRefused(root, record, "child-unbound", "A child gate ran before the child session was bound.");
    return false;
  }
  const facts = readHostFacts(context);
  if (!sameChildIdentity(record, facts)) {
    markRefused(
      root,
      record,
      "child-identity",
      "A child gate observed a different session UUID, cwd, parent id, depth or name than the frozen binding.",
    );
    return false;
  }
  if (currentTaskOwner() !== undefined) {
    failRoot(factory, root, "owner-conflict", "A managed TaskOwner is published; the child binding is refused.");
    return false;
  }
  if (!ensureChildSettings(factory, root)) return false;
  // Re-observe the actual child model and exact active tool set on every gate.
  const model = readCurrentModel(context);
  if (!sameModel(model, record.snapshot.definition.model)) {
    markRefused(root, record, "child-model", "The actual child model changed from the frozen child snapshot.");
    return false;
  }
  const tools = readActiveTools(pi);
  if (tools === null || !sameSet(tools, record.snapshot.definition.effectiveTools)) {
    markRefused(root, record, "child-tools", "The actual child active tools changed from the frozen child snapshot.");
    return false;
  }
  return true;
}

function onChildBeforeAgentStart(
  factory: FactoryContext,
  pi: DefinedOmpApi,
  event: unknown,
  context: NativeContext,
): undefined {
  try {
    const root = moduleRoot;
    if (root === null) {
      abortNow(context);
      return undefined;
    }
    const record = childRecord(factory, root, context);
    if (!childGuard(factory, pi, root, record, context) || record === null) {
      abortNow(context);
      return undefined;
    }
    if (record.roleGate === "refused") {
      abortNow(context);
      return undefined;
    }
    const prompt = isRecord(event) ? event.systemPrompt : undefined;
    if (!Array.isArray(prompt) || prompt.some((segment) => typeof segment !== "string")) {
      markRefused(root, record, "role-prompt-invalid", "The native system prompt was not an array of strings.");
      abortNow(context);
      return undefined;
    }
    let result;
    try {
      result = verifyNativeChildRole(
        record.snapshot.definition.body,
        prompt as string[],
        () => root.ports!.renderRoleFrame(record.snapshot.definition.body),
      );
    } catch (error) {
      markRefused(root, record, "role-verifier-threw", `The native Role verifier threw: ${errorMessage(error)}`);
      abortNow(context);
      return undefined;
    }
    if (!result.ok) {
      record.roleGate = "refused";
      record.roleRefusalCode = result.code;
      markRefused(root, record, result.code, result.message);
      abortNow(context);
      return undefined;
    }
    record.roleGate = "verified";
    record.roleVerifications += 1;
    return undefined;
  } catch (error) {
    const root = moduleRoot;
    if (root !== null) {
      const record = childRecord(factory, root, context);
      if (record !== null) markRefused(root, record, "role-hook", errorMessage(error));
    }
    abortNow(context);
    return undefined;
  }
}

function onChildContext(
  factory: FactoryContext,
  pi: DefinedOmpApi,
  event: unknown,
  context: NativeContext,
): undefined {
  try {
    const root = moduleRoot;
    if (root === null) {
      abortNow(context);
      return undefined;
    }
    const record = childRecord(factory, root, context);
    if (!childGuard(factory, pi, root, record, context) || record === null) {
      abortNow(context);
      return undefined;
    }
    if (record.skillGate === "refused") {
      abortNow(context);
      return undefined;
    }
    const messages = isRecord(event) ? event.messages : undefined;
    if (!Array.isArray(messages)) {
      markRefused(root, record, "skill-context-invalid", "The native context did not contain a message array.");
      abortNow(context);
      return undefined;
    }
    let result;
    try {
      result = verifyNativeAutoloadSkills(record.skillExpectations, messages);
    } catch (error) {
      markRefused(root, record, "skill-verifier-threw", `The native Skill verifier threw: ${errorMessage(error)}`);
      abortNow(context);
      return undefined;
    }
    if (!result.ok) {
      record.skillGate = "refused";
      record.skillRefusalCode = result.code;
      markRefused(root, record, result.code, result.message);
      abortNow(context);
      return undefined;
    }
    record.skillGate = "verified";
    record.skillVerifications += 1;
    return undefined;
  } catch (error) {
    const root = moduleRoot;
    if (root !== null) {
      const record = childRecord(factory, root, context);
      if (record !== null) markRefused(root, record, "skill-hook", errorMessage(error));
    }
    abortNow(context);
    return undefined;
  }
}

function childInput(
  factory: FactoryContext,
  pi: DefinedOmpApi,
  context: NativeContext,
): { readonly handled: true } | undefined {
  const root = moduleRoot;
  const record = root === null ? null : childRecord(factory, root, context);
  if (root === null || !childGuard(factory, pi, root, record, context)) {
    abortNow(context);
    return { handled: true };
  }
  return undefined;
}

function childToolCall(
  factory: FactoryContext,
  pi: DefinedOmpApi,
  context: NativeContext,
): { readonly block: true; readonly reason: string } | undefined {
  const root = moduleRoot;
  if (root === null) return block("Native child instance authority is unavailable; no tool ran.");
  const record = childRecord(factory, root, context);
  if (!childGuard(factory, pi, root, record, context)) {
    return block("Native child instance binding or runtime facts are refused; no tool ran.");
  }
  return undefined;
}

function buildDetailedStatus(factory: FactoryContext): InstancedStatusDetail {
  const root = moduleRoot;
  const main = factory.definitionEntry.controller.getStatus();
  // A factory that does not own the module root never reports or reuses that
  // root's authority. Only the owning main factory exposes instance state.
  if (root === null || root.factoryId !== factory.id) {
    return deepFreeze({
      schema: INSTANCED_NATIVE_ENTRY_SCHEMA,
      authority: "non-authoritative" as const,
      version: INSTANCED_NATIVE_ENTRY_VERSION,
      phase: factory.disposed ? "closed" as const : "unselected" as const,
      failure: factory.refusedReason,
      closeReason: null,
      restartRequired: factory.refusedReason !== null,
      factory: {
        id: factory.id,
        ownsRoot: false,
        refusedReason: factory.refusedReason,
        disposed: factory.disposed,
      },
      main: {
        phase: main.phase,
        failure: main.failure,
        bindingId: main.bindingId,
        version: main.version,
      },
      root: null,
      settings: null,
      selections: [],
      capacity: {
        definitions: { used: 0, limit: factory.limits.maxDefinitions },
        pending: { used: 0, limit: factory.limits.maxPending },
        records: { used: 0, limit: factory.limits.maxRecords },
        retainedTextBytes: { used: 0, limit: factory.limits.maxRetainedTextBytes },
        usedToolCallIds: 0,
        toolCallIdLimit: factory.limits.maxRecords + factory.limits.maxPending,
      },
      pending: [],
      instances: [],
      lastRefusal: null,
      nativeEventBus: factory.eventBusSubscribed ? "subscribed" : "unavailable",
    });
  }
  return deepFreeze({
    schema: INSTANCED_NATIVE_ENTRY_SCHEMA,
    authority: "non-authoritative" as const,
    version: INSTANCED_NATIVE_ENTRY_VERSION,
    phase: root.phase,
    failure: root.failure,
    closeReason: root.closeReason,
    restartRequired: root.restartRequired,
    factory: {
      id: factory.id,
      ownsRoot: root.factoryId === factory.id,
      refusedReason: factory.refusedReason,
      disposed: factory.disposed,
    },
    main: {
      phase: main.phase,
      failure: main.failure,
      bindingId: main.bindingId,
      version: main.version,
    },
    root: {
      agentId: root.agentId,
      sessionId: root.sessionId,
      workspaceRoot: root.workspaceRoot,
      epoch: root.epoch,
      workEpoch: root.workEpoch,
    },
    settings: root.settings === null
      ? null
      : { profile: "supported" as const, values: { ...root.settings } },
    selections: root.selections.map((selection) => ({
      name: selection.name,
      definitionPath: selection.definitionPath,
      canonicalPath: selection.canonicalPath,
      version: selection.version,
      model: { ...selection.model },
      tools: [...selection.tools],
    })),
    capacity: {
      definitions: { used: root.selections.length, limit: factory.limits.maxDefinitions },
      pending: { used: root.pending.size, limit: factory.limits.maxPending },
      records: { used: root.records.length, limit: factory.limits.maxRecords },
      retainedTextBytes: { used: root.retainedBytes, limit: factory.limits.maxRetainedTextBytes },
      usedToolCallIds: root.seenToolCalls.size,
      toolCallIdLimit: factory.limits.maxRecords + factory.limits.maxPending,
    },
    pending: [...root.pending.values()].map((pending) => ({
      parentToolCallId: pending.parentToolCallId,
      agentName: pending.agentName,
      state: pending.state,
      startedAt: pending.startedAt,
    })),
    instances: root.records.map((record) => ({
      id: record.id,
      definitionName: record.definition.name,
      definitionPath: record.definition.definitionPath,
      canonicalPath: record.definition.canonicalPath,
      version: record.definition.version,
      parentToolCallId: record.parentToolCallId,
      index: record.index,
      inputDigest: record.inputDigest,
      phase: record.phase,
      childId: record.childId,
      childSessionId: record.childSessionId,
      childCwd: record.childCwd,
      childDepth: record.childDepth,
      model: { ...record.definition.model },
      tools: [...record.definition.tools],
      roleGate: record.roleGate,
      skillGate: record.skillGate,
      roleVerifications: record.roleVerifications,
      skillVerifications: record.skillVerifications,
      roleRefusalCode: record.roleRefusalCode,
      skillRefusalCode: record.skillRefusalCode,
      refusalCode: record.refusalCode,
      refusalMessage: record.refusalMessage,
      lifecycle: record.lifecycle,
      lifecycleTerminal: record.lifecycleTerminal,
      taskResultObserved: record.taskResultObserved,
      observation: {
        work: {
          scope: "last-owner-main-hook" as const,
          capture: record.workRef === null ? "unavailable" as const : "captured" as const,
          captureReason: record.workCaptureReason,
          hook: record.workInspectionHook,
          error: record.workObservationError,
          invalidatedReason: record.workInvalidatedReason,
          inspection: record.workInspection,
        },
        result: {
          observation: record.resultObservation,
          error: record.resultObservationError,
        },
        lifecycleEvidence: {
          completed: record.lifecycleEvidence.completed,
          failed: record.lifecycleEvidence.failed,
          aborted: record.lifecycleEvidence.aborted,
        },
        conflict: record.resultLifecycleConflict === null ? null : { ...record.resultLifecycleConflict },
      },
      closedReason: record.closedReason,
      retainedBytes: record.retainedBytes,
    })),
    lastRefusal: root.lastRefusal === null ? null : { ...root.lastRefusal },
    nativeEventBus: factory.eventBusSubscribed ? "subscribed" : "unavailable",
  });
}

function encodedStatusBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function statusPhaseCounts(instances: InstancedStatusDetail["instances"]): InstancedStatusPhaseCounts {
  const counts = { admitted: 0, bound: 0, refused: 0, closed: 0 };
  for (const instance of instances) {
    switch (instance.phase) {
      case "admitted":
      case "bound":
      case "refused":
      case "closed":
        counts[instance.phase] += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}

/**
 * Bound the diagnostic output, never the records it describes. A view that
 * fits stays fully detailed. An over-budget view is replaced by the same
 * root/main/factory/state/capacity facts plus exact omitted counts and the
 * digest of the full detail. Serialized JSON is measured, never sliced.
 */
function boundedStatus(detail: InstancedStatusDetail): InstancedEntryStatus {
  const detailJson = JSON.stringify(detail);
  const detailBytes = Buffer.byteLength(detailJson, "utf8");
  const detailSha256 = sha256Hex(detailJson);
  const baseView = { budgetBytes: MAX_STATUS_BYTES, detailBytes, detailSha256 };
  if (detailBytes <= MAX_STATUS_BYTES) {
    const complete: InstancedEntryStatus = {
      ...detail,
      view: { ...baseView, complete: true },
    };
    if (encodedStatusBytes(complete) <= MAX_STATUS_BYTES) return deepFreeze(complete);
  }
  const omitted = {
    selections: detail.selections.length,
    pending: detail.pending.length,
    instances: detail.instances.length,
    instancePhases: statusPhaseCounts(detail.instances),
  };
  const summary: InstancedEntryStatus = {
    ...detail,
    selections: [],
    pending: [],
    instances: [],
    view: {
      ...baseView,
      complete: false,
      reason: "encoded-size-limit",
      omitted,
    },
  };
  if (encodedStatusBytes(summary) <= MAX_STATUS_BYTES) return deepFreeze(summary);
  // Summary fields are bounded by this module's constants. This last tier only
  // handles a pathological host-supplied path: omit diagnostic text explicitly
  // rather than changing any execution state or slicing an identity.
  const omittedFields = Object.freeze([
    "failure",
    "closeReason",
    "factory.refusedReason",
    "main.failure",
    "main.bindingId",
    "main.version",
    "root",
    "settings",
    "lastRefusal",
  ]);
  const compact: InstancedEntryStatus = {
    schema: detail.schema,
    authority: detail.authority,
    version: detail.version,
    phase: detail.phase,
    failure: null,
    closeReason: null,
    restartRequired: detail.restartRequired,
    factory: {
      id: detail.factory.id,
      ownsRoot: detail.factory.ownsRoot,
      refusedReason: null,
      disposed: detail.factory.disposed,
    },
    main: {
      phase: detail.main.phase,
      failure: null,
      bindingId: null,
      version: null,
    },
    root: null,
    settings: null,
    selections: [],
    capacity: detail.capacity,
    pending: [],
    instances: [],
    lastRefusal: null,
    nativeEventBus: detail.nativeEventBus,
    view: {
      ...baseView,
      complete: false,
      reason: "encoded-size-limit",
      omitted,
      omittedFields,
    },
  };
  return deepFreeze(compact);
}

function buildStatus(factory: FactoryContext): InstancedEntryStatus {
  return boundedStatus(buildDetailedStatus(factory));
}

function mainStatusFacts(factory: FactoryContext): InstancedStatusDetail["main"] {
  try {
    const main = factory.definitionEntry.controller.getStatus();
    return { phase: main.phase, failure: main.failure, bindingId: main.bindingId, version: main.version };
  } catch {
    return { phase: "unavailable", failure: "Main definition status is unavailable.", bindingId: null, version: null };
  }
}

const STATUS_UNAVAILABLE_FIELDS = Object.freeze([
  "root",
  "settings",
  "selections",
  "pending",
  "instances",
  "capacity.used",
  "lastRefusal",
]);

const STATUS_FALLBACK_OMITTED_FIELDS = Object.freeze([
  "failure",
  "factory.refusedReason",
  "main.failure",
  "main.bindingId",
  "main.version",
]);

function unavailableView(
  detail: InstancedStatusDetail,
  omittedFields?: readonly string[],
): InstancedStatusView {
  const fallbackJson = JSON.stringify(detail);
  return {
    complete: false,
    reason: "status-unavailable",
    budgetBytes: MAX_STATUS_BYTES,
    detailBytes: null,
    detailSha256: null,
    fallbackBytes: Buffer.byteLength(fallbackJson, "utf8"),
    fallbackSha256: sha256Hex(fallbackJson),
    omitted: {
      selections: null,
      pending: null,
      instances: null,
      instancePhases: null,
    },
    unavailable: STATUS_UNAVAILABLE_FIELDS,
    ...(omittedFields === undefined ? {} : { omittedFields }),
  };
}

function unavailableStatus(detail: InstancedStatusDetail): InstancedEntryStatus {
  const status: InstancedEntryStatus = { ...detail, view: unavailableView(detail) };
  if (encodedStatusBytes(status) <= MAX_STATUS_BYTES) return deepFreeze(status);
  // The fallback has no record arrays; only diagnostic text can be large.
  // Drop that text explicitly rather than implying any unobserved state.
  const compactDetail: InstancedStatusDetail = {
    ...detail,
    failure: null,
    factory: { ...detail.factory, refusedReason: null },
    main: { ...detail.main, failure: null, bindingId: null, version: null },
  };
  return deepFreeze({
    ...compactDetail,
    view: unavailableView(compactDetail, STATUS_FALLBACK_OMITTED_FIELDS),
  });
}

function buildStatusFailure(factory: FactoryContext, error: unknown): InstancedEntryStatus {
  const main = mainStatusFacts(factory);
  return unavailableStatus({
    schema: INSTANCED_NATIVE_ENTRY_SCHEMA,
    authority: "non-authoritative",
    version: INSTANCED_NATIVE_ENTRY_VERSION,
    phase: "failed",
    failure: boundedMessage(`Status build failed: ${errorMessage(error)}`),
    closeReason: null,
    restartRequired: true,
    factory: {
      id: factory.id,
      ownsRoot: moduleRoot?.factoryId === factory.id,
      refusedReason: factory.refusedReason === null ? null : boundedMessage(factory.refusedReason),
      disposed: factory.disposed,
    },
    main: {
      phase: main.phase,
      failure: main.failure === null ? null : boundedMessage(main.failure),
      bindingId: main.bindingId === null ? null : boundedMessage(main.bindingId),
      version: main.version === null ? null : boundedMessage(main.version),
    },
    root: null,
    settings: null,
    selections: [],
    capacity: {
      definitions: { used: null, limit: factory.limits.maxDefinitions },
      pending: { used: null, limit: factory.limits.maxPending },
      records: { used: null, limit: factory.limits.maxRecords },
      retainedTextBytes: { used: null, limit: factory.limits.maxRetainedTextBytes },
      usedToolCallIds: null,
      toolCallIdLimit: factory.limits.maxRecords + factory.limits.maxPending,
    },
    pending: [],
    instances: [],
    lastRefusal: null,
    nativeEventBus: factory.eventBusSubscribed ? "subscribed" : "unavailable",
  });
}

export function createInstancedNativeEntry(
  pi: InstancedOmpApi,
  options: InstancedNativeEntryOptions = {},
): InstancedNativeEntryControls {
  const limits = normalizeLimits(options.limits);
  const startupTimeoutMs = clampTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, MAX_STARTUP_TIMEOUT_MS);
  const d1TimeoutMs = Math.max(1, Math.floor(startupTimeoutMs / 2));
  const admissionTimeoutMs = clampTimeout(options.admissionTimeoutMs, DEFAULT_ADMISSION_TIMEOUT_MS, MAX_ADMISSION_TIMEOUT_MS);
  const factoryId = nextFactoryId++;
  const eventBus = readEventBus(pi);
  // A child factory is rebound per runtime and may have a distinct session
  // bus. Its birth root generation, not bus identity, scopes child authority.
  const homeRootToken = moduleRoot?.token ?? null;
  let definitionEntry!: DefinedControls;
  let portsPromise: Promise<InstancedNativePorts>;
  let childDefinitionsRead = false;
  let childDefinitionsValue: string | readonly string[] | undefined;
  const readChildDefinitions = (): string | readonly string[] | undefined => {
    if (options.childDefinitions !== undefined) return options.childDefinitions;
    if (!childDefinitionsRead) {
      childDefinitionsRead = true;
      try {
        const value = pi.getFlag?.(AGENT_CHILD_DEFINITIONS_FLAG);
        childDefinitionsValue = typeof value === "string" ? value : undefined;
      } catch {
        childDefinitionsValue = undefined;
      }
    }
    return childDefinitionsValue;
  };

  try {
    pi.registerFlag?.(AGENT_CHILD_DEFINITIONS_FLAG, {
      description: "JSON array of 1-8 absolute Agent Markdown paths for opt-in native child instances.",
      type: "string",
    });
  } catch (error) {
    stderr("flag_registration_failed", { reason: errorMessage(error) });
  }

  // This is the single fixed seam for D1's early instance-status display. It
  // is not a router: the name is fixed by D1, and D1 still runs its own
  // controller gate first. Before synchronous registration below this returns
  // no match; a missing/throwing registrar stays unregistered and D1 emits a
  // local unavailable diagnostic instead of a status/binding bypass.
  let statusFactory: FactoryContext | null = null;
  const d1Options: DefinedNativeEntryOptions = {
    ...(options.mainDefinitionPath === undefined ? {} : { definitionPath: options.mainDefinitionPath }),
    ...(options.nativePorts === undefined ? {} : {
      nativePorts: {
        parseAgent: options.nativePorts.parseAgent,
        parseFrontmatter: options.nativePorts.parseFrontmatter,
        getActiveSkills: options.nativePorts.getActiveSkills,
      } satisfies DefinedNativePorts,
    }),
    ...(options.loadMainDefinition === undefined ? {} : { loadDefinition: options.loadMainDefinition }),
    startupTimeoutMs: d1TimeoutMs,
    statusComposition: {
      instanceStatus: {
        isRegistered: () => statusFactory !== null && statusFactory.statusCommandRegistered,
        show(context) {
          if (statusFactory !== null && statusFactory.statusCommandRegistered) {
            showInstanceStatus(statusFactory, context);
          }
        },
      },
    },
  };
  definitionEntry = createDefinedNativeEntry(compositionApi(pi), d1Options);

  if (options.nativePorts !== undefined) {
    portsPromise = Promise.resolve(options.nativePorts);
  } else {
    portsPromise = importInstancedPorts();
  }
  // Avoid an unhandled rejection when this optional entry never sees a root.
  void portsPromise.catch(() => undefined);

  const factory: FactoryContext = {
    id: factoryId,
    bus: eventBus,
    homeRootToken,
    childRecordId: null,
    limits,
    startupTimeoutMs,
    rootStartupTimeoutMs: Math.max(1, startupTimeoutMs - d1TimeoutMs),
    admissionTimeoutMs,
    definitionEntry,
    portsPromise,
    loadChildDefinition: options.loadChildDefinition,
    diagnostic: options.diagnostic,
    statusCommandRegistered: false,
    eventBusSubscribed: false,
    rootToken: null,
    refusedReason: null,
    disposed: false,
  };
  factory.statusCommandRegistered = registerStatusCommand(pi, factory);
  // Readiness is published only after the synchronous registrar succeeded.
  if (factory.statusCommandRegistered) statusFactory = factory;
  factory.eventBusSubscribed = subscribeLifecycle(factory);

  pi.on("session_start", async (_event, context) => {
    try {
      const facts = readHostFacts(context);
      if (factory.disposed) {
        if (facts.agentKind === "sub") abortNow(context);
        return;
      }
      if (facts.agentKind === "main") {
        const root = claimRoot(factory, context);
        if (root === null) return;
        await startRoot(factory, root, pi, context, readChildDefinitions);
        return;
      }
      if (facts.agentKind === "sub") {
        bindChild(factory, pi, context);
        return;
      }
      factory.refusedReason = "Unknown agent identity is refused; it never becomes a main root.";
      abortNow(context);
    } catch (error) {
      const root = moduleRoot;
      if (root !== null && root.factoryId === factory.id) {
        failRoot(factory, root, "session-start", errorMessage(error));
      }
      abortNow(context);
    }
  });

  pi.on("input", (_event, context) => {
    try {
      const facts = readHostFacts(context);
      if (factory.disposed) {
        if (facts.agentKind === "sub") abortNow(context);
        return { handled: true };
      }
      if (facts.agentKind === "sub") return childInput(factory, pi, context);
      if (facts.agentKind !== "main") {
        abortNow(context);
        return { handled: true };
      }
      // D1's earlier input gate owns both reserved diagnostics. This layer
      // keeps only its existing main/root authorization for other input.
      const root = moduleRoot;
      if (root === null || root.factoryId !== factory.id) return { handled: true };
      if (!refreshRoot(factory, root, pi, context)) return { handled: true };
      refreshWorkObservations(factory, root, context, "input");
      return undefined;
    } catch (error) {
      const root = moduleRoot;
      if (root !== null && root.factoryId === factory.id) failRoot(factory, root, "input-hook", errorMessage(error));
      return { handled: true };
    }
  });

  pi.on("before_agent_start", (event, context) => {
    try {
      const facts = readHostFacts(context);
      if (factory.disposed) {
        if (facts.agentKind === "sub") abortNow(context);
        return undefined;
      }
      if (facts.agentKind === "sub") {
        onChildBeforeAgentStart(factory, pi, event, context);
        return undefined;
      }
      if (facts.agentKind !== "main") {
        abortNow(context);
        return undefined;
      }
      const root = moduleRoot;
      if (root === null || root.factoryId !== factory.id) {
        abortNow(context);
        return undefined;
      }
      if (!refreshRoot(factory, root, pi, context)) {
        abortNow(context);
        return undefined;
      }
      refreshWorkObservations(factory, root, context, "before_agent_start");
      // D1 owns the main prompt. This entry never rewrites it.
      return undefined;
    } catch (error) {
      const root = moduleRoot;
      if (root !== null && root.factoryId === factory.id) failRoot(factory, root, "prompt-hook", errorMessage(error));
      abortNow(context);
      return undefined;
    }
  });

  pi.on("context", (event, context) => {
    const facts = readHostFacts(context);
    if (factory.disposed || facts.agentKind !== "sub") return undefined;
    return onChildContext(factory, pi, event, context);
  });

  pi.on("tool_call", async (event, context) => {
    try {
      const facts = readHostFacts(context);
      if (factory.disposed) {
        if (facts.agentKind === "sub") abortNow(context);
        return block("The instance entry was disposed; no tool ran.");
      }
      if (facts.agentKind === "sub") return childToolCall(factory, pi, context);
      if (facts.agentKind !== "main") return block("Unknown agent identity cannot call tools.");
      const root = moduleRoot;
      if (root === null || root.factoryId !== factory.id) {
        return block("A second or unknown main root cannot call tools.");
      }
      if (isRecord(event) && event.toolName === "task") {
        return await admitTask(factory, root, pi, event, context);
      }
      if (!refreshRoot(factory, root, pi, context)) {
        return block(root.failure ?? "The native instance root is not valid; no tool ran.");
      }
      return undefined;
    } catch (error) {
      const root = moduleRoot;
      if (root !== null && root.factoryId === factory.id) failRoot(factory, root, "tool-hook", errorMessage(error));
      return block(`Native instance tool gate failed closed: ${errorMessage(error)}`);
    }
  });

  pi.on("tool_result", (event, context) => {
    try {
      if (factory.disposed) return;
      const root = moduleRoot;
      if (root === null
        || root.factoryId !== factory.id
        || !ownsRoot(factory, root)
        || !root.open
        || root.phase !== "ready") {
        return;
      }
      const facts = readHostFacts(context);
      if (facts.agentKind !== "main"
        || facts.agentId !== root.agentId
        || facts.sessionId !== root.sessionId
        || facts.workspaceRoot !== root.workspaceRoot) {
        return;
      }
      refreshWorkObservations(factory, root, context, "tool_result");
      if (!ownsRoot(factory, root) || !root.open || root.phase !== "ready") return;
      const afterRefresh = readHostFacts(context);
      if (afterRefresh.agentKind !== "main"
        || afterRefresh.agentId !== root.agentId
        || afterRefresh.sessionId !== root.sessionId
        || afterRefresh.workspaceRoot !== root.workspaceRoot) {
        return;
      }
      if (!isRecord(event) || event.toolName !== "task" || typeof event.toolCallId !== "string") return;
      const toolCallId = event.toolCallId;
      const record = root.recordByToolCall.get(toolCallId);
      if (record === undefined
        || record.admittedRootToken !== root.token
        || record.parentToolCallId !== toolCallId) {
        return;
      }
      const writeAllowed = (): boolean =>
        ownsRoot(factory, root)
        && root.token === record.admittedRootToken
        && root.open
        && root.phase === "ready"
        && root.recordByToolCall.get(toolCallId) === record;
      const expected = expectedResultAssociation(record, root);
      if (expected === null) {
        if (writeAllowed()) {
          record.resultObservationError ??= "owner session or workspace identity was unavailable at result observation";
        }
        return;
      }
      let next: NativeInstanceResultObservation;
      try {
        // Synchronous snapshot of this exact event, before later middleware.
        next = observeNativeInstanceResult(expected, event, record.resultObservation);
      } catch (error) {
        if (writeAllowed()) {
          record.resultObservationError ??= boundedMessage(`native result observation failed: ${errorMessage(error)}`);
        }
        return;
      }
      if (!writeAllowed()) return;
      record.resultObservation = next;
      record.taskResultObserved = true;
      assessResultLifecycleConflict(record);
    } catch {
      // Observations never gate.
    }
  });

  const onWorkEnding = (context: NativeContext, hook: InstancedWorkObservationHook): void => {
    try {
      const root = moduleRoot;
      if (root === null || factory.disposed || root.factoryId !== factory.id) return;
      const facts = readHostFacts(context);
      // A foreign main session/cwd with the same agent id is not this work's
      // end: it must neither refresh nor invalidate the real owner root.
      if (!matchesOwnerIdentity(root, facts)) return;
      refreshWorkObservations(factory, root, context, hook);
      if (!ownsRoot(factory, root)) return;
      invalidatePending(root, "the parent work ended before an admission published");
      invalidateUnboundAdmissions(
        root,
        "the parent work ended before the child session bound; a late child event cannot revive the admission",
      );
      root.workEpoch += 1;
    } catch {
      // Work-ending observation must not break host cleanup.
    }
  };
  pi.on("agent_end", (_event, context) => onWorkEnding(context, "agent_end"));
  pi.on("session_stop", (_event, context) => onWorkEnding(context, "session_stop"));

  for (const eventName of ["session_switch", "session_branch", "session_tree", "session_clear"] as const) {
    pi.on(eventName, (_event, context) => {
      try {
        const root = moduleRoot;
        const facts = readHostFacts(context);
        if (factory.disposed || root === null) return;
        if (facts.agentKind === "main") {
          if (root.factoryId === factory.id) closeRoot(factory, root, `main ${eventName} invalidated all pending and child bindings`);
          return;
        }
        if (facts.agentKind === "sub") {
          // The host may change the child session UUID before emitting this
          // navigation event. Use the owning factory binding so the actual
          // owner's drift becomes sticky instead of being ignored. A foreign
          // or stale factory still gets no record from locateOwnedChild.
          const owned = locateOwnedChild(factory, root, context);
          if (owned === null) return;
          const record = childRecord(factory, root, context);
          if (record !== null) {
            markRefused(root, record, "child-navigation", "Child navigation is unsupported and the binding is closed.");
          }
          abortNow(context);
        }
      } catch {
        // Navigation cleanup is best effort; the root remains fail-closed.
      }
    });
  }

  pi.on("session_shutdown", (_event, context) => {
    try {
      const root = moduleRoot;
      if (factory.disposed || root === null) return;
      const facts = readHostFacts(context);
      if (facts.agentKind === "main") {
        if (root.factoryId === factory.id) closeRoot(factory, root, "main session shutdown invalidated all pending and child bindings");
        return;
      }
      if (facts.agentKind === "sub") {
        // Only the frozen factory and frozen child facts may close the record.
        // A refused record remains closable by its original child shutdown.
        const record = matchingOwnedChild(factory, root, context);
        if (record !== null) {
          record.lifecycleTerminal = true;
          closeRecord(record, "child session shutdown");
        }
      }
    } catch {
      // Shutdown cleanup must not throw.
    }
  });

  pi.on("before_subagent_spawn", (event, context) => {
    try {
      const root = moduleRoot;
      if (factory.disposed
        || root === null
        || root.factoryId !== factory.id
        || !root.open
        || root.phase !== "ready") {
        return block("Native child expansion is refused because the instance root is not ready.");
      }
      const facts = readHostFacts(context);
      if (facts.agentKind !== "main") return block("Native child expansion is only supported from the bound main root.");
      if (!isRecord(event)
        || event.invocationKind !== "task"
        || typeof event.agent !== "string"
        || !root.selectionByName.has(event.agent)) {
        return block("Native child expansion is limited to an explicit selected task definition.");
      }
      if (currentTaskOwner() !== undefined) {
        failRoot(factory, root, "owner-conflict", "A managed TaskOwner is published; child expansion is refused.");
        return block(root.failure ?? "A managed TaskOwner is published.");
      }
      if (!refreshRoot(factory, root, pi, context)) {
        return block(root.failure ?? "The main binding is invalid for child expansion.");
      }
      // The admission was already counted when it was published. Checking the
      // record cap again here would permanently refuse the first admitted
      // spawn when maxRecords is 1.
      const waiting = root.records.some((record) =>
        record.phase === "admitted"
        && record.childId === null
        && record.admittedRootToken === root.token
        && record.admittedEpoch === root.epoch
        && record.admittedWorkEpoch === root.workEpoch
        && record.definition.name === event.agent);
      if (!waiting) {
        return block("Native child expansion has no admitted task call for the selected definition in this parent work.");
      }
      return undefined;
    } catch (error) {
      return block(`Native child expansion gate failed closed: ${errorMessage(error)}`);
    }
  });

  const controls: InstancedNativeEntryControls = {
    controller: definitionEntry.controller,
    nativeEntry: definitionEntry.nativeEntry,
    getStatus() {
      try {
        return buildStatus(factory);
      } catch (error) {
        return buildStatusFailure(factory, error);
      }
    },
    dispose() {
      if (factory.disposed) return;
      factory.disposed = true;
      const root = moduleRoot;
      const ownedRoot = root !== null && root.factoryId === factory.id;
      if (ownedRoot) {
        closeRoot(factory, root, "the instanced native entry was disposed by its owner");
      }
      // A root generation cannot be replaced safely on the same bus because
      // native lifecycle events carry no generation marker, so a delayed event
      // with a reused parent call ID could otherwise reach a new root.
      if (factory.rootToken !== null && factory.bus !== null) {
        retiredBuses.add(factory.bus);
      }
      if (ownedRoot) {
        moduleRoot = null;
      }
      factory.rootToken = null;
      definitionEntry.dispose();
    },
  };
  return controls;
}

export default function instancedNativeEntry(pi: InstancedOmpApi): void {
  try {
    createInstancedNativeEntry(pi);
  } catch (error) {
    stderr("instanced_native_entry_disabled", { reason: errorMessage(error) });
  }
}
