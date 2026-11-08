import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { AcceptanceContract } from "./acceptance-contract.ts";
import {
  CandidateError,
  type CandidateReadPort,
  type CandidateSnapshot,
  type FileIdentity,
  type FrozenTaskRef,
} from "./execution-candidates.ts";
import type { ExecutionActivitySnapshot } from "./execution-adapter.ts";
import { currentTaskOwner, subjectFromContext, type OmpToolContext } from "./task-entry-port.ts";
import type { ManagedTask, TaskOwner, TaskSubject } from "./task-owner.ts";
import { requirementsDigest } from "./task-requirements.ts";
import type { VerificationLookup, VerificationReceipt } from "./verification-service.ts";

/**
 * G2-B2-A delivery service.
 *
 * It freezes a real verified candidate selection into private read-only files
 * under a host-configured absolute delivery root and reports an honest,
 * bounded preview. It never accepts a task, submits, reserves ownership,
 * starts a process, runs a verifier or contacts a remote service. Registry
 * state is process-only and is populated exclusively by this service's own
 * successful write path.
 */

export const DELIVERY_BUNDLE_VERSION = "g2b2a-delivery-v1";
export const DELIVERY_MANIFEST_NAME = "manifest.json";
export const DELIVERY_REQUIREMENTS_NAME = "requirements.json";
export const MAX_DELIVERY_BUNDLES_PER_TASK = 8;
export const MAX_DELIVERY_ARTIFACTS = 8;
export const MAX_DELIVERY_ARTIFACT_BYTES = 256 * 1024;
export const MAX_DELIVERY_ARTIFACT_TOTAL_BYTES = 1024 * 1024;
export const MAX_DELIVERY_REQUIREMENTS_BYTES = 64 * 1024;
export const MAX_DELIVERY_MANIFEST_BYTES = 128 * 1024;
export const MAX_DELIVERY_INLINE_BYTES = 8 * 1024;
export const MAX_DELIVERY_INLINE_FILE_BYTES = 2048;
export const MAX_DELIVERY_CONTENT_BYTES = 32 * 1024;
export const MAX_DELIVERY_RESPONSE_BYTES = 64 * 1024;

const SUMMARY_LIMITS_FULL: SummaryTextLimits = {
  statement: 1024,
  conditionDescription: 512,
  receiptDetail: 300,
  receiptReason: 500,
};
const SUMMARY_LIMITS_COMPACT: SummaryTextLimits = {
  statement: 256,
  conditionDescription: 128,
  receiptDetail: 120,
  receiptReason: 200,
};
const SUMMARY_LIMITS_MINIMAL: SummaryTextLimits = {
  statement: 96,
  conditionDescription: 64,
  receiptDetail: 64,
  receiptReason: 96,
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".md", ".py", ".js", ".ts", ".log",
  ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".html", ".xml", ".yaml", ".yml",
]);

export class DeliveryError extends Error {
  override name = "DeliveryError";
  constructor(message: string, readonly busy = false) {
    super(message);
  }
}

export interface DeliveryPreviewRequest {
  expectedTaskId: string;
  expectedTaskRevision: number;
  runId: string;
  artifactIds: readonly string[];
  verificationReceiptId?: string;
}

export interface DeliveryRecheckRequest {
  expectedTaskId: string;
  expectedTaskRevision: number;
  deliveryId: string;
}

export interface DeliveryToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface DeliveryPreviewOutcome {
  result: DeliveryToolResult;
  /** Present only for a successful preview whose final entry guard still applies. */
  task?: FrozenTaskRef;
}

export interface DeliveryFileRow {
  artifactId: string;
  relativePath: string;
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface DeliveryRecheckOutcome {
  deliveryId: string;
  task: FrozenTaskRef;
  runId: string;
  artifactIds: string[];
  files: DeliveryFileRow[];
  manifest: { path: string; bytes: number; sha256: string };
  requirements: { path: string; bytes: number; sha256: string };
  previewDigest: string;
  contractDigest: string | null;
  receiptId: string | null;
  receiptOutcome: string | null;
  checkedAt: string;
}

export interface DeliveryServiceOptions {
  owner: TaskOwner;
  candidates: CandidateReadPort;
  activity: () => ExecutionActivitySnapshot;
  currentContract: (context: OmpToolContext) => { task: FrozenTaskRef; contract: AcceptanceContract | null };
  lookup: (context: OmpToolContext, receiptId: string) => Promise<VerificationLookup | null>;
  deliveryRoot: string;
  executionRoot: string;
  now?: () => string;
  id?: () => string;
  diagnostic?: (message: string, details?: Record<string, unknown>) => void;
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

/** Canonical configured root plus every canonical ancestor identity. */
interface DeliveryRoot extends DirectoryIdentity {
  chain: DirectoryIdentity[];
}

interface BundleFileRecord {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  identity: FileIdentity;
}

interface DisplayText {
  text: string;
  originalBytes: number;
  shownBytes: number;
  omittedBytes: number;
  truncated: boolean;
}

interface PreviewFileRow {
  artifactId: string;
  relativePath: string;
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  preview:
    | { inline: false; reason: string }
    | {
      inline: true;
      encoding: "utf-8";
      shownBytes: number;
      omittedBytes: number;
      truncated: boolean;
      text: string;
    };
}

interface PreviewPayload {
  version: "g2b2a-preview-v1";
  deliveryId: string;
  createdAt: string;
  task: FrozenTaskRef;
  run: { runId: string; callId: string };
  source: { bytes: number; sha256: string };
  inputs: Array<{ id: string; bytes: number; sha256: string }>;
  files: PreviewFileRow[];
  requirements: { name: string; bytes: number; sha256: string; sources: number };
  contract: { state: "none" } | { state: "bound"; summary: ContractSummary };
  verification:
    | { state: "not_referenced"; note: string }
    | {
      state: "referenced";
      receipt: ReceiptSummary;
      limitations: string[];
    };
}

interface DeliveryRecord {
  deliveryId: string;
  key: string;
  task: FrozenTaskRef;
  runId: string;
  artifactIds: string[];
  snapshotId: string;
  contractDigest: string | null;
  receiptId: string | null;
  receiptDigest: string | null;
  receiptOutcome: string | null;
  bundleDir: string;
  bundleIdentity: DirectoryIdentity;
  files: DeliveryFileRow[];
  fileIdentities: Map<string, FileIdentity>;
  manifest: BundleFileRecord;
  requirements: BundleFileRecord;
  previewPayload: PreviewPayload;
  previewDigest: string;
  summaryLimits: SummaryTextLimits;
  createdAt: string;
}

interface SummaryTextLimits {
  statement: number;
  conditionDescription: number;
  receiptDetail: number;
  receiptReason: number;
}

interface ContractSummary {
  contractId: string;
  digest: string;
  hostConfig: { id: string; version: string };
  verifier: { id: string; version: string; parametersDigest: string };
  coverage: {
    kind: "semantic" | "integrity";
    complete: boolean;
    coveredRevisions: number[];
    statement: string;
    statementOriginalBytes: number;
    statementShownBytes: number;
    statementOmittedBytes: number;
    statementTruncated: boolean;
    partialSemanticCoverage: boolean;
  };
  conditions: Array<{
    conditionId: string;
    kind: "semantic" | "integrity";
    coveredRevisions: number[];
    description: string;
    descriptionOriginalBytes: number;
    descriptionShownBytes: number;
    descriptionOmittedBytes: number;
    descriptionTruncated: boolean;
  }>;
}

interface ReceiptConditionSummary {
  conditionId: string;
  kind: string;
  result: string;
  coveredRevisions: number[];
  description: string;
  descriptionOriginalBytes: number;
  descriptionShownBytes: number;
  descriptionOmittedBytes: number;
  descriptionTruncated: boolean;
  detail: string | null;
  detailOriginalBytes: number;
  detailShownBytes: number;
  detailOmittedBytes: number;
  detailTruncated: boolean;
}

interface ReceiptSummary {
  receiptId: string;
  outcome: string;
  reason: string;
  reasonOriginalBytes: number;
  reasonShownBytes: number;
  reasonOmittedBytes: number;
  reasonTruncated: boolean;
  compatibility: string;
  usable: boolean;
  contract: { contractId: string; digest: string } | null;
  conditions: ReceiptConditionSummary[];
  uncoveredRevisions: number[];
  limits: { timeoutMs: number; timedOut: boolean; limitExceeded: boolean; verifierResultBytes: number };
  persistence: "process-only";
}

interface BundleRead {
  data: Map<string, Buffer>;
  manifest: BundleFileRecord;
  requirements: BundleFileRecord;
  manifestValue: Record<string, unknown>;
}

interface PreviewRenderRef {
  bundleDir: string;
  manifest: { path: string; bytes: number; sha256: string };
  requirements: { path: string; bytes: number; sha256: string };
  previewDigest: string;
}

interface PreviewBuildInput {
  deliveryId: string;
  createdAt: string;
  bundleDir: string;
  task: FrozenTaskRef;
  runId: string;
  callId: string;
  snapshot: CandidateSnapshot;
  artifactFiles: Array<{ artifactId: string; relativePath: string; name: string }>;
  fileRecords: readonly BundleFileRecord[];
  requirementsRecord: BundleFileRecord;
  requirementsSources: number;
  contract: ContractSummary | null;
  receipt: ReceiptSummary | null;
  includeInline: boolean;
  limits: SummaryTextLimits;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(data: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function hexDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function bounded(text: string, limit = MAX_DELIVERY_CONTENT_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new DeliveryError(`${label} must be a valid identifier.`);
  }
  return value;
}

function positiveRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new DeliveryError("expectedTaskRevision must be a positive integer.");
  }
  return value;
}

function frozenOf(task: ManagedTask): FrozenTaskRef {
  return {
    ownerId: task.ownerId,
    taskId: task.taskId,
    taskRevision: task.taskRevision,
    requirementsDigest: requirementsDigest(task.requirementSources),
  };
}

function sameFrozen(left: FrozenTaskRef, right: FrozenTaskRef): boolean {
  return left.ownerId === right.ownerId
    && left.taskId === right.taskId
    && left.taskRevision === right.taskRevision
    && left.requirementsDigest === right.requirementsDigest;
}

function copyTask(task: FrozenTaskRef): FrozenTaskRef {
  return { ...task };
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function extensionFor(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  return SAFE_EXTENSIONS.has(extension) ? extension : ".bin";
}

function contractSummary(contract: AcceptanceContract, limits: SummaryTextLimits): ContractSummary {
  const statement = displayText(contract.coverage.statement, limits.statement);
  return {
    contractId: contract.contractId,
    digest: contract.digest,
    hostConfig: { id: contract.hostConfig.id, version: contract.hostConfig.version },
    verifier: {
      id: contract.verifier.id,
      version: contract.verifier.version,
      parametersDigest: contract.verifier.parametersDigest,
    },
    coverage: {
      kind: contract.coverage.kind,
      complete: contract.coverage.complete,
      coveredRevisions: [...contract.coverage.coveredRevisions],
      statement: statement.text,
      statementOriginalBytes: statement.originalBytes,
      statementShownBytes: statement.shownBytes,
      statementOmittedBytes: statement.omittedBytes,
      statementTruncated: statement.truncated,
      partialSemanticCoverage: contract.coverage.kind === "semantic" && !contract.coverage.complete,
    },
    conditions: contract.conditions.map((condition) => {
      const description = displayText(condition.description, limits.conditionDescription);
      return {
        conditionId: condition.conditionId,
        kind: condition.kind,
        coveredRevisions: [...condition.coveredRevisions],
        description: description.text,
        descriptionOriginalBytes: description.originalBytes,
        descriptionShownBytes: description.shownBytes,
        descriptionOmittedBytes: description.omittedBytes,
        descriptionTruncated: description.truncated,
      };
    }),
  };
}

function receiptSummary(
  receipt: VerificationReceipt,
  compatibility: string,
  usable: boolean,
  limits: SummaryTextLimits,
): ReceiptSummary {
  const reason = displayText(receipt.reason ?? "", limits.receiptReason);
  return {
    receiptId: receipt.receiptId,
    outcome: receipt.outcome,
    reason: reason.text,
    reasonOriginalBytes: reason.originalBytes,
    reasonShownBytes: reason.shownBytes,
    reasonOmittedBytes: reason.omittedBytes,
    reasonTruncated: reason.truncated,
    compatibility,
    usable,
    contract: receipt.contract === null
      ? null
      : { contractId: receipt.contract.contractId, digest: receipt.contract.digest },
    conditions: receipt.conditions.map((condition) => {
      const description = displayText(condition.description, limits.conditionDescription);
      const detail = condition.detail === null
        ? null
        : displayText(condition.detail, limits.receiptDetail);
      return {
        conditionId: condition.conditionId,
        kind: condition.kind,
        result: condition.result,
        coveredRevisions: [...condition.coveredRevisions],
        description: description.text,
        descriptionOriginalBytes: description.originalBytes,
        descriptionShownBytes: description.shownBytes,
        descriptionOmittedBytes: description.omittedBytes,
        descriptionTruncated: description.truncated,
        detail: detail?.text ?? null,
        detailOriginalBytes: detail?.originalBytes ?? 0,
        detailShownBytes: detail?.shownBytes ?? 0,
        detailOmittedBytes: detail?.omittedBytes ?? 0,
        detailTruncated: detail?.truncated ?? false,
      };
    }),
    uncoveredRevisions: [...receipt.uncoveredRevisions],
    limits: {
      timeoutMs: receipt.limits.timeoutMs,
      timedOut: receipt.limits.timedOut,
      limitExceeded: receipt.limits.limitExceeded,
      verifierResultBytes: receipt.limits.verifierResultBytes,
    },
    persistence: receipt.persistence,
  };
}

function receiptDigest(summary: ReceiptSummary): string {
  return sha256(JSON.stringify(summary));
}

function isFormatControl(code: number): boolean {
  return code === 0x00ad
    || code === 0x061c
    || code === 0x180e
    || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x2028 && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x206f)
    || code === 0xfeff
    || (code >= 0xfff9 && code <= 0xfffb)
    || (code >= 0xe0000 && code <= 0xe007f);
}

function escapeControl(text: string): string {
  let result = "";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === "\n" || character === "\t") {
      result += character;
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      result += `\\x${code.toString(16).padStart(2, "0")}`;
    } else if (isFormatControl(code)) {
      result += code <= 0xffff
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : `\\u{${code.toString(16)}}`;
    } else {
      result += character;
    }
  }
  return result;
}

/** Safe model-visible rendering boundary; manifest and file bytes stay raw. */
export function deliverySafeText(text: string): string {
  return escapeControl(text);
}

/** UTF-8 byte truncation on a code-point boundary. */
export function deliveryBoundUtf8(text: string, limit: number): string {
  return bounded(text, limit);
}

/**
 * Bound a non-authoritative explanation for display. `shownBytes` and
 * `omittedBytes` count original UTF-8 bytes, not the escaped expansion.
 */
function displayText(value: string, maxShownBytes: number): DisplayText {
  const originalBytes = Buffer.byteLength(value, "utf8");
  const escaped = escapeControl(value);
  if (Buffer.byteLength(escaped, "utf8") <= maxShownBytes) {
    return {
      text: escaped,
      originalBytes,
      shownBytes: originalBytes,
      omittedBytes: 0,
      truncated: false,
    };
  }
  let text = "";
  let shownBytes = 0;
  for (const character of value) {
    const piece = escapeControl(character);
    const nextBytes = Buffer.byteLength(text + piece, "utf8");
    if (nextBytes > maxShownBytes) break;
    text += piece;
    shownBytes += Buffer.byteLength(character, "utf8");
  }
  return {
    text,
    originalBytes,
    shownBytes,
    omittedBytes: originalBytes - shownBytes,
    truncated: true,
  };
}

function textWindow(data: Buffer, maxBytes: number): {
  encoding: "utf-8";
  shownBytes: number;
  omittedBytes: number;
  truncated: boolean;
  text: string;
} | null {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
  if (data.length <= maxBytes) {
    return {
      encoding: "utf-8",
      shownBytes: data.length,
      omittedBytes: 0,
      truncated: false,
      text: escapeControl(decoded),
    };
  }
  let end = maxBytes;
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end -= 1;
  const prefix = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, end));
  return {
    encoding: "utf-8",
    shownBytes: end,
    omittedBytes: data.length - end,
    truncated: true,
    text: escapeControl(prefix),
  };
}

function deliveryKey(input: {
  task: FrozenTaskRef;
  runId: string;
  artifacts: Array<{ artifactId: string; sha256: string; bytes: number }>;
  contractDigest: string | null;
  receiptId: string | null;
}): string {
  return sha256(JSON.stringify({
    version: "g2b2a-delivery-key-v1",
    task: input.task,
    runId: input.runId,
    artifacts: [...input.artifacts].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    contractDigest: input.contractDigest,
    receiptId: input.receiptId,
  }));
}

function rejection(reason: string, options: { action: "describe" | "preview" | "recheck"; busy?: boolean }): DeliveryToolResult {
  const text = bounded([
    `agent_deliver ${options.action} rejected`,
    "taskAccepted: false",
    "acceptanceImplemented: false",
    "submissionAvailable: false",
    `reason: ${reason}`,
    ...(options.busy === true ? ["busy: true"] : []),
  ].join("\n"));
  return {
    content: [{ type: "text", text }],
    details: {
      action: options.action,
      taskAccepted: false,
      acceptanceImplemented: false,
      submissionAvailable: false,
      busy: options.busy === true,
      withheld: true,
    },
    isError: true,
  };
}

function isBusyError(error: unknown): boolean {
  return error instanceof DeliveryError
    ? error.busy
    : error instanceof Error && error.name === "VerificationGateBusyError";
}

function assertResponseBound(result: DeliveryToolResult): void {
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes > MAX_DELIVERY_RESPONSE_BYTES) {
    throw new DeliveryError("The delivery response exceeded its fixed byte budget.");
  }
}

/**
 * Record every canonical ancestor from the filesystem root to the configured
 * delivery root. Canonicalization accepts the platform's trusted alias
 * normalization (for example macOS /tmp -> /private/tmp), while every recorded
 * component must remain a real directory with the same device/inode.
 */
function canonicalRootChain(canonical: string): DirectoryIdentity[] {
  const parsed = path.parse(canonical);
  const chain: DirectoryIdentity[] = [];
  let current = parsed.root;
  const rootInfo = lstatSync(current);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new DeliveryError("A canonical delivery root ancestor is not a real directory.");
  }
  chain.push({ path: current, dev: rootInfo.dev, ino: rootInfo.ino });
  const relative = canonical.slice(parsed.root.length);
  for (const segment of relative.split(path.sep)) {
    if (segment.length === 0) continue;
    current = path.join(current, segment);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new DeliveryError("A canonical delivery root ancestor is a link or non-directory.");
    }
    chain.push({ path: current, dev: info.dev, ino: info.ino });
  }
  if (current !== canonical) {
    throw new DeliveryError("The canonical delivery root path was not preserved.");
  }
  return chain;
}

function resolveRoot(configured: string, executionRoot: string): { root: DeliveryRoot; executionCanonical: string } {
  if (typeof configured !== "string" || !path.isAbsolute(configured)) {
    throw new DeliveryError("deliveryRoot must be an explicit absolute host path.");
  }
  const resolved = path.resolve(configured);
  const name = path.basename(resolved);
  if (!name || name === "." || name === "..") {
    throw new DeliveryError("deliveryRoot must name a directory.");
  }
  let canonical: string;
  if (existsSync(resolved)) {
    const info = lstatSync(resolved);
    if (info.isSymbolicLink()) {
      throw new DeliveryError("deliveryRoot itself must not be a symbolic link.");
    }
    if (!info.isDirectory()) {
      throw new DeliveryError("deliveryRoot must be an existing directory.");
    }
    canonical = realpathSync(resolved);
    const canonicalInfo = lstatSync(canonical);
    if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) {
      throw new DeliveryError("deliveryRoot did not resolve to a real directory.");
    }
  } else {
    const parent = path.dirname(resolved);
    let canonicalParent: string;
    try {
      canonicalParent = realpathSync(parent);
    } catch {
      throw new DeliveryError("deliveryRoot's parent must already exist as a real directory.");
    }
    try {
      if (!statSync(canonicalParent).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new DeliveryError("deliveryRoot's parent must already exist as a real directory.");
    }
    const target = path.join(canonicalParent, name);
    if (existsSync(target)) {
      const info = lstatSync(target);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new DeliveryError("deliveryRoot was concurrently replaced by a link or non-directory.");
      }
      canonical = realpathSync(target);
    } else {
      mkdirSync(target, { mode: 0o700 });
      const created = lstatSync(target);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new DeliveryError("deliveryRoot creation did not produce a real directory.");
      }
      const actual = realpathSync(target);
      if (actual !== target) {
        throw new DeliveryError("deliveryRoot was replaced while it was created.");
      }
      canonical = actual;
    }
  }
  let executionCanonical: string;
  try {
    executionCanonical = realpathSync(executionRoot);
  } catch {
    executionCanonical = path.resolve(executionRoot);
  }
  if (within(canonical, executionCanonical) || within(executionCanonical, canonical)) {
    throw new DeliveryError("deliveryRoot must not equal or overlap the execution root.");
  }
  const rootInfo = lstatSync(canonical);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new DeliveryError("deliveryRoot is not a real directory.");
  }
  const chain = canonicalRootChain(canonical);
  return {
    root: { path: canonical, dev: rootInfo.dev, ino: rootInfo.ino, chain },
    executionCanonical,
  };
}

/**
 * Walk an existing directory chain below the recorded root without following
 * links. The recorded canonical ancestor chain and the root identity are
 * rechecked first; inside the root every component must be a real directory.
 */
async function directoryChain(
  root: DeliveryRoot,
  target: string,
  expected?: readonly DirectoryIdentity[],
): Promise<DirectoryIdentity[]> {
  const relative = path.relative(root.path, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new DeliveryError("A delivery path is outside the host-configured root.");
  }
  for (const component of root.chain) {
    const info = await lstat(component.path);
    if (info.isSymbolicLink()
      || !info.isDirectory()
      || info.dev !== component.dev
      || info.ino !== component.ino) {
      throw new DeliveryError("A canonical delivery root ancestor was replaced after configuration.");
    }
  }
  const chain: DirectoryIdentity[] = [];
  const rootInfo = await lstat(root.path);
  if (rootInfo.isSymbolicLink()
    || !rootInfo.isDirectory()
    || rootInfo.dev !== root.dev
    || rootInfo.ino !== root.ino) {
    throw new DeliveryError("The delivery root was replaced after configuration.");
  }
  chain.push({ path: root.path, dev: rootInfo.dev, ino: rootInfo.ino });
  if (relative === "") {
    if (expected !== undefined && expected.length !== 1) {
      throw new DeliveryError("A delivery directory chain changed after publication.");
    }
    return chain;
  }
  let current = root.path;
  for (const segment of relative.split(path.sep)) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new DeliveryError("A delivery path chain is invalid.");
    }
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new DeliveryError("A delivery path chain contains a link or non-directory.");
    }
    chain.push({ path: current, dev: info.dev, ino: info.ino });
  }
  if (expected !== undefined) {
    if (expected.length !== chain.length) {
      throw new DeliveryError("A delivery directory chain changed after publication.");
    }
    for (let index = 0; index < chain.length; index += 1) {
      const actual = chain[index]!;
      const recorded = expected[index]!;
      if (actual.path !== recorded.path || actual.dev !== recorded.dev || actual.ino !== recorded.ino) {
        throw new DeliveryError("A delivery directory was replaced after publication.");
      }
    }
  }
  return chain;
}

async function readBundleFile(
  root: DeliveryRoot,
  filePath: string,
  expectedDirectories: readonly DirectoryIdentity[] | undefined,
  maxBytes: number,
): Promise<{ record: BundleFileRecord; data: Buffer }> {
  await directoryChain(root, path.dirname(filePath), expectedDirectories);
  const before = await lstat(filePath);
  if (before.isSymbolicLink()) throw new DeliveryError("A delivery file is a symbolic link.");
  if (!before.isFile()) throw new DeliveryError("A delivery file is not an ordinary file.");
  if (before.nlink !== 1) throw new DeliveryError("A delivery file has multiple hard links.");
  if (before.size > maxBytes) throw new DeliveryError("A delivery file exceeds its byte budget.");
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size) {
      throw new DeliveryError("A delivery file changed before it was opened.");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new DeliveryError("A delivery file changed while it was read.");
    const after = await lstat(filePath);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.nlink !== 1) {
      throw new DeliveryError("A delivery file changed during the read.");
    }
    const data = Buffer.from(buffer.subarray(0, offset));
    const digest = sha256(data);
    return {
      record: {
        name: path.basename(filePath),
        path: filePath,
        bytes: data.length,
        sha256: digest,
        identity: { dev: opened.dev, ino: opened.ino, size: opened.size, sha256: digest },
      },
      data,
    };
  } finally {
    await handle.close();
  }
}

async function writeBundleFile(
  root: DeliveryRoot,
  directory: string,
  name: string,
  data: Buffer,
  maxBytes: number,
  expectedDirectories?: readonly DirectoryIdentity[],
): Promise<BundleFileRecord> {
  if (data.length > maxBytes) throw new DeliveryError("A delivery file exceeds its byte budget.");
  await directoryChain(root, directory, expectedDirectories);
  const filePath = path.join(directory, name);
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await handle.write(data, offset, data.length - offset);
      if (bytesWritten <= 0) throw new DeliveryError("A delivery file write made no progress.");
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const read = await readBundleFile(root, filePath, expectedDirectories, maxBytes);
  if (read.record.bytes !== data.length || read.record.sha256 !== sha256(data)) {
    throw new DeliveryError("A written delivery file did not round-trip to the same bytes.");
  }
  return read.record;
}

export class DeliveryService {
  private readonly owner: TaskOwner;
  private readonly candidates: CandidateReadPort;
  private readonly activity: () => ExecutionActivitySnapshot;
  private readonly currentContractPort: (context: OmpToolContext) => { task: FrozenTaskRef; contract: AcceptanceContract | null };
  private readonly lookupPort: (context: OmpToolContext, receiptId: string) => Promise<VerificationLookup | null>;
  private readonly root: DeliveryRoot;
  private readonly executionRoot: string;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly diagnostic: (message: string, details?: Record<string, unknown>) => void;
  private readonly records = new Map<string, DeliveryRecord>();
  private readonly byKey = new Map<string, string>();
  private readonly allocations = new Map<string, number>();
  private held = false;
  private disposed = false;

  constructor(options: DeliveryServiceOptions) {
    if (currentTaskOwner() !== options.owner) {
      throw new DeliveryError("The delivery service must use the published task owner.");
    }
    const resolved = resolveRoot(options.deliveryRoot, options.executionRoot);
    this.owner = options.owner;
    this.candidates = options.candidates;
    this.activity = options.activity;
    this.currentContractPort = options.currentContract;
    this.lookupPort = options.lookup;
    this.root = resolved.root;
    this.executionRoot = resolved.executionCanonical;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.id ?? (() => randomUUID());
    this.diagnostic = options.diagnostic ?? ((message, details) => {
      try {
        process.stderr.write(`${JSON.stringify({ type: "omp_agent_delivery", message, ...(details === undefined ? {} : { details }) })}\n`);
      } catch {
        // A diagnostic channel is not guaranteed.
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.held = false;
  }

  /** Synchronous live authority read used by the entry's final guard. */
  finalGuard(context: OmpToolContext, expected: FrozenTaskRef): string | null {
    if (this.disposed) return "the delivery service is disposed";
    if (currentTaskOwner() !== this.owner) return "the managed task owner changed";
    const reason = this.readReason(context);
    if (reason !== null) return reason;
    const task = this.readTask(context, true);
    if (task === null) return "the current managed task is not reachable and active";
    if (!sameFrozen(frozenOf(task), expected)) return "the current task identity or revision changed";
    return null;
  }

  private liveSubject(context: OmpToolContext): TaskSubject | null {
    if (currentTaskOwner() !== this.owner) return null;
    try {
      const subject = subjectFromContext(context, this.owner.workspaceRoot);
      return subject.agentKind === "main" ? subject : null;
    } catch {
      return null;
    }
  }

  private readTask(context: OmpToolContext, requireActive: boolean): ManagedTask | null {
    if (this.disposed || currentTaskOwner() !== this.owner) return null;
    const subject = this.liveSubject(context);
    if (subject === null) return null;
    if (this.owner.bindingStatus().state !== "attached") return null;
    try {
      const task = this.owner.reachableTask(subject);
      return requireActive && task.status !== "active" ? null : task;
    } catch {
      return null;
    }
  }

  private readReason(context: OmpToolContext): string | null {
    if (this.disposed) return "the delivery service is disposed";
    if (currentTaskOwner() !== this.owner) return "the managed task owner changed";
    let subject: TaskSubject;
    try {
      subject = subjectFromContext(context, this.owner.workspaceRoot);
    } catch {
      return "the live OMP main-session context or workspace is unavailable";
    }
    if (subject.agentKind !== "main") return "delivery is available only to the main agent session";
    if (this.owner.bindingStatus().state !== "attached") return "the conversation binding is detached";
    let task: ManagedTask;
    try {
      task = this.owner.reachableTask(subject);
    } catch {
      return "no managed task is reachable from the current main-session branch";
    }
    if (task.status !== "active") return "the current managed task is cancelled";
    return null;
  }

  private acquire(): boolean {
    if (this.disposed || this.held) return false;
    this.held = true;
    return true;
  }

  private release(): void {
    this.held = false;
  }

  private abortCheckpoint(signal: AbortSignal | undefined, message: string): void {
    if (signal?.aborted) throw new DeliveryError(message);
  }

  /**
   * Remove only a directory this call created and still owns. A failed mkdir,
   * a replaced path, a changed root chain or an unconfirmed identity leaves the
   * object alone and records a bounded host diagnostic instead.
   */
  private async discardOwnedDirectory(directory: DirectoryIdentity, label: string): Promise<void> {
    try {
      await directoryChain(this.root, path.dirname(directory.path));
    } catch (error) {
      this.diagnostic(`${label}_cleanup_withheld`, {
        reason: "the configured root chain no longer matches",
        error: errorMessage(error).slice(0, 500),
      });
      return;
    }
    let info;
    try {
      info = await lstat(directory.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.diagnostic(`${label}_cleanup_withheld`, {
        reason: "the owned directory could not be re-read",
        error: errorMessage(error).slice(0, 500),
      });
      return;
    }
    if (info.isSymbolicLink()
      || !info.isDirectory()
      || info.dev !== directory.dev
      || info.ino !== directory.ino) {
      this.diagnostic(`${label}_cleanup_withheld`, {
        reason: "the directory identity changed; a colliding object was not removed",
      });
      return;
    }
    try {
      await rm(directory.path, { recursive: true, force: true });
    } catch (error) {
      this.diagnostic(`${label}_cleanup_failed`, { error: errorMessage(error).slice(0, 500) });
    }
  }

  private activityFacts(): { snapshot: ExecutionActivitySnapshot; unsupported: string[]; supported: string[] } {
    const snapshot = this.activity();
    const authorized = this.owner.snapshot().authorizedCapabilities;
    const supported = authorized.filter((capability) => capability === snapshot.capabilityId);
    const unsupported = authorized.filter((capability) => capability !== snapshot.capabilityId).sort();
    return { snapshot, unsupported, supported };
  }

  private blockers(activity: ExecutionActivitySnapshot, unsupported: readonly string[]): string[] {
    const blockers = ["submission_not_implemented"];
    if (activity.disposed) blockers.push("disposed");
    if (activity.busy) blockers.push("busy");
    if (activity.unresolvedCompletions.length > 0 || activity.unresolvedOmitted > 0) blockers.push("unresolved_completion");
    if (unsupported.length > 0) blockers.push("activity_coverage_unsupported");
    return blockers;
  }

  private contractLine(context: OmpToolContext, limits: SummaryTextLimits = SUMMARY_LIMITS_FULL): {
    summary: ContractSummary | null;
    task: FrozenTaskRef | null;
    status: string;
  } {
    try {
      const current = this.currentContractPort(context);
      return {
        summary: current.contract === null ? null : contractSummary(current.contract, limits),
        task: copyTask(current.task),
        status: "available",
      };
    } catch (error) {
      if (isBusyError(error)) return { summary: null, task: null, status: "busy" };
      return { summary: null, task: null, status: "unavailable" };
    }
  }

  /** Final synchronous live task read; no host callback may follow a successful response. */
  private liveIdentity(context: OmpToolContext): FrozenTaskRef | null {
    if (this.disposed || currentTaskOwner() !== this.owner) return null;
    try {
      const subject = subjectFromContext(context, this.owner.workspaceRoot);
      if (subject.agentKind !== "main") return null;
      if (this.owner.bindingStatus().state !== "attached") return null;
      const task = this.owner.reachableTask(subject);
      if (task.status !== "active") return null;
      return frozenOf(task);
    } catch {
      return null;
    }
  }

  private unavailableDescribe(reason: string): DeliveryToolResult {
    const text = bounded([
      `agent_deliver describe ${DELIVERY_BUNDLE_VERSION}`,
      "taskAccepted: false",
      "acceptanceImplemented: false",
      "submissionAvailable: false",
      "submissionReason: not_implemented",
      "taskAvailable: false",
      "task: null",
      `contract: ${JSON.stringify({ status: "unavailable" })}`,
      `unavailableReason: ${deliverySafeText(reason)}`,
      `submissionBlockers: ${JSON.stringify(["submission_not_implemented", "task_unavailable"])}`,
      "capability: no current task identity, contract or delivery path is presented while the live binding is unavailable",
    ].join("\n"));
    return {
      content: [{ type: "text", text }],
      details: {
        action: "describe",
        taskAccepted: false,
        acceptanceImplemented: false,
        submissionAvailable: false,
        submissionReason: "not_implemented",
        taskAvailable: false,
        task: null,
        contract: { status: "unavailable" },
        unavailableReason: reason,
        submissionBlockers: ["submission_not_implemented", "task_unavailable"],
      },
    };
  }

  describe(context: OmpToolContext): DeliveryToolResult {
    if (this.disposed) return rejection("the delivery service is disposed", { action: "describe" });
    const activity = this.activityFacts();
    const afterActivity = this.liveIdentity(context);
    if (afterActivity === null) {
      return this.unavailableDescribe("the live task, main-session context or bound conversation changed during describe");
    }
    const task = this.readTask(context, true);
    if (task === null || !sameFrozen(frozenOf(task), afterActivity)) {
      return this.unavailableDescribe("the live task identity changed while describe read the owner");
    }
    const contract = this.contractLine(context);
    const finalIdentity = this.liveIdentity(context);
    if (finalIdentity === null || !sameFrozen(finalIdentity, frozenOf(task))) {
      return this.unavailableDescribe("the live task, main-session context or bound conversation changed during describe");
    }
    const contractView = contract.status !== "available"
      ? { status: contract.status }
      : contract.task !== null && !sameFrozen(contract.task, finalIdentity)
        ? { status: "unavailable" }
        : contract.summary === null
          ? { state: "none" }
          : { state: "bound", summary: contract.summary };
    const fixed = {
      version: DELIVERY_BUNDLE_VERSION,
      deliveryRoot: this.root.path,
      deliveryRootIdentity: { dev: this.root.dev, ino: this.root.ino },
      executionRootIdentity: this.executionRoot,
      task: {
        taskId: task.taskId,
        taskRevision: task.taskRevision,
        requirementsDigest: requirementsDigest(task.requirementSources),
      },
      contract: contractView,
      activity: {
        busy: activity.snapshot.busy,
        busyTask: activity.snapshot.busyTask,
        activeRunId: activity.snapshot.activeRunId,
        unresolvedCompletions: activity.snapshot.unresolvedCompletions,
        unresolvedOmitted: activity.snapshot.unresolvedOmitted,
        disposed: activity.snapshot.disposed,
      },
      activityCoverage: {
        observedCapabilityId: activity.snapshot.capabilityId,
        supportedCapabilityIds: activity.supported,
        unsupportedCapabilityIds: activity.unsupported,
        note: activity.unsupported.length > 0
          ? "only the local execution adapter is observed; these other side-effect capabilities are not known to be idle"
          : "only the local execution adapter is observed; no other authorized side-effect capability exists",
      },
      submissionBlockers: this.blockers(activity.snapshot, activity.unsupported),
      limits: {
        maxBundlesPerTask: MAX_DELIVERY_BUNDLES_PER_TASK,
        maxArtifacts: MAX_DELIVERY_ARTIFACTS,
        maxArtifactBytes: MAX_DELIVERY_ARTIFACT_BYTES,
        maxArtifactTotalBytes: MAX_DELIVERY_ARTIFACT_TOTAL_BYTES,
        maxRequirementsBytes: MAX_DELIVERY_REQUIREMENTS_BYTES,
        maxManifestBytes: MAX_DELIVERY_MANIFEST_BYTES,
        maxInlinePreviewBytes: MAX_DELIVERY_INLINE_BYTES,
        maxResponseBytes: MAX_DELIVERY_RESPONSE_BYTES,
      },
      taskAccepted: false,
      acceptanceImplemented: false,
      submissionAvailable: false,
      submissionReason: "not_implemented",
    };
    const text = deliverySafeText([
      `agent_deliver describe ${DELIVERY_BUNDLE_VERSION}`,
      "taskAccepted: false",
      "acceptanceImplemented: false",
      "submissionAvailable: false",
      "submissionReason: not_implemented",
      `deliveryRoot: ${JSON.stringify({ path: this.root.path, dev: this.root.dev, ino: this.root.ino })}`,
      `executionRoot: ${JSON.stringify(this.executionRoot)}`,
      `task: ${JSON.stringify(fixed.task)}`,
      `contract: ${JSON.stringify(fixed.contract)}`,
      `activity: ${JSON.stringify(fixed.activity)}`,
      `activityCoverage: ${JSON.stringify(fixed.activityCoverage)}`,
      `submissionBlockers: ${JSON.stringify(fixed.submissionBlockers)}`,
      `limits: ${JSON.stringify(fixed.limits)}`,
      "capability: bounded candidate-file export only; preview never submits, accepts, reviews, reserves ownership, verifies or cancels anything",
    ].join("\n"));
    if (new TextEncoder().encode(text).byteLength > MAX_DELIVERY_CONTENT_BYTES) {
      return rejection("describe facts exceeded the fixed content budget; no task, contract or path facts are shown.", { action: "describe" });
    }
    const result: DeliveryToolResult = {
      content: [{ type: "text", text }],
      details: {
        action: "describe",
        taskAccepted: false,
        acceptanceImplemented: false,
        submissionAvailable: false,
        submissionReason: "not_implemented",
        deliveryRoot: this.root.path,
        task: fixed.task,
        contract: fixed.contract,
        activity: fixed.activity,
        activityCoverage: fixed.activityCoverage,
        submissionBlockers: fixed.submissionBlockers,
      },
    };
    assertResponseBound(result);
    return result;
  }

  private async contractCheck(
    context: OmpToolContext,
    expected: FrozenTaskRef,
    expectedDigest: string | null,
    limits: SummaryTextLimits = SUMMARY_LIMITS_FULL,
  ): Promise<ContractSummary | null> {
    let current: { task: FrozenTaskRef; contract: AcceptanceContract | null };
    try {
      current = this.currentContractPort(context);
    } catch (error) {
      throw isBusyError(error)
        ? new DeliveryError("verification is busy; the delivery read was rejected without queueing.", true)
        : new DeliveryError("the current host contract is unavailable; the delivery read was rejected.");
    }
    if (!sameFrozen(current.task, expected)) {
      throw new DeliveryError("the current task identity changed during the delivery read.");
    }
    const summary = current.contract === null ? null : contractSummary(current.contract, limits);
    if ((summary?.digest ?? null) !== expectedDigest) {
      throw new DeliveryError("the current host contract changed during the delivery read.");
    }
    return summary;
  }

  private validateReceipt(
    found: VerificationLookup,
    expected: FrozenTaskRef,
    runId: string,
    snapshot: CandidateSnapshot,
    limits: SummaryTextLimits,
  ): ReceiptSummary {
    if (found.compatibility === "unavailable") {
      throw new DeliveryError("the referenced verification receipt was withheld because the live context changed.");
    }
    const receipt = found.receipt;
    if (receipt.task.ownerId !== expected.ownerId
      || receipt.task.taskId !== expected.taskId
      || receipt.task.taskRevision !== expected.taskRevision
      || receipt.task.requirementsDigest !== expected.requirementsDigest) {
      throw new DeliveryError("the referenced verification receipt belongs to a different owner, task, revision or requirements digest.");
    }
    if (receipt.candidates.runId !== runId) {
      throw new DeliveryError("the referenced verification receipt covers a different run.");
    }
    const sortRows = <T extends { artifactId: string }>(rows: readonly T[]): T[] =>
      [...rows].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    const receiptArtifacts = sortRows(receipt.candidates.artifacts);
    const snapshotArtifacts = sortRows(snapshot.artifacts);
    if (receiptArtifacts.length !== snapshotArtifacts.length) {
      throw new DeliveryError("the referenced verification receipt covers a different candidate set.");
    }
    for (let index = 0; index < snapshotArtifacts.length; index += 1) {
      const recorded = receiptArtifacts[index]!;
      const actual = snapshotArtifacts[index]!;
      if (recorded.artifactId !== actual.artifactId
        || recorded.bytes !== actual.bytes
        || recorded.sha256 !== actual.sha256
        || recorded.relativePath !== actual.relativePath) {
        throw new DeliveryError("the referenced verification receipt's candidate artifacts do not match this selection.");
      }
    }
    if (receipt.candidates.source === null
      || receipt.candidates.source.bytes !== snapshot.source.bytes
      || receipt.candidates.source.sha256 !== snapshot.source.sha256) {
      throw new DeliveryError("the referenced verification receipt's source digest does not match this run.");
    }
    const sortInputs = <T extends { id: string }>(rows: readonly T[]): T[] =>
      [...rows].sort((left, right) => left.id.localeCompare(right.id));
    const receiptInputs = sortInputs(receipt.candidates.inputs);
    const snapshotInputs = sortInputs(snapshot.inputs);
    if (receiptInputs.length !== snapshotInputs.length) {
      throw new DeliveryError("the referenced verification receipt's input set does not match this run.");
    }
    for (let index = 0; index < snapshotInputs.length; index += 1) {
      const recorded = receiptInputs[index]!;
      const actual = snapshotInputs[index]!;
      if (recorded.id !== actual.id || recorded.bytes !== actual.bytes || recorded.sha256 !== actual.sha256) {
        throw new DeliveryError("the referenced verification receipt's input digests do not match this run.");
      }
    }
    return receiptSummary(receipt, found.compatibility, found.usable, limits);
  }

  private async readReceipt(
    context: OmpToolContext,
    receiptId: string,
    expected: FrozenTaskRef,
    runId: string,
    snapshot: CandidateSnapshot,
    limits: SummaryTextLimits,
  ): Promise<ReceiptSummary> {
    let found: VerificationLookup | null;
    try {
      found = await this.lookupPort(context, receiptId);
    } catch (error) {
      throw isBusyError(error)
        ? new DeliveryError("verification is busy; the delivery read was rejected without queueing.", true)
        : new DeliveryError("the referenced verification receipt is unavailable.");
    }
    if (found === null) {
      throw new DeliveryError("the referenced verification receipt is unknown; a receipt selector is never treated as omitting it.");
    }
    return this.validateReceipt(found, expected, runId, snapshot, limits);
  }

  private async verifyBundle(record: DeliveryRecord): Promise<BundleRead> {
    await directoryChain(this.root, record.bundleDir, [
      { path: this.root.path, dev: this.root.dev, ino: this.root.ino },
      record.bundleIdentity,
    ]);
    const entries = await readdir(record.bundleDir);
    const expectedNames = new Set([
      DELIVERY_MANIFEST_NAME,
      DELIVERY_REQUIREMENTS_NAME,
      ...record.files.map((file) => file.name),
    ]);
    if (entries.length !== expectedNames.size || entries.some((entry) => !expectedNames.has(entry))) {
      throw new DeliveryError("The published delivery directory contains an unexpected entry.");
    }
    const data = new Map<string, Buffer>();
    for (const file of record.files) {
      const read = await readBundleFile(
        this.root,
        path.join(record.bundleDir, file.name),
        [{ path: this.root.path, dev: this.root.dev, ino: this.root.ino }, record.bundleIdentity],
        MAX_DELIVERY_ARTIFACT_BYTES,
      );
      const recorded = record.fileIdentities.get(file.name);
      if (recorded === undefined
        || recorded.dev !== read.record.identity.dev
        || recorded.ino !== read.record.identity.ino
        || recorded.size !== read.record.identity.size
        || recorded.sha256 !== read.record.identity.sha256
        || file.bytes !== read.record.bytes
        || file.sha256 !== read.record.sha256) {
        throw new DeliveryError("A published delivery file changed after registration.");
      }
      data.set(file.name, read.data);
    }
    const manifestRead = await readBundleFile(
      this.root,
      record.manifest.path,
      [{ path: this.root.path, dev: this.root.dev, ino: this.root.ino }, record.bundleIdentity],
      MAX_DELIVERY_MANIFEST_BYTES,
    );
    if (record.manifest.bytes !== manifestRead.record.bytes
      || record.manifest.sha256 !== manifestRead.record.sha256
      || record.manifest.identity.dev !== manifestRead.record.identity.dev
      || record.manifest.identity.ino !== manifestRead.record.identity.ino
      || record.manifest.identity.size !== manifestRead.record.identity.size
      || record.manifest.identity.sha256 !== manifestRead.record.identity.sha256) {
      throw new DeliveryError("The published delivery manifest changed after registration.");
    }
    const requirementsRead = await readBundleFile(
      this.root,
      record.requirements.path,
      [{ path: this.root.path, dev: this.root.dev, ino: this.root.ino }, record.bundleIdentity],
      MAX_DELIVERY_REQUIREMENTS_BYTES,
    );
    if (record.requirements.bytes !== requirementsRead.record.bytes
      || record.requirements.sha256 !== requirementsRead.record.sha256
      || record.requirements.identity.dev !== requirementsRead.record.identity.dev
      || record.requirements.identity.ino !== requirementsRead.record.identity.ino
      || record.requirements.identity.size !== requirementsRead.record.identity.size
      || record.requirements.identity.sha256 !== requirementsRead.record.identity.sha256) {
      throw new DeliveryError("The published requirements file changed after registration.");
    }
    let manifestValue: unknown;
    try {
      manifestValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestRead.data));
    } catch {
      throw new DeliveryError("The published delivery manifest is not valid UTF-8 JSON.");
    }
    if (typeof manifestValue !== "object" || manifestValue === null || Array.isArray(manifestValue)) {
      throw new DeliveryError("The published delivery manifest is not an object.");
    }
    const manifest = manifestValue as Record<string, unknown>;
    if (manifest.deliveryId !== record.deliveryId || manifest.previewDigest !== record.previewDigest) {
      throw new DeliveryError("The published delivery manifest identity does not match the registered delivery.");
    }
    if (typeof manifest.previewPayload !== "object" || manifest.previewPayload === null) {
      throw new DeliveryError("The published delivery manifest has no frozen preview payload.");
    }
    if (JSON.stringify(manifest.previewPayload) !== JSON.stringify(record.previewPayload)
      || sha256(JSON.stringify(manifest.previewPayload)) !== record.previewDigest) {
      throw new DeliveryError("The published delivery preview payload or its digest changed after registration.");
    }
    return {
      data,
      manifest: manifestRead.record,
      requirements: requirementsRead.record,
      manifestValue: manifest,
    };
  }

  private renderFileRows(record: DeliveryRecord): DeliveryFileRow[] {
    return record.files.map((file) => ({
      artifactId: file.artifactId,
      relativePath: file.relativePath,
      name: file.name,
      path: path.join(record.bundleDir, file.name),
      bytes: file.bytes,
      sha256: file.sha256,
    }));
  }

  private verificationLimitations(
    contract: ContractSummary | null,
    receipt: ReceiptSummary,
  ): string[] {
    const limitations = [
      "the referenced receipt is an existing verification record, not acceptance evidence",
      ...(receipt.outcome === "pass" ? [] : ["the referenced check did not pass"]),
      ...(receipt.compatibility === "current" ? [] : ["the referenced receipt is not current"]),
      ...(receipt.reason === "" ? [] : [`receipt reason: ${receipt.reason}`]),
      ...(contract?.coverage.partialSemanticCoverage
        ? ["the bound contract declares partial semantic coverage; listing every requirement revision does not establish complete semantic coverage"]
        : []),
      ...(contract?.coverage.kind === "integrity"
        ? ["the bound contract covers integrity only, not task semantics"]
        : []),
    ];
    if (receipt.outcome === "insufficient") {
      limitations.push("the receipt outcome is insufficient, not a pass");
      const notPassed = receipt.conditions
        .filter((condition) => condition.kind === "semantic" && condition.result !== "pass")
        .map((condition) => condition.conditionId);
      if (notPassed.length > 0) {
        limitations.push(`semantic condition(s) without a pass: ${notPassed.join(", ")}`);
      }
      if (receipt.uncoveredRevisions.length > 0) {
        limitations.push(`uncovered requirement revision(s): ${receipt.uncoveredRevisions.join(", ")}`);
      } else if (contract?.coverage.complete) {
        limitations.push("every listed requirement revision is covered, but the receipt itself remains insufficient");
      } else {
        limitations.push("no requirement revision is listed as uncovered; this does not make partial semantic coverage complete");
      }
    }
    return limitations;
  }

  private buildPreviewPayload(input: PreviewBuildInput): PreviewPayload {
    let remainingInlineBytes = MAX_DELIVERY_INLINE_BYTES;
    const files: PreviewFileRow[] = input.artifactFiles.map((artifact, index) => {
      const file = input.fileRecords[index]!;
      const data = input.snapshot.artifacts[index]!.data;
      let preview: PreviewFileRow["preview"];
      if (!input.includeInline) {
        preview = { inline: false, reason: "inline preview omitted to fit the response budget" };
      } else if (remainingInlineBytes <= 0) {
        preview = { inline: false, reason: "aggregate inline preview budget exhausted" };
      } else {
        const window = textWindow(
          data,
          Math.min(MAX_DELIVERY_INLINE_FILE_BYTES, remainingInlineBytes),
        );
        if (window !== null) remainingInlineBytes -= window.shownBytes;
        preview = window === null
          ? { inline: false, reason: "binary or invalid UTF-8; no inline preview" }
          : { ...window, inline: true };
      }
      return {
        artifactId: artifact.artifactId,
        relativePath: deliverySafeText(artifact.relativePath),
        name: artifact.name,
        path: path.join(input.bundleDir, artifact.name),
        bytes: file.bytes,
        sha256: file.sha256,
        preview,
      };
    });
    const verification: PreviewPayload["verification"] = input.receipt === null
      ? {
        state: "not_referenced",
        note: "no verification receipt was referenced; this is not evidence that a check ran",
      }
      : {
        state: "referenced",
        receipt: input.receipt,
        limitations: this.verificationLimitations(input.contract, input.receipt),
      };
    return {
      version: "g2b2a-preview-v1",
      deliveryId: input.deliveryId,
      createdAt: input.createdAt,
      task: copyTask(input.task),
      run: { runId: input.runId, callId: input.callId },
      source: { bytes: input.snapshot.source.bytes, sha256: input.snapshot.source.sha256 },
      inputs: input.snapshot.inputs.map((item) => ({ id: item.id, bytes: item.bytes, sha256: item.sha256 })),
      files,
      requirements: {
        name: input.requirementsRecord.name,
        bytes: input.requirementsRecord.bytes,
        sha256: input.requirementsRecord.sha256,
        sources: input.requirementsSources,
      },
      contract: input.contract === null
        ? { state: "none" }
        : { state: "bound", summary: input.contract },
      verification,
    };
  }

  private previewText(
    record: PreviewRenderRef,
    payload: PreviewPayload,
    activity: ReturnType<DeliveryService["activityFacts"]>,
    compactActivity: boolean,
  ): string {
    const activityView = compactActivity
      ? {
        busy: activity.snapshot.busy,
        activeRunId: activity.snapshot.activeRunId,
        unresolved: activity.snapshot.unresolvedCompletions.length,
        unresolvedOmitted: activity.snapshot.unresolvedOmitted,
        disposed: activity.snapshot.disposed,
        detailsOmitted: true,
      }
      : {
        busy: activity.snapshot.busy,
        busyTask: activity.snapshot.busyTask,
        activeRunId: activity.snapshot.activeRunId,
        unresolvedCompletions: activity.snapshot.unresolvedCompletions,
        unresolvedOmitted: activity.snapshot.unresolvedOmitted,
        disposed: activity.snapshot.disposed,
      };
    const lines = [
      `agent_deliver preview ${DELIVERY_BUNDLE_VERSION}`,
      "taskAccepted: false",
      "acceptanceImplemented: false",
      "submissionAvailable: false",
      "submissionReason: not_implemented",
      `deliveryId: ${payload.deliveryId}`,
      `task: ${JSON.stringify(payload.task)}`,
      `runId: ${payload.run.runId}`,
      `createdAt: ${payload.createdAt}`,
      `bundleDir: ${record.bundleDir}`,
      `source: ${JSON.stringify(payload.source)}`,
      `inputs: ${JSON.stringify(payload.inputs)}`,
      `requirementsSources: ${JSON.stringify(payload.requirements)}`,
      `manifest: ${JSON.stringify({ path: record.manifest.path, bytes: record.manifest.bytes, sha256: record.manifest.sha256 })}`,
      `requirements: ${JSON.stringify({ path: record.requirements.path, bytes: record.requirements.bytes, sha256: record.requirements.sha256 })}`,
      `files: ${JSON.stringify(payload.files)}`,
      `previewDigest: ${record.previewDigest}`,
      `previewDigestScope: ${JSON.stringify("sha256 of JSON.stringify(manifest.previewPayload); activity is a live overlay outside this frozen preview digest")}`,
      `contract: ${JSON.stringify(payload.contract)}`,
      `verification: ${JSON.stringify(payload.verification)}`,
      `activity: ${JSON.stringify(activityView)}`,
      `activityCoverage: ${JSON.stringify({
        observedCapabilityId: activity.snapshot.capabilityId,
        supportedCapabilityIds: activity.supported,
        unsupportedCapabilityIds: activity.unsupported,
        note: activity.unsupported.length > 0
          ? "only the local execution adapter is observed; these other side-effect capabilities are not known to be idle"
          : "only the local execution adapter is observed; no other authorized side-effect capability exists",
      })}`,
      `submissionBlockers: ${JSON.stringify(this.blockers(activity.snapshot, activity.unsupported))}`,
      "note: these are real read-only host files, not artifact://, file:// or download links; preview does not submit, accept, verify or cancel anything",
    ];
    return deliverySafeText(lines.join("\n"));
  }

  private previewResult(
    record: DeliveryRecord,
    activity: ReturnType<DeliveryService["activityFacts"]>,
  ): DeliveryToolResult {
    const payload = record.previewPayload;
    let text = this.previewText(record, payload, activity, false);
    if (new TextEncoder().encode(text).byteLength > MAX_DELIVERY_CONTENT_BYTES) {
      text = this.previewText(record, payload, activity, true);
    }
    if (new TextEncoder().encode(text).byteLength > MAX_DELIVERY_CONTENT_BYTES) {
      throw new DeliveryError("The required delivery facts exceed the model-visible content budget.");
    }
    const result: DeliveryToolResult = {
      content: [{ type: "text", text }],
      details: {
        action: "preview",
        taskAccepted: false,
        acceptanceImplemented: false,
        submissionAvailable: false,
        submissionReason: "not_implemented",
        deliveryId: record.deliveryId,
        taskId: record.task.taskId,
        taskRevision: record.task.taskRevision,
        runId: record.runId,
        artifactCount: record.files.length,
        manifestSha256: record.manifest.sha256,
        requirementsSha256: record.requirements.sha256,
        previewDigest: record.previewDigest,
        previewPayloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
        previewDigestScope: "frozen manifest.previewPayload; activity is a separate live overlay",
        contractDigest: record.contractDigest,
        verification: payload.verification.state === "not_referenced"
          ? { state: "not_referenced" }
          : {
            state: "referenced",
            receiptId: payload.verification.receipt.receiptId,
            outcome: payload.verification.receipt.outcome,
            usable: payload.verification.receipt.usable,
            reason: payload.verification.receipt.reason,
            limitations: payload.verification.limitations,
          },
        activity: {
          busy: activity.snapshot.busy,
          busyTask: activity.snapshot.busyTask,
          unresolved: activity.snapshot.unresolvedCompletions.length,
          disposed: activity.snapshot.disposed,
        },
        activityCoverage: {
          supportedCapabilityIds: activity.supported,
          unsupportedCapabilityIds: activity.unsupported,
        },
        submissionBlockers: this.blockers(activity.snapshot, activity.unsupported),
      },
    };
    assertResponseBound(result);
    return result;
  }

  private async recheckEvidence(
    record: DeliveryRecord,
    context: OmpToolContext,
    expected: FrozenTaskRef,
    snapshot: CandidateSnapshot,
    receiptId: string | null,
    signal: AbortSignal | undefined,
  ): Promise<{ contract: ContractSummary | null; receipt: ReceiptSummary | null }> {
    if (record.snapshotId !== snapshot.snapshotId) {
      throw new DeliveryError("The delivery's candidate snapshot identity changed.");
    }
    const contract = await this.contractCheck(context, expected, record.contractDigest);
    this.abortCheckpoint(signal, "the call was aborted while the host contract was checked.");
    let receipt: ReceiptSummary | null = null;
    if (receiptId !== null) {
      receipt = await this.readReceipt(context, receiptId, expected, record.runId, snapshot, record.summaryLimits);
      this.abortCheckpoint(signal, "the call was aborted while the verification receipt was checked.");
      if (receiptDigest(receipt) !== record.receiptDigest) {
        throw new DeliveryError("The referenced verification receipt changed after delivery registration.");
      }
    } else if (record.receiptDigest !== null) {
      throw new DeliveryError("The delivery's referenced receipt identity changed.");
    }
    return { contract, receipt };
  }

  async preview(
    context: OmpToolContext,
    request: DeliveryPreviewRequest,
    signal?: AbortSignal,
  ): Promise<DeliveryPreviewOutcome> {
    if (this.disposed) return { result: rejection("the delivery service is disposed.", { action: "preview" }) };
    if (signal?.aborted) return { result: rejection("the call was aborted before delivery admission.", { action: "preview" }) };
    if (!this.acquire()) {
      return {
        result: rejection(
          "another delivery call already owns this service; the call was rejected without queueing.",
          { action: "preview", busy: true },
        ),
      };
    }
    try {
      const expectedTaskId = identifier(request.expectedTaskId, "expectedTaskId");
      const expectedTaskRevision = positiveRevision(request.expectedTaskRevision);
      const runId = identifier(request.runId, "runId");
      if (!Array.isArray(request.artifactIds)
        || request.artifactIds.length < 1
        || request.artifactIds.length > MAX_DELIVERY_ARTIFACTS) {
        throw new DeliveryError(`artifactIds must select 1-${MAX_DELIVERY_ARTIFACTS} artifacts from one run.`);
      }
      const artifactIds = request.artifactIds.map((item) => identifier(item, "artifactId"));
      if (new Set(artifactIds).size !== artifactIds.length) throw new DeliveryError("artifactIds must be unique.");
      const receiptId = request.verificationReceiptId === undefined
        ? null
        : identifier(request.verificationReceiptId, "verificationReceiptId");

      const reason = this.readReason(context);
      if (reason !== null) throw new DeliveryError(`${reason}.`);
      const task = this.readTask(context, true);
      if (task === null) throw new DeliveryError("the current managed task is not reachable and active.");
      if (task.taskId !== expectedTaskId) throw new DeliveryError("expectedTaskId does not match the current task.");
      if (task.taskRevision !== expectedTaskRevision) {
        throw new DeliveryError(`stale expectedTaskRevision ${expectedTaskRevision}; the owner is at ${task.taskRevision}.`);
      }
      const expected = frozenOf(task);
      this.abortCheckpoint(signal, "the call was aborted before candidate resolution.");

      const snapshot = await this.candidates.resolveSnapshot(expected, { runId, artifactIds });
      this.abortCheckpoint(signal, "the call was aborted during candidate resolution.");
      const guardAfterSnapshot = this.finalGuard(context, expected);
      this.abortCheckpoint(signal, "the call was aborted while the candidate snapshot was checked.");
      if (guardAfterSnapshot !== null) throw new DeliveryError(`preview was withheld: ${guardAfterSnapshot}.`);
      if (snapshot.runId !== runId || !sameFrozen(snapshot.task, expected)) {
        throw new DeliveryError("the resolved candidate snapshot does not match this task and run.");
      }
      const currentContract = this.contractLine(context);
      this.abortCheckpoint(signal, "the call was aborted while the host contract was read.");
      const guardAfterContract = this.finalGuard(context, expected);
      this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
      if (guardAfterContract !== null) throw new DeliveryError(`preview was withheld: ${guardAfterContract}.`);
      if (currentContract.status === "busy") {
        throw new DeliveryError("verification is busy; the delivery read was rejected without queueing.", true);
      }
      if (currentContract.status !== "available") {
        throw new DeliveryError("the current host contract is unavailable; the delivery read was rejected.");
      }
      const contract = currentContract.summary;
      let receipt: ReceiptSummary | null = null;
      if (receiptId !== null) {
        receipt = await this.readReceipt(context, receiptId, expected, runId, snapshot, SUMMARY_LIMITS_FULL);
        this.abortCheckpoint(signal, "the call was aborted while the verification receipt was read.");
        const guardAfterReceipt = this.finalGuard(context, expected);
        this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
        if (guardAfterReceipt !== null) throw new DeliveryError(`preview was withheld: ${guardAfterReceipt}.`);
      }
      this.abortCheckpoint(signal, "the call was aborted before delivery allocation.");
      const guardBeforeWrite = this.finalGuard(context, expected);
      this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
      if (guardBeforeWrite !== null) throw new DeliveryError(`preview was withheld: ${guardBeforeWrite}.`);

      const key = deliveryKey({
        task: expected,
        runId,
        artifacts: snapshot.artifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        })),
        contractDigest: contract?.digest ?? null,
        receiptId,
      });
      const existingId = this.byKey.get(key);
      if (existingId !== undefined) {
        const record = this.records.get(existingId);
        if (record === undefined) throw new DeliveryError("The delivery registry is inconsistent.");
        const rechecked = await this.candidates.recheckSnapshot(record.snapshotId, expected);
        this.abortCheckpoint(signal, "the call was aborted while the frozen candidate was rechecked.");
        const guardAfterRecheck = this.finalGuard(context, expected);
        this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
        if (guardAfterRecheck !== null) throw new DeliveryError(`preview was withheld: ${guardAfterRecheck}.`);
        await this.verifyBundle(record);
        this.abortCheckpoint(signal, "the call was aborted while the published files were verified.");
        await this.recheckEvidence(record, context, expected, rechecked, receiptId, signal);
        this.abortCheckpoint(signal, "the call was aborted while the delivery evidence was checked.");
        const activity = this.activityFacts();
        this.abortCheckpoint(signal, "the call was aborted while the activity overlay was read.");
        const result = this.previewResult(record, activity);
        this.abortCheckpoint(signal, "the call was aborted before the idempotent result.");
        const guard = this.finalGuard(context, expected);
        this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
        if (guard !== null) throw new DeliveryError(`preview was withheld: ${guard}.`);
        return { result, task: expected };
      }

      const allocations = this.allocations.get(task.taskId) ?? 0;
      if (allocations >= MAX_DELIVERY_BUNDLES_PER_TASK) {
        throw new DeliveryError(
          `this task has allocated ${allocations} of ${MAX_DELIVERY_BUNDLES_PER_TASK} delivery bundles; failed allocations count.`,
        );
      }
      this.allocations.set(task.taskId, allocations + 1);

      const deliveryId = `delivery-${this.newId()}`;
      if (!IDENTIFIER.test(deliveryId)) throw new DeliveryError("The host-generated delivery id is not a valid identifier.");
      const staging = path.join(this.root.path, `.staging-${deliveryId}`);
      const finalDir = path.join(this.root.path, deliveryId);
      const rootEntry = { path: this.root.path, dev: this.root.dev, ino: this.root.ino };
      let stagingCreated = false;
      let stagingIdentity: DirectoryIdentity | null = null;
      let published: string | null = null;
      let publishedIdentity: DirectoryIdentity | null = null;
      try {
        await directoryChain(this.root, this.root.path);
        await mkdir(staging, { mode: 0o700 });
        stagingCreated = true;
        const stagingInfo = await lstat(staging);
        if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory()) {
          throw new DeliveryError("The delivery staging directory is not a real directory.");
        }
        stagingIdentity = { path: staging, dev: stagingInfo.dev, ino: stagingInfo.ino };
        await directoryChain(this.root, staging, [rootEntry, stagingIdentity]);

        const artifactFiles: Array<{ artifactId: string; relativePath: string; name: string }> = [];
        const fileRecords: BundleFileRecord[] = [];
        for (let index = 0; index < snapshot.artifacts.length; index += 1) {
          const artifact = snapshot.artifacts[index]!;
          const name = `candidate-${String(index + 1).padStart(2, "0")}${extensionFor(artifact.relativePath)}`;
          const written = await writeBundleFile(
            this.root,
            staging,
            name,
            artifact.data,
            MAX_DELIVERY_ARTIFACT_BYTES,
            [rootEntry, stagingIdentity],
          );
          artifactFiles.push({ artifactId: artifact.artifactId, relativePath: artifact.relativePath, name });
          fileRecords.push(written);
        }
        const totalArtifactBytes = fileRecords.reduce((total, file) => total + file.bytes, 0);
        if (totalArtifactBytes > MAX_DELIVERY_ARTIFACT_TOTAL_BYTES) {
          throw new DeliveryError("Selected delivery artifacts exceed their total byte budget.");
        }

        const requirementSources = task.requirementSources.map((source) => ({
          revision: source.revision,
          kind: source.kind,
          messageId: source.messageId,
          sessionId: source.sessionId,
          source: source.source,
          text: source.text,
          observedAt: source.observedAt,
          committedAt: source.committedAt,
          previousRevision: source.previousRevision,
        }));
        const requirementsData = Buffer.from(JSON.stringify({
          version: "g2b2a-requirements-v1",
          task: expected,
          sources: requirementSources,
        }), "utf8");
        if (requirementsData.length > MAX_DELIVERY_REQUIREMENTS_BYTES) {
          throw new DeliveryError("Authoritative requirement sources exceed the delivery byte budget.");
        }
        const requirementsRecord = await writeBundleFile(
          this.root,
          staging,
          DELIVERY_REQUIREMENTS_NAME,
          requirementsData,
          MAX_DELIVERY_REQUIREMENTS_BYTES,
          [rootEntry, stagingIdentity],
        );

        this.abortCheckpoint(signal, "the call was aborted while the delivery bundle was written.");
        const guardDuringWrite = this.finalGuard(context, expected);
        this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
        if (guardDuringWrite !== null) {
          throw new DeliveryError(`preview was withheld: ${guardDuringWrite}.`);
        }
        let contractDuringWrite = await this.contractCheck(context, expected, contract?.digest ?? null, SUMMARY_LIMITS_FULL);
        this.abortCheckpoint(signal, "the call was aborted while the host contract was checked.");
        const guardAfterContractWrite = this.finalGuard(context, expected);
        this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
        if (guardAfterContractWrite !== null) {
          throw new DeliveryError(`preview was withheld: ${guardAfterContractWrite}.`);
        }
        let receiptDuringWrite: ReceiptSummary | null = null;
        if (receiptId !== null) {
          receiptDuringWrite = await this.readReceipt(
            context, receiptId, expected, runId, snapshot, SUMMARY_LIMITS_FULL,
          );
          this.abortCheckpoint(signal, "the call was aborted while the verification receipt was checked.");
          const guardAfterReceiptWrite = this.finalGuard(context, expected);
          this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
          if (guardAfterReceiptWrite !== null) {
            throw new DeliveryError(`preview was withheld: ${guardAfterReceiptWrite}.`);
          }
        }
        // Budget sizing uses a provisional overlay only; the returned response
        // must re-read activity after every await below.
        const preflightActivity = this.activityFacts();
        this.abortCheckpoint(signal, "the call was aborted while the activity overlay was read.");
        const createdAt = this.now();
        const guardBeforePayload = this.finalGuard(context, expected);
        this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
        if (guardBeforePayload !== null) throw new DeliveryError(`preview was withheld: ${guardBeforePayload}.`);

        const buildPayload = (
          includeInline: boolean,
          limits: SummaryTextLimits,
          contractValue: ContractSummary | null,
          receiptValue: ReceiptSummary | null,
        ) => this.buildPreviewPayload({
          deliveryId,
          createdAt,
          bundleDir: finalDir,
          task: expected,
          runId,
          callId: snapshot.callId,
          snapshot,
          artifactFiles,
          fileRecords,
          requirementsRecord,
          requirementsSources: requirementSources.length,
          contract: contractValue,
          receipt: receiptValue,
          includeInline,
          limits,
        });
        const preflight = (
          payload: PreviewPayload,
          digest: string,
        ): boolean => {
          const ref: PreviewRenderRef = {
            bundleDir: finalDir,
            manifest: {
              path: path.join(finalDir, DELIVERY_MANIFEST_NAME),
              bytes: MAX_DELIVERY_MANIFEST_BYTES,
              sha256: `sha256:${"f".repeat(64)}`,
            },
            requirements: {
              path: path.join(finalDir, DELIVERY_REQUIREMENTS_NAME),
              bytes: requirementsRecord.bytes,
              sha256: requirementsRecord.sha256,
            },
            previewDigest: digest,
          };
          return new TextEncoder().encode(this.previewText(ref, payload, preflightActivity, false)).byteLength
            <= MAX_DELIVERY_CONTENT_BYTES - 256;
        };
        const chosenValues: Array<{
          payload: PreviewPayload;
          digest: string;
          contract: ContractSummary | null;
          receipt: ReceiptSummary | null;
          limits: SummaryTextLimits;
        }> = [];
        const tryPayload = (
          includeInline: boolean,
          limits: SummaryTextLimits,
          contractValue: ContractSummary | null,
          receiptValue: ReceiptSummary | null,
        ): boolean => {
          const payload = buildPayload(includeInline, limits, contractValue, receiptValue);
          const digest = sha256(JSON.stringify(payload));
          if (!preflight(payload, digest)) return false;
          chosenValues.push({ payload, digest, contract: contractValue, receipt: receiptValue, limits });
          return true;
        };
        if (!tryPayload(true, SUMMARY_LIMITS_FULL, contractDuringWrite, receiptDuringWrite)
          && !tryPayload(false, SUMMARY_LIMITS_FULL, contractDuringWrite, receiptDuringWrite)) {
          for (const limits of [SUMMARY_LIMITS_COMPACT, SUMMARY_LIMITS_MINIMAL]) {
            contractDuringWrite = await this.contractCheck(context, expected, contract?.digest ?? null, limits);
            this.abortCheckpoint(signal, "the call was aborted while the host contract was re-read.");
            const compactGuard = this.finalGuard(context, expected);
            this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
            if (compactGuard !== null) throw new DeliveryError(`preview was withheld: ${compactGuard}.`);
            if (receiptId !== null) {
              receiptDuringWrite = await this.readReceipt(
                context, receiptId, expected, runId, snapshot, limits,
              );
              this.abortCheckpoint(signal, "the call was aborted while the verification receipt was re-read.");
              const compactReceiptGuard = this.finalGuard(context, expected);
              this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
              if (compactReceiptGuard !== null) throw new DeliveryError(`preview was withheld: ${compactReceiptGuard}.`);
            }
            if (tryPayload(false, limits, contractDuringWrite, receiptDuringWrite)) break;
          }
        }
        const chosenPayload = chosenValues[0];
        if (chosenPayload === undefined) {
          throw new DeliveryError("The required delivery facts exceed the model-visible content budget.");
        }

        const manifestBase = {
          schemaVersion: 1,
          version: DELIVERY_BUNDLE_VERSION,
          deliveryId,
          createdAt,
          task: expected,
          run: { runId, callId: snapshot.callId },
          source: { bytes: snapshot.source.bytes, sha256: snapshot.source.sha256 },
          inputs: snapshot.inputs.map((input) => ({ id: input.id, bytes: input.bytes, sha256: input.sha256 })),
          provenance: { ...snapshot.provenance },
          artifacts: artifactFiles.map((artifact, index) => ({
            artifactId: artifact.artifactId,
            relativePath: artifact.relativePath,
            bytes: fileRecords[index]!.bytes,
            sha256: fileRecords[index]!.sha256,
            file: { name: artifact.name, bytes: fileRecords[index]!.bytes, sha256: fileRecords[index]!.sha256 },
          })),
          requirements: {
            name: DELIVERY_REQUIREMENTS_NAME,
            bytes: requirementsRecord.bytes,
            sha256: requirementsRecord.sha256,
            sources: requirementSources.length,
          },
          contractState: chosenPayload.contract === null ? "none" : "bound",
          contract: chosenPayload.contract,
          receiptState: chosenPayload.receipt === null ? "not_referenced" : "referenced",
          receipt: chosenPayload.receipt,
          previewPayload: chosenPayload.payload,
          previewDigest: chosenPayload.digest,
        };
        const manifestData = Buffer.from(JSON.stringify(manifestBase), "utf8");
        if (manifestData.length > MAX_DELIVERY_MANIFEST_BYTES) {
          throw new DeliveryError("The delivery manifest exceeds its byte budget.");
        }
        const manifestRecord = await writeBundleFile(
          this.root,
          staging,
          DELIVERY_MANIFEST_NAME,
          manifestData,
          MAX_DELIVERY_MANIFEST_BYTES,
          [rootEntry, stagingIdentity],
        );
        this.abortCheckpoint(signal, "the call was aborted before delivery publication.");
        const guardBeforePublish = this.finalGuard(context, expected);
        this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
        if (guardBeforePublish !== null) throw new DeliveryError(`preview was withheld: ${guardBeforePublish}.`);

        await directoryChain(this.root, staging, [rootEntry, stagingIdentity]);
        this.abortCheckpoint(signal, "the call was aborted before staging publication.");
        if (existsSync(finalDir)) throw new DeliveryError("The host-generated delivery directory already exists.");
        await rename(staging, finalDir);
        published = finalDir;
        stagingIdentity = null;
        const bundleInfo = await lstat(finalDir);
        if (bundleInfo.isSymbolicLink() || !bundleInfo.isDirectory()) {
          throw new DeliveryError("The published delivery directory is not a real directory.");
        }
        publishedIdentity = { path: finalDir, dev: bundleInfo.dev, ino: bundleInfo.ino };
        await directoryChain(this.root, finalDir, [rootEntry, publishedIdentity]);
        this.abortCheckpoint(signal, "the call was aborted during delivery publication.");

        const files: DeliveryFileRow[] = artifactFiles.map((artifact, index) => ({
          artifactId: artifact.artifactId,
          relativePath: artifact.relativePath,
          name: artifact.name,
          path: path.join(finalDir, artifact.name),
          bytes: fileRecords[index]!.bytes,
          sha256: fileRecords[index]!.sha256,
        }));
        const record: DeliveryRecord = {
          deliveryId,
          key,
          task: copyTask(expected),
          runId,
          artifactIds: [...artifactIds].sort(),
          snapshotId: snapshot.snapshotId,
          contractDigest: chosenPayload.contract?.digest ?? null,
          receiptId,
          receiptDigest: chosenPayload.receipt === null ? null : receiptDigest(chosenPayload.receipt),
          receiptOutcome: chosenPayload.receipt?.outcome ?? null,
          bundleDir: finalDir,
          bundleIdentity: publishedIdentity,
          files,
          fileIdentities: new Map(fileRecords.map((file) => [file.name, { ...file.identity }])),
          manifest: {
            ...manifestRecord,
            path: path.join(finalDir, DELIVERY_MANIFEST_NAME),
          },
          requirements: {
            ...requirementsRecord,
            path: path.join(finalDir, DELIVERY_REQUIREMENTS_NAME),
          },
          previewPayload: chosenPayload.payload,
          previewDigest: chosenPayload.digest,
          summaryLimits: chosenPayload.limits,
          createdAt: String(createdAt),
        };
        await this.verifyBundle(record);
        this.abortCheckpoint(signal, "the call was aborted while the published files were verified.");
        const guardAfterVerify = this.finalGuard(context, expected);
        this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
        if (guardAfterVerify !== null) throw new DeliveryError(`preview was withheld: ${guardAfterVerify}.`);
        const rechecked = await this.candidates.recheckSnapshot(record.snapshotId, expected);
        this.abortCheckpoint(signal, "the call was aborted while the frozen candidate was rechecked.");
        const guardAfterRecheck = this.finalGuard(context, expected);
        this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
        if (guardAfterRecheck !== null) throw new DeliveryError(`preview was withheld: ${guardAfterRecheck}.`);
        await this.recheckEvidence(record, context, expected, rechecked, receiptId, signal);
        this.abortCheckpoint(signal, "the call was aborted while the delivery evidence was checked.");
        // The live overlay is read only after the final candidate and evidence
        // awaits; the frozen previewPayload/previewDigest never include it.
        const activity = this.activityFacts();
        this.abortCheckpoint(signal, "the call was aborted while the activity overlay was read.");
        const result = this.previewResult(record, activity);
        this.abortCheckpoint(signal, "the call was aborted before delivery registration.");
        const guardFinal = this.finalGuard(context, expected);
        this.abortCheckpoint(signal, "the call was aborted while the host task was checked.");
        if (guardFinal !== null) throw new DeliveryError(`preview was withheld: ${guardFinal}.`);

        this.records.set(deliveryId, record);
        this.byKey.set(key, deliveryId);
        return { result, task: expected };
      } catch (error) {
        if (published === null) {
          if (!stagingCreated) {
            // mkdir failed; a preexisting/colliding path is not ours to remove.
          } else if (stagingIdentity === null) {
            this.diagnostic("staging_cleanup_withheld", {
              reason: "the staging directory identity was not confirmed; it was left in place",
            });
          } else {
            await this.discardOwnedDirectory(stagingIdentity, "staging");
          }
        } else if (!this.records.has(deliveryId)) {
          if (publishedIdentity === null) {
            this.diagnostic("unpublished_cleanup_withheld", {
              reason: "the published directory identity was not confirmed; it was left in place",
            });
          } else {
            await this.discardOwnedDirectory(publishedIdentity, "unpublished");
          }
        }
        throw error;
      }
    } catch (error) {
      this.diagnostic("preview_failed", { error: errorMessage(error).slice(0, 1000) });
      if (isBusyError(error)) {
        return {
          result: rejection(
            "another delivery or verification call owns the live service; the preview was rejected without queueing.",
            { action: "preview", busy: true },
          ),
        };
      }
      const safe = error instanceof DeliveryError || error instanceof CandidateError
        ? error.message
        : "delivery preview was withheld because the host could not prove the inputs, evidence and files are still current.";
      return { result: rejection(safe, { action: "preview" }) };
    } finally {
      this.release();
    }
  }

  async recheck(
    context: OmpToolContext,
    request: DeliveryRecheckRequest,
    signal?: AbortSignal,
  ): Promise<DeliveryRecheckOutcome> {
    if (this.disposed) throw new DeliveryError("the delivery service is disposed.");
    if (signal?.aborted) throw new DeliveryError("the recheck was aborted before admission.");
    if (!this.acquire()) {
      throw new DeliveryError("another delivery call already owns this service; recheck was rejected without queueing.", true);
    }
    try {
      const expectedTaskId = identifier(request.expectedTaskId, "expectedTaskId");
      const expectedTaskRevision = positiveRevision(request.expectedTaskRevision);
      const deliveryId = identifier(request.deliveryId, "deliveryId");
      const reason = this.readReason(context);
      if (reason !== null) throw new DeliveryError(`${reason}.`);
      const task = this.readTask(context, true);
      if (task === null) throw new DeliveryError("the current managed task is not reachable and active.");
      if (task.taskId !== expectedTaskId) throw new DeliveryError("expectedTaskId does not match the current task.");
      if (task.taskRevision !== expectedTaskRevision) {
        throw new DeliveryError(`stale expectedTaskRevision ${expectedTaskRevision}; the owner is at ${task.taskRevision}.`);
      }
      const expected = frozenOf(task);
      this.abortCheckpoint(signal, "the recheck was aborted before candidate verification.");
      const record = this.records.get(deliveryId);
      if (record === undefined) throw new DeliveryError("The delivery id is not registered by this service instance.");
      if (!sameFrozen(record.task, expected)) {
        throw new DeliveryError("The registered delivery belongs to a different task identity.");
      }
      const snapshot = await this.candidates.recheckSnapshot(record.snapshotId, expected);
      this.abortCheckpoint(signal, "the recheck was aborted while the frozen candidate was rechecked.");
      const guardAfterSnapshot = this.finalGuard(context, expected);
      this.abortCheckpoint(signal, "the recheck was aborted while the host task was checked.");
      if (guardAfterSnapshot !== null) throw new DeliveryError(`recheck was withheld: ${guardAfterSnapshot}.`);
      const bundle = await this.verifyBundle(record);
      this.abortCheckpoint(signal, "the recheck was aborted while the published files were verified.");
      const evidence = await this.recheckEvidence(record, context, expected, snapshot, record.receiptId, signal);
      this.abortCheckpoint(signal, "the recheck was aborted while the delivery evidence was checked.");
      const checkedAt = this.now();
      this.abortCheckpoint(signal, "the recheck was aborted before its final live check.");
      const guard = this.finalGuard(context, expected);
      this.abortCheckpoint(signal, "the recheck was aborted while the host task was checked.");
      if (guard !== null) throw new DeliveryError(`recheck was withheld: ${guard}.`);
      return {
        deliveryId,
        task: copyTask(expected),
        runId: record.runId,
        artifactIds: [...record.artifactIds],
        files: this.renderFileRows(record),
        manifest: { path: record.manifest.path, bytes: bundle.manifest.bytes, sha256: bundle.manifest.sha256 },
        requirements: {
          path: record.requirements.path,
          bytes: bundle.requirements.bytes,
          sha256: bundle.requirements.sha256,
        },
        previewDigest: record.previewDigest,
        contractDigest: record.contractDigest,
        receiptId: record.receiptId,
        receiptOutcome: evidence.receipt?.outcome ?? record.receiptOutcome,
        checkedAt,
      };
    } finally {
      this.release();
    }
  }
}

export { errorMessage as deliveryErrorMessage };
