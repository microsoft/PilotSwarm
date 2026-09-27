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
import { WORKSPACE_ERROR_CODES, type SessionWorkspace } from "./types.js";

export type WorkspaceCheckFailure = { ok: false; code: string; message: string };

const MAX_ROOT_NAME_LENGTH = 128;
const MAX_FOLDER_LENGTH = 1024;
const WORKSPACE_FIELDS = new Set(["schema", "root", "folder"]);

function fail(code: string, message: string): WorkspaceCheckFailure {
    return { ok: false, code, message };
}

/**
 * The folder-text check. Accepts `{ root, folder? }` (schema optional, must
 * be 1 when given) and returns the normalized record: folder is relative, has
 * no NUL, no `..` after normalizing, and no trailing slash. An empty folder or
 * "." means the root itself, so `folder` is left out. Root names are not
 * checked against a list here; only a worker knows the roots.
 */
export function validateWorkspaceText(input: unknown): { ok: true; workspace: SessionWorkspace } | WorkspaceCheckFailure {
    const invalid = (message: string) => fail(WORKSPACE_ERROR_CODES.PATH_INVALID, message);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return invalid("workspace must be an object with a root and an optional folder");
    }
    const raw = input as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
        if (!WORKSPACE_FIELDS.has(key)) return invalid(`unknown workspace field "${key}"; expected root and folder`);
    }
    if (raw.schema !== undefined && raw.schema !== 1) {
        return invalid(`unsupported workspace schema ${String(raw.schema)}; this version supports schema 1`);
    }
    const root = raw.root;
    if (typeof root !== "string" || root.length === 0) return invalid("workspace root must be a non-empty string");
    if (root.length > MAX_ROOT_NAME_LENGTH) return invalid(`workspace root is longer than ${MAX_ROOT_NAME_LENGTH} characters`);
    if (root.includes("\0") || root.includes("/") || root !== root.trim()) {
        return invalid("workspace root must be a root name, not a path");
    }
    const folder = raw.folder;
    if (folder === undefined || folder === null) return { ok: true, workspace: { schema: 1, root } };
    if (typeof folder !== "string") return invalid("workspace folder must be a string");
    if (folder.length > MAX_FOLDER_LENGTH) return invalid(`workspace folder is longer than ${MAX_FOLDER_LENGTH} characters`);
    if (folder.includes("\0")) return invalid("workspace folder must not contain a NUL character");
    if (folder.startsWith("/")) return invalid("workspace folder must be relative to the root");
    const normalized = path.posix.normalize(folder).replace(/\/+$/, "");
    if (normalized === ".." || normalized.startsWith("../")) return invalid("workspace folder must stay inside the root");
    if (normalized === "" || normalized === ".") return { ok: true, workspace: { schema: 1, root } };
    return { ok: true, workspace: { schema: 1, root, folder: normalized } };
}

/** Two records name the same folder. Both must already be normalized. */
export function sameWorkspace(a: SessionWorkspace | null | undefined, b: SessionWorkspace | null | undefined): boolean {
    if (!a || !b) return !a && !b;
    return a.root === b.root && (a.folder ?? "") === (b.folder ?? "");
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
     * files (section 4.6), inside the same deadline.
     */
    collect?: { agents?: boolean; skills?: boolean; instructions?: boolean };
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
}

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
