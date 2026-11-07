import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskBinding } from "../../src/identity.ts";
import { policyFingerprint, type ManagedPolicy } from "../../src/policy.ts";
import type { CheckMode } from "../../src/policy-check.ts";
import { commitArtifactAcceptance, type AcceptanceRecord } from "../../src/task-authority.ts";
import { BUSINESS_TOOL, EXTENSION_VERSION, READINESS_SCHEMA_VERSION, STATUS_TOOL } from "../../src/version.ts";
import {
  AdmissionError,
  assertAdmission,
  evaluateAdmission,
  EXPECTED_OMP_VERSION,
  FIXTURE_API,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  parseOmpVersion,
  type AdmissionCheck,
} from "./admission.ts";

export type Frame = Record<string, unknown>;
export type PolicyMode = "valid" | "missing" | "bad-fingerprint" | "bad-schema";

export interface ManagedRunOptions {
  scenario: string;
  policyMode?: PolicyMode;
  loadExtension?: boolean;
  builtinTools?: string[];
  extraTool?: boolean;
  checkMode?: CheckMode;
  checkDelayMs?: number;
  revoke?: boolean;
  toolCallTimeoutMs?: number;
  auditFailOn?: "business_written" | "business_written_persistent";
  prompt?: string;
  timeoutMs?: number;
}

export interface AdmissionOutcome {
  ok: boolean;
  error?: string;
  checks: AdmissionCheck[];
}

export interface ManagedAdmission extends AdmissionOutcome {
  ompVersion: string;
  state: Frame;
}

export interface FileSnapshot {
  path: string;
  bytes: number;
  sha256: string;
  mtimeMs: number;
  ino: number;
  content: string;
}

export interface RunSnapshot {
  workspaceEntries: string[];
  workspaceFiles: FileSnapshot[];
  audit: Array<Record<string, unknown>>;
  fixtureAudit: Array<Record<string, unknown>>;
  readiness?: unknown;
  status?: unknown;
  acceptance?: unknown;
  frames: Frame[];
  stderr: string;
  promptSent: boolean;
  admitted: boolean;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const POLICY_FIXTURE = path.join(REPO_ROOT, "policy/development-fixture.v1.json");
const FIXTURE_PROVIDER_PATH = path.join(REPO_ROOT, "test/fixtures/fixture-provider.mjs");
const EXTENSION_PATH = path.join(REPO_ROOT, "src/extension.ts");
const EXTRA_TOOL_PATH = path.join(REPO_ROOT, "test/fixtures/extra-tool.mjs");
const MAX_FRAME = 1024 * 1024;
const MAX_LOGICAL_FRAME = 64 * 1024 * 1024;

class RpcFrameDecoder {
  private chunk: { id: string; count: number; size: number; parts: Buffer[]; bytes: number } | undefined;

  decode(line: string): Frame | undefined {
    if (Buffer.byteLength(line) > MAX_FRAME) throw new Error("OMP RPC frame exceeds 1 MiB.");
    const frame = JSON.parse(line) as Frame;
    if (frame.type !== "rpc_chunk") {
      if (this.chunk) throw new Error("Interrupted RPC chunk sequence.");
      if (frame.type === "rpc_frame_error") throw new Error("OMP RPC logical frame overflow.");
      return frame;
    }
    const { chunkId, index, count, byteLength, data } = frame;
    if (typeof chunkId !== "string" || !chunkId
      || typeof index !== "number" || !Number.isSafeInteger(index)
      || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 100_000
      || typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_LOGICAL_FRAME
      || typeof data !== "string") {
      throw new Error("Invalid RPC chunk metadata.");
    }
    if (!this.chunk) {
      if (index !== 0) throw new Error("RPC chunk sequence must start at zero.");
      this.chunk = { id: chunkId, count, size: byteLength, parts: [], bytes: 0 };
    }
    const pending = this.chunk;
    if (pending.id !== chunkId || pending.count !== count || pending.size !== byteLength || pending.parts.length !== index) {
      throw new Error("Out-of-order or inconsistent RPC chunk sequence.");
    }
    const bytes = Buffer.from(data, "base64");
    pending.bytes += bytes.length;
    if (pending.bytes > pending.size) throw new Error("RPC chunks exceed their declared size.");
    pending.parts.push(bytes);
    if (pending.parts.length !== pending.count) return undefined;
    this.chunk = undefined;
    if (pending.bytes !== pending.size) throw new Error("RPC chunk byte length mismatch.");
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.parts))) as Frame;
    if (result.type === "rpc_chunk") throw new Error("Nested RPC chunks are forbidden.");
    return result;
  }

  finish(): void {
    if (this.chunk) throw new Error("RPC stream ended inside a chunk sequence.");
  }
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lineRecord(line: string, label: string): Record<string, unknown> {
  const value = JSON.parse(line) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not a JSON object.`);
  return value as Record<string, unknown>;
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function readJsonl(filePath: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split("\n").filter(Boolean).map((line) => lineRecord(line, `JSONL ${filePath}`));
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listFiles(root, child));
    else result.push(child);
  }
  return result;
}

function messageText(frame: Frame): string {
  const message = frame.message as { role?: unknown; content?: unknown } | undefined;
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * One real OMP RPC process, a deterministic in-process provider, a private
 * config/env, and a pre-prompt admission gate. Tests own start/prompt/snapshot/
 * cleanup so no prompt is sent on a failed admission.
 */
export class ManagedOmpSession {
  readonly root: string;
  readonly workspace: string;
  readonly agentDir: string;
  readonly policyPath: string;
  readonly policySha: string;
  readonly policy: ManagedPolicy;
  readonly bindingPath: string;
  readonly binding: TaskBinding;
  readonly readinessPath: string;
  readonly statusPath: string;
  readonly auditPath: string;
  readonly fixtureAuditPath: string;
  readonly acceptancePath: string;
  readonly configPath: string;
  readonly revokePath: string | undefined;
  readonly frames: Frame[] = [];
  readonly options: Required<Pick<ManagedRunOptions, "scenario">> & ManagedRunOptions;
  promptSent = false;
  admitted = false;
  admission: ManagedAdmission | undefined;

  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private decoder = new RpcFrameDecoder();
  private stderr = "";
  private failure: Error | undefined;
  private exited = false;
  private exitPromise: Promise<void> | undefined;
  private stopping = false;
  private sequence = 0;

  private constructor(
    private readonly values: {
      root: string;
      workspace: string;
      agentDir: string;
      policyPath: string;
      policySha: string;
      policy: ManagedPolicy;
      bindingPath: string;
      binding: TaskBinding;
      readinessPath: string;
      statusPath: string;
      auditPath: string;
      fixtureAuditPath: string;
      acceptancePath: string;
      configPath: string;
      revokePath: string | undefined;
    },
    options: ManagedRunOptions,
  ) {
    this.root = values.root;
    this.workspace = values.workspace;
    this.agentDir = values.agentDir;
    this.policyPath = values.policyPath;
    this.policySha = values.policySha;
    this.policy = values.policy;
    this.bindingPath = values.bindingPath;
    this.binding = values.binding;
    this.readinessPath = values.readinessPath;
    this.statusPath = values.statusPath;
    this.auditPath = values.auditPath;
    this.fixtureAuditPath = values.fixtureAuditPath;
    this.acceptancePath = values.acceptancePath;
    this.configPath = values.configPath;
    this.revokePath = values.revokePath;
    this.options = options;
  }

  static async create(options: ManagedRunOptions): Promise<ManagedOmpSession> {
    const root = await mkdtemp(path.join(tmpdir(), "omp-agent-g1a-"));
    const workspace = path.join(root, "workspace");
    const agentDir = path.join(root, "agent");
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(agentDir, { mode: 0o700 });
    const canonicalWorkspace = await realpath(workspace);

    const policyMode = options.policyMode ?? "valid";
    const sourceBytes = await readFile(POLICY_FIXTURE);
    let policyBytes = sourceBytes;
    if (policyMode === "bad-schema") {
      const value = JSON.parse(sourceBytes.toString("utf8")) as Record<string, unknown>;
      value.policyVersion = 0;
      policyBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    }
    const policyPath = path.join(root, "managed-policy.v1.json");
    if (policyMode !== "missing") await writeFile(policyPath, policyBytes, { mode: 0o600 });
    const policySha = policyMode === "bad-fingerprint"
      ? "0".repeat(64)
      : policyFingerprint(policyBytes);
    const policy = JSON.parse(sourceBytes.toString("utf8")) as ManagedPolicy;

    const identity = {
      schemaVersion: 1 as const,
      taskId: `task-g1a-${randomUUID()}`,
      taskRevision: 1,
      ownerId: `owner-g1a-${randomUUID()}`,
      runId: `run-g1a-${randomUUID()}`,
      attemptId: `attempt-g1a-${randomUUID()}`,
      executionEpoch: 1,
      workspaceRoot: canonicalWorkspace,
    };
    const bindingPath = path.join(root, "task-binding.json");
    await writeFile(bindingPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });

    const readinessPath = path.join(root, "readiness.json");
    const statusPath = path.join(root, "task-status.json");
    const auditPath = path.join(root, "extension-audit.jsonl");
    const fixtureAuditPath = path.join(root, "fixture-audit.jsonl");
    const acceptancePath = path.join(root, "acceptance.json");
    const revokePath = options.revoke ? path.join(root, "revoke.marker") : undefined;
    if (revokePath) await writeFile(revokePath, "revoked\n", { mode: 0o600 });
    await writeFile(auditPath, "", { mode: 0o600 });
    await writeFile(fixtureAuditPath, "", { mode: 0o600 });

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
      compaction: { enabled: false },
      advisor: { enabled: false },
      autolearn: { enabled: false },
      contextPromotion: { enabled: false },
      memory: { backend: "off" },
      tools: { approvalMode: "yolo", approval: {} },
      extensionHandlers: { toolCallTimeoutMs: options.toolCallTimeoutMs ?? 30_000 },
    }, null, 2), { mode: 0o600 });

    return new ManagedOmpSession({
      root,
      workspace: canonicalWorkspace,
      agentDir,
      policyPath,
      policySha,
      policy,
      bindingPath,
      binding: identity,
      readinessPath,
      statusPath,
      auditPath,
      fixtureAuditPath,
      acceptancePath,
      configPath,
      revokePath,
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
    env.G1A_FIXTURE_SCENARIO = this.options.scenario;
    env.G1A_FIXTURE_AUDIT = this.fixtureAuditPath;
    if (this.options.checkMode) env.OMP_AGENT_FIXTURE_CHECK_MODE = this.options.checkMode;
    if (this.options.checkDelayMs !== undefined) env.OMP_AGENT_FIXTURE_CHECK_DELAY_MS = String(this.options.checkDelayMs);
    if (this.options.auditFailOn) env.OMP_AGENT_FIXTURE_AUDIT_FAIL_ON = this.options.auditFailOn;
    if (this.revokePath) env.OMP_AGENT_REVOKE_PATH = this.revokePath;
    if (this.options.loadExtension !== false) {
      env.OMP_AGENT_POLICY_PATH = this.policyPath;
      env.OMP_AGENT_POLICY_SHA256 = this.policySha;
      env.OMP_AGENT_BINDING_PATH = this.bindingPath;
      env.OMP_AGENT_READY_PATH = this.readinessPath;
      env.OMP_AGENT_STATUS_PATH = this.statusPath;
      env.OMP_AGENT_AUDIT_PATH = this.auditPath;
    }
    return env;
  }

  private args(): string[] {
    const builtinTools = this.options.builtinTools ?? [];
    const args = [
      "--mode", "rpc", "--no-ui",
      ...(builtinTools.length ? ["--tools", builtinTools.join(",")] : ["--no-tools"]),
      "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-pty",
      "--no-session", "--no-title", "--no-prewalk", "--approval-mode", "yolo",
      "--config", this.configPath,
      "--model", `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`,
      "--thinking", "off",
      "--max-time", "20",
      "--max-cost", "0.1",
      "--extension", FIXTURE_PROVIDER_PATH,
    ];
    if (this.options.loadExtension !== false) args.push("--extension", EXTENSION_PATH);
    if (this.options.extraTool) args.push("--extension", EXTRA_TOOL_PATH);
    return args;
  }

  private executable(): string {
    return process.env.OMP_COMMAND || "omp";
  }

  private version(): string {
    const result = spawnSync(this.executable(), ["--version"], {
      env: { PATH: process.env.PATH, HOME: homedir() },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8192,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`OMP is unavailable: ${result.error?.message ?? `exit ${result.status}`}. Set OMP_COMMAND or install OMP ${EXPECTED_OMP_VERSION}.`);
    }
    return parseOmpVersion(result.stdout);
  }

  async start(): Promise<ManagedAdmission> {
    const ompVersion = this.version();
    if (ompVersion !== EXPECTED_OMP_VERSION) {
      const admission: ManagedAdmission = {
        ok: false,
        error: `OMP version mismatch: actual=${ompVersion} expected=${EXPECTED_OMP_VERSION}`,
        checks: [],
        ompVersion,
        state: {},
      };
      this.admission = admission;
      return admission;
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
    const model = (state.model ?? {}) as Frame;
    const dumpTools = Array.isArray(state.dumpTools) ? state.dumpTools as Array<{ name?: unknown }> : [];
    const readiness = await readJson(this.readinessPath);
    const readinessExists = existsSync(this.readinessPath);
    const expectedTools = [STATUS_TOOL, BUSINESS_TOOL];
    const expectedPolicy = {
      id: this.policy.policyId,
      version: this.policy.policyVersion,
      scope: this.policy.scope,
      sha256: policyFingerprint(await readFile(this.policyPath).catch(() => readFile(POLICY_FIXTURE))),
    };
    const admissionInput = {
      ompVersion,
      expectedOmpVersion: EXPECTED_OMP_VERSION,
      model: { provider: model.provider, id: model.id, api: model.api },
      dumpTools,
      expectedTools,
      readiness,
      readinessExists,
      expectedReadinessSchemaVersion: READINESS_SCHEMA_VERSION,
      expectedExtensionVersion: EXTENSION_VERSION,
      expectedPolicy,
      expectedIdentity: this.binding,
      expectedWorkspaceRoot: this.workspace,
    };
    const checks = evaluateAdmission(admissionInput);
    const failures = checks.filter((check) => !check.ok);
    const admission: ManagedAdmission = {
      ok: failures.length === 0,
      ...(failures.length ? { error: `Admission failed: ${failures.map((check) => check.name).join(", ")}` } : {}),
      checks,
      ompVersion,
      state,
    };
    this.admission = admission;
    if (!admission.ok) return admission;
    try {
      assertAdmission(admissionInput);
    } catch (error) {
      if (error instanceof AdmissionError) return { ...admission, ok: false, error: error.message };
      throw error;
    }
    this.admitted = true;
    await this.request("set_auto_retry", { enabled: false });
    await this.request("set_auto_compaction", { enabled: false });
    await this.request("set_cache_warming", { mode: "off" });
    await this.request("set_event_filter", {
      events: ["agent_start", "agent_end", "message_end", "tool_execution_start", "tool_execution_end", "extension_error", "notice", "prompt_result", "session_settled"],
    });
    return admission;
  }

  async prompt(message?: string): Promise<void> {
    if (!this.admitted) throw new Error("Refusing to send a business prompt before admission.");
    const text = message ?? "Please perform the managed fixture task and write the policy-bound deliverable.";
    const id = `prompt-${++this.sequence}`;
    const startIndex = this.frames.length;
    this.promptSent = true;
    this.send({ type: "prompt", id, message: text });
    await this.waitFor(
      () => this.frames.some((frame) => frame.type === "response" && frame.id === id),
      "prompt acknowledgement",
      10_000,
    );
    const acknowledgement = this.frames.find((frame) => frame.type === "response" && frame.id === id)!;
    if (acknowledgement.success !== true) throw new Error(`OMP rejected prompt: ${String(acknowledgement.error)}`);
    const acknowledgedInvoked = (acknowledgement.data as Frame | undefined)?.agentInvoked;
    if (acknowledgedInvoked === false) throw new Error(`OMP accepted prompt ${id} without invoking an agent.`);

    const deadline = Date.now() + (this.options.timeoutMs ?? 20_000);
    const remaining = (): number => Math.max(1, deadline - Date.now());

    await this.waitFor(
      () => this.promptResult(id, startIndex) !== undefined,
      `prompt_result ${id}`,
      remaining(),
    );
    const result = this.promptResult(id, startIndex)!;
    const status = result.frame.status;
    if (status !== "completed") {
      const error = result.frame.error as Frame | undefined;
      const detail = typeof error?.message === "string" ? error.message : JSON.stringify(error ?? null);
      throw new Error(`OMP prompt ${id} ended with status ${String(status)}: ${detail}`);
    }
    if (result.frame.agentInvoked !== true) {
      throw new Error(`OMP prompt ${id} completed without agentInvoked=true.`);
    }

    let markerIndex = startIndex;
    if (this.options.scenario === "happy") {
      await this.waitFor(
        () => this.frames.some((frame, index) => index > startIndex && index < result.index
          && frame.type === "message_end" && messageText(frame).includes("BACKGROUND_SEEN")),
        "background follow-up",
        remaining(),
      );
      markerIndex = this.frames.findIndex((frame, index) => index > startIndex && index < result.index
        && frame.type === "message_end" && messageText(frame).includes("BACKGROUND_SEEN"));
    }

    const terminalIndex = this.frames.findIndex((frame, index) => index > markerIndex && index <= result.index
      && frame.type === "agent_end" && frame.isTerminal === true);
    if (terminalIndex === -1) {
      throw new Error(`OMP prompt ${id} completed without a relevant terminal agent_end.`);
    }

    const providerFailure = this.promptProviderFailure(startIndex, result.index);
    if (providerFailure !== undefined) {
      throw new Error(`OMP prompt ${id} completed with a provider failure: ${providerFailure}`);
    }

    if (result.frame.sessionSettled !== true) {
      await this.waitFor(
        () => this.frames.some((frame, index) => index > result.index && frame.type === "session_settled"),
        `session_settled after ${id}`,
        remaining(),
      );
    }
    await Bun.sleep(150);
  }

  private promptResult(id: string, startIndex: number): { frame: Frame; index: number } | undefined {
    for (let index = startIndex; index < this.frames.length; index += 1) {
      const frame = this.frames[index]!;
      if (frame.type === "prompt_result" && frame.id === id) return { frame, index };
    }
    return undefined;
  }

  private promptProviderFailure(startIndex: number, endIndex: number): string | undefined {
    for (let index = startIndex; index <= endIndex; index += 1) {
      const frame = this.frames[index]!;
      if (frame.type === "error") return `error frame ${JSON.stringify(frame.error ?? frame)}`;
      const messages = frame.type === "agent_end" && Array.isArray(frame.messages)
        ? frame.messages
        : frame.type === "message_end"
          ? [frame.message]
          : [];
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

  async snapshot(): Promise<RunSnapshot> {
    const workspaceEntries = await listFiles(this.workspace);
    const workspaceFiles: FileSnapshot[] = [];
    for (const relative of workspaceEntries) {
      const full = path.join(this.workspace, relative);
      const info = await lstat(full);
      const bytes = await readFile(full);
      workspaceFiles.push({
        path: relative,
        bytes: bytes.length,
        sha256: sha256(bytes),
        mtimeMs: info.mtimeMs,
        ino: info.ino,
        content: bytes.toString("utf8"),
      });
    }
    return {
      workspaceEntries,
      workspaceFiles,
      audit: await readJsonl(this.auditPath),
      fixtureAudit: await readJsonl(this.fixtureAuditPath),
      readiness: await readJson(this.readinessPath),
      status: await readJson(this.statusPath),
      acceptance: await readJson(this.acceptancePath),
      frames: [...this.frames],
      stderr: this.stderr,
      promptSent: this.promptSent,
      admitted: this.admitted,
    };
  }

  async commitAcceptance(expectedContent?: string): Promise<AcceptanceRecord> {
    return commitArtifactAcceptance({
      binding: this.binding,
      policy: this.policy,
      policyFingerprint: policyFingerprint(await readFile(POLICY_FIXTURE)),
      acceptancePath: this.acceptancePath,
      ...(expectedContent === undefined ? {} : { expectedContent }),
    });
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
          if (!frame) continue;
          this.frames.push(frame);
        }
        if (this.buffer.length > MAX_FRAME) throw new Error("Unfinished OMP RPC frame exceeds 1 MiB.");
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
        if (!this.stopping) this.fail(new Error("OMP exited before the test completed."));
        resolve();
      });
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
  }

  private send(frame: Frame): void {
    if (this.failure) throw this.failure;
    if (!this.child || this.exited) throw new Error("OMP process is not running.");
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > MAX_FRAME) throw new Error("Outbound RPC frame exceeds 1 MiB.");
    this.child.stdin.write(line);
  }

  private async request(type: string, data: Frame = {}): Promise<Frame> {
    const id = `g1a-${++this.sequence}`;
    this.send({ ...data, type, id });
    await this.waitFor(
      () => this.frames.some((frame) => frame.type === "response" && frame.id === id),
      `${type} response`,
      10_000,
    );
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
      if (Date.now() >= deadline) {
        throw new Error(`${label}: timed out\n${this.stderr}\n${JSON.stringify(this.frames.slice(-8))}`);
      }
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

  private async waitForGroupExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (!this.groupExists()) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
      await Bun.sleep(20);
    }
    return false;
  }

  async cleanup(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    try {
      if (child) {
        try { child.stdin.end(); } catch { /* already closed */ }
        if (this.exitPromise) await Promise.race([this.exitPromise, Bun.sleep(1000)]);
        if (this.groupExists()) {
          try { process.kill(-child.pid!, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          await this.waitForGroupExit(1000);
        }
        if (this.groupExists()) {
          try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          await this.waitForGroupExit(1000);
        }
        if (this.groupExists()) throw new Error("OMP process group did not exit after SIGKILL.");
      }
    } finally {
      await rm(this.root, { recursive: true, force: true });
    }
  }
}
