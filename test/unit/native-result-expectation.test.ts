import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  fingerprintNativeJson,
  MAX_ENVELOPE_BYTES,
  MAX_ENVELOPE_NODES,
} from "../../src/native-instance-result.ts";
import {
  fingerprintExpectedCallResult,
  fingerprintObservedCallResult,
} from "../../src/native-result-expectation.ts";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Independent canonicalization for the JSON-safe fixtures used here. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("fixture is not JSON-encodable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function expected(input: unknown, result: unknown): Record<string, unknown> {
  return { input, result };
}

function observed(
  input: unknown,
  content: unknown,
  isError: unknown,
  details?: unknown,
): Record<string, unknown> {
  return {
    input,
    content,
    isError,
    ...(details === undefined ? {} : { details }),
  };
}

describe("native result expectation projection", () => {
  test("fingerprints the exact 64 KiB projection boundary and refuses one byte more", () => {
    const baseProjection = {
      content: [{ type: "text", text: "" }],
      input: {},
      isError: false,
    };
    const baseBytes = Buffer.byteLength(canonical(baseProjection), "utf8");
    const text = "x".repeat(MAX_ENVELOPE_BYTES - baseBytes);
    const exactProjection = {
      content: [{ type: "text", text }],
      input: {},
      isError: false,
    };

    const exact = fingerprintExpectedCallResult(expected({}, {
      content: [{ type: "text", text }],
    }));
    expect(exact).toEqual({
      ok: true,
      inputFingerprint: { bytes: 2, sha256: hash("{}") },
      fingerprint: {
        bytes: MAX_ENVELOPE_BYTES,
        sha256: hash(canonical(exactProjection)),
      },
    });

    const direct = fingerprintNativeJson(exactProjection);
    expect(direct).toEqual({
      ok: true,
      bytes: MAX_ENVELOPE_BYTES,
      sha256: hash(canonical(exactProjection)),
    });

    const over = fingerprintExpectedCallResult(expected({}, {
      content: [{ type: "text", text: `${text}x` }],
    }));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("encoding-byte-limit");
  });

  test("expected details and isError omissions match their declared JSON semantics", () => {
    const omitted = fingerprintExpectedCallResult(expected({}, { content: [] }));
    const undefinedDetails = fingerprintExpectedCallResult(expected({}, {
      content: [],
      details: undefined,
    }));
    const observedEvent = fingerprintObservedCallResult(observed({}, [], false), 1000);
    expect(omitted.ok).toBe(true);
    expect(undefinedDetails).toEqual(omitted);
    expect(observedEvent.ok).toBe(true);
    if (!omitted.ok || !observedEvent.ok) return;
    expect(observedEvent.fingerprint).toEqual(omitted.fingerprint);

    const explicitUndefinedIsError = fingerprintExpectedCallResult(expected({}, {
      content: [],
      isError: undefined,
    }));
    expect(explicitUndefinedIsError).toEqual({
      ok: false,
      reason: "expected-iserror-invalid",
    });
  });

  test("refuses malformed expected surfaces without invoking accessors or toJSON", () => {
    let invoked = 0;
    const accessorResult: Record<string, unknown> = {};
    Object.defineProperty(accessorResult, "content", {
      enumerable: true,
      get() {
        invoked += 1;
        throw new Error("content getter must not run");
      },
    });
    expect(fingerprintExpectedCallResult(expected({}, accessorResult))).toEqual({
      ok: false,
      reason: "accessor",
    });
    expect(invoked).toBe(0);

    const toJSONInput = {
      toJSON() {
        invoked += 1;
        return "rewritten";
      },
    };
    const toJSON = fingerprintExpectedCallResult(expected(toJSONInput, { content: [] }));
    expect(toJSON.ok).toBe(false);
    if (!toJSON.ok) expect(toJSON.reason).toBe("encoding-unsupported");
    expect(invoked).toBe(0);

    expect(fingerprintExpectedCallResult(expected({}, { content: "text" }))).toEqual({
      ok: false,
      reason: "expected-content-not-array",
    });
    expect(fingerprintExpectedCallResult(expected({}, {
      content: [{ type: "image" }],
    }))).toEqual({
      ok: false,
      reason: "expected-content-unsupported",
    });
    expect(fingerprintExpectedCallResult(expected({}, {
      content: [],
      isError: "false",
    }))).toEqual({
      ok: false,
      reason: "expected-iserror-invalid",
    });
  });

  test("refuses accessors, cycles, depth, node and revoked-proxy inputs boundedly", () => {
    let invoked = 0;
    const accessorEvent: Record<string, unknown> = { input: {}, isError: false };
    Object.defineProperty(accessorEvent, "content", {
      enumerable: true,
      get() {
        invoked += 1;
        throw new Error("content getter must not run");
      },
    });
    expect(fingerprintObservedCallResult(accessorEvent, 1000)).toEqual({
      ok: false,
      reason: "accessor",
    });
    expect(invoked).toBe(0);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(fingerprintExpectedCallResult(expected(cyclic, { content: [] }))).toEqual({
      ok: false,
      reason: "encoding-cycle",
    });

    let nested: unknown = 0;
    for (let index = 0; index < 40; index += 1) nested = { next: nested };
    expect(fingerprintExpectedCallResult(expected({}, {
      content: [],
      details: nested,
    }))).toEqual({ ok: false, reason: "encoding-depth-limit" });

    const manyKeys: Record<string, number> = {};
    for (let index = 0; index <= MAX_ENVELOPE_NODES; index += 1) manyKeys[`k${index}`] = index;
    expect(fingerprintExpectedCallResult(expected({}, {
      content: [],
      details: manyKeys,
    }))).toEqual({ ok: false, reason: "encoding-node-limit" });

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const revoked = fingerprintExpectedCallResult(expected(revocable.proxy, { content: [] }));
    expect(revoked.ok).toBe(false);
  });

  test("one bounded snapshot prevents proxy ABA between fingerprints and facts", () => {
    let inputReads = 0;
    const input = new Proxy({ task: "initial" }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "task") {
          inputReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: inputReads === 1 ? "A" : "B",
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const expectedProjection = fingerprintExpectedCallResult(expected(input, { content: [] }));
    expect(expectedProjection.ok).toBe(true);
    expect(inputReads).toBe(1);
    if (!expectedProjection.ok) return;
    expect(expectedProjection.inputFingerprint.sha256).toBe(hash('{"task":"A"}'));
    expect(expectedProjection.fingerprint.sha256).toBe(hash(canonical({
      content: [],
      input: { task: "A" },
      isError: false,
    })));

    let textReads = 0;
    const block = new Proxy({ type: "text", text: "initial" }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "text") {
          textReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: textReads === 1 ? "ok" : "spoofed",
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const observedProjection = fingerprintObservedCallResult({
      input: {},
      content: [block],
      isError: false,
    }, 1000);
    expect(observedProjection.ok).toBe(true);
    expect(textReads).toBe(1);
    if (!observedProjection.ok) return;
    expect(observedProjection.facts.textExcerpt).toBe("ok");
    expect(observedProjection.fingerprint.sha256).toBe(hash(canonical({
      content: [{ type: "text", text: "ok" }],
      input: {},
      isError: false,
    })));

    let typeReads = 0;
    const changingBlock = new Proxy({ type: "text", text: "ok" }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "type") {
          typeReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: typeReads === 1 ? "text" : "image",
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const stableProfile = fingerprintExpectedCallResult(expected({}, {
      content: [changingBlock],
    }));
    expect(stableProfile.ok).toBe(true);
    expect(typeReads).toBe(1);
    if (!stableProfile.ok) return;
    expect(stableProfile.fingerprint.sha256).toBe(hash(canonical({
      content: [{ type: "text", text: "ok" }],
      input: {},
      isError: false,
    })));
  });

  test("snapshot preserves own __proto__ keys as JSON data", () => {
    const protoOne = JSON.parse('{"__proto__":"one"}') as Record<string, unknown>;
    const protoTwo = JSON.parse('{"__proto__":"two"}') as Record<string, unknown>;
    const one = fingerprintExpectedCallResult(expected({}, {
      content: [],
      details: protoOne,
    }));
    const two = fingerprintExpectedCallResult(expected({}, {
      content: [],
      details: protoTwo,
    }));
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.fingerprint.sha256).toBe(hash(canonical({
      content: [],
      details: protoOne,
      input: {},
      isError: false,
    })));
    expect(one.fingerprint.sha256).not.toBe(two.fingerprint.sha256);
  });

  test("requires the complete observed envelope and preserves legacy facts", () => {
    expect(fingerprintObservedCallResult({ content: [], isError: false }, 1000)).toEqual({
      ok: false,
      reason: "event-input-missing",
    });
    expect(fingerprintObservedCallResult({ input: {}, isError: false }, 1000)).toEqual({
      ok: false,
      reason: "event-content-missing",
    });
    expect(fingerprintObservedCallResult({ input: {}, content: [], isError: undefined }, 1000))
      .toEqual({ ok: false, reason: "event-iserror-invalid" });
    expect(fingerprintObservedCallResult({ input: {}, content: "text", isError: false }, 1000))
      .toEqual({ ok: false, reason: "event-content-not-array" });

    const facts = fingerprintObservedCallResult(observed({}, [
      { type: "text", text: "first" },
      { type: "image" },
      { type: "text", text: "second" },
    ], true, { exitCode: 7 }), 1000);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.facts).toMatchObject({
      isErrorObserved: true,
      textExcerpt: "first\nsecond",
      textTruncated: false,
      textBlocks: 2,
      imageBlocks: 1,
      detailsPresent: true,
      exitCodeFromToolDetails: 7,
    });
  });
});
