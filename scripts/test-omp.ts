import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { EXPECTED_OMP_VERSION, parseOmpVersion } from "../test/harness/admission.ts";

const requested = process.env.OMP_COMMAND || "omp";
const resolved = requested.includes("/")
  ? (existsSync(requested) ? requested : undefined)
  : Bun.which(requested) ?? undefined;
if (!resolved) {
  console.error(`test:omp requires the installed OMP ${EXPECTED_OMP_VERSION}; ${JSON.stringify(requested)} was not found.`);
  process.exit(1);
}
const version = spawnSync(resolved, ["--version"], {
  env: { PATH: process.env.PATH, HOME: homedir() },
  encoding: "utf8",
  timeout: 5000,
  maxBuffer: 8192,
});
if (version.error || version.status !== 0) {
  console.error(`test:omp could not execute ${resolved}: ${version.error?.message ?? `exit ${version.status}`}`);
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
  console.error(`test:omp expects OMP ${EXPECTED_OMP_VERSION}; installed version is ${actual}.`);
  process.exit(1);
}

const test = Bun.spawn(["bun", "test", "test/omp-g1a.test.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, RUN_REAL_OMP_TEST: "1", OMP_COMMAND: resolved },
  stdout: "inherit",
  stderr: "inherit",
});
const code = await test.exited;
process.exit(code);
