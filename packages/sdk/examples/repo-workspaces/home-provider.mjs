/**
 * Each person's own folder (docs/proposals/session-workspaces.md, section 4.11).
 * One root, for example home=/ws/home, holds a folder per person:
 *
 *   <home>/users/<person>/          the person's folder
 *     AGENTS.md                     their instructions for every session
 *     .github/agents/*.agent.md     their agents (native tasks)
 *     .github/skills/<name>/        their skills
 *
 * defaultFolders(ctx)   every session gets its person's folder: the working
 *                       folder when its record has none, else extra folder
 *                       "home"; plus the plain roots named in defaultExtras
 *                       (for example "shared"), as extra folders. System
 *                       sessions and their sub-agents get none
 * ensureAttached(req)   the root's marker; the folder must be the session
 *                       owner's own (level 1: a path rule against mistakes,
 *                       not a security wall; every session is uid 1000); a
 *                       person's folder that does not exist yet is made and
 *                       given the starter files; everything in the person's
 *                       folder is adopted, with no git needed (adopt.folder)
 *
 * Folder names (personFolderName): a signed-in person by email, lowercased,
 * with other characters as "_" (Ada@Example.com ->
 * ada_example.com); a portal without sign-in -> "_anon"; a system
 * session and its sub-agents -> "_system" (used only when such a session sets
 * that folder itself). A name starting with "_" is never a person's. An email
 * that changes gives a new, empty folder.
 *
 * File calls on the mount run in child processes with a deadline.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeOutOfProcess } from "./provider.mjs";
import { MARKER_FILE } from "./repo-service.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The starter files a new person's folder gets. */
export const DEFAULT_HOME_SEED = path.join(HERE, "seed", "home");

const ADOPT_ALL = Object.freeze({ agents: true, skills: true, instructions: true, folder: true });

/** The folder name of a session's person (see the header). */
export function personFolderName(owner, isSystem) {
    if (isSystem || !owner || owner.provider === "system") return "_system";
    if (owner.provider === "anonymous") return "_anon";
    const email = typeof owner.email === "string" ? owner.email.trim().toLowerCase() : "";
    const raw = email || `${owner.provider}-${owner.subject}`.toLowerCase();
    let name = raw.replace(/[^a-z0-9._-]/g, "_").replace(/_+/g, "_").slice(0, 128);
    // "_..." is reserved (_anon, _system); ".", ".." and hidden names are not folders for people.
    if (!name || name.startsWith("_") || name.startsWith(".")) name = `u${name}`;
    return name;
}

// Makes <root>/<folder> and copies the starter files into it without
// replacing anything that is there. Prints {"made":true|false}.
const MAKE_SCRIPT = `
const fs = require("fs"), path = require("path");
const [root, folder, seed] = process.argv.slice(1);
const target = path.join(root, folder);
let made = false;
try { fs.mkdirSync(target); made = true; } catch (e) { if (e.code !== "EEXIST") throw e; }
const copy = (from, to) => {
  let entries = [];
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch (e) { return; }
  for (const entry of entries) {
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) { try { fs.mkdirSync(b); } catch (e) { if (e.code !== "EEXIST") throw e; } copy(a, b); }
    else if (entry.isFile()) { try { fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code !== "EEXIST") throw e; } }
  }
};
if (made && seed) copy(seed, target);
process.stdout.write(JSON.stringify({ made }));
`;

function makePersonFolder(rootPath, folder, seedDir, timeoutMs) {
    return new Promise((resolve) => {
        execFile(process.execPath, ["-e", MAKE_SCRIPT, rootPath, folder, seedDir ?? ""], { timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout) => {
            if (error) return resolve({ ok: false, message: error.killed ? `no answer within ${timeoutMs} ms` : String(error.message ?? error).split("\n")[0] });
            try { resolve({ ok: true, ...JSON.parse(String(stdout || "{}")) }); } catch { resolve({ ok: false, message: "unreadable answer" }); }
        });
    });
}

/**
 * @param {object} options
 * @param {{ name: string, path: string }} options.root       the home root
 * @param {() => ({ getSession(id: string): Promise<any> } | null)} options.getCatalog  the worker's session catalog
 * @param {string[]} [options.defaultExtras]  plain root names every session gets as extra folders of the same name
 * @param {string|null} [options.seedDir]     starter files for a new person's folder (default: seed/home; null: none)
 * @param {(root) => boolean|Promise<boolean>} [options.isMounted]
 * @param {(root) => Promise<void>} [options.attach]
 * @param {(root) => Promise<void>} [options.remount]
 * @param {number} [options.statTimeoutMs]
 */
export function createHomeProvider(options) {
    const root = { name: options.root.name, path: options.root.path };
    const statTimeoutMs = options.statTimeoutMs ?? 5_000;
    const seedDir = options.seedDir === undefined ? DEFAULT_HOME_SEED : options.seedDir;
    const defaultExtras = [...new Set(options.defaultExtras ?? [])];
    const fail = (code, message, retryAfterMs) => ({ ok: false, code, message, ...(retryAfterMs ? { retryAfterMs } : {}) });
    // A session's person never changes: one catalog read per session.
    const people = new Map();
    const personOf = async (sessionId) => {
        if (people.has(sessionId)) return people.get(sessionId);
        const row = await options.getCatalog?.()?.getSession(sessionId);
        if (!row) return null;
        const name = personFolderName(row.owner ?? null, Boolean(row.isSystem));
        if (people.size > 5_000) people.clear();
        people.set(sessionId, name);
        return name;
    };

    return {
        async listRoots() {
            return [{ ...root }];
        },

        defaultFolders(ctx) {
            // PilotSwarm's own system agents, and their sub-agents, keep
            // running as they did: no default folders. They can still set
            // users/_system as their workspace themselves.
            const person = personFolderName(ctx.owner, ctx.isSystem);
            if (person === "_system") return null;
            return {
                home: { name: "home", root: root.name, folder: `users/${person}` },
                ...(defaultExtras.length > 0 ? { extra: Object.fromEntries(defaultExtras.map((name) => [name, { root: name }])) } : {}),
            };
        },

        async ensureAttached(req) {
            if (req.workspace.root !== root.name) return fail("WORKSPACE_ROOT_UNKNOWN", `root "${req.workspace.root}" is not served by this provider`);
            if (options.attach && !(await options.isMounted?.(root))) {
                try { await options.attach(root); } catch (error) {
                    return fail("WORKSPACE_ATTACH_FAILED", `attach of root "${root.name}" failed: ${error?.message ?? error}`, 30_000);
                }
            }
            // The owner rule (level 1): only this session's person's folder.
            let person;
            try { person = await personOf(req.sessionId); } catch (error) {
                return fail("WORKSPACE_ATTACH_FAILED", `could not read the session's owner: ${error?.message ?? error}`, 30_000);
            }
            if (!person) return fail("WORKSPACE_ATTACH_FAILED", "the session's owner is unknown", 30_000);
            const folder = path.posix.normalize(req.workspace.folder ?? "");
            const mine = `users/${person}`;
            if (folder !== mine && !folder.startsWith(`${mine}/`)) {
                return fail("WORKSPACE_PATH_INVALID", `folder "${folder}" is not this session's own folder (${mine}) in root "${root.name}"`);
            }
            let probe = await probeOutOfProcess(root.path, folder, statTimeoutMs);
            if (probe.marker === "TIMEOUT") return fail("WORKSPACE_ATTACH_TIMEOUT", `root "${root.name}" did not answer within ${statTimeoutMs} ms`, 30_000);
            if (probe.marker === "ESTALE") {
                Promise.resolve().then(() => options.remount?.(root)).catch(() => undefined);
                return fail("WORKSPACE_STALE_MOUNT", `root "${root.name}" has a stale file handle; it needs a remount`, 30_000);
            }
            if (probe.marker !== "ok") return fail("WORKSPACE_NOT_MOUNTED", `root "${root.name}" has no ${MARKER_FILE} marker (${probe.marker})`, 30_000);
            if (probe.folderError && folder === mine) {
                // First use: make the person's folder and give it the starter files.
                const made = await makePersonFolder(root.path, mine, seedDir, statTimeoutMs * 2);
                if (!made.ok) return fail("WORKSPACE_ATTACH_FAILED", `could not make ${mine}: ${made.message}`, 30_000);
                probe = await probeOutOfProcess(root.path, folder, statTimeoutMs);
            }
            if (probe.marker !== "ok" || probe.folderError) {
                return fail("WORKSPACE_FOLDER_MISSING", `folder "${folder}" is not available (${probe.folderError ?? probe.marker})`);
            }
            // The real path must stay inside the person's folder: a link out of it is refused.
            if (probe.rel !== mine && !String(probe.rel).startsWith(`${mine}/`)) {
                return fail("WORKSPACE_PATH_INVALID", `folder "${folder}" resolves outside ${mine}`);
            }
            return { ok: true, path: folder ? path.join(root.path, folder) : root.path, adopt: { ...ADOPT_ALL } };
        },
    };
}
