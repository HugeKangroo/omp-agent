import { afterEach, describe, expect, test } from "bun:test";
import { parseHumanReviewEnv } from "../../src/execution-entry.ts";
import executionEntry from "../../src/execution-entry.ts";

const TOUCHED = [
  "OMP_AGENT_EXECUTION_ROOT",
  "OMP_AGENT_EXECUTION_TIMEOUT_MS",
  "OMP_AGENT_DELIVERY_ROOT",
  "OMP_AGENT_ACCEPTANCE_ROOT",
  "OMP_AGENT_HUMAN_REVIEW",
] as const;

const saved = new Map<string, string | undefined>();

for (const key of TOUCHED) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of TOUCHED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fakePi(): { registrations: string[]; pi: Parameters<typeof executionEntry>[0] } {
  const registrations: string[] = [];
  return {
    registrations,
    pi: {
      registerTool(tool: { name: string }) {
        registrations.push(tool.name);
      },
      on() {},
    } as Parameters<typeof executionEntry>[0],
  };
}

describe("C2-A exact human-review environment wiring", () => {
  test("only absent and the exact empty string mean off", () => {
    expect(parseHumanReviewEnv(undefined)).toBeUndefined();
    expect(parseHumanReviewEnv("")).toBeUndefined();
    expect(parseHumanReviewEnv("local-main-tui-v1")).toEqual({ kind: "local-main-tui", policyVersion: 1 });
  });

  test("every other value, including whitespace-only text, is rejected", () => {
    for (const value of [
      " ",
      "   ",
      "\t",
      "\n",
      "\r\n",
      "true",
      "1",
      "local-main-tui",
      "local-main-tui-v2",
      "LOCAL-MAIN-TUI-V1",
      " local-main-tui-v1",
      "local-main-tui-v1 ",
      "local-main-tui-v1\n",
    ]) {
      expect(() => parseHumanReviewEnv(value)).toThrow(/exactly local-main-tui-v1/);
    }
  });

  test("the extension entry registers nothing for an invalid value", () => {
    process.env.OMP_AGENT_EXECUTION_ROOT = process.cwd();
    delete process.env.OMP_AGENT_EXECUTION_TIMEOUT_MS;
    for (const value of ["yes-please", " ", "\t", "\n"]) {
      process.env.OMP_AGENT_HUMAN_REVIEW = value;
      const { registrations, pi } = fakePi();
      executionEntry(pi);
      expect(registrations).toEqual([]);
    }
  });

  test("the exact opt-in requires delivery and acceptance roots before registration", () => {
    process.env.OMP_AGENT_EXECUTION_ROOT = process.cwd();
    delete process.env.OMP_AGENT_DELIVERY_ROOT;
    delete process.env.OMP_AGENT_ACCEPTANCE_ROOT;
    process.env.OMP_AGENT_HUMAN_REVIEW = "local-main-tui-v1";
    const { registrations, pi } = fakePi();
    executionEntry(pi);
    expect(registrations).toEqual([]);
  });
});
