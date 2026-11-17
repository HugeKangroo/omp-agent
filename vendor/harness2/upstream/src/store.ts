import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CANDIDATE_IDS, STAGE_IDS, type HarnessBundle, type LibraryEntry, type RunEvent, type RunRecord, type RunRecoveryOrigin, type RunRecoverySeed } from "./types.ts";
import { validateAdaptationPolicy } from "./adaptation";
import { validateOmpProfileAuth } from "./omp-profile";
import { validateEvolution } from "./evolution";
import { validateExecutionProfile } from "./runtime-policy";
import { validateExplorationEvaluation, validateExplorationPlan } from "./exploration.ts";

const IDS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATUSES = new Set(["queued", "running", "interrupted", "completed", "failed", "cancelled", "applied"]);
const STAGES = new Set<string>(STAGE_IDS);
const CANDIDATES = new Set<string>(CANDIDATE_IDS);
const ADAPTIVE_STAGES = new Set(["plan", "route_1", "route_2", "route_3", "review", "refine"]);
const queues = new Map<string, Promise<unknown>>();

export class StoreConflictError extends Error { override name = "StoreConflictError"; }
export class StoreCorruptionError extends Error { override name = "StoreCorruptionError"; }
export class RunLockedError extends Error { override name = "RunLockedError"; }

function validId(id: string): string {
  if (!IDS.test(id)) throw new Error("Invalid run/entry ID: use 1–128 ASCII letters, digits, underscores or hyphens; start with a letter or digit");
  return id;
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function timestamp(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function finite(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function invariant(ok: unknown, field: string): asserts ok { if (!ok) throw new Error(`Invalid stored field: ${field}`); }

const RECOVERY_SEED_SCHEMA = "omp-agent.native-harness-recovery-seed.v1";
const RECOVERY_ORIGIN_SCHEMA = "omp-agent.native-harness-recovery-origin.v1";
const RECOVERY_PROFILE = "native-auto-scoped-files.v1";
const RECOVERY_SEED_MAX_BYTES = 4096;
const RECOVERY_ORIGIN_MAX_BYTES = 8192;
const RECOVERY_RUN_MAX_BYTES = 256 * 1024;
const RECOVERY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECOVERY_SHA256 = /^[a-f0-9]{64}$/;
const RECOVERY_CANCEL = /^cancel:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/;
const LOCK_OWNER_MAX_BYTES = 16 * 1024;
const CANCEL_REQUEST_MAX_BYTES = 64;
const RECOVERY_SEED_KEYS = Object.freeze([
  "accountingOwnerId",
  "accountingOwnerRevision",
  "admissionId",
  "admittedAt",
  "allocatedCostUsd",
  "deadlineAt",
  "inputManifestSha256",
  "profile",
  "schema",
  "sourceAssociationSha256",
  "sourceDescriptorSha256",
].sort());
const RECOVERY_ORIGIN_KEYS = Object.freeze([
  "createdAt",
  "nonce",
  "recordIdentitySha256",
  "runId",
  "schema",
  "seed",
].sort());

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const keys = Object.keys(value).sort();
  invariant(keys.length === expected.length && keys.every((key, index) => key === expected[index]), `${field} fields`);
}
function validateRecoverySeed(value: unknown): asserts value is RunRecoverySeed {
  invariant(object(value), "run.recoveryOrigin.seed");
  exactKeys(value, RECOVERY_SEED_KEYS, "run.recoveryOrigin.seed");
  invariant(value.schema === RECOVERY_SEED_SCHEMA && value.profile === RECOVERY_PROFILE, "recovery seed schema/profile");
  invariant(typeof value.accountingOwnerId === "string" && RECOVERY_UUID.test(value.accountingOwnerId), "recovery seed accountingOwnerId");
  invariant(typeof value.admissionId === "string" && RECOVERY_UUID.test(value.admissionId), "recovery seed admissionId");
  invariant(Number.isSafeInteger(value.accountingOwnerRevision) && (value.accountingOwnerRevision as number) >= 0, "recovery seed accountingOwnerRevision");
  for (const field of ["sourceAssociationSha256", "sourceDescriptorSha256", "inputManifestSha256"] as const) {
    invariant(typeof value[field] === "string" && RECOVERY_SHA256.test(value[field] as string), `recovery seed ${field}`);
  }
  const admittedAt = value.admittedAt;
  const deadlineAt = value.deadlineAt;
  invariant(Number.isSafeInteger(admittedAt) && (admittedAt as number) > 0, "recovery seed admittedAt");
  invariant(Number.isSafeInteger(deadlineAt) && (deadlineAt as number) > 0, "recovery seed deadlineAt");
  const window = (deadlineAt as number) - (admittedAt as number);
  invariant(window > 0 && window <= 300000, "recovery seed admission interval");
  const allocated = value.allocatedCostUsd;
  invariant(typeof allocated === "number" && Number.isFinite(allocated) && allocated > 0 && allocated <= 1, "recovery seed allocatedCostUsd");
}
function validateRecoveryOriginShape(value: unknown, expectedRunId: string): asserts value is RunRecoveryOrigin {
  invariant(object(value), "run.recoveryOrigin");
  exactKeys(value, RECOVERY_ORIGIN_KEYS, "run.recoveryOrigin");
  invariant(value.schema === RECOVERY_ORIGIN_SCHEMA, "recovery origin schema");
  invariant(typeof value.nonce === "string" && RECOVERY_UUID.test(value.nonce), "recovery origin nonce");
  invariant(typeof value.runId === "string" && value.runId === expectedRunId, "recovery origin run ID");
  validId(value.runId as string);
  invariant(timestamp(value.createdAt), "recovery origin createdAt");
  invariant(typeof value.recordIdentitySha256 === "string" && RECOVERY_SHA256.test(value.recordIdentitySha256), "recovery origin record identity");
  validateRecoverySeed(value.seed);
}
function buildRecoveryRecordIdentity(record: RunRecord): string {
  return createHash("sha256").update(canonical({
    id: record.id,
    createdAt: record.createdAt,
    workspace: record.workspace,
    task: record.task,
    config: record.config,
    baseHarness: record.baseHarness,
    libraryEntries: record.libraryEntries,
  }), "utf8").digest("hex");
}
function freezeRecoverySeed(seed: RunRecoverySeed): RunRecoverySeed {
  return Object.freeze({
    schema: seed.schema,
    profile: seed.profile,
    accountingOwnerId: seed.accountingOwnerId,
    admissionId: seed.admissionId,
    accountingOwnerRevision: seed.accountingOwnerRevision,
    sourceAssociationSha256: seed.sourceAssociationSha256,
    sourceDescriptorSha256: seed.sourceDescriptorSha256,
    inputManifestSha256: seed.inputManifestSha256,
    admittedAt: seed.admittedAt,
    deadlineAt: seed.deadlineAt,
    allocatedCostUsd: seed.allocatedCostUsd,
  });
}
function freezeRecoveryOrigin(origin: RunRecoveryOrigin): RunRecoveryOrigin {
  return Object.freeze({
    schema: origin.schema,
    nonce: origin.nonce,
    runId: origin.runId,
    createdAt: origin.createdAt,
    recordIdentitySha256: origin.recordIdentitySha256,
    seed: freezeRecoverySeed(origin.seed),
  });
}
/** Fixed-shape encoded origin bound, applied to the embedded origin object. */
function assertRecoveryOriginEncodedSize(origin: RunRecoveryOrigin): void {
  if (Buffer.byteLength(JSON.stringify(origin), "utf8") > RECOVERY_ORIGIN_MAX_BYTES) {
    throw new RangeError(`Recovery origin exceeds the ${RECOVERY_ORIGIN_MAX_BYTES}-byte profile.`);
  }
}
/** Raw seed text is read once and decoded by this private fixed-shape codec. */
function decodeRunRecoverySeedText(raw: string): RunRecoverySeed {
  if (typeof raw !== "string") throw new StoreCorruptionError("Corrupt recovery seed: expected UTF-8 text.");
  if (Buffer.byteLength(raw, "utf8") > RECOVERY_SEED_MAX_BYTES) {
    throw new RangeError(`Recovery seed text exceeds the ${RECOVERY_SEED_MAX_BYTES}-byte profile.`);
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new StoreCorruptionError("Corrupt recovery seed: invalid JSON. No fallback was applied."); }
  try { validateRecoverySeed(value); }
  catch (error) { throw new StoreCorruptionError(`Corrupt recovery seed: ${(error as Error).message}. No fallback was applied.`); }
  return freezeRecoverySeed(value);
}

function validateHarness(value: unknown): asserts value is HarnessBundle {
  invariant(object(value), "harness");
  invariant(value.schemaVersion === 1 && nonempty(value.id), "harness version/id");
  invariant(typeof value.promptAppend === "string" && typeof value.toolGuidance === "string" && typeof value.rationale === "string", "harness text");
  invariant(Array.isArray(value.skills) && value.skills.every(skill => object(skill) && nonempty(skill.name) && typeof skill.description === "string" && typeof skill.content === "string"), "harness.skills");
}
function validateLesson(value: unknown): void {
  invariant(object(value), "lesson");
  invariant(nonempty(value.cue) && nonempty(value.lesson), "lesson cue/text");
  invariant(Array.isArray(value.evidence) && value.evidence.every(item => typeof item === "string"), "lesson.evidence");
  invariant(typeof value.confidence === "string" && ["low", "medium", "high"].includes(value.confidence) && typeof value.limitations === "string", "lesson confidence/limitations");
}
function validateLibrary(value: unknown): asserts value is LibraryEntry {
  invariant(object(value), "library entry");
  invariant(value.schemaVersion === 1 && nonempty(value.id) && nonempty(value.runId), "library version/id");
  validId(value.id); validId(value.runId);
  invariant(nonempty(value.domain) && nonempty(value.model) && timestamp(value.createdAt), "library namespace/time");
  validateHarness(value.harness); validateLesson(value.lesson);
}
function validateRun(value: unknown, id?: string): asserts value is RunRecord {
  invariant(object(value), "run");
  invariant((value.schemaVersion === 1 || value.schemaVersion === 2) && nonempty(value.id), "run version/id"); validId(value.id);
  invariant(!id || value.id === id, "run ID matches directory");
  invariant(Number.isSafeInteger(value.revision) && (value.revision as number) >= 0, "run.revision");
  invariant(typeof value.status === "string" && STATUSES.has(value.status), "run.status");
  invariant(timestamp(value.createdAt) && timestamp(value.updatedAt), "run timestamps");
  invariant(nonempty(value.workspace) && typeof value.task === "string", "run workspace/task");
  if (value.warnings !== undefined) invariant(Array.isArray(value.warnings) && value.warnings.every(warning => typeof warning === "string"), "run.warnings");
  const config = value.config;
  invariant(object(config), "run.config");
  invariant(typeof config.mode === "string" && ["product", "research"].includes(config.mode), "config.mode");
  if (config.strategy !== undefined) invariant(typeof config.strategy === "string" && ["auto", "direct", "explore", "legacy", "adaptive"].includes(config.strategy), "config.strategy");
  const evolving = config.strategy === "adaptive";
  invariant((value.schemaVersion === 2) === evolving, "v2 requires adaptive strategy");
  if (evolving) { validateEvolution(value.evolution as import("./evolution").EvolutionState); invariant((value.evolution as import("./evolution").EvolutionState).contract === value.task, "frozen task contract"); }
  else invariant(value.evolution === undefined, "v1 cannot contain adaptive graph");
  if (config.adaptation !== undefined) validateAdaptationPolicy(config.adaptation as import("./adaptation").AdaptationPolicy);
  if (config.auth !== undefined) validateOmpProfileAuth(config.auth as import("./omp-profile").OmpProfileAuth);
  if (config.execution !== undefined) validateExecutionProfile(config.execution as import("./runtime-policy").ExecutionProfile);
  const adaptive = config.strategy !== undefined && config.strategy !== "legacy" && !evolving;
  invariant(config.mode !== "research" || config.strategy === undefined || config.strategy === "legacy", "research mode requires legacy strategy");
  for (const key of ["model", "improverModel", "domain", "ompCommand"]) invariant(nonempty(config[key]), `config.${key}`);
  for (const key of ["maxCostUsd", "maxDurationMs", "stageTimeoutMs"]) invariant(finite(config[key]), `config.${key}`);
  validateHarness(value.baseHarness);
  invariant(Array.isArray(value.libraryEntries), "run.libraryEntries"); value.libraryEntries.forEach(validateLibrary);
  const stages = value.stages;
  invariant(object(stages), "run.stages");
  for (const [key, stage] of Object.entries(stages)) {
    invariant(STAGES.has(key) && object(stage) && stage.id === key, "stage ID");
    invariant(adaptive || !ADAPTIVE_STAGES.has(key), "adaptive stage requires an explicit strategy");
    invariant(typeof stage.status === "string" && ["running", "completed", "failed"].includes(stage.status) && Number.isSafeInteger(stage.attempt) && (stage.attempt as number) >= 1, "stage status/attempt");
    invariant(typeof stage.cwd === "string" && timestamp(stage.startedAt), "stage workspace/time");
    if (stage.harness !== undefined) validateHarness(stage.harness);
    for (const field of ["accountedCostUsd", "reservedCostUsd", "observedCostUsd"]) if (stage[field] !== undefined) invariant(finite(stage[field]), `stage.${field}`);
    for (const field of ["artifactHash", "traceHash", "parentArtifactHash"]) if (stage[field] !== undefined) invariant(typeof stage[field] === "string" && /^[a-fA-F0-9]{64}$/.test(stage[field]), `stage.${field}`);
    invariant((stage.parentStage === undefined) === (stage.parentArtifactHash === undefined), "stage parent reference/hash pairing");
    if (key === "refine") invariant(stage.parentStage !== undefined, "refine parent reference");
    if (stage.parentStage !== undefined) {
      invariant(typeof stage.parentStage === "string" && CANDIDATES.has(stage.parentStage) && stage.parentStage !== key, "stage.parentStage");
      const parent = stages[stage.parentStage];
      invariant(object(parent) && parent.status === "completed" && parent.artifactHash === stage.parentArtifactHash, "stage parent artifact reference");
    }
    if (stage.validationFailures !== undefined) invariant(Number.isSafeInteger(stage.validationFailures) && (stage.validationFailures as number) >= 0, "stage.validationFailures");
    if (stage.result !== undefined) {
      invariant(object(stage.result) && object(stage.result.usage), "stage.result.usage");
      for (const field of ["inputTokens", "outputTokens", "costUsd"]) invariant(finite(stage.result.usage[field]), `stage.result.usage.${field}`);
      invariant(typeof stage.result.status === "string" && ["completed", "failed", "cancelled", "timed_out"].includes(stage.result.status), "stage.result.status");
      invariant(typeof stage.result.text === "string" && typeof stage.result.eventsPath === "string" && timestamp(stage.result.startedAt) && timestamp(stage.result.endedAt), "stage.result metadata");
      if (stage.result.usageEstimated !== undefined) invariant(typeof stage.result.usageEstimated === "boolean", "stage.result.usageEstimated");
    }
  }
  if (value.lesson !== undefined) validateLesson(value.lesson);
  if (["route_1", "route_2", "route_3", "review", "refine"].some(id => stages[id] !== undefined)) invariant(value.exploration !== undefined, "adaptive execution requires its saved plan");
  if (value.winner !== undefined) {
    invariant(typeof value.winner === "string" && CANDIDATES.has(value.winner), "run.winner");
    if (adaptive) {
      const winner = stages[value.winner];
      invariant(object(winner) && winner.status === "completed", "winner completed candidate reference");
      invariant(object(value.exploration) && value.exploration.selection !== undefined, "adaptive winner requires its saved selection");
    } else invariant(value.winner === "baseline" || value.winner === "final", "legacy run.winner");
  }
  if (value.exploration !== undefined) {
    invariant(adaptive && object(value.exploration), "run.exploration");
    const exploration = value.exploration;
    invariant(Object.keys(exploration).every(key => ["plan", "review", "selection"].includes(key)), "exploration fields");
    validateExplorationPlan(exploration.plan);
    invariant(config.strategy === "auto" || config.strategy === exploration.plan.decision, "exploration plan respects strategy");
    const planned = new Set(exploration.plan.routes.map(route => route.id));
    for (const id of ["route_1", "route_2", "route_3"] as const) if (stages[id] !== undefined) invariant(planned.has(id), "stage references a planned route");
    const completed = (["baseline", ...exploration.plan.routes.map(route => route.id), "refine"] as const).filter(id => {
      const stage = stages[id];
      return object(stage) && stage.status === "completed";
    });
    if (exploration.review !== undefined) validateExplorationEvaluation(exploration.review, exploration.plan, completed.filter(id => id !== "refine"));
    if (stages.refine !== undefined) {
      invariant(object(stages.refine) && exploration.review !== undefined && exploration.review.refinement?.candidate === stages.refine.parentStage, "refinement lineage matches its saved review");
    }
    if (exploration.selection !== undefined) {
      validateExplorationEvaluation(exploration.selection, exploration.plan, completed);
      invariant(exploration.selection.refinement === undefined, "final selection cannot request refinement");
      if (value.winner !== undefined) invariant(value.winner === exploration.selection.winner, "run winner matches selection");
    }
  }
  if (Object.hasOwn(value, "recoveryOrigin")) {
    invariant(value.recoveryOrigin !== undefined, "run.recoveryOrigin present");
    validateRecoveryOriginShape(value.recoveryOrigin, value.id);
    const origin = value.recoveryOrigin as RunRecoveryOrigin;
    invariant(origin.createdAt === value.createdAt, "recovery origin createdAt agrees with run");
    invariant(origin.recordIdentitySha256 === buildRecoveryRecordIdentity(value as unknown as RunRecord), "recovery origin record identity agrees with run");
    assertRecoveryOriginEncodedSize(origin);
  }
}
function validateEvent(value: unknown, id?: string): asserts value is RunEvent {
  invariant(object(value) && value.schemaVersion === 1 && nonempty(value.runId), "event version/runId");
  validId(value.runId); invariant(!id || value.runId === id, "event runId matches directory");
  invariant(timestamp(value.timestamp) && nonempty(value.type) && typeof value.message === "string", "event timestamp/type/message");
  if (value.stage !== undefined) invariant(typeof value.stage === "string" && STAGES.has(value.stage), "event.stage");
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreCorruptionError(`Store directory is not a regular directory: ${path}`);
  await chmod(path, 0o700);
}
async function existingDirectory(path: string): Promise<boolean> {
  const info = await lstat(path).catch(error => { if (isMissing(error)) return undefined; throw error; });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreCorruptionError(`Invalid store directory: ${path}`);
  return true;
}
export async function readRegular(path: string): Promise<string | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  try {
    if (!(await file.stat()).isFile()) throw new StoreCorruptionError(`Not a regular store file: ${path}`);
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

interface PathIdentity { readonly dev: number; readonly ino: number }
interface BoundedRegularFile {
  readonly bytes: Buffer;
  readonly text: string;
  readonly sha256: string;
  readonly identity: PathIdentity;
}
/**
 * Bounded, no-follow, regular-file read. The fstat size cap is checked before
 * allocation and the actual read is capped as well, so a growing file cannot
 * cause an unbounded allocation. The handle is closed on every path.
 */
async function readBoundedRegularFile(path: string, maxBytes: number): Promise<BoundedRegularFile | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new RangeError("Invalid bounded read limit");
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (isMissing(error)) return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new StoreCorruptionError(`Symlink is not a regular store file: ${path}`);
    throw error;
  }
  let result: BoundedRegularFile;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new StoreCorruptionError(`Not a regular store file: ${path}`);
    if (info.size > maxBytes) throw new StoreCorruptionError(`Store file exceeds ${maxBytes} bytes: ${path}`);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new StoreCorruptionError(`Store file exceeds ${maxBytes} bytes: ${path}`);
    const after = await file.stat();
    if (!after.isFile() || after.dev !== info.dev || after.ino !== info.ino || after.size !== offset) {
      throw new StoreConflictError(`Store file changed while reading: ${path}`);
    }
    const bytes = buffer.subarray(0, offset);
    result = {
      bytes,
      text: bytes.toString("utf8"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      identity: { dev: info.dev, ino: info.ino },
    };
  } catch (error) {
    try { await file.close(); }
    catch (closeError) {
      throw new Error(`Bounded read failed (${(error as Error).message}) and close failed (${(closeError as Error).message})`);
    }
    throw error;
  }
  // Exactly one close attempt. A rejected close is a real failure, not a
  // reason to retry, drain or continue with the observed bytes.
  await file.close();
  // Return only after the close and a current pathname check. This does not
  // make the read OS-atomic; it refuses a path replaced during read/close.
  await assertBoundedPathCurrent(path, result.identity);
  return result;
}
async function assertBoundedPathCurrent(path: string, identity: PathIdentity): Promise<void> {
  const info = await lstat(path).catch(error => {
    if (isMissing(error)) throw new StoreConflictError(`Store file disappeared after read: ${path}`);
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino) {
    throw new StoreConflictError(`Store file was replaced after read: ${path}`);
  }
}
async function pathIdentity(path: string, label: string): Promise<PathIdentity> {
  const info = await lstat(path).catch(error => {
    if (isMissing(error)) throw new StoreConflictError(`Missing ${label}: ${path}`);
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreCorruptionError(`Invalid ${label}: ${path}`);
  return { dev: info.dev, ino: info.ino };
}
async function assertPathIdentity(path: string, expected: PathIdentity, label: string): Promise<void> {
  const current = await pathIdentity(path, label);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new StoreConflictError(`${label} was replaced: ${path}`);
  }
}
async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, "r");
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function atomicWrite(path: string, contents: string, beforeRename?: () => Promise<void>, finalSeal?: () => void): Promise<void> {
  const seal = ownedFinalSeal(finalSeal);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(contents, "utf8"); await file.sync(); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  finally { await file.close(); }
  try {
    if (beforeRename !== undefined) await beforeRename();
    invokeFinalSeal(seal);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function parse<T>(raw: string, path: string, validate: (value: unknown) => void): T {
  try { const value: unknown = JSON.parse(raw); validate(value); return value as T; }
  catch (error) { throw new StoreCorruptionError(`Corrupt store file ${path}: ${(error as Error).message}. No fallback was applied.`); }
}

const HISTORY_TEXT_MAX_BYTES = 256 * 1024;
const HISTORY_EVENTS_MAX_ROWS = 4096;

/**
 * Pure readonly history decoder for one already-read run.json text.
 * It performs no filesystem I/O, lock acquisition, recovery or write. The
 * original vendor `parse`/`validateRun` schema check is used unchanged; the
 * expected run ID must match the record and the text is capped before parsing.
 * A BOM, torn/partial JSON or any other corruption is rejected rather than
 * stripped, repaired or replaced from a backup.
 */
export function decodeRunHistoryText(raw: string, expectedRunId: string): RunRecord {
  if (typeof raw !== "string") throw new StoreCorruptionError("Corrupt run history: expected UTF-8 text.");
  try { validId(expectedRunId); }
  catch { throw new StoreCorruptionError("Corrupt run history: invalid expected run ID."); }
  if (Buffer.byteLength(raw, "utf8") > HISTORY_TEXT_MAX_BYTES) {
    throw new RangeError(`Run history text exceeds the ${HISTORY_TEXT_MAX_BYTES}-byte readonly profile.`);
  }
  return parse<RunRecord>(raw, "run.json", value => validateRun(value, expectedRunId));
}

/**
 * Pure readonly decoder for one already-read events.jsonl text. The original
 * vendor `parse`/`validateEvent` schema check is used unchanged. Empty text is
 * an actually empty log; a missing final LF, a row/byte limit breach, a BOM, a
 * corrupt row or a mismatched run ID is rejected. No fallback is applied.
 */
export function decodeRunEventsText(raw: string, expectedRunId: string): RunEvent[] {
  if (typeof raw !== "string") throw new StoreCorruptionError("Corrupt event history: expected UTF-8 text.");
  try { validId(expectedRunId); }
  catch { throw new StoreCorruptionError("Corrupt event history: invalid expected run ID."); }
  if (Buffer.byteLength(raw, "utf8") > HISTORY_TEXT_MAX_BYTES) {
    throw new RangeError(`Event history text exceeds the ${HISTORY_TEXT_MAX_BYTES}-byte readonly profile.`);
  }
  if (raw === "") return [];
  if (!raw.endsWith("\n")) {
    throw new StoreCorruptionError("Incomplete event log: events.jsonl does not end with LF. No fallback was applied.");
  }
  const lines = raw.slice(0, -1).split("\n");
  if (lines.length > HISTORY_EVENTS_MAX_ROWS) {
    throw new RangeError(`Event history rows exceed the ${HISTORY_EVENTS_MAX_ROWS}-row readonly profile.`);
  }
  return lines.map((line, index) =>
    parse<RunEvent>(line, `events.jsonl:${index + 1}`, value => validateEvent(value, expectedRunId)));
}

/**
 * Pure readonly decoder for one already-read `recoveryOrigin` text. It checks
 * only the fixed origin/seed shape and the expected run ID; it cannot verify
 * `recordIdentitySha256`, which requires the surrounding actual RunRecord.
 * Oversize text is refused before JSON.parse; malformed JSON, unknown/absent
 * fields, an unsafe number or a mismatched run ID is StoreCorruptionError.
 * A BOM is not stripped, defaults are not invented and no backup is consulted.
 */
export function decodeRunRecoveryOriginText(raw: string, expectedRunId: string): RunRecoveryOrigin {
  if (typeof raw !== "string") throw new StoreCorruptionError("Corrupt recovery origin: expected UTF-8 text.");
  try { validId(expectedRunId); }
  catch { throw new StoreCorruptionError("Corrupt recovery origin: invalid expected run ID."); }
  if (Buffer.byteLength(raw, "utf8") > RECOVERY_ORIGIN_MAX_BYTES) {
    throw new RangeError(`Recovery origin text exceeds the ${RECOVERY_ORIGIN_MAX_BYTES}-byte profile.`);
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new StoreCorruptionError("Corrupt recovery origin: invalid JSON. No fallback was applied."); }
  try { validateRecoveryOriginShape(value, expectedRunId); }
  catch (error) { throw new StoreCorruptionError(`Corrupt recovery origin: ${(error as Error).message}. No fallback was applied.`); }
  return freezeRecoveryOrigin(value as RunRecoveryOrigin);
}
/** Presence of the origin key, even in otherwise malformed parseable JSON. */
function declaresRunRecoveryOrigin(raw: string): boolean {
  try { const value: unknown = JSON.parse(raw); return object(value) && Object.hasOwn(value, "recoveryOrigin"); }
  catch { return false; }
}
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(fn);
  queues.set(key, pending);
  try { return await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
}

interface LockOwner { pid: number; token: string; createdAt: string }
interface AcquiredLock {
  readonly path: string;
  readonly owner: LockOwner;
  readonly ownerText: string;
  readonly ownerSha256: string;
  readonly ownerIdentity: PathIdentity;
  readonly identity: PathIdentity;
  release(): Promise<void>;
}
async function lockOwner(path: string): Promise<LockOwner | undefined> {
  const file = await readBoundedRegularFile(join(path, "owner.json"), LOCK_OWNER_MAX_BYTES);
  if (file === undefined) return undefined;
  return parse<LockOwner>(file.text, path, value => {
    invariant(object(value) && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && nonempty(value.token) && timestamp(value.createdAt), "lock owner");
  });
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; return true; }
}
/**
 * Cleanup is allowed only while the path is still the directory this process
 * created and it either has no owner yet or still has our exact owner bytes.
 * Unknown or replaced paths are left for inspection instead of recursively
 * deleting whatever now occupies the lock name.
 */
async function cleanupInitializingLock(path: string, identity: PathIdentity, ownerText: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino) return;
    const owner = await readBoundedRegularFile(join(path, "owner.json"), LOCK_OWNER_MAX_BYTES);
    if (owner !== undefined && owner.text !== ownerText) return;
    // Recheck after the owner read: a same-owner hardlink under a replaced
    // directory must not be deleted by cleanup.
    const final = await lstat(path);
    if (!final.isDirectory() || final.isSymbolicLink() || final.dev !== identity.dev || final.ino !== identity.ino) return;
    await rm(path, { recursive: true });
  } catch { /* Preserve an unknown path rather than claim cleanup. */ }
}
/** Atomic mkdir lock. Only a valid, demonstrably dead PID can be reclaimed. */
async function acquireLock(path: string): Promise<AcquiredLock> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let created = false;
    try { await mkdir(path, { mode: 0o700 }); created = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) {
      const createdIdentity = await pathIdentity(path, "lock directory");
      const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
      const ownerText = `${JSON.stringify(owner, null, 2)}\n`;
      const ownerSha256 = createHash("sha256").update(ownerText, "utf8").digest("hex");
      try {
        await atomicWrite(join(path, "owner.json"), ownerText);
        const ownerIdentity = (await readBoundedRegularFile(join(path, "owner.json"), LOCK_OWNER_MAX_BYTES))?.identity;
        if (ownerIdentity === undefined) throw new StoreCorruptionError(`Lock owner disappeared after write: ${path}`);
        const identity = await pathIdentity(path, "lock directory");
        if (identity.dev !== createdIdentity.dev || identity.ino !== createdIdentity.ino) {
          throw new StoreConflictError(`Lock directory was replaced during initialization: ${path}`);
        }
        let released = false;
        return {
          path,
          owner,
          ownerText,
          ownerSha256,
          ownerIdentity,
          identity,
          release: async () => {
            if (released) return;
            await assertPathIdentity(path, identity, "lock directory");
            const current = await readBoundedRegularFile(join(path, "owner.json"), LOCK_OWNER_MAX_BYTES);
            if (current === undefined
              || current.identity.dev !== ownerIdentity.dev
              || current.identity.ino !== ownerIdentity.ino
              || current.text !== ownerText
              || current.sha256 !== ownerSha256) {
              throw new RunLockedError(`Lock ownership changed: ${path}`);
            }
            await assertPathIdentity(path, identity, "lock directory");
            await rm(path, { recursive: true });
            released = true;
          },
        };
      } catch (error) {
        await cleanupInitializingLock(path, createdIdentity, ownerText);
        throw error;
      }
    }
    const info = await lstat(path).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreCorruptionError(`Invalid lock directory: ${path}`);
    const old = await lockOwner(path);
    if (!old) throw new RunLockedError(`Lock is initializing or its owner record is missing; manual inspection required: ${path}`);
    if (alive(old.pid)) throw new RunLockedError(`Run/store is locked by active PID ${old.pid}: ${path}`);
    // This per-directory claim serializes stale reclaimers. Recheck the token after
    // claiming: the directory could have been replaced since the first read.
    const claim = join(path, "reclaim");
    try { await mkdir(claim, { mode: 0o700 }); }
    catch (error) {
      if (isMissing(error)) continue;
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RunLockedError(`Stale lock reclamation is in progress (or requires inspection): ${path}`);
      throw error;
    }
    const current = await lockOwner(path);
    if (!current || current.token !== old.token || alive(current.pid)) {
      await rm(claim, { recursive: true, force: true });
      throw new RunLockedError(`Lock changed during stale-owner check: ${path}`);
    }
    await rm(path, { recursive: true });
  }
  throw new RunLockedError(`Could not acquire lock: ${path}`);
}
export async function withWriteLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  return serialized(directory, async () => {
    await privateDirectory(dirname(directory));
    await privateDirectory(directory);
    const lock = await acquireLock(join(directory, ".write.lock"));
    try { return await fn(); } finally { await lock.release(); }
  });
}

/**
 * Store-issued run lease context. The object is identity-bound through a
 * private WeakMap entry; copied objects, lookalikes and contexts from another
 * Store or run are not authority. It observes the actual `.run.lock`; it does
 * not prove user intent, worker death, artifact validity or budget admission.
 */
export interface RunStoreLease {
  readonly ownerSha256: string;
  assertCurrent(): Promise<void>;
  release(): Promise<void>;
}
interface SaveLockedOptions {
  readonly maxBytes?: number;
  readonly beforePrimaryWrite?: () => Promise<void>;
  readonly beforePrimaryRename?: () => Promise<void>;
  /** Synchronous host currentness seal immediately before each original rename. */
  readonly finalSeal?: () => void;
  /**
   * Internal captured run directory already bound to a Store-issued lease.
   * Only the conditional lease-owned transition supplies this; ordinary save
   * and every caller-facing path keep the default `this.runDir(id)`.
   */
  readonly targetDirectory?: string;
}
interface LeaseState {
  readonly store: RunStore;
  readonly runId: string;
  readonly root: string;
  readonly runDir: string;
  readonly lockPath: string;
  readonly rootIdentity: PathIdentity;
  readonly runIdentity: PathIdentity;
  readonly lockIdentity: PathIdentity;
  readonly ownerText: string;
  readonly ownerSha256: string;
  readonly ownerIdentity: PathIdentity;
  active: boolean;
  busy: boolean;
}
const leaseStates = new WeakMap<RunStoreLease, LeaseState>();
const ABORTED_GETTER = typeof AbortSignal === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const NATIVE_PROMISE_PROTOTYPE = typeof Promise === "undefined" ? undefined : Promise.prototype;
const NATIVE_PROMISE_THEN = typeof Promise === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(Promise.prototype, "then")?.value;

/** Observe a refused genuine native Promise rejection without awaiting or accepting it. */
function observeRefusedPromise(value: unknown): void {
  if (NATIVE_PROMISE_PROTOTYPE === undefined || NATIVE_PROMISE_THEN === undefined) return;
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  let prototype: unknown;
  try { prototype = Object.getPrototypeOf(value); }
  catch { return; }
  if (prototype !== NATIVE_PROMISE_PROTOTYPE) return;
  for (const key of ["then", "constructor"] as const) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
    catch { return; }
    if (descriptor !== undefined) return;
  }
  try {
    Reflect.apply(NATIVE_PROMISE_THEN, value, [undefined, () => undefined]);
  } catch {
    // Refusal is synchronous; observing a foreign shape never changes it.
  }
}
/** Intrinsic getter call: prototype spoofing and shadowed `aborted` fail closed. */
function readSignalAborted(signal: AbortSignal): boolean {
  if (ABORTED_GETTER === undefined) throw new StoreConflictError("Recovery transition requires an actual AbortSignal");
  let value: unknown;
  try { value = ABORTED_GETTER.call(signal); }
  catch { throw new StoreConflictError("Recovery transition requires an actual AbortSignal"); }
  if (typeof value !== "boolean") throw new StoreConflictError("Recovery transition requires an actual AbortSignal");
  return value;
}
function ownedFinalSeal(value: unknown): (() => void) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") throw new StoreConflictError("Final seal must be one synchronous host function");
  return value as () => void;
}
/** No await is allowed between this call and the effect it seals. */
function invokeFinalSeal(seal: (() => void) | undefined): void {
  if (seal === undefined) return;
  const result: unknown = seal();
  if (result !== undefined) {
    observeRefusedPromise(result);
    throw new StoreConflictError("Final seal must return undefined synchronously");
  }
}
async function assertLeaseCurrent(state: LeaseState): Promise<void> {
  if (!state.active) throw new StoreConflictError(`Run lease is no longer active: ${state.runId}`);
  const assertScope = async (): Promise<void> => {
    if (!state.active) throw new StoreConflictError(`Run lease is no longer active: ${state.runId}`);
    await assertPathIdentity(state.root, state.rootIdentity, "store root");
    await assertPathIdentity(state.runDir, state.runIdentity, "run directory");
    await assertPathIdentity(state.lockPath, state.lockIdentity, "run lease");
  };
  const assertOwner = async (): Promise<void> => {
    const owner = await readBoundedRegularFile(join(state.lockPath, "owner.json"), LOCK_OWNER_MAX_BYTES);
    if (owner === undefined
      || owner.identity.dev !== state.ownerIdentity.dev
      || owner.identity.ino !== state.ownerIdentity.ino
      || owner.text !== state.ownerText
      || owner.sha256 !== state.ownerSha256) {
      throw new RunLockedError(`Run lease ownership changed: ${state.runId}`);
    }
  };
  await assertScope();
  await assertOwner();
  // The opened owner descriptor alone is not proof: recheck the scope, the
  // current path and owner bytes, then seal root/run/lock identities again
  // after the last owner read/close. A completed concurrent release cannot
  // leave this assertion current.
  await assertScope();
  await assertOwner();
  await assertScope();
  if (!state.active) throw new StoreConflictError(`Run lease is no longer active: ${state.runId}`);
}
export function recoveryDeadline(record: RunRecord): number {
  const origin = record.recoveryOrigin;
  if (origin === undefined) throw new StoreConflictError(`Run ${record.id} is not a marked recovery run`);
  const createdAt = Date.parse(record.createdAt);
  const maxDurationMs = record.config.maxDurationMs;
  const outer = origin.seed.deadlineAt;
  const inner = createdAt + maxDurationMs;
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(outer)
    || !Number.isFinite(maxDurationMs) || maxDurationMs < 0 || !Number.isSafeInteger(inner)) {
    throw new StoreCorruptionError(`Recovery deadline for ${record.id} is not a finite safe value`);
  }
  return Math.min(outer, inner);
}
export function assertRecoveryDeadline(record: RunRecord, now: number = Date.now()): void {
  const origin = record.recoveryOrigin;
  if (origin === undefined) throw new StoreConflictError(`Run ${record.id} is not a marked recovery run`);
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new StoreConflictError(`Recovery clock for ${record.id} is not a safe positive time`);
  }
  if (now < origin.seed.admittedAt) {
    throw new StoreConflictError(`Recovery clock for ${record.id} predates original admission`);
  }
  const deadline = recoveryDeadline(record);
  if (now >= deadline) throw new StoreConflictError(`Original recovery deadline expired for ${record.id}`);
}

/** Local-filesystem store. Mutations serialize in-process and use cross-process
 * write locks; active cross-process writers fail explicitly rather than wait.
 * acquire() is a separate whole-run lock for the controller's exclusive lease. */
export class RunStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  runDir(id: string): string { return join(this.root, validId(id)); }
  async create(record: RunRecord): Promise<RunRecord> {
    if (Object.hasOwn(record, "recoveryOrigin")) throw new StoreConflictError(`Recovery origin is store-issued; use createWithRecoveryOrigin: ${record.id}`);
    const created = structuredClone({ ...record, revision: 0 }); validateRun(created);
    return withWriteLock(this.runDir(created.id), async () => {
      if (await readRegular(join(this.runDir(created.id), "run.json")) !== undefined || await readRegular(join(this.runDir(created.id), "run.json.bak")) !== undefined) throw new StoreConflictError(`Run already exists: ${created.id}`);
      await atomicWrite(join(this.runDir(created.id), "run.json"), serialize(created)); return created;
    });
  }
  /**
   * Explicit creation of an initial native-auto run with a store-issued,
   * immutable creation association. The seed is caller-declared historical
   * data, not authority: this method checks only initial-record consistency
   * and fresh-directory/atomic-write behavior. It never means the run is
   * recoverable or eligible to resume.
   */
  async createWithRecoveryOrigin(record: RunRecord, seedText: string): Promise<RunRecord> {
    if (Object.hasOwn(record, "recoveryOrigin")) throw new StoreConflictError(`Recovery origin is store-issued; supply seed text: ${record.id}`);
    const owned = structuredClone(record); validateRun(owned);
    const seed = decodeRunRecoverySeedText(seedText);
    invariant(owned.schemaVersion === 1 && owned.status === "queued", "initial recovery run version/status");
    invariant(owned.config.mode === "product" && owned.config.strategy === "auto", "initial recovery run product/auto");
    invariant(owned.config.execution === undefined, "initial recovery run execution profile");
    invariant(owned.config.maxCostUsd > 0 && owned.config.maxDurationMs > 0 && owned.config.stageTimeoutMs > 0, "initial recovery run budgets");
    invariant(owned.config.maxCostUsd === seed.allocatedCostUsd, "initial recovery allocation matches config.maxCostUsd");
    invariant(Object.keys(owned.stages).length === 0 && owned.snapshot === undefined && owned.winner === undefined && owned.evolution === undefined, "initial recovery run must be undispatched");
    const createdAt = Date.parse(owned.createdAt);
    invariant(createdAt >= seed.admittedAt && createdAt < seed.deadlineAt, "initial recovery run createdAt lies inside the original admission interval");

    await privateDirectory(this.root);
    const directory = this.runDir(owned.id);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StoreConflictError(`Run directory already exists: ${owned.id}`);
      throw error;
    }
    return withWriteLock(directory, async () => {
      const path = join(directory, "run.json");
      if (await readRegular(path) !== undefined || await readRegular(`${path}.bak`) !== undefined) throw new StoreConflictError(`Run already exists: ${owned.id}`);
      const origin = freezeRecoveryOrigin({
        schema: RECOVERY_ORIGIN_SCHEMA,
        nonce: randomUUID(),
        runId: owned.id,
        createdAt: owned.createdAt,
        recordIdentitySha256: buildRecoveryRecordIdentity(owned),
        seed,
      });
      const created: RunRecord = { ...owned, revision: 0, recoveryOrigin: origin };
      // validateRun applies the fixed 8192-byte embedded-origin profile here,
      // before the initial primary exists.
      validateRun(created);
      const contents = serialize(created);
      if (Buffer.byteLength(contents, "utf8") > RECOVERY_RUN_MAX_BYTES) {
        throw new RangeError(`Initial recovery run exceeds the ${RECOVERY_RUN_MAX_BYTES}-byte profile.`);
      }
      await atomicWrite(path, contents); return created;
    });
  }
  async get(id: string): Promise<RunRecord | undefined> {
    const directory = this.runDir(id);
    if (!(await existingDirectory(this.root)) || !(await existingDirectory(directory))) return undefined;
    const path = join(directory, "run.json"); const raw = await readRegular(path);
    if (raw === undefined) {
      if (await readRegular(`${path}.bak`) !== undefined) throw new StoreCorruptionError(`Missing ${path}; backup exists. Use recover(id) explicitly.`);
      return undefined;
    }
    return parse<RunRecord>(raw, path, value => validateRun(value, id));
  }
  async list(): Promise<RunRecord[]> {
    if (!(await existingDirectory(this.root))) return [];
    const entries = await readdir(this.root, { withFileTypes: true }).catch(error => { if (isMissing(error)) return []; throw error; });
    const records: RunRecord[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!IDS.test(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new StoreCorruptionError(`Symlink in run store: ${entry.name}`);
      if (entry.isDirectory()) { const record = await this.get(entry.name); if (record) records.push(record); }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  /**
   * Already-write-locked CAS/identity/write body. Callers must own `next` and
   * already hold the original short write lock; this method never acquires
   * `withWriteLock` and never falls back to an unbounded reread.
   */
  private async saveLocked(next: RunRecord, current: RunRecord | undefined, expectedRevision: number, options?: SaveLockedOptions): Promise<RunRecord> {
    const id = next.id;
    const admittedRevision = next.revision;
    if (!current || current.revision !== expectedRevision || admittedRevision !== expectedRevision) throw new StoreConflictError(`Revision conflict for ${id}: expected ${expectedRevision}, found ${current?.revision ?? "missing"}`);
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new StoreConflictError("Revision counter exhausted");
    if (current.recoveryOrigin !== undefined || next.recoveryOrigin !== undefined) {
      if (current.recoveryOrigin === undefined || next.recoveryOrigin === undefined) {
        throw new StoreConflictError(`Recovery origin cannot be added to or removed from run ${id}`);
      }
      if (canonical(current.recoveryOrigin) !== canonical(next.recoveryOrigin)) {
        throw new StoreConflictError(`Recovery origin is immutable for run ${id}`);
      }
      if (buildRecoveryRecordIdentity(current) !== buildRecoveryRecordIdentity(next)) {
        throw new StoreConflictError(`Protected run identity cannot change for marked run ${id}`);
      }
      next.recoveryOrigin = current.recoveryOrigin;
    }
    next.revision = current.revision + 1; next.updatedAt = new Date().toISOString();
    next.createdAt = current.createdAt;
    const backupText = serialize(current);
    const nextText = serialize(next);
    if (options?.maxBytes !== undefined) {
      if (Buffer.byteLength(backupText, "utf8") > options.maxBytes || Buffer.byteLength(nextText, "utf8") > options.maxBytes) {
        throw new RangeError(`Recovery record exceeds the ${options.maxBytes}-byte profile.`);
      }
    }
    const finalSeal = ownedFinalSeal(options?.finalSeal);
    if (options?.beforePrimaryWrite !== undefined) await options.beforePrimaryWrite();
    const directory = options?.targetDirectory ?? this.runDir(id);
    await atomicWrite(join(directory, "run.json.bak"), backupText, undefined, finalSeal);
    await atomicWrite(join(directory, "run.json"), nextText, options?.beforePrimaryRename, finalSeal);
    return next;
  }
  async save(record: RunRecord, expectedRevision: number): Promise<RunRecord> {
    validateRun(record); const next = structuredClone(record);
    // Own the admitted ID before the first await; later caller mutation cannot
    // retarget this operation's lock, CAS or writes.
    const id = next.id;
    return withWriteLock(this.runDir(id), async () => {
      const current = await this.get(id);
      return this.saveLocked(next, current, expectedRevision);
    });
  }
  async appendEvent(event: RunEvent): Promise<void> {
    validateEvent(event); const copy = structuredClone(event);
    await withWriteLock(this.runDir(event.runId), async () => {
      if (!(await this.get(event.runId))) throw new StoreConflictError(`Unknown run: ${event.runId}`);
      const path = join(this.runDir(event.runId), "events.jsonl");
      // Refuse symlinks and malformed/torn existing logs; never silently discard evidence.
      await this.events(event.runId);
      const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { await file.chmod(0o600); await file.writeFile(`${JSON.stringify(copy)}\n`, "utf8"); await file.sync(); } finally { await file.close(); }
    });
  }
  async events(id: string): Promise<RunEvent[]> {
    const directory = this.runDir(id);
    if (!(await existingDirectory(this.root)) || !(await existingDirectory(directory))) return [];
    const path = join(directory, "events.jsonl"); const raw = await readRegular(path);
    if (raw === undefined || raw === "") return [];
    if (!raw.endsWith("\n")) throw new StoreCorruptionError(`Incomplete event log: ${path}`);
    return raw.slice(0, -1).split("\n").map((line, i) => parse<RunEvent>(line, `${path}:${i + 1}`, value => validateEvent(value, id)));
  }
  /**
   * Original whole-run lease, now with an identity-bound observation context.
   * Stale-lock reclamation remains the original policy: only a valid,
   * demonstrably dead owner can be reclaimed; a missing owner refuses.
   */
  async acquireWithContext(id: string): Promise<RunStoreLease> {
    // `readonly` is a compile-time property only. Capture the root and run
    // directory before the first await so validation and issuance cannot be
    // split between two trees by a runtime assignment to store.root.
    const root = this.root;
    const directory = join(root, validId(id));
    if (!(await existingDirectory(root)) || !(await existingDirectory(directory))) {
      throw new StoreConflictError(`Unknown run: ${id}`);
    }
    const primaryPath = join(directory, "run.json");
    const raw = await readRegular(primaryPath);
    if (raw === undefined) {
      if (await readRegular(`${primaryPath}.bak`) !== undefined) {
        throw new StoreCorruptionError(`Missing ${primaryPath}; backup exists. Use recover(id) explicitly.`);
      }
      throw new StoreConflictError(`Unknown run: ${id}`);
    }
    parse<RunRecord>(raw, primaryPath, value => validateRun(value, id));
    const rootIdentity = await pathIdentity(root, "store root");
    const runIdentity = await pathIdentity(directory, "run directory");
    const lock = await acquireLock(join(directory, ".run.lock"));
    try {
      await assertPathIdentity(root, rootIdentity, "store root");
      await assertPathIdentity(directory, runIdentity, "run directory");
      const state: LeaseState = {
        store: this,
        runId: id,
        root,
        runDir: directory,
        lockPath: lock.path,
        rootIdentity,
        runIdentity,
        lockIdentity: lock.identity,
        ownerText: lock.ownerText,
        ownerSha256: lock.ownerSha256,
        ownerIdentity: lock.ownerIdentity,
        active: true,
        busy: false,
      };
      const context: RunStoreLease = Object.freeze({
        ownerSha256: lock.ownerSha256,
        assertCurrent: async () => { await assertLeaseCurrent(state); },
        release: async () => {
          if (!state.active) return;
          if (state.busy) throw new StoreConflictError(`Run lease is busy: ${id}`);
          state.busy = true;
          try {
            // Cooperating Store writers honor this pathname lease. The final
            // check and recursive rm are not one OS-atomic operation; this
            // protocol does not claim resistance to arbitrary external
            // replacement in that narrow non-cooperating window.
            await assertLeaseCurrent(state);
            await rm(lock.path, { recursive: true });
            state.active = false;
          } finally { state.busy = false; }
        },
      });
      leaseStates.set(context, state);
      return context;
    } catch (error) {
      await lock.release().catch(() => {});
      throw error;
    }
  }
  /** Compatibility wrapper: the original acquire() release is the context release. */
  async acquire(id: string): Promise<() => Promise<void>> {
    return (await this.acquireWithContext(id)).release;
  }
  /**
   * Generation-aware cancellation for an already-marked run. Every accepted
   * request replaces the marker with a fresh random generation under the
   * original short write lock. The returned facts are observations only.
   */
  async requestMarkedCancellation(id: string): Promise<{
    readonly status: "requested" | "noop";
    readonly generation: string | null;
    readonly generationSha256: string | null;
  }> {
    validId(id);
    // Capture the operation target before the first await. A later runtime
    // mutation of store.root must not retarget the short lock, the primary
    // read or the generation write.
    const directory = this.runDir(id);
    return withWriteLock(directory, async () => {
      const primaryPath = join(directory, "run.json");
      const primary = await readBoundedRegularFile(primaryPath, RECOVERY_RUN_MAX_BYTES);
      if (primary === undefined) throw new StoreConflictError(`Unknown run: ${id}`);
      const record = parse<RunRecord>(primary.text, primaryPath, value => validateRun(value, id));
      if (record.recoveryOrigin === undefined) throw new StoreConflictError(`Run ${id} is not a marked recovery run`);
      if (record.status === "completed" || record.status === "applied") {
        return { status: "noop" as const, generation: null, generationSha256: null };
      }
      const cancelPath = join(directory, "cancel.request");
      const existing = await readBoundedRegularFile(cancelPath, CANCEL_REQUEST_MAX_BYTES);
      if (existing !== undefined && !RECOVERY_CANCEL.test(existing.text)) {
        throw new StoreCorruptionError(`Corrupt cancellation request: ${cancelPath}`);
      }
      const generation = `cancel:${randomUUID()}\n`;
      if (Buffer.byteLength(generation, "utf8") > CANCEL_REQUEST_MAX_BYTES) throw new RangeError("Cancellation generation exceeds the 64-byte profile.");
      await atomicWrite(cancelPath, generation);
      return {
        status: "requested" as const,
        generation,
        generationSha256: createHash("sha256").update(generation, "utf8").digest("hex"),
      };
    });
  }
  /**
   * Conditional interrupted-state transition for one marked run. This never
   * executes work and never proves resume eligibility: it only converts the
   * exact observed record to `interrupted` under the original short write
   * lock, then consumes the exact matched cancellation generation.
   */
  async commitRecoveryInterrupted(
    lease: RunStoreLease,
    runId: string,
    expectedRevision: number,
    expectedPrimarySha256: string,
    expectedCancelSha256: string | null,
    signal: AbortSignal,
    currentness: () => void | Promise<void>,
    finalSeal?: () => void,
  ): Promise<RunRecord> {
    if (typeof runId !== "string") throw new StoreConflictError("Recovery run ID must be a string");
    validId(runId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new StoreConflictError("Recovery revision must be a safe nonnegative integer");
    if (typeof expectedPrimarySha256 !== "string" || !RECOVERY_SHA256.test(expectedPrimarySha256)) throw new StoreConflictError("Recovery primary SHA must be 64 lowercase hex characters");
    if (expectedCancelSha256 !== null && (typeof expectedCancelSha256 !== "string" || !RECOVERY_SHA256.test(expectedCancelSha256))) throw new StoreConflictError("Recovery cancel SHA must be null or 64 lowercase hex characters");
    if (typeof AbortSignal === "undefined" || !(signal instanceof AbortSignal)) throw new StoreConflictError("Recovery transition requires an actual AbortSignal");
    if (typeof currentness !== "function") throw new StoreConflictError("Recovery transition requires a host currentness assertion");
    const fixedFinalSeal = ownedFinalSeal(finalSeal);
    const state = leaseStates.get(lease);
    if (state === undefined || state.store !== this || state.runId !== runId) {
      throw new StoreConflictError(`Run lease was not issued by this Store for ${runId}`);
    }
    if (!state.active) throw new StoreConflictError(`Run lease is no longer active: ${runId}`);
    if (state.busy) throw new StoreConflictError(`Run lease is busy: ${runId}`);
    // Bind this operation to the issued lease's original run directory before
    // the first await. A later runtime mutation of store.root must not
    // retarget the lock, reads, backup, primary, cancel or directory sync.
    const directory = state.runDir;
    // Own every scalar/reference before the first await. The host callback is
    // captured once and must not become a JSON permission or a thenable.
    const signalRef = signal;
    readSignalAborted(signalRef);
    const hostCheck = currentness;
    const startedClock = Date.now();
    if (!Number.isSafeInteger(startedClock) || startedClock <= 0) {
      throw new StoreConflictError("Recovery clock is not a safe positive time");
    }
    state.busy = true;
    let lastClock: number | undefined = startedClock;
    const assertClock = (record: RunRecord): void => {
      const now = Date.now();
      if (!Number.isSafeInteger(now) || now <= 0) {
        throw new StoreConflictError(`Recovery clock for ${record.id} is not a safe positive time`);
      }
      if (lastClock !== undefined && now < lastClock) {
        throw new StoreConflictError(`Recovery clock moved backwards during transition for ${record.id}`);
      }
      lastClock = now;
      assertRecoveryDeadline(record, now);
    };
    const assertCurrent = async (): Promise<void> => {
      if (readSignalAborted(signalRef)) throw new Error("Cancellation requested");
      await assertLeaseCurrent(state);
      if (readSignalAborted(signalRef)) throw new Error("Cancellation requested");
    };
    // Synchronous control seal used only after a frontier's final await:
    // original clock, captured pure host seal, then actual intrinsic signal.
    const seal = (record: RunRecord): void => {
      assertClock(record);
      invokeFinalSeal(fixedFinalSeal);
      if (readSignalAborted(signalRef)) throw new Error("Cancellation requested");
    };
    const checkHost = async (record: RunRecord | undefined): Promise<void> => {
      const result: unknown = hostCheck();
      if (result !== undefined) {
        if (!(result instanceof Promise)) throw new StoreConflictError("Host currentness assertion must return void or a Promise<void>");
        const value: unknown = await result;
        if (value !== undefined) throw new StoreConflictError("Host currentness assertion resolved to a non-void value");
      }
      await assertCurrent();
      if (record !== undefined) assertClock(record);
    };
    try {
      await assertCurrent();
      await checkHost(undefined);
      const committed = await withWriteLock(directory, async () => {
        const primaryPath = join(directory, "run.json");
        await assertCurrent();
        const primary = await readBoundedRegularFile(primaryPath, RECOVERY_RUN_MAX_BYTES);
        if (primary === undefined) throw new StoreConflictError(`Missing primary run record: ${runId}`);
        if (primary.sha256 !== expectedPrimarySha256) throw new StoreConflictError(`Primary run record changed: ${runId}`);
        const record = parse<RunRecord>(primary.text, primaryPath, value => validateRun(value, runId));
        if (record.revision !== expectedRevision) throw new StoreConflictError(`Revision conflict for ${runId}: expected ${expectedRevision}, found ${record.revision}`);
        if (record.recoveryOrigin === undefined) throw new StoreConflictError(`Run ${runId} is not a marked recovery run`);
        if (record.status === "completed" || record.status === "applied") throw new StoreConflictError(`Run ${runId} is already terminal`);
        assertClock(record);
        await assertCurrent();
        await checkHost(record);
        const assertPrimaryUnchanged = async (): Promise<void> => {
          // The host hook may have yielded arbitrary time. Re-read the actual
          // bounded primary and require both raw bytes and file identity.
          const current = await readBoundedRegularFile(primaryPath, RECOVERY_RUN_MAX_BYTES);
          if (current === undefined
            || current.sha256 !== expectedPrimarySha256
            || current.identity.dev !== primary.identity.dev
            || current.identity.ino !== primary.identity.ino) {
            throw new StoreConflictError(`Primary run record changed before publication: ${runId}`);
          }
        };
        const cancelPath = join(directory, "cancel.request");
        const cancel = await readBoundedRegularFile(cancelPath, CANCEL_REQUEST_MAX_BYTES);
        if (expectedCancelSha256 === null) {
          if (cancel !== undefined) throw new StoreConflictError(`Unexpected cancellation request for ${runId}`);
        } else {
          if (cancel === undefined) throw new StoreConflictError(`Matched cancellation request is missing for ${runId}`);
          if (!RECOVERY_CANCEL.test(cancel.text)) throw new StoreCorruptionError(`Corrupt cancellation request: ${cancelPath}`);
          if (cancel.sha256 !== expectedCancelSha256) throw new StoreConflictError(`Cancellation generation changed for ${runId}`);
        }
        const matchedCancel = cancel;
        await assertCurrent();
        assertClock(record);
        await assertPrimaryUnchanged();
        seal(record);
        const next = structuredClone(record);
        next.status = "interrupted";
        validateRun(next);
        const beforePublication = async (): Promise<void> => {
          // Host work may spend arbitrary time. Re-run it, then re-read the
          // actual bounded primary, then synchronously seal signal/clock
          // before the caller proceeds to backup or primary publication.
          await checkHost(record);
          await assertPrimaryUnchanged();
          seal(record);
        };
        const saved = await this.saveLocked(next, record, expectedRevision, {
          maxBytes: RECOVERY_RUN_MAX_BYTES,
          beforePrimaryWrite: beforePublication,
          beforePrimaryRename: beforePublication,
          // The rename-time window re-runs the full synchronous clock, host
          // seal and actual intrinsic signal, not the host seal alone.
          finalSeal: () => seal(record),
          targetDirectory: directory,
        });
        const savedText = serialize(saved);
        const published = await readBoundedRegularFile(primaryPath, RECOVERY_RUN_MAX_BYTES);
        if (published === undefined || published.text !== savedText) {
          throw new StoreConflictError(`Published recovery record changed: ${runId}`);
        }
        if (expectedCancelSha256 !== null) {
          if (matchedCancel === undefined) throw new StoreConflictError(`Matched cancellation request is missing for ${runId}`);
          // The host hook is an awaited boundary: re-read and match after it,
          // then run the pre-consumption guard without another host call.
          await checkHost(saved);
          const current = await readBoundedRegularFile(cancelPath, CANCEL_REQUEST_MAX_BYTES);
          if (current === undefined
            || current.sha256 !== expectedCancelSha256
            || !current.bytes.equals(matchedCancel.bytes)
            || current.identity.dev !== matchedCancel.identity.dev
            || current.identity.ino !== matchedCancel.identity.ino) {
            throw new StoreConflictError(`Cancellation request changed before consumption: ${runId}`);
          }
          await assertCurrent();
          assertClock(record);
          // No callback runs between this final byte/identity match and unlink.
          const confirmed = await readBoundedRegularFile(cancelPath, CANCEL_REQUEST_MAX_BYTES);
          if (confirmed === undefined
            || confirmed.sha256 !== expectedCancelSha256
            || !confirmed.bytes.equals(matchedCancel.bytes)
            || confirmed.identity.dev !== matchedCancel.identity.dev
            || confirmed.identity.ino !== matchedCancel.identity.ino) {
            throw new StoreConflictError(`Cancellation request changed before consumption: ${runId}`);
          }
          seal(record);
          await unlink(cancelPath);
          await syncDirectory(directory);
        }
        // When absence was expected, a newly appeared marker is a newer request:
        // it is never unlinked here and remains visible to the next observer.
        await checkHost(saved);
        const finalPrimary = await readBoundedRegularFile(primaryPath, RECOVERY_RUN_MAX_BYTES);
        if (finalPrimary === undefined
          || finalPrimary.sha256 !== published.sha256
          || finalPrimary.identity.dev !== published.identity.dev
          || finalPrimary.identity.ino !== published.identity.ino) {
          throw new StoreConflictError(`Published recovery record changed before success: ${runId}`);
        }
        await assertCurrent();
        seal(saved);
        return saved;
      });
      // `withWriteLock` has fully returned, including its short-lock release
      // IO. No host callback may run here: one final synchronous intrinsic
      // signal + monotone original-deadline seal only. A newer cancellation
      // request remains unread and unconsumed.
      try { seal(committed); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new StoreConflictError(`Recovery record ${runId} was committed, but the final signal/deadline seal failed: ${reason}`);
      }
      return committed;
    } finally { state.busy = false; }
  }
  /** Explicit recovery only: preserve damaged bytes, restore the validated previous
   * revision, and advance past the interrupted revision to invalidate old CAS tokens. */
  async recover(id: string): Promise<RunRecord> {
    validId(id);
    return withWriteLock(this.runDir(id), async () => {
      const path = join(this.runDir(id), "run.json"); const raw = await readRegular(path);
      const declaresOrigin = raw !== undefined && declaresRunRecoveryOrigin(raw);
      if (raw !== undefined) {
        let valid = false;
        try { parse<RunRecord>(raw, path, value => validateRun(value, id)); valid = true; } catch (error) { if (!(error instanceof StoreCorruptionError)) throw error; }
        if (valid) throw new StoreConflictError(`Run ${id} is valid; recovery would roll it back`);
      }
      const backup = await readRegular(`${path}.bak`);
      if (backup === undefined) throw new StoreCorruptionError(`No backup available for ${id}`);
      const record = parse<RunRecord>(backup, `${path}.bak`, value => validateRun(value, id));
      // A creation-bound marker is never recreated or erased by backup rollback,
      // even when the current file is malformed after declaring that marker.
      if (record.recoveryOrigin !== undefined || declaresOrigin) {
        throw new StoreConflictError(`Run ${id} declares a creation-bound recovery origin; backup rollback is refused`);
      }
      invariant(record.revision < Number.MAX_SAFE_INTEGER - 1, "recoverable revision");
      if (raw !== undefined) await atomicWrite(`${path}.corrupt.${randomUUID()}`, raw);
      record.revision += 2; record.updatedAt = new Date().toISOString();
      // Checkpoint recovery itself so a second corruption cannot reuse a revision.
      await atomicWrite(`${path}.bak`, serialize(record));
      await atomicWrite(path, serialize(record)); return record;
    });
  }
}

export class LibraryStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private namespace(domain: string, model: string): string {
    invariant(nonempty(domain) && nonempty(model), "library namespace");
    return join(this.root, createHash("sha256").update(JSON.stringify([domain, model])).digest("hex"));
  }
  async list(domain: string, model: string): Promise<LibraryEntry[]> {
    const directory = this.namespace(domain, model);
    if (!(await existingDirectory(this.root)) || !(await existingDirectory(directory))) return [];
    const entries = await readdir(directory, { withFileTypes: true }); const results: LibraryEntry[] = [];
    for (const file of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.name.endsWith(".json")) continue;
      validId(file.name.slice(0, -5));
      const path = join(directory, file.name); const raw = await readRegular(path);
      if (raw === undefined) throw new StoreCorruptionError(`Library entry disappeared: ${path}`);
      const entry = parse<LibraryEntry>(raw, path, validateLibrary);
      if (entry.domain !== domain || entry.model !== model || entry.id !== file.name.slice(0, -5)) throw new StoreCorruptionError(`Library entry namespace/ID mismatch: ${path}`);
      results.push(entry);
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async add(entry: LibraryEntry): Promise<LibraryEntry> {
    validateLibrary(entry); const copy = structuredClone(entry);
    return withWriteLock(this.namespace(entry.domain, entry.model), async () => {
      const path = join(this.namespace(entry.domain, entry.model), `${validId(entry.id)}.json`);
      const raw = await readRegular(path);
      if (raw !== undefined) {
        const existing = parse<LibraryEntry>(raw, path, validateLibrary);
        if (canonical(existing) !== canonical(copy)) throw new StoreConflictError(`Conflicting library entry: ${entry.id}`);
        return existing;
      }
      await atomicWrite(path, serialize(copy)); return copy;
    });
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
