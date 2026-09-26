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
    const text = content.replace(/\r\n/g, "\n");
    const fallbackName = path.posix.basename(file).replace(/\.agent\.md$/, "");
    let meta: Record<string, string | string[]> = {};
    let body = text;
    let hasMcpServers = false;
    if (text.startsWith("---\n")) {
        const end = text.indexOf("\n---", 3);
        if (end < 0) return { ok: false, reason: "the frontmatter has no closing ---" };
        const lines = text.slice(4, end).split("\n");
        body = text.slice(end + 4).replace(/^[^\n]*\n?/, "");
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
    /** The attach path: where the CLI finds `.github/skills`. */
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
    /** A digest of everything that reaches the CLI. Set only when adopt asks for agents or skills. */
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
    const skillDirectories = skills.length > 0 ? [path.join(input.attachPath, ".github", "skills")] : [];
    const report: WorkspaceAdoptionReport = { agents: [...agentNames].sort(), skills, skipped };
    const asked = Boolean(adopt?.agents || adopt?.skills);
    return {
        customAgents,
        skillDirectories,
        report,
        ...(asked ? {
            hash: createHash("sha256").update(JSON.stringify({
                agents: customAgents.map((a) => [a.name, a.description, a.prompt, a.tools ?? null, (a as any).model]),
                skills,
                skillDirectories,
            })).digest("hex"),
        } : {}),
    };
}

/** Two reports name the same agents, skills and skips. */
export function sameAdoption(a: WorkspaceAdoptionReport, b: WorkspaceAdoptionReport): boolean {
    return JSON.stringify([a.agents, a.skills, a.skipped]) === JSON.stringify([b.agents, b.skills, b.skipped]);
}

/**
 * The note a turn gets when its adopted set is new or changed. `previous`
 * null means nothing was adopted before (the first adoption).
 */
export function adoptionNote(previous: WorkspaceAdoptionReport | null, next: WorkspaceAdoptionReport): string | undefined {
    const list = (names: string[]) => names.join(", ");
    if (!previous) {
        const parts = [
            next.agents.length ? `Repo agents available through the task tool: ${list(next.agents)}.` : "",
            next.skills.length ? `Repo skills available: ${list(next.skills)}.` : "",
        ].filter(Boolean);
        return parts.length ? parts.join(" ") : undefined;
    }
    const diff = (before: string[], after: string[]) => ({
        added: after.filter((n) => !before.includes(n)),
        removed: before.filter((n) => !after.includes(n)),
    });
    const describe = (kind: string, d: { added: string[]; removed: string[] }) =>
        d.added.length || d.removed.length
            ? `Repo ${kind} changed: added ${list(d.added) || "none"}, removed ${list(d.removed) || "none"}.`
            : "";
    const parts = [describe("agents", diff(previous.agents, next.agents)), describe("skills", diff(previous.skills, next.skills))].filter(Boolean);
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
