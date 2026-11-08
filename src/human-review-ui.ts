import type {
  HumanReviewTransportInput,
  HumanReviewTransportResult,
} from "./human-review-types.ts";

/**
 * Fixed local main-TUI transport seam.
 *
 * C1 ships no actual UI. Production must always return `unavailable` and has
 * no approval placeholder. C2 may implement this exact function against
 * `ctx.ui.custom`; tests may replace this module only in an isolated process
 * before product imports, and must label the result as simulated transport.
 */
export async function presentLocalHumanReview(
  _input: HumanReviewTransportInput,
): Promise<HumanReviewTransportResult> {
  return {
    kind: "unavailable",
    reason: "the local main-TUI human-review adapter is not available in this build",
  };
}
