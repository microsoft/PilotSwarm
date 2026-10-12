/**
 * `pilotswarm workflows ...` — register and inspect Git-backed workflows.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
    PilotSwarmManagementClient,
    createSessionBlobStore,
    FilesystemArtifactStore,
} from "pilotswarm-sdk";
import { bootstrapApiAuth } from "./auth/cli.js";

const USAGE = `pilotswarm workflows — manage registered workflows

Usage:
  pilotswarm workflows register --repo <url> --ref <git-ref> --path <workflow.yaml> [--user|--shared] [--json]
  pilotswarm workflows list [--json]
  pilotswarm workflows show <definition-id> [--json]

Connection:
  --api-url <url>          defaults to PILOTSWARM_API_URL
  --store <postgres-url>   direct-store break-glass mode
  --schema <cms-schema>    direct-store CMS schema

Scope:
  --user (default)         visible only to the registering user
  --shared                 visible to every authenticated user`;

export function parseWorkflowArgs(argv) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--repo") flags.repositoryUrl = argv[++i];
        else if (arg === "--ref") flags.gitRef = argv[++i];
        else if (arg === "--path") flags.workflowPath = argv[++i];
        else if (arg === "--shared") flags.scope = "shared";
        else if (arg === "--user") flags.scope = "user";
        else if (arg === "--json") flags.json = true;
        else if (arg === "--api-url") flags.apiUrl = argv[++i];
        else if (arg === "--store") flags.store = argv[++i];
        else if (arg === "--schema") flags.schema = argv[++i];
        else if (arg === "--help" || arg === "-h") flags.help = true;
        else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        else positional.push(arg);
    }
    return { flags, positional };
}

function resolveMode(flags) {
    if (flags.store) return { mode: "direct", store: flags.store };
    const apiUrl = String(flags.apiUrl || process.env.PILOTSWARM_API_URL || "").trim();
    if (apiUrl) return { mode: "web", apiUrl: apiUrl.replace(/\/+$/, "") };
    if (process.env.DATABASE_URL) return { mode: "direct", store: process.env.DATABASE_URL };
    throw new Error(
        "no deployment configured — pass --api-url <url> (or set PILOTSWARM_API_URL), "
        + "or --store <postgres-url> for direct break-glass access",
    );
}

async function makeContext(flags) {
    const resolved = resolveMode(flags);
    if (resolved.mode === "web") {
        const { getAccessToken } = await bootstrapApiAuth(resolved.apiUrl, {
            interactive: true,
        });
        const client = new PilotSwarmManagementClient({
            apiUrl: resolved.apiUrl,
            getAccessToken,
        });
        await client.start();
        return {
            mode: "web",
            client,
            close: () => client.stop().catch(() => {}),
        };
    }

    console.error(
        "[pilotswarm workflows] direct-store mode — no deployment authentication or authorization.",
    );
    const sessionStateDir = process.env.SESSION_STATE_DIR
        || path.join(os.homedir(), ".copilot", "session-state");
    const artifactStore = createSessionBlobStore(process.env, { sessionStateDir })
        ?? new FilesystemArtifactStore(path.join(path.dirname(sessionStateDir), "artifacts"));
    const client = new PilotSwarmManagementClient({
        store: resolved.store,
        cmsSchema: flags.schema || process.env.PILOTSWARM_CMS_SCHEMA || undefined,
        artifactStore,
    });
    try {
        await client.start();
        return {
            mode: "direct",
            client,
            close: () => client.stop(),
        };
    } catch (error) {
        await client.stop().catch(() => {});
        throw error;
    }
}

function printDefinition(definition) {
    const scope = definition.scope === "shared" ? "shared" : "user";
    console.log(
        `${definition.definitionId}  ${definition.graphId}  ${scope}  ${definition.packageSource?.kind ?? ""}`,
    );
}

export async function runWorkflowsCommand(argv, dependencies = {}) {
    const { flags, positional } = parseWorkflowArgs(argv);
    const [command, ...rest] = positional;
    if (flags.help) {
        console.log(USAGE);
        return 0;
    }
    if (!command) {
        console.log(USAGE);
        return 1;
    }

    const contextFactory = dependencies.makeContext ?? makeContext;
    const ctx = await contextFactory(flags);
    try {
        if (command === "register") {
            if (!flags.repositoryUrl || !flags.gitRef || !flags.workflowPath) {
                console.error(
                    "usage: pilotswarm workflows register --repo <url> --ref <git-ref> --path <workflow.yaml> [--user|--shared]",
                );
                return 1;
            }
            const scope = flags.scope ?? "user";
            const owner = ctx.mode === "direct"
                ? { provider: "local", subject: os.userInfo().username }
                : null;
            const definition = await ctx.client.registerWorkflowDefinition({
                scope,
                source: {
                    kind: "git",
                    repositoryUrl: flags.repositoryUrl,
                    gitRef: flags.gitRef,
                    workflowPath: flags.workflowPath,
                },
            }, {
                scope,
                owner,
                isAdmin: ctx.mode === "direct",
                createdBy: ctx.mode === "direct"
                    ? `${os.userInfo().username}@cli`
                    : null,
            });
            if (flags.json) console.log(JSON.stringify(definition, null, 2));
            else printDefinition(definition);
            return 0;
        }

        if (command === "list") {
            const definitions = await ctx.client.listWorkflowDefinitions();
            if (flags.json) console.log(JSON.stringify(definitions, null, 2));
            else for (const definition of definitions) printDefinition(definition);
            return 0;
        }

        if (command === "show") {
            const definitionId = rest[0];
            if (!definitionId) {
                console.error("usage: pilotswarm workflows show <definition-id> [--json]");
                return 1;
            }
            const definition = await ctx.client.getWorkflowDefinition(definitionId);
            if (!definition) {
                console.error(`workflow definition not found: ${definitionId}`);
                return 1;
            }
            if (flags.json) console.log(JSON.stringify(definition, null, 2));
            else printDefinition(definition);
            return 0;
        }

        console.error(`unknown workflows command: ${command}`);
        return 1;
    } finally {
        await ctx.close();
    }
}
