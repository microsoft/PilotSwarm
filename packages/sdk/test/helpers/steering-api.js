import { createRequire } from "node:module";
import { PortalRuntime } from "../../../app/web/runtime.js";
import { createApiRouter } from "../../../app/web/api/router.js";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import { ApiClient } from "../../api/src/api-client.js";

const require = createRequire(new URL("../../../app/package.json", import.meta.url));
const express = require("express");

export const steeringContext = (subject, over = {}) => ({
    sender: { kind: "user", provider: "test", subject, display: subject },
    authzEnforced: true, isAdmin: false, ...over,
});

/** Actual protocol router, PortalRuntime and direct/Web management clients over real CMS. */
export async function withSteeringApi(h, fn) {
    const direct = new PilotSwarmManagementClient({
        store: h.env.store, duroxideSchema: h.env.duroxideSchema, cmsSchema: h.env.cmsSchema, factsSchema: h.env.factsSchema,
    });
    await direct.start();
    const runtime = new PortalRuntime({ store: h.env.store, mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: true, adminScope: "unrestricted" };
    runtime.transport = {
        mgmt: direct,
        getSessionAccess: (sessionId, viewer) => h.catalog.getSessionAccess(sessionId, viewer),
        recordAuthzAudit: (entry) => h.catalog.recordAuthzAudit(entry),
        getSessionSteeringState: (...args) => direct.getSessionSteeringState(...args),
        steerSessionTurn: (...args) => direct.steerSessionTurn(...args),
        getSteeringRequest: (...args) => direct.getSteeringRequest(...args),
        listSteeringRequests: (...args) => direct.listSteeringRequests(...args),
        withdrawSteeringRequest: (...args) => direct.withdrawSteeringRequest(...args),
        getSessionSteeringStats: (...args) => direct.getSessionSteeringStats(...args),
    };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({
        runtime,
        requireAuth(req, res, next) {
            const subject = req.headers["x-fixture-subject"];
            if (typeof subject !== "string" || !subject) {
                res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED", message: "Fixture sign-in required" } });
                return;
            }
            req.auth = {
                principal: { provider: "test", subject, displayName: subject },
                authorization: { role: req.headers["x-fixture-role"] === "admin" ? "admin" : "user" },
            };
            next();
        },
    }));
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    const webClients = [];
    const web = async (subject, role = "user") => {
        const api = new ApiClient({ apiUrl, fetchImpl: (url, options) => fetch(url, {
            ...options, headers: { ...Object.fromEntries(new Headers(options.headers)),
                "x-fixture-subject": subject, "x-fixture-role": role },
        }) });
        const client = new PilotSwarmManagementClient({ apiUrl, api });
        webClients.push(client);
        await client.start();
        return client;
    };
    try {
        await fn({ direct, runtime, apiUrl, web });
    } finally {
        for (const client of webClients) await client.stop();
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await direct.stop();
    }
}
