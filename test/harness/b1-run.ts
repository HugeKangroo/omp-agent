import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { EXPECTED_OMP_VERSION, parseOmpVersion } from "./admission.ts";
import { RpcFrameDecoder, type Frame } from "./managed-run.ts";

/**
 * Bounded real-OMP lifecycle for the experimental G1-B1 entry. It reuses the
 * checked RPC decoder but not the G1-A managed-policy harness: B1 has no
 * policy, binding or fixed file writer.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const PROVIDER_PATH = path.join(REPO_ROOT, "test/fixtures/b1-provider.mjs");
const CAPABILITY_PATH = path.join(REPO_ROOT, "test/fixtures/b1-capability.mjs");
const ENTRY_PATH = path.join(REPO_ROOT, "src/task-entry.ts");
const JOB_ENTRY_PATH = path.join(REPO_ROOT, "src/job-entry.ts");
const OBSERVED_JOB_ENTRY_PATH = path.join(REPO_ROOT, "test/fixtures/observe-job-tool.mjs");
const B1_PROVIDER = "g1b-fixture";
const B1_MODEL = "scripted";
const B1_API = "g1b-fixture-api";
const BASE_TOOLS = ["agent_task", "agent_test_capability", "agent_untrusted_echo"];

export interface B1RunOptions {
  scenario: string;
  timeoutMs?: number;
  /**
   * Narrow opt-in for native navigation/session scenarios. The default stays
   * --no-session; when enabled, journals live only under the private temp root.
   */
  persistSessions?: boolean;
  /** Explicit G1-B3a experimental job entry. Endpoint is host-chosen. */
  jobs?: {
    endpoint: string;
    capabilityId?: string;
    timeoutMs?: number;
    /** Test-only transparent observer of the actual third-argument signal. */
    observeToolSignal?: boolean;
  };
}

export class B1OmpSession {
  readonly root: string;
  readonly workspace: string;
  readonly statePath: string;
  readonly auditPath: string;
  readonly fixtureAuditPath: string;
  readonly fixtureSnapshotPath: string;
  readonly configPath: string;
  readonly sessionDir: string | undefined;
  readonly jobRecordPath: string | undefined;
  readonly jobAuditPath: string | undefined;
  readonly jobToolTracePath: string | undefined;
  private readonly jobEndpoint: string | undefined;
  private readonly jobCapabilityId: string | undefined;
  private readonly jobTimeoutMs: number | undefined;
  private readonly observeJobTool: boolean | undefined;
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
    statePath: string;
    auditPath: string;
    fixtureAuditPath: string;
    fixtureSnapshotPath: string;
    configPath: string;
    sessionDir: string | undefined;
    jobRecordPath: string | undefined;
    jobAuditPath: string | undefined;
    jobToolTracePath: string | undefined;
    jobEndpoint: string | undefined;
    jobCapabilityId: string | undefined;
    jobTimeoutMs: number | undefined;
    observeJobTool: boolean | undefined;
  }, scenario: string) {
    this.root = values.root;
    this.workspace = values.workspace;
    this.statePath = values.statePath;
    this.auditPath = values.auditPath;
    this.fixtureAuditPath = values.fixtureAuditPath;
    this.fixtureSnapshotPath = values.fixtureSnapshotPath;
    this.configPath = values.configPath;
    this.sessionDir = values.sessionDir;
    this.jobRecordPath = values.jobRecordPath;
    this.jobAuditPath = values.jobAuditPath;
    this.jobToolTracePath = values.jobToolTracePath;
    this.jobEndpoint = values.jobEndpoint;
    this.jobCapabilityId = values.jobCapabilityId;
    this.jobTimeoutMs = values.jobTimeoutMs;
    this.observeJobTool = values.observeJobTool;
    this.scenario = scenario;
  }

  static async create(options: B1RunOptions): Promise<B1OmpSession> {
    const root = await mkdtemp(path.join(tmpdir(), "omp-agent-g1b-"));
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { mode: 0o700 });
    const workspace = await realpath(workspacePath);
    await mkdir(path.join(root, "agent"), { mode: 0o700 });
    const sessionDir = options.persistSessions === true ? path.join(root, "sessions") : undefined;
    if (sessionDir) await mkdir(sessionDir, { mode: 0o700 });
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
    const statePath = path.join(root, "b1-state.json");
    const auditPath = path.join(root, "b1-audit.jsonl");
    const fixtureAuditPath = path.join(root, "fixture-audit.jsonl");
    const fixtureSnapshotPath = path.join(root, "fixture-snapshot.json");
    await writeFile(statePath, "", { mode: 0o600 });
    await writeFile(auditPath, "", { mode: 0o600 });
    await writeFile(fixtureAuditPath, "", { mode: 0o600 });
    await writeFile(fixtureSnapshotPath, "", { mode: 0o600 });
    const jobRecordPath = options.jobs ? path.join(root, "job-record.json") : undefined;
    const jobAuditPath = options.jobs ? path.join(root, "job-audit.jsonl") : undefined;
    const jobToolTracePath = options.jobs && options.jobs.observeToolSignal
      ? path.join(root, "job-tool-trace.jsonl")
      : undefined;
    if (jobAuditPath) await writeFile(jobAuditPath, "", { mode: 0o600 });
    if (jobToolTracePath) await writeFile(jobToolTracePath, "", { mode: 0o600 });
    const session = new B1OmpSession({
      root,
      workspace,
      statePath,
      auditPath,
      fixtureAuditPath,
      fixtureSnapshotPath,
      configPath,
      sessionDir,
      jobRecordPath,
      jobAuditPath,
      jobToolTracePath,
      jobEndpoint: options.jobs?.endpoint,
      jobCapabilityId: options.jobs?.capabilityId,
      jobTimeoutMs: options.jobs?.timeoutMs,
      observeJobTool: options.jobs?.observeToolSignal,
    }, options.scenario);
    return session;
  }

  private configFile(): string {
    return this.configPath;
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
    env.B1_FIXTURE_SCENARIO = this.scenario;
    env.B1_FIXTURE_AUDIT = this.fixtureAuditPath;
    env.B1_FIXTURE_SNAPSHOT = this.fixtureSnapshotPath;
    env.OMP_AGENT_B1_STATE_PATH = this.statePath;
    env.OMP_AGENT_B1_WORKSPACE_ROOT = this.workspace;
    env.OMP_AGENT_B1_AUDIT_PATH = this.auditPath;
    env.OMP_AGENT_B1_CAPABILITIES = this.jobEndpoint ? "test-progress,job-submit" : "test-progress";
    env.B1_CAPABILITY_COUNTER = path.join(this.root, "capability-counter.json");
    if (this.jobEndpoint && this.jobRecordPath) {
      env.OMP_AGENT_JOB_ENDPOINT = this.jobEndpoint;
      env.OMP_AGENT_JOB_RECORD_PATH = this.jobRecordPath;
      env.OMP_AGENT_JOB_AUDIT_PATH = this.jobAuditPath!;
      env.OMP_AGENT_JOB_CAPABILITY = this.jobCapabilityId ?? "job-submit";
      if (this.jobTimeoutMs !== undefined) env.OMP_AGENT_JOB_TIMEOUT_MS = String(this.jobTimeoutMs);
      if (this.jobToolTracePath) env.B3_TOOL_TRACE = this.jobToolTracePath;
    }
    return env;
  }

  private args(): string[] {
    return [
      "--mode", "rpc", "--no-ui", "--no-tools",
      "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-pty",
      ...(this.sessionDir ? ["--session-dir", this.sessionDir] : ["--no-session"]),
      "--no-title", "--no-prewalk", "--approval-mode", "yolo",
      "--config", this.configFile(),
      "--model", `${B1_PROVIDER}/${B1_MODEL}`,
      "--thinking", "off",
      "--max-time", "20",
      "--max-cost", "0.1",
      "--extension", PROVIDER_PATH,
      "--extension", ENTRY_PATH,
      "--extension", CAPABILITY_PATH,
      ...(this.jobEndpoint ? ["--extension", this.observeJobTool ? OBSERVED_JOB_ENTRY_PATH : JOB_ENTRY_PATH] : []),
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
    if (version.error || version.status !== 0) throw new Error(`OMP is unavailable: ${version.error?.message ?? `exit ${version.status}`}`);
    const ompVersion = parseOmpVersion(version.stdout);
    if (ompVersion !== EXPECTED_OMP_VERSION) throw new Error(`OMP version mismatch: actual=${ompVersion} expected=${EXPECTED_OMP_VERSION}`);

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
    if (model.provider !== B1_PROVIDER || model.id !== B1_MODEL || model.api !== B1_API) {
      throw new Error(`B1 admission failed: actual=${String(model.provider)}/${String(model.id)}/${String(model.api)}`);
    }
    const dumpTools = Array.isArray(state.dumpTools) ? state.dumpTools as Array<{ name?: unknown }> : [];
    const names = dumpTools.map((tool) => typeof tool.name === "string" ? tool.name : "").sort();
    const expectedTools = [...BASE_TOOLS, ...(this.jobEndpoint ? ["agent_job"] : [])];
    if (JSON.stringify(names) !== JSON.stringify([...expectedTools].sort())) {
      throw new Error(`B1 admission failed: tools=${names.join(",")} expected=${expectedTools.join(",")}`);
    }
    const prePromptAudit = existsSync(this.auditPath) ? (await readFile(this.auditPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event) : [];
    const business = prePromptAudit.filter((event) => ["input_observed", "task_started", "task_tool_attempt", "capability_admission_allowed"].includes(String(event.type)));
    if (business.length) throw new Error(`B1 entry performed business actions before admission: ${JSON.stringify(business)}`);
    this.admitted = true;
    await this.request("set_auto_retry", { enabled: false });
    await this.request("set_auto_compaction", { enabled: false });
    await this.request("set_cache_warming", { mode: "off" });
    await this.request("set_event_filter", {
      events: ["agent_start", "agent_end", "message_end", "tool_execution_start", "tool_execution_end", "extension_error", "notice", "prompt_result", "session_settled", "manual_compaction_start", "manual_compaction_end"],
    });
  }

  async prompt(message: string): Promise<void> {
    if (!this.admitted) throw new Error("Refusing to send a business prompt before B1 admission.");
    const id = `b1-prompt-${++this.sequence}`;
    const startIndex = this.frames.length;
    this.promptSent = true;
    this.send({ type: "prompt", id, message });
    await this.waitFor(() => this.frames.some((frame) => frame.type === "response" && frame.id === id), "prompt acknowledgement", 10_000);
    const acknowledgement = this.frames.find((frame) => frame.type === "response" && frame.id === id)!;
    if (acknowledgement.success !== true) throw new Error(`OMP rejected prompt: ${String(acknowledgement.error)}`);
    const deadline = Date.now() + 25_000;
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

  /**
   * Send a genuine user prompt whose agent run is expected to be host-aborted.
   * Completion is still the correlated prompt_result (aborted) plus
   * session_settled; an RPC acknowledgement alone is insufficient.
   */
  async promptAborted(message: string): Promise<Frame> {
    if (!this.admitted) throw new Error("Refusing to send a business prompt before B1 admission.");
    const id = `b1-prompt-${++this.sequence}`;
    const startIndex = this.frames.length;
    this.promptSent = true;
    this.send({ type: "prompt", id, message });
    await this.waitFor(() => this.frames.some((frame) => frame.type === "response" && frame.id === id), "prompt acknowledgement", 10_000);
    const acknowledgement = this.frames.find((frame) => frame.type === "response" && frame.id === id)!;
    if (acknowledgement.success !== true) throw new Error(`OMP rejected prompt: ${String(acknowledgement.error)}`);
    const deadline = Date.now() + 25_000;
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

  /** Host-requested abort. The ACK is not completion; callers wait for prompt_result. */
  abort(): Promise<Frame> {
    return this.request("abort");
  }

  get processId(): number | undefined {
    return this.child?.pid;
  }

  /**
   * Actual process-group death for disconnect evidence. This is not remote
   * cancellation and not restart recovery; the independent service is owned by
   * the test host and must be checked separately.
   */
  async killProcessGroup(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    const child = this.child;
    if (!child?.pid) throw new Error("OMP process is not running.");
    if (this.exited) return;
    // A deliberate kill is not a harness failure.
    this.stopping = true;
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    if (this.exitPromise) await Promise.race([this.exitPromise, Bun.sleep(5_000)]);
    const deadline = Date.now() + 5_000;
    while (this.groupExists() && Date.now() < deadline) await Bun.sleep(20);
    if (this.groupExists()) throw new Error(`OMP process group survived ${signal}.`);
  }

  /**
   * Drive a local extension command. A slash command does not invoke an agent,
   * so completion is the matching prompt_result with agentInvoked=false; an
   * ACK or a guessed sleep is not completion.
   */
  async command(message: string): Promise<Frame> {
    if (!this.admitted) throw new Error("Refusing to send a command before B1 admission.");
    if (!message.startsWith("/")) throw new Error("Local commands must start with '/'.");
    const id = `b1-command-${++this.sequence}`;
    const startIndex = this.frames.length;
    this.promptSent = true;
    this.send({ type: "prompt", id, message });
    await this.waitFor(() => this.frames.some((frame) => frame.type === "response" && frame.id === id), "command acknowledgement", 10_000);
    const acknowledgement = this.frames.find((frame) => frame.type === "response" && frame.id === id)!;
    if (acknowledgement.success !== true) throw new Error(`OMP rejected command: ${String(acknowledgement.error)}`);
    await this.waitFor(() => this.result(id, startIndex) !== undefined, `command prompt_result ${id}`, 15_000);
    const result = this.result(id, startIndex)!;
    if (result.frame.status !== "completed") throw new Error(`OMP command ${id} failed: ${JSON.stringify(result.frame.error ?? result.frame)}`);
    if (result.frame.agentInvoked !== false) throw new Error(`OMP command ${id} unexpectedly invoked an agent.`);
    const failure = this.providerFailure(startIndex, result.index);
    if (failure) throw new Error(`OMP command ${id} saw a provider failure: ${failure}`);
    await Bun.sleep(100);
    return result.frame;
  }

  /**
   * Actual OMP journal/model-context compaction through the official RPC
   * method. The fixture's session_before_compact override supplies the summary
   * and first kept entry; no remote summarizer is involved.
   */
  async compact(customInstructions: string): Promise<Frame> {
    if (!this.admitted) throw new Error("Refusing to compact before B1 admission.");
    const startIndex = this.frames.length;
    await this.request("compact", { customInstructions });
    await this.waitFor(
      () => this.frames.slice(startIndex).some((frame) => frame.type === "manual_compaction_end"),
      "manual compaction end",
      20_000,
    );
    const end = this.frames.slice(startIndex).find((frame) => frame.type === "manual_compaction_end")!;
    if (end.aborted === true) throw new Error(`OMP compaction was aborted: ${JSON.stringify(end)}`);
    await Bun.sleep(100);
    return end;
  }

  /** Poll the real fixture audit for a hook/provider event. */
  async waitForAudit(label: string, predicate: (event: Record<string, unknown>) => boolean, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const entries = await this.jsonl(this.fixtureAuditPath);
      const found = entries.find(predicate);
      if (found) return found;
      if (this.failure || this.exited) throw new Error(`${label}: ${this.failure?.message ?? "OMP exited"}\n${this.stderr}`);
      if (Date.now() >= deadline) throw new Error(`${label}: timed out\n${this.stderr}\n${JSON.stringify(this.frames.slice(-8))}`);
      await Bun.sleep(25);
    }
  }

  /** Native RPC session replacement; used only by navigation/session tests. */
  async newSession(): Promise<Frame> {
    if (!this.admitted) throw new Error("Refusing to replace the session before B1 admission.");
    return this.request("new_session");
  }

  /** Append-only fixture snapshot history; labels are never lost to a later hook. */
  async fixtureSnapshotHistory(): Promise<Frame[]> {
    return (await this.jsonl(`${this.fixtureSnapshotPath}.history`))
      .filter((value): value is Frame => typeof value === "object" && value !== null && !Array.isArray(value));
  }

  async fixtureSnapshot(): Promise<Frame | undefined> {
    const value = await this.json(this.fixtureSnapshotPath);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Frame : undefined;
  }

  async waitForFixture(label: string, predicate: (value: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const value = await this.fixtureSnapshot();
      if (value && predicate(value)) return value;
      if (this.failure || this.exited) throw new Error(`${label}: ${this.failure?.message ?? "OMP exited"}\n${this.stderr}`);
      if (Date.now() >= deadline) throw new Error(`${label}: timed out\n${this.stderr}\n${JSON.stringify(this.frames.slice(-8))}`);
      await Bun.sleep(20);
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

  async snapshot() {
    return {
      frames: [...this.frames],
      state: await this.json(this.statePath),
      audit: await this.jsonl(this.auditPath),
      fixtureAudit: await this.jsonl(this.fixtureAuditPath),
      fixtureSnapshot: await this.fixtureSnapshot(),
      counter: await this.json(path.join(this.root, "capability-counter.json")),
      jobRecord: this.jobRecordPath ? await this.json(this.jobRecordPath) : undefined,
      jobAudit: this.jobAuditPath ? await this.jsonl(this.jobAuditPath) : [],
      jobToolTrace: this.jobToolTracePath ? await this.jsonl(this.jobToolTracePath) : [],
      stderr: this.stderr,
      workspaceEntries: (await readdir(this.workspace)).sort(),
    };
  }

  private async json(filePath: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      return undefined;
    }
  }

  private async jsonl(filePath: string): Promise<Array<Record<string, unknown>>> {
    try {
      return (await readFile(filePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
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
        if (!this.stopping) this.fail(new Error("OMP exited before the B1 test completed."));
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
    const id = `b1-${++this.sequence}`;
    this.send({ ...data, type, id });
    await this.waitFor(() => this.frames.some((frame) => frame.type === "response" && frame.id === id), `${type} response`, 10_000);
    const response = this.frames.find((frame) => frame.type === "response" && frame.id === id)!;
    if (response.success !== true) throw new Error(`OMP ${type} failed: ${String(response.error || "unknown error")}`);
    return response;
  }

  private async waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (this.failure || this.exited) throw new Error(`${label}: ${this.failure?.message ?? "OMP exited"}\n${this.stderr}\n${JSON.stringify(this.frames.slice(-8))}`);
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
          try { process.kill(-child.pid!, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
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
