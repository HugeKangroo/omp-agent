import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { EXPECTED_OMP_VERSION, parseOmpVersion } from "./admission.ts";
import { exportB1Evidence } from "./b1-run.ts";
import {
  executionProcessIdentities,
  processAlive,
  snapshotTree,
  type DeliveryFileSnapshot,
} from "./delivery-run.ts";
import { RpcFrameDecoder, type Frame } from "./managed-run.ts";

/** Bounded real-OMP lifecycle for the B3-B2 single daily entry. */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const PROVIDER_PATH = path.join(REPO_ROOT, "test/fixtures/daily-provider.mjs");
const OBSERVER_PATH = path.join(REPO_ROOT, "test/fixtures/daily-observer.mjs");
const ENTRY_PATH = path.join(REPO_ROOT, "src/daily-entry.ts");
const PROVIDER = "daily-fixture";
const MODEL = "scripted";
const API = "daily-fixture-api";
const CLEANUP_IDENTITY_TIMEOUT_MS = 5_000;

/**
 * The product's default-deny seatbelt profile admits the CommandLineTools
 * Python framework only when the selected interpreter path names it. The
 * `/usr/bin/python3` xcrun shim instead loads libxcrun outside that allowlist,
 * so select the actual CommandLineTools or a real package-manager interpreter.
 */
function fixturePythonPath(): string {
  for (const candidate of [
    "/Library/Developer/CommandLineTools/usr/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  const which = Bun.which("python3");
  if (which !== null) return which;
  throw new Error("python3 is required for the daily fixture");
}

export const DAILY_MANAGED_TOOLS = [
  "agent_deliver",
  "agent_execute",
  "agent_history",
  "agent_task",
  "agent_verify",
] as const;

export const DAILY_NATIVE_BYTES = Buffer.from(
  "DAILY_NATIVE_NOTICE\nordinary synthetic file\nsecond visible line\n",
  "utf8",
);

export const DAILY_PROMPTS = {
  nativeRead: (file: string) => [
    "DAILY_NATIVE_READ: Read the synthetic ordinary file and report its actual visible text.",
    `file: ${file}`,
    "This is an ordinary request. Do not create a managed task and do not write any file.",
  ].join("\n"),
  taskA: "DAILY_TASK_A: Start one managed task from this ordinary request. Run the authorized alpha input through the fixed transformation, verify the real candidate, preview the real selected artifact, and attempt the host review action. Do not claim acceptance.",
  cancelA: "DAILY_CANCEL_A: This is an explicit user cancellation. Cancel the current managed task with its exact currently observed selector.",
  taskB: "DAILY_TASK_B: Start a distinct managed task from this ordinary request. Run its own fixed transformation, verify the real candidate, and preview its real selected artifact. Do not claim acceptance.",
  adversarial: "DAILY_ADVERSARIAL_OLD_SELECTOR: Explicit adversarial step. Replay task A's previously observed old selector against the current owner. It must not mutate or dispatch for task B.",
} as const;

export type DailyMode = "daily" | "baseline" | "invalid" | "missing-config";

export interface DailyRunOptions {
  mode: DailyMode;
  timeoutMs?: number;
  /** Native tool names from one zero-prompt provider-only baseline launch. */
  baselineTools?: string[];
  /** Absolute package/product directory; OMP reads package.json#omp.extensions. */
  entryDirectory?: string;
  /** Absolute product directory observed by the read-only port fixture. */
  productDirectory?: string;
  /** Absolute observer fixture path; defaults to the checkout daily observer. */
  observerPath?: string;
  /** Absolute selected-product task-entry-port.ts imported by the observer. */
  observerPortPath?: string;
  /** Isolated OMP profile name; defaults to "default" for legacy suites. */
  profile?: string;
}

export interface DailyInstance {
  instanceId: string;
  root: string;
  executionRoot: string;
  deliveryRoot: string;
  acceptanceRoot: string;
  statePath: string;
  auditPath: string;
}

export interface DailyStartResult {
  state: Frame;
  toolNames: string[];
  instance?: DailyInstance;
}

export interface DailyFailureRecord {
  sequence: number;
  attempt: string;
  instanceId: string | null;
  at: string;
  source: "process" | "test" | "cleanup";
  message: string;
}

export interface DailyShutdownFacts {
  observedAt: string;
  fallback: string[];
  processGroupGone: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  observerShutdown: boolean;
}

export interface DailyProcessCheck {
  instanceId: string;
  executionRoot: string;
  identities: Array<{ label: string; pid: number; group: boolean }>;
  alive: string[];
  error: string | null;
}

export interface DailyExportFacts {
  requestedRoot: string | null;
  attempted: boolean;
  target: string | null;
  complete: boolean | null;
  copied: string[];
  skipped: string[];
  error: string | null;
  ledgerError: string | null;
}

export interface DailyCleanupFacts {
  attemptId: string;
  mode: DailyMode;
  runtimeRoot: string;
  startedAt: string;
  finishedAt: string;
  completed: boolean;
  error: string | null;
  firstCause: string | null;
  failures: DailyFailureRecord[];
  process: {
    childPid: number | null;
    stdinClosed: boolean;
    signalsSent: string[];
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    processGroupGone: boolean;
    observerShutdown: boolean | null;
  };
  shutdown: DailyShutdownFacts | null;
  checks: DailyProcessCheck[];
  export: DailyExportFacts;
  /** Actual post-cleanup postcheck; null when the check itself failed. */
  runtimeExistsAfter: boolean | null;
  runtimeRetained: boolean | null;
  runtimeDeleted: boolean | null;
}

export interface DailyLifecycleFacts {
  attemptId: string;
  mode: DailyMode;
  runtimeRoot: string;
  cleanup: DailyCleanupFacts | null;
  failures: DailyFailureRecord[];
  firstCause: string | null;
}

interface DailyAttemptRecord {
  attempt: string;
  instanceId: string | null;
  stderr: string;
  failures: DailyFailureRecord[];
}

let dailyAttemptSequence = 0;
/** Fixture-side recording order across attempts; wallclock is not ordering evidence. */
let dailyFailureSequence = 0;

interface DailySessionValues {
  root: string;
  workspace: string;
  launchDir: string;
  homeDir: string;
  configHome: string;
  cacheHome: string;
  dataHome: string;
  stateHome: string;
  tempDir: string;
  agentDir: string;
  inputPath: string;
  nativeFilePath: string;
  ompConfigPath: string;
  dailyConfigPath: string | null;
  dailyStateRoot: string | null;
  providerAuditPath: string;
  observerAuditPath: string;
}

export class DailyOmpSession {
  readonly root: string;
  readonly workspace: string;
  readonly launchDir: string;
  readonly inputPath: string;
  readonly nativeFilePath: string;
  readonly dailyConfigPath: string | null;
  readonly dailyStateRoot: string | null;
  readonly providerAuditPath: string;
  readonly observerAuditPath: string;
  readonly mode: DailyMode;
  readonly timeoutMs: number;
  readonly frames: Frame[] = [];
  readonly requests: Frame[] = [];
  readonly priorFrames: Frame[] = [];
  readonly priorRequests: Frame[] = [];
  readonly knownInstanceIds = new Set<string>();
  readonly attemptId: string;
  toolNames: string[] = [];
  instance: DailyInstance | undefined;
  admitted = false;

  private readonly values: DailySessionValues;
  private readonly options: DailyRunOptions;
  private readonly attemptRecord: DailyAttemptRecord;
  private readonly priorAttempts: DailyAttemptRecord[] = [];
  private readonly priorInstances: DailyInstance[] = [];
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private decoder = new RpcFrameDecoder();
  private stderr = "";
  private failure: Error | undefined;
  private exited = false;
  private exitPromise: Promise<void> | undefined;
  private stopping = false;
  private sequence = 0;
  private admission: Frame | undefined;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private cleanupDone = false;
  private superseded = false;
  private lastShutdownFacts: DailyShutdownFacts | undefined;
  private cleanupFacts: DailyCleanupFacts | undefined;

  private constructor(values: DailySessionValues, options: DailyRunOptions) {
    this.values = values;
    this.options = options;
    this.attemptId = `attempt-${++dailyAttemptSequence}`;
    this.attemptRecord = {
      attempt: this.attemptId,
      instanceId: null,
      stderr: "",
      failures: [],
    };
    this.root = values.root;
    this.workspace = values.workspace;
    this.launchDir = values.launchDir;
    this.inputPath = values.inputPath;
    this.nativeFilePath = values.nativeFilePath;
    this.dailyConfigPath = values.dailyConfigPath;
    this.dailyStateRoot = values.dailyStateRoot;
    this.providerAuditPath = values.providerAuditPath;
    this.observerAuditPath = values.observerAuditPath;
    this.mode = options.mode;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  static async create(options: DailyRunOptions): Promise<DailyOmpSession> {
    const created = await mkdtemp(path.join(tmpdir(), "omp-agent-daily-"));
    try {
      return await DailyOmpSession.createAt(await realpath(created), options);
    } catch (error) {
      try {
        await rm(created, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new Error(
          `Daily setup failed: ${(error as Error).message}; cleanup failed: ${(cleanupError as Error).message}; retained ${created}`,
        );
      }
      throw error;
    }
  }

  private static async createAt(root: string, options: DailyRunOptions): Promise<DailyOmpSession> {
    const workspacePath = path.join(root, "workspace");
    const launchPath = path.join(root, "launch");
    const homePath = path.join(root, "home");
    const configHomePath = path.join(root, "config-home");
    const cacheHomePath = path.join(root, "cache-home");
    const dataHomePath = path.join(root, "data-home");
    const stateHomePath = path.join(root, "state-home");
    const tempPath = path.join(root, "tmp");
    const agentPath = path.join(root, "agent");
    for (const directory of [
      workspacePath, launchPath, homePath, configHomePath, cacheHomePath,
      dataHomePath, stateHomePath, tempPath, agentPath,
    ]) {
      await mkdir(directory, { mode: 0o700 });
    }
    const workspace = await realpath(workspacePath);
    const launchDir = await realpath(launchPath);
    const homeDir = await realpath(homePath);
    const configHome = await realpath(configHomePath);
    const cacheHome = await realpath(cacheHomePath);
    const dataHome = await realpath(dataHomePath);
    const stateHome = await realpath(stateHomePath);
    const tempDir = await realpath(tempPath);
    const agentDir = await realpath(agentPath);
    const inputPath = path.join(root, "authorized-input.txt");
    await writeFile(inputPath, "alpha native fixture\nsecond line\n", { mode: 0o600 });
    const nativeFilePath = path.join(workspace, "notice.txt");
    await writeFile(nativeFilePath, DAILY_NATIVE_BYTES, { mode: 0o600 });

    const ompConfigPath = path.join(root, "omp-config.json");
    await writeFile(ompConfigPath, JSON.stringify({
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
      extensionHandlers: { toolCallTimeoutMs: 30_000 },
      startup: { setupWizard: false, checkUpdate: false },
    }, null, 2), { mode: 0o600 });

    const absentConfig = options.mode === "baseline" || options.mode === "missing-config";
    const dailyConfigPath = absentConfig ? null : path.join(root, "daily-config.json");
    const dailyStateRoot = absentConfig ? null : path.join(root, "daily-state");
    if (options.mode === "daily") {
      const pythonPath = fixturePythonPath();
      await writeFile(dailyConfigPath!, JSON.stringify({
        schemaVersion: 1,
        workspaceRoot: workspace,
        stateRoot: dailyStateRoot,
        inputs: [{ id: "alpha", path: inputPath }],
        pythonPath,
        bunPath: process.execPath,
      }, null, 2), { mode: 0o600 });
    } else if (options.mode === "invalid") {
      // The state root and a foreign sentinel already exist. A failed config
      // load must not create, rewrite, reset or remove either one.
      await mkdir(path.join(dailyStateRoot!, "instances"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(dailyStateRoot!, "foreign-sentinel.txt"), "foreign sentinel must survive\n", { mode: 0o600 });
      await writeFile(dailyConfigPath!, JSON.stringify({
        schemaVersion: 2,
        workspaceRoot: workspace,
        stateRoot: dailyStateRoot,
        inputs: [{ id: "alpha", path: inputPath }],
      }, null, 2), { mode: 0o600 });
    }

    const providerAuditPath = path.join(root, "provider-audit.jsonl");
    const observerAuditPath = path.join(root, "observer-audit.jsonl");
    await writeFile(providerAuditPath, "", { mode: 0o600 });
    await writeFile(observerAuditPath, "", { mode: 0o600 });

    return new DailyOmpSession({
      root,
      workspace,
      launchDir,
      homeDir,
      configHome,
      cacheHome,
      dataHome,
      stateHome,
      tempDir,
      agentDir,
      inputPath,
      nativeFilePath,
      ompConfigPath,
      dailyConfigPath,
      dailyStateRoot,
      providerAuditPath,
      observerAuditPath,
    }, options);
  }

  /** Continue the same host config/root in a second real OMP process. */
  static async restartFrom(previous: DailyOmpSession): Promise<DailyOmpSession> {
    if (previous.mode !== "daily") {
      throw new Error("only a valid daily load can be restarted");
    }
    const providerAuditPath = path.join(previous.root, "provider-audit-restart.jsonl");
    const observerAuditPath = path.join(previous.root, "observer-audit-restart.jsonl");
    await writeFile(providerAuditPath, "", { mode: 0o600 });
    await writeFile(observerAuditPath, "", { mode: 0o600 });
    const next = new DailyOmpSession({
      ...previous.values,
      providerAuditPath,
      observerAuditPath,
    }, previous.options);
    for (const id of previous.knownInstanceIds) next.knownInstanceIds.add(id);
    if (previous.instance !== undefined) next.knownInstanceIds.add(previous.instance.instanceId);
    // Carry the first failure, every later diagnostic, attempt-tagged stderr and
    // each owned instance before the old session is retired, so a later
    // successful restart cannot erase the earlier failing evidence.
    next.priorFrames.push(...previous.priorFrames, ...previous.frames);
    next.priorRequests.push(...previous.priorRequests, ...previous.requests);
    next.priorAttempts.push(...previous.allAttempts());
    next.priorInstances.push(...previous.allInstances());
    previous.superseded = true;
    return next;
  }

  markFailure(error: unknown): void {
    this.recordFailure("test", error);
  }

  stderrText(): string {
    return this.combinedStderr();
  }

  private recordFailure(source: DailyFailureRecord["source"], error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.attemptRecord.failures.some((failure) => failure.source === source && failure.message === message)) {
      return;
    }
    this.attemptRecord.failures.push({
      sequence: ++dailyFailureSequence,
      attempt: this.attemptId,
      instanceId: this.attemptRecord.instanceId,
      at: new Date().toISOString(),
      source,
      message,
    });
  }

  private allAttempts(): DailyAttemptRecord[] {
    return [...this.priorAttempts, this.attemptRecord];
  }

  private allInstances(): DailyInstance[] {
    const instances = [...this.priorInstances];
    if (this.instance !== undefined) instances.push(this.instance);
    const seen = new Set<string>();
    return instances.filter((instance) => {
      if (seen.has(instance.instanceId)) return false;
      seen.add(instance.instanceId);
      return true;
    });
  }

  private allFailures(): DailyFailureRecord[] {
    return this.allAttempts()
      .flatMap((attempt) => attempt.failures)
      .sort((left, right) => left.sequence - right.sequence);
  }

  private firstCause(): string | undefined {
    return this.allFailures()[0]?.message ?? this.failure?.message;
  }

  private failureSummary(): string | undefined {
    const causes = this.allFailures().map((failure) =>
      `${failure.attempt}/${failure.instanceId ?? "unbound"}/${failure.source}: ${failure.message}`);
    return causes.length > 0 ? causes.join(" | ") : this.failure?.message;
  }

  private combinedStderr(): string {
    return this.allAttempts().map((attempt) => attempt.stderr).join("");
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "USER", "LOGNAME", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.HOME = this.values.homeDir;
    env.XDG_CONFIG_HOME = this.values.configHome;
    env.XDG_CACHE_HOME = this.values.cacheHome;
    env.XDG_DATA_HOME = this.values.dataHome;
    env.XDG_STATE_HOME = this.values.stateHome;
    env.TMPDIR = this.values.tempDir;
    env.TERM = "dumb";
    env.PI_CONFIG_DIR = ".omp";
    env.PI_CODING_AGENT_DIR = this.values.agentDir;
    env.PI_NO_TITLE = "1";
    env.PI_NO_PTY = "1";
    env.OMP_PROFILE = this.options.profile ?? "default";
    env.DAILY_PROVIDER_AUDIT = this.providerAuditPath;
    env.DAILY_PROVIDER_MODE = this.mode;
    env.DAILY_OBSERVER_AUDIT = this.observerAuditPath;
    env.PACKAGE_ENTRY_OBSERVER_AUDIT = this.observerAuditPath;
    if (this.options.observerPortPath !== undefined) {
      env.PACKAGE_ENTRY_PORT_PATH = this.options.observerPortPath;
    }
    if (this.options.productDirectory !== undefined) {
      env.PACKAGE_ENTRY_PRODUCT_DIR = this.options.productDirectory;
    }
    if (this.dailyConfigPath !== null) env.OMP_AGENT_CONFIG = this.dailyConfigPath;
    return env;
  }

  private args(): string[] {
    const args = [
      "--mode", "rpc", "--no-ui",
      "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-pty",
      "--no-session", "--no-title", "--no-prewalk", "--approval-mode", "yolo",
      "--config", this.values.ompConfigPath,
      "--model", `${PROVIDER}/${MODEL}`,
      "--thinking", "off",
      "--max-time", "120",
      "--max-cost", "0.1",
      "--cwd", this.workspace,
      "--extension", PROVIDER_PATH,
    ];
    if (this.mode !== "baseline") {
      args.push("--extension", this.options.entryDirectory ?? ENTRY_PATH);
    }
    args.push("--extension", this.options.observerPath ?? OBSERVER_PATH);
    return args;
  }

  private executable(): string {
    const requested = process.env.OMP_COMMAND || "omp";
    return requested.includes("/") ? path.resolve(requested) : requested;
  }

  async start(): Promise<DailyStartResult> {
    const version = spawnSync(this.executable(), ["--version"], {
      env: { PATH: process.env.PATH, HOME: homedir() },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8192,
    });
    if (version.error || version.status !== 0) {
      throw new Error(
        `OMP is unavailable: ${version.error?.message ?? `exit ${version.status}`}. Set OMP_COMMAND or install OMP ${EXPECTED_OMP_VERSION}.`,
      );
    }
    const actualVersion = parseOmpVersion(version.stdout);
    if (actualVersion !== EXPECTED_OMP_VERSION) {
      throw new Error(`OMP version mismatch: actual=${actualVersion} expected=${EXPECTED_OMP_VERSION}`);
    }
    const child = spawn(this.executable(), this.args(), {
      cwd: this.launchDir,
      env: this.env(),
      stdio: "pipe",
      detached: true,
      windowsHide: true,
    });
    this.child = child;
    this.attach(child);
    await this.waitFor(() => this.frames.some((frame) => frame.type === "ready"), "OMP ready", 15_000);
    await this.request("negotiate_protocol", { protocolVersion: 2 });
    const stateFrame = await this.request("get_state");
    const state = stateFrame.data as Frame;
    this.admission = state;
    const model = (state.model ?? {}) as Frame;
    if (model.provider !== PROVIDER || model.id !== MODEL || model.api !== API) {
      throw new Error(`Daily admission failed: actual=${String(model.provider)}/${String(model.id)}/${String(model.api)}`);
    }
    const dumpTools = Array.isArray(state.dumpTools) ? state.dumpTools as Array<{ name?: unknown }> : [];
    this.toolNames = dumpTools
      .map((tool) => typeof tool.name === "string" ? tool.name : "")
      .filter(Boolean)
      .sort();
    this.validateToolCatalog();
    await this.waitFor(
      async () => (await this.observerEvents()).some((event) => event.type === "session_start"),
      "daily observer session_start",
      10_000,
    );
    if (this.mode === "daily") {
      this.instance = await this.waitForInstance();
      this.attemptRecord.instanceId = this.instance.instanceId;
      const snapshot = await this.readState(this.instance);
      if (snapshot.tasksCreated !== 0 || snapshot.currentTask !== null) {
        throw new Error(`Daily admission failed: pre-prompt owner state is not empty: ${JSON.stringify({
          tasksCreated: snapshot.tasksCreated,
          currentTask: snapshot.currentTask,
        })}`);
      }
      const audit = await readFile(this.instance.auditPath, "utf8");
      if (!audit.includes(`"type":"daily_entry_ready"`)) {
        throw new Error("Daily admission failed: the product did not append daily_entry_ready.");
      }
      if (audit.includes(`"type":"task_tool_attempt"`) || audit.includes(`"type":"task_started"`)) {
        throw new Error("Daily admission failed: business task activity occurred before the first prompt.");
      }
    }
    await this.request("set_auto_retry", { enabled: false });
    await this.request("set_auto_compaction", { enabled: false });
    await this.request("set_cache_warming", { mode: "off" });
    await this.request("set_event_filter", {
      events: [
        "agent_start", "agent_end", "message_end", "tool_execution_start", "tool_execution_end",
        "extension_error", "notice", "prompt_result", "session_settled",
      ],
    });
    this.admitted = true;
    return {
      state,
      toolNames: [...this.toolNames],
      ...(this.instance === undefined ? {} : { instance: this.instance }),
    };
  }

  private validateToolCatalog(): void {
    if (new Set(this.toolNames).size !== this.toolNames.length) {
      throw new Error(`Daily admission failed: duplicate tool names ${this.toolNames.join(",")}`);
    }
    if (!this.toolNames.includes("read")) {
      throw new Error("Daily admission failed: the genuine native read tool is absent.");
    }
    const managed = DAILY_MANAGED_TOOLS.filter((name) => this.toolNames.includes(name));
    if (this.mode === "daily") {
      if (managed.length !== DAILY_MANAGED_TOOLS.length) {
        throw new Error(`Daily admission failed: managed tools missing; saw ${this.toolNames.join(",")}`);
      }
      if (this.options.baselineTools !== undefined) {
        const expected = [...new Set([...this.options.baselineTools, ...DAILY_MANAGED_TOOLS])].sort();
        if (JSON.stringify(this.toolNames) !== JSON.stringify(expected)) {
          throw new Error(
            `Daily admission failed: catalog is not baseline plus managed tools; actual=${this.toolNames.join(",")} expected=${expected.join(",")}`,
          );
        }
      }
    } else if (managed.length !== 0) {
      throw new Error(`Daily admission failed: managed tools are operative in ${this.mode} mode: ${managed.join(",")}`);
    }
  }

  private async waitForInstance(): Promise<DailyInstance> {
    const instancesRoot = path.join(this.dailyStateRoot!, "instances");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      let entries: Array<{ name: string; isDirectory(): boolean }> = [];
      try {
        entries = await readdir(instancesRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const candidates = entries
        .filter((entry) => entry.isDirectory() && !this.knownInstanceIds.has(entry.name))
        .map((entry) => entry.name);
      if (candidates.length > 1) {
        throw new Error(`Daily instance discovery saw more than one new instance: ${candidates.join(",")}`);
      }
      if (candidates.length === 1) {
        const instanceId = candidates[0]!;
        try {
          const root = await realpath(path.join(instancesRoot, instanceId));
          const instance: DailyInstance = {
            instanceId,
            root,
            executionRoot: await realpath(path.join(root, "execution")),
            deliveryRoot: await realpath(path.join(root, "delivery")),
            acceptanceRoot: await realpath(path.join(root, "acceptance")),
            statePath: path.join(root, "task-state.json"),
            auditPath: path.join(root, "audit.jsonl"),
          };
          const snapshot = await this.readState(instance);
          if (snapshot.schemaVersion === 1) {
            this.knownInstanceIds.add(instanceId);
            return instance;
          }
        } catch {
          // The product may still be completing startup.
        }
      }
      await Bun.sleep(25);
    }
    throw new Error(`Daily admission failed: no new product-created instance appeared under ${instancesRoot}`);
  }

  private async readState(instance: DailyInstance): Promise<Record<string, any>> {
    return JSON.parse(await readFile(instance.statePath, "utf8")) as Record<string, any>;
  }

  async state(): Promise<Record<string, any>> {
    if (this.instance === undefined) throw new Error("No daily instance is available.");
    return this.readState(this.instance);
  }

  /** Actual argv and environment key names used for this launch, without values. */
  launchDescriptor(): Record<string, unknown> {
    return {
      argv: this.args(),
      cwd: this.launchDir,
      environmentKeys: Object.keys(this.env()).sort(),
      model: `${PROVIDER}/${MODEL}`,
      api: API,
      mode: this.mode,
      profile: this.options.profile ?? "default",
      entryDirectory: this.options.entryDirectory ?? ENTRY_PATH,
      observerPath: this.options.observerPath ?? OBSERVER_PATH,
      observerPortPath: this.options.observerPortPath ?? null,
      productDirectory: this.options.productDirectory ?? null,
      dailyConfigPath: this.dailyConfigPath,
      workspace: this.workspace,
      timeoutMs: this.timeoutMs,
    };
  }

  async providerEvents(): Promise<Array<Record<string, any>>> {
    return this.jsonl(this.providerAuditPath);
  }

  async observerEvents(): Promise<Array<Record<string, any>>> {
    return this.jsonl(this.observerAuditPath);
  }

  async deliveryFiles(): Promise<DeliveryFileSnapshot[]> {
    if (this.instance === undefined) return [];
    return snapshotTree(this.instance.deliveryRoot);
  }

  async acceptanceFiles(): Promise<DeliveryFileSnapshot[]> {
    if (this.instance === undefined) return [];
    return snapshotTree(this.instance.acceptanceRoot);
  }

  async executionRecords(): Promise<Array<Record<string, any>>> {
    if (this.instance === undefined) return [];
    const records: Array<Record<string, any>> = [];
    let names: string[];
    try {
      names = await readdir(this.instance.executionRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return records;
      throw error;
    }
    for (const name of names.filter((entry) => entry.startsWith("run-")).sort()) {
      try {
        const record = JSON.parse(
          await readFile(path.join(this.instance.executionRoot, name, "record.json"), "utf8"),
        ) as Record<string, any>;
        records.push({ ...record, _directory: path.join(this.instance.executionRoot, name) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return records;
  }

  async instanceTree(instance = this.instance): Promise<DeliveryFileSnapshot[]> {
    if (instance === undefined) return [];
    return snapshotTree(instance.root);
  }

  async snapshot(): Promise<Record<string, unknown>> {
    return {
      mode: this.mode,
      frames: [...this.frames],
      requests: [...this.requests],
      admission: this.admission,
      toolNames: [...this.toolNames],
      instance: this.instance ?? null,
      providerEvents: await this.providerEvents(),
      observerEvents: await this.observerEvents(),
      state: this.instance === undefined ? null : await this.state(),
      executionRecords: await this.executionRecords(),
      deliveryFiles: await this.deliveryFiles(),
      acceptanceFiles: await this.acceptanceFiles(),
      stderr: this.combinedStderr(),
    };
  }

  async prompt(message: string): Promise<Frame> {
    if (this.mode === "baseline") throw new Error("The zero-prompt baseline must not receive a business prompt.");
    if (!this.admitted) throw new Error("Refusing to send a business prompt before daily admission.");
    const id = `daily-prompt-${++this.sequence}`;
    const startIndex = this.frames.length;
    const observerIndex = (await this.observerEvents()).length;
    const startedAt = Date.now();
    this.send({ type: "prompt", id, message });
    await this.waitFor(
      () => this.frames.some((frame) => frame.type === "response" && frame.id === id),
      "prompt acknowledgement",
      10_000,
    );
    const acknowledgement = this.frames.find((frame) => frame.type === "response" && frame.id === id)!;
    if (acknowledgement.success !== true) throw new Error(`OMP rejected prompt: ${String(acknowledgement.error)}`);
    await this.waitFor(() => this.result(id, startIndex) !== undefined, `prompt_result ${id}`, this.timeoutMs);
    const result = this.result(id, startIndex)!;
    if (result.frame.status !== "completed") {
      throw new Error(`OMP prompt ${id} failed: ${JSON.stringify(result.frame.error ?? result.frame)}`);
    }
    if (result.frame.agentInvoked !== true) throw new Error(`OMP prompt ${id} did not invoke an agent.`);
    const failure = this.providerFailure(startIndex, result.index);
    if (failure !== undefined) throw new Error(`OMP prompt ${id} saw a provider failure: ${failure}`);
    await this.waitFor(
      () => result.frame.sessionSettled === true
        || this.frames.some((frame, index) => index > result.index && frame.type === "session_settled"),
      `session_settled after ${id}`,
      Math.max(1, this.timeoutMs - (Date.now() - startedAt)),
    );
    await this.waitFor(
      async () => (await this.observerEvents()).slice(observerIndex).some((event) => event.type === "agent_end"),
      `daily observer agent_end after ${id}`,
      10_000,
    );
    await Bun.sleep(100);
    return result.frame;
  }

  async shutdown(): Promise<{
    fallback: string[];
    processGroupGone: boolean;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    observerShutdown: boolean;
  }> {
    const fallback: string[] = [];
    const child = this.child;
    if (!child) throw new Error("Daily session was never started.");
    this.stopping = true;
    if (!this.exited) {
      try { child.stdin.end(); } catch { /* already closed */ }
      await Promise.race([this.exitPromise, Bun.sleep(3000)]);
    }
    if (!this.exited) {
      fallback.push("OMP did not exit after the RPC stdin EOF");
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (!this.groupExists()) break;
        try { process.kill(-child.pid!, signal); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await Promise.race([this.exitPromise, Bun.sleep(1000)]);
      }
    }
    if (!this.exited) throw new Error("OMP did not exit after SIGKILL.");
    const result = {
      fallback,
      processGroupGone: !this.groupExists(),
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      observerShutdown: (await this.observerEvents()).some((event) => event.type === "session_shutdown"),
    };
    this.lastShutdownFacts = { observedAt: new Date().toISOString(), ...result };
    return result;
  }

  /** Actual final lifecycle facts; the cleanup block is null until cleanup ran. */
  finalFacts(): DailyLifecycleFacts {
    return {
      attemptId: this.attemptId,
      mode: this.mode,
      runtimeRoot: this.root,
      cleanup: this.cleanupFacts ?? null,
      failures: this.allFailures(),
      firstCause: this.firstCause() ?? null,
    };
  }

  async cleanup(): Promise<void> {
    if (this.cleanupDone || this.superseded) return;
    this.cleanupDone = true;
    this.stopping = true;
    const startedAt = new Date().toISOString();
    const child = this.child;
    const failures: string[] = [];
    const signalsSent: string[] = [];
    let stdinClosed = false;
    if (child) {
      try {
        try { child.stdin.end(); stdinClosed = true; } catch { /* closed */ }
        if (this.exitPromise) await Promise.race([this.exitPromise, Bun.sleep(1000)]);
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          if (!this.groupExists()) break;
          try {
            process.kill(-child.pid!, signal);
            signalsSent.push(signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          const deadline = Date.now() + 1000;
          while (this.groupExists() && Date.now() < deadline) await Bun.sleep(20);
        }
        if (this.groupExists()) failures.push("OMP process group did not exit after SIGKILL");
      } catch (error) {
        failures.push(`OMP shutdown failed: ${(error as Error).message}`);
      }
    }
    const checks: DailyProcessCheck[] = [];
    if (this.mode === "daily") {
      // Every instance this owned chain actually created, including instances
      // from a superseded attempt, must provide real execution/watchdog
      // identity evidence before any shared root can be removed.
      for (const instance of this.allInstances()) {
        try {
          const identities = await executionProcessIdentities(
            instance.executionRoot,
            instance.auditPath,
          );
          const alive = await this.waitForIdentitiesGone(identities);
          checks.push({
            instanceId: instance.instanceId,
            executionRoot: instance.executionRoot,
            identities,
            alive,
            error: null,
          });
          if (alive.length > 0) {
            failures.push(`test-owned processes still alive in ${instance.instanceId}: ${alive.join(", ")}`);
          }
        } catch (error) {
          checks.push({
            instanceId: instance.instanceId,
            executionRoot: instance.executionRoot,
            identities: [],
            alive: [],
            error: (error as Error).message,
          });
          failures.push(`process evidence unavailable for ${instance.instanceId}: ${(error as Error).message}`);
        }
      }
    }
    let observerShutdown: boolean | null = null;
    try {
      observerShutdown = (await this.observerEvents()).some((event) => event.type === "session_shutdown");
    } catch {
      observerShutdown = null;
    }
    for (const failure of failures) this.recordFailure("cleanup", failure);
    const reason = this.failureSummary();
    let removeRoot = reason === undefined && failures.length === 0;
    const requestedRoot = process.env.OMP_AGENT_DAILY_EVIDENCE_ROOT ?? null;
    const exportFacts: DailyExportFacts = {
      requestedRoot,
      attempted: false,
      target: null,
      complete: null,
      copied: [],
      skipped: [],
      error: null,
      ledgerError: null,
    };
    let exportTarget: string | null = null;
    if (reason !== undefined) {
      if (requestedRoot === null || !path.isAbsolute(requestedRoot)) {
        removeRoot = false;
        const message = "no absolute OMP_AGENT_DAILY_EVIDENCE_ROOT";
        exportFacts.error = message;
        this.appendStderr(`\n[daily-evidence] ${message}; preserving ${this.root}\n`);
      } else {
        exportFacts.attempted = true;
        try {
          const exported = await this.exportEvidence(requestedRoot, reason);
          exportTarget = exported.target;
          exportFacts.target = exported.target;
          exportFacts.complete = exported.complete;
          exportFacts.copied = exported.copied;
          exportFacts.skipped = exported.skipped;
          if (!exported.complete) {
            removeRoot = false;
            const message = `incomplete export; preserving ${this.root}`;
            failures.push(message);
            exportFacts.error = message;
            this.recordFailure("cleanup", message);
            this.appendStderr(`\n[daily-evidence] ${message}\n`);
          }
        } catch (error) {
          removeRoot = false;
          const attached = (error as { exportTarget?: unknown }).exportTarget;
          if (typeof attached === "string") exportTarget = attached;
          exportFacts.target = exportTarget;
          const message = `export failed (${(error as Error).message}); preserving ${this.root}`;
          failures.push(message);
          exportFacts.error = message;
          this.recordFailure("cleanup", message);
          this.appendStderr(`\n[daily-evidence] ${message}\n`);
        }
      }
    }
    if (!removeRoot) {
      console.error(`[daily-evidence] preserved ${this.root}; causes: ${(reason ?? "").slice(0, 4000)}`);
    } else {
      try {
        await rm(this.root, { recursive: true, force: true });
      } catch (error) {
        removeRoot = false;
        const message = `runtime removal failed (${(error as Error).message}); retaining ${this.root}`;
        failures.push(message);
        this.recordFailure("cleanup", message);
        this.appendStderr(`\n[daily-evidence] ${message}\n`);
      }
    }
    let runtimeExistsAfter: boolean | null = null;
    try {
      await stat(this.root);
      runtimeExistsAfter = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        runtimeExistsAfter = false;
      } else {
        const message = `runtime postcheck failed: ${(error as Error).message}`;
        failures.push(message);
        this.recordFailure("cleanup", message);
        this.appendStderr(`\n[daily-evidence] ${message}\n`);
      }
    }
    const facts: DailyCleanupFacts = {
      attemptId: this.attemptId,
      mode: this.mode,
      runtimeRoot: this.root,
      startedAt,
      finishedAt: new Date().toISOString(),
      completed: failures.length === 0,
      error: failures.length > 0 ? failures.join("; ") : null,
      firstCause: this.firstCause() ?? null,
      failures: [],
      process: {
        childPid: child?.pid ?? null,
        stdinClosed,
        signalsSent,
        exitCode: this.exitCode,
        exitSignal: this.exitSignal,
        processGroupGone: !this.groupExists(),
        observerShutdown,
      },
      shutdown: this.lastShutdownFacts ?? null,
      checks,
      export: exportFacts,
      runtimeExistsAfter,
      runtimeRetained: runtimeExistsAfter,
      runtimeDeleted: runtimeExistsAfter === null ? null : !runtimeExistsAfter,
    };
    facts.failures = this.allFailures();
    facts.firstCause = this.firstCause() ?? null;
    facts.completed = failures.length === 0;
    facts.error = failures.length > 0 ? failures.join("; ") : null;
    this.cleanupFacts = facts;
    if (exportTarget !== null) {
      try {
        await this.writeFinalExportLedger(exportTarget);
      } catch (error) {
        const message = `final export ledger write failed (${(error as Error).message})`;
        failures.push(message);
        exportFacts.ledgerError = message;
        this.recordFailure("cleanup", message);
        this.appendStderr(`\n[daily-evidence] ${message}\n`);
      }
    }
    // Refresh after any late cleanup diagnostic so the in-memory final facts
    // never lose the last cause.
    facts.failures = this.allFailures();
    facts.firstCause = this.firstCause() ?? null;
    facts.completed = failures.length === 0;
    facts.error = failures.length > 0 ? failures.join("; ") : null;
    this.cleanupFacts = facts;
    if (failures.length > 0) {
      throw new Error(
        `Daily cleanup failed; retaining ${this.root}: ${failures.join("; ")}`
        + (this.firstCause() === undefined ? "" : `; first retained cause: ${this.firstCause()}`),
      );
    }
  }

  private appendStderr(text: string): void {
    this.stderr = `${this.stderr}${text}`.slice(-65536);
    this.attemptRecord.stderr = `${this.attemptRecord.stderr}${text}`.slice(-65536);
  }

  private async exportEvidence(evidenceRoot: string, reason: string): Promise<{ complete: boolean; target: string; copied: string[]; skipped: string[] }> {
    const exported = await exportB1Evidence({
      sourceRoot: this.root,
      evidenceRoot,
      scenario: `daily-${this.mode}`,
      reason,
      frames: [...this.priorFrames, ...this.frames],
      stderr: this.combinedStderr(),
      pid: this.child?.pid ?? null,
    });
    try {
      await writeFile(
        path.join(exported.target, "attempts.json"),
        JSON.stringify({
          phase: "export-attempt",
          capturedAt: new Date().toISOString(),
          firstCause: this.firstCause() ?? null,
          attempts: this.allAttempts(),
          instances: this.allInstances(),
        }, null, 2),
        { mode: 0o600 },
      );
      await writeFile(path.join(exported.target, "requests.json"), JSON.stringify(
        [...this.priorRequests, ...this.requests],
        null,
        2,
      ), { mode: 0o600 });
      await writeFile(path.join(exported.target, "launch.json"), JSON.stringify({
        argv: this.args(),
        cwd: this.launchDir,
        environmentKeys: Object.keys(this.env()).sort(),
        isolation: {
          home: this.values.homeDir,
          agentDir: this.values.agentDir,
          xdgConfig: this.values.configHome,
          xdgCache: this.values.cacheHome,
          xdgData: this.values.dataHome,
          xdgState: this.values.stateHome,
          tmp: this.values.tempDir,
        },
        model: `${PROVIDER}/${MODEL}`,
        api: API,
        timeoutMs: this.timeoutMs,
        dailyConfigPath: this.dailyConfigPath,
        toolNames: this.toolNames,
        instance: this.instance ?? null,
      }, null, 2), { mode: 0o600 });
      await writeFile(
        path.join(exported.target, "fixture-manifest.json"),
        JSON.stringify(await dailyFixtureManifest(), null, 2),
        { mode: 0o600 },
      );
      return exported;
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        Object.defineProperty(error, "exportTarget", {
          value: exported.target,
          configurable: true,
          enumerable: false,
        });
      }
      throw error;
    }
  }

  /**
   * Rewrite the exported attempts ledger after cleanup/export attempts finish.
   * The earlier export-attempt ledger remains embedded so the pre-cleanup
   * snapshot stays identifiable.
   */
  private async writeFinalExportLedger(target: string): Promise<void> {
    const facts = this.cleanupFacts;
    if (facts === undefined) throw new Error("final export ledger requested before cleanup facts were assembled");
    let initialExportAttempts: unknown = null;
    try {
      initialExportAttempts = JSON.parse(await readFile(path.join(target, "attempts.json"), "utf8"));
    } catch {
      initialExportAttempts = null;
    }
    await writeFile(
      path.join(target, "attempts.json"),
      JSON.stringify({
        phase: "post-cleanup",
        firstCause: facts.firstCause,
        attempts: this.allAttempts(),
        instances: this.allInstances(),
        cleanup: facts,
      }, null, 2),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(target, "final-ledger.json"),
      JSON.stringify({
        phase: "post-cleanup",
        writtenAt: new Date().toISOString(),
        runtimeRoot: this.root,
        initialExportAttempts,
        cleanup: facts,
      }, null, 2),
      { mode: 0o600 },
    );
  }

  private async waitForIdentitiesGone(
    identities: Array<{ label: string; pid: number; group: boolean }>,
  ): Promise<string[]> {
    const deadline = Date.now() + CLEANUP_IDENTITY_TIMEOUT_MS;
    while (true) {
      const alive = identities
        .filter((identity) => processAlive(identity.pid, identity.group))
        .map((identity) => `${identity.label} pid=${identity.pid}`);
      if (alive.length === 0 || Date.now() >= deadline) return alive;
      await Bun.sleep(20);
    }
  }

  private async jsonl(filePath: string): Promise<Array<Record<string, any>>> {
    try {
      return (await readFile(filePath, "utf8"))
        .split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private result(id: string, startIndex: number): { frame: Frame; index: number } | undefined {
    for (let index = startIndex; index < this.frames.length; index += 1) {
      const frame = this.frames[index]!;
      if (frame.type === "prompt_result" && frame.id === id) return { frame, index };
    }
    return undefined;
  }

  private providerFailure(startIndex: number, endIndex: number): string | undefined {
    for (let index = startIndex; index <= endIndex; index += 1) {
      const frame = this.frames[index]!;
      if (frame.type === "error") return JSON.stringify(frame.error ?? frame);
      if (frame.type === "extension_error") return JSON.stringify(frame.error ?? frame);
      const messages = frame.type === "agent_end" && Array.isArray(frame.messages)
        ? frame.messages
        : frame.type === "message_end" ? [frame.message] : [];
      for (const message of messages) {
        if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
        const record = message as Frame;
        if (record.role === "assistant" && record.stopReason === "error") {
          return String(record.errorMessage ?? "assistant stopped with an error");
        }
      }
    }
    return undefined;
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    const utf8 = new TextDecoder();
    child.stdout.on("data", (bytes: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, bytes]);
        let end: number;
        while ((end = this.buffer.indexOf(10)) !== -1) {
          const line = this.buffer.subarray(0, end);
          this.buffer = this.buffer.subarray(end + 1);
          if (!line.length) continue;
          const frame = this.decoder.decode(utf8.decode(line, { stream: false }));
          if (frame) this.frames.push(frame);
        }
        if (this.buffer.length > 1024 * 1024) throw new Error("Unfinished OMP RPC frame exceeds 1 MiB.");
      } catch (error) {
        this.fail(error as Error);
      }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      this.appendStderr(bytes.toString("utf8"));
    });
    child.on("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => { if (!this.stopping) this.fail(error); });
    this.exitPromise = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        this.exited = true;
        this.exitCode = code;
        this.exitSignal = signal;
        try {
          this.decoder.finish();
        } catch (error) {
          if (!this.stopping) this.fail(error as Error);
        }
        if (!this.stopping) this.fail(new Error("OMP exited before the daily test completed."));
        resolve();
      });
    });
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.recordFailure("process", error);
  }

  private send(frame: Frame): void {
    if (this.failure) throw this.failure;
    if (!this.child || this.exited) throw new Error("OMP process is not running.");
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Outbound RPC frame exceeds 1 MiB.");
    this.requests.push(frame);
    this.child.stdin.write(line);
  }

  private async request(type: string, data: Frame = {}): Promise<Frame> {
    const id = `daily-rpc-${++this.sequence}`;
    this.send({ ...data, type, id });
    await this.waitFor(() => this.frames.some((frame) => frame.type === "response" && frame.id === id), `${type} response`, 10_000);
    const response = this.frames.find((frame) => frame.type === "response" && frame.id === id)!;
    if (response.success !== true) throw new Error(`OMP ${type} failed: ${String(response.error || "unknown error")}`);
    return response;
  }

  private async waitFor(
    predicate: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!await predicate()) {
      if (this.failure || this.exited) {
        throw new Error(`${label}: ${this.failure?.message ?? "OMP exited"}\n${this.stderr}\n${JSON.stringify(this.frames.slice(-8))}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`${label}: timed out\n${this.stderr}\n${JSON.stringify(this.frames.slice(-8))}`);
      }
      await Bun.sleep(10);
    }
  }

  private groupExists(): boolean {
    if (!this.child?.pid) return false;
    return processAlive(this.child.pid, true);
  }
}

async function dailyFixtureManifest(): Promise<Record<string, unknown>> {
  const files = [
    "test/fixtures/daily-provider.mjs",
    "test/fixtures/daily-observer.mjs",
    "test/harness/daily-run.ts",
    "test/omp-daily.test.ts",
    "scripts/test-daily.ts",
    "src/daily-entry.ts",
    "src/daily-config.ts",
  ];
  const rows: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const relative of files) {
    const absolute = path.join(REPO_ROOT, relative);
    try {
      const bytes = await readFile(absolute);
      rows.push({
        path: relative,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        bytes: bytes.byteLength,
      });
    } catch (error) {
      rows.push({ path: relative, sha256: `missing:${String(error)}`, bytes: 0 });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    files: rows,
    note: "Fixture-side manifest only; root's frozen product manifest remains authoritative.",
  };
}
