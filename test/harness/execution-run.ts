import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { EXPECTED_OMP_VERSION, parseOmpVersion } from "./admission.ts";
import { RpcFrameDecoder, type Frame } from "./managed-run.ts";

/** Bounded real-OMP lifecycle for the G2-A1 execution entry. */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const PROVIDER_PATH = path.join(REPO_ROOT, "test/fixtures/execution-provider.mjs");
const TASK_ENTRY_GATE_PATH = path.join(REPO_ROOT, "test/fixtures/task-entry-cancel-gate.mjs");
const EXECUTION_ENTRY_PATH = path.join(REPO_ROOT, "src/execution-entry.ts");
const PROVIDER = "g2a-fixture";
const MODEL = "scripted";
const API = "g2a-fixture-api";
const EXPECTED_TOOLS = ["agent_execute", "agent_task", "agent_verify"];

export interface ExecutionRunOptions {
  scenario: string;
  dispatchWallMs?: number;
  timeoutMs?: number;
}

export class ExecutionOmpSession {
  readonly root: string;
  readonly workspace: string;
  readonly executionRoot: string;
  readonly auditPath: string;
  readonly executionAuditPath: string;
  readonly fixtureAuditPath: string;
  readonly inputPath: string;
  readonly frames: Frame[] = [];
  readonly scenario: string;
  promptSent = false;
  admitted = false;

  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private readonly decoder = new RpcFrameDecoder();
  private stderr = "";
  private failure: Error | undefined;
  private exited = false;
  private exitPromise: Promise<void> | undefined;
  private stopping = false;
  private sequence = 0;

  private constructor(values: {
    root: string;
    workspace: string;
    executionRoot: string;
    auditPath: string;
    executionAuditPath: string;
    fixtureAuditPath: string;
    inputPath: string;
  }, scenario: string) {
    this.root = values.root;
    this.workspace = values.workspace;
    this.executionRoot = values.executionRoot;
    this.auditPath = values.auditPath;
    this.executionAuditPath = values.executionAuditPath;
    this.fixtureAuditPath = values.fixtureAuditPath;
    this.inputPath = values.inputPath;
    this.scenario = scenario;
  }

  static async create(options: ExecutionRunOptions): Promise<ExecutionOmpSession> {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2a1-")));
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { mode: 0o700 });
    const workspace = await realpath(workspacePath);
    await mkdir(path.join(root, "agent"), { mode: 0o700 });
    const executionPath = path.join(root, "execution");
    await mkdir(executionPath, { mode: 0o700, recursive: true });
    const executionRoot = await realpath(executionPath);
    const inputPath = path.join(root, "alpha-input.txt");
    await writeFile(inputPath, "native authorized alpha input\n", { mode: 0o600 });
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
      extensionHandlers: { toolCallTimeoutMs: options.timeoutMs ?? 30_000 },
    }, null, 2), { mode: 0o600 });
    const auditPath = path.join(root, "b1-audit.jsonl");
    const executionAuditPath = path.join(root, "execution-audit.jsonl");
    const fixtureAuditPath = path.join(root, "fixture-audit.jsonl");
    const statePath = path.join(root, "b1-state.json");
    for (const filePath of [auditPath, executionAuditPath, fixtureAuditPath, statePath]) {
      await writeFile(filePath, "", { mode: 0o600 });
    }
    const session = new ExecutionOmpSession({
      root,
      workspace,
      executionRoot,
      auditPath,
      executionAuditPath,
      fixtureAuditPath,
      inputPath,
    }, options.scenario);
    session.writeDispatchLimit(options.dispatchWallMs ?? 10_000);
    return session;
  }

  private dispatchWallMs = 10_000;

  private writeDispatchLimit(value: number): void {
    this.dispatchWallMs = value;
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "USER", "LOGNAME", "LANG", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.HOME = homedir();
    env.TERM = "dumb";
    env.PI_CONFIG_DIR = path.relative(homedir(), this.root);
    env.PI_CODING_AGENT_DIR = path.join(this.root, "agent");
    env.PI_NO_TITLE = "1";
    env.PI_NO_PTY = "1";
    env.OMP_PROFILE = "default";
    env.EXECUTION_FIXTURE_SCENARIO = this.scenario;
    env.EXECUTION_FIXTURE_AUDIT = this.fixtureAuditPath;
    env.EXECUTION_FIXTURE_ROOT = this.executionRoot;
    env.OMP_AGENT_B1_STATE_PATH = path.join(this.root, "b1-state.json");
    env.OMP_AGENT_B1_WORKSPACE_ROOT = this.workspace;
    env.OMP_AGENT_B1_AUDIT_PATH = this.auditPath;
    env.OMP_AGENT_B1_CAPABILITIES = "local-script";
    env.OMP_AGENT_EXECUTION_ROOT = this.executionRoot;
    env.OMP_AGENT_EXECUTION_INPUTS = JSON.stringify([{ id: "alpha", path: this.inputPath }]);
    env.OMP_AGENT_EXECUTION_CAPABILITY = "local-script";
    env.OMP_AGENT_EXECUTION_AUDIT_PATH = this.executionAuditPath;
    env.OMP_AGENT_EXECUTION_TIMEOUT_MS = String(this.dispatchWallMs);
    return env;
  }

  private args(): string[] {
    return [
      "--mode", "rpc", "--no-ui", "--no-tools",
      "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-pty",
      "--no-session", "--no-title", "--no-prewalk", "--approval-mode", "yolo",
      "--config", path.join(this.root, "config.yml"),
      "--model", `${PROVIDER}/${MODEL}`,
      "--thinking", "off",
      "--max-time", "30",
      "--max-cost", "0.1",
      "--extension", PROVIDER_PATH,
      "--extension", TASK_ENTRY_GATE_PATH,
      "--extension", EXECUTION_ENTRY_PATH,
    ];
  }

  async start(): Promise<void> {
    const executable = process.env.OMP_COMMAND || "omp";
    const version = spawnSync(executable, ["--version"], {
      env: { PATH: process.env.PATH, HOME: homedir() },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8192,
    });
    if (version.error || version.status !== 0) {
      throw new Error(`OMP is unavailable: ${version.error?.message ?? `exit ${version.status}`}`);
    }
    const ompVersion = parseOmpVersion(version.stdout);
    if (ompVersion !== EXPECTED_OMP_VERSION) {
      throw new Error(`OMP version mismatch: actual=${ompVersion} expected=${EXPECTED_OMP_VERSION}`);
    }
    const child = spawn(executable, this.args(), {
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
    const model = (state.model ?? {}) as Frame;
    if (model.provider !== PROVIDER || model.id !== MODEL || model.api !== API) {
      throw new Error(`G2-A1 admission failed: actual=${String(model.provider)}/${String(model.id)}/${String(model.api)}`);
    }
    const dumpTools = Array.isArray(state.dumpTools) ? state.dumpTools as Array<{ name?: unknown }> : [];
    const names = dumpTools.map((tool) => typeof tool.name === "string" ? tool.name : "").sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new Error(`G2-A1 admission failed: unexpected toolset ${names.join(",")}; native bash/write/read are not allowed.`);
    }
    const prePromptAudit = existsSync(this.auditPath)
      ? (await readFile(this.auditPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Frame)
      : [];
    const business = prePromptAudit.filter((event) =>
      ["input_observed", "task_started", "task_tool_attempt", "capability_admission_allowed"].includes(String(event.type)));
    if (business.length) throw new Error(`G2-A1 entry performed business actions before admission: ${JSON.stringify(business)}`);
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
  }

  async prompt(message: string): Promise<void> {
    if (!this.admitted) throw new Error("Refusing to send a business prompt before G2-A1 admission.");
    const id = `g2a1-prompt-${++this.sequence}`;
    const startIndex = this.frames.length;
    this.promptSent = true;
    this.send({ type: "prompt", id, message });
    await this.waitFor(() => this.frames.some((frame) => frame.type === "response" && frame.id === id), "prompt acknowledgement", 10_000);
    const acknowledgement = this.frames.find((frame) => frame.type === "response" && frame.id === id)!;
    if (acknowledgement.success !== true) throw new Error(`OMP rejected prompt: ${String(acknowledgement.error)}`);
    const deadline = Date.now() + 30_000;
    await this.waitFor(() => this.result(id, startIndex) !== undefined, `prompt_result ${id}`, Math.max(1, deadline - Date.now()));
    const result = this.result(id, startIndex)!;
    if (result.frame.status !== "completed") throw new Error(`OMP prompt ${id} failed: ${JSON.stringify(result.frame.error ?? result.frame)}`);
    if (result.frame.agentInvoked !== true) throw new Error(`OMP prompt ${id} did not invoke an agent.`);
    const failure = this.providerFailure(startIndex, result.index);
    if (failure) throw new Error(`OMP prompt ${id} saw a provider failure: ${failure}`);
    await this.waitFor(
      () => this.frames.some((frame, index) => index > result.index && frame.type === "session_settled"),
      `session_settled after ${id}`,
      Math.max(1, deadline - Date.now()),
    );
    await Bun.sleep(150);
  }

  async promptAborted(message: string): Promise<Frame> {
    if (!this.admitted) throw new Error("Refusing to send a business prompt before G2-A1 admission.");
    const id = `g2a1-prompt-${++this.sequence}`;
    const startIndex = this.frames.length;
    this.promptSent = true;
    this.send({ type: "prompt", id, message });
    await this.waitFor(() => this.frames.some((frame) => frame.type === "response" && frame.id === id), "prompt acknowledgement", 10_000);
    const acknowledgement = this.frames.find((frame) => frame.type === "response" && frame.id === id)!;
    if (acknowledgement.success !== true) throw new Error(`OMP rejected prompt: ${String(acknowledgement.error)}`);
    const deadline = Date.now() + 30_000;
    await this.waitFor(() => this.result(id, startIndex) !== undefined, `prompt_result ${id}`, Math.max(1, deadline - Date.now()));
    const result = this.result(id, startIndex)!;
    if (result.frame.status !== "aborted") {
      throw new Error(`OMP prompt ${id} was expected to abort but ended ${String(result.frame.status)}.`);
    }
    await this.waitFor(
      () => result.frame.sessionSettled === true
        || this.frames.some((frame, index) => index > result.index && frame.type === "session_settled"),
      `session_settled after aborted ${id}`,
      Math.max(1, deadline - Date.now()),
    );
    await Bun.sleep(100);
    return result.frame;
  }

  /** Abort after the adapter has actually recorded a running child. */
  async promptAbortedWhileRunning(message: string): Promise<Record<string, unknown>> {
    const pending = this.promptAborted(message);
    await this.waitForExecutionRecord("running child record", (record) => {
      const process = record.process as Record<string, unknown> | null | undefined;
      return record.phase === "running" && typeof process?.pid === "number";
    }, 20_000);
    const aborting = this.abort();
    await pending;
    await aborting;
    return (await this.waitForExecutionRecord("completed child record", (record) => record.phase === "completed", 20_000));
  }

  abort(): Promise<Frame> {
    return this.request("abort");
  }

  async waitForExecutionRecord(
    label: string,
    predicate: (record: Record<string, unknown>) => boolean,
    timeoutMs = 20_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const record = await this.latestExecutionRecord();
      if (record && predicate(record)) return record;
      if (this.failure || this.exited) {
        throw new Error(`${label}: ${this.failure?.message ?? "OMP exited"}\n${this.stderr}`);
      }
      if (Date.now() >= deadline) throw new Error(`${label}: timed out\n${this.stderr}\n${JSON.stringify(this.frames.slice(-8))}`);
      await Bun.sleep(20);
    }
  }

  async latestExecutionRecord(): Promise<Record<string, unknown> | undefined> {
    const runDir = await this.latestRunDir();
    if (!runDir) return undefined;
    try {
      return JSON.parse(await readFile(path.join(runDir, "record.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  async latestRunDir(): Promise<string | undefined> {
    let entries: string[];
    try {
      entries = (await readdir(this.executionRoot)).filter((name) => name.startsWith("run-")).sort();
    } catch {
      return undefined;
    }
    for (const name of entries.reverse()) {
      const runDir = path.join(this.executionRoot, name);
      if (existsSync(path.join(runDir, "record.json"))) return runDir;
    }
    return undefined;
  }

  async watchdogEvents(): Promise<Array<Record<string, unknown>>> {
    const runDir = await this.latestRunDir();
    if (!runDir) return [];
    try {
      return (await readFile(path.join(runDir, "watchdog.jsonl"), "utf8"))
        .split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  waitForArmed(timeoutMs = 20_000): Promise<Record<string, unknown>> {
    return this.waitForExecutionRecord("armed watchdog record", (record) => {
      const watchdog = record.watchdog as Record<string, unknown> | undefined;
      const process = record.process as Record<string, unknown> | null | undefined;
      return record.phase === "running"
        && watchdog?.armed === true
        && typeof watchdog.watchdogPid === "number"
        && typeof process?.pid === "number";
    }, timeoutMs);
  }

  async signalHostGroup(signal: "SIGSTOP" | "SIGCONT"): Promise<void> {
    const pid = this.child?.pid;
    if (!pid) throw new Error("OMP process is not running.");
    process.kill(-pid, signal);
  }

  async killHostGroup(): Promise<void> {
    this.stopping = true;
    const pid = this.child?.pid;
    if (pid) {
      try { process.kill(-pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (this.exitPromise) await Promise.race([this.exitPromise, Bun.sleep(5000)]);
  }

  async snapshot() {
    return {
      frames: [...this.frames],
      audit: await this.jsonl(this.auditPath),
      executionAudit: await this.jsonl(this.executionAuditPath),
      fixtureAudit: await this.jsonl(this.fixtureAuditPath),
      record: await this.latestExecutionRecord(),
      stderr: this.stderr,
      workspaceEntries: (await readdir(this.workspace)).sort(),
    };
  }

  get processId(): number | undefined {
    return this.child?.pid;
  }

  private async jsonl(filePath: string): Promise<Array<Record<string, unknown>>> {
    try {
      return (await readFile(filePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
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
        if (record.role === "assistant" && record.stopReason === "error") return String(record.errorMessage ?? "assistant error");
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
      this.stderr = `${this.stderr}${bytes.toString("utf8")}`.slice(-8000);
    });
    child.on("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => { if (!this.stopping) this.fail(error); });
    this.exitPromise = new Promise((resolve) => {
      child.on("close", () => {
        this.exited = true;
        try {
          this.decoder.finish();
        } catch (error) {
          if (!this.stopping) this.fail(error as Error);
        }
        if (!this.stopping) this.fail(new Error("OMP exited before the G2-A1 test completed."));
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
    const id = `g2a1-${++this.sequence}`;
    this.send({ ...data, type, id });
    await this.waitFor(() => this.frames.some((frame) => frame.type === "response" && frame.id === id), `${type} response`, 10_000);
    const response = this.frames.find((frame) => frame.type === "response" && frame.id === id)!;
    if (response.success !== true) throw new Error(`OMP ${type} failed: ${String(response.error || "unknown error")}`);
    return response;
  }

  private async waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (this.failure || this.exited) {
        throw new Error(`${label}: ${this.failure?.message ?? "OMP exited"}\n${this.stderr}\n${JSON.stringify(this.frames.slice(-8))}`);
      }
      if (Date.now() >= deadline) throw new Error(`${label}: timed out\n${this.stderr}\n${JSON.stringify(this.frames.slice(-8))}`);
      await Bun.sleep(10);
    }
  }

  private groupExists(): boolean {
    if (!this.child?.pid) return false;
    try {
      process.kill(-this.child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    try {
      if (child) {
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
        if (this.groupExists()) throw new Error("OMP process group did not exit after SIGKILL.");
      }
    } finally {
      await rm(this.root, { recursive: true, force: true });
    }
  }
}
