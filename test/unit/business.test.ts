import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEvent } from "../../src/audit.ts";
import {
  BusinessDenied,
  BusinessFailure,
  businessErrorOutcome,
  executeDeliverable,
  ReceiptStore,
  type BusinessRuntime,
} from "../../src/business.ts";
import { IdentityError, parseTaskBinding, type TaskBinding } from "../../src/identity.ts";
import { loadPolicy, policyFingerprint } from "../../src/policy.ts";

const FIXTURE = fileURLToPath(new URL("../../policy/development-fixture.v1.json", import.meta.url));
const fixtureBytes = await readFile(FIXTURE);
const loadedPolicy = await loadPolicy(FIXTURE, policyFingerprint(fixtureBytes));

interface Sandbox {
  root: string;
  workspace: string;
  binding: TaskBinding;
  runtime: BusinessRuntime;
  audit: AuditEvent[];
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), "g1a-business-"));
  const workspace = path.join(root, "workspace");
  await writeFile(path.join(root, ".keep"), "");
  await mkdir(workspace, { mode: 0o700 });
  const canonical = await realpath(workspace);
  const binding = parseTaskBinding({
    schemaVersion: 1,
    taskId: "task-business",
    taskRevision: 1,
    ownerId: "owner-business",
    runId: "run-business",
    attemptId: "attempt-business",
    executionEpoch: 1,
    workspaceRoot: canonical,
  });
  const audit: AuditEvent[] = [];
  const runtime: BusinessRuntime = {
    loadedPolicy,
    binding,
    canonicalWorkspaceRoot: canonical,
    receipts: new ReceiptStore(),
    audit: (event) => audit.push(event),
  };
  return { root, workspace: canonical, binding, runtime, audit };
}

describe("actual business tool enforcement", () => {
  test("writes one policy-bound file and records a receipt", async () => {
    const box = await sandbox();
    try {
      const outcome = await executeDeliverable(box.runtime, { content: "authoritative content\n" });
      expect(outcome.receipt?.path).toBe("deliverable.txt");
      expect(outcome.receipt?.bytes).toBe(Buffer.byteLength("authoritative content\n"));
      expect(await readFile(path.join(box.workspace, "deliverable.txt"), "utf8")).toBe("authoritative content\n");
      expect(box.audit.map((entry) => entry.type)).toEqual([
        "business_recheck_started",
        "business_recheck_allowed",
        "business_written",
      ]);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("an identical duplicate dispatch does not repeat the logical write", async () => {
    const box = await sandbox();
    try {
      const first = await executeDeliverable(box.runtime, { content: "one write\n" });
      expect(first.receipt?.requestSha256).toBe(createHash("sha256").update("one write\n").digest("hex"));
      const target = path.join(box.workspace, "deliverable.txt");
      const before = await lstat(target);
      const beforeBytes = await readFile(target);
      const duplicate = await executeDeliverable(box.runtime, { content: "one write\n" });
      const after = await lstat(target);
      expect(duplicate.result.details).toMatchObject({
        applied: false,
        duplicate: true,
        currentArtifactValid: true,
        outcome: "already-applied",
      });
      expect(await readFile(target)).toEqual(beforeBytes);
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(box.audit.filter((entry) => entry.type === "business_written")).toHaveLength(1);
      expect(box.audit.filter((entry) => entry.type === "business_duplicate_dispatch")).toHaveLength(1);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("changed parameters under the same logical operation are an explicit conflict", async () => {
    const box = await sandbox();
    try {
      await executeDeliverable(box.runtime, { content: "original\n" });
      const target = path.join(box.workspace, "deliverable.txt");
      const before = await readFile(target);
      await expect(executeDeliverable(box.runtime, { content: "different content\n" }))
        .rejects.toMatchObject({ name: "BusinessDenied", code: "operation-conflict" });
      expect(await readFile(target)).toEqual(before);
      expect(box.audit.filter((entry) => entry.type === "business_written")).toHaveLength(1);
      expect(box.audit.filter((entry) => entry.type === "business_operation_conflict")).toHaveLength(1);
      expect(box.audit.filter((entry) => entry.type === "business_duplicate_dispatch")).toHaveLength(0);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("a replay reports the historic receipt when the artifact no longer matches", async () => {
    const box = await sandbox();
    try {
      await executeDeliverable(box.runtime, { content: "recorded\n" });
      const target = path.join(box.workspace, "deliverable.txt");
      await writeFile(target, "tampered\n");
      const replay = await executeDeliverable(box.runtime, { content: "recorded\n" });
      expect(replay.result.isError).toBe(true);
      expect(replay.result.details).toMatchObject({
        applied: false,
        duplicate: true,
        currentArtifactValid: false,
        outcome: "historic-operation-status",
        replaySafe: false,
      });
      expect(await readFile(target, "utf8")).toBe("tampered\n");
      expect(box.audit.filter((entry) => entry.type === "business_written")).toHaveLength(1);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("an audit failure after a real write reports a confirmed side effect", async () => {
    const box = await sandbox();
    try {
      const audit: AuditEvent[] = [];
      const runtime: BusinessRuntime = {
        ...box.runtime,
        receipts: new ReceiptStore(),
        audit: (event) => {
          audit.push(event);
          if (event.type === "business_written") throw new Error("audit storage failed");
        },
      };
      let failure: BusinessFailure | undefined;
      try {
        await executeDeliverable(runtime, { content: "written before audit\n" });
      } catch (error) {
        if (error instanceof BusinessFailure) failure = error;
        else throw error;
      }
      expect(failure).toBeInstanceOf(BusinessFailure);
      expect(failure?.details).toMatchObject({ phase: "audit", sideEffect: "confirmed", replaySafe: false });
      expect(failure?.details.operationId).toMatch(/^op-/);
      expect(await readFile(path.join(box.workspace, "deliverable.txt"), "utf8")).toBe("written before audit\n");
      const reported = businessErrorOutcome(failure);
      expect(reported.isError).toBe(true);
      expect(reported.details).toMatchObject({
        applied: true,
        sideEffect: "confirmed",
        outcome: "unknown",
        replaySafe: false,
        phase: "audit",
      });
      expect(reported.details.operationId).toBe(failure?.details.operationId);
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("a symlinked parent is refused before any write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "g1a-business-link-"));
    try {
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(outside, { mode: 0o700 });
      const canonical = await realpath(workspace);
      await symlink(outside, path.join(canonical, "sub"), "dir");
      const value = JSON.parse(fixtureBytes.toString("utf8")) as Record<string, any>;
      value.managedTool.deliverablePath = "sub/out.txt";
      const policyPath = path.join(root, "nested-policy.json");
      const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await writeFile(policyPath, bytes);
      const loaded = await loadPolicy(policyPath, policyFingerprint(bytes));
      const binding = parseTaskBinding({
        schemaVersion: 1, taskId: "task-link", taskRevision: 1, ownerId: "owner-link",
        runId: "run-link", attemptId: "attempt-link", executionEpoch: 1, workspaceRoot: canonical,
      });
      const audit: AuditEvent[] = [];
      const runtime: BusinessRuntime = {
        loadedPolicy: loaded, binding, canonicalWorkspaceRoot: canonical,
        receipts: new ReceiptStore(), audit: (event) => audit.push(event),
      };
      await expect(executeDeliverable(runtime, { content: "must not escape\n" }))
        .rejects.toMatchObject({ name: "BusinessDenied", code: "unsafe-path" });
      await expect(lstat(path.join(outside, "out.txt"))).rejects.toThrow();
      expect(audit.map((entry) => entry.type)).toContain("business_denied_unsafe_path");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("model-supplied identity fields are rejected with zero writes", async () => {
    const box = await sandbox();
    try {
      await expect(executeDeliverable(box.runtime, {
        content: "tampered\n",
        taskId: "attacker",
        taskRevision: 99,
        ownerId: "attacker",
        executionEpoch: 99,
      })).rejects.toBeInstanceOf(IdentityError);
      await expect(lstat(path.join(box.workspace, "deliverable.txt"))).rejects.toThrow();
      expect(box.audit.map((entry) => entry.type)).toContain("business_arguments_rejected");
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("host revocation after the hook denies at the business boundary", async () => {
    const box = await sandbox();
    try {
      const revokePath = path.join(box.root, "revoke.marker");
      await writeFile(revokePath, "revoked\n");
      box.runtime.revokePath = revokePath;
      await expect(executeDeliverable(box.runtime, { content: "denied\n" })).rejects.toBeInstanceOf(BusinessDenied);
      await expect(lstat(path.join(box.workspace, "deliverable.txt"))).rejects.toThrow();
      expect(box.audit.map((entry) => entry.type)).not.toContain("business_written");
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });

  test("a changed policy file is rejected at execution time with zero writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "g1a-business-policy-"));
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      const canonical = await realpath(workspace);
      const policyPath = path.join(root, "policy.json");
      await writeFile(policyPath, fixtureBytes);
      const loaded = await loadPolicy(policyPath, policyFingerprint(fixtureBytes));
      const binding = parseTaskBinding({
        schemaVersion: 1, taskId: "task-1", taskRevision: 1, ownerId: "owner-1",
        runId: "run-1", attemptId: "attempt-1", executionEpoch: 1, workspaceRoot: canonical,
      });
      const audit: AuditEvent[] = [];
      const runtime: BusinessRuntime = {
        loadedPolicy: loaded, binding, canonicalWorkspaceRoot: canonical,
        receipts: new ReceiptStore(), audit: (event) => audit.push(event),
      };
      await writeFile(policyPath, fixtureBytes.toString("utf8").replace('"policyVersion": 1', '"policyVersion": 2'));
      await expect(executeDeliverable(runtime, { content: "denied\n" })).rejects.toThrow(/fingerprint/);
      await expect(lstat(path.join(canonical, "deliverable.txt"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an existing unverified target is never overwritten", async () => {
    const box = await sandbox();
    try {
      await writeFile(path.join(box.workspace, "deliverable.txt"), "pre-existing\n");
      await expect(executeDeliverable(box.runtime, { content: "replacement\n" })).rejects.toThrow(/already exists/);
      expect(await readFile(path.join(box.workspace, "deliverable.txt"), "utf8")).toBe("pre-existing\n");
      expect(box.audit.map((entry) => entry.type)).toContain("business_denied_existing_target");
    } finally {
      await rm(box.root, { recursive: true, force: true });
    }
  });
});
