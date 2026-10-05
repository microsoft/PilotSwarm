import express from "express";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WS_PATH } from "pilotswarm-sdk/api";
import { buildSessionCatalogPgClientConfig } from "pilotswarm-sdk";
import { getPortalAssetFile, getPortalConfig, parsePortalLinkOrigins } from "./config.js";
import { authenticateRequest, getAuthConfig } from "./auth.js";
import { getPublicAuthContext } from "./auth/authz/engine.js";
import { PortalRuntime } from "./runtime.js";
import { createApiRouter } from "./api/router.js";
import { errorDetail } from "./api/error-detail.js";
import { attachWebSockets } from "./api/ws.js";
import { createCanvasPlane } from "./api/canvas-plane.js";
import { createLivePlane } from "./api/live-plane.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");
const DIST_ASSETS_DIR = path.join(DIST_DIR, "assets");

function getPortalMode() {
    const explicitMode = process.env.PORTAL_TUI_MODE || process.env.PORTAL_MODE;
    if (explicitMode) return explicitMode;
    return process.env.KUBERNETES_SERVICE_HOST ? "remote" : "local";
}

function createPortalServer({ app }) {
    const certPath = process.env.TLS_CERT_PATH;
    const keyPath = process.env.TLS_KEY_PATH;
    if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        return {
            protocol: "https",
            server: https.createServer({
                cert: fs.readFileSync(certPath),
                key: fs.readFileSync(keyPath),
            }, app),
        };
    }
    return {
        protocol: "http",
        server: http.createServer(app),
    };
}

const LEGACY_RPC_STATUS_BY_CODE = {
    INVALID_REQUEST: 400,
    MODEL_AMBIGUOUS: 400,
    MODEL_UNRESOLVED: 400,
    VALIDATION_FAILED: 400,
    PORTAL_AUTH_REQUIRED: 401,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    REGENERATE_UNSUPPORTED: 409,
    FACTS_ENHANCED_UNSUPPORTED: 409,
    GRAPH_UNSUPPORTED: 409,
    CONFLICT: 409,
    PAYLOAD_TOO_LARGE: 413,
};

export function createJsonRpcError(error, fallbackStatus = 500) {
    const status = LEGACY_RPC_STATUS_BY_CODE[error?.code]
        || (Number.isInteger(error?.status) ? error.status : fallbackStatus);
    const code = error?.code
        || (status === 400 ? "INVALID_REQUEST"
            : status === 401 ? "UNAUTHORIZED"
                : status === 403 ? "FORBIDDEN"
                    : status === 404 ? "NOT_FOUND"
                        : status === 409 ? "CONFLICT"
                            : status === 413 ? "PAYLOAD_TOO_LARGE" : "INTERNAL_ERROR");
    return { status, body: { ok: false, error: errorDetail(error, status, code) } };
}

/**
 * The JSON body limits, per route: 2 MB unless a route carries more.
 * Mounted before any other body parser: the path-scoped parser wins, and
 * the general one skips a body already parsed.
 */
export function installJsonBodyLimits(app, { workspaceFileMb } = {}) {
    // Artifact uploads carry base64 image bodies (image attachments: up to
    // 4 MB decoded ≈ 5.4 MB base64) — give ONLY that route an 8 MB envelope.
    app.use("/api/v1/sessions/:sessionId/artifacts/:filename", express.json({ limit: "8mb" }));
    // Agent packages allow 2 MB DECODED. Base64 plus JSON overhead exceeds
    // the default 2 MB request cap, so reserve 4 MB for this route.
    app.use("/api/v1/agent-packages/upload", express.json({ limit: "4mb" }));
    // Workspace files (the Workspace pane) and canvas-ws writes carry a whole
    // file as base64: the file limit (PORTAL_WORKSPACE_MAX_FILE_MB, default
    // 20 MB) plus a third, plus room for the rest of the call.
    const fileMb = Number(workspaceFileMb) > 0 ? Number(workspaceFileMb) : 20;
    const workspaceBodyLimit = `${Math.ceil(fileMb * 1.4) + 1}mb`;
    app.use("/api/v1/management/sessions/:sessionId/workspace/files", express.json({ limit: workspaceBodyLimit }));
    app.use("/api/v1/management/sessions/:sessionId/canvas-workspace", express.json({ limit: workspaceBodyLimit }));
    app.use(express.json({ limit: "2mb" }));
}

/**
 * The pg client config for the canvas and live LISTEN relays. It follows
 * the session catalog rules: the same database, the sslmode fix, and the
 * managed-identity token. If the config cannot be built, it returns null:
 * the relays are then unavailable and the portal still starts.
 */
export function buildListenConnection(storageOptions, env = process.env) {
    try {
        return buildSessionCatalogPgClientConfig(storageOptions, env);
    } catch (error) {
        // The builder's messages never include the URL.
        console.warn(`[portal] live relays unavailable: ${String(error?.message || error).slice(0, 200)}`);
        return null;
    }
}

function sendSpaIndex(res) {
    res.set("Cache-Control", "no-store, max-age=0");
    res.sendFile(path.join(DIST_DIR, "index.html"));
}

export async function startServer(opts = {}) {
    const { port = Number(process.env.PORT) || 3001, host = process.env.PORTAL_HOST, workers } = opts;
    if (Number.isFinite(workers) && !process.env.WORKERS) {
        process.env.WORKERS = String(workers);
    }

    // Strip "__PS_UNSET__" sentinels written by deploy seed-secrets and
    // by the portal-config render path so optional env vars (like
    // ANTHROPIC_API_KEY or AZURE_OAI_KEY) appear unset to downstream code.
    // Mirrors the worker's behavior in packages/sdk/examples/worker.js.
    const SEED_SECRETS_UNSET_SENTINEL = "__PS_UNSET__";
    for (const [k, v] of Object.entries(process.env)) {
        if (v === SEED_SECRETS_UNSET_SENTINEL) delete process.env[k];
    }

    // Fail-loud at startup: a malformed PORTAL_LINK_ORIGINS should stop
    // the portal visibly, never silently hand out broken links.
    const linkOrigins = parsePortalLinkOrigins();
    const portalConfig = {
        ...getPortalConfig(),
        ...(linkOrigins.length ? { linkOrigins } : {}),
        // The side pane's Workspace tab: only when this portal serves the workspace roots.
        workspaceFiles: Boolean(String(process.env.PORTAL_WORKSPACE_ROOTS || "").trim()),
    };
    const mode = getPortalMode();
    const useManagedIdentity = ["1", "true", "yes", "on"].includes(
        String(process.env.PILOTSWARM_USE_MANAGED_IDENTITY || "").toLowerCase(),
    );
    // The runtime and the live-update listeners must use the same settings,
    // so both reach the session catalog database the same way.
    const storageOptions = {
        store: process.env.DATABASE_URL || "sqlite::memory:",
        useManagedIdentity,
        cmsFactsDatabaseUrl: process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || undefined,
        aadDbUser: process.env.PILOTSWARM_DB_AAD_USER || undefined,
    };
    const runtime = new PortalRuntime({ ...storageOptions, mode });

    const app = express();
    app.set("trust proxy", true);
    installJsonBodyLimits(app, { workspaceFileMb: Number(process.env.PORTAL_WORKSPACE_MAX_FILE_MB) });

    const { server, protocol } = createPortalServer({ app });

    async function requireAuth(req, res, next) {
        const auth = await authenticateRequest(req);
        if (!auth.ok) {
            res.status(auth.status).json({ ok: false, error: auth.error || (auth.status === 403 ? "Forbidden" : "Unauthorized") });
            return;
        }
        req.auth = auth;
        req.authClaims = auth.principal?.rawClaims || null;
        // Persist the role this token carried so the worker can resolve
        // `isAdmin` for sessions this principal owns. Fire-and-forget: it is
        // an observation, not part of this request's authorization — so it is
        // called optionally. A runtime without the method (tests, embedders
        // supplying their own) must not turn every authenticated request into
        // a 500.
        runtime.noteSignInRole?.(auth);
        next();
    }

    app.get("/api/health", async (_req, res) => {
        const started = runtime.started;
        res.json({
            ok: true,
            started,
            mode,
            authz: runtime.getAuthorizationPolicy?.(),
        });
    });

    app.get("/api/portal-config", async (req, res) => {
        try {
            const auth = await getAuthConfig(req);
            res.json({
                ok: true,
                portal: portalConfig,
                auth,
            });
        } catch (error) {
            const payload = createJsonRpcError(error, 500);
            res.status(payload.status).json(payload.body);
        }
    });

    app.get("/api/auth-config", async (req, res) => {
        try {
            const auth = await getAuthConfig(req);
            res.json(auth);
        } catch (error) {
            const payload = createJsonRpcError(error, 500);
            res.status(payload.status).json(payload.body);
        }
    });

    app.get("/api/auth/me", requireAuth, async (req, res) => {
        res.json({
            ok: true,
            ...getPublicAuthContext(req.auth),
        });
    });

    app.get("/api/bootstrap", requireAuth, async (_req, res) => {
        try {
            const bootstrap = await runtime.getBootstrap();
            res.json({
                ok: true,
                ...bootstrap,
                auth: getPublicAuthContext(_req.auth),
            });
        } catch (error) {
            const payload = createJsonRpcError(error, 500);
            res.status(payload.status).json(payload.body);
        }
    });

    // Canvas share-link doors: token-authenticated, deliberately OUTSIDE
    // requireAuth — the token IS the capability, scoped to exactly one
    // canvas's document and live state. Both answer 404 for any failure
    // (missing, expired-by-reset, malformed) so nothing about link validity
    // leaks. The doc is served under CSP sandbox: even a direct navigation
    // renders it with an OPAQUE origin, so agent-authored canvas HTML can
    // never script against the portal origin.
    app.get("/api/canvas-share/doc", async (req, res) => {
        try {
            const doc = await runtime.getCanvasShareDoc(String(req.query.t || ""));
            if (!doc) {
                res.status(404).type("text/plain").send("Not found");
                return;
            }
            res.set("Content-Security-Policy", "sandbox allow-scripts");
            res.set("Cache-Control", "no-store, max-age=0");
            res.type("text/html").send(doc.html);
        } catch {
            res.status(404).type("text/plain").send("Not found");
        }
    });

    app.get("/api/canvas-share/live", async (req, res) => {
        try {
            const state = await runtime.getCanvasShareLive(String(req.query.t || ""));
            if (!state) {
                res.status(404).json({ ok: false });
                return;
            }
            res.set("Cache-Control", "no-store, max-age=0");
            res.json({ ok: true, ...state });
        } catch {
            res.status(404).json({ ok: false });
        }
    });

    // The KV store through the link door — READ ONLY today (a read/write
    // link is phase 4 of interactive-canvas-apps). The token is the
    // address: session and slot come from the token row, never the query.
    app.get("/api/canvas-share/kv", async (req, res) => {
        try {
            const state = await runtime.getCanvasShareKv(String(req.query.t || ""), {
                prefix: typeof req.query.prefix === "string" ? req.query.prefix : null,
                after: typeof req.query.after === "string" ? req.query.after : null,
                key: typeof req.query.key === "string" ? req.query.key : null,
                limit: req.query.limit != null ? Number(req.query.limit) : null,
            });
            if (!state) {
                res.status(404).json({ ok: false });
                return;
            }
            res.set("Cache-Control", "no-store, max-age=0");
            res.json({ ok: true, ...state });
        } catch {
            res.status(404).json({ ok: false });
        }
    });

    // The versioned Web API (the supported product surface). The legacy
    // /api/rpc + /portal-ws routes below stay mounted through the same
    // dispatcher during the deprecation window.
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));

    app.post("/api/rpc", requireAuth, async (req, res) => {
        const method = String(req.body?.method || "").trim();
        if (!method) {
            res.status(400).json({ ok: false, error: "RPC method is required" });
            return;
        }
        try {
            const result = await runtime.call(method, req.body?.params || {}, req.auth);
            res.json({ ok: true, result });
        } catch (error) {
            const status = /Unsupported portal RPC method/i.test(String(error?.message || ""))
                ? 400
                : 500;
            const payload = createJsonRpcError(error, status);
            res.status(payload.status).json(payload.body);
        }
    });

    app.get("/api/sessions/:sessionId/artifacts/:filename/download", requireAuth, async (req, res) => {
        try {
            const sessionId = req.params.sessionId;
            const filename = req.params.filename;
            const artifact = await runtime.downloadArtifactBinary(sessionId, filename, req.auth);
            const contentType = String(artifact?.contentType || "application/octet-stream");
            res.setHeader("content-type", contentType);
            res.setHeader("content-disposition", `attachment; filename="${path.basename(filename)}"`);
            res.send(artifact.body);
        } catch (error) {
            const payload = createJsonRpcError(error, 404);
            res.status(payload.status).json(payload.body);
        }
    });

    app.get("/api/sessions/:sessionId/artifacts/:filename/meta", requireAuth, async (req, res) => {
        try {
            const sessionId = req.params.sessionId;
            const filename = req.params.filename;
            const metadata = await runtime.getArtifactMetadata(sessionId, filename, req.auth);
            if (!metadata) {
                res.status(404).json({ ok: false, error: "Artifact not found" });
                return;
            }
            res.json({ ok: true, ...metadata });
        } catch (error) {
            const payload = createJsonRpcError(error, 404);
            res.status(payload.status).json(payload.body);
        }
    });

    app.get("/api/portal-assets/:assetName", async (req, res) => {
        const assetFile = getPortalAssetFile(req.params.assetName);
        if (!assetFile || !fs.existsSync(assetFile)) {
            res.status(404).end();
            return;
        }
        res.sendFile(assetFile, {
            maxAge: "1h",
        });
    });

    if (fs.existsSync(DIST_DIR)) {
        app.use("/assets", express.static(DIST_ASSETS_DIR, {
            immutable: true,
            maxAge: "1y",
            fallthrough: true,
        }));
        app.use("/assets", (_req, res) => {
            res.status(404).type("text/plain").send("Asset not found");
        });
        app.use(express.static(DIST_DIR, { index: false }));
        app.get(/^\/(?!api\/).*/, (_req, res) => {
            sendSpaIndex(res);
        });
    }

    // The canvas-plane relay: LISTEN → WebSocket fan-out for live canvas
    // ticks (docs/proposals/canvas-data-plane.md). In-process hosting phase;
    // the module is deployment-agnostic and lifts out unchanged. Degrades to
    // "unavailable" (browsers fall back to durable events) without a DB URL.
    // Both relays get one connection config, built from the runtime's settings.
    const listenConnection = buildListenConnection(storageOptions);
    const canvasPlane = createCanvasPlane({ connection: listenConnection });
    runtime.canvasPlane = canvasPlane;
    canvasPlane.start().catch(() => { /* reconnect loop owns retries */ });

    const livePlane = createLivePlane({
        connection: listenConnection,
        getLive: (sessionId, topics) => runtime.getLive(sessionId, topics),
    });
    runtime.livePlane = livePlane;
    livePlane.start().catch(() => { /* reconnect loop owns retries */ });

    const socketServers = attachWebSockets(server, runtime, [
        { path: "/portal-ws", allowThemeMessages: true },
        { path: WS_PATH },
    ]);

    async function shutdown() {
        await canvasPlane.stop().catch(() => {});
        await livePlane.stop().catch(() => {});
        for (const socketServer of socketServers) {
            for (const client of socketServer.clients) {
                try {
                    client.close();
                } catch {}
            }
        }
        await runtime.stop().catch(() => {});
        server.close();
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
    console.log(`[portal] PilotSwarm Web at ${protocol}://localhost:${port}`);

    // Test/embedder handle: stops the runtime and closes the server.
    server.stopPortal = shutdown;
    return server;
}

if (process.argv[1]?.endsWith("server.js") || import.meta.url === `file://${process.argv[1]}`) {
    startServer().catch((error) => {
        console.error("[portal] Failed to start:", error);
        process.exitCode = 1;
    });
}
