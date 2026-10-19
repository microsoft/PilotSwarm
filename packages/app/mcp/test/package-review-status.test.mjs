import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/tools/agent-packages.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm" });
const { registerAgentPackageTools } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

for (const role of ["user", "admin"]) {
    test(`MCP publisher review status is available read-only to ${role}; administration stays separate`, async () => {
        const tools = new Map();
        const calls = [];
        const status = { packageId: "pkg", versions: [{ decision: "pending", executable: true, active: false }] };
        registerAgentPackageTools({ registerTool: (name, _options, handler) => tools.set(name, handler) }, {
            web: true, agentMgmt: "read", admin: true, role,
            mgmt: { getAgentPackageReviewStatus: async (...args) => { calls.push(args); return status; } },
        });
        assert.equal(tools.has("decide_agent_package_review"), false);
        const result = await tools.get("get_agent_package_review_status")({ package_id: "pkg" });
        assert.deepEqual(JSON.parse(result.content[0].text), status);
        assert.deepEqual(calls, [["pkg", null, role === "admin"]], "Web management transport, not the tool body, carries authenticated authority");
    });
}
