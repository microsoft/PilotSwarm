/**
 * MCP servers for a session whose agent runs on a compute host
 * (docs/proposals/compute-providers.md, "Skills and MCP servers on remote
 * sessions").
 *
 * What these hold it to: a package's own server is rebuilt to run on the
 * host out of the copied folder, with only what its own entry states and
 * never a worker value; a deployment's server stays on the trusted side
 * and is reached by a ticket, with its command, environment, headers and
 * address never crossing; a deployment may keep a server away from these
 * sessions; and the fields PilotSwarm reads itself never reach a runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
    computeCopyName,
    mcpOriginKey,
    packageMcpFolders,
    packageMcpFoldersForAgents,
    remoteMcpCustomAgents,
    remoteMcpServers,
} from "../../dist/compute-mcp.js";

const PACKAGE_DIR = path.resolve("/worker/packages/weather");
const HOST_DIR = "/host/copies/folders/package-x";

function facts(overrides = {}) {
    return {
        placements: { [computeCopyName("package", PACKAGE_DIR)]: HOST_DIR },
        relay: { command: "/host/node", args: ["/host/relay.cjs", "--at", "127.0.0.1:5000"] },
        httpBase: "http://127.0.0.1:5001/",
        separator: "/",
        ...overrides,
    };
}

function origins(map) {
    return (name) => map[name];
}

let minted = 0;
const mint = () => `ticket-${++minted}`;

test("a package's server is rebuilt to run on the host, out of the copied folder", () => {
    const raw = {
        command: "node",
        args: ["./servers/weather.js", path.join(PACKAGE_DIR, "data", "stations.json")],
        cwd: PACKAGE_DIR,
        tools: ["forecast"],
        env: { WEATHER_UNITS: "metric" },
        timeout: 9000,
    };
    const result = remoteMcpServers(
        { weather: { ...raw, cwd: PACKAGE_DIR } },
        origins({ weather: { origin: "package", dir: PACKAGE_DIR, packageId: "p1", raw } }),
        facts(), mint);
    assert.deepEqual(result.unavailable, []);
    assert.deepEqual(result.servers.weather, {
        command: "node",
        args: ["./servers/weather.js", `${HOST_DIR}/data/stations.json`],
        cwd: HOST_DIR,
        tools: ["forecast"],
        env: { WEATHER_UNITS: "metric" },
        timeout: 9000,
    });
    assert.equal(JSON.stringify(result.servers).includes(PACKAGE_DIR), false, "no worker path reaches the host");
});

test("a package's server that asks for a worker value is unavailable, and says which field", () => {
    const raw = { command: "node", args: ["./s.js"], cwd: PACKAGE_DIR, tools: ["*"], env: { TOKEN: "${WORKER_TOKEN}" } };
    const result = remoteMcpServers(
        { weather: { ...raw, env: { TOKEN: "a-real-secret" } } },
        origins({ weather: { origin: "package", dir: PACKAGE_DIR, raw } }),
        facts(), mint);
    assert.deepEqual(result.servers, {});
    assert.equal(result.unavailable.length, 1);
    assert.match(result.unavailable[0].reason, /asks for a value from the worker \(env\.TOKEN\)/);
    // And the resolved value was never anywhere near the answer.
    assert.equal(JSON.stringify(result).includes("a-real-secret"), false);
});

test("a package's server that names a path outside its own folder is unavailable", () => {
    const outside = { command: "/usr/local/worker/bin/server", args: [], cwd: PACKAGE_DIR, tools: ["*"] };
    const byCommand = remoteMcpServers({ x: outside },
        origins({ x: { origin: "package", dir: PACKAGE_DIR, raw: outside } }), facts(), mint);
    assert.match(byCommand.unavailable[0].reason, /command is a path outside its own package folder/);

    const arg = { command: "node", args: ["/worker/secrets/key.json"], cwd: PACKAGE_DIR, tools: ["*"] };
    const byArg = remoteMcpServers({ x: arg },
        origins({ x: { origin: "package", dir: PACKAGE_DIR, raw: arg } }), facts(), mint);
    assert.match(byArg.unavailable[0].reason, /arguments is a path outside its own package folder/);
});

test("a package's server whose folder could not be copied is unavailable, and the turn goes on", () => {
    const raw = { command: "node", args: ["./s.js"], cwd: PACKAGE_DIR, tools: ["*"] };
    const result = remoteMcpServers({ x: raw, y: { command: "cat", args: [], cwd: PACKAGE_DIR, tools: ["*"] } },
        origins({
            x: { origin: "package", dir: PACKAGE_DIR, raw },
            y: { origin: "deployment", dir: "/deploy", remote: true },
        }),
        facts({ placements: {} }), mint);
    assert.match(result.unavailable[0].reason, /package folder could not be copied/);
    assert.ok(result.servers.y, "the other server is still there");
});

test("a deployment's server stays on the trusted side and is reached by a ticket", () => {
    const configured = {
        command: "/worker/bin/catalog",
        args: ["--serve"],
        cwd: "/worker",
        env: { CATALOG_TOKEN: "worker-only-secret" },
        tools: ["search", "fetch"],
        timeout: 30000,
    };
    const result = remoteMcpServers({ catalog: configured },
        origins({ catalog: { origin: "deployment", dir: "/deploy", remote: true } }), facts(), mint);
    assert.deepEqual(result.unavailable, []);
    const entry = result.servers.catalog;
    assert.equal(entry.type, "local");
    assert.equal(entry.command, "/host/node");
    assert.deepEqual(entry.args.slice(0, 3), ["/host/relay.cjs", "--at", "127.0.0.1:5000"]);
    assert.equal(entry.args[3], "--ticket");
    assert.equal(entry.args[4], result.tickets[0].ticket);
    assert.deepEqual(entry.tools, ["search", "fetch"]);
    assert.equal(entry.timeout, 30000);
    const text = JSON.stringify(result.servers);
    assert.equal(text.includes("worker-only-secret"), false, "the server's own credentials never cross");
    assert.equal(text.includes("/worker/bin/catalog"), false, "nor its command");
    assert.equal(entry.env, undefined, "nor any environment");
});

test("a deployment's server reached over HTTP becomes a local address, with no configured header", () => {
    const configured = {
        type: "http",
        url: "https://tools.example.invalid/mcp",
        headers: { Authorization: "Bearer worker-only-secret" },
        tools: ["*"],
    };
    const result = remoteMcpServers({ tools: configured },
        origins({ tools: { origin: "deployment", dir: "/deploy", remote: true } }), facts(), mint);
    const entry = result.servers.tools;
    assert.equal(entry.type, "http");
    assert.equal(entry.url, `http://127.0.0.1:5001/${result.tickets[0].ticket}`);
    assert.equal(entry.headers, undefined);
    const text = JSON.stringify(result.servers);
    assert.equal(text.includes("worker-only-secret"), false);
    assert.equal(text.includes("tools.example.invalid"), false, "nor the address it actually reaches");
});

test("a deployment may keep a server away from sessions whose agent runs elsewhere", () => {
    const configured = { command: "/worker/bin/db", args: [], tools: ["*"] };
    const result = remoteMcpServers({ db: configured },
        origins({ db: { origin: "deployment", dir: "/deploy", remote: false } }), facts(), mint);
    assert.deepEqual(result.servers, {});
    assert.match(result.unavailable[0].reason, /keeps this server away/);
});

test("a server with no origin is unavailable rather than guessed at", () => {
    const result = remoteMcpServers({ mystery: { command: "x", args: [], tools: ["*"] } }, () => undefined, facts(), mint);
    assert.deepEqual(result.servers, {});
    assert.match(result.unavailable[0].reason, /cannot tell whose code/);
});

test("the fields PilotSwarm reads itself never reach a runtime", () => {
    const raw = { command: "node", args: ["./s.js"], cwd: PACKAGE_DIR, tools: ["*"], default: true, allowedAgents: ["a"], remote: false };
    const result = remoteMcpServers({ x: raw },
        origins({ x: { origin: "package", dir: PACKAGE_DIR, raw } }), facts(), mint);
    assert.equal(result.servers.x.default, undefined);
    assert.equal(result.servers.x.allowedAgents, undefined);
    assert.equal(result.servers.x.remote, undefined);
});

test("a host that offers no relay says so instead of handing over a broken entry", () => {
    const result = remoteMcpServers({ catalog: { command: "/worker/bin/catalog", args: [], tools: ["*"] } },
        origins({ catalog: { origin: "deployment", dir: "/deploy", remote: true } }),
        facts({ relay: null }), mint);
    assert.deepEqual(result.servers, {});
    assert.match(result.unavailable[0].reason, /no relay/);
});

test("the maps nested in custom agents are transformed too", () => {
    const configured = { command: "/worker/bin/catalog", args: [], env: { TOKEN: "worker-only-secret" }, tools: ["*"] };
    const agents = [
        { name: "plain", prompt: "x" },
        { name: "researcher", prompt: "x", mcpServers: { catalog: configured } },
    ];
    const result = remoteMcpCustomAgents(agents,
        origins({ catalog: { origin: "deployment", dir: "/deploy", remote: true } }), facts(), mint);
    assert.equal(result.agents[0].mcpServers, undefined);
    assert.equal(result.agents[1].mcpServers.catalog.command, "/host/node");
    assert.equal(JSON.stringify(result.agents).includes("worker-only-secret"), false);
});

test("the package folders a session needs copied are found in both the top map and the nested ones", () => {
    const raw = { command: "node", args: ["./s.js"], cwd: PACKAGE_DIR, tools: ["*"] };
    const where = origins({ weather: { origin: "package", dir: PACKAGE_DIR, raw } });
    assert.deepEqual(packageMcpFolders({ weather: raw }, where),
        [{ name: computeCopyName("package", PACKAGE_DIR), source: PACKAGE_DIR }]);
    assert.deepEqual(packageMcpFoldersForAgents([{ name: "a", mcpServers: { weather: raw } }], where),
        [{ name: computeCopyName("package", PACKAGE_DIR), source: PACKAGE_DIR }]);
    assert.deepEqual(packageMcpFolders({ catalog: {} }, origins({ catalog: { origin: "deployment", dir: "/deploy" } })), []);
});

test("a folder's copy is named by where it came from, so the same folder is one copy", () => {
    assert.equal(computeCopyName("skills", "/a/b"), computeCopyName("skills", "/a/b"));
    assert.notEqual(computeCopyName("skills", "/a/b"), computeCopyName("skills", "/a/c"));
    assert.match(computeCopyName("skills", "/a/b"), /^skills-[0-9a-f]{16}$/);
});

test("the older event-stream transport is refused plainly rather than offered half-working", () => {
    // That transport announces, inside the stream, the address the runtime
    // must post to. The worker forwards the stream without reading it, so
    // the announcement would reach the runtime naming somewhere it cannot
    // get to — and the turn would fail in the middle of a conversation
    // instead of here, with a reason.
    const result = remoteMcpServers(
        { legacy: { type: "sse", url: "https://tools.example.invalid/sse", tools: ["*"] } },
        origins({ legacy: { origin: "deployment", dir: "/deploy", remote: true } }), facts(), mint);
    assert.deepEqual(result.servers, {});
    assert.deepEqual(result.tickets, [], "and no ticket is minted for a server that cannot be reached");
    assert.match(result.unavailable[0].reason, /older event-stream transport/);
});

test("two packages exporting one server name each get their own, never the other's", () => {
    // The names collide; the packages do not. A session authorized for
    // one of them must be given that one's folder and that one's entry.
    const first = path.resolve("/worker/packages/alpha");
    const second = path.resolve("/worker/packages/beta");
    const host = {
        placements: {
            [computeCopyName("package", first)]: "/host/copies/folders/alpha",
            [computeCopyName("package", second)]: "/host/copies/folders/beta",
        },
        relay: { command: "/host/node", args: ["/host/relay.cjs"] },
        httpBase: "http://127.0.0.1:5001/",
        separator: "/",
    };
    const alpha = {
        origin: "package", dir: first, packageId: "pkg-alpha",
        raw: { command: "./alpha-server", args: [], tools: ["*"] },
    };
    const beta = {
        origin: "package", dir: second, packageId: "pkg-beta",
        raw: { command: "./beta-server", args: [], tools: ["*"] },
    };
    // The session's own map says which one it was authorized for.
    const forAlpha = remoteMcpServers({ tools: {} }, origins({ tools: alpha }), host, mint);
    assert.equal(forAlpha.servers.tools.command, "./alpha-server");
    assert.equal(forAlpha.servers.tools.cwd, "/host/copies/folders/alpha");
    assert.deepEqual(packageMcpFolders({ tools: {} }, origins({ tools: alpha })),
        [{ name: computeCopyName("package", first), source: first }],
        "and only that package's folder is copied to the host");

    const forBeta = remoteMcpServers({ tools: {} }, origins({ tools: beta }), host, mint);
    assert.equal(forBeta.servers.tools.command, "./beta-server");
    assert.equal(forBeta.servers.tools.cwd, "/host/copies/folders/beta");
    assert.deepEqual(packageMcpFolders({ tools: {} }, origins({ tools: beta })),
        [{ name: computeCopyName("package", second), source: second }]);
});

test("an origin is asked for by package and name together, so one name is not one answer", () => {
    assert.notEqual(mcpOriginKey("pkg-alpha", "tools"), mcpOriginKey("pkg-beta", "tools"));
    assert.notEqual(mcpOriginKey(null, "tools"), mcpOriginKey("pkg-alpha", "tools"));
    assert.equal(mcpOriginKey(null, "tools"), mcpOriginKey(undefined, "tools"));
    assert.equal(mcpOriginKey("pkg-alpha", "tools"), mcpOriginKey("pkg-alpha", "tools"));
});
