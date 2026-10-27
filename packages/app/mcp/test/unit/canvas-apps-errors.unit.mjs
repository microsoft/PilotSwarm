/**
 * MCP canvas app tools keep a typed refusal typed: the legacy migration
 * applied while the canvas app transition is on (issue 181) comes back as an
 * error result with code CANVAS_LEGACY_MODE_ON and status 409, not as plain
 * text. Other errors keep their existing shape.
 *
 * Run: node mcp/test/unit/canvas-apps-errors.unit.mjs (after the MCP build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCanvasAppTools } from "../../dist/src/tools/canvas-apps.js";
import { errorToResult } from "../../dist/src/util/respond.js";

const MESSAGE = "the canvas app transition (PILOTSWARM_CANVAS_LEGACY_MODE) is on: switch it off before applying the migration; a dry run still works";

/** The error the Web API client raises for the server's 409 (api-client.js). */
function refusal() {
    return Object.assign(new Error(MESSAGE), { code: "CANVAS_LEGACY_MODE_ON", status: 409 });
}

async function withTools(web, run) {
    const server = new McpServer({ name: "canvas-apps-test", version: "1.0.0" });
    registerCanvasAppTools(server, { web });
    const client = new Client({ name: "canvas-apps-client", version: "1.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(serverSide);
        await client.connect(clientSide);
        await run(client);
    } finally {
        await client.close();
        await server.close();
    }
}

test("migrate_legacy_canvas_apps: apply refused while the transition is on keeps code and status", async () => {
    const calls = [];
    const web = {
        migrateLegacyCanvasApps: async (args) => {
            calls.push(args);
            if (args.dryRun === false) throw refusal();
            return { dryRun: true, migrated: 0, skipped: 0, lines: [], applyBlocked: { code: "CANVAS_LEGACY_MODE_ON", message: MESSAGE } };
        },
    };
    await withTools(web, async (client) => {
        const applied = await client.callTool({ name: "migrate_legacy_canvas_apps", arguments: { dry_run: false } });
        assert.equal(applied.isError, true);
        const body = JSON.parse(applied.content[0].text);
        assert.deepEqual(body, { error: MESSAGE, status: 409, code: "CANVAS_LEGACY_MODE_ON" });
        const dry = await client.callTool({ name: "migrate_legacy_canvas_apps", arguments: {} });
        assert.ok(!dry.isError);
        assert.equal(JSON.parse(dry.content[0].text).applyBlocked.code, "CANVAS_LEGACY_MODE_ON");
    });
    assert.deepEqual(calls, [{ dryRun: false }, { dryRun: true }]);
});

test("other errors keep their shape: 403 typed as before, anything else plain text", () => {
    const forbidden = errorToResult(Object.assign(new Error("only an unrestricted admin may do this"), { status: 403, code: "FORBIDDEN" }));
    assert.deepEqual(JSON.parse(forbidden.content[0].text), { error: "only an unrestricted admin may do this", status: 403, code: "FORBIDDEN" });
    const other = errorToResult(Object.assign(new Error("no such app"), { status: 404, code: "NOT_FOUND" }));
    assert.equal(other.content[0].text, "Error: no such app");
    assert.equal(other.isError, true);
    // The code alone, without a status, still maps to 409.
    const bare = errorToResult(Object.assign(new Error(MESSAGE), { code: "CANVAS_LEGACY_MODE_ON" }));
    assert.equal(JSON.parse(bare.content[0].text).status, 409);
});
