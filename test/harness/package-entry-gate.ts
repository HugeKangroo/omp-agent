import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

/** Real package-manager tarball, safe extraction and exact inventory gate. */

export interface InventoryEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PackageArtifact {
  packageRoot: string;
  extractRoot: string;
  tarballPath: string;
  tarballBytes: number;
  tarballSha256: string;
  packCommand: string[];
  packStdout: string;
  packStderr: string;
  packageJson: Record<string, unknown>;
  entries: InventoryEntry[];
  expectedPaths: string[];
  mutation: { removed: string; rejected: true; error: string };
}

export interface PackageArtifactOptions {
  repoRoot: string;
  /** Owned output directory outside the source checkout. */
  artifactRoot: string;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function command(label: string, argv: string[], cwd: string, timeout: number): {
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${String(result.status)}: ${result.stdout}\n${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function withinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`source inventory contains a symbolic link: ${absolute}`);
      if (info.isDirectory()) visit(absolute);
      else if (info.isFile()) files.push(absolute);
      else throw new Error(`source inventory contains an unsupported entry: ${absolute}`);
    }
  };
  visit(root);
  return files;
}

/** Exact allowlist: package.json, the public docs, policy, launcher and all src. */
export function expectedPackagePaths(repoRoot: string): string[] {
  const paths = [
    "package/package.json",
    "package/README.md",
    "package/docs/architecture.md",
    "package/docs/testing.md",
    "package/docs/release-notes.md",
    "package/policy/development-fixture.v1.json",
    "package/scripts/isolated-exec.py",
  ];
  for (const absolute of walkFiles(path.join(repoRoot, "src"))) {
    paths.push(`package/src/${path.relative(path.join(repoRoot, "src"), absolute).split(path.sep).join("/")}`);
  }
  return paths.sort();
}

function safeTarNames(tarball: string): string[] {
  const names = command("tar list", ["tar", "-tzf", tarball], path.dirname(tarball), 30_000)
    .stdout.split("\n").filter((line) => line.length > 0);
  const verbose = command("tar verbose list", ["tar", "-tvzf", tarball], path.dirname(tarball), 30_000)
    .stdout.split("\n").filter((line) => line.length > 0);
  if (names.length !== verbose.length) {
    throw new Error("tar listing line counts disagree; refusing an ambiguous archive");
  }
  const seen = new Set<string>();
  names.forEach((name, index) => {
    if (name.includes("\\")) throw new Error(`tar entry contains a backslash: ${JSON.stringify(name)}`);
    if (name.startsWith("/")) throw new Error(`tar entry is absolute: ${JSON.stringify(name)}`);
    if (seen.has(name)) throw new Error(`tar entry is duplicated: ${JSON.stringify(name)}`);
    seen.add(name);
    const components = name.replace(/\/$/, "").split("/");
    if (components.some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`tar entry has an unsafe component: ${JSON.stringify(name)}`);
    }
    if (components[0] !== "package") {
      throw new Error(`tar entry is outside the package root: ${JSON.stringify(name)}`);
    }
    const type = verbose[index]![0];
    const directoryName = name.endsWith("/");
    if (type === "l" || type === "h") {
      throw new Error(`tar entry is a link: ${JSON.stringify(name)}`);
    }
    if (type === "d" && !directoryName) {
      throw new Error(`tar directory entry lacks a trailing slash: ${JSON.stringify(name)}`);
    }
    if (type === "-" && directoryName) {
      throw new Error(`tar file entry has a trailing slash: ${JSON.stringify(name)}`);
    }
    if (type !== "-" && type !== "d") {
      throw new Error(`tar entry has unsupported type ${JSON.stringify(type)}: ${JSON.stringify(name)}`);
    }
  });
  return names;
}

function extract(tarball: string, destination: string): void {
  command(
    "tar extract",
    ["tar", "-xzf", tarball, "-C", destination, "--no-same-owner"],
    path.dirname(tarball),
    30_000,
  );
}

async function validateExtracted(
  packageRoot: string,
  repoRoot: string,
  expectedPaths: string[],
): Promise<InventoryEntry[]> {
  const rootInfo = lstatSync(packageRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("extracted package root is not a real directory");
  }
  const entries: InventoryEntry[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`extracted package contains a symbolic link: ${absolute}`);
      if (info.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!info.isFile()) throw new Error(`extracted package contains an unsupported entry: ${absolute}`);
      const real = realpathSync(absolute);
      if (!withinOrEqual(realpathSync(packageRoot), real)) {
        throw new Error(`extracted file resolves outside the package root: ${absolute}`);
      }
      const relative = `package/${path.relative(packageRoot, absolute).split(path.sep).join("/")}`;
      const bytes = readFileSync(absolute);
      entries.push({ path: relative, bytes: bytes.byteLength, sha256: sha256Bytes(bytes) });
    }
  };
  visit(packageRoot);
  const actual = entries.map((entry) => entry.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedPaths)) {
    const missing = expectedPaths.filter((item) => !actual.includes(item));
    const extra = actual.filter((item) => !expectedPaths.includes(item));
    throw new Error(`package inventory mismatch; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
  }
  for (const entry of entries) {
    const source = path.join(repoRoot, entry.path.slice("package/".length));
    const sourceBytes = readFileSync(source);
    if (entry.path === "package/package.json") {
      const sourceValue = JSON.parse(sourceBytes.toString("utf8")) as unknown;
      const packagedValue = JSON.parse(
        readFileSync(path.join(packageRoot, "package.json"), "utf8"),
      ) as unknown;
      if (JSON.stringify(sourceValue) !== JSON.stringify(packagedValue)) {
        throw new Error("packaged package.json differs semantically from the source checkout");
      }
      continue;
    }
    if (sha256Bytes(sourceBytes) !== entry.sha256) {
      throw new Error(`packaged bytes differ from the source checkout: ${entry.path}`);
    }
  }
  return entries;
}

export async function buildPackageArtifact(options: PackageArtifactOptions): Promise<PackageArtifact> {
  const repoRoot = realpathSync(options.repoRoot);
  await mkdir(path.resolve(options.artifactRoot), { recursive: true, mode: 0o700 });
  const artifactRoot = realpathSync(options.artifactRoot);
  if (withinOrEqual(repoRoot, artifactRoot)) {
    throw new Error("package artifact output must be outside the source checkout");
  }
  const packRoot = path.join(artifactRoot, "pack");
  const extractRoot = path.join(artifactRoot, "extracted");
  const mutationRoot = path.join(artifactRoot, "mutation");
  for (const directory of [packRoot, extractRoot, mutationRoot]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  const packCommand = [
    "bun", "pm", "pack",
    "--destination", packRoot,
    "--ignore-scripts",
  ];
  const packed = command("bun pm pack", packCommand, repoRoot, 60_000);
  const tarballs = readdirSync(packRoot).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`bun pm pack produced ${tarballs.length} tarballs; expected exactly one`);
  }
  const tarballPath = path.join(packRoot, tarballs[0]!);
  const tarball = readFileSync(tarballPath);
  const names = safeTarNames(tarballPath);
  extract(tarballPath, extractRoot);
  const packageRoot = path.join(extractRoot, "package");
  const expectedPaths = expectedPackagePaths(repoRoot);
  const entries = await validateExtracted(packageRoot, repoRoot, expectedPaths);
  const packageJson = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;

  const mutationPackageRoot = path.join(mutationRoot, "package");
  extract(tarballPath, mutationRoot);
  const removed = path.join(mutationPackageRoot, "scripts/isolated-exec.py");
  await rm(removed);
  let mutationError = "";
  try {
    await validateExtracted(mutationPackageRoot, repoRoot, expectedPaths);
  } catch (error) {
    mutationError = (error as Error).message;
  }
  if (!mutationError.includes("scripts/isolated-exec.py")) {
    throw new Error(
      `missing-launcher inventory mutation was not rejected for the launcher: ${mutationError || "accepted"}`,
    );
  }
  if (!names.includes("package/scripts/isolated-exec.py")) {
    throw new Error("tar listing omitted the packaged launcher");
  }

  return {
    packageRoot,
    extractRoot,
    tarballPath,
    tarballBytes: tarball.byteLength,
    tarballSha256: sha256Bytes(tarball),
    packCommand,
    packStdout: packed.stdout,
    packStderr: packed.stderr,
    packageJson,
    entries,
    expectedPaths,
    mutation: { removed, rejected: true, error: mutationError },
  };
}
