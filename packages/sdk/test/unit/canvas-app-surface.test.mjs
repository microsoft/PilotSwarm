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

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const DIRECT = read("../../src/management-client.ts");
const WEB = read("../../src/web/web-management-client.ts");
const HTTP = read("../../api/src/http-api-transport.js");
const NODE = read("../../../app/tui/src/node-sdk-transport.js");
const RUNTIME = read("../../../app/web/runtime.js");
const MCP = read("../../../app/mcp/src/tools/canvas-apps.ts");
const CLI = read("../../../app/tui/src/apps-cli.js");

const CANVAS_OPS = OPERATIONS.filter((op) => /CanvasApp|CanvasWorkspaceApproval|CanvasWorkspaceConsent/.test(op.name));
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
