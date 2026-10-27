/**
 * Canvas app registry (issue 181): surface parity and the provider boundary.
 *
 * - Every canvas-app protocol operation has a same-named method on the
 *   direct management client, the Web management client, the Node SDK
 *   transport and the HTTP transport, and an access class.
 * - The MCP tools and the `pilotswarm apps` CLI call only those operations.
 * - The workspace approval operations exist on the clients (the portal needs
 *   them) but on no agent-, MCP- or CLI-facing surface.
 * - The registry's core files import no cloud SDK and no concrete blob
 *   adapter: bytes go through the ArtifactStore interface only.
 *
 * Run: node --test test/unit/canvas-app-surface.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OPERATIONS } from "../../api/src/protocol.js";

// Windows checkouts may convert line endings; the patterns below assume LF.
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const DIRECT = read("../../src/management-client.ts");
const WEB = read("../../src/web/web-management-client.ts");
const HTTP = read("../../api/src/http-api-transport.js");
const NODE = read("../../../app/tui/src/node-sdk-transport.js");
const RUNTIME = read("../../../app/web/runtime.js");
const MCP = read("../../../app/mcp/src/tools/canvas-apps.ts");
const CLI = read("../../../app/tui/src/apps-cli.js");

const CANVAS_OPS = OPERATIONS.filter((op) => /CanvasApp|CanvasWorkspaceApproval|CanvasWorkspaceConsent|CanvasRevisionLabel/.test(op.name));
const APPROVAL_OPS = ["getCanvasWorkspaceApproval", "setCanvasWorkspaceConsent"];

test("every canvas app operation is on every client and transport, with an access class and a runtime case", () => {
    assert.ok(CANVAS_OPS.length >= 20, `found ${CANVAS_OPS.length}`);
    for (const op of CANVAS_OPS) {
        assert.ok(op.access, `${op.name} has an access class`);
        assert.match(DIRECT, new RegExp(`\\n    async ${op.name}\\(`), `direct client: ${op.name}`);
        assert.match(WEB, new RegExp(`\\n    async ${op.name}\\(`), `web client: ${op.name}`);
        assert.match(HTTP, new RegExp(`\\n    ${op.name}\\(args = \\{\\}\\)`), `HTTP transport: ${op.name}`);
        assert.match(NODE, new RegExp(`\\n    async ${op.name}\\(`), `Node SDK transport: ${op.name}`);
        assert.match(RUNTIME, new RegExp(`case "${op.name}"`), `portal runtime: ${op.name}`);
    }
});

test("the MCP tools and the CLI call only canvas app operations, and never the approval", () => {
    const names = new Set(CANVAS_OPS.map((op) => op.name));
    const mcpOps = [...MCP.matchAll(/op\("([A-Za-z]+)"/g)].map((m) => m[1]);
    assert.ok(mcpOps.length >= 15);
    for (const name of mcpOps) assert.ok(names.has(name), `MCP calls ${name}`);
    const cliOps = [...CLI.matchAll(/client\.([A-Za-z]+)\(/g)].map((m) => m[1]).filter((n) => n !== "start" && n !== "stop");
    assert.ok(cliOps.length >= 15);
    for (const name of cliOps) assert.ok(names.has(name), `CLI calls ${name}`);
    // Every registry operation a person can do from a terminal has a CLI command
    // (review S07). Not here: the session-slot publish (an agent's) and the approval ops.
    const CLI_REQUIRED = [
        "listCanvasApps", "searchCanvasApps", "getCanvasApp", "getCanvasAppHtml", "uploadCanvasApp",
        "setCanvasAppScope", "setCanvasAppEnabled", "setCanvasAppMetadata", "pinCanvasAppVersion", "deleteCanvasApp",
        "grantCanvasAppEditor", "revokeCanvasAppEditor", "listCanvasAppEditors", "exportCanvasApp", "importCanvasApp",
        "getCanvasAppLoads", "pruneCanvasApps", "migrateLegacyCanvasApps",
    ];
    for (const name of CLI_REQUIRED) {
        assert.ok(names.has(name), `${name} is a canvas app operation`);
        assert.ok(cliOps.includes(name), `the CLI exposes ${name}`);
    }
    for (const name of APPROVAL_OPS) {
        assert.ok(!mcpOps.includes(name) && !cliOps.includes(name), `${name} is portal-only`);
        assert.doesNotMatch(MCP, new RegExp(name));
        assert.doesNotMatch(CLI, new RegExp(name));
    }
});

test("the approval operations are the session owner's (session:files), and never assume admin", () => {
    for (const name of APPROVAL_OPS) {
        assert.equal(OPERATIONS.find((op) => op.name === name)?.access, "session:files", name);
        assert.match(NODE, new RegExp(`async ${name}\\(args = \\{\\}, owner = this\\.currentUser, isAdmin = false\\) \\{\\s*return this\\.mgmt\\.${name}\\(args \\?\\? \\{\\}, owner, isAdmin === true\\);`), `Node SDK transport ${name} defaults to no admin`);
    }
});

test("the registry's core files stay cloud-neutral", () => {
    const files = [
        "../../src/canvas-app-registry.ts",
        "../../src/canvas-app-store.ts",
        "../../src/canvas-workspace.ts",
        "../../src/canvas-legacy.ts",
        "../../src/migrations/canvas-app-registry-0084.ts",
    ];
    for (const rel of files) {
        const source = read(rel);
        const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
        for (const spec of imports) {
            assert.doesNotMatch(spec, /^@azure\/|^@aws-sdk\/|^aws-sdk|^@google-cloud\/|blob-store/, `${rel} imports ${spec}`);
        }
    }
});

test("no canvas operation on the Node SDK transport assumes admin when the caller does not say so", () => {
    const methods = [...NODE.matchAll(/\n    async (\w*Canvas\w*)\(args = \{\}, owner = this\.currentUser, isAdmin = (\w+)\)/g)];
    assert.ok(methods.length >= 20, `found ${methods.length}`);
    for (const [, name, fallback] of methods) assert.equal(fallback, "false", `${name} defaults isAdmin to ${fallback}`);
    for (const [, name] of methods) {
        assert.match(NODE, new RegExp(`async ${name}\\(args = \\{\\}, owner = this\\.currentUser, isAdmin = false\\) \\{\\s*return this\\.mgmt\\.${name}\\(args \\?\\? \\{\\}, owner, isAdmin === true\\);`), `${name} passes admin only when it is exactly true`);
    }
});

test("the app byte-space family is one pure module; membership is the registry's answer, never a guess from the id", async () => {
    const { createHash } = await import("node:crypto");
    const { CANVAS_APP_SPACE_PREFIX, looksLikeCanvasAppSpace } = await import("../../dist/canvas-app-space.js");
    assert.equal(
        CANVAS_APP_SPACE_PREFIX,
        createHash("sha256").update("pilotswarm-canvas-apps:artifacts").digest("hex").slice(0, 12),
        "the literal prefix is the documented derivation",
    );
    const SPACE = read("../../src/canvas-app-space.ts");
    assert.ok(!/from "node:|require\(/.test(SPACE), "the family module imports no Node built-in");
    const member = `${CANVAS_APP_SPACE_PREFIX.slice(0, 8)}-${CANVAS_APP_SPACE_PREFIX.slice(8, 12)}-8000-8000-000000000001`;
    assert.ok(looksLikeCanvasAppSpace(member));
    assert.ok(!looksLikeCanvasAppSpace("00000000-0000-4000-8000-000000000001"));

    // Direct mode: the family pre-filters, the registry decides. A legacy
    // session whose id is in the family but is not app storage is NOT refused.
    const { PilotSwarmManagementClient } = await import("../../dist/management-client.js");
    const direct = new PilotSwarmManagementClient({ store: "postgres://unused" });
    const spaces = new Set([member]);
    direct._catalog = { canvasApps: { isSpace: async (id) => spaces.has(id) } };
    assert.equal(await direct.isCanvasAppStorage(member), true, "a real app space");
    const legacy = `${CANVAS_APP_SPACE_PREFIX.slice(0, 8)}-${CANVAS_APP_SPACE_PREFIX.slice(8, 12)}-8000-8000-0000000000aa`;
    assert.equal(await direct.isCanvasAppStorage(legacy), false, "a legacy family id that is not app storage");
    assert.equal(await direct.isCanvasAppStorage("00000000-0000-4000-8000-000000000001"), false);
    direct._catalog = {};
    assert.equal(await direct.isCanvasAppStorage(legacy), true, "no registry to ask: the family is refused (fail closed)");

    // Web mode does not guess: the server decides on every artifact route.
    assert.match(WEB, /\n    async isCanvasAppStorage\(_sessionId: string\): Promise<boolean> \{\n        throw webModeUnsupported\("isCanvasAppStorage"/);
    const { WebPilotSwarmManagementClient } = await import("../../dist/web/web-management-client.js");
    const web = Object.create(WebPilotSwarmManagementClient.prototype);
    await assert.rejects(web.isCanvasAppStorage(member), (e) => e.code === "WEB_MODE_UNSUPPORTED");

});
