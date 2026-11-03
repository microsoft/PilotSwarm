import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { jsonResult, withToolErrors } from "../util/respond.js";

/**
 * Workflow support as the deployment advertises it (design 04 "Advertise
 * capability/version in bootstrap", D11; R26): the management client's own
 * answer, which is exactly what a bootstrap carries as `workflows` (web mode:
 * the server's bootstrap; direct mode: this process's own configuration, the
 * answer its server would advertise). Null from a host that advertises none
 * (an older server, or a client without the getter) or that cannot be asked
 * now. It reports configuration only: the server decides every call again.
 */
export async function workflowAdvertisement(ctx: ServerContext): Promise<Record<string, unknown> | null> {
    const mgmt = ctx.mgmt as { getWorkflowCapabilities?: () => Promise<Record<string, unknown> | null> };
    if (typeof mgmt.getWorkflowCapabilities !== "function") return null;
    try {
        const advertised = await mgmt.getWorkflowCapabilities();
        return advertised !== null && typeof advertised === "object" && !Array.isArray(advertised) ? advertised : null;
    } catch {
        return null;
    }
}

/**
 * Capability & identity descriptor (proposal G1).
 *
 * Two-layer discovery: conditional tool registration means an absent
 * capability's tools never appear in tools/list; this descriptor explains the
 * shape of what IS present, so clients can plan instead of probe. Flags are
 * frozen at boot (the same per-boot gate used for registration) — a restart
 * picks up provider changes, matching worker semantics.
 */
export function buildCapabilities(ctx: ServerContext) {
    return {
        mode: ctx.webMode ? "web" : "direct",
        admin: ctx.admin,
        // Ownership/visibility posture (security model): the caller's role and
        // whether the deployment enforces per-user session access. When
        // ownership_enforced is true, list_sessions returns only sessions you
        // can read and a send/read to another user's private session is
        // refused with the reason in the error.
        role: ctx.role ?? null,
        ownership_enforced: ctx.authz?.ownershipEnforced ?? false,
        admin_scope: ctx.authz?.adminScope ?? "unrestricted",
        authz_policy_version: ctx.authz?.policyVersion ?? 0,
        user_resource_bypass: ctx.admin && ctx.authz?.adminScope !== "cluster",
        system_session_admin: ctx.admin,
        default_visibility: ctx.authz?.defaultVisibility ?? "private",
        // Session groups are private per-user organization: list_session_groups
        // returns only the caller's groups, session views carry viewer_group_id
        // (the caller's own placement), and manage_session_group 'place' needs
        // only read access to the sessions being organized.
        viewerScopedGroups: true,
        facts: {
            search: Boolean(ctx.enhancedFacts?.capabilities.search),
            embedder: Boolean(ctx.enhancedFacts?.capabilities.embedder),
        },
        graph: Boolean(ctx.graph),
        // Optional-method probes on the graph provider — presence differs by
        // provider, not by transport.
        graph_namespaces: Boolean(ctx.graph && typeof (ctx.graph as any).listGraphNamespaces === "function"),
        graph_stats: Boolean(ctx.graph && typeof (ctx.graph as any).graphStats === "function"),
        models_configured: Boolean(ctx.models) || ctx.webMode,
        skills_prompts: ctx.skills.length,
        registered_agents: ctx.registeredAgents.length,
        // Image attachments on send_message/send_and_wait (web mode only —
        // refs are validated against the session's artifact store at the API
        // edge, which direct mode does not run).
        prompt: { imageAttachments: ctx.webMode },
        // The workflow tools this server registers, keyed as the deployment's
        // advertisement (`workflows.v2`, which get_capabilities and the
        // capabilities resource add) so a client compares them: no workflow
        // read tool here (the Web API's GET /sessions/:id/workflow reads),
        // and update_workflow only with the test-only option workflowCommands.
        workflow_tools: { read: false, commands: ctx.workflowCommands === true },
    };
}

export function registerCapabilityTools(server: McpServer, ctx: ServerContext) {
    server.registerTool(
        "get_capabilities",
        {
            title: "Get Capabilities",
            description:
                "Describe this PilotSwarm MCP server's capability surface: mode (web/direct), whether the caller's "
                + "credential carries the admin role, enhanced-facts search/embedder availability, graph availability, "
                + "and counts of registered agents/skills; the deployment's workflow support exactly as its bootstrap "
                + "advertises it (workflows: null from a host that advertises none) and the workflow tools this server "
                + "registers (workflow_tools). Use this before planning multi-step operations — tools for "
                + "absent capabilities are not registered at all.",
            inputSchema: {},
        },
        withToolErrors(async () => {
            // Embedded-worker count — live state, fetched fresh (web only).
            // IMPORTANT: this counts workers embedded in the PORTAL process.
            // Deployments running dedicated worker pods report 0 here even
            // with a healthy worker fleet; the truthful per-session signal is
            // worker_claimed on the create_session response.
            let embeddedWorkers: number | null = null;
            if (ctx.api) {
                try {
                    const w: any = await ctx.web.ops.getWorkerCount();
                    embeddedWorkers = typeof w === "number" ? w : (w?.count ?? w?.workers ?? null);
                } catch {
                    embeddedWorkers = null;
                }
            }
            let defaultModel: string | null = null;
            try {
                defaultModel = ctx.models
                    ? (ctx.models.defaultModel ?? null)
                    : ((await ctx.mgmt.getDefaultModel()) ?? null);
            } catch {
                defaultModel = null;
            }
            return jsonResult({
                ...buildCapabilities(ctx),
                workflows: await workflowAdvertisement(ctx),
                embedded_workers: embeddedWorkers,
                default_model: defaultModel,
            });
        }),
    );
}
