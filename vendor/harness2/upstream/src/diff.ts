import { lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { safeDisplay } from "./commands.ts";
import type { Change, RunRecord } from "./types.ts";

const DEFAULT_LIMIT = 48_000;

function checkedFile(root: string, relative: string): string {
  if (!relative || isAbsolute(relative) || relative.includes("\\") || relative.includes("\0") || relative.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === ".harness2")) {
    throw new Error("Unsafe path in diff preview.");
  }
  if (lstatSync(root).isSymbolicLink()) throw new Error("Diff root cannot be a symbolic link.");
  let current = realpathSync(root);
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Diff preview cannot follow symbolic links.");
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new Error("Diff preview requires regular files.");
  }
  return current;
}

/** Human review only: the original persisted snapshot and selected run remain authoritative. */
export function renderDiff(record: RunRecord, changes: Change[], maxCharacters = DEFAULT_LIMIT): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 100 || maxCharacters > 1_000_000) throw new Error("Invalid diff preview limit.");
  if (!record.snapshot || !record.winner) throw new Error("This run has no selected output to review.");
  const candidate = record.stages[record.winner]?.cwd;
  if (!candidate) throw new Error("The selected workspace is missing.");
  if (!changes.length) return "The selected result has no file changes.";
  let output = "";
  let truncated = false;
  for (const change of changes) {
    const before = change.kind === "add" ? "/dev/null" : checkedFile(record.snapshot.root, change.path);
    const after = change.kind === "delete" ? "/dev/null" : checkedFile(candidate, change.path);
    const result = spawnSync("git", ["--no-pager", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", before, after], {
      encoding: "utf8",
      maxBuffer: Math.max(64_000, Math.min(maxCharacters * 4, 4_000_000)),
      timeout: 5000,
      env: { ...process.env, GIT_PAGER: "cat", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" },
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOBUFS") {
      output += `\n${change.kind}: ${JSON.stringify(change.path)}\n[This file exceeds the preview limit.]\n`;
      truncated = true;
      break;
    }
    if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error(`Cannot render diff: ${safeDisplay(result.error?.message ?? result.stderr).slice(0, 500)}`);
    const a = JSON.stringify(`a/${change.path}`);
    const b = JSON.stringify(`b/${change.path}`);
    let inHunk = false;
    const patch = result.stdout.split("\n").map((line) => {
      if (line.startsWith("@@ ")) inHunk = true;
      // Only metadata contains host paths. Hunk lines can also begin with --- or +++.
      if (inHunk) return line;
      if (line.startsWith("diff --git ")) return `diff --git ${a} ${b}`;
      if (line.startsWith("--- ")) return `--- ${change.kind === "add" ? "/dev/null" : a}`;
      if (line.startsWith("+++ ")) return `+++ ${change.kind === "delete" ? "/dev/null" : b}`;
      if (line.startsWith("Binary files ")) return `Binary files ${a} and ${b} differ`;
      return line;
    }).join("\n");
    output += `\n${change.kind}: ${JSON.stringify(change.path)}\n${safeDisplay(patch)}`;
    if (output.length > maxCharacters) {
      output = output.slice(0, maxCharacters);
      truncated = true;
      break;
    }
  }
  return output.trim() + (truncated ? "\n\n[Preview truncated. Inspect the selected workspace files before applying.]" : "");
}
