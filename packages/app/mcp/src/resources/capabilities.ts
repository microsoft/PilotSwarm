import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { buildCapabilities, workflowAdvertisement } from "../tools/capabilities.js";

export function registerCapabilityResources(server: McpServer, ctx: ServerContext) {
    server.registerResource(
        "capabilities",
        "pilotswarm://capabilities",
        {
            title: "Server Capabilities",
            description:
                "Capability descriptor for this MCP server: mode, admin role, enhanced-facts flags, graph availability, "
                + "the deployment's workflow support as its bootstrap advertises it, and the workflow tools this server registers.",
            mimeType: "application/json",
        },
        async (uri) => ({
            contents: [
                {
                    uri: uri.href,
                    text: JSON.stringify({ ...buildCapabilities(ctx), workflows: await workflowAdvertisement(ctx) }, null, 2),
                    mimeType: "application/json",
                },
            ],
        }),
    );
}
