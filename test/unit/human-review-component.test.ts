import { describe, expect, test } from "bun:test";
import {
  HUMAN_REVIEW_MIN_COLUMNS,
  HUMAN_REVIEW_MIN_ROWS,
  createHumanReviewComponent,
  type HumanReviewDecision,
  type HumanReviewPaint,
  type HumanReviewRuntime,
} from "../../src/human-review-component.ts";
import type { HumanReviewPresentation } from "../../src/human-review-types.ts";
import {
  FIXED_FILE_TEXT,
  FIXED_REQUIREMENT_TEXT,
  createSimulatedRuntime,
  fixedPresentation,
  geometryOf,
  simulatedPaint,
  type SimulatedGeometry,
} from "../harness/human-review-ui-sim.ts";

function setup(options: {
  geometry?: SimulatedGeometry;
  presentation?: HumanReviewPresentation;
  runtime?: HumanReviewRuntime;
} = {}): {
  component: ReturnType<typeof createHumanReviewComponent>;
  decisions: HumanReviewDecision[];
  geometry: ReturnType<typeof geometryOf>;
  render(): readonly string[];
  paint(alt?: boolean, mutate?: (rows: string[]) => void): void;
  body(rows: readonly string[]): readonly string[];
} {
  const geometry = geometryOf(options.geometry ?? { columns: 80, rows: 40 });
  const decisions: HumanReviewDecision[] = [];
  const listeners = new Set<(paint: HumanReviewPaint) => void>();
  const component = createHumanReviewComponent({
    presentation: options.presentation ?? fixedPresentation(),
    runtime: options.runtime ?? createSimulatedRuntime(),
    geometry: geometry.geometry,
    paintSource: {
      addPaintListener(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    requestRender: () => {},
    signal: new AbortController().signal,
    expiresAt: "2026-11-08T00:05:00.000Z",
    now: () => Date.parse("2026-11-08T00:01:00.000Z"),
    onDecision: (decision) => decisions.push(decision),
  });
  const render = (): readonly string[] => component.render(geometry.geometry().columns);
  return {
    component,
    decisions,
    geometry,
    render,
    paint(alt = true, mutate) {
      const width = geometry.geometry().columns;
      const rows = geometry.geometry().rows;
      const plain = [...render()];
      mutate?.(plain);
      const frame = simulatedPaint(plain, width, rows, alt);
      for (const listener of listeners) listener(frame);
    },
    body(rows: readonly string[]) {
      const height = geometry.geometry().rows;
      return rows.slice(2, height - 4);
    },
  };
}

function pageOf(rows: readonly string[]): { index: number; count: number } {
  const header = rows.find((row) => row.startsWith("HUMAN REVIEW · page "));
  const match = header?.match(/^HUMAN REVIEW · page (\d+)\/(\d+)$/);
  if (match === null || match === undefined) throw new Error("page header missing");
  return { index: Number(match[1]), count: Number(match[2]) };
}

describe("C2-A local human-review component (simulated paint)", () => {
  test("renders complete frozen requirements and file text losslessly", () => {
    const harness = setup({ geometry: { columns: 100, rows: 140 } });
    const rows = harness.render();
    const body = harness.body(rows);
    for (const line of FIXED_REQUIREMENT_TEXT.split("\n")) {
      expect(body).toContain(line);
    }
    for (const line of FIXED_FILE_TEXT.split("\n")) {
      expect(body).toContain(line);
    }
    expect(body).toContain("alpha line   ");
    expect(body).toContain("中文行 emoji 😀 combining e\u0301");
    expect(body).toContain("escaped control ⟦U+001B⟧ and literal tab notation ⟦U+0009⟧");
    expect(body).toContain("final tail marker: END-OF-FILE");
    expect(body).toContain("requirement tail: END-OF-REQUIREMENT");
    expect(body.some((line) => line === "")).toBe(true);
    expect(rows.every((row) => !row.includes("\x1b"))).toBe(true);
    expect(rows.join("\n")).toContain("AUTOMATIC EVIDENCE AND LIMITATIONS");
  });

  test("Accept requires a completed paint and distinct navigation", () => {
    const harness = setup({ geometry: { columns: 80, rows: 140 } });
    const before = harness.render();
    expect(pageOf(before).count).toBe(1);
    expect(before.join("\n")).toContain("Accept locked");
    harness.component.handleInput("\x1b[B");
    expect(harness.render().join("\n")).toContain("Decision: ● Reject");
    expect(harness.decisions).toEqual([]);

    harness.paint();
    const unlocked = harness.render();
    expect(unlocked.join("\n")).toContain("Accept ready");
    harness.component.handleInput("\x1b[B");
    const selected = harness.render();
    expect(selected.join("\n")).toContain("Decision: ○ Reject   ● Accept reviewed files");
    expect(harness.decisions).toEqual([]);

    harness.component.handleInput("\r");
    expect(harness.decisions).toEqual(["approve"]);
  });

  test("initial Enter rejects instead of approving", () => {
    const harness = setup({ geometry: { columns: 80, rows: 140 } });
    harness.render();
    harness.component.handleInput("\r");
    expect(harness.decisions).toEqual(["reject"]);
  });

  test("Escape rejects and repeated or late input is ignored", () => {
    const harness = setup({ geometry: { columns: 80, rows: 140 } });
    harness.render();
    harness.paint();
    harness.component.handleInput("\x1b[B");
    expect(harness.render().join("\n")).toContain("● Accept reviewed files");
    harness.component.handleInput("\x1b");
    expect(harness.decisions).toEqual(["reject"]);
    harness.component.handleInput("\r");
    harness.component.handleInput("\x1b[B");
    harness.component.handleInput("\x1b[200~paste\x1b[201~\r");
    expect(harness.decisions).toEqual(["reject"]);
  });

  test("bracketed paste plus trailing Enter never approves", () => {
    const harness = setup({ geometry: { columns: 80, rows: 140 } });
    harness.render();
    harness.paint();
    harness.component.handleInput("\x1b[B");
    expect(harness.render().join("\n")).toContain("● Accept reviewed files");
    harness.component.handleInput("\x1b[200~hello\r\nworld\x1b[201~\r");
    expect(harness.decisions).toEqual([]);
    expect(harness.render().join("\n")).toContain("Decision: ● Reject");
    harness.component.handleInput("\r");
    expect(harness.decisions).toEqual(["reject"]);
  });

  test("a completed frame mismatch leaves coverage uncounted", () => {
    const harness = setup({ geometry: { columns: 80, rows: 140 } });
    harness.render();
    harness.paint(true, (rows) => {
      rows[0] = `${rows[0]}tampered`;
    });
    harness.component.handleInput("\x1b[B");
    expect(harness.render().join("\n")).toContain("Decision: ● Reject");
    harness.component.handleInput("\r");
    expect(harness.decisions).toEqual(["reject"]);
  });

  test("a non-fullscreen paint is not coverage", () => {
    const harness = setup({ geometry: { columns: 80, rows: 140 } });
    harness.render();
    harness.paint(false);
    harness.component.handleInput("\x1b[B");
    expect(harness.render().join("\n")).toContain("Decision: ● Reject");
  });

  test("resize clears coverage and resets the default decision", () => {
    const harness = setup({ geometry: { columns: 60, rows: 14 } });
    const first = harness.render();
    expect(pageOf(first).count).toBeGreaterThan(1);
    harness.paint();
    harness.component.handleInput("\x1b[B");
    harness.paint();
    harness.geometry.resize(90, 30);
    const resized = harness.render();
    expect(pageOf(resized).index).toBe(1);
    expect(resized.join("\n")).toContain("Decision: ● Reject");
    const count = pageOf(resized).count;
    for (let index = 1; index < count; index += 1) {
      harness.component.handleInput("\x1b[B");
    }
    expect(harness.render().join("\n")).toContain("Decision: ● Reject");
    harness.component.handleInput("\x1b[B");
    expect(harness.render().join("\n")).toContain("Decision: ● Reject");
  });

  test("small terminals show a resize notice and keep Escape usable", () => {
    const harness = setup({
      geometry: { columns: HUMAN_REVIEW_MIN_COLUMNS - 4, rows: HUMAN_REVIEW_MIN_ROWS - 2 },
    });
    const rows = harness.render();
    expect(rows.join("\n")).toContain("Resize to at least 48x10");
    expect(rows.join("\n")).toContain("Esc rejects");
    harness.component.handleInput("\x1b");
    expect(harness.decisions).toEqual(["reject"]);
  });

  test("a nonempty zero-cell evidence line is unsupported, never accepted", () => {
    const presentation = fixedPresentation();
    presentation.model.requirements.sources[0]!.text = "\u0301";
    const harness = setup({ presentation, geometry: { columns: 80, rows: 40 } });
    const rows = harness.render();
    expect(rows.join("\n")).toContain("zero terminal cells");
    expect(rows.join("\n")).toContain("Acceptance disabled");
    harness.paint();
    harness.component.handleInput("\x1b[B");
    harness.component.handleInput("\r");
    expect(harness.decisions).toEqual(["reject"]);
  });

  test("a row wider than the terminal is unsupported, never accepted", () => {
    const presentation = fixedPresentation();
    presentation.model.delivery.files[0]!.text = "TESTWIDE\n";
    const base = createSimulatedRuntime();
    const runtime: HumanReviewRuntime = {
      ...base,
      visibleWidth: (text) => (text === "TESTWIDE" ? HUMAN_REVIEW_MIN_COLUMNS + 1 : base.visibleWidth(text)),
    };
    const harness = setup({ presentation, runtime, geometry: { columns: HUMAN_REVIEW_MIN_COLUMNS, rows: 20 } });
    const rows = harness.render();
    expect(rows.join("\n")).toContain("a grapheme is wider than the available cells");
    harness.paint();
    harness.component.handleInput("\x1b[B");
    harness.component.handleInput("\r");
    expect(harness.decisions).toEqual(["reject"]);
  });

  test("repeat and release events cannot decide", () => {
    const base = createSimulatedRuntime();
    const runtime: HumanReviewRuntime = {
      ...base,
      isKeyRepeat: (data) => data === "\x1b[B" || data === "\r",
      isKeyRelease: (data) => data === "\x1b",
    };
    const harness = setup({ geometry: { columns: 80, rows: 140 }, runtime });
    harness.render();
    harness.paint();
    harness.component.handleInput("\x1b[B");
    harness.component.handleInput("\r");
    harness.component.handleInput("\x1b");
    expect(harness.decisions).toEqual([]);
  });
});
