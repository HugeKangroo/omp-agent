import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_HARNESS_WORKSPACE_LIMITS,
  NativeHarnessWorkspaceError,
  prepareNativeHarnessWorkspace,
  type NativeHarnessWorkspaceDescriptor,
  type NativeHarnessWorkspaceFailureCode,
  type NativeHarnessWorkspaceHostConfig,
  type NativeHarnessWorkspaceTestPorts,
} from "../../src/native-harness-workspace.ts";

const bases: string[] = [];

afterEach(async () => {
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

interface Fixture {
  readonly base: string;
  readonly source: string;
  readonly storage: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "omp-g5b-")));
  bases.push(base);
  await chmod(base, 0o700);
  const source = path.join(base, "source");
  const storage = path.join(base, "storage");
  await mkdir(source, { mode: 0o755 });
  await chmod(source, 0o755);
  await mkdir(storage, { mode: 0o700 });
  await chmod(storage, 0o700);
  return { base, source, storage };
}

async function writeSource(
  source: string,
  relativePath: string,
  content: string | Uint8Array,
  mode = 0o644,
): Promise<void> {
  const absolute = path.join(source, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  await writeFile(absolute, content);
  await chmod(absolute, mode);
}

function config(
  sourceRoot: string,
  storageRoot: string,
  inputFiles: readonly string[],
): NativeHarnessWorkspaceHostConfig {
  return { sourceRoot, storageRoot, inputFiles };
}

function noopGuard(): void {
  // The normal-path guard admits every effect.
}

async function expectFailure(
  operation: Promise<unknown>,
  code: NativeHarnessWorkspaceFailureCode,
): Promise<NativeHarnessWorkspaceError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(NativeHarnessWorkspaceError);
    const failure = error as NativeHarnessWorkspaceError;
    expect(failure.code).toBe(code);
    expect(failure.message.length).toBeLessThanOrEqual(512);
    return failure;
  }
  throw new Error(`expected ${code} failure`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function modeOf(target: string): Promise<number> {
  return (await lstat(target)).mode & 0o777;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectedContentDigest(descriptor: NativeHarnessWorkspaceDescriptor): string {
  return sha256(JSON.stringify(descriptor.inputManifest.map((entry) => [
    entry.relativePath,
    entry.bytes,
    entry.sha256,
  ])));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForPidGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} did not exit`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function makeExecutable(directory: string, name: string, body: string): Promise<string> {
  const target = path.join(directory, name);
  await writeFile(target, body);
  await chmod(target, 0o700);
  return target;
}

function gitRootOf(workspaceRoot: string): string {
  const result = spawnSync("/usr/bin/git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  expect(result.status).toBe(0);
  return (result.stdout ?? "").trim();
}

describe("native harness private workspace", () => {
  test("stages exact selected bytes, prepares a private Git root and avoids source mutation", async () => {
    const { source, storage } = await makeFixture();
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("héllo 🌍\r\nsecond\r\n", "utf8"),
    ]);
    await writeSource(source, "docs/α.txt", bom, 0o644);
    await writeSource(source, "notes/second.md", "plain\n", 0o600);
    await writeSource(source, "unselected.txt", "must not be copied\n");
    const sourceMode = await modeOf(path.join(source, "docs/α.txt"));
    const controller = new AbortController();

    const descriptor = await prepareNativeHarnessWorkspace(
      config(source, storage, ["docs/α.txt", "notes/second.md"]),
      noopGuard,
      controller.signal,
    );

    expect(descriptor.schema).toBe("omp-agent.native-harness-workspace.v1");
    expect(descriptor.sourceRoot).toBe(source);
    expect(descriptor.gitInitialized).toBe(true);
    expect(path.dirname(descriptor.preparedRoot)).toBe(storage);
    expect(path.dirname(descriptor.workspaceRoot)).toBe(descriptor.preparedRoot);
    expect(path.dirname(descriptor.storeRoot)).toBe(descriptor.preparedRoot);
    expect(descriptor.workspaceRoot).not.toBe(descriptor.storeRoot);
    expect(await modeOf(descriptor.preparedRoot)).toBe(0o700);
    expect(await modeOf(descriptor.workspaceRoot)).toBe(0o700);
    expect(await modeOf(descriptor.storeRoot)).toBe(0o700);
    expect(await readdir(descriptor.storeRoot)).toEqual([]);

    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.inputManifest)).toBe(true);
    expect(descriptor.inputManifest.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(Object.isFrozen(descriptor.limitations)).toBe(true);
    expect("destroy" in descriptor).toBe(false);

    const stagedBom = await readFile(path.join(descriptor.workspaceRoot, "docs/α.txt"));
    expect(Buffer.compare(stagedBom, bom)).toBe(0);
    expect(await readFile(path.join(descriptor.workspaceRoot, "notes/second.md"), "utf8")).toBe("plain\n");
    expect(await modeOf(path.join(descriptor.workspaceRoot, "docs/α.txt"))).toBe(0o600);
    expect(await modeOf(path.join(descriptor.workspaceRoot, "notes/second.md"))).toBe(0o600);
    expect(await modeOf(path.join(descriptor.workspaceRoot, "docs"))).toBe(0o700);
    expect(await exists(path.join(descriptor.workspaceRoot, "unselected.txt"))).toBe(false);
    expect(await exists(path.join(descriptor.storeRoot, "unselected.txt"))).toBe(false);

    const gitTop = gitRootOf(descriptor.workspaceRoot);
    expect(await realpath(gitTop)).toBe(descriptor.workspaceRoot);
    expect((await lstat(path.join(descriptor.workspaceRoot, ".git"))).isDirectory()).toBe(true);

    expect(descriptor.inputManifest.map((entry) => entry.relativePath)).toEqual([
      "docs/α.txt",
      "notes/second.md",
    ]);
    const byPath = new Map(descriptor.inputManifest.map((entry) => [entry.relativePath, entry]));
    expect(byPath.get("docs/α.txt")).toEqual({
      relativePath: "docs/α.txt",
      bytes: bom.length,
      sha256: sha256(bom),
      observedAt: expect.any(Number),
    });
    expect(byPath.get("notes/second.md")?.bytes).toBe(6);
    expect(byPath.get("notes/second.md")?.sha256).toBe(sha256("plain\n"));
    expect(/^[0-9a-f]{64}$/.test(descriptor.manifestSha256)).toBe(true);
    expect(descriptor.manifestSha256).toBe(expectedContentDigest(descriptor));

    // The source is read, not modified; its ordinary project mode is retained.
    expect(Buffer.compare(await readFile(path.join(source, "docs/α.txt")), bom)).toBe(0);
    expect(await modeOf(path.join(source, "docs/α.txt"))).toBe(sourceMode);
    expect(await readFile(path.join(source, "unselected.txt"), "utf8")).toBe("must not be copied\n");

    const second = await prepareNativeHarnessWorkspace(
      config(source, storage, ["docs/α.txt", "notes/second.md"]),
      noopGuard,
      new AbortController().signal,
    );
    expect(second.preparedRoot).not.toBe(descriptor.preparedRoot);
    expect(second.manifestSha256).toBe(descriptor.manifestSha256);
    expect(await readdir(second.storeRoot)).toEqual([]);
  });

  test("rejects malformed host config without running accessors", async () => {
    const { source, storage } = await makeFixture();
    let getterCalls = 0;

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "sourceRoot", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return source;
      },
    });
    Object.defineProperty(accessor, "storageRoot", { enumerable: true, value: storage });
    Object.defineProperty(accessor, "inputFiles", { enumerable: true, value: ["a.txt"] });
    await expectFailure(
      prepareNativeHarnessWorkspace(
        accessor as unknown as NativeHarnessWorkspaceHostConfig,
        noopGuard,
        new AbortController().signal,
      ),
      "invalid-config",
    );
    expect(getterCalls).toBe(0);

    const inputArray = ["a.txt"];
    Object.defineProperty(inputArray, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "a.txt";
      },
    });
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, inputArray),
        noopGuard,
        new AbortController().signal,
      ),
      "invalid-config",
    );
    expect(getterCalls).toBe(0);

    const inherited = Object.create({ sourceRoot: source, storageRoot: storage, inputFiles: ["a.txt"] });
    const extra = { sourceRoot: source, storageRoot: storage, inputFiles: ["a.txt"], extra: true };
    const symbol = { sourceRoot: source, storageRoot: storage, inputFiles: ["a.txt"] };
    Object.defineProperty(symbol, Symbol("extra"), { value: true, enumerable: true });
    const sparse = ["a.txt", , "b.txt"];
    const arrayExtra = ["a.txt"] as string[] & { extra?: boolean };
    arrayExtra.extra = true;

    for (const malformed of [null, [], inherited, extra, symbol]) {
      await expectFailure(
        prepareNativeHarnessWorkspace(
          malformed as unknown as NativeHarnessWorkspaceHostConfig,
          noopGuard,
          new AbortController().signal,
        ),
        "invalid-config",
      );
    }
    for (const inputFiles of [
      [] as string[],
      ["a.txt", "a.txt"],
      ["../a.txt"],
      ["a\\b.txt"],
      ["/etc/passwd"],
      ["a//b.txt"],
      ["./a.txt"],
      [".git/config"],
      [".env"],
      [".ssh/id_rsa"],
      ["node_modules/pkg/index.js"],
      ["src/AGENTS.md"],
      ["credentials.json"],
      ["secrets.yaml"],
      ["key.pem"],
    ]) {
      await expectFailure(
        prepareNativeHarnessWorkspace(
          config(source, storage, inputFiles),
          noopGuard,
          new AbortController().signal,
        ),
        inputFiles.length === 2 && inputFiles[0] === "a.txt" ? "duplicate-input" : (
          [".git/config", ".env", ".ssh/id_rsa", "node_modules/pkg/index.js", "src/AGENTS.md", "credentials.json", "secrets.yaml", "key.pem"].includes(inputFiles[0] ?? "")
            ? "reserved-input"
            : "invalid-config"
        ),
      );
    }
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, sparse as unknown as string[]),
        noopGuard,
        new AbortController().signal,
      ),
      "invalid-config",
    );
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, arrayExtra),
        noopGuard,
        new AbortController().signal,
      ),
      "invalid-config",
    );

    const nine = Array.from({ length: 9 }, (_, index) => `f${index}.txt`);
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, nine),
        noopGuard,
        new AbortController().signal,
      ),
      "invalid-config",
    );
    expect(await readdir(storage)).toEqual([]);
  });

  test("rejects selected .gitignore paths so Git excludes cannot hide a selected file", async () => {
    const { source, storage } = await makeFixture();
    await writeSource(source, ".gitignore", "a.txt\n");
    await writeSource(source, "a.txt", "a\n");
    await writeSource(source, "nested/.gitignore", "*.log\n");
    await writeSource(source, "nested/keep.txt", "keep\n");
    for (const inputFiles of [[".gitignore"], [".gitignore", "a.txt"], ["nested/.gitignore"]]) {
      await expectFailure(
        prepareNativeHarnessWorkspace(
          config(source, storage, inputFiles),
          noopGuard,
          new AbortController().signal,
        ),
        "reserved-input",
      );
    }
    expect(await readdir(storage)).toEqual([]);
    expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("a\n");
  });

  test("accepts eight small files and enforces per-file and aggregate byte limits", async () => {
    const { base, source, storage } = await makeFixture();
    const eight = Array.from({ length: 8 }, (_, index) => `f${index}.txt`);
    for (const name of eight) await writeSource(source, name, `${name}\n`);
    const descriptor = await prepareNativeHarnessWorkspace(
      config(source, storage, eight),
      noopGuard,
      new AbortController().signal,
    );
    expect(descriptor.inputManifest).toHaveLength(8);
    expect(await readdir(descriptor.storeRoot)).toEqual([]);

    const failureStorage = path.join(base, "storage-fail");
    await mkdir(failureStorage, { mode: 0o700 });
    await chmod(failureStorage, 0o700);

    const nine = [...eight, "f8.txt"];
    await writeSource(source, "f8.txt", "f8\n");
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, failureStorage, nine),
        noopGuard,
        new AbortController().signal,
      ),
      "invalid-config",
    );

    const oversized = Buffer.alloc(NATIVE_HARNESS_WORKSPACE_LIMITS.maxFileBytes + 1, 0x61);
    await writeSource(source, "oversized.txt", oversized);
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, failureStorage, ["oversized.txt"]),
        noopGuard,
        new AbortController().signal,
      ),
      "input-limit",
    );

    const part = Buffer.alloc(200 * 1024, 0x62);
    await writeSource(source, "part-a.txt", part);
    await writeSource(source, "part-b.txt", part);
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, failureStorage, ["part-a.txt", "part-b.txt"]),
        noopGuard,
        new AbortController().signal,
      ),
      "input-limit",
    );
    expect(await readdir(failureStorage)).toEqual([]);
  });

  test("rejects links, directories, binary bytes and source escapes", async () => {
    const { source, storage } = await makeFixture();
    const outside = path.join(source, "outside.txt");
    await writeSource(source, "outside.txt", "outside\n");
    await symlink(outside, path.join(source, "link.txt"));
    await mkdir(path.join(source, "directory"));
    await writeSource(source, "binary.bin", Buffer.from([0x61, 0x00, 0x62]));
    await writeSource(source, "invalid-utf8.bin", Buffer.from([0xff, 0xfe, 0xfd]));

    for (const selected of ["link.txt", "directory", "binary.bin", "invalid-utf8.bin"]) {
      await expectFailure(
        prepareNativeHarnessWorkspace(
          config(source, storage, [selected]),
          noopGuard,
          new AbortController().signal,
        ),
        "unsafe-input",
      );
      expect(await readdir(storage)).toEqual([]);
    }
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  test("requires an existing, private, separate storage root without modifying the base", async () => {
    const { base, source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");

    await chmod(storage, 0o755);
    const before = await modeOf(storage);
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
      ),
      "unsafe-storage",
    );
    expect(await modeOf(storage)).toBe(before);
    await chmod(storage, 0o700);

    const inside = path.join(source, "inside-store");
    await mkdir(inside, { mode: 0o700 });
    await chmod(inside, 0o700);
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, inside, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
      ),
      "invalid-root",
    );

    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, base, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
      ),
      "invalid-root",
    );

    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, source, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
      ),
      "unsafe-storage",
    );

    const storageLink = path.join(base, "storage-link");
    await symlink(storage, storageLink);
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storageLink, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
      ),
      "unsafe-storage",
    );

    const sourceLink = path.join(base, "source-link");
    await symlink(source, sourceLink);
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(sourceLink, storage, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
      ),
      "invalid-root",
    );

    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, path.join(base, "missing"), ["a.txt"]),
        noopGuard,
        new AbortController().signal,
      ),
      "unsafe-storage",
    );

    await chmod(storage, 0o701);
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
      ),
      "unsafe-storage",
    );
    await chmod(storage, 0o2700);
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
      ),
      "unsafe-storage",
    );
    await chmod(storage, 0o700);

    expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("a\n");
    expect(await modeOf(storage)).toBe(0o700);
    expect(await modeOf(base)).toBe(0o700);
  });

  test("abort at each preparation boundary checks the real signal before the final guard", async () => {
    const { source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const points = ["after-owned-root", "before-read", "before-write", "before-git", "after-git"] as const;

    for (const point of points) {
      const controller = new AbortController();
      let guardCalls = 0;
      let guardCallsAtCheckpoint = -1;
      const guard = (): void => {
        guardCalls += 1;
      };
      const ports: NativeHarnessWorkspaceTestPorts = {
        checkpoint(event) {
          if (event.point !== point) return;
          guardCallsAtCheckpoint = guardCalls;
          controller.abort();
        },
      };
      const failure = await expectFailure(
        prepareNativeHarnessWorkspace(
          config(source, storage, ["a.txt"]),
          guard,
          controller.signal,
          ports,
        ),
        "aborted",
      );
      expect(guardCallsAtCheckpoint).toBeGreaterThanOrEqual(0);
      expect(guardCalls).toBe(guardCallsAtCheckpoint);
      expect(failure.cleanup).toBe("removed");
      expect(failure.preparedRoot).toBeNull();
      expect(await readdir(storage)).toEqual([]);
    }
  });

  test("a stale guard stops the next effect and cleans the owned root", async () => {
    const { source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const points = ["after-owned-root", "before-read", "before-write", "before-git", "after-git"] as const;

    for (const point of points) {
      let current = true;
      let guardCalls = 0;
      let guardCallsAtCheckpoint = -1;
      const guard = (): void => {
        guardCalls += 1;
        if (!current) throw new Error("the original parent call is no longer current");
      };
      const ports: NativeHarnessWorkspaceTestPorts = {
        checkpoint(event) {
          if (event.point !== point) return;
          guardCallsAtCheckpoint = guardCalls;
          current = false;
        },
      };
      const failure = await expectFailure(
        prepareNativeHarnessWorkspace(
          config(source, storage, ["a.txt"]),
          guard,
          new AbortController().signal,
          ports,
        ),
        "authority-lost",
      );
      expect(guardCalls).toBe(guardCallsAtCheckpoint + 1);
      expect(failure.cleanup).toBe("removed");
      expect(await readdir(storage)).toEqual([]);
    }
  });

  test("guard loss after file and directory handle allocation still closes handles and cleans the root", async () => {
    const { source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    for (const point of ["after-open", "after-opendir"] as const) {
      let current = true;
      let guardCalls = 0;
      let guardCallsAtCheckpoint = -1;
      const guard = (): void => {
        guardCalls += 1;
        if (!current) throw new Error("authority was lost");
      };
      const ports: NativeHarnessWorkspaceTestPorts = {
        checkpoint(event) {
          if (event.point !== point) return;
          guardCallsAtCheckpoint = guardCalls;
          current = false;
        },
      };
      const failure = await expectFailure(
        prepareNativeHarnessWorkspace(
          config(source, storage, ["a.txt"]),
          guard,
          new AbortController().signal,
          ports,
        ),
        "authority-lost",
      );
      expect(guardCalls).toBe(guardCallsAtCheckpoint + 1);
      expect(failure.cleanup).toBe("removed");
      expect(await readdir(storage)).toEqual([]);
    }
  });

  test("preserves a replaced prepared path instead of deleting an unrelated tree", async () => {
    const { source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const controller = new AbortController();
    let replacedRoot = "";
    let movedRoot = "";
    const ports: NativeHarnessWorkspaceTestPorts = {
      async checkpoint(event) {
        if (event.point !== "after-owned-root") return;
        replacedRoot = event.preparedRoot;
        movedRoot = `${event.preparedRoot}-moved`;
        await rename(event.preparedRoot, movedRoot);
        await mkdir(replacedRoot, { mode: 0o700 });
        await chmod(replacedRoot, 0o700);
        await writeFile(path.join(replacedRoot, "marker.txt"), "do-not-delete");
        controller.abort();
      },
    };
    const failure = await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["a.txt"]),
        noopGuard,
        controller.signal,
        ports,
      ),
      "aborted",
    );
    expect(failure.cleanup).toBe("preserved");
    expect(failure.preparedRoot).toBe(replacedRoot);
    expect(await readFile(path.join(replacedRoot, "marker.txt"), "utf8")).toBe("do-not-delete");
    expect(await exists(movedRoot)).toBe(true);
    expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("a\n");
    expect(await exists(storage)).toBe(true);
  });

  test("fails closed when sourceRoot is replaced during preparation", async () => {
    const { source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const movedSource = `${source}-moved`;
    const ports: NativeHarnessWorkspaceTestPorts = {
      async checkpoint(event) {
        if (event.point !== "before-git") return;
        await rename(source, movedSource);
        await mkdir(source, { mode: 0o755 });
        await chmod(source, 0o755);
        await writeFile(path.join(source, "new.txt"), "new\n");
      },
    };
    const failure = await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
        ports,
      ),
      "identity-changed",
    );
    expect(failure.cleanup).toBe("removed");
    expect(await readdir(storage)).toEqual([]);
    expect(await readFile(path.join(source, "new.txt"), "utf8")).toBe("new\n");
    expect(await readFile(path.join(movedSource, "a.txt"), "utf8")).toBe("a\n");
  });

  test("fails closed when the storage base is replaced and never deletes the replacement", async () => {
    const { source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const movedStorage = `${storage}-moved`;
    const controller = new AbortController();
    const ports: NativeHarnessWorkspaceTestPorts = {
      async checkpoint(event) {
        if (event.point !== "before-git") return;
        await rename(storage, movedStorage);
        await mkdir(storage, { mode: 0o700 });
        await chmod(storage, 0o700);
        await writeFile(path.join(storage, "unrelated.txt"), "keep\n");
        controller.abort();
      },
    };
    const failure = await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["a.txt"]),
        noopGuard,
        controller.signal,
        ports,
      ),
      "aborted",
    );
    expect(failure.cleanup).not.toBe("removed");
    expect(failure.preparedRoot?.startsWith(storage)).toBe(true);
    expect(await readFile(path.join(storage, "unrelated.txt"), "utf8")).toBe("keep\n");
    expect(await exists(movedStorage)).toBe(true);
    expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("a\n");
  });

  test("rejects destination links without touching the link target", async () => {
    const { base, source, storage } = await makeFixture();
    await writeSource(source, "nested/file.txt", "data\n");
    const outside = path.join(base, "outside");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(path.join(outside, "keep.txt"), "keep\n");
    const ports: NativeHarnessWorkspaceTestPorts = {
      async checkpoint(event) {
        if (event.point !== "before-write" || event.relativePath !== "nested/file.txt") return;
        await symlink(outside, path.join(event.workspaceRoot, "nested"));
      },
    };
    const failure = await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["nested/file.txt"]),
        noopGuard,
        new AbortController().signal,
        ports,
      ),
      "unsafe-destination",
    );
    expect(failure.cleanup).toBe("removed");
    expect(await readdir(outside)).toEqual(["keep.txt"]);
    expect(await readdir(storage)).toEqual([]);
  });

  test("rejects a destination file link without deleting its target", async () => {
    const { source, storage } = await makeFixture();
    await writeSource(source, "link.txt", "data\n");
    const target = path.join(storage, "target.txt");
    await writeFile(target, "target\n");
    const ports: NativeHarnessWorkspaceTestPorts = {
      async checkpoint(event) {
        if (event.point !== "before-write") return;
        await symlink(target, path.join(event.workspaceRoot, "link.txt"));
      },
    };
    await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["link.txt"]),
        noopGuard,
        new AbortController().signal,
        ports,
      ),
      "unsafe-destination",
    );
    expect(await readFile(target, "utf8")).toBe("target\n");
    expect(await readdir(storage)).toEqual(["target.txt"]);
  });

  test("rejects git failure with bounded diagnostics and removes only the owned root", async () => {
    const { source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const fakeGit = await makeExecutable(path.join(source, ".."), "fake-git-fail", [
      "#!/bin/sh",
      "i=0",
      "while [ \"$i\" -lt 200 ]; do",
      "  printf 'secret-marker-0123456789' >&2",
      "  i=$((i+1))",
      "done",
      "exit 7",
      "",
    ].join("\n"));
    const failure = await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
        { gitExecutable: fakeGit },
      ),
      "git-failed",
    );
    expect(failure.message).not.toContain("secret-marker");
    expect(failure.message.length).toBeLessThanOrEqual(512);
    expect(failure.cleanup).toBe("removed");
    expect(await readdir(storage)).toEqual([]);
    expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("a\n");
  });

  test("bounds git timeout and reaps the child before removing the owned root", async () => {
    const { base, source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const pidFile = path.join(base, "git-timeout.pid");
    const childPidFile = path.join(base, "git-timeout-child.pid");
    const fakeGit = await makeExecutable(base, "fake-git-timeout", [
      "#!/bin/sh",
      `echo $$ > ${shellQuote(pidFile)}`,
      "sleep 5 &",
      "child=$!",
      `echo \"$child\" > ${shellQuote(childPidFile)}`,
      "wait \"$child\"",
      "",
    ].join("\n"));
    const failure = await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
        {
          gitExecutable: fakeGit,
          gitTimeoutMs: 1000,
          gitKillGraceMs: 50,
          gitCloseGraceMs: 2000,
        },
      ),
      "git-timeout",
    );
    expect(failure.cleanup).toBe("removed");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    const childPid = Number((await readFile(childPidFile, "utf8")).trim());
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(isPidAlive(pid)).toBe(false);
    expect(isPidAlive(childPid)).toBe(false);
    expect(await readdir(storage)).toEqual([]);
  });

  test("does not let a short close grace cancel a pending KILL to the whole group", async () => {
    const { base, source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const pidFile = path.join(base, "git-kill.pid");
    const childPidFile = path.join(base, "git-kill-child.pid");
    const fakeGit = await makeExecutable(base, "fake-git-kill", [
      "#!/bin/sh",
      "trap '' TERM",
      `echo $$ > ${shellQuote(pidFile)}`,
      "sleep 5 &",
      "child=$!",
      `echo \"$child\" > ${shellQuote(childPidFile)}`,
      "wait \"$child\"",
      "",
    ].join("\n"));
    const failure = await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
        {
          gitExecutable: fakeGit,
          gitTimeoutMs: 1000,
          gitKillGraceMs: 500,
          gitCloseGraceMs: 100,
        },
      ),
      "git-timeout",
    );
    expect(failure.cleanup).toBe("removed");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    const childPid = Number((await readFile(childPidFile, "utf8")).trim());
    expect(isPidAlive(pid)).toBe(false);
    expect(isPidAlive(childPid)).toBe(false);
    expect(await readdir(storage)).toEqual([]);
  });

  test("kills a same-group redirected-stdio descendant after the direct git child exits", async () => {
    const { base, source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const pidFile = path.join(base, "git-descendant.pid");
    const childPidFile = path.join(base, "git-descendant-child.pid");
    const fakeGit = await makeExecutable(base, "fake-git-descendant", [
      "#!/bin/sh",
      `echo $$ > ${shellQuote(pidFile)}`,
      "( trap '' TERM; sleep 5 ) >/dev/null 2>&1 &",
      "child=$!",
      `echo \"$child\" > ${shellQuote(childPidFile)}`,
      "exit 1",
      "",
    ].join("\n"));
    const failure = await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
        {
          gitExecutable: fakeGit,
          gitKillGraceMs: 200,
          gitCloseGraceMs: 1000,
        },
      ),
      "git-failed",
    );
    expect(failure.cleanup).toBe("removed");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    const childPid = Number((await readFile(childPidFile, "utf8")).trim());
    expect(isPidAlive(pid)).toBe(false);
    expect(isPidAlive(childPid)).toBe(false);
    expect(await readdir(storage)).toEqual([]);
  });

  test("waits for a slow git init beyond the old two-second grace with default timeout", async () => {
    const { base, source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const fakeGit = await makeExecutable(base, "fake-git-slow", [
      "#!/bin/sh",
      "last=''",
      "for arg in \"$@\"; do last=\"$arg\"; done",
      "case \"$*\" in",
      "  *rev-parse*)",
      "    printf '%s\\n' \"$2\"",
      "    exit 0",
      "    ;;",
      "  *)",
      "    sleep 2.2",
      "    mkdir -p \"$last/.git\"",
      "    exit 0",
      "    ;;",
      "esac",
      "",
    ].join("\n"));
    const started = Date.now();
    const descriptor = await prepareNativeHarnessWorkspace(
      config(source, storage, ["a.txt"]),
      noopGuard,
      new AbortController().signal,
      { gitExecutable: fakeGit },
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(await exists(path.join(descriptor.workspaceRoot, ".git"))).toBe(true);
    expect(await readdir(descriptor.storeRoot)).toEqual([]);
  });

  test("waits for a late git exit that happens after the timeout", async () => {
    const { source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const fakeGit = await makeExecutable(path.join(source, ".."), "fake-git-late", [
      "#!/bin/sh",
      "trap '' TERM",
      "sleep 0.2",
      "exit 0",
      "",
    ].join("\n"));
    const failure = await expectFailure(
      prepareNativeHarnessWorkspace(
        config(source, storage, ["a.txt"]),
        noopGuard,
        new AbortController().signal,
        {
          gitExecutable: fakeGit,
          gitTimeoutMs: 50,
          gitKillGraceMs: 1000,
          gitCloseGraceMs: 2000,
        },
      ),
      "git-timeout",
    );
    expect(failure.cleanup).toBe("removed");
    expect(await readdir(storage)).toEqual([]);
  });

  test("preserves the owned root while a late git descendant keeps the child open", async () => {
    const { base, source, storage } = await makeFixture();
    await writeSource(source, "a.txt", "a\n");
    const fakeScript = path.join(base, "fake-git-child.mjs");
    await writeFile(fakeScript, [
      "import { spawn } from \"node:child_process\";",
      "import { writeFileSync } from \"node:fs\";",
      "import path from \"node:path\";",
      "const workspace = process.argv.at(-1);",
      "const root = path.dirname(workspace);",
      "const child = spawn(process.execPath, [\"-e\", \"setTimeout(() => {}, 3000)\"], {",
      "  detached: true,",
      "  stdio: [\"ignore\", \"inherit\", \"inherit\"],",
      "});",
      "if (child.pid) writeFileSync(path.join(root, \"grandchild.pid\"), String(child.pid));",
      "process.on(\"SIGTERM\", () => {});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    const fakeGit = await makeExecutable(base, "fake-git-child", [
      "#!/bin/sh",
      `exec ${shellQuote(process.execPath)} ${shellQuote(fakeScript)} "$@"`,
      "",
    ].join("\n"));
    let failure: NativeHarnessWorkspaceError | null = null;
    let grandchildPid = 0;
    try {
      failure = await expectFailure(
        prepareNativeHarnessWorkspace(
          config(source, storage, ["a.txt"]),
          noopGuard,
          new AbortController().signal,
          {
            gitExecutable: fakeGit,
            gitTimeoutMs: 1500,
            gitKillGraceMs: 100,
            gitCloseGraceMs: 200,
          },
        ),
        "git-cleanup-unknown",
      );
      expect(failure.cleanup).toBe("preserved");
      expect(failure.preparedRoot).not.toBeNull();
      expect(await exists(failure.preparedRoot!)).toBe(true);
      grandchildPid = Number((await readFile(path.join(failure.preparedRoot!, "grandchild.pid"), "utf8")).trim());
      expect(Number.isSafeInteger(grandchildPid)).toBe(true);
      expect(isPidAlive(grandchildPid)).toBe(true);
      expect(await exists(path.join(failure.preparedRoot!, "workspace"))).toBe(true);
    } finally {
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // The grandchild may have exited on its own.
        }
        await waitForPidGone(grandchildPid).catch(() => undefined);
      }
    }
    expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("a\n");
  });
});
