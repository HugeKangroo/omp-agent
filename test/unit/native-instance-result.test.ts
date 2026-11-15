import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  MAX_ASSOCIATION_ID_CHARS,
  MAX_ENVELOPE_BYTES,
  MAX_ENVELOPE_NODES,
  NATIVE_INSTANCE_RESULT_SCHEMA,
  NATIVE_INSTANCE_RESULT_VERSION,
  observeNativeInstanceResult,
  type NativeInstanceResultAssociation,
  type NativeInstanceResultObservation,
} from "../../src/native-instance-result.ts";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Independent test canonicalization for the simple JSON-safe fixture values used here. */
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

function association(
  overrides: Partial<Record<keyof NativeInstanceResultAssociation, unknown>> = {},
): NativeInstanceResultAssociation {
  return Object.freeze({
    instanceId: "instance-a",
    parentToolCallId: "call-a",
    index: 0 as const,
    childId: "ChildA",
    childSessionId: "session-child-a",
    agentName: "d2-same",
    parentSessionId: "parent-session",
    workspaceRoot: "/workspace",
    rootEpoch: 1,
    definitionVersion: "1",
    ...overrides,
  }) as NativeInstanceResultAssociation;
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 0,
    id: "ChildA",
    agent: "d2-same",
    exitCode: 0,
    aborted: false,
    truncated: false,
    output: "done",
    ...overrides,
  };
}

const NORMAL_CONTENT = [
  {
    type: "text",
    text: "<task-result id=\"ChildA\" agent=\"d2-same\" status=\"completed\" duration=\"37ms\">\n\n<output>\ndone\n</output>\n</task-result>",
  },
  { type: "text", text: "TOOL_RESULT_SENTINEL" },
];

interface EventOptions {
  readonly resultOverrides?: Record<string, unknown>;
  readonly results?: unknown;
  readonly isError?: unknown;
  readonly content?: unknown;
  readonly callId?: string;
  readonly details?: Record<string, unknown>;
  readonly toolName?: string;
}

function taskEvent(options: EventOptions = {}): Record<string, unknown> {
  const results = options.results ?? [result(options.resultOverrides)];
  return {
    toolName: options.toolName ?? "task",
    toolCallId: options.callId ?? "call-a",
    isError: options.isError === undefined ? false : options.isError,
    content: options.content === undefined ? NORMAL_CONTENT : options.content,
    details: options.details ?? { results },
  };
}

function expectEnvelopeComplete(
  observation: NativeInstanceResultObservation,
  event: Record<string, unknown>,
): void {
  const expectedText = canonical({
    content: event.content,
    details: event.details,
    isError: event.isError,
  });
  expect(observation.envelope).toEqual({
    encoding: "canonical-json",
    complete: true,
    bytes: Buffer.byteLength(expectedText, "utf8"),
    sha256: hash(expectedText),
  });
}

function expectUnavailable(
  observation: NativeInstanceResultObservation,
  reason: NativeInstanceResultObservation["reason"],
): void {
  expect(observation.state).toBe("unavailable");
  expect(observation.reason).toBe(reason);
  expect(observation.link).toBe("unavailable");
  expect(observation.outcome).toBe("unknown");
  expect(observation.confirmedChildAbort).toBe(false);
  expect(observation.envelope.complete).toBe(false);
  expect(observation.envelope.bytes).toBeNull();
  expect(observation.envelope.sha256).toBeNull();
}

describe("observeNativeInstanceResult association and outcome", () => {
  test("observes a normal native envelope and keeps output separate from formatted content", () => {
    const expected = association();
    const event = taskEvent({
      resultOverrides: { outputPath: "/workspace/tmp/ChildA.md" },
      details: {
        projectAgentsDir: "/workspace/.omp/agents",
        results: [result({ outputPath: "/workspace/tmp/ChildA.md" })],
        totalDurationMs: 37,
      },
    });
    event.content = NORMAL_CONTENT;

    const observation = observeNativeInstanceResult(expected, event);

    expect(observation.schema).toBe(NATIVE_INSTANCE_RESULT_SCHEMA);
    expect(observation.version).toBe(NATIVE_INSTANCE_RESULT_VERSION);
    expect(observation.authority).toBe("non-authoritative");
    expect(observation.scope).toBe("tool-result-middleware");
    expect(observation.state).toBe("observed");
    expect(observation.reason).toBe("observed-envelope");
    expect(observation.link).toBe("instance");
    expect(observation.outcome).toBe("completed-envelope");
    expect(observation.parentCancellation).toBe("unknown");
    expect(observation.semanticAcceptance).toBe("not-evaluated");
    expect(observation.confirmedChildAbort).toBe(false);
    expect(observation.association).toEqual(expected);
    expect(observation.association).not.toBe(expected);
    expect(Object.isFrozen(observation.association)).toBe(true);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.envelope)).toBe(true);
    expectEnvelopeComplete(observation, event);
    expect(observation.output).toEqual({
      bytes: 4,
      sha256: hash("done"),
      excerpt: "done",
      excerptTruncated: false,
    });
    expect(observation.native).toMatchObject({
      isError: false,
      exitCode: 0,
      aborted: false,
      truncated: false,
      errorPresent: false,
      error: null,
      abortReason: null,
      outputPath: "/workspace/tmp/ChildA.md",
    });
    expect("accepted" in observation).toBe(false);
    expect("eligible" in observation).toBe(false);
  });

  test("observes an active child abort without inferring parent cancellation", () => {
    const expected = association();
    const event = taskEvent({
      resultOverrides: {
        exitCode: 1,
        aborted: true,
        truncated: false,
        output: "",
        abortReason: "Interrupted by user",
        outputPath: "/workspace/tmp/ChildA.md",
      },
    });

    const observation = observeNativeInstanceResult(expected, event);

    expect(observation.state).toBe("observed");
    expect(observation.link).toBe("instance");
    expect(observation.outcome).toBe("aborted-envelope");
    expect(observation.confirmedChildAbort).toBe(true);
    expect(observation.parentCancellation).toBe("unknown");
    expect(observation.output).toEqual({
      bytes: 0,
      sha256: hash(""),
      excerpt: "",
      excerptTruncated: false,
    });
    expect(observation.native).toMatchObject({
      isError: false,
      exitCode: 1,
      aborted: true,
      truncated: false,
      errorPresent: false,
      abortReason: { text: "Interrupted by user", bytes: 19, truncated: false },
    });
  });

  test("observes a late completed result independently", () => {
    const expected = association({
      instanceId: "instance-late",
      parentToolCallId: "call-late",
      childId: "LateChild",
      childSessionId: "session-late",
    });
    const event = taskEvent({
      callId: "call-late",
      resultOverrides: { id: "LateChild", output: "late output" },
      content: [{ type: "text", text: "<task-result id=\"LateChild\">late output</task-result>" }],
    });

    const observation = observeNativeInstanceResult(expected, event);

    expect(observation.outcome).toBe("completed-envelope");
    expect(observation.association?.instanceId).toBe("instance-late");
    expect(observation.output?.sha256).toBe(hash("late output"));
  });

  test("keeps nested, salvaged, and malformed failure shapes out of completed", () => {
    const nestedFailure = observeNativeInstanceResult(association(), taskEvent({
      resultOverrides: {
        exitCode: 1,
        aborted: false,
        output: "",
        truncated: false,
        error: "Error: initial prompt dropped before provider dispatch",
      },
    }));
    expect(nestedFailure.outcome).toBe("failed-envelope");
    expect(nestedFailure.native).toMatchObject({
      exitCode: 1,
      aborted: false,
      errorPresent: true,
      error: {
        text: "Error: initial prompt dropped before provider dispatch",
        bytes: 54,
        truncated: false,
      },
    });

    const failureWithoutAborted = observeNativeInstanceResult(association(), (() => {
      const event = taskEvent({
        resultOverrides: {
          exitCode: 1,
          output: "",
          truncated: false,
          error: "structured failure without aborted property",
        },
      });
      const resultRecord = (event.details as { results: Array<Record<string, unknown>> }).results[0]!;
      delete resultRecord.aborted;
      return event;
    })());
    expect(failureWithoutAborted.outcome).toBe("failed-envelope");
    expect(failureWithoutAborted.native?.aborted).toBeNull();
    expect(failureWithoutAborted.native?.errorPresent).toBe(true);

    const salvaged = observeNativeInstanceResult(association(), taskEvent({
      isError: true,
      resultOverrides: {
        exitCode: 0,
        aborted: false,
        output: "",
        truncated: false,
        error: "salvaged child error",
      },
    }));
    expect(salvaged.outcome).toBe("failed-envelope");
    expect(salvaged.native).toMatchObject({ isError: true, exitCode: 0, aborted: false });

    const nullError = observeNativeInstanceResult(association(), taskEvent({
      resultOverrides: { error: null },
    }));
    expect(nullError.state).toBe("observed");
    expect(nullError.outcome).toBe("unknown");
    expect(nullError.native?.errorPresent).toBe(false);

    const abortedPrecedence = observeNativeInstanceResult(association(), taskEvent({
      resultOverrides: {
        exitCode: 1,
        aborted: true,
        abortReason: "Interrupted by user",
        error: "also errors",
      },
    }));
    expect(abortedPrecedence.outcome).toBe("aborted-envelope");
  });

  test("accepts empty output, truncated output, and an absent outputPath", () => {
    const expected = association();
    const event = taskEvent({
      resultOverrides: {
        output: "",
        truncated: true,
        outputPath: undefined,
      },
    });

    const observation = observeNativeInstanceResult(expected, event);

    expect(observation.state).toBe("observed");
    expect(observation.outcome).toBe("completed-envelope");
    expect(observation.output).toEqual({
      bytes: 0,
      sha256: hash(""),
      excerpt: "",
      excerptTruncated: false,
    });
    expect(observation.native?.truncated).toBe(true);
    expect(observation.native?.outputPath).toBeNull();
  });

  test("isolates two same-definition children by call, child id, and session", () => {
    const a = association();
    const b = association({
      instanceId: "instance-b",
      parentToolCallId: "call-b",
      childId: "ChildB",
      childSessionId: "session-child-b",
    });
    const eventA = taskEvent();
    const eventB = taskEvent({
      callId: "call-b",
      resultOverrides: { id: "ChildB", output: "done" },
    });

    const observedA = observeNativeInstanceResult(a, eventA);
    const observedB = observeNativeInstanceResult(b, eventB);

    expect(observedA.association?.instanceId).toBe("instance-a");
    expect(observedB.association?.instanceId).toBe("instance-b");
    expect(observedA.output?.sha256).toBe(hash("done"));
    expect(observedB.output?.sha256).toBe(hash("done"));
    expect(observedA.envelope.sha256).not.toBe(observedB.envelope.sha256);

    const crossCall = observeNativeInstanceResult(a, eventB);
    expectUnavailable(crossCall, "event-call-mismatch");
    expect(crossCall.association).toEqual(a);

    const crossIdEvent = taskEvent({ resultOverrides: { id: "ChildB" } });
    const crossId = observeNativeInstanceResult(a, crossIdEvent);
    expectUnavailable(crossId, "result-id");
    expect(crossId.association).toEqual(a);
  });

  test("keeps extra plain content fields in the digest without using tags as identity", () => {
    const expected = association();
    const firstEvent = taskEvent({
      content: [{
        type: "text",
        text: "<task-result id=\"OtherChild\" agent=\"other-agent\">wrong tag identity</task-result>",
        note: "first",
      }],
    });
    const secondEvent = taskEvent({
      content: [{
        type: "text",
        text: "<task-result id=\"OtherChild\" agent=\"other-agent\">wrong tag identity</task-result>",
        note: "second",
      }],
    });

    const first = observeNativeInstanceResult(expected, firstEvent);
    expect(first.state).toBe("observed");
    expect(first.link).toBe("instance");
    expect(first.outcome).toBe("completed-envelope");
    expect(first.association?.childId).toBe("ChildA");
    expectEnvelopeComplete(first, firstEvent);

    const conflicted = observeNativeInstanceResult(expected, secondEvent, first);
    expect(conflicted.state).toBe("conflicted");
    expect(conflicted.conflict?.reason).toBe("envelope-digest-mismatch");
    expect(conflicted.conflict?.lastEnvelopeSha256).toBe(hash(canonical({
      content: secondEvent.content,
      details: secondEvent.details,
      isError: secondEvent.isError,
    })));
  });

  test("refuses malformed or oversized expected associations before touching the event", () => {
    let getterCalls = 0;
    const expectedWithGetter = { ...association() };
    Object.defineProperty(expectedWithGetter, "instanceId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "instance-a";
      },
    });
    const getterObservation = observeNativeInstanceResult(expectedWithGetter, taskEvent());
    expectUnavailable(getterObservation, "expected-association-invalid");
    expect(getterObservation.association).toBeNull();
    expect(getterObservation.native).toBeNull();
    expect(getterCalls).toBe(0);

    const invalid = observeNativeInstanceResult(
      association({ instanceId: "" }),
      taskEvent(),
    );
    expectUnavailable(invalid, "expected-association-invalid");
    expect(invalid.association).toBeNull();

    const oversized = observeNativeInstanceResult(
      association({ instanceId: "x".repeat(MAX_ASSOCIATION_ID_CHARS + 1) }),
      taskEvent(),
    );
    expectUnavailable(oversized, "expected-association-oversized");
    expect(oversized.association).toBeNull();
  });

  test("refuses wrong calls, names, indices, batches, and malformed shapes", () => {
    const expected = association();
    const cases: Array<[unknown, NativeInstanceResultObservation["reason"]]> = [
      [null, "event-not-object"],
      [taskEvent({ toolName: "read" }), "event-not-task"],
      [taskEvent({ callId: "call-other" }), "event-call-mismatch"],
      [taskEvent({ results: [] }), "results-count"],
      [taskEvent({ results: [result(), result({ id: "ChildB" })] }), "results-count"],
      [taskEvent({ results: "not-an-array" }), "results-invalid"],
      [taskEvent({ results: [42] }), "result-shape"],
      [taskEvent({ resultOverrides: { index: 1 } }), "result-index"],
      [taskEvent({ resultOverrides: { id: "ChildB" } }), "result-id"],
      [taskEvent({ resultOverrides: { agent: "other-agent" } }), "result-agent"],
    ];
    for (const [event, reason] of cases) {
      const observation = observeNativeInstanceResult(expected, event);
      expectUnavailable(observation, reason);
      expect(observation.association).toEqual(expected);
    }

    const missingContent = taskEvent();
    delete missingContent.content;
    expectUnavailable(observeNativeInstanceResult(expected, missingContent), "event-content-missing");

    const missingDetails = taskEvent();
    delete missingDetails.details;
    expectUnavailable(observeNativeInstanceResult(expected, missingDetails), "details-missing");

    const missingResults = taskEvent({ details: {} });
    expectUnavailable(observeNativeInstanceResult(expected, missingResults), "results-missing");
  });

  test("supports a call-only failure when no child was bound, but never a completed link", () => {
    const unbound = association({ childId: null, childSessionId: null });
    const noResultsEvent = taskEvent({ results: [], isError: true });

    const callOnlyFailure = observeNativeInstanceResult(unbound, noResultsEvent);
    expect(callOnlyFailure.state).toBe("observed");
    expect(callOnlyFailure.reason).toBe("observed-call-only");
    expect(callOnlyFailure.link).toBe("call-only");
    expect(callOnlyFailure.outcome).toBe("failed-envelope");
    expect(callOnlyFailure.confirmedChildAbort).toBe(false);
    expect(callOnlyFailure.native).toMatchObject({ isError: true, exitCode: null });
    expect(callOnlyFailure.envelope.complete).toBe(true);

    const unboundSuccess = observeNativeInstanceResult(
      unbound,
      taskEvent({ results: [], isError: false }),
    );
    expectUnavailable(unboundSuccess, "child-unbound");
  });

  test("does not complete an instance link without a proven child session", () => {
    const callOnlyExpected = association({ childSessionId: null });
    const success = observeNativeInstanceResult(callOnlyExpected, taskEvent());
    expect(success.state).toBe("observed");
    expect(success.link).toBe("call-only");
    expect(success.outcome).toBe("unknown");
    expect(success.confirmedChildAbort).toBe(false);
    expect(success.output?.sha256).toBe(hash("done"));
    expect(success.native?.exitCode).toBe(0);

    const abort = observeNativeInstanceResult(callOnlyExpected, taskEvent({
      resultOverrides: { exitCode: 1, aborted: true, output: "", abortReason: "Interrupted by user" },
    }));
    expect(abort.link).toBe("call-only");
    expect(abort.outcome).toBe("aborted-envelope");
    expect(abort.confirmedChildAbort).toBe(false);
  });

  test("does not coerce missing or mistyped outcome fields into completed", () => {
    const expected = association();
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ resultOverrides: { exitCode: "0" } }, { exitCode: null }],
      [{ resultOverrides: { aborted: undefined } }, { aborted: null }],
      [{ resultOverrides: { truncated: undefined } }, { truncated: null }],
      [{ resultOverrides: { output: 42 } }, {}],
      [{ resultOverrides: { error: null } }, { errorPresent: false }],
      [{ resultOverrides: { aborted: null } }, { aborted: null }],
      [{ isError: "false" }, { isError: null }],
    ];
    for (const [overrides, nativeMatch] of cases) {
      const event = taskEvent(overrides as EventOptions);
      const observation = observeNativeInstanceResult(expected, event);
      expect(observation.state).toBe("observed");
      expect(observation.outcome).toBe("unknown");
      expect(observation.link).toBe("instance");
      expect(observation.native).toMatchObject(nativeMatch);
    }
  });

  test("makes canonical duplicates idempotent across key order and undefined optional fields", () => {
    const firstEvent: Record<string, unknown> = {
      isError: false,
      details: {
        results: [{
          output: "done",
          outputPath: undefined,
          truncated: false,
          error: undefined,
          aborted: false,
          exitCode: 0,
          agent: "d2-same",
          id: "ChildA",
          index: 0,
        }],
        projectAgentsDir: "/workspace/.omp/agents",
      },
      content: NORMAL_CONTENT,
      toolCallId: "call-a",
      toolName: "task",
    };
    const secondEvent: Record<string, unknown> = {
      toolName: "task",
      toolCallId: "call-a",
      content: NORMAL_CONTENT,
      details: {
        projectAgentsDir: "/workspace/.omp/agents",
        results: [{
          index: 0,
          id: "ChildA",
          agent: "d2-same",
          exitCode: 0,
          aborted: false,
          truncated: false,
          output: "done",
        }],
      },
      isError: false,
    };

    const first = observeNativeInstanceResult(association(), firstEvent);
    expect(first.state).toBe("observed");
    expectEnvelopeComplete(first, secondEvent);
    const duplicate = observeNativeInstanceResult(association(), secondEvent, first);
    expect(duplicate).toBe(first);
  });
});

describe("observeNativeInstanceResult sticky duplicates and conflicts", () => {
  test("retains the first owned observation on output digest conflict", () => {
    const expected = association();
    const firstEvent = taskEvent();
    const first = observeNativeInstanceResult(expected, firstEvent);
    const changedEvent = taskEvent({ resultOverrides: { output: "changed" } });
    const changedCanonical = canonical({
      content: changedEvent.content,
      details: changedEvent.details,
      isError: changedEvent.isError,
    });

    const conflicted = observeNativeInstanceResult(expected, changedEvent, first);

    expect(conflicted.state).toBe("conflicted");
    expect(conflicted.reason).toBe("observation-conflict");
    expect(conflicted.association).toEqual(first.association);
    expect(conflicted.link).toBe(first.link);
    expect(conflicted.outcome).toBe(first.outcome);
    expect(conflicted.envelope).toBe(first.envelope);
    expect(conflicted.output).toBe(first.output);
    expect(conflicted.native).toBe(first.native);
    expect(conflicted.confirmedChildAbort).toBe(false);
    expect(conflicted.conflict).toEqual({
      reason: "envelope-digest-mismatch",
      firstEnvelopeSha256: first.envelope.sha256,
      lastEnvelopeSha256: hash(changedCanonical),
      firstAssociationSha256: hash(canonical(expected)),
      lastAssociationSha256: hash(canonical(expected)),
      lastObservationReason: "observed-envelope",
    });
    expect(Object.isFrozen(conflicted.conflict)).toBe(true);

    expect(observeNativeInstanceResult(expected, changedEvent, conflicted)).toBe(conflicted);
    expect(observeNativeInstanceResult(expected, firstEvent, conflicted)).toBe(conflicted);
  });

  test("keeps unavailable observations monotonic", () => {
    const expected = association();
    const unavailable = observeNativeInstanceResult(expected, taskEvent({ callId: "wrong-call" }));
    expectUnavailable(unavailable, "event-call-mismatch");

    const laterSuccess = observeNativeInstanceResult(expected, taskEvent(), unavailable);
    expect(laterSuccess).toBe(unavailable);
    expect(laterSuccess.state).toBe("unavailable");
    expect(laterSuccess.link).toBe("unavailable");
    expect(laterSuccess.envelope.complete).toBe(false);
  });

  test("turns an id conflict after a valid observation into a sticky conflict", () => {
    const expected = association();
    const first = observeNativeInstanceResult(expected, taskEvent());
    const idConflict = observeNativeInstanceResult(
      expected,
      taskEvent({ resultOverrides: { id: "OtherChild" } }),
      first,
    );

    expect(idConflict.state).toBe("conflicted");
    expect(idConflict.outcome).toBe("completed-envelope");
    expect(idConflict.envelope).toBe(first.envelope);
    expect(idConflict.conflict?.reason).toBe("unavailable-observation");
    expect(idConflict.conflict?.firstEnvelopeSha256).toBe(first.envelope.sha256);
    expect(idConflict.conflict?.lastEnvelopeSha256).toBeNull();
    expect(idConflict.conflict?.lastObservationReason).toBe("result-id");
  });

  test("turns an association change with the same envelope into a conflict", () => {
    const first = observeNativeInstanceResult(association(), taskEvent());
    const changedAssociation = association({ instanceId: "instance-a2" });

    const conflicted = observeNativeInstanceResult(changedAssociation, taskEvent(), first);

    expect(conflicted.state).toBe("conflicted");
    expect(conflicted.association).toEqual(association());
    expect(conflicted.conflict?.reason).toBe("association-mismatch");
    expect(conflicted.conflict?.lastEnvelopeSha256).toBe(first.envelope.sha256);
    expect(conflicted.conflict?.firstAssociationSha256).toBe(hash(canonical(association())));
    expect(conflicted.conflict?.lastAssociationSha256).toBe(hash(canonical(changedAssociation)));
  });

  test("preserves a first aborted observation when a later success arrives", () => {
    const expected = association();
    const abortEvent = taskEvent({
      resultOverrides: { exitCode: 1, aborted: true, output: "", abortReason: "Interrupted by user" },
    });
    const aborted = observeNativeInstanceResult(expected, abortEvent);
    expect(aborted.outcome).toBe("aborted-envelope");
    expect(aborted.confirmedChildAbort).toBe(true);

    const successEvent = taskEvent();
    const conflicted = observeNativeInstanceResult(expected, successEvent, aborted);

    expect(conflicted.state).toBe("conflicted");
    expect(conflicted.outcome).toBe("aborted-envelope");
    expect(conflicted.confirmedChildAbort).toBe(true);
    expect(conflicted.envelope).toBe(aborted.envelope);
    expect(conflicted.output).toBe(aborted.output);
    expect(conflicted.conflict?.reason).toBe("envelope-digest-mismatch");

    expect(observeNativeInstanceResult(expected, successEvent, conflicted)).toBe(conflicted);
  });
});

describe("observeNativeInstanceResult snapshot, bounds, and safety", () => {
  test("does not retain event or expected references after the call", () => {
    const mutableAssociation = {
      instanceId: "instance-a",
      parentToolCallId: "call-a",
      index: 0 as const,
      childId: "ChildA",
      childSessionId: "session-child-a",
      agentName: "d2-same",
      parentSessionId: "parent-session",
      workspaceRoot: "/workspace",
      rootEpoch: 1,
      definitionVersion: "1",
    };
    const event = taskEvent({
      resultOverrides: { output: "original", outputPath: "/workspace/tmp/ChildA.md" },
    });
    const observation = observeNativeInstanceResult(mutableAssociation, event);
    const originalEnvelope = observation.envelope.sha256;
    const originalOutput = observation.output?.sha256;
    const originalNativePath = observation.native?.outputPath;

    mutableAssociation.instanceId = "mutated-instance";
    mutableAssociation.childId = "MutatedChild";
    (event.content as Array<{ text: string }>)[0]!.text = "mutated content";
    (event.details as { results: Array<Record<string, unknown>> }).results[0]!.output = "mutated output";
    (event.details as { results: Array<Record<string, unknown>> }).results[0]!.outputPath = "/mutated";
    event.isError = true;

    expect(observation.association?.instanceId).toBe("instance-a");
    expect(observation.association?.childId).toBe("ChildA");
    expect(observation.envelope.sha256).toBe(originalEnvelope);
    expect(observation.output?.sha256).toBe(originalOutput);
    expect(observation.output?.excerpt).toBe("original");
    expect(observation.native?.outputPath).toBe(originalNativePath);
  });

  test("never invokes own accessors on the event, result, or expected association", () => {
    const expected = association();
    let contentGetterCalls = 0;
    const contentGetterEvent = taskEvent();
    Object.defineProperty(contentGetterEvent, "content", {
      enumerable: true,
      configurable: true,
      get() {
        contentGetterCalls += 1;
        return NORMAL_CONTENT;
      },
    });
    expectUnavailable(observeNativeInstanceResult(expected, contentGetterEvent), "event-accessor");
    expect(contentGetterCalls).toBe(0);

    let outputGetterCalls = 0;
    const getterResult = result();
    Object.defineProperty(getterResult, "output", {
      enumerable: true,
      configurable: true,
      get() {
        outputGetterCalls += 1;
        return "getter output";
      },
    });
    const outputGetterEvent = taskEvent({ results: [getterResult] });
    expectUnavailable(observeNativeInstanceResult(expected, outputGetterEvent), "event-accessor");
    expect(outputGetterCalls).toBe(0);

    let resultElementGetterCalls = 0;
    const getterResults: unknown[] = [];
    Object.defineProperty(getterResults, "0", {
      enumerable: true,
      configurable: true,
      get() {
        resultElementGetterCalls += 1;
        return result();
      },
    });
    const resultElementEvent = taskEvent({ results: getterResults });
    expectUnavailable(observeNativeInstanceResult(expected, resultElementEvent), "event-accessor");
    expect(resultElementGetterCalls).toBe(0);

    let contentTextGetterCalls = 0;
    const getterBlock = { type: "text" };
    Object.defineProperty(getterBlock, "text", {
      enumerable: true,
      configurable: true,
      get() {
        contentTextGetterCalls += 1;
        return "getter text";
      },
    });
    const contentTextEvent = taskEvent({ content: [getterBlock] });
    expectUnavailable(observeNativeInstanceResult(expected, contentTextEvent), "event-accessor");
    expect(contentTextGetterCalls).toBe(0);

    let nestedGetterCalls = 0;
    const nestedGetterEvent = taskEvent();
    const details = nestedGetterEvent.details as Record<string, unknown>;
    Object.defineProperty(details, "extra", {
      enumerable: true,
      configurable: true,
      get() {
        nestedGetterCalls += 1;
        return "getter value";
      },
    });
    const nestedObservation = observeNativeInstanceResult(expected, nestedGetterEvent);
    expectUnavailable(nestedObservation, "encoding-accessor");
    expect(nestedGetterCalls).toBe(0);
    expect(nestedObservation.output).toBeNull();
    expect(nestedObservation.native).toMatchObject({
      isError: false,
      exitCode: 0,
      aborted: false,
      truncated: false,
      errorPresent: false,
      error: null,
      abortReason: null,
      outputPath: null,
    });
  });

  test("returns bounded unavailable observations for revoked proxies", () => {
    const expected = association();
    const revokedEvent = Proxy.revocable({}, {});
    revokedEvent.revoke();
    const eventObservation = observeNativeInstanceResult(expected, revokedEvent.proxy);
    expectUnavailable(eventObservation, "event-unreadable");
    expect(eventObservation.association).toEqual(expected);

    const revokedExpected = Proxy.revocable({}, {});
    revokedExpected.revoke();
    const expectedObservation = observeNativeInstanceResult(
      revokedExpected.proxy as unknown as NativeInstanceResultAssociation,
      taskEvent(),
    );
    expectUnavailable(expectedObservation, "expected-association-unreadable");
    expect(expectedObservation.association).toBeNull();
  });

  test("requires native text content arrays and keeps invalid content out of completed", () => {
    const expected = association();
    const emptyContent = observeNativeInstanceResult(
      expected,
      taskEvent({ content: [] }),
    );
    expect(emptyContent.state).toBe("observed");
    expect(emptyContent.outcome).toBe("completed-envelope");

    const invalidContents: Array<[unknown, NativeInstanceResultObservation["reason"]]> = [
      [null, "event-content-invalid"],
      [12, "event-content-invalid"],
      ["text", "event-content-invalid"],
      [{ foo: true }, "event-content-invalid"],
      [[42], "event-content-invalid"],
      [[{ type: "text" }], "event-content-invalid"],
      [[{ type: "text", text: 1 }], "event-content-invalid"],
      [[{ type: "image" }], "event-content-unsupported"],
    ];
    for (const [content, reason] of invalidContents) {
      expectUnavailable(
        observeNativeInstanceResult(expected, taskEvent({ content })),
        reason,
      );
    }

    const sparseContent: unknown[] = [];
    sparseContent.length = 1;
    expectUnavailable(
      observeNativeInstanceResult(expected, taskEvent({ content: sparseContent })),
      "event-content-invalid",
    );

    const oversizedContent = Array.from(
      { length: MAX_ENVELOPE_NODES + 1 },
      () => ({ type: "text", text: "" }),
    );
    expectUnavailable(
      observeNativeInstanceResult(expected, taskEvent({ content: oversizedContent })),
      "encoding-node-limit",
    );
  });

  test("rejects cycles, exotic values, undefined array items, and nonfinite numbers", () => {
    function contentWithPayload(payload: unknown): unknown[] {
      return [{ type: "text", text: "valid text", payload }];
    }

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cycleObservation = observeNativeInstanceResult(
      association(),
      taskEvent({ content: contentWithPayload(cyclic) }),
    );
    expectUnavailable(cycleObservation, "encoding-cycle");
    expect(cycleObservation.envelope).toEqual({
      encoding: "canonical-json",
      complete: false,
      bytes: null,
      sha256: null,
    });

    expectUnavailable(
      observeNativeInstanceResult(
        association(),
        taskEvent({ content: contentWithPayload(Number.NaN) }),
      ),
      "encoding-nonfinite",
    );
    expectUnavailable(
      observeNativeInstanceResult(
        association(),
        taskEvent({ content: contentWithPayload(new Date(0)) }),
      ),
      "encoding-unsupported",
    );
    expectUnavailable(
      observeNativeInstanceResult(
        association(),
        taskEvent({ content: contentWithPayload([undefined]) }),
      ),
      "encoding-undefined-array-item",
    );
  });

  test("enforces the exact encoded byte bound without publishing a clipped hash", () => {
    const minimalResult = {
      index: 0,
      id: "ChildA",
      agent: "d2-same",
      exitCode: 0,
      aborted: false,
      truncated: false,
      output: "done",
    };
    const baseEvent = taskEvent({
      content: [{ type: "text", text: "" }],
      results: [minimalResult],
    });
    const baseBytes = Buffer.byteLength(canonical({
      content: baseEvent.content,
      details: baseEvent.details,
      isError: baseEvent.isError,
    }), "utf8");
    const exactLength = MAX_ENVELOPE_BYTES - baseBytes;

    const exactEvent = taskEvent({
      content: [{ type: "text", text: "x".repeat(exactLength) }],
      results: [minimalResult],
    });
    const exact = observeNativeInstanceResult(association(), exactEvent);
    expect(exact.state).toBe("observed");
    expect(exact.envelope).toEqual({
      encoding: "canonical-json",
      complete: true,
      bytes: MAX_ENVELOPE_BYTES,
      sha256: hash(canonical({
        content: exactEvent.content,
        details: exactEvent.details,
        isError: exactEvent.isError,
      })),
    });

    const overEvent = taskEvent({
      content: [{ type: "text", text: "x".repeat(exactLength + 1) }],
      results: [minimalResult],
    });
    const over = observeNativeInstanceResult(association(), overEvent);
    expectUnavailable(over, "encoding-byte-limit");
    expect(over.envelope.bytes).toBeNull();
    expect(over.envelope.sha256).toBeNull();
  });

  test("enforces the exact depth boundary", () => {
    function nested(levels: number): Record<string, unknown> {
      let value: unknown = 0;
      for (let index = 0; index < levels; index += 1) value = { next: value };
      return value as Record<string, unknown>;
    }

    function contentWithNested(levels: number): unknown[] {
      return [{ type: "text", text: "valid text", payload: nested(levels) }];
    }

    const allowed = observeNativeInstanceResult(
      association(),
      taskEvent({ content: contentWithNested(29) }),
    );
    expect(allowed.state).toBe("observed");
    expect(allowed.envelope.complete).toBe(true);

    const rejected = observeNativeInstanceResult(
      association(),
      taskEvent({ content: contentWithNested(30) }),
    );
    expectUnavailable(rejected, "encoding-depth-limit");
  });

  test("enforces the exact node boundary", () => {
    const minimalResult = {
      index: 0,
      id: "ChildA",
      agent: "d2-same",
      exitCode: 0,
      aborted: false,
      truncated: false,
      output: "done",
    };
    function resultWithPadding(length: number): Record<string, unknown> {
      return {
        ...minimalResult,
        padding: Array.from({ length }, (_, index) => index),
      };
    }

    const allowed = observeNativeInstanceResult(
      association(),
      taskEvent({ content: [], results: [resultWithPadding(4082)] }),
    );
    expect(allowed.state).toBe("observed");
    expect(allowed.envelope.complete).toBe(true);

    const rejected = observeNativeInstanceResult(
      association(),
      taskEvent({ content: [], results: [resultWithPadding(4083)] }),
    );
    expectUnavailable(rejected, "encoding-node-limit");
  });

  test("keeps output digest raw and envelope digest canonical for UTF-8 and JSON escaping", () => {
    const output = "line\n\"quote\"\\\u0001 é 😀";
    const event = taskEvent({
      content: [{ type: "text", text: "<task-result id=\"ChildA\">done</task-result>" }, { type: "text", text: "sentinel" }],
      resultOverrides: { output },
    });

    const observation = observeNativeInstanceResult(association(), event);

    expect(observation.state).toBe("observed");
    expectEnvelopeComplete(observation, event);
    expect(observation.output).toEqual({
      bytes: Buffer.byteLength(output, "utf8"),
      sha256: hash(output),
      excerpt: output,
      excerptTruncated: false,
    });
    expect(observation.envelope.sha256).not.toBe(observation.output?.sha256);
  });

  test("bounds excerpts to 1024 UTF-8 bytes without splitting multibyte characters", () => {
    const multibyte = observeNativeInstanceResult(
      association(),
      taskEvent({ resultOverrides: { output: "é".repeat(1000) } }),
    );
    expect(multibyte.output?.bytes).toBe(2000);
    expect(multibyte.output?.sha256).toBe(hash("é".repeat(1000)));
    expect(Buffer.byteLength(multibyte.output!.excerpt, "utf8")).toBe(1024);
    expect(multibyte.output?.excerptTruncated).toBe(true);
    expect(multibyte.output?.excerpt).toBe("é".repeat(512));

    const emoji = observeNativeInstanceResult(
      association(),
      taskEvent({ resultOverrides: { output: "😀".repeat(300) } }),
    );
    expect(emoji.output?.bytes).toBe(1200);
    expect(Buffer.byteLength(emoji.output!.excerpt, "utf8")).toBe(1024);
    expect(emoji.output?.excerptTruncated).toBe(true);
    expect(emoji.output?.excerpt).toBe("😀".repeat(256));

    const exact = observeNativeInstanceResult(
      association(),
      taskEvent({ resultOverrides: { output: "a".repeat(1024) } }),
    );
    expect(exact.output?.excerpt).toBe("a".repeat(1024));
    expect(exact.output?.excerptTruncated).toBe(false);

    const over = observeNativeInstanceResult(
      association(),
      taskEvent({ resultOverrides: { output: "a".repeat(1025) } }),
    );
    expect(over.output?.excerpt).toBe("a".repeat(1024));
    expect(over.output?.excerptTruncated).toBe(true);
  });

  test("bounds error and abortReason text without discarding failure facts", () => {
    const longError = "e".repeat(2048);
    const observation = observeNativeInstanceResult(association(), taskEvent({
      resultOverrides: {
        exitCode: 1,
        aborted: false,
        output: "",
        error: longError,
      },
    }));

    expect(observation.outcome).toBe("failed-envelope");
    expect(observation.native?.errorPresent).toBe(true);
    expect(observation.native?.error).toEqual({
      text: "e".repeat(1024),
      bytes: 2048,
      truncated: true,
    });
  });
});
