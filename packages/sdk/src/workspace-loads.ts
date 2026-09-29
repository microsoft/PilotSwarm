/**
 * Agents and skills loaded by path (docs/proposals/session-workspaces.md,
 * section 4.12). A session loads a file that sits in one of its attached
 * folders (the working folder or an extra folder, defaults included):
 *
 *   load_agent({ path })   an .agent.md file: a native task agent from the next turn
 *   load_skill({ path })   a skill folder, or its SKILL.md: the body now, and a
 *                          skill the CLI offers from the next turn
 *
 * A load is saved with the session (its capability state), relative to its
 * root, so it survives moves: every worker mounts a root at the same path.
 * Every turn the file is read again, so edits take effect. A loaded agent or
 * skill wins over the repo's and the person's own of the same name.
 */
import path from "node:path";
import type { WorkspaceLoad } from "./capability-catalog.js";
import { readWorkspaceFiles, type WorkspaceFileResult } from "./workspace-check.js";
import { parseRepoAgentFile, type AdoptionSource } from "./workspace-repo-agents.js";

/** A folder this turn attached: where its root is, and where the folder is. */
export interface AttachedFolder { root: string; rootPath: string; path: string }

type AttachInfo = {
    root: string; rootPath: string; path: string;
    extras?: Array<{ root: string; rootPath: string; path: string }>;
} | undefined | null;

/** The working folder and every extra folder this turn attached. */
export function attachedFoldersOf(attach: AttachInfo): AttachedFolder[] {
    if (!attach) return [];
    return [
        { root: attach.root, rootPath: attach.rootPath, path: attach.path },
        ...(attach.extras ?? []).map((extra) => ({ root: extra.root, rootPath: extra.rootPath, path: extra.path })),
    ];
}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);

/**
 * Where a path the model gave is: absolute, or relative to the working
 * folder. It must be inside an attached folder (the deepest one that holds
 * it wins). The load keeps the path relative to that folder's root.
 */
export function resolveLoadPath(input: unknown, folders: AttachedFolder[]):
    { ok: true; folder: AttachedFolder; absolute: string; rootRelative: string } | { ok: false; reason: string } {
    if (typeof input !== "string" || !input.trim() || input.includes("\0")) return { ok: false, reason: "path is required" };
    if (folders.length === 0) return { ok: false, reason: "this session has no attached folders in this turn" };
    const absolute = path.isAbsolute(input) ? path.normalize(input) : path.resolve(folders[0].path, input);
    const folder = folders
        .filter((candidate) => within(absolute, path.normalize(candidate.path)))
        .sort((a, b) => b.path.length - a.path.length)[0];
    if (!folder) {
        return { ok: false, reason: `${absolute} is not inside the working folder or an extra folder (${folders.map((f) => f.path).join(", ")})` };
    }
    const rootRelative = path.relative(folder.rootPath, absolute).split(path.sep).join("/");
    if (!rootRelative || rootRelative.startsWith("..")) return { ok: false, reason: `${absolute} is not inside its root` };
    return { ok: true, folder, absolute, rootRelative };
}

/** A SKILL.md: its name (frontmatter, else the folder's name), description and body. */
export function parseSkillFile(folderName: string, content: string): { ok: true; name: string; description: string; body: string } | { ok: false; reason: string } {
    const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    let meta: Record<string, string> = {};
    let body = text;
    const lines = text.split("\n");
    if (/^---[ \t]*$/.test(lines[0] ?? "")) {
        const close = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line));
        if (close < 0) return { ok: false, reason: "the frontmatter has no closing ---" };
        for (const line of lines.slice(1, close)) {
            const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
            if (pair) meta[pair[1]] = pair[2].trim().replace(/^(["'])(.*)\1$/, "$2");
        }
        body = lines.slice(close + 1).join("\n");
    }
    const name = meta.name || folderName;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return { ok: false, reason: `invalid skill name "${name}"` };
    if (!body.trim()) return { ok: false, reason: "the skill has no instructions" };
    return { ok: true, name, description: meta.description ?? "", body: body.trim() };
}

/** Read the files behind loads (tools and the per-turn setup share this). */
export async function readLoadFiles(
    requests: Array<{ kind: "agent" | "skill"; absolute: string; folder: AttachedFolder }>,
    timeoutMs?: number,
): Promise<WorkspaceFileResult[]> {
    return readWorkspaceFiles(requests.map((request) => ({ kind: request.kind, path: request.absolute, within: request.folder.path })),
        timeoutMs !== undefined ? { timeoutMs } : {});
}

export interface ResolvedLoads {
    /** The "loaded" source for the adoption merge, winner first; absent when nothing loaded could be read. */
    source?: AdoptionSource;
    /** Loads left out this turn, and why. */
    skipped: Array<{ kind: "agent" | "skill"; file: string; name: string; reason: string; source: "loaded" }>;
    /** Loaded skills for load_skill by name. */
    skillCatalog: Array<{ name: string; description: string; prompt: string }>;
}

/**
 * Every turn: read each load again, inside this turn's attached folders. A
 * load whose folder is not attached, or whose file is gone or changed its
 * name, is left out with the reason.
 */
export async function resolveWorkspaceLoads(loads: WorkspaceLoad[], folders: AttachedFolder[], timeoutMs?: number): Promise<ResolvedLoads> {
    const skipped: ResolvedLoads["skipped"] = [];
    const wanted: Array<{ load: WorkspaceLoad; absolute: string; folder: AttachedFolder }> = [];
    for (const load of loads) {
        const file = `${load.root}:${load.path}`;
        const folder = folders
            .filter((candidate) => candidate.root === load.root && within(path.join(candidate.rootPath, load.path), path.normalize(candidate.path)))
            .sort((a, b) => b.path.length - a.path.length)[0];
        if (!folder) {
            skipped.push({ kind: load.kind, file, name: load.name, reason: "its folder is not attached in this turn", source: "loaded" });
            continue;
        }
        wanted.push({ load, absolute: path.join(folder.rootPath, load.path), folder });
    }
    const results = await readLoadFiles(wanted.map((w) => ({ kind: w.load.kind, absolute: w.absolute, folder: w.folder })), timeoutMs);
    const agents: Array<{ file: string; content: string }> = [];
    const skillFolders: Array<{ name: string; path: string }> = [];
    const skillCatalog: ResolvedLoads["skillCatalog"] = [];
    wanted.forEach((w, index) => {
        const file = `${w.load.root}:${w.load.path}`;
        const result = results[index];
        if (!result?.ok) {
            skipped.push({ kind: w.load.kind, file, name: w.load.name, reason: result?.reason ?? "unreadable", source: "loaded" });
            return;
        }
        if (w.load.kind === "agent") {
            const parsed = parseRepoAgentFile(path.posix.basename(w.load.path), result.content);
            if (!parsed.ok || parsed.agent.name !== w.load.name) {
                skipped.push({ kind: "agent", file, name: w.load.name, source: "loaded",
                    reason: parsed.ok ? `the file now names agent "${parsed.agent.name}"; load it again` : parsed.reason });
                return;
            }
            agents.push({ file, content: result.content });
        } else {
            const parsed = parseSkillFile(path.basename(result.folder ?? ""), result.content);
            if (!parsed.ok || parsed.name !== w.load.name) {
                skipped.push({ kind: "skill", file, name: w.load.name, source: "loaded",
                    reason: parsed.ok ? `the file now names skill "${parsed.name}"; load it again` : parsed.reason });
                return;
            }
            skillFolders.push({ name: parsed.name, path: result.folder! });
            skillCatalog.push({ name: parsed.name, description: parsed.description, prompt: parsed.body });
        }
    });
    const source: AdoptionSource | undefined = agents.length > 0 || skillFolders.length > 0 ? {
        kind: "loaded",
        scan: { agents, skills: [], skipped: [], cloneRoot: "" },
        adopt: { agents: agents.length > 0, skills: false, instructions: false },
        attachPath: "",
        skillFolders,
    } : undefined;
    return { ...(source ? { source } : {}), skipped, skillCatalog };
}
