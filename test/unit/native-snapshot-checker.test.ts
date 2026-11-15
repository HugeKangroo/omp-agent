import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_NATIVE_TEXT_CHECK_CONDITIONS,
  MAX_NATIVE_TEXT_CHECK_PLAN_BYTES,
  MAX_NATIVE_TEXT_CHECK_RECEIPT_BYTES,
  NativeTextCheckError,
  NATIVE_TEXT_CHECKER_ID,
  NATIVE_TEXT_CHECKER_VERSION,
  NATIVE_TEXT_CHECK_SCHEMA_VERSION,
  createNativeTextCheckPlan,
  matchesNativeTextCheckReceipt,
  runNativeTextChecks,
  type NativeTextCheckCondition,
} from "../../src/native-snapshot-checker.ts";
import {
  MAX_OUTPUT_FILE_BYTES,
  NativeFileError,
  captureWorkspaceText,
  isNativeWorkspaceTextSnapshot,
  nodeFileIo,
  observeWorkspaceFile,
  type NativeFileIo,
} from "../../src/native-work.ts";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-d3-a1-")));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resultsById(receipt: ReturnType<typeof runNativeTextChecks>): Record<string, string> {
  return Object.fromEntries(receipt.conditions.map((condition) => [condition.id, condition.result]));
}

describe("native workspace text snapshots", () => {
  test("capture retains exact BOM, Unicode and CRLF bytes while old observe stays plain", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "nested"));
    const content = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("héllo 🌍\r\nsecond line\r\n", "utf8"),
    ]);
    await writeFile(path.join(root, "nested", "data.txt"), content);

    const snapshot = await captureWorkspaceText(root, "nested/data.txt", nodeFileIo, 1234);
    expect(snapshot.text).toBe(content.toString("utf8"));
    expect(snapshot.text.startsWith("\uFEFF")).toBe(true);
    expect(Buffer.from(snapshot.text, "utf8").equals(content)).toBe(true);
    expect(snapshot.file).toEqual({
      relativePath: "nested/data.txt",
      bytes: content.length,
      sha256: sha256(content),
      observedAt: 1234,
    });
    expect(Object.keys(snapshot)).toEqual(["captureId", "file", "text"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.file)).toBe(true);
    expect(isNativeWorkspaceTextSnapshot(snapshot)).toBe(true);
    expect(isNativeWorkspaceTextSnapshot({
      captureId: snapshot.captureId,
      file: { ...snapshot.file },
      text: snapshot.text,
    })).toBe(false);

    const second = await captureWorkspaceText(root, "nested/data.txt");
    expect(second.captureId).not.toBe(snapshot.captureId);
    expect(second.file.sha256).toBe(snapshot.file.sha256);
    expect(() => {
      (snapshot as any).text = "changed";
    }).toThrow();

    const observed = await observeWorkspaceFile(root, "nested/data.txt", nodeFileIo, 99);
    expect(Object.keys(observed)).toEqual(["relativePath", "bytes", "sha256", "observedAt"]);
    expect("text" in observed).toBe(false);
    expect("captureId" in observed).toBe(false);
    expect(Object.isFrozen(observed)).toBe(false);
    observed.bytes = 0;
    expect(snapshot.file.bytes).toBe(content.length);

    await writeFile(path.join(root, "nested", "empty.txt"), Buffer.alloc(0));
    const empty = await captureWorkspaceText(root, "nested/empty.txt");
    expect(empty.text).toBe("");
    expect(empty.file.bytes).toBe(0);
    expect(empty.file.sha256).toBe(sha256(Buffer.alloc(0)));
    expect(Buffer.from(empty.text, "utf8").length).toBe(0);
  });

  test("capture uses one open/read stream and the in-memory text ignores later writes", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "out.txt"), "first bytes\n");
    let opens = 0;
    let reads = 0;
    const io: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        opens++;
        const handle = await nodeFileIo.open(target, flags);
        return {
          stat: (options) => handle.stat(options),
          close: () => handle.close(),
          async read(buffer, offset, length, position) {
            reads++;
            return handle.read(buffer, offset, length, position);
          },
        };
      },
    };

    const snapshot = await captureWorkspaceText(root, "out.txt", io);
    expect(opens).toBe(1);
    expect(reads).toBe(1);
    expect(MAX_OUTPUT_FILE_BYTES).toBe(256 * 1024);

    await writeFile(path.join(root, "out.txt"), "second bytes changed\n");
    expect(snapshot.text).toBe("first bytes\n");
    expect(snapshot.file.bytes).toBe("first bytes\n".length);
    expect(snapshot.file.sha256).toBe(sha256("first bytes\n"));

    let failure: unknown;
    try {
      await captureWorkspaceText(root, "missing.txt");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(NativeFileError);
    expect(isNativeWorkspaceTextSnapshot(failure)).toBe(false);
  });
});

describe("fixed native text check plans", () => {
  test("strict validation rejects malformed, accessor, proxy, symbol and oversized conditions", () => {
    const invalidInputs: unknown[] = [
      {},
      { conditions: [] },
      { conditions: "not-an-array" },
      {
        conditions: Array.from(
          { length: MAX_NATIVE_TEXT_CHECK_CONDITIONS + 1 },
          (_, index) => ({ id: `c${index}`, kind: "json-valid" }),
        ),
      },
      { conditions: [{ id: "", kind: "json-valid" }] },
      { conditions: [{ id: "a".repeat(129), kind: "json-valid" }] },
      { conditions: [{ id: "a", kind: "json-valid", extra: true }] },
      { conditions: [{ id: "a", kind: "text-includes", value: "" }] },
      { conditions: [{ id: "a", kind: "text-includes", value: "x".repeat(4097) }] },
      { conditions: [{ id: "a", kind: "json-equals", pointer: "", value: NaN }] },
      { conditions: [{ id: "a", kind: "json-equals", pointer: "", value: Infinity }] },
      { conditions: [{ id: "a", kind: "json-equals", pointer: "", value: {} }] },
      { conditions: [{ id: "a", kind: "json-type", pointer: "a", type: "string" }] },
      { conditions: [{ id: "a", kind: "json-type", pointer: "/a~2", type: "string" }] },
      {
        conditions: [{
          id: "a",
          kind: "json-type",
          pointer: `/${Array.from({ length: 33 }, (_, index) => `s${index}`).join("/")}`,
          type: "string",
        }],
      },
      { conditions: [{ id: "a", kind: "json-type", pointer: `/${"a".repeat(1024)}`, type: "string" }] },
      { conditions: [{ id: "a", kind: "json-type", pointer: "", type: "integer" }] },
      { conditions: [{ id: "a", kind: "unknown" }] },
      {
        conditions: [
          { id: "a", kind: "text-includes", value: "x" },
          { id: "a", kind: "json-valid" },
        ],
      },
      {
        conditions: Array.from(
          { length: 8 },
          (_, index) => ({ id: `c${index}`, kind: "text-includes", value: "x".repeat(4096) }),
        ),
      },
    ];
    for (const input of invalidInputs) {
      expect(() => createNativeTextCheckPlan(input)).toThrow(NativeTextCheckError);
    }

    let accessorCalls = 0;
    const accessor = { kind: "json-valid" } as Record<string, unknown>;
    Object.defineProperty(accessor, "id", {
      enumerable: true,
      get() {
        accessorCalls++;
        return "a";
      },
    });
    expect(() => createNativeTextCheckPlan({ conditions: [accessor] })).toThrow(NativeTextCheckError);
    expect(accessorCalls).toBe(0);

    const accessorInput = {} as Record<string, unknown>;
    Object.defineProperty(accessorInput, "conditions", {
      enumerable: true,
      get() {
        accessorCalls++;
        return [];
      },
    });
    expect(() => createNativeTextCheckPlan(accessorInput)).toThrow(NativeTextCheckError);
    expect(accessorCalls).toBe(0);

    let hugeAccessorCalls = 0;
    const hugeCondition = { id: "a", kind: "json-valid" } as Record<string, unknown>;
    Object.defineProperty(hugeCondition, "k".repeat(100_000), {
      enumerable: true,
      get() {
        hugeAccessorCalls++;
        return true;
      },
    });
    let hugeFailure: unknown;
    try {
      createNativeTextCheckPlan({ conditions: [hugeCondition] });
    } catch (error) {
      hugeFailure = error;
    }
    expect(hugeFailure).toBeInstanceOf(NativeTextCheckError);
    expect((hugeFailure as Error).message.length).toBeLessThan(300);
    expect(hugeAccessorCalls).toBe(0);

    let extraDescriptorCalls = 0;
    const planWithExtra = new Proxy(
      { conditions: [{ id: "a", kind: "json-valid" }], extra: true },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "extra") extraDescriptorCalls++;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    expect(() => createNativeTextCheckPlan(planWithExtra)).toThrow(NativeTextCheckError);
    expect(extraDescriptorCalls).toBe(0);

    let conditionDescriptorCalls = 0;
    const oversizedCondition = new Proxy(
      { id: "a", kind: "json-valid", a: 1, b: 2, c: 3 },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "a" || property === "b" || property === "c") conditionDescriptorCalls++;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    expect(() => createNativeTextCheckPlan({ conditions: [oversizedCondition] })).toThrow(NativeTextCheckError);
    expect(conditionDescriptorCalls).toBe(0);

    const oversizedArrayTarget = Array.from(
      { length: MAX_NATIVE_TEXT_CHECK_CONDITIONS },
      (_, index) => ({ id: `c${index}`, kind: "json-valid" }),
    );
    Object.defineProperty(oversizedArrayTarget, "extra", { enumerable: true, value: true });
    let arrayDescriptorCalls = 0;
    const oversizedArray = new Proxy(oversizedArrayTarget, {
      getOwnPropertyDescriptor(target, property) {
        if (property === "extra") arrayDescriptorCalls++;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() => createNativeTextCheckPlan({ conditions: oversizedArray })).toThrow(NativeTextCheckError);
    expect(arrayDescriptorCalls).toBe(0);

    const symbolCondition = { id: "a", kind: "json-valid", [Symbol("extra")]: true };
    expect(() => createNativeTextCheckPlan({ conditions: [symbolCondition] })).toThrow(NativeTextCheckError);

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => createNativeTextCheckPlan({ conditions: [revoked.proxy] })).toThrow(NativeTextCheckError);

    let getTrapCalls = 0;
    const proxied = new Proxy({ id: "proxied", kind: "json-valid" }, {
      get(target, property, receiver) {
        getTrapCalls++;
        return Reflect.get(target, property, receiver);
      },
    });
    const plan = createNativeTextCheckPlan({ conditions: [proxied] });
    expect(getTrapCalls).toBe(0);
    expect(plan.conditions[0]?.kind).toBe("json-valid");

    expect(JSON.stringify({ plan }).length).toBeLessThan(MAX_NATIVE_TEXT_CHECK_PLAN_BYTES);
  });

  test("plan byte limit includes the wrapper and digest at the exact boundary", () => {
    const encoder = new TextEncoder();
    const conditions = (lastValueChars: number): NativeTextCheckCondition[] => [
      { id: "a", kind: "text-includes", value: "x".repeat(4096) },
      { id: "b", kind: "text-includes", value: "x".repeat(4096) },
      { id: "c", kind: "text-includes", value: "x".repeat(4096) },
      { id: "d", kind: "text-includes", value: "x".repeat(lastValueChars) },
    ];

    const justBelow = createNativeTextCheckPlan({ conditions: conditions(3741) });
    expect(encoder.encode(JSON.stringify(justBelow)).byteLength).toBe(MAX_NATIVE_TEXT_CHECK_PLAN_BYTES - 1);

    const atBound = createNativeTextCheckPlan({ conditions: conditions(3742) });
    expect(encoder.encode(JSON.stringify(atBound)).byteLength).toBe(MAX_NATIVE_TEXT_CHECK_PLAN_BYTES);

    const overBound = conditions(3743);
    const payloadBytes = encoder.encode(JSON.stringify({
      checkerId: NATIVE_TEXT_CHECKER_ID,
      checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
      schemaVersion: NATIVE_TEXT_CHECK_SCHEMA_VERSION,
      conditions: overBound,
    })).byteLength;
    expect(payloadBytes).toBeLessThanOrEqual(MAX_NATIVE_TEXT_CHECK_PLAN_BYTES);
    expect(() => createNativeTextCheckPlan({ conditions: overBound })).toThrow(NativeTextCheckError);
  });

  test("issued plans are deeply frozen and mutations cannot alter checks", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "data.json"), '{"x":1}');
    const snapshot = await captureWorkspaceText(root, "data.json");
    const plan = createNativeTextCheckPlan({
      conditions: [{ id: "x", kind: "json-equals", pointer: "/x", value: 1 }],
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.conditions)).toBe(true);
    expect(Object.isFrozen(plan.conditions[0])).toBe(true);
    expect(plan.checkerId).toBe(NATIVE_TEXT_CHECKER_ID);
    expect(plan.checkerVersion).toBe(NATIVE_TEXT_CHECKER_VERSION);

    expect(() => {
      (plan as any).conditions[0].value = 2;
    }).toThrow();
    expect(() => {
      (plan as any).conditions.push({ id: "other", kind: "json-valid" });
    }).toThrow();
    expect(runNativeTextChecks(snapshot, plan).outcome).toBe("pass");
  });
});

describe("fixed native text checks", () => {
  test("JSON pointer, duplicate keys and primitive types use own-key ordinary JSON semantics", async () => {
    const root = await workspace();
    const text = '{"a/b":{"m~n":7},"arr":[1,{"x":null},"s"],"flag":true,"nothing":null,"nested":{"constructor":"own"},"dup":1,"dup":2}';
    await writeFile(path.join(root, "data.json"), text);
    const snapshot = await captureWorkspaceText(root, "data.json");
    const conditions: NativeTextCheckCondition[] = [
      { id: "valid", kind: "json-valid" },
      { id: "root-object", kind: "json-type", pointer: "", type: "object" },
      { id: "escaped-type", kind: "json-type", pointer: "/a~1b/m~0n", type: "number" },
      { id: "escaped-eq", kind: "json-equals", pointer: "/a~1b/m~0n", value: 7 },
      { id: "array-index", kind: "json-equals", pointer: "/arr/0", value: 1 },
      { id: "array-object", kind: "json-type", pointer: "/arr/1", type: "object" },
      { id: "null", kind: "json-type", pointer: "/arr/1/x", type: "null" },
      { id: "boolean", kind: "json-type", pointer: "/flag", type: "boolean" },
      { id: "string", kind: "json-type", pointer: "/arr/2", type: "string" },
      { id: "array", kind: "json-type", pointer: "/arr", type: "array" },
      { id: "own-inherited-name", kind: "json-type", pointer: "/nested/constructor", type: "string" },
      { id: "dup", kind: "json-equals", pointer: "/dup", value: 2 },
      { id: "missing", kind: "json-type", pointer: "/missing", type: "null" },
      { id: "inherited", kind: "json-type", pointer: "/constructor", type: "string" },
      { id: "bounds", kind: "json-equals", pointer: "/arr/3", value: 1 },
      { id: "append", kind: "json-equals", pointer: "/arr/-", value: 1 },
      { id: "noncanonical", kind: "json-equals", pointer: "/arr/01", value: 1 },
      { id: "root-eq", kind: "json-equals", pointer: "", value: "not the root" },
    ];
    const receipt = runNativeTextChecks(snapshot, createNativeTextCheckPlan({ conditions }));
    expect(receipt.outcome).toBe("fail");
    const results = resultsById(receipt);
    for (const id of [
      "valid",
      "root-object",
      "escaped-type",
      "escaped-eq",
      "array-index",
      "array-object",
      "null",
      "boolean",
      "string",
      "array",
      "own-inherited-name",
      "dup",
    ]) {
      expect(results[id]).toBe("pass");
    }
    for (const id of ["missing", "inherited", "bounds", "append", "noncanonical", "root-eq"]) {
      expect(results[id]).toBe("fail");
    }
    expect(receipt.taskAccepted).toBe(false);
    expect(receipt.semanticAcceptance).toBe("not-evaluated");

    await writeFile(path.join(root, "invalid.json"), "not json");
    const invalid = await captureWorkspaceText(root, "invalid.json");
    const invalidReceipt = runNativeTextChecks(invalid, createNativeTextCheckPlan({
      conditions: [
        { id: "text", kind: "text-includes", value: "not" },
        { id: "valid-json", kind: "json-valid" },
        { id: "root", kind: "json-type", pointer: "", type: "object" },
        { id: "value", kind: "json-equals", pointer: "/x", value: 1 },
      ],
    }));
    expect(resultsById(invalidReceipt)).toEqual({
      text: "pass",
      "valid-json": "fail",
      root: "fail",
      value: "fail",
    });
    expect(invalidReceipt.outcome).toBe("fail");
  });

  test("V1 failure, V2 pass and ABA restore keep each receipt bound to its capture", async () => {
    const root = await workspace();
    const file = path.join(root, "data.json");
    const v1 = '{"status":"pending"}\n';
    const v2 = '{"status":"done"}\n';
    await writeFile(file, v1);
    const first = await captureWorkspaceText(root, "data.json");
    const plan = createNativeTextCheckPlan({
      conditions: [
        { id: "done", kind: "json-equals", pointer: "/status", value: "done" },
        { id: "status-text", kind: "json-type", pointer: "/status", type: "string" },
      ],
    });
    const firstReceipt = runNativeTextChecks(first, plan);
    expect(firstReceipt.outcome).toBe("fail");
    expect(matchesNativeTextCheckReceipt(firstReceipt, first, plan)).toBe(true);

    await writeFile(file, v2);
    const second = await captureWorkspaceText(root, "data.json");
    const secondReceipt = runNativeTextChecks(second, plan);
    expect(secondReceipt.outcome).toBe("pass");
    expect(matchesNativeTextCheckReceipt(secondReceipt, second, plan)).toBe(true);
    expect(matchesNativeTextCheckReceipt(firstReceipt, second, plan)).toBe(false);

    await writeFile(file, v1);
    const restored = await captureWorkspaceText(root, "data.json");
    expect(restored.file.sha256).toBe(first.file.sha256);
    expect(restored.captureId).not.toBe(first.captureId);
    expect(restored.text).toBe(v1);
    expect(first.text).toBe(v1);
    expect(matchesNativeTextCheckReceipt(firstReceipt, restored, plan)).toBe(false);
    expect(matchesNativeTextCheckReceipt(secondReceipt, restored, plan)).toBe(false);
    expect(matchesNativeTextCheckReceipt(firstReceipt, first, plan)).toBe(true);
    expect(runNativeTextChecks(restored, plan).outcome).toBe("fail");
    expect(firstReceipt.outcome).toBe("fail");

    const differentPlan = createNativeTextCheckPlan({
      conditions: [
        { id: "done", kind: "json-equals", pointer: "/status", value: "done" },
        { id: "status-text", kind: "json-type", pointer: "/status", type: "string" },
        { id: "extra", kind: "text-includes", value: "done" },
      ],
    });
    expect(matchesNativeTextCheckReceipt(secondReceipt, second, differentPlan)).toBe(false);

    const sameDigestPlan = createNativeTextCheckPlan({
      conditions: [
        { id: "done", kind: "json-equals", pointer: "/status", value: "done" },
        { id: "status-text", kind: "json-type", pointer: "/status", type: "string" },
      ],
    });
    expect(sameDigestPlan).not.toBe(plan);
    expect(sameDigestPlan.digest).toBe(plan.digest);
    expect(matchesNativeTextCheckReceipt(secondReceipt, second, sameDigestPlan)).toBe(false);
    expect(matchesNativeTextCheckReceipt(secondReceipt, second, plan)).toBe(true);
  });

  test("forged snapshots, plans and receipts are rejected without invoking accessors", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "data.json"), '{"ok":true}');
    const snapshot = await captureWorkspaceText(root, "data.json");
    const plan = createNativeTextCheckPlan({
      conditions: [{ id: "ok", kind: "json-equals", pointer: "/ok", value: true }],
    });
    const receipt = runNativeTextChecks(snapshot, plan);
    expect(receipt.outcome).toBe("pass");

    let accessorCalls = 0;
    const forgedSnapshot = Object.defineProperties({}, {
      captureId: { enumerable: true, get: () => { accessorCalls++; return snapshot.captureId; } },
      file: { enumerable: true, get: () => { accessorCalls++; return snapshot.file; } },
      text: { enumerable: true, get: () => { accessorCalls++; return snapshot.text; } },
    });
    expect(isNativeWorkspaceTextSnapshot(forgedSnapshot)).toBe(false);
    expect(matchesNativeTextCheckReceipt(receipt, forgedSnapshot, plan)).toBe(false);
    expect(() => runNativeTextChecks(forgedSnapshot as any, plan)).toThrow(NativeTextCheckError);

    const forgedPlan = Object.defineProperties({}, {
      digest: { enumerable: true, get: () => { accessorCalls++; return plan.digest; } },
      checkerId: { enumerable: true, get: () => { accessorCalls++; return plan.checkerId; } },
      checkerVersion: { enumerable: true, get: () => { accessorCalls++; return plan.checkerVersion; } },
      conditions: { enumerable: true, get: () => { accessorCalls++; return plan.conditions; } },
    });
    expect(matchesNativeTextCheckReceipt(receipt, snapshot, forgedPlan)).toBe(false);
    expect(() => runNativeTextChecks(snapshot, forgedPlan as any)).toThrow(NativeTextCheckError);

    const forgedReceipt = Object.defineProperties({}, {
      planDigest: { enumerable: true, get: () => { accessorCalls++; return receipt.planDigest; } },
      snapshot: { enumerable: true, get: () => { accessorCalls++; return receipt.snapshot; } },
      checkerVersion: { enumerable: true, get: () => { accessorCalls++; return receipt.checkerVersion; } },
    });
    expect(matchesNativeTextCheckReceipt(forgedReceipt, snapshot, plan)).toBe(false);
    expect(accessorCalls).toBe(0);

    expect(matchesNativeTextCheckReceipt({ ...receipt }, snapshot, plan)).toBe(false);
    expect(matchesNativeTextCheckReceipt(receipt, { ...snapshot }, plan)).toBe(false);
  });

  test("receipts are deeply frozen, bounded and never copy the captured text", async () => {
    const root = await workspace();
    const marker = "SENTINEL-DO-NOT-COPY";
    const content = `${marker}-${"x".repeat(4000)}`;
    await writeFile(path.join(root, "data.txt"), content);
    const snapshot = await captureWorkspaceText(root, "data.txt");
    const receipt = runNativeTextChecks(snapshot, createNativeTextCheckPlan({
      conditions: [{ id: "marker", kind: "text-includes", value: marker }],
    }));
    expect(receipt.outcome).toBe("pass");
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.snapshot)).toBe(true);
    expect(Object.isFrozen(receipt.snapshot.file)).toBe(true);
    expect(Object.isFrozen(receipt.conditions)).toBe(true);
    expect(Object.isFrozen(receipt.conditions[0])).toBe(true);
    expect(() => {
      (receipt as any).outcome = "fail";
    }).toThrow();
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain(marker);
    expect(encoded).not.toContain("x".repeat(100));
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(MAX_NATIVE_TEXT_CHECK_RECEIPT_BYTES);
  });
});
