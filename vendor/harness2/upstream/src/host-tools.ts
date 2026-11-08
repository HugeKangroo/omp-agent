import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export interface HostToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  loadMode: "essential";
}

export interface HostToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface HostToolOptions {
  /** Only solver workers should receive write access. Defaults to false. */
  writable?: boolean;
  maxFileBytes?: number;
  maxEntries?: number;
  /** Exact URI -> UTF-8 text map. Read-only and never materialized on disk. */
  virtualResources?: Readonly<Record<string, string>>;
}

export interface HostTools {
  definitions: HostToolDefinition[];
  execute(name: string, args: unknown, signal?: AbortSignal): Promise<HostToolResult>;
}

const PROTECTED_SEGMENTS = new Set([
  ".git", ".omp", ".pi", ".harness2", ".harness2-origin.json", ".agents", ".codex", ".aws", ".claude", ".gemini", ".ssh", ".gnupg",
  "agents.md", "claude.md", "gemini.md", "node_modules", ".venv", "venv",
]);
// Keep aligned with workspace.ts: candidate outputs containing these cannot be applied.
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|service[-_]account[^/]*\.json)$|\.(?:pem|key|p12|pfx|keystore)$/i;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRIES = 1000;
const PAGE_METADATA_RESERVE = 1024;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class ToolBoundaryError extends Error {}

function fail(message: string): never {
  throw new ToolBoundaryError(message);
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) fail("Operation cancelled.");
}

function isProtected(segment: string): boolean {
  const lower = segment.toLowerCase();
  return PROTECTED_SEGMENTS.has(lower) || SECRET_NAME.test(lower);
}

function relativeParts(value: unknown, allowRoot: boolean): string[] {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    fail("Provide a relative workspace path of at most 4096 characters.");
  }
  if (allowRoot && (value === "." || value === "")) return [];
  if (!value || path.isAbsolute(value) || value.includes("\\") || URI_SCHEME.test(value)) {
    fail("Absolute paths, URIs and backslashes are not allowed for workspace files.");
  }
  const parts = value.split("/");
  if (parts.length > 128 || parts.some((part) => !part || part === "." || part === "..")) {
    fail("Path traversal, empty segments, and dot segments are not allowed.");
  }
  if (parts.some(isProtected)) fail("Access to control directories and credential files is not allowed.");
  return parts;
}

function inputObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("Tool arguments must be an object.");
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => !allowed.includes(key))) fail("Unknown tool argument.");
  return args;
}

function positiveLimit(value: number | undefined, fallback: number, ceiling: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > ceiling) {
    throw new TypeError(`Host tool limit must be an integer between 1 and ${ceiling}.`);
  }
  return result;
}

function sameNode(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function result(text: string, details?: unknown): HostToolResult {
  return { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) };
}

/**
 * Fixed RPC tools for a private workspace copy. The model cannot create links,
 * spawn processes, choose tool code, or address paths outside this root.
 *
 * This is an application boundary, not an OS sandbox. Node does not expose an
 * openat2-style directory-relative resolver on all supported platforms. The
 * inode checks and O_NOFOLLOW below reject ordinary link/path substitution, but
 * cannot prove containment against another local process racing ancestor moves
 * between syscalls. Run against a private workspace not writable by an attacker;
 * use an OS sandbox if hostile local processes are in the threat model.
 */
export async function createHostTools(workspace: string, options: HostToolOptions = {}): Promise<HostTools> {
  const originalRoot = path.resolve(workspace);
  const originalRootStat = await lstat(originalRoot);
  if (originalRootStat.isSymbolicLink() || !originalRootStat.isDirectory()) {
    throw new ToolBoundaryError("Workspace root must be a real directory, not a symbolic link.");
  }
  // Canonicalize system ancestors (e.g. macOS /tmp -> /private/tmp) once.
  const root = await realpath(originalRoot);
  const rootIdentity = await lstat(root);
  const maxFileBytes = positiveLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 16 * 1024 * 1024);
  if (maxFileBytes < PAGE_METADATA_RESERVE * 2) throw new TypeError("maxFileBytes must be at least 2048 bytes to include pagination metadata.");
  const maxReadBytes = maxFileBytes - PAGE_METADATA_RESERVE;
  // Leave ample room for the RPC envelope even when callers configure larger file pages.
  const maxListBytes = Math.min(maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxEntries = positiveLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, 100_000);
  const writable = options.writable === true;
  const virtualResources = new Map<string, Buffer>();
  for (const [uri, body] of Object.entries(options.virtualResources ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+$/.test(uri) || /[\x00-\x1f\x7f]/.test(uri) || typeof body !== "string") {
      throw new TypeError("Virtual resources must map exact absolute URIs to strings.");
    }
    virtualResources.set(uri, Buffer.from(body, "utf8"));
  }

  function readWindow(args: Record<string, unknown>): { offset: number; length: number } {
    const offset = args.offset ?? 0;
    const length = args.length ?? maxReadBytes;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) fail("offset must be a nonnegative integer UTF-8 byte offset.");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 1 || length > maxReadBytes) {
      fail(`length must be an integer between 1 and ${maxReadBytes} bytes.`);
    }
    return { offset, length };
  }

  function pageResult(buffer: Buffer, offset: number, length: number, totalBytes: number): HostToolResult {
    if (offset > totalBytes) fail("offset exceeds the resource size.");
    if (buffer.length && (buffer[0]! & 0xc0) === 0x80) fail("offset must be on a UTF-8 character boundary; use nextOffset from the preceding page.");
    const trimBoundary = (value: number): number => {
      let end = value;
      while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
      return end;
    };
    let end = trimBoundary(Math.min(length, buffer.length));
    for (;;) {
      if (end === 0 && offset < totalBytes) fail("length is too small for the next UTF-8 character; request at least 4 bytes.");
      let text;
      try { text = textDecoder.decode(buffer.subarray(0, end)); }
      catch { fail("The requested page is not valid UTF-8 text."); }
      const truncated = offset + end < totalBytes;
      const pagination = { offset, bytes: end, totalBytes, nextOffset: truncated ? offset + end : null, truncated };
      const output: HostToolResult = {
        content: [{ type: "text", text }, { type: "text", text: JSON.stringify({ pagination }) }],
        details: pagination,
      };
      // Bound the entire serialized result as well as raw text, including JSON
      // escaping of control characters and the model-visible pagination block.
      const size = Buffer.byteLength(JSON.stringify(output), "utf8");
      if (size <= maxFileBytes) return output;
      end = trimBoundary(Math.max(1, Math.floor(end * (maxFileBytes - PAGE_METADATA_RESERVE) / size)));
    }
  }

  async function assertRoot(): Promise<void> {
    const current = await lstat(root);
    const original = await lstat(originalRoot);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(current, rootIdentity)
      || original.isSymbolicLink() || !sameNode(original, rootIdentity)
      || await realpath(originalRoot) !== root) {
      fail("Workspace root changed; refusing access.");
    }
  }

  async function directory(parts: string[], create: boolean, signal?: AbortSignal): Promise<string> {
    await assertRoot();
    let current = root;
    for (const part of parts) {
      checkSignal(signal);
      current = path.join(current, part);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (!create || !isMissing(error)) throw error;
        await mkdir(current, { mode: 0o700 });
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) fail("Path components must be real directories; links are not allowed.");
      if (await realpath(current) !== current) fail("Directory path changed; refusing access.");
    }
    await assertRoot();
    return current;
  }

  async function validateFile(parts: string[], signal?: AbortSignal): Promise<{ full: string; info: Stats }> {
    const parent = await directory(parts.slice(0, -1), false, signal);
    const full = path.join(parent, parts.at(-1)!);
    const info = await lstat(full);
    if (info.isSymbolicLink() || !info.isFile()) fail("Only regular files are allowed; links and special files are not supported.");
    if (info.nlink !== 1) fail("Hard-linked files are not allowed.");
    return { full, info };
  }

  async function readFile(args: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolResult> {
    const { offset, length } = readWindow(args);
    if (typeof args.path === "string" && URI_SCHEME.test(args.path)) {
      const resource = virtualResources.get(args.path);
      if (!resource) fail("Unknown virtual resource URI.");
      checkSignal(signal);
      return pageResult(resource.subarray(offset, offset + length + 3), offset, length, resource.length);
    }
    const parts = relativeParts(args.path, false);
    const { full, info } = await validateFile(parts, signal);
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !sameNode(opened, info)) fail("File changed while opening; refusing access.");
      const verified = await validateFile(parts, signal);
      if (!sameNode(opened, verified.info)) fail("File changed while opening; refusing access.");
      if (offset > opened.size) fail("offset exceeds the resource size.");
      checkSignal(signal);
      // Up to three lookahead bytes let us stop on a complete code point without
      // reading or decoding the whole file, even for very large evidence logs.
      const buffer = Buffer.alloc(Math.min(length + 3, opened.size - offset));
      let readBytes = 0;
      while (readBytes < buffer.length) {
        const next = await handle.read(buffer, readBytes, buffer.length - readBytes, offset + readBytes);
        if (!next.bytesRead) break;
        readBytes += next.bytesRead;
        checkSignal(signal);
      }
      const after = await validateFile(parts, signal);
      const afterFd = await handle.stat();
      if (!sameNode(opened, after.info) || opened.size !== afterFd.size || opened.mtimeMs !== afterFd.mtimeMs || opened.ctimeMs !== afterFd.ctimeMs) {
        fail("File changed while reading; refusing the result.");
      }
      return pageResult(buffer.subarray(0, readBytes), offset, length, opened.size);
    } finally { await handle.close(); }
  }

  async function writeFile(args: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolResult> {
    if (!writable) fail("This worker has read-only workspace access.");
    const parts = relativeParts(args.path, false);
    if (parts.some((part) => part.toLowerCase() === ".harness-evidence")) {
      fail("The .harness-evidence directory is reserved for read-only evidence.");
    }
    if (typeof args.content !== "string") fail("content must be a UTF-8 string.");
    const bytes = Buffer.from(args.content, "utf8");
    if (bytes.length > maxFileBytes) fail(`Content exceeds the ${maxFileBytes}-byte limit.`);
    const parent = await directory(parts.slice(0, -1), true, signal);
    const full = path.join(parent, parts.at(-1)!);
    const parentIdentity = await lstat(parent);
    let existed = true;
    let initial: Stats | undefined;
    try {
      initial = (await validateFile(parts, signal)).info;
    } catch (error) {
      if (!isMissing(error)) throw error;
      existed = false;
    }
    checkSignal(signal);
    const flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      | (existed ? 0 : constants.O_CREAT | constants.O_EXCL);
    const handle = await open(full, flags, 0o600);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || (initial && !sameNode(opened, initial))) {
        fail("File changed while opening; refusing the write.");
      }
      const verified = await validateFile(parts, signal);
      if (!sameNode(opened, verified.info) || !sameNode(parentIdentity, await lstat(parent))) {
        fail("Path changed while opening; refusing the write.");
      }
      checkSignal(signal);
      // Never follow the pathname after opening and verifying the file descriptor.
      await handle.truncate(0);
      await handle.writeFile(bytes);
      await handle.sync();
      const after = await validateFile(parts, signal);
      if (!sameNode(opened, after.info) || !sameNode(parentIdentity, await lstat(parent))) {
        fail("Path changed while writing; workspace requires inspection.");
      }
      return result(`Wrote ${bytes.length} bytes to ${parts.join("/")}.`, { path: parts.join("/"), bytes: bytes.length });
    } finally { await handle.close(); }
  }

  async function listFiles(args: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolResult> {
    const parts = relativeParts(args.path ?? ".", true);
    if (args.recursive !== undefined && typeof args.recursive !== "boolean") fail("recursive must be a boolean.");
    const offset = args.offset === undefined ? 0 : args.offset;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) fail("offset must be a nonnegative integer entry offset.");
    const start = await directory(parts, false, signal);
    const entries: Array<{ path: string; type: "file" | "directory"; bytes?: number }> = [];
    const pending = [{ full: start, parts }];
    let skipped = 0;
    let truncated = false;
    let visited = 0;
    let responseBytes = PAGE_METADATA_RESERVE;
    while (pending.length) {
      checkSignal(signal);
      const next = pending.shift()!;
      await directory(next.parts, false, signal);
      const children = (await readdir(next.full)).sort();
      for (const name of children) {
        checkSignal(signal);
        if (isProtected(name)) { skipped++; continue; }
        const childParts = [...next.parts, name];
        // Filesystem names can contain backslashes and control characters even
        // though tool callers cannot address them. Keep them outside the surface.
        try { relativeParts(childParts.join("/"), false); }
        catch { skipped++; continue; }
        const child = path.join(next.full, name);
        const info = await lstat(child);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) {
          skipped++;
          continue;
        }
        const entry: typeof entries[number] = { path: childParts.join("/"), type: info.isDirectory() ? "directory" : "file", ...(info.isFile() ? { bytes: info.size } : {}) };
        if (visited >= offset) {
          if (entries.length >= maxEntries) { truncated = true; break; }
          const encoded = JSON.stringify(entry);
          // Entries appear both in details and inside the JSON text block. Count
          // both encodings, including escaping and a conservative comma allowance.
          const entryBytes = Buffer.byteLength(encoded) + Buffer.byteLength(JSON.stringify(encoded));
          if (responseBytes + entryBytes > maxListBytes) {
            if (!entries.length) fail("A directory entry exceeds the listing response budget.");
            truncated = true;
            break;
          }
          responseBytes += entryBytes;
          entries.push(entry);
        }
        visited++;
        if (info.isDirectory() && args.recursive === true) pending.push({ full: child, parts: childParts });
      }
      if (truncated) break;
    }
    await assertRoot();
    if (offset > visited) fail("offset exceeds the directory listing size.");
    const data = { entries, skipped, truncated, offset, nextOffset: truncated ? offset + entries.length : null };
    return result(JSON.stringify(data), data);
  }

  const definitions: HostToolDefinition[] = [
    {
      name: "list_files",
      loadMode: "essential",
      description: `List a page of files in the private workspace, optionally recursively. Uses sorted breadth-first order, at most ${maxEntries} entries and a ${maxListBytes}-byte total response budget. Follow nextOffset until null, keeping path and recursive unchanged; restart from offset 0 after workspace edits. Links, control directories and credential files are excluded.`,
      parameters: { type: "object", properties: { path: { type: "string", description: 'Relative directory; "." means the workspace root.' }, recursive: { type: "boolean" }, offset: { type: "integer", minimum: 0, description: "Zero-based entry offset (default 0). Use nextOffset from the preceding page." } }, additionalProperties: false },
    },
    {
      name: "read_file",
      loadMode: "essential",
      description: `Read a UTF-8 page from a regular workspace file or an explicitly provided virtual resource URI. offset is a zero-based byte offset (default 0); length is a maximum byte count (default ${maxReadBytes}). The first text block is content; the second reports pagination. Follow nextOffset until null; page ends are shortened to character boundaries and the ${maxFileBytes}-byte total response budget. Workspace links and control/credential files are forbidden.`,
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0, description: "Zero-based UTF-8 byte offset. Use the prior page's nextOffset to avoid splitting a character." }, length: { type: "integer", minimum: 1, maximum: maxReadBytes, description: "Maximum content bytes; the page may be shortened to fit UTF-8 boundaries and response metadata." } }, required: ["path"], additionalProperties: false },
    },
  ];
  if (writable) definitions.push({
    name: "write_file",
    loadMode: "essential",
    description: `Create or replace a UTF-8 file inside the private workspace, up to ${maxFileBytes} bytes. Creates missing parent directories. No shell, links, absolute paths, control/credential files, or writes under the read-only .harness-evidence directory.`,
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
  });

  // Serialize our own operations so parallel model tool calls cannot race paths.
  let queue = Promise.resolve();
  return {
    definitions,
    execute(name, args, signal) {
      const operation = queue.then(async (): Promise<HostToolResult> => {
        try {
          checkSignal(signal);
          if (name === "read_file") return await readFile(inputObject(args, ["path", "offset", "length"]), signal);
          if (name === "write_file") return await writeFile(inputObject(args, ["path", "content"]), signal);
          if (name === "list_files") return await listFiles(inputObject(args, ["path", "recursive", "offset"]), signal);
          fail("Unknown host tool.");
        } catch (error) {
          const message = error instanceof ToolBoundaryError ? error.message
            : isMissing(error) ? "Requested file or directory does not exist."
            : "Workspace operation failed; no additional filesystem access was granted.";
          return { ...result(message), isError: true };
        }
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}
