import { describe, expect, test } from "bun:test";
import {
  assertIdentityCurrent,
  identityOf,
  parseDeliverableArguments,
  parseTaskBinding,
  sameIdentity,
  type TaskBinding,
} from "../../src/identity.ts";

const bindingValue = {
  schemaVersion: 1,
  taskId: "task-1",
  taskRevision: 3,
  ownerId: "owner-1",
  runId: "run-1",
  attemptId: "attempt-1",
  executionEpoch: 2,
  workspaceRoot: "/tmp/example-workspace",
};

describe("trusted task identity", () => {
  test("parses exactly the six host-bound identity fields plus workspace and schema", () => {
    const binding = parseTaskBinding(bindingValue);
    expect(identityOf(binding)).toEqual({
      taskId: "task-1",
      taskRevision: 3,
      ownerId: "owner-1",
      runId: "run-1",
      attemptId: "attempt-1",
      executionEpoch: 2,
    });
    expect(binding.workspaceRoot).toBe("/tmp/example-workspace");
  });

  test("rejects missing, extra, zero, relative or unsafe binding values", () => {
    expect(() => parseTaskBinding({ ...bindingValue, schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => parseTaskBinding({ ...bindingValue, taskRevision: 0 })).toThrow(/taskRevision/);
    expect(() => parseTaskBinding({ ...bindingValue, executionEpoch: -1 })).toThrow(/executionEpoch/);
    expect(() => parseTaskBinding({ ...bindingValue, workspaceRoot: "relative/path" })).toThrow(/absolute/);
    expect(() => parseTaskBinding({ ...bindingValue, extra: true })).toThrow(/unknown field/);
    const { ownerId: _ownerId, ...missingOwner } = bindingValue;
    expect(() => parseTaskBinding(missingOwner)).toThrow(/missing field/);
  });

  test("model params can never supply identity or operation authority", () => {
    expect(parseDeliverableArguments({ content: "ok\n" }, 100)).toEqual({ content: "ok\n" });
    expect(() => parseDeliverableArguments({ content: "ok", taskId: "attacker" }, 100)).toThrow(/never accepts identity/);
    expect(() => parseDeliverableArguments({ content: "ok", taskRevision: 99 }, 100)).toThrow(/never accepts identity/);
    expect(() => parseDeliverableArguments({ content: "ok", ownerId: "attacker" }, 100)).toThrow(/never accepts identity/);
    expect(() => parseDeliverableArguments({ content: "ok", runId: "attacker" }, 100)).toThrow(/never accepts identity/);
    expect(() => parseDeliverableArguments({ content: "ok", attemptId: "attacker" }, 100)).toThrow(/never accepts identity/);
    expect(() => parseDeliverableArguments({ content: "ok", executionEpoch: 99 }, 100)).toThrow(/never accepts identity/);
    expect(() => parseDeliverableArguments({ content: "ok", operationId: "op" }, 100)).toThrow(/never accepts identity/);
    expect(() => parseDeliverableArguments({ content: "ok", workspaceRoot: "/" }, 100)).toThrow(/never accepts identity/);
    expect(() => parseDeliverableArguments({ text: "ok" }, 100)).toThrow(/content field/);
    expect(() => parseDeliverableArguments({ content: "too long" }, 4)).toThrow(/exceeds/);
  });

  test("a stale revision or epoch cannot be refreshed with model data", () => {
    const binding: TaskBinding = parseTaskBinding(bindingValue);
    const current = identityOf(binding);
    expect(sameIdentity(current, identityOf(binding))).toBe(true);
    assertIdentityCurrent(current, identityOf(binding));
    expect(() => assertIdentityCurrent({ ...current, taskRevision: 4 }, current)).toThrow(/current trusted binding/);
    expect(() => assertIdentityCurrent({ ...current, executionEpoch: 3 }, current)).toThrow(/current trusted binding/);
  });
});
