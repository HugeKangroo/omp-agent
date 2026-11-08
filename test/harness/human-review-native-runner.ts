import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  buildExpectedDocument,
  gradeAcceptance,
  gradeDailyComposition,
  gradeFrames,
  loadNativeEvidence,
  semanticMutationChecks,
  type ExpectedDocument,
  type ExpectedOracle,
  type NativeCorpus,
} from "./human-review-native-oracle.ts";

/**
 * Bounded native human-review case runner. It verifies a root-provided SHA
 * manifest before any import/spawn, creates one fresh private runtime root,
 * runs the narrow PTY driver, then grades the saved evidence offline. It never
 * imports product code and never retries a failed case.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CORPUS_PATH = path.join(REPO_ROOT, "test/fixtures/human-review-native-corpus.json");
const EXPECTED_PATH = path.join(REPO_ROOT, "test/fixtures/human-review-native-expected.json");
const DRIVER_PATH = path.join(REPO_ROOT, "test/harness/native-pty-driver.py");
const PROVIDER_PATH = path.join(REPO_ROOT, "test/fixtures/human-review-native-provider.mjs");
const OBSERVER_PATH = path.join(REPO_ROOT, "test/fixtures/human-review-native-observer.mjs");
const DAILY_OBSERVER_PATH = path.join(REPO_ROOT, "test/fixtures/daily-human-review-native-observer.mjs");
const HYBRID_PATH = path.join(REPO_ROOT, "test/fixtures/human-review-native-hybrid-host.mjs");
const TASK_ENTRY_PATH = path.join(REPO_ROOT, "src/task-entry.ts");

const EXPECTED_VERSION = "18.18.0";
const PROVIDER = "native-review-fixture";
const MODEL = "scripted";
const API = "native-review-fixture-api";

type CaseMode = "admission" | "business";
type ExtensionMode = "default-env" | "hybrid" | "daily";
type EnvMode = "enabled" | "absent" | "invalid" | "daily";

interface CaseSpec {
  mode: CaseMode;
  extension: ExtensionMode;
  env: EnvMode;
  providerMode: "forbidden" | "single" | "revise";
  revisions: 1 | 2;
  initialSize: [number, number];
  resize: [number, number] | null;
  timeoutSeconds: number;
  tools: string[];
  registeredNames: string[];
  requestReview: boolean;
  defaultInvocation: number;
  hybridHost: boolean;
  daily?: boolean;
}

export const CASE_SPECS: Record<string, CaseSpec> = {
  "admission-unset": {
    mode: "admission",
    extension: "default-env",
    env: "absent",
    providerMode: "forbidden",
    revisions: 1,
    initialSize: [80, 24],
    resize: null,
    timeoutSeconds: 60,
    tools: ["agent_deliver", "agent_execute", "agent_task", "agent_verify"],
    registeredNames: ["agent_deliver", "agent_execute", "agent_verify"],
    requestReview: false,
    defaultInvocation: 1,
    hybridHost: false,
  },
  "admission-invalid-whitespace": {
    mode: "admission",
    extension: "default-env",
    env: "invalid",
    providerMode: "forbidden",
    revisions: 1,
    initialSize: [80, 24],
    resize: null,
    timeoutSeconds: 60,
    tools: ["agent_task"],
    registeredNames: [],
    requestReview: false,
    defaultInvocation: 1,
    hybridHost: false,
  },
  "initial-enter": {
    mode: "business",
    extension: "default-env",
    env: "enabled",
    providerMode: "single",
    revisions: 1,
    initialSize: [100, 30],
    resize: null,
    timeoutSeconds: 60,
    tools: ["agent_deliver", "agent_execute", "agent_task", "agent_verify"],
    registeredNames: ["agent_deliver", "agent_execute", "agent_verify"],
    requestReview: true,
    defaultInvocation: 1,
    hybridHost: false,
  },
  escape: {
    mode: "business",
    extension: "default-env",
    env: "enabled",
    providerMode: "single",
    revisions: 1,
    initialSize: [100, 30],
    resize: null,
    timeoutSeconds: 60,
    tools: ["agent_deliver", "agent_execute", "agent_task", "agent_verify"],
    registeredNames: ["agent_deliver", "agent_execute", "agent_verify"],
    requestReview: true,
    defaultInvocation: 1,
    hybridHost: false,
  },
  "daily-escape": {
    mode: "business",
    extension: "daily",
    env: "daily",
    providerMode: "single",
    revisions: 1,
    initialSize: [100, 30],
    resize: null,
    timeoutSeconds: 60,
    tools: ["read", "agent_deliver", "agent_execute", "agent_task", "agent_verify"],
    registeredNames: ["agent_deliver", "agent_execute", "agent_task", "agent_verify"],
    requestReview: true,
    defaultInvocation: 1,
    hybridHost: false,
    daily: true,
  },
  "resize-reject": {
    mode: "business",
    extension: "default-env",
    env: "enabled",
    providerMode: "single",
    revisions: 1,
    initialSize: [24, 8],
    resize: [80, 24],
    timeoutSeconds: 60,
    tools: ["agent_deliver", "agent_execute", "agent_task", "agent_verify"],
    registeredNames: ["agent_deliver", "agent_execute", "agent_verify"],
    requestReview: true,
    defaultInvocation: 1,
    hybridHost: false,
  },
  "positive-no-contract": {
    mode: "business",
    extension: "default-env",
    env: "enabled",
    providerMode: "revise",
    revisions: 2,
    initialSize: [100, 30],
    resize: null,
    timeoutSeconds: 60,
    tools: ["agent_deliver", "agent_execute", "agent_task", "agent_verify"],
    registeredNames: ["agent_deliver", "agent_execute", "agent_verify"],
    requestReview: true,
    defaultInvocation: 1,
    hybridHost: false,
  },
  "positive-partial-hybrid": {
    mode: "business",
    extension: "hybrid",
    env: "enabled",
    providerMode: "single",
    revisions: 1,
    initialSize: [100, 30],
    resize: null,
    timeoutSeconds: 60,
    tools: ["agent_deliver", "agent_execute", "agent_task", "agent_verify"],
    registeredNames: ["agent_deliver", "agent_execute", "agent_verify"],
    requestReview: true,
    defaultInvocation: 0,
    hybridHost: true,
  },
  "deadline-expiry": {
    mode: "business",
    extension: "default-env",
    env: "enabled",
    providerMode: "single",
    revisions: 1,
    initialSize: [100, 30],
    resize: null,
    timeoutSeconds: 360,
    tools: ["agent_deliver", "agent_execute", "agent_task", "agent_verify"],
    registeredNames: ["agent_deliver", "agent_execute", "agent_verify"],
    requestReview: true,
    defaultInvocation: 1,
    hybridHost: false,
  },
};

const REQUIRED_EXTRA = [
  "scripts/test-human-review-native.ts",
  "test/harness/human-review-native-runner.ts",
  "test/harness/human-review-native-oracle.ts",
  "test/harness/native-pty-driver.py",
  "test/fixtures/human-review-native-corpus.json",
  "test/fixtures/human-review-native-expected.json",
  "test/fixtures/human-review-native-provider.mjs",
  "test/fixtures/human-review-native-observe.mjs",
  "test/fixtures/human-review-native-observer.mjs",
  "test/fixtures/daily-human-review-native-observer.mjs",
  "test/fixtures/human-review-native-hybrid-host.mjs",
  "package.json",
  "bun.lock",
  "tsconfig.json",
];

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes?: number;
}

export interface NativeManifest {
  phase: string;
  authorizedByRoot: boolean;
  allowNativeExecution: boolean;
  allowNetworkProviderCalls: boolean;
  cases: string[];
  omp: { path: string; sha256: string; expectedVersion: string };
  files: ManifestFile[];
}

export function sha256FileBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function sha256Path(filePath: string): Promise<string> {
  return sha256FileBytes(await readFile(filePath));
}

async function listRecursive(root: string, accept: (name: string) => boolean): Promise<string[]> {
  const result: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error("source scan depth exceeded");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && accept(entry.name)) result.push(full);
    }
  };
  await walk(root, 0);
  return result.sort();
}

export async function requiredFilePaths(repoRoot = REPO_ROOT): Promise<string[]> {
  const source = await listRecursive(path.join(repoRoot, "src"), (name) => /(\.ts|\.mjs|\.d\.mts)$/.test(name));
  return [
    ...source,
    ...REQUIRED_EXTRA.map((relative) => path.join(repoRoot, relative)),
  ].map((file) => path.resolve(file)).sort();
}

export async function verifyManifest(
  manifestPath: string,
  caseName: string | null,
  repoRoot = REPO_ROOT,
): Promise<{ manifest: NativeManifest; verified: Map<string, string> }> {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifest, "utf8")) as NativeManifest;
  if (manifest.phase !== "c2b-native-human-review") throw new Error("manifest phase is not c2b-native-human-review");
  if (manifest.authorizedByRoot !== true) throw new Error("manifest is not authorizedByRoot");
  if (manifest.allowNativeExecution !== true) throw new Error("manifest does not allow native execution");
  if (manifest.allowNetworkProviderCalls !== false) throw new Error("manifest must record allowNetworkProviderCalls=false");
  if (!Array.isArray(manifest.cases)) throw new Error("manifest has no case list");
  if (caseName !== null && !manifest.cases.includes(caseName)) throw new Error(`case ${caseName} is not in the frozen manifest`);
  if (!manifest.omp || manifest.omp.expectedVersion !== EXPECTED_VERSION) throw new Error("manifest OMP identity is malformed");
  if (!path.isAbsolute(manifest.omp.path) || !existsSync(manifest.omp.path)) throw new Error("manifest OMP path is missing");
  if (await sha256Path(manifest.omp.path) !== manifest.omp.sha256) throw new Error("OMP binary does not match the frozen manifest");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("manifest has no files");
  const byPath = new Map<string, ManifestFile>();
  const verified = new Map<string, string>();
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || typeof entry.sha256 !== "string") throw new Error("malformed manifest file entry");
    const full = path.resolve(repoRoot, entry.path);
    if (byPath.has(full)) throw new Error(`duplicate manifest entry ${entry.path}`);
    byPath.set(full, entry);
    if (!existsSync(full)) throw new Error(`frozen file is missing: ${entry.path}`);
    const actual = await sha256Path(full);
    if (actual !== entry.sha256) throw new Error(`frozen file changed: ${entry.path}`);
    verified.set(full, actual);
  }
  const required = await requiredFilePaths(repoRoot);
  const missing = required.filter((file) => !byPath.has(file));
  if (missing.length > 0) {
    throw new Error(`manifest does not cover all required files: ${missing.map((file) => path.relative(repoRoot, file)).join(", ")}`);
  }
  return { manifest, verified };
}

function hashJson(value: unknown): string {
  return sha256FileBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

export interface CasePlan {
  schemaVersion: 1;
  case: string;
  repoRoot: string;
  manifestPath: string;
  runtimeRoot: string;
  evidenceRoot: string;
  omp: { path: string; expectedVersion: string };
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  initialSize: [number, number];
  resize: [number, number] | null;
  timeoutSeconds: number;
  mode: CaseMode;
  revisions: number;
  prompts: { task: string; revision: string };
  expected: {
    model: { provider: string; id: string; api: string };
    tools: string[];
    registeredNames: string[];
    requestReview: boolean;
    defaultInvocation: number;
    hybridHost: boolean;
    daily?: boolean;
  };
  paths: Record<string, string | null>;
}

function privateEnv(runtimeRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "USER", "LOGNAME", "LANG", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const home = path.join(runtimeRoot, "home");
  env.HOME = home;
  env.XDG_CONFIG_HOME = path.join(runtimeRoot, "config-home");
  env.XDG_CACHE_HOME = path.join(runtimeRoot, "cache");
  env.XDG_DATA_HOME = path.join(runtimeRoot, "data");
  env.XDG_STATE_HOME = path.join(runtimeRoot, "state-home");
  env.TERM = "xterm-256color";
  env.PI_CONFIG_DIR = ".omp";
  env.PI_CODING_AGENT_DIR = path.join(runtimeRoot, "agent");
  env.PI_NO_TITLE = "1";
  env.OMP_PROFILE = "default";
  return env;
}

function ompIsolationConfig(): Record<string, unknown> {
  return {
    startup: { setupWizard: false, checkUpdate: false },
    enabledProviders: [],
    disabledProviders: [
      "native", "claude", "claude-plugins", "codex", "gemini", "github", "opencode",
      "cursor", "windsurf", "agents-md", "agents", "omp-plugins", "agent-plugins",
      "omp-managed", "mcp-json", "skillshare",
    ],
    extensions: [],
    autoResume: false,
    retry: { enabled: false, modelFallback: false },
    mcp: { enableProjectConfig: false, notifications: false },
    providers: { cacheWarming: "off" },
    compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 64 },
    advisor: { enabled: false },
    autolearn: { enabled: false },
    contextPromotion: { enabled: false },
    memory: { backend: "off" },
    tools: { approvalMode: "yolo", approval: {} },
    extensionHandlers: { toolCallTimeoutMs: 340_000 },
  };
}

/** The product sandbox admits the real CommandLineTools interpreter, not the xcrun shim. */
function acceptedPythonPath(): string {
  for (const candidate of [
    "/Library/Developer/CommandLineTools/usr/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  const which = Bun.which("python3");
  if (which !== null && which !== "/usr/bin/python3") return which;
  throw new Error("an accepted host Python interpreter is required for the daily case");
}

async function createPlan(
  caseName: string,
  spec: CaseSpec,
  manifestPath: string,
  manifest: NativeManifest,
  corpus: NativeCorpus,
): Promise<{ plan: CasePlan; runtimeRoot: string; evidenceRoot: string; caseDir: string }> {
  if (spec.daily) return createDailyPlan(caseName, spec, manifestPath, manifest, corpus);
  const base = process.env.REVIEW_NATIVE_EVIDENCE_BASE || path.join(tmpdir(), "omp-agent-native-review");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const createdCaseDir = await mkdtemp(path.join(base, `native-review-${caseName}-`));
  const caseDir = await realpath(createdCaseDir);
  const runtimeRoot = path.join(caseDir, "runtime");
  const evidenceRoot = path.join(caseDir, "evidence");
  const workspace = path.join(runtimeRoot, "workspace");
  const agentDir = path.join(runtimeRoot, "agent");
  const homeDir = path.join(runtimeRoot, "home");
  const configHome = path.join(runtimeRoot, "config-home");
  const cacheDir = path.join(runtimeRoot, "cache");
  const dataDir = path.join(runtimeRoot, "data");
  const stateHome = path.join(runtimeRoot, "state-home");
  const inputRoot = path.join(runtimeRoot, "inputs");
  const executionRoot = path.join(runtimeRoot, "execution");
  const deliveryRoot = path.join(runtimeRoot, "delivery");
  const acceptanceRoot = path.join(runtimeRoot, "acceptance");
  for (const directory of [runtimeRoot, evidenceRoot, workspace, agentDir, homeDir, configHome, cacheDir, dataDir, stateHome, inputRoot, executionRoot, deliveryRoot, acceptanceRoot]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  for (const file of corpus.files) {
    await writeFile(path.join(inputRoot, file.name), Buffer.from(file.rawText, "utf8"), { mode: 0o600 });
  }
  const configPath = path.join(runtimeRoot, "config.json");
  await writeFile(configPath, JSON.stringify(ompIsolationConfig(), null, 2), { mode: 0o600 });

  const env = privateEnv(runtimeRoot);
  env.OMP_AGENT_B1_STATE_PATH = path.join(runtimeRoot, "task-state.json");
  env.OMP_AGENT_B1_WORKSPACE_ROOT = workspace;
  env.OMP_AGENT_B1_AUDIT_PATH = path.join(runtimeRoot, "task-audit.jsonl");
  env.OMP_AGENT_B1_CAPABILITIES = "local-script";
  env.OMP_AGENT_EXECUTION_ROOT = executionRoot;
  env.OMP_AGENT_EXECUTION_INPUTS = JSON.stringify([
    { id: "alpha", path: path.join(inputRoot, "alpha.txt") },
    { id: "beta", path: path.join(inputRoot, "beta.txt") },
  ]);
  env.OMP_AGENT_EXECUTION_CAPABILITY = "local-script";
  env.OMP_AGENT_EXECUTION_AUDIT_PATH = path.join(runtimeRoot, "execution-audit.jsonl");
  env.OMP_AGENT_EXECUTION_TIMEOUT_MS = "5000";
  env.OMP_AGENT_DELIVERY_ROOT = deliveryRoot;
  env.OMP_AGENT_ACCEPTANCE_ROOT = acceptanceRoot;
  if (spec.env === "enabled") env.OMP_AGENT_HUMAN_REVIEW = "local-main-tui-v1";
  else if (spec.env === "invalid") env.OMP_AGENT_HUMAN_REVIEW = "   ";
  const observerAudit = path.join(runtimeRoot, "observer-audit.jsonl");
  const providerAudit = path.join(runtimeRoot, "provider-audit.jsonl");
  const hostAudit = path.join(runtimeRoot, "host-audit.jsonl");
  env.REVIEW_NATIVE_AUDIT = observerAudit;
  env.REVIEW_NATIVE_PROVIDER_AUDIT = providerAudit;
  env.REVIEW_NATIVE_PROVIDER_MODE = spec.providerMode;
  env.REVIEW_NATIVE_MAX_REQUESTS = "12";
  env.REVIEW_NATIVE_HYBRID = spec.hybridHost ? "1" : "0";
  env.REVIEW_NATIVE_ROOT = runtimeRoot;
  env.REVIEW_NATIVE_INPUT_ROOT = inputRoot;
  env.REVIEW_NATIVE_HOST_AUDIT = hostAudit;
  for (const file of [observerAudit, providerAudit, path.join(runtimeRoot, "task-audit.jsonl"), path.join(runtimeRoot, "execution-audit.jsonl"), path.join(runtimeRoot, "task-state.json")]) {
    await writeFile(file, "", { mode: 0o600 });
  }
  if (spec.hybridHost) await writeFile(hostAudit, "", { mode: 0o600 });

  const extensionPath = spec.extension === "hybrid" ? HYBRID_PATH : OBSERVER_PATH;
  const argv = [
    manifest.omp.path,
    "--no-tools",
    "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp",
    "--no-session", "--no-title", "--no-prewalk",
    "--approval-mode", "yolo",
    "--config", configPath,
    "--model", `${PROVIDER}/${MODEL}`,
    "--thinking", "off",
    "--max-time", String(spec.timeoutSeconds - 5),
    "--max-cost", "0.1",
    "--extension", PROVIDER_PATH,
    "--extension", TASK_ENTRY_PATH,
    "--extension", extensionPath,
  ];
  const plan: CasePlan = {
    schemaVersion: 1,
    case: caseName,
    repoRoot: REPO_ROOT,
    manifestPath: path.resolve(manifestPath),
    runtimeRoot,
    evidenceRoot,
    omp: { path: manifest.omp.path, expectedVersion: EXPECTED_VERSION },
    argv,
    env,
    cwd: workspace,
    initialSize: spec.initialSize,
    resize: spec.resize,
    timeoutSeconds: spec.timeoutSeconds,
    mode: spec.mode,
    revisions: spec.revisions,
    prompts: { task: corpus.prompts.task, revision: corpus.prompts.revision },
    expected: {
      model: { provider: PROVIDER, id: MODEL, api: API },
      tools: spec.tools,
      registeredNames: spec.registeredNames,
      requestReview: spec.requestReview,
      defaultInvocation: spec.defaultInvocation,
      hybridHost: spec.hybridHost,
    },
    paths: {
      audit: observerAudit,
      providerAudit,
      hostAudit,
      ownerState: path.join(runtimeRoot, "task-state.json"),
      b1Audit: path.join(runtimeRoot, "task-audit.jsonl"),
      executionAudit: path.join(runtimeRoot, "execution-audit.jsonl"),
      executionRoot,
      deliveryRoot,
      acceptanceRoot,
      inputRoot,
    },
  };
  const planPath = path.join(caseDir, "plan.json");
  await writeFile(planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });
  return { plan, runtimeRoot, evidenceRoot, caseDir };
}

async function createDailyPlan(
  caseName: string,
  spec: CaseSpec,
  manifestPath: string,
  manifest: NativeManifest,
  corpus: NativeCorpus,
): Promise<{ plan: CasePlan; runtimeRoot: string; evidenceRoot: string; caseDir: string }> {
  const base = process.env.REVIEW_NATIVE_EVIDENCE_BASE || path.join(tmpdir(), "omp-agent-native-review");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const caseDir = await realpath(await mkdtemp(path.join(base, `native-review-${caseName}-`)));
  const runtimeRoot = path.join(caseDir, "runtime");
  const evidenceRoot = path.join(caseDir, "evidence");
  const workspace = path.join(runtimeRoot, "workspace");
  const agentDir = path.join(runtimeRoot, "agent");
  const homeDir = path.join(runtimeRoot, "home");
  const configHome = path.join(runtimeRoot, "config-home");
  const cacheDir = path.join(runtimeRoot, "cache");
  const dataDir = path.join(runtimeRoot, "data");
  const stateHome = path.join(runtimeRoot, "state-home");
  const inputRoot = path.join(runtimeRoot, "inputs");
  const dailyStateRoot = path.join(runtimeRoot, "daily-state");
  for (const directory of [runtimeRoot, evidenceRoot, workspace, agentDir, homeDir, configHome, cacheDir, dataDir, stateHome, inputRoot]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const inputs: Array<{ id: string; path: string }> = [];
  for (const id of ["alpha", "beta"]) {
    const file = corpus.files.find((candidate) => candidate.name === `${id}.txt`);
    if (!file) throw new Error(`the frozen corpus has no ${id}.txt input`);
    const inputPath = path.join(inputRoot, file.name);
    await writeFile(inputPath, Buffer.from(file.rawText, "utf8"), { mode: 0o600 });
    inputs.push({ id, path: await realpath(inputPath) });
  }

  const configPath = path.join(runtimeRoot, "config.json");
  await writeFile(configPath, JSON.stringify(ompIsolationConfig(), null, 2), { mode: 0o600 });
  const dailyConfigPath = path.join(runtimeRoot, "daily-config.json");
  await writeFile(dailyConfigPath, JSON.stringify({
    schemaVersion: 1,
    workspaceRoot: await realpath(workspace),
    stateRoot: dailyStateRoot,
    inputs,
    pythonPath: acceptedPythonPath(),
    bunPath: process.execPath,
    humanReview: "local-main-tui-v1",
  }, null, 2), { mode: 0o600 });

  const observerAudit = path.join(runtimeRoot, "observer-audit.jsonl");
  const providerAudit = path.join(runtimeRoot, "provider-audit.jsonl");
  await writeFile(observerAudit, "", { mode: 0o600 });
  await writeFile(providerAudit, "", { mode: 0o600 });

  const env = privateEnv(runtimeRoot);
  env.OMP_AGENT_CONFIG = dailyConfigPath;
  env.REVIEW_NATIVE_AUDIT = observerAudit;
  env.REVIEW_NATIVE_PROVIDER_AUDIT = providerAudit;
  env.REVIEW_NATIVE_PROVIDER_MODE = spec.providerMode;
  env.REVIEW_NATIVE_MAX_REQUESTS = "12";
  env.REVIEW_NATIVE_HYBRID = "0";
  env.REVIEW_NATIVE_VERIFY_WITHOUT_CONTRACT = "1";
  env.REVIEW_NATIVE_ROOT = runtimeRoot;
  env.REVIEW_NATIVE_INPUT_ROOT = inputRoot;

  const argv = [
    manifest.omp.path,
    "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp",
    "--no-session", "--no-title", "--no-prewalk",
    "--approval-mode", "yolo",
    "--config", configPath,
    "--model", `${PROVIDER}/${MODEL}`,
    "--thinking", "off",
    "--max-time", String(spec.timeoutSeconds - 5),
    "--max-cost", "0.1",
    "--cwd", workspace,
    "--extension", PROVIDER_PATH,
    "--extension", DAILY_OBSERVER_PATH,
  ];
  const plan: CasePlan = {
    schemaVersion: 1,
    case: caseName,
    repoRoot: REPO_ROOT,
    manifestPath: path.resolve(manifestPath),
    runtimeRoot,
    evidenceRoot,
    omp: { path: manifest.omp.path, expectedVersion: EXPECTED_VERSION },
    argv,
    env,
    cwd: workspace,
    initialSize: spec.initialSize,
    resize: spec.resize,
    timeoutSeconds: spec.timeoutSeconds,
    mode: spec.mode,
    revisions: spec.revisions,
    prompts: { task: corpus.prompts.task, revision: corpus.prompts.revision },
    expected: {
      model: { provider: PROVIDER, id: MODEL, api: API },
      tools: [...spec.tools],
      registeredNames: spec.registeredNames,
      requestReview: spec.requestReview,
      defaultInvocation: spec.defaultInvocation,
      hybridHost: false,
      daily: true,
    },
    paths: {
      audit: observerAudit,
      providerAudit,
      hostAudit: null,
      ownerState: null,
      b1Audit: null,
      executionAudit: null,
      executionRoot: null,
      deliveryRoot: null,
      acceptanceRoot: null,
      stateRoot: dailyStateRoot,
      dailyAudit: null,
      inputRoot,
    },
  };
  await writeFile(path.join(caseDir, "plan.json"), JSON.stringify(plan, null, 2), { mode: 0o600 });
  return { plan, runtimeRoot, evidenceRoot, caseDir };
}

function processAlive(pid: number, group = false): boolean {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function driverCheck(id: string, ok: boolean, detail: string): { id: string; ok: boolean; detail: string } {
  return { id, ok, detail };
}

const DRIVER_STDOUT_LIMIT = 256 * 1024;
const DRIVER_STDERR_LIMIT = 512 * 1024;
const DRIVER_DEADLINE_GRACE_MS = 15_000;
const DRIVER_CLEANUP_GRACE_MS = 5_000;

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (text.length < limit) {
      const remaining = limit - text.length;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
    }
    if (bytes > limit) truncated = true;
  }
  text += decoder.decode();
  return { text, bytes, truncated };
}

async function runDriverBounded(
  pythonPath: string,
  planPath: string,
  caseDir: string,
  caseTimeoutSeconds: number,
): Promise<{
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  timedOut: boolean;
  cleanupFallback: string[];
}> {
  const child = Bun.spawn([pythonPath, DRIVER_PATH, "--plan", planPath], {
    cwd: REPO_ROOT,
    env: { ...process.env, REVIEW_NATIVE_EVIDENCE_BASE: path.dirname(caseDir) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = collectBounded(child.stdout as ReadableStream<Uint8Array>, DRIVER_STDOUT_LIMIT);
  const stderrPromise = collectBounded(child.stderr as ReadableStream<Uint8Array>, DRIVER_STDERR_LIMIT);
  const deadlineMs = caseTimeoutSeconds * 1000 + DRIVER_DEADLINE_GRACE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  const first = await Promise.race([child.exited.then(() => "exit" as const), deadline]);
  let timedOut = first === "deadline";
  const cleanupFallback: string[] = [];
  if (timedOut) {
    cleanupFallback.push("parent deadline reached; signalled only the owned driver handle");
    try {
      child.kill("SIGINT");
    } catch {
      cleanupFallback.push("SIGINT delivery to the owned driver failed");
    }
    for (const [signal, grace] of [["SIGTERM", DRIVER_CLEANUP_GRACE_MS], ["SIGKILL", DRIVER_CLEANUP_GRACE_MS]] as const) {
      if (await Promise.race([child.exited.then(() => true), Bun.sleep(grace).then(() => false)])) break;
      try {
        child.kill(signal);
        cleanupFallback.push(`escalated to ${signal} after the bounded cleanup grace`);
      } catch {
        cleanupFallback.push(`${signal} delivery to the owned driver failed`);
      }
    }
    await Promise.race([child.exited.then(() => true), Bun.sleep(DRIVER_CLEANUP_GRACE_MS).then(() => false)]);
  }
  if (timer !== undefined) clearTimeout(timer);
  const collected = await Promise.race([
    Promise.all([stdoutPromise, stderrPromise]),
    Bun.sleep(DRIVER_CLEANUP_GRACE_MS).then(() => null),
  ]);
  if (collected === null) {
    cleanupFallback.push("diagnostic streams did not close within the bounded collection grace");
    return {
      stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0,
      stdoutTruncated: false, stderrTruncated: false,
      exitCode: child.exitCode ?? null,
      timedOut,
      cleanupFallback,
    };
  }
  return {
    stdout: collected[0].text,
    stderr: collected[1].text,
    stdoutBytes: collected[0].bytes,
    stderrBytes: collected[1].bytes,
    stdoutTruncated: collected[0].truncated,
    stderrTruncated: collected[1].truncated,
    exitCode: child.exitCode ?? null,
    timedOut,
    cleanupFallback,
  };
}

async function runCase(caseName: string, manifestPath: string): Promise<{ resultPath: string; status: string; checks: Array<{ id: string; ok: boolean; detail: string }> }> {
  const spec = CASE_SPECS[caseName];
  if (!spec) throw new Error(`unknown case ${caseName}`);
  const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8")) as NativeCorpus;
  const expectedBytes = await readFile(EXPECTED_PATH);
  const expected = JSON.parse(expectedBytes.toString("utf8")) as ExpectedOracle;
  expected.fixtureSha256 = sha256FileBytes(expectedBytes);
  const oracleSourceSha = expected.sourceSha256.startsWith("sha256:") ? expected.sourceSha256 : `sha256:${expected.sourceSha256}`;
  if (oracleSourceSha !== sha256FileBytes(await readFile(CORPUS_PATH))) throw new Error("the independent oracle does not match the frozen corpus");
  const { manifest } = await verifyManifest(manifestPath, caseName, REPO_ROOT);
  const { plan, runtimeRoot, evidenceRoot, caseDir } = await createPlan(caseName, spec, manifestPath, manifest, corpus);
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const missingEvidence: string[] = [];
  let firstMismatch: Record<string, any> | null = null;
  let expectedDocument: ExpectedDocument | null = null;
  let driverResult: Record<string, any> = {};
  let pythonPath = spec.daily ? acceptedPythonPath() : process.env.REVIEW_NATIVE_PYTHON;
  if (!pythonPath) pythonPath = Bun.which("python3") ?? undefined;
  if (!pythonPath) throw new Error("python3 is required for the PTY driver");
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let driverFailure: Record<string, any> | null = null;
  let driverProcess: Awaited<ReturnType<typeof runDriverBounded>> | null = null;
  try {
    driverProcess = await runDriverBounded(pythonPath, path.join(caseDir, "plan.json"), caseDir, spec.timeoutSeconds);
    await writeFile(path.join(evidenceRoot, "driver-stdout.txt"), driverProcess.stdout, { mode: 0o600 });
    await writeFile(path.join(evidenceRoot, "driver-stderr.txt"), driverProcess.stderr, { mode: 0o600 });
    if (driverProcess.timedOut) {
      driverFailure = {
        type: "DriverFailure",
        stage: "parent-deadline",
        message: `the parent supervisor deadline (${spec.timeoutSeconds}s + ${DRIVER_DEADLINE_GRACE_MS}ms grace) expired`,
        stdout: driverProcess.stdout.slice(0, 2000),
        stderr: driverProcess.stderr.slice(0, 4000),
      };
    } else if (driverProcess.stdoutTruncated || driverProcess.stderrTruncated) {
      driverFailure = {
        type: "DriverFailure",
        stage: "diagnostic-stream",
        message: `driver diagnostics exceeded the retained bound (stdout ${driverProcess.stdoutBytes} bytes, stderr ${driverProcess.stderrBytes} bytes)`,
      };
    } else {
      try {
        driverResult = JSON.parse(await readFile(path.join(evidenceRoot, "driver-result.json"), "utf8")) as Record<string, any>;
      } catch {
        driverFailure = { type: "DriverFailure", stage: "driver-result", message: `driver exit ${String(driverProcess.exitCode)} without a result`, stdout: driverProcess.stdout.slice(0, 2000), stderr: driverProcess.stderr.slice(0, 4000) };
      }
    }
  } catch (error) {
    driverFailure = { type: "DriverFailure", stage: "spawn", message: error instanceof Error ? error.message : String(error) };
  }
  if (driverResult.status !== "pass" && driverFailure === null) {
    driverFailure = driverResult.failure ?? { type: "DriverFailure", stage: "driver", message: "driver reported failure" };
  }
  checks.push(driverCheck("driver_status", driverFailure === null, driverFailure === null ? "driver completed" : JSON.stringify(driverFailure)));
  checks.push(driverCheck("driver_exit", driverProcess?.exitCode === 0 && driverProcess.timedOut === false, `exit=${String(driverProcess?.exitCode ?? null)} timedOut=${String(driverProcess?.timedOut ?? true)}`));
  checks.push(driverCheck("parent_cleanup_bounded", (driverProcess?.cleanupFallback.length ?? 1) === 0, JSON.stringify(driverProcess?.cleanupFallback ?? ["no parent supervisor result"])));
  const exit = driverResult.exit ?? {};
  checks.push(driverCheck("omp_exit", exit.code === 0 && exit.signal === null && exit.statusUnavailable !== true, `code=${String(exit.code)} signal=${String(exit.signal)} unavailable=${String(exit.statusUnavailable)}`));
  checks.push(driverCheck("omp_group_gone", exit.groupGone === true, `groupGone=${String(exit.groupGone)}`));
  checks.push(driverCheck("driver_fallback", Array.isArray(exit.fallback) && exit.fallback.length === 0, JSON.stringify(exit.fallback ?? [])));
  checks.push(driverCheck("cleanup_failure_absent", driverResult.cleanupFailure === null || driverResult.cleanupFailure === undefined, JSON.stringify(driverResult.cleanupFailure ?? null)));
  if (spec.daily) {
    const discovery = driverResult.pathDiscovery;
    checks.push(driverCheck(
      "daily_path_discovery",
      discovery?.ok === true,
      JSON.stringify(discovery ?? null),
    ));
  }
  const runFacts = Array.isArray(driverResult.runFacts) ? driverResult.runFacts as Array<Record<string, any>> : [];
  const identities = Array.isArray(driverResult.processIdentities) ? driverResult.processIdentities as Array<Record<string, any>> : [];
  checks.push(driverCheck("run_fact_count", spec.mode === "admission" ? runFacts.length === 0 : runFacts.length === 1, `${runFacts.length} run fact(s)`));
  for (const identity of identities) {
    checks.push(driverCheck(`run_identity_${String(identity.runId)}`, identity.pidGone === true && identity.groupGone === true && identity.watchdogGone === true, JSON.stringify(identity)));
    if (processAlive(Number(identity.pid), true) || processAlive(Number(identity.pid), false) || processAlive(Number(identity.watchdogPid), false)) {
      checks.push(driverCheck(`run_identity_live_${String(identity.runId)}`, false, "recorded script/watchdog identity is still alive"));
    }
  }
  try {
    const evidence = await loadNativeEvidence(evidenceRoot);
    const turns = evidence.provider.filter((event) => event.type === "provider_turn").length;
    checks.push(driverCheck("provider_request_bound", turns <= 12, `${turns} actual provider request(s)`));
    if (evidence.audit.some((event) => event.type === "harness_error" || event.type === "evidence_truncation" || event.type === "audit_overflow" || event.type === "audit_byte_limit")) {
      checks.push(driverCheck("observer_evidence_complete", false, "the observer reported a harness error, truncation or audit cap"));
    } else {
      checks.push(driverCheck("observer_evidence_complete", true, "no observer truncation or harness error"));
    }
    if (spec.mode === "admission") {
      checks.push(driverCheck("admission_no_provider", turns === 0, `${turns} provider request(s)`));
      checks.push(driverCheck("admission_no_acceptance", evidence.acceptance.size === 0, `${evidence.acceptance.size} acceptance file(s)`));
      checks.push(driverCheck("admission_no_task", evidence.owner.currentTask === null, `owner currentTask=${String(evidence.owner.currentTask?.taskId ?? null)}`));
      checks.push(driverCheck("admission_no_custom_surface", !evidence.audit.some((event) => event.type === "factory" || event.type === "custom_call"), "no custom review surface"));
      const starts = evidence.audit.filter((event) => event.type === "execute_call_start" && event.toolName === "agent_execute");
      const ends = evidence.audit.filter((event) => event.type === "execute_result_observed" && event.toolName === "agent_execute");
      checks.push(driverCheck("admission_no_execute_start", starts.length === 0, `${starts.length} actual readonly start(s)`));
      checks.push(driverCheck("admission_no_execute_terminal", ends.length === 0, `${ends.length} terminal event(s)`));
    } else {
      expectedDocument = buildExpectedDocument(evidence, corpus, expected, {
        expectedRelativePaths: corpus.files.map((file) => file.name),
        expectedRevisions: Array.from({ length: spec.revisions }, (_, index) => index + 1),
      });
      const frames = gradeFrames(evidence.audit, expectedDocument, caseName);
      checks.push(...frames.checks);
      if (frames.firstMismatch !== null) firstMismatch = frames.firstMismatch;
      const acceptance = gradeAcceptance(evidence, expectedDocument, caseName);
      checks.push(...acceptance);
      if (spec.daily) checks.push(...gradeDailyComposition(evidence, expectedDocument));
      if (caseName === "positive-no-contract" || caseName === "positive-partial-hybrid") {
        const baselineOk = acceptance.every((check) => check.ok)
          && frames.checks.every((check) => check.ok)
          && frames.firstMismatch === null;
        if (baselineOk) checks.push(...semanticMutationChecks(evidence, expectedDocument, caseName));
        else checks.push(driverCheck("mutation_selfchecks_skipped", false, "the captured positive evidence did not pass the unmodified grade"));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    missingEvidence.push(message);
    checks.push(driverCheck("oracle", false, message));
  }
  const stable = await (async () => {
    try {
      await verifyManifest(manifestPath, caseName, REPO_ROOT);
      return { ok: true, detail: "manifest and all required files still match" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  })();
  checks.push(driverCheck("source_stability_after", stable.ok, stable.detail));
  const failed = checks.filter((check) => !check.ok);
  const status = failed.length === 0 ? "pass" : "fail";
  const result = {
    schemaVersion: 1,
    case: caseName,
    provenance: "automated_terminal_input / engineering / no-human",
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    caseDir,
    source: {
      manifestPath: path.resolve(manifestPath),
      manifestSha256: await sha256Path(manifestPath),
      requiredFiles: (await requiredFilePaths(REPO_ROOT)).length,
      stableAfter: stable.ok,
    },
    driver: {
      status: driverResult.status ?? "unavailable",
      failure: driverFailure,
      exit,
      rawPty: driverResult.rawPty ?? null,
      inputs: driverResult.inputs ?? [],
      resizes: driverResult.resizes ?? [],
      runFacts,
      processIdentities: identities,
      cleanupFailure: driverResult.cleanupFailure ?? null,
      roots: driverResult.roots ?? null,
    },
    expected: expectedDocument === null ? null : {
      digest: expectedDocument.digest,
      renderedBytes: expectedDocument.renderedBytes,
      rawContentBytes: expectedDocument.rawContentBytes,
      fileCount: expectedDocument.fileCount,
      requirementRevisions: expectedDocument.requirementRevisions,
      expiresAt: expectedDocument.expiresAt,
    },
    checks,
    firstMismatch,
    missingEvidence,
    limitations: [
      "automated terminal input is engineering evidence, never genuine human approval",
      "raw ANSI/PTY bytes are not a screenshot or proof of visual readability",
      "the small-window unsupported layout is graded as a closed branch, not as complete evidence traversal",
    ],
    runtimeRetained: status !== "pass",
  };
  await writeFile(path.join(evidenceRoot, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  if (status === "pass") {
    try {
      await rm(runtimeRoot, { recursive: true, force: true });
    } catch (error) {
      result.status = "fail";
      result.runtimeRetained = true;
      result.checks.push(driverCheck("runtime_cleanup", false, error instanceof Error ? error.message : String(error)));
      await writeFile(path.join(evidenceRoot, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    }
  }
  return { resultPath: path.join(evidenceRoot, "result.json"), status: result.status, checks: result.checks };
}

export async function runSelectedCases(caseName: string, manifestPath: string, includeDeadline: boolean): Promise<{ status: string; results: Array<{ case: string; status: string; resultPath: string }> }> {
  const cases = caseName === "all"
    ? Object.keys(CASE_SPECS).filter((name) => name !== "daily-escape" && (includeDeadline || name !== "deadline-expiry"))
    : [caseName];
  const results: Array<{ case: string; status: string; resultPath: string }> = [];
  for (const name of cases) {
    const result = await runCase(name, manifestPath);
    results.push({ case: name, status: result.status, resultPath: result.resultPath });
    if (result.status !== "pass") break;
  }
  return { status: results.every((result) => result.status === "pass") ? "pass" : "fail", results };
}

export function planText(): string {
  const rows = Object.entries(CASE_SPECS).map(([name, spec]) => ({
    case: name,
    mode: spec.mode,
    extension: spec.extension,
    env: spec.env,
    providerMode: spec.providerMode,
    revisions: spec.revisions,
    initialSize: spec.initialSize,
    resize: spec.resize,
    timeoutSeconds: spec.timeoutSeconds,
  }));
  return JSON.stringify({
    status: "inert-plan",
    executeRequires: "--execute --manifest ROOT_AUTHORIZED_MANIFEST --case NAME",
    cases: rows,
    deadlineCase: "deadline-expiry requires explicit --case or --include-deadline with --case all",
  }, null, 2);
}

export async function describeRequired(): Promise<string> {
  const files = await requiredFilePaths(REPO_ROOT);
  const rows = [];
  for (const file of files) rows.push({ path: path.relative(REPO_ROOT, file), sha256: await sha256Path(file), bytes: (await lstat(file)).size });
  return JSON.stringify({ phase: "c2b-native-human-review", requiredFiles: rows }, null, 2);
}

export { REPO_ROOT, CORPUS_PATH, EXPECTED_PATH, DRIVER_PATH, PROVIDER_PATH, OBSERVER_PATH, HYBRID_PATH, TASK_ENTRY_PATH, EXPECTED_VERSION, PROVIDER, MODEL, API, hashJson, homedir };
