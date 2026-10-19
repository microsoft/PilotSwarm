import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createServer, loadConfigFromFile } from "vite";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));

async function loadConfig(base) {
    const previous = process.env.PORTAL_BASE_PATH;
    process.env.PORTAL_BASE_PATH = base;
    try {
        const result = await loadConfigFromFile({ command: "serve", mode: "test" }, configFile);
        assert.ok(result, "the real Vite config loads");
        return result.config;
    } finally {
        if (previous === undefined) delete process.env.PORTAL_BASE_PATH;
        else process.env.PORTAL_BASE_PATH = previous;
    }
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
}

async function close(server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function rawRequest(server, target, method = "GET") {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: "127.0.0.1", port: server.address().port, path: target, method,
        }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (data) => { body += data; });
            response.on("error", reject);
            response.on("end", () => resolve({ status: response.statusCode, body }));
        });
        request.on("error", reject);
        request.end();
    });
}

for (const base of ["/", "/portal", "/tools/agents"]) {
    const mount = base === "/" ? "" : base;

    test(`Vite forwards API slash parameters but rejects structural aliases under ${base}`, async (t) => {
        const config = await loadConfig(base);
        const calls = [];
        const upstream = http.createServer((req, res) => {
            const call = { method: req.method, url: req.url };
            calls.push(call);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(call));
        });
        await listen(upstream);
        t.after(() => close(upstream));
        const target = `http://127.0.0.1:${upstream.address().port}`;
        const proxy = Object.fromEntries(Object.entries(config.server.proxy).map(
            ([key, value]) => [key, { ...value, target }],
        ));
        const vite = await createServer({
            ...config,
            root: webRoot,
            configFile: false,
            logLevel: "silent",
            server: { ...config.server, proxy, middlewareMode: true, hmr: false, watch: null },
            optimizeDeps: { noDiscovery: true, include: [] },
        });
        t.after(() => vite.close());
        const server = http.createServer(vite.middlewares);
        await listen(server);
        t.after(() => close(server));

        for (const method of ["GET", "DELETE"]) {
            const url = `${mount}/api/v1/graph/namespaces/corpus%2Facme?opaque=%2F%252e`;
            const response = await rawRequest(server, url, method);
            assert.equal(response.status, 200, method);
            assert.deepEqual(JSON.parse(response.body), { method, url }, "the actual proxy preserves the request target");
        }
        assert.equal(calls.length, 2);
        for (const suffix of [
            "/./api/health", "/%2e/api/health", "/%252e%252e/api/health", "//api/health",
            "/a%2fb", "/a%5Cb", "/apish/a%2fb", "/api%2Fv1/a%2fb", "/%61pi/a%2fb", "/API/a%2fb",
            "/api/v1/graph/namespaces/corpus%252Facme",
            "/api/v1/graph/namespaces/corpus%2F%252e%252e",
            "/api/v1/graph/namespaces/corpus%2F..",
            "/api/v1/graph/namespaces/corpus%2F%2Facme",
            "/api/v1/graph/namespaces/corpus%5Cacme",
            "/api/v1/graph/namespaces/corpus%00acme",
        ]) {
            const response = await rawRequest(server, `${mount}${suffix}`);
            assert.equal(response.status, 400, suffix);
            assert.equal(response.body, "Not found", suffix);
        }
        if (mount) {
            for (const url of ["/api/health", `${mount}ish/api/health`, `${mount.toUpperCase()}/api/health`]) {
                assert.equal((await rawRequest(server, url)).status, 404, url);
            }
            for (const url of [
                "/api/v1/graph/namespaces/corpus%2Facme",
                `${mount}ish/api/v1/graph/namespaces/corpus%2Facme`,
            ]) assert.equal((await rawRequest(server, url)).status, 400, url);
        }
        assert.equal(calls.length, 2, "rejected requests never reach the upstream");
    });

    test(`Vite keeps strict navigation, legacy exclusion and redirects under ${base}`, async () => {
        const config = await loadConfig(base);
        const plugin = config.plugins.find((value) => value.name === "portal-base-path");
        assert.ok(plugin);
        let middleware;
        plugin.configureServer({ middlewares: { use(value) { middleware = value; } } });
        assert.equal(typeof middleware, "function");
        const dispatch = (url, method = "GET") => {
            const req = { url, method };
            const headers = {};
            const res = {
                statusCode: 200, ended: false,
                setHeader(name, value) { headers[name] = value; },
                end() { this.ended = true; },
            };
            let next = false;
            middleware(req, res, () => { next = true; });
            return { url: req.url, status: res.statusCode, ended: res.ended, headers, next };
        };
        for (const method of ["GET", "HEAD"]) {
            const response = dispatch(`${mount}/sessions/fixture?opaque=%2F`, method);
            assert.equal(response.url, `${mount}/index.html?opaque=%2F`);
            assert.equal(response.next, true);
        }
        for (const suffix of ["/app.js", "/%61pp.js", "/app%2Ejs", "/public", "/%70ublic/index.html"]) {
            const response = dispatch(`${mount}${suffix}`);
            assert.equal(response.status, 404, suffix);
            assert.equal(response.ended, true);
            assert.equal(response.next, false);
        }
        const apiUrl = `${mount}/api/v1/graph/namespaces/corpus%2Facme`;
        assert.deepEqual(dispatch(apiUrl), { url: apiUrl, status: 200, ended: false, headers: {}, next: true });
        if (mount) {
            const response = dispatch(`${mount}?opaque=%2F`);
            assert.equal(response.status, 308);
            assert.deepEqual(response.headers, { Location: `${mount}/?opaque=%2F` });
            assert.equal(response.ended, true);
            assert.equal(response.next, false);
        } else {
            assert.deepEqual(dispatch("/?opaque=%2F").headers, {});
        }
    });
}
