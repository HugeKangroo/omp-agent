import path from "node:path";
import {
  clonePlain,
  deepFreeze,
  nodeFileIo,
  sha256Hex,
  type NativeFileHandle,
  type NativeFileIo,
  type NativeFileStats,
} from "./native-work.ts";

/**
 * Explicit, host-selected Agent Markdown preflight.
 *
 * This module owns no YAML parser, model loop, tool registry or Skill loader.
 * The host supplies the fixed OMP native parser/resolver ports. Selection is by
 * one absolute file path, not by Agent name; `origin` therefore states
 * `explicit-host-path` and never claims native discovery provenance.
 *
 * The snapshot freezes only initial definition/Skill text. It is not a
 * filesystem sandbox, permission grant, or freeze of scripts, templates or
 * `skill://` resources referenced by that text.
 *
 * Initial definition frontmatter is exactly `name`, `description`, `tools`,
 * `model` and `autoloadSkills`; every other field is rejected by name. There
 * are no profession/name branches. Omitted `tools` preserves the host active
 * set and explicit tool names must match that set exactly. One model selector
 * is accepted: an exact `provider/id` must resolve to the same identity, while
 * a bare or `@role` native selector keeps its original spelling and records the
 * resolved identity. Thinking/routing suffixes are rejected, not dropped.
 */

export const DEFINITION_SNAPSHOT_SCHEMA = "omp-agent.definition-snapshot.v1";
export const DEFINITION_FREEZE_SCOPE = "initial-text";
export const DEFINITION_ORIGIN = "explicit-host-path";
export const MAX_DEFINITION_BYTES = 64 * 1024;
export const MAX_SKILLS = 8;
export const MAX_SKILL_BYTES = 256 * 1024;
export const MAX_INITIAL_TEXT_BYTES = 1024 * 1024;

const MAX_ERROR_MESSAGE_CHARS = 320;
const MAX_PATH_CHARS = 4096;
const SUPPORTED_DEFINITION_FIELDS = new Set(["name", "description", "tools", "model", "autoloadSkills"]);

export type DefinitionErrorCode =
  | "invalid-options"
  | "invalid-definition-path"
  | "invalid-workspace-root"
  | "file-missing"
  | "file-unsafe"
  | "file-unreadable"
  | "file-too-large"
  | "file-changed"
  | "invalid-text"
  | "native-parse-failed"
  | "invalid-definition"
  | "unsupported-fields"
  | "parser-disagreement"
  | "missing-name"
  | "missing-description"
  | "empty-body"
  | "invalid-tools"
  | "duplicate-tool"
  | "unknown-tool"
  | "invalid-model"
  | "unresolved-model"
  | "model-not-exact"
  | "model-suffix-unsupported"
  | "multiple-models"
  | "invalid-skills"
  | "skill-limit"
  | "skill-missing"
  | "skill-ambiguous"
  | "skill-duplicate"
  | "skill-metadata-mismatch"
  | "total-too-large";

/** Stable preflight failure. Message is bounded; fields are diagnostic names only. */
export class DefinitionError extends Error {
  override name = "DefinitionError";
  readonly code: DefinitionErrorCode;
  readonly fields: readonly string[];

  constructor(code: DefinitionErrorCode, message: string, fields: readonly string[] = []) {
    super(boundMessage(message));
    this.code = code;
    this.fields = Object.freeze(fields.slice(0, 16));
  }
}

export interface DefinitionModelRef {
  readonly provider: string;
  readonly id: string;
}

export interface DefinitionModelSnapshot extends DefinitionModelRef {
  /** Original native selector, or null when the host current model was used. */
  readonly selector: string | null;
  readonly selectorKind: "host-current" | "provider-id" | "native-selector";
}

/** Minimal native parseAgent result shape; extra native fields are not needed here. */
export interface NativeParsedAgent {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly systemPrompt?: unknown;
  readonly tools?: unknown;
  readonly model?: unknown;
  readonly autoloadSkills?: unknown;
}

export interface NativeFrontmatterResult {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

export type ParseAgentPort = (
  filePath: string,
  content: string,
  source: string,
  level: "fatal",
) => NativeParsedAgent;

export type ParseFrontmatterPort = (
  content: string,
  options: { readonly location: string; readonly level: "fatal" },
) => NativeFrontmatterResult;

export type ResolveModelPort = (selector: string) => DefinitionModelRef | undefined;

export interface DefinitionSkillMetadata {
  readonly name: string;
  readonly filePath: string;
  readonly description: string;
}

export interface LoadDefinitionSnapshotOptions {
  /** Absolute host-selected Agent Markdown file; duplicates are disambiguated by path. */
  readonly definitionPath: string;
  /** Existing absolute workspace root, used as a host fact and never as task authority. */
  readonly workspaceRoot: string;
  readonly parseAgent: ParseAgentPort;
  readonly parseFrontmatter: ParseFrontmatterPort;
  /** Actual native Skill metadata from loadSkills. */
  readonly availableSkills: readonly DefinitionSkillMetadata[];
  /** Current host active tool names, excluding plugin companion controls. */
  readonly availableTools: readonly string[];
  readonly currentModel: DefinitionModelRef;
  readonly resolveModel: ResolveModelPort;
  /**
   * Normalization label passed to native parseAgent. It is not provenance and
   * is deliberately excluded from the snapshot version.
   */
  readonly nativeSource?: string;
  /** Narrow file seam used only by tests; defaults to the OMP-neutral node reader. */
  readonly fileIo?: NativeFileIo;
}

export interface DefinitionDocumentSnapshot {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly rawContent: string;
  readonly bytes: number;
  readonly sha256: string;
  /** null means the definition omitted tools and preserves the host active set. */
  readonly requestedTools: readonly string[] | null;
  readonly effectiveTools: readonly string[];
  readonly model: DefinitionModelSnapshot;
  readonly autoloadSkills: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

export interface DefinitionSkillSnapshot {
  readonly name: string;
  readonly description: string;
  readonly canonicalPath: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly rawContent: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

export interface DefinitionSnapshotStatus {
  readonly schema: typeof DEFINITION_SNAPSHOT_SCHEMA;
  readonly origin: typeof DEFINITION_ORIGIN;
  readonly freezeScope: typeof DEFINITION_FREEZE_SCOPE;
  readonly version: string;
  readonly workspaceRoot: string;
  readonly definition: {
    readonly name: string;
    readonly canonicalPath: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly effectiveTools: readonly string[];
    readonly model: DefinitionModelSnapshot;
    readonly autoloadSkills: readonly string[];
  };
  readonly skills: readonly {
    readonly name: string;
    readonly canonicalPath: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
}

export interface DefinitionSnapshot {
  readonly schema: typeof DEFINITION_SNAPSHOT_SCHEMA;
  readonly origin: typeof DEFINITION_ORIGIN;
  readonly freezeScope: typeof DEFINITION_FREEZE_SCOPE;
  readonly version: string;
  readonly workspaceRoot: string;
  /** Normalization label only; not discovery provenance. */
  readonly nativeSourceLabel: string;
  readonly definition: DefinitionDocumentSnapshot;
  readonly skills: readonly DefinitionSkillSnapshot[];
  /** Fresh immutable status copy; mutating it cannot change this snapshot. */
  getStatus(): DefinitionSnapshotStatus;
}

interface BoundedFile {
  canonicalPath: string;
  bytes: number;
  sha256: string;
  rawContent: string;
}

interface DirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

interface ToolSelection {
  requested: string[] | null;
  effective: string[];
}

function boundMessage(value: string): string {
  const normalized = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_ERROR_MESSAGE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_ERROR_MESSAGE_CHARS - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function sameFileSignature(left: NativeFileStats, right: NativeFileStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function absoluteHostPath(value: unknown, label: string, code: DefinitionErrorCode): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PATH_CHARS
    || value.includes("\0")
    || !path.isAbsolute(value)) {
    throw new DefinitionError(code, `${label} must be one explicit absolute path.`);
  }
  const resolved = path.resolve(value);
  if (resolved !== value) {
    throw new DefinitionError(code, `${label} must be a normalized absolute path.`);
  }
  return resolved;
}

async function resolveWorkspaceRoot(value: unknown, io: NativeFileIo): Promise<string> {
  const root = absoluteHostPath(value, "workspaceRoot", "invalid-workspace-root");
  let info: NativeFileStats;
  try {
    info = await io.lstat(root, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new DefinitionError("invalid-workspace-root", "workspaceRoot is missing.");
    }
    throw new DefinitionError("invalid-workspace-root", "workspaceRoot could not be inspected.");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new DefinitionError("invalid-workspace-root", "workspaceRoot must be a real directory, not a link.");
  }
  let canonical: string;
  try {
    canonical = await io.realpath(root);
  } catch {
    throw new DefinitionError("invalid-workspace-root", "workspaceRoot could not be resolved.");
  }
  if (canonical !== root) {
    throw new DefinitionError("invalid-workspace-root", "workspaceRoot must not traverse symbolic links.");
  }
  return canonical;
}

async function inspectParent(
  io: NativeFileIo,
  absolute: string,
  label: string,
): Promise<DirectoryIdentity[]> {
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  if (segments.length === 0) {
    throw new DefinitionError("file-unsafe", `${label} path does not name a file.`);
  }
  const directories: DirectoryIdentity[] = [];
  let current = parsed.root;
  for (const segment of segments.slice(0, -1)) {
    if (segment === "." || segment === "..") {
      throw new DefinitionError("file-unsafe", `${label} path contains an unsupported segment.`);
    }
    current = path.join(current, segment);
    let info: NativeFileStats;
    try {
      info = await io.lstat(current, { bigint: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new DefinitionError("file-missing", `${label} parent directory is missing.`);
      if (isErrno(error, "ENOTDIR") || isErrno(error, "ELOOP")) {
        throw new DefinitionError("file-unsafe", `${label} path traverses a link or non-directory.`);
      }
      throw new DefinitionError("file-unreadable", `${label} parent directory could not be inspected.`);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new DefinitionError("file-unsafe", `${label} path traverses a symbolic link or non-directory.`);
    }
    directories.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return directories;
}

async function recheckParents(io: NativeFileIo, directories: readonly DirectoryIdentity[], label: string): Promise<void> {
  for (const directory of directories) {
    let canonical: string;
    try {
      canonical = await io.realpath(directory.path);
    } catch {
      throw new DefinitionError("file-changed", `${label} changed while it was being read.`);
    }
    if (canonical !== directory.path) {
      throw new DefinitionError("file-unsafe", `${label} path now traverses a symbolic link.`);
    }
    let info: NativeFileStats;
    try {
      info = await io.lstat(directory.path, { bigint: true });
    } catch {
      throw new DefinitionError("file-changed", `${label} changed while it was being read.`);
    }
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== directory.dev || info.ino !== directory.ino) {
      throw new DefinitionError("file-changed", `${label} parent changed while it was being read.`);
    }
  }
}

/**
 * Reads one host-selected absolute text file. Every existing path component is
 * checked with lstat and realpath; the final component is opened with O_NOFOLLOW
 * and its inode/size/timestamps are compared before and after the read. This is
 * a best-effort read check, not an atomic filesystem transaction.
 */
async function readBoundedFile(
  io: NativeFileIo,
  requestedPath: string,
  label: string,
  maxBytes: number,
  requiredBasename?: string,
): Promise<BoundedFile> {
  const absolute = absoluteHostPath(requestedPath, label, "invalid-definition-path");
  if (requiredBasename !== undefined && path.basename(absolute) !== requiredBasename) {
    throw new DefinitionError("file-unsafe", `${label} must reference ${requiredBasename}.`);
  }
  const directories = await inspectParent(io, absolute, label);

  let before: NativeFileStats;
  try {
    before = await io.lstat(absolute, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new DefinitionError("file-missing", `${label} file is missing.`);
    if (isErrno(error, "ENOTDIR") || isErrno(error, "ELOOP")) {
      throw new DefinitionError("file-unsafe", `${label} is a link or non-file.`);
    }
    throw new DefinitionError("file-unreadable", `${label} file could not be inspected.`);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new DefinitionError("file-unsafe", `${label} must be a regular non-link file.`);
  }
  if (before.size > BigInt(maxBytes)) {
    throw new DefinitionError("file-too-large", `${label} exceeds ${maxBytes} bytes.`);
  }
  let canonicalBefore: string;
  try {
    canonicalBefore = await io.realpath(absolute);
  } catch {
    throw new DefinitionError("file-changed", `${label} disappeared while it was being inspected.`);
  }
  if (canonicalBefore !== absolute) {
    throw new DefinitionError("file-unsafe", `${label} path traverses a symbolic link.`);
  }

  let handle: NativeFileHandle;
  try {
    handle = await io.open(absolute, io.O_RDONLY | io.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new DefinitionError("file-missing", `${label} file is missing.`);
    if (isErrno(error, "ELOOP")) throw new DefinitionError("file-unsafe", `${label} is a symbolic link.`);
    throw new DefinitionError("file-unreadable", `${label} file could not be opened.`);
  }

  try {
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile()) throw new DefinitionError("file-unsafe", `${label} is not a regular file.`);
      if (!sameFileSignature(before, opened)) {
        throw new DefinitionError("file-changed", `${label} changed before it was read.`);
      }
      if (opened.size > BigInt(maxBytes)) {
        throw new DefinitionError("file-too-large", `${label} exceeds ${maxBytes} bytes.`);
      }
      const size = Number(opened.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new DefinitionError("file-too-large", `${label} has an unsupported size.`);
      }
      const buffer = new Uint8Array(size);
      let read = 0;
      while (read < size) {
        const result = await handle.read(buffer, read, size - read, read);
        if (result.bytesRead <= 0) break;
        read += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (read !== size || !sameFileSignature(opened, after)) {
        throw new DefinitionError("file-changed", `${label} changed while it was being read.`);
      }
      await recheckParents(io, directories, label);
      let finalAtPath: NativeFileStats;
      try {
        finalAtPath = await io.lstat(absolute, { bigint: true });
      } catch {
        throw new DefinitionError("file-changed", `${label} disappeared while it was being read.`);
      }
      if (finalAtPath.isSymbolicLink() || !finalAtPath.isFile() || !sameFileSignature(opened, finalAtPath)) {
        throw new DefinitionError("file-changed", `${label} changed while it was being read.`);
      }
      let canonicalAfter: string;
      try {
        canonicalAfter = await io.realpath(absolute);
      } catch {
        throw new DefinitionError("file-changed", `${label} disappeared while it was being read.`);
      }
      if (canonicalAfter !== absolute) {
        throw new DefinitionError("file-changed", `${label} path changed while it was being read.`);
      }
      if (buffer.includes(0)) {
        throw new DefinitionError("invalid-text", `${label} contains a NUL byte.`);
      }
      let rawContent: string;
      try {
        rawContent = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        throw new DefinitionError("invalid-text", `${label} is not valid UTF-8.`);
      }
      return {
        canonicalPath: absolute,
        bytes: read,
        sha256: sha256Hex(buffer),
        rawContent,
      };
    } catch (error) {
      if (error instanceof DefinitionError) throw error;
      throw new DefinitionError("file-unreadable", `${label} could not be read.`);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) throw new DefinitionError("invalid-definition", "Snapshot metadata contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (type !== "object") {
    throw new DefinitionError("invalid-definition", "Snapshot metadata must contain only plain JSON values.");
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DefinitionError("invalid-definition", "Snapshot metadata must contain only plain objects.");
  }
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function freezeFrontmatter(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new DefinitionError("invalid-definition", `${label} frontmatter must be an object.`);
  }
  let copy: Record<string, unknown>;
  try {
    copy = clonePlain(value);
    canonicalJson(copy);
  } catch (error) {
    if (error instanceof DefinitionError) throw error;
    throw new DefinitionError("invalid-definition", `${label} frontmatter is not plain JSON metadata.`);
  }
  return deepFreeze(copy);
}

function nonEmptyString(value: unknown, label: string, code: DefinitionErrorCode): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DefinitionError(code, `${label} must be a non-empty string.`);
  }
  return value;
}

function meaningfulToolName(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\x00-\x20\x7f]/.test(value)) {
    throw new DefinitionError("invalid-tools", `${label} must be one non-empty tool name without whitespace.`);
  }
  return value;
}

function validateNameList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new DefinitionError("invalid-options", `${label} must be an array.`);
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of value) {
    const name = meaningfulToolName(entry, label);
    if (seen.has(name)) {
      throw new DefinitionError("invalid-options", `${label} contains duplicate name ${JSON.stringify(name)}.`);
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function validateCurrentModel(value: unknown): DefinitionModelRef {
  if (!isRecord(value)) throw new DefinitionError("invalid-options", "currentModel is required.");
  const provider = nonEmptyString(value.provider, "currentModel.provider", "invalid-options");
  const id = nonEmptyString(value.id, "currentModel.id", "invalid-options");
  return { provider, id };
}

function validateModelRef(value: unknown, selector: string): DefinitionModelRef {
  if (!isRecord(value)) {
    throw new DefinitionError("unresolved-model", `Model resolver returned no exact model for ${JSON.stringify(selector)}.`);
  }
  if (typeof value.provider !== "string" || value.provider.length === 0
    || typeof value.id !== "string" || value.id.length === 0) {
    throw new DefinitionError("unresolved-model", `Model resolver returned an invalid identity for ${JSON.stringify(selector)}.`);
  }
  return { provider: value.provider, id: value.id };
}

function parseTools(
  rawFrontmatter: Record<string, unknown>,
  parsedTools: unknown,
  availableTools: readonly string[],
): ToolSelection {
  const hasTools = hasOwn(rawFrontmatter, "tools");
  const declared = hasTools ? rawFrontmatter.tools : undefined;
  if (hasTools && declared === null) {
    throw new DefinitionError("invalid-tools", "tools must be omitted or name tools; explicit null is unsupported.");
  }
  if (hasTools) {
    if (typeof declared === "string") {
      if (declared.trim().length === 0) {
        throw new DefinitionError("invalid-tools", "tools declaration must name at least one tool.");
      }
    } else if (Array.isArray(declared)) {
      for (const entry of declared) {
        if (typeof entry !== "string") {
          throw new DefinitionError("invalid-tools", "tools declaration must contain only strings.");
        }
      }
    } else {
      throw new DefinitionError("invalid-tools", "tools declaration must be an array or comma-separated string.");
    }
  }

  if (parsedTools === undefined) {
    if (!hasTools) return { requested: null, effective: [...availableTools].sort() };
    if (Array.isArray(declared) && declared.length === 0) {
      return { requested: [], effective: [] };
    }
    throw new DefinitionError("parser-disagreement", "Native parser omitted a declared tools list.");
  }
  if (!Array.isArray(parsedTools)) {
    throw new DefinitionError("invalid-tools", "Native parser returned a non-array tools value.");
  }
  const seen = new Set<string>();
  const requested: string[] = [];
  for (const entry of parsedTools) {
    const name = meaningfulToolName(entry, "tools entry");
    if (seen.has(name)) {
      throw new DefinitionError("duplicate-tool", `tools contains duplicate name ${JSON.stringify(name)}.`);
    }
    seen.add(name);
    requested.push(name);
  }
  const available = new Set(availableTools);
  const unknown = requested.filter((name) => !available.has(name)).sort();
  if (unknown.length > 0) {
    throw new DefinitionError(
      "unknown-tool",
      `Requested tools are not currently active: ${unknown.slice(0, 8).join(", ")}.`,
      unknown,
    );
  }
  return { requested, effective: [...requested].sort() };
}

function parseModel(
  rawFrontmatter: Record<string, unknown>,
  parsedModel: unknown,
  currentModel: DefinitionModelRef,
  resolveModel: ResolveModelPort,
): DefinitionModelSnapshot {
  const hasModel = hasOwn(rawFrontmatter, "model");
  const declared = hasModel ? rawFrontmatter.model : undefined;
  if (hasModel && declared === null) {
    throw new DefinitionError("invalid-model", "model must be omitted or name one selector; explicit null is unsupported.");
  }
  if (hasModel) {
    if (typeof declared === "string") {
      if (declared.trim().length === 0) {
        throw new DefinitionError("invalid-model", "model declaration must name one selector.");
      }
    } else if (Array.isArray(declared)) {
      if (declared.length === 0) {
        throw new DefinitionError("invalid-model", "model declaration must not be an empty array.");
      }
      for (const entry of declared) {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          throw new DefinitionError("invalid-model", "model declaration must contain non-empty strings.");
        }
      }
    } else {
      throw new DefinitionError("invalid-model", "model declaration must be a string or array.");
    }
  }

  if (parsedModel === undefined) {
    if (hasModel) {
      throw new DefinitionError("parser-disagreement", "Native parser omitted a declared model selector.");
    }
    return {
      selector: null,
      selectorKind: "host-current",
      provider: currentModel.provider,
      id: currentModel.id,
    };
  }
  if (!Array.isArray(parsedModel) || parsedModel.length === 0) {
    throw new DefinitionError("invalid-model", "Native parser returned no usable model selector.");
  }
  if (parsedModel.length > 1) {
    throw new DefinitionError(
      "multiple-models",
      `Definition declares ${parsedModel.length} model selectors; exactly one is supported.`,
    );
  }
  const rawSelector = parsedModel[0];
  if (typeof rawSelector !== "string"
    || rawSelector.length === 0
    || rawSelector.trim() !== rawSelector
    || /[\x00-\x20\x7f]/.test(rawSelector)) {
    throw new DefinitionError("invalid-model", "Native parser returned an invalid model selector.");
  }
  const selector = rawSelector;

  if ((selector.includes("@") && !selector.startsWith("@")) || selector.slice(1).includes("@")) {
    throw new DefinitionError(
      "model-suffix-unsupported",
      `Model selector ${JSON.stringify(selector)} uses an unsupported routing suffix.`,
    );
  }
  if (selector.includes(":")) {
    throw new DefinitionError(
      "model-suffix-unsupported",
      `Model selector ${JSON.stringify(selector)} uses an unsupported thinking/routing suffix.`,
    );
  }

  if (selector.includes("/")) {
    const slash = selector.indexOf("/");
    const provider = selector.slice(0, slash);
    const id = selector.slice(slash + 1);
    if (provider.length === 0 || id.length === 0) {
      throw new DefinitionError("invalid-model", `Model selector ${JSON.stringify(selector)} is not provider/id.`);
    }
    let resolved: DefinitionModelRef | undefined;
    try {
      resolved = resolveModel(selector);
    } catch {
      throw new DefinitionError("unresolved-model", `Model resolver failed for ${JSON.stringify(selector)}.`);
    }
    const exact = validateModelRef(resolved, selector);
    if (exact.provider !== provider || exact.id !== id) {
      throw new DefinitionError(
        "model-not-exact",
        `Model selector ${JSON.stringify(selector)} resolved to ${JSON.stringify(`${exact.provider}/${exact.id}`)}; exact provider/id is required and thinking/routing suffixes are unsupported.`,
      );
    }
    return { selector, selectorKind: "provider-id", provider, id };
  }

  let resolved: DefinitionModelRef | undefined;
  try {
    resolved = resolveModel(selector);
  } catch {
    throw new DefinitionError("unresolved-model", `Model resolver failed for ${JSON.stringify(selector)}.`);
  }
  const actual = validateModelRef(resolved, selector);
  return {
    selector,
    selectorKind: "native-selector",
    provider: actual.provider,
    id: actual.id,
  };
}

function parseSkillDeclarations(
  rawFrontmatter: Record<string, unknown>,
  parsedSkills: unknown,
): string[] {
  const hasSkills = hasOwn(rawFrontmatter, "autoloadSkills");
  const declared = hasSkills ? rawFrontmatter.autoloadSkills : undefined;
  if (hasSkills && declared === null) {
    throw new DefinitionError("invalid-skills", "autoloadSkills must be omitted or name Skills; explicit null is unsupported.");
  }
  if (hasSkills) {
    if (typeof declared === "string") {
      if (declared.trim().length === 0) {
        throw new DefinitionError("invalid-skills", "autoloadSkills must name at least one Skill.");
      }
    } else if (Array.isArray(declared)) {
      for (const entry of declared) {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          throw new DefinitionError("invalid-skills", "autoloadSkills must contain non-empty strings.");
        }
      }
    } else {
      throw new DefinitionError("invalid-skills", "autoloadSkills must be an array or comma-separated string.");
    }
  }

  if (parsedSkills === undefined) {
    if (!hasSkills || (Array.isArray(declared) && declared.length === 0)) return [];
    throw new DefinitionError("parser-disagreement", "Native parser omitted declared autoloadSkills.");
  }
  if (!Array.isArray(parsedSkills)) {
    throw new DefinitionError("invalid-skills", "Native parser returned a non-array autoloadSkills value.");
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of parsedSkills) {
    if (typeof entry !== "string"
      || entry.length === 0
      || entry.trim() !== entry
      || /[\x00-\x1f\x7f]/.test(entry)) {
      throw new DefinitionError("invalid-skills", "autoloadSkills entries must be meaningful names.");
    }
    if (seen.has(entry)) {
      throw new DefinitionError("skill-duplicate", `autoloadSkills contains duplicate name ${JSON.stringify(entry)}.`);
    }
    seen.add(entry);
    names.push(entry);
  }
  if (names.length > MAX_SKILLS) {
    throw new DefinitionError("skill-limit", `Definition selects ${names.length} Skills; at most ${MAX_SKILLS} are supported.`);
  }
  return names;
}

function nativeSkillName(
  frontmatter: Record<string, unknown>,
  canonicalPath: string,
): string {
  const rawName = frontmatter.name;
  if (typeof rawName === "string" && rawName.trim().length > 0) return rawName.trim();
  return path.basename(path.dirname(canonicalPath));
}

function assertSkillMetadataMatches(
  frontmatter: Record<string, unknown>,
  canonicalPath: string,
  metadata: DefinitionSkillMetadata,
): void {
  const nativeName = nativeSkillName(frontmatter, canonicalPath);
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  if (nativeName !== metadata.name) {
    throw new DefinitionError(
      "skill-metadata-mismatch",
      `Skill file ${JSON.stringify(canonicalPath)} has native name ${JSON.stringify(nativeName)}, not exact loadSkills metadata name ${JSON.stringify(metadata.name)}; namespaced or renamed aliases cannot be verified from current native metadata, so re-run native Skill discovery.`,
    );
  }
  if (description !== metadata.description) {
    throw new DefinitionError(
      "skill-metadata-mismatch",
      `Skill ${JSON.stringify(metadata.name)} description changed after native Skill discovery; re-run native Skill discovery.`,
    );
  }
}

function validateAvailableSkills(value: unknown): DefinitionSkillMetadata[] {
  if (!Array.isArray(value)) {
    throw new DefinitionError("invalid-options", "availableSkills must be an array.");
  }
  const skills: DefinitionSkillMetadata[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new DefinitionError("invalid-options", "availableSkills entries must be objects.");
    }
    const name = nonEmptyString(entry.name, "availableSkills.name", "invalid-options");
    if (name.trim() !== name || /[\x00-\x1f\x7f]/.test(name)) {
      throw new DefinitionError("invalid-options", `availableSkills name ${JSON.stringify(name)} is not normalized.`);
    }
    const filePath = absoluteHostPath(entry.filePath, "availableSkills.filePath", "invalid-options");
    if (typeof entry.description !== "string") {
      throw new DefinitionError("invalid-options", `availableSkills description for ${JSON.stringify(name)} must be a string.`);
    }
    skills.push({ name, filePath, description: entry.description });
  }
  return skills;
}

function versionFor(
  definition: DefinitionDocumentSnapshot,
  skills: readonly DefinitionSkillSnapshot[],
): string {
  const payload = {
    schema: DEFINITION_SNAPSHOT_SCHEMA,
    origin: DEFINITION_ORIGIN,
    freezeScope: DEFINITION_FREEZE_SCOPE,
    definition: {
      canonicalPath: definition.canonicalPath,
      sha256: definition.sha256,
      bytes: definition.bytes,
      bodySha256: definition.bodySha256,
      name: definition.name,
      description: definition.description,
      requestedTools: definition.requestedTools,
      effectiveTools: definition.effectiveTools,
      model: definition.model,
      autoloadSkills: definition.autoloadSkills,
    },
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      canonicalPath: skill.canonicalPath,
      sha256: skill.sha256,
      bytes: skill.bytes,
      bodySha256: skill.bodySha256,
      frontmatter: skill.frontmatter,
    })),
  };
  return `definition-snapshot-v1:sha256:${sha256Hex(canonicalJson(payload))}`;
}

function makeStatus(
  workspaceRoot: string,
  version: string,
  definition: DefinitionDocumentSnapshot,
  skills: readonly DefinitionSkillSnapshot[],
): DefinitionSnapshotStatus {
  return deepFreeze({
    schema: DEFINITION_SNAPSHOT_SCHEMA,
    origin: DEFINITION_ORIGIN,
    freezeScope: DEFINITION_FREEZE_SCOPE,
    version,
    workspaceRoot,
    definition: {
      name: definition.name,
      canonicalPath: definition.canonicalPath,
      sha256: definition.sha256,
      bytes: definition.bytes,
      effectiveTools: [...definition.effectiveTools],
      model: { ...definition.model },
      autoloadSkills: [...definition.autoloadSkills],
    },
    skills: skills.map((skill) => ({
      name: skill.name,
      canonicalPath: skill.canonicalPath,
      sha256: skill.sha256,
      bytes: skill.bytes,
    })),
  });
}

export async function loadDefinitionSnapshot(
  options: LoadDefinitionSnapshotOptions,
): Promise<DefinitionSnapshot> {
  if (!isRecord(options)) {
    throw new DefinitionError("invalid-options", "Definition snapshot options are required.");
  }
  const io = options.fileIo ?? nodeFileIo;
  const definitionPath = absoluteHostPath(options.definitionPath, "definitionPath", "invalid-definition-path");
  if (typeof options.parseAgent !== "function" || typeof options.parseFrontmatter !== "function") {
    throw new DefinitionError("invalid-options", "Native parseAgent and parseFrontmatter ports are required.");
  }
  if (typeof options.resolveModel !== "function") {
    throw new DefinitionError("invalid-options", "A native resolveModel port is required.");
  }
  const nativeSourceLabel = options.nativeSource === undefined ? "explicit" : options.nativeSource;
  if (typeof nativeSourceLabel !== "string"
    || nativeSourceLabel.length === 0
    || nativeSourceLabel.length > 64
    || /[\x00-\x1f\x7f]/.test(nativeSourceLabel)) {
    throw new DefinitionError("invalid-options", "nativeSource must be a short printable label.");
  }
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot, io);
  const availableTools = validateNameList(options.availableTools, "availableTools");
  const currentModel = validateCurrentModel(options.currentModel);
  const availableSkills = validateAvailableSkills(options.availableSkills);
  const skillsByName = new Map<string, DefinitionSkillMetadata[]>();
  for (const skill of availableSkills) {
    const list = skillsByName.get(skill.name) ?? [];
    list.push(skill);
    skillsByName.set(skill.name, list);
  }

  const file = await readBoundedFile(io, definitionPath, "Definition", MAX_DEFINITION_BYTES);

  let frontmatterResult: NativeFrontmatterResult;
  try {
    frontmatterResult = options.parseFrontmatter(file.rawContent, {
      location: file.canonicalPath,
      level: "fatal",
    });
  } catch {
    throw new DefinitionError("native-parse-failed", "Native frontmatter parser rejected the selected definition.");
  }
  if (!isRecord(frontmatterResult) || !isRecord(frontmatterResult.frontmatter)
    || typeof frontmatterResult.body !== "string") {
    throw new DefinitionError("invalid-definition", "Native frontmatter parser returned an unsupported result.");
  }
  const frontmatter = frontmatterResult.frontmatter;
  const unsupported = Object.keys(frontmatter).filter((key) => !SUPPORTED_DEFINITION_FIELDS.has(key)).sort();
  if (unsupported.length > 0) {
    throw new DefinitionError(
      "unsupported-fields",
      `Unsupported Agent frontmatter fields: ${unsupported.slice(0, 8).join(", ")}.`,
      unsupported,
    );
  }

  let parsedAgent: NativeParsedAgent;
  try {
    parsedAgent = options.parseAgent(file.canonicalPath, file.rawContent, nativeSourceLabel, "fatal");
  } catch {
    throw new DefinitionError("native-parse-failed", "Native Agent parser rejected the selected definition.");
  }
  if (!isRecord(parsedAgent)) {
    throw new DefinitionError("invalid-definition", "Native Agent parser returned an unsupported result.");
  }

  const name = nonEmptyString(parsedAgent.name, "Agent name", "missing-name");
  const description = nonEmptyString(parsedAgent.description, "Agent description", "missing-description");
  if (frontmatter.name !== name) {
    throw new DefinitionError("parser-disagreement", "Native parser name disagrees with native frontmatter.");
  }
  if (frontmatter.description !== description) {
    throw new DefinitionError("parser-disagreement", "Native parser description disagrees with native frontmatter.");
  }
  if (typeof parsedAgent.systemPrompt !== "string" || parsedAgent.systemPrompt.trim().length === 0) {
    throw new DefinitionError("empty-body", "Agent definition body must be non-empty text.");
  }
  if (frontmatterResult.body !== parsedAgent.systemPrompt) {
    throw new DefinitionError("parser-disagreement", "Native parser body disagrees with native frontmatter body.");
  }
  if (frontmatterResult.body.trim().length === 0) {
    throw new DefinitionError("empty-body", "Agent definition body must be non-empty text.");
  }

  const tools = parseTools(frontmatter, parsedAgent.tools, availableTools);
  const model = parseModel(frontmatter, parsedAgent.model, currentModel, options.resolveModel);
  const autoloadSkills = parseSkillDeclarations(frontmatter, parsedAgent.autoloadSkills);

  const definitionFrontmatter = freezeFrontmatter(frontmatter, "Agent");
  const definition: DefinitionDocumentSnapshot = deepFreeze({
    requestedPath: definitionPath,
    canonicalPath: file.canonicalPath,
    name,
    description,
    body: parsedAgent.systemPrompt,
    bodySha256: sha256Hex(parsedAgent.systemPrompt),
    rawContent: file.rawContent,
    bytes: file.bytes,
    sha256: file.sha256,
    requestedTools: tools.requested,
    effectiveTools: tools.effective,
    model,
    autoloadSkills,
    frontmatter: definitionFrontmatter,
  });

  const skills: DefinitionSkillSnapshot[] = [];
  let totalBytes = file.bytes;
  for (const skillName of autoloadSkills) {
    const matches = skillsByName.get(skillName) ?? [];
    if (matches.length === 0) {
      throw new DefinitionError("skill-missing", `autoloadSkills references missing Skill ${JSON.stringify(skillName)}.`);
    }
    if (matches.length > 1) {
      throw new DefinitionError(
        "skill-ambiguous",
        `autoloadSkills name ${JSON.stringify(skillName)} matches ${matches.length} available Skills.`,
      );
    }
    const metadata = matches[0]!;
    const skillFile = await readBoundedFile(io, metadata.filePath, `Skill ${JSON.stringify(skillName)}`, MAX_SKILL_BYTES, "SKILL.md");
    totalBytes += skillFile.bytes;
    if (totalBytes > MAX_INITIAL_TEXT_BYTES) {
      throw new DefinitionError(
        "total-too-large",
        `Initial definition and Skill text exceeds ${MAX_INITIAL_TEXT_BYTES} bytes.`,
      );
    }
    let skillFrontmatterResult: NativeFrontmatterResult;
    try {
      skillFrontmatterResult = options.parseFrontmatter(skillFile.rawContent, {
        location: skillFile.canonicalPath,
        level: "fatal",
      });
    } catch {
      throw new DefinitionError("native-parse-failed", `Native frontmatter parser rejected Skill ${JSON.stringify(skillName)}.`);
    }
    if (!isRecord(skillFrontmatterResult) || !isRecord(skillFrontmatterResult.frontmatter)
      || typeof skillFrontmatterResult.body !== "string") {
      throw new DefinitionError("invalid-definition", `Native frontmatter parser returned an unsupported result for Skill ${JSON.stringify(skillName)}.`);
    }
    assertSkillMetadataMatches(skillFrontmatterResult.frontmatter, skillFile.canonicalPath, metadata);
    if (skillFrontmatterResult.body.trim().length === 0) {
      throw new DefinitionError("empty-body", `Skill ${JSON.stringify(skillName)} body must be non-empty text.`);
    }
    const skillFrontmatter = freezeFrontmatter(skillFrontmatterResult.frontmatter, `Skill ${JSON.stringify(skillName)}`);
    skills.push(deepFreeze({
      name: metadata.name,
      description: metadata.description,
      canonicalPath: skillFile.canonicalPath,
      body: skillFrontmatterResult.body,
      bodySha256: sha256Hex(skillFrontmatterResult.body),
      rawContent: skillFile.rawContent,
      bytes: skillFile.bytes,
      sha256: skillFile.sha256,
      frontmatter: skillFrontmatter,
    }));
  }

  const frozenSkills = deepFreeze(skills);
  const version = versionFor(definition, frozenSkills);
  const snapshot: DefinitionSnapshot = {
    schema: DEFINITION_SNAPSHOT_SCHEMA,
    origin: DEFINITION_ORIGIN,
    freezeScope: DEFINITION_FREEZE_SCOPE,
    version,
    workspaceRoot,
    nativeSourceLabel,
    definition,
    skills: frozenSkills,
    getStatus: () => makeStatus(workspaceRoot, version, definition, frozenSkills),
  };
  return deepFreeze(snapshot);
}
