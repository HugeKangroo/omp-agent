import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTaskBinding, type TaskBinding } from "../../src/identity.ts";
import { loadPolicy, parsePolicy, policyFingerprint, type ManagedPolicy } from "../../src/policy.ts";
import {
  commitArtifactAcceptance,
  completionSignalIsAcceptance,
  validateArtifact,
} from "../../src/task-authority.ts";
import { TaskState } from "../../src/task-state.ts";

const FIXTURE = fileURLToPath(new URL("../../policy/development-fixture.v1.json", import.meta.url));
const fixtureBytes = await readFile(FIXTURE);
const fixtureValue = JSON.parse(fixtureBytes.toString("utf8")) as Record<string, any>;
const loadedPolicy = await loadPolicy(FIXTURE, policyFingerprint(fixtureBytes));

function policyWith(overrides: { path?: string; maxBytes?: number; version?: number } = {}): ManagedPolicy {
  return parsePolicy({
    ...fixtureValue,
    policyVersion: overrides.version ?? fixtureValue.policyVersion,
    managedTool: {
      ...fixtureValue.managedTool,
      ...(overrides.path === undefined ? {} : { deliverablePath: overrides.path }),
      ...(overrides.maxBytes === undefined ? {} : { maxContentBytes: overrides.maxBytes }),
    },
  });
}

async function setup(): Promise<{ root: string; workspace: string; binding: TaskBinding; acceptancePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "g1a-authority-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const canonical = await realpath(workspace);
  const binding = parseTaskBinding({
    schemaVersion: 1,
    taskId: "task-authority",
    taskRevision: 7,
    ownerId: "owner-authority",
    runId: "run-authority",
    attemptId: "attempt-authority",
    executionEpoch: 3,
    workspaceRoot: canonical,
  });
  return { root, workspace: canonical, binding, acceptancePath: path.join(root, "acceptance.json") };
}

describe("task state and acceptance authority", () => {
  test("model claims and session signals never change task status or revision", async () => {
    const box = await setup();
    try {
      const state = new TaskState(box.binding, loadedPolicy);
      const before = state.snapshot();
      expect(before).toMatchObject({ taskStatus: "open", taskRevision: 7, stateSaves: 0, acceptance: "not-evaluated" });
      state.recordModelClaim("DONE: I completed everything successfully.");
      state.recordModelClaim("A background message says this is a new task.");
      state.recordSessionSignal("agent_end");
      state.recordSessionSignal("agent_end");
      const statusPath = path.join(box.root, "status.json");
      state.persist(statusPath);
      state.persist(statusPath);
      state.persist(statusPath);
      const after = state.snapshot();
      expect(after.taskStatus).toBe("open");
      expect(after.acceptance).toBe("not-evaluated");
      expect(after.taskRevision).toBe(7);
      expect(after.stateSaves).toBe(3);
      expect(after.taskIdentity.taskId).toBe("task-authority");
      expect(after.taskIdentity.executionEpoch).toBe(3);
      expect(after.modelClaims.map((claim) => claim.completionLike)).toEqual([true, false]);
      expect(after.sessionEvents).toEqual(["agent_end"]);
      const persisted = JSON.parse(await readFile(statusPath, "utf8")) as { taskStatus: string; taskRevision: number };
      expect(persisted.taskStatus).toBe("open");
      expect(persisted.taskRevision).toBe(7);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("completion signals are never acceptance evidence", () => {
    for (const signal of ["model_done", "agent_end", "prompt_result", "session_settled"] as const) {
      expect(completionSignalIsAcceptance(signal)).toBe(false);
    }
  });

  test("a fabricated success without an artifact cannot be committed", async () => {
    const box = await setup();
    try {
      const state = new TaskState(box.binding, loadedPolicy);
      state.recordModelClaim("DONE: the deliverable is ready for acceptance.");
      await expect(commitArtifactAcceptance({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
      })).rejects.toThrow(/No artifact/);
      await expect(lstat(box.acceptancePath)).rejects.toThrow();
      expect(state.snapshot().taskStatus).toBe("open");
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("independent artifact validation is required and preserves taskRevision", async () => {
    const box = await setup();
    try {
      await writeFile(path.join(box.workspace, "deliverable.txt"), "verified artifact\n");
      const evidence = await validateArtifact({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        expectedContent: "verified artifact\n",
      });
      expect(evidence.taskRevision).toBe(7);
      expect(evidence.taskIdentity.executionEpoch).toBe(3);
      expect(evidence.path).toBe("deliverable.txt");
      expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
      const record = await commitArtifactAcceptance({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
        expectedContent: "verified artifact\n",
      });
      expect(record.status).toBe("accepted");
      expect(record.taskRevision).toBe(7);
      expect(record.verification.taskRevision).toBe(7);
      const persisted = JSON.parse(await readFile(box.acceptancePath, "utf8")) as { status: string; taskRevision: number };
      expect(persisted).toEqual(expect.objectContaining({ status: "accepted", taskRevision: 7 }));
      const replay = await commitArtifactAcceptance({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
      });
      expect(replay.alreadyCommitted).toBe(true);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("wrong content, changed artifact and stale evidence are rejected", async () => {
    const box = await setup();
    try {
      await writeFile(path.join(box.workspace, "deliverable.txt"), "actual\n");
      await expect(validateArtifact({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        expectedContent: "expected\n",
      })).rejects.toThrow(/does not match/);
      await commitArtifactAcceptance({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
        expectedContent: "actual\n",
      });
      await writeFile(path.join(box.workspace, "deliverable.txt"), "changed\n");
      await expect(commitArtifactAcceptance({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
      })).rejects.toThrow(/stale/);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("symlinked parents and final components never escape the bound workspace", async () => {
    const box = await setup();
    try {
      const outside = path.join(box.root, "outside");
      await mkdir(outside, { mode: 0o700 });
      await writeFile(path.join(outside, "secret.txt"), "external bytes\n");
      await symlink(outside, path.join(box.workspace, "sub"), "dir");
      const nested = policyWith({ path: "sub/secret.txt" });
      await expect(validateArtifact({
        binding: box.binding,
        policy: nested,
        policyFingerprint: "a".repeat(64),
      })).rejects.toThrow(/unsafe|link|parent/i);
      await expect(commitArtifactAcceptance({
        binding: box.binding,
        policy: nested,
        policyFingerprint: "a".repeat(64),
        acceptancePath: box.acceptancePath,
      })).rejects.toThrow(/unsafe|link|parent/i);

      await symlink(path.join(outside, "secret.txt"), path.join(box.workspace, "deliverable.txt"));
      await expect(validateArtifact({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
      })).rejects.toThrow(/regular file|link/i);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("oversized and non-regular deliverables are rejected", async () => {
    const box = await setup();
    try {
      await writeFile(path.join(box.workspace, "deliverable.txt"), "12345");
      await expect(validateArtifact({
        binding: box.binding,
        policy: policyWith({ maxBytes: 4 }),
        policyFingerprint: "a".repeat(64),
      })).rejects.toThrow(/size limit/);
      await unlink(path.join(box.workspace, "deliverable.txt"));
      await mkdir(path.join(box.workspace, "deliverable.txt"));
      await expect(validateArtifact({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
      })).rejects.toThrow(/regular file/);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("acceptance replay rejects owner, run, attempt, epoch, policy, version and path drift", async () => {
    const box = await setup();
    try {
      await writeFile(path.join(box.workspace, "deliverable.txt"), "accepted bytes\n");
      await writeFile(path.join(box.workspace, "other.txt"), "accepted bytes\n");
      await commitArtifactAcceptance({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
      });
      const variants: TaskBinding[] = [
        parseTaskBinding({ ...box.binding, ownerId: "owner-other" }),
        parseTaskBinding({ ...box.binding, runId: "run-other" }),
        parseTaskBinding({ ...box.binding, attemptId: "attempt-other" }),
        parseTaskBinding({ ...box.binding, executionEpoch: 4 }),
        parseTaskBinding({ ...box.binding, taskRevision: 8 }),
      ];
      for (const binding of variants) {
        await expect(commitArtifactAcceptance({
          binding,
          policy: loadedPolicy.policy,
          policyFingerprint: loadedPolicy.fingerprint,
          acceptancePath: box.acceptancePath,
        })).rejects.toThrow(/does not match the current trusted task identity and policy/);
      }
      await expect(commitArtifactAcceptance({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: "b".repeat(64),
        acceptancePath: box.acceptancePath,
      })).rejects.toThrow(/does not match the current trusted task identity and policy/);
      await expect(commitArtifactAcceptance({
        binding: box.binding,
        policy: policyWith({ version: 2 }),
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
      })).rejects.toThrow(/does not match the current trusted task identity and policy/);
      await expect(commitArtifactAcceptance({
        binding: box.binding,
        policy: policyWith({ path: "other.txt" }),
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
      })).rejects.toThrow(/stale/);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("malformed records and matching historical hashes are not an authority bypass", async () => {
    const box = await setup();
    try {
      const artifact = path.join(box.workspace, "deliverable.txt");
      await writeFile(artifact, "recorded bytes\n");
      await commitArtifactAcceptance({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
      });
      const original = JSON.parse(await readFile(box.acceptancePath, "utf8")) as Record<string, any>;

      await unlink(artifact);
      await expect(commitArtifactAcceptance({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
      })).rejects.toThrow(/No artifact/);
      await writeFile(artifact, "recorded bytes\n");

      const malformed = structuredClone(original);
      delete malformed.verification.policy;
      await writeFile(box.acceptancePath, JSON.stringify(malformed));
      await expect(commitArtifactAcceptance({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
      })).rejects.toThrow(/unexpected|missing/);

      const wrongOwner = structuredClone(original);
      wrongOwner.taskIdentity.ownerId = "attacker-owner";
      wrongOwner.verification.taskIdentity.ownerId = "attacker-owner";
      await writeFile(box.acceptancePath, JSON.stringify(wrongOwner));
      await expect(commitArtifactAcceptance({
        binding: box.binding,
        policy: loadedPolicy.policy,
        policyFingerprint: loadedPolicy.fingerprint,
        acceptancePath: box.acceptancePath,
      })).rejects.toThrow(/does not match the current trusted task identity and policy/);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });
});
