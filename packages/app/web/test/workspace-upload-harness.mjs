import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import express from "express";
import { PilotSwarmManagementClient } from "../../../sdk/dist/management-client.js";
import { NodeSdkTransport } from "../../tui/src/node-sdk-transport.js";
import { PortalRuntime } from "../runtime.js";
import { createApiRouter } from "../api/router.js";
import { installJsonBodyLimits } from "../server.js";

const owner = { provider: "dev", subject: "upload-owner" };
export async function uploadHttpFixture({ sessionOwners = { session: owner } } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ps-upload-http-"));
    const spool = await fs.mkdtemp(path.join(os.tmpdir(), "ps-upload-spool-"));
    await fs.writeFile(path.join(root, ".pilotswarm-export"), "");
    const events = [], upstream = [], requests = [], servers = [];
    const mgmt = new PilotSwarmManagementClient({
        store: "sqlite::memory:",
        workspaceFiles: { roots: [{ name: "fixture", path: root }], transferDir: spool },
    });
    // Only catalog/auth metadata and event persistence are supplied by the fixture.
    mgmt._started = true;
    mgmt.getSessionWorkspace = async () => ({ workspace: { schema: 1, root: "fixture", folder: "" }, path: root });
    mgmt._catalog = {
        getSession: async (id) => sessionOwners[id] ? { deletedAt: null } : null,
        getSessionAccess: async (id, viewer) => sessionOwners[id] ? {
            rootSessionId: id, isSystem: false, visibility: "shared_write", owner: sessionOwners[id],
            viewerIsOwner: viewer.provider === sessionOwners[id].provider && viewer.subject === sessionOwners[id].subject,
            viewerShareAccess: null,
        } : null,
        recordEvents: async (_id, rows) => events.push(...rows),
        close: async () => {},
    };
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.transport = Object.assign(Object.create(NodeSdkTransport.prototype), { mgmt });
    const app = express();
    app.use((req, _res, next) => { upstream.push({ method: req.method, url: req.url }); next(); });
    installJsonBodyLimits(app);
    app.use("/api/v1", createApiRouter({
        runtime,
        requireAuth: (req, _res, next) => {
            req.auth = { principal: req.headers["x-other-user"] ? { provider: "dev", subject: "other" } : req.headers["x-upload-owner"] ? { provider: "dev", subject: req.headers["x-upload-owner"] } : owner, authorization: { allowed: true, role: req.headers["x-admin"] ? "admin" : "user" } };
            next();
        },
    }));
    async function listen(handler) {
        const server = http.createServer(handler);
        servers.push(server);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        return `http://127.0.0.1:${server.address().port}`;
    }
    const direct = await listen(app);
    const proxy = await listen(async (req, res) => {
        const row = { method: req.method, url: req.url, bytes: 0, forwarded: false };
        requests.push(row);
        const chunks = [];
        for await (const chunk of req) {
            row.bytes += chunk.length;
            if (row.bytes <= 1_000_000) chunks.push(chunk);
        }
        if (row.bytes > 1_000_000) {
            row.status = 413;
            res.writeHead(413, { "content-type": "text/html" }); res.end("<h1>Payload Too Large</h1>"); return;
        }
        row.forwarded = true;
        const headers = { ...req.headers }; delete headers.host; delete headers["transfer-encoding"]; delete headers["content-length"];
        try {
            const response = await fetch(direct + req.url, {
                method: req.method, headers,
                ...(["GET", "HEAD"].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
            });
            row.status = response.status;
            const body = Buffer.from(await response.arrayBuffer());
            row.responseBytes = body.length;
            res.writeHead(response.status, { "content-type": response.headers.get("content-type") }); res.end(body);
        } catch (error) {
            res.writeHead(502); res.end(String(error.message));
        }
    });
    return {
        root, mgmt, direct, proxy, requests, upstream, events,
        close: async () => {
            await mgmt.stop();
            await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
            await fs.rm(root, { recursive: true }); await fs.rm(spool, { recursive: true });
        },
    };
}
