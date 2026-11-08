import { createHash } from "node:crypto";
import type { AcceptanceEvidence } from "./delivery-service.ts";
import type { RequirementSource } from "./task-requirements.ts";
import {
  HUMAN_REVIEW_DISPLAY_VERSION,
  HUMAN_REVIEW_ESCAPE_VERSION,
  HUMAN_REVIEW_POLICY_VERSION,
  HUMAN_REVIEW_RECORD_VERSION,
  REVIEW_DEADLINE_MS,
  REVIEW_MAX_DISPLAY_BYTES,
  REVIEW_MAX_FILES,
  REVIEW_MAX_FILE_BYTES,
  REVIEW_MAX_REQUIREMENT_BYTES,
  REVIEW_MAX_TOTAL_FILE_BYTES,
  type AcceptanceRecordV2,
  type HumanReviewAdmission,
  type HumanReviewAssessment,
  type HumanReviewBinding,
  type HumanReviewDisplay,
  type HumanReviewDisplayModel,
  type HumanReviewEvidenceState,
  type HumanReviewPresentation,
  HumanReviewError,
  humanReviewDigest,
  humanReviewSafeText,
  isCanonicalHumanReviewTime,
  isHumanReviewIdentifier,
} from "./human-review-types.ts";

/**
 * Pure human-review admission, display construction and v2 record checks.
 *
 * The automatic verification outcome and `usable` flag are never rewritten:
 * a partial or integrity-only receipt may be supplemented only after every
 * declared condition passed and the private issuance facts are all true.
 */

interface HumanReviewEvaluationInput {
  evidence: AcceptanceEvidence;
  requirementRevisions: readonly number[];
}

export function humanReviewRequirementRevisions(sources: readonly RequirementSource[]): number[] {
  return [...new Set(sources.map((source) => source.revision))].sort((left, right) => left - right);
}

function receiptMetaPresent(evidence: AcceptanceEvidence): boolean {
  return evidence.receipt !== null
    || evidence.receiptDigest !== null
    || evidence.receiptCompatibility !== null
    || evidence.receiptUsable
    || evidence.receiptSnapshotId !== null
    || evidence.reviewFacts !== null;
}

function unique(reasons: readonly string[]): string[] {
  return [...new Set(reasons)];
}

function assessmentFor(
  revisions: readonly number[],
  automaticCheckIds: readonly string[],
  semanticCovered: ReadonlySet<number>,
  automaticEvidenceState: HumanReviewEvidenceState,
): HumanReviewAssessment {
  return {
    reviewedRequirementRevisions: [...revisions],
    automaticCheckIds: [...automaticCheckIds],
    humanSupplementRequiredRevisions: revisions.filter((revision) => !semanticCovered.has(revision)),
    automaticEvidenceState,
  };
}

export function evaluateHumanReviewEvidence(input: HumanReviewEvaluationInput): HumanReviewAdmission {
  const revisions = [...new Set(input.requirementRevisions)].sort((left, right) => left - right);
  const evidence = input.evidence;
  const reasons: string[] = [];
  if (revisions.length === 0) reasons.push("the frozen task has no requirement revisions");

  if (evidence.contract === null) {
    if (receiptMetaPresent(evidence)) {
      reasons.push("no contract is bound, but an automatic receipt/fact set is present; an unbound receipt cannot be adopted as human evidence");
    }
    if (reasons.length > 0) {
      return { eligible: false, kind: null, reasons: unique(reasons), assessment: null };
    }
    return {
      eligible: true,
      kind: "human",
      reasons: [],
      assessment: assessmentFor(revisions, [], new Set(), "none"),
    };
  }

  const contract = evidence.contract;
  if (!sameTask(contract.task, evidence.task)) reasons.push("the contract belongs to a different task identity");
  if (contract.conditions.length === 0) reasons.push("the contract has no declared conditions");
  if (evidence.receipt === null) {
    reasons.push("a current contract is bound but no actual current verification receipt is adopted; execute the configured check and preview again");
    return { eligible: false, kind: null, reasons: unique(reasons), assessment: null };
  }
  const receipt = evidence.receipt;
  if (!sameTask(receipt.task, evidence.task)) reasons.push("the verification receipt belongs to a different task identity");
  if (receipt.contract === null) {
    reasons.push("the verification receipt is not bound to a contract");
  } else if (receipt.contract.contractId !== contract.contractId
    || receipt.contract.digest !== contract.digest
    || receipt.contract.hostConfigId !== contract.hostConfig.id
    || receipt.contract.hostConfigVersion !== contract.hostConfig.version
    || receipt.contract.verifierId !== contract.verifier.id
    || receipt.contract.verifierVersion !== contract.verifier.version
    || receipt.contract.parametersDigest !== contract.verifier.parametersDigest) {
    reasons.push("the verification receipt contract/verifier identity differs from the current contract");
  }
  if (evidence.receiptCompatibility !== "current") {
    reasons.push(`the verification receipt is not current (${evidence.receiptCompatibility ?? "unavailable"})`);
  }
  if (receipt.issuedCurrent !== true) reasons.push("the verification receipt was not issued as a current record");
  if (receipt.limits.timedOut) reasons.push("the trusted verifier timed out");
  if (receipt.limits.limitExceeded) reasons.push("the verifier result or receipt exceeded its limit");
  if (receipt.outcome === "fail") reasons.push("the automatic verification outcome is fail");
  if (receipt.conditions.length !== contract.conditions.length) {
    reasons.push("the receipt condition set does not exactly match the declared contract conditions");
  }
  const passIds: string[] = [];
  let exactConditions = true;
  if (receipt.conditions.length !== contract.conditions.length) exactConditions = false;
  for (const declared of contract.conditions) {
    const found = receipt.conditions.find((condition) => condition.conditionId === declared.conditionId);
    if (found === undefined) {
      exactConditions = false;
      reasons.push(`declared condition ${declared.conditionId} is missing from the receipt`);
      continue;
    }
    if (found.kind !== declared.kind) {
      exactConditions = false;
      reasons.push(`declared condition ${declared.conditionId} changed kind`);
    }
    if (JSON.stringify(found.coveredRevisions) !== JSON.stringify(declared.coveredRevisions)) {
      exactConditions = false;
      reasons.push(`declared condition ${declared.conditionId} changed coverage`);
    }
    if (found.result !== "pass") {
      reasons.push(`declared condition ${declared.conditionId} did not pass (${found.result})`);
    } else {
      passIds.push(declared.conditionId);
    }
  }
  const declaredIds = new Set(contract.conditions.map((condition) => condition.conditionId));
  if (receipt.conditions.some((condition) => !declaredIds.has(condition.conditionId))) {
    exactConditions = false;
    reasons.push("the receipt contains a condition not declared by the contract");
  }

  const facts = evidence.reviewFacts;
  if (facts === null) {
    reasons.push("no private issuance facts exist for this receipt; an older receipt cannot be guessed into a valid result");
  } else {
    if (facts.receiptId !== receipt.receiptId) reasons.push("the issuance facts belong to a different receipt id");
    if (evidence.receiptDigest === null || facts.receiptDigest !== evidence.receiptDigest) {
      reasons.push("the issuance facts are not bound to the final receipt digest");
    }
    if (!facts.resultSettled) reasons.push("the verifier did not settle with a result");
    if (!facts.resultShapeValid) reasons.push("the verifier result shape was not valid");
    if (!facts.exactConditionSet || !exactConditions) {
      reasons.push("the verifier result did not exactly cover the declared condition set");
    }
    if (!facts.postVerifierCandidateRechecked) reasons.push("the candidate/evidence recheck after verification did not succeed");
    if (!facts.issuedCurrent) reasons.push("the receipt was not issued against the current task/evidence");
  }
  const semanticCovered = new Set<number>();
  for (const condition of contract.conditions) {
    if (condition.kind !== "semantic" || !passIds.includes(condition.conditionId)) continue;
    for (const revision of condition.coveredRevisions) semanticCovered.add(revision);
  }
  const state: HumanReviewEvidenceState = contract.coverage.kind === "integrity"
    ? "integrity-only"
    : receipt.outcome === "pass" && contract.coverage.complete === true
      ? "complete"
      : "partial";
  const assessment = assessmentFor(revisions, passIds, contract.coverage.kind === "semantic" ? semanticCovered : new Set(), state);
  if (reasons.length > 0) {
    return { eligible: false, kind: null, reasons: unique(reasons), assessment };
  }
  return { eligible: true, kind: "hybrid", reasons: [], assessment };
}

function sameTask(
  left: { ownerId: string | null; taskId: string; taskRevision: number; requirementsDigest: string | null },
  right: { ownerId: string | null; taskId: string; taskRevision: number; requirementsDigest: string | null },
): boolean {
  return left.ownerId !== null
    && right.ownerId !== null
    && left.ownerId === right.ownerId
    && left.taskId === right.taskId
    && left.taskRevision === right.taskRevision
    && left.requirementsDigest !== null
    && left.requirementsDigest === right.requirementsDigest;
}

export function humanReviewBindingOf(evidence: AcceptanceEvidence): HumanReviewBinding {
  return {
    deliveryId: evidence.deliveryId,
    previewDigest: evidence.previewDigest,
    deliverySnapshotId: evidence.deliverySnapshotId,
    candidateSnapshotId: evidence.candidate.snapshotId,
    runId: evidence.runId,
    callId: evidence.candidate.callId,
    source: { ...evidence.candidate.source },
    inputs: evidence.candidate.inputs.map((input) => ({ id: input.id, bytes: input.bytes, sha256: input.sha256 })),
    artifacts: evidence.candidate.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      relativePath: artifact.relativePath,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
    manifest: { ...evidence.manifest },
    requirements: { ...evidence.requirements },
    contractDigest: evidence.contract?.digest ?? null,
    automaticReceiptId: evidence.receipt?.receiptId ?? null,
    automaticReceiptDigest: evidence.receiptDigest,
  };
}

export function humanReviewDisplayOf(presentation: HumanReviewPresentation): HumanReviewDisplay {
  return {
    version: HUMAN_REVIEW_DISPLAY_VERSION,
    digest: presentation.digest,
    rawContentBytes: presentation.rawContentBytes,
    renderedBytes: presentation.renderedBytes,
    fileCount: presentation.fileCount,
    requirementRevisions: [...presentation.requirementRevisions],
    complete: true,
    contentTruncated: false,
  };
}

interface HumanReviewPresentationInput {
  evidence: AcceptanceEvidence;
  requirementSources: readonly RequirementSource[];
  fileData: ReadonlyMap<string, Buffer>;
  automaticState?: HumanReviewEvidenceState;
}

export function buildHumanReviewPresentation(input: HumanReviewPresentationInput): HumanReviewPresentation {
  const { evidence, requirementSources, fileData } = input;
  if (evidence.files.length > REVIEW_MAX_FILES) {
    throw new HumanReviewError(
      `review_too_large: ${evidence.files.length} selected files exceed the ${REVIEW_MAX_FILES}-file human review budget`,
      "review_too_large",
    );
  }
  let totalFileBytes = 0;
  const files = evidence.files.map((file) => {
    if (file.bytes > REVIEW_MAX_FILE_BYTES) {
      throw new HumanReviewError(
        `review_too_large: ${file.relativePath} is ${file.bytes} bytes; the per-file review limit is ${REVIEW_MAX_FILE_BYTES}`,
        "review_too_large",
      );
    }
    const data = fileData.get(file.name);
    if (data === undefined || data.length !== file.bytes || bytesDigest(data) !== file.sha256) {
      throw new HumanReviewError(
        `review_invalid: actual bytes for ${file.relativePath} do not match the registered delivery identity`,
        "review_invalid",
      );
    }
    totalFileBytes += data.length;
    if (totalFileBytes > REVIEW_MAX_TOTAL_FILE_BYTES) {
      throw new HumanReviewError(
        `review_too_large: selected files exceed the ${REVIEW_MAX_TOTAL_FILE_BYTES}-byte total review budget`,
        "review_too_large",
      );
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      throw new HumanReviewError(
        `review_unsupported: ${file.relativePath} is not valid UTF-8; binary review is unsupported`,
        "review_unsupported",
      );
    }
    return {
      artifactId: file.artifactId,
      relativePath: humanReviewSafeText(file.relativePath),
      name: humanReviewSafeText(file.name),
      path: humanReviewSafeText(file.path),
      bytes: file.bytes,
      sha256: file.sha256,
      text: humanReviewSafeText(decoded),
    };
  });
  let totalRequirementBytes = 0;
  const requirements = requirementSources.map((source) => {
    const rawBytes = Buffer.byteLength(source.text, "utf8");
    totalRequirementBytes += rawBytes;
    if (totalRequirementBytes > REVIEW_MAX_REQUIREMENT_BYTES) {
      throw new HumanReviewError(
        `review_too_large: requirement sources exceed the ${REVIEW_MAX_REQUIREMENT_BYTES}-byte review budget`,
        "review_too_large",
      );
    }
    return {
      revision: source.revision,
      kind: source.kind,
      messageId: source.messageId,
      sessionId: source.sessionId,
      source: source.source,
      observedAt: source.observedAt,
      committedAt: source.committedAt,
      previousRevision: source.previousRevision,
      text: humanReviewSafeText(source.text),
      rawBytes,
    };
  });
  const requirementRevisions = humanReviewRequirementRevisions(requirementSources);
  const receipt = evidence.receipt;
  const automaticState = input.automaticState
    ?? (evidence.contract === null
      ? "none"
      : receipt === null
        ? "none"
        : evidence.contract.coverage.kind === "integrity"
          ? "integrity-only"
          : receipt.outcome === "pass" && evidence.contract.coverage.complete
            ? "complete"
            : "partial");
  const limitations = automaticLimitations(evidence);
  const model: HumanReviewDisplayModel = {
    version: HUMAN_REVIEW_DISPLAY_VERSION,
    transform: HUMAN_REVIEW_ESCAPE_VERSION,
    task: { ...evidence.task },
    delivery: {
      deliveryId: evidence.deliveryId,
      previewDigest: evidence.previewDigest,
      runId: evidence.runId,
      callId: evidence.candidate.callId,
      source: { ...evidence.candidate.source },
      inputs: evidence.candidate.inputs.map((item) => ({ ...item })),
      files,
      manifest: { ...evidence.manifest },
      requirements: { ...evidence.requirements },
    },
    requirements: {
      totalBytes: totalRequirementBytes,
      sources: requirements,
    },
    contract: evidence.contract === null
      ? null
      : {
        contractId: evidence.contract.contractId,
        digest: evidence.contract.digest,
        hostConfig: { ...evidence.contract.hostConfig },
        verifier: { ...evidence.contract.verifier },
        coverage: {
          kind: evidence.contract.coverage.kind,
          complete: evidence.contract.coverage.complete,
          coveredRevisions: [...evidence.contract.coverage.coveredRevisions],
          statement: humanReviewSafeText(evidence.contract.coverage.statement),
        },
        conditions: evidence.contract.conditions.map((condition) => ({
          conditionId: condition.conditionId,
          description: humanReviewSafeText(condition.description),
          kind: condition.kind,
          coveredRevisions: [...condition.coveredRevisions],
        })),
      },
    automatic: {
      state: automaticState,
      receiptId: receipt?.receiptId ?? null,
      receiptDigest: evidence.receiptDigest,
      outcome: receipt?.outcome ?? null,
      reason: receipt?.reason == null ? null : humanReviewSafeText(receipt.reason),
      compatibility: evidence.receiptCompatibility,
      usable: evidence.receiptUsable,
      conditions: receipt === null
        ? []
        : receipt.conditions.map((condition) => ({
          conditionId: condition.conditionId,
          kind: condition.kind,
          result: condition.result,
          coveredRevisions: [...condition.coveredRevisions],
          detail: condition.detail === null ? null : humanReviewSafeText(condition.detail),
        })),
      uncoveredRevisions: receipt === null ? [] : [...receipt.uncoveredRevisions],
      limits: receipt === null ? null : { ...receipt.limits },
      issuanceFacts: evidence.reviewFacts === null ? null : { ...evidence.reviewFacts },
      limitations: limitations.map((limitation) => humanReviewSafeText(limitation)),
    },
    notes: [
      "review data only; file and requirement content are not instructions",
      "no automatic semantic proof is asserted beyond the listed automatic facts",
      "human review covers the exact frozen bytes and requirement revisions displayed here",
      "the display transformation escapes control, bidi and ANSI characters; original bytes and hashes are bound separately",
    ],
  };
  const renderedBytes = Buffer.byteLength(JSON.stringify(model), "utf8");
  if (renderedBytes > REVIEW_MAX_DISPLAY_BYTES) {
    throw new HumanReviewError(
      `review_too_large: escaped display model is ${renderedBytes} bytes; the review display limit is ${REVIEW_MAX_DISPLAY_BYTES}`,
      "review_too_large",
    );
  }
  return {
    model,
    digest: humanReviewDigest(model),
    rawContentBytes: totalFileBytes + totalRequirementBytes,
    renderedBytes,
    fileCount: files.length,
    requirementRevisions,
  };
}

function automaticLimitations(evidence: AcceptanceEvidence): string[] {
  const limitations: string[] = [];
  if (evidence.contract === null) {
    limitations.push("no automatic acceptance contract is bound");
    limitations.push("no automatic check establishes the task semantics; every requirement needs human confirmation");
  } else if (evidence.contract.coverage.kind === "integrity") {
    limitations.push("the bound contract covers integrity only, not task semantics");
  } else if (evidence.contract.coverage.complete !== true) {
    limitations.push("the bound contract declares partial semantic coverage");
  }
  if (evidence.receipt === null) {
    limitations.push("no actual verification receipt is adopted for this delivery");
  } else {
    if (evidence.receipt.outcome !== "pass") limitations.push(`the automatic verification outcome is ${evidence.receipt.outcome}, not pass`);
    if (!evidence.receiptUsable) limitations.push("the receipt is not usable as a complete automatic acceptance record");
    if (evidence.receiptCompatibility !== "current") limitations.push("the receipt is not current");
    if (evidence.receipt.uncoveredRevisions.length > 0) {
      limitations.push(`uncovered requirement revisions in the automatic receipt: ${evidence.receipt.uncoveredRevisions.join(", ")}`);
    }
    const facts = evidence.reviewFacts;
    if (facts === null) {
      limitations.push("private issuance facts are absent; this receipt cannot be used for human/hybrid admission");
    } else if (!facts.resultSettled || !facts.resultShapeValid || !facts.exactConditionSet
      || !facts.postVerifierCandidateRechecked || !facts.issuedCurrent) {
      limitations.push("one or more private issuance facts are false; human approval cannot bypass this");
    }
  }
  return limitations;
}

function bytesDigest(data: Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

const TOP_KEYS = new Set([
  "schemaVersion", "version", "policy", "acceptanceId", "deliveryId", "acceptedAt", "task",
  "requirements", "delivery", "candidate", "contract", "receipt", "evidence", "humanReview",
]);
const HUMAN_KEYS = new Set([
  "schemaVersion", "receiptId", "reviewId", "policyVersion", "decision", "interactionSource",
  "issuedAt", "expiresAt", "decidedAt", "task", "session", "binding", "display", "assessment",
]);
const BINDING_KEYS = new Set([
  "deliveryId", "previewDigest", "deliverySnapshotId", "candidateSnapshotId", "runId", "callId",
  "source", "inputs", "artifacts", "manifest", "requirements", "contractDigest",
  "automaticReceiptId", "automaticReceiptDigest",
]);
const DISPLAY_KEYS = new Set([
  "version", "digest", "rawContentBytes", "renderedBytes", "fileCount",
  "requirementRevisions", "complete", "contentTruncated",
]);
const ASSESSMENT_KEYS = new Set([
  "reviewedRequirementRevisions", "automaticCheckIds", "humanSupplementRequiredRevisions",
  "automaticEvidenceState",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function property(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string, problems: string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) problems.push(`${label} has unsupported fields: ${extra.slice(0, 4).join(", ")}`);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function numberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item > 0);
}

/** Strict pure v2 shape/consistency check before the fixed store prepares it. */
export function validateHumanReviewRecordV2(value: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(value)) return ["the v2 acceptance record is not an object"];
  exactKeys(value, TOP_KEYS, "the v2 acceptance record", problems);
  if (value.schemaVersion !== 2) problems.push("schemaVersion must be 2");
  if (value.version !== HUMAN_REVIEW_RECORD_VERSION) problems.push(`version must be ${HUMAN_REVIEW_RECORD_VERSION}`);
  if (!isHumanReviewIdentifier(value.acceptanceId)) problems.push("acceptanceId is not a bounded identifier");
  if (!isHumanReviewIdentifier(value.deliveryId)) problems.push("deliveryId is not a bounded identifier");
  if (!isCanonicalHumanReviewTime(value.acceptedAt)) problems.push("acceptedAt is not canonical UTC ISO");
  if (!isObject(value.policy)) {
    problems.push("policy is not an object");
  } else {
    exactKeys(value.policy, new Set(["source", "version"]), "policy", problems);
    if (value.policy.source !== "human-review" && value.policy.source !== "hybrid-human-review") {
      problems.push("policy.source is not a human/hybrid source");
    }
    if (value.policy.version !== HUMAN_REVIEW_POLICY_VERSION) problems.push("policy.version is not the fixed human-review policy");
  }
  if (!isObject(value.task)
    || !isHumanReviewIdentifier(value.task.ownerId)
    || !isHumanReviewIdentifier(value.task.taskId)
    || typeof value.task.taskRevision !== "number"
    || !isHumanReviewIdentifier(value.task.requirementsDigest)) {
    problems.push("task is not a bounded frozen task reference");
  }
  if (!isObject(value.requirements)
    || !isHumanReviewIdentifier(value.requirements.digest)
    || !Array.isArray(value.requirements.sources)
    || value.requirements.sources.length === 0) {
    problems.push("requirements sources are missing");
  }
  if (!isObject(value.humanReview)) return [...problems, "humanReview is missing"];
  const human = value.humanReview;
  exactKeys(human, HUMAN_KEYS, "humanReview", problems);
  if (human.schemaVersion !== 1) problems.push("humanReview.schemaVersion must be 1");
  if (!isHumanReviewIdentifier(human.receiptId)) problems.push("humanReview.receiptId is not a bounded identifier");
  if (!isHumanReviewIdentifier(human.reviewId)) problems.push("humanReview.reviewId is not a bounded identifier");
  if (human.policyVersion !== HUMAN_REVIEW_POLICY_VERSION) problems.push("humanReview.policyVersion is not fixed");
  if (human.decision !== "approve") problems.push("humanReview.decision is not approve");
  if (human.interactionSource !== "local-main-tui-component") problems.push("humanReview.interactionSource is not the fixed local source");
  if (!isCanonicalHumanReviewTime(human.issuedAt)
    || !isCanonicalHumanReviewTime(human.expiresAt)
    || !isCanonicalHumanReviewTime(human.decidedAt)) {
    problems.push("humanReview times are not canonical UTC ISO");
  } else {
    if (human.decidedAt < human.issuedAt) problems.push("humanReview.decidedAt precedes issuedAt");
    if (human.decidedAt > human.expiresAt) problems.push("humanReview.decidedAt exceeds the fixed deadline");
    if (human.expiresAt <= human.issuedAt) problems.push("humanReview.expiresAt does not follow issuedAt");
    if (Date.parse(human.expiresAt) - Date.parse(human.issuedAt) !== REVIEW_DEADLINE_MS) {
      problems.push("humanReview deadline is not the fixed 300000 ms");
    }
    if (isCanonicalHumanReviewTime(value.acceptedAt) && value.acceptedAt < human.decidedAt) {
      problems.push("acceptedAt precedes the human decision");
    }
  }
  if (!isObject(human.task) || !isObject(value.task)
    || JSON.stringify(human.task) !== JSON.stringify(value.task)) {
    problems.push("humanReview.task does not match the record task");
  }
  if (!isObject(human.session)
    || !isHumanReviewIdentifier(human.session.sessionId)
    || !isHumanReviewIdentifier(human.session.branchAnchorId)) {
    problems.push("humanReview.session is not a bounded session/anchor reference");
  }
  if (!isObject(human.binding)) {
    problems.push("humanReview.binding is missing");
  } else {
    exactKeys(human.binding, BINDING_KEYS, "humanReview.binding", problems);
    const binding = human.binding;
    if (binding.deliveryId !== value.deliveryId) problems.push("binding.deliveryId does not match the record delivery");
    if (typeof binding.previewDigest !== "string" || !binding.previewDigest.startsWith("sha256:")) problems.push("binding.previewDigest is not a digest");
    if (!isHumanReviewIdentifier(binding.deliverySnapshotId)) problems.push("binding.deliverySnapshotId is not bounded");
    if (!isHumanReviewIdentifier(binding.candidateSnapshotId)) problems.push("binding.candidateSnapshotId is not bounded");
    if (!isHumanReviewIdentifier(binding.runId)) problems.push("binding.runId is not bounded");
    if (!isHumanReviewIdentifier(binding.callId)) problems.push("binding.callId is not bounded");
    if (!isObject(binding.source) || typeof binding.source.bytes !== "number" || typeof binding.source.sha256 !== "string") problems.push("binding.source is malformed");
    if (!Array.isArray(binding.inputs) || !Array.isArray(binding.artifacts)) problems.push("binding inputs/artifacts are malformed");
    if (!isObject(binding.manifest) || !isObject(binding.requirements)) problems.push("binding manifest/requirements are malformed");
    if (binding.contractDigest !== null && typeof binding.contractDigest !== "string") problems.push("binding.contractDigest is malformed");
    if (binding.automaticReceiptId !== null && !isHumanReviewIdentifier(binding.automaticReceiptId)) problems.push("binding.automaticReceiptId is malformed");
    if (binding.automaticReceiptDigest !== null && typeof binding.automaticReceiptDigest !== "string") problems.push("binding.automaticReceiptDigest is malformed");
    if (isObject(value.delivery)) {
      if (binding.deliverySnapshotId !== value.delivery.snapshotId) {
        problems.push("humanReview.binding delivery snapshot differs from the record delivery");
      }
      if (Array.isArray(value.delivery.artifactIds)
        && Array.isArray(binding.artifacts)
        && JSON.stringify([...value.delivery.artifactIds].sort()) !== JSON.stringify(binding.artifacts.map((artifact) => isObject(artifact) ? artifact.artifactId : null).sort())) {
        problems.push("humanReview.binding artifacts do not match the selected delivery ids");
      }
      const deliveryArtifacts = Array.isArray(value.delivery.files)
        ? value.delivery.files.map((file) => isObject(file)
          ? {
            artifactId: file.artifactId,
            relativePath: file.relativePath,
            bytes: file.bytes,
            sha256: file.sha256,
          }
          : file)
        : value.delivery.files;
      if (binding.previewDigest !== value.delivery.previewDigest
        || binding.runId !== value.delivery.runId
        || JSON.stringify(binding.artifacts) !== JSON.stringify(deliveryArtifacts)
        || JSON.stringify(binding.manifest) !== JSON.stringify(value.delivery.manifest)
        || JSON.stringify(binding.requirements) !== JSON.stringify(value.delivery.requirements)) {
        problems.push("humanReview.binding is not the actual delivery/candidate identity");
      }
    }
    if (isObject(value.candidate)) {
      if (binding.candidateSnapshotId !== value.candidate.snapshotId
        || JSON.stringify(binding.source) !== JSON.stringify(value.candidate.source)
        || JSON.stringify(binding.inputs) !== JSON.stringify(value.candidate.inputs)) {
        problems.push("humanReview.binding source/input identity differs from the candidate");
      }
    }
    const policySource = property(value.policy, "source");
    if (value.contract === null) {
      if (binding.contractDigest !== null
        || binding.automaticReceiptId !== null
        || binding.automaticReceiptDigest !== null
        || policySource !== "human-review") {
        problems.push("no-contract human review must not claim contract/receipt evidence");
      }
      if (isObject(human.assessment) && human.assessment.automaticEvidenceState !== "none") {
        problems.push("no-contract human review must report automaticEvidenceState none");
      }
    } else if (!isObject(value.contract)
      || binding.contractDigest !== value.contract.digest
      || policySource !== "hybrid-human-review") {
      problems.push("hybrid human review must bind the actual contract digest");
    } else if (!isObject(value.receipt) || !isObject(value.receipt.receipt)) {
      problems.push("hybrid human review requires the actual automatic receipt object");
    }
    if (isObject(value.receipt)) {
      const receipt = value.receipt.receipt;
      if (receipt === null) {
        if (value.receipt.digest !== null || value.receipt.snapshotId !== null) problems.push("an absent automatic receipt must have null digest/snapshot");
        if (binding.automaticReceiptId !== null || binding.automaticReceiptDigest !== null) problems.push("binding claims a receipt that the record lacks");
      } else if (isObject(receipt)) {
        if (binding.automaticReceiptId !== receipt.receiptId) problems.push("binding receipt id differs from the receipt");
        if (binding.automaticReceiptDigest === null || value.receipt.digest !== binding.automaticReceiptDigest) problems.push("binding receipt digest differs from the record receipt");
        if (humanReviewDigest(receipt) !== value.receipt.digest) problems.push("the automatic receipt digest does not cover its exact JSON content");
        if (value.receipt.snapshotId === null) problems.push("a present automatic receipt must keep its snapshot association");
      } else {
        problems.push("receipt.receipt is malformed");
      }
    }
  }
  if (!isObject(human.display)) {
    problems.push("humanReview.display is missing");
  } else {
    exactKeys(human.display, DISPLAY_KEYS, "humanReview.display", problems);
    if (human.display.version !== HUMAN_REVIEW_DISPLAY_VERSION) problems.push("display version is not fixed");
    if (typeof human.display.digest !== "string" || !human.display.digest.startsWith("sha256:")) problems.push("display digest is malformed");
    if (typeof human.display.rawContentBytes !== "number" || human.display.rawContentBytes < 0) problems.push("display rawContentBytes is malformed");
    if (typeof human.display.renderedBytes !== "number"
      || human.display.renderedBytes < 0
      || human.display.renderedBytes > REVIEW_MAX_DISPLAY_BYTES) {
      problems.push("display renderedBytes exceeds the fixed review display budget");
    }
    if (!Number.isSafeInteger(human.display.fileCount)
      || (human.display.fileCount as number) < 1
      || (human.display.fileCount as number) > REVIEW_MAX_FILES) {
      problems.push("display fileCount is outside the fixed review budget");
    }
    if (!numberArray(human.display.requirementRevisions)) problems.push("display requirementRevisions is malformed");
    if (human.display.complete !== true || human.display.contentTruncated !== false) {
      problems.push("human review display must be complete and untruncated");
    }
    if (isObject(value.delivery) && Array.isArray(value.delivery.files)
      && value.delivery.files.length !== human.display.fileCount) {
      problems.push("display fileCount does not match the selected delivery files");
    }
  }
  if (!isObject(human.assessment)) {
    problems.push("humanReview.assessment is missing");
  } else {
    exactKeys(human.assessment, ASSESSMENT_KEYS, "humanReview.assessment", problems);
    const assessment = human.assessment;
    const automaticCheckIds = stringArray(assessment.automaticCheckIds) ? assessment.automaticCheckIds : [];
    if (!numberArray(assessment.reviewedRequirementRevisions)) problems.push("assessment reviewed revisions are malformed");
    if (!stringArray(assessment.automaticCheckIds)) problems.push("assessment automatic check ids are malformed");
    if (!numberArray(assessment.humanSupplementRequiredRevisions)) problems.push("assessment supplement revisions are malformed");
    if (assessment.automaticEvidenceState !== "none"
      && assessment.automaticEvidenceState !== "partial"
      && assessment.automaticEvidenceState !== "integrity-only"
      && assessment.automaticEvidenceState !== "complete") {
      problems.push("assessment automaticEvidenceState is not a fixed value");
    }
    if (isObject(value.requirements) && Array.isArray(value.requirements.sources)) {
      const actual = [...new Set(value.requirements.sources.map((source) => isObject(source) ? source.revision : null))].sort((left, right) => (left as number) - (right as number));
      if (JSON.stringify(assessment.reviewedRequirementRevisions) !== JSON.stringify(actual)) {
        problems.push("assessment reviewed revisions do not exactly cover the current requirements");
      }
    }
    if (isObject(value.contract) && Array.isArray(value.contract.conditions)) {
      const declared = value.contract.conditions.map((condition) => isObject(condition) ? condition.conditionId : null);
      const declaredSet = new Set(declared);
      if (automaticCheckIds.some((id) => !declaredSet.has(id))) problems.push("assessment claims an automatic check not declared by the contract");
      if (property(value.policy, "source") === "hybrid-human-review"
        && JSON.stringify(automaticCheckIds) !== JSON.stringify(declared)) {
        problems.push("hybrid assessment automatic checks must be every declared condition");
      }
    }
  }
  if (isObject(value.requirements) && isObject(value.task)
    && value.requirements.digest !== value.task.requirementsDigest) {
    problems.push("requirements digest does not match the frozen task");
  }
  if (isObject(value.evidence)) {
    if (typeof value.evidence.humanReviewReceiptDigest !== "string") {
      problems.push("evidence.humanReviewReceiptDigest is missing");
    } else if (value.evidence.humanReviewReceiptDigest !== humanReviewDigest(human)) {
      problems.push("evidence.humanReviewReceiptDigest does not cover the exact humanReview object");
    }
    if (isObject(value.delivery) && value.evidence.deliverySnapshotId !== value.delivery.snapshotId) {
      problems.push("evidence delivery snapshot differs from the record delivery");
    }
    if (isObject(value.receipt) && value.evidence.receiptSnapshotId !== value.receipt.snapshotId) {
      problems.push("evidence receipt snapshot differs from the record receipt");
    }
  } else {
    problems.push("record evidence is missing");
  }
  if (isObject(value.delivery) && typeof value.delivery.deliveryId === "string") {
    if (value.delivery.deliveryId !== value.deliveryId) problems.push("record delivery id does not match delivery.deliveryId");
  }
  const deliveryRunId = property(value.delivery, "runId");
  if (isObject(value.candidate) && isObject(value.task)
    && value.candidate.runId !== deliveryRunId) {
    problems.push("candidate/delivery run identities differ");
  }
  return [...new Set(problems)];
}

export { HUMAN_REVIEW_POLICY_VERSION, HUMAN_REVIEW_RECORD_VERSION };
