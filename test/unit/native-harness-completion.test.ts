import { describe, expect, test } from "bun:test";
import { copyWitnessResult } from "../../src/native-harness-completion.ts";

function resultValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value: Record<string, unknown> = {
    text: "bounded result",
    usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    eventsPath: "/tmp/worker-events.jsonl",
    status: "completed",
    ...overrides,
  };
  return value;
}

describe("G5-3A1 completion result projection", () => {
  test("genuinely absent usageEstimated defaults to observed usage", () => {
    const copied = copyWitnessResult(resultValue());
    expect(copied.failure).toBeNull();
    expect(copied.result?.usage.usageEstimated).toBe(false);
    expect(copied.result?.textBytes).toBe(Buffer.byteLength("bounded result", "utf8"));
  });

  test("explicit usageEstimated true is retained", () => {
    const copied = copyWitnessResult(resultValue({ usageEstimated: true }));
    expect(copied.result?.usage.usageEstimated).toBe(true);
  });

  test("an own usageEstimated accessor is never invoked and never defaults to known", () => {
    let calls = 0;
    const value = resultValue();
    Object.defineProperty(value, "usageEstimated", {
      enumerable: true,
      configurable: false,
      get() {
        calls += 1;
        return true;
      },
    });
    const copied = copyWitnessResult(value);
    expect(calls).toBe(0);
    expect(copied.result).toBeNull();
    expect(copied.failure).toContain("usage");
  });

  test("a present non-boolean usageEstimated is unreadable, not estimated", () => {
    const copied = copyWitnessResult(resultValue({ usageEstimated: "true" }));
    expect(copied.result).toBeNull();
    expect(copied.failure).toContain("usage");
  });
});
