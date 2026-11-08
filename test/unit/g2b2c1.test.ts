import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  REVIEW_DEADLINE_MS,
  REVIEW_MAX_DISPLAY_BYTES,
  REVIEW_MAX_FILES,
  REVIEW_MAX_FILE_BYTES,
  REVIEW_MAX_REQUIREMENT_BYTES,
  REVIEW_MAX_TOTAL_FILE_BYTES,
  HUMAN_REVIEW_DISPLAY_VERSION,
  HUMAN_REVIEW_ESCAPE_VERSION,
  humanReviewDeadlineAt,
  humanReviewDeadlineReached,
  humanReviewSafeText,
} from "../../src/human-review-types.ts";
import {
  evaluateHumanReviewEvidence,
  humanReviewRequirementRevisions,
} from "../../src/human-review-policy.ts";
import {
  createHumanFixture,
  extraVerifier,
  failVerifier,
  hugeVerifier,
  malformedVerifier,
  missingVerifier,
  partialSpec,
  passSpec,
} from "../harness/human-review-fixture.ts";
import { clearPublishedTaskOwner, publishTaskOwner, type OmpToolContext } from "../../src/task-entry-port.ts";
import { TaskOwner } from "../../src/task-owner.ts";

function factsTrue(facts: {
  resultSettled: boolean;
  resultShapeValid: boolean;
  exactConditionSet: boolean;
  postVerifierCandidateRechecked: boolean;
  issuedCurrent: boolean;
} | null): boolean {
  return facts !== null
    && facts.resultSettled
    && facts.resultShapeValid
    && facts.exactConditionSet
    && facts.postVerifierCandidateRechecked
    && facts.issuedCurrent;
}

describe("G2-B2-C1 host human-review evidence", () => {
  test("fixed limits and the unambiguous display transform are stable", () => {
    expect(REVIEW_DEADLINE_MS).toBe(300_000);
    expect(REVIEW_MAX_FILES).toBe(4);
    expect(REVIEW_MAX_FILE_BYTES).toBe(8_192);
    expect(REVIEW_MAX_TOTAL_FILE_BYTES).toBe(24_576);
    expect(REVIEW_MAX_REQUIREMENT_BYTES).toBe(8_192);
    expect(REVIEW_MAX_DISPLAY_BYTES).toBe(65_536);
    expect(HUMAN_REVIEW_DISPLAY_VERSION).toBe("human-review-display-v2");
    expect(HUMAN_REVIEW_ESCAPE_VERSION).toBe("human-review-safe-text-v2");
    expect(humanReviewDeadlineReached(100, 300_099)).toBe(false);
    expect(humanReviewDeadlineReached(100, 300_100)).toBe(true);
    expect(humanReviewDeadlineAt("2026-11-08T00:00:00.000Z")).toBe("2026-11-08T00:05:00.000Z");

    const realBidi = "A\u202eB";
    const literal = "A\\u202eB";
    const safeReal = humanReviewSafeText(realBidi);
    const safeLiteral = humanReviewSafeText(literal);
    expect(safeReal).toBe("A⟦U+202E⟧B");
    expect(safeLiteral).toBe("A\\u202eB");
    expect(safeReal).not.toBe(safeLiteral);
    expect(humanReviewSafeText("x\u001b[31my")).toBe("x⟦U+001B⟧[31my");
    expect(humanReviewSafeText("⟦U+202E⟧")).toBe("⟦U+27E6⟧U+202E⟧");
    expect(humanReviewSafeText("line\nnext\tcol")).toBe("line\nnext⟦U+0009⟧col");
    expect(humanReviewSafeText("tap⟦U+0009⟧marker")).toBe("tap⟦U+27E6⟧U+0009⟧marker");
  });

  test("TAB is escaped in the display model while original bytes and digest are unchanged", async () => {
    const original = Buffer.from("A\tB\nC\n", "utf8");
    const f = await createHumanFixture({
      source: 'from pathlib import Path\nPath("answer.txt").write_bytes(b"A\\tB\\nC\\n")\nprint("tab artifact")\n',
    });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      const read = await f.readReview(preview.deliveryId);
      const file = read.presentation.model.delivery.files[0]!;
      const evidenceFile = read.evidence.files[0]!;
      expect(file.text).toBe("A⟦U+0009⟧B\nC\n");
      expect(file.text).not.toContain("\t");
      expect(file.bytes).toBe(original.length);
      expect(file.sha256).toBe(`sha256:${createHash("sha256").update(original).digest("hex")}`);
      expect(evidenceFile.bytes).toBe(original.length);
      expect(evidenceFile.sha256).toBe(file.sha256);
      expect(read.presentation.requirementRevisions).toEqual([1]);
    } finally {
      await f.cleanup();
    }
  });

  test("no-contract actual delivery is human-eligible and displays full bytes", async () => {
    const f = await createHumanFixture();
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      const read = await f.readReview(preview.deliveryId);
      expect(read.evidence.contract).toBeNull();
      expect(read.evidence.receipt).toBeNull();
      expect(read.evidence.reviewFacts).toBeNull();
      expect(read.presentation.model.delivery.files[0]!.text).toBe("42\n");
      expect(read.presentation.model.requirements.sources[0]!.text).toContain("Produce an accepted answer.");
      const admission = evaluateHumanReviewEvidence({
        evidence: read.evidence,
        requirementRevisions: humanReviewRequirementRevisions(f.owner.snapshot().currentTask!.requirementSources),
      });
      expect(admission.eligible).toBe(true);
      expect(admission.kind).toBe("human");
      expect(admission.assessment!.automaticEvidenceState).toBe("none");
      expect(admission.assessment!.reviewedRequirementRevisions).toEqual([1]);
      expect(admission.assessment!.automaticCheckIds).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("valid partial receipt keeps insufficient/usable:false while facts are all true", async () => {
    const f = await createHumanFixture();
    try {
      f.bind(partialSpec());
      const run = await f.run();
      const receiptId = await f.verify(run.runId, run.artifactIds);
      const preview = await f.preview(run.runId, run.artifactIds, receiptId);
      const lookup = await f.entry.lookup(f.ctx, receiptId);
      expect(lookup!.receipt.outcome).toBe("insufficient");
      expect(lookup!.usable).toBe(false);
      expect(factsTrue(lookup!.reviewFacts)).toBe(true);
      const read = await f.readReview(preview.deliveryId);
      expect(read.evidence.receipt!.outcome).toBe("insufficient");
      expect(read.evidence.receiptUsable).toBe(false);
      expect(read.evidence.reviewFacts).toEqual(lookup!.reviewFacts);
      expect(read.presentation.model.automatic.state).toBe("partial");
      const admission = evaluateHumanReviewEvidence({
        evidence: read.evidence,
        requirementRevisions: humanReviewRequirementRevisions(f.owner.snapshot().currentTask!.requirementSources),
      });
      expect(admission.eligible).toBe(true);
      expect(admission.kind).toBe("hybrid");
      expect(admission.assessment!.automaticCheckIds).toEqual(["answer"]);
    } finally {
      await f.cleanup();
    }
  });

  test("partial plus unknown extra condition cannot become all-valid", async () => {
    const f = await createHumanFixture({ verifier: extraVerifier() });
    try {
      f.bind(partialSpec());
      const run = await f.run();
      const receiptId = await f.verify(run.runId, run.artifactIds);
      const lookup = await f.entry.lookup(f.ctx, receiptId);
      expect(lookup!.receipt.outcome).toBe("insufficient");
      expect(lookup!.reviewFacts).not.toBeNull();
      expect(lookup!.reviewFacts!.resultSettled).toBe(true);
      expect(lookup!.reviewFacts!.resultShapeValid).toBe(true);
      expect(lookup!.reviewFacts!.exactConditionSet).toBe(false);
      expect(factsTrue(lookup!.reviewFacts)).toBe(false);
      const preview = await f.preview(run.runId, run.artifactIds, receiptId);
      const read = await f.readReview(preview.deliveryId);
      const admission = evaluateHumanReviewEvidence({
        evidence: read.evidence,
        requirementRevisions: humanReviewRequirementRevisions(f.owner.snapshot().currentTask!.requirementSources),
      });
      expect(admission.eligible).toBe(false);
      expect(admission.reasons.join(" ")).toContain("exactly cover");
    } finally {
      await f.cleanup();
    }
  });

  test("missing condition, malformed result and over-limit result fail closed", async () => {
    for (const verifier of [missingVerifier(), malformedVerifier(), hugeVerifier()]) {
      const f = await createHumanFixture({ verifier });
      try {
        f.bind(partialSpec());
        const run = await f.run();
        const receiptId = await f.verify(run.runId, run.artifactIds);
        const lookup = await f.entry.lookup(f.ctx, receiptId);
        expect(lookup!.receipt.outcome).toBe("insufficient");
        expect(factsTrue(lookup!.reviewFacts)).toBe(false);
        if (verifier === hugeVerifier()) {
          expect(lookup!.receipt.limits.limitExceeded).toBe(true);
          expect(lookup!.reviewFacts!.resultShapeValid).toBe(false);
        }
        const preview = await f.preview(run.runId, run.artifactIds, receiptId);
        const read = await f.readReview(preview.deliveryId);
        const admission = evaluateHumanReviewEvidence({
          evidence: read.evidence,
          requirementRevisions: humanReviewRequirementRevisions(f.owner.snapshot().currentTask!.requirementSources),
        });
        expect(admission.eligible).toBe(false);
      } finally {
        await f.cleanup();
      }
    }
  });

  test("a bound contract with no actual receipt is not treated as no-contract", async () => {
    const f = await createHumanFixture();
    try {
      f.bind(passSpec());
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      const read = await f.readReview(preview.deliveryId);
      expect(read.evidence.contract).not.toBeNull();
      expect(read.evidence.receipt).toBeNull();
      const admission = evaluateHumanReviewEvidence({
        evidence: read.evidence,
        requirementRevisions: humanReviewRequirementRevisions(f.owner.snapshot().currentTask!.requirementSources),
      });
      expect(admission.eligible).toBe(false);
      expect(admission.reasons.join(" ")).toContain("no actual current verification receipt");
    } finally {
      await f.cleanup();
    }
  });

  test("a failed declared condition cannot be hidden by human review", async () => {
    const f = await createHumanFixture({ verifier: failVerifier() });
    try {
      f.bind(passSpec());
      const run = await f.run();
      const receiptId = await f.verify(run.runId, run.artifactIds);
      const lookup = await f.entry.lookup(f.ctx, receiptId);
      expect(lookup!.receipt.outcome).toBe("fail");
      expect(factsTrue(lookup!.reviewFacts)).toBe(true);
      const preview = await f.preview(run.runId, run.artifactIds, receiptId);
      const read = await f.readReview(preview.deliveryId);
      const admission = evaluateHumanReviewEvidence({
        evidence: read.evidence,
        requirementRevisions: humanReviewRequirementRevisions(f.owner.snapshot().currentTask!.requirementSources),
      });
      expect(admission.eligible).toBe(false);
      expect(admission.reasons.join(" ")).toContain("did not pass");
    } finally {
      await f.cleanup();
    }
  });

  test("production C1 transport is unavailable and installs nothing", async () => {
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      const result = await f.request(preview.deliveryId);
      expect(result.review.state).toBe("unavailable");
      expect(result.operation.outcome).toBe("not_committed");
      expect(result.operation.operationCommitted).toBe(false);
      expect(result.operation.acceptance).toBeNull();
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
      expect(readdirSync(f.acceptanceRoot)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("omitted humanReview remains disabled", async () => {
    const f = await createHumanFixture();
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      const result = await f.request(preview.deliveryId);
      expect(result.review.state).toBe("unavailable");
      expect(result.review.reason).toContain("not enabled");
      expect(readdirSync(f.acceptanceRoot)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("a context getter that publishes a replacement owner and throws withholds disabled-review facts", async () => {
    const f = await createHumanFixture({ humanReview: false });
    const replacement = new TaskOwner({ workspaceRoot: f.workspace, authorizedCapabilities: ["local-script"] });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      const selector = f.selector(preview.deliveryId);
      let getterHits = 0;
      const baseManager = f.ctx.sessionManager!;
      const context: OmpToolContext = {
        ...f.ctx,
        sessionManager: {
          getSessionId: () => {
            getterHits += 1;
            publishTaskOwner(replacement);
            throw new Error("injected context getter failure after publishing a replacement owner");
          },
          getLeafId: () => baseManager.getLeafId(),
          getBranch: () => baseManager.getBranch(),
        },
      };
      const result = await f.entry.acceptance!.requestHumanReview(context, selector);
      expect(getterHits).toBe(1);
      expect(replacement.snapshot().currentTask).toBeNull();
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
      expect(result.review.state).toBe("unavailable");
      expect(result.review.reviewId).toBeNull();
      expect(result.operation.outcome).toBe("not_committed");
      expect(result.operation.operationCommitted).toBe(false);
      expect(result.operation.acceptance).toBeNull();
      expect(result.operation.taskAccepted).toBeNull();
      expect(result.operation.current).toEqual({
        state: "unavailable",
        taskId: null,
        status: null,
        accepted: null,
        reason: expect.any(String),
      });
      expect(readdirSync(f.acceptanceRoot)).toEqual([]);
    } finally {
      clearPublishedTaskOwner(replacement);
      await f.cleanup();
    }
  });

  test("full UTF-8 at the 8192-byte boundary is displayable and control text is unambiguous", async () => {
    const content = "a".repeat(8_192);
    const f = await createHumanFixture({
      source: `from pathlib import Path\nPath("answer.txt").write_text(${JSON.stringify(content)}, encoding="utf-8")\n`,
    });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      const read = await f.readReview(preview.deliveryId);
      expect(read.presentation.model.delivery.files[0]!.text).toBe(content);
      expect(read.presentation.rawContentBytes).toBe(8_192 + Buffer.byteLength("Produce an accepted answer.", "utf8"));
      expect(read.presentation.renderedBytes).toBeLessThanOrEqual(REVIEW_MAX_DISPLAY_BYTES);
    } finally {
      await f.cleanup();
    }

    const mixed = "A\u202eB literal \\u202e C\u001b[31mD\n";
    const g = await createHumanFixture({
      source: `from pathlib import Path\nPath("answer.txt").write_text(${JSON.stringify(mixed)}, encoding="utf-8")\n`,
    });
    try {
      const run = await g.run();
      const preview = await g.preview(run.runId, run.artifactIds);
      const read = await g.readReview(preview.deliveryId);
      const text = read.presentation.model.delivery.files[0]!.text;
      expect(text).toContain("A⟦U+202E⟧B");
      expect(text).toContain("literal \\u202e");
      expect(text).toContain("⟦U+001B⟧[31mD");
    } finally {
      await g.cleanup();
    }
  });

  test("8193-byte, invalid UTF-8, five-file and oversized-requirement reviews fail closed", async () => {
    const tooLarge = await createHumanFixture({
      source: `from pathlib import Path\nPath("answer.txt").write_text(${JSON.stringify("a".repeat(8_193))}, encoding="utf-8")\n`,
    });
    try {
      const run = await tooLarge.run();
      const preview = await tooLarge.preview(run.runId, run.artifactIds);
      await expect(tooLarge.readReview(preview.deliveryId)).rejects.toMatchObject({ name: "HumanReviewError", code: "review_too_large" });
    } finally {
      await tooLarge.cleanup();
    }

    const invalid = await createHumanFixture({
      source: `from pathlib import Path\nPath("answer.txt").write_bytes(bytes([0xff, 0xfe, 0x41]))\n`,
    });
    try {
      const run = await invalid.run();
      const preview = await invalid.preview(run.runId, run.artifactIds);
      await expect(invalid.readReview(preview.deliveryId)).rejects.toMatchObject({ name: "HumanReviewError", code: "review_unsupported" });
    } finally {
      await invalid.cleanup();
    }

    const many = await createHumanFixture({
      source: [
        "from pathlib import Path",
        ...Array.from({ length: 5 }, (_, index) => `Path("f${index}.txt").write_text(${JSON.stringify("x".repeat(1_000))}, encoding="utf-8")`),
        "",
      ].join("\n"),
    });
    try {
      const run = await many.run();
      const preview = await many.preview(run.runId, run.artifactIds);
      await expect(many.readReview(preview.deliveryId)).rejects.toMatchObject({ name: "HumanReviewError", code: "review_too_large" });
    } finally {
      await many.cleanup();
    }

    const longRequirement = await createHumanFixture({ requirementText: "r".repeat(8_193) });
    try {
      const run = await longRequirement.run();
      const preview = await longRequirement.preview(run.runId, run.artifactIds);
      await expect(longRequirement.readReview(preview.deliveryId)).rejects.toMatchObject({ name: "HumanReviewError", code: "review_too_large" });
    } finally {
      await longRequirement.cleanup();
    }
  });

  test("review facts are defensive copies and do not enter receipt JSON or model output", async () => {
    const f = await createHumanFixture();
    try {
      f.bind(partialSpec());
      const run = await f.run();
      const receiptId = await f.verify(run.runId, run.artifactIds);
      const lookup = await f.entry.lookup(f.ctx, receiptId);
      expect(lookup!.reviewFacts).not.toBeNull();
      const mutated = lookup!.reviewFacts!;
      mutated.resultSettled = false;
      mutated.receiptDigest = "not-the-digest";
      const again = await f.entry.lookup(f.ctx, receiptId);
      expect(again!.reviewFacts!.resultSettled).toBe(true);
      expect(again!.reviewFacts!.receiptDigest).not.toBe("not-the-digest");
      expect(JSON.stringify(again!.receipt)).not.toContain("reviewFacts");
      expect(JSON.stringify(again!.receipt)).not.toContain("resultSettled");
      expect(again!.modelView).not.toContain("resultSettled");
      expect(again!.modelView).not.toContain("exactConditionSet");
    } finally {
      await f.cleanup();
    }
  });
});
