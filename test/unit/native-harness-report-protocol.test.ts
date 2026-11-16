import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { NativeToolResult } from "../../src/native-entry.ts";
import {
  NATIVE_HARNESS_REPORT_MAX_WIRE_BYTES,
  boundNativeHarnessReportWire,
  readNativeHarnessReportSelectedInput,
  type NativeHarnessReportInputRead,
} from "../../src/native-harness-report-protocol.ts";
import {
  readNativeHarnessReportSelection,
  type NativeHarnessReportSelection,
} from "../../src/native-harness-report.ts";
import { fingerprintNativeJson } from "../../src/native-instance-result.ts";

const DIGEST = "a".repeat(64);

function freshSelection(overrides: Partial<NativeHarnessReportSelection> = {}): NativeHarnessReportSelection {
  return {
    sourceToolCallId: "source-1",
    captureId: "capture-1",
    captureDigest: DIGEST,
    checkToolCallIds: ["check-b", "check-a"],
    ...overrides,
  };
}

function selected(read: NativeHarnessReportInputRead): Extract<NativeHarnessReportInputRead, { state: "selected" }> {
  if (read.state !== "selected") {
    throw new Error(read.state === "invalid" ? `expected selected: ${read.reason}` : "expected selected, got ordinary");
  }
  return read;
}

function invalid(read: NativeHarnessReportInputRead): Extract<NativeHarnessReportInputRead, { state: "invalid" }> {
  if (read.state !== "invalid") throw new Error(`expected invalid, got ${read.state}`);
  return read;
}

function minimalReport(harnessResult: unknown): Record<string, unknown> {
  return { action: "report", outcome: "completed", harnessResult };
}

function expectSameFingerprint(read: Extract<NativeHarnessReportInputRead, { state: "selected" }>, reference: unknown): void {
  const expected = fingerprintNativeJson(reference);
  if (!expected.ok) throw new Error(expected.reason);
  expect(read.fingerprint).toEqual({ bytes: expected.bytes, sha256: expected.sha256 });
}

describe("selected Harness report input snapshot", () => {
  test("ordinary reports without an own selector are not inspected or rewritten", () => {
    expect(readNativeHarnessReportSelectedInput({ action: "inspect" }).state).toBe("ordinary");
    expect(readNativeHarnessReportSelectedInput({
      action: "report",
      checks: "not even a valid legacy value",
      outcome: "completed",
      extra: true,
    }).state).toBe("ordinary");
    expect(readNativeHarnessReportSelectedInput(null).state).toBe("ordinary");
    expect(readNativeHarnessReportSelectedInput("report").state).toBe("ordinary");

    const inherited = Object.create({ harnessResult: freshSelection() });
    inherited.action = "report";
    inherited.outcome = "completed";
    expect(readNativeHarnessReportSelectedInput(inherited).state).toBe("ordinary");
  });

  test("minimal selected input is owned, frozen and hashed with the original selector", () => {
    const raw = minimalReport(freshSelection());
    const read = selected(readNativeHarnessReportSelectedInput(raw));
    expect(Object.keys(read.input).sort()).toEqual(["action", "harnessResult", "outcome"]);
    expect(Object.isFrozen(read.input)).toBe(true);
    expect(read.input.harnessResult).toBe(read.selection);
    expect(Object.isFrozen(read.selection)).toBe(true);
    expect(Object.isFrozen(read.selection.checkToolCallIds)).toBe(true);
    expect(Object.isFrozen(read.fingerprint)).toBe(true);
    expect(Object.isFrozen(read)).toBe(true);
    expect(read.selection.checkToolCallIds).toEqual(["check-b", "check-a"]);
    expectSameFingerprint(read, raw);

    const nullPrototype = Object.assign(Object.create(null), {
      action: "report",
      outcome: "completed",
      harnessResult: freshSelection(),
    });
    expect(selected(readNativeHarnessReportSelectedInput(nullPrototype)).selection).toEqual(read.selection);
  });

  test("different selector source, capture and check ids change the complete input hash", () => {
    const original = selected(readNativeHarnessReportSelectedInput(minimalReport(freshSelection())));
    const variants = [
      freshSelection({ sourceToolCallId: "source-2" }),
      freshSelection({ captureId: "capture-2" }),
      freshSelection({ captureDigest: "b".repeat(64) }),
      freshSelection({ checkToolCallIds: ["check-a"] }),
      freshSelection({ checkToolCallIds: ["check-a", "check-b"] }),
    ];
    for (const variant of variants) {
      expect(selected(readNativeHarnessReportSelectedInput(minimalReport(variant))).fingerprint.sha256)
        .not.toBe(original.fingerprint.sha256);
    }
  });

  test("raw spaces and omitted optional fields hash differently from trimmed/default-injected input", () => {
    const raw = {
      action: "report",
      outcome: "insufficient",
      checks: [{ toolCallId: "call-1", purpose: "  keep raw purpose  " }],
      summary: "  keep raw summary  ",
      limitations: ["  keep raw limitation  "],
      harnessResult: freshSelection(),
    };
    const read = selected(readNativeHarnessReportSelectedInput(raw));
    expect(read.input.checks?.[0]?.purpose).toBe("  keep raw purpose  ");
    expect(read.input.summary).toBe("  keep raw summary  ");
    expect(read.input.limitations?.[0]).toBe("  keep raw limitation  ");
    expect(read.input.outputFiles).toBeUndefined();
    expect(read.input.harnessResult).toBe(read.selection);

    expectSameFingerprint(read, raw);

    const normalized = fingerprintNativeJson({
      action: "report",
      outcome: "insufficient",
      checks: [{ toolCallId: "call-1", purpose: "keep raw purpose" }],
      summary: "keep raw summary",
      limitations: ["keep raw limitation"],
      outputFiles: [],
      harnessResult: read.selection,
    });
    if (!normalized.ok) throw new Error(normalized.reason);
    expect(normalized.sha256).not.toBe(read.fingerprint.sha256);
  });

  test("explicit empty outputFiles is retained and hashes differently from omission", () => {
    const minimal = selected(readNativeHarnessReportSelectedInput(minimalReport(freshSelection())));
    const withEmpty = selected(readNativeHarnessReportSelectedInput({
      action: "report",
      outcome: "completed",
      outputFiles: [],
      harnessResult: freshSelection(),
    }));
    expect(withEmpty.input.outputFiles).toEqual([]);
    expect(Object.isFrozen(withEmpty.input.outputFiles)).toBe(true);
    expect(withEmpty.fingerprint.sha256).not.toBe(minimal.fingerprint.sha256);
    expectSameFingerprint(withEmpty, {
      action: "report",
      outcome: "completed",
      outputFiles: [],
      harnessResult: withEmpty.selection,
    });
  });

  test("caller mutation after the snapshot cannot change owned input, selector or hash", () => {
    const rawChecks = [{ toolCallId: "call-1", purpose: "original purpose" }];
    const rawLimitations = ["original limitation"];
    const rawSelector = {
      sourceToolCallId: "source-1",
      captureId: "capture-1",
      captureDigest: DIGEST,
      checkToolCallIds: ["check-b", "check-a"],
    };
    const read = selected(readNativeHarnessReportSelectedInput({
      action: "report",
      outcome: "completed",
      checks: rawChecks,
      limitations: rawLimitations,
      harnessResult: rawSelector,
    }));
    const before = read.fingerprint;
    const beforeSelection = read.selection;

    rawChecks[0]!.purpose = "mutated purpose";
    rawChecks.push({ toolCallId: "call-2", purpose: "late check" });
    rawLimitations[0] = "mutated limitation";
    rawSelector.sourceToolCallId = "mutated-source";
    rawSelector.checkToolCallIds[0] = "mutated-check";

    expect(read.input.checks?.[0]?.purpose).toBe("original purpose");
    expect(read.input.checks).toHaveLength(1);
    expect(read.input.limitations?.[0]).toBe("original limitation");
    expect(read.input.checks).not.toBe(rawChecks);
    expect(read.input.checks?.[0]).not.toBe(rawChecks[0]);
    expect(read.selection).toBe(beforeSelection);
    expect(read.selection.sourceToolCallId).toBe("source-1");
    expect(read.selection.checkToolCallIds).toEqual(["check-b", "check-a"]);
    expect(read.fingerprint).toEqual(before);
    const rehashed = fingerprintNativeJson(read.input);
    if (!rehashed.ok) throw new Error(rehashed.reason);
    expect({ bytes: rehashed.bytes, sha256: rehashed.sha256 }).toEqual(before);
  });

  test("one outer descriptor observation is reused; later proxy reads cannot split the snapshot", () => {
    let getReads = 0;
    const descriptorReads = new Map<string, number>();
    const target = { action: "report", outcome: "completed", harnessResult: freshSelection() };
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        getReads += 1;
        return Reflect.get(t, key, receiver);
      },
      getOwnPropertyDescriptor(t, key) {
        if (typeof key === "string") descriptorReads.set(key, (descriptorReads.get(key) ?? 0) + 1);
        if (key === "harnessResult" && (descriptorReads.get(key) ?? 0) > 1) {
          return {
            value: freshSelection({ sourceToolCallId: "late-selector" }),
            enumerable: true,
            configurable: true,
            writable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
    });
    const read = selected(readNativeHarnessReportSelectedInput(proxy));
    expect(getReads).toBe(0);
    expect(descriptorReads.get("action")).toBe(1);
    expect(descriptorReads.get("outcome")).toBe(1);
    expect(descriptorReads.get("harnessResult")).toBe(1);
    expect(read.selection.sourceToolCallId).toBe("source-1");
    expectSameFingerprint(read, target);
  });

  test("reflection failures and revoked proxies return bounded refusal, not ordinary", () => {
    const revoked = Proxy.revocable({ action: "report", outcome: "completed" }, {});
    revoked.revoke();
    const refusal = invalid(readNativeHarnessReportSelectedInput(revoked.proxy));
    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe("invalid-caller");
    expect(refusal.reason.length).toBeGreaterThan(0);
    expect(refusal.reason.length).toBeLessThanOrEqual(320);

    const throwing = new Proxy({}, {
      ownKeys() {
        throw new Error("trap");
      },
    });
    expect(invalid(readNativeHarnessReportSelectedInput(throwing)).code).toBe("invalid-caller");
  });

  test("selector accessors, non-enumerability and explicit undefined/null refuse without fallback", () => {
    let getterCalls = 0;
    const accessor = { action: "report", outcome: "completed" } as Record<string, unknown>;
    Object.defineProperty(accessor, "harnessResult", {
      get() {
        getterCalls += 1;
        return freshSelection();
      },
      enumerable: true,
      configurable: true,
    });
    expect(invalid(readNativeHarnessReportSelectedInput(accessor)).state).toBe("invalid");
    expect(getterCalls).toBe(0);

    const hidden = { action: "report", outcome: "completed" } as Record<string, unknown>;
    Object.defineProperty(hidden, "harnessResult", {
      value: freshSelection(),
      enumerable: false,
      configurable: true,
    });
    expect(invalid(readNativeHarnessReportSelectedInput(hidden)).state).toBe("invalid");

    for (const value of [undefined, null]) {
      expect(invalid(readNativeHarnessReportSelectedInput(minimalReport(value))).state).toBe("invalid");
    }
  });

  test("mixed origin, unknown string fields and symbol fields refuse in the selected branch", () => {
    for (const extra of ["instanceResult", "handoffAdoptionId", "unexpected", "toJSON"]) {
      const raw = { ...minimalReport(freshSelection()), [extra]: null };
      expect(invalid(readNativeHarnessReportSelectedInput(raw)).state).toBe("invalid");
    }
    const withSymbol = {
      ...minimalReport(freshSelection()),
      [Symbol("extra")]: true,
    };
    expect(invalid(readNativeHarnessReportSelectedInput(withSymbol)).state).toBe("invalid");
  });

  test("explicit undefined or null optional fields refuse rather than becoming omission", () => {
    for (const key of ["checks", "outputFiles", "summary", "limitations"] as const) {
      for (const value of [undefined, null]) {
        const raw = { ...minimalReport(freshSelection()), [key]: value };
        expect(invalid(readNativeHarnessReportSelectedInput(raw)).state).toBe("invalid");
      }
    }
  });

  test("wrong action/outcome, exotic prototypes and non-object arguments refuse", () => {
    for (const raw of [
      { action: "inspect", outcome: "completed", harnessResult: freshSelection() },
      { action: "report", outcome: "accepted", harnessResult: freshSelection() },
      { action: "report", harnessResult: freshSelection() },
      Object.assign(Object.create({ action: "report" }), minimalReport(freshSelection())),
      Object.assign([], minimalReport(freshSelection())),
    ]) {
      expect(invalid(readNativeHarnessReportSelectedInput(raw)).state).toBe("invalid");
    }
  });

  test("checks are exact finite rows and refuse accessors, extras, sparse/exotic arrays and oversize", () => {
    const base = (checks: unknown): Record<string, unknown> => ({
      action: "report",
      outcome: "completed",
      checks,
      harnessResult: freshSelection(),
    });

    expect(invalid(readNativeHarnessReportSelectedInput(base(new Array(1)))).state).toBe("invalid");

    const extraProperty: unknown[] = [{ toolCallId: "call-1", purpose: "p" }];
    Object.defineProperty(extraProperty, "extra", { value: true, enumerable: true });
    expect(invalid(readNativeHarnessReportSelectedInput(base(extraProperty))).state).toBe("invalid");

    const exoticPrototype: unknown[] = [{ toolCallId: "call-1", purpose: "p" }];
    Object.setPrototypeOf(exoticPrototype, {});
    expect(invalid(readNativeHarnessReportSelectedInput(base(exoticPrototype))).state).toBe("invalid");

    const proxyTarget = [
      { toolCallId: "call-1", purpose: "p" },
      { toolCallId: "call-2", purpose: "p" },
    ];
    const replacedIndex = new Proxy(proxyTarget, {
      ownKeys() {
        return ["length", "0", "extra"];
      },
      getOwnPropertyDescriptor(t, key) {
        if (key === "1") {
          return { value: proxyTarget[1], enumerable: true, configurable: true, writable: true };
        }
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
    });
    expect(invalid(readNativeHarnessReportSelectedInput(base(replacedIndex))).state).toBe("invalid");

    let getterCalls = 0;
    const item: Record<string, unknown> = { toolCallId: "call-1" };
    Object.defineProperty(item, "purpose", {
      get() {
        getterCalls += 1;
        return "p";
      },
      enumerable: true,
      configurable: true,
    });
    expect(invalid(readNativeHarnessReportSelectedInput(base([item]))).state).toBe("invalid");
    expect(getterCalls).toBe(0);

    expect(invalid(readNativeHarnessReportSelectedInput(base([
      { toolCallId: "call-1", purpose: "p", toJSON: () => "no" },
    ]))).state).toBe("invalid");

    expect(invalid(readNativeHarnessReportSelectedInput(base(
      Array.from({ length: 25 }, (_, index) => ({ toolCallId: `call-${index}`, purpose: "p" })),
    ))).state).toBe("invalid");

    expect(invalid(readNativeHarnessReportSelectedInput(base([
      { toolCallId: "x".repeat(257), purpose: "p" },
    ]))).state).toBe("invalid");

    expect(invalid(readNativeHarnessReportSelectedInput(base([
      { toolCallId: "call-1", purpose: "p".repeat(64 * 1024 + 1) },
    ]))).state).toBe("invalid");
  });

  test("summary, limitations and outputFiles enforce their fixed shape", () => {
    const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
      action: "report",
      outcome: "completed",
      harnessResult: freshSelection(),
      ...extra,
    });
    expect(invalid(readNativeHarnessReportSelectedInput(base({ summary: "s".repeat(2001) }))).state).toBe("invalid");
    expect(invalid(readNativeHarnessReportSelectedInput(base({ limitations: [1] }))).state).toBe("invalid");
    expect(invalid(readNativeHarnessReportSelectedInput(base({ limitations: Array(9).fill("x") }))).state).toBe("invalid");
    expect(invalid(readNativeHarnessReportSelectedInput(base({
      limitations: ["l".repeat(64 * 1024 + 1)],
    }))).state).toBe("invalid");
    expect(invalid(readNativeHarnessReportSelectedInput(base({ outputFiles: ["workspace.txt"] }))).state).toBe("invalid");
    expect(invalid(readNativeHarnessReportSelectedInput(base({ outputFiles: [""] }))).state).toBe("invalid");
  });
});

describe("shared Harness selection reader", () => {
  test("exact boundaries and raw id order are preserved", () => {
    const atLimit = readNativeHarnessReportSelection(freshSelection({
      sourceToolCallId: "s".repeat(256),
      captureId: "c".repeat(256),
      checkToolCallIds: Array.from({ length: 8 }, (_, index) => `check-${index}`),
    }));
    if (!atLimit.ok) throw new Error(atLimit.reason);
    expect(atLimit.selection.checkToolCallIds).toEqual([
      "check-0", "check-1", "check-2", "check-3", "check-4", "check-5", "check-6", "check-7",
    ]);
    expect(Object.isFrozen(atLimit.selection)).toBe(true);

    const ordered = readNativeHarnessReportSelection(freshSelection({
      checkToolCallIds: ["z-last", "a-first", "m-middle"],
    }));
    if (!ordered.ok) throw new Error(ordered.reason);
    expect(ordered.selection.checkToolCallIds).toEqual(["z-last", "a-first", "m-middle"]);
  });

  test("oversize, malformed, duplicate and noncontrol selection fields refuse", () => {
    const cases: NativeHarnessReportSelection[] = [
      freshSelection({ sourceToolCallId: "s".repeat(257) }),
      freshSelection({ captureId: "c".repeat(257) }),
      freshSelection({ sourceToolCallId: "bad\nid" }),
      freshSelection({ captureDigest: "A".repeat(64) }),
      freshSelection({ captureDigest: "a".repeat(63) }),
      freshSelection({ captureDigest: "a".repeat(65) }),
      freshSelection({ checkToolCallIds: Array.from({ length: 9 }, (_, index) => `check-${index}`) }),
      freshSelection({ checkToolCallIds: ["same", "same"] }),
      freshSelection({ checkToolCallIds: [""] }),
      freshSelection({ checkToolCallIds: ["bad\nid"] }),
      freshSelection({ checkToolCallIds: ["x".repeat(257)] }),
    ];
    for (const selection of cases) {
      expect(readNativeHarnessReportSelection(selection).ok).toBe(false);
    }
  });

  test("selection shape rejects accessors, symbols, sparse arrays and extra fields", () => {
    let getterCalls = 0;
    const accessor = { ...freshSelection(), checkToolCallIds: ["check-a"] } as Record<string, unknown>;
    Object.defineProperty(accessor, "captureId", {
      get() {
        getterCalls += 1;
        return "capture-1";
      },
      enumerable: true,
      configurable: true,
    });
    expect(readNativeHarnessReportSelection(accessor).ok).toBe(false);
    expect(getterCalls).toBe(0);

    expect(readNativeHarnessReportSelection({
      ...freshSelection(),
      [Symbol("extra")]: true,
    }).ok).toBe(false);
    expect(readNativeHarnessReportSelection({
      ...freshSelection(),
      instanceResult: null,
    }).ok).toBe(false);

    const sparse = ["check-a"];
    sparse.length = 2;
    expect(readNativeHarnessReportSelection(freshSelection({
      checkToolCallIds: sparse,
    })).ok).toBe(false);

    expect(readNativeHarnessReportSelection(freshSelection({
      checkToolCallIds: Object.assign(["check-a"], { extra: true }),
    })).ok).toBe(false);

    const revoked = Proxy.revocable(freshSelection(), {});
    revoked.revoke();
    const refusal = readNativeHarnessReportSelection(revoked.proxy);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.reason.length).toBeLessThanOrEqual(320);
  });
});

describe("selected input canonical 64KiB bound", () => {
  function reportWithPurpose(purpose: string): NativeHarnessReportInputRead {
    return readNativeHarnessReportSelectedInput({
      action: "report",
      outcome: "completed",
      checks: [{ toolCallId: "call-1", purpose }],
      harnessResult: freshSelection(),
    });
  }

  test("exact 64KiB encoding is accepted; one raw character over refuses", () => {
    const base = selected(reportWithPurpose(""));
    const padding = 64 * 1024 - base.fingerprint.bytes;
    expect(padding).toBeGreaterThan(0);
    expect(padding).toBeLessThan(64 * 1024);

    const exact = selected(reportWithPurpose("a".repeat(padding)));
    expect(exact.fingerprint.bytes).toBe(64 * 1024);

    const over = invalid(reportWithPurpose("a".repeat(padding + 1)));
    expect(over.code).toBe("too-large");
    expect(over.reason).toContain("encoding-byte-limit");
  });

  test("escape amplification within per-field raw caps is caught by the original encoder", () => {
    const amplified = invalid(reportWithPurpose("\u0000".repeat(12_000)));
    expect(amplified.code).toBe("too-large");
    expect(amplified.reason).toContain("encoding-byte-limit");
  });
});

function exactWire(target: number): NativeToolResult {
  const note = "utf8 é 漢 \"quoted\" \\ control:\u0001";
  const build = (text: string, extra: string): NativeToolResult => ({
    content: [{ type: "text", text }],
    details: { kind: "native-work-report", note, duplicatedText: text, extra },
  });
  const base = Buffer.byteLength(JSON.stringify(build("", "")), "utf8");
  let remaining = target - base;
  let extra = "";
  if (remaining % 2 !== 0) {
    extra = "x";
    remaining -= 1;
  }
  const wire = build("a".repeat(remaining / 2), extra);
  expect(Buffer.byteLength(JSON.stringify(wire), "utf8")).toBe(target);
  return wire;
}

describe("complete report wire bound", () => {
  test("exact 262144 UTF-8 bytes is accepted and preserves wire identity", () => {
    const wire = exactWire(NATIVE_HARNESS_REPORT_MAX_WIRE_BYTES);
    const result = boundNativeHarnessReportWire(wire);
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    expect(result.wire).toBe(wire);
    expect(result.bytes).toBe(NATIVE_HARNESS_REPORT_MAX_WIRE_BYTES);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("one byte over is refused without truncation or mutation, counting content and details", () => {
    const wire = exactWire(NATIVE_HARNESS_REPORT_MAX_WIRE_BYTES);
    const text = wire.content[0]!;
    text.text += "a";
    expect(Buffer.byteLength(JSON.stringify(wire), "utf8")).toBe(NATIVE_HARNESS_REPORT_MAX_WIRE_BYTES + 1);
    const before = text.text;
    const result = boundNativeHarnessReportWire(wire);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("too-large");
    expect(result.reason.length).toBeLessThanOrEqual(320);
    expect(text.text).toBe(before);
    expect(wire.content[0]).toBe(text);
  });

  test("JSON encoding failure refuses with a bounded reason", () => {
    const wire = {
      content: [{ type: "text", text: "x" }],
      details: { huge: 1n },
    } as unknown as NativeToolResult;
    const result = boundNativeHarnessReportWire(wire);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("invalid-caller");
    expect(result.reason.length).toBeLessThanOrEqual(320);
  });
});
