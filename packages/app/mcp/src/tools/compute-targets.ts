import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, withToolErrors } from "../util/respond.js";

export function registerComputeTargetTools(server: McpServer, ctx: ServerContext) {
    // Web mode stamps the authenticated principal at the API edge. Direct
    // mode has no per-request identity, so it can manage shared targets only.
    const viewer = { principal: null, isAdmin: ctx.admin };

    server.registerTool(
        "list_compute_targets",
        {
            title: "List Compute Targets",
            description: "List shared compute targets and any personal targets visible to the caller.",
            inputSchema: {},
        },
        withToolErrors(async () => jsonResult(await ctx.mgmt.listComputeTargets(viewer))),
    );

    server.registerTool(
        "list_compute_target_models",
        {
            title: "List Compute Target Models",
            description: "List PilotSwarm models and the selected target's advertised host model options.",
            inputSchema: {
                name: z.string().min(1).describe("Full target name or a supported shorthand"),
            },
        },
        withToolErrors(async ({ name }) => jsonResult(await ctx.mgmt.listComputeTargetModels(viewer, name))),
    );

    server.registerTool(
        "manage_compute_target",
        {
            title: "Manage Compute Target",
            description:
                "Create, update, enable or disable, delete, or check a compute target. "
                + "Set mine=true for a personal target; mine=false selects the shared namespace and requires an administrator. "
                + "A check runs on a worker and records the target's advertised options.",
            inputSchema: {
                action: z.enum(["create", "update", "delete", "probe"]).describe("The operation to perform"),
                mine: z.boolean().describe("true = your personal target; false = shared target (admin)"),
                name: z.string().min(1).optional().describe("Full owner/label name or a supported shorthand"),
                label: z.string().min(1).optional().describe("Label used when creating a target; the owner namespace is assigned by PilotSwarm"),
                kind: z.string().min(1).optional().describe("Registered compute-provider kind (create)"),
                display_name: z.string().nullable().optional().describe("Optional display name"),
                config: z.record(z.string(), z.unknown()).nullable().optional().describe("Provider-specific target configuration"),
                enabled: z.boolean().optional().describe("Whether the target may be used"),
            },
        },
        withToolErrors(async ({ action, mine, name, label, kind, display_name, config, enabled }) => {
            if (action === "create") {
                if (!kind) throw new Error("create requires kind");
                const input = { name, label, kind, displayName: display_name, config };
                return jsonResult(mine
                    ? await ctx.mgmt.createMyComputeTarget(viewer, input)
                    : await ctx.mgmt.createComputeTarget(viewer, input));
            }
            if (!name) throw new Error(`${action} requires name`);
            if (action === "delete") {
                return jsonResult(mine
                    ? await ctx.mgmt.deleteMyComputeTarget(viewer, name)
                    : await ctx.mgmt.deleteComputeTarget(viewer, name));
            }
            if (action === "probe") {
                return jsonResult(mine
                    ? await ctx.mgmt.probeMyComputeTarget(viewer, name)
                    : await ctx.mgmt.probeComputeTarget(viewer, name));
            }
            const input = { name, displayName: display_name, config, enabled };
            return jsonResult(mine
                ? await ctx.mgmt.updateMyComputeTarget(viewer, input)
                : await ctx.mgmt.updateComputeTarget(viewer, input));
        }),
    );
}
