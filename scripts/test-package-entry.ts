import { existsSync, closeSync, openSync, writeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_OMP_VERSION, parseOmpVersion } from "../test/harness/admission.ts";
import {
  binaryManifest,
  sourceManifest,
  writeJson,
} from "../test/harness/package-entry-evidence.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUITE_TIMEOUT_MS = 90_000;
const requested = process.env.OMP_COMMAND || "omp";
const resolved = requested.includes("/")
  ? (existsSync(requested) ? path.resolve(requested) : undefined)
  : Bun.which(requested) ?? undefined;
if (!resolved) {
  console.error(`test:package-entry requires the installed OMP ${EXPECTED_OMP_VERSION}; ${JSON.stringify(requested)} was not found.`);
  process.exit(1);
}
const version = spawnSync(resolved, ["--version"], {
  env: { PATH: process.env.PATH, HOME: homedir() },
  encoding: "utf8",
  timeout: 5000,
  maxBuffer: 8192,
});
if (version.error || version.status !== 0) {
  console.error(`test:package-entry could not execute ${resolved}: ${version.error?.message ?? `exit ${version.status}`}`);
  process.exit(1);
}
let actual: string;
try {
  actual = parseOmpVersion(version.stdout);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
if (actual !== EXPECTED_OMP_VERSION) {
  console.error(`test:package-entry expects OMP ${EXPECTED_OMP_VERSION}; installed version is ${actual}.`);
  process.exit(1);
}

const evidenceRoot = await mkdtemp(path.join(tmpdir(), "omp-agent-package-entry-suite-"));
const logPath = path.join(evidenceRoot, "suite.log");
const startedAt = new Date().toISOString();
const command = ["bun", "test", "test/omp-package-entry.test.ts"];
const source = sourceManifest(REPO_ROOT);
const ompBinary = await binaryManifest(resolved, actual);
const bunBinary = await binaryManifest(process.execPath, Bun.version);
await writeJson(path.join(evidenceRoot, "source-binary-manifest.json"), {
  startedAt,
  repoRoot: REPO_ROOT,
  source,
  binaries: { omp: ompBinary, bun: bunBinary },
  packageJson: JSON.parse(await Bun.file(path.join(REPO_ROOT, "package.json")).text()),
  note: "Saved before the package-entry suite imports or spawns any product process.",
});
await writeJson(path.join(evidenceRoot, "suite.json"), {
  startedAt,
  evidenceRoot,
  logPath,
  command,
  timeoutMs: SUITE_TIMEOUT_MS,
  omp: { path: resolved, version: actual },
});

const child = spawn(command[0]!, command.slice(1), {
  cwd: REPO_ROOT,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    RUN_REAL_OMP_TEST: "1",
    OMP_COMMAND: resolved,
    PACKAGE_ENTRY_EVIDENCE_ROOT: evidenceRoot,
    PACKAGE_ENTRY_LOG: logPath,
  },
});
const logFd = openSync(logPath, "a", 0o600);
const tee = (chunk: Buffer, target: number): void => {
  try { writeSync(target, chunk); } catch { /* terminal closed */ }
  try { writeSync(logFd, chunk); } catch { /* bounded log fd */ }
};
child.stdout?.on("data", (chunk: Buffer) => tee(chunk, 1));
child.stderr?.on("data", (chunk: Buffer) => tee(chunk, 2));
let timedOut = false;
const watchdog = setTimeout(() => {
  timedOut = true;
  try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
}, SUITE_TIMEOUT_MS);
const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  child.on("close", (code, signal) => resolve({ code, signal }));
});
clearTimeout(watchdog);
closeSync(logFd);
const finishedAt = new Date().toISOString();
await writeJson(path.join(evidenceRoot, "suite-result.json"), {
  startedAt,
  finishedAt,
  durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
  timedOut,
  exitCode: result.code,
  exitSignal: result.signal,
  evidenceRoot,
  logPath,
});
console.log(`[package-entry] evidence=${evidenceRoot}`);
console.log(`[package-entry] log=${logPath}`);
console.log(`[package-entry] exit=${String(result.code)} signal=${String(result.signal)} timedOut=${timedOut}`);
process.exit(timedOut ? 124 : (result.code ?? 1));
