import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPolicy,
  parsePolicy,
  policyFingerprint,
  recheckLoadedPolicy,
} from "../../src/policy.ts";

const FIXTURE = fileURLToPath(new URL("../../policy/development-fixture.v1.json", import.meta.url));
const validBytes = await readFile(FIXTURE);
const validValue = JSON.parse(validBytes.toString("utf8")) as Record<string, unknown>;
const validFingerprint = policyFingerprint(validBytes);

function altered(mutate: (value: Record<string, any>) => void): unknown {
  const copy = structuredClone(validValue);
  mutate(copy);
  return copy;
}

describe("versioned managed policy", () => {
  test("accepts the explicit development fixture policy and exposes a stable fingerprint", () => {
    const policy = parsePolicy(validValue);
    expect(policy.policyId).toBe("omp-agent.g1a-development-fixture");
    expect(policy.policyVersion).toBe(1);
    expect(policy.scope).toBe("development-fixture");
    expect(policy.managedTool.deliverablePath).toBe("deliverable.txt");
    expect(policy.preToolCheck).toEqual({ required: true, businessToolRecheck: true });
    expect(validFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(policyFingerprint(validBytes)).toBe(validFingerprint);
  });

  test("loads only with the host-provided fingerprint", async () => {
    const loaded = await loadPolicy(FIXTURE, validFingerprint);
    expect(loaded.policy.policyVersion).toBe(1);
    await expect(loadPolicy(FIXTURE, "0".repeat(64))).rejects.toThrow(/fingerprint/);
  });

  test("rejects schema, scope, path, tool, check and size drift", () => {
    expect(() => parsePolicy(altered((value) => { value.schemaVersion = 2; }))).toThrow(/schemaVersion/);
    expect(() => parsePolicy(altered((value) => { value.policyVersion = 0; }))).toThrow(/policyVersion/);
    expect(() => parsePolicy(altered((value) => { value.scope = "unscoped"; }))).toThrow(/scope/);
    expect(() => parsePolicy(altered((value) => { value.unknown = true; }))).toThrow(/unknown field/);
    expect(() => parsePolicy(altered((value) => { delete value.managedTool; }))).toThrow(/missing field/);
    expect(() => parsePolicy(altered((value) => { value.managedTool.name = "bash"; }))).toThrow(/managedTool.name/);
    expect(() => parsePolicy(altered((value) => { value.managedTool.deliverablePath = "../escape.txt"; }))).toThrow(/unsafe|segments/);
    expect(() => parsePolicy(altered((value) => { value.managedTool.deliverablePath = "/tmp/escape.txt"; }))).toThrow(/relative/);
    expect(() => parsePolicy(altered((value) => { value.managedTool.deliverablePath = ".git/config"; }))).toThrow(/unsafe/);
    expect(() => parsePolicy(altered((value) => { value.managedTool.maxContentBytes = 0; }))).toThrow(/maxContentBytes/);
    expect(() => parsePolicy(altered((value) => { value.preToolCheck.businessToolRecheck = false; }))).toThrow(/preToolCheck/);
  });

  test("a post-start policy change is rejected at the business recheck boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "g1a-policy-"));
    try {
      const policyPath = path.join(root, "policy.json");
      await writeFile(policyPath, validBytes);
      const loaded = await loadPolicy(policyPath, validFingerprint);
      expect((await recheckLoadedPolicy(loaded)).policyVersion).toBe(1);
      await writeFile(policyPath, `${JSON.stringify(altered((value) => { value.policyVersion = 2; }), null, 2)}\n`);
      await expect(recheckLoadedPolicy(loaded)).rejects.toThrow(/fingerprint/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
