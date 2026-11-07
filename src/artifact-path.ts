import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export type ArtifactPathCode = "invalid-path" | "missing" | "unsafe-path" | "changed";

export class ArtifactPathError extends Error {
  override name = "ArtifactPathError";
  constructor(message: string, readonly code: ArtifactPathCode) {
    super(message);
  }
}

export interface ArtifactLocation {
  /** Canonical workspace root as returned by realpath. */
  root: string;
  /** Policy-relative POSIX path, for example `reports/out.txt`. */
  relative: string;
  /** Absolute target path below the canonical root. */
  absolute: string;
  /** Verified parent directory below the canonical root. */
  parent: string;
  /** Final path component. */
  name: string;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function segmentsOf(relativePath: string): string[] {
  if (
    typeof relativePath !== "string"
    || relativePath.length < 1
    || relativePath.length > 1024
    || relativePath.includes("\\")
    || path.isAbsolute(relativePath)
  ) {
    throw new ArtifactPathError("Artifact path must be a relative POSIX path.", "invalid-path");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || /[\x00-\x1f\x7f]/.test(segment))) {
    throw new ArtifactPathError("Artifact path contains an empty or traversing segment.", "invalid-path");
  }
  return segments;
}

/**
 * Resolves one policy-relative artifact path below a canonical workspace root.
 *
 * Every existing parent is checked with lstat and realpath before use, so a
 * symlinked parent cannot redirect the target outside the bound workspace.
 * Missing parents are either rejected (`createParents: false`) or created with
 * mode 0700 and rechecked (`createParents: true`).
 *
 * This is a path-containment check, not an OS sandbox. A same-user process can
 * still replace a checked component before a later open; callers that read or
 * write must use O_NOFOLLOW and compare device/inode/size before and after I/O.
 */
export async function resolveArtifactLocation(
  workspaceRoot: string,
  relativePath: string,
  options: { createParents?: boolean } = {},
): Promise<ArtifactLocation> {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new ArtifactPathError("Workspace root must be absolute.", "invalid-path");
  }
  let root: string;
  try {
    root = await realpath(workspaceRoot);
  } catch (error) {
    if (isMissing(error)) throw new ArtifactPathError("Workspace root does not exist.", "missing");
    throw new ArtifactPathError("Workspace root could not be resolved.", "changed");
  }
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new ArtifactPathError("Workspace root must resolve to a directory.", "unsafe-path");
  }

  const segments = segmentsOf(relativePath);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    let info;
    try {
      info = await lstat(parent);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!options.createParents) {
        throw new ArtifactPathError("Artifact parent directory does not exist.", "missing");
      }
      await mkdir(parent, { mode: 0o700 });
      info = await lstat(parent);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ArtifactPathError("Artifact path traverses a link or non-directory.", "unsafe-path");
    }
    const canonical = await realpath(parent);
    if (canonical !== parent || !isContained(root, canonical)) {
      throw new ArtifactPathError("Artifact parent escaped the bound workspace.", "unsafe-path");
    }
  }

  const name = segments.at(-1)!;
  const absolute = path.join(parent, name);
  if (!isContained(root, absolute) || absolute === root) {
    throw new ArtifactPathError("Artifact path escapes the bound workspace.", "invalid-path");
  }
  return Object.freeze({ root, relative: segments.join("/"), absolute, parent, name });
}
