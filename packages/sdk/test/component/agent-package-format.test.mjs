import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateAgentPackageDir } from "../../dist/agent-package-format.js";

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-pkg-test-"));
}

/** Minimal valid package directory; mutate from here per case. */
function writeValidPackage(dir, { name = "acme-kit", version = "1.2.3" } = {}) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills", "ops"), { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name, version, description: "Test package",
    }));
    fs.writeFileSync(path.join(dir, "agents", "triager.agent.md"), [
        "---",
        "name: triager",
        "description: Triage agent",
        "schemaVersion: 1",
        "version: 1.0.0",
        "---",
        "",
        "You triage things.",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "skills", "ops", "SKILL.md"), [
        "---",
        "name: ops",
        "description: Ops knowledge",
        "---",
        "",
        "Do ops well.",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
        "ticket-api": { command: "node", args: ["./mcp-servers/ticket.js"], tools: ["*"] },
    }));
    return dir;
}

function errorCodes(validation) {
    return validation.errors.map((e) => e.code).sort();
}

test("worker-module syntax errors are caught by the compile-only check", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.mkdirSync(path.join(dir, "tools"));
    fs.writeFileSync(path.join(dir, "tools", "worker-module.js"), "export default {{{");
    const result = await validateAgentPackageDir(dir);
    assert.deepEqual(errorCodes(result), ["syntax_error"]);
    assert.match(result.errors[0].message, /worker-module\.js failed syntax check/);

    // And a healthy module (with imports, never executed) passes.
    fs.writeFileSync(
        path.join(dir, "tools", "worker-module.js"),
        'import { defineTool } from "pilotswarm-sdk";\nexport default { createTools: () => [] };\n',
    );
    const ok = await validateAgentPackageDir(dir);
    assert.deepEqual(ok.errors, []);

    // Helpers under tools/ are gated too — a broken import target must not
    // slip through to fail at worker import time.
    fs.writeFileSync(path.join(dir, "tools", "helper.js"), "const oops = {{{");
    const helperBroken = await validateAgentPackageDir(dir);
    assert.deepEqual(errorCodes(helperBroken), ["syntax_error"]);
    assert.match(helperBroken.errors[0].message, /helper\.js/);
});
