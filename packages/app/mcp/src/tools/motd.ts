import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MOTD_OPERATION_SPECS, MOTD_IMAGE_MAX_BYTES, MotdError } from "pilotswarm-sdk";
import type { ServerContext } from "../context.js";
import { jsonResult, withToolErrors } from "../util/respond.js";

export function registerMotdTools(server: McpServer, ctx: ServerContext) {
    const provider = process.env.PILOTSWARM_MCP_ACTOR_PROVIDER;
    const subject = process.env.PILOTSWARM_MCP_ACTOR_SUBJECT;
    const viewer = { principal: provider && subject ? { provider, subject } : null,
        isAdmin: !ctx.webMode && ctx.admin && process.env.PILOTSWARM_MCP_MOTD_ADMIN === "true" };
    const picture = z.object({ base64: z.string().max(Math.ceil(MOTD_IMAGE_MAX_BYTES / 3) * 4),
        contentType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), alt: z.string().min(1).max(1024) }).strict();
    for (const spec of MOTD_OPERATION_SPECS) {
        const inputSchema: Record<string, z.ZodTypeAny> = {};
        if (["dismiss", "delete", "image"].includes(spec.kind)) inputSchema.motdId = z.string().regex(/^[1-9]\d*$/);
        if (spec.kind === "image") inputSchema.mobile = z.boolean().optional();
        if (spec.kind === "list") {
            inputSchema.limit = z.number().int().min(1).max(200).optional();
            inputSchema.before = z.string().regex(/^[1-9]\d*$/).optional();
        }
        if (spec.kind === "create") Object.assign(inputSchema, {
            fromAt: z.string(), toAt: z.string(), bodyMd: z.string().min(1).max(16384),
            mobileBodyMd: z.string().max(16384).optional(), requestId: z.string().min(1).max(128),
            imagePlacement: z.enum(["above", "beside", "background"]).optional(),
            image: picture.optional(), mobileImage: picture.optional(),
        });
        server.registerTool(spec.name, { title: spec.name.replaceAll("_", " "), description: spec.description, inputSchema },
            withToolErrors(async (args) => {
                // Web mode derives privilege at the server. Direct mode needs
                // an explicit grant; possession of a catalog is not a grant.
                if (!ctx.webMode && spec.access === "fleet:admin" && !viewer.isAdmin)
                    throw new MotdError("MOTD_FORBIDDEN", "Direct message management requires an explicit admin grant", 403);
                switch (spec.kind) {
                    case "current": return jsonResult(await ctx.mgmt.getCurrentMotd(viewer));
                    case "dismiss": return jsonResult(await ctx.mgmt.dismissMotd(viewer, args.motdId));
                    case "delete": return jsonResult(await ctx.mgmt.deleteMotd(viewer, args.motdId));
                    case "image": return jsonResult(await ctx.mgmt.getMotdImage(viewer, args.motdId, args.mobile));
                    case "list": return jsonResult(await ctx.mgmt.listMotds(viewer, args.limit, args.before));
                    case "create": return jsonResult(await ctx.mgmt.createMotd(viewer, args));
                }
            }));
    }
}
