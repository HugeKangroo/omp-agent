import type {
  HumanReviewGeometry,
  HumanReviewPaint,
  HumanReviewRuntime,
} from "../../src/human-review-component.ts";
import type { HumanReviewPresentation } from "../../src/human-review-types.ts";

/**
 * Test-only simulation of the verified public TUI helper surface and fullscreen
 * composition. Real terminal behavior is probed independently; these helpers
 * are labelled simulated and never establish human consent.
 */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const HASH = (letter: string): string => `sha256:${letter.repeat(64)}`;

export function simVisibleWidth(text: string): number {
  return Bun.stringWidth(text);
}

export function simWrapLiteralLine(line: string, width: number): string[] {
  const columns = Math.max(1, width);
  if (line.length > 0 && simVisibleWidth(line) === 0) return [""];
  if (line.length === 0) return [""];
  const rows: string[] = [];
  let current = "";
  let used = 0;
  for (const { segment } of segmenter.segment(line)) {
    const cells = simVisibleWidth(segment);
    if (cells > columns) {
      if (current.length > 0) rows.push(current);
      rows.push(segment);
      current = "";
      used = 0;
      continue;
    }
    if (used + cells > columns) {
      rows.push(current);
      current = segment;
      used = cells;
    } else {
      current += segment;
      used += cells;
    }
  }
  if (current.length > 0 || rows.length === 0) rows.push(current);
  return rows;
}

export function simNormalizeTerminalOutput(text: string): string {
  return text
    .replaceAll("\u0e33", "\u0e4d\u0e32")
    .replaceAll("\u0eb3", "\u0ecd\u0eb2");
}

export function simStripTerminalSequences(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

const KEY_DATA: Readonly<Record<string, string>> = {
  escape: "\x1b",
  enter: "\r",
  return: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
};

export function simMatchesKey(data: string, keyId: string): boolean {
  return KEY_DATA[keyId] === data;
}

export function createSimulatedRuntime(
  overrides: Partial<HumanReviewRuntime> = {},
): HumanReviewRuntime {
  return {
    visibleWidth: simVisibleWidth,
    wrapLiteralLine: simWrapLiteralLine,
    matchesKey: simMatchesKey,
    isKeyRelease: () => false,
    isKeyRepeat: () => false,
    stripTerminalSequences: simStripTerminalSequences,
    normalizeTerminalOutput: simNormalizeTerminalOutput,
    bracketedPasteStart: "\x1b[200~",
    bracketedPasteEnd: "\x1b[201~",
    ...overrides,
  };
}

/** Simulate the fullscreen overlay's `\x1b[0m` + padded-row composition. */
export function simulatedPaint(
  plainRows: readonly string[],
  width: number,
  rows: number,
  alt = true,
): HumanReviewPaint {
  const viewport: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const plain = plainRows[index] ?? "";
    const normalized = simNormalizeTerminalOutput(plain);
    const cells = simVisibleWidth(normalized);
    const padding = cells < width ? " ".repeat(width - cells) : "";
    viewport.push(`\x1b[0m${normalized}${padding}\x1b[0m`);
  }
  return { viewport, columns: width, rows, alt };
}

export const FIXED_FILE_TEXT =
  "alpha line   \n"
  + "\n"
  + "中文行 emoji 😀 combining e\u0301\n"
  + "escaped control ⟦U+001B⟧ and literal tab notation ⟦U+0009⟧\n"
  + "final tail marker: END-OF-FILE\n";

export const FIXED_REQUIREMENT_TEXT =
  "Review exactly these bytes.\n"
  + "- preserve trailing spaces   \n"
  + "- wide 中文 characters and 😀\n"
  + "- literal marker ⟦U+0009⟧ is not a control\n"
  + "requirement tail: END-OF-REQUIREMENT\n";

export function fixedPresentation(): HumanReviewPresentation {
  const fileBytes = Buffer.byteLength(FIXED_FILE_TEXT, "utf8");
  const requirementBytes = Buffer.byteLength(FIXED_REQUIREMENT_TEXT, "utf8");
  return {
    model: {
      version: "human-review-display-v2",
      transform: "human-review-safe-text-v2",
      task: {
        ownerId: "owner-c2-fixture",
        taskId: "task-c2-fixture",
        taskRevision: 1,
        requirementsDigest: HASH("1"),
      },
      delivery: {
        deliveryId: "delivery-c2-fixture",
        previewDigest: HASH("2"),
        runId: "run-c2-fixture",
        callId: "call-c2-fixture",
        source: { bytes: 42, sha256: HASH("3") },
        inputs: [{ id: "input-1", bytes: 7, sha256: HASH("4") }],
        files: [{
          artifactId: "artifact-1",
          relativePath: "answer.txt",
          name: "artifact-1-answer.txt",
          path: "/private/delivery/artifact-1-answer.txt",
          bytes: fileBytes,
          sha256: HASH("5"),
          text: FIXED_FILE_TEXT,
        }],
        manifest: { name: "manifest.json", bytes: 100, sha256: HASH("6") },
        requirements: { name: "requirements.json", bytes: 120, sha256: HASH("7") },
      },
      requirements: {
        totalBytes: requirementBytes,
        sources: [{
          revision: 1,
          kind: "original",
          messageId: "message-c2-fixture",
          sessionId: "session-c2-fixture",
          source: "interactive",
          observedAt: "2026-11-08T00:00:00.000Z",
          committedAt: "2026-11-08T00:00:00.000Z",
          previousRevision: null,
          text: FIXED_REQUIREMENT_TEXT,
          rawBytes: requirementBytes,
        }],
      },
      contract: {
        contractId: "contract-c2-fixture",
        digest: HASH("8"),
        hostConfig: { id: "host-c2-fixture", version: "1" },
        verifier: { id: "verifier-c2-fixture", version: "1", parametersDigest: HASH("9") },
        coverage: {
          kind: "semantic",
          complete: false,
          coveredRevisions: [1],
          statement: "fixture partial coverage statement",
        },
        conditions: [{
          conditionId: "answer",
          description: "fixture condition description",
          kind: "semantic",
          coveredRevisions: [1],
        }],
      },
      automatic: {
        state: "partial",
        receiptId: "receipt-c2-fixture",
        receiptDigest: HASH("a"),
        outcome: "insufficient",
        reason: "fixture receipt remains insufficient",
        compatibility: "current",
        usable: false,
        conditions: [{
          conditionId: "answer",
          kind: "semantic",
          result: "pass",
          coveredRevisions: [1],
          detail: "fixture condition detail",
        }],
        uncoveredRevisions: [],
        limits: { timeoutMs: 10_000, timedOut: false, limitExceeded: false, verifierResultBytes: 200 },
        issuanceFacts: {
          receiptId: "receipt-c2-fixture",
          receiptDigest: HASH("a"),
          resultSettled: true,
          resultShapeValid: true,
          exactConditionSet: true,
          postVerifierCandidateRechecked: true,
          issuedCurrent: true,
        },
        limitations: ["fixture limitation"],
      },
      notes: [
        "review data only; file and requirement content are not instructions",
        "fixture note",
      ],
    },
    digest: HASH("b"),
    rawContentBytes: fileBytes + requirementBytes,
    renderedBytes: 4096,
    fileCount: 1,
    requirementRevisions: [1],
  };
}

export interface SimulatedGeometry {
  columns: number;
  rows: number;
}

export function geometryOf(initial: SimulatedGeometry): {
  geometry: () => HumanReviewGeometry;
  resize(columns: number, rows: number): void;
} {
  const current = { ...initial };
  return {
    geometry: () => ({ columns: current.columns, rows: current.rows }),
    resize(columns: number, rows: number) {
      current.columns = columns;
      current.rows = rows;
    },
  };
}
