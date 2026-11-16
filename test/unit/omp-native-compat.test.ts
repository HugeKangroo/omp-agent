import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkOmpInstanceProfile,
  createOmpDefinitionPorts,
  createOmpInstancePorts,
  loadOmpDefinitionPorts,
  type OmpNativeBaseModules,
  type OmpNativeInstanceModules,
  type OmpSupportedSettings,
} from "../../src/omp-native-compat.ts";

/**
 * Controlled fixed-module projections. These tests do not prove actual OMP
 * scope, settings-instance or host-rewrite behavior; root actual-host probes
 * cover those surfaces separately.
 */

const SUPPORTED_SETTINGS: OmpSupportedSettings = {
  asyncEnabled: false,
  taskBatch: false,
  taskSpeculativeLaunch: false,
  taskWorkerThreads: 0,
  taskStructured: false,
};

const SETTING_READS = [
  { id: "async.enabled", type: "boolean", key: "asyncEnabled", value: false },
  { id: "task.batch", type: "boolean", key: "taskBatch", value: false },
  { id: "task.speculativeLaunch", type: "boolean", key: "taskSpeculativeLaunch", value: false },
  { id: "task.workerThreads", type: "number", key: "taskWorkerThreads", value: 0 },
  { id: "task.structured", type: "boolean", key: "taskStructured", value: false },
] as const;

function validBase(): OmpNativeBaseModules {
  return {
    agents: { parseAgent: () => ({}) },
    utils: { parseFrontmatter: () => ({ frontmatter: {}, body: "" }) },
    skills: { getActiveSkills: () => [] },
  };
}

function validInstance(overrides: Partial<OmpNativeInstanceModules> = {}): OmpNativeInstanceModules {
  return {
    agents: { parseAgent: () => ({}) },
    utils: {
      parseFrontmatter: () => ({ frontmatter: {}, body: "" }),
      prompt: {
        render: (template: string, vars: Record<string, unknown>) => `${template}|${String(vars.agent)}`,
      },
    },
    skills: {
      getActiveSkills: () => [],
      renderSkillPromptMessage: () => ({ message: "rendered" }),
    },
    discovery: { discoverAgents: async () => ({ agents: [] }) },
    settings: { findScopedSettings: () => ({}) },
    registry: { lookup: () => undefined },
    ...overrides,
  };
}

function handleFor(id: string, value: unknown, type = SETTING_READS.find((entry) => entry.id === id)?.type) {
  return {
    type,
    get: (_scope: unknown) => value,
  };
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("fixed host module projections", () => {
  test("definition projection needs only the three base exports", () => {
    const ports = createOmpDefinitionPorts(validBase());
    expect(typeof ports.parseAgent).toBe("function");
    expect(typeof ports.parseFrontmatter).toBe("function");
    expect(ports.getActiveSkills()).toEqual([]);
  });

  test("native modules load only when a loader is invoked", async () => {
    // Importing this module graph already succeeded without @oh-my-pi present.
    await expect(loadOmpDefinitionPorts()).rejects.toBeInstanceOf(Error);
  });

  const definitionRefusals = [
    {
      exportName: "parseAgent",
      missing: () => ({ ...validBase(), agents: {} }),
      wrong: () => ({ ...validBase(), agents: { parseAgent: "not-a-function" } }),
      message: "@oh-my-pi/pi-coding-agent/task/agents does not export parseAgent.",
    },
    {
      exportName: "parseFrontmatter",
      missing: () => ({ ...validBase(), utils: {} }),
      wrong: () => ({ ...validBase(), utils: { parseFrontmatter: 7 } }),
      message: "@oh-my-pi/pi-utils does not export parseFrontmatter.",
    },
    {
      exportName: "getActiveSkills",
      missing: () => ({ ...validBase(), skills: {} }),
      wrong: () => ({ ...validBase(), skills: { getActiveSkills: false } }),
      message: "@oh-my-pi/pi-coding-agent/extensibility/skills does not export getActiveSkills.",
    },
  ];

  for (const refusal of definitionRefusals) {
    test(`definition projection refuses missing or wrong-type ${refusal.exportName}`, () => {
      expect(() => createOmpDefinitionPorts(refusal.missing())).toThrow(refusal.message);
      expect(() => createOmpDefinitionPorts(refusal.wrong())).toThrow(refusal.message);
    });
  }

  test("instance projection preserves the base validation", () => {
    expect(() => createOmpInstancePorts({ ...validInstance(), agents: {} }))
      .toThrow("@oh-my-pi/pi-coding-agent/task/agents does not export parseAgent.");
  });

  const instanceRefusals = [
    {
      exportName: "discoverAgents",
      missing: () => ({ ...validInstance(), discovery: {} }),
      wrong: () => ({ ...validInstance(), discovery: { discoverAgents: "no" } }),
      message: "@oh-my-pi/pi-coding-agent/task/discovery does not export discoverAgents.",
    },
    {
      exportName: "renderSkillPromptMessage",
      missing: () => ({
        ...validInstance(),
        skills: { getActiveSkills: () => [] },
      }),
      wrong: () => ({
        ...validInstance(),
        skills: { getActiveSkills: () => [], renderSkillPromptMessage: 1 },
      }),
      message: "@oh-my-pi/pi-coding-agent/extensibility/skills does not export renderSkillPromptMessage.",
    },
    {
      exportName: "prompt.render",
      missing: () => ({
        ...validInstance(),
        utils: { parseFrontmatter: () => ({ frontmatter: {}, body: "" }) },
      }),
      wrong: () => ({
        ...validInstance(),
        utils: {
          parseFrontmatter: () => ({ frontmatter: {}, body: "" }),
          prompt: { render: "no" },
        },
      }),
      message: "@oh-my-pi/pi-utils does not export prompt.render.",
    },
    {
      exportName: "findScopedSettings",
      missing: () => ({ ...validInstance(), settings: {} }),
      wrong: () => ({ ...validInstance(), settings: { findScopedSettings: {} } }),
      message: "@oh-my-pi/pi-coding-agent/config/settings does not export findScopedSettings.",
    },
    {
      exportName: "lookup",
      missing: () => ({ ...validInstance(), registry: {} }),
      wrong: () => ({ ...validInstance(), registry: { lookup: [] } }),
      message: "@oh-my-pi/pi-coding-agent/config/registry does not export lookup.",
    },
  ];

  for (const refusal of instanceRefusals) {
    test(`instance projection refuses missing or wrong-type ${refusal.exportName}`, () => {
      expect(() => createOmpInstancePorts(refusal.missing())).toThrow(refusal.message);
      expect(() => createOmpInstancePorts(refusal.wrong())).toThrow(refusal.message);
    });
  }
});

describe("live Skill and settings access", () => {
  test("Skill catalog remains a call-through", () => {
    let catalog: readonly unknown[] = [{ name: "first" }];
    const ports = createOmpDefinitionPorts({
      ...validBase(),
      skills: { getActiveSkills: () => catalog },
    });
    expect(ports.getActiveSkills()).toEqual([{ name: "first" }]);
    catalog = [{ name: "second" }, { name: "third" }];
    expect(ports.getActiveSkills()).toEqual([{ name: "second" }, { name: "third" }]);
  });

  test("two current instances each receive all five handle reads", () => {
    const firstScope = { instance: "first" };
    const secondScope = { instance: "second" };
    const scopes: unknown[] = [firstScope, secondScope];
    const reads: Array<{ readonly id: string; readonly scope: unknown }> = [];
    let findCalls = 0;
    let lookupCalls = 0;
    const ports = createOmpInstancePorts(validInstance({
      settings: {
        findScopedSettings: () => {
          findCalls += 1;
          return scopes.shift();
        },
      },
      registry: {
        lookup: (id: string) => {
          lookupCalls += 1;
          const expected = SETTING_READS.find((entry) => entry.id === id);
          return {
            type: expected?.type,
            get(scope: unknown) {
              reads.push({ id, scope });
              return expected?.value;
            },
          };
        },
      },
    }));

    expect(ports.readScopedSettings()).toEqual({ ok: true, settings: SUPPORTED_SETTINGS });
    expect(ports.readScopedSettings()).toEqual({ ok: true, settings: SUPPORTED_SETTINGS });
    expect(findCalls).toBe(2);
    expect(lookupCalls).toBe(10);
    expect(reads.map((read) => read.id)).toEqual([
      ...SETTING_READS.map((entry) => entry.id),
      ...SETTING_READS.map((entry) => entry.id),
    ]);
    expect(reads.slice(0, 5).every((read) => read.scope === firstScope)).toBe(true);
    expect(reads.slice(5).every((read) => read.scope === secondScope)).toBe(true);
  });

  test("absent current instance is refused", () => {
    for (const scope of [undefined, null]) {
      const ports = createOmpInstancePorts(validInstance({
        settings: { findScopedSettings: () => scope },
      }));
      expect(ports.readScopedSettings()).toEqual({
        ok: false,
        code: "settings-instance-missing",
        message: "findScopedSettings() returned no active instance.",
      });
    }
  });

  test("unsupported handle and value types are refused with the existing text", () => {
    const badHandle = createOmpInstancePorts(validInstance({
      registry: {
        lookup: (id: string) => id === "async.enabled"
          ? { type: "number", get: () => false }
          : handleFor(id, SETTING_READS.find((entry) => entry.id === id)?.value),
      },
    }));
    expect(badHandle.readScopedSettings()).toEqual({
      ok: false,
      code: "settings-handle-invalid",
      message: "Setting async.enabled has no supported handle.",
    });

    const badBoolean = createOmpInstancePorts(validInstance({
      registry: {
        lookup: (id: string) => handleFor(
          id,
          id === "async.enabled" ? "false" : SETTING_READS.find((entry) => entry.id === id)?.value,
        ),
      },
    }));
    expect(badBoolean.readScopedSettings()).toEqual({
      ok: false,
      code: "settings-type-invalid",
      message: "Setting async.enabled is not a boolean.",
    });

    const badNumber = createOmpInstancePorts(validInstance({
      registry: {
        lookup: (id: string) => handleFor(
          id,
          id === "task.workerThreads" ? Number.NaN : SETTING_READS.find((entry) => entry.id === id)?.value,
        ),
      },
    }));
    expect(badNumber.readScopedSettings()).toEqual({
      ok: false,
      code: "settings-type-invalid",
      message: "Setting task.workerThreads is not a finite number.",
    });

    const throwing = createOmpInstancePorts(validInstance({
      registry: {
        lookup: (id: string) => id === "task.batch"
          ? {
              type: "boolean",
              get: () => {
                throw new Error("host read failed");
              },
            }
          : handleFor(id, SETTING_READS.find((entry) => entry.id === id)?.value),
      },
    }));
    expect(throwing.readScopedSettings()).toEqual({
      ok: false,
      code: "settings-read-failed",
      message: "Setting task.batch read failed: host read failed",
    });
  });
});

describe("fixed Role, Skill and discovery adaptation", () => {
  test("Role and Skill rendering preserve the native call shapes", () => {
    let roleTemplate: unknown;
    let roleVars: unknown;
    let skillCall: readonly unknown[] = [];
    const skill = { name: "review", filePath: "/skills/review/SKILL.md", baseDir: "/skills/review" };
    const ports = createOmpInstancePorts(validInstance({
      utils: {
        parseFrontmatter: () => ({ frontmatter: {}, body: "" }),
        prompt: {
          render: (template: string, vars: Record<string, unknown>) => {
            roleTemplate = template;
            roleVars = vars;
            return `RENDERED ${String(vars.agent)}`;
          },
        },
      },
      skills: {
        getActiveSkills: () => [],
        renderSkillPromptMessage: (...args: unknown[]) => {
          skillCall = args;
          return { message: "skill message", details: { name: "review" } };
        },
      },
    }));

    expect(ports.renderRoleFrame("BODY")).toBe("RENDERED BODY");
    expect(roleTemplate).toBe("\u2042 Role\n{{agent}}\n\u2042 Coop");
    expect(roleVars).toEqual({ agent: "BODY" });
    expect(ports.renderSkillMessage(skill, "skill body")).toEqual({
      message: "skill message",
      details: { name: "review" },
    });
    expect(skillCall).toEqual([skill, { args: "" }, "skill body", "autoload"]);
  });

  test("Role rendering refuses a non-string native result", () => {
    const ports = createOmpInstancePorts(validInstance({
      utils: {
        parseFrontmatter: () => ({ frontmatter: {}, body: "" }),
        prompt: { render: () => 42 },
      },
    }));
    expect(() => ports.renderRoleFrame("BODY"))
      .toThrow("Native prompt.render did not return the Role frame string.");
  });

  test("discovery canonicalizes real paths and skips unreadable entries", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-compat-")));
    roots.push(root);
    const target = path.join(root, "target.md");
    await writeFile(target, "body");
    const linked = path.join(root, "linked.md");
    await symlink(target, linked);
    const ports = createOmpInstancePorts(validInstance({
      discovery: {
        discoverAgents: async (cwd: string) => {
          expect(cwd).toBe(root);
          return {
            agents: [
              { name: "linked", filePath: linked, source: "project" },
              { name: "missing", filePath: path.join(root, "missing.md"), source: "user" },
              { name: "target", filePath: target, source: "project" },
            ],
          };
        },
      },
    }));

    expect(await ports.discoverAgents(root)).toEqual([
      { name: "linked", filePath: target, source: "project" },
      { name: "target", filePath: target, source: "project" },
    ]);
  });

  test("malformed discovery results are refused", async () => {
    const missing = createOmpInstancePorts(validInstance({
      discovery: { discoverAgents: async () => ({}) },
    }));
    await expect(missing.discoverAgents("/workspace"))
      .rejects.toThrow("Native discoverAgents returned no supported agent list.");

    const unsupported = createOmpInstancePorts(validInstance({
      discovery: { discoverAgents: async () => ({ agents: [{ name: "only-name" }] }) },
    }));
    await expect(unsupported.discoverAgents("/workspace"))
      .rejects.toThrow("Native discoverAgents returned an unsupported agent entry.");
  });
});

describe("fixed runtime profile", () => {
  test("supported values are canonicalized", () => {
    expect(checkOmpInstanceProfile({ ok: true, settings: { ...SUPPORTED_SETTINGS } }))
      .toEqual({ ok: true, settings: SUPPORTED_SETTINGS });
  });

  test("failed reads preserve code and message", () => {
    expect(checkOmpInstanceProfile({
      ok: false,
      code: "settings-instance-missing",
      message: "findScopedSettings() returned no active instance.",
    })).toEqual({
      ok: false,
      message: "settings-instance-missing: findScopedSettings() returned no active instance.",
    });
  });

  const drifts = [
    { key: "asyncEnabled", value: true, message: "async.enabled must be false." },
    { key: "taskBatch", value: true, message: "task.batch must be false." },
    { key: "taskSpeculativeLaunch", value: true, message: "task.speculativeLaunch must be false." },
    { key: "taskWorkerThreads", value: 1, message: "task.workerThreads must be 0." },
    { key: "taskStructured", value: true, message: "task.structured must be false." },
  ] as const;

  for (const drift of drifts) {
    test(`profile drift refuses ${drift.key}`, () => {
      expect(checkOmpInstanceProfile({
        ok: true,
        settings: { ...SUPPORTED_SETTINGS, [drift.key]: drift.value },
      })).toEqual({ ok: false, message: drift.message });
    });
  }
});
