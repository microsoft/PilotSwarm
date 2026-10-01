import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isRepoMcpEnabled, loadRepoMcpConfig } from "../../dist/mcp-loader.js";

// Characterizes the repo-MCP-access loader, which loads a repo's
// .vscode/mcp.json, defaulting to remote
//    servers only, defaulting tools to ["*"], and honoring allow/skip lists.

function withRepo(files, callback) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-mcp-"));
    try {
        for (const [rel, contents] of Object.entries(files)) {
            const full = path.join(dir, rel);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, contents);
        }
        return callback(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function mcp(servers) {
    return JSON.stringify({ servers });
}

test("repository MCP loading requires an explicit affirmative value", () => {
    for (const value of [undefined, null, "", "0", "false", "off", "no", "unexpected"]) {
        assert.equal(isRepoMcpEnabled(value), false);
    }
    for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
        assert.equal(isRepoMcpEnabled(value), true);
    }
});

test("loadRepoMcpConfig returns an empty map when there is no .vscode/mcp.json", () => {
    withRepo({}, (dir) => {
        assert.deepEqual(loadRepoMcpConfig(dir), {});
    });
});

test("loadRepoMcpConfig loads a remote server and defaults tools to ['*']", () => {
    withRepo({ ".vscode/mcp.json": mcp({ foo: { type: "http", url: "https://example/mcp" } }) }, (dir) => {
        const result = loadRepoMcpConfig(dir);
        assert.ok(result.foo, "remote server is loaded");
        assert.equal(result.foo.type, "http");
        assert.deepEqual(result.foo.tools, ["*"]);
    });
});

test("loadRepoMcpConfig skips stdio servers by default (remoteOnly)", () => {
    withRepo({ ".vscode/mcp.json": mcp({ bar: { command: "node", args: ["x"] } }) }, (dir) => {
        assert.deepEqual(loadRepoMcpConfig(dir), {});
    });
});

test("loadRepoMcpConfig includes stdio servers when remoteOnly is disabled and anchors cwd", () => {
    withRepo({ ".vscode/mcp.json": mcp({ bar: { command: "node", args: ["x"] } }) }, (dir) => {
        const result = loadRepoMcpConfig(dir, { remoteOnly: false });
        assert.ok(result.bar, "stdio server is loaded when remoteOnly=false");
        assert.equal(result.bar.command, "node");
        assert.equal(result.bar.cwd, path.resolve(dir));
    });
});

test("loadRepoMcpConfig honors an allowlist", () => {
    const servers = { a: { type: "http", url: "u" }, b: { type: "http", url: "u" } };
    withRepo({ ".vscode/mcp.json": mcp(servers) }, (dir) => {
        const result = loadRepoMcpConfig(dir, { allow: ["a"] });
        assert.ok(result.a);
        assert.equal(result.b, undefined);
    });
});

test("loadRepoMcpConfig honors a skip list", () => {
    const servers = { a: { type: "http", url: "u" }, b: { type: "http", url: "u" } };
    withRepo({ ".vscode/mcp.json": mcp(servers) }, (dir) => {
        const traces = [];
        const result = loadRepoMcpConfig(dir, { skip: ["b"], trace: (message) => traces.push(message) });
        assert.ok(result.a);
        assert.equal(result.b, undefined);
        assert.ok(traces.some((message) => message.includes('"b": in skip list')));
    });
});

test("loadRepoMcpConfig skip list wins over the allowlist", () => {
    const servers = { a: { type: "http", url: "u" }, b: { type: "http", url: "u" } };
    withRepo({ ".vscode/mcp.json": mcp(servers) }, (dir) => {
        const result = loadRepoMcpConfig(dir, { allow: ["a", "b"], skip: ["b"] });
        assert.deepEqual(Object.keys(result), ["a"]);
    });
});

test("loadRepoMcpConfig tolerates a flat server map (no 'servers' key)", () => {
    withRepo({ ".vscode/mcp.json": JSON.stringify({ foo: { type: "http", url: "u" } }) }, (dir) => {
        assert.ok(loadRepoMcpConfig(dir).foo);
    });
});

test("loadRepoMcpConfig skips a server carrying an unresolved ${input} placeholder", () => {
    const servers = {
        s: { type: "http", url: "https://example/mcp", headers: { Authorization: "${input:token}" } },
    };
    withRepo({ ".vscode/mcp.json": mcp(servers) }, (dir) => {
        assert.deepEqual(loadRepoMcpConfig(dir), {});
    });
});

test("loadRepoMcpConfig returns an empty map on invalid JSON", () => {
    withRepo({ ".vscode/mcp.json": "not json {" }, (dir) => {
        assert.deepEqual(loadRepoMcpConfig(dir), {});
    });
});
