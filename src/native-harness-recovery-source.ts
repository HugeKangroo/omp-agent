import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { readActualAbortSignal } from "./native-abort.ts";
import type { NativeHarnessAccountingPrepared } from "./native-harness-accounting.ts";
import type {
  NativeHarnessAdmittedBudget,
  NativeHarnessAssociation,
  NativeHarnessPrepareAccounting,
} from "./native-harness-delegation.ts";
import {
  NATIVE_HARNESS_WORKSPACE_LIMITS,
  type NativeHarnessWorkspaceDescriptor,
  type NativeHarnessWorkspaceManifestEntry,
} from "./native-harness-workspace.ts";
import {
  NativeFileError,
  captureWorkspaceText,
  deepFreeze,
  nodeFileIo,
  sha256Hex,
  validateRelativePath,
  type NativeFileHandle,
  type NativeFileIo,
  type NativeFileStats,
  type NativeWorkspaceTextSnapshot,
} from "./native-work.ts";

/**
 * One fixed-file recovery-source leaf.
 *
 * It writes only `preparedRoot/recovery-source.json`, below one existing
 * private workspace preparation root, and verifies that same file by exact
 * bytes. Host-only facts are copied before the first await; model input,
 * hostConfig, task text, auth, definitions and ambient environment are not
 * accepted or serialized. The returned facts are not an issued permission,
 * a durability claim, a whole-tree snapshot or a resume license.
 */

export const NATIVE_HARNESS_RECOVERY_SOURCE_SCHEMA =
  "omp-agent.native-harness-recovery-source.v1" as const;
export const NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE = "native-auto-scoped-files.v1" as const;
export const NATIVE_HARNESS_RECOVERY_SEED_SCHEMA =
  "omp-agent.native-harness-recovery-seed.v1" as const;
export const NATIVE_HARNESS_RECOVERY_SOURCE_FILE = "recovery-source.json" as const;
export const NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES = 16_384 as const;
export const NATIVE_HARNESS_RECOVERY_SEED_MAX_BYTES = 4_096 as const;

const RECOVERY_TOOL_NAME = "agent_harness" as const;
const OWNED_PREFIX = "omp-harness-";
const SOURCE_FILE_MODE = 0o600;
const MAX_OBSERVATION_CHARS = 1024;
const MAX_SESSION_CHARS = 1024;
const MAX_TOOL_CALL_CHARS = 256;
const MAX_TOOL_NAME_CHARS = 64;
const MAX_PATH_CHARS = NATIVE_HARNESS_WORKSPACE_LIMITS.maxPathChars;
const MAX_MODEL_CHARS = 256;
const MAX_COMMAND_CHARS = 4096;
const MAX_SOURCE_PINS = 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const MODEL_PATTERN = /^([a-z0-9][a-z0-9-]*)\/([^\s,:@]+)$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

const BIGINT_LSTAT = Object.freeze({ bigint: true as const });
const ACTUAL_PROMISE_THEN = (() => {
  try {
    return Promise.prototype.then;
  } catch {
    return null;
  }
})();
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const O_NOFOLLOW = nodeFileIo.O_NOFOLLOW;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;
const DIRECTORY_READ_FLAGS = nodeFileIo.O_RDONLY | O_NOFOLLOW | O_DIRECTORY;

type RecoverySourceFailureCode =
  | "invalid-input"
  | "authority-lost"
  | "aborted"
  | "unsafe-path"
  | "identity-changed"
  | "already-exists"
  | "write-failed"
  | "readback-failed"
  | "too-large";

export class NativeHarnessRecoverySourceError extends Error {
  override name = "NativeHarnessRecoverySourceError";

  constructor(
    message: string,
    readonly code: RecoverySourceFailureCode,
    cause?: unknown,
  ) {
    super(message);
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

function fail(code: RecoverySourceFailureCode, message: string, cause?: unknown): never {
  throw new NativeHarnessRecoverySourceError(message, code, cause);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameDirectoryIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return true;
  }
}

/** Exact own-data object reader: no prototype, accessor, symbol or extra key. */
function readStrictFields(
  value: unknown,
  allowed: readonly string[],
  label: string,
): ReadonlyMap<string, unknown> {
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail("invalid-input", `${label} must be an exact plain object.`);
    }
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    if (error instanceof NativeHarnessRecoverySourceError) throw error;
    fail("invalid-input", `${label} could not be inspected.`, error);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid-input", `${label} must be an exact plain object.`);
  }
  if (keys.length !== allowed.length || keys.some((key) => typeof key !== "string")) {
    fail("invalid-input", `${label} must contain exactly its fixed fields.`);
  }
  const fields = new Map<string, unknown>();
  for (const key of allowed) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch (error) {
      fail("invalid-input", `${label}.${key} could not be inspected.`, error);
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      fail("invalid-input", `${label}.${key} must be an enumerable own data field.`);
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function readPlainArray(value: unknown, max: number, label: string): readonly unknown[] {
  let prototype: object | null;
  let keys: (string | symbol)[];
  let length: unknown;
  try {
    if (!Array.isArray(value)) fail("invalid-input", `${label} must be a plain array.`);
    prototype = Object.getPrototypeOf(value);
    length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    keys = Reflect.ownKeys(value);
  } catch (error) {
    if (error instanceof NativeHarnessRecoverySourceError) throw error;
    fail("invalid-input", `${label} could not be inspected.`, error);
  }
  if (prototype !== Array.prototype) fail("invalid-input", `${label} must be a plain array.`);
  if (
    typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > max
  ) {
    fail("invalid-input", `${label} has an invalid length.`);
  }
  if (keys.length !== length + 1) {
    fail("invalid-input", `${label} must not contain holes or extra properties.`);
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index++) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch (error) {
      fail("invalid-input", `${label}[${index}] could not be inspected.`, error);
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      fail("invalid-input", `${label}[${index}] must be an enumerable own data field.`);
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function readString(
  value: unknown,
  label: string,
  max: number,
  absolute: boolean,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || CONTROL_PATTERN.test(value)
    || (absolute && !path.isAbsolute(value))
  ) {
    fail(
      "invalid-input",
      `${label} must be a ${absolute ? "canonical absolute " : ""}string of 1-${max} characters.`,
    );
  }
  return value;
}

function readSafeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    fail("invalid-input", `${label} must be a safe integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function readHex64(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    fail("invalid-input", `${label} must be 64 lowercase hexadecimal characters.`);
  }
  return value;
}

function readUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("invalid-input", `${label} must be a canonical lowercase UUID.`);
  }
  return value;
}

function readRelativePath(value: unknown, label: string): string {
  try {
    return validateRelativePath(value);
  } catch (error) {
    fail("invalid-input", `${label} must be a valid native relative path.`, error);
  }
}

export interface RecoveryBackendProfile {
  readonly model: string;
  readonly improverModel: string;
  readonly ompCommand: string;
  readonly mode: "product";
  readonly strategy: "auto";
  readonly domain: "generic";
  readonly adaptation: {
    readonly capabilities: "fixed";
    readonly reuse: false;
    readonly learnMethods: false;
  };
}

export interface RecoveryBackendBuild {
  readonly sourceId: string;
  readonly sourceIntegrity: "build-label-only";
}

/** Trusted host path expectations for the pure recovery-source decoder. */
export interface NativeHarnessRecoverySourceTextExpectation {
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly preparedRelativeRoot: string;
}

/**
 * Trusted host expectation for the readonly open. `sourceDescriptorSha256` is
 * the exact SHA-256 of the raw `recovery-source.json` bytes from a previous
 * preparation. It is an observation match, never a creation flag, serialized
 * pin set or permission.
 */
export type NativeHarnessRecoverySourceOpenExpectation =
  NativeHarnessRecoverySourceTextExpectation & {
    readonly sourceDescriptorSha256: string;
  };

/**
 * Pure decoded shape of one already-read `recovery-source.json` document.
 * `sha256` hashes the exact caller-supplied UTF-8 bytes; reordered but
 * semantically equal JSON is not normalized back into the original digest.
 * These facts are a decode of caller-supplied text, never proof that an actual
 * file exists, a completion handle, lease authority or resume permission.
 */
export interface NativeHarnessRecoverySourceDocument {
  readonly schema: typeof NATIVE_HARNESS_RECOVERY_SOURCE_SCHEMA;
  readonly profile: typeof NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE;
  readonly accounting: NativeHarnessPrepareAccounting;
  readonly association: NativeHarnessAssociation;
  readonly budget: NativeHarnessAdmittedBudget;
  readonly workspace: {
    readonly sourceRoot: string;
    readonly preparedRelativeRoot: string;
    readonly workspaceRelativeRoot: string;
    readonly storeRelativeRoot: string;
  };
  readonly inputs: readonly NativeHarnessWorkspaceManifestEntry[];
  readonly inputManifestSha256: string;
  readonly backendProfile: RecoveryBackendProfile;
  readonly backendBuild: RecoveryBackendBuild;
  readonly bytes: number;
  readonly sha256: string;
}

export interface NativeHarnessRecoverySourceInput {
  /** Actual canonical host storage root; never model input. */
  readonly storageRoot: string;
  readonly descriptor: NativeHarnessWorkspaceDescriptor;
  readonly association: NativeHarnessAssociation;
  readonly accounting: NativeHarnessPrepareAccounting;
  readonly budget: NativeHarnessAdmittedBudget;
  readonly backendProfile: RecoveryBackendProfile;
  readonly backendBuild: RecoveryBackendBuild;
}

export type SourceInput = NativeHarnessRecoverySourceInput;

export interface RecoverySourcePin {
  readonly role: "storage" | "prepared" | "workspace" | "store";
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface NativeHarnessRecoverySourceFacts {
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly preparedRoot: string;
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly relativePath: typeof NATIVE_HARNESS_RECOVERY_SOURCE_FILE;
  readonly pins: readonly RecoverySourcePin[];
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PreparedRecoverySource {
  readonly accountingPrepared: NativeHarnessAccountingPrepared;
  readonly seedText: string;
  readonly source: NativeHarnessRecoverySourceFacts;
}

interface OwnedInput {
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly preparedRoot: string;
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly preparedRelativeRoot: string;
  readonly workspaceRelativeRoot: string;
  readonly storeRelativeRoot: string;
  readonly association: NativeHarnessAssociation;
  readonly accounting: NativeHarnessPrepareAccounting;
  readonly budget: NativeHarnessAdmittedBudget;
  readonly inputs: readonly NativeHarnessWorkspaceManifestEntry[];
  readonly inputManifestSha256: string;
  readonly backendProfile: RecoveryBackendProfile;
  readonly backendBuild: RecoveryBackendBuild;
  readonly documentText: string;
  readonly documentBytes: Uint8Array;
  readonly documentSha256: string;
}

function readAssociation(value: unknown, sourceRoot: string): NativeHarnessAssociation {
  const fields = readStrictFields(
    value,
    ["observationId", "generation", "sessionId", "workspaceRoot", "toolCallId", "toolName"],
    "association",
  );
  const observationId = readString(fields.get("observationId"), "association.observationId", MAX_OBSERVATION_CHARS, false);
  const generation = readSafeInteger(fields.get("generation"), "association.generation", 1, Number.MAX_SAFE_INTEGER);
  const sessionId = readString(fields.get("sessionId"), "association.sessionId", MAX_SESSION_CHARS, false);
  const workspaceRoot = readString(fields.get("workspaceRoot"), "association.workspaceRoot", MAX_PATH_CHARS, true);
  const toolCallId = readString(fields.get("toolCallId"), "association.toolCallId", MAX_TOOL_CALL_CHARS, false);
  const toolName = readString(fields.get("toolName"), "association.toolName", MAX_TOOL_NAME_CHARS, false);
  if (toolName !== RECOVERY_TOOL_NAME) {
    fail("invalid-input", `association.toolName must be ${RECOVERY_TOOL_NAME}.`);
  }
  if (workspaceRoot !== sourceRoot) {
    fail("invalid-input", "association.workspaceRoot must equal the canonical descriptor.sourceRoot.");
  }
  return Object.freeze({
    observationId,
    generation,
    sessionId,
    workspaceRoot,
    toolCallId,
    toolName: RECOVERY_TOOL_NAME,
  });
}

function readAccounting(value: unknown): NativeHarnessPrepareAccounting {
  const fields = readStrictFields(
    value,
    ["ownerId", "admissionId", "reserveRevision", "sourceAssociationSha256", "admittedAt"],
    "accounting",
  );
  return Object.freeze({
    ownerId: readUuid(fields.get("ownerId"), "accounting.ownerId"),
    admissionId: readUuid(fields.get("admissionId"), "accounting.admissionId"),
    reserveRevision: readSafeInteger(fields.get("reserveRevision"), "accounting.reserveRevision", 1, Number.MAX_SAFE_INTEGER),
    sourceAssociationSha256: readHex64(fields.get("sourceAssociationSha256"), "accounting.sourceAssociationSha256"),
    admittedAt: readSafeInteger(fields.get("admittedAt"), "accounting.admittedAt", 1, Number.MAX_SAFE_INTEGER),
  });
}

function readBudget(value: unknown, admittedAt: number): NativeHarnessAdmittedBudget {
  const fields = readStrictFields(value, ["maxCostUsd", "deadlineAt", "maxDurationMs"], "budget");
  const maxCostUsd = fields.get("maxCostUsd");
  if (
    typeof maxCostUsd !== "number"
    || !Number.isFinite(maxCostUsd)
    || maxCostUsd <= 0
    || maxCostUsd > 1
  ) {
    fail("invalid-input", "budget.maxCostUsd must be a finite number greater than 0 and at most 1.");
  }
  const deadlineAt = readSafeInteger(fields.get("deadlineAt"), "budget.deadlineAt", 1, Number.MAX_SAFE_INTEGER);
  const maxDurationMs = readSafeInteger(
    fields.get("maxDurationMs"),
    "budget.maxDurationMs",
    1,
    300_000,
  );
  if (!Number.isSafeInteger(admittedAt + maxDurationMs) || admittedAt + maxDurationMs !== deadlineAt) {
    fail("invalid-input", "budget.deadlineAt must equal accounting.admittedAt + budget.maxDurationMs.");
  }
  return Object.freeze({ maxCostUsd, deadlineAt, maxDurationMs });
}

function readBackendProfile(value: unknown): RecoveryBackendProfile {
  const fields = readStrictFields(
    value,
    ["model", "improverModel", "ompCommand", "mode", "strategy", "domain", "adaptation"],
    "backendProfile",
  );
  const readModel = (raw: unknown, label: string): string => {
    const model = readString(raw, label, MAX_MODEL_CHARS, false);
    if (
      model.length < 3
      || !MODEL_PATTERN.test(model)
      || /[?*]/.test(model)
    ) {
      fail("invalid-input", `${label} must be one exact provider/model-id without wildcards.`);
    }
    return model;
  };
  const model = readModel(fields.get("model"), "backendProfile.model");
  const improverModel = readModel(fields.get("improverModel"), "backendProfile.improverModel");
  if (model !== improverModel) {
    fail("invalid-input", "backendProfile.model must equal backendProfile.improverModel.");
  }
  const ompCommand = readString(
    fields.get("ompCommand"),
    "backendProfile.ompCommand",
    MAX_COMMAND_CHARS,
    true,
  );
  if (fields.get("mode") !== "product") fail("invalid-input", "backendProfile.mode must be product.");
  if (fields.get("strategy") !== "auto") fail("invalid-input", "backendProfile.strategy must be auto.");
  if (fields.get("domain") !== "generic") fail("invalid-input", "backendProfile.domain must be generic.");
  const adaptation = readStrictFields(
    fields.get("adaptation"),
    ["capabilities", "reuse", "learnMethods"],
    "backendProfile.adaptation",
  );
  if (adaptation.get("capabilities") !== "fixed") {
    fail("invalid-input", "backendProfile.adaptation.capabilities must be fixed.");
  }
  if (adaptation.get("reuse") !== false) {
    fail("invalid-input", "backendProfile.adaptation.reuse must be false.");
  }
  if (adaptation.get("learnMethods") !== false) {
    fail("invalid-input", "backendProfile.adaptation.learnMethods must be false.");
  }
  return Object.freeze({
    model,
    improverModel,
    ompCommand,
    mode: "product",
    strategy: "auto",
    domain: "generic",
    adaptation: Object.freeze({ capabilities: "fixed", reuse: false, learnMethods: false }),
  });
}

function readBackendBuild(value: unknown): RecoveryBackendBuild {
  const fields = readStrictFields(value, ["sourceId", "sourceIntegrity"], "backendBuild");
  if (fields.get("sourceIntegrity") !== "build-label-only") {
    fail("invalid-input", "backendBuild.sourceIntegrity must be build-label-only.");
  }
  return Object.freeze({
    sourceId: readHex64(fields.get("sourceId"), "backendBuild.sourceId"),
    sourceIntegrity: "build-label-only",
  });
}

function readManifest(
  value: unknown,
  declaredDigest: string,
): readonly NativeHarnessWorkspaceManifestEntry[] {
  const raw = readPlainArray(
    value,
    NATIVE_HARNESS_WORKSPACE_LIMITS.maxFiles,
    "descriptor.inputManifest",
  );
  if (raw.length < 1) {
    fail("invalid-input", "descriptor.inputManifest must contain 1-8 entries.");
  }
  const entries: NativeHarnessWorkspaceManifestEntry[] = [];
  let totalBytes = 0;
  for (let index = 0; index < raw.length; index++) {
    const fields = readStrictFields(
      raw[index],
      ["relativePath", "bytes", "sha256", "observedAt"],
      `descriptor.inputManifest[${index}]`,
    );
    const relativePath = readRelativePath(
      fields.get("relativePath"),
      `descriptor.inputManifest[${index}].relativePath`,
    );
    const bytes = readSafeInteger(
      fields.get("bytes"),
      `descriptor.inputManifest[${index}].bytes`,
      0,
      NATIVE_HARNESS_WORKSPACE_LIMITS.maxFileBytes,
    );
    totalBytes += bytes;
    if (totalBytes > NATIVE_HARNESS_WORKSPACE_LIMITS.maxTotalBytes) {
      fail("invalid-input", "descriptor.inputManifest exceeds the total byte limit.");
    }
    entries.push(Object.freeze({
      relativePath,
      bytes,
      sha256: readHex64(fields.get("sha256"), `descriptor.inputManifest[${index}].sha256`),
      observedAt: readSafeInteger(
        fields.get("observedAt"),
        `descriptor.inputManifest[${index}].observedAt`,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    }));
  }
  for (let index = 1; index < entries.length; index++) {
    if (entries[index - 1]!.relativePath >= entries[index]!.relativePath) {
      fail("invalid-input", "descriptor.inputManifest must be strictly sorted by ordinal relativePath.");
    }
  }
  const recomputed = sha256Hex(JSON.stringify(entries.map((entry) => [
    entry.relativePath,
    entry.bytes,
    entry.sha256,
  ])));
  if (recomputed !== declaredDigest) {
    fail("invalid-input", "descriptor.manifestSha256 does not match the owned manifest triples.");
  }
  return Object.freeze(entries);
}

function readDescriptor(value: unknown): {
  readonly sourceRoot: string;
  readonly preparedRoot: string;
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly inputManifest: readonly NativeHarnessWorkspaceManifestEntry[];
  readonly manifestSha256: string;
} {
  const fields = readStrictFields(
    value,
    [
      "schema",
      "sourceRoot",
      "preparedRoot",
      "workspaceRoot",
      "storeRoot",
      "inputManifest",
      "manifestSha256",
      "gitInitialized",
      "limitations",
    ],
    "descriptor",
  );
  if (fields.get("schema") !== "omp-agent.native-harness-workspace.v1") {
    fail("invalid-input", "descriptor.schema is not the native workspace schema.");
  }
  if (fields.get("gitInitialized") !== true) {
    fail("invalid-input", "descriptor.gitInitialized must be true.");
  }
  readPlainArray(fields.get("limitations"), 64, "descriptor.limitations");
  const sourceRoot = readString(fields.get("sourceRoot"), "descriptor.sourceRoot", MAX_PATH_CHARS, true);
  const preparedRoot = readString(fields.get("preparedRoot"), "descriptor.preparedRoot", MAX_PATH_CHARS, true);
  const workspaceRoot = readString(fields.get("workspaceRoot"), "descriptor.workspaceRoot", MAX_PATH_CHARS, true);
  const storeRoot = readString(fields.get("storeRoot"), "descriptor.storeRoot", MAX_PATH_CHARS, true);
  const manifestSha256 = readHex64(fields.get("manifestSha256"), "descriptor.manifestSha256");
  if (workspaceRoot !== path.join(preparedRoot, "workspace")) {
    fail("invalid-input", "descriptor.workspaceRoot must be preparedRoot/workspace.");
  }
  if (storeRoot !== path.join(preparedRoot, "store")) {
    fail("invalid-input", "descriptor.storeRoot must be preparedRoot/store.");
  }
  return {
    sourceRoot,
    preparedRoot,
    workspaceRoot,
    storeRoot,
    inputManifest: readManifest(fields.get("inputManifest"), manifestSha256),
    manifestSha256,
  };
}

function associationDigest(association: NativeHarnessAssociation): string {
  return sha256Hex(JSON.stringify({
    observationId: association.observationId,
    generation: association.generation,
    sessionId: association.sessionId,
    workspaceRoot: association.workspaceRoot,
    toolCallId: association.toolCallId,
    toolName: association.toolName,
  }));
}

function readSourceInput(value: unknown): OwnedInput {
  const fields = readStrictFields(
    value,
    [
      "storageRoot",
      "descriptor",
      "association",
      "accounting",
      "budget",
      "backendProfile",
      "backendBuild",
    ],
    "source input",
  );
  const storageRoot = readString(fields.get("storageRoot"), "storageRoot", MAX_PATH_CHARS, true);
  const descriptor = readDescriptor(fields.get("descriptor"));
  if (
    isContained(descriptor.sourceRoot, storageRoot)
    || isContained(storageRoot, descriptor.sourceRoot)
  ) {
    fail("invalid-input", "storageRoot and descriptor.sourceRoot must be disjoint.");
  }
  if (path.dirname(descriptor.preparedRoot) !== storageRoot) {
    fail("invalid-input", "descriptor.preparedRoot must be a direct child of storageRoot.");
  }
  if (!path.basename(descriptor.preparedRoot).startsWith(OWNED_PREFIX)) {
    fail("invalid-input", `descriptor.preparedRoot must use the ${OWNED_PREFIX} owned prefix.`);
  }
  const association = readAssociation(fields.get("association"), descriptor.sourceRoot);
  const accounting = readAccounting(fields.get("accounting"));
  if (associationDigest(association) !== accounting.sourceAssociationSha256) {
    fail("invalid-input", "accounting.sourceAssociationSha256 does not match the owned association.");
  }
  const budget = readBudget(fields.get("budget"), accounting.admittedAt);
  const backendProfile = readBackendProfile(fields.get("backendProfile"));
  const backendBuild = readBackendBuild(fields.get("backendBuild"));

  const preparedRelativeRoot = readRelativePath(
    path.relative(storageRoot, descriptor.preparedRoot),
    "preparedRelativeRoot",
  );
  const workspaceRelativeRoot = readRelativePath(
    path.relative(storageRoot, descriptor.workspaceRoot),
    "workspaceRelativeRoot",
  );
  const storeRelativeRoot = readRelativePath(
    path.relative(storageRoot, descriptor.storeRoot),
    "storeRelativeRoot",
  );
  if (workspaceRelativeRoot !== `${preparedRelativeRoot}/workspace`) {
    fail("invalid-input", "workspaceRelativeRoot must be preparedRelativeRoot/workspace.");
  }
  if (storeRelativeRoot !== `${preparedRelativeRoot}/store`) {
    fail("invalid-input", "storeRelativeRoot must be preparedRelativeRoot/store.");
  }

  const document = {
    schema: NATIVE_HARNESS_RECOVERY_SOURCE_SCHEMA,
    profile: NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE,
    accounting: {
      ownerId: accounting.ownerId,
      admissionId: accounting.admissionId,
      reserveRevision: accounting.reserveRevision,
      sourceAssociationSha256: accounting.sourceAssociationSha256,
      admittedAt: accounting.admittedAt,
    },
    association: {
      observationId: association.observationId,
      generation: association.generation,
      sessionId: association.sessionId,
      workspaceRoot: association.workspaceRoot,
      toolCallId: association.toolCallId,
      toolName: association.toolName,
    },
    budget: {
      maxCostUsd: budget.maxCostUsd,
      deadlineAt: budget.deadlineAt,
      maxDurationMs: budget.maxDurationMs,
    },
    workspace: {
      sourceRoot: descriptor.sourceRoot,
      preparedRelativeRoot,
      workspaceRelativeRoot,
      storeRelativeRoot,
    },
    inputs: descriptor.inputManifest.map((entry) => ({
      relativePath: entry.relativePath,
      bytes: entry.bytes,
      sha256: entry.sha256,
      observedAt: entry.observedAt,
    })),
    inputManifestSha256: descriptor.manifestSha256,
    backendProfile: {
      model: backendProfile.model,
      improverModel: backendProfile.improverModel,
      ompCommand: backendProfile.ompCommand,
      mode: backendProfile.mode,
      strategy: backendProfile.strategy,
      domain: backendProfile.domain,
      adaptation: {
        capabilities: backendProfile.adaptation.capabilities,
        reuse: backendProfile.adaptation.reuse,
        learnMethods: backendProfile.adaptation.learnMethods,
      },
    },
    backendBuild: {
      sourceId: backendBuild.sourceId,
      sourceIntegrity: backendBuild.sourceIntegrity,
    },
  };
  const documentText = `${JSON.stringify(document)}\n`;
  const documentBytes = Buffer.from(documentText, "utf8");
  if (documentBytes.length > NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES) {
    fail(
      "too-large",
      `recovery source document is ${documentBytes.length} bytes; the maximum is ${NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES}.`,
    );
  }

  return {
    storageRoot,
    sourceRoot: descriptor.sourceRoot,
    preparedRoot: descriptor.preparedRoot,
    workspaceRoot: descriptor.workspaceRoot,
    storeRoot: descriptor.storeRoot,
    preparedRelativeRoot,
    workspaceRelativeRoot,
    storeRelativeRoot,
    association,
    accounting,
    budget,
    inputs: descriptor.inputManifest,
    inputManifestSha256: descriptor.manifestSha256,
    backendProfile,
    backendBuild,
    documentText,
    documentBytes,
    documentSha256: sha256Hex(documentBytes),
  };
}

interface LiveContext {
  readonly guard: () => void;
  readonly signal: AbortSignal;
}

function readSignalOnly(live: LiveContext): void {
  const read = readActualAbortSignal(live.signal);
  if (!read.ok) fail("authority-lost", read.reason);
  if (read.aborted) fail("aborted", "the actual host AbortSignal is aborted.");
}

function observeNativePromiseSettlement(value: unknown): boolean {
  if (ACTUAL_PROMISE_THEN === null) return false;
  try {
    // Native then brand-checks the receiver. A real Promise gets two handlers
    // attached solely to consume a possible rejection; an arbitrary thenable
    // throws here and is never assimilated or invoked.
    Reflect.apply(ACTUAL_PROMISE_THEN, value, [() => undefined, () => undefined]);
    return true;
  } catch {
    return false;
  }
}

function runGuard(live: LiveContext): void {
  let result: unknown;
  try {
    result = live.guard();
  } catch (error) {
    fail("authority-lost", "the host guard rejected current authority.", error);
  }
  if (observeNativePromiseSettlement(result)) {
    fail("authority-lost", "the host guard must be synchronous and must not return a Promise.");
  }
  if (isThenable(result)) {
    fail("authority-lost", "the host guard must be synchronous and must not return a Promise or thenable.");
  }
}

function assertLive(live: LiveContext): void {
  readSignalOnly(live);
  runGuard(live);
  readSignalOnly(live);
}

function createLiveContext(guard: unknown, signal: unknown): LiveContext {
  if (typeof guard !== "function") {
    fail("invalid-input", "guard must be a synchronous host function.");
  }
  const read = readActualAbortSignal(signal);
  if (!read.ok) fail("authority-lost", read.reason);
  if (read.aborted) fail("aborted", "the actual host AbortSignal is aborted before any effect.");
  return { guard: guard as () => void, signal: signal as AbortSignal };
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

async function inspectDirectory(live: LiveContext, target: string, label: string): Promise<DirectoryIdentity> {
  assertLive(live);
  let first;
  try {
    first = await nodeFileIo.lstat(target, BIGINT_LSTAT);
  } catch (error) {
    fail("unsafe-path", `${label} is missing or unreadable.`, error);
  }
  assertLive(live);
  if (first.isSymbolicLink() || !first.isDirectory()) {
    fail("unsafe-path", `${label} must be a real directory, not a link or special file.`);
  }
  let resolved: string;
  try {
    resolved = await nodeFileIo.realpath(target);
  } catch (error) {
    fail("identity-changed", `${label} could not be resolved.`, error);
  }
  assertLive(live);
  if (resolved !== target) {
    fail("unsafe-path", `${label} is an alias or traverses a link.`);
  }
  let second;
  try {
    second = await nodeFileIo.lstat(target, BIGINT_LSTAT);
  } catch (error) {
    fail("identity-changed", `${label} disappeared while it was inspected.`, error);
  }
  assertLive(live);
  if (
    second.isSymbolicLink()
    || !second.isDirectory()
    || second.dev !== first.dev
    || second.ino !== first.ino
  ) {
    fail("identity-changed", `${label} changed while it was inspected.`);
  }
  return { path: target, dev: second.dev, ino: second.ino };
}

function assertPinnedLayout(pins: readonly RecoverySourcePin[]): void {
  if (pins.length !== MAX_SOURCE_PINS) {
    fail("invalid-input", "source pins must contain exactly four directories.");
  }
  const roles = ["storage", "prepared", "workspace", "store"] as const;
  for (let index = 0; index < roles.length; index++) {
    if (pins[index]!.role !== roles[index]) {
      fail("invalid-input", "source pins must use the fixed storage/prepared/workspace/store order.");
    }
  }
  const storage = pins[0]!;
  const prepared = pins[1]!;
  const workspace = pins[2]!;
  const store = pins[3]!;
  if (path.dirname(prepared.path) !== storage.path) {
    fail("invalid-input", "prepared pin must be a direct child of the storage pin.");
  }
  if (!path.basename(prepared.path).startsWith(OWNED_PREFIX)) {
    fail("invalid-input", `prepared pin must use the ${OWNED_PREFIX} owned prefix.`);
  }
  if (workspace.path !== path.join(prepared.path, "workspace")) {
    fail("invalid-input", "workspace pin must be prepared/workspace.");
  }
  if (store.path !== path.join(prepared.path, "store")) {
    fail("invalid-input", "store pin must be prepared/store.");
  }
}

type DirectoryGate = (live: LiveContext) => void;

async function verifyPinnedDirectories(
  live: LiveContext,
  pins: readonly RecoverySourcePin[],
  gate: DirectoryGate = assertLive,
): Promise<void> {
  assertPinnedLayout(pins);
  for (const pin of pins) {
    gate(live);
    let resolved: string;
    try {
      resolved = await nodeFileIo.realpath(pin.path);
    } catch (error) {
      fail("identity-changed", `the ${pin.role} directory disappeared.`, error);
    }
    gate(live);
    if (resolved !== pin.path) {
      fail("identity-changed", `the ${pin.role} directory was redirected.`);
    }
    let info;
    try {
      info = await nodeFileIo.lstat(pin.path, BIGINT_LSTAT);
    } catch (error) {
      fail("identity-changed", `the ${pin.role} directory disappeared.`, error);
    }
    gate(live);
    if (
      info.isSymbolicLink()
      || !info.isDirectory()
      || info.dev !== pin.dev
      || info.ino !== pin.ino
    ) {
      fail("identity-changed", `the ${pin.role} directory identity changed.`);
    }
  }
}

/**
 * Final-effect seal for a path-creating open. The preceding mutable guard is
 * deliberately the last one; this recheck uses only the captured actual signal
 * and the fixed four pins. It is not an OS-atomic sandbox, but it closes the
 * guard-callback window between the last authority read and the open.
 */
async function sealPinnedDirectories(
  live: LiveContext,
  pins: readonly RecoverySourcePin[],
): Promise<void> {
  await verifyPinnedDirectories(live, pins, readSignalOnly);
  readSignalOnly(live);
}

async function pinWorkspace(
  live: LiveContext,
  owned: Pick<OwnedInput, "storageRoot" | "sourceRoot" | "preparedRoot" | "workspaceRoot" | "storeRoot">,
): Promise<readonly RecoverySourcePin[]> {
  const storage = await inspectDirectory(live, owned.storageRoot, "storageRoot");
  const source = await inspectDirectory(live, owned.sourceRoot, "sourceRoot");
  if (
    isContained(source.path, storage.path)
    || isContained(storage.path, source.path)
  ) {
    fail("unsafe-path", "storageRoot must be strictly outside sourceRoot.");
  }
  const prepared = await inspectDirectory(live, owned.preparedRoot, "preparedRoot");
  const workspace = await inspectDirectory(live, owned.workspaceRoot, "workspaceRoot");
  const store = await inspectDirectory(live, owned.storeRoot, "storeRoot");
  if (prepared.path !== owned.preparedRoot || workspace.path !== owned.workspaceRoot || store.path !== owned.storeRoot) {
    fail("identity-changed", "the descriptor paths were replaced.");
  }
  const pins: readonly RecoverySourcePin[] = Object.freeze([
    Object.freeze({ role: "storage" as const, ...storage }),
    Object.freeze({ role: "prepared" as const, ...prepared }),
    Object.freeze({ role: "workspace" as const, ...workspace }),
    Object.freeze({ role: "store" as const, ...store }),
  ]);
  assertPinnedLayout(pins);
  await verifyPinnedDirectories(live, pins);
  return pins;
}

async function assertSourceFileShape(
  live: LiveContext,
  pins: readonly RecoverySourcePin[],
  preparedRoot: string,
): Promise<void> {
  const target = path.join(preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE);
  assertLive(live);
  await verifyPinnedDirectories(live, pins);
  assertLive(live);
  let info;
  try {
    // NativeFileStats intentionally omits mode; read the actual node
    // BigIntStats here rather than widening the shared observation interface.
    info = await lstat(target, BIGINT_LSTAT);
  } catch (error) {
    fail("readback-failed", "recovery-source.json is missing or unreadable.", error);
  }
  assertLive(live);
  await verifyPinnedDirectories(live, pins);
  assertLive(live);
  if (info.isSymbolicLink() || !info.isFile()) {
    fail("unsafe-path", "recovery-source.json must be a regular non-link file.");
  }
  if ((info.mode & 0o777n) !== BigInt(SOURCE_FILE_MODE) || (info.mode & 0o7000n) !== 0n) {
    fail("unsafe-path", "recovery-source.json must have mode 0600 and no special bits.");
  }
  if (info.size > BigInt(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES)) {
    fail(
      "too-large",
      `recovery-source.json exceeds ${NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES} bytes.`,
    );
  }
}

interface CloseFailureTracker {
  failure: unknown | null;
}

function createReadbackIo(
  live: LiveContext,
  pins: readonly RecoverySourcePin[],
  preparedRoot: string,
): { readonly io: NativeFileIo; readonly tracker: CloseFailureTracker } {
  const sourcePath = path.join(preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE);
  const tracker: CloseFailureTracker = { failure: null };

  async function enter(): Promise<void> {
    assertLive(live);
    await verifyPinnedDirectories(live, pins);
    assertLive(live);
  }

  async function leave(): Promise<void> {
    assertLive(live);
    await verifyPinnedDirectories(live, pins);
    assertLive(live);
  }

  function assertTarget(target: string, allowRoot: boolean): void {
    if (target === sourcePath) return;
    if (allowRoot && target === preparedRoot) return;
    fail("unsafe-path", "the readback wrapper was asked for a path outside its fixed file and pins.");
  }

  const io: NativeFileIo = {
    O_RDONLY: nodeFileIo.O_RDONLY,
    O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
    async realpath(target: string): Promise<string> {
      assertTarget(target, true);
      await enter();
      const resolved = await nodeFileIo.realpath(target);
      await leave();
      return resolved;
    },
    async lstat(target: string): Promise<NativeFileStats> {
      assertTarget(target, true);
      await enter();
      const info = await nodeFileIo.lstat(target, BIGINT_LSTAT);
      await leave();
      if (target === sourcePath && info.isFile() && info.size > BigInt(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES)) {
        throw new NativeFileError(
          `recovery-source.json exceeds ${NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES} bytes.`,
          "too-large",
        );
      }
      return info;
    },
    async open(target: string, flags: number): Promise<NativeFileHandle> {
      assertTarget(target, false);
      await enter();
      await sealPinnedDirectories(live, pins);
      readSignalOnly(live);
      const handle = await nodeFileIo.open(target, flags | O_NONBLOCK);
      try {
        await enter();
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
      return {
        async stat(): Promise<NativeFileStats> {
          await enter();
          const info = await handle.stat(BIGINT_LSTAT);
          await leave();
          if (info.isFile() && info.size > BigInt(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES)) {
            throw new NativeFileError(
              `recovery-source.json exceeds ${NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES} bytes.`,
              "too-large",
            );
          }
          return info;
        },
        async read(
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ): Promise<{ bytesRead: number }> {
          await enter();
          const result = await handle.read(buffer, offset, length, position);
          await leave();
          return { bytesRead: result.bytesRead };
        },
        async close(): Promise<void> {
          // The caller's guard no longer owns handle reclamation. A close
          // failure is recorded and rethrown; captureWorkspaceText swallows it,
          // so the outer leaf refuses success after the capture returns.
          try {
            await handle.close();
          } catch (error) {
            if (tracker.failure === null) tracker.failure = error;
            throw error;
          }
        },
      };
    },
  };
  return { io, tracker };
}

async function writeSourceDocument(
  live: LiveContext,
  pins: readonly RecoverySourcePin[],
  preparedRoot: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = path.join(preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE);
  assertLive(live);
  await verifyPinnedDirectories(live, pins);
  assertLive(live);

  let absent = false;
  try {
    await nodeFileIo.lstat(target, BIGINT_LSTAT);
  } catch (error) {
    if (isErrno(error, "ENOENT")) absent = true;
    else fail("unsafe-path", "the fixed source path could not be inspected.", error);
  }
  assertLive(live);
  if (!absent) {
    fail("already-exists", "recovery-source.json already exists; refusing to overwrite or replace it.");
  }
  await verifyPinnedDirectories(live, pins);
  assertLive(live);
  await sealPinnedDirectories(live, pins);
  readSignalOnly(live);

  let handle;
  try {
    handle = await open(target, WRITE_FLAGS, SOURCE_FILE_MODE);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      fail("already-exists", "recovery-source.json already exists; refusing to overwrite or replace it.");
    }
    fail("write-failed", "recovery-source.json could not be created exclusively.", error);
  }

  let closeFailure: unknown;
  try {
    assertLive(live);
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written, written);
      if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
        fail("write-failed", "recovery-source.json write made no progress; bytes may exist.");
      }
      written += result.bytesWritten;
      assertLive(live);
    }
    await handle.sync();
    assertLive(live);
  } finally {
    try {
      await handle.close();
    } catch (error) {
      closeFailure = error;
    }
  }
  if (closeFailure !== undefined) {
    fail("write-failed", "recovery-source.json close failed after writing; bytes may exist.", closeFailure);
  }

  await verifyPinnedDirectories(live, pins);
  assertLive(live);
  await sealPinnedDirectories(live, pins);
  readSignalOnly(live);

  let directoryHandle;
  try {
    directoryHandle = await open(preparedRoot, DIRECTORY_READ_FLAGS);
  } catch (error) {
    fail("write-failed", "the prepared directory could not be opened for sync.", error);
  }
  let directoryCloseFailure: unknown;
  try {
    assertLive(live);
    await directoryHandle.sync();
    assertLive(live);
  } finally {
    try {
      await directoryHandle.close();
    } catch (error) {
      directoryCloseFailure = error;
    }
  }
  if (directoryCloseFailure !== undefined) {
    fail("write-failed", "the prepared directory close failed after sync; bytes may exist.", directoryCloseFailure);
  }
  assertLive(live);
  await verifyPinnedDirectories(live, pins);
  assertLive(live);
}

/**
 * One actual bounded capture of the fixed source file. Reused by readback
 * verification and the readonly open; the 16 KiB ceilings, strict UTF-8,
 * mode/link/path shape, O_NONBLOCK wrapper, close-failure tracker and final
 * pin/signal checks are all applied here and nowhere else.
 */
async function captureSourceBack(
  live: LiveContext,
  pins: readonly RecoverySourcePin[],
  preparedRoot: string,
): Promise<NativeWorkspaceTextSnapshot> {
  assertLive(live);
  await verifyPinnedDirectories(live, pins);
  assertLive(live);
  const { io, tracker } = createReadbackIo(live, pins, preparedRoot);
  const snapshot = await captureWorkspaceText(
    preparedRoot,
    NATIVE_HARNESS_RECOVERY_SOURCE_FILE,
    io,
  );
  if (tracker.failure !== null) {
    fail("readback-failed", "recovery-source.json readback close failed; the handle is not claimed closed.", tracker.failure);
  }
  assertLive(live);
  await verifyPinnedDirectories(live, pins);
  assertLive(live);
  await assertSourceFileShape(live, pins, preparedRoot);
  return snapshot;
}

async function readSourceBack(
  live: LiveContext,
  pins: readonly RecoverySourcePin[],
  preparedRoot: string,
  expectedText: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<NativeWorkspaceTextSnapshot> {
  const snapshot = await captureSourceBack(live, pins, preparedRoot);
  if (
    snapshot.file.relativePath !== NATIVE_HARNESS_RECOVERY_SOURCE_FILE
    || snapshot.text !== expectedText
    || snapshot.file.bytes !== expectedBytes
    || snapshot.file.sha256 !== expectedSha256
  ) {
    fail("readback-failed", "recovery-source.json bytes do not match the exact owned document.");
  }
  return snapshot;
}

function readSourceFacts(value: unknown): NativeHarnessRecoverySourceFacts {
  const fields = readStrictFields(
    value,
    [
      "storageRoot",
      "sourceRoot",
      "preparedRoot",
      "workspaceRoot",
      "storeRoot",
      "relativePath",
      "pins",
      "text",
      "bytes",
      "sha256",
    ],
    "source",
  );
  const storageRoot = readString(fields.get("storageRoot"), "source.storageRoot", MAX_PATH_CHARS, true);
  const sourceRoot = readString(fields.get("sourceRoot"), "source.sourceRoot", MAX_PATH_CHARS, true);
  const preparedRoot = readString(fields.get("preparedRoot"), "source.preparedRoot", MAX_PATH_CHARS, true);
  const workspaceRoot = readString(fields.get("workspaceRoot"), "source.workspaceRoot", MAX_PATH_CHARS, true);
  const storeRoot = readString(fields.get("storeRoot"), "source.storeRoot", MAX_PATH_CHARS, true);
  if (fields.get("relativePath") !== NATIVE_HARNESS_RECOVERY_SOURCE_FILE) {
    fail("invalid-input", `source.relativePath must be ${NATIVE_HARNESS_RECOVERY_SOURCE_FILE}.`);
  }
  const text = fields.get("text");
  if (
    typeof text !== "string"
    || text.length < 1
    || text.startsWith("\uFEFF")
    || !text.endsWith("\n")
  ) {
    fail("invalid-input", "source.text must be the exact newline-terminated UTF-8 document without BOM.");
  }
  if (text.length > NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES) {
    fail(
      "too-large",
      `source.text exceeds ${NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES} characters before UTF-8 encoding.`,
    );
  }
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length > NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES) {
    fail("too-large", `source.text exceeds ${NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES} bytes.`);
  }
  const bytes = readSafeInteger(fields.get("bytes"), "source.bytes", 0, NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES);
  if (bytes !== encoded.length) {
    fail("invalid-input", "source.bytes must equal the exact UTF-8 byte length of source.text.");
  }
  const sha256 = readHex64(fields.get("sha256"), "source.sha256");
  if (sha256 !== sha256Hex(encoded)) {
    fail("invalid-input", "source.sha256 must hash the exact UTF-8 bytes of source.text.");
  }
  const rawPins = readPlainArray(fields.get("pins"), MAX_SOURCE_PINS, "source.pins");
  if (rawPins.length !== MAX_SOURCE_PINS) {
    fail("invalid-input", "source.pins must contain exactly four directories.");
  }
  const pins: RecoverySourcePin[] = [];
  for (const rawPin of rawPins) {
    const pinFields = readStrictFields(rawPin, ["role", "path", "dev", "ino"], "source.pin");
    const role = pinFields.get("role");
    if (role !== "storage" && role !== "prepared" && role !== "workspace" && role !== "store") {
      fail("invalid-input", "source.pin.role is invalid.");
    }
    const pinPath = readString(pinFields.get("path"), "source.pin.path", MAX_PATH_CHARS, true);
    const dev = pinFields.get("dev");
    const ino = pinFields.get("ino");
    if (typeof dev !== "bigint" || dev < 0n || typeof ino !== "bigint" || ino < 0n) {
      fail("invalid-input", "source.pin dev/ino must be actual nonnegative bigint identities.");
    }
    pins.push(Object.freeze({ role, path: pinPath, dev, ino }));
  }
  assertPinnedLayout(pins);
  if (
    pins[0]!.path !== storageRoot
    || pins[1]!.path !== preparedRoot
    || pins[2]!.path !== workspaceRoot
    || pins[3]!.path !== storeRoot
  ) {
    fail("invalid-input", "source paths and pins must identify the same four directories.");
  }
  if (
    isContained(sourceRoot, storageRoot)
    || isContained(storageRoot, sourceRoot)
  ) {
    fail("invalid-input", "source.storageRoot and source.sourceRoot must be disjoint.");
  }
  return Object.freeze({
    storageRoot,
    sourceRoot,
    preparedRoot,
    workspaceRoot,
    storeRoot,
    relativePath: NATIVE_HARNESS_RECOVERY_SOURCE_FILE,
    pins: Object.freeze(pins),
    text,
    bytes,
    sha256,
  });
}

function readSourceDocument(
  raw: unknown,
  expectedValue: unknown,
): NativeHarnessRecoverySourceDocument {
  const expectedFields = readStrictFields(
    expectedValue,
    ["storageRoot", "sourceRoot", "preparedRelativeRoot"],
    "source expectation",
  );
  const storageRoot = readString(
    expectedFields.get("storageRoot"),
    "expectation.storageRoot",
    MAX_PATH_CHARS,
    true,
  );
  const expectedSourceRoot = readString(
    expectedFields.get("sourceRoot"),
    "expectation.sourceRoot",
    MAX_PATH_CHARS,
    true,
  );
  const expectedPreparedRelativeRoot = readRelativePath(
    expectedFields.get("preparedRelativeRoot"),
    "expectation.preparedRelativeRoot",
  );
  if (
    isContained(storageRoot, expectedSourceRoot)
    || isContained(expectedSourceRoot, storageRoot)
  ) {
    fail("invalid-input", "expectation.storageRoot and expectation.sourceRoot must be disjoint.");
  }
  const expectedPreparedRoot = path.join(storageRoot, expectedPreparedRelativeRoot);
  if (path.dirname(expectedPreparedRoot) !== storageRoot) {
    fail("invalid-input", "expectation.preparedRelativeRoot must be a direct child of storageRoot.");
  }
  if (!path.basename(expectedPreparedRoot).startsWith(OWNED_PREFIX)) {
    fail("invalid-input", `expectation.preparedRelativeRoot must use the ${OWNED_PREFIX} owned prefix.`);
  }
  readString(expectedPreparedRoot, "expectation.preparedRoot", MAX_PATH_CHARS, true);

  if (typeof raw !== "string") {
    fail("invalid-input", "recovery source document must be UTF-8 text.");
  }
  if (raw.length > NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES) {
    fail("too-large", `recovery source document exceeds ${NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES} characters.`);
  }
  const encoded = Buffer.from(raw, "utf8");
  if (encoded.length > NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES) {
    fail("too-large", `recovery source document exceeds ${NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES} bytes.`);
  }
  if (raw.length === 0 || raw.startsWith("\uFEFF") || !raw.endsWith("\n")) {
    fail("invalid-input", "recovery source document must be newline-terminated UTF-8 without BOM.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail("invalid-input", "recovery source document is not valid JSON. No fallback was applied.", error);
  }
  const fields = readStrictFields(
    value,
    [
      "schema",
      "profile",
      "accounting",
      "association",
      "budget",
      "workspace",
      "inputs",
      "inputManifestSha256",
      "backendProfile",
      "backendBuild",
    ],
    "recovery source document",
  );
  if (fields.get("schema") !== NATIVE_HARNESS_RECOVERY_SOURCE_SCHEMA) {
    fail("invalid-input", "recovery source schema is not the fixed v1 schema.");
  }
  if (fields.get("profile") !== NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE) {
    fail("invalid-input", "recovery source profile is not the fixed native profile.");
  }
  const workspaceFields = readStrictFields(
    fields.get("workspace"),
    ["sourceRoot", "preparedRelativeRoot", "workspaceRelativeRoot", "storeRelativeRoot"],
    "recovery source workspace",
  );
  const sourceRoot = readString(
    workspaceFields.get("sourceRoot"),
    "workspace.sourceRoot",
    MAX_PATH_CHARS,
    true,
  );
  if (sourceRoot !== expectedSourceRoot) {
    fail("identity-changed", "recovery source workspace.sourceRoot does not match the host expectation.");
  }
  if (
    isContained(sourceRoot, storageRoot)
    || isContained(storageRoot, sourceRoot)
  ) {
    fail("invalid-input", "recovery source workspace.sourceRoot and storage root must be disjoint.");
  }
  const preparedRelativeRoot = readRelativePath(
    workspaceFields.get("preparedRelativeRoot"),
    "workspace.preparedRelativeRoot",
  );
  const workspaceRelativeRoot = readRelativePath(
    workspaceFields.get("workspaceRelativeRoot"),
    "workspace.workspaceRelativeRoot",
  );
  const storeRelativeRoot = readRelativePath(
    workspaceFields.get("storeRelativeRoot"),
    "workspace.storeRelativeRoot",
  );
  if (preparedRelativeRoot !== expectedPreparedRelativeRoot) {
    fail("identity-changed", "recovery source preparedRelativeRoot does not match the host expectation.");
  }
  if (workspaceRelativeRoot !== `${preparedRelativeRoot}/workspace`) {
    fail("invalid-input", "workspace.workspaceRelativeRoot must be preparedRelativeRoot/workspace.");
  }
  if (storeRelativeRoot !== `${preparedRelativeRoot}/store`) {
    fail("invalid-input", "workspace.storeRelativeRoot must be preparedRelativeRoot/store.");
  }
  readString(
    path.join(storageRoot, preparedRelativeRoot),
    "workspace.preparedRoot",
    MAX_PATH_CHARS,
    true,
  );
  readString(
    path.join(storageRoot, workspaceRelativeRoot),
    "workspace.workspaceRoot",
    MAX_PATH_CHARS,
    true,
  );
  readString(
    path.join(storageRoot, storeRelativeRoot),
    "workspace.storeRoot",
    MAX_PATH_CHARS,
    true,
  );
  const association = readAssociation(fields.get("association"), sourceRoot);
  const accounting = readAccounting(fields.get("accounting"));
  if (associationDigest(association) !== accounting.sourceAssociationSha256) {
    fail("invalid-input", "accounting.sourceAssociationSha256 does not match the document association.");
  }
  const budget = readBudget(fields.get("budget"), accounting.admittedAt);
  const inputManifestSha256 = readHex64(
    fields.get("inputManifestSha256"),
    "recovery source inputManifestSha256",
  );
  const inputs = readManifest(fields.get("inputs"), inputManifestSha256);
  const backendProfile = readBackendProfile(fields.get("backendProfile"));
  const backendBuild = readBackendBuild(fields.get("backendBuild"));
  return deepFreeze({
    schema: NATIVE_HARNESS_RECOVERY_SOURCE_SCHEMA,
    profile: NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE,
    accounting,
    association,
    budget,
    workspace: {
      sourceRoot,
      preparedRelativeRoot,
      workspaceRelativeRoot,
      storeRelativeRoot,
    },
    inputs,
    inputManifestSha256,
    backendProfile,
    backendBuild,
    bytes: encoded.length,
    sha256: sha256Hex(encoded),
  });
}

interface OwnedOpenExpectation {
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly preparedRelativeRoot: string;
  readonly preparedRoot: string;
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly sourceDescriptorSha256: string;
}

/**
 * Exact four-field host expectation for a readonly open. Values are copied
 * before any guard callback or await; only the fixed prepared/workspace/store
 * layout is derived, so no caller-supplied artifact root, descriptor, pin set
 * or creation flag can redirect the observed source.
 */
function readOpenExpectation(value: unknown): OwnedOpenExpectation {
  const fields = readStrictFields(
    value,
    ["storageRoot", "sourceRoot", "preparedRelativeRoot", "sourceDescriptorSha256"],
    "source open expectation",
  );
  const storageRoot = readString(fields.get("storageRoot"), "expectation.storageRoot", MAX_PATH_CHARS, true);
  const sourceRoot = readString(fields.get("sourceRoot"), "expectation.sourceRoot", MAX_PATH_CHARS, true);
  const preparedRelativeRoot = readRelativePath(
    fields.get("preparedRelativeRoot"),
    "expectation.preparedRelativeRoot",
  );
  const sourceDescriptorSha256 = readHex64(
    fields.get("sourceDescriptorSha256"),
    "expectation.sourceDescriptorSha256",
  );
  if (
    isContained(storageRoot, sourceRoot)
    || isContained(sourceRoot, storageRoot)
  ) {
    fail("invalid-input", "expectation.storageRoot and expectation.sourceRoot must be disjoint.");
  }
  const preparedRoot = path.join(storageRoot, preparedRelativeRoot);
  if (path.dirname(preparedRoot) !== storageRoot) {
    fail("invalid-input", "expectation.preparedRelativeRoot must be a direct child of storageRoot.");
  }
  if (!path.basename(preparedRoot).startsWith(OWNED_PREFIX)) {
    fail("invalid-input", `expectation.preparedRelativeRoot must use the ${OWNED_PREFIX} owned prefix.`);
  }
  readString(preparedRoot, "expectation.preparedRoot", MAX_PATH_CHARS, true);
  const workspaceRoot = path.join(storageRoot, `${preparedRelativeRoot}/workspace`);
  const storeRoot = path.join(storageRoot, `${preparedRelativeRoot}/store`);
  readString(workspaceRoot, "expectation.workspaceRoot", MAX_PATH_CHARS, true);
  readString(storeRoot, "expectation.storeRoot", MAX_PATH_CHARS, true);
  return Object.freeze({
    storageRoot,
    sourceRoot,
    preparedRelativeRoot,
    preparedRoot,
    workspaceRoot,
    storeRoot,
    sourceDescriptorSha256,
  });
}

/**
 * Pure bounded decoder for one already-read `recovery-source.json` text.
 * It reuses the writer's fixed field/value readers, verifies the exact
 * schema/profile, confined relative layout, manifest triples, association
 * digest and the host path expectations. It performs no filesystem, process,
 * signal, write, controller or network effect, never constructs a prepared
 * source or completion handle and never calls the writer/verifier. The
 * returned SHA-256 hashes the exact supplied bytes; reordered raw JSON is not
 * normalized or re-signed. Host path expectations are caller-supplied values,
 * not proof that those directories or files exist.
 */
export function decodeNativeHarnessRecoverySourceText(
  raw: string,
  expected: NativeHarnessRecoverySourceTextExpectation,
): NativeHarnessRecoverySourceDocument {
  return readSourceDocument(raw, expected);
}

/**
 * Readonly opening of one existing source document. It pins the fixed four
 * directories from the exact four-field host expectation, captures the fixed
 * file once through the shared bounded reader, decodes that exact text and
 * requires the raw captured SHA-256 to equal `sourceDescriptorSha256`, then
 * reseals the original pins, guard and signal before freezing facts.
 *
 * It creates no directory, file, seed or prepared source, writes and removes
 * nothing, reads no source input bytes and never treats supplied pins or a
 * workspace descriptor as sufficient. The result is an observation only, not
 * a permission, lease, durability claim or resume license; the file may
 * change after this call and must be re-observed by a later join.
 */
export async function openNativeHarnessRecoverySource(
  expected: NativeHarnessRecoverySourceOpenExpectation,
  guard: () => void,
  signal: AbortSignal,
): Promise<Readonly<{
  source: NativeHarnessRecoverySourceFacts;
  document: NativeHarnessRecoverySourceDocument;
}>> {
  const owned = readOpenExpectation(expected);
  const live = createLiveContext(guard, signal);
  assertLive(live);

  const pins = await pinWorkspace(live, owned);
  assertLive(live);
  // Apply the original file shape/ceiling before the common capture so an
  // oversized or linked file is refused with the owned error classification.
  await assertSourceFileShape(live, pins, owned.preparedRoot);

  const snapshot = await captureSourceBack(live, pins, owned.preparedRoot);
  const document = decodeNativeHarnessRecoverySourceText(snapshot.text, {
    storageRoot: owned.storageRoot,
    sourceRoot: owned.sourceRoot,
    preparedRelativeRoot: owned.preparedRelativeRoot,
  });
  if (
    snapshot.file.relativePath !== NATIVE_HARNESS_RECOVERY_SOURCE_FILE
    || document.bytes !== snapshot.file.bytes
    || document.sha256 !== snapshot.file.sha256
  ) {
    fail("readback-failed", "the decoded document does not describe the exact captured bytes.");
  }
  if (snapshot.file.sha256 !== owned.sourceDescriptorSha256) {
    fail("readback-failed", "recovery-source.json raw SHA-256 does not match the expected source descriptor SHA-256.");
  }

  // Final original pin/guard/signal seal. No further host callback is made
  // before the frozen observation is returned.
  assertLive(live);
  await verifyPinnedDirectories(live, pins);
  assertLive(live);
  await sealPinnedDirectories(live, pins);
  // The seal's own final signal read happens before this async continuation
  // resumes. Re-read the captured actual signal synchronously after the last
  // await so an abort in that scheduling gap cannot return frozen facts.
  readSignalOnly(live);

  const source: NativeHarnessRecoverySourceFacts = deepFreeze({
    storageRoot: owned.storageRoot,
    sourceRoot: owned.sourceRoot,
    preparedRoot: owned.preparedRoot,
    workspaceRoot: owned.workspaceRoot,
    storeRoot: owned.storeRoot,
    relativePath: NATIVE_HARNESS_RECOVERY_SOURCE_FILE,
    pins,
    text: snapshot.text,
    bytes: snapshot.file.bytes,
    sha256: snapshot.file.sha256,
  });
  return deepFreeze({ source, document });
}

function buildSeedText(
  owned: OwnedInput,
  sourceDescriptorSha256: string,
): string {
  const seedText = JSON.stringify({
    schema: NATIVE_HARNESS_RECOVERY_SEED_SCHEMA,
    profile: NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE,
    accountingOwnerId: owned.accounting.ownerId,
    admissionId: owned.accounting.admissionId,
    accountingOwnerRevision: owned.accounting.reserveRevision,
    sourceAssociationSha256: owned.accounting.sourceAssociationSha256,
    sourceDescriptorSha256,
    inputManifestSha256: owned.inputManifestSha256,
    admittedAt: owned.accounting.admittedAt,
    deadlineAt: owned.budget.deadlineAt,
    allocatedCostUsd: owned.budget.maxCostUsd,
  });
  if (Buffer.byteLength(seedText, "utf8") > NATIVE_HARNESS_RECOVERY_SEED_MAX_BYTES) {
    fail("too-large", `recovery seed exceeds ${NATIVE_HARNESS_RECOVERY_SEED_MAX_BYTES} bytes.`);
  }
  return seedText;
}

/**
 * Creates the one fixed source document below the already-prepared private
 * root, syncs it, reads the exact bytes back through the shared bounded reader,
 * and returns owned facts only after that readback matches. A rejection may
 * leave a partially written or fully written document; this leaf never
 * overwrites, renames, retries or removes it.
 */
export async function prepareNativeHarnessRecoverySource(
  input: SourceInput,
  guard: () => void,
  signal: AbortSignal,
): Promise<PreparedRecoverySource> {
  const owned = readSourceInput(input);
  const live = createLiveContext(guard, signal);
  assertLive(live);

  const pins = await pinWorkspace(live, owned);
  assertLive(live);
  await verifyPinnedDirectories(live, pins);
  assertLive(live);

  await writeSourceDocument(live, pins, owned.preparedRoot, owned.documentBytes);
  await assertSourceFileShape(live, pins, owned.preparedRoot);
  const snapshot = await readSourceBack(
    live,
    pins,
    owned.preparedRoot,
    owned.documentText,
    owned.documentBytes.length,
    owned.documentSha256,
  );

  const seedText = buildSeedText(owned, snapshot.file.sha256);
  const sourceDescriptorSha256 = snapshot.file.sha256;
  const accountingPrepared: NativeHarnessAccountingPrepared = Object.freeze({
    preparedRelativeRoot: owned.preparedRelativeRoot,
    storeRelativeRoot: owned.storeRelativeRoot,
    inputManifestSha256: owned.inputManifestSha256,
    sourceDescriptorSha256,
  });
  const source: NativeHarnessRecoverySourceFacts = deepFreeze({
    storageRoot: owned.storageRoot,
    sourceRoot: owned.sourceRoot,
    preparedRoot: owned.preparedRoot,
    workspaceRoot: owned.workspaceRoot,
    storeRoot: owned.storeRoot,
    relativePath: NATIVE_HARNESS_RECOVERY_SOURCE_FILE,
    pins,
    text: owned.documentText,
    bytes: owned.documentBytes.length,
    sha256: owned.documentSha256,
  });

  // No further host callback. This is an observation gate, not a grant.
  readSignalOnly(live);
  return deepFreeze({ accountingPrepared, seedText, source });
}

/**
 * Re-observes the four pinned directories and the one fixed file. The exact
 * original text, bytes and hash must match; a missing file, changed bytes,
 * JSON reordering, link/root replacement or close failure refuses success.
 * This verifies current observations only and never rewrites or resigns.
 */
export async function verifyNativeHarnessRecoverySource(
  source: PreparedRecoverySource["source"],
  guard: () => void,
  signal: AbortSignal,
): Promise<void> {
  const facts = readSourceFacts(source);
  const live = createLiveContext(guard, signal);
  assertLive(live);

  await inspectDirectory(live, facts.storageRoot, "storageRoot");
  const sourceRoot = await inspectDirectory(live, facts.sourceRoot, "sourceRoot");
  if (
    isContained(sourceRoot.path, facts.storageRoot)
    || isContained(facts.storageRoot, sourceRoot.path)
  ) {
    fail("unsafe-path", "storageRoot must be strictly outside sourceRoot.");
  }
  await inspectDirectory(live, facts.preparedRoot, "preparedRoot");
  await inspectDirectory(live, facts.workspaceRoot, "workspaceRoot");
  await inspectDirectory(live, facts.storeRoot, "storeRoot");
  await verifyPinnedDirectories(live, facts.pins);
  await assertSourceFileShape(live, facts.pins, facts.preparedRoot);
  await readSourceBack(
    live,
    facts.pins,
    facts.preparedRoot,
    facts.text,
    facts.bytes,
    facts.sha256,
  );
  readSignalOnly(live);
}
