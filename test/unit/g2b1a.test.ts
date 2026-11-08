import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AcceptanceContractStore,
  type TrustedContractSpec,
} from "../../src/acceptance-contract.ts";
import { CandidateRegistry } from "../../src/execution-candidates.ts";
import { ExecutionAdapter, type ExecutionToolContext } from "../../src/execution-adapter.ts";
import type { FrozenTaskRef } from "../../src/execution-candidates.ts";
import { writeJsonAtomicSync } from "../../src/host-record.ts";
import { TaskOwner, type ManagedTask, type TaskSubject } from "../../src/task-owner.ts";
import { requirementsDigest } from "../../src/task-requirements.ts";
import {
  VerificationService,
  type TrustedVerifier,
  type VerificationRequest,
  type VerificationResult,
} from "../../src/verification-service.ts";

const SESSION = "g2b1a-session";
const NOW = "2026-11-08T00:00:00.000Z";
const PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";
const BUN = process.execPath;
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

function assistant(id: string, parentId: string): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "working" }] },
  };
}

function messageOf(entry: Entry): Record<string, unknown> {
  return { ...(entry.message as Record<string, unknown>), id: entry.id };
}

function subject(branch: readonly unknown[]): TaskSubject {
  return { sessionId: SESSION, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

function guard(owner: TaskOwner, taskRevision?: number) {
  const task = owner.snapshot().currentTask;
  if (!task) throw new Error("test setup: no current task");
  return { taskId: task.taskId, taskRevision: taskRevision ?? task.taskRevision };
}

let WORKSPACE = "";

function context(branch: readonly unknown[], leafId: string): ExecutionToolContext {
  return {
    cwd: WORKSPACE,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => SESSION,
      getLeafId: () => leafId,
      getBranch: () => branch,
    },
  };
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface Fixture {
  root: string;
  workspace: string;
  owner: TaskOwner;
  branch: readonly Entry[];
  secondBranch: readonly Entry[] | null;
  ctx: ExecutionToolContext;
  live: { branch: readonly Entry[] };
  adapter: ExecutionAdapter;
  contracts: AcceptanceContractStore;
  cleanup: () => Promise<void>;
}

async function fixture(options: {
  recordWriter?: (filePath: string, value: unknown) => void;
  prepareAmendment?: boolean;
} = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b1a-")));
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2b1a-ws-")));
  WORKSPACE = workspace;
  const fixtures = path.join(root, "fixtures");
  await mkdir(fixtures);
  const alphaPath = path.join(fixtures, "alpha.txt");
  await writeFile(alphaPath, "authorized alpha input\n", { mode: 0o600 });
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: workspace,
    ownerId: "owner-g2b1a",
    authorizedCapabilities: ["local-script"],
    now: () => NOW,
    id: () => `id-${++sequence}`,
  });
  const branch = [base(), user("user-1", "leaf-1", "Produce a candidate artifact.")];
  const ctx = context(branch, "user-1");
  owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: workspace,
    source: "rpc",
    text: "Produce a candidate artifact.",
    observedAt: NOW,
    baseLeafId: "leaf-1",
  });
  owner.observeAgentStart({ sessionId: SESSION, prompt: "Produce a candidate artifact.", reason: "prompt" });
  owner.start(subject(branch), "Produce a candidate artifact.");
  let secondBranch: readonly Entry[] | null = null;
  if (options.prepareAmendment === true) {
    const grant = owner.snapshot().activeGrant!;
    expect(owner.closeTurn({
      sessionId: SESSION,
      branch,
      messages: [messageOf(user("user-1", "leaf-1", grant.text))],
    })).toBe(true);
    const second = [...branch, assistant("assistant-1", "user-1"), user("user-2", "assistant-1", "Amended requirement.")];
    expect(owner.observeInput({
      sessionId: SESSION,
      workspaceRoot: workspace,
      source: "rpc",
      text: "Amended requirement.",
      observedAt: NOW,
      baseLeafId: "assistant-1",
    }).accepted).toBe(true);
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Amended requirement.", reason: "prompt" });
    secondBranch = second;
  }
  const adapter = new ExecutionAdapter(owner, {
    root,
    inputs: [{ id: "alpha", path: alphaPath }],
    capabilityId: "local-script",
    pythonPath: PYTHON,
    bunPath: BUN,
    launcherPath: LAUNCHER,
    ...(options.recordWriter === undefined ? {} : { recordWriter: options.recordWriter }),
    id: () => `run-${++sequence}`,
    now: () => NOW,
  });
  const contracts = new AcceptanceContractStore({
    currentTask: () => owner.snapshot().currentTask,
    now: () => NOW,
    id: () => `contract-${++sequence}`,
  });
  return {
    root,
    workspace,
    owner,
    branch,
    secondBranch,
    ctx,
    live: { branch },
    adapter,
    contracts,
    cleanup: async () => {
      adapter.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

function amendTask(f: Fixture): readonly Entry[] {
  const grant = f.owner.snapshot().activeGrant!;
  expect(f.owner.closeTurn({
    sessionId: SESSION,
    branch: f.branch,
    messages: [messageOf(user("user-1", "leaf-1", grant.text))],
  })).toBe(true);
  const second = [...f.branch, assistant("assistant-1", "user-1"), user("user-2", "assistant-1", "Amended requirement.")];
  expect(f.owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: f.workspace,
    source: "rpc",
    text: "Amended requirement.",
    observedAt: NOW,
    baseLeafId: "assistant-1",
  }).accepted).toBe(true);
  f.owner.observeAgentStart({ sessionId: SESSION, prompt: "Amended requirement.", reason: "prompt" });
  return second;
}

function frozenNow(owner: TaskOwner): FrozenTaskRef {
  const task = owner.snapshot().currentTask;
  if (!task) throw new Error("test setup: no task");
  return {
    ownerId: task.ownerId,
    taskId: task.taskId,
    taskRevision: task.taskRevision,
    requirementsDigest: requirementsDigest(task.requirementSources),
  };
}

function passSpec(overrides: { kind?: "semantic" | "integrity"; covered?: number[]; conditionCovered?: number[] } = {}): TrustedContractSpec {
  const kind = overrides.kind ?? "semantic";
  const covered = overrides.covered ?? [1];
  const conditionCovered = overrides.conditionCovered ?? covered;
  return {
    hostConfig: { id: "host-fixture", version: "1" },
    verifier: { id: "fixture-semantic", version: "1", parameters: { fixture: true } },
    conditions: [{
      conditionId: "answer",
      description: "fixture semantic condition",
      kind,
      coveredRevisions: conditionCovered,
    }],
    coverage: {
      kind,
      complete: true,
      coveredRevisions: covered,
      statement: "host fixture binds this exact requirement",
    },
  };
}

function passVerifier(): TrustedVerifier {
  return {
    id: "fixture-semantic",
    version: "1",
    check(input) {
      const artifact = input.candidate.artifacts.find((item) => item.relativePath === "answer.txt")
        ?? input.candidate.artifacts.find((item) => item.relativePath === "failed.txt");
      const text = artifact?.data.toString("utf8") ?? "";
      // The verifier mutates only its independent copy; the archive must not change.
      if (artifact) artifact.data.fill(0);
      return {
        conditions: [{
          conditionId: "answer",
          result: text.includes("42") || text.includes("partial") ? "pass" : "fail",
          detail: "trusted-detail-marker",
        }],
      };
    },
  };
}

function serviceWith(f: Fixture, verifier: TrustedVerifier, timeoutMs = 1000, contracts = f.contracts): VerificationService {
  return new VerificationService({
    owner: f.owner,
    liveSubject: () => subject(f.live.branch),
    candidates: f.adapter.candidates,
    contracts,
    verifiers: [verifier],
    timeoutMs,
    now: () => NOW,
    id: (() => {
      let index = 0;
      return () => `service-${++index}`;
    })(),
  });
}

async function runPython(f: Fixture, source: string, inputIds: string[] = []): Promise<{ result: any; details: any }> {
  const result = await f.adapter.run(f.ctx, {
    action: "run",
    runtime: "python",
    source,
    inputIds,
    expectedTaskId: f.owner.snapshot().currentTask!.taskId,
    expectedTaskRevision: f.owner.snapshot().currentTask!.taskRevision,
  });
  return { result, details: result.details as Record<string, any> };
}

function runIdOf(details: Record<string, any>): string {
  return details.runId as string;
}

function artifactIdsOf(details: Record<string, any>): string[] {
  return (details.artifacts as Array<{ artifactId: string }>).map((item) => item.artifactId);
}

function archivePath(f: Fixture, details: Record<string, any>, artifactId = "artifact-1"): string {
  const runDir = path.dirname(path.join(f.root, details.hostRecordRef as string));
  return path.join(runDir, "artifacts", `${artifactId}.bin`);
}

const ANSWER_SOURCE = `
open("answer.txt", "w").write("42\\n")
print("answer written")
`;

const NONZERO_SOURCE = `
open("failed.txt", "w").write("partial\\n")
raise SystemExit(3)
`;

describe("G2-B1a candidate registry, contract and verification", () => {
  test("real archive reaches a complete semantic contract, keeps owner active, and lookup rechecks bytes", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      f.contracts.bindContract(frozen, frozen.requirementsDigest, passSpec());
      const service = serviceWith(f, passVerifier());
      const { details } = await runPython(f, ANSWER_SOURCE, ["alpha"]);
      expect(details.candidateRegistration).toMatchObject({ registered: 1, idempotent: 0 });
      expect(details.requirementsDigest).toBe(frozen.requirementsDigest);
      expect(details.artifactsTotal).toBe(1);
      const snapshot = await f.adapter.candidates.resolveSnapshot(frozen, {
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(snapshot.artifacts[0]!.data.toString("utf8")).toBe("42\n");
      expect(snapshot.source.sha256).toMatch(/^sha256:/);
      expect(snapshot.inputs).toHaveLength(1);
      expect(snapshot.inputs[0]!.id).toBe("alpha");
      expect(snapshot.inputs[0]!.bytes).toBe(Buffer.byteLength("authorized alpha input\n"));
      expect(snapshot.inputs[0]!.sha256).toBe(sha256("authorized alpha input\n"));
      expect(snapshot.provenance.exitCode).toBe(0);
      // The returned copy is independent of registry/archive bytes.
      snapshot.artifacts[0]!.data[0] = 0x58;
      const rechecked = await f.adapter.candidates.recheckSnapshot(snapshot.snapshotId, frozen);
      expect(rechecked.artifacts[0]!.data.toString("utf8")).toBe("42\n");

      const verified = await service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(verified.outcome).toBe("pass");
      expect(verified.taskAccepted).toBe(false);
      expect(verified.receipt?.taskAccepted).toBe(false);
      expect(verified.receipt?.conditions[0]).toMatchObject({ conditionId: "answer", result: "pass" });
      expect(verified.receipt?.candidates.artifacts[0]!.sha256).toBe(sha256("42\n"));
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
      expect(new TextEncoder().encode(verified.modelView).byteLength).toBeLessThanOrEqual(16 * 1024);
      expect(verified.modelView).toContain("taskAccepted: false");
      expect(verified.modelView).toContain("outcome: pass");
      expect(verified.modelView).toContain("receiptId:");

      const returned = verified.receipt!;
      returned.conditions[0]!.result = "fail";
      returned.candidates.artifacts[0]!.relativePath = "mutated.txt";
      const lookedUp = await service.lookup(verified.receipt!.receiptId);
      expect(lookedUp?.usable).toBe(true);
      expect(lookedUp?.receipt.outcome).toBe("pass");
      expect(lookedUp?.receipt.conditions[0]!.result).toBe("pass");
      expect(lookedUp?.receipt.candidates.artifacts[0]!.relativePath).toBe("answer.txt");
    } finally {
      await f.cleanup();
    }
  });

  test("nonzero exit remains a real archived candidate with provenance, not blanket success or deletion", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      f.contracts.bindContract(frozen, frozen.requirementsDigest, passSpec());
      const service = serviceWith(f, passVerifier());
      const { result, details } = await runPython(f, NONZERO_SOURCE);
      expect(result.isError).toBe(true);
      expect(details.dispatch.exitCode).toBe(3);
      expect(details.candidateRegistration).toMatchObject({ registered: 1, idempotent: 0 });
      expect(details.artifactsTotal).toBe(1);
      const snapshot = await f.adapter.candidates.resolveSnapshot(frozen, {
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(snapshot.provenance.exitCode).toBe(3);
      expect(snapshot.provenance.spawned).toBe(true);
      expect(snapshot.artifacts[0]!.data.toString("utf8")).toBe("partial\n");
      const record = JSON.parse(await readFile(path.join(f.root, details.hostRecordRef as string), "utf8"));
      expect(record.process.exitCode).toBe(3);
      expect(record.artifacts).toHaveLength(1);
      expect(record.artifacts[0].sha256).toBe(sha256("partial\n"));
      const verified = await service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(verified.outcome).toBe("pass");
      expect(verified.receipt?.taskAccepted).toBe(false);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await f.cleanup();
    }
  });

  test("integrity-only and empty semantic condition coverage stay insufficient", async () => {
    const f = await fixture();
    try {
      const { details } = await runPython(f, ANSWER_SOURCE);
      const frozen = frozenNow(f.owner);
      const integrityStore = new AcceptanceContractStore({
        currentTask: () => f.owner.snapshot().currentTask,
        now: () => NOW,
        id: () => "contract-integrity",
      });
      integrityStore.bindContract(frozen, frozen.requirementsDigest, passSpec({ kind: "integrity" }));
      const integrity = await serviceWith(f, passVerifier(), 1000, integrityStore).verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(integrity.outcome).toBe("insufficient");
      expect(integrity.receipt?.conditions[0]!.result).toBe("pass");
      expect(integrity.usable).toBe(false);

      const emptyStore = new AcceptanceContractStore({
        currentTask: () => f.owner.snapshot().currentTask,
        now: () => NOW,
        id: () => "contract-empty",
      });
      emptyStore.bindContract(frozen, frozen.requirementsDigest, passSpec({ conditionCovered: [] }));
      const empty = await serviceWith(f, passVerifier(), 1000, emptyStore).verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(empty.outcome).toBe("insufficient");
      expect(empty.receipt?.uncoveredRevisions).toEqual([1]);
      expect(empty.receipt?.conditions[0]!.result).toBe("pass");

      const noConditionsStore = new AcceptanceContractStore({
        currentTask: () => f.owner.snapshot().currentTask,
        now: () => NOW,
        id: () => "contract-no-conditions",
      });
      noConditionsStore.bindContract(frozen, frozen.requirementsDigest, {
        ...passSpec(),
        conditions: [],
      });
      const noConditions = await serviceWith(f, passVerifier(), 1000, noConditionsStore).verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(noConditions.outcome).toBe("insufficient");
      expect(noConditions.receipt?.conditions).toEqual([]);

      const mutable: TrustedVerifier = {
        id: "fixture-semantic",
        version: "1",
        check() {
          return { conditions: [{ conditionId: "answer", result: "fail" }] };
        },
      };
      const frozenVerifierService = serviceWith(f, mutable, 1000, integrityStore);
      mutable.check = () => ({ conditions: [{ conditionId: "answer", result: "pass" }] });
      const frozenVerifier = await frozenVerifierService.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(frozenVerifier.receipt?.conditions[0]!.result).toBe("fail");
      expect(frozenVerifier.outcome).toBe("insufficient");

      const partialStore = new AcceptanceContractStore({
        currentTask: () => f.owner.snapshot().currentTask,
        now: () => NOW,
        id: () => "contract-partial",
      });
      partialStore.bindContract(frozen, frozen.requirementsDigest, {
        ...passSpec(),
        conditions: [{ ...passSpec().conditions[0]!, coveredRevisions: [] }],
        coverage: { kind: "semantic", complete: false, coveredRevisions: [], statement: "partial host fixture" },
      });
      const partial = await serviceWith(f, passVerifier(), 1000, partialStore).verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(partial.outcome).toBe("insufficient");
      expect(partial.receipt?.uncoveredRevisions).toEqual([1]);
    } finally {
      await f.cleanup();
    }
  });

  test("conservative complete:false coverage binds but remains insufficient when every condition passes", async () => {
    const f = await fixture();
    try {
      const { details } = await runPython(f, ANSWER_SOURCE);
      const frozen = frozenNow(f.owner);
      const bound = f.contracts.bindContract(frozen, frozen.requirementsDigest, {
        ...passSpec(),
        coverage: {
          kind: "semantic",
          complete: false,
          coveredRevisions: [1],
          statement: "artifact content only; execution evidence retention is deliberately uncovered",
        },
      });
      expect(bound.coverage.complete).toBe(false);
      const result = await serviceWith(f, passVerifier()).verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(result.receipt?.conditions.map((condition) => condition.result)).toEqual(["pass"]);
      expect(result.outcome).toBe("insufficient");
      expect(result.receipt?.outcome).toBe("insufficient");
      expect(result.usable).toBe(false);
      expect(result.receipt?.uncoveredRevisions).toEqual([]);
      expect(f.contracts.contractFor(frozen)!.coverage.complete).toBe(false);
      expect(() => f.contracts.bindContract(frozen, frozen.requirementsDigest, {
        ...passSpec(),
        coverage: { ...passSpec().coverage, complete: false, coveredRevisions: [99] },
      })).toThrow(/not in the frozen ledger/);
    } finally {
      await f.cleanup();
    }
  });

  test("no contract, wrong revision, wrong run and forged-shaped values are rejected without authority", async () => {
    const f = await fixture();
    try {
      const { details } = await runPython(f, ANSWER_SOURCE);
      const frozen = frozenNow(f.owner);
      const service = serviceWith(f, passVerifier());
      const noContract = await service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(noContract.outcome).toBe("insufficient");
      expect(noContract.taskAccepted).toBe(false);
      const wrongRevision = await service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision + 1,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(wrongRevision.receipt).toBeNull();
      const forged = await service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: "../escape",
        artifactIds: ["artifact-1"],
      });
      expect(forged.receipt).toBeNull();
      await expect(f.adapter.candidates.resolveSnapshot(
        { ...frozen, requirementsDigest: "requirements-digest-v1:sha256:" + "0".repeat(64) },
        { runId: runIdOf(details), artifactIds: ["artifact-1"] },
      )).rejects.toThrow(/different owner\/task\/revision/);
      await expect(f.adapter.candidates.resolveSnapshot(frozen, {
        runId: "run-does-not-exist",
        artifactIds: ["artifact-1"],
      })).rejects.toThrow(/No registered candidate/);
      expect(await service.lookup("verification-forged")).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  test("same artifact id in another run is selected by run identity, not artifact id alone", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      const first = await runPython(f, ANSWER_SOURCE);
      const secondSource = `open("answer.txt", "w").write("second run\\n")\n`;
      const second = await runPython(f, secondSource);
      expect(first.details.candidateRegistration.registered).toBe(1);
      expect(second.details.candidateRegistration.registered).toBe(1);
      const one = await f.adapter.candidates.resolveSnapshot(frozen, {
        runId: runIdOf(first.details),
        artifactIds: ["artifact-1"],
      });
      const two = await f.adapter.candidates.resolveSnapshot(frozen, {
        runId: runIdOf(second.details),
        artifactIds: ["artifact-1"],
      });
      expect(one.runId).toBe(runIdOf(first.details));
      expect(two.runId).toBe(runIdOf(second.details));
      expect(one.artifacts[0]!.data.toString("utf8")).toBe("42\n");
      expect(two.artifacts[0]!.data.toString("utf8")).toBe("second run\n");
      await expect(f.adapter.candidates.resolveSnapshot(frozen, {
        runId: runIdOf(second.details),
        artifactIds: ["artifact-9"],
      })).rejects.toThrow(/No registered candidate/);
    } finally {
      await f.cleanup();
    }
  });

  test("archive replacement, symlink, hardlink and size overrun are rejected and lookup cannot stay usable", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      f.contracts.bindContract(frozen, frozen.requirementsDigest, passSpec());
      const service = serviceWith(f, passVerifier());
      const { details } = await runPython(f, ANSWER_SOURCE);
      const verified = await service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(verified.outcome).toBe("pass");
      const archive = archivePath(f, details);
      await chmod(archive, 0o600);
      await writeFile(archive, "tampered\n");
      await expect(f.adapter.candidates.resolveSnapshot(frozen, {
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      })).rejects.toThrow(/changed since registration/);
      const lookup = await service.lookup(verified.receipt!.receiptId);
      expect(lookup?.usable).toBe(false);
      expect(lookup?.compatibility).toBe("candidate-changed");
      expect(lookup?.modelView).not.toContain("answer.txt");
      expect(lookup?.modelView).not.toContain("trusted-detail-marker");
      expect(lookup?.receipt.outcome).toBe("pass");
      expect(lookup?.modelView).toContain("withheld (context is not current");
      expect(lookup?.modelView).not.toContain("candidate bytes changed");

      const restore = path.join(f.root, "restore.bin");
      await writeFile(restore, "42\n");
      await rm(archive);
      await symlink(restore, archive);
      await expect(f.adapter.candidates.resolveSnapshot(frozen, {
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      })).rejects.toThrow(/symbolic link|link or non-directory/);
      await rm(archive);
      await writeFile(restore, "42\n");
      await link(restore, archive);
      await expect(f.adapter.candidates.resolveSnapshot(frozen, {
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      })).rejects.toThrow(/multiple hard links/);
      await rm(archive);
      await writeFile(archive, Buffer.alloc(300 * 1024, 0x41));
      await expect(f.adapter.candidates.resolveSnapshot(frozen, {
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      })).rejects.toThrow(/byte limit/);

      // Replacing the registered private root itself with a link fails closed.
      const rootReal = `${f.root}-real`;
      await rename(f.root, rootReal);
      await symlink(rootReal, f.root);
      await expect(f.adapter.candidates.resolveSnapshot(frozen, {
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      })).rejects.toThrow(/link|replaced|not a real directory/);
      await rm(f.root);
      await rename(rootReal, f.root);
    } finally {
      await f.cleanup();
    }
  });

  test("async verifier barrier: revise, cancel, detach and abort cannot publish a usable pass", async () => {
    // Revise during the trusted checker.
    {
      const f = await fixture({ prepareAmendment: true });
      try {
        const frozen = frozenNow(f.owner);
        f.contracts.bindContract(frozen, frozen.requirementsDigest, passSpec());
        const { details } = await runPython(f, ANSWER_SOURCE);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
        const verifier: TrustedVerifier = {
          id: "fixture-semantic",
          version: "1",
          async check() {
            entered();
            await gate;
            return { conditions: [{ conditionId: "answer", result: "pass" }] };
          },
        };
        const service = serviceWith(f, verifier);
        const pending = service.verify({
          expectedTaskId: frozen.taskId,
          expectedTaskRevision: frozen.taskRevision,
          runId: runIdOf(details),
          artifactIds: artifactIdsOf(details),
        });
        await enteredPromise;
        expect(f.owner.revise(subject(f.secondBranch!), guard(f.owner)).revised).toBe(true);
        release();
        const result = await pending;
        expect(result.outcome).toBe("insufficient");
        expect(result.usable).toBe(false);
        expect(result.receipt?.outcome).toBe("insufficient");
        expect(f.owner.snapshot().currentTask!.taskRevision).toBe(2);
        expect(f.owner.snapshot().currentTask!.status).toBe("active");
      } finally {
        await f.cleanup();
      }
    }
    // Cancel during the trusted checker.
    {
      const f = await fixture();
      try {
        const frozen = frozenNow(f.owner);
        f.contracts.bindContract(frozen, frozen.requirementsDigest, passSpec());
        const { details } = await runPython(f, ANSWER_SOURCE);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
        const verifier: TrustedVerifier = {
          id: "fixture-semantic",
          version: "1",
          async check() {
            entered();
            await gate;
            return { conditions: [{ conditionId: "answer", result: "pass" }] };
          },
        };
        const service = serviceWith(f, verifier);
        const pending = service.verify({
          expectedTaskId: frozen.taskId,
          expectedTaskRevision: frozen.taskRevision,
          runId: runIdOf(details),
          artifactIds: artifactIdsOf(details),
        });
        await enteredPromise;
        f.owner.cancel(subject(f.branch), guard(f.owner));
        release();
        const result = await pending;
        expect(result.outcome).toBe("insufficient");
        expect(result.usable).toBe(false);
        expect(f.owner.snapshot().currentTask!.status).toBe("cancelled");
        const lookup = await service.lookup(result.receipt!.receiptId);
        expect(lookup?.usable).toBe(false);
        expect(lookup?.compatibility).toBe("cancelled");
      } finally {
        await f.cleanup();
      }
    }
    // Detach during the trusted checker.
    {
      const f = await fixture();
      try {
        const frozen = frozenNow(f.owner);
        f.contracts.bindContract(frozen, frozen.requirementsDigest, passSpec());
        const { details } = await runPython(f, ANSWER_SOURCE);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
        const verifier: TrustedVerifier = {
          id: "fixture-semantic",
          version: "1",
          async check() {
            entered();
            await gate;
            return { conditions: [{ conditionId: "answer", result: "pass" }] };
          },
        };
        const service = serviceWith(f, verifier);
        const pending = service.verify({
          expectedTaskId: frozen.taskId,
          expectedTaskRevision: frozen.taskRevision,
          runId: runIdOf(details),
          artifactIds: artifactIdsOf(details),
        });
        await enteredPromise;
        f.owner.navigate("session_branch", SESSION);
        release();
        const result = await pending;
        expect(result.outcome).toBe("insufficient");
        expect(result.usable).toBe(false);
        expect(f.owner.bindingStatus().state).toBe("detached");
      } finally {
        await f.cleanup();
      }
    }
    // Abort during the trusted checker.
    {
      const f = await fixture();
      try {
        const frozen = frozenNow(f.owner);
        f.contracts.bindContract(frozen, frozen.requirementsDigest, passSpec());
        const { details } = await runPython(f, ANSWER_SOURCE);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
        const verifier: TrustedVerifier = {
          id: "fixture-semantic",
          version: "1",
          async check() {
            entered();
            await gate;
            return { conditions: [{ conditionId: "answer", result: "pass" }] };
          },
        };
        const service = serviceWith(f, verifier);
        const controller = new AbortController();
        const pending = service.verify({
          expectedTaskId: frozen.taskId,
          expectedTaskRevision: frozen.taskRevision,
          runId: runIdOf(details),
          artifactIds: artifactIdsOf(details),
        }, controller.signal);
        await enteredPromise;
        controller.abort();
        release();
        const result = await pending;
        expect(result.outcome).toBe("insufficient");
        expect(result.usable).toBe(false);
        expect(f.owner.snapshot().currentTask!.status).toBe("active");
      } finally {
        await f.cleanup();
      }
    }
  });

  test("timeout and late resolver never publish a pass; disposal is terminal", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      f.contracts.bindContract(frozen, frozen.requirementsDigest, passSpec());
      const { details } = await runPython(f, ANSWER_SOURCE);
      let lateResolve!: () => void;
      const late = new Promise<void>((resolve) => { lateResolve = resolve; });
      const slowVerifier: TrustedVerifier = {
        id: "fixture-semantic",
        version: "1",
        async check() {
          await late;
          return { conditions: [{ conditionId: "answer", result: "pass" }] };
        },
      };
      const service = serviceWith(f, slowVerifier, 20);
      const result = await service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(result.outcome).toBe("insufficient");
      expect(result.receipt?.limits.timedOut).toBe(true);
      expect(result.usable).toBe(false);
      lateResolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const lookup = await service.lookup(result.receipt!.receiptId);
      expect(lookup?.receipt.outcome).toBe("insufficient");
      expect(lookup?.usable).toBe(false);
      service.dispose();
      const disposed = await service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      expect(disposed.receipt).toBeNull();
      expect(disposed.taskAccepted).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("recordWriter revise before registration keeps the old task/revision/digest and real failure facts", async () => {
    const f = await fixture({ prepareAmendment: true });
    try {
      const frozen = frozenNow(f.owner);
      const second = f.secondBranch!;
      const adapter = new ExecutionAdapter(f.owner, {
        root: f.root,
        inputs: [],
        capabilityId: "local-script",
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
        id: () => "run-revise",
        now: () => NOW,
        recordWriter: (filePath, value) => {
          writeJsonAtomicSync(filePath, value);
          if ((value as Record<string, unknown>).phase === "completed") {
            f.owner.revise(subject(second), guard(f.owner));
          }
        },
      });
      const result = await adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: ANSWER_SOURCE,
        inputIds: [],
        expectedTaskId: f.owner.snapshot().currentTask!.taskId,
        expectedTaskRevision: 1,
      });
      const details = result.details as Record<string, any>;
      expect(details.taskRevision).toBe(1);
      expect(details.requirementsDigest).toBe(frozen.requirementsDigest);
      expect(details.candidateRegistration).toMatchObject({ registered: 1 });
      expect(f.owner.snapshot().currentTask!.taskRevision).toBe(2);
      const oldSnapshot = await adapter.candidates.resolveSnapshot(frozen, {
        runId: details.runId,
        artifactIds: ["artifact-1"],
      });
      expect(oldSnapshot.task).toEqual(frozen);
      const record = JSON.parse(await readFile(path.join(f.root, details.hostRecordRef), "utf8"));
      expect(record.taskRevision).toBe(1);
      expect(record.requirementsDigest).toBe(frozen.requirementsDigest);
      expect(record.artifacts).toHaveLength(1);
      adapter.dispose();
    } finally {
      await f.cleanup();
    }
  });

  test("registration failure keeps artifacts and execution facts in the run record", async () => {
    const f = await fixture();
    try {
      const adapter = new ExecutionAdapter(f.owner, {
        root: f.root,
        inputs: [],
        capabilityId: "local-script",
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
        id: () => "run-failed-registration",
        now: () => NOW,
        recordWriter: (filePath, value) => {
          writeJsonAtomicSync(filePath, value);
          if ((value as Record<string, unknown>).phase === "completed") {
            unlinkSync(path.join(path.dirname(filePath), "artifacts", "artifact-1.bin"));
          }
        },
      });
      const result = await adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: ANSWER_SOURCE,
        inputIds: [],
        expectedTaskId: f.owner.snapshot().currentTask!.taskId,
        expectedTaskRevision: 1,
      });
      const details = result.details as Record<string, any>;
      expect(details.candidateRegistration).toBeNull();
      expect(String(details.candidateRegistrationError)).toMatch(/ENOENT|no such file/i);
      expect(details.artifactsTotal).toBe(1);
      expect(details.dispatch.exitCode).toBe(0);
      const record = JSON.parse(await readFile(path.join(f.root, details.hostRecordRef), "utf8"));
      expect(record.process.exitCode).toBe(0);
      expect(record.artifacts).toHaveLength(1);
      expect(record.artifacts[0].sha256).toBe(sha256("42\n"));
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
      adapter.dispose();
    } finally {
      await f.cleanup();
    }
  });

  test("registration failure after detach withholds the archive path from content and details", async () => {
    const f = await fixture();
    try {
      const adapter = new ExecutionAdapter(f.owner, {
        root: f.root,
        inputs: [],
        capabilityId: "local-script",
        pythonPath: PYTHON,
        bunPath: BUN,
        launcherPath: LAUNCHER,
        id: () => "run-detached-registration",
        now: () => NOW,
        recordWriter: (filePath, value) => {
          writeJsonAtomicSync(filePath, value);
          if ((value as Record<string, unknown>).phase === "completed") {
            unlinkSync(path.join(path.dirname(filePath), "artifacts", "artifact-1.bin"));
            f.owner.navigate("session_branch", SESSION);
          }
        },
      });
      const result = await adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: ANSWER_SOURCE,
        inputIds: [],
        expectedTaskId: f.owner.snapshot().currentTask!.taskId,
        expectedTaskRevision: 1,
      });
      const details = result.details as Record<string, any>;
      const content = result.content.map((part) => part.text).join("\n");
      expect(details.visible).toBe(false);
      expect(details.bindingAfter.state).toBe("detached");
      expect(details.candidateRegistration).toBeNull();
      expect(String(details.candidateRegistrationError)).toMatch(/candidate registration failed/i);
      expect(String(details.candidateRegistrationError)).toMatch(/diagnostic withheld/i);
      expect(String(details.candidateRegistrationError)).not.toContain(f.root);
      expect(content).toContain("visible=false");
      expect(content).toMatch(/candidateRegistrationError="?candidate registration failed/i);
      expect(content).not.toContain(f.root);
      // Real execution, artifact and error-existence facts survive, and the
      // already-written host record is untouched.
      expect(details.dispatch.spawned).toBe(true);
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.artifactsTotal).toBe(1);
      expect(details.output.text).toBe("");
      const record = JSON.parse(await readFile(path.join(f.root, details.hostRecordRef), "utf8"));
      expect(record.process.exitCode).toBe(0);
      expect(record.artifacts).toHaveLength(1);
      expect(record.artifacts[0].sha256).toBe(sha256("42\n"));
      adapter.dispose();
    } finally {
      await f.cleanup();
    }
  });

  test("per-task attempt budget uses the real task and fake ids allocate no receipt budget", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      const service = serviceWith(f, passVerifier());
      const fake = await service.verify({
        expectedTaskId: "task-does-not-exist",
        expectedTaskRevision: 1,
        runId: "run-fake",
        artifactIds: ["artifact-1"],
      });
      expect(fake.receipt).toBeNull();
      const concurrent = await Promise.all(Array.from({ length: 20 }, () => service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: "run-fake",
        artifactIds: ["artifact-1"],
      })));
      expect(concurrent.filter((item) => item.receipt !== null)).toHaveLength(16);
      expect(concurrent.filter((item) => item.receipt === null)).toHaveLength(4);
      const exhausted = await service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: "run-fake",
        artifactIds: ["artifact-1"],
      });
      expect(exhausted.receipt).toBeNull();
      expect(exhausted.reason).toContain("budget exhausted");
    } finally {
      await f.cleanup();
    }
  });

  test("pre-admission rejection content is a consistent no-receipt taskAccepted:false view", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      const service = serviceWith(f, passVerifier());
      const controller = new AbortController();
      controller.abort();
      const aborted = await service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: "run-any",
        artifactIds: ["artifact-1"],
      }, controller.signal);
      expect(aborted.receipt).toBeNull();
      expect(aborted.taskAccepted).toBe(false);
      expect(aborted.usable).toBe(false);
      expect(aborted.modelView).toContain("taskAccepted: false");
      expect(aborted.modelView).toContain("receipt: none");
      expect(aborted.modelView).toContain("verificationAdmission: none");
      expect(aborted.modelView).toContain("reason: verification was aborted before admission");
      expect(aborted.modelView).not.toContain("receiptId");
      expect(aborted.modelView).not.toContain(frozen.taskId);
      expect(new TextEncoder().encode(aborted.modelView).byteLength).toBeLessThanOrEqual(16 * 1024);

      const fake = await service.verify({
        expectedTaskId: "task-fake",
        expectedTaskRevision: 1,
        runId: "run-any",
        artifactIds: ["artifact-1"],
      });
      expect(fake.receipt).toBeNull();
      expect(fake.modelView).toContain("taskAccepted: false");
      expect(fake.modelView).toContain("reason: expectedTaskId does not match the current task");
      expect(fake.modelView).not.toContain(frozen.taskId);

      const missing = await service.verify({
        expectedTaskRevision: 1,
        runId: "run-any",
        artifactIds: ["artifact-1"],
      } as unknown as VerificationRequest);
      expect(missing.receipt).toBeNull();
      expect(missing.modelView).toContain("taskAccepted: false");
      expect(missing.modelView).toContain("receipt: none");
      expect(missing.modelView).toContain("verificationAdmission: none");
      expect(missing.modelView).toContain("reason: expectedTaskId is not a valid identifier");
    } finally {
      await f.cleanup();
    }
  });

  test("dispose during verification and in-flight archive byte change never yield a usable pass", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      f.contracts.bindContract(frozen, frozen.requirementsDigest, passSpec());
      const { details } = await runPython(f, ANSWER_SOURCE);
      const request = {
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      };
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const barrier: TrustedVerifier = {
        id: "fixture-semantic",
        version: "1",
        async check() {
          entered();
          await gate;
          return { conditions: [{ conditionId: "answer", result: "pass" }] };
        },
      };
      const disposedService = serviceWith(f, barrier);
      const pendingDispose = disposedService.verify(request);
      await enteredPromise;
      disposedService.dispose();
      release();
      const disposedResult = await pendingDispose;
      expect(disposedResult.outcome).toBe("insufficient");
      expect(disposedResult.usable).toBe(false);

      let entered2!: () => void;
      let release2!: () => void;
      const enteredPromise2 = new Promise<void>((resolve) => { entered2 = resolve; });
      const gate2 = new Promise<void>((resolve) => { release2 = resolve; });
      const barrier2: TrustedVerifier = {
        id: "fixture-semantic",
        version: "1",
        async check() {
          entered2();
          await gate2;
          return { conditions: [{ conditionId: "answer", result: "pass" }] };
        },
      };
      const changedService = serviceWith(f, barrier2);
      const pendingChange = changedService.verify(request);
      await enteredPromise2;
      const archive = archivePath(f, details);
      await chmod(archive, 0o600);
      await writeFile(archive, "changed during verification\n");
      release2();
      const changedResult = await pendingChange;
      expect(changedResult.outcome).toBe("insufficient");
      expect(changedResult.usable).toBe(false);
      expect(changedResult.receipt?.reason).toMatch(/changed after verification|candidate bytes changed/);
    } finally {
      await f.cleanup();
    }
  });

  test("over-limit verifier results and receipts fail closed as bounded insufficient", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      const conditionIds = Array.from({ length: 16 }, (_, index) => `c${index}`);
      const spec: TrustedContractSpec = {
        hostConfig: { id: "host-fixture", version: "1" },
        verifier: { id: "fixture-semantic", version: "1", parameters: {} },
        conditions: conditionIds.map((conditionId) => ({
          conditionId,
          description: "x".repeat(1800),
          kind: "semantic",
          coveredRevisions: [1],
        })),
        coverage: {
          kind: "semantic",
          complete: true,
          coveredRevisions: [1],
          statement: "all sixteen fixture conditions cover the exact requirement",
        },
      };
      f.contracts.bindContract(frozen, frozen.requirementsDigest, spec);
      const { details } = await runPython(f, ANSWER_SOURCE);
      const request = {
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      };
      const padded: TrustedVerifier = {
        id: "fixture-semantic",
        version: "1",
        check() {
          return {
            conditions: conditionIds.map((conditionId) => ({
              conditionId,
              result: "pass",
              detail: "d".repeat(350),
            })),
          };
        },
      };
      const receiptLimited = await serviceWith(f, padded).verify(request);
      expect(receiptLimited.outcome).toBe("insufficient");
      expect(receiptLimited.receipt?.limits.limitExceeded).toBe(true);
      expect(receiptLimited.receipt?.conditions).toHaveLength(16);
      expect(receiptLimited.usable).toBe(false);
      expect(new TextEncoder().encode(JSON.stringify(receiptLimited.receipt)).byteLength).toBeLessThanOrEqual(32 * 1024);

      const huge: TrustedVerifier = {
        id: "fixture-semantic",
        version: "1",
        check() {
          return {
            conditions: conditionIds.map((conditionId) => ({
              conditionId,
              result: "pass",
              detail: "v".repeat(1400),
            })),
          };
        },
      };
      const resultLimited = await serviceWith(f, huge).verify(request);
      expect(resultLimited.outcome).toBe("insufficient");
      expect(resultLimited.receipt?.limits.limitExceeded).toBe(true);
      expect(resultLimited.receipt?.limits.verifierResultBytes).toBeGreaterThan(16 * 1024);
      expect(resultLimited.usable).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("snapshot capacity rejects explicitly and retains existing handles under concurrency", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      const { details } = await runPython(f, ANSWER_SOURCE);
      const selector = { runId: runIdOf(details), artifactIds: ["artifact-1"] };
      const settled = await Promise.allSettled(
        Array.from({ length: 65 }, () => f.adapter.candidates.resolveSnapshot(frozen, selector)),
      );
      const fulfilled = settled.filter((item) => item.status === "fulfilled");
      const rejected = settled.filter((item) => item.status === "rejected");
      expect(fulfilled).toHaveLength(64);
      expect(rejected).toHaveLength(1);
      const first = fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof f.adapter.candidates.resolveSnapshot>>>;
      const rechecked = await f.adapter.candidates.recheckSnapshot(first.value.snapshotId, frozen);
      expect(rechecked.artifacts[0]!.data.toString("utf8")).toBe("42\n");
      await expect(f.adapter.candidates.resolveSnapshot(frozen, selector)).rejects.toThrow(/capacity/);
    } finally {
      await f.cleanup();
    }
  });

  test("a live getter returning a different branch is re-read after async work, not reused", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      f.contracts.bindContract(frozen, frozen.requirementsDigest, passSpec());
      const { details } = await runPython(f, ANSWER_SOURCE);
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const verifier: TrustedVerifier = {
        id: "fixture-semantic",
        version: "1",
        async check() {
          entered();
          await gate;
          return { conditions: [{ conditionId: "answer", result: "pass" }] };
        },
      };
      const service = serviceWith(f, verifier);
      const pending = service.verify({
        expectedTaskId: frozen.taskId,
        expectedTaskRevision: frozen.taskRevision,
        runId: runIdOf(details),
        artifactIds: artifactIdsOf(details),
      });
      await enteredPromise;
      f.live.branch = [base(), user("other-user", "leaf-1", "Unrelated branch.")];
      release();
      const result = await pending;
      expect(result.outcome).toBe("insufficient");
      expect(result.compatibility).toBe("detached");
      expect(result.usable).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("registry registration is idempotent by real facts and rejects conflicting identities", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      const { details } = await runPython(f, ANSWER_SOURCE);
      const snapshot = await f.adapter.candidates.resolveSnapshot(frozen, {
        runId: runIdOf(details),
        artifactIds: ["artifact-1"],
      });
      const runDir = path.dirname(path.join(f.root, details.hostRecordRef as string));
      const registration = {
        task: frozen,
        runId: runIdOf(details),
        callId: details.callId as string,
        privateRoot: f.root,
        source: {
          path: path.join(runDir, "source", "script.py"),
          bytes: snapshot.source.bytes,
          sha256: snapshot.source.sha256,
        },
        inputs: [],
        artifacts: [{
          artifactId: "artifact-1",
          relativePath: "answer.txt",
          archivePath: archivePath(f, details),
          bytes: snapshot.artifacts[0]!.bytes,
          sha256: snapshot.artifacts[0]!.sha256,
        }],
        provenance: snapshot.provenance,
        registeredAt: NOW,
      };
      const registry = new CandidateRegistry({ now: () => NOW, id: () => "registry-id" });
      expect(await registry.register(registration)).toEqual({ registered: 1, idempotent: 0 });
      expect(await registry.register(registration)).toEqual({ registered: 0, idempotent: 1 });
      await expect(registry.register({
        ...registration,
        artifacts: [{ ...registration.artifacts[0]!, sha256: sha256("different") }],
      })).rejects.toThrow(/different facts/);
      const resolved = await registry.readPort().resolveSnapshot(frozen, {
        runId: registration.runId,
        artifactIds: ["artifact-1"],
      });
      expect(resolved.artifacts[0]!.data.toString("utf8")).toBe("42\n");
    } finally {
      await f.cleanup();
    }
  });

  test("contract binding is exact, idempotent and immutable against caller aliases", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      const spec = passSpec();
      const bound = f.contracts.bindContract(frozen, frozen.requirementsDigest, spec);
      const again = f.contracts.bindContract(frozen, frozen.requirementsDigest, spec);
      expect(again.contractId).toBe(bound.contractId);
      expect(again.digest).toBe(bound.digest);
      spec.conditions[0]!.description = "mutated caller text";
      spec.coverage.coveredRevisions.push(99);
      (spec.verifier.parameters as Record<string, unknown>).fixture = false;
      const stored = f.contracts.contractFor(frozen)!;
      expect(stored.conditions[0]!.description).toBe("fixture semantic condition");
      expect(stored.coverage.coveredRevisions).toEqual([1]);
      expect((stored.verifier.parameters as Record<string, unknown>).fixture).toBe(true);
      expect(() => f.contracts.bindContract(
        { ...frozen, requirementsDigest: "requirements-digest-v1:sha256:" + "f".repeat(64) },
        "requirements-digest-v1:sha256:" + "f".repeat(64),
        passSpec(),
      )).toThrow();
      expect(() => f.contracts.bindContract(frozen, frozen.requirementsDigest, {
        ...passSpec(),
        coverage: { ...passSpec().coverage, complete: true, coveredRevisions: [] },
      })).toThrow(/coverage claim/);
      expect(() => f.contracts.bindContract(frozen, frozen.requirementsDigest, {
        ...passSpec(),
        conditions: [{ ...passSpec().conditions[0]!, conditionId: "different" }],
      })).toThrow(/already bound/);
    } finally {
      await f.cleanup();
    }
  });

  test("contract binding re-reads live eligibility after host id and clock callbacks", async () => {
    {
      const f = await fixture();
      try {
        const frozen = frozenNow(f.owner);
        const second = amendTask(f);
        const store = new AcceptanceContractStore({
          currentTask: () => f.owner.snapshot().currentTask,
          now: () => NOW,
          id: () => {
            expect(f.owner.revise(subject(second), guard(f.owner)).revised).toBe(true);
            return "contract-callback-review";
          },
        });
        expect(() => store.bindContract(frozen, frozen.requirementsDigest, passSpec()))
          .toThrow(/identity changed/);
        expect(store.contractFor(frozen)).toBeNull();
        expect(f.owner.snapshot().currentTask!.taskRevision).toBe(2);
      } finally {
        await f.cleanup();
      }
    }
    {
      const f = await fixture();
      try {
        const frozen = frozenNow(f.owner);
        const store = new AcceptanceContractStore({
          currentTask: () => f.owner.snapshot().currentTask,
          now: () => {
            f.owner.cancel(subject(f.branch), guard(f.owner));
            return NOW;
          },
          id: () => "contract-clock-cancel",
        });
        expect(() => store.bindContract(frozen, frozen.requirementsDigest, passSpec()))
          .toThrow(/no longer active/);
        expect(store.contractFor(frozen)).toBeNull();
        expect(f.owner.snapshot().currentTask!.status).toBe("cancelled");
      } finally {
        await f.cleanup();
      }
    }
  });

  test("idempotent binding re-read preserves the existing immutable contract", async () => {
    const f = await fixture();
    try {
      const frozen = frozenNow(f.owner);
      const second = amendTask(f);
      let calls = 0;
      let reviseOnCall = Number.POSITIVE_INFINITY;
      const store = new AcceptanceContractStore({
        currentTask: () => {
          calls += 1;
          if (calls === reviseOnCall) {
            expect(f.owner.revise(subject(second), guard(f.owner)).revised).toBe(true);
          }
          return f.owner.snapshot().currentTask;
        },
        now: () => NOW,
        id: () => "contract-idempotent-recheck",
      });
      const first = store.bindContract(frozen, frozen.requirementsDigest, passSpec());
      reviseOnCall = calls + 2;
      expect(() => store.bindContract(frozen, frozen.requirementsDigest, passSpec()))
        .toThrow(/identity changed/);
      expect(store.contractFor(frozen)?.contractId).toBe(first.contractId);
      expect(f.owner.snapshot().currentTask!.taskRevision).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
});
