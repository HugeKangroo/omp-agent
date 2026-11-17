import { Buffer } from "node:buffer";
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { readActualAbortSignal } from "./native-abort.ts";
import { sha256Hex } from "./native-work.ts";

/**
 * R1b3 bounded readonly process observation leaf.
 *
 * This module owns the fixed owner-file parsers and layout derivation for the
 * current vendor worker/lock records, one finite projection, and the one
 * fixed Darwin `/bin/ps` adapter. It owns no process registry, scheduler,
 * history store, recovery authority, signal to an owner PID or second FS
 * reader. Owner text always arrives from the history core's existing pinned
 * `captureWorkspaceText` path; this module never reads a path by itself.
 *
 * A present OS row proves only that a PID was present at that instant. It is
 * not signed dispatch identity, worker ownership, a stopped proof or a resume
 * capability. The flattened `ps` command is marker material, not exact argv.
 */

export const NATIVE_HARNESS_HISTORY_PROCESS_LIMITS = Object.freeze({
  /** At most 15 current recorded stages plus one controller target. */
  maxTargets: 16,
  /** Worst-case reservation charged before each owner read. */
  ownerReadReservationBytes: 256 * 1024,
  /** JSON decode cap only; the FS read may have returned more bytes. */
  ownerDecodeBytes: 16 * 1024,
  maxPids: 16,
  statChars: 16,
  startedAtChars: 32,
  psStdoutBytes: 64 * 1024,
  psStderrBytes: 4 * 1024,
  osBudgetMs: 5000,
  osCleanupMs: 1000,
  reasonChars: 320,
});

const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LSTART_PATTERN = /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

/** Mirrors the current vendor `STAGE_IDS`; old layouts outside it are unavailable. */
const FIXED_STAGE_IDS = Object.freeze([
  "baseline",
  "inv_edit",
  "dom_edit",
  "inv_probe",
  "dom_probe",
  "compose_edit",
  "final",
  "select",
  "reflect",
  "plan",
  "route_1",
  "route_2",
  "route_3",
  "review",
  "refine",
] as const);
const STAGE_ID_SET = new Set<string>(FIXED_STAGE_IDS);

export interface NativeHarnessHistoryProcessReason {
  readonly code: string;
  readonly detail: string;
}

function boundedDetail(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.reasonChars
    ? normalized
    : normalized.slice(0, NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.reasonChars);
}

export function processReason(code: string, detail: string): NativeHarnessHistoryProcessReason {
  return Object.freeze({ code, detail: boundedDetail(detail) });
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= 1024
    && !CONTROL_PATTERN.test(value)
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && value !== path.parse(value).root;
}

/* ------------------------------------------------------------------------- */
/* Fixed target derivation                                                   */
/* ------------------------------------------------------------------------- */

export type NativeHarnessHistoryProcessTargetKind = "controller" | "stage";

export interface NativeHarnessHistoryProcessTarget {
  readonly targetId: string;
  readonly kind: NativeHarnessHistoryProcessTargetKind;
  readonly stage: string | null;
  readonly attempt: number | null;
  readonly recordedStatus: "running" | "completed" | "failed" | null;
  /** Storage-root-relative POSIX path; never an absolute read root. */
  readonly ownerRelativePath: string;
}

export interface NativeHarnessHistoryProcessStageInput {
  readonly id: string;
  readonly status: "running" | "completed" | "failed";
  readonly attempt: number;
  readonly cwd: string;
}

export interface NativeHarnessHistoryProcessStageTargetRow {
  readonly id: string;
  readonly status: "running" | "completed" | "failed";
  readonly attempt: number | null;
  readonly target: NativeHarnessHistoryProcessTarget | null;
  readonly problem: NativeHarnessHistoryProcessReason | null;
}

export interface NativeHarnessHistoryProcessTargets {
  readonly controller: NativeHarnessHistoryProcessTarget;
  readonly stages: readonly NativeHarnessHistoryProcessStageTargetRow[];
  readonly problems: readonly NativeHarnessHistoryProcessReason[];
  /** Total derived targets, including the controller; at most 16. */
  readonly targetCount: number;
}

function stageCwdLayout(
  storageRoot: string,
  runRelativeRoot: string,
  runId: string,
  id: string,
  attempt: number,
  cwd: string,
): { readonly ok: true; readonly attemptDirectory: string } | { readonly ok: false; readonly problem: NativeHarnessHistoryProcessReason } {
  if (!isCanonicalAbsolutePath(cwd)) {
    return {
      ok: false,
      problem: processReason(
        "stage-workspace-invalid",
        "A recorded stage workspace is not an absolute normalized path.",
      ),
    };
  }
  const relativeCwd = path.relative(storageRoot, cwd);
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd) || relativeCwd === "") {
    return {
      ok: false,
      problem: processReason(
        "stage-workspace-invalid",
        "A recorded stage workspace is outside the pinned selected run.",
      ),
    };
  }
  const segments = relativeCwd.split(path.sep);
  const expectedAttemptPrefix = `attempt-${attempt}-`;
  // <harness>/store/runs/<runId>/stages/<stage>/attempt-<n>-<uuid>/workspace
  const attemptDirectory = segments[6];
  const runSegments = runRelativeRoot.split("/");
  const shapeMatches = segments.length === 8
    && segments[0] === runSegments[0]
    && segments[1] === "store"
    && segments[2] === "runs"
    && segments[3] === runId
    && segments[4] === "stages"
    && segments[5] === id
    && attemptDirectory !== undefined
    && attemptDirectory.startsWith(expectedAttemptPrefix)
    && UUID_PATTERN.test(attemptDirectory.slice(expectedAttemptPrefix.length))
    && segments[7] === "workspace";
  if (!shapeMatches) {
    return {
      ok: false,
      problem: processReason(
        "stage-workspace-invalid",
        "A recorded stage workspace does not have the exact selected-run/stage/attempt/workspace shape.",
      ),
    };
  }
  return { ok: true, attemptDirectory };
}

/**
 * Derives the finite local target allowlist from the already decoded record.
 * It performs no I/O. Invalid stage rows keep their recorded labels but get no
 * target, so the core starts zero corresponding reads for them.
 */
export function deriveNativeHarnessHistoryProcessTargets(
  storageRoot: string,
  runRelativeRoot: string,
  runId: string,
  stages: readonly NativeHarnessHistoryProcessStageInput[],
): NativeHarnessHistoryProcessTargets {
  const problems: NativeHarnessHistoryProcessReason[] = [];
  const controller: NativeHarnessHistoryProcessTarget = Object.freeze({
    targetId: "controller",
    kind: "controller" as const,
    stage: null,
    attempt: null,
    recordedStatus: null,
    ownerRelativePath: `${runRelativeRoot}/.run.lock/owner.json`,
  });
  const rows: NativeHarnessHistoryProcessStageTargetRow[] = [];
  const seenIds = new Set<string>();
  let targetCount = 1;
  for (const stage of stages) {
    const attempt = isPositiveSafeInteger(stage.attempt) ? stage.attempt : null;
    if (!STAGE_ID_SET.has(stage.id) || stage.id === "controller") {
      const problem = processReason(
        "stage-id-invalid",
        "A recorded stage ID is not one of the fixed current vendor stages.",
      );
      problems.push(problem);
      rows.push({ id: stage.id, status: stage.status, attempt, target: null, problem });
      continue;
    }
    if (seenIds.has(stage.id)) {
      const problem = processReason(
        "stage-id-duplicate",
        "A recorded stage ID appeared more than once; only the first row is targetable.",
      );
      problems.push(problem);
      rows.push({ id: stage.id, status: stage.status, attempt, target: null, problem });
      continue;
    }
    seenIds.add(stage.id);
    if (targetCount >= NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.maxTargets) {
      const problem = processReason(
        "stage-target-limit",
        `More than ${NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.maxTargets - 1} current stage rows were recorded; this row is unavailable.`,
      );
      problems.push(problem);
      rows.push({ id: stage.id, status: stage.status, attempt, target: null, problem });
      continue;
    }
    if (attempt === null) {
      const problem = processReason(
        "stage-attempt-invalid",
        "A recorded stage attempt is not a positive safe integer.",
      );
      problems.push(problem);
      rows.push({ id: stage.id, status: stage.status, attempt: null, target: null, problem });
      continue;
    }
    const layout = stageCwdLayout(storageRoot, runRelativeRoot, runId, stage.id, attempt, stage.cwd);
    if (!layout.ok) {
      problems.push(layout.problem);
      rows.push({ id: stage.id, status: stage.status, attempt, target: null, problem: layout.problem });
      continue;
    }
    const target: NativeHarnessHistoryProcessTarget = Object.freeze({
      targetId: stage.id,
      kind: "stage" as const,
      stage: stage.id,
      attempt,
      recordedStatus: stage.status,
      ownerRelativePath: `${runRelativeRoot}/stages/${stage.id}/${layout.attemptDirectory}/artifacts/worker-owner.json`,
    });
    targetCount += 1;
    rows.push({ id: stage.id, status: stage.status, attempt, target, problem: null });
  }
  return Object.freeze({
    controller,
    stages: Object.freeze(rows),
    problems: Object.freeze(problems),
    targetCount,
  });
}

/* ------------------------------------------------------------------------- */
/* Recovery lifecycle targets, probes and factual projection                 */
/* ------------------------------------------------------------------------- */

export const NATIVE_HARNESS_HISTORY_RECOVERY_LIMITS = Object.freeze({
  maxAttempts: 32,
  maxProbesPerRound: 33,
  maxProbes: 66,
  maxAuxPerRound: 34,
  maxAux: 68,
  ownerCapBytes: 16 * 1024,
  cancelCapBytes: 64,
  auxChargeLimitBytes: 1_081_472,
  lifecycleMs: 5_000,
  maxResultBytes: 128 * 1024,
});

/**
 * Narrow synchronous live-process seam. The signal is always the literal 0.
 * The default discards `process.kill`'s boolean result; any non-undefined
 * return or thenable is treated as an unusable observation, never presence.
 */
export type NativeHarnessHistorySignalQuery = (pid: number, signal: 0) => void;

export const nativeHarnessHistorySignalQuery: NativeHarnessHistorySignalQuery = (pid) => {
  // The OS signal is never taken from the caller or a mutable argument.
  process.kill(pid, 0);
};

export type NativeHarnessHistoryRecoveryAuxKind = "worker-owner" | "controller-owner" | "cancel";

export type NativeHarnessHistoryRecoveryAuxState =
  | "observed"
  | "missing"
  | "lock-directory-missing"
  | "ancestor-missing"
  | "unsafe"
  | "too-large"
  | "unavailable"
  | "not-attempted"
  | "aborted"
  | "expired";

export type NativeHarnessHistoryRecoveryAuxMissingAt = "target" | "ancestor" | "lock-directory";

export interface NativeHarnessHistoryRecoveryCleanupInputRunner {
  readonly observationKind: "runner-observation";
  readonly spawnAttempted: boolean;
  readonly closeSeen: boolean;
  readonly groupObservation: "not-observed" | "present" | "unknown";
  readonly hostWorkSettled: boolean;
  readonly approvalWorkSettled: boolean;
  readonly logFlush: "success" | "failure";
}

export interface NativeHarnessHistoryRecoveryCleanupInputSynthetic {
  readonly observationKind: "synthetic-fixture";
}

export type NativeHarnessHistoryRecoveryCleanupInput =
  | NativeHarnessHistoryRecoveryCleanupInputRunner
  | NativeHarnessHistoryRecoveryCleanupInputSynthetic;

export interface NativeHarnessHistoryRecoveryRowInput {
  readonly ordinal: number;
  readonly nonce: string;
  readonly stage: string;
  readonly attempt: number;
  readonly cwd: string;
  readonly artifactDir: string;
  readonly state: string;
  readonly launchRuntimeRoot: string | null;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly processIdentitySha256: string | null;
  readonly cleanup: NativeHarnessHistoryRecoveryCleanupInput | null;
}

export interface NativeHarnessHistoryRecoveryAuxTarget {
  readonly targetId: string;
  readonly kind: NativeHarnessHistoryRecoveryAuxKind;
  /** Storage-root-relative POSIX path. */
  readonly relativePath: string;
  /** Fixed bounded ancestors between the storage root and the target parent. */
  readonly ancestorRelativePaths: readonly string[];
  readonly capBytes: number;
}

export type NativeHarnessHistoryRecoveryHistoricalCleanupDeclaration =
  | "recorded-no-launch"
  | "declared-cleanup-observed"
  | "synthetic-fixture-not-proof"
  | "no-cleanup-recorded"
  | "unknown";

export interface NativeHarnessHistoryRecoveryHistoricalCleanup {
  readonly declaration: NativeHarnessHistoryRecoveryHistoricalCleanupDeclaration;
  readonly spawnAttempted: boolean | null;
  readonly closeSeen: boolean | null;
  readonly groupObservation: "not-observed" | "present" | "unknown" | null;
  readonly hostWorkSettled: boolean | null;
  readonly approvalWorkSettled: boolean | null;
  readonly logFlush: "success" | "failure" | null;
}

export interface NativeHarnessHistoryRecoveryAttemptTarget {
  readonly targetId: string;
  readonly ordinal: number;
  readonly nonce: string;
  readonly stage: string;
  readonly attempt: number;
  readonly dispatchState: string;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly processIdentitySha256: string | null;
  readonly launchRuntimeRoot: string | null;
  readonly workerOwner: NativeHarnessHistoryRecoveryAuxTarget | null;
  readonly historicalCleanup: NativeHarnessHistoryRecoveryHistoricalCleanup;
  readonly problem: NativeHarnessHistoryProcessReason | null;
}

export interface NativeHarnessHistoryRecoveryTargets {
  readonly attempts: readonly NativeHarnessHistoryRecoveryAttemptTarget[];
  readonly controllerOwner: NativeHarnessHistoryRecoveryAuxTarget;
  readonly cancel: NativeHarnessHistoryRecoveryAuxTarget;
  readonly problems: readonly NativeHarnessHistoryProcessReason[];
  readonly workerOwnerTargets: number;
  readonly auxTargetsPerRound: number;
  readonly auxChargePerRound: number;
  readonly auxChargeTotal: number;
  /** True when the whole lifecycle target set was refused before any effect. */
  readonly refused: boolean;
  readonly inventoryRows: number;
}

function historicalCleanupFor(
  state: string,
  cleanup: NativeHarnessHistoryRecoveryCleanupInput | null,
): NativeHarnessHistoryRecoveryHistoricalCleanup {
  if (cleanup !== null && cleanup.observationKind === "synthetic-fixture") {
    return Object.freeze({
      declaration: "synthetic-fixture-not-proof" as const,
      spawnAttempted: null,
      closeSeen: null,
      groupObservation: null,
      hostWorkSettled: null,
      approvalWorkSettled: null,
      logFlush: null,
    });
  }
  if (cleanup !== null) {
    return Object.freeze({
      declaration: cleanup.spawnAttempted
        ? "declared-cleanup-observed" as const
        : "recorded-no-launch" as const,
      spawnAttempted: cleanup.spawnAttempted,
      closeSeen: cleanup.closeSeen,
      groupObservation: cleanup.groupObservation,
      hostWorkSettled: cleanup.hostWorkSettled,
      approvalWorkSettled: cleanup.approvalWorkSettled,
      logFlush: cleanup.logFlush,
    });
  }
  // An intended row and a launch gap without a process bound have no real
  // no-spawn receipt. They stay unknown rather than becoming cleanup proof.
  if (state === "intended" || state === "launch-pending") {
    return Object.freeze({
      declaration: "unknown" as const,
      spawnAttempted: null,
      closeSeen: null,
      groupObservation: null,
      hostWorkSettled: null,
      approvalWorkSettled: null,
      logFlush: null,
    });
  }
  return Object.freeze({
    declaration: "no-cleanup-recorded" as const,
    spawnAttempted: null,
    closeSeen: null,
    groupObservation: null,
    hostWorkSettled: null,
    approvalWorkSettled: null,
    logFlush: null,
  });
}

function recoveryAuxTarget(
  targetId: string,
  kind: NativeHarnessHistoryRecoveryAuxKind,
  relativePath: string,
  ancestorRelativePaths: readonly string[],
  capBytes: number,
): NativeHarnessHistoryRecoveryAuxTarget {
  return Object.freeze({
    targetId,
    kind,
    relativePath,
    ancestorRelativePaths: Object.freeze([...ancestorRelativePaths]),
    capBytes,
  });
}

/**
 * Pure recovery target derivation over the already decoded inventory v2 rows.
 * Unlike the original R1 target list it never deduplicates by stage: every
 * ordinal+nonce attempt identity is retained, up to the inventory's 32-row
 * bound. Invalid layout rows keep their process/historical facts but receive
 * no worker-owner path.
 */
export function deriveNativeHarnessHistoryRecoveryTargets(
  storageRoot: string,
  runRelativeRoot: string,
  runId: string,
  rows: readonly NativeHarnessHistoryRecoveryRowInput[],
): NativeHarnessHistoryRecoveryTargets {
  const problems: NativeHarnessHistoryProcessReason[] = [];
  const attempts: NativeHarnessHistoryRecoveryAttemptTarget[] = [];
  const controllerOwner = recoveryAuxTarget(
    "controller-owner",
    "controller-owner",
    `${runRelativeRoot}/.run.lock/owner.json`,
    [`${runRelativeRoot}/.run.lock`],
    NATIVE_HARNESS_HISTORY_RECOVERY_LIMITS.ownerCapBytes,
  );
  const cancel = recoveryAuxTarget(
    "cancel",
    "cancel",
    `${runRelativeRoot}/cancel.request`,
    [],
    NATIVE_HARNESS_HISTORY_RECOVERY_LIMITS.cancelCapBytes,
  );
  if (rows.length > NATIVE_HARNESS_HISTORY_RECOVERY_LIMITS.maxAttempts) {
    // Admission is all-or-nothing: never truncate to a plausible subset.
    return Object.freeze({
      attempts: Object.freeze([]),
      controllerOwner,
      cancel,
      problems: Object.freeze([processReason(
        "recovery-attempt-limit",
        `More than ${NATIVE_HARNESS_HISTORY_RECOVERY_LIMITS.maxAttempts} inventory rows were supplied; lifecycle observation was refused before any auxiliary read or probe.`,
      )]),
      workerOwnerTargets: 0,
      auxTargetsPerRound: 0,
      auxChargePerRound: 0,
      auxChargeTotal: 0,
      refused: true,
      inventoryRows: rows.length,
    });
  }
  for (const row of rows) {
    if (!isPositiveSafeInteger(row.ordinal) || !UUID_PATTERN.test(row.nonce)) {
      const problem = processReason(
        "recovery-attempt-identity",
        "An inventory row does not carry a positive ordinal and canonical nonce identity.",
      );
      problems.push(problem);
      continue;
    }
    const targetId = `attempt-${row.ordinal}-${row.nonce}`;
    let problem: NativeHarnessHistoryProcessReason | null = null;
    let workerOwner: NativeHarnessHistoryRecoveryAuxTarget | null = null;
    if (!isPositiveSafeInteger(row.attempt)) {
      problem = processReason(
        "recovery-attempt-invalid",
        "An inventory row attempt is not a positive safe integer.",
      );
    } else {
      const layout = stageCwdLayout(
        storageRoot,
        runRelativeRoot,
        runId,
        row.stage,
        row.attempt,
        row.cwd,
      );
      if (!layout.ok) {
        problem = layout.problem;
      } else {
        const expectedArtifactDir = path.join(
          storageRoot,
          runRelativeRoot,
          "stages",
          row.stage,
          layout.attemptDirectory,
          "artifacts",
        );
        if (row.artifactDir !== expectedArtifactDir) {
          problem = processReason(
            "recovery-artifact-dir-mismatch",
            "An inventory row artifact directory is not the exact selected-run/stage/attempt sibling.",
          );
        } else {
          const artifactRelativePath = `${runRelativeRoot}/stages/${row.stage}/${layout.attemptDirectory}/artifacts`;
          workerOwner = recoveryAuxTarget(
            `${targetId}-worker-owner`,
            "worker-owner",
            `${artifactRelativePath}/worker-owner.json`,
            [
              `${runRelativeRoot}/stages`,
              `${runRelativeRoot}/stages/${row.stage}`,
              `${runRelativeRoot}/stages/${row.stage}/${layout.attemptDirectory}`,
              artifactRelativePath,
            ],
            NATIVE_HARNESS_HISTORY_RECOVERY_LIMITS.ownerCapBytes,
          );
        }
      }
    }
    if (problem !== null) problems.push(problem);
    attempts.push(Object.freeze({
      targetId,
      ordinal: row.ordinal,
      nonce: row.nonce,
      stage: row.stage,
      attempt: row.attempt,
      dispatchState: row.state,
      pid: row.pid,
      pgid: row.pgid,
      processIdentitySha256: row.processIdentitySha256,
      launchRuntimeRoot: row.launchRuntimeRoot,
      workerOwner,
      historicalCleanup: historicalCleanupFor(row.state, row.cleanup),
      problem,
    }));
  }
  const workerOwnerTargets = attempts.filter((attempt) => attempt.workerOwner !== null).length;
  const auxTargetsPerRound = workerOwnerTargets + 2;
  const auxChargePerRound = attempts.reduce(
    (sum, attempt) => sum + (attempt.workerOwner?.capBytes ?? 0),
    controllerOwner.capBytes + cancel.capBytes,
  );
  return Object.freeze({
    attempts: Object.freeze(attempts),
    controllerOwner,
    cancel,
    problems: Object.freeze(problems),
    workerOwnerTargets,
    auxTargetsPerRound,
    auxChargePerRound,
    auxChargeTotal: auxChargePerRound * 2,
    refused: false,
    inventoryRows: rows.length,
  });
}

/* ------------------------------------------------------------------------- */
/* Fixed synchronous signal-0 probes                                         */
/* ------------------------------------------------------------------------- */

export interface NativeHarnessHistoryRecoveryProbeFact {
  readonly kind: "process-group" | "controller-pid";
  readonly targetId: string;
  readonly ordinal: number | null;
  readonly nonce: string | null;
  readonly stage: string | null;
  readonly attempt: number | null;
  readonly pid: number | null;
  readonly pgid: number | null;
  /** Positive PID or negative PGID actually passed to the seam. */
  readonly queryPid: number | null;
  readonly signal: 0;
  readonly applicable: boolean;
  readonly called: boolean;
  readonly presence: NativeHarnessHistoryProcessPresence;
  readonly refused: boolean;
  readonly problem: NativeHarnessHistoryProcessReason | null;
}

function refusedProbe(
  base: Omit<NativeHarnessHistoryRecoveryProbeFact, "signal" | "applicable" | "called" | "presence" | "refused" | "problem" | "queryPid">,
  detail: string,
): NativeHarnessHistoryRecoveryProbeFact {
  return Object.freeze({
    ...base,
    queryPid: null,
    signal: 0 as const,
    applicable: false,
    called: false,
    presence: "unknown" as const,
    refused: true,
    problem: processReason("probe-target-refused", detail),
  });
}

function runSignalProbe(
  base: Omit<NativeHarnessHistoryRecoveryProbeFact, "signal" | "called" | "presence" | "refused" | "problem" | "queryPid">,
  targetPid: number,
  seam: NativeHarnessHistorySignalQuery,
): NativeHarnessHistoryRecoveryProbeFact {
  let result: unknown;
  try {
    result = (seam as (pid: number, signal: 0) => unknown)(targetPid, 0);
  } catch (error) {
    let code: string | null = null;
    try {
      if (typeof error === "object" && error !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(error, "code");
        if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") {
          code = descriptor.value;
        }
      }
    } catch {
      code = null;
    }
    if (code === "ESRCH") {
      return Object.freeze({
        ...base,
        queryPid: targetPid,
        signal: 0 as const,
        called: true,
        presence: "not-observed" as const,
        refused: false,
        problem: processReason(
          "probe-not-observed",
          "The fixed signal-0 query returned ESRCH in this round; this is an interval observation, never proof about a later process.",
        ),
      });
    }
    return Object.freeze({
      ...base,
      queryPid: targetPid,
      signal: 0 as const,
      called: true,
      presence: "unknown" as const,
      refused: false,
      problem: processReason(
        "probe-unknown",
        code === "EPERM" || code === "EINVAL"
          ? "The fixed signal-0 query was refused; presence and absence are unknown."
          : "The fixed signal-0 query failed or was unusable; presence and absence are unknown.",
      ),
    });
  }
  if (result !== undefined) {
    return Object.freeze({
      ...base,
      queryPid: targetPid,
      signal: 0 as const,
      called: true,
      presence: "unknown" as const,
      refused: false,
      problem: processReason(
        "probe-seam-unusable",
        "The fixed signal-0 seam returned a non-void or asynchronous result; it is not treated as presence.",
      ),
    });
  }
  return Object.freeze({
    ...base,
    queryPid: targetPid,
    signal: 0 as const,
    called: true,
    presence: "present" as const,
    refused: false,
    problem: null,
  });
}

/**
 * One fresh inventory-PGID query. PGID <= 1 is refused before the seam is
 * invoked; no leader-PID query is substituted for group observation.
 */
export function probeNativeHarnessHistoryRecoveryGroup(
  attempt: NativeHarnessHistoryRecoveryAttemptTarget,
  seam: NativeHarnessHistorySignalQuery,
): NativeHarnessHistoryRecoveryProbeFact {
  const base = {
    kind: "process-group" as const,
    targetId: attempt.targetId,
    ordinal: attempt.ordinal,
    nonce: attempt.nonce,
    stage: attempt.stage,
    attempt: attempt.attempt,
    pid: attempt.pid,
    pgid: attempt.pgid,
  };
  if (attempt.pgid === null) {
    return Object.freeze({
      ...base,
      queryPid: null,
      signal: 0 as const,
      applicable: false,
      called: false,
      presence: "unknown" as const,
      refused: false,
      problem: processReason("probe-no-process-group", "The inventory row has no recorded process PGID."),
    });
  }
  if (!isPositiveSafeInteger(attempt.pgid) || attempt.pgid <= 1) {
    return refusedProbe(base, "The recorded process PGID is not greater than 1; no query was made.");
  }
  return runSignalProbe({ ...base, applicable: true }, -attempt.pgid, seam);
}

export function probeNativeHarnessHistoryRecoveryController(
  pid: number,
  seam: NativeHarnessHistorySignalQuery,
): NativeHarnessHistoryRecoveryProbeFact {
  const base = {
    kind: "controller-pid" as const,
    targetId: "controller-owner",
    ordinal: null,
    nonce: null,
    stage: null,
    attempt: null,
    pid,
    pgid: null,
  };
  if (!isPositiveSafeInteger(pid)) {
    return refusedProbe(base, "The observed controller owner PID is not a positive safe integer.");
  }
  return runSignalProbe({ ...base, applicable: true }, pid, seam);
}

/* ------------------------------------------------------------------------- */
/* Declared worker association                                               */
/* ------------------------------------------------------------------------- */

export type NativeHarnessHistoryRecoveryBindingState =
  | "matches"
  | "mismatch"
  | "not-observed"
  | "not-applicable"
  | "unknown";

export interface NativeHarnessHistoryRecoveryWorkerBinding {
  readonly state: NativeHarnessHistoryRecoveryBindingState;
  /** Recomputed original Runner association; never a process-birth proof. */
  readonly associationSha256: string | null;
  readonly declaredIdentitySha256: string | null;
  readonly problem: NativeHarnessHistoryProcessReason | null;
}

function bindingProblem(state: NativeHarnessHistoryRecoveryBindingState, detail: string): NativeHarnessHistoryRecoveryWorkerBinding {
  return Object.freeze({
    state,
    associationSha256: null,
    declaredIdentitySha256: null,
    problem: processReason(`worker-binding-${state}`, detail),
  });
}

/**
 * Recomputes the original Runner association over key-sorted canonical JSON of
 * {runId,stage,runtimeRoot,pid,pgid,startedAt} with no trailing LF. The owner's
 * privateRuntimeRoot supplies runtimeRoot. Owner JSON, nonce and attempt are
 * never hashed or added.
 */
export function bindNativeHarnessHistoryRecoveryWorker(
  attempt: NativeHarnessHistoryRecoveryAttemptTarget,
  runId: string,
  read: NativeHarnessHistoryProcessOwnerRead | null,
): NativeHarnessHistoryRecoveryWorkerBinding {
  if (attempt.pid === null && attempt.pgid === null) {
    if (attempt.launchRuntimeRoot !== null) {
      return bindingProblem(
        "unknown",
        "A launch was recorded without a process-bound PID/PGID; the process association remains unknown.",
      );
    }
    return bindingProblem("not-applicable", "The inventory row has no process-bound association.");
  }
  if (read === null || read.state === "not-attempted" || read.state === "missing") {
    return bindingProblem(
      "not-observed",
      "The worker owner record is absent or was not attempted; this remains missing, not dead.",
    );
  }
  if (read.state !== "observed" || read.declaration === null) {
    return bindingProblem(
      "unknown",
      read.problem?.detail ?? "The worker owner record could not be decoded for association.",
    );
  }
  const declaration = read.declaration;
  if (declaration.kind !== "worker") {
    return bindingProblem("mismatch", "The worker target decoded a non-worker owner declaration.");
  }
  if (
    attempt.pid === null
    || attempt.pgid === null
    || attempt.launchRuntimeRoot === null
    || declaration.runId !== runId
    || declaration.stage !== attempt.stage
    || declaration.pid !== attempt.pid
    || declaration.pgid !== attempt.pgid
    || declaration.privateRuntimeRoot !== attempt.launchRuntimeRoot
  ) {
    return bindingProblem(
      "mismatch",
      "The worker owner run/stage/PID/PGID/runtime facts do not match the inventory row.",
    );
  }
  const associationPayload = JSON.stringify({
    pgid: declaration.pgid,
    pid: declaration.pid,
    runId: declaration.runId,
    runtimeRoot: declaration.privateRuntimeRoot,
    stage: declaration.stage,
    startedAt: declaration.startedAt,
  });
  const associationSha256 = sha256Hex(associationPayload);
  if (attempt.processIdentitySha256 === null) {
    return Object.freeze({
      state: "unknown" as const,
      associationSha256,
      declaredIdentitySha256: null,
      problem: processReason(
        "worker-binding-identity-missing",
        "The inventory row does not carry a recorded association digest for comparison.",
      ),
    });
  }
  if (attempt.processIdentitySha256 !== associationSha256) {
    return Object.freeze({
      state: "mismatch" as const,
      associationSha256,
      declaredIdentitySha256: attempt.processIdentitySha256,
      problem: processReason(
        "worker-binding-digest-mismatch",
        "The recomputed Runner association does not match the inventory row identity; this is not process-birth authentication.",
      ),
    });
  }
  return Object.freeze({
    state: "matches" as const,
    associationSha256,
    declaredIdentitySha256: attempt.processIdentitySha256,
    problem: null,
  });
}

/* ------------------------------------------------------------------------- */
/* Factual lifecycle projection                                              */
/* ------------------------------------------------------------------------- */

export interface NativeHarnessHistoryRecoveryAuxFact {
  readonly kind: NativeHarnessHistoryRecoveryAuxKind;
  readonly state: NativeHarnessHistoryRecoveryAuxState;
  readonly exists: boolean | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly openedFiles: 0 | 1;
  readonly closeAttempted: boolean;
  readonly closeSettled: boolean;
  readonly closeSucceeded: boolean;
  readonly missingAt: NativeHarnessHistoryRecoveryAuxMissingAt | null;
  readonly ownerState: NativeHarnessHistoryProcessOwnerState | null;
  readonly ownerPid: number | null;
  readonly ownerPgid: number | null;
  readonly ownerSha256: string | null;
  readonly problem: NativeHarnessHistoryProcessReason | null;
}

export type NativeHarnessHistoryRecoveryComparison =
  | "stable"
  | "different"
  | "unavailable"
  | "not-attempted"
  | "revoked";

export type NativeHarnessHistoryRecoveryStatus =
  | "stable"
  | "different"
  | "unavailable"
  | "not-observed"
  | "aborted"
  | "expired"
  | "revoked";

export interface NativeHarnessHistoryRecoveryAttemptSummaryInput {
  readonly target: NativeHarnessHistoryRecoveryAttemptTarget;
  readonly round1Worker: NativeHarnessHistoryRecoveryAuxFact | null;
  readonly round2Worker: NativeHarnessHistoryRecoveryAuxFact | null;
  readonly binding1: NativeHarnessHistoryRecoveryWorkerBinding | null;
  readonly binding2: NativeHarnessHistoryRecoveryWorkerBinding | null;
  readonly group1: NativeHarnessHistoryRecoveryProbeFact | null;
  readonly group2: NativeHarnessHistoryRecoveryProbeFact | null;
  readonly workerComparison: NativeHarnessHistoryRecoveryComparison;
  readonly groupComparison: NativeHarnessHistoryRecoveryComparison;
  readonly coverage: "complete" | "partial" | "unavailable";
}

export interface NativeHarnessHistoryRecoveryControllerSummaryInput {
  readonly round1Owner: NativeHarnessHistoryRecoveryAuxFact | null;
  readonly round2Owner: NativeHarnessHistoryRecoveryAuxFact | null;
  readonly probe1: NativeHarnessHistoryRecoveryProbeFact | null;
  readonly probe2: NativeHarnessHistoryRecoveryProbeFact | null;
  readonly ownerComparison: NativeHarnessHistoryRecoveryComparison;
  readonly probeComparison: NativeHarnessHistoryRecoveryComparison;
  readonly lockDirectory1: "present" | "missing" | "unsafe" | "unknown" | "not-attempted";
  readonly lockDirectory2: "present" | "missing" | "unsafe" | "unknown" | "not-attempted";
}

export interface NativeHarnessHistoryRecoveryCancelSummaryInput {
  readonly round1: NativeHarnessHistoryRecoveryAuxFact | null;
  readonly round2: NativeHarnessHistoryRecoveryAuxFact | null;
  readonly status: "requested" | "not-observed" | "unknown" | "not-attempted";
  readonly comparison: NativeHarnessHistoryRecoveryComparison;
}

export interface NativeHarnessHistoryRecoveryWindowInput {
  readonly budgetMs: 5_000;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly checkedAt: number;
  readonly expired: boolean;
  readonly globalDeadlineAt: number;
  readonly roundsStarted: 0 | 1 | 2;
}

export interface NativeHarnessHistoryRecoveryProjectionInput {
  readonly attempts: readonly NativeHarnessHistoryRecoveryAttemptSummaryInput[];
  readonly controller: NativeHarnessHistoryRecoveryControllerSummaryInput;
  readonly cancel: NativeHarnessHistoryRecoveryCancelSummaryInput;
  readonly inventoryRows: number;
  readonly auxAttemptsRound1: number;
  readonly auxAttemptsRound2: number;
  readonly auxChargedBytes: number;
  readonly probesRound1: number;
  readonly probesRound2: number;
  readonly window: NativeHarnessHistoryRecoveryWindowInput;
  readonly gate: "aborted" | "deadline-expired" | null;
  readonly prerequisiteFailure: NativeHarnessHistoryProcessReason | null;
  readonly derivationProblems: readonly NativeHarnessHistoryProcessReason[];
  readonly finalPrimaryStatus: NativeHarnessReconciliationFilesStatusInput;
  readonly revokedReasons: readonly string[];
}

/** Mirrors the collector's final primary status without a runtime import cycle. */
export type NativeHarnessReconciliationFilesStatusInput =
  | "stable"
  | "different"
  | "unavailable"
  | "unknown"
  | "aborted"
  | "expired";

export interface NativeHarnessHistoryRecoveryAttemptProjection {
  readonly targetId: string;
  readonly ordinal: number;
  readonly nonce: string;
  readonly stage: string;
  readonly attempt: number;
  readonly dispatchState: string;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly inventoryIdentitySha256: string | null;
  readonly historicalCleanup: NativeHarnessHistoryRecoveryHistoricalCleanup;
  readonly worker: {
    readonly round1: NativeHarnessHistoryRecoveryAuxFact | null;
    readonly round2: NativeHarnessHistoryRecoveryAuxFact | null;
    readonly comparison: NativeHarnessHistoryRecoveryComparison;
    readonly binding1: NativeHarnessHistoryRecoveryWorkerBinding | null;
    readonly binding2: NativeHarnessHistoryRecoveryWorkerBinding | null;
  };
  readonly group: {
    readonly round1: NativeHarnessHistoryRecoveryProbeFact | null;
    readonly round2: NativeHarnessHistoryRecoveryProbeFact | null;
    readonly comparison: NativeHarnessHistoryRecoveryComparison;
  };
  readonly coverage: "complete" | "partial" | "unavailable";
}

export interface NativeHarnessHistoryRecoveryLifecycleFacts {
  readonly status: NativeHarnessHistoryRecoveryStatus;
  readonly provisionalStatus: Exclude<NativeHarnessHistoryRecoveryStatus, "revoked">;
  readonly revoked: boolean;
  readonly revokedReasons: readonly string[];
  readonly failure: NativeHarnessHistoryProcessReason | null;
  readonly rounds: 2;
  readonly coverage: {
    readonly inventoryRows: number;
    readonly attemptTargets: number;
    readonly workerOwnerTargets: number;
    readonly completeAttempts: number;
    readonly auxAttemptsRound1: number;
    readonly auxAttemptsRound2: number;
    readonly auxChargedBytes: number;
    readonly auxChargeLimitBytes: 1_081_472;
    readonly auxTargetLimitPerRound: 34;
    readonly probesRound1: number;
    readonly probesRound2: number;
    readonly probeLimitPerRound: 33;
    readonly maxOpenedFiles: 1;
  };
  readonly completeAttemptCoverage: {
    readonly status: "complete" | "incomplete" | "unavailable" | "not-required";
    readonly detail: string;
  };
  readonly attempts: readonly NativeHarnessHistoryRecoveryAttemptProjection[];
  readonly currentGroups: {
    readonly status: NativeHarnessHistoryRecoveryStatus;
    readonly round1: {
      readonly present: number;
      readonly notObserved: number;
      readonly unknown: number;
      readonly refused: number;
    };
    readonly round2: {
      readonly present: number;
      readonly notObserved: number;
      readonly unknown: number;
      readonly refused: number;
    };
    readonly absenceObservation:
      | "not-applicable"
      | "all-known-groups-not-observed-in-both-rounds"
      | "some-known-groups-present"
      | "unknown";
    readonly claim: "interval-observation-only-never-future-permission";
  };
  readonly controllerLease: {
    readonly status: NativeHarnessHistoryRecoveryStatus;
    readonly lockDirectoryRound1: "present" | "missing" | "unsafe" | "unknown" | "not-attempted";
    readonly lockDirectoryRound2: "present" | "missing" | "unsafe" | "unknown" | "not-attempted";
    readonly ownerRound1: NativeHarnessHistoryRecoveryAuxFact | null;
    readonly ownerRound2: NativeHarnessHistoryRecoveryAuxFact | null;
    readonly ownerComparison: NativeHarnessHistoryRecoveryComparison;
    readonly probe1: NativeHarnessHistoryRecoveryProbeFact | null;
    readonly probe2: NativeHarnessHistoryRecoveryProbeFact | null;
    readonly probeComparison: NativeHarnessHistoryRecoveryComparison;
    readonly ownerPid: number | null;
    readonly claim: "lock-owner-declaration-and-interval-presence-only";
  };
  readonly cancel: {
    readonly status: "requested" | "not-observed" | "unknown" | "not-attempted";
    readonly round1: NativeHarnessHistoryRecoveryAuxFact | null;
    readonly round2: NativeHarnessHistoryRecoveryAuxFact | null;
    readonly comparison: NativeHarnessHistoryRecoveryComparison;
    readonly claim: "existence-only-no-generation-or-clear";
  };
  readonly historicalCleanup: {
    readonly recordedNoLaunch: number;
    readonly declaredCleanupObserved: number;
    readonly syntheticFixtureNotProof: number;
    readonly noCleanupRecorded: number;
    readonly unknown: number;
    readonly claim: "declared-inventory-facts-not-fresh-os-proof";
  };
  readonly observationStability: {
    readonly status: NativeHarnessHistoryRecoveryStatus;
    readonly workerAuxStable: boolean | null;
    readonly groupsStable: boolean | null;
    readonly controllerStable: boolean | null;
    readonly cancelStable: boolean | null;
    readonly reasons: readonly string[];
  };
  readonly window: {
    readonly budgetMs: 5_000;
    readonly startedAt: number;
    readonly deadlineAt: number;
    readonly checkedAt: number;
    readonly expired: boolean;
    readonly constrainedByRemaining30s: boolean;
    readonly roundsStarted: 0 | 1 | 2;
    readonly soft: true;
  };
}

function comparisonOf(...values: readonly NativeHarnessHistoryRecoveryComparison[]): NativeHarnessHistoryRecoveryComparison {
  if (values.includes("different")) return "different";
  if (values.includes("unavailable")) return "unavailable";
  if (values.includes("not-attempted")) return "not-attempted";
  return "stable";
}

function statusForComparison(comparison: NativeHarnessHistoryRecoveryComparison): NativeHarnessHistoryRecoveryStatus {
  if (comparison === "stable") return "stable";
  if (comparison === "different") return "different";
  if (comparison === "not-attempted") return "not-observed";
  return "unavailable";
}

function countProbeRound(
  attempts: readonly NativeHarnessHistoryRecoveryAttemptSummaryInput[],
  round: 1 | 2,
): NativeHarnessHistoryRecoveryLifecycleFacts["currentGroups"]["round1"] {
  let present = 0;
  let notObserved = 0;
  let unknown = 0;
  let refused = 0;
  for (const attempt of attempts) {
    const fact = round === 1 ? attempt.group1 : attempt.group2;
    if (fact === null) continue;
    if (fact.refused) refused += 1;
    if (fact.presence === "present") present += 1;
    else if (fact.presence === "not-observed") notObserved += 1;
    else unknown += 1;
  }
  return Object.freeze({ present, notObserved, unknown, refused });
}

/**
 * Projects already-observed round facts into separate factual axes. No
 * allStopped/recoverable/eligible/authority boolean is produced. A final
 * primary refusal changes any provisional stable lifecycle presentation to
 * revoked while retaining bounded counters and per-attempt facts.
 */
export function projectNativeHarnessHistoryRecoveryLifecycle(
  input: NativeHarnessHistoryRecoveryProjectionInput,
): NativeHarnessHistoryRecoveryLifecycleFacts {
  const attemptComparisons = input.attempts.flatMap((attempt) => [
    attempt.workerComparison,
    attempt.groupComparison,
  ]);
  const controllerComparisons = [input.controller.ownerComparison, input.controller.probeComparison];
  const cancelComparison = input.cancel.comparison;
  const allComparisons = [...attemptComparisons, ...controllerComparisons, cancelComparison];
  let provisional: Exclude<NativeHarnessHistoryRecoveryStatus, "revoked">;
  let failure: NativeHarnessHistoryProcessReason | null = input.prerequisiteFailure;
  if (input.prerequisiteFailure !== null) {
    provisional = "unavailable";
  } else if (input.gate === "aborted") {
    provisional = "aborted";
    failure = processReason("lifecycle-aborted", "The host signal aborted the fixed lifecycle window.");
  } else if (input.gate === "deadline-expired" || input.window.expired) {
    provisional = "expired";
    failure = processReason("lifecycle-expired", "The fixed lifecycle window expired; no later phases were started.");
  } else if (input.derivationProblems.length !== 0) {
    provisional = "unavailable";
    failure = input.derivationProblems[0]!;
  } else if (allComparisons.includes("different")) {
    provisional = "different";
  } else if (input.window.roundsStarted < 2) {
    provisional = "unavailable";
    failure = processReason("lifecycle-rounds-incomplete", "Fewer than two lifecycle rounds were started.");
  } else if (
    allComparisons.includes("unavailable")
    || allComparisons.includes("not-attempted")
    || input.attempts.some((attempt) => attempt.coverage !== "complete")
  ) {
    provisional = "unavailable";
    failure = failure ?? processReason("lifecycle-coverage-incomplete", "One or more lifecycle facts were unavailable.");
  } else {
    provisional = "stable";
  }

  const primaryRefused = input.finalPrimaryStatus !== "stable";
  // Any control/time refusal after the lifecycle phase started is sticky for
  // presentation purposes even when the whole lifecycle was already
  // unavailable. Failures before the first round cannot leave a stable nested
  // presentation, so they are not "refusals" of observed facts.
  const controlRefused = input.gate !== null
    || (input.prerequisiteFailure !== null && input.window.roundsStarted > 0);
  const finalRefused = primaryRefused || controlRefused;
  const workerComparisons = input.attempts.map((attempt) => attempt.workerComparison);
  const groupComparisons = input.attempts.map((attempt) => attempt.groupComparison);
  const workerAuxComparison = comparisonOf(...workerComparisons);
  const groupsComparison = comparisonOf(...groupComparisons);
  const controllerComparison = comparisonOf(...controllerComparisons);
  const hadStablePresentation = provisional === "stable"
    || attemptComparisons.includes("stable")
    || workerAuxComparison === "stable"
    || groupsComparison === "stable"
    || controllerComparison === "stable"
    || cancelComparison === "stable";
  const revoked = finalRefused && hadStablePresentation;
  const status: NativeHarnessHistoryRecoveryStatus = primaryRefused && revoked ? "revoked" : provisional;
  const revokedReasons = revoked ? Object.freeze([...input.revokedReasons]) : Object.freeze([] as string[]);
  const presentedComparison = (comparison: NativeHarnessHistoryRecoveryComparison): NativeHarnessHistoryRecoveryComparison =>
    finalRefused && comparison === "stable" ? "revoked" : comparison;

  const attempts: NativeHarnessHistoryRecoveryAttemptProjection[] = input.attempts.map((attempt) =>
    Object.freeze({
      targetId: attempt.target.targetId,
      ordinal: attempt.target.ordinal,
      nonce: attempt.target.nonce,
      stage: attempt.target.stage,
      attempt: attempt.target.attempt,
      dispatchState: attempt.target.dispatchState,
      pid: attempt.target.pid,
      pgid: attempt.target.pgid,
      inventoryIdentitySha256: attempt.target.processIdentitySha256,
      historicalCleanup: attempt.target.historicalCleanup,
      worker: Object.freeze({
        round1: attempt.round1Worker,
        round2: attempt.round2Worker,
        comparison: presentedComparison(attempt.workerComparison),
        binding1: attempt.binding1,
        binding2: attempt.binding2,
      }),
      group: Object.freeze({
        round1: attempt.group1,
        round2: attempt.group2,
        comparison: presentedComparison(attempt.groupComparison),
      }),
      coverage: attempt.coverage,
    }),
  );

  const groupsStatus = statusForComparison(groupsComparison);
  const controllerMissingBoth = input.controller.lockDirectory1 === "missing"
    && input.controller.lockDirectory2 === "missing";
  const controllerStatus = input.controller.ownerComparison === "stable"
    && input.controller.round1Owner?.state === "missing"
    && input.controller.round2Owner?.state === "missing"
    ? "not-observed" as const
    : controllerMissingBoth
      ? "not-observed" as const
      : statusForComparison(controllerComparison);

  const round1Counts = countProbeRound(input.attempts, 1);
  const round2Counts = countProbeRound(input.attempts, 2);
  const anyPresence = round1Counts.present + round2Counts.present > 0;
  const allKnownAbsent = input.attempts.length > 0
    && input.attempts.every((attempt) =>
      attempt.target.pgid !== null
      && attempt.group1?.presence === "not-observed"
      && attempt.group2?.presence === "not-observed");
  const absenceObservation = input.attempts.every((attempt) => attempt.target.pgid === null)
    ? "not-applicable" as const
    : anyPresence
      ? "some-known-groups-present" as const
      : allKnownAbsent
        ? "all-known-groups-not-observed-in-both-rounds" as const
        : "unknown" as const;

  const historicalCounts = {
    recordedNoLaunch: 0,
    declaredCleanupObserved: 0,
    syntheticFixtureNotProof: 0,
    noCleanupRecorded: 0,
    unknown: 0,
  };
  for (const attempt of input.attempts) {
    switch (attempt.target.historicalCleanup.declaration) {
      case "recorded-no-launch": historicalCounts.recordedNoLaunch += 1; break;
      case "declared-cleanup-observed": historicalCounts.declaredCleanupObserved += 1; break;
      case "synthetic-fixture-not-proof": historicalCounts.syntheticFixtureNotProof += 1; break;
      case "no-cleanup-recorded": historicalCounts.noCleanupRecorded += 1; break;
      default: historicalCounts.unknown += 1; break;
    }
  }

  const completeAttempts = input.attempts.filter((attempt) => attempt.coverage === "complete").length;
  const zeroAttempts = input.attempts.length === 0;
  const coverageComplete = input.prerequisiteFailure === null
    && input.window.roundsStarted === 2
    && !allComparisons.includes("not-attempted")
    && completeAttempts === input.attempts.length;
  const completeAttemptCoverageStatus = input.prerequisiteFailure !== null
    ? "unavailable" as const
    : zeroAttempts
      // A valid empty inventory needs no attempt observation. This does not
      // stand in for controller/cancel coverage or for stopped-process proof.
      ? "not-required" as const
      : coverageComplete
        ? "complete" as const
        : "incomplete" as const;

  const stabilityStatus: NativeHarnessHistoryRecoveryStatus = revoked
    ? "revoked"
    : comparisonOf(workerAuxComparison, groupsComparison, controllerComparison, cancelComparison) === "stable"
      && coverageComplete
      ? "stable"
      : statusForComparison(comparisonOf(workerAuxComparison, groupsComparison, controllerComparison, cancelComparison));
  const stabilityReasons = Object.freeze([
    ...input.derivationProblems.map((problem) => problem.detail),
    ...(revoked ? input.revokedReasons : []),
  ]);

  return Object.freeze({
    status,
    provisionalStatus: provisional,
    revoked,
    revokedReasons,
    failure,
    rounds: 2 as const,
    coverage: Object.freeze({
      inventoryRows: input.inventoryRows,
      attemptTargets: input.attempts.length,
      workerOwnerTargets: input.attempts.filter((attempt) => attempt.target.workerOwner !== null).length,
      completeAttempts,
      auxAttemptsRound1: input.auxAttemptsRound1,
      auxAttemptsRound2: input.auxAttemptsRound2,
      auxChargedBytes: input.auxChargedBytes,
      auxChargeLimitBytes: 1_081_472 as const,
      auxTargetLimitPerRound: 34 as const,
      probesRound1: input.probesRound1,
      probesRound2: input.probesRound2,
      probeLimitPerRound: 33 as const,
      maxOpenedFiles: 1 as const,
    }),
    completeAttemptCoverage: Object.freeze({
      status: completeAttemptCoverageStatus,
      detail: completeAttemptCoverageStatus === "not-required"
        ? "No inventory attempts were recorded; the attempt axis is explicitly empty and controller/cancel axes remain separate."
        : completeAttemptCoverageStatus === "complete"
          ? "Every inventory attempt was targeted in both fixed rounds."
          : input.prerequisiteFailure?.detail
            ?? "One or more inventory attempts lacked a complete two-round observation.",
    }),
    attempts: Object.freeze(attempts),
    currentGroups: Object.freeze({
      status: finalRefused && groupsStatus === "stable" ? "revoked" as const : groupsStatus,
      round1: round1Counts,
      round2: round2Counts,
      absenceObservation,
      claim: "interval-observation-only-never-future-permission" as const,
    }),
    controllerLease: Object.freeze({
      status: finalRefused && controllerStatus === "stable" ? "revoked" as const : controllerStatus,
      lockDirectoryRound1: input.controller.lockDirectory1,
      lockDirectoryRound2: input.controller.lockDirectory2,
      ownerRound1: input.controller.round1Owner,
      ownerRound2: input.controller.round2Owner,
      ownerComparison: presentedComparison(input.controller.ownerComparison),
      probe1: input.controller.probe1,
      probe2: input.controller.probe2,
      probeComparison: presentedComparison(input.controller.probeComparison),
      ownerPid: input.controller.round1Owner?.ownerPid ?? null,
      claim: "lock-owner-declaration-and-interval-presence-only" as const,
    }),
    cancel: Object.freeze({
      status: input.cancel.status,
      round1: input.cancel.round1,
      round2: input.cancel.round2,
      comparison: presentedComparison(cancelComparison),
      claim: "existence-only-no-generation-or-clear" as const,
    }),
    historicalCleanup: Object.freeze({
      ...historicalCounts,
      claim: "declared-inventory-facts-not-fresh-os-proof" as const,
    }),
    observationStability: Object.freeze({
      status: stabilityStatus,
      workerAuxStable: finalRefused ? null : workerAuxComparison === "stable",
      groupsStable: finalRefused ? null : groupsComparison === "stable",
      controllerStable: finalRefused ? null : controllerComparison === "stable",
      cancelStable: finalRefused ? null : cancelComparison === "stable",
      reasons: stabilityReasons,
    }),
    window: Object.freeze({
      budgetMs: 5_000 as const,
      startedAt: input.window.startedAt,
      deadlineAt: input.window.deadlineAt,
      checkedAt: input.window.checkedAt,
      expired: input.window.expired,
      constrainedByRemaining30s: input.window.deadlineAt < input.window.globalDeadlineAt,
      roundsStarted: input.window.roundsStarted,
      soft: true as const,
    }),
  });
}

/* ------------------------------------------------------------------------- */
/* Owner declarations and reads                                              */
/* ------------------------------------------------------------------------- */

export type NativeHarnessHistoryProcessOwnerState =
  | "observed"
  | "missing"
  | "invalid"
  | "unavailable"
  | "budget-exhausted"
  | "not-attempted";

export interface NativeHarnessHistoryProcessWorkerDeclaration {
  readonly kind: "worker";
  readonly runId: string;
  readonly stage: string;
  readonly pid: number;
  readonly pgid: number;
  /** Internal marker material only; never projected. */
  readonly privateRuntimeRoot: string;
  readonly configMarker: string;
  readonly appendMarker: string;
  readonly startedAt: string;
}

export interface NativeHarnessHistoryProcessControllerDeclaration {
  readonly kind: "controller";
  readonly pid: number;
  /** Internal; never projected. */
  readonly token: string;
  readonly createdAt: string;
}

export type NativeHarnessHistoryProcessOwnerDeclaration =
  | NativeHarnessHistoryProcessWorkerDeclaration
  | NativeHarnessHistoryProcessControllerDeclaration;

export interface NativeHarnessHistoryProcessOwnerText {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
}

export interface NativeHarnessHistoryProcessOwnerRead {
  readonly targetId: string;
  readonly state: NativeHarnessHistoryProcessOwnerState;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly observedAt: number | null;
  readonly problem: NativeHarnessHistoryProcessReason | null;
  readonly declaration: NativeHarnessHistoryProcessOwnerDeclaration | null;
}

function baseOwnerRead(
  targetId: string,
  state: NativeHarnessHistoryProcessOwnerState,
  problem: NativeHarnessHistoryProcessReason | null,
  text: NativeHarnessHistoryProcessOwnerText | null,
): NativeHarnessHistoryProcessOwnerRead {
  return {
    targetId,
    state,
    bytes: text === null ? null : text.bytes,
    sha256: text === null ? null : text.sha256,
    observedAt: text === null ? null : text.observedAt,
    problem,
    declaration: null,
  };
}

export function ownerReadWithoutIo(
  target: NativeHarnessHistoryProcessTarget,
  state: "budget-exhausted" | "not-attempted",
  detail: string,
): NativeHarnessHistoryProcessOwnerRead {
  return baseOwnerRead(
    target.targetId,
    state,
    processReason(state === "budget-exhausted" ? "owner-read-budget-exhausted" : "owner-read-not-attempted", detail),
    null,
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => keys.includes(key));
}

function boundedLabel(value: unknown, maxChars: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxChars
    && !CONTROL_PATTERN.test(value);
}

function decodeWorkerDeclaration(
  value: Record<string, unknown>,
  target: NativeHarnessHistoryProcessTarget,
  runId: string,
): NativeHarnessHistoryProcessWorkerDeclaration | NativeHarnessHistoryProcessReason {
  if (!exactKeys(value, ["schemaVersion", "runId", "stage", "pid", "pgid", "privateRuntimeRoot", "startedAt"])) {
    return processReason("owner-shape", "The worker owner record has missing or unknown fields.");
  }
  if (value.schemaVersion !== 1) {
    return processReason("owner-schema", "The worker owner schemaVersion is not the supported value 1.");
  }
  if (value.runId !== runId || value.stage !== target.stage) {
    return processReason(
      "owner-target-mismatch",
      "The worker owner run/stage does not match the selected run and current recorded stage.",
    );
  }
  if (!isPositiveSafeInteger(value.pid) || !isPositiveSafeInteger(value.pgid)) {
    return processReason("owner-pid", "The worker owner PID/PGID is not a positive safe integer.");
  }
  if (!isCanonicalAbsolutePath(value.privateRuntimeRoot)
    || !path.basename(value.privateRuntimeRoot).startsWith("omp-harness2-worker-")) {
    return processReason(
      "owner-runtime-root",
      "The worker owner private runtime root is not a bounded absolute worker runtime path.",
    );
  }
  if (typeof value.startedAt !== "string" || !ISO_TIMESTAMP_PATTERN.test(value.startedAt)) {
    return processReason("owner-started-at", "The worker owner startedAt is not a bounded ISO timestamp.");
  }
  return Object.freeze({
    kind: "worker" as const,
    runId,
    stage: target.stage as string,
    pid: value.pid,
    pgid: value.pgid,
    privateRuntimeRoot: value.privateRuntimeRoot,
    configMarker: `${value.privateRuntimeRoot}/config.yml`,
    appendMarker: `${value.privateRuntimeRoot}/harness.txt`,
    startedAt: value.startedAt,
  });
}

function decodeControllerDeclaration(
  value: Record<string, unknown>,
): NativeHarnessHistoryProcessControllerDeclaration | NativeHarnessHistoryProcessReason {
  if (!exactKeys(value, ["pid", "token", "createdAt"])) {
    return processReason("owner-shape", "The controller lock owner has missing or unknown fields.");
  }
  if (!isPositiveSafeInteger(value.pid)) {
    return processReason("owner-pid", "The controller lock PID is not a positive safe integer.");
  }
  if (!boundedLabel(value.token, 256)) {
    return processReason("owner-token", "The controller lock token is not bounded text.");
  }
  if (typeof value.createdAt !== "string" || !ISO_TIMESTAMP_PATTERN.test(value.createdAt)) {
    return processReason("owner-created-at", "The controller lock createdAt is not a bounded ISO timestamp.");
  }
  return Object.freeze({
    kind: "controller" as const,
    pid: value.pid,
    token: value.token,
    createdAt: value.createdAt,
  });
}

/**
 * Strictly decodes one owner text already read through the core's pinned path.
 * Oversize here is a decode cap, not a claim about the FS read size.
 */
export function decodeNativeHarnessHistoryProcessOwner(
  target: NativeHarnessHistoryProcessTarget,
  runId: string,
  text: NativeHarnessHistoryProcessOwnerText,
): NativeHarnessHistoryProcessOwnerRead {
  if (Buffer.byteLength(text.text, "utf8") > NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.ownerDecodeBytes) {
    return baseOwnerRead(
      target.targetId,
      "invalid",
      processReason(
        "owner-decode-oversized",
        `The owner JSON exceeds the ${NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.ownerDecodeBytes}-byte decode cap; the FS read may have returned more bytes.`,
      ),
      text,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return baseOwnerRead(
      target.targetId,
      "invalid",
      processReason("owner-json", "The owner record is not valid JSON."),
      text,
    );
  }
  if (!plainObject(parsed)) {
    return baseOwnerRead(
      target.targetId,
      "invalid",
      processReason("owner-shape", "The owner record is not a JSON object."),
      text,
    );
  }
  const decoded = target.kind === "controller"
    ? decodeControllerDeclaration(parsed)
    : decodeWorkerDeclaration(parsed, target, runId);
  if ("code" in decoded) {
    return baseOwnerRead(target.targetId, "invalid", decoded, text);
  }
  return {
    targetId: target.targetId,
    state: "observed",
    bytes: text.bytes,
    sha256: text.sha256,
    observedAt: text.observedAt,
    problem: null,
    declaration: decoded,
  };
}

/* ------------------------------------------------------------------------- */
/* OS observation types                                                      */
/* ------------------------------------------------------------------------- */

export type NativeHarnessHistoryProcessPresence = "present" | "not-observed" | "unknown";
export type NativeHarnessHistoryProcessIdentity =
  | "runtime-marker-consistent"
  | "mismatch"
  | "unknown";
export type NativeHarnessHistoryProcessState = "zombie" | "other" | "unknown";
export type NativeHarnessHistoryProcessPgidComparison = "match" | "mismatch" | "unknown";
export type NativeHarnessHistoryProcessMarkerComparison = "consistent" | "mismatch" | "unknown";

export interface NativeHarnessHistoryProcessOsRow {
  readonly pid: number;
  readonly pgid: number;
  readonly stat: string;
  readonly startedAt: string;
  /** Bounded by the stdout cap; internal marker material, never projected. */
  readonly command: string;
}

export type NativeHarnessHistoryProcessOsCause =
  | "unsupported-platform"
  | "invalid-pid-list"
  | "spawn-error"
  | "exit-status"
  | "stderr"
  | "malformed-output"
  | "unexpected-pid"
  | "duplicate-pid"
  | "empty-output"
  | "truncated-stdout"
  | "truncated-stderr"
  | "timeout"
  | "aborted"
  | "child-error"
  | "cleanup-unknown"
  | "observer-failure";

export interface NativeHarnessHistoryProcessOsObservation {
  readonly state: "completed" | "not-observed" | "unknown";
  readonly cause: NativeHarnessHistoryProcessOsCause | null;
  readonly rows: readonly NativeHarnessHistoryProcessOsRow[];
  /** Wall-clock observation time; null when no trustworthy query settled. */
  readonly observedAt: number | null;
  readonly queryStarted: boolean;
  readonly cleanup: "not-needed" | "settled" | "unknown";
  readonly problem: NativeHarnessHistoryProcessReason | null;
}

export interface NativeHarnessHistoryProcessOsObserver {
  readonly platform: "darwin" | "unsupported";
  /**
   * Exactly one bounded batch observation over the finite selected PID list.
   * Implementations must never signal, inspect or clean up an owner PID.
   */
  observePids(
    pids: readonly number[],
    signal: AbortSignal,
  ): Promise<NativeHarnessHistoryProcessOsObservation>;
}

/* ------------------------------------------------------------------------- */
/* Fixed Darwin `/bin/ps` adapter                                            */
/* ------------------------------------------------------------------------- */

const PS_PROGRAM = "/bin/ps";
const PS_FIELDS = "pid=,pgid=,stat=,lstart=,command=";
const PS_ENV = Object.freeze({
  LC_ALL: "C",
  LANG: "C",
  PATH: "/usr/bin:/bin",
});

/** Narrow child surface used by the fixed adapter and its finite fake port. */
export interface NativeHarnessHistoryProcessChildStream {
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  destroy(): void;
}

export interface NativeHarnessHistoryProcessChild {
  /** Undefined when the runtime did not actually start a child process. */
  readonly pid?: number | undefined;
  readonly stdout: NativeHarnessHistoryProcessChildStream | null;
  readonly stderr: NativeHarnessHistoryProcessChildStream | null;
  once(event: "error", listener: (error: unknown) => void): void;
  once(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  kill(signal: "SIGKILL"): boolean;
  unref(): void;
}

export interface NativeHarnessHistoryProcessSpawnOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly shell: false;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}

export type NativeHarnessHistoryProcessSpawn = (
  command: string,
  args: readonly string[],
  options: NativeHarnessHistoryProcessSpawnOptions,
) => NativeHarnessHistoryProcessChild;

export interface NativeHarnessHistoryProcessAdapterOptions {
  /** Test seam only; production always uses the fixed `/bin/ps` spawn. */
  readonly spawn?: NativeHarnessHistoryProcessSpawn;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  /** Test seam may lower, never raise, the fixed operation budget. */
  readonly budgetMs?: number;
  /** Test seam may lower, never raise, the fixed cleanup budget. */
  readonly cleanupMs?: number;
}

const DEFAULT_SPAWN: NativeHarnessHistoryProcessSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], {
    env: options.env as Record<string, string>,
    cwd: options.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  }) as NativeHarnessHistoryProcessChild;

function observedTime(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Date.now();
  } catch {
    return Date.now();
  }
}

function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function unknownOs(
  cause: NativeHarnessHistoryProcessOsCause,
  detail: string,
  extras: {
    readonly queryStarted?: boolean;
    readonly cleanup?: "not-needed" | "settled" | "unknown";
  } = {},
): NativeHarnessHistoryProcessOsObservation {
  return Object.freeze({
    state: "unknown" as const,
    cause,
    rows: Object.freeze([]),
    observedAt: null,
    queryStarted: extras.queryStarted ?? false,
    cleanup: extras.cleanup ?? "not-needed",
    problem: processReason(`os-${cause}`, detail),
  });
}

export interface NativeHarnessHistoryProcessPsParseFailure {
  readonly code: "malformed-output" | "unexpected-pid" | "duplicate-pid";
  readonly detail: string;
}

export type NativeHarnessHistoryProcessPsParse =
  | { readonly ok: true; readonly rows: readonly NativeHarnessHistoryProcessOsRow[] }
  | { readonly ok: false; readonly problem: NativeHarnessHistoryProcessPsParseFailure };

/**
 * Pure parser for the fixed `pid=,pgid=,stat=,lstart=,command=` output.
 * Duplicate or unrequested PIDs are parse failures, never absent rows.
 */
export function parseDarwinPsOutput(
  text: string,
  requestedPids: readonly number[],
): NativeHarnessHistoryProcessPsParse {
  const requested = new Set(requestedPids);
  const seen = new Set<number>();
  const rows: NativeHarnessHistoryProcessOsRow[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/.exec(line);
    if (match === null) {
      return {
        ok: false,
        problem: { code: "malformed-output", detail: "A ps row does not match the fixed bounded column layout." },
      };
    }
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const stat = match[3] as string;
    const startedAt = (match[4] as string).replace(/\s+/g, " ");
    const command = match[5] as string;
    if (!isPositiveSafeInteger(pid) || !isPositiveSafeInteger(pgid)
      || stat.length === 0
      || stat.length > NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.statChars
      || !/^[A-Za-z][A-Za-z0-9+<*.-]*$/.test(stat)
      || !LSTART_PATTERN.test(startedAt)) {
      return {
        ok: false,
        problem: { code: "malformed-output", detail: "A ps row has an invalid PID, PGID, stat or start time." },
      };
    }
    if (!requested.has(pid)) {
      return {
        ok: false,
        problem: { code: "unexpected-pid", detail: "The ps output contained a PID that was not requested." },
      };
    }
    if (seen.has(pid)) {
      return {
        ok: false,
        problem: { code: "duplicate-pid", detail: "The ps output contained a duplicate requested PID." },
      };
    }
    seen.add(pid);
    rows.push(Object.freeze({ pid, pgid, stat, startedAt, command }));
  }
  return { ok: true, rows: Object.freeze(rows) };
}

export interface NativeHarnessHistoryProcessPsCompletion {
  readonly requestedPids: readonly number[];
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** Set only when the runtime did not start a child process at all. */
  readonly spawnError: string | null;
  /** Set when an already-started child reported an error event. */
  readonly childError: string | null;
  readonly queryStarted: boolean;
  readonly cleanup: "settled" | "unknown";
  readonly observedAt: number;
}

/**
 * Pure completion classification. Only exit 1 with empty stdout/stderr is
 * absence. Every other non-zero/unknown condition is unknown, never stopped.
 */
export function classifyDarwinPsCompletion(
  input: NativeHarnessHistoryProcessPsCompletion,
): NativeHarnessHistoryProcessOsObservation {
  const base = {
    queryStarted: input.queryStarted,
    cleanup: input.cleanup,
  } as const;
  if (input.spawnError !== null) {
    return unknownOs("spawn-error", "The fixed ps subprocess could not be started.", { queryStarted: false, cleanup: "not-needed" });
  }
  if (!input.queryStarted) {
    return unknownOs(
      "spawn-error",
      "The fixed ps subprocess did not report a started child PID.",
      { queryStarted: false, cleanup: input.cleanup },
    );
  }
  if (input.aborted) {
    return unknownOs("aborted", "The host signal aborted the fixed ps query.", base);
  }
  if (input.timedOut) {
    return unknownOs("timeout", "The fixed ps query exceeded its bounded operation budget.", base);
  }
  if (input.childError !== null) {
    return unknownOs("child-error", "The fixed ps child reported an error after it started.", base);
  }
  if (input.stdoutTruncated) {
    return unknownOs("truncated-stdout", "The ps stdout exceeded the fixed bounded profile.", base);
  }
  if (input.stderrTruncated) {
    return unknownOs("truncated-stderr", "The ps stderr exceeded the fixed bounded profile.", base);
  }
  if (input.cleanup !== "settled") {
    return unknownOs("cleanup-unknown", "The fixed ps subprocess cleanup could not be confirmed within budget.", base);
  }
  const hasStdout = input.stdout.trim() !== "";
  const hasStderr = input.stderr.length > 0;
  if (input.exitSignal !== null) {
    return unknownOs("exit-status", "The fixed ps subprocess ended by signal, not a bounded exit status.", base);
  }
  if (input.exitCode === 0) {
    if (hasStderr) {
      return unknownOs("stderr", "The fixed ps query wrote stderr output.", base);
    }
    if (!hasStdout) {
      return unknownOs("empty-output", "The fixed ps query exited 0 without any bounded row.", base);
    }
    const parsed = parseDarwinPsOutput(input.stdout, input.requestedPids);
    if (!parsed.ok) {
      return unknownOs(parsed.problem.code, parsed.problem.detail, base);
    }
    return Object.freeze({
      state: "completed" as const,
      cause: null,
      rows: parsed.rows,
      observedAt: input.observedAt,
      queryStarted: true,
      cleanup: input.cleanup,
      problem: null,
    });
  }
  if (input.exitCode === 1) {
    if (!hasStdout && !hasStderr) {
      return Object.freeze({
        state: "not-observed" as const,
        cause: null,
        rows: Object.freeze([]),
        observedAt: input.observedAt,
        queryStarted: true,
        cleanup: input.cleanup,
        problem: null,
      });
    }
    return unknownOs(
      hasStderr ? "stderr" : "exit-status",
      "The fixed ps query exited 1 with output; this is unknown, not an absent process.",
      base,
    );
  }
  return unknownOs(
    "exit-status",
    "The fixed ps query returned an unexpected exit status.",
    base,
  );
}

function clampBudget(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(fallback, Math.floor(value)));
}

/**
 * Creates the one stateless Darwin observer. Construction performs no I/O and
 * starts no process. On non-Darwin hosts it returns a bounded unsupported
 * unknown without spawning anything.
 */
export function createDarwinHistoryProcessObserver(
  options: NativeHarnessHistoryProcessAdapterOptions = {},
): NativeHarnessHistoryProcessOsObserver {
  const platform: "darwin" | "unsupported" = (options.platform ?? process.platform) === "darwin"
    ? "darwin"
    : "unsupported";
  const spawn = options.spawn ?? DEFAULT_SPAWN;
  const now = options.now ?? Date.now;
  const budgetMs = clampBudget(options.budgetMs, NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.osBudgetMs);
  const cleanupMs = clampBudget(options.cleanupMs, NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.osCleanupMs);
  return Object.freeze({
    platform,
    async observePids(pids: readonly number[], signal: AbortSignal): Promise<NativeHarnessHistoryProcessOsObservation> {
      if (platform !== "darwin") {
        return unknownOs("unsupported-platform", "Bounded OS observation is implemented only for Darwin.");
      }
      const unique: number[] = [];
      const seen = new Set<number>();
      for (const pid of pids) {
        if (!isPositiveSafeInteger(pid) || seen.has(pid)) {
          return unknownOs("invalid-pid-list", "The selected PID list is not a bounded set of positive integers.");
        }
        if (unique.length >= NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.maxPids) {
          return unknownOs("invalid-pid-list", `At most ${NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.maxPids} PIDs may be queried.`);
        }
        seen.add(pid);
        unique.push(pid);
      }
      if (unique.length === 0) {
        return unknownOs("invalid-pid-list", "An OS query requires at least one selected PID.");
      }
      const signalRead = readActualAbortSignal(signal);
      if (!signalRead.ok || signalRead.aborted) {
        return unknownOs("aborted", "The host signal was not an actual un-aborted AbortSignal.");
      }

      const startedMono = monotonicMs();
      const operationDeadline = startedMono + budgetMs;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let aborted = false;
      let spawnFailed = false;
      let childError: string | null = null;
      let settled = false;
      let closed = false;
      let closeCode: number | null = null;
      let closeSignal: string | null = null;
      let killRequested = false;
      let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
      let mainTimer: ReturnType<typeof setTimeout> | null = null;

      let child: NativeHarnessHistoryProcessChild | null = null;
      try {
        child = spawn(
          PS_PROGRAM,
          ["-p", unique.join(","), "-o", PS_FIELDS],
          {
            env: PS_ENV,
            cwd: "/",
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch {
        return unknownOs("spawn-error", "The fixed ps subprocess could not be started.", { queryStarted: false });
      }
      const actualChild = child;
      const queryStarted = actualChild.pid !== undefined;

      return await new Promise<NativeHarnessHistoryProcessOsObservation>((resolve) => {
        let removeAbortListener: (() => void) | null = null;
        const cleanup = (): void => {
          if (mainTimer !== null) clearTimeout(mainTimer);
          if (cleanupTimer !== null) clearTimeout(cleanupTimer);
          if (removeAbortListener !== null) {
            removeAbortListener();
            removeAbortListener = null;
          }
        };
        const destroyStreams = (): void => {
          try { actualChild.stdout?.destroy(); } catch { /* bounded cleanup */ }
          try { actualChild.stderr?.destroy(); } catch { /* bounded cleanup */ }
        };
        const finalize = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (!closed) {
            try { actualChild.unref(); } catch { /* best effort */ }
          }
          destroyStreams();
          const observedAt = observedTime(now);
          const completion = classifyDarwinPsCompletion({
            requestedPids: unique,
            exitCode: closeCode,
            exitSignal: closeSignal,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            stdoutTruncated,
            stderrTruncated,
            timedOut,
            aborted,
            spawnError: spawnFailed ? "spawn-failed" : null,
            childError,
            queryStarted,
            cleanup: closed ? "settled" : "unknown",
            observedAt,
          });
          resolve(Object.freeze({
            ...completion,
            cleanup: closed || !queryStarted ? completion.cleanup : "unknown",
          }));
        };
        const requestKill = (): void => {
          if (settled || killRequested) return;
          killRequested = true;
          try { actualChild.kill("SIGKILL"); } catch { /* cleanup is reported unknown below */ }
          const remaining = operationDeadline - monotonicMs();
          const wait = Math.max(0, Math.min(cleanupMs, remaining));
          if (closed) {
            finalize();
            return;
          }
          if (wait <= 0) {
            finalize();
            return;
          }
          cleanupTimer = setTimeout(() => {
            finalize();
          }, wait);
        };
        // The main query may use only the time before the reserved cleanup
        // window. Spawn elapsed time is already excluded from this delay.
        const mainWorkDeadline = operationDeadline - cleanupMs;
        const mainWorkMs = Math.max(1, Math.min(budgetMs, mainWorkDeadline - monotonicMs()));
        mainTimer = setTimeout(() => {
          timedOut = true;
          requestKill();
        }, mainWorkMs);
        actualChild.stdout?.on("data", (chunk) => {
          if (stdoutTruncated) return;
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.psStdoutBytes) {
            stdoutTruncated = true;
            stdoutChunks.length = 0;
            requestKill();
            return;
          }
          stdoutChunks.push(Buffer.from(chunk));
        });
        actualChild.stderr?.on("data", (chunk) => {
          if (stderrTruncated) return;
          stderrBytes += chunk.byteLength;
          if (stderrBytes > NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.psStderrBytes) {
            stderrTruncated = true;
            stderrChunks.length = 0;
            requestKill();
            return;
          }
          stderrChunks.push(Buffer.from(chunk));
        });
        actualChild.stdout?.on("error", () => {
          stdoutTruncated = true;
          requestKill();
        });
        actualChild.stderr?.on("error", () => {
          stderrTruncated = true;
          requestKill();
        });
        actualChild.once("error", () => {
          if (!queryStarted) {
            spawnFailed = true;
            finalize();
            return;
          }
          childError = "subprocess-error";
          requestKill();
        });
        actualChild.once("close", (code, signal) => {
          closed = true;
          closeCode = code;
          closeSignal = signal;
          finalize();
        });
        const abortListener = (): void => {
          aborted = true;
          requestKill();
        };
        signal.addEventListener("abort", abortListener, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abortListener);
        // The signal may have aborted inside spawn, before this listener
        // existed, and an own `aborted` property can shadow the native state.
        const registeredRead = readActualAbortSignal(signal);
        if (!registeredRead.ok || registeredRead.aborted) {
          abortListener();
        }
      });
    },
  });
}

/**
 * Legacy-compatible uninspected projection. Kept in this leaf so the history
 * core and this module cannot drift on the exact old shape.
 */
export interface NativeHarnessHistoryProcessEntry {
  readonly state: "unknown";
  readonly coverage: "unknown";
  readonly observedAt: null;
  readonly source: "not-inspected-in-r1a";
}

export interface NativeHarnessHistoryProcessUninspectedObservation {
  readonly inspected: false;
  readonly controller: NativeHarnessHistoryProcessEntry;
  readonly workers: NativeHarnessHistoryProcessEntry;
  readonly limitations: readonly string[];
}

export interface NativeHarnessHistoryProcessOwnerProjection {
  readonly state: NativeHarnessHistoryProcessOwnerState;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly observedAt: number | null;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly basis: "worker-declaration" | "lock-claim" | null;
  readonly problem: NativeHarnessHistoryProcessReason | null;
}

export interface NativeHarnessHistoryProcessOsFacts {
  readonly presence: NativeHarnessHistoryProcessPresence;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly stat: string | null;
  readonly processState: NativeHarnessHistoryProcessState;
  readonly startedAt: string | null;
  readonly observedAt: number | null;
  readonly pgidComparison: NativeHarnessHistoryProcessPgidComparison;
  readonly markerComparison: NativeHarnessHistoryProcessMarkerComparison;
  readonly problem: NativeHarnessHistoryProcessReason | null;
}

export interface NativeHarnessHistoryProcessRow {
  readonly target: "controller" | "stage";
  readonly stage: string | null;
  readonly attempt: number | null;
  readonly recordedStatus: "running" | "completed" | "failed" | null;
  readonly owner: NativeHarnessHistoryProcessOwnerProjection;
  readonly os: NativeHarnessHistoryProcessOsFacts;
  readonly identity: NativeHarnessHistoryProcessIdentity;
}

export interface NativeHarnessHistoryProcessControllerSummary {
  /** Never an ownership or stopped boolean. */
  readonly state: "unknown";
  readonly coverage: "controller-lock-only";
  readonly presence: NativeHarnessHistoryProcessPresence;
  readonly owner: NativeHarnessHistoryProcessOwnerProjection;
  readonly os: NativeHarnessHistoryProcessOsFacts;
  readonly identity: NativeHarnessHistoryProcessIdentity;
}

export interface NativeHarnessHistoryProcessWorkerCounts {
  readonly targeted: number;
  readonly present: number;
  readonly notObserved: number;
  readonly unknown: number;
  readonly zombies: number;
  readonly markerConsistent: number;
  readonly markerMismatch: number;
}

export interface NativeHarnessHistoryProcessWorkersSummary {
  /** Never an all-workers or stopped boolean. */
  readonly state: "unknown";
  readonly coverage: "current-recorded-attempts-only";
  readonly rows: readonly NativeHarnessHistoryProcessRow[];
  readonly counts: NativeHarnessHistoryProcessWorkerCounts;
  readonly groupCoverage: "not-inspected";
  readonly historicalAttempts: "incomplete";
}

export interface NativeHarnessHistoryProcessOsInspection {
  /** True only when the fixed OS subprocess was actually started. */
  readonly executed: boolean;
  readonly state: "completed" | "not-observed" | "limited-unknown" | "not-run" | "unsupported" | "aborted";
  readonly requestedPids: number;
  readonly observedPids: number;
  readonly cleanup: "not-needed" | "settled" | "unknown";
  readonly observedAt: number | null;
  readonly problem: NativeHarnessHistoryProcessReason | null;
}

export interface NativeHarnessHistoryProcessSummary {
  readonly ownerReads: {
    readonly attempted: number;
    readonly observed: number;
    readonly failed: number;
    readonly notAttempted: number;
  };
  readonly osQueries: 0 | 1;
  readonly presence: {
    readonly present: number;
    readonly notObserved: number;
    readonly unknown: number;
  };
  /** No process, group or original-worker stopped proof is established. */
  readonly stopProof: "not-established";
}

export interface NativeHarnessHistoryProcessLimitedObservation {
  readonly inspected: true;
  readonly platform: "darwin" | "unsupported";
  readonly controller: NativeHarnessHistoryProcessControllerSummary;
  readonly workers: NativeHarnessHistoryProcessWorkersSummary;
  readonly coverage: {
    readonly basis: "current-recorded-attempts-only";
    readonly group: "not-inspected";
    readonly historicalAttempts: "incomplete";
  };
  readonly osInspection: NativeHarnessHistoryProcessOsInspection;
  readonly summary: NativeHarnessHistoryProcessSummary;
  /** Null when no OS query executed; never invented for unobserved rows. */
  readonly observedAt: number | null;
  readonly limitations: readonly string[];
}

export type NativeHarnessHistoryProcessObservation =
  | NativeHarnessHistoryProcessUninspectedObservation
  | NativeHarnessHistoryProcessLimitedObservation;

export function uninspectedProcessObservation(): NativeHarnessHistoryProcessUninspectedObservation {
  const entry: NativeHarnessHistoryProcessEntry = {
    state: "unknown",
    coverage: "unknown",
    observedAt: null,
    source: "not-inspected-in-r1a",
  };
  return {
    inspected: false,
    controller: entry,
    workers: entry,
    limitations: [
      "No OS process or signal observation was performed in R1a.",
      "A recorded run status is not a current controller or worker state.",
      "Missing owner/lock metadata would not prove that any process stopped.",
    ],
  };
}

/* ------------------------------------------------------------------------- */
/* Collection and bounded projection                                         */
/* ------------------------------------------------------------------------- */

export type NativeHarnessHistoryProcessOsSkip =
  | "no-owner-pid"
  | "unsupported-platform"
  | "root-changed"
  | "aborted"
  | "budget-exhausted";

export interface NativeHarnessHistoryProcessCollection {
  readonly observation: NativeHarnessHistoryProcessLimitedObservation;
  readonly rootCurrentAfterQuery: boolean;
}

function ownerProjection(read: NativeHarnessHistoryProcessOwnerRead): NativeHarnessHistoryProcessOwnerProjection {
  const declaration = read.declaration;
  return {
    state: read.state,
    bytes: read.bytes,
    sha256: read.sha256,
    observedAt: read.observedAt,
    pid: declaration === null ? null : declaration.pid,
    pgid: declaration === null || declaration.kind === "controller" ? null : declaration.pgid,
    basis: declaration === null
      ? null
      : declaration.kind === "controller" ? "lock-claim" : "worker-declaration",
    problem: read.problem,
  };
}

function osFactsFor(
  target: NativeHarnessHistoryProcessTarget,
  read: NativeHarnessHistoryProcessOwnerRead,
  os: NativeHarnessHistoryProcessOsObservation | null,
  osSkip: NativeHarnessHistoryProcessOsSkip | null,
): NativeHarnessHistoryProcessOsFacts {
  const declaration = read.declaration;
  const expectedPid = declaration === null ? null : declaration.pid;
  const expectedPgid = declaration === null || declaration.kind === "controller" ? null : declaration.pgid;
  let osRow: NativeHarnessHistoryProcessOsRow | null = null;
  if (os !== null && os.state === "completed" && expectedPid !== null) {
    osRow = os.rows.find((row) => row.pid === expectedPid) ?? null;
  }
  let presence: NativeHarnessHistoryProcessPresence;
  if (expectedPid === null) {
    presence = "unknown";
  } else if (os === null) {
    presence = "unknown";
  } else if (os.state === "completed") {
    presence = osRow === null ? "not-observed" : "present";
  } else if (os.state === "not-observed") {
    presence = "not-observed";
  } else {
    presence = "unknown";
  }
  const processState: NativeHarnessHistoryProcessState = osRow === null
    ? "unknown"
    : osRow.stat.startsWith("Z") ? "zombie" : "other";
  const pgidComparison: NativeHarnessHistoryProcessPgidComparison = osRow === null || expectedPgid === null
    ? "unknown"
    : osRow.pgid === expectedPgid ? "match" : "mismatch";
  let markerComparison: NativeHarnessHistoryProcessMarkerComparison = "unknown";
  if (osRow !== null && declaration !== null && declaration.kind === "worker") {
    if (osRow.command.trim() === "") {
      markerComparison = "unknown";
    } else {
      markerComparison = osRow.command.includes(declaration.configMarker)
        && osRow.command.includes(declaration.appendMarker)
        ? "consistent"
        : "mismatch";
    }
  }
  let identity: NativeHarnessHistoryProcessIdentity = "unknown";
  if (presence === "present" && processState !== "zombie") {
    if (target.kind === "stage") {
      if (pgidComparison === "mismatch" || markerComparison === "mismatch") {
        identity = "mismatch";
      } else if (pgidComparison === "match" && markerComparison === "consistent") {
        identity = "runtime-marker-consistent";
      }
    }
    // The controller lock has no original birth marker: ownership stays unknown.
  }
  let problem: NativeHarnessHistoryProcessReason | null = null;
  if (os === null) {
    problem = osSkip === "no-owner-pid"
      ? processReason("os-no-owner-pid", "No validated owner PID was available for an OS query.")
      : osSkip === "unsupported-platform"
        ? processReason("os-unsupported", "Bounded OS observation is unsupported on this platform.")
        : osSkip === "aborted"
          ? processReason("os-not-run-aborted", "The OS query was not started because the host signal aborted.")
          : osSkip === "root-changed"
            ? processReason("os-not-run-root-changed", "The OS query was not started because the pinned storage root changed.")
            : osSkip === "budget-exhausted"
              ? processReason("os-not-run-budget", "The OS query was not started after owner-read budget exhaustion.")
              : null;
  } else if (os.state === "unknown") {
    problem = os.problem;
  } else if (presence === "not-observed") {
    problem = processReason(
      "os-not-observed",
      "The requested PID was not present in this bounded OS observation; this does not prove the group or original worker stopped.",
    );
  }
  return {
    presence,
    pid: osRow === null ? null : osRow.pid,
    pgid: osRow === null ? null : osRow.pgid,
    stat: osRow === null ? null : osRow.stat,
    processState,
    startedAt: osRow === null ? null : osRow.startedAt,
    observedAt: osRow === null ? null : os?.observedAt ?? null,
    pgidComparison,
    markerComparison,
    problem,
  };
}

/**
 * Collects at most one owner read per derived target followed by at most one
 * batch OS query. The caller owns every FS reservation/settle and root gate;
 * this function only sequences the finite allowlist and never retains the
 * read closure after it returns.
 */
export async function collectNativeHarnessHistoryProcess(
  input: {
    readonly targets: NativeHarnessHistoryProcessTargets;
    readonly readOwner: (
      target: NativeHarnessHistoryProcessTarget,
    ) => Promise<NativeHarnessHistoryProcessOwnerRead>;
    readonly osObserver: NativeHarnessHistoryProcessOsObserver;
    readonly signal: AbortSignal;
    readonly isRootCurrent: () => Promise<boolean>;
    readonly isAborted: () => boolean;
  },
): Promise<NativeHarnessHistoryProcessCollection> {
  const ordered: NativeHarnessHistoryProcessTarget[] = [];
  for (const row of input.targets.stages) {
    if (row.target !== null) ordered.push(row.target);
  }
  const reads: NativeHarnessHistoryProcessOwnerRead[] = [];
  let skip: NativeHarnessHistoryProcessOsSkip | null = null;
  let stop = false;
  const readOne = async (target: NativeHarnessHistoryProcessTarget): Promise<void> => {
    if (stop) {
      reads.push(ownerReadWithoutIo(target, "not-attempted", "No owner read was started after an earlier stop condition."));
      return;
    }
    if (input.isAborted()) {
      stop = true;
      skip = "aborted";
      reads.push(ownerReadWithoutIo(target, "not-attempted", "The host signal aborted before this owner read."));
      return;
    }
    const read = await input.readOwner(target);
    reads.push(read);
    if (read.state === "budget-exhausted") {
      stop = true;
      skip = "budget-exhausted";
      return;
    }
    if (!(await input.isRootCurrent())) {
      stop = true;
      skip = "root-changed";
      return;
    }
    if (input.isAborted()) {
      stop = true;
      skip = "aborted";
    }
  };
  await readOne(input.targets.controller);
  for (const target of ordered) await readOne(target);

  const byTarget = new Map<string, NativeHarnessHistoryProcessOwnerRead>();
  for (const read of reads) byTarget.set(read.targetId, read);
  const readFor = (target: NativeHarnessHistoryProcessTarget): NativeHarnessHistoryProcessOwnerRead =>
    byTarget.get(target.targetId)
    ?? ownerReadWithoutIo(target, "not-attempted", "No owner read result was recorded for this target.");

  const selectedPids: number[] = [];
  const selected = new Set<number>();
  for (const target of [input.targets.controller, ...ordered]) {
    const read = readFor(target);
    if (read.declaration === null) continue;
    if (!selected.has(read.declaration.pid)) {
      selected.add(read.declaration.pid);
      selectedPids.push(read.declaration.pid);
    }
  }

  let os: NativeHarnessHistoryProcessOsObservation | null = null;
  if (skip === null) {
    if (selectedPids.length === 0) {
      skip = "no-owner-pid";
    } else if (input.osObserver.platform !== "darwin") {
      skip = "unsupported-platform";
    } else if (input.isAborted()) {
      skip = "aborted";
    } else {
      try {
        os = await input.osObserver.observePids(selectedPids, input.signal);
      } catch {
        os = unknownOs("observer-failure", "The bounded OS observer failed without a usable result.");
      }
      if (os.state === "unknown" && os.cause === "aborted") skip = "aborted";
    }
  }

  const rootCurrentAfterQuery = await input.isRootCurrent();
  const skipped: NativeHarnessHistoryProcessOsSkip | null = os === null ? skip : null;
  const controllerRead = readFor(input.targets.controller);
  const controllerOs = osFactsFor(input.targets.controller, controllerRead, os, skipped);
  const controllerOwner = ownerProjection(controllerRead);

  const stageRows: NativeHarnessHistoryProcessRow[] = [];
  const stageCounts = {
    targeted: 0,
    present: 0,
    notObserved: 0,
    unknown: 0,
    zombies: 0,
    markerConsistent: 0,
    markerMismatch: 0,
  };
  for (const row of input.targets.stages) {
    const target = row.target;
    if (target === null) continue;
    const read = readFor(target);
    const owner = ownerProjection(read);
    const osFacts = osFactsFor(target, read, os, skipped);
    const identity: NativeHarnessHistoryProcessIdentity = osFacts.presence === "present"
      && osFacts.processState !== "zombie"
      && (osFacts.pgidComparison === "mismatch" || osFacts.markerComparison === "mismatch")
      ? "mismatch"
      : osFacts.presence === "present"
        && osFacts.processState !== "zombie"
        && osFacts.pgidComparison === "match"
        && osFacts.markerComparison === "consistent"
        ? "runtime-marker-consistent"
        : "unknown";
    stageCounts.targeted += 1;
    if (osFacts.presence === "present") stageCounts.present += 1;
    else if (osFacts.presence === "not-observed") stageCounts.notObserved += 1;
    else stageCounts.unknown += 1;
    if (osFacts.processState === "zombie") stageCounts.zombies += 1;
    if (osFacts.markerComparison === "consistent") stageCounts.markerConsistent += 1;
    if (osFacts.markerComparison === "mismatch") stageCounts.markerMismatch += 1;
    stageRows.push(Object.freeze({
      target: "stage" as const,
      stage: target.stage,
      attempt: target.attempt,
      recordedStatus: target.recordedStatus,
      owner,
      os: osFacts,
      identity,
    }));
  }

  const attemptedReads = reads.filter((read) => read.state !== "not-attempted" && read.state !== "budget-exhausted").length;
  const observedReads = reads.filter((read) => read.state === "observed").length;
  const failedReads = reads.filter((read) => read.state === "missing" || read.state === "invalid" || read.state === "unavailable").length;
  const notAttemptedReads = reads.length - attemptedReads;
  const osState: NativeHarnessHistoryProcessOsInspection["state"] = os === null
    ? skip === "unsupported-platform"
      ? "unsupported"
      : skip === "aborted"
        ? "aborted"
        : "not-run"
    : os.state === "completed"
      ? "completed"
      : os.state === "not-observed"
        ? "not-observed"
        : os.cause === "aborted" ? "aborted" : "limited-unknown";
  const osInspection: NativeHarnessHistoryProcessOsInspection = {
    executed: os !== null && os.queryStarted,
    state: osState,
    requestedPids: selectedPids.length,
    observedPids: os !== null && os.state === "completed" ? os.rows.length : 0,
    cleanup: os === null ? "not-needed" : os.cleanup,
    observedAt: os === null ? null : os.observedAt,
    problem: os === null
      ? skipped === "no-owner-pid"
        ? processReason("os-no-owner-pid", "No validated owner PID was selected, so no OS query was executed.")
        : skipped === "unsupported-platform"
          ? processReason("os-unsupported", "Bounded OS observation is unsupported on this platform.")
          : skipped === "aborted"
            ? processReason("os-not-run-aborted", "No OS query was executed because the host signal aborted.")
            : skipped === "root-changed"
              ? processReason("os-not-run-root-changed", "No OS query was executed because the pinned storage root changed.")
              : processReason("os-not-run-budget", "No OS query was executed after owner-read budget exhaustion.")
      : os.problem,
  };

  const present = controllerOs.presence === "present" ? 1 : 0;
  const presenceNotObserved = controllerOs.presence === "not-observed" ? 1 : 0;
  const presenceUnknown = controllerOs.presence === "unknown" ? 1 : 0;
  const observation: NativeHarnessHistoryProcessLimitedObservation = {
    inspected: true,
    platform: input.osObserver.platform,
    controller: {
      state: "unknown",
      coverage: "controller-lock-only",
      presence: controllerOs.presence,
      owner: controllerOwner,
      os: controllerOs,
      identity: "unknown",
    },
    workers: {
      state: "unknown",
      coverage: "current-recorded-attempts-only",
      rows: Object.freeze(stageRows),
      counts: stageCounts,
      groupCoverage: "not-inspected",
      historicalAttempts: "incomplete",
    },
    coverage: {
      basis: "current-recorded-attempts-only",
      group: "not-inspected",
      historicalAttempts: "incomplete",
    },
    osInspection,
    summary: {
      ownerReads: {
        attempted: attemptedReads,
        observed: observedReads,
        failed: failedReads,
        notAttempted: notAttemptedReads,
      },
      osQueries: os !== null && os.queryStarted ? 1 : 0,
      presence: {
        present: present + stageCounts.present,
        notObserved: presenceNotObserved + stageCounts.notObserved,
        unknown: presenceUnknown + stageCounts.unknown,
      },
      stopProof: "not-established",
    },
    observedAt: os === null ? null : os.observedAt,
    limitations: [
      ...input.targets.problems.map((problem) => problem.detail),
      "Only current recorded stage attempts and one historical controller lock owner were targeted; old attempts were not scanned.",
      "A present PID is an observation at one instant, not signed dispatch identity, ownership or a live-worker claim.",
      "A zombie state is reported separately and is never described as a live executing worker.",
      "Marker consistency uses the flattened ps command and declared runtime path; it is not exact argv or exclusive identity.",
      "Missing owner metadata is one possible outcome among cleanup, pre-write failure or crash; it is never a stopped proof.",
      "Group coverage was not inspected and historical attempt coverage is incomplete.",
      "No authority, resume, attach, cancel, lock or signal capability is created or implied.",
      ...(osInspection.executed
        ? []
        : ["No OS subprocess was executed; owner-read outcomes are distinct from actual OS observation."]),
    ],
  };
  return Object.freeze({
    observation: Object.freeze(observation),
    rootCurrentAfterQuery,
  });
}
