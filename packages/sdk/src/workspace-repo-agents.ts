/**
 * Repo-native agents and skills (docs/proposals/session-workspaces.md,
 * section 4.6).
 *
 * The path check (workspace-check.ts) reads `.github/agents/*.agent.md` and
 * names the folders under `.github/skills` when the provider's `adopt` asks
 * for them. This module turns that into CLI config for one session:
 *
 *   1. Parse each agent file: frontmatter plus the markdown body.
 *   2. Filter it: tools, MCP servers, model, name collisions.
 *   3. Report what was adopted and what was skipped, and hash what reaches
 *      the CLI, for the binding fingerprint.
 *
 * Repo agents run as native `task` children. The CLI limits each child to
 * its agent's tool list; RepoAgentAccess tells the native child guard
 * (native-subagents.ts) which children belong to adopted agents.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CustomAgentConfig } from "@github/copilot-sdk";
import type { RepoScan } from "./workspace-check.js";
import type { WorkspaceAdopt, WorkspaceAdoptionReport } from "./types.js";

export interface ParsedRepoAgent {
    name: string;
    description: string;
    prompt: string;
    /** Undefined when the file has no `tools` key: the CLI then gives the agent every tool. */
    tools?: string[];
    model?: string;
    hasMcpServers: boolean;
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function unquote(value: string): string {
    const v = value.trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
    return v;
}

/** `[a, "b"]`, `a, b`, `'a, b'` or a single name. */
function toolList(value: string): string[] {
    const v = value.trim();
    const inner = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : unquote(v);
    return inner.split(",").map(unquote).filter(Boolean);
}

/**
 * Parse a GitHub custom agent file. Supported frontmatter keys: `name`
 * (defaults to the file name), `description`, `tools` (a YAML list, an
 * inline list, or a comma list), `model`, and `mcp-servers` (noted, never
 * used). Other keys are ignored. The body is the agent's prompt.
 */
export function parseRepoAgentFile(file: string, content: string): { ok: true; agent: ParsedRepoAgent } | { ok: false; reason: string } {
    // A byte-order mark and trailing spaces on the --- lines are allowed. A
    // file that opens a frontmatter block that does not parse is refused,
    // never read as all prompt: its `tools:` line would be lost, and the
    // agent would get every tool (review R8).
    const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const fallbackName = path.posix.basename(file).replace(/\.agent\.md$/, "");
    let meta: Record<string, string | string[]> = {};
    let body = text;
    let hasMcpServers = false;
    const allLines = text.split("\n");
    const fence = (line: string) => /^---[ \t]*$/.test(line);
    const firstContent = allLines.findIndex((line) => line.trim() !== "");
    if (firstContent >= 0 && allLines[firstContent].trimStart().startsWith("---")) {
        if (firstContent !== 0 || !fence(allLines[0])) {
            return { ok: false, reason: "the frontmatter must start with a --- line at the top of the file" };
        }
        const close = allLines.findIndex((line, index) => index > 0 && fence(line));
        if (close < 0) return { ok: false, reason: "the frontmatter has no closing ---" };
        const lines = allLines.slice(1, close);
        body = allLines.slice(close + 1).join("\n");
        let key: string | null = null;
        let block: string[] | null = null;
        const flush = () => {
            if (key && block) meta[key] = block.join(" ").replace(/\s+/g, " ").trim();
            block = null;
        };
        for (const line of lines) {
            if (block !== null) {
                if (/^\s/.test(line) || line.trim() === "") { block.push(line.trim()); continue; }
                flush();
            }
            if (!line.trim() || line.trim().startsWith("#")) continue;
            const item = /^\s+-\s+(.*)$/.exec(line);
            if (item && key) {
                const list = Array.isArray(meta[key]) ? meta[key] as string[] : [];
                list.push(unquote(item[1]));
                meta[key] = list;
                continue;
            }
            if (/^\s/.test(line)) continue; // nested mapping lines (mcp-servers)
            const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
            if (!pair) continue;
            key = pair[1];
            const value = pair[2];
            if (key === "mcp-servers" || key === "mcpServers") hasMcpServers = true;
            if (value === ">" || value === "|" || value === ">-" || value === "|-") { block = []; continue; }
            meta[key] = value === "" ? [] : value;
        }
        flush();
    }
    const scalar = (k: string): string | undefined => (typeof meta[k] === "string" ? unquote(meta[k] as string) : undefined);
    const name = scalar("name") || fallbackName;
    if (!AGENT_NAME.test(name)) return { ok: false, reason: `invalid agent name "${name}"` };
    const prompt = body.trim();
    if (!prompt) return { ok: false, reason: "the agent file has no instructions" };
    let tools: string[] | undefined;
    if (Object.hasOwn(meta, "tools")) {
        const raw = meta.tools;
        tools = Array.isArray(raw) ? raw.filter(Boolean) : toolList(raw);
    }
    return {
        ok: true,
        agent: {
            name,
            description: scalar("description") || `Repo agent from ${file}.`,
            prompt,
            ...(tools !== undefined ? { tools } : {}),
            ...(scalar("model") ? { model: scalar("model") } : {}),
            hasMcpServers,
        },
    };
}

export interface RepoAdoptionInput {
    scan: RepoScan | undefined;
    adopt: WorkspaceAdopt | undefined;
    /** The attach path. The CLI finds `.github/skills` at the scan's clone root, relative to it. */
    attachPath: string;
    /** Native tasks are on for this session (worker setting and the owner's copilot.native_tasks). */
    nativeTasks: boolean;
    /** Every adopted agent runs on the session's model; the child guard pins it anyway. */
    sessionModel: string;
    /** PilotSwarm's own tool names. A native child cannot call them, so repo agents never list them. */
    pilotswarmToolNames: ReadonlySet<string>;
    /** Names that win a collision: the native profiles, the CLI's built-in agents, the worker's loaded agents. */
    reservedAgentNames: ReadonlySet<string>;
}

export interface RepoAdoption {
    customAgents: CustomAgentConfig[];
    skillDirectories: string[];
    report: WorkspaceAdoptionReport;
    /** A digest of everything that reaches the CLI. Set only when adopt asks for agents, skills or instructions. */
    hash?: string;
}

/** Filter the scanned repo content for one session (section 4.6). */
export function resolveRepoAdoption(input: RepoAdoptionInput): RepoAdoption {
    const { scan, adopt } = input;
    const skipped: WorkspaceAdoptionReport["skipped"] = [...(scan?.skipped ?? [])];
    const customAgents: CustomAgentConfig[] = [];
    const agentNames: string[] = [];
    if (adopt?.agents && scan) {
        const seen = new Set<string>();
        for (const { file, content } of scan.agents) {
            if (!input.nativeTasks) {
                skipped.push({ kind: "agent", file, reason: "native tasks are off for this session (copilot.native_tasks)" });
                continue;
            }
            const parsed = parseRepoAgentFile(file, content);
            if (!parsed.ok) {
                skipped.push({ kind: "agent", file, reason: parsed.reason });
                continue;
            }
            const agent = parsed.agent;
            if (input.reservedAgentNames.has(agent.name)) {
                skipped.push({ kind: "agent", file, name: agent.name, reason: "a PilotSwarm agent has this name" });
                continue;
            }
            if (seen.has(agent.name)) {
                skipped.push({ kind: "agent", file, name: agent.name, reason: "an earlier repo agent file has this name" });
                continue;
            }
            const dropped: string[] = [];
            let tools: string[] | undefined;
            if (agent.tools !== undefined) {
                tools = [];
                for (const tool of agent.tools) {
                    if (tool.includes("/")) dropped.push(`${tool} (MCP tool)`);
                    else if (input.pilotswarmToolNames.has(tool)) dropped.push(`${tool} (PilotSwarm tool)`);
                    else tools.push(tool);
                }
                // Never pass []: the CLI reads it as "no tools".
                if (tools.length === 0) {
                    skipped.push({
                        kind: "agent", file, name: agent.name,
                        reason: agent.tools.length === 0 ? "the agent lists no tools" : `no usable tools: ${dropped.join(", ")}`,
                    });
                    continue;
                }
            }
            if (agent.hasMcpServers) dropped.push("its MCP servers");
            if (agent.model && agent.model !== input.sessionModel) dropped.push(`model ${agent.model} (runs on the session model)`);
            if (dropped.length > 0) skipped.push({ kind: "agent", file, name: agent.name, reason: `adopted without: ${dropped.join(", ")}` });
            seen.add(agent.name);
            agentNames.push(agent.name);
            customAgents.push({
                name: agent.name,
                description: agent.description,
                prompt: agent.prompt,
                ...(tools ? { tools } : {}),
                model: input.sessionModel,
                infer: true,
            } as CustomAgentConfig);
        }
    }
    const skills = adopt?.skills && scan ? [...scan.skills].sort() : [];
    // The skills folder is the clone root's, which is above the attach path
    // when the workspace is a subfolder of the clone.
    const skillDirectories = skills.length > 0 && typeof scan?.cloneRoot === "string"
        ? [path.join(input.attachPath, scan.cloneRoot, ".github", "skills")]
        : [];
    const repo = typeof scan?.cloneRoot === "string" ? path.basename(path.resolve(input.attachPath, scan.cloneRoot)) : undefined;
    const report: WorkspaceAdoptionReport = { ...(repo ? { repo } : {}), agents: [...agentNames].sort(), skills, skipped };
    const asked = Boolean(adopt?.agents || adopt?.skills || adopt?.instructions);
    return {
        customAgents,
        skillDirectories,
        report,
        ...(asked ? {
            hash: createHash("sha256").update(JSON.stringify({
                agents: customAgents.map((a) => [a.name, a.description, a.prompt, a.tools ?? null, (a as any).model]),
                skills,
                skillDirectories,
                // The CLI reads the instruction files when it creates or
                // resumes the session, so a changed file must resume it.
                ...(adopt?.instructions ? { instructions: scan?.instructions ?? [] } : {}),
            })).digest("hex"),
        } : {}),
    };
}

/** Two reports name the same agents, skills and skips, from every source. */
export function sameAdoption(a: WorkspaceAdoptionReport, b: WorkspaceAdoptionReport): boolean {
    const key = (r: WorkspaceAdoptionReport) => JSON.stringify([r.agents, r.skills, r.skipped, r.personal ?? null, r.loaded ?? null]);
    return key(a) === key(b);
}

/** Each source's names, with how the note calls it. */
function adoptedGroups(report: WorkspaceAdoptionReport): Array<{ label: string; agents: string[]; skills: string[] }> {
    return [
        { label: "Repo", agents: report.agents, skills: report.skills },
        { label: "Your own", agents: report.personal?.agents ?? [], skills: report.personal?.skills ?? [] },
        { label: "Loaded", agents: report.loaded?.agents ?? [], skills: report.loaded?.skills ?? [] },
    ];
}

/**
 * The note a turn gets when its adopted set is new or changed. `previous`
 * null means nothing was adopted before (the first adoption). "Your own"
 * are the person's folder's (section 4.11); "Loaded" were loaded by path (4.12).
 */
export function adoptionNote(previous: WorkspaceAdoptionReport | null, next: WorkspaceAdoptionReport): string | undefined {
    const list = (names: string[]) => names.join(", ");
    if (!previous) {
        const parts = adoptedGroups(next).flatMap((group) => [
            group.agents.length ? `${group.label} agents available through the task tool: ${list(group.agents)}.` : "",
            group.skills.length ? `${group.label} skills available: ${list(group.skills)}.` : "",
        ]).filter(Boolean);
        return parts.length ? parts.join(" ") : undefined;
    }
    const diff = (before: string[], after: string[]) => ({
        added: after.filter((n) => !before.includes(n)),
        removed: before.filter((n) => !after.includes(n)),
    });
    const describe = (label: string, kind: string, d: { added: string[]; removed: string[] }) =>
        d.added.length || d.removed.length
            ? `${label} ${kind} changed: added ${list(d.added) || "none"}, removed ${list(d.removed) || "none"}.`
            : "";
    const before = adoptedGroups(previous);
    const parts = adoptedGroups(next).flatMap((group, i) => [
        describe(group.label, "agents", diff(before[i].agents, group.agents)),
        describe(group.label, "skills", diff(before[i].skills, group.skills)),
    ]).filter(Boolean);
    return parts.length ? parts.join(" ") : undefined;
}

/**
 * Which native children belong to adopted repo agents, from the runtime's
 * subagent events (never from model arguments). Per CLI handle.
 */
export class RepoAgentAccess {
    private readonly children = new Map<string, string>();

    constructor(
        private readonly names: ReadonlySet<string>,
        private readonly pilotswarmToolNames: ReadonlySet<string>,
    ) {}

    has(name: string): boolean {
        return this.names.has(name);
    }

    observe(event: any): void {
        if (event?.type === "subagent.started" && event.agentId && this.names.has(event.data?.agentName)) {
            this.children.set(event.agentId, event.data.agentName);
        } else if ((event?.type === "subagent.completed" || event?.type === "subagent.failed") && event.agentId) {
            this.children.delete(event.agentId);
        } else if (["session.idle", "session.error", "abort"].includes(event?.type) && !event.agentId) {
            this.children.clear();
        }
    }

    /**
     * A child of an adopted agent may use CLI tools: the CLI already limits
     * it to its agent's list. Never a PilotSwarm tool, and never `task`.
     */
    allowsHook(sessionId: string, toolName: string): boolean {
        return this.children.has(sessionId) && toolName !== "task" && !this.pilotswarmToolNames.has(toolName);
    }

    /** Never persist runtime identity maps with session config. */
    toJSON(): undefined { return undefined; }
}

// ─── Several sources: loaded files, the repo, the person's folder ──────

/** Where adopted content comes from, winner first on a name clash (sections 4.11, 4.12). */
export type AdoptionSourceKind = "loaded" | "repo" | "personal";

export interface AdoptionSource {
    kind: AdoptionSourceKind;
    scan: RepoScan | undefined;
    adopt: WorkspaceAdopt | undefined;
    /** The folder the scan ran on; skills sit under <attachPath>/<cloneRoot>/.github/skills. */
    attachPath: string;
    /** Skills given as folders of their own (loaded by path), instead of the scan's .github/skills names. */
    skillFolders?: Array<{ name: string; path: string }>;
}

export interface WorkspaceAdoptionInput extends Omit<RepoAdoptionInput, "scan" | "adopt" | "attachPath"> {
    /** In precedence order: on a name clash the earlier source wins. */
    sources: AdoptionSource[];
}

export interface WorkspaceAdoption extends RepoAdoption {
    /** Every adopted skill: its name, folder and source, winner first. */
    skills: Array<{ name: string; path: string; kind: AdoptionSourceKind }>;
    /**
     * The skills cannot be given to the CLI as one source's skills folder
     * (several sources, or a folder with a skill that lost a clash): the
     * caller links each adopted skill into a folder of its own
     * (linkSkillFolders) and gives the CLI that folder.
     */
    linkSkills: boolean;
}

const SOURCE_LABEL: Record<AdoptionSourceKind, string> = { loaded: "a loaded", repo: "the repo's", personal: "your own" };

/**
 * Adoption from several sources (sections 4.6, 4.11, 4.12): files loaded by
 * path first, then the repo's, then the person's own folder. A name taken by
 * an earlier source is skipped in a later one, with the reason. With the
 * repo as the only source, the result is resolveRepoAdoption's.
 */
export function resolveWorkspaceAdoption(input: WorkspaceAdoptionInput): WorkspaceAdoption {
    const { sources, ...rest } = input;
    const live = sources.filter((source) => source.adopt || (source.skillFolders?.length ?? 0) > 0);
    if (live.length <= 1 && (live[0]?.kind ?? "repo") === "repo" && !(live[0]?.skillFolders?.length)) {
        const only = live[0];
        const single = resolveRepoAdoption({ ...rest, scan: only?.scan, adopt: only?.adopt, attachPath: only?.attachPath ?? "" });
        const skillPath = single.skillDirectories[0];
        return {
            ...single,
            skills: single.report.skills.map((name) => ({ name, path: path.join(skillPath ?? "", name), kind: "repo" as const })),
            linkSkills: false,
        };
    }
    const customAgents: CustomAgentConfig[] = [];
    const skills: WorkspaceAdoption["skills"] = [];
    const skipped: WorkspaceAdoptionReport["skipped"] = [];
    const winner = new Map<string, AdoptionSourceKind>();
    const skillWinner = new Map<string, AdoptionSourceKind>();
    const lists: Record<AdoptionSourceKind, { agents: string[]; skills: string[] }> = {
        loaded: { agents: [], skills: [] }, repo: { agents: [], skills: [] }, personal: { agents: [], skills: [] },
    };
    let repoName: string | undefined;
    let lostSkill = false;
    let skillSourceCount = 0;
    const hashParts: unknown[] = [];
    for (const source of live) {
        const tag = source.kind === "repo" ? {} : { source: source.kind as "personal" | "loaded" };
        const one = resolveRepoAdoption({ ...rest, scan: source.scan, adopt: source.adopt, attachPath: source.attachPath });
        for (const skip of one.report.skipped) skipped.push({ ...skip, ...tag });
        if (source.kind === "repo" && one.report.repo) repoName = one.report.repo;
        for (const agent of one.customAgents) {
            const taken = winner.get(agent.name);
            if (taken) {
                skipped.push({ kind: "agent", file: agent.name, name: agent.name, reason: `${SOURCE_LABEL[taken]} agent has this name`, ...tag });
                continue;
            }
            winner.set(agent.name, source.kind);
            customAgents.push(agent);
            lists[source.kind].agents.push(agent.name);
        }
        const folders = source.skillFolders
            ?? one.report.skills.map((name) => ({ name, path: path.join(one.skillDirectories[0] ?? "", name) }));
        if (folders.length > 0) skillSourceCount += 1;
        for (const folder of folders) {
            const taken = skillWinner.get(folder.name);
            if (taken) {
                lostSkill = true;
                skipped.push({ kind: "skill", file: folder.name, name: folder.name, reason: `${SOURCE_LABEL[taken]} skill has this name`, ...tag });
                continue;
            }
            skillWinner.set(folder.name, source.kind);
            skills.push({ ...folder, kind: source.kind });
            lists[source.kind].skills.push(folder.name);
        }
        hashParts.push([source.kind, one.hash ?? null, folders.map((f) => [f.name, f.path])]);
    }
    const linkSkills = skillSourceCount > 1 || lostSkill || live.some((source) => (source.skillFolders?.length ?? 0) > 0);
    const skillDirectories = linkSkills || skills.length === 0
        ? []
        : [path.dirname(skills[0].path)];
    const sorted = (names: string[]) => [...names].sort();
    const report: WorkspaceAdoptionReport = {
        ...(repoName ? { repo: repoName } : {}),
        agents: sorted(lists.repo.agents),
        skills: sorted(lists.repo.skills),
        skipped,
        ...(lists.personal.agents.length || lists.personal.skills.length
            ? { personal: { agents: sorted(lists.personal.agents), skills: sorted(lists.personal.skills) } } : {}),
        ...(lists.loaded.agents.length || lists.loaded.skills.length
            ? { loaded: { agents: sorted(lists.loaded.agents), skills: sorted(lists.loaded.skills) } } : {}),
    };
    return {
        customAgents,
        skills,
        skillDirectories,
        linkSkills,
        report,
        hash: createHash("sha256").update(JSON.stringify(hashParts)).digest("hex"),
    };
}

/**
 * The folder of links for adopted skills from several sources: one link per
 * skill, named by the skill, to its folder. Local to this worker; rebuilt
 * whenever the set changes. Returns the folder.
 */
export function linkSkillFolders(dir: string, skills: Array<{ name: string; path: string }>): string {
    fs.mkdirSync(dir, { recursive: true });
    const wanted = new Map(skills.map((skill) => [skill.name, skill.path]));
    for (const entry of fs.readdirSync(dir)) {
        const target = wanted.get(entry);
        const full = path.join(dir, entry);
        let current: string | null = null;
        try { current = fs.readlinkSync(full); } catch { current = null; }
        if (target === undefined || current !== target) fs.rmSync(full, { force: true, recursive: true });
    }
    for (const [name, target] of wanted) {
        const full = path.join(dir, name);
        if (!fs.existsSync(full) && !isLink(full)) fs.symlinkSync(target, full, "dir");
    }
    return dir;
}

function isLink(full: string): boolean {
    try { return fs.lstatSync(full).isSymbolicLink(); } catch { return false; }
}
