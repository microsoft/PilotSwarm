import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMcpConfig, loadRepoMcpConfig } from "../../dist/mcp-loader.js";

test("stdio servers anchor to the owning plugin dir (packaged MCP servers)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cwd-test-"));
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
        "no-cwd": { command: "node", args: ["./mcp-servers/a.js"], tools: ["*"] },
        "rel-cwd": { command: "node", args: ["b.js"], cwd: "./mcp-servers", tools: ["*"] },
        "abs-cwd": { command: "node", args: ["c.js"], cwd: "/opt/fixed", tools: ["*"] },
        "remote": { type: "http", url: "https://example.com/mcp", tools: ["*"] },
    }));
    const servers = loadMcpConfig(dir);
    const abs = path.resolve(dir);
    assert.equal(servers["no-cwd"].cwd, abs, "missing cwd defaults to the plugin dir");
    assert.equal(servers["rel-cwd"].cwd, path.join(abs, "mcp-servers"), "relative cwd resolves against the plugin dir");
    assert.equal(servers["abs-cwd"].cwd, "/opt/fixed", "absolute cwd untouched");
    assert.equal(servers["remote"].cwd, undefined, "remote servers get no cwd");
});

// VS Code's .vscode/mcp.json is JSONC: real repos carry `//` comments (often to
// disable a server) and trailing commas. The loader must parse these WITHOUT
// corrupting the `//` inside server URLs — a strict JSON.parse rejected the whole
// file on the first comment and loaded zero servers (the original regression).
const JSONC_MCP = `{
    // repo servers for delegated MCP
    "servers": {
        "analytics": {
            "type": "http",
            "url": "https://analytics.example.com"
        },
        // "disabled-server": {
        //     "type": "http",
        //     "url": "https://disabled.example.com/mcp"
        // },
        "operations": {
            "url": "https://operations.example.com",
            "type": "http"
        },
    }
}`;

test("loadRepoMcpConfig parses JSONC (comments + trailing comma) without breaking URLs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-jsonc-test-"));
    fs.mkdirSync(path.join(dir, ".vscode"));
    fs.writeFileSync(path.join(dir, ".vscode", "mcp.json"), JSONC_MCP);

    const servers = loadRepoMcpConfig(dir);
    // The two live servers load; the commented-out one does not.
    assert.deepEqual(Object.keys(servers).sort(), ["analytics", "operations"]);
    assert.equal(servers["disabled-server"], undefined, "commented-out server must not load");
    // The `//` inside URLs survives — the string-aware parser did not treat it
    // as a comment.
    assert.equal(servers["analytics"].url, "https://analytics.example.com");
    assert.equal(servers["operations"].url, "https://operations.example.com");
});

test("loadMcpConfig also tolerates JSONC in .mcp.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-jsonc-plugin-"));
    fs.writeFileSync(path.join(dir, ".mcp.json"), `{
        // a remote server, with a trailing comma after it
        "remote": { "type": "http", "url": "https://example.com/mcp", "tools": ["*"] },
    }`);
    const servers = loadMcpConfig(dir);
    assert.equal(servers["remote"].url, "https://example.com/mcp");
});

test("loadMcpConfig accepts the mcpServers plugin wrapper", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wrapper-plugin-"));
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
        mcpServers: {
            "sql-code": {
                type: "http",
                url: "https://example.com/sql-code",
                tools: ["*"],
            },
            local: {
                type: "stdio",
                command: "node",
                args: ["server.js"],
                tools: ["*"],
            },
        },
    }));

    const servers = loadMcpConfig(dir);

    assert.deepEqual(Object.keys(servers).sort(), ["local", "sql-code"]);
    assert.equal(servers.mcpServers, undefined);
    assert.equal(servers.local.cwd, path.resolve(dir));
});

test("loadMcpConfig preserves flat servers named like wrapper fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-flat-wrapper-name-"));
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
        servers: {
            type: "http",
            url: "https://example.com/servers",
            tools: ["*"],
        },
        mcpServers: {
            type: "stdio",
            command: "node",
            args: ["server.js"],
            tools: ["*"],
        },
    }));

    const loaded = loadMcpConfig(dir);

    assert.equal(loaded.servers.url, "https://example.com/servers");
    assert.equal(loaded.mcpServers.command, "node");
    assert.equal(loaded.mcpServers.cwd, path.resolve(dir));
});
