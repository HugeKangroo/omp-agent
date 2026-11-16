import { realpath } from "node:fs/promises";
import type {
  ParseAgentPort,
  ParseFrontmatterPort,
} from "./agent-definition.ts";

/**
 * Fixed OMP 18.20.2 host compatibility boundary.
 *
 * This module owns the host module specifiers, their required export shapes,
 * the fixed Role frame and the five supported scoped runtime settings. It
 * owns no session, root, binding, settings-instance, Skill-catalog or handle
 * state: every accessor remains a live call-through to the host.
 *
 * Literal dynamic import specifiers are required: the fixed host rewrites
 * literal module imports, while a specifier held in a variable bypasses that
 * rewrite. Native imports never run at module load; both loaders are lazy.
 */

const NATIVE_AGENTS_SPECIFIER = "@oh-my-pi/pi-coding-agent/task/agents";
const NATIVE_DISCOVERY_SPECIFIER = "@oh-my-pi/pi-coding-agent/task/discovery";
const NATIVE_UTILS_SPECIFIER = "@oh-my-pi/pi-utils";
const NATIVE_SKILLS_SPECIFIER = "@oh-my-pi/pi-coding-agent/extensibility/skills";
const NATIVE_SETTINGS_SPECIFIER = "@oh-my-pi/pi-coding-agent/config/settings";
const NATIVE_REGISTRY_SPECIFIER = "@oh-my-pi/pi-coding-agent/config/registry";
const ROLE_FRAME = "\u2042 Role\n{{agent}}\n\u2042 Coop";

const SUPPORTED_SETTING_IDS = [
  ["async.enabled", "boolean", "asyncEnabled"],
  ["task.batch", "boolean", "taskBatch"],
  ["task.speculativeLaunch", "boolean", "taskSpeculativeLaunch"],
  ["task.workerThreads", "number", "taskWorkerThreads"],
  ["task.structured", "boolean", "taskStructured"],
] as const;

export interface OmpDefinitionPorts {
  readonly parseAgent: ParseAgentPort;
  readonly parseFrontmatter: ParseFrontmatterPort;
  /**
   * Actual process-wide native Skill catalog, normally
   * `@oh-my-pi/pi-coding-agent/extensibility/skills`.getActiveSkills.
   */
  readonly getActiveSkills: () => readonly unknown[];
}

export interface OmpInstancePorts extends OmpDefinitionPorts {
  readonly discoverAgents: (cwd: string) => Promise<readonly OmpDiscoveredAgent[]>;
  readonly renderRoleFrame: (body: string) => string;
  readonly renderSkillMessage: (skill: OmpSkillRenderInput, body: string) => unknown;
  readonly readScopedSettings: () => OmpSettingsResult;
}

export interface OmpSupportedSettings {
  readonly asyncEnabled: boolean;
  readonly taskBatch: boolean;
  readonly taskSpeculativeLaunch: boolean;
  readonly taskWorkerThreads: number;
  readonly taskStructured: boolean;
}

export type OmpSettingsResult =
  | { readonly ok: true; readonly settings: OmpSupportedSettings }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type OmpProfileResult =
  | { readonly ok: true; readonly settings: OmpSupportedSettings }
  | { readonly ok: false; readonly message: string };

export interface OmpDiscoveredAgent {
  readonly name: string;
  readonly filePath: string;
  readonly source: string;
}

export interface OmpSkillRenderInput {
  readonly name: string;
  readonly filePath: string;
  readonly baseDir: string;
}

/**
 * Fixed module projections used by the two finite constructors below.
 *
 * These are not a general importer seam: the only production modules are the
 * literal host imports in the loader functions at the end of this file.
 */
export interface OmpNativeBaseModules {
  readonly agents: unknown;
  readonly utils: unknown;
  readonly skills: unknown;
}

export interface OmpNativeInstanceModules extends OmpNativeBaseModules {
  readonly discovery: unknown;
  readonly settings: unknown;
  readonly registry: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function moduleExport(module: unknown, name: string): unknown {
  if (typeof module !== "object" || module === null) return undefined;
  return (module as Record<string, unknown>)[name];
}

/** Builds the three-export definition projection from fixed host modules. */
export function createOmpDefinitionPorts(modules: OmpNativeBaseModules): OmpDefinitionPorts {
  const parseAgent = moduleExport(modules.agents, "parseAgent");
  const parseFrontmatter = moduleExport(modules.utils, "parseFrontmatter");
  const getActiveSkills = moduleExport(modules.skills, "getActiveSkills");
  if (typeof parseAgent !== "function") {
    throw new Error(`${NATIVE_AGENTS_SPECIFIER} does not export parseAgent.`);
  }
  if (typeof parseFrontmatter !== "function") {
    throw new Error(`${NATIVE_UTILS_SPECIFIER} does not export parseFrontmatter.`);
  }
  if (typeof getActiveSkills !== "function") {
    throw new Error(`${NATIVE_SKILLS_SPECIFIER} does not export getActiveSkills.`);
  }
  return {
    parseAgent: parseAgent as ParseAgentPort,
    parseFrontmatter: parseFrontmatter as ParseFrontmatterPort,
    getActiveSkills: () => (getActiveSkills as () => readonly unknown[])(),
  };
}

/** Builds the full instance projection from fixed host modules. */
export function createOmpInstancePorts(modules: OmpNativeInstanceModules): OmpInstancePorts {
  const base = createOmpDefinitionPorts(modules);
  const discoverAgentsNative = moduleExport(modules.discovery, "discoverAgents");
  const renderSkillPromptMessage = moduleExport(modules.skills, "renderSkillPromptMessage");
  const prompt = moduleExport(modules.utils, "prompt");
  const findScopedSettings = moduleExport(modules.settings, "findScopedSettings");
  const lookup = moduleExport(modules.registry, "lookup");

  if (typeof discoverAgentsNative !== "function") {
    throw new Error(`${NATIVE_DISCOVERY_SPECIFIER} does not export discoverAgents.`);
  }
  if (typeof renderSkillPromptMessage !== "function") {
    throw new Error(`${NATIVE_SKILLS_SPECIFIER} does not export renderSkillPromptMessage.`);
  }
  if (!isRecord(prompt) || typeof prompt.render !== "function") {
    throw new Error(`${NATIVE_UTILS_SPECIFIER} does not export prompt.render.`);
  }
  if (typeof findScopedSettings !== "function") {
    throw new Error(`${NATIVE_SETTINGS_SPECIFIER} does not export findScopedSettings.`);
  }
  if (typeof lookup !== "function") {
    throw new Error(`${NATIVE_REGISTRY_SPECIFIER} does not export lookup.`);
  }

  const readScopedSettings = (): OmpSettingsResult => {
    const instance = findScopedSettings();
    if (instance === undefined || instance === null) {
      return {
        ok: false,
        code: "settings-instance-missing",
        message: "findScopedSettings() returned no active instance.",
      };
    }
    const values: Record<string, boolean | number> = {};
    for (const [id, expectedType, key] of SUPPORTED_SETTING_IDS) {
      const handle = lookup(id);
      if (!isRecord(handle) || handle.type !== expectedType || typeof handle.get !== "function") {
        return { ok: false, code: "settings-handle-invalid", message: `Setting ${id} has no supported handle.` };
      }
      let value: unknown;
      try {
        value = (handle.get as (scope: unknown) => unknown)(instance);
      } catch (error) {
        return {
          ok: false,
          code: "settings-read-failed",
          message: `Setting ${id} read failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (expectedType === "boolean") {
        if (typeof value !== "boolean") {
          return { ok: false, code: "settings-type-invalid", message: `Setting ${id} is not a boolean.` };
        }
      } else if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, code: "settings-type-invalid", message: `Setting ${id} is not a finite number.` };
      }
      values[key] = value;
    }
    return {
      ok: true,
      settings: {
        asyncEnabled: values.asyncEnabled as boolean,
        taskBatch: values.taskBatch as boolean,
        taskSpeculativeLaunch: values.taskSpeculativeLaunch as boolean,
        taskWorkerThreads: values.taskWorkerThreads as number,
        taskStructured: values.taskStructured as boolean,
      },
    };
  };

  const discoverAgents = async (cwd: string): Promise<readonly OmpDiscoveredAgent[]> => {
    const result = await (discoverAgentsNative as (cwd: string) => Promise<unknown>)(cwd);
    if (!isRecord(result) || !Array.isArray(result.agents)) {
      throw new Error("Native discoverAgents returned no supported agent list.");
    }
    const output: OmpDiscoveredAgent[] = [];
    for (const agent of result.agents) {
      if (!isRecord(agent)
        || typeof agent.name !== "string"
        || agent.name.length === 0
        || typeof agent.filePath !== "string"
        || agent.filePath.length === 0
        || typeof agent.source !== "string") {
        throw new Error("Native discoverAgents returned an unsupported agent entry.");
      }
      try {
        output.push({
          name: agent.name,
          filePath: await realpath(agent.filePath),
          source: agent.source,
        });
      } catch {
        // An unreadable unrelated definition is not an authority candidate.
      }
    }
    return output;
  };

  return {
    ...base,
    discoverAgents,
    renderRoleFrame: (body: string): string => {
      const rendered = (prompt.render as (template: string, vars: Record<string, unknown>) => unknown)(
        ROLE_FRAME,
        { agent: body },
      );
      if (typeof rendered !== "string") {
        throw new Error("Native prompt.render did not return the Role frame string.");
      }
      return rendered;
    },
    renderSkillMessage: (skill, body) => {
      return (renderSkillPromptMessage as (
        value: OmpSkillRenderInput,
        args: { readonly args: string },
        content: string,
        mode: "autoload",
      ) => unknown)(skill, { args: "" }, body, "autoload");
    },
    readScopedSettings,
  };
}

/** The fixed supported runtime profile; every value must match exactly. */
export function checkOmpInstanceProfile(result: OmpSettingsResult): OmpProfileResult {
  if (!result.ok) return { ok: false, message: `${result.code}: ${result.message}` };
  const settings = result.settings;
  if (settings.asyncEnabled !== false) return { ok: false, message: "async.enabled must be false." };
  if (settings.taskBatch !== false) return { ok: false, message: "task.batch must be false." };
  if (settings.taskSpeculativeLaunch !== false) return { ok: false, message: "task.speculativeLaunch must be false." };
  if (settings.taskWorkerThreads !== 0) return { ok: false, message: "task.workerThreads must be 0." };
  if (settings.taskStructured !== false) return { ok: false, message: "task.structured must be false." };
  return {
    ok: true,
    settings: {
      asyncEnabled: false,
      taskBatch: false,
      taskSpeculativeLaunch: false,
      taskWorkerThreads: 0,
      taskStructured: false,
    },
  };
}

async function loadBaseModules(): Promise<OmpNativeBaseModules> {
  const [agents, utils, skills] = await Promise.all([
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-coding-agent/task/agents"),
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-utils"),
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-coding-agent/extensibility/skills"),
  ]);
  return { agents, utils, skills };
}

/** Loads and validates only the three exports an independent D1 requires. */
export async function loadOmpDefinitionPorts(): Promise<OmpDefinitionPorts> {
  return createOmpDefinitionPorts(await loadBaseModules());
}

/** Loads the same base projection plus the instance-only host exports. */
export async function loadOmpInstancePorts(): Promise<OmpInstancePorts> {
  const [base, discovery, settings, registry] = await Promise.all([
    loadBaseModules(),
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-coding-agent/task/discovery"),
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    // @ts-expect-error -- host-supplied runtime module; exports validated below.
    import("@oh-my-pi/pi-coding-agent/config/registry"),
  ]);
  return createOmpInstancePorts({ ...base, discovery, settings, registry });
}
