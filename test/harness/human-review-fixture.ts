import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TrustedContractSpec } from "../../src/acceptance-contract.ts";
import { createDeliveryEntry, DELIVERY_TOOL } from "../../src/delivery-entry.ts";
import type { AcceptanceReviewEvidence } from "../../src/delivery-service.ts";
import { createExecutionEntry, type ExecutionEntryControls } from "../../src/execution-entry.ts";
import { clearPublishedTaskOwner, publishTaskOwner, type OmpToolContext } from "../../src/task-entry-port.ts";
import { TaskOwner, type TaskSubject } from "../../src/task-owner.ts";
import { VERIFICATION_TOOL } from "../../src/verification-entry.ts";
import type { TrustedVerifier } from "../../src/verification-service.ts";
import type { HumanReviewOption } from "../../src/human-review-types.ts";

const SESSION = "g2b2c1-session";
const NOW = "2026-11-08T00:00:00.000Z";
const PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";
const LAUNCHER = path.resolve(import.meta.dir, "../../scripts/isolated-exec.py");

type Entry = Record<string, unknown> & { id: string; parentId: string | null };

function base(): Entry {
  return { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} };
}

function user(id: string, parentId: string, text: string): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], attribution: "user" },
  };
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: OmpToolContext,
  ): Promise<ToolResult>;
}

interface FakePi {
  tools: Map<string, RegisteredTool>;
  handlers: Map<string, (event: unknown) => unknown>;
  pi: Parameters<typeof createExecutionEntry>[0];
}

function fakePi(): FakePi {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (event: unknown) => unknown>();
  return {
    tools,
    handlers,
    pi: {
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
      on(event: string, handler: (event: unknown) => unknown) {
        handlers.set(event, handler);
      },
    } as Parameters<typeof createExecutionEntry>[0],
  };
}

let WORKSPACE = "";

function subject(branch: readonly unknown[]): TaskSubject {
  return { sessionId: SESSION, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

export function context(branchSource: readonly unknown[] | (() => readonly unknown[])): OmpToolContext {
  const branch = typeof branchSource === "function" ? branchSource : () => branchSource;
  return {
    cwd: WORKSPACE,
    agent: { kind: "main" },
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getSessionId: () => SESSION,
      getLeafId: () => null,
      getBranch: branch,
    },
  };
}

export function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

export function line(text: string, prefix: string): string | undefined {
  return text.split("\n").find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

export function passVerifier(): TrustedVerifier {
  return {
    id: "fixture-semantic",
    version: "1",
    check(input) {
      const artifact = input.candidate.artifacts.find((item) => item.relativePath === "answer.txt");
      return {
        conditions: [{
          conditionId: "answer",
          result: artifact?.data.toString("utf8").includes("42") ? "pass" : "fail",
          detail: "fixture check detail",
        }],
      };
    },
  };
}

export function extraVerifier(): TrustedVerifier {
  return {
    id: "fixture-semantic",
    version: "1",
    check() {
      return {
        conditions: [
          { conditionId: "answer", result: "pass", detail: "answer is 42" },
          { conditionId: "unknown-extra", result: "pass", detail: "not declared" },
        ],
      };
    },
  };
}

export function missingVerifier(): TrustedVerifier {
  return { id: "fixture-semantic", version: "1", check: () => ({ conditions: [] }) };
}

export function failVerifier(): TrustedVerifier {
  return {
    id: "fixture-semantic",
    version: "1",
    check: () => ({ conditions: [{ conditionId: "answer", result: "fail", detail: "fixture failure" }] }),
  };
}

export function malformedVerifier(): TrustedVerifier {
  return {
    id: "fixture-semantic",
    version: "1",
    check: () => ({ conditions: "not-an-array" }) as unknown as { conditions: [] },
  };
}

export function hugeVerifier(): TrustedVerifier {
  return {
    id: "fixture-semantic",
    version: "1",
    check: () => ({ conditions: [{ conditionId: "answer", result: "pass", detail: "x".repeat(20_000) }] }),
  };
}

export function passSpec(overrides: Partial<TrustedContractSpec> = {}): TrustedContractSpec {
  return {
    hostConfig: { id: "host-fixture", version: "1" },
    verifier: { id: "fixture-semantic", version: "1", parameters: { secret: "never-in-record" } },
    conditions: [{
      conditionId: "answer",
      description: "fixture semantic condition",
      kind: "semantic",
      coveredRevisions: [1],
    }],
    coverage: {
      kind: "semantic",
      complete: true,
      coveredRevisions: [1],
      statement: "host fixture binds this exact requirement",
    },
    ...overrides,
  };
}

export function partialSpec(): TrustedContractSpec {
  return passSpec({
    coverage: {
      kind: "semantic",
      complete: false,
      coveredRevisions: [1],
      statement: "host fixture declares partial semantic coverage",
    },
  });
}

export interface HumanFixture {
  root: string;
  workspace: string;
  deliveryRoot: string;
  acceptanceRoot: string;
  owner: TaskOwner;
  branch: readonly Entry[];
  live: { branch: readonly Entry[] };
  ctx: OmpToolContext;
  entry: ExecutionEntryControls;
  tools: Map<string, RegisteredTool>;
  run(): Promise<{ runId: string; artifactIds: string[] }>;
  verify(runId: string, artifactIds: string[]): Promise<string>;
  preview(runId: string, artifactIds: string[], receiptId?: string): Promise<{ deliveryId: string; text: string }>;
  readReview(deliveryId: string, signal?: AbortSignal): Promise<AcceptanceReviewEvidence>;
  bind(spec?: TrustedContractSpec): void;
  selector(deliveryId: string): { expectedTaskId: string; expectedTaskRevision: number; deliveryId: string };
  request(deliveryId: string, signal?: AbortSignal): Promise<import("../../src/acceptance-service.ts").HumanReviewOperationResult>;
  submit(deliveryId: string): Promise<import("../../src/acceptance-service.ts").AcceptanceOperationResult>;
  inspect(deliveryId: string): Promise<import("../../src/acceptance-service.ts").AcceptedInspectionResult>;
  cleanup(): Promise<void>;
}

const SOURCE = `
from pathlib import Path
Path("answer.txt").write_text("42\\n", encoding="utf-8")
print("artifact written")
`;

export async function createHumanFixture(options: {
  verifier?: TrustedVerifier;
  humanReview?: HumanReviewOption;
  withAcceptance?: boolean;
  source?: string;
  requirementText?: string;
} = {}): Promise<HumanFixture> {
  const source = options.source ?? SOURCE;
  const requirementText = options.requirementText ?? "Produce an accepted answer.";
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2c1-")));
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2c1-ws-")));
  WORKSPACE = workspace;
  const deliveryRoot = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2c1-del-")));
  const acceptanceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b2c1-acc-")));
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: workspace,
    ownerId: "owner-g2b2c1",
    authorizedCapabilities: ["local-script"],
    now: () => NOW,
    id: () => `owner-id-${++sequence}`,
  });
  const branch = [base(), user("user-1", "leaf-1", requirementText)];
  const live = { branch };
  const ctx = context(() => live.branch);
  owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: workspace,
    source: "rpc",
    text: requirementText,
    observedAt: NOW,
    baseLeafId: "leaf-1",
  });
  owner.observeAgentStart({ sessionId: SESSION, prompt: requirementText, reason: "prompt" });
  owner.start(subject(branch), requirementText);
  publishTaskOwner(owner);
  const fake = fakePi();
  const entry = createExecutionEntry(fake.pi, {
    root,
    capabilityId: "local-script",
    pythonPath: PYTHON,
    bunPath: process.execPath,
    launcherPath: LAUNCHER,
    trustedVerifiers: [options.verifier ?? passVerifier()],
    deliveryRoot,
    ...(options.withAcceptance === false ? {} : { acceptanceRoot }),
    ...(options.humanReview === undefined ? {} : { humanReview: options.humanReview }),
  });
  const fixture: HumanFixture = {
    root,
    workspace,
    deliveryRoot,
    acceptanceRoot,
    owner,
    branch,
    live,
    ctx,
    entry,
    tools: fake.tools,
    async run() {
      const task = owner.snapshot().currentTask!;
      const result = await entry.adapter.run(ctx, {
        action: "run",
        runtime: "python",
        source,
        inputIds: [],
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
      });
      if (result.isError !== undefined) throw new Error(textOf(result));
      const details = result.details as Record<string, unknown>;
      const artifacts = details.artifacts as Array<{ artifactId: string }>;
      return { runId: String(details.runId), artifactIds: artifacts.map((artifact) => artifact.artifactId) };
    },
    async verify(runId, artifactIds) {
      const task = owner.snapshot().currentTask!;
      const result = await fake.tools.get(VERIFICATION_TOOL)!.execute("verify", {
        action: "verify",
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
        runId,
        artifactIds,
      }, undefined, undefined, ctx);
      if (result.isError !== undefined) throw new Error(textOf(result));
      return (result.details as { receiptId: string }).receiptId;
    },
    async preview(runId, artifactIds, receiptId) {
      const task = owner.snapshot().currentTask!;
      const result = await fake.tools.get(DELIVERY_TOOL)!.execute("preview", {
        action: "preview",
        expectedTaskId: task.taskId,
        expectedTaskRevision: task.taskRevision,
        runId,
        artifactIds,
        ...(receiptId === undefined ? {} : { verificationReceiptId: receiptId }),
      }, undefined, undefined, ctx);
      if (result.isError !== undefined) throw new Error(textOf(result));
      const text = textOf(result);
      return { deliveryId: line(text, "deliveryId: ")!, text };
    },
    readReview(deliveryId, signal) {
      return entry.delivery!.readAcceptanceReviewEvidence(ctx, fixture.selector(deliveryId), signal);
    },
    bind(spec = passSpec()) {
      entry.bindContract(ctx, spec);
    },
    selector(deliveryId) {
      const task = owner.snapshot().currentTask!;
      return { expectedTaskId: task.taskId, expectedTaskRevision: task.taskRevision, deliveryId };
    },
    async request(deliveryId, signal) {
      return entry.acceptance!.requestHumanReview(ctx, fixture.selector(deliveryId), signal);
    },
    async submit(deliveryId) {
      return entry.acceptance!.submit(ctx, fixture.selector(deliveryId));
    },
    async inspect(deliveryId) {
      return entry.acceptance!.inspect(ctx, fixture.selector(deliveryId));
    },
    async cleanup() {
      entry.dispose();
      clearPublishedTaskOwner();
      await rm(root, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(deliveryRoot, { recursive: true, force: true });
      await rm(acceptanceRoot, { recursive: true, force: true });
    },
  };
  return fixture;
}
