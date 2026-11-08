import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { EXPECTED_OMP_VERSION, parseOmpVersion } from "./admission.ts";
import { RpcFrameDecoder, type Frame } from "./managed-run.ts";

/** Bounded real-OMP lifecycle for the native delivery regression. */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const PROVIDER_PATH = path.join(REPO_ROOT, "test/fixtures/delivery-provider.mjs");
const HOST_PATH = path.join(REPO_ROOT, "test/fixtures/delivery-host.mjs");
const TASK_ENTRY_PATH = path.join(REPO_ROOT, "src/task-entry.ts");
const PROVIDER = "delivery-fixture";
const MODEL = "scripted";
const API = "delivery-fixture-api";
const EXPECTED_TOOLS = ["agent_deliver", "agent_execute", "agent_task", "agent_verify"];
const CLEANUP_IDENTITY_TIMEOUT_MS = 5_000;
const MAX_EVIDENCE_RUNS = 16;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const PROVEN_NO_SPAWN_AUDIT_EVENTS = new Set([
  "execution_preparation_failed",
  "execution_aborted_before_spawn",
  "execution_revoked_before_spawn",
  "execution_not_dispatched_record_failed",
]);
const SPAWN_AUDIT_EVENTS = new Set([
  "execution_process_settled",
  "execution_completed",
  "execution_completion_unconfirmed",
  "execution_record_write_failed",
  "execution_owner_stop",
  "execution_candidate_registration_failed",
  "execution_artifacts_exported",
]);

export interface OwnedProcessIdentity {
  label: string;
  pid: number;
  group: boolean;
}

/**
 * Reusable actual process identity evidence for a bounded execution root.
 * Reads only retained run records and the execution audit; a run without
 * complete identity evidence is refused rather than guessed.
 */
export async function executionProcessIdentities(
  executionRoot: string,
  executionAuditPath: string,
): Promise<OwnedProcessIdentity[]> {
  const identities: OwnedProcessIdentity[] = [];
  const seen = new Set<string>();
  const add = (label: string, pid: number, group: boolean): void => {
    const key = `${group ? "group" : "pid"}:${pid}`;
    if (seen.has(key)) return;
    seen.add(key);
    identities.push({ label, pid, group });
  };

  const entries = await readdir(executionRoot);
  const runs = entries.filter((name) => name.startsWith("run-")).sort();
  if (runs.length > MAX_EVIDENCE_RUNS) {
    throw new Error(`execution run evidence exceeds ${MAX_EVIDENCE_RUNS} runs`);
  }
  const readEvidence = async (filePath: string, label: string): Promise<string> => {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file`);
    if (info.size > MAX_EVIDENCE_BYTES) throw new Error(`${label} exceeds ${MAX_EVIDENCE_BYTES} bytes`);
    return readFile(filePath, "utf8");
  };
  const auditText = await readEvidence(executionAuditPath, "execution audit");
  const audit = auditText.split("\n").filter(Boolean).map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`execution audit line ${index + 1} is not valid JSON`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`execution audit line ${index + 1} is not an object`);
    }
    return value as Record<string, unknown>;
  });
  const runAudit = new Map<string, string[]>();
  for (const event of audit) {
    if (typeof event.runId !== "string") continue;
    const types = runAudit.get(event.runId) ?? [];
    types.push(String(event.type));
    runAudit.set(event.runId, types);
  }

  const recordedRuns = new Set<string>();
  for (const name of runs) {
    const text = await readEvidence(path.join(executionRoot, name, "record.json"), `${name}/record.json`);
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${name}/record.json is not valid JSON`);
    }
    if (typeof record.runId !== "string" || record.runId.length === 0) {
      throw new Error(`${name}/record.json has no run identity`);
    }
    recordedRuns.add(record.runId);
    const phase = String(record.phase);
    const process = record.process;
    if (process === null) {
      if (phase === "not_dispatched") continue;
      throw new Error(`${name} is ${phase} with no process evidence`);
    }
    if (typeof process !== "object" || process === null || Array.isArray(process)) {
      throw new Error(`${name} has malformed process evidence`);
    }
    const dispatch = process as Record<string, unknown>;
    if (dispatch.spawned === false) {
      if (dispatch.pid !== null || dispatch.pgid !== null) {
        throw new Error(`${name} has a pid without a spawn`);
      }
      continue;
    }
    if (dispatch.spawned !== true) {
      throw new Error(`${name} has no spawn disposition`);
    }
    const pid = dispatch.pid;
    const pgid = dispatch.pgid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 1 || !Number.isSafeInteger(pgid) || pgid !== pid) {
      throw new Error(`${name} has malformed script identity`);
    }
    add(`${name} script group`, pgid as number, true);
    add(`${name} script`, pid as number, false);

    const watchdog = dispatch.watchdog ?? record.watchdog;
    if (typeof watchdog !== "object" || watchdog === null || Array.isArray(watchdog)) {
      throw new Error(`${name} has malformed watchdog evidence`);
    }
    const facts = watchdog as Record<string, unknown>;
    // A spawned execution may fork its watcher before the handshake lands.
    // Unarmed or missing handshake evidence therefore does not prove that no
    // watcher exists, so refuse to treat it as a no-watcher disposition.
    if (facts.armed !== true) {
      throw new Error(`${name} has no verified armed watchdog identity; evidence is insufficient to prove no watcher forked`);
    }
    const watchdogPid = facts.watchdogPid;
    if (!Number.isSafeInteger(watchdogPid) || (watchdogPid as number) <= 1
      || watchdogPid === pid || watchdogPid === pgid) {
      throw new Error(`${name} has malformed watchdog identity`);
    }
    add(`${name} watchdog`, watchdogPid as number, false);
  }

  for (const [runId, types] of runAudit) {
    if (recordedRuns.has(runId)) continue;
    const provenNoSpawn = types.some((type) => PROVEN_NO_SPAWN_AUDIT_EVENTS.has(type));
    const spawnEvidence = types.some((type) => SPAWN_AUDIT_EVENTS.has(type));
    if (!provenNoSpawn || spawnEvidence) {
      throw new Error(`execution audit references ${runId} without retained run evidence`);
    }
  }
  return identities;
}

export const DELIVERY_PROMPT = "Generate answer.txt from the authorized input, verify its actual bytes, preview the host delivery, and submit only when the configured host contract is complete.";
export const ANSWER_PREFIX = Buffer.from("DELIVERY_OK\n", "utf8");

export type DeliveryMode = "full" | "partial" | "delivery-only";

export interface DeliveryFileSnapshot {
  path: string;
  relativePath: string;
  bytes: number;
  sha256: string;
  ino: number;
  dev: number;
  mtimeMs: number;
  nlink: number;
  mode: number;
  text: string;
}

export function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function snapshotTree(root: string): Promise<DeliveryFileSnapshot[]> {
  const rows: DeliveryFileSnapshot[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5) throw new Error("delivery test snapshot depth bound exceeded");
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error("delivery test snapshot refuses symlink");
      if (info.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!info.isFile() || rows.length >= 64 || info.size > 1024 * 1024) {
        throw new Error("delivery test snapshot file bound exceeded");
      }
      const bytes = await readFile(full);
      rows.push({
        path: full,
        relativePath: path.relative(root, full),
        bytes: bytes.length,
        sha256: sha256(bytes),
        ino: info.ino,
        dev: info.dev,
        mtimeMs: info.mtimeMs,
        nlink: info.nlink,
        mode: info.mode & 0o777,
        text: bytes.toString("utf8"),
      });
    }
  };
  await walk(root, 0);
  return rows;
}

export function processAlive(pid: number, group = false): boolean {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export interface DeliveryRunOptions {
  mode: DeliveryMode;
  timeoutMs?: number;
}

export class DeliveryOmpSession {
  readonly root: string;
  readonly workspace: string;
  readonly agentDir: string;
  readonly executionRoot: string;
  readonly deliveryRoot: string;
  readonly acceptanceRoot: string | null;
  readonly inputPath: string;
  readonly statePath: string;
  readonly b1AuditPath: string;
  readonly executionAuditPath: string;
  readonly fixtureAuditPath: string;
  readonly configPath: string;
  readonly mode: DeliveryMode;
  readonly frames: Frame[] = [];

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
  admitted = false;

  private constructor(values: {
    root: string;
    workspace: string;
    agentDir: string;
    executionRoot: string;
    deliveryRoot: string;
    acceptanceRoot: string | null;
    inputPath: string;
    statePath: string;
    b1AuditPath: string;
    executionAuditPath: string;
    fixtureAuditPath: string;
    configPath: string;
  }, options: DeliveryRunOptions) {
    this.root = values.root;
    this.workspace = values.workspace;
    this.agentDir = values.agentDir;
    this.executionRoot = values.executionRoot;
    this.deliveryRoot = values.deliveryRoot;
    this.acceptanceRoot = values.acceptanceRoot;
    this.inputPath = values.inputPath;
    this.statePath = values.statePath;
    this.b1AuditPath = values.b1AuditPath;
    this.executionAuditPath = values.executionAuditPath;
    this.fixtureAuditPath = values.fixtureAuditPath;
    this.configPath = values.configPath;
    this.mode = options.mode;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private readonly timeoutMs: number;

  static async create(options: DeliveryRunOptions): Promise<DeliveryOmpSession> {
    const created = await mkdtemp(path.join(tmpdir(), "omp-agent-delivery-"));
    try {
      return await DeliveryOmpSession.createAt(await realpath(created), options);
    } catch (error) {
      try {
        await rm(created, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new Error(`Delivery setup failed: ${(error as Error).message}; cleanup failed: ${(cleanupError as Error).message}; retained ${created}`);
      }
      throw error;
    }
  }

  private static async createAt(root: string, options: DeliveryRunOptions): Promise<DeliveryOmpSession> {
    const workspacePath = path.join(root, "workspace");
    const agentPath = path.join(root, "agent");
    const executionPath = path.join(root, "execution");
    const deliveryPath = path.join(root, "delivery");
    const acceptancePath = path.join(root, "acceptance");
    await mkdir(workspacePath, { mode: 0o700 });
    await mkdir(agentPath, { mode: 0o700 });
    await mkdir(executionPath, { mode: 0o700 });
    await mkdir(deliveryPath, { mode: 0o700 });
    if (options.mode !== "delivery-only") await mkdir(acceptancePath, { mode: 0o700 });
    const workspace = await realpath(workspacePath);
    const executionRoot = await realpath(executionPath);
    const deliveryRoot = await realpath(deliveryPath);
    const acceptanceRoot = options.mode === "delivery-only" ? null : await realpath(acceptancePath);
    const inputPath = path.join(root, "authorized-input.txt");
    await writeFile(inputPath, "native delivery authorized input\n第二行 exact bytes\n", { mode: 0o600 });
    const configPath = path.join(root, "config.yml");
    await writeFile(configPath, JSON.stringify({
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
    }, null, 2), { mode: 0o600 });
    const statePath = path.join(root, "b1-state.json");
    const b1AuditPath = path.join(root, "b1-audit.jsonl");
    const executionAuditPath = path.join(root, "execution-audit.jsonl");
    const fixtureAuditPath = path.join(root, "delivery-fixture.jsonl");
    for (const filePath of [statePath, b1AuditPath, executionAuditPath, fixtureAuditPath]) {
      await writeFile(filePath, "", { mode: 0o600 });
    }
    return new DeliveryOmpSession({
      root,
      workspace,
      agentDir: await realpath(agentPath),
      executionRoot,
      deliveryRoot,
      acceptanceRoot,
      inputPath,
      statePath,
      b1AuditPath,
      executionAuditPath,
      fixtureAuditPath,
      configPath,
    }, options);
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "USER", "LOGNAME", "LANG", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.HOME = homedir();
    env.TERM = "dumb";
    env.PI_CONFIG_DIR = path.relative(homedir(), this.root);
    env.PI_CODING_AGENT_DIR = this.agentDir;
    env.PI_NO_TITLE = "1";
    env.PI_NO_PTY = "1";
    env.OMP_PROFILE = "default";
    env.DELIVERY_FIXTURE_ROOT = this.root;
    env.DELIVERY_FIXTURE_MODE = this.mode;
    env.DELIVERY_FIXTURE_INPUT_PATH = this.inputPath;
    env.DELIVERY_FIXTURE_AUDIT = this.fixtureAuditPath;
    env.OMP_AGENT_B1_STATE_PATH = this.statePath;
    env.OMP_AGENT_B1_WORKSPACE_ROOT = this.workspace;
    env.OMP_AGENT_B1_AUDIT_PATH = this.b1AuditPath;
    env.OMP_AGENT_B1_CAPABILITIES = "local-script";
    env.OMP_AGENT_EXECUTION_ROOT = this.executionRoot;
    env.OMP_AGENT_EXECUTION_INPUTS = JSON.stringify([{ id: "alpha", path: this.inputPath }]);
    env.OMP_AGENT_EXECUTION_CAPABILITY = "local-script";
    env.OMP_AGENT_EXECUTION_AUDIT_PATH = this.executionAuditPath;
    env.OMP_AGENT_EXECUTION_TIMEOUT_MS = "5000";
    env.OMP_AGENT_DELIVERY_ROOT = this.deliveryRoot;
    if (this.acceptanceRoot !== null) env.OMP_AGENT_ACCEPTANCE_ROOT = this.acceptanceRoot;
    return env;
  }

  private args(): string[] {
    return [
      "--mode", "rpc", "--no-ui", "--no-tools",
      "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-pty",
      "--no-session", "--no-title", "--no-prewalk", "--approval-mode", "yolo",
      "--config", this.configPath,
      "--model", `${PROVIDER}/${MODEL}`,
      "--thinking", "off",
      "--max-time", "30",
      "--max-cost", "0.1",
      "--extension", PROVIDER_PATH,
      "--extension", TASK_ENTRY_PATH,
      "--extension", HOST_PATH,
    ];
  }

  private executable(): string {
    const requested = process.env.OMP_COMMAND || "omp";
    return requested.includes("/") ? path.resolve(requested) : requested;
  }

  async start(): Promise<Frame> {
    const version = spawnSync(this.executable(), ["--version"], {
      env: { PATH: process.env.PATH, HOME: homedir() },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8192,
    });
    if (version.error || version.status !== 0) {
      throw new Error(`OMP is unavailable: ${version.error?.message ?? `exit ${version.status}`}. Set OMP_COMMAND or install OMP ${EXPECTED_OMP_VERSION}.`);
    }
    const actualVersion = parseOmpVersion(version.stdout);
    if (actualVersion !== EXPECTED_OMP_VERSION) {
      throw new Error(`OMP version mismatch: actual=${actualVersion} expected=${EXPECTED_OMP_VERSION}`);
    }
    const child = spawn(this.executable(), this.args(), {
      cwd: this.workspace,
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
      throw new Error(`Delivery admission failed: actual=${String(model.provider)}/${String(model.id)}/${String(model.api)}`);
    }
    const dumpTools = Array.isArray(state.dumpTools) ? state.dumpTools as Array<{ name?: unknown }> : [];
    const names = dumpTools.map((tool) => typeof tool.name === "string" ? tool.name : "").sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new Error(`Delivery admission failed: unexpected toolset ${names.join(",")}; expected ${EXPECTED_TOOLS.join(",")}.`);
    }
    const events = await this.fixtureEvents();
    if (!events.some((event) => event.type === "fixture_ready")) {
      throw new Error("Delivery admission failed: the host fixture did not publish its actual composition.");
    }
    const prePromptAudit = await this.b1Audit();
    const business = prePromptAudit.filter((event) =>
      ["input_observed", "task_started", "task_tool_attempt", "capability_admission_allowed"].includes(String(event.type)));
    if (business.length > 0) {
      throw new Error(`Delivery admission failed: business actions occurred before admission: ${JSON.stringify(business)}`);
    }
    this.admitted = true;
    await this.request("set_auto_retry", { enabled: false });
    await this.request("set_auto_compaction", { enabled: false });
    await this.request("set_cache_warming", { mode: "off" });
    await this.request("set_event_filter", {
      events: [
        "agent_start", "agent_end", "message_end", "tool_execution_start", "tool_execution_end",
        "extension_error", "notice", "prompt_result", "session_settled",
      ],
    });
    return state;
  }

  async prompt(message = DELIVERY_PROMPT): Promise<Frame> {
    if (!this.admitted) throw new Error("Refusing to send a business prompt before delivery admission.");
    const id = `delivery-prompt-${++this.sequence}`;
    const startIndex = this.frames.length;
    const startedAt = Date.now();
    this.send({ type: "prompt", id, message });
    await this.waitFor(() => this.frames.some((frame) => frame.type === "response" && frame.id === id), "prompt acknowledgement", 10_000);
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
      async () => (await this.fixtureEvents()).some((event) => event.type === "agent_end_fixture"),
      "host fixture agent_end",
      10_000,
    );
    await Bun.sleep(100);
    return result.frame;
  }

  async fixtureEvents(): Promise<Array<Record<string, any>>> {
    return this.jsonl(this.fixtureAuditPath);
  }

  async b1Audit(): Promise<Array<Record<string, any>>> {
    return this.jsonl(this.b1AuditPath);
  }

  async owner(): Promise<Record<string, any> | undefined> {
    try {
      return JSON.parse(await readFile(this.statePath, "utf8")) as Record<string, any>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async inputBytes(): Promise<Buffer> {
    return readFile(this.inputPath);
  }

  async deliveryFiles(): Promise<DeliveryFileSnapshot[]> {
    return snapshotTree(this.deliveryRoot);
  }

  async acceptanceFiles(): Promise<DeliveryFileSnapshot[]> {
    return this.acceptanceRoot === null ? [] : snapshotTree(this.acceptanceRoot);
  }

  async executionRecords(): Promise<Array<Record<string, any>>> {
    const records: Array<Record<string, any>> = [];
    let names: string[];
    try {
      names = await readdir(this.executionRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return records;
      throw error;
    }
    for (const name of names.filter((entry) => entry.startsWith("run-")).sort()) {
      try {
        const record = JSON.parse(await readFile(path.join(this.executionRoot, name, "record.json"), "utf8")) as Record<string, any>;
        records.push({ ...record, _directory: path.join(this.executionRoot, name) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return records;
  }

  async snapshot(): Promise<Record<string, unknown>> {
    return {
      mode: this.mode,
      frames: [...this.frames],
      admission: this.admission,
      fixtureEvents: await this.fixtureEvents(),
      b1Audit: await this.b1Audit(),
      owner: await this.owner(),
      executionRecords: await this.executionRecords(),
      deliveryFiles: await this.deliveryFiles(),
      acceptanceFiles: await this.acceptanceFiles(),
      stderr: this.stderr,
    };
  }

  /**
   * Actual shutdown through the RPC stdin EOF. A fallback signal is recorded
   * and fails the clean-shutdown assertion rather than being hidden.
   */
  async shutdown(): Promise<{
    fallback: string[];
    processGroupGone: boolean;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    fixtureShutdown: boolean;
  }> {
    const fallback: string[] = [];
    const child = this.child;
    if (!child) throw new Error("Delivery session was never started.");
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
    return {
      fallback,
      processGroupGone: !this.groupExists(),
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      fixtureShutdown: (await this.fixtureEvents()).some((event) => event.type === "session_shutdown_fixture"),
    };
  }

  async cleanup(): Promise<void> {
    if (this.cleanupDone) return;
    this.stopping = true;
    const child = this.child;
    const failures: string[] = [];
    if (child) {
      try {
        try { child.stdin.end(); } catch { /* closed */ }
        if (this.exitPromise) await Promise.race([this.exitPromise, Bun.sleep(1000)]);
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          if (!this.groupExists()) break;
          try { process.kill(-child.pid!, signal); } catch (error) {
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
    if (failures.length === 0) {
      try {
        const identities = await this.testOwnedProcessIdentities();
        const alive = await this.waitForIdentitiesGone(identities);
        if (alive.length > 0) {
          failures.push(`test-owned processes still alive: ${alive.join(", ")}`);
        }
      } catch (error) {
        failures.push(`process evidence unavailable: ${(error as Error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Delivery cleanup failed; retaining ${this.root}: ${failures.join("; ")}`);
    }
    await rm(this.root, { recursive: true, force: true });
    this.cleanupDone = true;
  }

  private async testOwnedProcessIdentities(): Promise<OwnedProcessIdentity[]> {
    return await executionProcessIdentities(this.executionRoot, this.executionAuditPath);
  }

  private async executionAudit(): Promise<Array<Record<string, unknown>>> {
    const text = await this.readEvidence(this.executionAuditPath, "execution audit");
    return text.split("\n").filter(Boolean).map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`execution audit line ${index + 1} is not valid JSON`);
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`execution audit line ${index + 1} is not an object`);
      }
      return value as Record<string, unknown>;
    });
  }

  private async readEvidence(filePath: string, label: string): Promise<string> {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file`);
    if (info.size > MAX_EVIDENCE_BYTES) throw new Error(`${label} exceeds ${MAX_EVIDENCE_BYTES} bytes`);
    return readFile(filePath, "utf8");
  }

  private async waitForIdentitiesGone(identities: OwnedProcessIdentity[]): Promise<string[]> {
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
      this.stderr = `${this.stderr}${bytes.toString("utf8")}`.slice(-12000);
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
        if (!this.stopping) this.fail(new Error("OMP exited before the delivery test completed."));
        resolve();
      });
    });
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
  }

  private send(frame: Frame): void {
    if (this.failure) throw this.failure;
    if (!this.child || this.exited) throw new Error("OMP process is not running.");
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Outbound RPC frame exceeds 1 MiB.");
    this.child.stdin.write(line);
  }

  private async request(type: string, data: Frame = {}): Promise<Frame> {
    const id = `delivery-rpc-${++this.sequence}`;
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
