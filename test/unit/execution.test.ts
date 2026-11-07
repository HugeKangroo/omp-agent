import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXECUTION_LIMITS,
  ExecutionAdapter,
  parseExecutionArguments,
  sandboxProfile,
  type ExecutionToolContext,
} from "../../src/execution-adapter.ts";
import { TaskOwner, type TaskSubject } from "../../src/task-owner.ts";

const WORKSPACE = path.join(tmpdir(), "omp-agent-g2a1-unit-workspace");
const SESSION = "g2a1-session";
const NOW = "2026-11-08T00:00:00.000Z";
const PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";
const BUN = "/Users/joey/.bun/bin/bun";
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
    message: {
      role: "user",
      content: [{ type: "text", text }],
      attribution: "user",
    },
  };
}

function subject(branch: readonly unknown[]): TaskSubject {
  return { sessionId: SESSION, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

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
  fixtures: string;
  alphaPath: string;
  alphaBytes: Buffer;
  owner: TaskOwner;
  branch: readonly Entry[];
  ctx: ExecutionToolContext;
  adapter: ExecutionAdapter;
  runDirs: () => Promise<string[]>;
  cleanup: () => Promise<void>;
}

async function fixture(options: {
  dispatchWallMs?: number;
  terminationGraceMs?: number;
  extraInputs?: Array<{ id: string; path: string }>;
  badInputs?: boolean;
  recordWriter?: (filePath: string, value: unknown) => void;
} = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2a1-unit-")));
  const fixtures = path.join(root, "fixtures");
  await mkdir(fixtures);
  const alphaPath = path.join(fixtures, "alpha.txt");
  const alphaBytes = Buffer.from("authorized alpha input\nsecond line\n", "utf8");
  await writeFile(alphaPath, alphaBytes, { mode: 0o600 });
  const extraInputs = [...(options.extraInputs ?? [])];
  if (options.badInputs === true) {
    const symlinkPath = path.join(fixtures, "symlink.txt");
    const hardlinkPath = path.join(fixtures, "hardlink.txt");
    await symlink(alphaPath, symlinkPath);
    await link(alphaPath, hardlinkPath);
    extraInputs.push({ id: "symlink", path: symlinkPath }, { id: "hardlink", path: hardlinkPath });
  }
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: WORKSPACE,
    ownerId: "owner-g2a1-unit",
    authorizedCapabilities: ["local-script"],
    now: () => NOW,
    id: () => `id-${++sequence}`,
  });
  const branch = [base(), user("user-1", "leaf-1", "Run the local candidate.")];
  const ctx = context(branch, "user-1");
  owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text: "Run the local candidate.",
    observedAt: NOW,
    baseLeafId: "leaf-1",
  });
  owner.observeAgentStart({ sessionId: SESSION, prompt: "Run the local candidate.", reason: "prompt" });
  owner.start(subject(branch), "unit execution");
  const adapter = new ExecutionAdapter(owner, {
    root,
    inputs: [{ id: "alpha", path: alphaPath }, ...extraInputs],
    capabilityId: "local-script",
    id: () => `run-${++sequence}`,
    ...(options.dispatchWallMs === undefined ? {} : { dispatchWallMs: options.dispatchWallMs }),
    ...(options.terminationGraceMs === undefined ? {} : { terminationGraceMs: options.terminationGraceMs }),
    ...(options.recordWriter === undefined ? {} : { recordWriter: options.recordWriter }),
  });
  return {
    root,
    fixtures,
    alphaPath,
    alphaBytes,
    owner,
    branch,
    ctx,
    adapter,
    runDirs: async () => (await readdir(root)).filter((name) => name.startsWith("run-")).sort(),
    cleanup: async () => {
      adapter.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function detailsOf(result: { details?: unknown }): Record<string, any> {
  return result.details as Record<string, any>;
}

const PYTHON_INPUT_ARTIFACT = `
import hashlib, json, os
manifest = json.load(open(os.environ["OMP_INPUTS_MANIFEST"], encoding="utf-8"))
source = open(manifest["handles"]["alpha"]["path"], "rb").read()
digest = hashlib.sha256(source).hexdigest().encode("ascii")
open("computed.txt", "wb").write(digest + b"\\n" + source)
print("python input bytes", len(source))
`;

const BUN_INPUT_ARTIFACT = `
import { cpus } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const manifest = JSON.parse(readFileSync(process.env.OMP_INPUTS_MANIFEST!, "utf8"));
const source = readFileSync(manifest.handles.alpha.path);
const digest = createHash("sha256").update(source).digest("hex");
writeFileSync("computed.txt", digest + "\\n" + source.toString("utf8"));
writeFileSync("cpus.txt", String(cpus().length));
console.log("bun input bytes", source.length);
`;

const SYSCTL_PROBE = `
import ctypes

def sysctl_query(pid, selector):
    libc = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, selector, pid)
    size = ctypes.c_size_t(0)
    ctypes.set_errno(0)
    rc = libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0)
    errno_first = ctypes.get_errno()
    if rc != 0:
        return {"rc": rc, "errno": errno_first}
    buffer = ctypes.create_string_buffer(size.value)
    ctypes.set_errno(0)
    rc = libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0)
    errno_second = ctypes.get_errno()
    if rc != 0:
        return {"rc": rc, "errno": errno_second}
    data = buffer.raw[:size.value]
    return {
        "rc": 0,
        "errno": 0,
        "argvMarker": b"SYNTHETIC_ARGV_MARKER" in data,
        "envMarker": b"SYNTHETIC_ENV_MARKER" in data,
    }
`;

describe("agent_execute argument parsing", () => {
  test("accepts describe and bounded run arguments", () => {
    expect(parseExecutionArguments({ action: "describe" })).toEqual({ action: "describe" });
    expect(parseExecutionArguments({
      action: "run",
      runtime: "python",
      source: "print('x')",
      inputIds: ["alpha"],
      expectedTaskRevision: 1,
    })).toMatchObject({ action: "run", runtime: "python", inputIds: ["alpha"], expectedTaskRevision: 1 });
  });

  test("rejects host authority, paths, environment and duplicate handles", () => {
    const forbidden = [
      { action: "run", runtime: "python", source: "x", expectedTaskRevision: 1, path: "/etc/passwd" },
      { action: "run", runtime: "python", source: "x", expectedTaskRevision: 1, env: { A: "B" } },
      { action: "run", runtime: "python", source: "x", expectedTaskRevision: 1, taskId: "task-1" },
      { action: "run", runtime: "python", source: "x", expectedTaskRevision: 1, interpreter: "/bin/sh" },
      { action: "run", runtime: "python", source: "x", inputIds: ["a", "a"], expectedTaskRevision: 1 },
      { action: "describe", taskId: "task-1" },
    ];
    for (const value of forbidden) expect(() => parseExecutionArguments(value)).toThrow();
  });

  test("source byte limit is enforced before any execution", () => {
    expect(() => parseExecutionArguments({
      action: "run",
      runtime: "python",
      source: "x".repeat(EXECUTION_LIMITS.maxSourceBytes + 1),
      expectedTaskRevision: 1,
    })).toThrow();
  });
});

describe("agent_execute describe", () => {
  test("reports actual runtimes, truthful limits and authorized handles without full paths", async () => {
    const f = await fixture();
    try {
      const result = await f.adapter.describe(f.ctx);
      expect(result.isError).toBeUndefined();
      const details = detailsOf(result);
      expect(details.action).toBe("describe");
      expect(details.taskRevision).toBe(1);
      expect(details.taskAccepted).toBe(false);
      expect(details.runtimes.python.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(details.runtimes.bun.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(details.limits.version).toBe(EXECUTION_LIMITS.version);
      expect(details.limits.maxInputs).toBe(8);
      expect(details.limits.dispatchWallMs).toBe(EXECUTION_LIMITS.dispatchWallMs);
      expect(details.authorizedInputs).toEqual([
        expect.objectContaining({ id: "alpha", name: "alpha.txt", available: true }),
      ]);
      expect(JSON.stringify(details)).not.toContain(f.fixtures);
    } finally {
      await f.cleanup();
    }
  });

  test("returned runtime facts are detached from later describe and actual run evidence", async () => {
    const f = await fixture();
    try {
      const first = await f.adapter.describe(f.ctx);
      const original = detailsOf(first).runtimes.python.version;
      expect(original).toMatch(/^\d+\.\d+\.\d+$/);
      detailsOf(first).runtimes.python.version = "FORGED-VERSION";
      detailsOf(first).runtimes.python.executable = "forged-python";

      const fresh = await f.adapter.describe(f.ctx);
      expect(detailsOf(fresh).runtimes.python.version).toBe(original);
      expect(detailsOf(fresh).runtimes.python.executable).not.toBe("forged-python");

      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('trusted runtime remains')",
        inputIds: [],
        expectedTaskRevision: 1,
      });
      expect(result.isError).toBeUndefined();
      expect(detailsOf(result).runtimeVersion).toBe(original);
      const record = JSON.parse(await readFile(path.join(f.root, String(detailsOf(result).hostRecordRef)), "utf8"));
      expect(record.runtimeVersion).toBe(original);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("describe withholds task and input metadata when the binding detaches during inspection", async () => {
    const f = await fixture();
    try {
      const pending = f.adapter.describe(f.ctx);
      f.owner.navigate("session_tree", SESSION);
      const result = await pending;
      expect(result.isError === true || (detailsOf(result).authorizedInputs === undefined)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(f.fixtures);
      expect(JSON.stringify(result)).not.toContain("alpha.txt");
    } finally {
      await f.cleanup();
    }
  });
});

describe("generic Python and Bun execution", () => {
  test("Python reads the authorized input and writes a host-verifiable artifact", async () => {
    const f = await fixture();
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: PYTHON_INPUT_ARTIFACT,
        inputIds: ["alpha"],
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(result.isError).toBeUndefined();
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.dispatch.spawned).toBe(true);
      expect(details.dispatch.pid).toBeNumber();
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.taskAccepted).toBe(false);
      const artifact = details.artifacts.find((item: any) => item.relativePath === "computed.txt");
      expect(artifact).toBeTruthy();
      const archived = await readFile(path.join(f.root, artifact.archiveRef));
      expect(sha256(archived)).toBe(artifact.sha256);
      expect(archived.toString("utf8")).toBe(`${sha256(f.alphaBytes).slice(7)}\n${f.alphaBytes.toString("utf8")}`);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("Bun reads the same authorized input and writes an independently verified artifact", async () => {
    const f = await fixture();
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "bun",
        source: BUN_INPUT_ARTIFACT,
        inputIds: ["alpha"],
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(result.isError).toBeUndefined();
      expect(details.dispatch.exitCode).toBe(0);
      const artifact = details.artifacts.find((item: any) => item.relativePath === "computed.txt");
      expect(artifact).toBeTruthy();
      const archived = await readFile(path.join(f.root, artifact.archiveRef));
      expect(sha256(archived)).toBe(artifact.sha256);
      expect(archived.toString("utf8")).toContain(sha256(f.alphaBytes).slice(7));
      const cpus = details.artifacts.find((item: any) => item.relativePath === "cpus.txt");
      expect(cpus).toBeTruthy();
      expect(Number(await readFile(path.join(f.root, cpus.archiveRef), "utf8"))).toBeGreaterThan(0);
    } finally {
      await f.cleanup();
    }
  }, 20_000);
});

describe("admission and concurrency boundaries", () => {
  test("unauthorized input, stale revision and pre-aborted calls never spawn", async () => {
    const f = await fixture();
    try {
      const unauthorized = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('never')",
        inputIds: ["not-authorized"],
        expectedTaskRevision: 1,
      });
      expect(unauthorized.isError).toBe(true);

      const stale = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('never')",
        inputIds: [],
        expectedTaskRevision: 99,
      });
      expect(stale.isError).toBe(true);

      const controller = new AbortController();
      controller.abort();
      const aborted = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('never')",
        inputIds: [],
        expectedTaskRevision: 1,
      }, controller.signal);
      expect(aborted.isError).toBe(true);
      expect((await f.runDirs())).toEqual([]);
      expect(f.owner.snapshot().currentTask?.admissions).toBe(0);
      expect(f.owner.snapshot().currentTask?.taskRevision).toBe(1);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("initial symlink and multilink inputs are rejected before any spawn", async () => {
    const f = await fixture({ badInputs: true });
    try {
      for (const inputId of ["symlink", "hardlink"]) {
        const result = await f.adapter.run(f.ctx, {
          action: "run",
          runtime: "python",
          source: "print('never')",
          inputIds: [inputId],
          expectedTaskRevision: 1,
        });
        expect(result.isError).toBe(true);
        expect(String(detailsOf(result).error)).toMatch(/symbolic link|hard links/);
      }
      expect(await f.runDirs()).toEqual([]);
      expect((await readFile(f.alphaPath)).toString("base64")).toBe(f.alphaBytes.toString("base64"));
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("dispose from the prepared-record host callback prevents spawn and records not_dispatched", async () => {
    let adapter: ExecutionAdapter | undefined;
    const f = await fixture({
      recordWriter: (filePath, value) => {
        writeFileSync(filePath, JSON.stringify(value));
        if ((value as { phase?: unknown }).phase === "prepared") adapter?.dispose();
      },
    });
    adapter = f.adapter;
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "open('did-run.txt', 'w').write('side effect')\nprint('must not run')\n",
        inputIds: [],
        expectedTaskRevision: 1,
      });
      expect(result.isError).toBe(true);
      expect(detailsOf(result).dispatch).toBeUndefined();
      const dirs = await f.runDirs();
      expect(dirs.length).toBe(1);
      const record = JSON.parse(await readFile(path.join(f.root, dirs[0]!, "record.json"), "utf8"));
      expect(record.phase).toBe("not_dispatched");
      expect(record.process).toBeNull();
      expect(record.dispatch).toMatchObject({ spawned: false, pid: null, reason: "not_dispatched" });
      expect(String(record.notDispatchedReason)).toContain("disposed");
      expect(await readdir(path.join(f.root, dirs[0]!, "work"))).toEqual(["tmp"]);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("two concurrent calls yield one busy rejection, one actual spawn and no double budget", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const source = "import time\ntime.sleep(0.4)\nprint('slow done')\n";
      const args = {
        action: "run" as const,
        runtime: "python" as const,
        source,
        inputIds: [],
        expectedTaskRevision: 1,
      };
      const first = f.adapter.run(f.ctx, args);
      const second = f.adapter.run(f.ctx, args);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(secondResult.isError).toBe(true);
      expect(String(detailsOf(secondResult).error)).toContain("already active");
      const details = detailsOf(firstResult);
      expect(details.dispatch.spawned).toBe(true);
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.attemptBudget).toMatchObject({ attempted: 1, dispatched: 1, reserved: 0 });
      expect(f.owner.snapshot().currentTask?.admissions).toBe(1);
      expect((await f.runDirs()).length).toBe(1);
      const describe = detailsOf(await f.adapter.describe(f.ctx));
      expect(describe.dispatchBudget).toMatchObject({ attempted: 1, dispatched: 1 });
    } finally {
      await f.cleanup();
    }
  }, 20_000);
});

describe("actual OS sandbox controls", () => {
  test("outside read/write, network, fork, hardlink and external signal are denied; own output works", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "omp-agent-g2a1-outside-"));
    const outsideFile = path.join(outsideDir, "outside.txt");
    await writeFile(outsideFile, "outside artificial content\n");
    const dummy = spawn(PYTHON, ["-I", "-B", "-c", "import time\ntime.sleep(20)", "SYNTHETIC_ARGV_MARKER"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, OMP_SYSCTL_DUMMY_ENV: "SYNTHETIC_ENV_MARKER" },
    });
    let accepted = 0;
    const server = createServer((socket) => {
      accepted += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const metaPath = path.join(outsideDir, "meta.json");
    await writeFile(metaPath, JSON.stringify({
      outside: outsideFile,
      port,
      dummyPid: dummy.pid,
    }));
    await Bun.sleep(150);
    const f = await fixture({ extraInputs: [{ id: "meta", path: metaPath }] });
    const previousSecret = process.env.OMP_TEST_SECRET;
    process.env.OMP_TEST_SECRET = "ARTIFICIAL_SECRET_MUST_NOT_LEAK";
    try {
      const source = `
import json, os, socket, threading
${SYSCTL_PROBE}
manifest = json.load(open(os.environ["OMP_INPUTS_MANIFEST"], encoding="utf-8"))
meta = json.load(open(manifest["handles"]["meta"]["path"], encoding="utf-8"))
report = {}
report["sysctl_external"] = {
    str(selector): sysctl_query(int(meta["dummyPid"]), selector) for selector in (38, 49)
}
report["sysctl_self"] = {
    str(selector): sysctl_query(os.getpid(), selector) for selector in (38, 49)
}
try:
    open(meta["outside"], "rb").read()
    report["outside_read"] = "allowed"
except OSError as error:
    report["outside_read"] = error.errno
try:
    with open(meta["outside"], "wb") as handle:
        handle.write(b"attack")
    report["outside_write"] = "allowed"
except OSError as error:
    report["outside_write"] = error.errno
try:
    socket.create_connection(("127.0.0.1", meta["port"]), 0.3)
    report["network"] = "allowed"
except OSError as error:
    report["network"] = error.errno
try:
    os.fork()
    report["fork"] = "allowed"
except OSError as error:
    report["fork"] = error.errno
try:
    os.posix_spawn("/bin/echo", ["echo", "x"], {})
    report["posix_spawn"] = "allowed"
except OSError as error:
    report["posix_spawn"] = error.errno
try:
    import subprocess
    subprocess.Popen(["/bin/echo", "x"], start_new_session=True)
    report["detached_spawn"] = "allowed"
except OSError as error:
    report["detached_spawn"] = error.errno
try:
    os.link("own.txt", "link.txt")
    report["hardlink"] = "allowed"
except OSError as error:
    report["hardlink"] = error.errno
try:
    os.kill(meta["dummyPid"], 30)
    report["signal"] = "allowed"
except OSError as error:
    report["signal"] = error.errno
try:
    os.fstat(6000)
    report["fd6000"] = "open"
except OSError as error:
    report["fd6000"] = error.errno
report["secret"] = os.environ.get("OMP_TEST_SECRET", "<absent>")
thread_totals = []
def worker():
    thread_totals.append(sum(range(1000)))
workers = [threading.Thread(target=worker) for _ in range(8)]
for worker_thread in workers:
    worker_thread.start()
for worker_thread in workers:
    worker_thread.join()
report["threads"] = sum(thread_totals)
with open(os.path.join(os.environ["OMP_WORK_DIR"], "report.json"), "w", encoding="utf-8") as handle:
    json.dump(report, handle)
with open("own.txt", "w", encoding="utf-8") as handle:
    handle.write("own output works")
`;
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source,
        inputIds: ["meta"],
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      const artifact = details.artifacts.find((item: any) => item.relativePath === "report.json");
      expect(artifact).toBeTruthy();
      const report = JSON.parse(await readFile(path.join(f.root, artifact.archiveRef), "utf8"));
      expect(report.outside_read).not.toBe("allowed");
      expect(report.outside_write).not.toBe("allowed");
      expect(report.network).not.toBe("allowed");
      expect(report.fork).not.toBe("allowed");
      expect(report.posix_spawn).not.toBe("allowed");
      expect(report.detached_spawn).not.toBe("allowed");
      expect(report.hardlink).not.toBe("allowed");
      expect(report.signal).not.toBe("allowed");
      expect(() => process.kill(dummy.pid!, 0)).not.toThrow();
      expect(report.fd6000).not.toBe("open");
      expect(report.secret).toBe("<absent>");
      expect(report.threads).toBe(8 * 499500);
      for (const selector of ["38", "49"]) {
        const external = report.sysctl_external[selector];
        expect(external.rc).toBe(-1);
        expect(external.errno).toBe(1);
        expect(external.argvMarker).toBeUndefined();
        expect(external.envMarker).toBeUndefined();
        // The runtime's own process-info exception remains available.
        expect(report.sysctl_self[selector].rc).toBe(0);
      }
      // Unsandboxed positive control against the same artificial dummy proves
      // the syscall is functional on this host, not merely denied by a broken
      // probe. Only the known dummy PID and synthetic markers are touched.
      const positive = spawnSync(PYTHON, [
        "-I", "-B", "-c",
        `${SYSCTL_PROBE}\nimport json, sys\nprint(json.dumps({str(selector): sysctl_query(int(sys.argv[1]), selector) for selector in (38, 49)}))`,
        String(dummy.pid),
      ], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 });
      expect(positive.status, positive.stderr).toBe(0);
      const positiveReport = JSON.parse(positive.stdout);
      for (const selector of ["38", "49"]) {
        expect(positiveReport[selector].rc).toBe(0);
        expect(positiveReport[selector].argvMarker).toBe(true);
        expect(positiveReport[selector].envMarker).toBe(true);
      }
      expect(accepted).toBe(0);
      const own = details.artifacts.find((item: any) => item.relativePath === "own.txt");
      expect(own).toBeTruthy();
      expect(await readFile(path.join(f.root, own.archiveRef), "utf8")).toBe("own output works");
      expect(await readFile(outsideFile, "utf8")).toBe("outside artificial content\n");
    } finally {
      if (previousSecret === undefined) delete process.env.OMP_TEST_SECRET;
      else process.env.OMP_TEST_SECRET = previousSecret;
      server.close();
      if (dummy.pid) {
        try { process.kill(-dummy.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await f.cleanup();
      await rm(outsideDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("limits, cancellation and evidence", () => {
  test("timeout kills an ignore-SIGTERM process group and reports the reason honestly", async () => {
    const f = await fixture({ dispatchWallMs: 300, terminationGraceMs: 100 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import signal, time\nsignal.signal(signal.SIGTERM, lambda *args: None)\ntime.sleep(20)\n",
        inputIds: [],
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(result.isError).toBe(true);
      expect(details.dispatch.reason).toBe("timeout");
      expect(details.dispatch.terminatedByHost).toBe(true);
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.dispatch.durationMs).toBeLessThan(5000);
      expect(() => process.kill(details.dispatch.pid, 0)).toThrow();
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("output flood is bounded, explicitly truncated and terminates the process", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import os, time\nos.write(1, b'x' * 200000)\ntime.sleep(5)\n",
        inputIds: [],
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.output.truncated).toBe(true);
      expect(details.output.retainedBytes).toBe(EXECUTION_LIMITS.maxRetainedOutputBytes);
      expect(details.output.observedBytes).toBeGreaterThan(EXECUTION_LIMITS.maxRetainedOutputBytes);
      expect(details.dispatch.reason).toBe("output_limit");
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.output.text.length).toBeLessThanOrEqual(4096);
      expect(details.output.omittedFromResponseBytes).toBeGreaterThan(0);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("RLIMIT_FSIZE soft and hard both cap writes at 256 KiB", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: `
import json, resource
report = {}
try:
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
    report["raised"] = "allowed"
except (OSError, ValueError) as error:
    report["raised"] = getattr(error, "errno", None)
soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
report["soft"] = soft
report["hard"] = hard
try:
    with open("big.bin", "wb") as handle:
        handle.write(b"x" * (300 * 1024))
    report["write"] = "allowed"
except OSError as error:
    report["write"] = error.errno
with open("fsize.json", "w", encoding="utf-8") as handle:
    json.dump(report, handle)
`,
        inputIds: [],
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.dispatch.exitCode).toBe(0);
      const artifact = details.artifacts.find((item: any) => item.relativePath === "fsize.json");
      expect(artifact).toBeTruthy();
      const report = JSON.parse(await readFile(path.join(f.root, artifact.archiveRef), "utf8"));
      expect(report.raised).not.toBe("allowed");
      expect(report.soft).toBe(EXECUTION_LIMITS.maxFileSizeBytes);
      expect(report.hard).toBe(EXECUTION_LIMITS.maxFileSizeBytes);
      expect(report.write).toBe(27);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("untrusted exit code 111 is reported as an uncertain launch stage, not as proof no code ran", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "open('marker.txt', 'w', encoding='utf-8').write('untrusted-code-ran')\nimport sys\nsys.exit(111)\n",
        inputIds: [],
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.dispatch.exitCode).toBe(111);
      expect(details.dispatch.launchStage).toBe("unknown");
      expect(details.dispatch.launchStageNote).toContain("not proof");
      expect(result.isError).toBe(true);
      const marker = details.artifacts.find((item: any) => item.relativePath === "marker.txt");
      expect(marker).toBeTruthy();
      expect(await readFile(path.join(f.root, marker.archiveRef), "utf8")).toBe("untrusted-code-ran");
      expect(String(details.error ?? "")).not.toContain("no process was started");
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("a host record failure after spawn still terminates the owned process and keeps actual facts", async () => {
    let writes = 0;
    const f = await fixture({
      dispatchWallMs: 5000,
      terminationGraceMs: 100,
      recordWriter: (filePath, value) => {
        writes += 1;
        if (writes >= 2) throw new Error("injected record fault");
        writeFileSync(filePath, JSON.stringify(value));
      },
    });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "import time\ntime.sleep(10)\n",
        inputIds: [],
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(result.isError).toBe(true);
      expect(details.dispatch.spawned).toBe(true);
      expect(details.dispatch.pid).toBeNumber();
      expect(details.dispatch.reason).toBe("host_record_failure");
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(String(details.hostRecordErrors.afterSpawn)).toContain("injected record fault");
      expect(String(details.hostRecordErrors.finalRecord)).toContain("injected record fault");
      expect(writes).toBe(3);
      expect(() => process.kill(details.dispatch.pid, 0)).toThrow();
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("artifact total byte cap rejects the next oversize file without reading it", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: `
for index in range(8):
    with open("big%d.bin" % index, "wb") as handle:
        handle.write(b"x" * 150000)
`,
        inputIds: [],
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.artifactLimitReached).toBe(true);
      expect(details.artifacts.length).toBe(6);
      expect(details.artifactTotalBytes).toBeLessThanOrEqual(EXECUTION_LIMITS.maxArtifactTotalBytes);
      expect(details.artifactRejections.some((item: any) => item.reason.includes("total byte limit"))).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("artifact export is bounded to top-level ordinary files and rejects directories and FIFOs", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: `
import os
for index in range(10):
    with open("f%d.txt" % index, "w", encoding="utf-8") as handle:
        handle.write(str(index))
os.mkdir("subdir")
with open("subdir/nested.txt", "w", encoding="utf-8") as handle:
    handle.write("nested")
os.mkfifo("pipe")
try:
    os.symlink("/etc/passwd", "link.txt")
except OSError:
    pass
`,
        inputIds: [],
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(details.dispatch.exitCode).toBe(0);
      expect(details.artifacts.length).toBe(EXECUTION_LIMITS.maxArtifacts);
      expect(details.artifactRejections.some((item: any) => item.reason.includes("subdirectories"))).toBe(true);
      expect(details.artifactRejections.some((item: any) => item.reason.includes("FIFO"))).toBe(true);
      expect(details.artifactRejections.some((item: any) => item.reason.includes("hard links") || item.reason.includes("symbolic link"))).toBe(true);
      expect(details.artifactRejections.some((item: any) => item.reason.includes("artifact count"))).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("escaped adversarial artifact names trim only the response window and stay full in the host record", async () => {
    const f = await fixture({ dispatchWallMs: 5000 });
    try {
      const source = `
for index in range(260):
    with open(chr(1) * 200 + str(index) + ".txt", "w", encoding="utf-8") as handle:
        handle.write("x")
print("completed candidate artifacts")
`;
      const result = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source,
        inputIds: [],
        expectedTaskRevision: 1,
      });
      const details = detailsOf(result);
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(EXECUTION_LIMITS.maxToolResponseBytes);
      expect(details.runId).toBeString();
      expect(details.dispatch.spawned).toBe(true);
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.taskAccepted).toBe(false);
      expect(details.hostRecordRef).toBeString();
      expect(details.artifactRejectionsShown).toBe(8);
      expect(details.artifactRejections.length).toBe(8);
      expect(details.artifactRejectionsOmitted).toBeGreaterThan(200);
      expect(details.artifactRejectionsRecordRef).toBe(details.hostRecordRef);
      expect(details.artifactRejections.every((item: any) => item.relativePath.startsWith("\u0001".repeat(200)))).toBe(true);

      const record = JSON.parse(await readFile(path.join(f.root, String(details.hostRecordRef)), "utf8"));
      expect(record.phase).toBe("completed");
      expect(record.artifactRejections.length).toBe(248);
      expect(details.artifactRejectionsShown + details.artifactRejectionsOmitted).toBe(record.artifactRejections.length);
      const rejected = record.artifactRejections.find((item: any) => item.reason === "artifact count limit");
      expect(rejected).toBeTruthy();
      expect(rejected.relativePath.startsWith("\u0001".repeat(200))).toBe(true);
      expect(rejected.relativePath.endsWith(".txt")).toBe(true);
      expect(record.artifacts.length).toBe(EXECUTION_LIMITS.maxArtifacts);
      expect(record.artifacts.every((item: any) => item.relativePath.startsWith("\u0001".repeat(200)))).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 20_000);
});

describe("owner authority changes during a run", () => {
  const LONG = "import time\ntime.sleep(0.6)\nopen('late.txt','w').write('late output')\n";

  test("a genuine cancel stops the running child and keeps the result at revision 1 with no restored authority", async () => {
    const f = await fixture({ dispatchWallMs: 5000, terminationGraceMs: 100 });
    try {
      const running = f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: LONG,
        inputIds: [],
        expectedTaskRevision: 1,
      });
      await Bun.sleep(150);
      f.owner.cancel(subject(f.branch));
      const result = await running;
      const details = detailsOf(result);
      expect(details.taskRevision).toBe(1);
      expect(details.dispatch.reason).toBe("owner_cancelled");
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(f.owner.snapshot().currentTask?.status).toBe("cancelled");
      const admissions = f.owner.snapshot().currentTask?.admissions;
      const after = await f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: "print('no')",
        inputIds: [],
        expectedTaskRevision: 1,
      });
      expect(after.isError).toBe(true);
      expect(f.owner.snapshot().currentTask?.admissions).toBe(admissions);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("a genuine revision conservatively stops the old run and withholds its output", async () => {
    const f = await fixture({ dispatchWallMs: 5000, terminationGraceMs: 100 });
    try {
      const running = f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: LONG,
        inputIds: [],
        expectedTaskRevision: 1,
      });
      await Bun.sleep(150);
      f.owner.sessionChanged();
      const amended = "Amend the requirements with a second genuine turn.";
      expect(f.owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: WORKSPACE,
        source: "rpc",
        text: amended,
        observedAt: NOW,
        baseLeafId: "user-1",
      }).accepted).toBe(true);
      f.owner.observeAgentStart({ sessionId: SESSION, prompt: amended, reason: "prompt" });
      const branch2 = [...f.branch, user("user-2", "user-1", amended)];
      expect(f.owner.revise(subject(branch2), "amended understanding").revised).toBe(true);
      const result = await running;
      const details = detailsOf(result);
      expect(details.taskRevision).toBe(1);
      expect(details.dispatch.reason).toBe("task_revised");
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.artifactsWithheld).toBe(true);
      expect(details.artifacts).toEqual([]);
      expect(f.owner.snapshot().currentTask?.taskRevision).toBe(2);
    } finally {
      await f.cleanup();
    }
  }, 20_000);

  test("navigation detach stops the child and withholds output", async () => {
    const f = await fixture({ dispatchWallMs: 5000, terminationGraceMs: 100 });
    try {
      const running = f.adapter.run(f.ctx, {
        action: "run",
        runtime: "python",
        source: LONG,
        inputIds: [],
        expectedTaskRevision: 1,
      });
      await Bun.sleep(150);
      f.owner.navigate("session_switch", SESSION);
      const result = await running;
      const details = detailsOf(result);
      expect(details.dispatch.reason).toBe("binding_detached");
      expect(details.dispatch.processGroupVerifiedGone).toBe(true);
      expect(details.bindingAfter.state).toBe("detached");
      expect(details.artifactsWithheld).toBe(true);
      expect(details.withheldReason).toContain("host record");
    } finally {
      await f.cleanup();
    }
  }, 20_000);
});

describe("trusted launcher descriptor boundary", () => {
  test("an inherited descriptor 6000 does not survive into the sandbox", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g2a1-fd-")));
    try {
      const sourceRoot = path.join(root, "source");
      const inputRoot = path.join(root, "inputs");
      const workRoot = path.join(root, "work");
      await mkdir(sourceRoot);
      await mkdir(inputRoot);
      await mkdir(workRoot);
      const script = path.join(sourceRoot, "script.py");
      await writeFile(script, `
import json, os
report = {}
try:
    os.fstat(6000)
    report["fd6000"] = "open"
except OSError as error:
    report["fd6000"] = error.errno
with open(os.path.join(os.environ["OMP_WORK_DIR"], "fd-report.json"), "w", encoding="utf-8") as handle:
    json.dump(report, handle)
`);
      const interpreter = await realpath(PYTHON);
      const profile = path.join(root, "profile.sb");
      await writeFile(profile, sandboxProfile({ interpreterPath: interpreter, sourceRoot, inputRoot, workRoot }));
      const parentCode = `
import os, sys
os.dup2(0, 6000)
os.set_inheritable(6000, True)
os.execv(sys.executable, [sys.executable, "-I", "-B", sys.argv[1], "--profile", sys.argv[2], "--fsize", "262144", "--", sys.argv[3], sys.argv[4]])
`;
      const child = spawn(PYTHON, [
        "-I", "-B", "-c", parentCode, LAUNCHER, profile, interpreter, script,
      ], {
        detached: true,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          OMP_WORK_DIR: workRoot,
          OMP_INPUTS_MANIFEST: path.join(inputRoot, "manifest.json"),
        },
        stdio: "ignore",
      });
      const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(exitCode).toBe(0);
      const report = JSON.parse(await readFile(path.join(workRoot, "fd-report.json"), "utf8"));
      expect(report.fd6000).not.toBe("open");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
