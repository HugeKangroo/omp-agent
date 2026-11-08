import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { EXECUTION_LIMITS } from "./execution-adapter.ts";
import type { HumanReviewHostOption } from "./human-review-types.ts";

/**
 * B3-B2 host-selected daily configuration.
 *
 * The JSON file named by absolute OMP_AGENT_CONFIG is the only source of this
 * entry's workspace, state root, input whitelist and optional runtime/review
 * choices. It intentionally accepts no credentials, endpoints, model-controlled
 * paths, per-task policy or scattered execution-environment knobs.
 */

export const DAILY_CONFIG_SCHEMA_VERSION = 1 as const;
export const DAILY_CONFIG_MAX_BYTES = 64 * 1024;
export const HUMAN_REVIEW_OPT_IN = "local-main-tui-v1" as const;

const INPUT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "workspaceRoot",
  "inputs",
  "stateRoot",
  "pythonPath",
  "bunPath",
  "humanReview",
] as const;
const INPUT_KEYS = ["id", "path"] as const;

export class DailyConfigError extends Error {
  override name = "DailyConfigError";
}

export interface DailyInput {
  id: string;
  /** Canonical absolute regular-file path; never a directory, glob or model value. */
  path: string;
}

export interface DailyConfig {
  schemaVersion: typeof DAILY_CONFIG_SCHEMA_VERSION;
  /** Canonical location of the loaded host config file. */
  configPath: string;
  /** Canonical real workspace root; must equal the actual OMP launch workspace. */
  workspaceRoot: string;
  /** Canonical host-private state root, default `<workspace>/.omp-agent`. */
  stateRoot: string;
  /** Host-authorized regular files; empty means no execution inputs. */
  inputs: readonly DailyInput[];
  pythonPath?: string;
  bunPath?: string;
  /** Default off; only the exact local-main-tui-v1 opt-in is accepted. */
  humanReview?: HumanReviewHostOption;
}

export interface LoadDailyConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Actual host launch workspace; defaults to process.cwd(). */
  launchWorkspace?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DailyConfigError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function strictRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const result = record(value, label);
  const unknown = Object.keys(result).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new DailyConfigError(
      `${label} has ${unknown.length} unsupported field(s): ${unknown.join(", ")}. Remove them; credentials, endpoints, per-task policy and model-controlled paths are not accepted.`,
    );
  }
  return result;
}

function absoluteString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new DailyConfigError(`${label} must be a non-empty absolute path.`);
  }
  return value;
}

function existingDirectory(value: string, label: string): string {
  let info;
  try {
    info = statSync(value);
  } catch (error) {
    throw new DailyConfigError(`${label} is not an existing usable directory: ${errorMessage(error)}.`);
  }
  if (!info.isDirectory()) throw new DailyConfigError(`${label} must be a directory.`);
  try {
    return realpathSync(value);
  } catch (error) {
    throw new DailyConfigError(`${label} could not be canonicalized: ${errorMessage(error)}.`);
  }
}

/**
 * Canonicalize a path whose leaf may not exist yet. Existing ancestors are
 * resolved through realpath, and missing components are appended verbatim.
 */
export function canonicalizeCandidate(value: string): string {
  const resolved = path.resolve(value);
  const suffix: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      return path.join(realpathSync(cursor), ...suffix);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function withinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readConfigFile(configPath: string): unknown {
  let bytes: Buffer;
  try {
    const info = lstatSync(configPath);
    if (info.isSymbolicLink()) {
      throw new DailyConfigError("OMP_AGENT_CONFIG must name a regular file, not a symbolic link.");
    }
    if (!info.isFile()) {
      throw new DailyConfigError("OMP_AGENT_CONFIG must name a regular file.");
    }
    bytes = readFileSync(configPath);
  } catch (error) {
    if (error instanceof DailyConfigError) throw error;
    throw new DailyConfigError(`OMP_AGENT_CONFIG could not be read: ${errorMessage(error)}.`);
  }
  if (bytes.length > DAILY_CONFIG_MAX_BYTES) {
    throw new DailyConfigError(
      `OMP_AGENT_CONFIG exceeds ${DAILY_CONFIG_MAX_BYTES} bytes; keep the host configuration small.`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DailyConfigError("OMP_AGENT_CONFIG is not valid UTF-8 JSON.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DailyConfigError("OMP_AGENT_CONFIG is not valid JSON.");
  }
}

function parseInputs(value: unknown, stateRoot: string): DailyInput[] {
  if (!Array.isArray(value)) {
    throw new DailyConfigError("config.inputs must be an explicit array; use [] when there are no inputs.");
  }
  if (value.length > EXECUTION_LIMITS.maxInputs) {
    throw new DailyConfigError(`config.inputs exceeds the ${EXECUTION_LIMITS.maxInputs}-handle execution limit.`);
  }
  const seen = new Set<string>();
  const inputs: DailyInput[] = [];
  value.forEach((item, index) => {
    const label = `config.inputs[${index}]`;
    const input = strictRecord(item, label, INPUT_KEYS);
    if (typeof input.id !== "string" || !INPUT_ID.test(input.id)) {
      throw new DailyConfigError(`${label}.id must be a valid unique identifier.`);
    }
    if (seen.has(input.id)) {
      throw new DailyConfigError(`${label}.id duplicates the input id ${input.id}.`);
    }
    seen.add(input.id);
    const rawPath = absoluteString(input.path, `${label}.path`);
    let info;
    try {
      info = lstatSync(rawPath);
    } catch (error) {
      throw new DailyConfigError(`${label}.path is not an existing file: ${errorMessage(error)}.`);
    }
    if (info.isSymbolicLink()) {
      throw new DailyConfigError(`${label}.path must not be a symbolic link.`);
    }
    if (!info.isFile()) {
      throw new DailyConfigError(`${label}.path must be a regular file.`);
    }
    if (info.nlink !== 1) {
      throw new DailyConfigError(`${label}.path must have exactly one hard link.`);
    }
    let canonical: string;
    try {
      canonical = realpathSync(rawPath);
    } catch (error) {
      throw new DailyConfigError(`${label}.path could not be canonicalized: ${errorMessage(error)}.`);
    }
    if (withinOrEqual(stateRoot, canonical)) {
      throw new DailyConfigError(
        `${label}.path points into managed internal state (${stateRoot}); inputs must be separate host files.`,
      );
    }
    inputs.push({ id: input.id, path: canonical });
  });
  return inputs;
}

/**
 * Read and strictly validate the host-selected config. No directory is
 * created, no process or runtime is probed, and no owner is published here.
 */
export function loadDailyConfig(options: LoadDailyConfigOptions = {}): DailyConfig {
  const env = options.env ?? process.env;
  const configuredPath = env.OMP_AGENT_CONFIG;
  if (typeof configuredPath !== "string" || configuredPath.length === 0 || !path.isAbsolute(configuredPath)) {
    throw new DailyConfigError(
      "OMP_AGENT_CONFIG is required and must be an absolute path to the host-selected JSON config.",
    );
  }
  const configPath = path.resolve(configuredPath);
  const value = readConfigFile(configPath);
  const root = strictRecord(value, "config", TOP_LEVEL_KEYS);

  if (root.schemaVersion !== DAILY_CONFIG_SCHEMA_VERSION) {
    throw new DailyConfigError(`config.schemaVersion must be exactly ${DAILY_CONFIG_SCHEMA_VERSION}.`);
  }
  const workspaceRoot = existingDirectory(
    absoluteString(root.workspaceRoot, "config.workspaceRoot"),
    "config.workspaceRoot",
  );

  const launchWorkspaceValue = options.launchWorkspace ?? process.cwd();
  if (!path.isAbsolute(launchWorkspaceValue)) {
    throw new DailyConfigError("The actual OMP launch workspace must be an absolute path.");
  }
  const launchWorkspace = existingDirectory(launchWorkspaceValue, "OMP launch workspace");
  if (workspaceRoot !== launchWorkspace) {
    throw new DailyConfigError(
      `config.workspaceRoot canonical path does not match the actual OMP launch workspace (${launchWorkspace}).`,
    );
  }

  let stateRoot: string;
  if (root.stateRoot === undefined) {
    stateRoot = path.join(workspaceRoot, ".omp-agent");
  } else {
    const stateRootValue = absoluteString(root.stateRoot, "config.stateRoot");
    let stateInfo;
    try {
      stateInfo = lstatSync(stateRootValue);
    } catch {
      stateInfo = undefined;
    }
    if (stateInfo !== undefined) {
      if (stateInfo.isSymbolicLink()) {
        throw new DailyConfigError("config.stateRoot must not be a symbolic link; provide its canonical real directory.");
      }
      if (!stateInfo.isDirectory()) {
        throw new DailyConfigError("config.stateRoot must be a directory.");
      }
      stateRoot = realpathSync(stateRootValue);
    } else {
      stateRoot = canonicalizeCandidate(stateRootValue);
    }
  }
  if (withinOrEqual(stateRoot, workspaceRoot)) {
    throw new DailyConfigError(
      "config.stateRoot must not equal or contain the workspace root; choose a private state directory inside the workspace or elsewhere.",
    );
  }

  const inputs = parseInputs(root.inputs, stateRoot);

  const pythonPath = root.pythonPath === undefined
    ? undefined
    : absoluteString(root.pythonPath, "config.pythonPath");
  const bunPath = root.bunPath === undefined
    ? undefined
    : absoluteString(root.bunPath, "config.bunPath");

  let humanReview: HumanReviewHostOption | undefined;
  if (root.humanReview !== undefined && root.humanReview !== false) {
    if (root.humanReview !== HUMAN_REVIEW_OPT_IN) {
      throw new DailyConfigError(
        `config.humanReview must be omitted, false, or exactly ${JSON.stringify(HUMAN_REVIEW_OPT_IN)}.`,
      );
    }
    humanReview = { kind: "local-main-tui", policyVersion: 1 };
  }

  const canonicalConfigPath = realpathSync(configPath);
  return {
    schemaVersion: DAILY_CONFIG_SCHEMA_VERSION,
    configPath: canonicalConfigPath,
    workspaceRoot,
    stateRoot,
    inputs,
    ...(pythonPath === undefined ? {} : { pythonPath }),
    ...(bunPath === undefined ? {} : { bunPath }),
    ...(humanReview === undefined ? {} : { humanReview }),
  };
}
