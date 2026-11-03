import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MOTD_OPERATION_SPECS, motdToolParameters, motdCreateInput, MotdError, type MotdToolProperty } from "pilotswarm-sdk";
import type { ServerContext } from "../context.js";
import { jsonResult, withToolErrors } from "../util/respond.js";

function fieldSchema(property: MotdToolProperty): z.ZodTypeAny {
    if (property.type === "object") {
        const fields: Record<string, z.ZodTypeAny> = {};
        for (const [key, field] of Object.entries(property.properties || {}))
            fields[key] = property.required?.includes(key) ? fieldSchema(field) : fieldSchema(field).optional();
        return z.object(fields).strict();
    }
    if (property.type === "boolean") return z.boolean();
    if (property.type === "integer") return z.number().int().min(property.minimum ?? 0).max(property.maximum ?? Number.MAX_SAFE_INTEGER);
    // z.enum publishes the allowed values in tools/list; a refine would hide them.
    if (property.enum?.length) return z.enum(property.enum as [string, ...string[]]);
    let field = z.string().min(property.minLength ?? 0).max(property.maxLength ?? 4096);
    if (property.pattern) field = field.regex(new RegExp(property.pattern));
    return field;
}
export function registerMotdTools(server: McpServer, ctx: ServerContext) {
    const provider = process.env.PILOTSWARM_MCP_ACTOR_PROVIDER;
    const subject = process.env.PILOTSWARM_MCP_ACTOR_SUBJECT;
    const viewer = { principal: provider && subject ? { provider, subject } : null,
        isAdmin: !ctx.webMode && ctx.admin && process.env.PILOTSWARM_MCP_MOTD_ADMIN === "true" };
    for (const spec of MOTD_OPERATION_SPECS) {
        const schema = motdToolParameters(spec);
        const inputSchema: Record<string, z.ZodTypeAny> = {};
        for (const [key, property] of Object.entries(schema.properties)) {
            const field = property.description ? fieldSchema(property).describe(property.description) : fieldSchema(property);
            inputSchema[key] = schema.required.includes(key) ? field : field.optional();
        }
        server.registerTool(spec.name, { title: spec.name.replaceAll("_", " "), description: spec.description, inputSchema },
            withToolErrors(async (args) => {
                // Web mode derives privilege at the server. Direct mode needs
                // an explicit grant; possession of a catalog is not a grant.
                if (!ctx.webMode && spec.access === "fleet:admin" && !viewer.isAdmin)
                    throw new MotdError("MOTD_FORBIDDEN", "Direct message management requires an explicit admin grant", 403);
                switch (spec.kind) {
                    case "current": return jsonResult(await ctx.mgmt.getCurrentMotd(viewer));
                    case "dismiss": return jsonResult(await ctx.mgmt.dismissMotd(viewer, z.string().parse(args.motdId)));
                    case "delete": return jsonResult(await ctx.mgmt.deleteMotd(viewer, z.string().parse(args.motdId)));
                    case "image": return jsonResult(await ctx.mgmt.getMotdImage(viewer, z.string().parse(args.motdId), z.boolean().optional().parse(args.mobile)));
                    case "list": return jsonResult(await ctx.mgmt.listMotds(viewer, z.number().optional().parse(args.limit), z.string().optional().parse(args.before)));
                    case "create": return jsonResult(await ctx.mgmt.createMotd(viewer, motdCreateInput(args)));
                }
            }));
    }
}
