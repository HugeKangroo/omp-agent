import type {
  HumanReviewDisplayModel,
  HumanReviewPresentation,
} from "./human-review-types.ts";

/**
 * Pure local-main-TUI review component.
 *
 * This module owns only frozen-display pagination, narrow key handling and a
 * completed-paint coverage gate. It never receives the private acceptance
 * capability, an approval function, a store, or a writer. The fixed adapter in
 * `human-review-ui.ts` is the only caller that can turn its explicit
 * `approve` callback into the original capability returned to the acceptance
 * service.
 */

export const HUMAN_REVIEW_MIN_COLUMNS = 48;
export const HUMAN_REVIEW_MIN_ROWS = 10;
const HEADER_ROWS = 2;
const FOOTER_ROWS = 4;
const BODY_MIN_ROWS = 1;

export interface HumanReviewRuntime {
  visibleWidth(text: string): number;
  wrapLiteralLine(line: string, width: number): string[];
  matchesKey(data: string, keyId: string): boolean;
  isKeyRelease(data: string): boolean;
  isKeyRepeat(data: string): boolean;
  stripTerminalSequences(text: string): string;
  normalizeTerminalOutput(text: string): string;
  bracketedPasteStart: string;
  bracketedPasteEnd: string;
}

export interface HumanReviewGeometry {
  columns: number;
  rows: number;
}

export interface HumanReviewPaint {
  viewport: readonly string[];
  columns: number;
  rows: number;
  alt: boolean;
}

export interface HumanReviewPaintSource {
  addPaintListener(listener: (paint: HumanReviewPaint) => void): () => void;
}

export type HumanReviewDecision = "approve" | "reject";

export interface HumanReviewComponentOptions {
  presentation: HumanReviewPresentation;
  runtime: HumanReviewRuntime;
  geometry: () => HumanReviewGeometry;
  paintSource?: HumanReviewPaintSource;
  requestRender?: () => void;
  signal?: AbortSignal;
  expiresAt: string;
  now?: () => number;
  onDecision: (decision: HumanReviewDecision) => void;
}

export interface HumanReviewComponent {
  render(width: number): readonly string[];
  handleInput(data: string): void;
  capturesInput(data: string): boolean;
  dispose(): void;
}

interface Layout {
  signature: string;
  width: number;
  rows: number;
  bodyHeight: number;
  pages: string[][];
  pageCount: number;
  supported: boolean;
  problem: string | null;
}

interface RenderedFrame {
  signature: string;
  width: number;
  rows: number;
  pageIndex: number;
  pageCount: number;
  supported: boolean;
  plain: string[];
  padded: string[];
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function nullable(value: unknown): string {
  return value === null || value === undefined ? "none" : String(value);
}

function requirementRevisions(model: HumanReviewDisplayModel): number[] {
  return model.requirements.sources.map((source) => source.revision);
}

/**
 * Build the complete readable pager from the immutable frozen model. File and
 * requirement text is already under the C1 safe display transform; this
 * function never re-escapes or rewrites it. Metadata is emitted as plain
 * strings so the component can reject any residual raw control code instead
 * of interpreting it.
 */
function contentLines(presentation: HumanReviewPresentation): string[] {
  const { model } = presentation;
  const lines: string[] = [
    "HUMAN REVIEW — exact frozen evidence",
    `REQUIREMENTS (${model.requirements.sources.length} complete source(s), ${model.requirements.totalBytes} total bytes)`,
  ];
  for (let index = 0; index < model.requirements.sources.length; index += 1) {
    const source = model.requirements.sources[index]!;
    lines.push(
      `--- REQUIREMENT ${index + 1}/${model.requirements.sources.length} ---`,
      `revision: ${source.revision}`,
      `kind: ${source.kind}`,
      `messageId: ${source.messageId}`,
      `sessionId: ${source.sessionId}`,
      `source: ${source.source}`,
      `observedAt: ${source.observedAt}`,
      `committedAt: ${source.committedAt}`,
      `previousRevision: ${nullable(source.previousRevision)}`,
      `rawBytes: ${source.rawBytes}`,
      "requirement text follows:",
      source.text,
      `--- END REQUIREMENT ${index + 1}/${model.requirements.sources.length} ---`,
    );
  }
  lines.push("", `SELECTED FILES (${model.delivery.files.length} complete file(s))`);
  for (let index = 0; index < model.delivery.files.length; index += 1) {
    const file = model.delivery.files[index]!;
    lines.push(
      `--- FILE ${index + 1}/${model.delivery.files.length} ---`,
      `artifactId: ${file.artifactId}`,
      `relativePath: ${file.relativePath}`,
      `name: ${file.name}`,
      `path: ${file.path}`,
      `bytes: ${file.bytes}`,
      `sha256: ${file.sha256}`,
      "file text follows:",
      file.text,
      `--- END FILE ${index + 1}/${model.delivery.files.length} ---`,
    );
  }
  lines.push("", "AUTOMATIC EVIDENCE AND LIMITATIONS");
  if (model.contract === null) {
    lines.push("contract: none");
  } else {
    lines.push(
      `contractId: ${model.contract.contractId}`,
      `contract digest: ${model.contract.digest}`,
      `host config: id=${model.contract.hostConfig.id} version=${model.contract.hostConfig.version}`,
      `verifier: id=${model.contract.verifier.id} version=${model.contract.verifier.version} parametersDigest=${model.contract.verifier.parametersDigest}`,
      `coverage: kind=${model.contract.coverage.kind} complete=${model.contract.coverage.complete} coveredRevisions=${displayValue(model.contract.coverage.coveredRevisions)}`,
      `coverage statement: ${model.contract.coverage.statement}`,
    );
    for (const condition of model.contract.conditions) {
      lines.push(
        `contract condition: id=${condition.conditionId} kind=${condition.kind} coveredRevisions=${displayValue(condition.coveredRevisions)}`,
        `contract condition description: ${condition.description}`,
      );
    }
  }
  const automatic = model.automatic;
  lines.push(
    `automatic state: ${automatic.state}`,
    `automatic receiptId: ${nullable(automatic.receiptId)}`,
    `automatic receiptDigest: ${nullable(automatic.receiptDigest)}`,
    `automatic outcome: ${nullable(automatic.outcome)}`,
    `automatic reason: ${nullable(automatic.reason)}`,
    `automatic compatibility: ${nullable(automatic.compatibility)}`,
    `automatic usable: ${automatic.usable}`,
    `automatic uncoveredRevisions: ${displayValue(automatic.uncoveredRevisions)}`,
    `automatic limits: ${displayValue(automatic.limits)}`,
    `automatic issuance facts: ${displayValue(automatic.issuanceFacts)}`,
  );
  for (const condition of automatic.conditions) {
    lines.push(
      `automatic condition: id=${condition.conditionId} kind=${condition.kind} result=${condition.result} coveredRevisions=${displayValue(condition.coveredRevisions)}`,
      `automatic condition detail: ${nullable(condition.detail)}`,
    );
  }
  for (const limitation of automatic.limitations) {
    lines.push(`automatic limitation: ${limitation}`);
  }

  lines.push(
    "",
    "BOUND TASK",
    `ownerId: ${model.task.ownerId}`,
    `taskId: ${model.task.taskId}`,
    `taskRevision: ${model.task.taskRevision}`,
    `requirementsDigest: ${model.task.requirementsDigest}`,
    "",
    "BOUND DELIVERY AND RUN",
    `deliveryId: ${model.delivery.deliveryId}`,
    `previewDigest: ${model.delivery.previewDigest}`,
    `runId: ${model.delivery.runId}`,
    `callId: ${model.delivery.callId}`,
    `source: bytes=${model.delivery.source.bytes} sha256=${model.delivery.source.sha256}`,
    `manifest: name=${model.delivery.manifest.name} bytes=${model.delivery.manifest.bytes} sha256=${model.delivery.manifest.sha256}`,
    `requirements file: name=${model.delivery.requirements.name} bytes=${model.delivery.requirements.bytes} sha256=${model.delivery.requirements.sha256}`,
    model.delivery.inputs.length === 0
      ? "inputs: none"
      : `inputs: ${displayValue(model.delivery.inputs)}`,
    "",
    "DISPLAY PROVENANCE",
    `display version: ${model.version}`,
    `display transform: ${model.transform}`,
    `display digest: ${presentation.digest}`,
    `raw content bytes: ${presentation.rawContentBytes}`,
    `rendered bytes: ${presentation.renderedBytes}`,
    `file count: ${presentation.fileCount}`,
    `requirement revisions: ${displayValue(requirementRevisions(model))}`,
    "",
    "REVIEW NOTES",
  );
  for (const note of model.notes) {
    lines.push(`note: ${note}`);
  }
  return lines;
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

/** Residual raw controls are treated as an unsupported display, never escaped. */
function hasResidualControl(line: string): boolean {
  for (const character of line) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || isFormatControl(code)) return true;
  }
  return false;
}

interface WrappedContent {
  rows: string[];
  problem: string | null;
}

function wrapFrozenContent(
  lines: readonly string[],
  width: number,
  runtime: HumanReviewRuntime,
): WrappedContent {
  const rows: string[] = [];
  for (const logical of lines) {
    for (const line of logical.split("\n")) {
      if (line.length > 0 && hasResidualControl(line)) {
        return { rows: [], problem: "display contains an unescaped control character" };
      }
      if (line.length > 0 && runtime.visibleWidth(line) === 0) {
        return { rows: [], problem: "a nonempty evidence line has zero terminal cells" };
      }
      const wrapped = runtime.wrapLiteralLine(line, width);
      if (wrapped.length === 0 || wrapped.join("") !== line) {
        return { rows: [], problem: "the terminal wrapper did not preserve the line" };
      }
      for (const row of wrapped) {
        if (row.length > 0 && runtime.visibleWidth(row) === 0) {
          return { rows: [], problem: "a nonempty wrapped row has zero terminal cells" };
        }
        if (runtime.visibleWidth(row) > width) {
          return { rows: [], problem: "a grapheme is wider than the available cells" };
        }
        rows.push(row);
      }
    }
  }
  return { rows, problem: null };
}

function paginate(rows: readonly string[], bodyHeight: number): string[][] {
  if (rows.length === 0) return [[]];
  const pages: string[][] = [];
  for (let index = 0; index < rows.length; index += bodyHeight) {
    pages.push(rows.slice(index, index + bodyHeight));
  }
  return pages;
}

export function createHumanReviewComponent(options: HumanReviewComponentOptions): HumanReviewComponent {
  const runtime = options.runtime;
  const presentation = options.presentation;
  const now = options.now ?? (() => Date.now());
  let disposed = false;
  let settled = false;
  let focus: "reject" | "accept" = "reject";
  let pageIndex = 0;
  let layout: Layout | null = null;
  let lastFrame: RenderedFrame | null = null;
  let paintProblem: string | null = null;
  let paintListenerUnavailable: string | null = null;
  let expired = false;
  let unsubscribePaint: (() => void) | undefined;
  const verified = new Set<number>();

  const requestRender = (): void => {
    if (disposed || settled) return;
    try {
      options.requestRender?.();
    } catch {
      // A failed repaint cannot turn into approval or change coverage.
    }
  };

  const deadlineReached = (): boolean => {
    const deadline = Date.parse(options.expiresAt);
    if (!Number.isSafeInteger(deadline)) return true;
    return now() >= deadline;
  };

  const acceptEligible = (): boolean => {
    if (disposed || settled) return false;
    if (options.signal?.aborted === true) return false;
    if (paintProblem !== null) return false;
    if (expired || deadlineReached()) return false;
    const current = layout;
    const frame = lastFrame;
    if (current === null || frame === null) return false;
    if (!current.supported || current.pageCount === 0) return false;
    if (frame.signature !== current.signature) return false;
    let geometry: HumanReviewGeometry;
    try {
      geometry = options.geometry();
    } catch {
      return false;
    }
    if (frame.width !== geometry.columns || frame.rows !== geometry.rows) return false;
    return verified.size === current.pageCount;
  };

  const invalidateCoverage = (reason: string): void => {
    if (verified.size > 0 || paintProblem === null) {
      verified.clear();
      focus = "reject";
      paintProblem = reason;
      requestRender();
    }
  };

  const onPaint = (paint: HumanReviewPaint): void => {
    if (disposed || settled) return;
    const frame = lastFrame;
    const current = layout;
    if (frame === null || current === null || !frame.supported || frame.pageCount === 0) return;
    if (paint.alt !== true) {
      invalidateCoverage("paint gate: the completed frame was not the fullscreen view");
      return;
    }
    if (!Number.isSafeInteger(paint.columns) || !Number.isSafeInteger(paint.rows)) return;
    if (paint.columns !== frame.width || paint.rows !== frame.rows) return;
    let geometry: HumanReviewGeometry;
    try {
      geometry = options.geometry();
    } catch {
      return;
    }
    if (geometry.columns !== frame.width || geometry.rows !== frame.rows) return;
    if (!Array.isArray(paint.viewport) || paint.viewport.length !== frame.rows) {
      invalidateCoverage("paint gate: the completed frame did not cover the full terminal height");
      return;
    }
    for (let index = 0; index < frame.rows; index += 1) {
      const actual = runtime.stripTerminalSequences(String(paint.viewport[index] ?? ""));
      if (actual !== frame.padded[index]) {
        invalidateCoverage("paint gate: a displayed row did not match the frozen layout");
        return;
      }
    }
    paintProblem = null;
    if (verified.has(frame.pageIndex)) return;
    verified.add(frame.pageIndex);
    if (verified.size === current.pageCount) requestRender();
  };

  if (options.paintSource !== undefined) {
    try {
      unsubscribePaint = options.paintSource.addPaintListener(onPaint);
    } catch {
      paintListenerUnavailable = "paint gate: no completed-frame listener is available";
      paintProblem = paintListenerUnavailable;
    }
  } else {
    paintListenerUnavailable = "paint gate: no completed-frame listener is available";
    paintProblem = paintListenerUnavailable;
  }

  const noticeRows = (problem: string, width: number, rows: number): string[] => {
    const logical = [
      "Esc rejects",
      "Acceptance disabled",
      problem,
      "Resize to at least 48x10 or press Escape to reject.",
      "No file content is counted as reviewed in this layout.",
      "HUMAN REVIEW",
      `Deadline: ${options.expiresAt}`,
    ];
    const flattened: string[] = [];
    for (const line of logical) {
      for (const row of runtime.wrapLiteralLine(line, Math.max(1, width))) flattened.push(row);
    }
    const selected = flattened.slice(0, rows);
    while (selected.length < rows) selected.push("");
    return selected;
  };

  const computeLayout = (width: number, rows: number): Layout => {
    const signature = `${presentation.digest}|${width}|${rows}`;
    if (width < HUMAN_REVIEW_MIN_COLUMNS || rows < HUMAN_REVIEW_MIN_ROWS) {
      const problem = `terminal is ${width}x${rows}; minimum is ${HUMAN_REVIEW_MIN_COLUMNS}x${HUMAN_REVIEW_MIN_ROWS}`;
      return {
        signature,
        width,
        rows,
        bodyHeight: rows - HEADER_ROWS - FOOTER_ROWS,
        pages: [],
        pageCount: 0,
        supported: false,
        problem,
      };
    }
    const bodyHeight = rows - HEADER_ROWS - FOOTER_ROWS;
    if (bodyHeight < BODY_MIN_ROWS) {
      return {
        signature,
        width,
        rows,
        bodyHeight: 0,
        pages: [],
        pageCount: 0,
        supported: false,
        problem: "no readable review rows fit in this terminal",
      };
    }
    const wrapped = wrapFrozenContent(contentLines(presentation), width, runtime);
    if (wrapped.problem !== null) {
      return {
        signature,
        width,
        rows,
        bodyHeight,
        pages: [],
        pageCount: 0,
        supported: false,
        problem: wrapped.problem,
      };
    }
    const pages = paginate(wrapped.rows, bodyHeight);
    return {
      signature,
      width,
      rows,
      bodyHeight,
      pages,
      pageCount: pages.length,
      supported: true,
      problem: null,
    };
  };

  const ensureLayout = (width: number, rows: number): Layout => {
    const signature = `${presentation.digest}|${width}|${rows}`;
    if (layout !== null && layout.signature === signature) return layout;
    const next = computeLayout(width, rows);
    layout = next;
    verified.clear();
    focus = "reject";
    pageIndex = 0;
    lastFrame = null;
    paintProblem = paintListenerUnavailable;
    return next;
  };

  const headerRows = (current: Layout): string[] => {
    if (!current.supported) {
      return [
        "HUMAN REVIEW — display unavailable",
        "accept locked · display unsupported",
      ];
    }
    const shown = verified.size;
    const ready = acceptEligible();
    const status = ready
      ? `pages shown: ${shown}/${current.pageCount} · Accept ready`
      : paintProblem !== null
        ? `pages shown: ${shown}/${current.pageCount} · display unverified`
        : expired || deadlineReached()
          ? `pages shown: ${shown}/${current.pageCount} · deadline elapsed`
          : `pages shown: ${shown}/${current.pageCount} · Accept locked`;
    return [
      `HUMAN REVIEW · page ${pageIndex + 1}/${current.pageCount}`,
      status,
    ];
  };

  const footerRows = (current: Layout): string[] => {
    if (!current.supported) {
      return [
        "Acceptance disabled",
        "Press Escape to reject",
        "Resize for a readable review",
        `Deadline: ${options.expiresAt}`,
      ];
    }
    return [
      focus === "accept"
        ? "Decision: ○ Reject   ● Accept reviewed files"
        : "Decision: ● Reject   ○ Accept reviewed files",
      "↑/↓ browse pages · Enter confirms",
      "All pages shown → ↓ selects Accept, then Enter",
      "Esc rejects · " + `Deadline: ${options.expiresAt}`,
    ];
  };

  const paddedExpected = (plain: readonly string[], width: number): string[] | null => {
    const padded: string[] = [];
    for (const row of plain) {
      const normalized = runtime.normalizeTerminalOutput(row);
      const cells = runtime.visibleWidth(normalized);
      if (!Number.isSafeInteger(cells) || cells < 0 || cells > width) return null;
      padded.push(normalized + " ".repeat(width - cells));
    }
    return padded;
  };

  const renderNotice = (problem: string, width: number, rows: number): readonly string[] => {
    const current = layout;
    const fixed = noticeRows(problem, width, rows);
    const padded = paddedExpected(fixed, width) ?? fixed.map(() => " ".repeat(Math.max(0, width)));
    lastFrame = {
      signature: current?.signature ?? `${presentation.digest}|${width}|${rows}`,
      width,
      rows,
      pageIndex: 0,
      pageCount: 0,
      supported: false,
      plain: fixed,
      padded,
    };
    return fixed;
  };

  const component: HumanReviewComponent = {
    render(width: number): readonly string[] {
      let rows: number;
      try {
        rows = options.geometry().rows;
      } catch {
        return [];
      }
      if (!Number.isSafeInteger(rows) || rows <= 0) return [];
      if (disposed || settled) {
        return renderNotice("the review is closed", width, rows);
      }
      const current = ensureLayout(width, rows);
      if (!current.supported) {
        return renderNotice(current.problem ?? "the display is unsupported", width, rows);
      }
      if (pageIndex >= current.pageCount) pageIndex = current.pageCount - 1;
      const body = [...(current.pages[pageIndex] ?? [])];
      while (body.length < current.bodyHeight) body.push("");
      const plain = [
        ...headerRows(current),
        ...body.slice(0, current.bodyHeight),
        ...footerRows(current),
      ];
      while (plain.length < rows) plain.push("");
      const padded = paddedExpected(plain, width);
      if (padded === null) {
        return renderNotice("a rendered row exceeded the terminal width", width, rows);
      }
      lastFrame = {
        signature: current.signature,
        width,
        rows,
        pageIndex,
        pageCount: current.pageCount,
        supported: true,
        plain: plain.slice(0, rows),
        padded,
      };
      return plain.slice(0, rows);
    },

    capturesInput(data: string): boolean {
      if (disposed || settled) return false;
      try {
        if (data.includes(runtime.bracketedPasteStart) || data.includes(runtime.bracketedPasteEnd)) return true;
      } catch {
        return true;
      }
      return matchesKey(data, "escape")
        || matchesKey(data, "enter")
        || matchesKey(data, "return")
        || matchesKey(data, "up")
        || matchesKey(data, "down")
        || matchesKey(data, "left")
        || matchesKey(data, "right")
        || matchesKey(data, "pageUp")
        || matchesKey(data, "pageDown");
    },

    handleInput(data: string): void {
      if (disposed || settled) return;
      try {
        if (data.includes(runtime.bracketedPasteStart) || data.includes(runtime.bracketedPasteEnd)) {
          // A paste event is never parsed, even when the terminal appends CR
          // or a Kitty Enter after the closing marker.
          focus = "reject";
          requestRender();
          return;
        }
      } catch {
        focus = "reject";
        return;
      }
      if (isRelease(data) || isRepeat(data)) return;
      if (matchesKey(data, "escape")) {
        decide("reject");
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        if (focus === "accept") {
          if (!acceptEligible()) {
            if (deadlineReached()) {
              expired = true;
              requestRender();
            } else {
              focus = "reject";
              requestRender();
            }
            return;
          }
          decide("approve");
          return;
        }
        decide("reject");
        return;
      }
      if (matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "pageUp")) {
        if (focus === "accept") {
          focus = "reject";
          requestRender();
          return;
        }
        if (layout !== null && layout.supported && pageIndex > 0) {
          pageIndex -= 1;
          requestRender();
        }
        return;
      }
      if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "pageDown")) {
        if (focus === "accept") return;
        if (layout !== null && layout.supported && pageIndex < layout.pageCount - 1) {
          pageIndex += 1;
          requestRender();
          return;
        }
        if (acceptEligible()) {
          focus = "accept";
          requestRender();
        }
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      verified.clear();
      const unsubscribe = unsubscribePaint;
      unsubscribePaint = undefined;
      try {
        unsubscribe?.();
      } catch {
        // No late decision path depends on a failed unsubscribe.
      }
      lastFrame = null;
    },
  };

  function matchesKey(data: string, keyId: string): boolean {
    try {
      return runtime.matchesKey(data, keyId) === true;
    } catch {
      return false;
    }
  }

  function isRelease(data: string): boolean {
    try {
      return runtime.isKeyRelease(data) === true;
    } catch {
      return false;
    }
  }

  function isRepeat(data: string): boolean {
    try {
      return runtime.isKeyRepeat(data) === true;
    } catch {
      return false;
    }
  }

  function decide(decision: HumanReviewDecision): void {
    if (disposed || settled) return;
    settled = true;
    verified.clear();
    try {
      options.onDecision(decision);
    } catch {
      // The adapter's one-shot closure remains authoritative.
    }
  }

  return component;
}
