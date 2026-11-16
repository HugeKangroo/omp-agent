import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureNativeHarnessOutput,
  matchesNativeHarnessOutputCapture,
  type NativeHarnessOutputCapture,
  type NativeHarnessOutputCheckpoint,
} from "../../src/native-harness-output.ts";
import {
  createNativeHarnessBackend,
  readNativeHarnessBackendCompletion,
  type NativeHarnessBackendHostConfig,
} from "../../src/native-harness-backend.ts";
import type { NativeHarnessBackendCompletion } from "../../src/native-harness-completion.ts";
import {
  NATIVE_HARNESS_MAX_DURATION_MS,
  type NativeHarnessBackend,
  type NativeHarnessPrepareRequest,
} from "../../src/native-harness-delegation.ts";
import type { NativeContext } from "../../src/native-entry.ts";
import { createNativeTextCheckPlan, runNativeTextChecks } from "../../src/native-snapshot-checker.ts";
import { isNativeWorkspaceTextSnapshot } from "../../src/native-work.ts";
import type { Runner, WorkerRequest, WorkerResult } from "../../vendor/harness2/index.ts";

const PLAN_RESPONSE = JSON.stringify({
  decision: "direct",
  reason: "Bounded output capture planning.",
  criteria: [{ id: "task", description: "Fulfill the requested bounded task.", kind: "requirement" }],
  routes: [],
});

const SELECT_RESPONSE = JSON.stringify({
  method: "model_review",
  assessments: [{
    candidate: "A",
    criteria: [{ criterionId: "task", verdict: "unknown", evidence: "Bounded test evidence." }],
    strengths: [],
    weaknesses: [],
  }],
  winner: "A",
  reason: "Bounded test selection.",
  limitations: ["Bounded test execution is not semantic acceptance."],
});

const EXPLORE_PLAN_RESPONSE = JSON.stringify({
  decision: "explore",
  reason: "Bounded output capture exploration.",
  criteria: [{ id: "task", description: "Fulfill the requested bounded task.", kind: "requirement" }],
  routes: [
    { id: "route_1", name: "Route one", approach: "Bounded first approach.", assumptions: [], tradeoffs: [] },
    { id: "route_2", name: "Route two", approach: "Bounded second approach.", assumptions: [], tradeoffs: [] },
  ],
});

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly host: NativeHarnessBackendHostConfig;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g53a1b-")));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const storageRoot = path.join(root, "private");
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(storageRoot, { mode: 0o700 });
  await writeFile(path.join(sourceRoot, "a.txt"), "alpha\n", { mode: 0o600 });
  await writeFile(path.join(sourceRoot, "b.txt"), "beta\n", { mode: 0o600 });
  return {
    root,
    sourceRoot,
    storageRoot,
    host: {
      model: "deepseek/deepseek-chat",
      ompCommand: "/usr/bin/fake-omp",
      storageRoot,
      inputFiles: ["a.txt", "b.txt"],
    },
  };
}

function contextFor(f: Fixture): NativeContext {
  return {
    cwd: f.sourceRoot,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => "g53a1b-session",
      getCwd: () => f.sourceRoot,
    },
  };
}

interface RunnerOptions {
  readonly candidateFiles?: readonly string[];
  readonly candidateBytes?: Uint8Array;
}

interface DeterministicRunner {
  readonly runner: Runner;
  readonly requests: WorkerRequest[];
}

function deterministicRunner(options: RunnerOptions = {}): DeterministicRunner {
  const requests: WorkerRequest[] = [];
  const files = options.candidateFiles ?? ["candidate.txt"];
  let index = 0;
  const runner: Runner = {
    async run(request: WorkerRequest): Promise<WorkerResult> {
      requests.push(request);
      await mkdir(request.artifactDir, { recursive: true, mode: 0o700 });
      const eventsPath = path.join(request.artifactDir, "worker-events.jsonl");
      await writeFile(eventsPath, `${JSON.stringify({ type: "fixture", stage: request.stage })}\n`, { mode: 0o600 });
      let text = "stage completed";
      if (request.stage === "plan") {
        text = PLAN_RESPONSE;
      } else if (request.stage === "select") {
        text = SELECT_RESPONSE;
      } else if (request.stage === "baseline") {
        for (const [offset, file] of files.entries()) {
          if (options.candidateBytes !== undefined) {
            await writeFile(path.join(request.cwd, file), options.candidateBytes, { mode: 0o600 });
          } else {
            await writeFile(path.join(request.cwd, file), `candidate ${offset} ${index}\n`, { mode: 0o600 });
          }
          index += 1;
        }
        text = "baseline completed";
      }
      return {
        text,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        eventsPath,
        status: "completed",
      };
    },
  };
  return { runner, requests };
}

function explorationEvaluation(stage: "review" | "select", runId: string): string {
  const candidates = stage === "review"
    ? ["baseline", "route_1", "route_2"]
    : ["baseline", "route_1", "route_2", "refine"];
  const ordered = [...candidates].sort((left, right) => {
    const leftHash = createHash("sha256").update(`${runId}:${left}`).digest("hex");
    const rightHash = createHash("sha256").update(`${runId}:${right}`).digest("hex");
    return leftHash.localeCompare(rightHash);
  });
  const label = (candidate: string): string => {
    const index = ordered.indexOf(candidate);
    if (index < 0) throw new Error("fixture candidate is not evaluated");
    return String.fromCharCode(65 + index);
  };
  const winner = stage === "review" ? "route_2" : "refine";
  return JSON.stringify({
    assessments: ordered.map((candidate) => ({
      candidate: label(candidate),
      criteria: [{ criterionId: "task", verdict: "unknown", evidence: "Bounded fixture evidence." }],
      strengths: [],
      weaknesses: [],
    })),
    winner: label(winner),
    reason: "Bounded fixture selection.",
    limitations: ["Bounded fixture execution is not semantic acceptance."],
    ...(stage === "review"
      ? { refinement: { candidate: label("route_2"), instructions: "Refine the bounded route." } }
      : {}),
  });
}

function exploreRunner(): DeterministicRunner {
  const requests: WorkerRequest[] = [];
  const runner: Runner = {
    async run(request: WorkerRequest): Promise<WorkerResult> {
      requests.push(request);
      await mkdir(request.artifactDir, { recursive: true, mode: 0o700 });
      const eventsPath = path.join(request.artifactDir, "worker-events.jsonl");
      await writeFile(eventsPath, `${JSON.stringify({ type: "fixture", stage: request.stage })}\n`, { mode: 0o600 });
      let text = "stage completed";
      if (request.stage === "plan") {
        text = EXPLORE_PLAN_RESPONSE;
      } else if (request.stage === "review" || request.stage === "select") {
        text = explorationEvaluation(request.stage, request.runId);
      } else if (request.stage !== "reflect") {
        await writeFile(path.join(request.cwd, `${request.stage}.txt`), `${request.stage}\n`, { mode: 0o600 });
        text = `${request.stage} completed`;
      }
      return {
        text,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        eventsPath,
        status: "completed",
      };
    },
  };
  return { runner, requests };
}

function prepareRequest(f: Fixture, runner: Runner): NativeHarnessPrepareRequest {
  return Object.freeze({
    association: Object.freeze({
      observationId: "observation-g53a1b",
      generation: 1,
      sessionId: "g53a1b-session",
      workspaceRoot: f.sourceRoot,
      toolCallId: "call-g53a1b",
      toolName: "agent_harness" as const,
    }),
    budget: Object.freeze({
      maxCostUsd: 1,
      deadlineAt: Date.now() + 120_000,
      maxDurationMs: NATIVE_HARNESS_MAX_DURATION_MS,
    }),
    signal: new AbortController().signal,
    runner,
    guard: () => undefined,
  });
}

interface Executed {
  readonly backend: NativeHarnessBackend;
  readonly completion: NativeHarnessBackendCompletion;
  readonly runId: string;
  readonly record: Record<string, any>;
  readonly storeRoot: string;
}

async function executed(runner: Runner = deterministicRunner().runner): Promise<Executed> {
  const f = await fixture();
  const factory = createNativeHarnessBackend(f.host, { deterministicRunner: runner });
  const prepared = await factory.prepare(prepareRequest(f, factory.runner), contextFor(f));
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
  const created = await prepared.backend.create("bounded output capture task") as { readonly runId?: unknown };
  if (typeof created.runId !== "string") throw new Error("backend created no run");
  const settled = await prepared.backend.execute(created.runId) as { readonly status?: unknown };
  expect(settled.status).toBe("completed");
  const observed = readNativeHarnessBackendCompletion(prepared.backend);
  if (!observed.ok) throw new Error(`completion unavailable: ${observed.reason}`);
  const diagnostic = factory.inspect().at(-1)!;
  const record = JSON.parse(
    await readFile(path.join(diagnostic.storeRoot!, "runs", created.runId, "run.json"), "utf8"),
  ) as Record<string, any>;
  return {
    backend: prepared.backend,
    completion: observed.completion,
    runId: created.runId,
    record,
    storeRoot: diagnostic.storeRoot!,
  };
}

async function capture(
  backend: NativeHarnessBackend,
  options: {
    readonly signal?: AbortSignal;
    readonly guard?: () => void;
    readonly checkpoint?: (event: NativeHarnessOutputCheckpoint) => void | Promise<void>;
  } = {},
) {
  return captureNativeHarnessOutput(
    backend,
    options.guard ?? (() => undefined),
    options.signal ?? new AbortController().signal,
    options.checkpoint === undefined ? undefined : { checkpoint: options.checkpoint },
  );
}

function requireCapture(result: Awaited<ReturnType<typeof capture>>): NativeHarnessOutputCapture {
  if (!result.ok) throw new Error(`capture failed: ${result.code} ${result.reason}`);
  return result.capture;
}

describe("G5-3A1b bounded native Harness output capture", () => {
  test("actual completion yields the supported add, issued snapshot and pure matcher", async () => {
    const det = deterministicRunner();
    const run = await executed(det.runner);
    const requestCount = det.requests.length;
    const result = await capture(run.backend);
    const captureValue = requireCapture(result);
    expect(det.requests).toHaveLength(requestCount);

    expect(captureValue.schema).toBe("omp-agent.native-harness-output-capture.v1");
    expect(captureValue.originKind).toBe("harness2-native");
    expect(captureValue.completionId).toBe(run.completion.completionId);
    expect(captureValue.runId).toBe(run.runId);
    expect(captureValue.taskAccepted).toBe(false);
    expect(captureValue.semanticAcceptance).toBe("not-evaluated");
    expect(captureValue.winner).toEqual({
      candidate: "baseline",
      attempt: run.completion.winner.attempt,
      artifactHash: run.completion.winner.artifactHash,
      traceHash: run.completion.winner.traceHash,
    });
    expect(captureValue.changes).toHaveLength(1);
    const change = captureValue.changes[0]!;
    expect(change.path).toBe("candidate.txt");
    expect(change.kind).toBe("add");
    expect(change.mode).toBe(0o600);
    expect(change.snapshot.file.bytes).toBe(Buffer.byteLength("candidate 0 0\n", "utf8"));
    expect(change.snapshot.file.sha256)
      .toBe(createHash("sha256").update("candidate 0 0\n").digest("hex"));
    expect(change.controllerHash)
      .toBe(createHash("sha256")
        .update(`600\0candidate 0 0\n`, "utf8")
        .digest("hex"));
    expect(isNativeWorkspaceTextSnapshot(change.snapshot)).toBe(true);
    expect(run.record.stages.baseline.artifactHash)
      .toBe(createHash("sha256").update(JSON.stringify([{
        path: "candidate.txt",
        kind: "add",
        afterHash: change.controllerHash,
      }])).digest("hex"));

    const plan = createNativeTextCheckPlan({
      conditions: [{ id: "text", kind: "text-includes", value: "candidate 0" }],
    });
    expect(runNativeTextChecks(change.snapshot, plan).outcome).toBe("pass");

    expect(captureValue.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(captureValue.sources.map((source) => source.relativePath)).toEqual(["a.txt", "b.txt"]);
    expect(captureValue.baseInputs.map((input) => input.relativePath)).toEqual(["a.txt", "b.txt"]);
    expect(captureValue.stages).toHaveLength(1);
    expect(captureValue.stages[0]!.changeManifestSha256).toBe(run.completion.winner.artifactHash);
    expect(Object.isFrozen(captureValue)).toBe(true);
    expect(Object.isFrozen(captureValue.changes)).toBe(true);
    expect(Object.isFrozen(change)).toBe(true);

    expect(matchesNativeHarnessOutputCapture(run.backend, captureValue)).toBe(true);
    expect(matchesNativeHarnessOutputCapture(run.backend, { ...captureValue })).toBe(false);
    expect(matchesNativeHarnessOutputCapture({ ...run.backend }, captureValue)).toBe(false);
    expect(matchesNativeHarnessOutputCapture(run.backend, JSON.parse(JSON.stringify(captureValue)))).toBe(false);
    expect(matchesNativeHarnessOutputCapture(null, captureValue)).toBe(false);
    expect(matchesNativeHarnessOutputCapture(run.backend, null)).toBe(false);

    // Later file mutation cannot alter the issued historical capture or its
    // pure object/source binding.
    const winnerCwd = run.completion.winner.cwd;
    await writeFile(path.join(winnerCwd, "candidate.txt"), "mutated after issue\n", { mode: 0o600 });
    expect(matchesNativeHarnessOutputCapture(run.backend, captureValue)).toBe(true);
    expect(change.snapshot.text).toBe("candidate 0 0\n");
    expect(captureValue.digest).toBe(requireCapture(result).digest);
  });

  test("original source, stage, marker, ancestry and trace tamper refuses without writes", async () => {
    const run = await executed();
    const winnerCwd = run.completion.winner.cwd;
    const sourceRoot = run.completion.prepared.sourceRoot;
    const beforeSource = await readFile(path.join(sourceRoot, "a.txt"));
    await writeFile(path.join(sourceRoot, "a.txt"), "alpha changed\n", { mode: 0o600 });
    const source = await capture(run.backend);
    expect(source.ok).toBe(false);
    if (!source.ok) expect(source.code).toBe("changed");
    expect(await readFile(path.join(sourceRoot, "a.txt"))).not.toEqual(beforeSource);
    // Restore for the remaining independent fixtures.
    await writeFile(path.join(sourceRoot, "a.txt"), beforeSource, { mode: 0o600 });

    await writeFile(path.join(winnerCwd, "extra.txt"), "extra\n", { mode: 0o600 });
    const extra = await capture(run.backend);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.code).toBe("changed");
    await unlink(path.join(winnerCwd, "extra.txt"));

    const marker = path.join(winnerCwd, ".harness2-origin.json");
    const markerBytes = await readFile(marker, "utf8");
    await writeFile(marker, JSON.stringify({ ...JSON.parse(markerBytes), destination: "/tmp/elsewhere" }), { mode: 0o600 });
    const badMarker = await capture(run.backend);
    expect(badMarker.ok).toBe(false);
    if (!badMarker.ok) expect(badMarker.code).toBe("changed");
    await writeFile(marker, markerBytes, { mode: 0o600 });

    await mkdir(path.join(winnerCwd, "node_modules", "nested"), { recursive: true });
    await writeFile(path.join(winnerCwd, "node_modules", "nested", "extra.txt"), "dependency\n", { mode: 0o600 });
    const dependency = await capture(run.backend);
    expect(dependency.ok).toBe(false);
    if (!dependency.ok) expect(dependency.code).toBe("unsupported");
    await rm(path.join(winnerCwd, "node_modules"), { recursive: true, force: true });

    await writeFile(path.join(winnerCwd, "AGENTS.md"), "protected\n", { mode: 0o600 });
    const protectedPath = await capture(run.backend);
    expect(protectedPath.ok).toBe(false);
    if (!protectedPath.ok) expect(protectedPath.code).toBe("unsupported");
    await unlink(path.join(winnerCwd, "AGENTS.md"));

    await mkdir(path.join(winnerCwd, "nested", ".harness2-origin.json"), { recursive: true });
    const nestedMarkerDirectory = await capture(run.backend);
    expect(nestedMarkerDirectory.ok).toBe(false);
    if (!nestedMarkerDirectory.ok) expect(nestedMarkerDirectory.code).toBe("unsupported");
    await rm(path.join(winnerCwd, "nested"), { recursive: true, force: true });

    await unlink(marker);
    await mkdir(marker);
    const topLevelMarkerDirectory = await capture(run.backend);
    expect(topLevelMarkerDirectory.ok).toBe(false);
    if (!topLevelMarkerDirectory.ok) expect(topLevelMarkerDirectory.code).toBe("unsupported");
    await rm(marker, { recursive: true, force: true });
    await writeFile(marker, markerBytes, { mode: 0o600 });

    await symlink(path.join(winnerCwd, "a.txt"), path.join(winnerCwd, "link.txt"));
    const linked = await capture(run.backend);
    expect(linked.ok).toBe(false);
    if (!linked.ok) expect(linked.code).toBe("unsafe-path");
    await unlink(path.join(winnerCwd, "link.txt"));

    await unlink(run.completion.winner.eventsPath);
    const missingTrace = await capture(run.backend);
    expect(missingTrace.ok).toBe(false);
    if (!missingTrace.ok) expect(missingTrace.code).toBe("missing");
  });

  test("deletion, existing-file mode change and zero changes refuse boundedly", async () => {
    const deletionRun = await executed();
    await unlink(path.join(deletionRun.completion.winner.cwd, "a.txt"));
    const deletion = await capture(deletionRun.backend);
    expect(deletion.ok).toBe(false);
    if (!deletion.ok) expect(deletion.code).toBe("unsupported");

    const modeRun = await executed();
    await chmod(path.join(modeRun.completion.winner.cwd, "a.txt"), 0o644);
    const mode = await capture(modeRun.backend);
    expect(mode.ok).toBe(false);
    if (!mode.ok) expect(mode.code).toBe("unsupported");

    const zero = await executed(deterministicRunner({ candidateFiles: [] }).runner);
    const zeroResult = await capture(zero.backend);
    expect(zeroResult.ok).toBe(false);
    if (!zeroResult.ok) expect(zeroResult.code).toBe("no-output-changes");
  });

  test("output and inventory bounds refuse without a partial capture", async () => {
    const exact = await executed(
      deterministicRunner({ candidateFiles: Array.from({ length: 8 }, (_, index) => `exact-${index}.txt`) }).runner,
    );
    const exactResult = await capture(exact.backend);
    expect(exactResult.ok).toBe(true);
    if (exactResult.ok) expect(exactResult.capture.changes).toHaveLength(8);

    const tooManyChanges = await executed(
      deterministicRunner({ candidateFiles: Array.from({ length: 9 }, (_, index) => `out-${index}.txt`) }).runner,
    );
    const changes = await capture(tooManyChanges.backend);
    expect(changes.ok).toBe(false);
    if (!changes.ok) expect(changes.code).toBe("too-large");

    const tooManyFiles = await executed(
      deterministicRunner({ candidateFiles: Array.from({ length: 17 }, (_, index) => `file-${index}.txt`) }).runner,
    );
    const files = await capture(tooManyFiles.backend);
    expect(files.ok).toBe(false);
    if (!files.ok) expect(files.code).toBe("too-large");
  });

  test("refine winner checks the frozen parent chain against the original base", async () => {
    const run = await executed(exploreRunner().runner);
    expect(run.completion.winner.candidate).toBe("refine");
    expect(run.completion.ancestry).toHaveLength(1);
    expect(run.completion.ancestry[0]!.candidate).toBe("route_2");
    const result = await capture(run.backend);
    const captureValue = requireCapture(result);
    expect(captureValue.changes.map((change) => change.path)).toEqual(["refine.txt", "route_2.txt"]);
    expect(captureValue.stages.map((stage) => stage.candidate)).toEqual(["refine", "route_2"]);
    expect(captureValue.stages.every((stage) => stage.artifactHash === stage.changeManifestSha256)).toBe(true);
    expect(matchesNativeHarnessOutputCapture(run.backend, captureValue)).toBe(true);
  });

  test("abort, async guard, guard refusal and final-guard abort issue nothing", async () => {
    const run = await executed();
    const prescinded = new AbortController();
    prescinded.abort();
    const aborted = await capture(run.backend, { signal: prescinded.signal });
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) expect(aborted.code).toBe("aborted");

    const asyncGuard = await capture(run.backend, { guard: (() => Promise.resolve()) as unknown as () => void });
    expect(asyncGuard.ok).toBe(false);
    if (!asyncGuard.ok) expect(asyncGuard.code).toBe("invalid-control");

    const hostile = {
      get then(): unknown {
        throw new Error("throwing then getter");
      },
      get code(): unknown {
        throw new Error("throwing code getter");
      },
    };
    for (const value of [null, false, 0, hostile]) {
      const nonUndefined = await capture(run.backend, { guard: (() => value) as unknown as () => void });
      expect(nonUndefined.ok).toBe(false);
      if (!nonUndefined.ok) expect(nonUndefined.code).toBe("invalid-control");
    }
    const hostileThrow = await capture(run.backend, {
      guard: () => { throw hostile; },
    });
    expect(hostileThrow.ok).toBe(false);
    if (!hostileThrow.ok) expect(hostileThrow.code).toBe("authority-lost");

    const refused = await capture(run.backend, { guard: () => { throw new Error("no authority"); } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("authority-lost");

    const controller = new AbortController();
    const midAbort = await capture(run.backend, {
      signal: controller.signal,
      checkpoint(event) {
        if (event.point === "after-directory-open") controller.abort();
      },
    });
    expect(midAbort.ok).toBe(false);
    if (!midAbort.ok) expect(midAbort.code).toBe("aborted");

    const finalController = new AbortController();
    const finalAbort = await capture(run.backend, {
      signal: finalController.signal,
      checkpoint(event) {
        if (event.point === "before-issue") finalController.abort();
      },
    });
    expect(finalAbort.ok).toBe(false);
    if (!finalAbort.ok) expect(finalAbort.code).toBe("aborted");

    // Exact final-guard regression: the guard itself aborts the actual signal
    // and returns undefined. The post-guard genuine getter must see it and
    // refuse issuance.
    const guardController = new AbortController();
    let armed = false;
    const guardAbort = await capture(run.backend, {
      signal: guardController.signal,
      guard: () => {
        if (armed) guardController.abort();
      },
      checkpoint(event) {
        if (event.point === "before-issue") armed = true;
      },
    });
    expect(guardAbort.ok).toBe(false);
    if (!guardAbort.ok) expect(guardAbort.code).toBe("aborted");
  });

  test("native aborted getter ignores shadowed instance state", async () => {
    const run = await executed();
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "aborted", { value: true, configurable: true });
    const shadowedTrue = await capture(run.backend, { signal: controller.signal });
    expect(shadowedTrue.ok).toBe(true);

    const aborted = new AbortController();
    aborted.abort();
    Object.defineProperty(aborted.signal, "aborted", { value: false, configurable: true });
    const shadowedFalse = await capture(run.backend, { signal: aborted.signal });
    expect(shadowedFalse.ok).toBe(false);
    if (!shadowedFalse.ok) expect(shadowedFalse.code).toBe("aborted");
  });

  test("special permission bits refuse on output, base, source, marker and trace", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly path: (run: Executed) => string;
    }> = [
      { name: "output", path: (run) => path.join(run.completion.winner.cwd, "candidate.txt") },
      { name: "base", path: (run) => path.join(run.completion.base.root, "a.txt") },
      { name: "source", path: (run) => path.join(run.completion.prepared.sourceRoot, "a.txt") },
      { name: "marker", path: (run) => path.join(run.completion.winner.cwd, ".harness2-origin.json") },
      { name: "trace", path: (run) => run.completion.winner.eventsPath },
    ];
    for (const item of cases) {
      const run = await executed();
      await chmod(item.path(run), 0o4600);
      const result = await capture(run.backend);
      expect(result.ok, item.name).toBe(false);
      if (!result.ok) expect(result.code, item.name).toBe("unsupported");
    }
  });

  test("BOM is retained exactly and invalid UTF-8 refuses", async () => {
    const bomBytes = Buffer.from("\uFEFFbom\n", "utf8");
    const bomRun = await executed(
      deterministicRunner({ candidateFiles: ["bom.txt"], candidateBytes: bomBytes }).runner,
    );
    const bomCapture = requireCapture(await capture(bomRun.backend));
    const bom = bomCapture.changes[0]!;
    expect(bom.snapshot.text).toBe("\uFEFFbom\n");
    expect(bom.snapshot.file.bytes).toBe(bomBytes.length);
    expect(bom.snapshot.file.sha256).toBe(createHash("sha256").update(bomBytes).digest("hex"));
    expect(bom.controllerHash)
      .toBe(createHash("sha256").update("600\0", "utf8").update(bomBytes).digest("hex"));

    const invalidRun = await executed(
      deterministicRunner({
        candidateFiles: ["bad.txt"],
        candidateBytes: new Uint8Array([0xff, 0xfe, 0xfd]),
      }).runner,
    );
    const invalid = await capture(invalidRun.backend);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.code).toBe("unsupported");
  });

  test("FIFO replacement at the trace-open checkpoint cannot block the capture", async () => {
    const run = await executed();
    const eventsPath = run.completion.winner.eventsPath;
    const replaced = await capture(run.backend, {
      checkpoint(event) {
        if (event.point === "before-trace-open" && event.stage === "baseline") {
          execFileSync("rm", ["-f", eventsPath]);
          execFileSync("mkfifo", [eventsPath]);
        }
      },
    });
    expect(replaced.ok).toBe(false);
    if (!replaced.ok) {
      expect(["unsupported", "unsafe-path", "changed"]).toContain(replaced.code);
      expect(replaced.reason.length).toBeLessThanOrEqual(320);
    }
    expect((await lstat(eventsPath)).isFIFO()).toBe(true);
  });

  test("foreign backend or forged completion cannot select paths or trigger I/O", async () => {
    const forged = await capture(
      { runId: "forged", winner: { candidate: "baseline", cwd: "/" } } as unknown as NativeHarnessBackend,
    );
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.code).toBe("source-unavailable");
    expect(matchesNativeHarnessOutputCapture({}, {})).toBe(false);
  });
});
