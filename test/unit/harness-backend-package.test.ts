import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessController, RunConfig, RunRecord } from "../../vendor/harness2/index.ts";
import {
  buildPackageArtifact,
  expectedPackagePaths,
  sha256Bytes,
  validateExtracted,
  type PackageArtifact,
} from "../harness/package-entry-gate.ts";

// Type-only contract: importing the vendored public entry brings its full
// relative source closure under the existing project typecheck. This does not
// prove runtime compatibility with an OMP process.
type Assert<T extends true> = T;
type _CreateReturnsRunRecord = Assert<Awaited<ReturnType<HarnessController["create"]>> extends RunRecord ? true : false>;
type _ListReturnsRunRecords = Assert<Awaited<ReturnType<HarnessController["list"]>> extends RunRecord[] ? true : false>;
type _CreateAcceptsRunConfig = Assert<Parameters<HarnessController["create"]>[1] extends Partial<RunConfig> & { model: string } ? true : false>;

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const VENDOR_ROOT = path.join(REPO_ROOT, "vendor/harness2");
const SOURCE_MANIFEST = path.join(VENDOR_ROOT, "SOURCE.json");
const UPSTREAM_REPOSITORY = "https://github.com/HugeKangroo/omp-harness2";
const UPSTREAM_BASE_COMMIT = "6d5cd6386c8a085d0070cfb660ddbc5c7f76b92e";
const EXPECTED_SOURCE_ID = "1edfaf2a5b39f15adaf53e9d351b43c29a62853b6dd27cf52b028a77d656b031";
const UPSTREAM_MODULES = [
  "adaptation.ts",
  "approval-channel.ts",
  "capabilities.ts",
  "commands.ts",
  "controller.ts",
  "conversation.ts",
  "diff.ts",
  "evolution-completion.ts",
  "evolution.ts",
  "exploration-prompts.ts",
  "exploration.ts",
  "generated-extension.ts",
  "host-tools.ts",
  "method-authoring.ts",
  "omp-profile.ts",
  "planner-catalog.ts",
  "planner-methods.ts",
  "prompts.ts",
  "runner.ts",
  "runtime-policy.ts",
  "store.ts",
  "surface.ts",
  "task-graph.ts",
  "types.ts",
  "workflows.ts",
  "workspace.ts",
] as const;
const EXPECTED_VENDOR_FILES = [
  "vendor/harness2/SOURCE.json",
  "vendor/harness2/index.ts",
  "vendor/harness2/upstream/LICENSE",
  "vendor/harness2/upstream/NOTICE",
  ...UPSTREAM_MODULES.map((name) => `vendor/harness2/upstream/src/${name}`),
].sort();
const EXPECTED_MODIFIED_FILES = [
  "vendor/harness2/upstream/src/controller.ts",
  "vendor/harness2/upstream/src/evolution.ts",
  "vendor/harness2/upstream/src/runner.ts",
].sort();
const EXPECTED_EDITED_ORIGINALS: Record<string, string> = {
  "vendor/harness2/upstream/src/controller.ts": "711967e2e61220953e00412dbfcf3dac623202f0cd01d9e1fcfd002113582d92",
  "vendor/harness2/upstream/src/evolution.ts": "706d229570950eb074844472ada15237477ed9d86ffb8b4443f9601861f16985",
  "vendor/harness2/upstream/src/runner.ts": "589cde36411bcb71ea06a2c628b4fa28dbbc36f44d1431043452e98d9f829f24",
};

type SourceFileKind = "upstream-source" | "license" | "wrapper" | "provenance";

interface SourceFileEntry {
  distributionPath: string;
  upstreamPath: string | null;
  kind: SourceFileKind;
  originalSha256: string | null;
  bundledSha256: string | null;
  bytes: number | null;
  modified: boolean;
  note: string;
}

interface SourceManifest {
  schemaVersion: 1;
  format: string;
  upstream: {
    repository: string;
    baseCommit: string;
    contentKind: string;
    publishedUpstreamTag: boolean;
    note: string;
  };
  sourceId: string;
  sourceIdAlgorithm: string;
  license: {
    upstreamLicensePath: string;
    upstreamNoticePath: string;
    distributionLicensePath: string;
    distributionNoticePath: string;
    note: string;
  };
  files: SourceFileEntry[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function walkFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const info = statSync(absolute);
      if (info.isDirectory()) visit(absolute);
      else if (info.isFile()) files.push(absolute);
      else throw new Error(`vendor inventory contains an unsupported entry: ${absolute}`);
    }
  };
  visit(directory);
  return files;
}

function relativeToRepo(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

function resolveRelativeSource(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base];
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
  else candidates.push(`${base}.ts`);
  candidates.push(path.join(base, "index.ts"));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next documented resolution form.
    }
  }
  return undefined;
}

/** Follow the shipped relative import closure, rejecting bare runtime dependencies. */
function resolveVendorClosure(entry: string, packageRoot: string): string[] {
  const sourceRoot = path.join(packageRoot, "vendor/harness2/upstream/src");
  const vendorRoot = path.join(packageRoot, "vendor/harness2");
  const resolvedSources = new Set<string>();
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (file.startsWith(`${sourceRoot}${path.sep}`)) {
      resolvedSources.add(relativeToRepo(path.join(REPO_ROOT, "vendor/harness2/upstream/src", path.relative(sourceRoot, file))));
    }
    const source = readFileSync(file, "utf8");
    const imports = source.matchAll(/^[ \t]*(?:import|export)\b(?:[^;]*?\bfrom\s*)?\s*["']([^"']+)["']/gm);
    for (const match of imports) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeSource(file, specifier);
        if (!resolved) throw new Error(`unresolved relative module ${JSON.stringify(specifier)} from ${file}`);
        if (!resolved.startsWith(`${vendorRoot}${path.sep}`)) {
          throw new Error(`module ${JSON.stringify(specifier)} resolves outside the extracted vendor root: ${resolved}`);
        }
        queue.push(resolved);
      } else if (!specifier.startsWith("node:") && specifier !== "bun:sqlite") {
        throw new Error(`unexpected bare runtime dependency ${JSON.stringify(specifier)} from ${file}`);
      }
    }
  }
  return [...resolvedSources].sort(compareText);
}

let artifactRoot: string | undefined;
let artifact: PackageArtifact | undefined;

beforeAll(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "omp-agent-harness2-package-"));
  artifact = await buildPackageArtifact({
    repoRoot: REPO_ROOT,
    artifactRoot: path.join(artifactRoot, "artifact"),
  });
}, 120_000);

afterAll(async () => {
  if (artifactRoot !== undefined) await rm(artifactRoot, { recursive: true, force: true });
});

describe("G5-1 vendored Harness² source capsule", () => {
  test("provenance pins the portable 30-file closure and actual bytes", () => {
    const manifest = JSON.parse(readFileSync(SOURCE_MANIFEST, "utf8")) as SourceManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.format).toBe("omp-agent-vendored-source");
    expect(manifest.upstream.repository).toBe(UPSTREAM_REPOSITORY);
    expect(manifest.upstream.baseCommit).toBe(UPSTREAM_BASE_COMMIT);
    expect(manifest.upstream.publishedUpstreamTag).toBe(false);
    expect(manifest.sourceId).toBe(EXPECTED_SOURCE_ID);

    const manifestPaths = manifest.files.map((entry) => entry.distributionPath).sort(compareText);
    expect(manifestPaths).toEqual(EXPECTED_VENDOR_FILES);
    expect(manifest.files.map((entry) => entry.distributionPath)).toEqual(manifestPaths);

    const actualPaths = walkFiles(VENDOR_ROOT).map(relativeToRepo).sort(compareText);
    expect(actualPaths).toEqual(EXPECTED_VENDOR_FILES);

    let sourceCount = 0;
    for (const entry of manifest.files) {
      expect(entry.distributionPath.startsWith("vendor/harness2/")).toBe(true);
      expect(entry.note.length).toBeGreaterThan(0);
      if (entry.kind === "provenance") {
        expect(entry.distributionPath).toBe("vendor/harness2/SOURCE.json");
        expect(entry.originalSha256).toBeNull();
        expect(entry.bundledSha256).toBeNull();
        expect(entry.bytes).toBeNull();
        continue;
      }
      const absolute = path.resolve(REPO_ROOT, entry.distributionPath);
      expect(path.relative(REPO_ROOT, absolute).startsWith("..")).toBe(false);
      const bytes = readFileSync(absolute);
      expect(entry.bytes).toBe(bytes.byteLength);
      expect(entry.bundledSha256).toBe(sha256Hex(bytes));
      if (entry.kind === "upstream-source" || entry.kind === "license") {
        expect(entry.originalSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(entry.modified).toBe(entry.originalSha256 !== entry.bundledSha256);
        const pinnedOriginal = EXPECTED_EDITED_ORIGINALS[entry.distributionPath];
        if (pinnedOriginal !== undefined) expect(entry.originalSha256).toBe(pinnedOriginal);
      } else {
        expect(entry.originalSha256).toBeNull();
        expect(entry.modified).toBe(false);
      }
      if (entry.kind === "upstream-source") sourceCount += 1;
    }
    expect(sourceCount).toBe(26);
    expect(
      manifest.files.filter((entry) => entry.modified).map((entry) => entry.distributionPath).sort(compareText),
    ).toEqual(EXPECTED_MODIFIED_FILES);

    const digestFiles = manifest.files
      .filter((entry) => entry.kind !== "provenance")
      .map((entry) => {
        if (entry.bundledSha256 === null) throw new Error(`missing bundled hash for ${entry.distributionPath}`);
        return { distributionPath: entry.distributionPath, bundledSha256: entry.bundledSha256 };
      })
      .sort((a, b) => compareText(a.distributionPath, b.distributionPath));
    const digest = sha256Hex(
      Buffer.from(
        canonicalJson({
          schemaVersion: manifest.schemaVersion,
          upstreamRepository: manifest.upstream.repository,
          baseCommit: manifest.upstream.baseCommit,
          files: digestFiles,
        }),
        "utf8",
      ),
    );
    expect(digest).toBe(manifest.sourceId);

    const serialized = JSON.stringify(manifest);
    for (const forbidden of ["/Users/", "/private/", "/tmp/", ".harness2"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("package metadata includes every vendor file explicitly and preserves old entries", () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      files: string[];
      omp: { extensions: string[] };
    };
    const vendorEntries = packageJson.files.filter((entry) => entry.startsWith("vendor/")).sort(compareText);
    expect(vendorEntries).toEqual(EXPECTED_VENDOR_FILES);
    expect(packageJson.files).not.toContain("vendor");
    expect(packageJson.files).not.toContain("vendor/harness2");
    expect(packageJson.files.some((entry) => entry.includes("*"))).toBe(false);
    expect(packageJson.omp).toEqual({ extensions: ["./src/daily-entry.ts"] });
    for (const oldEntry of [
      "src",
      "policy",
      "scripts/isolated-exec.py",
      "docs/architecture.md",
      "docs/testing.md",
      "docs/release-notes.md",
      "README.md",
    ]) {
      expect(packageJson.files).toContain(oldEntry);
    }

    const expected = expectedPackagePaths(REPO_ROOT);
    expect(expected).toEqual([...expected].sort(compareText));
    for (const file of EXPECTED_VENDOR_FILES) expect(expected).toContain(`package/${file}`);
    for (const oldEntry of [
      "package/package.json",
      "package/README.md",
      "package/docs/architecture.md",
      "package/docs/testing.md",
      "package/docs/release-notes.md",
      "package/policy/development-fixture.v1.json",
      "package/scripts/isolated-exec.py",
      "package/src/daily-entry.ts",
    ]) {
      expect(expected).toContain(oldEntry);
    }
  });

  test("upstream license and notice are retained verbatim", () => {
    const license = readFileSync(path.join(VENDOR_ROOT, "upstream/LICENSE"), "utf8");
    expect(license.startsWith("MIT License\n")).toBe(true);
    expect(license).toContain("Copyright (c) 2026 omp-harness2 contributors");
    expect(license).toContain("Permission is hereby granted, free of charge");
    const notice = readFileSync(path.join(VENDOR_ROOT, "upstream/NOTICE"), "utf8");
    expect(notice).toContain("Harness²");
    expect(notice).toContain("Oh My Pi");
    const manifest = JSON.parse(readFileSync(SOURCE_MANIFEST, "utf8")) as SourceManifest;
    expect(manifest.license.distributionLicensePath).toBe("vendor/harness2/upstream/LICENSE");
    expect(manifest.license.distributionNoticePath).toBe("vendor/harness2/upstream/NOTICE");
  });

  test("real packed and extracted modules resolve the full 26-module relative closure", async () => {
    if (artifact === undefined || artifactRoot === undefined) throw new Error("package artifact was not built");
    const realArtifactRoot = realpathSync(artifactRoot);
    const realPackageRoot = realpathSync(artifact.packageRoot);
    expect(realPackageRoot.startsWith(`${realArtifactRoot}${path.sep}`)).toBe(true);
    expect(realPackageRoot.startsWith(`${realpathSync(REPO_ROOT)}${path.sep}`)).toBe(false);

    const packedVendor = artifact.entries
      .map((entry) => entry.path)
      .filter((entry) => entry.startsWith("package/vendor/"))
      .sort(compareText);
    expect(packedVendor).toEqual(EXPECTED_VENDOR_FILES.map((file) => `package/${file}`));
    for (const file of EXPECTED_VENDOR_FILES) {
      const entry = artifact.entries.find((candidate) => candidate.path === `package/${file}`);
      expect(entry).toBeDefined();
      const source = readFileSync(path.join(REPO_ROOT, file));
      expect(entry!.sha256).toBe(sha256Bytes(source));
      expect(entry!.bytes).toBe(source.byteLength);
    }

    const extractedIndex = path.join(artifact.packageRoot, "vendor/harness2/index.ts");
    expect(realpathSync(extractedIndex).startsWith(`${realPackageRoot}${path.sep}`)).toBe(true);
    const vendored = await import(pathToFileURL(extractedIndex).href) as Record<string, unknown>;
    expect(Object.keys(vendored)).toEqual(["HarnessController"]);
    expect(typeof vendored.HarnessController).toBe("function");

    const closure = resolveVendorClosure(extractedIndex, artifact.packageRoot);
    expect(closure).toEqual(
      UPSTREAM_MODULES.map((name) => `vendor/harness2/upstream/src/${name}`).sort(compareText),
    );
  });

  test("gate rejects a missing or changed required vendor source without touching the checkout", async () => {
    if (artifact === undefined || artifactRoot === undefined) throw new Error("package artifact was not built");
    const expected = expectedPackagePaths(REPO_ROOT);
    const mutationPackageRoot = path.join(artifactRoot, "vendor-mutation", "package");
    cpSync(artifact.packageRoot, mutationPackageRoot, { recursive: true, dereference: false });

    const missing = path.join(mutationPackageRoot, "vendor/harness2/upstream/src/runner.ts");
    unlinkSync(missing);
    let missingError = "";
    try {
      await validateExtracted(mutationPackageRoot, REPO_ROOT, expected);
    } catch (error) {
      missingError = (error as Error).message;
    }
    expect(missingError).toContain("package/vendor/harness2/upstream/src/runner.ts");
    expect(missingError).toContain("missing=");

    cpSync(path.join(artifact.packageRoot, "vendor/harness2/upstream/src/runner.ts"), missing);
    const changed = path.join(mutationPackageRoot, "vendor/harness2/upstream/src/types.ts");
    appendFileSync(changed, "\n// test-owned package mutation\n");
    let changedError = "";
    try {
      await validateExtracted(mutationPackageRoot, REPO_ROOT, expected);
    } catch (error) {
      changedError = (error as Error).message;
    }
    expect(changedError).toContain("package/vendor/harness2/upstream/src/types.ts");
    expect(changedError).toContain("differ");

    expect(readFileSync(path.join(REPO_ROOT, "vendor/harness2/upstream/src/types.ts"), "utf8")).not.toContain(
      "test-owned package mutation",
    );
  });
});
