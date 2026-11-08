import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CANDIDATE_IDS, STAGE_IDS, type HarnessBundle, type LibraryEntry, type RunEvent, type RunRecord } from "./types.ts";
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
export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(contents, "utf8"); await file.sync(); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  finally { await file.close(); }
  try {
    await rename(temporary, path);
    const dir = await open(dirname(path), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await rm(temporary, { force: true }); }
}
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function parse<T>(raw: string, path: string, validate: (value: unknown) => void): T {
  try { const value: unknown = JSON.parse(raw); validate(value); return value as T; }
  catch (error) { throw new StoreCorruptionError(`Corrupt store file ${path}: ${(error as Error).message}. No fallback was applied.`); }
}
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(fn);
  queues.set(key, pending);
  try { return await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
}

interface LockOwner { pid: number; token: string; createdAt: string }
async function lockOwner(path: string): Promise<LockOwner | undefined> {
  const raw = await readRegular(join(path, "owner.json"));
  if (raw === undefined) return undefined;
  return parse<LockOwner>(raw, path, value => {
    invariant(object(value) && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && nonempty(value.token) && timestamp(value.createdAt), "lock owner");
  });
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; return true; }
}
/** Atomic mkdir lock. Only a valid, demonstrably dead PID can be reclaimed. */
async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await mkdir(path, { mode: 0o700 });
      const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
      try { await atomicWrite(join(path, "owner.json"), serialize(owner)); }
      catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
      let released = false;
      return async () => {
        if (released) return;
        const current = await lockOwner(path);
        if (current?.token !== owner.token) throw new RunLockedError(`Lock ownership changed: ${path}`);
        await rm(path, { recursive: true }); released = true;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
    const release = await acquireLock(join(directory, ".write.lock"));
    try { return await fn(); } finally { await release(); }
  });
}

/** Local-filesystem store. Mutations serialize in-process and use cross-process
 * write locks; active cross-process writers fail explicitly rather than wait.
 * acquire() is a separate whole-run lock for the controller's exclusive lease. */
export class RunStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  runDir(id: string): string { return join(this.root, validId(id)); }
  async create(record: RunRecord): Promise<RunRecord> {
    const created = structuredClone({ ...record, revision: 0 }); validateRun(created);
    return withWriteLock(this.runDir(created.id), async () => {
      if (await readRegular(join(this.runDir(created.id), "run.json")) !== undefined || await readRegular(join(this.runDir(created.id), "run.json.bak")) !== undefined) throw new StoreConflictError(`Run already exists: ${created.id}`);
      await atomicWrite(join(this.runDir(created.id), "run.json"), serialize(created)); return created;
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
  async save(record: RunRecord, expectedRevision: number): Promise<RunRecord> {
    validateRun(record); const next = structuredClone(record);
    return withWriteLock(this.runDir(record.id), async () => {
      const current = await this.get(record.id);
      if (!current || current.revision !== expectedRevision || record.revision !== expectedRevision) throw new StoreConflictError(`Revision conflict for ${record.id}: expected ${expectedRevision}, found ${current?.revision ?? "missing"}`);
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new StoreConflictError("Revision counter exhausted");
      next.revision = current.revision + 1; next.updatedAt = new Date().toISOString();
      next.createdAt = current.createdAt;
      await atomicWrite(join(this.runDir(record.id), "run.json.bak"), serialize(current));
      await atomicWrite(join(this.runDir(record.id), "run.json"), serialize(next)); return next;
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
  async acquire(id: string): Promise<() => Promise<void>> {
    if (!(await this.get(id))) throw new StoreConflictError(`Unknown run: ${id}`);
    return acquireLock(join(this.runDir(id), ".run.lock"));
  }
  /** Explicit recovery only: preserve damaged bytes, restore the validated previous
   * revision, and advance past the interrupted revision to invalidate old CAS tokens. */
  async recover(id: string): Promise<RunRecord> {
    validId(id);
    return withWriteLock(this.runDir(id), async () => {
      const path = join(this.runDir(id), "run.json"); const raw = await readRegular(path);
      if (raw !== undefined) {
        let valid = false;
        try { parse<RunRecord>(raw, path, value => validateRun(value, id)); valid = true; } catch (error) { if (!(error instanceof StoreCorruptionError)) throw error; }
        if (valid) throw new StoreConflictError(`Run ${id} is valid; recovery would roll it back`);
      }
      const backup = await readRegular(`${path}.bak`);
      if (backup === undefined) throw new StoreCorruptionError(`No backup available for ${id}`);
      const record = parse<RunRecord>(backup, `${path}.bak`, value => validateRun(value, id));
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
