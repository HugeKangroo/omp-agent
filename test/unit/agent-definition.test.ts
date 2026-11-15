import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFINITION_FREEZE_SCOPE,
  DEFINITION_ORIGIN,
  DEFINITION_SNAPSHOT_SCHEMA,
  DefinitionError,
  loadDefinitionSnapshot,
  MAX_DEFINITION_BYTES,
  MAX_INITIAL_TEXT_BYTES,
  MAX_SKILL_BYTES,
  type DefinitionModelRef,
  type DefinitionSkillMetadata,
  type LoadDefinitionSnapshotOptions,
  type NativeParsedAgent,
  type ResolveModelPort,
} from "../../src/agent-definition.ts";
import { nodeFileIo, type NativeFileIo } from "../../src/native-work.ts";

const temporaryDirs: string[] = [];

afterEach(async () => {
  for (const dir of temporaryDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface SkillDocument {
  frontmatter: Record<string, unknown>;
  body: string;
  fail?: boolean;
}

interface FakeDefinition {
  frontmatter: Record<string, unknown>;
  body: string;
  parsed?: Partial<NativeParsedAgent>;
  skillDocs?: Map<string, SkillDocument>;
  failFrontmatter?: boolean;
  failAgent?: boolean;
}

interface OptionOverrides {
  availableSkills?: DefinitionSkillMetadata[];
  availableTools?: string[];
  currentModel?: DefinitionModelRef;
  resolveModel?: ResolveModelPort;
  nativeSource?: string;
  fileIo?: NativeFileIo;
}

interface WrittenSkill {
  metadata: DefinitionSkillMetadata;
  filePath: string;
  doc: SkillDocument;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function tempRoot(prefix = "omp-definition-"): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(path.join(base, prefix));
  temporaryDirs.push(dir);
  return dir;
}

async function writeDefinition(root: string, name: string, body: string): Promise<string> {
  const filePath = path.join(root, `${name}.md`);
  await writeFile(
    filePath,
    `---\nname: ${name}\ndescription: Generic definition ${name}\n---\n${body}\n`,
    "utf8",
  );
  return filePath;
}

async function writeSkill(
  root: string,
  name: string,
  options: { description?: string; body?: string; frontmatter?: Record<string, unknown> } = {},
): Promise<WrittenSkill> {
  const directory = path.join(root, "skills", name);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "SKILL.md");
  const body = options.body ?? `Instructions for ${name}.`;
  const description = options.description ?? `Description for ${name}`;
  await writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    "utf8",
  );
  return {
    metadata: { name, filePath, description },
    filePath,
    doc: {
      frontmatter: { name, description, ...options.frontmatter },
      body,
    },
  };
}

function parsedTools(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return value;
}

function parsedModel(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return value;
}

function parsedSkills(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return value;
}

function makeOptions(
  definitionPath: string,
  workspaceRoot: string,
  fake: FakeDefinition,
  overrides: OptionOverrides = {},
): LoadDefinitionSnapshotOptions {
  const skillDocs = fake.skillDocs ?? new Map<string, SkillDocument>();
  const base: NativeParsedAgent = {
    name: fake.frontmatter.name,
    description: fake.frontmatter.description,
    systemPrompt: fake.body,
    tools: parsedTools(fake.frontmatter.tools),
    model: parsedModel(fake.frontmatter.model),
    autoloadSkills: parsedSkills(fake.frontmatter.autoloadSkills),
  };
  return {
    definitionPath,
    workspaceRoot,
    parseAgent: () => {
      if (fake.failAgent === true) throw new Error("synthetic native Agent parse failure");
      return { ...base, ...fake.parsed };
    },
    parseFrontmatter: (_content, options) => {
      if (fake.failFrontmatter === true) throw new Error("synthetic native frontmatter parse failure");
      const skill = skillDocs.get(options.location);
      if (skill !== undefined) {
        if (skill.fail === true) throw new Error("synthetic native Skill parse failure");
        return { frontmatter: structuredClone(skill.frontmatter), body: skill.body };
      }
      return { frontmatter: structuredClone(fake.frontmatter), body: fake.body };
    },
    availableSkills: overrides.availableSkills ?? [],
    availableTools: overrides.availableTools ?? ["read", "write", "bash"],
    currentModel: overrides.currentModel ?? { provider: "host", id: "current-model" },
    resolveModel: overrides.resolveModel ?? ((selector) => {
      const slash = selector.indexOf("/");
      if (slash < 0) return { provider: "prov", id: selector };
      return { provider: selector.slice(0, slash), id: selector.slice(slash + 1) };
    }),
    ...(overrides.nativeSource === undefined ? {} : { nativeSource: overrides.nativeSource }),
    ...(overrides.fileIo === undefined ? {} : { fileIo: overrides.fileIo }),
  };
}

async function captureError(promise: Promise<unknown>): Promise<DefinitionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DefinitionError) return error;
    throw error;
  }
  throw new Error("Expected a DefinitionError.");
}

function genericFake(name: string, body: string, extra: Partial<FakeDefinition> = {}): FakeDefinition {
  return {
    frontmatter: { name, description: `Generic definition ${name}` },
    body,
    ...extra,
  };
}

describe("loadDefinitionSnapshot", () => {
  test("freezes explicit file provenance, definition text, tools, model and Skill text", async () => {
    const root = await tempRoot();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const skill = await writeSkill(root, "skill-a");
    const definitionPath = await writeDefinition(root, "generic-a", "Do the selected work.");
    const fake: FakeDefinition = {
      frontmatter: {
        name: "generic-a",
        description: "Generic definition generic-a",
        tools: ["read", "write"],
        model: "prov/model-a",
        autoloadSkills: ["skill-a"],
      },
      body: "Do the selected work.",
      skillDocs: new Map([[skill.filePath, skill.doc]]),
    };
    const snapshot = await loadDefinitionSnapshot(makeOptions(definitionPath, workspace, fake, {
      availableSkills: [skill.metadata],
      resolveModel: (selector) => selector === "prov/model-a" ? { provider: "prov", id: "model-a" } : undefined,
    }));

    expect(snapshot.schema).toBe(DEFINITION_SNAPSHOT_SCHEMA);
    expect(snapshot.origin).toBe(DEFINITION_ORIGIN);
    expect(snapshot.freezeScope).toBe(DEFINITION_FREEZE_SCOPE);
    expect(snapshot.nativeSourceLabel).toBe("explicit");
    expect(snapshot.version).toMatch(/^definition-snapshot-v1:sha256:[0-9a-f]{64}$/);
    expect(snapshot.workspaceRoot).toBe(workspace);
    expect(snapshot.definition.canonicalPath).toBe(definitionPath);
    expect(snapshot.definition.requestedPath).toBe(definitionPath);
    expect(snapshot.definition.name).toBe("generic-a");
    expect(snapshot.definition.body).toBe("Do the selected work.");
    expect(snapshot.definition.requestedTools).toEqual(["read", "write"]);
    expect(snapshot.definition.effectiveTools).toEqual(["read", "write"]);
    expect(snapshot.definition.model).toEqual({
      selector: "prov/model-a",
      selectorKind: "provider-id",
      provider: "prov",
      id: "model-a",
    });
    expect(snapshot.definition.autoloadSkills).toEqual(["skill-a"]);
    expect(snapshot.definition.sha256).toBe(sha256(await Bun.file(definitionPath).bytes()));
    expect(snapshot.definition.rawContent).toContain("Do the selected work.");
    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.skills[0]!.name).toBe("skill-a");
    expect(snapshot.skills[0]!.description).toBe("Description for skill-a");
    expect(snapshot.skills[0]!.canonicalPath).toBe(skill.filePath);
    expect(snapshot.skills[0]!.body).toBe(skill.doc.body);
    expect(snapshot.skills[0]!.rawContent).toContain(skill.doc.body);
    expect(snapshot.skills[0]!.frontmatter).toEqual(skill.doc.frontmatter);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.definition.effectiveTools)).toBe(true);
    expect(Object.isFrozen(snapshot.skills[0]!.frontmatter)).toBe(true);
  });

  test("omitted tools and model preserve the actual host capability set", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-minimal", "Use the host baseline.");
    const snapshot = await loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      genericFake("generic-minimal", "Use the host baseline."),
      { availableTools: ["write", "read", "bash"], currentModel: { provider: "host", id: "actual" } },
    ));

    expect(snapshot.definition.requestedTools).toBeNull();
    expect(snapshot.definition.effectiveTools).toEqual(["bash", "read", "write"]);
    expect(snapshot.definition.model).toEqual({
      selector: null,
      selectorKind: "host-current",
      provider: "host",
      id: "actual",
    });
    expect(snapshot.skills).toEqual([]);
  });

  test("allows a host-selected definition outside the workspace without claiming task access", async () => {
    const root = await tempRoot();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const definitionPath = await writeDefinition(root, "outside-generic", "Outside the workspace.");
    const snapshot = await loadDefinitionSnapshot(makeOptions(
      definitionPath,
      workspace,
      genericFake("outside-generic", "Outside the workspace."),
      { nativeSource: "project" },
    ));
    expect(snapshot.definition.canonicalPath).toBe(definitionPath);
    expect(snapshot.workspaceRoot).toBe(workspace);
    expect(snapshot.origin).toBe("explicit-host-path");
    expect(snapshot.nativeSourceLabel).toBe("project");
  });

  test("same inputs produce the same version and caller mutation does not alter the snapshot", async () => {
    const root = await tempRoot();
    const skill = await writeSkill(root, "skill-stable");
    const definitionPath = await writeDefinition(root, "generic-stable", "Stable body.");
    const fake: FakeDefinition = {
      frontmatter: {
        name: "generic-stable",
        description: "Generic definition generic-stable",
        autoloadSkills: ["skill-stable"],
      },
      body: "Stable body.",
      skillDocs: new Map([[skill.filePath, skill.doc]]),
    };
    const availableSkills = [skill.metadata];
    const availableTools = ["read", "write"];
    const first = await loadDefinitionSnapshot(makeOptions(definitionPath, root, fake, {
      availableSkills,
      availableTools,
    }));
    const second = await loadDefinitionSnapshot(makeOptions(definitionPath, root, fake, {
      availableSkills: [{ ...skill.metadata }],
      availableTools: [...availableTools],
    }));
    expect(second.version).toBe(first.version);

    availableTools.push("bash");
    (availableSkills[0] as { name: string }).name = "mutated";
    fake.frontmatter.name = "mutated-definition";
    expect(first.definition.effectiveTools).toEqual(["read", "write"]);
    expect(first.skills[0]!.name).toBe("skill-stable");
    expect(first.definition.name).toBe("generic-stable");

    const status = first.getStatus();
    expect(status.version).toBe(first.version);
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.definition.effectiveTools)).toBe(true);
    expect(() => {
      (status.definition.effectiveTools as string[]).push("bash");
    }).toThrow();
    expect(first.definition.effectiveTools).toEqual(["read", "write"]);
  });

  test("content changes create a new version while the old snapshot stays unchanged", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-versioned", "First body.");
    const fake = genericFake("generic-versioned", "First body.");
    const first = await loadDefinitionSnapshot(makeOptions(definitionPath, root, fake));

    await writeFile(
      definitionPath,
      "---\nname: generic-versioned\ndescription: Generic definition generic-versioned\n---\nSecond body.\n",
      "utf8",
    );
    fake.body = "Second body.";
    const second = await loadDefinitionSnapshot(makeOptions(definitionPath, root, fake));

    expect(first.version).not.toBe(second.version);
    expect(first.definition.body).toBe("First body.");
    expect(first.definition.rawContent).toContain("First body.");
    expect(second.definition.body).toBe("Second body.");
    expect(second.definition.sha256).not.toBe(first.definition.sha256);
  });

  test("permits two distinct generic definitions on the same kernel", async () => {
    const root = await tempRoot();
    const firstPath = await writeDefinition(root, "generic-one", "Handle one kind of work.");
    const secondPath = await writeDefinition(root, "generic-two", "Handle a different kind of work.");
    const first = await loadDefinitionSnapshot(makeOptions(firstPath, root, genericFake("generic-one", "Handle one kind of work.")));
    const second = await loadDefinitionSnapshot(makeOptions(secondPath, root, genericFake("generic-two", "Handle a different kind of work.")));

    expect(first.definition.name).toBe("generic-one");
    expect(second.definition.name).toBe("generic-two");
    expect(first.definition.body).not.toBe(second.definition.body);
    expect(first.version).not.toBe(second.version);
    expect(first.workspaceRoot).toBe(second.workspaceRoot);
  });
});

describe("definition preflight failures", () => {
  test("rejects missing, relative and symlinked selected paths", async () => {
    const root = await tempRoot();
    const missing = await captureError(loadDefinitionSnapshot(makeOptions(
      path.join(root, "missing.md"),
      root,
      genericFake("missing", "Body."),
    )));
    expect(missing.code).toBe("file-missing");

    const relative = await captureError(loadDefinitionSnapshot(makeOptions(
      "relative.md",
      root,
      genericFake("relative", "Body."),
    )));
    expect(relative.code).toBe("invalid-definition-path");

    const realFile = await writeDefinition(root, "generic-real", "Real body.");
    const link = path.join(root, "generic-link.md");
    await symlink(realFile, link);
    const linked = await captureError(loadDefinitionSnapshot(makeOptions(
      link,
      root,
      genericFake("generic-link", "Real body."),
    )));
    expect(linked.code).toBe("file-unsafe");

    const realDirectory = path.join(root, "real-directory");
    await mkdir(realDirectory);
    const realNested = await writeDefinition(realDirectory, "generic-nested", "Nested body.");
    const linkedDirectory = path.join(root, "linked-directory");
    await symlink(realDirectory, linkedDirectory);
    const linkedParent = await captureError(loadDefinitionSnapshot(makeOptions(
      path.join(linkedDirectory, path.basename(realNested)),
      root,
      genericFake("generic-nested", "Nested body."),
    )));
    expect(linkedParent.code).toBe("file-unsafe");
  });

  test("rejects invalid UTF-8, NUL bytes and oversized definition files", async () => {
    const root = await tempRoot();
    const invalidPath = path.join(root, "invalid.md");
    await writeFile(invalidPath, Buffer.from([0x61, 0xff, 0x62]));
    const invalid = await captureError(loadDefinitionSnapshot(makeOptions(
      invalidPath,
      root,
      genericFake("invalid", "Body."),
    )));
    expect(invalid.code).toBe("invalid-text");

    const nulPath = path.join(root, "nul.md");
    await writeFile(nulPath, Buffer.from("before\0after", "utf8"));
    const nul = await captureError(loadDefinitionSnapshot(makeOptions(
      nulPath,
      root,
      genericFake("nul", "Body."),
    )));
    expect(nul.code).toBe("invalid-text");

    const largePath = path.join(root, "large.md");
    await writeFile(largePath, Buffer.alloc(MAX_DEFINITION_BYTES + 1, 0x61));
    const large = await captureError(loadDefinitionSnapshot(makeOptions(
      largePath,
      root,
      genericFake("large", "Body."),
    )));
    expect(large.code).toBe("file-too-large");
  });

  test("rejects a file that changes while it is being read", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "changing", "Original body.");
    const changingIo: NativeFileIo = {
      O_RDONLY: nodeFileIo.O_RDONLY,
      O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
      realpath: (target) => nodeFileIo.realpath(target),
      lstat: (target, options) => nodeFileIo.lstat(target, options),
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        let reads = 0;
        return {
          stat: (options) => handle.stat(options),
          async read(buffer, offset, length, position) {
            const result = await handle.read(buffer, offset, length, position);
            if (reads++ === 0) await appendFile(target, "changed");
            return result;
          },
          close: () => handle.close(),
        };
      },
    };
    const changed = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      genericFake("changing", "Original body."),
      { fileIo: changingIo },
    )));
    expect(changed.code).toBe("file-changed");
  });

  test("converts unexpected file handle failures into a stable DefinitionError", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "unreadable", "Body.");
    const failingIo: NativeFileIo = {
      O_RDONLY: nodeFileIo.O_RDONLY,
      O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
      realpath: (target) => nodeFileIo.realpath(target),
      lstat: (target, options) => nodeFileIo.lstat(target, options),
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        return {
          stat: async () => {
            throw new Error("synthetic handle failure");
          },
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: () => handle.close(),
        };
      },
    };
    const error = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      genericFake("unreadable", "Body."),
      { fileIo: failingIo },
    )));
    expect(error.code).toBe("file-unreadable");
    expect(error.message).toContain("could not be read");
  });

  test("rejects missing workspace roots", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-workspace", "Body.");
    const error = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      path.join(root, "missing-workspace"),
      genericFake("generic-workspace", "Body."),
    )));
    expect(error.code).toBe("invalid-workspace-root");
  });

  test("rejects unsupported native frontmatter instead of silently narrowing it", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-unsupported", "Body.");
    const fake: FakeDefinition = {
      frontmatter: {
        name: "generic-unsupported",
        description: "Generic definition generic-unsupported",
        spawns: "*",
        thinkingLevel: "high",
      },
      body: "Body.",
    };
    const error = await captureError(loadDefinitionSnapshot(makeOptions(definitionPath, root, fake)));
    expect(error.code).toBe("unsupported-fields");
    expect(error.fields).toEqual(["spawns", "thinkingLevel"]);
    expect(error.message).toContain("spawns");
    expect(error.message).toContain("thinkingLevel");
  });

  test("rejects missing name, missing description, empty body and parser disagreement", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-fields", "Body.");

    const noName = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { description: "Only description" }, body: "Body." },
    )));
    expect(noName.code).toBe("missing-name");

    const noDescription = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-fields" }, body: "Body." },
    )));
    expect(noDescription.code).toBe("missing-description");

    const emptyBody = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-fields", description: "Description" }, body: "" },
    )));
    expect(emptyBody.code).toBe("empty-body");

    const bodyDisagreement = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      genericFake("generic-fields", "Parser body.", { parsed: { systemPrompt: "Frontmatter body." } }),
    )));
    expect(bodyDisagreement.code).toBe("parser-disagreement");

    const nameDisagreement = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      genericFake("generic-fields", "Body.", { parsed: { name: "different-name" } }),
    )));
    expect(nameDisagreement.code).toBe("parser-disagreement");
  });

  test("converts native parser failures into bounded DefinitionError values", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-native-error", "Body.");
    const frontmatterFailure = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      genericFake("generic-native-error", "Body.", { failFrontmatter: true }),
    )));
    expect(frontmatterFailure.code).toBe("native-parse-failed");
    expect(frontmatterFailure.message.length).toBeLessThan(400);

    const agentFailure = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      genericFake("generic-native-error", "Body.", { failAgent: true }),
    )));
    expect(agentFailure.code).toBe("native-parse-failed");
  });

  test("rejects invalid, duplicate and inactive tool declarations", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-tools", "Body.");

    const inactive = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-tools", description: "Description", tools: ["read", "network"] }, body: "Body." },
      { availableTools: ["read", "write"] },
    )));
    expect(inactive.code).toBe("unknown-tool");
    expect(inactive.fields).toEqual(["network"]);

    const duplicate = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-tools", description: "Description", tools: ["read", "read"] }, body: "Body." },
      { availableTools: ["read", "write"] },
    )));
    expect(duplicate.code).toBe("duplicate-tool");

    const malformed = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-tools", description: "Description", tools: { read: true } }, body: "Body." },
    )));
    expect(malformed.code).toBe("invalid-tools");

    const empty = await loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-tools", description: "Description", tools: [] }, body: "Body." },
      { availableTools: ["read", "write"] },
    ));
    expect(empty.definition.requestedTools).toEqual([]);
    expect(empty.definition.effectiveTools).toEqual([]);
  });

  test("rejects explicit null fields and never inherits for an explicit empty tool list", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-explicit", "Body.");

    const nullTools = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-explicit", description: "Description", tools: null }, body: "Body." },
    )));
    expect(nullTools.code).toBe("invalid-tools");

    const nullModel = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-explicit", description: "Description", model: null }, body: "Body." },
    )));
    expect(nullModel.code).toBe("invalid-model");

    const nullSkills = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-explicit", description: "Description", autoloadSkills: null }, body: "Body." },
    )));
    expect(nullSkills.code).toBe("invalid-skills");

    const collapsedEmpty = await loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: { name: "generic-explicit", description: "Description", tools: [] },
        body: "Body.",
        parsed: { tools: undefined },
      },
      { availableTools: ["read", "write"] },
    ));
    expect(collapsedEmpty.definition.requestedTools).toEqual([]);
    expect(collapsedEmpty.definition.effectiveTools).toEqual([]);
  });

  test("requires one exact model, rejects fuzzy replacement and unsupported suffixes", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-model", "Body.");
    const explicit = await loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-model", description: "Description", model: "prov/model-a" }, body: "Body." },
      { resolveModel: () => ({ provider: "prov", id: "model-a" }) },
    ));
    expect(explicit.definition.model.selectorKind).toBe("provider-id");

    const fuzzy = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-model", description: "Description", model: "prov/model-a" }, body: "Body." },
      { resolveModel: () => ({ provider: "prov", id: "model-b" }) },
    )));
    expect(fuzzy.code).toBe("model-not-exact");

    const unresolved = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-model", description: "Description", model: "prov/model-a" }, body: "Body." },
      { resolveModel: () => undefined },
    )));
    expect(unresolved.code).toBe("unresolved-model");

    const multiple = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-model", description: "Description", model: ["prov/one", "prov/two"] }, body: "Body." },
    )));
    expect(multiple.code).toBe("multiple-models");

    let resolverCalls = 0;
    const suffix = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-model", description: "Description", model: "prov/model-a:high" }, body: "Body." },
      {
        resolveModel: () => {
          resolverCalls += 1;
          return { provider: "prov", id: "model-a" };
        },
      },
    )));
    expect(suffix.code).toBe("model-suffix-unsupported");
    expect(resolverCalls).toBe(0);

    const numericSuffix = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-model", description: "Description", model: "prov/model-a:2" }, body: "Body." },
      {
        resolveModel: () => {
          resolverCalls += 1;
          return { provider: "prov", id: "model-a:2" };
        },
      },
    )));
    expect(numericSuffix.code).toBe("model-suffix-unsupported");
    expect(resolverCalls).toBe(0);

    const malformed = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-model", description: "Description", model: { provider: "prov" } }, body: "Body." },
    )));
    expect(malformed.code).toBe("invalid-model");
  });

  test("preserves a native alias selector and records the actual resolved identity", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-alias", "Body.");
    const snapshot = await loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-alias", description: "Description", model: "@small" }, body: "Body." },
      { resolveModel: (selector) => selector === "@small" ? { provider: "prov", id: "small-model" } : undefined },
    ));
    expect(snapshot.definition.model).toEqual({
      selector: "@small",
      selectorKind: "native-selector",
      provider: "prov",
      id: "small-model",
    });
  });
});

describe("Skill preflight", () => {
  test("rejects missing, ambiguous and duplicate declared Skills", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-skills", "Body.");
    const missing = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-skills", description: "Description", autoloadSkills: ["absent"] }, body: "Body." },
    )));
    expect(missing.code).toBe("skill-missing");

    const ambiguous = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-skills", description: "Description", autoloadSkills: ["same"] }, body: "Body." },
      {
        availableSkills: [
          { name: "same", filePath: path.join(root, "a", "SKILL.md"), description: "A" },
          { name: "same", filePath: path.join(root, "b", "SKILL.md"), description: "B" },
        ],
      },
    )));
    expect(ambiguous.code).toBe("skill-ambiguous");

    const duplicate = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      { frontmatter: { name: "generic-skills", description: "Description", autoloadSkills: ["one", "one"] }, body: "Body." },
    )));
    expect(duplicate.code).toBe("skill-duplicate");
  });

  test("rejects too many Skills and oversized or non-SKILL.md referenced files", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-skill-files", "Body.");
    const tooMany = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: {
          name: "generic-skill-files",
          description: "Description",
          autoloadSkills: Array.from({ length: 9 }, (_, index) => `skill-${index}`),
        },
        body: "Body.",
      },
    )));
    expect(tooMany.code).toBe("skill-limit");

    const largeSkill = await writeSkill(root, "large-skill");
    await writeFile(largeSkill.filePath, Buffer.alloc(MAX_SKILL_BYTES + 1, 0x61));
    const oversized = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: {
          name: "generic-skill-files",
          description: "Description",
          autoloadSkills: ["large-skill"],
        },
        body: "Body.",
      },
      { availableSkills: [largeSkill.metadata] },
    )));
    expect(oversized.code).toBe("file-too-large");

    const wrongNameDirectory = path.join(root, "wrong-name");
    await mkdir(wrongNameDirectory);
    const wrongNamePath = path.join(wrongNameDirectory, "OTHER.md");
    await writeFile(wrongNamePath, "---\nname: wrong-name\ndescription: Wrong\n---\nBody.\n", "utf8");
    const wrongName = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: {
          name: "generic-skill-files",
          description: "Description",
          autoloadSkills: ["wrong-name"],
        },
        body: "Body.",
      },
      { availableSkills: [{ name: "wrong-name", filePath: wrongNamePath, description: "Wrong" }] },
    )));
    expect(wrongName.code).toBe("file-unsafe");
  });

  test("enforces the total initial text budget across definition and Skills", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-total", "Body.");
    const skills: DefinitionSkillMetadata[] = [];
    const docs = new Map<string, SkillDocument>();
    for (let index = 0; index < 4; index += 1) {
      const skill = await writeSkill(root, `large-${index}`);
      await writeFile(skill.filePath, Buffer.alloc(MAX_SKILL_BYTES, 0x61));
      skills.push(skill.metadata);
      docs.set(skill.filePath, skill.doc);
    }
    const error = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: {
          name: "generic-total",
          description: "Description",
          autoloadSkills: skills.map((skill) => skill.name),
        },
        body: "Body.",
        skillDocs: docs,
      },
      { availableSkills: skills },
    )));
    expect(error.code).toBe("total-too-large");
    expect(MAX_INITIAL_TEXT_BYTES).toBe(1024 * 1024);
  });

  test("rejects Skill name or description drift after native discovery", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-skill-drift", "Body.");

    const renamed = await writeSkill(root, "old-skill-name");
    renamed.doc.frontmatter.name = "new-skill-name";
    await writeFile(
      renamed.filePath,
      `---\nname: new-skill-name\ndescription: ${renamed.metadata.description}\n---\n${renamed.doc.body}\n`,
      "utf8",
    );
    const nameDrift = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: { name: "generic-skill-drift", description: "Description", autoloadSkills: ["old-skill-name"] },
        body: "Body.",
        skillDocs: new Map([[renamed.filePath, renamed.doc]]),
      },
      { availableSkills: [renamed.metadata] },
    )));
    expect(nameDrift.code).toBe("skill-metadata-mismatch");

    const described = await writeSkill(root, "described-skill", { description: "Old description" });
    described.doc.frontmatter.description = "New description";
    await writeFile(
      described.filePath,
      `---\nname: described-skill\ndescription: New description\n---\n${described.doc.body}\n`,
      "utf8",
    );
    const descriptionDrift = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: { name: "generic-skill-drift", description: "Description", autoloadSkills: ["described-skill"] },
        body: "Body.",
        skillDocs: new Map([[described.filePath, described.doc]]),
      },
      { availableSkills: [described.metadata] },
    )));
    expect(descriptionDrift.code).toBe("skill-metadata-mismatch");
  });

  test("requires exact native Skill names and rejects unverifiable aliases", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-skill-name-exact", "Body.");
    const skill = await writeSkill(root, "foo~2");
    const exact = await loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: { name: "generic-skill-name-exact", description: "Description", autoloadSkills: ["foo~2"] },
        body: "Body.",
        skillDocs: new Map([[skill.filePath, skill.doc]]),
      },
      { availableSkills: [skill.metadata] },
    ));
    expect(exact.skills.map((entry) => entry.name)).toEqual(["foo~2"]);
    const oldVersion = exact.version;
    const oldRaw = exact.skills[0]!.rawContent;

    const alias = { ...skill.metadata, name: "plugin/foo~2" };
    const aliasRaw = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: {
          name: "generic-skill-name-exact",
          description: "Description",
          autoloadSkills: ["plugin/foo~2"],
        },
        body: "Body.",
        skillDocs: new Map([[skill.filePath, skill.doc]]),
      },
      { availableSkills: [alias] },
    )));
    expect(aliasRaw.code).toBe("skill-metadata-mismatch");
    expect(aliasRaw.message).toContain("alias");

    await writeFile(
      skill.filePath,
      `---\nname: foo\ndescription: ${skill.metadata.description}\n---\n${skill.doc.body}\n`,
      "utf8",
    );
    skill.doc.frontmatter.name = "foo";
    const aliasChanged = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: {
          name: "generic-skill-name-exact",
          description: "Description",
          autoloadSkills: ["plugin/foo~2"],
        },
        body: "Body.",
        skillDocs: new Map([[skill.filePath, skill.doc]]),
      },
      { availableSkills: [alias] },
    )));
    expect(aliasChanged.code).toBe("skill-metadata-mismatch");
    expect(aliasChanged.message).toContain("alias");

    expect(exact.version).toBe(oldVersion);
    expect(exact.skills[0]!.rawContent).toBe(oldRaw);
  });

  test("rejects unreadable Skill text and empty Skill bodies", async () => {
    const root = await tempRoot();
    const definitionPath = await writeDefinition(root, "generic-skill-text", "Body.");
    const invalidSkill = await writeSkill(root, "invalid-skill");
    await writeFile(invalidSkill.filePath, Buffer.from([0xff, 0xfe]));
    const invalid = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: { name: "generic-skill-text", description: "Description", autoloadSkills: ["invalid-skill"] },
        body: "Body.",
      },
      { availableSkills: [invalidSkill.metadata] },
    )));
    expect(invalid.code).toBe("invalid-text");

    const emptySkill = await writeSkill(root, "empty-skill", { body: "" });
    const empty = await captureError(loadDefinitionSnapshot(makeOptions(
      definitionPath,
      root,
      {
        frontmatter: { name: "generic-skill-text", description: "Description", autoloadSkills: ["empty-skill"] },
        body: "Body.",
        skillDocs: new Map([[emptySkill.filePath, emptySkill.doc]]),
      },
      { availableSkills: [emptySkill.metadata] },
    )));
    expect(empty.code).toBe("empty-body");
  });
});
