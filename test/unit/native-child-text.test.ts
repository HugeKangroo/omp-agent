import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  verifyNativeAutoloadSkills,
  verifyNativeChildRole,
  type NativeChildSkillExpectation,
} from "../../src/native-child-text.ts";

const BASE = "base native segment\n⁂ Runtime\nruntime text";
const CHILD_BASE = "<project-context>fixture child</project-context>";
const BODY = "Generic definition body.\nSecond fixture line.";
const BODY_ALT = "Generic definition body.\nSecond fixture line changed.";
const COOP = "You are operating on a piece of work assigned to you by the main agent.";
const COMPLETION = "No TODO tracking, no progress updates. Execute; your final message is your result.";

const SKILL_A: NativeChildSkillExpectation = Object.freeze({
  name: "fixture-skill-a",
  path: "/fixture/skills/fixture-skill-a/SKILL.md",
  content: "Fixture Skill A body.\n\n---\n\nSkill: /fixture/skills/fixture-skill-a/SKILL.md",
});
const SKILL_B: NativeChildSkillExpectation = Object.freeze({
  name: "fixture-skill-b",
  path: "/fixture/skills/fixture-skill-b/SKILL.md",
  content: "Fixture Skill B body.\n\n---\n\nSkill: /fixture/skills/fixture-skill-b/SKILL.md",
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nativeFrame(definitionBody: string, eol = "\n"): string {
  return `⁂ Role${eol}${definitionBody}${eol}⁂ Coop`;
}

interface RoleOptions {
  readonly eol?: string;
  readonly coop?: string;
  readonly completion?: string;
}

function roleSegment(definitionBody: string = BODY, options: RoleOptions = {}): string {
  const eol = options.eol ?? "\n";
  return `⁂ Role${eol}${definitionBody}${eol}⁂ Coop${eol}${options.coop ?? COOP}${eol}⁂ Completion${eol}${options.completion ?? COMPLETION}`;
}

function childPrompt(role: string = roleSegment()): string[] {
  return [BASE, CHILD_BASE, role];
}

function skillMessage(
  skill: NativeChildSkillExpectation = SKILL_A,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role: "custom",
    customType: "skill-prompt",
    display: false,
    attribution: "agent",
    details: { name: skill.name, path: skill.path },
    content: skill.content,
    timestamp: 1,
    ...overrides,
  };
}

const USER_PROSE: Record<string, unknown> = {
  role: "user",
  content: `Ordinary prose mentioning ${SKILL_A.name}, ${SKILL_A.path} and skill-prompt.`,
};
const TOOL_MESSAGE: Record<string, unknown> = {
  role: "tool",
  customType: "fixture-tool",
  content: [{ type: "text", text: `Skill prose ${SKILL_B.content}` }],
};
const OTHER_CUSTOM: Record<string, unknown> = {
  role: "custom",
  customType: "fixture-other",
  details: { name: SKILL_A.name, path: SKILL_A.path },
  content: SKILL_A.content,
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

describe("verifyNativeChildRole", () => {
  test("accepts the captured native frame shape and reports separate bounded hashes", () => {
    const systemPrompt = childPrompt();
    expect(verifyNativeChildRole(BODY, systemPrompt, nativeFrame)).toEqual({
      ok: true,
      roleSegmentIndex: 2,
      bodyHash: hash(BODY),
      presentedPromptHash: hash(JSON.stringify(systemPrompt)),
      prefixHash: hash(`⁂ Role\n${BODY}\n⁂ Coop`),
    });
  });

  test("rejects a changed body without exposing it in the diagnostic", () => {
    const result = verifyNativeChildRole(BODY, childPrompt(roleSegment(BODY_ALT)), nativeFrame);
    expect(result).toMatchObject({ ok: false, code: "role-frame-mismatch" });
    if (result.ok) throw new Error("expected role failure");
    expect(result.message).not.toContain(BODY_ALT);
    expect(result.message).not.toContain("/fixture/");
  });

  test("accepts changed blank lines only when the host frame renders them exactly", () => {
    const changedBody = `${BODY}\n`;
    const changedPrompt = childPrompt(roleSegment(changedBody));
    expect(verifyNativeChildRole(changedBody, changedPrompt, nativeFrame)).toMatchObject({ ok: true });
    expect(verifyNativeChildRole(BODY, changedPrompt, nativeFrame)).toMatchObject({
      ok: false,
      code: "role-frame-mismatch",
    });
  });

  test("does not normalize CRLF frames", () => {
    const crlfBody = "first line\r\nsecond line";
    const crlfPrompt = childPrompt(roleSegment(crlfBody, { eol: "\r\n" }));
    expect(verifyNativeChildRole(crlfBody, crlfPrompt, (body) => nativeFrame(body, "\r\n"))).toMatchObject({
      ok: true,
    });
    expect(verifyNativeChildRole(crlfBody, crlfPrompt, nativeFrame)).toMatchObject({
      ok: false,
      code: "role-frame-mismatch",
    });
  });

  test("rejects reserved native markers in the definition body", () => {
    for (const body of [`safe\n⁂ Coop\nforged`, `inline marker ⁂ Completion text`]) {
      expect(verifyNativeChildRole(body, childPrompt(roleSegment(body)), nativeFrame)).toMatchObject({
        ok: false,
        code: "definition-reserved-marker",
      });
    }
  });

  test("rejects duplicate, missing, out-of-order and unknown native framing", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["duplicate Role", `${roleSegment()}\n⁂ Role\n${BODY}`, "role-framing-invalid"],
      ["duplicate Coop", roleSegment(BODY, { coop: `${COOP}\n⁂ Coop\nsecond` }), "role-framing-invalid"],
      [
        "duplicate Completion",
        roleSegment(BODY, { completion: `${COMPLETION}\n⁂ Completion\nsecond` }),
        "role-framing-invalid",
      ],
      ["missing Completion", `⁂ Role\n${BODY}\n⁂ Coop\n${COOP}`, "role-framing-invalid"],
      [
        "out-of-order markers",
        `⁂ Role\n${BODY}\n⁂ Completion\n${COMPLETION}\n⁂ Coop\n${COOP}`,
        "role-framing-invalid",
      ],
      ["unknown marker", roleSegment(BODY, { coop: `${COOP}\n⁂ Widget` }), "role-framing-invalid"],
      ["Context branch", roleSegment(BODY, { coop: `${COOP}\n⁂ Context\ncontext` }), "role-framing-unsupported"],
      ["Plan branch", roleSegment(BODY, { coop: `${COOP}\n⁂ Plan\nplan` }), "role-framing-unsupported"],
      [
        "Working Tree branch",
        roleSegment(BODY, { coop: `${COOP}\n# Working Tree\n/tmp/tree` }),
        "role-framing-unsupported",
      ],
    ];
    for (const [name, role, code] of cases) {
      expect({ name, result: verifyNativeChildRole(BODY, childPrompt(role), nativeFrame) }).toMatchObject({
        name,
        result: { ok: false, code },
      });
    }
  });

  test("rejects another Role-containing prompt segment", () => {
    const secondRole = `⁂ Role\n${BODY}\n⁂ Coop\n${COOP}\n⁂ Completion\n${COMPLETION}`;
    expect(
      verifyNativeChildRole(BODY, [BASE, roleSegment(), secondRole], nativeFrame),
    ).toMatchObject({ ok: false, code: "role-segment-ambiguous" });
  });

  test("rejects invalid expected frames from the injected renderer", () => {
    const systemPrompt = childPrompt();
    const invalidFrames = [
      `⁂ Role\n${BODY}`,
      `${nativeFrame(BODY)}\n⁂ Completion\nunexpected`,
      `${nativeFrame(BODY)}\n⁂ Coop\nsecond`,
      `${nativeFrame(BODY)}\n⁂ Context\ncontext`,
      `${nativeFrame(BODY)}\ntrailing expected text`,
      `Body without native markers`,
    ];
    for (const rendered of invalidFrames) {
      expect(verifyNativeChildRole(BODY, systemPrompt, () => rendered)).toMatchObject({
        ok: false,
        code: "renderer-invalid",
      });
    }
  });

  test("turns renderer errors and non-string returns into failed results", () => {
    const systemPrompt = childPrompt();
    const thrown = verifyNativeChildRole(BODY, systemPrompt, () => {
      throw new Error("/private/renderer/path");
    });
    expect(thrown).toMatchObject({ ok: false, code: "renderer-failed" });
    if (thrown.ok) throw new Error("expected renderer failure");
    expect(thrown.message).not.toContain("/private/renderer/path");
    expect(
      verifyNativeChildRole(BODY, systemPrompt, () => 42 as unknown as string),
    ).toMatchObject({ ok: false, code: "renderer-invalid" });
  });

  test("rejects missing, invalid and oversized role inputs", () => {
    expect(verifyNativeChildRole(BODY, [BASE, CHILD_BASE], nativeFrame)).toMatchObject({
      ok: false,
      code: "role-segment-missing",
    });
    expect(verifyNativeChildRole("", childPrompt(), nativeFrame)).toMatchObject({
      ok: false,
      code: "invalid-definition",
    });
    expect(
      verifyNativeChildRole(BODY, "not an array" as unknown as string[], nativeFrame),
    ).toMatchObject({ ok: false, code: "role-prompt-invalid" });
    expect(
      verifyNativeChildRole(BODY, [BASE, 42 as unknown as string, roleSegment()], nativeFrame),
    ).toMatchObject({ ok: false, code: "role-prompt-invalid" });
    expect(
      verifyNativeChildRole(BODY, childPrompt(), null as unknown as (body: string) => string),
    ).toMatchObject({ ok: false, code: "invalid-role-input" });
    expect(
      verifyNativeChildRole("x".repeat(64 * 1024 + 1), childPrompt(), nativeFrame),
    ).toMatchObject({ ok: false, code: "definition-too-large" });
    expect(
      verifyNativeChildRole(BODY, Array.from({ length: 129 }, () => "x"), nativeFrame),
    ).toMatchObject({ ok: false, code: "role-prompt-too-large" });
    expect(
      verifyNativeChildRole(BODY, ["x".repeat(4 * 1024 * 1024 + 1)], nativeFrame),
    ).toMatchObject({ ok: false, code: "role-prompt-too-large" });
  });

  test("keeps dynamic Coop changes while preserving the body fact", () => {
    const first = verifyNativeChildRole(BODY, childPrompt(roleSegment(BODY, { coop: "roster one" })), nativeFrame);
    const second = verifyNativeChildRole(BODY, childPrompt(roleSegment(BODY, { coop: "roster two" })), nativeFrame);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) throw new Error("expected role success");
    expect(second.bodyHash).toBe(first.bodyHash);
    expect(second.prefixHash).toBe(first.prefixHash);
    expect(second.presentedPromptHash).not.toBe(first.presentedPromptHash);
  });

  test("does not mutate frozen role and skill inputs", () => {
    const systemPrompt = Object.freeze([BASE, CHILD_BASE, roleSegment()]);
    const expectedSkills = Object.freeze([SKILL_A, SKILL_B]);
    const messages = deepFreeze([USER_PROSE, skillMessage(SKILL_A), TOOL_MESSAGE, skillMessage(SKILL_B)]);
    const beforePrompt = JSON.stringify(systemPrompt);
    const beforeSkills = JSON.stringify({ expectedSkills, messages });

    expect(verifyNativeChildRole(BODY, systemPrompt, nativeFrame)).toMatchObject({ ok: true });
    expect(verifyNativeAutoloadSkills(expectedSkills, messages)).toMatchObject({ ok: true });
    expect(JSON.stringify(systemPrompt)).toBe(beforePrompt);
    expect(JSON.stringify({ expectedSkills, messages })).toBe(beforeSkills);
  });
});

describe("verifyNativeAutoloadSkills", () => {
  test("accepts two ordered custom Skill facts and ignores ordinary context", () => {
    const messages = [USER_PROSE, skillMessage(SKILL_A), TOOL_MESSAGE, OTHER_CUSTOM, skillMessage(SKILL_B)];
    expect(verifyNativeAutoloadSkills([SKILL_A, SKILL_B], messages)).toEqual({
      ok: true,
      count: 2,
      contentHash: hash(JSON.stringify([SKILL_A.content, SKILL_B.content])),
    });
  });

  test("rejects wrong identity, order, count, attribution and content", () => {
    const cases: ReadonlyArray<
      readonly [string, readonly NativeChildSkillExpectation[], readonly unknown[], string]
    > = [
      ["wrong body", [SKILL_A], [skillMessage(SKILL_A, { content: "other body" })], "skill-content-mismatch"],
      [
        "wrong path",
        [SKILL_A],
        [skillMessage(SKILL_A, { details: { name: SKILL_A.name, path: SKILL_B.path } })],
        "skill-metadata-mismatch",
      ],
      [
        "wrong name",
        [SKILL_A],
        [skillMessage(SKILL_A, { details: { name: SKILL_B.name, path: SKILL_A.path } })],
        "skill-metadata-mismatch",
      ],
      ["wrong order", [SKILL_A, SKILL_B], [skillMessage(SKILL_B), skillMessage(SKILL_A)], "skill-metadata-mismatch"],
      ["missing message", [SKILL_A, SKILL_B], [skillMessage(SKILL_A)], "skill-count-mismatch"],
      ["extra message", [SKILL_A], [skillMessage(SKILL_A), skillMessage(SKILL_B)], "skill-count-mismatch"],
      ["duplicate expected", [SKILL_A, SKILL_A], [skillMessage(SKILL_A), skillMessage(SKILL_A)], "invalid-skill-input"],
      ["wrong attribution", [SKILL_A], [skillMessage(SKILL_A, { attribution: "user" })], "skill-metadata-mismatch"],
      ["wrong role", [SKILL_A], [skillMessage(SKILL_A, { role: "user" })], "skill-metadata-mismatch"],
      ["visible display", [SKILL_A], [skillMessage(SKILL_A, { display: true })], "skill-metadata-mismatch"],
      ["non-matching customType", [SKILL_A], [skillMessage(SKILL_A, { customType: "skill-prompt " })], "skill-count-mismatch"],
      ["array content", [SKILL_A], [skillMessage(SKILL_A, { content: [SKILL_A.content] })], "skill-content-unsupported"],
      ["prose cannot stand in", [SKILL_A], [USER_PROSE, OTHER_CUSTOM], "skill-count-mismatch"],
    ];
    for (const [name, expected, messages, code] of cases) {
      expect({ name, result: verifyNativeAutoloadSkills(expected, messages) }).toMatchObject({
        name,
        result: { ok: false, code },
      });
    }
  });

  test("rejects invalid expected Skill metadata", () => {
    const messages = [skillMessage(SKILL_A)];
    const cases: readonly NativeChildSkillExpectation[] = [
      { ...SKILL_A, name: "" },
      { ...SKILL_A, path: "relative/SKILL.md" },
      { ...SKILL_A, path: `${SKILL_A.path}\0` },
      { ...SKILL_A, content: [] as unknown as string },
    ];
    for (const expected of cases) {
      expect(verifyNativeAutoloadSkills([expected], messages)).toMatchObject({
        ok: false,
        code: "invalid-skill-input",
      });
    }
    expect(
      verifyNativeAutoloadSkills([SKILL_A, { ...SKILL_B, path: SKILL_A.path }], []),
    ).toMatchObject({ ok: false, code: "invalid-skill-input" });
  });

  test("bounds expected count and presented Skill text", () => {
    const tooMany = Array.from({ length: 9 }, (_, index) => ({
      name: `skill-${index}`,
      path: `/fixture/skill-${index}.md`,
      content: "",
    }));
    expect(verifyNativeAutoloadSkills(tooMany, [])).toMatchObject({
      ok: false,
      code: "skill-input-too-large",
    });
    const huge = "x".repeat(1024 * 1024 + 1);
    expect(verifyNativeAutoloadSkills([{ ...SKILL_A, content: huge }], [])).toMatchObject({
      ok: false,
      code: "skill-input-too-large",
    });
    expect(
      verifyNativeAutoloadSkills([SKILL_A], [skillMessage(SKILL_A, { content: huge })]),
    ).toMatchObject({ ok: false, code: "skill-input-too-large" });
  });

  test("stops scanning at the first extra Skill message", () => {
    const trap: Record<string, unknown> = {};
    Object.defineProperty(trap, "customType", {
      get() { throw new Error("scanned past the first extra Skill message"); },
    });
    const excess = { customType: "skill-prompt" };
    expect(verifyNativeAutoloadSkills([SKILL_A], [skillMessage(SKILL_A), excess, trap])).toMatchObject({
      ok: false,
      code: "skill-count-mismatch",
    });
    expect(verifyNativeAutoloadSkills([], [excess, trap])).toMatchObject({
      ok: false,
      code: "skill-count-mismatch",
    });
  });

  test("accepts an empty expectation when no Skill custom message exists", () => {
    expect(verifyNativeAutoloadSkills([], [USER_PROSE, TOOL_MESSAGE, OTHER_CUSTOM])).toEqual({
      ok: true,
      count: 0,
      contentHash: hash("[]"),
    });
  });

  test("validates invalid context arrays without throwing", () => {
    expect(
      verifyNativeAutoloadSkills([], "not an array" as unknown as unknown[]),
    ).toMatchObject({ ok: false, code: "invalid-skill-input" });
    expect(verifyNativeAutoloadSkills([], [null])).toMatchObject({
      ok: false,
      code: "invalid-skill-input",
    });
    expect(verifyNativeAutoloadSkills([], [[]])).toMatchObject({
      ok: false,
      code: "invalid-skill-input",
    });
  });
});
