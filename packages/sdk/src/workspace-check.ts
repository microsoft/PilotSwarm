/**
 * Session workspace checks (docs/proposals/session-workspaces.md, section 4.1).
 *
 * Two kinds:
 *
 * - The folder-text check: pure rules on the record. Every caller runs it in
 *   process: the client, the Web API, MCP and the agent tool.
 * - The path check: filesystem rules on the attach path. It runs only on a
 *   worker, because only workers see the roots. It runs out of process, with
 *   a deadline, one check per root at a time. A call into a hung NFS mount
 *   blocks for as long as the server is gone, and it would block this
 *   process's event loop or its libuv threads if it ran here.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { WORKSPACE_ERROR_CODES, type SessionWorkspace, type SessionWorkspaceExtra } from "./types.js";

export type WorkspaceCheckFailure = { ok: false; code: string; message: string };

const MAX_ROOT_NAME_LENGTH = 128;
const MAX_FOLDER_LENGTH = 1024;
const WORKSPACE_FIELDS = new Set(["schema", "root", "folder", "extra"]);
const EXTRA_FIELDS = new Set(["root", "folder", "required"]);

/** The most extra folders one workspace may name (section 4.10). */
export const MAX_WORKSPACE_EXTRAS = 4;
/** An extra folder's name: what the model and the provider call it. */
const EXTRA_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** What canvas apps call the working folder (canvas-ws paths: "work/..."). */
export const CANVAS_WORKING_FOLDER_NAME = "work";

/**
 * A name no extra or default folder may have: "work", which canvas apps use
 * for the working folder, and a property every object has ("constructor",
 * ...), which a plain lookup would find.
 */
function reservedName(name: string): boolean {
    return name === CANVAS_WORKING_FOLDER_NAME || Object.prototype.hasOwnProperty.call(Object.prototype, name);
}

/** The value of an own key only; never a property from the prototype. */
function own<T>(map: Record<string, T> | undefined | null, name: string): T | undefined {
    return map && Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
}

/** Present: neither undefined nor null. A caller may send null for "not given". */
function present(value: unknown): boolean {
    return value !== undefined && value !== null;
}

function fail(code: string, message: string): WorkspaceCheckFailure {
    return { ok: false, code, message };
}

const invalid = (message: string) => fail(WORKSPACE_ERROR_CODES.PATH_INVALID, message);

/** The root and folder rules, shared by the working folder and each extra folder. */
function checkRootAndFolder(root: unknown, folder: unknown, what: string): { ok: true; root: string; folder?: string } | WorkspaceCheckFailure {
    if (typeof root !== "string" || root.length === 0) return invalid(`${what} root must be a non-empty string`);
    if (root.length > MAX_ROOT_NAME_LENGTH) return invalid(`${what} root is longer than ${MAX_ROOT_NAME_LENGTH} characters`);
    if (root.includes("\0") || root.includes("/") || root !== root.trim()) {
        return invalid(`${what} root must be a root name, not a path`);
    }
    if (folder === undefined || folder === null) return { ok: true, root };
    if (typeof folder !== "string") return invalid(`${what} folder must be a string`);
    if (folder.length > MAX_FOLDER_LENGTH) return invalid(`${what} folder is longer than ${MAX_FOLDER_LENGTH} characters`);
    if (folder.includes("\0")) return invalid(`${what} folder must not contain a NUL character`);
    if (folder.startsWith("/")) return invalid(`${what} folder must be relative to the root`);
    const normalized = path.posix.normalize(folder).replace(/\/+$/, "");
    if (normalized === ".." || normalized.startsWith("../")) return invalid(`${what} folder must stay inside the root`);
    if (normalized === "" || normalized === ".") return { ok: true, root };
    return { ok: true, root, folder: normalized };
}

/**
 * The extra-folder map: names, shapes and the count. With `allowNull`, a
 * null value (remove that folder) is kept as null; that form is only for
 * the agent tool's merge. Names come back sorted.
 */
function checkExtraMap(input: unknown, allowNull: boolean): { ok: true; extra: Record<string, SessionWorkspaceExtra | null> } | WorkspaceCheckFailure {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return invalid("extra must be an object that maps a folder name to { root, folder, required }");
    }
    const names = Object.keys(input as Record<string, unknown>).sort();
    if (names.length > MAX_WORKSPACE_EXTRAS * 2) return invalid(`extra names too many folders; at most ${MAX_WORKSPACE_EXTRAS} are allowed`);
    const extra: Record<string, SessionWorkspaceExtra | null> = {};
    for (const name of names) {
        if (!EXTRA_NAME.test(name)) {
            return invalid(`extra folder name "${name}" must be 1-32 lowercase letters, digits, "-" or "_", starting with a letter or digit`);
        }
        if (reservedName(name)) return invalid(`extra folder name "${name}" is reserved${name === CANVAS_WORKING_FOLDER_NAME ? " (canvas apps call the working folder that)" : ""}; pick another name`);
        const value = (input as Record<string, unknown>)[name];
        if (value === null && allowNull) {
            extra[name] = null;
            continue;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return invalid(`extra folder "${name}" must be an object with a root, an optional folder and an optional required flag`);
        }
        const raw = value as Record<string, unknown>;
        for (const key of Object.keys(raw)) {
            if (!EXTRA_FIELDS.has(key)) return invalid(`unknown field "${key}" in extra folder "${name}"; expected root, folder and required`);
        }
        const checked = checkRootAndFolder(raw.root, raw.folder, `extra folder "${name}"`);
        if (!checked.ok) return checked;
        if (raw.required !== undefined && typeof raw.required !== "boolean") return invalid(`extra folder "${name}": required must be true or false`);
        extra[name] = {
            root: checked.root,
            ...(checked.folder ? { folder: checked.folder } : {}),
            ...(raw.required === false ? { required: false } : {}),
        };
    }
    return { ok: true, extra };
}

/**
 * One default folder from a provider's defaultFolders (section 4.11): a valid
 * extra-folder name and the folder-text rules. Normalized like a record's
 * extra folder; `required` is kept only when true (defaults are optional).
 */
export function checkDefaultFolder(name: unknown, value: unknown): { ok: true; name: string; folder: SessionWorkspaceExtra } | WorkspaceCheckFailure {
    if (typeof name !== "string" || !EXTRA_NAME.test(name)) {
        return invalid(`default folder name "${String(name)}" must be 1-32 lowercase letters, digits, "-" or "_", starting with a letter or digit`);
    }
    if (reservedName(name)) return invalid(`default folder name "${name}" is reserved`);
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(`default folder "${name}" must be an object with a root`);
    const raw = value as Record<string, unknown>;
    const checked = checkRootAndFolder(raw.root, raw.folder, `default folder "${name}"`);
    if (!checked.ok) return checked;
    return {
        ok: true,
        name,
        folder: { root: checked.root, ...(checked.folder ? { folder: checked.folder } : {}), ...(raw.required === true ? { required: true } : { required: false }) },
    };
}

/** One folder is the other, or holds it, in the same root. The text only; links are not followed. */
export function foldersOverlap(a: { root: string; folder?: string }, b: { root: string; folder?: string }): boolean {
    if (a.root !== b.root) return false;
    const x = a.folder ?? "";
    const y = b.folder ?? "";
    return x === y || x === "" || y === "" || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * The folder-text check. Accepts `{ root, folder?, extra? }` (schema
 * optional, must be 1 when given) and returns the normalized record: each
 * folder is relative, has no NUL, no `..` after normalizing, and no trailing
 * slash. An empty folder or "." means the root itself, so `folder` is left
 * out. Extra folders (section 4.10): at most MAX_WORKSPACE_EXTRAS, by name;
 * `required: true` is the default and is left out; no two folders of the
 * record may overlap, because a provider may lease a folder once per
 * session. Root names are not checked against a list here; only a worker
 * knows the roots.
 */
export function validateWorkspaceText(input: unknown): { ok: true; workspace: SessionWorkspace } | WorkspaceCheckFailure {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return invalid("workspace must be an object with a root and an optional folder");
    }
    const raw = input as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
        if (!WORKSPACE_FIELDS.has(key)) return invalid(`unknown workspace field "${key}"; expected root, folder and extra`);
    }
    if (raw.schema !== undefined && raw.schema !== 1) {
        return invalid(`unsupported workspace schema ${String(raw.schema)}; this version supports schema 1`);
    }
    const base = checkRootAndFolder(raw.root, raw.folder, "workspace");
    if (!base.ok) return base;
    const workspace: SessionWorkspace = { schema: 1, root: base.root, ...(base.folder ? { folder: base.folder } : {}) };
    if (raw.extra === undefined || raw.extra === null) return { ok: true, workspace };
    const checked = checkExtraMap(raw.extra, false);
    if (!checked.ok) return checked;
    const names = Object.keys(checked.extra);
    if (names.length > MAX_WORKSPACE_EXTRAS) return invalid(`a workspace has at most ${MAX_WORKSPACE_EXTRAS} extra folders; this one names ${names.length}`);
    if (names.length === 0) return { ok: true, workspace };
    const extra = checked.extra as Record<string, SessionWorkspaceExtra>;
    for (const name of names) {
        if (foldersOverlap(extra[name], workspace)) {
            return invalid(`extra folder "${name}" overlaps the working folder; pick a folder outside it`);
        }
    }
    for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) {
            if (foldersOverlap(extra[names[i]], extra[names[j]])) {
                return invalid(`extra folders "${names[i]}" and "${names[j]}" overlap; each must be a separate folder`);
            }
        }
    }
    workspace.extra = extra;
    return { ok: true, workspace };
}

/** The working folder alone: the record without its extra folders. */
export function workingFolderOf(workspace: SessionWorkspace): SessionWorkspace {
    return { schema: 1, root: workspace.root, ...(workspace.folder ? { folder: workspace.folder } : {}) };
}

/** One extra folder as a record of its own, for the provider. */
export function extraFolderRecord(extra: SessionWorkspaceExtra): SessionWorkspace {
    return { schema: 1, root: extra.root, ...(extra.folder ? { folder: extra.folder } : {}) };
}

/** Two records name the same working folder. Extra folders are not compared. */
export function sameWorkingFolder(a: SessionWorkspace | null | undefined, b: SessionWorkspace | null | undefined): boolean {
    if (!a || !b) return !a && !b;
    return a.root === b.root && (a.folder ?? "") === (b.folder ?? "");
}

function sameExtra(a: SessionWorkspaceExtra | undefined, b: SessionWorkspaceExtra | undefined): boolean {
    if (!a || !b) return !a && !b;
    return a.root === b.root && (a.folder ?? "") === (b.folder ?? "") && (a.required !== false) === (b.required !== false);
}

/** The same folder: root and folder, whatever its role or name. */
export function sameFolder(a: { root: string; folder?: string } | null | undefined, b: { root: string; folder?: string } | null | undefined): boolean {
    if (!a || !b) return !a && !b;
    return a.root === b.root && (a.folder ?? "") === (b.folder ?? "");
}

/** Two records name the same folders: the working folder and every extra folder. Both must already be normalized. */
export function sameWorkspace(a: SessionWorkspace | null | undefined, b: SessionWorkspace | null | undefined): boolean {
    if (!sameWorkingFolder(a, b)) return false;
    if (!a || !b) return true;
    const names = new Set([...Object.keys(a.extra ?? {}), ...Object.keys(b.extra ?? {})]);
    for (const name of names) {
        if (!sameExtra(own(a.extra, name), own(b.extra, name))) return false;
    }
    return true;
}

/**
 * The extra folders of `next` to check before a change is stored: the ones
 * that are new or whose folder moved. Kept folders and a changed `required`
 * need no check; the session attaches them every turn.
 */
export function changedExtraNames(previous: SessionWorkspace | null | undefined, next: SessionWorkspace | null | undefined): string[] {
    return Object.keys(next?.extra ?? {}).filter((name) => !sameFolder(own(previous?.extra, name), own(next?.extra, name))).sort();
}

/**
 * Whether a set_session_workspace call changes the working folder: it has
 * a root, a folder or clear. A call with only `extra` does not, so it does
 * not end the turn. The deny hook asks this before the handler runs.
 */
export function callChangesWorkingFolder(args: unknown): boolean {
    let value = args;
    if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return true; }
    }
    if (!value || typeof value !== "object") return true;
    const raw = value as Record<string, unknown>;
    // Anything but a plain extra-only call is treated as a change of the
    // working folder, so a malformed call still gets the stricter handling.
    // The handler drops the mark again if it accepts extras only. null is
    // "not given", as in the merge.
    const extraOnly = present(raw.extra) && !present(raw.root) && !present(raw.folder) && raw.clear !== true;
    return !extraOnly;
}

export interface WorkspaceChangeInput {
    root?: unknown;
    folder?: unknown;
    clear?: unknown;
    extra?: unknown;
}

export type WorkspaceMerge =
    | {
        ok: true;
        /** The record after the change; null after clear. */
        next: SessionWorkspace | null;
        /** The working folder changes (or is cleared), so the change waits for the turn to end. */
        changesWorkingFolder: boolean;
        /** The patch as given, normalized: a record adds or replaces, null removes. */
        extraPatch: Record<string, SessionWorkspaceExtra | null>;
        added: string[];
        replaced: string[];
        removed: string[];
    }
    | WorkspaceCheckFailure;

/**
 * The agent tool's change, merged into the current record (section 4.10):
 *
 *   { root, folder }        a new working folder; the extra folders stay
 *   { extra: { logs: {…} } } adds or replaces "logs"; the rest stays
 *   { extra: { logs: null } } removes "logs"
 *   { clear: true }         clears the working folder and every extra folder
 *
 * Omitted parts keep their current value, so the model never resends what
 * it keeps.
 */
export function mergeWorkspaceChange(current: SessionWorkspace | null | undefined, change: WorkspaceChangeInput): WorkspaceMerge {
    const hasRoot = present(change.root);
    const hasFolder = present(change.folder);
    const hasExtra = present(change.extra);
    if (present(change.clear) && change.clear !== true && change.clear !== false) return invalid("clear must be true or false");
    if (change.clear === true) {
        if (hasRoot || hasFolder || hasExtra) return invalid("pass either clear=true or a change, not both");
        const removed = Object.keys(current?.extra ?? {});
        return { ok: true, next: null, changesWorkingFolder: true, extraPatch: {}, added: [], replaced: [], removed };
    }
    if (hasFolder && !hasRoot) return invalid("pass root with folder; omit both to keep the working folder");
    if (!hasRoot && !hasExtra) return invalid("pass root and folder for a new working folder, extra to change extra folders, or clear=true");
    let patch: Record<string, SessionWorkspaceExtra | null> = {};
    if (hasExtra) {
        const checked = checkExtraMap(change.extra, true);
        if (!checked.ok) return checked;
        patch = checked.extra;
    }
    const base = hasRoot
        ? { root: change.root, ...(hasFolder ? { folder: change.folder } : {}) }
        : current ? workingFolderOf(current) : null;
    if (!base) return invalid("set a working folder first (root and folder); extra folders need one");
    const extra: Record<string, SessionWorkspaceExtra> = { ...(current?.extra ?? {}) };
    const added: string[] = [];
    const replaced: string[] = [];
    const removed: string[] = [];
    for (const [name, value] of Object.entries(patch)) {
        const existing = own(extra, name);
        if (value === null) {
            if (!existing) return invalid(`no extra folder is named "${name}"`);
            delete extra[name];
            removed.push(name);
        } else {
            if (!existing) added.push(name);
            else if (!sameFolder(existing, value)) replaced.push(name);
            extra[name] = value;
        }
    }
    const candidate: Record<string, unknown> = { schema: 1, ...base };
    if (Object.keys(extra).length > 0) candidate.extra = extra;
    const checked = validateWorkspaceText(candidate);
    if (!checked.ok) return checked;
    const changesWorkingFolder = hasRoot && !sameWorkingFolder(current ?? null, checked.workspace);
    return { ok: true, next: checked.workspace, changesWorkingFolder, extraPatch: patch, added, replaced, removed };
}

// ─── Path check ───────────────────────────────────────────────────

export const DEFAULT_PATH_CHECK_TIMEOUT_MS = 5_000;

export interface WorkspacePathCheckRequest {
    rootName: string;
    /** The root's path from `listRoots()`. */
    rootPath: string;
    /** The attach path from `ensureAttached()`. */
    path: string;
    timeoutMs?: number;
    /**
     * Also read the repo's agents and skills, and stamp its instruction
     * files (section 4.6), inside the same deadline. `folder`: with no clone
     * root, adopt from the attach path itself (a person's folder, 4.11).
     * `instructionText`: also read the instruction files' text, for a folder
     * the CLI does not read them from (an extra folder).
     */
    collect?: { agents?: boolean; skills?: boolean; instructions?: boolean; folder?: boolean; instructionText?: boolean };
}

/** Repo limits from section 4.6. */
export const MAX_REPO_AGENTS = 30;
export const MAX_REPO_AGENT_BYTES = 64 * 1024;
/** Agent files looked at past the limit; the rest are counted, not opened. */
export const MAX_REPO_AGENT_OVERFLOW = 20;
/** A skills folder with more entries is not adopted: the CLI would read every entry, and the check could not look at each. */
export const MAX_REPO_SKILL_ENTRIES = 200;

/**
 * What the check read from the checkout for adoption. Everything comes from
 * the clone root: the nearest folder at or above the attach path, inside the
 * root, that holds `.git`. With no clone root, nothing is adopted. Agent
 * files are read whole (at most MAX_REPO_AGENTS files of at most
 * MAX_REPO_AGENT_BYTES). Skills are only named: the CLI reads them itself
 * from `.github/skills`. A file or folder whose real path leaves the clone
 * root is never read.
 */
export interface RepoScan {
    agents: Array<{ file: string; content: string }>;
    skills: string[];
    skipped: Array<{ kind: "agent" | "skill"; file: string; reason: string }>;
    /** The clone root, relative to the attach path: "" when they are the same folder. Absent: no clone root. */
    cloneRoot?: string;
    /**
     * The instruction files the CLI may load, as [file, size, mtimeMs], when
     * instructions are adopted. Only their stamp is read: it joins the
     * fingerprint, so an edited AGENTS.md resumes the session.
     */
    instructions?: Array<[string, number, number]>;
    /** The instruction files' text, when collect.instructionText asked for it (at most MAX_INSTRUCTION_TEXT_BYTES in all). */
    instructionText?: Array<{ file: string; content: string }>;
    /** The adoption root is the attached folder itself, not a git clone (collect.folder). */
    folderRoot?: boolean;
}

/** The most instruction text read from one extra folder (all files together). */
export const MAX_INSTRUCTION_TEXT_BYTES = 32 * 1024;

export type WorkspacePathCheckResult = { ok: true; realPath: string; repo?: RepoScan } | WorkspaceCheckFailure;

/**
 * Test only. A local `stat` never hangs, so tests make chosen checks sleep to
 * stand in for a hung mount. `unkillable` stands in for a process stuck in
 * uninterruptible NFS I/O: the deadline does not kill it, so the root stays
 * hung until the sleep ends.
 */
export type WorkspaceCheckTestHook = (req: { rootName: string; path: string }) =>
    { sleepMs?: number; unkillable?: boolean } | undefined;

let testHook: WorkspaceCheckTestHook | null = null;

/** Test only: see WorkspaceCheckTestHook. Pass null to remove the hook. */
export function setWorkspaceCheckTestHook(hook: WorkspaceCheckTestHook | null): void {
    testHook = hook;
}

// The child process. It gets its request in an environment variable, prints
// one JSON line, and exits. Plain CommonJS so it runs under any node.
const CHECK_SCRIPT = `
const fs = require("fs");
const path = require("path");
const req = JSON.parse(process.env.PS_WORKSPACE_CHECK || "{}");
const out = (value) => process.stdout.write(JSON.stringify(value));
if (req.sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, req.sleepMs);
let rootReal;
try { rootReal = fs.realpathSync(req.rootPath); }
catch (e) { out({ ok: false, code: req.codes.FOLDER_MISSING, message: "root path " + req.rootPath + " is not available on this worker (" + (e.code || e.message) + ")" }); process.exit(0); }
let real;
try { real = fs.realpathSync(req.path); }
catch (e) {
  const missing = e.code === "ENOENT" || e.code === "ENOTDIR";
  out({ ok: false, code: missing ? req.codes.FOLDER_MISSING : req.codes.PATH_INVALID,
        message: (missing ? "folder does not exist: " : "cannot resolve the folder (" + (e.code || e.message) + "): ") + req.path });
  process.exit(0);
}
const rel = path.relative(rootReal, real);
if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
  out({ ok: false, code: req.codes.PATH_INVALID, message: "folder resolves outside the root: " + req.path });
  process.exit(0);
}
let st;
try { st = fs.statSync(real); }
catch (e) { out({ ok: false, code: req.codes.FOLDER_MISSING, message: "cannot stat the folder (" + (e.code || e.message) + "): " + req.path }); process.exit(0); }
if (!st.isDirectory()) {
  out({ ok: false, code: req.codes.FOLDER_MISSING, message: "not a directory (a file, a FIFO, or a symlink to a file): " + req.path });
  process.exit(0);
}
if (!req.collect || (!req.collect.agents && !req.collect.skills && !req.collect.instructions)) { out({ ok: true, realPath: real }); process.exit(0); }
// Adoption (section 4.6) reads from the clone root: the nearest folder at or
// above the attach path, inside the root, that holds .git. With no clone
// root, nothing is adopted. A path whose real location leaves the clone
// root is skipped, never read.
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (e) { return false; } };
let clone = null;
for (let dir = real; ; dir = path.dirname(dir)) {
  if (exists(path.join(dir, ".git"))) { clone = dir; break; }
  if (path.relative(rootReal, dir) === "" || dir === path.dirname(dir)) break;
}
const repo = { agents: [], skills: [], skipped: [] };
// A person's folder (section 4.11): with no clone, the provider may let the
// attached folder itself be the adoption root.
if (!clone && req.collect.folder) { clone = real; repo.folderRoot = true; }
if (req.collect.instructions) {
  // Only a stamp: the CLI reads these itself. It joins the fingerprint.
  const stamp = [];
  const note = (dir, prefix) => {
    for (const name of ["AGENTS.md", ".github/copilot-instructions.md"]) {
      try { const s = fs.statSync(path.join(dir, name)); if (s.isFile()) stamp.push([prefix + name, s.size, s.mtimeMs]); } catch (e) {}
    }
  };
  note(real, "");
  if (clone && clone !== real) note(clone, path.relative(real, clone) + "/");
  try {
    const idir = path.join(clone || real, ".github", "instructions");
    for (const name of fs.readdirSync(idir).filter((n) => n.endsWith(".instructions.md")).sort().slice(0, 50)) {
      try { const s = fs.statSync(path.join(idir, name)); stamp.push([".github/instructions/" + name, s.size, s.mtimeMs]); } catch (e) {}
    }
  } catch (e) {}
  repo.instructions = stamp;
  if (req.collect.instructionText) {
    // The text, for a folder the CLI does not read instructions from.
    const texts = [];
    let used = 0;
    for (const [file] of stamp) {
      const full = file.startsWith(".github/instructions/") ? path.join(clone || real, file) : path.join(real, file);
      try {
        const r = fs.realpathSync(full);
        const rel3 = path.relative(clone || real, r);
        if (rel3 === ".." || rel3.startsWith(".." + path.sep) || path.isAbsolute(rel3)) continue;
        const left = req.maxInstructionText - used;
        if (left <= 0) break;
        const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
        try {
          const buf = Buffer.alloc(Math.min(left, 256 * 1024));
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          used += n;
          texts.push({ file, content: buf.subarray(0, n).toString("utf8") });
        } finally { fs.closeSync(fd); }
      } catch (e) {}
    }
    repo.instructionText = texts;
  }
}
if (!clone) {
  if (req.collect.agents && exists(path.join(real, ".github", "agents"))) repo.skipped.push({ kind: "agent", file: ".github/agents", reason: "the folder is not inside a git clone, so nothing is adopted" });
  if (req.collect.skills && exists(path.join(real, ".github", "skills"))) repo.skipped.push({ kind: "skill", file: ".github/skills", reason: "the folder is not inside a git clone, so nothing is adopted" });
  out({ ok: true, realPath: real, repo });
  process.exit(0);
}
repo.cloneRoot = path.relative(real, clone);
const inside = (p) => { try { const r = fs.realpathSync(p); const rel2 = path.relative(clone, r); return !(rel2 === ".." || rel2.startsWith(".." + path.sep) || path.isAbsolute(rel2)); } catch (e) { return false; } };
// Read at most max + 1 bytes, so a file that grew after its stat is still refused.
const readBounded = (full, max) => {
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const buf = Buffer.alloc(max + 1);
    const n = fs.readSync(fd, buf, 0, max + 1, 0);
    return n > max ? null : buf.subarray(0, n).toString("utf8");
  } finally { fs.closeSync(fd); }
};
if (req.collect.agents) {
  const dir = path.join(clone, ".github", "agents");
  if (exists(dir)) {
    if (!inside(dir)) repo.skipped.push({ kind: "agent", file: ".github/agents", reason: "the folder resolves outside the clone" });
    else {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".agent.md")).sort(); } catch (e) {}
      // Files past the limit are counted, never opened: a huge folder must
      // not use up the check's deadline.
      const looked = names.slice(0, req.maxAgents + req.maxAgentOverflow);
      for (const name of looked) {
        const file = ".github/agents/" + name;
        if (repo.agents.length >= req.maxAgents) { repo.skipped.push({ kind: "agent", file, reason: "more than " + req.maxAgents + " agents" }); continue; }
        const full = path.join(dir, name);
        if (!inside(full)) { repo.skipped.push({ kind: "agent", file, reason: "the file resolves outside the clone" }); continue; }
        let fst; try { fst = fs.statSync(full); } catch (e) { repo.skipped.push({ kind: "agent", file, reason: "unreadable (" + (e.code || e.message) + ")" }); continue; }
        if (!fst.isFile()) { repo.skipped.push({ kind: "agent", file, reason: "not a regular file" }); continue; }
        const tooBig = { kind: "agent", file, reason: "larger than " + (req.maxAgentBytes / 1024) + " KB" };
        if (fst.size > req.maxAgentBytes) { repo.skipped.push(tooBig); continue; }
        try {
          const content = readBounded(full, req.maxAgentBytes);
          if (content === null) repo.skipped.push(tooBig);
          else repo.agents.push({ file, content });
        } catch (e) { repo.skipped.push({ kind: "agent", file, reason: "unreadable (" + (e.code || e.message) + ")" }); }
      }
      if (names.length > looked.length) {
        repo.skipped.push({ kind: "agent", file: ".github/agents", reason: (names.length - looked.length) + " more agent files, not read" });
      }
    }
  }
}
if (req.collect.skills) {
  const dir = path.join(clone, ".github", "skills");
  if (exists(dir)) {
    if (!inside(dir)) repo.skipped.push({ kind: "skill", file: ".github/skills", reason: "the folder resolves outside the clone" });
    else {
      let names = [];
      try { names = fs.readdirSync(dir).sort(); } catch (e) {}
      if (names.length > req.maxSkillEntries) {
        // The CLI reads the whole folder, and every entry needs its check.
        repo.skipped.push({ kind: "skill", file: ".github/skills", reason: "more than " + req.maxSkillEntries + " entries, so no repo skill is adopted" });
      } else {
        const found = [];
        let escaped = null;
        for (const name of names) {
          const skill = path.join(dir, name, "SKILL.md");
          if (!exists(skill)) continue;
          if (!inside(path.join(dir, name)) || !inside(skill)) { escaped = ".github/skills/" + name; break; }
          found.push(name);
        }
        // The CLI reads the whole folder, so one escaping skill skips them all.
        if (escaped) repo.skipped.push({ kind: "skill", file: escaped, reason: "resolves outside the clone, so no repo skill is adopted" });
        else repo.skills = found;
      }
    }
  }
}
out({ ok: true, realPath: real, repo });
`;

interface RootCheckState {
    busy: boolean;
    /** The active check passed its deadline and its process has not exited yet. */
    hung: boolean;
    waiters: Array<{ resolve: (outcome: "acquired" | "timeout" | "hung") => void; timer: ReturnType<typeof setTimeout> }>;
}

const rootStates = new Map<string, RootCheckState>();

function stateFor(rootName: string): RootCheckState {
    let state = rootStates.get(rootName);
    if (!state) {
        state = { busy: false, hung: false, waiters: [] };
        rootStates.set(rootName, state);
    }
    return state;
}

function acquire(state: RootCheckState, timeoutMs: number): Promise<"acquired" | "timeout" | "hung"> {
    if (!state.busy) {
        state.busy = true;
        return Promise.resolve("acquired");
    }
    if (state.hung) return Promise.resolve("hung");
    return new Promise((resolve) => {
        const waiter = {
            resolve,
            timer: setTimeout(() => {
                const index = state.waiters.indexOf(waiter);
                if (index >= 0) state.waiters.splice(index, 1);
                resolve("timeout");
            }, timeoutMs),
        };
        state.waiters.push(waiter);
    });
}

/** The active check's process exited. Hand the slot to the next waiter. */
function releaseSlot(state: RootCheckState): void {
    state.hung = false;
    const next = state.waiters.shift();
    if (next) {
        clearTimeout(next.timer);
        next.resolve("acquired");
        return;
    }
    state.busy = false;
}

/** The active check passed its deadline. Everyone queued behind it fails now. */
function markHung(state: RootCheckState): void {
    state.hung = true;
    for (const waiter of state.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve("hung");
    }
}

function timeoutFailure(req: WorkspacePathCheckRequest, why: string): WorkspaceCheckFailure {
    return fail(WORKSPACE_ERROR_CODES.CHECK_TIMEOUT, `path check on root "${req.rootName}" timed out: ${why}`);
}

/**
 * The path check: the attach path must resolve (symlinks included) to a
 * directory inside the root. Checks on one root run one at a time. A queued
 * check waits up to the deadline for the running one; if the running check
 * has already timed out, the queued check fails at once. Checks on other
 * roots are not affected.
 */
export async function checkWorkspacePath(req: WorkspacePathCheckRequest): Promise<WorkspacePathCheckResult> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_PATH_CHECK_TIMEOUT_MS;
    const state = stateFor(req.rootName);
    const outcome = await acquire(state, timeoutMs);
    if (outcome === "hung") return timeoutFailure(req, "an earlier check on this root is still hung");
    if (outcome === "timeout") return timeoutFailure(req, `waited ${timeoutMs} ms for the running check`);
    return runCheck(state, req, timeoutMs);
}

function runCheck(state: RootCheckState, req: WorkspacePathCheckRequest, timeoutMs: number): Promise<WorkspacePathCheckResult> {
    const hook = testHook?.({ rootName: req.rootName, path: req.path });
    return new Promise((resolve) => {
        let settled = false;
        const settle = (result: WorkspacePathCheckResult) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        // A failed spawn can emit both "error" and "close"; free the slot once.
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            releaseSlot(state);
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(process.execPath, ["-e", CHECK_SCRIPT], {
                stdio: ["ignore", "pipe", "ignore"],
                env: {
                    PATH: process.env.PATH ?? "",
                    PS_WORKSPACE_CHECK: JSON.stringify({
                        rootPath: req.rootPath,
                        path: req.path,
                        sleepMs: hook?.sleepMs ?? 0,
                        codes: WORKSPACE_ERROR_CODES,
                        ...(req.collect ? {
                            collect: req.collect,
                            maxAgents: MAX_REPO_AGENTS,
                            maxAgentBytes: MAX_REPO_AGENT_BYTES,
                            maxAgentOverflow: MAX_REPO_AGENT_OVERFLOW,
                            maxSkillEntries: MAX_REPO_SKILL_ENTRIES,
                            maxInstructionText: MAX_INSTRUCTION_TEXT_BYTES,
                        } : {}),
                    }),
                },
            });
        } catch (error: any) {
            release();
            settle(timeoutFailure(req, `could not start the check process (${error?.message ?? error})`));
            return;
        }
        let stdout = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
        const timer = setTimeout(() => {
            markHung(state);
            if (!hook?.unkillable) child.kill("SIGKILL");
            settle(timeoutFailure(req, `no answer within ${timeoutMs} ms`));
        }, timeoutMs);
        child.once("error", (error) => {
            clearTimeout(timer);
            release();
            settle(timeoutFailure(req, `check process failed (${error.message})`));
        });
        child.once("close", () => {
            clearTimeout(timer);
            release();
            try {
                const parsed = JSON.parse(stdout);
                if (parsed && parsed.ok === true && typeof parsed.realPath === "string") {
                    settle(parsed.repo ? { ok: true, realPath: parsed.realPath, repo: parsed.repo as RepoScan } : { ok: true, realPath: parsed.realPath });
                } else if (parsed && parsed.ok === false && typeof parsed.code === "string") {
                    settle(fail(parsed.code, String(parsed.message ?? parsed.code)));
                } else {
                    settle(timeoutFailure(req, "check process gave no answer"));
                }
            } catch {
                settle(timeoutFailure(req, "check process gave no answer"));
            }
        });
    });
}

// ─── Files loaded by path (section 4.12) ──────────────────────────

/** The largest agent or SKILL.md file a session may load. */
export const MAX_LOAD_FILE_BYTES = 64 * 1024;
export const DEFAULT_LOAD_READ_TIMEOUT_MS = 5_000;

export interface WorkspaceFileRequest {
    kind: "agent" | "skill";
    /** Absolute path: an agent file; for a skill, its folder or its SKILL.md. */
    path: string;
    /** The attached folder it must stay inside, links included. */
    within: string;
}

export type WorkspaceFileResult =
    | { ok: true; realPath: string; content: string; /** A skill's folder. */ folder?: string }
    | { ok: false; reason: string };

const READ_SCRIPT = `
const fs = require("fs"), path = require("path");
const reqs = JSON.parse(process.env.PS_WORKSPACE_READ || "[]");
const max = Number(process.env.PS_WORKSPACE_READ_MAX || 65536);
const inside = (child, parent) => { const r = path.relative(parent, child); return r === "" || !(r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r)); };
const tooBig = () => ({ ok: false, reason: "larger than " + (max / 1024) + " KB" });
const out = reqs.map((q) => {
  try {
    const within = fs.realpathSync(q.within);
    let real = fs.realpathSync(q.path);
    if (!inside(real, within)) return { ok: false, reason: "it resolves outside the folder it is in" };
    let folder;
    let st = fs.statSync(real);
    if (q.kind === "skill") {
      if (st.isDirectory()) { folder = real; real = path.join(real, "SKILL.md"); }
      else if (path.basename(real) === "SKILL.md") folder = path.dirname(real);
      else return { ok: false, reason: "a skill is a folder with a SKILL.md, or that SKILL.md file" };
      real = fs.realpathSync(real);
      if (!inside(real, within)) return { ok: false, reason: "its SKILL.md resolves outside the folder it is in" };
      st = fs.statSync(real);
    }
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    if (st.size > max) return tooBig();
    const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    try {
      const buf = Buffer.alloc(max + 1);
      const n = fs.readSync(fd, buf, 0, max + 1, 0);
      if (n > max) return tooBig();
      return Object.assign({ ok: true, realPath: real, content: buf.subarray(0, n).toString("utf8") }, folder ? { folder } : {});
    } finally { fs.closeSync(fd); }
  } catch (e) {
    return { ok: false, reason: e.code === "ENOENT" ? "no such file or folder" : "unreadable (" + (e.code || e.message) + ")" };
  }
});
process.stdout.write(JSON.stringify(out));
`;

/**
 * Read agent and skill files for loading, in one child process with a
 * deadline (the files are on the mount). A file whose real path leaves its
 * attached folder is refused. Results come back in request order.
 */
export async function readWorkspaceFiles(requests: WorkspaceFileRequest[], opts: { timeoutMs?: number } = {}): Promise<WorkspaceFileResult[]> {
    if (requests.length === 0) return [];
    const timeoutMs = opts.timeoutMs ?? DEFAULT_LOAD_READ_TIMEOUT_MS;
    return new Promise((resolve) => {
        const all = (reason: string) => resolve(requests.map(() => ({ ok: false as const, reason })));
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(process.execPath, ["-e", READ_SCRIPT], {
                stdio: ["ignore", "pipe", "ignore"],
                env: { PATH: process.env.PATH ?? "", PS_WORKSPACE_READ: JSON.stringify(requests), PS_WORKSPACE_READ_MAX: String(MAX_LOAD_FILE_BYTES) },
            });
        } catch (error: any) {
            all(`could not start the read (${error?.message ?? error})`);
            return;
        }
        let stdout = "";
        let done = false;
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            child.kill("SIGKILL");
            all(`the folder did not answer within ${timeoutMs} ms`);
        }, timeoutMs);
        child.on("error", (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            all(`the read failed (${error?.message ?? error})`);
        });
        child.on("close", () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
                const parsed = JSON.parse(stdout);
                resolve(Array.isArray(parsed) && parsed.length === requests.length ? parsed : requests.map(() => ({ ok: false as const, reason: "unreadable answer" })));
            } catch {
                all("unreadable answer");
            }
        });
    });
}
