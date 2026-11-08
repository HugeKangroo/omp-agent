import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ApplyResult, Change, FileEntry, WorkspaceSnapshot } from "./types.js";

/** These limits apply independently to the input and each candidate workspace. */
export const WORKSPACE_LIMITS = { files: 20_000, fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 };
const ORIGIN = ".harness2-origin.json";
const APPLY_LOCK = ".harness2/.apply.lock";
const omittedDirectories = new Set([".git", ".harness2", ".harness-evidence", ".omp", ".pi", ".claude", ".codex", ".gemini", ".aws", ".ssh", ".gnupg", "node_modules", ".venv", "venv"]);
const dependencyDirectories = new Set(["node_modules", ".venv", "venv"]);
const ambientNames = new Set(["agents.md", "claude.md", "gemini.md", ORIGIN]);
const secretName = /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|service[-_]account[^/]*\.json)$|\.(?:pem|key|p12|pfx|keystore)$/i;

function excluded(file: string): boolean {
  return file.split("/").some(part => omittedDirectories.has(part.toLowerCase()) || ambientNames.has(part.toLowerCase()) || secretName.test(part));
}
function normalized(file: string): string {
  if (!file || path.isAbsolute(file) || file.includes("\\") || file.includes("\0") || file.split("/").some(p => !p || p === "." || p === "..")) throw new Error(`Unsafe workspace path: ${file}`);
  return file;
}
function inside(root: string, other: string): boolean {
  const rel = path.relative(root, other);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
function rootDirectory(root: string): string {
  const absolute = path.resolve(root);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Workspace root must be a real directory: ${absolute}`);
  return fs.realpathSync(absolute);
}
/** Canonicalize the existing ancestor, then refuse any symlink below that boundary. */
function destinationPath(input: string): string {
  const absolute = path.resolve(input);
  const missing: string[] = [];
  let cursor = absolute;
  while (!fs.existsSync(cursor)) {
    if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Symlink destination: ${cursor}`);
    missing.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`Invalid destination: ${absolute}`);
    cursor = parent;
  }
  if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink destination: ${cursor}`);
  return path.join(rootDirectory(cursor), ...missing);
}
function safePath(root: string, relative: string, allowMissing = false): string {
  normalized(relative);
  let cursor = root;
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]!);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) {
      if (!allowMissing) throw new Error(`Workspace file disappeared: ${relative}`);
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink is not supported: ${relative}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Non-directory parent: ${relative}`);
  }
  if (!inside(root, cursor)) throw new Error(`Path escaped workspace: ${relative}`);
  return cursor;
}
function hash(bytes: Buffer, mode: number): string {
  return createHash("sha256").update(`${mode.toString(8)}\0`).update(bytes).digest("hex");
}
function readFile(root: string, relative: string): { entry: FileEntry; bytes: Buffer } {
  const file = safePath(root, relative);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error(`Special files and submodules are not supported: ${relative}`);
    if (before.mode & 0o7000) throw new Error(`Special file permissions are not supported: ${relative}`);
    if (before.size > WORKSPACE_LIMITS.fileBytes) throw new Error(`Workspace file exceeds size limit: ${relative}`);
    // Bound the allocation even if another process grows the file after fstat.
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== before.size) throw new Error(`Workspace changed while reading: ${relative}`);
    const bytes = buffer.subarray(0, length);
    const after = fs.fstatSync(fd);
    safePath(root, relative);
    const current = fs.lstatSync(file);
    if (before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode) throw new Error(`Workspace changed while reading: ${relative}`);
    const mode = before.mode & 0o777;
    return { entry: { path: relative, size: bytes.length, mode, hash: hash(bytes, mode) }, bytes };
  } finally { fs.closeSync(fd); }
}
function checkLimits(files: FileEntry[]): void {
  if (files.length > WORKSPACE_LIMITS.files || files.reduce((n, f) => n + f.size, 0) > WORKSPACE_LIMITS.totalBytes) throw new Error("Workspace exceeds file count or total size limit");
}
function gitFiles(root: string): string[] {
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0 || !top.stdout.trim() || rootDirectory(top.stdout.trim()) !== root) throw new Error("Harness² requires the root of a local Git working tree");
  const result = spawnSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error("Could not enumerate Git workspace files");
  return [...new Set(result.stdout.split("\0").filter(Boolean).map(normalized))].sort();
}
function snapshotManifest(snapshot: WorkspaceSnapshot): Map<string, FileEntry> {
  const root = rootDirectory(snapshot.root);
  const entries = new Map<string, FileEntry>();
  for (const entry of snapshot.files) {
    normalized(entry.path);
    if (excluded(entry.path) || entries.has(entry.path)) throw new Error(`Invalid snapshot manifest path: ${entry.path}`);
    const actual = readFile(root, entry.path).entry;
    if (actual.hash !== entry.hash || actual.mode !== entry.mode || actual.size !== entry.size) throw new Error(`Snapshot integrity check failed: ${entry.path}`);
    entries.set(entry.path, entry);
  }
  checkLimits(snapshot.files);
  return entries;
}
function writeNew(root: string, relative: string, bytes: Buffer, mode: number): void {
  const output = safePath(root, relative, true);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  safePath(root, relative, true);
  fs.writeFileSync(output, bytes, { flag: "wx", mode });
  fs.chmodSync(output, mode);
}

/** Captures current bytes, including staged/unstaged changes and nonignored untracked files. */
export function captureSnapshot(sourceRoot: string, destinationRoot: string): WorkspaceSnapshot {
  const source = rootDirectory(sourceRoot);
  const destination = destinationPath(destinationRoot);
  if (inside(destination, source) || (inside(source, destination) && !path.relative(source, destination).split(path.sep).some(p => omittedDirectories.has(p.toLowerCase())))) throw new Error("Snapshot destination must be separate or under an excluded directory");
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error("Snapshot destination must be empty");
  const listed = gitFiles(source);
  const excludedPaths = listed.filter(excluded);
  const files: FileEntry[] = [];
  fs.mkdirSync(destination, { recursive: true });
  try {
    for (const relative of listed.filter(f => !excluded(f))) {
      // Git retains paths deleted in the dirty working tree. Their absence is the baseline.
      if (!fs.lstatSync(safePath(source, relative, true), { throwIfNoEntry: false })) continue;
      const value = readFile(source, relative);
      files.push(value.entry);
      checkLimits(files);
      writeNew(destination, relative, value.bytes, value.entry.mode);
    }
    const again = gitFiles(source).filter(f => !excluded(f)).filter(f => fs.lstatSync(safePath(source, f, true), { throwIfNoEntry: false }));
    if (JSON.stringify(again) !== JSON.stringify(files.map(f => f.path))) throw new Error("Workspace file list changed during snapshot capture");
    for (const entry of files) if (readFile(source, entry.path).entry.hash !== entry.hash) throw new Error(`Workspace changed during snapshot capture: ${entry.path}`);
    return { id: randomUUID(), sourceRoot: source, root: destination, files, excludedPaths, createdAt: new Date().toISOString() };
  } catch (error) {
    // Only files created in the previously empty destination are removed.
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Existing directories are reset only when marked as a workspace owned by this snapshot. */
export function materializeSnapshot(snapshot: WorkspaceSnapshot, destinationRoot: string): void {
  snapshotManifest(snapshot);
  const destination = destinationPath(destinationRoot);
  const source = rootDirectory(snapshot.sourceRoot);
  const snapshotRoot = rootDirectory(snapshot.root);
  if (inside(destination, source) || inside(destination, snapshotRoot) || inside(snapshotRoot, destination)) throw new Error("Unsafe candidate destination");
  if (inside(source, destination) && !path.relative(source, destination).split(path.sep).some(p => omittedDirectories.has(p.toLowerCase()))) throw new Error("Candidate inside source must be under an excluded directory");
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) {
    const marker = safePath(destination, ORIGIN);
    const data = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (data.snapshotId !== snapshot.id || data.destination !== destination) throw new Error("Refusing to reset an unowned candidate directory");
    fs.rmSync(destination, { recursive: true });
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of snapshot.files) writeNew(destination, entry.path, readFile(snapshotRoot, entry.path).bytes, entry.mode);
  writeNew(destination, ORIGIN, Buffer.from(JSON.stringify({ snapshotId: snapshot.id, destination })), 0o600);
}

function candidateFiles(root: string): Map<string, FileEntry> {
  const files: FileEntry[] = [];
  function walk(relative = ""): void {
    for (const item of fs.readdirSync(relative ? safePath(root, relative) : root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = relative ? `${relative}/${item.name}` : item.name;
      normalized(file);
      if (item.isSymbolicLink()) throw new Error(`Candidate symlink is not supported: ${file}`);
      if (file === ORIGIN && item.isFile()) continue;
      if (dependencyDirectories.has(item.name.toLowerCase()) && item.isDirectory()) continue;
      if (excluded(file)) throw new Error(`Candidate contains a protected configuration or secret path: ${file}`);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) { files.push(readFile(root, file).entry); checkLimits(files); }
      else throw new Error(`Candidate special file is not supported: ${file}`);
    }
  }
  walk();
  return new Map(files.map(entry => [entry.path, entry]));
}

/** Continue a candidate in a separate workspace while keeping the original apply baseline. */
export function materializeCandidate(snapshot: WorkspaceSnapshot, candidateRoot: string, destinationRoot: string): void {
  snapshotManifest(snapshot);
  const source = rootDirectory(snapshot.sourceRoot);
  const original = rootDirectory(snapshot.root);
  const candidate = rootDirectory(candidateRoot);
  const destination = destinationPath(destinationRoot);
  if (inside(candidate, source) || inside(candidate, original) || inside(original, candidate)) throw new Error("Unsafe parent candidate workspace");
  if (inside(source, candidate) && !path.relative(source, candidate).split(path.sep).some(p => omittedDirectories.has(p.toLowerCase()))) throw new Error("Parent candidate inside source must be under an excluded directory");
  if (inside(candidate, destination) || inside(destination, candidate)) throw new Error("Parent and child candidate workspaces must not overlap");
  if (inside(original, destination) || inside(destination, original)) throw new Error("Child candidate must not overlap the original snapshot");
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error("Child candidate destination must be new or empty");
  const marker = JSON.parse(readFile(candidate, ORIGIN).bytes.toString("utf8")) as { snapshotId?: unknown; destination?: unknown } | null;
  if (!marker || marker.snapshotId !== snapshot.id || marker.destination !== candidate) throw new Error("Parent candidate does not belong to this snapshot");
  const continuation: WorkspaceSnapshot = { ...snapshot, root: candidate, files: [...candidateFiles(candidate).values()] };
  // This descriptor exists only for copying. Its ID/source stay bound to the
  // original snapshot, which remains authoritative for diff and explicit apply.
  try {
    materializeSnapshot(continuation, destination);
    snapshotManifest({ ...continuation, root: destination });
  } catch (error) {
    // The destination was empty and cannot overlap either parent or baseline.
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export function diffWorkspace(snapshot: WorkspaceSnapshot, candidateRoot: string): Change[] {
  const before = snapshotManifest(snapshot);
  const after = candidateFiles(rootDirectory(candidateRoot));
  const changes: Change[] = [];
  for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(file), next = after.get(file);
    if (old?.hash === next?.hash) continue;
    changes.push({ path: file, kind: !old ? "add" : !next ? "delete" : "modify", ...(old ? { beforeHash: old.hash } : {}), ...(next ? { afterHash: next.hash } : {}) });
  }
  return changes;
}

function currentHash(root: string, relative: string): string | undefined {
  const full = safePath(root, relative, true);
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${relative}`);
  return readFile(root, relative).entry.hash;
}
/** Individual writes are atomic. The journal enables recovery; this is not a multi-file transaction. */
function replace(root: string, relative: string, bytes: Buffer, mode: number): void {
  const target = safePath(root, relative, true);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  safePath(root, relative, true);
  const temporary = path.join(path.dirname(target), `.harness2-write-${randomUUID()}`);
  const fd = fs.openSync(temporary, "wx", mode);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { safePath(root, relative, true); fs.renameSync(temporary, target); } finally { fs.rmSync(temporary, { force: true }); }
}
interface ApplyLockOwner { pid: number; token: string; createdAt: string; sourceRoot: string }
function readApplyLockOwner(source: string): ApplyLockOwner | undefined {
  const directory = safePath(source, APPLY_LOCK);
  if (!fs.lstatSync(directory).isDirectory()) throw new Error("Invalid workspace apply lock directory");
  const file = safePath(source, `${APPLY_LOCK}/owner.json`, true);
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isFile() || info.nlink !== 1 || info.size > 4096) throw new Error("Invalid workspace apply lock owner; manual inspection required");
  let owner: ApplyLockOwner;
  try { owner = JSON.parse(readFile(directory, "owner.json").bytes.toString("utf8")) as ApplyLockOwner; }
  catch { throw new Error("Invalid workspace apply lock owner; manual inspection required"); }
  if (!owner || typeof owner !== "object" || Array.isArray(owner) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.token !== "string" || !owner.token || typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt)) || owner.sourceRoot !== source) {
    throw new Error("Invalid workspace apply lock owner; manual inspection required");
  }
  return owner;
}
function applyOwnerIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
/** Serialize every transaction and recovery for this workspace, across run IDs and processes. */
function acquireApplyLock(source: string): () => void {
  fs.mkdirSync(safePath(source, ".harness2", true), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 4; attempt++) {
    const directory = safePath(source, APPLY_LOCK, true);
    let created = false;
    try { fs.mkdirSync(directory, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (created) {
      const owner: ApplyLockOwner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString(), sourceRoot: source };
      try { replace(directory, "owner.json", Buffer.from(JSON.stringify(owner)), 0o600); }
      catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
      return () => {
        if (readApplyLockOwner(source)?.token !== owner.token) throw new Error("Workspace apply lock ownership changed; manual inspection required");
        fs.rmSync(safePath(source, APPLY_LOCK), { recursive: true });
      };
    }
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })) continue;
    const old = readApplyLockOwner(source);
    if (!old) throw new Error("Workspace apply lock is initializing or its owner is missing; manual inspection required");
    if (applyOwnerIsAlive(old.pid)) throw new Error(`Workspace apply is locked by active or unverified PID ${old.pid}`);
    // Only one stale-owner reclaimer may inspect and remove this directory. A new
    // owner can have acquired the path since our first read, so recheck its token.
    const claim = safePath(source, `${APPLY_LOCK}/reclaim`, true);
    try { fs.mkdirSync(claim, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Workspace apply lock reclamation is in progress or requires manual inspection");
      throw error;
    }
    const current = readApplyLockOwner(source);
    if (!current || current.token !== old.token || applyOwnerIsAlive(current.pid)) {
      fs.rmSync(claim, { recursive: true, force: true });
      throw new Error("Workspace apply lock changed during stale-owner check");
    }
    fs.rmSync(safePath(source, APPLY_LOCK), { recursive: true });
  }
  throw new Error("Could not acquire workspace apply lock");
}
interface Journal { sourceRoot: string; state: "prepared" | "applying" | "committed" | "rolled_back" | "rollback_failed"; changes: Change[]; before: (FileEntry | null)[] }
function saveJournal(directory: string, journal: Journal): void { replace(directory, "journal.json", Buffer.from(JSON.stringify(journal, null, 2)), 0o600); }
function rollback(source: string, directory: string, journal: Journal): void {
  // Validate the entire recovery before changing anything, preserving subsequent user edits.
  for (const [index, change] of journal.changes.entries()) {
    if (excluded(normalized(change.path))) throw new Error("Protected path in apply recovery journal");
    const before = journal.before[index];
    if ((before?.hash) !== change.beforeHash || (before && before.path !== change.path)) throw new Error("Invalid apply recovery journal");
    const current = currentHash(source, change.path);
    if (current !== change.beforeHash && current !== change.afterHash) throw new Error(`Cannot recover apply; workspace changed: ${change.path}`);
    if (before && readFile(directory, `backup/${index}`).entry.size !== before.size) throw new Error("Invalid apply backup");
    if (before) {
      const backup = readFile(directory, `backup/${index}`).bytes;
      if (hash(backup, before.mode) !== before.hash) throw new Error("Apply backup integrity check failed");
    }
  }
  for (const [index, change] of [...journal.changes.entries()].reverse()) {
    if (currentHash(source, change.path) === change.beforeHash) continue;
    const before = journal.before[index];
    if (before) replace(source, change.path, readFile(directory, `backup/${index}`).bytes, before.mode);
    else fs.unlinkSync(safePath(source, change.path));
  }
  journal.state = "rolled_back";
  saveJournal(directory, journal);
}
/** Recover interrupted journaled applies, refusing to overwrite post-interruption edits. */
export function recoverInterruptedApplies(sourceRoot: string): string[] {
  const source = rootDirectory(sourceRoot);
  const release = acquireApplyLock(source);
  try { return recoverInterruptedAppliesLocked(source); }
  finally { release(); }
}
function recoverInterruptedAppliesLocked(source: string): string[] {
  const transactions = safePath(source, ".harness2/apply-transactions", true);
  if (!fs.existsSync(transactions)) return [];
  const recovered: string[] = [];
  for (const item of fs.readdirSync(transactions)) {
    const directory = safePath(source, `.harness2/apply-transactions/${normalized(item)}`);
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("Invalid apply transaction directory");
    const journalPath = safePath(directory, "journal.json", true);
    if (!fs.existsSync(journalPath)) continue; // Backup preparation was interrupted before any write.
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as Journal;
    if (journal.sourceRoot !== source || !Array.isArray(journal.changes) || !Array.isArray(journal.before) || journal.changes.length !== journal.before.length) throw new Error("Invalid apply recovery journal");
    if (!["prepared", "applying", "committed", "rolled_back", "rollback_failed"].includes(journal.state) || new Set(journal.changes.map(c => c.path)).size !== journal.changes.length) throw new Error("Invalid apply recovery journal state");
    if (["prepared", "applying", "rollback_failed"].includes(journal.state)) { rollback(source, directory, journal); recovered.push(item); }
  }
  return recovered;
}

export function applyWorkspace(snapshot: WorkspaceSnapshot, candidateRoot: string, options: { dryRun?: boolean } = {}): ApplyResult {
  const source = rootDirectory(snapshot.sourceRoot);
  const candidate = rootDirectory(candidateRoot);
  if (source === candidate) throw new Error("Candidate must be separate from source workspace");
  const release = acquireApplyLock(source);
  try { return applyWorkspaceLocked(snapshot, source, candidate, options); }
  finally { release(); }
}
function applyWorkspaceLocked(snapshot: WorkspaceSnapshot, source: string, candidate: string, options: { dryRun?: boolean }): ApplyResult {
  if (!options.dryRun) recoverInterruptedAppliesLocked(source);
  const changes = diffWorkspace(snapshot, candidate);
  const manifest = new Map(snapshot.files.map(f => [f.path, f]));
  const affected = new Set(changes.map(c => c.path));
  for (const entry of snapshot.files) if (!affected.has(entry.path) && currentHash(source, entry.path) !== entry.hash) throw new Error(`Workspace drift detected: ${entry.path}`);
  const before = changes.every(c => currentHash(source, c.path) === c.beforeHash);
  const after = changes.every(c => currentHash(source, c.path) === c.afterHash);
  if (!before && !after) throw new Error("Workspace drift detected; refusing to apply candidate changes");
  if (after) return { applied: false, changes, alreadyApplied: true };
  if (options.dryRun) return { applied: false, changes, alreadyApplied: false };
  const relative = `.harness2/apply-transactions/${randomUUID()}`;
  const directory = safePath(source, relative, true);
  fs.mkdirSync(directory, { recursive: true });
  const journal: Journal = { sourceRoot: source, state: "prepared", changes, before: changes.map(c => manifest.get(c.path) ?? null) };
  for (const [index, change] of changes.entries()) {
    const entry = manifest.get(change.path);
    if (entry) writeNew(directory, `backup/${index}`, readFile(source, change.path).bytes, 0o600);
  }
  saveJournal(directory, journal);
  try {
    journal.state = "applying"; saveJournal(directory, journal);
    for (const change of changes) {
      if (currentHash(source, change.path) !== change.beforeHash) throw new Error(`Workspace changed during apply: ${change.path}`);
      if (change.kind === "delete") fs.unlinkSync(safePath(source, change.path));
      else {
        const next = readFile(candidate, change.path);
        if (next.entry.hash !== change.afterHash) throw new Error(`Candidate changed during apply: ${change.path}`);
        replace(source, change.path, next.bytes, next.entry.mode);
      }
    }
    journal.state = "committed"; saveJournal(directory, journal);
    return { applied: true, changes, alreadyApplied: false };
  } catch (error) {
    try { rollback(source, directory, journal); }
    catch (recoveryError) {
      journal.state = "rollback_failed"; saveJournal(directory, journal);
      throw new Error(`Apply failed and needs recovery: ${String(error)}; ${String(recoveryError)}`);
    }
    throw new Error(`Apply failed; prior file contents restored: ${String(error)}`);
  }
}
