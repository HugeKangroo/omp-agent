import { Buffer } from "node:buffer";
import path from "node:path";
import { sha256Hex } from "./native-work.ts";

/**
 * Pure text checks for a supported native child profile.
 *
 * These functions do no file IO, host calls, prompt mutation or authorization.
 * A false result is a refusal fact only: the caller must gate native execution
 * on it. Hashes describe the bounded bytes observed at this call; they are not
 * definition versions, provenance or cryptographic authority.
 *
 * Role scope: one host-rendered minimal Role/Coop frame matched byte-for-byte,
 * not full policy integrity or arbitrary future templates; base segments and
 * dynamic Coop text are preserved, not interpreted. Skill scope: exact custom
 * Skill messages in supplied context; earlier extension mutations are not cryptographically excluded.
 */

const ROLE_MARKER = "⁂ Role";
const COOP_MARKER = "⁂ Coop";
const COMPLETION_MARKER = "⁂ Completion";
const CONTEXT_MARKER = "⁂ Context";
const PLAN_MARKER = "⁂ Plan";
const WORKTREE_MARKER = "# Working Tree";
const RESERVED_MARKER = "⁂ ";

const MAX_ROLE_SEGMENTS = 128;
const MAX_ROLE_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_DEFINITION_BYTES = 64 * 1024;
const MAX_SKILLS = 8;
const MAX_SKILL_TEXT_BYTES = 1024 * 1024;
const MAX_SKILL_NAME_CHARS = 1024;
const MAX_SKILL_PATH_CHARS = 4096;

type NativeMarkerKind = "role" | "coop" | "completion";

interface ScannedMarker {
  readonly kind: NativeMarkerKind; readonly lineStart: number; readonly lineEnd: number;
}

interface FrameScan {
  readonly markers: readonly ScannedMarker[];
  readonly unknownStarts: readonly number[];
  readonly unsupportedSectionStarts: readonly number[];
  readonly worktreeStarts: readonly number[];
}

export type NativeChildTextFailureCode =
  | "invalid-role-input"
  | "invalid-definition"
  | "definition-reserved-marker"
  | "definition-too-large"
  | "role-prompt-invalid"
  | "role-prompt-too-large"
  | "role-segment-missing"
  | "role-segment-ambiguous"
  | "role-framing-invalid"
  | "role-framing-unsupported"
  | "role-frame-mismatch"
  | "renderer-failed"
  | "renderer-invalid"
  | "invalid-skill-input"
  | "skill-input-too-large"
  | "skill-count-mismatch"
  | "skill-metadata-mismatch"
  | "skill-content-unsupported"
  | "skill-content-mismatch";

export interface NativeChildTextFailure {
  readonly ok: false; readonly code: NativeChildTextFailureCode; readonly message: string;
}

export interface NativeChildRoleFacts {
  readonly roleSegmentIndex: number;
  /** Exact selected definition-body bytes, not a source or version identity. */
  readonly bodyHash: string;
  /** Exact ordered native systemPrompt array serialized as JSON. */
  readonly presentedPromptHash: string;
  /** Exact actual prefix matched against the host-rendered frame. */
  readonly prefixHash: string;
}

export type NativeChildRoleResult = ({ readonly ok: true } & NativeChildRoleFacts) | NativeChildTextFailure;

export interface NativeChildSkillExpectation {
  readonly name: string; readonly path: string; readonly content: string;
}

export interface NativeChildSkillFacts {
  readonly count: number; readonly contentHash: string;
}

export type NativeChildSkillResult = ({ readonly ok: true } & NativeChildSkillFacts) | NativeChildTextFailure;

function fail(code: NativeChildTextFailureCode, message: string): NativeChildTextFailure { return { ok: false, code, message }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }

function markerKindAt(text: string, lineStart: number, lineEnd: number): NativeMarkerKind | "unknown" | undefined {
  const length = lineEnd - lineStart;
  if (length === ROLE_MARKER.length && text.startsWith(ROLE_MARKER, lineStart)) return "role";
  if (length === COOP_MARKER.length && text.startsWith(COOP_MARKER, lineStart)) return "coop";
  if (length === COMPLETION_MARKER.length && text.startsWith(COMPLETION_MARKER, lineStart)) return "completion";
  if (text.startsWith(RESERVED_MARKER, lineStart)) return "unknown";
  return undefined;
}

function isUnsupportedSectionAt(text: string, lineStart: number, lineEnd: number): boolean {
  const length = lineEnd - lineStart;
  return (length === CONTEXT_MARKER.length && text.startsWith(CONTEXT_MARKER, lineStart))
    || (length === PLAN_MARKER.length && text.startsWith(PLAN_MARKER, lineStart));
}

function scanFrame(text: string): FrameScan {
  const markers: ScannedMarker[] = [];
  const unknownStarts: number[] = [];
  const unsupportedSectionStarts: number[] = [];
  const worktreeStarts: number[] = [];
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const rawEnd = newline === -1 ? text.length : newline;
    const lineEnd = rawEnd > lineStart && text.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
    const kind = markerKindAt(text, lineStart, lineEnd);
    if (kind === "role" || kind === "coop" || kind === "completion") {
      markers.push({ kind, lineStart, lineEnd });
    } else if (kind === "unknown") {
      if (isUnsupportedSectionAt(text, lineStart, lineEnd)) unsupportedSectionStarts.push(lineStart);
      else unknownStarts.push(lineStart);
    }
    if (lineEnd - lineStart === WORKTREE_MARKER.length && text.startsWith(WORKTREE_MARKER, lineStart)) worktreeStarts.push(lineStart);
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  return { markers, unknownStarts, unsupportedSectionStarts, worktreeStarts };
}

function actualFrame(scan: FrameScan): NativeChildTextFailure | undefined {
  if (scan.unsupportedSectionStarts.length > 0) {
    return fail("role-framing-unsupported",
      "The native Role segment contains an unsupported Context or Plan section.");
  }
  if (scan.unknownStarts.length > 0) {
    return fail("role-framing-invalid", "The native Role segment contains an unknown native section marker.");
  }

  const roles = scan.markers.filter((marker) => marker.kind === "role");
  const coops = scan.markers.filter((marker) => marker.kind === "coop");
  const completions = scan.markers.filter((marker) => marker.kind === "completion");
  if (roles.length !== 1 || coops.length !== 1 || completions.length !== 1) {
    return fail("role-framing-invalid",
      "The native Role segment must contain exactly one Role, Coop and Completion marker.");
  }

  const role = roles[0]!;
  const coop = coops[0]!;
  const completion = completions[0]!;
  if (role.lineStart !== 0) return fail("role-framing-invalid", "The native Role segment must begin with the Role marker.");
  if (!(role.lineEnd < coop.lineStart && coop.lineEnd < completion.lineStart)) {
    return fail("role-framing-invalid", "Native Role, Coop and Completion markers are out of order.");
  }
  if (scan.worktreeStarts.some((start) => start > coop.lineEnd && start < completion.lineStart)) {
    return fail("role-framing-unsupported",
      "The initial supported profile does not accept the native Working Tree branch.");
  }
  return undefined;
}

/**
 * Verifies that one actual native Role segment presents exactly the frame
 * produced by the host renderer for `definitionBody`. The dynamic Coop roster
 * and every other prompt segment are left untouched. No trim, dedent, body
 * search or whitespace normalization is performed.
 */
export function verifyNativeChildRole(
  definitionBody: string,
  systemPrompt: readonly string[],
  renderRoleFrame: (body: string) => string,
): NativeChildRoleResult {
  if (typeof renderRoleFrame !== "function") return fail("invalid-role-input", "A native Role frame renderer function is required.");
  if (typeof definitionBody !== "string") return fail("invalid-definition", "The native definition body must be a string.");
  if (definitionBody.length === 0) return fail("invalid-definition", "The native definition body must not be empty.");
  if (byteLength(definitionBody) > MAX_DEFINITION_BYTES) return fail("definition-too-large", "The native definition body exceeds its bounded size.");
  if (definitionBody.includes(RESERVED_MARKER)) {
    return fail("definition-reserved-marker", "The native definition body contains a reserved native section marker.");
  }
  if (!Array.isArray(systemPrompt)) return fail("role-prompt-invalid", "The native system prompt must be an array of string segments.");
  if (systemPrompt.length > MAX_ROLE_SEGMENTS) return fail("role-prompt-too-large", "The native system prompt has too many segments.");

  let totalBytes = 0;
  let roleSegmentIndex = -1;
  let roleScan: FrameScan | undefined;
  for (let index = 0; index < systemPrompt.length; index += 1) {
    const segment: unknown = systemPrompt[index];
    if (typeof segment !== "string") return fail("role-prompt-invalid", "Every native system prompt segment must be a string.");
    totalBytes += byteLength(segment);
    if (totalBytes > MAX_ROLE_PROMPT_BYTES) return fail("role-prompt-too-large", "The native system prompt exceeds its bounded total size.");
    const scan = scanFrame(segment);
    if (!scan.markers.some((marker) => marker.kind === "role")) continue;
    if (roleSegmentIndex !== -1) {
      return fail("role-segment-ambiguous", "More than one native system prompt segment contains a Role marker.");
    }
    roleSegmentIndex = index;
    roleScan = scan;
  }

  if (roleSegmentIndex === -1 || roleScan === undefined) return fail("role-segment-missing", "No native system prompt segment contains a Role marker.");
  const framingFailure = actualFrame(roleScan);
  if (framingFailure !== undefined) return framingFailure;

  let rendered: unknown;
  try {
    rendered = renderRoleFrame(definitionBody);
  } catch {
    return fail("renderer-failed", "The native Role frame renderer failed.");
  }
  if (typeof rendered !== "string") return fail("renderer-invalid", "The native Role frame renderer did not return a string.");
  if (byteLength(rendered) > MAX_ROLE_PROMPT_BYTES) return fail("renderer-invalid", "The native Role frame renderer returned an oversized frame.");

  const expected = scanFrame(rendered);
  if (expected.unknownStarts.length > 0 || expected.unsupportedSectionStarts.length > 0) {
    return fail("renderer-invalid", "The rendered native Role frame contains an unsupported section marker.");
  }
  const expectedRoles = expected.markers.filter((marker) => marker.kind === "role");
  const expectedCoops = expected.markers.filter((marker) => marker.kind === "coop");
  const expectedCompletions = expected.markers.filter((marker) => marker.kind === "completion");
  if (expectedRoles.length !== 1 || expectedCoops.length !== 1 || expectedCompletions.length !== 0) {
    return fail("renderer-invalid",
      "The rendered native Role frame must contain exactly one Role and one Coop marker, and no Completion marker.");
  }
  if (expectedRoles[0]!.lineStart !== 0 || !(expectedRoles[0]!.lineEnd < expectedCoops[0]!.lineStart)) {
    return fail("renderer-invalid", "The rendered native Role frame has an invalid Role/Coop shape.");
  }
  const expectedAfterCoop = rendered.length - expectedCoops[0]!.lineEnd;
  if (expectedAfterCoop !== 0 && !(expectedAfterCoop === 1 && rendered.endsWith("\n"))
    && !(expectedAfterCoop === 2 && rendered.endsWith("\r\n"))) {
    return fail("renderer-invalid", "The rendered native Role frame must end at the Coop marker.");
  }

  const actualRoleSegment: string = systemPrompt[roleSegmentIndex]!;
  if (!actualRoleSegment.startsWith(rendered)) {
    return fail("role-frame-mismatch", "The actual native Role prefix does not equal the host-rendered expected frame.");
  }

  return {
    ok: true,
    roleSegmentIndex,
    bodyHash: sha256Hex(definitionBody),
    presentedPromptHash: sha256Hex(JSON.stringify(systemPrompt)),
    prefixHash: sha256Hex(rendered),
  };
}

/**
 * Verifies the exact custom Skill messages visible in a supplied native context
 * array. Only messages with customType `skill-prompt` participate; ordinary
 * user, tool and other custom messages are ignored. No Skill lookup or reload
 * occurs here.
 */
export function verifyNativeAutoloadSkills(
  expected: readonly NativeChildSkillExpectation[],
  contextMessages: readonly unknown[],
): NativeChildSkillResult {
  if (!Array.isArray(expected)) return fail("invalid-skill-input", "Expected autoload Skills must be an array.");
  if (expected.length > MAX_SKILLS) return fail("skill-input-too-large", "The expected autoload Skill count exceeds its bound.");

  const validated: NativeChildSkillExpectation[] = [];
  const names = new Set<string>();
  const paths = new Set<string>();
  let expectedBytes = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const entry: unknown = expected[index];
    if (!isRecord(entry)) return fail("invalid-skill-input", "Each expected autoload Skill must be an object.");
    const { name, path: skillPath, content } = entry;
    if (
      typeof name !== "string"
      || name.length === 0
      || name.length > MAX_SKILL_NAME_CHARS
      || typeof skillPath !== "string"
      || skillPath.length === 0
      || skillPath.length > MAX_SKILL_PATH_CHARS
      || skillPath.includes("\0")
      || !path.isAbsolute(skillPath)
      || typeof content !== "string"
    ) {
      return fail("invalid-skill-input",
        "Expected autoload Skills require a non-empty name, an absolute path and string content.");
    }
    if (names.has(name) || paths.has(skillPath)) {
      return fail("invalid-skill-input", "Expected autoload Skill names and paths must be unique.");
    }
    expectedBytes += byteLength(content);
    if (expectedBytes > MAX_SKILL_TEXT_BYTES) {
      return fail("skill-input-too-large", "Expected autoload Skill text exceeds its bounded total size.");
    }
    names.add(name);
    paths.add(skillPath);
    validated.push({ name, path: skillPath, content });
  }

  if (!Array.isArray(contextMessages)) return fail("invalid-skill-input", "Native context messages must be an array.");
  const matched: Record<string, unknown>[] = [];
  for (const message of contextMessages) {
    if (!isRecord(message)) return fail("invalid-skill-input", "Every native context message must be an object.");
    if (message.customType !== "skill-prompt") continue;
    if (matched.length === validated.length) {
      return fail("skill-count-mismatch", "The native Skill prompt message count does not match the expected autoload Skill count.");
    }
    matched.push(message);
  }
  if (matched.length !== validated.length) {
    return fail("skill-count-mismatch", "The native Skill prompt message count does not match the expected autoload Skill count.");
  }

  const presentedContents: string[] = [];
  let actualBytes = 0;
  for (let index = 0; index < validated.length; index += 1) {
    const expectedSkill = validated[index]!;
    const message = matched[index]!;
    const details = message.details;
    if (
      message.role !== "custom"
      || message.attribution !== "agent"
      || message.display !== false
      || !isRecord(details)
      || details.name !== expectedSkill.name
      || details.path !== expectedSkill.path
    ) {
      return fail("skill-metadata-mismatch",
        "A native Skill prompt message does not carry the expected custom Skill metadata.");
    }
    const content = message.content;
    if (typeof content !== "string") {
      return fail("skill-content-unsupported",
        "Native Skill prompt content must be a string; structured content is unsupported.");
    }
    actualBytes += byteLength(content);
    if (actualBytes > MAX_SKILL_TEXT_BYTES) {
      return fail("skill-input-too-large", "Presented native Skill text exceeds its bounded total size.");
    }
    if (content !== expectedSkill.content) {
      return fail("skill-content-mismatch", "A native Skill prompt message body does not match the expected Skill body.");
    }
    presentedContents.push(content);
  }

  return {
    ok: true,
    count: presentedContents.length,
    contentHash: sha256Hex(JSON.stringify(presentedContents)),
  };
}
