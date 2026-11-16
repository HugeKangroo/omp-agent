/** Versioned wire/storage contracts. Never persist executable objects or secrets. */
export type Mode = "product" | "research";
export type ExecutionStrategy = "auto" | "direct" | "explore" | "legacy" | "adaptive";
export const CANDIDATE_IDS = ["baseline", "inv_probe", "dom_probe", "final", "route_1", "route_2", "route_3", "refine"] as const;
export type CandidateId = typeof CANDIDATE_IDS[number];
export const STAGE_IDS = ["baseline", "inv_edit", "dom_edit", "inv_probe", "dom_probe", "compose_edit", "final", "select", "reflect", "plan", "route_1", "route_2", "route_3", "review", "refine"] as const;
export type StageId = typeof STAGE_IDS[number];
export type RunStatus = "queued" | "running" | "interrupted" | "completed" | "failed" | "cancelled" | "applied";

export interface ExplorationCriterion { id: string; description: string; kind: "requirement" | "quality" }
export interface ExplorationRoute {
  id: "route_1" | "route_2" | "route_3";
  name: string;
  approach: string;
  assumptions: string[];
  tradeoffs: string[];
}
export interface ExplorationPlan {
  decision: "direct" | "explore";
  reason: string;
  criteria: ExplorationCriterion[];
  routes: ExplorationRoute[];
}
export interface ExplorationAssessment {
  candidate: CandidateId;
  criteria: Array<{ criterionId: string; verdict: "met" | "not_met" | "unknown"; evidence: string }>;
  strengths: string[];
  weaknesses: string[];
}
export interface ExplorationEvaluation {
  method: "model_review" | "fallback";
  assessments: ExplorationAssessment[];
  winner: CandidateId | null;
  reason: string;
  limitations: string[];
  refinement?: { candidate: CandidateId; instructions: string };
}

export interface HarnessSkill { name: string; description: string; content: string }
export interface HarnessBundle {
  schemaVersion: 1;
  id: string;
  parentId?: string;
  promptAppend: string;
  toolGuidance: string;
  skills: HarnessSkill[];
  rationale: string;
}

export interface RunConfig {
  mode: Mode;
  /** Missing on pre-exploration records, which retain the legacy pipeline. */
  strategy?: ExecutionStrategy;
  model: string;
  improverModel: string;
  maxCostUsd: number;
  maxDurationMs: number;
  stageTimeoutMs: number;
  domain: string;
  ompCommand: string;
  auth?: import("./omp-profile").OmpProfileAuth;
  adaptation?: import("./adaptation").AdaptationPolicy;
  execution?: import("./runtime-policy").ExecutionProfile;
}

export interface FileEntry { path: string; hash: string; size: number; mode: number }
export interface WorkspaceSnapshot {
  id: string;
  sourceRoot: string;
  root: string;
  files: FileEntry[];
  createdAt: string;
  excludedPaths?: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Bounded observation of one original Runner lifecycle. Events contain only
 * owned scalars/digests; never prompts, credentials, argv, context or result text. */
export interface WorkerLifecyclePreLaunchEvent {
  readonly type: "preLaunch";
  readonly runId: string;
  readonly stage: StageId;
  readonly runtimeRoot: string;
  readonly timeoutMs: number;
  readonly configSha256: string;
  readonly appendixSha256: string;
}

export interface WorkerLifecycleProcessBoundEvent {
  readonly type: "processBound";
  readonly runId: string;
  readonly stage: StageId;
  readonly pid: number | null;
  readonly pgid: number | null;
  /** Association-only digest of actual spawn facts; not a boot/authenticated identity. */
  readonly associationSha256: string;
}

export interface WorkerLifecyclePrePromptEvent {
  readonly type: "prePrompt";
  readonly runId: string;
  readonly stage: StageId;
  /** SHA-256 of the exact encoded RPC frame bytes that will be sent. */
  readonly promptSha256: string;
  readonly promptBytes: number;
  readonly timeoutMs: number;
}

export interface WorkerLifecycleCleanupObservedEvent {
  readonly type: "cleanupObserved";
  readonly runId: string;
  readonly stage: StageId;
  readonly spawnAttempted: boolean;
  readonly closeSeen: boolean;
  readonly closeCode: number | null;
  readonly closeSignal: string | null;
  /** Actual probe result of the original PGID; "not-observed" means an actual ESRCH probe. */
  readonly groupObservation: "not-observed" | "present" | "unknown";
  /** Time of the actual probe, or null when no original-PGID probe occurred (no rpc/missing PID). */
  readonly groupObservedAt: string | null;
  readonly hostWorkSettled: boolean;
  readonly approvalWorkSettled: boolean;
  readonly logFlush: "success" | "failure";
}

export interface WorkerLifecycleResultObservedEvent {
  readonly type: "resultObserved";
  readonly runId: string;
  readonly stage: StageId;
  /** SHA-256 of canonical JSON for the exact final WorkerResult. */
  readonly resultSha256: string;
  readonly status: WorkerResult["status"];
  readonly usage: Usage;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly usageEstimated: boolean;
}

export type WorkerLifecycleEvent =
  | WorkerLifecyclePreLaunchEvent
  | WorkerLifecycleProcessBoundEvent
  | WorkerLifecyclePrePromptEvent
  | WorkerLifecycleCleanupObservedEvent
  | WorkerLifecycleResultObservedEvent;

/** Host-owned optional port. Methods/scalars are captured once, before async work. */
export interface WorkerLifecyclePort {
  /** Trusted one-shot cleanup budget for this worker lifecycle. */
  readonly cleanupGraceMs: number;
  /** Throw on refusal; must return void synchronously. */
  assertAdvanceCurrent(): void;
  /** Awaited persistence for one bounded event. Throw on refusal; never ignore assertPersistable. */
  checkpoint(event: WorkerLifecycleEvent, assertPersistable: () => void): Promise<void>;
}

export interface WorkerRequest {
  runId: string;
  stage: StageId;
  role: "solver" | "editor" | "selector" | "reflector";
  cwd: string;
  artifactDir: string;
  prompt: string;
  harness: HarnessBundle;
  model: string;
  maxCostUsd: number;
  timeoutMs: number;
  ompCommand: string;
  auth?: import("./omp-profile").OmpProfileAuth;
  signal?: AbortSignal;
  onEvent?: (event: WorkerEvent) => void;
  taskId?: string;
  generatedExtensions?: import("./generated-extension").GeneratedExtension[];
  execution?: import("./runtime-policy").ExecutionProfile;
  approval?: import("./runtime-policy").ApprovalHandler;
  /** Optional host-owned lifecycle sink; not tool/model input and never serialized. */
  lifecycle?: WorkerLifecyclePort;
}

export interface WorkerEvent { type: string; timestamp: string; data: unknown }
export interface WorkerResult {
  text: string;
  usage: Usage;
  startedAt: string;
  endedAt: string;
  eventsPath: string;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  error?: string;
  /** True when cost is a conservative allocation reservation, not observed provider usage. */
  usageEstimated?: boolean;
}
export interface Runner { run(request: WorkerRequest): Promise<WorkerResult> }

export interface StageRecord {
  id: StageId;
  status: "running" | "completed" | "failed";
  attempt: number;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  result?: WorkerResult;
  harness?: HarnessBundle;
  error?: string;
  /** Total consumed/reserved USD across attempts; interrupted attempts retain reservation. */
  accountedCostUsd?: number;
  reservedCostUsd?: number;
  /** Hash of the admitted file-change manifest, pinned before composition/selection. */
  artifactHash?: string;
  traceHash?: string;
  validationFailures?: number;
  observedCostUsd?: number;
  parentStage?: CandidateId;
  parentArtifactHash?: string;
}

export interface Lesson {
  cue: string;
  lesson: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
  limitations: string;
}
export interface LibraryEntry {
  schemaVersion: 1;
  id: string;
  runId: string;
  domain: string;
  model: string;
  createdAt: string;
  harness: HarnessBundle;
  lesson: Lesson;
}

/** Initial historical facts supplied once, at original creation. These values
 * are declarations recorded with the record; they are not proof of authority,
 * source completeness or eligibility to resume. */
export interface RunRecoverySeed {
  schema: "omp-agent.native-harness-recovery-seed.v1";
  profile: "native-auto-scoped-files.v1";
  accountingOwnerId: string;
  admissionId: string;
  accountingOwnerRevision: number;
  sourceAssociationSha256: string;
  sourceDescriptorSha256: string;
  inputManifestSha256: string;
  admittedAt: number;
  deadlineAt: number;
  allocatedCostUsd: number;
}

/** Store-issued immutable creation association. Presence means only that the
 * association was recorded with the initial record; it never means the run is
 * recoverable, stopped, current, authorized or budget-complete. */
export interface RunRecoveryOrigin {
  schema: "omp-agent.native-harness-recovery-origin.v1";
  nonce: string;
  runId: string;
  createdAt: string;
  recordIdentitySha256: string;
  seed: RunRecoverySeed;
}

export interface RunRecord {
  schemaVersion: 1 | 2;
  evolution?: import("./evolution").EvolutionState;
  recoveryOrigin?: RunRecoveryOrigin;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  task: string;
  config: RunConfig;
  status: RunStatus;
  snapshot?: WorkspaceSnapshot;
  baseHarness: HarnessBundle;
  libraryEntries: LibraryEntry[];
  stages: Partial<Record<StageId, StageRecord>>;
  winner?: CandidateId;
  exploration?: { plan: ExplorationPlan; review?: ExplorationEvaluation; selection?: ExplorationEvaluation };
  selectionReason?: string;
  lesson?: Lesson;
  error?: string;
  appliedAt?: string;
  warnings?: string[];
}

export interface RunEvent {
  schemaVersion: 1;
  runId: string;
  timestamp: string;
  type: string;
  stage?: StageId;
  message: string;
}

export interface Change {
  path: string;
  kind: "add" | "modify" | "delete";
  beforeHash?: string;
  afterHash?: string;
}
export interface ApplyResult { applied: boolean; changes: Change[]; alreadyApplied: boolean }
