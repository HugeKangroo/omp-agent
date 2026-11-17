import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  NATIVE_HARNESS_HISTORY_PROCESS_LIMITS,
  NATIVE_HARNESS_HISTORY_RECOVERY_LIMITS,
  bindNativeHarnessHistoryRecoveryWorker,
  classifyDarwinPsCompletion,
  createDarwinHistoryProcessObserver,
  decodeNativeHarnessHistoryProcessOwner,
  deriveNativeHarnessHistoryProcessTargets,
  deriveNativeHarnessHistoryRecoveryTargets,
  parseDarwinPsOutput,
  probeNativeHarnessHistoryRecoveryController,
  probeNativeHarnessHistoryRecoveryGroup,
  projectNativeHarnessHistoryRecoveryLifecycle,
  type NativeHarnessHistoryProcessChild,
  type NativeHarnessHistoryProcessOwnerText,
  type NativeHarnessHistoryProcessSpawn,
  type NativeHarnessHistoryRecoveryAttemptSummaryInput,
  type NativeHarnessHistoryRecoveryAttemptTarget,
  type NativeHarnessHistoryRecoveryProjectionInput,
  type NativeHarnessHistoryRecoveryRowInput,
} from "../../src/native-harness-history-process.ts";
import { sha256Hex } from "../../src/native-work.ts";

const ROOT = "/tmp/omp-r1b3";
const HARNESS = "omp-harness-abc123";
const RUN_ID = "run-fixture-1";
const RUN_ROOT = `${HARNESS}/store/runs/${RUN_ID}`;
const UUID = "11111111-1111-4111-8111-111111111111";
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const PS_LINE = ` 4321  4321 S Mon Jan  1 00:00:00 2026 /usr/bin/omp --config /tmp/omp-harness2-worker-abcdef/config.yml --append-system-prompt /tmp/omp-harness2-worker-abcdef/harness.txt`;

function stageCwd(attempt = 2): string {
  return path.join(ROOT, RUN_ROOT, "stages", "baseline", `attempt-${attempt}-${UUID}`, "workspace");
}

function derive(cwd = stageCwd()) {
  return deriveNativeHarnessHistoryProcessTargets(
    ROOT,
    RUN_ROOT,
    RUN_ID,
    [{ id: "baseline", status: "completed", attempt: 2, cwd }],
  );
}

function ownerText(value: unknown): NativeHarnessHistoryProcessOwnerText {
  const text = JSON.stringify(value);
  return { text, bytes: Buffer.byteLength(text, "utf8"), sha256: "a".repeat(64), observedAt: 10 };
}

function workerOwner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    stage: "baseline",
    pid: 4321,
    pgid: 4321,
    privateRuntimeRoot: "/tmp/omp-harness2-worker-abcdef",
    startedAt: STARTED_AT,
    ...overrides,
  };
}

function recoveryNonce(value: number): string {
  const hex = value.toString(16).padStart(12, "0");
  return `00000000-1111-4111-8111-${hex}`;
}

function recoveryCwd(stage: string, attempt: number): string {
  return path.join(ROOT, RUN_ROOT, "stages", stage, `attempt-${attempt}-${UUID}`, "workspace");
}

function recoveryRow(overrides: Partial<NativeHarnessHistoryRecoveryRowInput> = {}): NativeHarnessHistoryRecoveryRowInput {
  const cwd = overrides.cwd ?? recoveryCwd("baseline", 2);
  return {
    ordinal: 1,
    nonce: recoveryNonce(1),
    stage: "baseline",
    attempt: 2,
    cwd,
    artifactDir: path.join(path.dirname(cwd), "artifacts"),
    state: "process-bound",
    launchRuntimeRoot: "/tmp/omp-harness2-worker-abcdef",
    pid: 4321,
    pgid: 4321,
    processIdentitySha256: "c".repeat(64),
    cleanup: null,
    ...overrides,
  };
}

function recoveryAttempts(count: number): NativeHarnessHistoryRecoveryRowInput[] {
  return Array.from({ length: count }, (_, index) => {
    const attempt = index + 1;
    return recoveryRow({
      ordinal: attempt,
      nonce: recoveryNonce(attempt),
      attempt,
      cwd: recoveryCwd("baseline", attempt),
      artifactDir: path.join(path.dirname(recoveryCwd("baseline", attempt)), "artifacts"),
    });
  });
}

function recoveryTargets(rows: readonly NativeHarnessHistoryRecoveryRowInput[]) {
  return deriveNativeHarnessHistoryRecoveryTargets(ROOT, RUN_ROOT, RUN_ID, rows);
}

function emptyProjectionAttempt(
  groupComparison: NativeHarnessHistoryRecoveryAttemptSummaryInput["groupComparison"],
  workerComparison: NativeHarnessHistoryRecoveryAttemptSummaryInput["workerComparison"],
  coverage: NativeHarnessHistoryRecoveryAttemptSummaryInput["coverage"],
): NativeHarnessHistoryRecoveryAttemptSummaryInput {
  const target = recoveryTargets([recoveryRow()]).attempts[0]!;
  return {
    target,
    round1Worker: null,
    round2Worker: null,
    binding1: null,
    binding2: null,
    group1: null,
    group2: null,
    workerComparison,
    groupComparison,
    coverage,
  };
}

function projectionInput(
  attempts: readonly NativeHarnessHistoryRecoveryAttemptSummaryInput[],
  finalPrimaryStatus: NativeHarnessHistoryRecoveryProjectionInput["finalPrimaryStatus"],
): NativeHarnessHistoryRecoveryProjectionInput {
  return {
    attempts,
    controller: {
      round1Owner: null,
      round2Owner: null,
      probe1: null,
      probe2: null,
      ownerComparison: "stable",
      probeComparison: "stable",
      lockDirectory1: "missing",
      lockDirectory2: "missing",
    },
    cancel: {
      round1: null,
      round2: null,
      status: "not-observed",
      comparison: "stable",
    },
    inventoryRows: attempts.length,
    auxAttemptsRound1: 0,
    auxAttemptsRound2: 0,
    auxChargedBytes: 0,
    probesRound1: 0,
    probesRound2: 0,
    window: {
      budgetMs: 5_000,
      startedAt: 100,
      deadlineAt: 5_100,
      checkedAt: 200,
      expired: false,
      globalDeadlineAt: 30_100,
      roundsStarted: 2,
    },
    gate: null,
    prerequisiteFailure: null,
    derivationProblems: [],
    finalPrimaryStatus,
    revokedReasons: finalPrimaryStatus === "stable" ? [] : ["changed"],
  };
}

describe("bounded process targets and owner declarations", () => {
  test("derives the exact vendor controller and current attempt owner paths", () => {
    const targets = derive();
    expect(targets.targetCount).toBe(2);
    expect(targets.controller.ownerRelativePath).toBe(`${RUN_ROOT}/.run.lock/owner.json`);
    expect(targets.stages[0]?.target).not.toBeNull();
    expect(targets.stages[0]?.target?.ownerRelativePath).toBe(
      `${RUN_ROOT}/stages/baseline/attempt-2-${UUID}/artifacts/worker-owner.json`,
    );
  });

  test("rejects the reversed workspace/attempt layout with no target and no read", () => {
    const reversed = path.join(ROOT, RUN_ROOT, "stages", "baseline", "workspace", `attempt-2-${UUID}`);
    const targets = derive(reversed);
    expect(targets.stages[0]?.target).toBeNull();
    expect(targets.stages[0]?.problem?.code).toBe("stage-workspace-invalid");
    expect(targets.targetCount).toBe(1);
  });

  test("rejects run/stage/cwd escapes and unknown stage IDs without a target", () => {
    const outside = path.join("/tmp", "other", RUN_ROOT, "stages", "baseline", `attempt-2-${UUID}`, "workspace");
    expect(derive(outside).stages[0]?.target).toBeNull();
    const wrongAttempt = deriveNativeHarnessHistoryProcessTargets(
      ROOT,
      RUN_ROOT,
      RUN_ID,
      [{ id: "baseline", status: "completed", attempt: 3, cwd: stageCwd(2) }],
    );
    expect(wrongAttempt.stages[0]?.target).toBeNull();
    expect(wrongAttempt.stages[0]?.problem?.code).toBe("stage-workspace-invalid");
    const wrongStage = deriveNativeHarnessHistoryProcessTargets(
      ROOT,
      RUN_ROOT,
      RUN_ID,
      [{ id: "final", status: "running", attempt: 2, cwd: stageCwd() }],
    );
    expect(wrongStage.stages[0]?.target).toBeNull();
    expect(wrongStage.stages[0]?.problem?.code).toBe("stage-workspace-invalid");
    const unknown = deriveNativeHarnessHistoryProcessTargets(
      ROOT,
      RUN_ROOT,
      RUN_ID,
      [{ id: "not_a_stage", status: "running", attempt: 1, cwd: stageCwd(1) }],
    );
    expect(unknown.stages[0]?.target).toBeNull();
    expect(unknown.stages[0]?.problem?.code).toBe("stage-id-invalid");
  });

  test("caps targets at 16 and refuses extra rows without an owner path", () => {
    const stages = ["baseline", "inv_edit", "dom_edit", "inv_probe", "dom_probe", "compose_edit",
      "final", "select", "reflect", "plan", "route_1", "route_2", "route_3", "review", "refine"]
      .map((id, index) => ({
        id,
        status: "completed" as const,
        attempt: index + 1,
        cwd: path.join(ROOT, RUN_ROOT, "stages", id, `attempt-${index + 1}-${UUID}`, "workspace"),
      }));
    const targets = deriveNativeHarnessHistoryProcessTargets(ROOT, RUN_ROOT, RUN_ID, stages);
    expect(targets.targetCount).toBe(NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.maxTargets);
    expect(targets.stages).toHaveLength(15);
    expect(targets.stages.some((row) => row.problem?.code === "stage-target-limit")).toBe(false);
    expect(targets.stages.every((row) => row.target !== null)).toBe(true);
  });

  test("decodes worker and controller declarations but not a target mismatch", () => {
    const targets = derive();
    const workerTarget = targets.stages[0]!.target!;
    const worker = decodeNativeHarnessHistoryProcessOwner(workerTarget, RUN_ID, ownerText(workerOwner()));
    expect(worker.state).toBe("observed");
    expect(worker.declaration?.kind).toBe("worker");
    expect(worker.declaration?.pid).toBe(4321);
    expect(worker.declaration?.kind === "worker" ? worker.declaration.pgid : null).toBe(4321);

    const mismatch = decodeNativeHarnessHistoryProcessOwner(
      workerTarget,
      RUN_ID,
      ownerText(workerOwner({ stage: "final" })),
    );
    expect(mismatch.state).toBe("invalid");
    expect(mismatch.problem?.code).toBe("owner-target-mismatch");
    expect(mismatch.declaration).toBeNull();

    const controller = decodeNativeHarnessHistoryProcessOwner(
      targets.controller,
      RUN_ID,
      ownerText({ pid: 99, token: "lock-token", createdAt: STARTED_AT }),
    );
    expect(controller.state).toBe("observed");
    expect(controller.declaration?.kind).toBe("controller");
    expect(controller.declaration?.pid).toBe(99);

    const oversized = decodeNativeHarnessHistoryProcessOwner(workerTarget, RUN_ID, {
      text: "x".repeat(NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.ownerDecodeBytes + 1),
      bytes: NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.ownerDecodeBytes + 1,
      sha256: "b".repeat(64),
      observedAt: 11,
    });
    expect(oversized.state).toBe("invalid");
    expect(oversized.problem?.code).toBe("owner-decode-oversized");
  });
});

describe("recovery lifecycle targets and fixed signal-0 probes", () => {
  test("retains multiple attempts of the same stage by ordinal and nonce", () => {
    const thirdCwd = recoveryCwd("baseline", 3);
    const rows = [
      recoveryRow({ ordinal: 1, nonce: recoveryNonce(1), attempt: 2 }),
      recoveryRow({
        ordinal: 2,
        nonce: recoveryNonce(2),
        attempt: 3,
        cwd: thirdCwd,
        artifactDir: path.join(path.dirname(thirdCwd), "artifacts"),
      }),
    ];
    const targets = recoveryTargets(rows);
    expect(targets.refused).toBe(false);
    expect(targets.attempts).toHaveLength(2);
    expect(targets.attempts[0]?.targetId).toBe(`attempt-1-${recoveryNonce(1)}`);
    expect(targets.attempts[1]?.targetId).toBe(`attempt-2-${recoveryNonce(2)}`);
    expect(targets.attempts[0]?.workerOwner?.relativePath).toContain("attempt-2-");
    expect(targets.attempts[1]?.workerOwner?.relativePath).toContain("attempt-3-");
  });

  test("keeps exactly 32 attempts and refuses 33 before any target effect", () => {
    const accepted = recoveryTargets(recoveryAttempts(32));
    expect(accepted.refused).toBe(false);
    expect(accepted.attempts).toHaveLength(32);
    expect(accepted.workerOwnerTargets).toBe(32);
    expect(accepted.auxTargetsPerRound).toBe(34);
    expect(accepted.auxChargePerRound).toBe(540_736);
    expect(accepted.auxChargeTotal).toBe(NATIVE_HARNESS_HISTORY_RECOVERY_LIMITS.auxChargeLimitBytes);
    expect(accepted.auxChargeTotal).toBe(1_081_472);

    const refused = recoveryTargets(recoveryAttempts(33));
    expect(refused.refused).toBe(true);
    expect(refused.attempts).toEqual([]);
    expect(refused.inventoryRows).toBe(33);
    expect(refused.workerOwnerTargets).toBe(0);
    expect(refused.auxTargetsPerRound).toBe(0);
    expect(refused.auxChargeTotal).toBe(0);
    expect(refused.problems[0]?.code).toBe("recovery-attempt-limit");
  });

  test("queries every row group and one controller in each of two rounds without dedupe", () => {
    const targets = recoveryTargets(recoveryAttempts(32));
    const calls: Array<{ pid: number; signal: number }> = [];
    const seam = (pid: number, signal: 0): void => {
      calls.push({ pid, signal });
    };
    for (let round = 0; round < 2; round++) {
      for (const attempt of targets.attempts) {
        const fact = probeNativeHarnessHistoryRecoveryGroup(attempt, seam);
        expect(fact.called).toBe(true);
        expect(fact.presence).toBe("present");
        expect(fact.signal).toBe(0);
      }
      const controller = probeNativeHarnessHistoryRecoveryController(9999, seam);
      expect(controller.called).toBe(true);
      expect(controller.presence).toBe("present");
      expect(controller.signal).toBe(0);
    }
    expect(calls).toHaveLength(66);
    expect(calls.filter((call) => call.pid < 0)).toHaveLength(64);
    expect(calls.every((call) => call.signal === 0)).toBe(true);
  });

  test("refuses PGID <= 1 before the seam and classifies ESRCH, EPERM and unusable results", () => {
    let calls = 0;
    const seam = (): void => { calls += 1; };
    const refusedTarget = recoveryTargets([recoveryRow({ pgid: 1, pid: 1 })]).attempts[0]!;
    const refused = probeNativeHarnessHistoryRecoveryGroup(refusedTarget, seam);
    expect(calls).toBe(0);
    expect(refused.called).toBe(false);
    expect(refused.refused).toBe(true);
    expect(refused.problem?.code).toBe("probe-target-refused");

    const target = recoveryTargets([recoveryRow()]).attempts[0]!;
    const esrch = probeNativeHarnessHistoryRecoveryGroup(target, () => {
      const error = new Error("gone");
      Object.defineProperty(error, "code", { value: "ESRCH", enumerable: true });
      throw error;
    });
    expect(esrch.called).toBe(true);
    expect(esrch.presence).toBe("not-observed");

    const eperm = probeNativeHarnessHistoryRecoveryGroup(target, () => {
      const error = new Error("denied");
      Object.defineProperty(error, "code", { value: "EPERM", enumerable: true });
      throw error;
    });
    expect(eperm.presence).toBe("unknown");

    const accessor = probeNativeHarnessHistoryRecoveryGroup(target, () => {
      const error = {};
      Object.defineProperty(error, "code", {
        enumerable: true,
        get() { throw new Error("descriptor trap"); },
      });
      throw error;
    });
    expect(accessor.presence).toBe("unknown");

    const inherited = probeNativeHarnessHistoryRecoveryGroup(target, () => {
      throw Object.create({ code: "ESRCH" });
    });
    expect(inherited.presence).toBe("unknown");

    const asynchronous = probeNativeHarnessHistoryRecoveryGroup(
      target,
      (() => Promise.resolve()) as unknown as (pid: number, signal: 0) => void,
    );
    expect(asynchronous.called).toBe(true);
    expect(asynchronous.presence).toBe("unknown");
  });

  test("recomputes the exact original runner association and reports mismatches", () => {
    const runtimeRoot = "/tmp/omp-harness2-worker-abcdef";
    const expected = sha256Hex(JSON.stringify({
      pgid: 4321,
      pid: 4321,
      runId: RUN_ID,
      runtimeRoot,
      stage: "baseline",
      startedAt: STARTED_AT,
    }));
    const target = recoveryTargets([
      recoveryRow({ processIdentitySha256: expected }),
    ]).attempts[0]!;
    const decodedTarget = derive().stages[0]!.target!;
    const read = decodeNativeHarnessHistoryProcessOwner(decodedTarget, RUN_ID, ownerText(workerOwner()));
    const binding = bindNativeHarnessHistoryRecoveryWorker(target, RUN_ID, read);
    expect(binding.state).toBe("matches");
    expect(binding.associationSha256).toBe(expected);
    expect(binding.declaredIdentitySha256).toBe(expected);

    const wrongIdentity = bindNativeHarnessHistoryRecoveryWorker(
      recoveryTargets([recoveryRow({ processIdentitySha256: "d".repeat(64) })]).attempts[0]!,
      RUN_ID,
      read,
    );
    expect(wrongIdentity.state).toBe("mismatch");

    const wrongRuntime = bindNativeHarnessHistoryRecoveryWorker(
      target,
      RUN_ID,
      decodeNativeHarnessHistoryProcessOwner(
        decodedTarget,
        RUN_ID,
        ownerText(workerOwner({ privateRuntimeRoot: "/tmp/omp-harness2-worker-zzzzzz" })),
      ),
    );
    expect(wrongRuntime.state).toBe("mismatch");

    expect(bindNativeHarnessHistoryRecoveryWorker(target, RUN_ID, null).state).toBe("not-observed");
    const launchOnly = recoveryTargets([
      recoveryRow({ pid: null, pgid: null, processIdentitySha256: null }),
    ]).attempts[0]!;
    expect(bindNativeHarnessHistoryRecoveryWorker(launchOnly, RUN_ID, null).state).toBe("unknown");
    const noProcess = recoveryTargets([
      recoveryRow({ pid: null, pgid: null, launchRuntimeRoot: null, processIdentitySha256: null }),
    ]).attempts[0]!;
    expect(bindNativeHarnessHistoryRecoveryWorker(noProcess, RUN_ID, null).state).toBe("not-applicable");
  });

  test("reports empty attempt coverage as not-required and revokes stable groups on final refusal", () => {
    const empty = projectNativeHarnessHistoryRecoveryLifecycle(projectionInput([], "stable"));
    expect(empty.status).toBe("stable");
    expect(empty.attempts).toEqual([]);
    expect(empty.completeAttemptCoverage.status).toBe("not-required");
    expect(empty.coverage.inventoryRows).toBe(0);

    const emptyOneRound = projectNativeHarnessHistoryRecoveryLifecycle({
      ...projectionInput([], "stable"),
      window: { ...projectionInput([], "stable").window, roundsStarted: 1 },
    });
    expect(emptyOneRound.completeAttemptCoverage.status).toBe("not-required");

    const invalidEmpty = projectNativeHarnessHistoryRecoveryLifecycle({
      ...projectionInput([], "stable"),
      prerequisiteFailure: {
        code: "lifecycle-metadata-unavailable",
        detail: "Invalid metadata must not look like a valid empty inventory.",
      },
    });
    expect(invalidEmpty.completeAttemptCoverage.status).toBe("unavailable");
    expect(invalidEmpty.status).toBe("unavailable");

    const mixed = projectNativeHarnessHistoryRecoveryLifecycle(projectionInput(
      [emptyProjectionAttempt("stable", "unavailable", "partial")],
      "different",
    ));
    expect(mixed.provisionalStatus).toBe("unavailable");
    expect(mixed.status).toBe("revoked");
    expect(mixed.revoked).toBe(true);
    expect(mixed.currentGroups.status).toBe("revoked");
    expect(mixed.attempts[0]?.group.comparison).toBe("revoked");
    // Missing controller owners stay not-observed rather than becoming a
    // stable presentation; the raw comparisons are still revoked.
    expect(mixed.controllerLease.ownerComparison).toBe("revoked");
    expect(mixed.controllerLease.probeComparison).toBe("revoked");
    expect(mixed.cancel.comparison).toBe("revoked");
    expect(mixed.observationStability.workerAuxStable).toBeNull();
    expect(mixed.observationStability.groupsStable).toBeNull();
    expect(mixed.observationStability.controllerStable).toBeNull();
    expect(mixed.observationStability.cancelStable).toBeNull();
    expect(mixed.coverage.auxChargedBytes).toBe(0);
  });
});

describe("fixed Darwin ps parsing and completion", () => {
  test("parses requested rows and refuses duplicate, unrequested or malformed rows", () => {
    const parsed = parseDarwinPsOutput(`${PS_LINE}\n`, [4321]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.rows[0]?.pid).toBe(4321);
      expect(parsed.rows[0]?.pgid).toBe(4321);
      expect(parsed.rows[0]?.stat).toBe("S");
      expect(parsed.rows[0]?.startedAt).toBe("Mon Jan 1 00:00:00 2026");
      expect(parsed.rows[0]?.command).toContain("omp-harness2-worker-abcdef");
    }
    const duplicate = parseDarwinPsOutput(`${PS_LINE}\n${PS_LINE}\n`, [4321]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.problem.code).toBe("duplicate-pid");
    const unexpected = parseDarwinPsOutput(`${PS_LINE}\n`, [9999]);
    expect(unexpected.ok).toBe(false);
    if (!unexpected.ok) expect(unexpected.problem.code).toBe("unexpected-pid");
    const malformed = parseDarwinPsOutput("not a ps row\n", [4321]);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.problem.code).toBe("malformed-output");
  });

  test("classifies exit 0, exit 1 empty, exit 1 output, stderr, truncation and timeout", () => {
    const base = {
      requestedPids: [4321],
      exitCode: 0,
      exitSignal: null,
      stdout: `${PS_LINE}\n`,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
      spawnError: null,
      childError: null,
      queryStarted: true,
      cleanup: "settled" as const,
      observedAt: 1234,
    };
    expect(classifyDarwinPsCompletion(base).state).toBe("completed");
    const empty = classifyDarwinPsCompletion({ ...base, exitCode: 1, stdout: "" });
    expect(empty.state).toBe("not-observed");
    expect(empty.observedAt).toBe(1234);
    const exitOneOutput = classifyDarwinPsCompletion({ ...base, exitCode: 1, stdout: "x" });
    expect(exitOneOutput.state).toBe("unknown");
    expect(exitOneOutput.cause).toBe("exit-status");
    const stderr = classifyDarwinPsCompletion({ ...base, stderr: "permission denied" });
    expect(stderr.state).toBe("unknown");
    expect(stderr.cause).toBe("stderr");
    const newlineStderr = classifyDarwinPsCompletion({ ...base, stderr: "\n" });
    expect(newlineStderr.state).toBe("unknown");
    expect(newlineStderr.cause).toBe("stderr");
    const newlineStderrExitOne = classifyDarwinPsCompletion({ ...base, exitCode: 1, stdout: "", stderr: "\n" });
    expect(newlineStderrExitOne.state).toBe("unknown");
    expect(newlineStderrExitOne.cause).toBe("stderr");
    const spawnFailure = classifyDarwinPsCompletion({ ...base, spawnError: "failed", queryStarted: false });
    expect(spawnFailure.cause).toBe("spawn-error");
    expect(spawnFailure.queryStarted).toBe(false);
    const childFailure = classifyDarwinPsCompletion({ ...base, childError: "error" });
    expect(childFailure.cause).toBe("child-error");
    expect(childFailure.queryStarted).toBe(true);
    const truncated = classifyDarwinPsCompletion({ ...base, stdoutTruncated: true });
    expect(truncated.state).toBe("unknown");
    expect(truncated.cause).toBe("truncated-stdout");
    const timeout = classifyDarwinPsCompletion({ ...base, timedOut: true });
    expect(timeout.state).toBe("unknown");
    expect(timeout.cause).toBe("timeout");
    const aborted = classifyDarwinPsCompletion({ ...base, aborted: true });
    expect(aborted.cause).toBe("aborted");
    const noClose = classifyDarwinPsCompletion({ ...base, cleanup: "unknown" });
    expect(noClose.cause).toBe("cleanup-unknown");
    const emptyZero = classifyDarwinPsCompletion({ ...base, stdout: "" });
    expect(emptyZero.cause).toBe("empty-output");
  });
});

class FakeStream extends EventEmitter {
  destroy(): void {}
}

class FakeChild extends EventEmitter {
  readonly pid = 54321;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  killed = 0;
  unrefed = false;
  kill(): boolean {
    this.killed += 1;
    return true;
  }
  unref(): void {
    this.unrefed = true;
  }
}

function asChild(child: FakeChild): NativeHarnessHistoryProcessChild {
  return child as unknown as NativeHarnessHistoryProcessChild;
}

describe("fixed Darwin observer with a finite fake subprocess", () => {
  test("queries only the selected PIDs with fixed /bin/ps arguments and a minimal environment", async () => {
    let seen: { command: string; args: string[]; options: unknown } | null = null;
    const child = new FakeChild();
    const spawn: NativeHarnessHistoryProcessSpawn = (command, args, options) => {
      seen = { command, args: [...args], options };
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(`${PS_LINE}\n`));
        child.emit("close", 0, null);
      });
      return asChild(child);
    };
    const observer = createDarwinHistoryProcessObserver({
      platform: "darwin",
      spawn,
      budgetMs: 1000,
      cleanupMs: 100,
      now: () => 777,
    });
    const result = await observer.observePids([4321], new AbortController().signal);
    expect(seen).not.toBeNull();
    const call = seen as unknown as { command: string; args: string[]; options: Record<string, unknown> };
    expect(call.command).toBe("/bin/ps");
    expect(call.args).toEqual(["-p", "4321", "-o", "pid=,pgid=,stat=,lstart=,command="]);
    expect(call.options.env).toEqual({ LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" });
    expect(call.options.shell).toBe(false);
    expect(result.state).toBe("completed");
    expect(result.queryStarted).toBe(true);
    expect(result.observedAt).toBe(777);
    expect(result.rows).toHaveLength(1);
  });

  test("bounds a hanging fake child, kills only that child and reports cleanup unknown", async () => {
    const child = new FakeChild();
    const observer = createDarwinHistoryProcessObserver({
      platform: "darwin",
      spawn: () => asChild(child),
      budgetMs: 20,
      cleanupMs: 10,
      now: () => 1,
    });
    const result = await observer.observePids([4321], new AbortController().signal);
    expect(result.state).toBe("unknown");
    expect(result.cause).toBe("timeout");
    expect(result.cleanup).toBe("unknown");
    expect(child.killed).toBeGreaterThan(0);
    expect(child.unrefed).toBe(true);
  });

  test("observes an abort raised synchronously inside the spawn callback", async () => {
    const controller = new AbortController();
    const child = new FakeChild();
    const observer = createDarwinHistoryProcessObserver({
      platform: "darwin",
      spawn: () => {
        controller.abort();
        queueMicrotask(() => child.emit("close", 0, null));
        return asChild(child);
      },
      budgetMs: 1000,
      cleanupMs: 100,
      now: () => 1,
    });
    const result = await observer.observePids([4321], controller.signal);
    expect(result.state).toBe("unknown");
    expect(result.cause).toBe("aborted");
    expect(result.queryStarted).toBe(true);
    expect(result.cleanup).toBe("settled");
    expect(child.killed).toBeGreaterThan(0);
  });

  test("re-reads the actual aborted state after registration despite a shadowed own flag", async () => {
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "aborted", { value: false });
    const child = new FakeChild();
    const observer = createDarwinHistoryProcessObserver({
      platform: "darwin",
      spawn: () => {
        controller.abort();
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from(`${PS_LINE}\n`));
          child.emit("close", 0, null);
        });
        return asChild(child);
      },
      budgetMs: 1000,
      cleanupMs: 100,
      now: () => 1,
    });
    const result = await observer.observePids([4321], controller.signal);
    expect(controller.signal.aborted).toBe(false);
    expect(result.state).toBe("unknown");
    expect(result.cause).toBe("aborted");
    expect(result.queryStarted).toBe(true);
    expect(result.cleanup).toBe("settled");
    expect(child.killed).toBeGreaterThan(0);
  });

  test("a started child error uses a bounded cleanup window instead of leaking", async () => {
    const child = new FakeChild();
    const observer = createDarwinHistoryProcessObserver({
      platform: "darwin",
      spawn: () => {
        queueMicrotask(() => child.emit("error", new Error("fixture error")));
        return asChild(child);
      },
      budgetMs: 100,
      cleanupMs: 10,
      now: () => 1,
    });
    const result = await observer.observePids([4321], new AbortController().signal);
    expect(result.state).toBe("unknown");
    expect(result.cause).toBe("child-error");
    expect(result.queryStarted).toBe(true);
    expect(result.cleanup).toBe("unknown");
    expect(child.killed).toBeGreaterThan(0);
  });

  test("returns unsupported without spawning on a non-Darwin host", async () => {
    let spawned = 0;
    const observer = createDarwinHistoryProcessObserver({
      platform: "linux",
      spawn: () => {
        spawned += 1;
        return asChild(new FakeChild());
      },
    });
    const result = await observer.observePids([4321], new AbortController().signal);
    expect(spawned).toBe(0);
    expect(result.state).toBe("unknown");
    expect(result.cause).toBe("unsupported-platform");
    expect(result.queryStarted).toBe(false);
  });
});
