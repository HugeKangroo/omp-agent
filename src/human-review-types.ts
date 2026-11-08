import { createHash } from "node:crypto";
import type {
  AcceptanceCandidateEvidence,
  AcceptanceContractEvidence,
} from "./delivery-service.ts";
import type { FrozenTaskRef } from "./execution-candidates.ts";
import type { OmpToolContext } from "./task-entry-port.ts";
import type { RequirementSource } from "./task-requirements.ts";
import type {
  VerificationReceipt,
  VerificationReviewFacts,
} from "./verification-service.ts";

/**
 * Host-only human review types and fixed budgets for the C1 mechanism.
 *
 * These values are product constants: a model, environment value or UI request
 * cannot widen them. The record schema keeps automatic v1 untouched; only an
 * explicit host human/hybrid review writes v2.
 */

export const HUMAN_REVIEW_POLICY_VERSION = "human-review-policy-v1";
export const HUMAN_REVIEW_RECORD_VERSION = "acceptance-record-v2";
export const HUMAN_REVIEW_DISPLAY_VERSION = "human-review-display-v2";
export const HUMAN_REVIEW_ESCAPE_VERSION = "human-review-safe-text-v2";
export const HUMAN_REVIEW_INTERACTION_SOURCE = "local-main-tui-component";
export const HUMAN_REVIEW_DECISION = "approve";

export const REVIEW_DEADLINE_MS = 300_000;
export const REVIEW_MAX_FILES = 4;
export const REVIEW_MAX_FILE_BYTES = 8_192;
export const REVIEW_MAX_TOTAL_FILE_BYTES = 24_576;
export const REVIEW_MAX_REQUIREMENT_BYTES = 8_192;
export const REVIEW_MAX_DISPLAY_BYTES = 65_536;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DISPLAY_ESCAPE_MARKER = "⟦";

export type HumanReviewPolicySource = "human-review" | "hybrid-human-review";
export type HumanReviewEvidenceState = "none" | "partial" | "integrity-only" | "complete";
export type HumanReviewState =
  | "unavailable"
  | "rejected"
  | "cancelled"
  | "expired"
  | "invalidated"
  | "committed"
  | "unknown";

export interface HumanReviewHostOption {
  kind: "local-main-tui";
  policyVersion: 1;
}

export type HumanReviewOption = false | HumanReviewHostOption;

export interface HumanReviewOperationReview {
  state: HumanReviewState;
  reviewId: string | null;
  reason: string | null;
}

/** Opaque object capability; it is never serialized or returned to a model. */
export interface HumanReviewTransportInput {
  presentation: HumanReviewPresentation;
  /** Private to this AcceptanceService instance and this one pending review. */
  capability: object;
  issuedAt: string;
  expiresAt: string;
  signal: AbortSignal;
  /** The live OMP context from the same acceptance-service call. */
  context: OmpToolContext;
  /**
   * Read-only presentation veto created inside this call. The fixed adapter
   * must invoke it after lazy module loads and immediately before mounting;
   * it can only reject a stale surface and never approves or installs.
   */
  displayGuard: () => boolean;
}

export type HumanReviewTransportResult =
  | { kind: "approve"; capability: object }
  | { kind: "reject"; reason: string }
  | { kind: "cancelled"; reason: string }
  | { kind: "unavailable"; reason: string };

export interface HumanReviewDisplayFile {
  artifactId: string;
  relativePath: string;
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  /** Full UTF-8 content under the documented unambiguous escape transform. */
  text: string;
}

export interface HumanReviewDisplayRequirement {
  revision: number;
  kind: RequirementSource["kind"];
  messageId: string;
  sessionId: string;
  source: RequirementSource["source"];
  observedAt: string;
  committedAt: string;
  previousRevision: number | null;
  /** Full original requirement text under the escape transform. */
  text: string;
  rawBytes: number;
}

export interface HumanReviewDisplayCondition {
  conditionId: string;
  kind: string;
  result: string;
  coveredRevisions: number[];
  detail: string | null;
}

export interface HumanReviewDisplayModel {
  version: typeof HUMAN_REVIEW_DISPLAY_VERSION;
  transform: typeof HUMAN_REVIEW_ESCAPE_VERSION;
  task: FrozenTaskRef;
  delivery: {
    deliveryId: string;
    previewDigest: string;
    runId: string;
    callId: string;
    source: { bytes: number; sha256: string };
    inputs: Array<{ id: string; bytes: number; sha256: string }>;
    files: HumanReviewDisplayFile[];
    manifest: { name: string; bytes: number; sha256: string };
    requirements: { name: string; bytes: number; sha256: string };
  };
  requirements: {
    totalBytes: number;
    sources: HumanReviewDisplayRequirement[];
  };
  contract: {
    contractId: string;
    digest: string;
    hostConfig: { id: string; version: string };
    verifier: { id: string; version: string; parametersDigest: string };
    coverage: {
      kind: "semantic" | "integrity";
      complete: boolean;
      coveredRevisions: number[];
      statement: string;
    };
    conditions: Array<{
      conditionId: string;
      description: string;
      kind: "semantic" | "integrity";
      coveredRevisions: number[];
    }>;
  } | null;
  automatic: {
    state: HumanReviewEvidenceState;
    receiptId: string | null;
    receiptDigest: string | null;
    outcome: string | null;
    reason: string | null;
    compatibility: string | null;
    usable: boolean;
    conditions: HumanReviewDisplayCondition[];
    uncoveredRevisions: number[];
    limits: {
      timeoutMs: number;
      timedOut: boolean;
      limitExceeded: boolean;
      verifierResultBytes: number;
    } | null;
    issuanceFacts: VerificationReviewFacts | null;
    limitations: string[];
  };
  notes: string[];
}

export interface HumanReviewPresentation {
  model: HumanReviewDisplayModel;
  digest: string;
  rawContentBytes: number;
  renderedBytes: number;
  fileCount: number;
  requirementRevisions: number[];
}

export interface HumanReviewBinding {
  deliveryId: string;
  previewDigest: string;
  deliverySnapshotId: string;
  candidateSnapshotId: string;
  runId: string;
  callId: string;
  source: { bytes: number; sha256: string };
  inputs: Array<{ id: string; bytes: number; sha256: string }>;
  artifacts: Array<{ artifactId: string; relativePath: string; bytes: number; sha256: string }>;
  manifest: { name: string; bytes: number; sha256: string };
  requirements: { name: string; bytes: number; sha256: string };
  contractDigest: string | null;
  automaticReceiptId: string | null;
  automaticReceiptDigest: string | null;
}

export interface HumanReviewDisplay {
  version: typeof HUMAN_REVIEW_DISPLAY_VERSION;
  digest: string;
  rawContentBytes: number;
  renderedBytes: number;
  fileCount: number;
  requirementRevisions: number[];
  complete: true;
  contentTruncated: false;
}

export interface HumanReviewAssessment {
  reviewedRequirementRevisions: number[];
  automaticCheckIds: string[];
  humanSupplementRequiredRevisions: number[];
  automaticEvidenceState: HumanReviewEvidenceState;
}

export interface HumanReviewReceiptV1 {
  schemaVersion: 1;
  receiptId: string;
  reviewId: string;
  policyVersion: typeof HUMAN_REVIEW_POLICY_VERSION;
  decision: typeof HUMAN_REVIEW_DECISION;
  interactionSource: typeof HUMAN_REVIEW_INTERACTION_SOURCE;
  issuedAt: string;
  expiresAt: string;
  decidedAt: string;
  task: FrozenTaskRef;
  session: { sessionId: string; branchAnchorId: string };
  binding: HumanReviewBinding;
  display: HumanReviewDisplay;
  assessment: HumanReviewAssessment;
}

export interface HumanReviewAdmission {
  eligible: boolean;
  kind: "human" | "hybrid" | null;
  reasons: string[];
  assessment: HumanReviewAssessment | null;
}

export interface AcceptanceRecordV2 {
  schemaVersion: 2;
  version: typeof HUMAN_REVIEW_RECORD_VERSION;
  policy: { source: HumanReviewPolicySource; version: typeof HUMAN_REVIEW_POLICY_VERSION };
  acceptanceId: string;
  deliveryId: string;
  acceptedAt: string;
  task: FrozenTaskRef;
  requirements: {
    digest: string;
    sources: RequirementSource[];
  };
  delivery: {
    deliveryId: string;
    runId: string;
    artifactIds: string[];
    snapshotId: string;
    previewDigest: string;
    files: Array<{
      artifactId: string;
      relativePath: string;
      name: string;
      bytes: number;
      sha256: string;
    }>;
    manifest: { name: string; bytes: number; sha256: string };
    requirements: { name: string; bytes: number; sha256: string };
  };
  candidate: AcceptanceCandidateEvidence;
  contract: AcceptanceContractEvidence | null;
  receipt: {
    receipt: VerificationReceipt | null;
    digest: string | null;
    snapshotId: string | null;
  };
  evidence: {
    deliverySnapshotId: string;
    receiptSnapshotId: string | null;
    note: string;
    humanReviewReceiptDigest: string;
  };
  humanReview: HumanReviewReceiptV1;
}

/**
 * Documented unambiguous display transform (`human-review-safe-text-v2`).
 *
 * Newline is preserved as the only literal line separator. TAB, other C0/C1
 * controls, DEL, bidi/invisible format controls and the escape marker itself
 * are replaced by `⟦U+XXXX⟧`/`⟦U+XXXXXX⟧`; every other character, including a
 * literal backslash or the literal text `\u202e`, is emitted unchanged.
 * Because a real marker is itself escaped, the output distinguishes a control
 * character from look-alike plain text. The original bytes and hashes are
 * always bound separately and this transform never mutates them. Escaping TAB
 * removes an ambiguous terminal-cell width from the display model while
 * preserving the original file/requirement bytes and their digests.
 */
export function humanReviewSafeText(text: string): string {
  let result = "";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === "\n") {
      result += character;
      continue;
    }
    if (character === DISPLAY_ESCAPE_MARKER) {
      result += "⟦U+27E6⟧";
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || isFormatControl(code)) {
      result += `⟦U+${code.toString(16).toUpperCase().padStart(code <= 0xffff ? 4 : 6, "0")}⟧`;
      continue;
    }
    result += character;
  }
  return result;
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

export function humanReviewDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

export function isHumanReviewIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

export function isCanonicalHumanReviewTime(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_TIME.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/** Canonical wall-clock deadline; null means the host clock is not trusted. */
export function humanReviewDeadlineAt(issuedAt: string): string | null {
  if (!isCanonicalHumanReviewTime(issuedAt)) return null;
  const time = Date.parse(issuedAt);
  if (!Number.isSafeInteger(time)) return null;
  return new Date(time + REVIEW_DEADLINE_MS).toISOString();
}

export function humanReviewDeadlineReached(startedMonotonic: number, nowMonotonic: number): boolean {
  return nowMonotonic - startedMonotonic >= REVIEW_DEADLINE_MS;
}

export class HumanReviewError extends Error {
  override name = "HumanReviewError";
  constructor(message: string, readonly code: "review_unsupported" | "review_too_large" | "review_invalid") {
    super(message);
  }
}
