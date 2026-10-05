/**
 * Session workspace files for the people who own the session: list, read,
 * write, make folders, move, delete and zip, inside the folders of one
 * session, on this process's own mount of the workspace roots (the portal's
 * Workspace pane).
 *
 * Rules:
 * - Paths are relative to one of the session's folders and must stay inside
 *   it, symlinks included.
 * - Every file call runs in a child process with a deadline, so a hung mount
 *   cannot hang the caller (the same rule as a workspace provider's).
 * - Files inside `.git`, and a root's `.pilotswarm-export` marker, are read-only.
 * - Files larger than `maxBytes` are not read or written; a folder zip is
 *   limited to `maxBytes` of files in all.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { SessionWorkspaceView } from "./types.js";

export const DEFAULT_WORKSPACE_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_WORKSPACE_FILE_TIMEOUT_MS = 30_000;
export const MAX_WORKSPACE_DIR_ENTRIES = 5_000;
/**
 * How many file calls run at once in this process, per kind. A call that
 * carries a whole file (read, write, zip, move) holds it several times over
 * while it runs: bytes, base64 and JSON, in the child and here. So only a
 * few of those run together; lighter calls have their own lane.
 */
const FILE_CALL_LANES = {
    whole: { max: 2, running: 0, waiting: [] as Array<() => void> },
    light: { max: 6, running: 0, waiting: [] as Array<() => void> },
};
const WHOLE_FILE_OPS = new Set(["read", "write", "zip", "move"]);
/** How long a call waits for its turn before it fails busy: a hung mount must not hold everyone's calls. */
export const DEFAULT_FILE_CALL_WAIT_MS = 10_000;

/** Where this process can reach the workspace roots, and the limits. */
export interface WorkspaceFilesConfig {
    /** The roots this process serves, by the same names the workers' provider uses. */
    roots: Array<{ name: string; path: string }>;
    /** The largest file, and the largest folder zip (its files in all), in bytes. Default 20 MB. */
    maxBytes?: number;
    /** The deadline for one file call. Default 30 s. */
    timeoutMs?: number;
    /** How long a call waits for its turn before it fails busy. Default 10 s. */
    queueWaitMs?: number;
    /**
     * Refuse a root without its `.pilotswarm-export` marker (an unmounted
     * share looks like an empty local folder). Default true.
     */
    requireMarker?: boolean;
    /** The most entries one folder listing returns. Default 5,000. */
    maxEntries?: number;
}

export const WORKSPACE_FILE_ERROR_CODES = {
    DISABLED: "WORKSPACE_FILES_DISABLED",
    FOLDER_UNKNOWN: "WORKSPACE_FILES_FOLDER_UNKNOWN",
    NOT_OPENED: "WORKSPACE_FILES_NOT_OPENED",
    ROOT_UNAVAILABLE: "WORKSPACE_FILES_ROOT_UNAVAILABLE",
    PATH_INVALID: "WORKSPACE_FILES_PATH_INVALID",
    OUTSIDE: "WORKSPACE_FILES_OUTSIDE",
    NOT_FOUND: "WORKSPACE_FILES_NOT_FOUND",
    EXISTS: "WORKSPACE_FILES_EXISTS",
    CONFLICT: "WORKSPACE_FILES_CONFLICT",
    READ_ONLY: "WORKSPACE_FILES_READ_ONLY",
    TOO_LARGE: "WORKSPACE_FILES_TOO_LARGE",
    NOT_A_FILE: "WORKSPACE_FILES_NOT_A_FILE",
    NOT_A_FOLDER: "WORKSPACE_FILES_NOT_A_FOLDER",
    NOT_EMPTY: "WORKSPACE_FILES_NOT_EMPTY",
    TIMEOUT: "WORKSPACE_FILES_TIMEOUT",
    BUSY: "WORKSPACE_FILES_BUSY",
    IO: "WORKSPACE_FILES_IO",
} as const;

const C = WORKSPACE_FILE_ERROR_CODES;

/** The HTTP status for a workspace file error code. */
export function workspaceFileErrorStatus(code: string): number {
    switch (code) {
        case C.NOT_FOUND:
        case C.FOLDER_UNKNOWN:
            return 404;
        case C.CONFLICT:
        case C.EXISTS:
        case C.NOT_EMPTY:
        case C.NOT_OPENED:
            return 409;
        case C.READ_ONLY:
            return 403;
        case C.TOO_LARGE:
            return 413;
        case C.TIMEOUT:
            return 504;
        case C.BUSY:
        case C.DISABLED:
        case C.ROOT_UNAVAILABLE:
            return 503;
        case C.IO:
            return 500;
        default:
            return 400;
    }
}

/** An error with the workspace file `code` and its HTTP `status`. */
export function workspaceFileError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
    // A 5xx with a fixed message the caller should see (the Web API hides
    // other 5xx messages). Not IO: its message can hold a path on the server.
    const expose = code === C.TIMEOUT || code === C.BUSY || code === C.DISABLED || code === C.ROOT_UNAVAILABLE;
    return Object.assign(new Error(message), { code, status: workspaceFileErrorStatus(code), ...(expose ? { expose: true } : {}) }, extra);
}
const fileError = workspaceFileError;

/** One call on a session's workspace files. Paths are relative to the folder. */
export type WorkspaceFileCall =
    | { op: "list" | "stat" | "read" | "mkdir"; folder: string; path?: string }
    | { op: "zip"; folder: string; path?: string; paths?: string[] }
    | { op: "find"; folder: string; path?: string; query: string }
    | { op: "write"; folder: string; path: string; contentBase64: string; ifMatch?: string | null; createParents?: boolean }
    | { op: "delete"; folder: string; path: string; recursive?: boolean }
    | { op: "move"; folder: string; path: string; toFolder?: string; toPath: string };

export const WORKSPACE_FILE_OPS = ["list", "stat", "read", "zip", "find", "mkdir", "write", "delete", "move"] as const;

// ─── Telling the agent what the owner changed ─────────────────────────

/** A change the session's owner made through a file call (list, stat, read and zip change nothing). */
export interface WorkspaceFileChange {
    /** "run": a canvas app ran one of its declared commands (it may have changed files). "git": the Workspace tab moved the repository. */
    op: "write" | "mkdir" | "move" | "delete" | "run" | "git";
    /** The folder's name, as the pane shows it ("home", "shared", the repo's name). */
    folder: string;
    path: string;
    /** write: the file did not exist before. */
    created?: boolean;
    toFolder?: string;
    toPath?: string;
    /** run: the command's name in the canvas app's manifest. */
    command?: string;
    /** git: what the tab did in the repository (`path` is the repository's folder). */
    git?: { action: "checkout" | "restore"; to?: string; from?: string; detached?: boolean; stashed?: boolean };
}

/** Recorded by the file calls that change something. */
export const WORKSPACE_FILES_CHANGED_EVENT = "session.workspace_files_changed";
/** Recorded by the turn that told the agent: the changes up to `throughSeq` are noted. */
export const WORKSPACE_FILES_NOTED_EVENT = "session.workspace_files_noted";

/**
 * Which owner changes (session.workspace_files_changed) a turn tells the
 * model, from those events and the notes already recorded, in seq order:
 * those after the last note; or, for another attempt at the turn that
 * wrote the last note, that note's changes again (a retry must say the
 * same thing; later changes wait for the next turn).
 */
export function workspaceFileChangesToTell(
    events: Array<{ seq: number | string; eventType: string; data?: any }>,
    turnIndex: number,
): { changed: Array<{ seq: number | string; eventType: string; data?: any }>; from: number; again: boolean } {
    const noted = events.filter((event) => event.eventType === WORKSPACE_FILES_NOTED_EVENT);
    const last = noted[noted.length - 1];
    const again = Boolean(last) && Number(last!.data?.turnIndex) === turnIndex;
    const from = again ? Number(last!.data?.fromSeq) : Number(last?.data?.throughSeq ?? 0) + 1;
    const through = again ? Number(last!.data?.throughSeq) : Number.MAX_SAFE_INTEGER;
    const changed = events.filter((event) => event.eventType === WORKSPACE_FILES_CHANGED_EVENT
        && Number(event.seq) >= from && Number(event.seq) <= through);
    return { changed, from, again };
}
const MAX_NOTED_CHANGES = 20;

/**
 * The line the agent gets at its next turn about files its session's owner
 * changed in the portal since it last looked. Repeated saves of one file
 * are one change. Null when there is nothing to tell.
 */
export function workspaceFileChangesNote(changes: WorkspaceFileChange[]): string | null {
    const where = (folder: string | undefined, path: string | undefined) => (path ? `${folder || "?"}/${path}` : folder || "?");
    const phrases: string[] = [];
    for (const change of changes) {
        if (!change || typeof change !== "object") continue;
        const target = where(change.folder, change.path);
        const phrase = change.op === "write" ? `${change.created ? "added" : "edited"} ${target}`
            : change.op === "mkdir" ? `made folder ${target}`
            : change.op === "move" ? `moved ${target} to ${where(change.toFolder ?? change.folder, change.toPath)}`
            : change.op === "delete" ? `deleted ${target}`
            : change.op === "run" ? `ran the canvas command "${change.command ?? "?"}" in ${target}`
            : change.op === "git" && change.git?.action === "checkout"
                ? `${change.git.detached ? `checked out commit ${change.git.to} in ${target} (detached HEAD; it was on ${change.git.from})` : `switched ${target} back to branch ${change.git.to}`}${change.git.stashed ? "; their uncommitted changes are stashed" : ""}`
            : change.op === "git" && change.git?.action === "restore" ? `put their stashed changes back in ${target}`
            : null;
        if (!phrase) continue;
        const index = phrases.indexOf(phrase);
        if (index >= 0) phrases.splice(index, 1);
        phrases.push(phrase);
    }
    if (phrases.length === 0) return null;
    const shown = phrases.slice(-MAX_NOTED_CHANGES);
    const more = phrases.length - shown.length;
    return "Since your last turn, the session's owner changed files in the portal (the Workspace tab or a canvas app): "
        + `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}. `
        + "Read a file again before you rely on what you saw of it earlier.";
}

/** One folder of a session, as the Workspace pane shows it. */
export interface WorkspaceFileFolder {
    /** "working" for the working folder; "extra:<name>" for an extra folder. */
    id: string;
    /** What to call it: the working folder's own name, "home", or the extra folder's name. */
    name: string;
    role: "working" | "extra";
    /** The person's own folder (a deployment's default home folder). */
    home: boolean;
    root: string;
    /** Relative to the root; "" is the root itself. */
    folder: string;
    /**
     * A worker opened this folder for the session (its provider's rules
     * passed). A record names a folder before any worker checks it; the
     * portal serves only what a worker opened.
     */
    opened: boolean;
    /** Opened, and this process serves the folder's root. */
    available: boolean;
    /**
     * The folder's absolute path on this process's mount, the same path the
     * workers use (listSessionWorkspaceFolders only; the pane matches it
     * against the paths in the agent's tool calls). Not given to canvas apps.
     */
    base?: string;
}

/**
 * The folders of a session, from its workspace record and the default
 * folders its last turn used: the working folder first, then the extra
 * folders by name.
 */
export function workspaceFileFolders(view: SessionWorkspaceView | null | undefined, config?: WorkspaceFilesConfig | null): WorkspaceFileFolder[] {
    const served = new Set((config?.roots ?? []).map((root) => root.name));
    const folders: WorkspaceFileFolder[] = [];
    const record = view?.workspace ?? null;
    const defaults = view?.defaults ?? null;
    const add = (folder: Omit<WorkspaceFileFolder, "available">) => {
        if (folders.some((existing) => existing.id === folder.id)) return;
        folders.push({ ...folder, available: folder.opened && served.has(folder.root) });
    };
    // Opened = a worker reported the folder's path (session.workspace_changed
    // with path / extraPaths), or the worker chose it as a default folder
    // (session.workspace_defaults). A record alone is only a request.
    const extraPaths = view?.extraPaths ?? {};
    if (record) {
        const folder = record.folder ?? "";
        const opened = typeof view?.path === "string" && view.path.length > 0;
        add({ id: "working", name: lastSegment(folder) || record.root, role: "working", home: false, root: record.root, folder, opened });
    } else if (defaults?.workingFolder) {
        add({ id: "working", name: "home", role: "working", home: true, root: defaults.workingFolder.root, folder: defaults.workingFolder.folder ?? "", opened: true });
    }
    for (const [name, extra] of Object.entries(record?.extra ?? {})) {
        const opened = typeof extraPaths[name] === "string" && extraPaths[name].length > 0;
        add({ id: `extra:${name}`, name, role: "extra", home: false, root: extra.root, folder: extra.folder ?? "", opened });
    }
    for (const extra of defaults?.extra ?? []) {
        add({ id: `extra:${extra.name}`, name: extra.name, role: "extra", home: extra.home === true, root: extra.root, folder: extra.folder ?? "", opened: true });
    }
    return folders;
}

function lastSegment(folder: string): string {
    const parts = folder.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
}

/** A path inside a folder: relative, no NUL, at most 4096 characters. "" is the folder itself. */
export function checkWorkspaceFilePath(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw fileError(C.PATH_INVALID, "the path must be a string");
    if (value.length > 4096) throw fileError(C.PATH_INVALID, "the path is longer than 4096 characters");
    if (value.includes("\0")) throw fileError(C.PATH_INVALID, "the path has a NUL character");
    if (value.startsWith("/")) throw fileError(C.PATH_INVALID, "the path must be relative to the folder");
    return value.replace(/\/+$/, "");
}

/** The absolute folder a folder id names, on this process's mount. */
export function resolveWorkspaceFileFolder(folders: WorkspaceFileFolder[], folderId: unknown, config: WorkspaceFilesConfig): { folder: WorkspaceFileFolder; base: string; rootPath: string } {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (!folder) throw fileError(C.FOLDER_UNKNOWN, `the session has no folder "${String(folderId)}"`);
    if (folder.opened === false) throw fileError(C.NOT_OPENED, `the session's worker has not opened "${folder.name}" yet`);
    const root = config.roots.find((candidate) => candidate.name === folder.root);
    if (!root) throw fileError(C.ROOT_UNAVAILABLE, `this portal does not serve the root "${folder.root}"`);
    const base = folder.folder ? `${root.path.replace(/\/+$/, "")}/${folder.folder}` : root.path;
    return { folder, base, rootPath: root.path };
}

// ─── The child process ────────────────────────────────────────────────
// One call per process: a JSON request on stdin, a JSON answer on stdout.

/** The child's script, exported for tests that run it with a stubbed fs. */
export const FILES_SCRIPT = `
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const chunks = [];
let C = {};
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  let answer;
  try {
    const q = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    C = q.codes;
    answer = run(q);
  } catch (e) { answer = failure(e); }
  process.stdout.write(JSON.stringify(answer));
});
const err = (code, message, extra) => Object.assign(new Error(message), { psCode: code }, extra || {});
function failure(e) {
  if (e && e.psCode) return Object.assign({ ok: false, code: e.psCode, message: e.message }, e.etag !== undefined ? { etag: e.etag } : {}, e.size !== undefined ? { size: e.size } : {});
  const map = { ENOENT: C.NOT_FOUND, EACCES: C.READ_ONLY, EPERM: C.READ_ONLY, EROFS: C.READ_ONLY, EEXIST: C.EXISTS, ENOTEMPTY: C.NOT_EMPTY, EISDIR: C.NOT_A_FILE, ENOTDIR: C.NOT_A_FOLDER };
  const code = (e && map[e.code]) || C.IO;
  const message = code === C.READ_ONLY ? "the folder or file is read-only" : code === C.NOT_FOUND ? "no such file or folder" : String((e && e.message) || e);
  return { ok: false, code, message };
}
const inside = (child, parent) => { const r = path.relative(parent, child); return r === "" || !(r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r)); };
const tag = (buf) => "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
const mb = (n) => Math.round(n / 1048576) + " MB";
// Where a path lands. \`target\` is the path as written; \`real\` is where it
// really goes: the real path of its nearest existing part, then the rest.
// An unmounted root is an empty local folder, so a root without its marker
// is refused (writes would land on this machine's own disk).
function locate(base, rootPath, rel, q) {
  let realRoot;
  try { realRoot = fs.realpathSync(rootPath); } catch (e) { throw err(C.ROOT_UNAVAILABLE, "the root is missing here"); }
  if (q && q.requireMarker && !fs.existsSync(path.join(realRoot, ".pilotswarm-export"))) {
    throw err(C.ROOT_UNAVAILABLE, "the root is not mounted here: it has no .pilotswarm-export marker (or set PORTAL_WORKSPACE_REQUIRE_MARKER=false)");
  }
  let realBase;
  try { realBase = fs.realpathSync(base); } catch (e) { throw err(e.code === "ENOENT" ? C.NOT_FOUND : C.IO, "the folder is missing or unreadable"); }
  const target = path.resolve(realBase, rel || ".");
  if (!inside(target, realBase)) throw err(C.OUTSIDE, "the path leaves the folder");
  let probe = target;
  const rest = [];
  while (probe !== realBase && !fs.existsSync(probe)) { rest.unshift(path.basename(probe)); probe = path.dirname(probe); }
  const realProbe = fs.realpathSync(probe);
  if (!inside(realProbe, realBase)) throw err(C.OUTSIDE, "the path resolves outside the folder");
  const real = path.join(realProbe, ...rest);
  // Canvas apps never go through a link: their declared paths are checked
  // as written, so the path must be the place.
  if (q && q.noLinks && real !== target) throw err(C.OUTSIDE, "the path goes through a link; canvas apps do not follow links");
  return { realBase, realRoot, target, real, rel: path.relative(realBase, target) };
}
function protectedAt(loc, t) {
  if (!t) return null;
  if (path.relative(loc.realBase, t).split(path.sep).some((part) => part.toLowerCase() === ".git")) return "files inside .git are read-only here";
  if (path.basename(t).toLowerCase() === ".pilotswarm-export" && path.dirname(t) === loc.realRoot) return "the root's marker file is read-only";
  return null;
}
// Read-only: the path as written, and where it really goes (a link to .git
// is .git; on a disk that ignores case, .GIT is .git).
function protectedWhy(loc, target, real) {
  if (target) return protectedAt(loc, target) || protectedAt(loc, real);
  return protectedAt(loc, loc.target) || protectedAt(loc, loc.real);
}
function realOr(p, fallback) { try { return fs.realpathSync(p); } catch { return fallback; } }
function kindOf(st) { return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other"; }
function canWrite(p) { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } }
function run(q) {
  if (q.op === "move") return move(q);
  const loc = locate(q.base, q.rootPath, q.path, q);
  switch (q.op) {
    case "list": return list(loc, q);
    case "stat": return stat(loc, q);
    case "read": return read(loc, q);
    case "write": return write(loc, q);
    case "mkdir": return mkdir(loc);
    case "delete": return remove(loc, q);
    case "zip": return zip(loc, q);
    case "find": return find(loc, q);
    case "repos": return repos(loc, q);
    default: throw err(C.PATH_INVALID, "unknown operation");
  }
}
function list(loc, q) {
  const st = fs.statSync(loc.target);
  if (!st.isDirectory()) throw err(C.NOT_A_FOLDER, "not a folder");
  // Folders first, then by name, BEFORE the cut: a long folder keeps its
  // subfolders and the first names, not whatever the disk returned first.
  const dirents = fs.readdirSync(loc.target, { withFileTypes: true })
    .sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const readOnlyHere = Boolean(protectedWhy(loc)) || !canWrite(loc.target);
  const entries = [];
  for (const d of dirents.slice(0, q.maxEntries)) {
    const full = path.join(loc.target, d.name);
    const entry = { name: d.name, kind: "other", size: 0, mtimeMs: 0 };
    try {
      const l = fs.lstatSync(full);
      entry.mtimeMs = l.mtimeMs;
      if (l.isSymbolicLink()) {
        entry.kind = "link";
        try {
          const real = fs.realpathSync(full);
          if (!inside(real, loc.realBase)) entry.target = "outside";
          else { const s = fs.statSync(real); entry.target = kindOf(s); entry.size = s.isFile() ? s.size : 0; }
        } catch { entry.target = "missing"; }
      } else {
        entry.kind = kindOf(l);
        if (l.isFile()) entry.size = l.size;
      }
      const realFull = entry.kind === "link" ? realOr(full, null) : path.join(loc.real, d.name);
      if (readOnlyHere || protectedWhy(loc, full, realFull) || (entry.kind !== "link" && !canWrite(full))) entry.readOnly = true;
    } catch {}
    entries.push(entry);
  }
  const isDir = (e) => e.kind === "dir" || (e.kind === "link" && e.target === "dir");
  entries.sort((a, b) => (isDir(b) - isDir(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { ok: true, entries, truncated: dirents.length > q.maxEntries, readOnly: readOnlyHere };
}
function stat(loc, q) {
  const real = fs.realpathSync(loc.target);
  const st = fs.statSync(real);
  const answer = { ok: true, kind: kindOf(st), size: st.isFile() ? st.size : 0, mtimeMs: st.mtimeMs };
  if (st.isFile() && st.size <= q.maxBytes) answer.etag = tag(fs.readFileSync(real));
  return answer;
}
function read(loc, q) {
  const real = fs.realpathSync(loc.target);
  const st = fs.statSync(real);
  if (!st.isFile()) throw err(C.NOT_A_FILE, "not a file");
  if (st.size > q.maxBytes) throw err(C.TOO_LARGE, "larger than " + mb(q.maxBytes), { size: st.size });
  const buf = fs.readFileSync(real);
  if (buf.length > q.maxBytes) throw err(C.TOO_LARGE, "larger than " + mb(q.maxBytes), { size: buf.length });
  return { ok: true, contentBase64: buf.toString("base64"), size: buf.length, mtimeMs: st.mtimeMs, etag: tag(buf), readOnly: Boolean(protectedWhy(loc)) || !canWrite(real) || !canWrite(path.dirname(real)) };
}
function write(loc, q) {
  const why = protectedWhy(loc);
  if (why) throw err(C.READ_ONLY, why);
  if (loc.rel === "") throw err(C.NOT_A_FILE, "the folder itself is not a file");
  const buf = Buffer.from(q.contentBase64 || "", "base64");
  if (buf.length > q.maxBytes) throw err(C.TOO_LARGE, "larger than " + mb(q.maxBytes), { size: buf.length });
  let target = loc.target;
  let mode;
  let exists = false;
  try { fs.lstatSync(loc.target); exists = true; } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (exists) {
    target = fs.realpathSync(loc.target);
    const st = fs.statSync(target);
    if (!st.isFile()) throw err(C.NOT_A_FILE, "not a file");
    if (q.ifMatch === null) throw err(C.EXISTS, "a file with this name already exists");
    if (typeof q.ifMatch === "string") {
      const current = tag(fs.readFileSync(target));
      if (current !== q.ifMatch) throw err(C.CONFLICT, "the file changed since it was read", { etag: current });
    }
    mode = st.mode & 0o7777;
  } else {
    if (typeof q.ifMatch === "string") throw err(C.CONFLICT, "the file was deleted since it was read", { etag: null });
    if (q.createParents) fs.mkdirSync(path.dirname(loc.target), { recursive: true });
  }
  const tmp = path.join(path.dirname(target), "." + path.basename(target) + ".ps-" + process.pid + "-" + Date.now() + ".tmp");
  fs.writeFileSync(tmp, buf, { flag: "wx", mode: mode === undefined ? 0o644 : mode });
  try {
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  const st = fs.statSync(target);
  return { ok: true, etag: tag(buf), size: buf.length, mtimeMs: st.mtimeMs, created: !exists };
}
function mkdir(loc) {
  const why = protectedWhy(loc);
  if (why) throw err(C.READ_ONLY, why);
  fs.mkdirSync(loc.target);
  return { ok: true };
}
function remove(loc, q) {
  const why = protectedWhy(loc);
  if (why) throw err(C.READ_ONLY, why);
  if (loc.rel === "") throw err(C.PATH_INVALID, "the folder itself cannot be deleted here");
  const l = fs.lstatSync(loc.target);
  if (l.isDirectory()) {
    if (q.recursive) fs.rmSync(loc.target, { recursive: true });
    else fs.rmdirSync(loc.target);
  } else fs.unlinkSync(loc.target);
  return { ok: true };
}
function move(q) {
  const from = locate(q.base, q.rootPath, q.path, q);
  const to = locate(q.toBase, q.toRootPath, q.toPath, { ...q, rootPath: q.toRootPath });
  const why = protectedWhy(from) || protectedWhy(to);
  if (why) throw err(C.READ_ONLY, why);
  if (from.rel === "") throw err(C.PATH_INVALID, "the folder itself cannot be moved here");
  if (to.rel === "") throw err(C.PATH_INVALID, "give the new name, not the folder");
  fs.lstatSync(from.target);
  if (inside(to.target, from.target)) throw err(C.PATH_INVALID, "a folder cannot move into itself");
  let exists = false;
  try { fs.lstatSync(to.target); exists = true; } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (exists) throw err(C.EXISTS, "something with that name is already there");
  try { fs.renameSync(from.target, to.target); }
  catch (e) {
    if (e.code !== "EXDEV") throw e;
    // Another root: copy, then remove. Bounded like a folder zip, and
    // copied under a hidden name first, so a failure leaves no half copy
    // under the new name.
    let total = 0;
    const measure = (p) => {
      const l = fs.lstatSync(p);
      if (l.isDirectory()) { for (const name of fs.readdirSync(p)) measure(path.join(p, name)); return; }
      total += l.size;
      if (total > q.maxBytes) throw err(C.TOO_LARGE, "moving to another root copies the files; the limit is " + mb(q.maxBytes) + " in all");
    };
    measure(from.target);
    const tmp = path.join(path.dirname(to.target), "." + path.basename(to.target) + ".ps-move-" + process.pid + ".tmp");
    try {
      // verbatimSymlinks: a relative link stays relative. Without it, a link
      // becomes an absolute path into the source, which is deleted next.
      fs.cpSync(from.target, tmp, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
      fs.renameSync(tmp, to.target);
    } catch (e2) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      throw e2;
    }
    fs.rmSync(from.target, { recursive: true });
  }
  return { ok: true };
}
function zip(loc, q) {
  const fflate = require(q.fflatePath);
  const files = {};
  let total = 0, count = 0, gitSkipped = false;
  // Unix modes (os 3) keep a script executable after unzip.
  const addFile = (full, name, l) => {
    total += l.size;
    if (total > q.maxBytes) throw err(C.TOO_LARGE, "the files are larger than " + mb(q.maxBytes) + " in all");
    files[name] = [new Uint8Array(fs.readFileSync(full)), { mtime: l.mtime, os: 3, attrs: l.mode * 65536 }];
    count++;
  };
  const answer = (out) => ({ ok: true, contentBase64: Buffer.from(out).toString("base64"), size: out.length, files: count, ...(gitSkipped ? { skipped: [".git"] } : {}) });
  // Several paths in one folder (a selection): each at its own name.
  if (Array.isArray(q.paths)) {
    for (const rel of q.paths) {
      const one = locate(q.base, q.rootPath, rel, q);
      if (protectedWhy(one)) { if (String(rel).split("/").some((part) => part.toLowerCase() === ".git")) gitSkipped = true; continue; }
      const l = fs.lstatSync(one.target);
      if (l.isSymbolicLink()) continue;
      const name = path.relative(loc.realBase, one.target).split(path.sep).join("/");
      if (l.isDirectory()) { files[name] = {}; walkInto(one.target, name + "/"); }
      else if (l.isFile()) addFile(one.target, name, l);
    }
    return answer(fflate.zipSync(files, { level: 6 }));
  }
  if (!fs.statSync(loc.target).isDirectory()) throw err(C.NOT_A_FOLDER, "not a folder");
  walkInto(loc.target, "");
  return answer(fflate.zipSync(files, { level: 6 }));
  function walkInto(dir, prefix) { walk(dir, prefix); }
  function walk(dir, prefix) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === ".git" && q.skipGit) { gitSkipped = true; continue; }
      if (d.name === ".pilotswarm-export" && dir === loc.realRoot) continue;
      const full = path.join(dir, d.name);
      const l = fs.lstatSync(full);
      if (l.isSymbolicLink()) continue;
      // A folder entry: fflate adds the trailing slash itself.
      if (l.isDirectory()) { files[prefix + d.name] = {}; walk(full, prefix + d.name + "/"); continue; }
      if (!l.isFile()) continue;
      addFile(full, prefix + d.name, l);
    }
  }
}
// Git repositories inside the folder (a folder that holds ".git", a folder
// or a file), breadth first, up to maxDepth levels down. A repository's own
// folders are not searched (no repositories inside repositories), nor are
// links, ".git" or node_modules.
function repos(loc, q) {
  if (!fs.statSync(loc.target).isDirectory()) throw err(C.NOT_A_FOLDER, "not a folder");
  const found = [];
  let visited = 0, truncated = false;
  const queue = [{ rel: "", depth: 0 }];
  while (queue.length) {
    const { rel, depth } = queue.shift();
    let dirents;
    try { dirents = fs.readdirSync(path.join(loc.target, rel), { withFileTypes: true }); } catch { continue; }
    if (rel && dirents.some((d) => d.name === ".git" && (d.isDirectory() || d.isFile()))) {
      found.push(rel);
      if (found.length >= q.maxResults) { truncated = true; break; }
      continue;
    }
    if (depth >= q.maxDepth) continue;
    for (const d of dirents) {
      if (++visited > q.maxVisited) { truncated = true; queue.length = 0; break; }
      if (!d.isDirectory() || d.name === ".git" || d.name === "node_modules") continue;
      queue.push({ rel: rel ? rel + "/" + d.name : d.name, depth: depth + 1 });
    }
  }
  return { ok: true, repos: found.sort(), truncated };
}
// Files and folders whose name holds the words, in any case, breadth first.
// A word with a "/" matches the path. Best first: the whole name, then the
// start of the name, then anywhere; nearer the top first.
function find(loc, q) {
  if (!fs.statSync(loc.target).isDirectory()) throw err(C.NOT_A_FOLDER, "not a folder");
  const words = String(q.query || "").toLowerCase().split(/\\s+/).filter(Boolean);
  if (!words.length) return { ok: true, matches: [], truncated: false };
  const found = [];
  let visited = 0, truncated = false;
  const queue = [""];
  while (queue.length) {
    const rel = queue.shift();
    let dirents;
    try { dirents = fs.readdirSync(path.join(loc.target, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      if (++visited > q.maxVisited) { truncated = true; queue.length = 0; break; }
      const childRel = rel ? rel + "/" + d.name : d.name;
      const isDir = d.isDirectory();
      if (isDir && d.name !== ".git") queue.push(childRel);
      const name = d.name.toLowerCase();
      const hay = childRel.toLowerCase();
      if (!words.every((w) => (w.includes("/") ? hay : name).includes(w))) continue;
      const first = words[0];
      const rank = name === first ? 0 : name.startsWith(first) ? 1 : 2;
      found.push({ path: childRel, kind: isDir ? "dir" : d.isFile() ? "file" : d.isSymbolicLink() ? "link" : "other", rank, depth: childRel.split("/").length });
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.path.localeCompare(b.path));
  const matches = found.slice(0, q.maxResults).map(({ path, kind }) => ({ path, kind }));
  return { ok: true, matches, truncated: truncated || found.length > q.maxResults };
}
`;

/**
 * A turn to run one file call of this kind; the result frees it. A freed
 * turn goes straight to the next caller waiting. A caller that waits longer
 * than `waitMs` fails with WORKSPACE_FILES_BUSY. Exported for tests.
 */
export async function acquireFileCallSlot(op: string, waitMs = DEFAULT_FILE_CALL_WAIT_MS): Promise<() => void> {
    const lane = WHOLE_FILE_OPS.has(op) ? FILE_CALL_LANES.whole : FILE_CALL_LANES.light;
    if (lane.running < lane.max) lane.running++;
    else {
        await new Promise<void>((resolve, reject) => {
            const take = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => {
                const at = lane.waiting.indexOf(take);
                if (at >= 0) lane.waiting.splice(at, 1);
                reject(fileError(C.BUSY, "too many file calls are running here; try again in a moment"));
            }, waitMs);
            lane.waiting.push(take);
        });
    }
    let freed = false;
    return () => {
        if (freed) return;
        freed = true;
        const next = lane.waiting.shift();
        if (next) next();
        else lane.running--;
    };
}

let fflatePath: string | undefined;
function resolveFflate(): string {
    fflatePath ??= createRequire(import.meta.url).resolve("fflate");
    return fflatePath;
}

/** Runs one file call in a child process. Rejects with an error that has `code` and `status`. */
export async function runWorkspaceFileCall(request: Record<string, unknown>, config: WorkspaceFilesConfig): Promise<any> {
    const maxBytes = config.maxBytes ?? DEFAULT_WORKSPACE_FILE_MAX_BYTES;
    const timeoutMs = config.timeoutMs ?? DEFAULT_WORKSPACE_FILE_TIMEOUT_MS;
    const payload = JSON.stringify({
        ...request,
        codes: WORKSPACE_FILE_ERROR_CODES,
        requireMarker: config.requireMarker !== false,
        maxBytes,
        maxEntries: config.maxEntries ?? MAX_WORKSPACE_DIR_ENTRIES,
        ...(request.op === "zip" ? { fflatePath: resolveFflate(), skipGit: true } : {}),
        ...(request.op === "find" ? { maxVisited: 50_000, maxResults: 200 } : {}),
        ...(request.op === "repos" ? { maxVisited: 5_000, maxResults: 50, maxDepth: 3 } : {}),
    });
    // Base64 grows content by a third; leave room for the rest of the answer.
    const maxAnswerBytes = Math.ceil(maxBytes * 1.4) + 4 * 1024 * 1024;
    const release = await acquireFileCallSlot(String(request.op ?? ""), config.queueWaitMs ?? DEFAULT_FILE_CALL_WAIT_MS);
    try {
        return await new Promise((resolve, reject) => {
            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(process.execPath, ["-e", FILES_SCRIPT], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "" } });
            } catch (error: any) {
                reject(fileError(C.IO, `could not start the file call (${error?.message ?? error})`));
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            let done = false;
            const finish = (fn: () => void) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                fn();
            };
            const timer = setTimeout(() => finish(() => {
                child.kill("SIGKILL");
                reject(fileError(C.TIMEOUT, `the folder did not answer within ${Math.round(timeoutMs / 1000)} s`));
            }), timeoutMs);
            child.stdout?.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxAnswerBytes) {
                    finish(() => {
                        child.kill("SIGKILL");
                        reject(fileError(C.TOO_LARGE, "the answer is too large"));
                    });
                    return;
                }
                chunks.push(chunk);
            });
            child.on("error", (error) => finish(() => reject(fileError(C.IO, `the file call failed (${error.message})`))));
            child.on("close", () => finish(() => {
                let parsed: any;
                try {
                    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                } catch {
                    reject(fileError(C.IO, "the file call gave no answer"));
                    return;
                }
                if (parsed?.ok === true) {
                    delete parsed.ok;
                    resolve(parsed);
                } else {
                    const extra: Record<string, unknown> = {};
                    if (parsed && "etag" in parsed) extra.etag = parsed.etag;
                    if (parsed && "size" in parsed) extra.size = parsed.size;
                    reject(fileError(String(parsed?.code ?? C.IO), String(parsed?.message ?? "the file call failed"), extra));
                }
            }));
            child.stdin?.on("error", () => { /* the child exited early; its answer says why */ });
            child.stdin?.end(payload);
        });
    } finally {
        release();
    }
}

/** The config from settings: `name=path` pairs, comma-separated; the limit in MB. */
export function workspaceFilesConfigFromEnv(env: Record<string, string | undefined> = process.env): WorkspaceFilesConfig | null {
    const raw = String(env.PORTAL_WORKSPACE_ROOTS ?? "").trim();
    if (!raw) return null;
    const roots: Array<{ name: string; path: string }> = [];
    for (const pair of raw.split(",")) {
        const text = pair.trim();
        if (!text) continue;
        const at = text.indexOf("=");
        const name = at > 0 ? text.slice(0, at).trim() : "";
        const rootPath = at > 0 ? text.slice(at + 1).trim() : "";
        if (!name || !rootPath.startsWith("/")) throw new Error(`PORTAL_WORKSPACE_ROOTS: "${text}" must be name=/absolute/path`);
        roots.push({ name, path: rootPath });
    }
    const limitMb = Number(env.PORTAL_WORKSPACE_MAX_FILE_MB ?? "");
    const marker = String(env.PORTAL_WORKSPACE_REQUIRE_MARKER ?? "").trim().toLowerCase();
    return {
        roots,
        ...(Number.isFinite(limitMb) && limitMb > 0 ? { maxBytes: Math.round(limitMb * 1024 * 1024) } : {}),
        ...(["false", "0", "no", "off"].includes(marker) ? { requireMarker: false } : {}),
    };
}
