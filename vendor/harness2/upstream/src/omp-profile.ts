import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";
export interface OmpProfileAuth {
  kind: "omp-profile";
  agentDir: string;
}
export function validateOmpProfileAuth(value: OmpProfileAuth): void {
  if (
    !value ||
    value.kind !== "omp-profile" ||
    Object.keys(value).some((k) => !["kind", "agentDir"].includes(k)) ||
    typeof value.agentDir !== "string" ||
    !isAbsolute(value.agentDir) ||
    /[\x00-\x1f]/.test(value.agentDir)
  )
    throw new Error("Invalid OMP profile authentication source");
}
/** Inspect names, types and availability only. Never select credential data, account identities or tokens. */
export async function inspectOmpProfile(
  agentDir: string,
): Promise<{
  auth: OmpProfileAuth;
  modelRoles: Record<string, string>;
  credentials: Array<{
    provider: string;
    type: string;
    count: number;
    enabled: number;
  }>;
}> {
  const auth: OmpProfileAuth = { kind: "omp-profile", agentDir };
  validateOmpProfileAuth(auth);
  const info = await lstat(agentDir);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("OMP agent directory must be a real directory");
  const config = Bun.YAML.parse(
    await readFile(join(agentDir, "config.yml"), "utf8"),
  ) as { modelRoles?: Record<string, unknown> };
  const db = new Database(join(agentDir, "agent.db"), { readonly: true });
  try {
    const rows = db
      .query(
        "SELECT provider, credential_type AS type, COUNT(*) AS count, SUM(CASE WHEN disabled_cause IS NULL THEN 1 ELSE 0 END) AS enabled FROM auth_credentials GROUP BY provider, credential_type",
      )
      .all() as Array<{
      provider: string;
      type: string;
      count: number;
      enabled: number;
    }>;
    return {
      auth,
      modelRoles: Object.fromEntries(
        Object.entries(config.modelRoles ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      credentials: rows,
    };
  } finally {
    db.close();
  }
}
