import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DailyOmpSession } from "./daily-run.ts";

/** Evidence retained outside the checkout on success and failure. */

export interface BinaryManifest {
  path: string;
  realpath: string;
  bytes: number;
  sha256: string;
  version: string;
}

export interface SourceManifest {
  repoRoot: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

export type EvidenceGapKind =
  | "missing"
  | "unavailable"
  | "read_failure"
  | "hash_mismatch"
  | "path_escape"
  | "identity_mismatch";

export interface EvidenceGap {
  requirement: string;
  sourcePath: string | null;
  kind: EvidenceGapKind;
  reason: string;
}

export interface EvidenceCopyFact {
  requirement: string;
  sourcePath: string;
  target: string;
  relativeTarget: string;
  sourceBytes: number;
  sourceSha256: string;
  copiedBytes: number;
  copiedSha256: string;
}

export interface RunEvidenceBinding {
  name: string;
  directory: string;
  phase: string;
  runId: string | null;
  taskId: string | null;
  record: EvidenceCopyFact | null;
  source: {
    sourcePath: string;
    target: string;
    bytes: number;
    sha256: string;
    providerSourceMatched: boolean;
  } | null;
  inputs: Array<{
    id: string;
    sourcePath: string;
    stagedPath: string;
    authorizedTarget: string | null;
    stagedTarget: string;
    bytes: number;
    sha256: string;
  }>;
  artifacts: Array<{
    artifactId: string;
    archiveRef: string;
    target: string;
    bytes: number;
    sha256: string;
  }>;
  watchdog: {
    logRef: string | null;
    target: string | null;
    logAvailable: boolean;
    pid: number | null;
    pgid: number | null;
    scriptPid: number | null;
    supervisorPid: number | null;
    watchdogPid: number | null;
    groupGone: boolean | null;
  } | null;
  unavailable: string[];
}

export interface SessionEvidenceCapture {
  label: string;
  directory: string;
  capturedAt: string;
  cleanupPhase: "precleanup";
  complete: boolean;
  snapshot: Record<string, unknown>;
  copies: EvidenceCopyFact[];
  gaps: EvidenceGap[];
  runs: RunEvidenceBinding[];
  completedRuns: number;
  indexFile: string;
}

export interface CaptureOptions {
  /** Actual runIds already observed from provider/observer facts. */
  expectedRunIds?: string[];
  /** Explicit host-authorized original input paths for this case. */
  authorizedInputPaths?: string[];
  /** Actual provider tool-call source strings for this case. */
  providerToolCallSources?: string[];
  /** Delivery files that must be present in the captured delivery tree. */
  expectedDeliveryPaths?: string[];
}

interface ExpectedFile {
  bytes?: number | undefined;
  sha256?: string | undefined;
}

class EvidenceGapError extends Error {
  readonly kind: EvidenceGapKind;

  constructor(kind: EvidenceGapKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function withinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function ensureEvidenceRoot(repoRoot: string): Promise<string> {
  const requested = process.env.PACKAGE_ENTRY_EVIDENCE_ROOT;
  const root = requested === undefined
    ? path.join(tmpdir(), `omp-agent-package-entry-${Date.now()}-${process.pid}`)
    : path.resolve(requested);
  if (withinOrEqual(path.resolve(repoRoot), root)) {
    throw new Error("package-entry evidence must be outside the source checkout");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

export function sourceManifest(repoRoot: string): SourceManifest {
  const listed = spawnSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (listed.error) throw new Error(`source manifest git ls-files failed: ${listed.error.message}`);
  if (listed.status !== 0) throw new Error(`source manifest git ls-files failed: ${listed.stderr}`);
  const relativePaths = listed.stdout.split("\0").filter(Boolean).sort();
  const files = relativePaths.map((relative) => {
    const bytes = readFileSync(path.join(repoRoot, relative));
    return { path: relative, bytes: bytes.byteLength, sha256: sha256Bytes(bytes) };
  });
  return { repoRoot, files };
}

export async function binaryManifest(binaryPath: string, version: string): Promise<BinaryManifest> {
  const real = await realpath(binaryPath);
  const bytes = await readFile(real);
  return {
    path: binaryPath,
    realpath: real,
    bytes: bytes.byteLength,
    sha256: sha256Bytes(bytes),
    version,
  };
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function gap(
  gaps: EvidenceGap[],
  requirement: string,
  kind: EvidenceGapKind,
  reason: string,
  sourcePath?: string,
): void {
  gaps.push({ requirement, sourcePath: sourcePath ?? null, kind, reason });
}

function safeRelativeTarget(base: string, relativeTarget: string): string {
  if (relativeTarget.length === 0 || relativeTarget.includes("\0") || path.isAbsolute(relativeTarget)) {
    throw new EvidenceGapError("path_escape", `evidence target is not a relative path: ${relativeTarget}`);
  }
  const normalized = path.normalize(relativeTarget);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new EvidenceGapError("path_escape", `evidence target escapes its root: ${relativeTarget}`);
  }
  const target = path.resolve(base, normalized);
  if (!withinOrEqual(path.resolve(base), target)) {
    throw new EvidenceGapError("path_escape", `evidence target escapes its root: ${relativeTarget}`);
  }
  return target;
}

async function requireRealDirectory(
  directory: string,
  requirement: string,
  gaps: EvidenceGap[],
): Promise<string | null> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      gap(gaps, requirement, "path_escape", `${directory} is not a real directory`, directory);
      return null;
    }
    return await realpath(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    gap(
      gaps,
      requirement,
      code === "ENOENT" ? "missing" : "read_failure",
      `${directory}: ${(error as Error).message}`,
      directory,
    );
    return null;
  }
}

async function captureFile(
  args: {
    directory: string;
    source: string;
    relativeTarget: string;
    requirement: string;
    gaps: EvidenceGap[];
    copies: EvidenceCopyFact[];
    expected?: ExpectedFile;
    allowedRoot?: string | undefined;
  },
): Promise<EvidenceCopyFact | null> {
  let target: string;
  try {
    target = safeRelativeTarget(args.directory, args.relativeTarget);
  } catch (error) {
    gap(args.gaps, args.requirement, "path_escape", (error as Error).message, args.source);
    return null;
  }
  let info;
  try {
    info = await lstat(args.source);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    gap(
      args.gaps,
      args.requirement,
      code === "ENOENT" ? "missing" : "read_failure",
      `${args.source}: ${(error as Error).message}`,
      args.source,
    );
    return null;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    gap(args.gaps, args.requirement, "path_escape", `${args.source} is not a regular file`, args.source);
    return null;
  }
  if (args.allowedRoot !== undefined) {
    try {
      const real = await realpath(args.source);
      if (!withinOrEqual(args.allowedRoot, real)) {
        gap(args.gaps, args.requirement, "path_escape", `${args.source} resolves outside ${args.allowedRoot}`, args.source);
        return null;
      }
    } catch (error) {
      gap(args.gaps, args.requirement, "read_failure", `${args.source}: ${(error as Error).message}`, args.source);
      return null;
    }
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(args.source);
  } catch (error) {
    gap(args.gaps, args.requirement, "read_failure", `${args.source}: ${(error as Error).message}`, args.source);
    return null;
  }
  if (args.expected?.bytes !== undefined && args.expected.bytes !== bytes.byteLength) {
    gap(
      args.gaps,
      args.requirement,
      "hash_mismatch",
      `${args.source}: expected ${args.expected.bytes} bytes, read ${bytes.byteLength}`,
      args.source,
    );
  }
  if (args.expected?.sha256 !== undefined && args.expected.sha256 !== sha256Bytes(bytes)) {
    gap(
      args.gaps,
      args.requirement,
      "hash_mismatch",
      `${args.source}: expected ${args.expected.sha256}, read ${sha256Bytes(bytes)}`,
      args.source,
    );
  }
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
  } catch (error) {
    gap(args.gaps, args.requirement, "read_failure", `${target}: ${(error as Error).message}`, args.source);
    return null;
  }
  let copied: Buffer;
  try {
    copied = await readFile(target);
  } catch (error) {
    gap(args.gaps, args.requirement, "read_failure", `${target}: ${(error as Error).message}`, args.source);
    return null;
  }
  const fact: EvidenceCopyFact = {
    requirement: args.requirement,
    sourcePath: args.source,
    target,
    relativeTarget: path.relative(args.directory, target),
    sourceBytes: bytes.byteLength,
    sourceSha256: sha256Bytes(bytes),
    copiedBytes: copied.byteLength,
    copiedSha256: sha256Bytes(copied),
  };
  if (fact.copiedBytes !== fact.sourceBytes || fact.copiedSha256 !== fact.sourceSha256) {
    gap(
      args.gaps,
      args.requirement,
      "hash_mismatch",
      `${args.source}: copied evidence does not match source bytes`,
      args.source,
    );
  }
  args.copies.push(fact);
  return fact;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function captureRun(
  args: {
    executionRoot: string;
    executionRootReal: string;
    name: string;
    directoryReal: string;
    directory: string;
    options: CaptureOptions;
    gaps: EvidenceGap[];
    copies: EvidenceCopyFact[];
  },
): Promise<RunEvidenceBinding> {
  const binding: RunEvidenceBinding = {
    name: args.name,
    directory: args.directoryReal,
    phase: "unknown",
    runId: null,
    taskId: null,
    record: null,
    source: null,
    inputs: [],
    artifacts: [],
    watchdog: null,
    unavailable: [],
  };
  const recordRequirement = `${args.name} record.json`;
  const recordFact = await captureFile({
    directory: args.directory,
    source: path.join(args.directoryReal, "record.json"),
    relativeTarget: `execution/${args.name}/record.json`,
    requirement: recordRequirement,
    gaps: args.gaps,
    copies: args.copies,
    allowedRoot: args.directoryReal,
  });
  binding.record = recordFact;
  if (recordFact === null) return binding;

  let record: Record<string, any>;
  try {
    record = JSON.parse(await readFile(path.join(args.directoryReal, "record.json"), "utf8")) as Record<string, any>;
  } catch (error) {
    gap(args.gaps, recordRequirement, "read_failure", (error as Error).message, path.join(args.directoryReal, "record.json"));
    return binding;
  }
  binding.phase = typeof record.phase === "string" ? record.phase : "unknown";
  binding.runId = typeof record.runId === "string" && record.runId.length > 0 ? record.runId : null;
  binding.taskId = typeof record.taskId === "string" ? record.taskId : null;
  if (binding.runId === null) {
    gap(args.gaps, recordRequirement, "identity_mismatch", "record has no runId", path.join(args.directoryReal, "record.json"));
  }
  const expectedRunIds = args.options.expectedRunIds;
  if (expectedRunIds !== undefined && expectedRunIds.length > 0
    && (binding.runId === null || !expectedRunIds.includes(binding.runId))) {
    gap(
      args.gaps,
      recordRequirement,
      "identity_mismatch",
      `actual runId ${String(binding.runId)} is not one of the observed runs ${expectedRunIds.join(",")}`,
      path.join(args.directoryReal, "record.json"),
    );
  }
  if (binding.phase !== "completed") {
    // A failure-stage run has not produced these files yet. Record the
    // absence explicitly instead of claiming complete execution evidence.
    binding.unavailable.push(
      `phase=${binding.phase}; source, staged inputs, artifacts and watchdog raw are not yet produced`,
    );
    for (const requirement of ["source", "inputs manifest", "staged inputs", "artifacts", "watchdog raw"]) {
      gap(
        args.gaps,
        `${args.name} ${requirement}`,
        "unavailable",
        `run phase is ${binding.phase}; evidence not yet produced`,
        args.directoryReal,
      );
    }
    return binding;
  }

  // Inputs manifest: mandatory raw bytes plus record/manifest handle binding.
  const inputsRoot = path.join(args.directoryReal, "inputs");
  const manifestPath = path.join(inputsRoot, "manifest.json");
  const manifestRequirement = `${args.name} inputs manifest`;
  const inputsRootReal = await requireRealDirectory(inputsRoot, `${args.name} inputs directory`, args.gaps);
  await captureFile({
    directory: args.directory,
    source: manifestPath,
    relativeTarget: `execution/${args.name}/inputs/manifest.json`,
    requirement: manifestRequirement,
    gaps: args.gaps,
    copies: args.copies,
    allowedRoot: inputsRootReal ?? undefined,
  });
  let manifest: Record<string, any> | null = null;
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("manifest is not an object");
    manifest = parsed;
  } catch (error) {
    gap(args.gaps, manifestRequirement, "read_failure", (error as Error).message, manifestPath);
  }
  if (manifest !== null) {
    if (typeof manifest.runtime !== "string" || manifest.runtime !== record.runtime) {
      gap(
        args.gaps,
        manifestRequirement,
        "identity_mismatch",
        `manifest runtime ${String(manifest.runtime)} does not match record runtime ${String(record.runtime)}`,
        manifestPath,
      );
    }
    let workDirOk = false;
    if (typeof manifest.workDir === "string") {
      try {
        workDirOk = withinOrEqual(args.directoryReal, await realpath(path.resolve(manifest.workDir)));
      } catch {
        workDirOk = false;
      }
    }
    if (!workDirOk) {
      gap(
        args.gaps,
        manifestRequirement,
        "path_escape",
        `manifest workDir is not inside ${args.directoryReal}`,
        manifestPath,
      );
    }
  }

  if (!isRecord(record.source)) {
    gap(args.gaps, `${args.name} source`, "missing", "record.source is missing", args.directoryReal);
  } else {
    const expectedSource: ExpectedFile = {
      bytes: typeof record.source.bytes === "number" ? record.source.bytes : undefined,
      sha256: typeof record.source.sha256 === "string" ? record.source.sha256 : undefined,
    };
    if (expectedSource.bytes === undefined || expectedSource.sha256 === undefined) {
      gap(args.gaps, `${args.name} source`, "missing", "record.source lacks bytes/sha256", args.directoryReal);
    }
    const manifestSourcePath = manifest !== null && typeof manifest.sourcePath === "string"
      ? path.resolve(manifest.sourcePath)
      : null;
    const sourceRoot = path.join(args.directoryReal, "source");
    const sourceRootReal = await requireRealDirectory(sourceRoot, `${args.name} source directory`, args.gaps);
    let sourceReal: string | null = null;
    if (manifestSourcePath === null) {
      gap(
        args.gaps,
        `${args.name} source`,
        manifest === null ? "unavailable" : "identity_mismatch",
        "inputs manifest has no sourcePath",
        manifestPath,
      );
    } else {
      try {
        sourceReal = await realpath(manifestSourcePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        gap(
          args.gaps,
          `${args.name} source`,
          code === "ENOENT" ? "missing" : "read_failure",
          `${manifestSourcePath}: ${(error as Error).message}`,
          manifestSourcePath,
        );
      }
      if (sourceReal !== null && (sourceRootReal === null || !withinOrEqual(sourceRootReal, sourceReal))) {
        gap(
          args.gaps,
          `${args.name} source`,
          "path_escape",
          `manifest sourcePath is outside ${sourceRoot}`,
          manifestSourcePath,
        );
        sourceReal = null;
      }
    }
    if (sourceReal !== null && sourceRootReal !== null) {
      const sourceName = path.basename(manifestSourcePath!);
      const sourceFact = await captureFile({
        directory: args.directory,
        source: sourceReal,
        relativeTarget: `execution/${args.name}/source/${sourceName}`,
        requirement: `${args.name} source`,
        gaps: args.gaps,
        copies: args.copies,
        expected: expectedSource,
        allowedRoot: sourceRootReal,
      });
      if (sourceFact !== null) {
        const providerSources = args.options.providerToolCallSources ?? [];
        const matched = providerSources.some((source) => {
          const bytes = Buffer.from(source, "utf8");
          return bytes.byteLength === sourceFact.sourceBytes && sha256Bytes(bytes) === sourceFact.sourceSha256;
        });
        if (!matched) {
          gap(
            args.gaps,
            `${args.name} source provider binding`,
            providerSources.length === 0 ? "unavailable" : "identity_mismatch",
            providerSources.length === 0
              ? "actual provider tool-call source facts were not supplied"
              : "actual source bytes do not match any provider tool-call source",
            manifestSourcePath!,
          );
        }
        binding.source = {
          sourcePath: manifestSourcePath!,
          target: sourceFact.target,
          bytes: sourceFact.sourceBytes,
          sha256: sourceFact.sourceSha256,
          providerSourceMatched: matched,
        };
      }
    }
  }

  // Staged inputs and explicitly host-authorized originals.
  const recordInputs = Array.isArray(record.inputs) ? record.inputs : [];
  const handleIds = manifest !== null && isRecord(manifest.handles) ? Object.keys(manifest.handles).sort() : [];
  const recordIds = recordInputs
    .map((input: unknown) => (isRecord(input) && typeof input.id === "string" ? input.id : null))
    .filter((id: string | null): id is string => id !== null)
    .sort();
  if (recordIds.length !== recordInputs.length) {
    gap(args.gaps, `${args.name} inputs`, "identity_mismatch", "record input without a string id", args.directoryReal);
  }
  if (new Set(recordIds).size !== recordIds.length) {
    gap(args.gaps, `${args.name} inputs`, "identity_mismatch", "duplicate record input ids", args.directoryReal);
  }
  if (manifest !== null && JSON.stringify(handleIds) !== JSON.stringify(recordIds)) {
    gap(
      args.gaps,
      manifestRequirement,
      "identity_mismatch",
      `manifest handles ${JSON.stringify(handleIds)} do not match record inputs ${JSON.stringify(recordIds)}`,
      manifestPath,
    );
  }
  const whitelist = args.options.authorizedInputPaths ?? [];
  const whitelistReal: string[] = [];
  for (const candidate of whitelist) {
    try {
      whitelistReal.push(await realpath(candidate));
    } catch (error) {
      gap(
        args.gaps,
        `${args.name} authorized input whitelist`,
        "read_failure",
        `${candidate}: ${(error as Error).message}`,
        candidate,
      );
    }
  }
  if (recordInputs.length > 0 && whitelist.length === 0) {
    gap(
      args.gaps,
      `${args.name} authorized input whitelist`,
      "unavailable",
      "no explicit host-authorized original input paths were supplied",
      args.directoryReal,
    );
  }
  if (inputsRootReal !== null) {
    for (const input of recordInputs) {
      if (!isRecord(input)) {
        gap(args.gaps, `${args.name} inputs`, "identity_mismatch", "input is not an object", args.directoryReal);
        continue;
      }
      const id = typeof input.id === "string" ? input.id : "unknown";
      const requirement = `${args.name} input ${id}`;
      const expected: ExpectedFile = {
        bytes: typeof input.bytes === "number" ? input.bytes : undefined,
        sha256: typeof input.sha256 === "string" ? input.sha256 : undefined,
      };
      if (expected.bytes === undefined || expected.sha256 === undefined) {
        gap(args.gaps, requirement, "missing", "record input lacks bytes/sha256", args.directoryReal);
      }
      if (typeof input.stagedPath !== "string") {
        gap(args.gaps, requirement, "missing", "record input has no stagedPath", args.directoryReal);
        continue;
      }
      const stagedPath = path.resolve(input.stagedPath);
      let stagedReal: string;
      try {
        stagedReal = await realpath(stagedPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        gap(
          args.gaps,
          requirement,
          code === "ENOENT" ? "missing" : "read_failure",
          `${stagedPath}: ${(error as Error).message}`,
          stagedPath,
        );
        continue;
      }
      if (!withinOrEqual(inputsRootReal, stagedReal)) {
        gap(args.gaps, requirement, "path_escape", `stagedPath is outside ${inputsRoot}`, stagedPath);
        continue;
      }
      const stagedFact = await captureFile({
        directory: args.directory,
        source: stagedReal,
        relativeTarget: `execution/${args.name}/inputs/${path.basename(stagedPath)}`,
        requirement: `${requirement} staged`,
        gaps: args.gaps,
        copies: args.copies,
        expected,
        allowedRoot: inputsRootReal,
      });
      if (manifest !== null && isRecord(manifest.handles)) {
        const handle = manifest.handles[id];
        if (!isRecord(handle)) {
          gap(args.gaps, requirement, "identity_mismatch", "manifest handle is missing", manifestPath);
        } else {
          if (typeof handle.path !== "string") {
            gap(args.gaps, requirement, "identity_mismatch", "manifest handle has no path", manifestPath);
          } else {
            try {
              const handleReal = await realpath(handle.path);
              if (handleReal !== stagedReal) {
                gap(args.gaps, requirement, "identity_mismatch", "manifest handle path differs from stagedPath", manifestPath);
              }
            } catch (error) {
              gap(args.gaps, requirement, "read_failure", (error as Error).message, manifestPath);
            }
          }
          if (handle.bytes !== expected.bytes || handle.sha256 !== expected.sha256) {
            gap(args.gaps, requirement, "hash_mismatch", "manifest handle bytes/sha256 differ from record input", manifestPath);
          }
        }
      }
      let authorizedTarget: string | null = null;
      if (typeof input.sourcePath !== "string") {
        gap(args.gaps, requirement, "missing", "record input has no sourcePath", args.directoryReal);
      } else {
        const sourcePath = path.resolve(input.sourcePath);
        let sourceReal: string | null = null;
        try {
          sourceReal = await realpath(sourcePath);
        } catch (error) {
          gap(args.gaps, requirement, "read_failure", `${sourcePath}: ${(error as Error).message}`, sourcePath);
        }
        if (sourceReal !== null && !whitelistReal.includes(sourceReal)) {
          gap(
            args.gaps,
            requirement,
            "identity_mismatch",
            "original input is not in the explicit host-authorized whitelist",
            sourcePath,
          );
        } else if (sourceReal !== null) {
          const authorizedFact = await captureFile({
            directory: args.directory,
            source: sourcePath,
            relativeTarget: `host-inputs/${id}/${path.basename(sourcePath)}`,
            requirement: `${requirement} authorized original`,
            gaps: args.gaps,
            copies: args.copies,
            expected,
          });
          authorizedTarget = authorizedFact?.target ?? null;
        }
      }
      binding.inputs.push({
        id,
        sourcePath: typeof input.sourcePath === "string" ? input.sourcePath : "",
        stagedPath,
        authorizedTarget,
        stagedTarget: stagedFact?.target ?? "",
        bytes: expected.bytes ?? -1,
        sha256: expected.sha256 ?? "",
      });
    }
  }

  // Artifacts: archiveRef is relative to executionRoot, not the run directory.
  if (!Array.isArray(record.artifacts)) {
    gap(args.gaps, `${args.name} artifacts`, "missing", "record.artifacts is missing", args.directoryReal);
  } else {
    const artifactsRoot = path.join(args.directoryReal, "artifacts");
    const artifactsRootReal = await requireRealDirectory(artifactsRoot, `${args.name} artifacts directory`, args.gaps);
    for (const artifact of record.artifacts) {
      if (!isRecord(artifact) || typeof artifact.archiveRef !== "string") {
        gap(args.gaps, `${args.name} artifacts`, "identity_mismatch", "artifact has no archiveRef", args.directoryReal);
        continue;
      }
      const archiveRef = artifact.archiveRef;
      if (path.isAbsolute(archiveRef) || !archiveRef.startsWith(`${args.name}/artifacts/`)) {
        gap(
          args.gaps,
          `${args.name} artifact ${String(artifact.artifactId)}`,
          "path_escape",
          `archiveRef is not confined to ${args.name}/artifacts`,
          archiveRef,
        );
        continue;
      }
      let resolved: string;
      try {
        resolved = safeRelativeTarget(args.executionRootReal, archiveRef);
      } catch (error) {
        gap(
          args.gaps,
          `${args.name} artifact ${String(artifact.artifactId)}`,
          "path_escape",
          (error as Error).message,
          archiveRef,
        );
        continue;
      }
      if (artifactsRootReal === null) continue;
      const expected: ExpectedFile = {
        bytes: typeof artifact.bytes === "number" ? artifact.bytes : undefined,
        sha256: typeof artifact.sha256 === "string" ? artifact.sha256 : undefined,
      };
      const fact = await captureFile({
        directory: args.directory,
        source: resolved,
        relativeTarget: `execution/${archiveRef}`,
        requirement: `${args.name} artifact ${String(artifact.artifactId)}`,
        gaps: args.gaps,
        copies: args.copies,
        expected,
        allowedRoot: artifactsRootReal,
      });
      if (fact !== null) {
        binding.artifacts.push({
          artifactId: typeof artifact.artifactId === "string" ? artifact.artifactId : "unknown",
          archiveRef,
          target: fact.target,
          bytes: fact.sourceBytes,
          sha256: fact.sourceSha256,
        });
      }
    }
  }

  // Watchdog raw log and process identity facts.
  const watchdog = record.watchdog;
  if (!isRecord(watchdog)) {
    gap(args.gaps, `${args.name} watchdog`, "missing", "record.watchdog is missing", args.directoryReal);
  } else {
    const process = isRecord(record.process) ? record.process : null;
    const watchdogBinding: RunEvidenceBinding["watchdog"] = {
      logRef: typeof watchdog.logRef === "string" ? watchdog.logRef : null,
      target: null,
      logAvailable: watchdog.logAvailable === true,
      pid: typeof process?.pid === "number" ? Number(process.pid) : null,
      pgid: typeof process?.pid === "number" && typeof process?.pgid === "number" ? Number(process.pgid) : null,
      scriptPid: typeof watchdog.scriptPid === "number" ? Number(watchdog.scriptPid) : null,
      supervisorPid: typeof watchdog.supervisorPid === "number" ? Number(watchdog.supervisorPid) : null,
      watchdogPid: typeof watchdog.watchdogPid === "number" ? Number(watchdog.watchdogPid) : null,
      groupGone: process !== null && typeof process.groupGone === "boolean" ? process.groupGone : null,
    };
    binding.watchdog = watchdogBinding;
    if (process === null || process.spawned !== true
      || !Number.isSafeInteger(watchdogBinding.pid) || (watchdogBinding.pid ?? 0) <= 1
      || watchdogBinding.pgid !== watchdogBinding.pid
      || watchdogBinding.scriptPid !== watchdogBinding.pid
      || watchdog.armed !== true
      || !Number.isSafeInteger(watchdogBinding.watchdogPid) || (watchdogBinding.watchdogPid ?? 0) <= 1) {
      gap(
        args.gaps,
        `${args.name} process identity`,
        "identity_mismatch",
        "record process/watchdog identity is incomplete or inconsistent",
        path.join(args.directoryReal, "record.json"),
      );
    }
    if (watchdogBinding.logAvailable) {
      if (watchdogBinding.logRef === null || path.isAbsolute(watchdogBinding.logRef)
        || !watchdogBinding.logRef.startsWith(`${args.name}/`)) {
        gap(
          args.gaps,
          `${args.name} watchdog raw`,
          "path_escape",
          "watchdog logRef is not confined to the same run",
          String(watchdogBinding.logRef),
        );
      } else {
        let logPath: string;
        try {
          logPath = safeRelativeTarget(args.executionRootReal, watchdogBinding.logRef);
        } catch (error) {
          gap(args.gaps, `${args.name} watchdog raw`, "path_escape", (error as Error).message, watchdogBinding.logRef);
          logPath = "";
        }
        if (logPath !== "") {
          const fact = await captureFile({
            directory: args.directory,
            source: logPath,
            relativeTarget: `execution/${watchdogBinding.logRef}`,
            requirement: `${args.name} watchdog raw`,
            gaps: args.gaps,
            copies: args.copies,
            allowedRoot: args.directoryReal,
          });
          watchdogBinding.target = fact?.target ?? null;
        }
      }
    } else {
      gap(
        args.gaps,
        `${args.name} watchdog raw`,
        "unavailable",
        `record.watchdog.logAvailable is ${String(watchdog.logAvailable)}`,
        args.directoryReal,
      );
    }
  }
  return binding;
}

async function captureExecution(
  args: {
    instance: NonNullable<DailyOmpSession["instance"]>;
    directory: string;
    options: CaptureOptions;
    gaps: EvidenceGap[];
    copies: EvidenceCopyFact[];
  },
): Promise<RunEvidenceBinding[]> {
  const executionRootReal = await requireRealDirectory(
    args.instance.executionRoot,
    "execution root",
    args.gaps,
  );
  if (executionRootReal === null) return [];
  const bindings: RunEvidenceBinding[] = [];
  let names: string[];
  try {
    names = await readdir(executionRootReal);
  } catch (error) {
    gap(args.gaps, "execution root", "read_failure", (error as Error).message, executionRootReal);
    return bindings;
  }
  for (const name of names.filter((entry) => entry.startsWith("run-")).sort()) {
    const directory = path.join(executionRootReal, name);
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      gap(args.gaps, `${name} directory`, "read_failure", (error as Error).message, directory);
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      gap(args.gaps, `${name} directory`, "path_escape", `${directory} is not a real directory`, directory);
      continue;
    }
    const directoryReal = await realpath(directory);
    if (!withinOrEqual(executionRootReal, directoryReal)) {
      gap(args.gaps, `${name} directory`, "path_escape", `${directoryReal} escapes ${executionRootReal}`, directory);
      continue;
    }
    bindings.push(await captureRun({
      executionRoot: args.instance.executionRoot,
      executionRootReal,
      name,
      directoryReal,
      directory: args.directory,
      options: args.options,
      gaps: args.gaps,
      copies: args.copies,
    }));
  }
  const observed = new Set(bindings.map((binding) => binding.runId).filter((value): value is string => value !== null));
  for (const expected of args.options.expectedRunIds ?? []) {
    if (!observed.has(expected)) {
      gap(args.gaps, `run ${expected}`, "missing", "observed run has no retained execution record", executionRootReal);
    }
  }
  return bindings;
}

async function captureTree(
  args: {
    rootReal: string;
    kind: "delivery" | "acceptance";
    files: Array<{ path: string; relativePath: string; bytes: number; sha256: string }>;
    expectedPaths: string[] | undefined;
    directory: string;
    gaps: EvidenceGap[];
    copies: EvidenceCopyFact[];
  },
): Promise<void> {
  const captured = new Set<string>();
  for (const file of args.files) {
    const fact = await captureFile({
      directory: args.directory,
      source: file.path,
      relativeTarget: `${args.kind}/${file.relativePath}`,
      requirement: `${args.kind} ${file.relativePath}`,
      gaps: args.gaps,
      copies: args.copies,
      expected: { bytes: file.bytes, sha256: file.sha256 },
      allowedRoot: args.rootReal,
    });
    if (fact !== null) {
      try {
        captured.add(await realpath(file.path));
      } catch {
        captured.add(path.resolve(file.path));
      }
    }
  }
  for (const expected of args.expectedPaths ?? []) {
    let real: string;
    try {
      real = await realpath(expected);
    } catch (error) {
      gap(args.gaps, `${args.kind} ${expected}`, "missing", (error as Error).message, expected);
      continue;
    }
    if (!captured.has(real)) {
      gap(args.gaps, `${args.kind} ${expected}`, "missing", "expected file was not captured", expected);
    }
  }
}

/** Copy the raw product/session facts before cleanup can remove the runtime root. */
export async function captureSessionEvidence(
  evidenceRoot: string,
  label: string,
  session: DailyOmpSession,
  extra: Record<string, unknown> = {},
  options: CaptureOptions = {},
): Promise<SessionEvidenceCapture> {
  const directory = path.join(evidenceRoot, label);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const capturedAt = new Date().toISOString();
  const snapshot = await session.snapshot();
  await writeJson(path.join(directory, "session.json"), {
    label,
    capturedAt,
    cleanupPhase: "precleanup",
    launch: session.launchDescriptor(),
    snapshot,
    ...extra,
  });
  const gaps: EvidenceGap[] = [];
  const copies: EvidenceCopyFact[] = [];
  const runs: RunEvidenceBinding[] = [];

  // Every launched session owns a provider and observer audit file. These are
  // required raw facts, not optional copies.
  await captureFile({
    directory,
    source: session.providerAuditPath,
    relativeTarget: "provider-audit.jsonl",
    requirement: "provider audit",
    gaps,
    copies,
  });
  await captureFile({
    directory,
    source: session.observerAuditPath,
    relativeTarget: "observer-audit.jsonl",
    requirement: "observer audit",
    gaps,
    copies,
  });

  const instance = session.instance;
  if (instance !== undefined) {
    const instanceRootReal = await requireRealDirectory(instance.root, "instance root", gaps);
    const executionRootReal = await requireRealDirectory(instance.executionRoot, "execution root", gaps);
    const deliveryRootReal = await requireRealDirectory(instance.deliveryRoot, "delivery root", gaps);
    const acceptanceRootReal = await requireRealDirectory(instance.acceptanceRoot, "acceptance root", gaps);
    await captureFile({
      directory,
      source: instance.statePath,
      relativeTarget: "task-state.json",
      requirement: "task state",
      gaps,
      copies,
      allowedRoot: instanceRootReal ?? undefined,
    });
    await captureFile({
      directory,
      source: instance.auditPath,
      relativeTarget: "audit.jsonl",
      requirement: "execution audit",
      gaps,
      copies,
      allowedRoot: instanceRootReal ?? undefined,
    });
    if (executionRootReal !== null) {
      runs.push(...await captureExecution({ instance, directory, options, gaps, copies }));
    }
    if (deliveryRootReal !== null) {
      await captureTree({
        rootReal: deliveryRootReal,
        kind: "delivery",
        files: await session.deliveryFiles(),
        expectedPaths: options.expectedDeliveryPaths,
        directory,
        gaps,
        copies,
      });
    }
    if (acceptanceRootReal !== null) {
      await captureTree({
        rootReal: acceptanceRootReal,
        kind: "acceptance",
        files: await session.acceptanceFiles(),
        expectedPaths: undefined,
        directory,
        gaps,
        copies,
      });
    }
  }

  const complete = gaps.length === 0;
  const indexFile = path.join(directory, "capture-index.json");
  await writeJson(indexFile, {
    label,
    capturedAt,
    cleanupPhase: "precleanup",
    complete,
    copies,
    gaps,
    runs,
    completedRuns: runs.filter((run) => run.phase === "completed").length,
  });
  return {
    label,
    directory,
    capturedAt,
    cleanupPhase: "precleanup",
    complete,
    snapshot,
    copies,
    gaps,
    runs,
    completedRuns: runs.filter((run) => run.phase === "completed").length,
    indexFile,
  };
}

export async function captureShutdown(
  evidenceRoot: string,
  label: string,
  shutdown: Record<string, unknown>,
): Promise<void> {
  await writeJson(path.join(evidenceRoot, label, "shutdown.json"), shutdown);
}
