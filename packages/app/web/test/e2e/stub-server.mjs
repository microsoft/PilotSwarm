// Hermetic portal server for the layout/theme tests.
//
// Serves the built browser app from packages/app/web/dist and answers every
// /api/* route from fixtures. No database, no worker, no LLM, no auth — so
// these tests run in seconds and can gate every portal change, which the
// LLM-backed test/local suite cannot.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// PS_E2E_DIST: test a build kept apart from dist/, which a running local
// portal may be serving.
const DIST = process.env.PS_E2E_DIST ? path.resolve(process.env.PS_E2E_DIST) : path.resolve(__dirname, "../../dist");

// These tests run against the BUILT bundle, so a stale dist means every one of
// them passes against the previous build - silently, and with total conviction.
// That happened: a run reported four passes for an interaction whose code was
// not in the bundle at all. `npm run test:e2e` builds first; this catches a
// bare `npx playwright test`.
const SOURCE_DIRS = [
    path.resolve(__dirname, "../../src"),
    path.resolve(__dirname, "../../../ui/core/src"),
    path.resolve(__dirname, "../../../ui/react/src"),
];

function newestMtime(dir) {
    let newest = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
        else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
    return newest;
}

function assertFreshBundle() {
    if (!fs.existsSync(DIST)) {
        throw new Error("packages/app/web/dist is missing — run `npm run build:web` (or `npm run test:e2e`, which builds first).");
    }
    const built = newestMtime(DIST);
    const source = Math.max(...SOURCE_DIRS.filter((dir) => fs.existsSync(dir)).map(newestMtime));
    if (source > built) {
        const age = Math.round((source - built) / 1000);
        throw new Error(
            `packages/app/web/dist is ${age}s older than the sources it is built from. `
            + "These tests would assert against the PREVIOUS build. Run `npm run test:e2e` (it builds first).",
        );
    }
}

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
};

// Six by default — enough for the layout tests. The perf test asks for a
// realistic fleet size, where per-row cost actually shows up.
// `groupMembers` files chosen sessions into a folder up front (index -> groupId),
// so a test can drag onto a folder's MEMBERS and not just its header row.
// `parents` nests sessions (childIndex -> parentIndex) so the list renders a
// real subtree - the shape the nested-session "well" is drawn around.
const makeSessions = (count, groupMembers = {}, parents = {}) => Array.from({ length: count }, (_, i) => ({
    // The WIRE field is viewerGroupId (placement is viewer-private); the
    // client deliberately ignores a raw groupId on the session DTO.
    viewerGroupId: groupMembers[i] || null,
    sessionId: `1111111${i}-2222-3333-4444-55555555555${i}`,
    title: i === 0
        // A deliberately long title: the pane header must ellipsize it rather
        // than wrap, because the header is a fixed height.
        ? "A deliberately very long session title that must ellipsize rather than wrap the header"
        : `Session ${i}`,
    status: i % 2 ? "idle" : "running",
    model: "github-copilot:claude-sonnet-5",
    agentId: null,
    isSystem: false,
    owner: { provider: "none", subject: "test", email: "test@example.com", displayName: "Test User" },
    parentSessionId: parents[i] == null ? null : `1111111${parents[i]}-2222-3333-4444-55555555555${parents[i]}`,
    createdAt: 1785000000000,
    updatedAt: 1785000000000 + i,
    // Real rows carry usage, so the ctx column and the detail box render the
    // same work they do in production.
    contextUsage: { currentTokens: 20_000 + (i * 977), tokenLimit: 200_000 },
}));

// A small but deliberately awkward CSV: a quoted field containing a comma
// (must survive parsing) that needs NO quoting in TSV (only tab/newline/quote
// do), so the copy tests can prove we neither drop it nor over-quote it.
export const CSV_ARTIFACT = {
    filename: "changes.csv",
    contentType: "text/csv",
    content: [
        "commit_hash,date,summary",
        'bd57abbb,2026-06-04,"Bulk pgindent, mechanical"',
        "95b6ec52,2026-06-03,vacuumdb analyze-only",
    ].join("\n"),
};

const ARTIFACT_ENTRIES = [{
    filename: CSV_ARTIFACT.filename,
    contentType: CSV_ARTIFACT.contentType,
    sizeBytes: Buffer.byteLength(CSV_ARTIFACT.content),
    uploadedAt: "2026-06-04T00:00:00.000Z",
    source: "agent",
    isBinary: false,
}];

// A long transcript, for the resize/scroll perf tests. Alternating turns with
// enough prose per message to look like a real agent session — width-dependent
// wrapping is exactly the work being measured.
const PARA = "The CPG migration workflow renamed durably stored disk attach/detach properties. "
    + "Old state may not resume on new code, and new state may not survive rollback to old code. "
    + "Owner responded: migration overlap is rare; failures are recoverable by restarting.";

// `systemEvery`: every Nth assistant message carries an embedded [SYSTEM: …]
// notice, which makes it NON-rich-renderable — so it renders through the
// terminal line builders as a "lines" block. Those are the width-dependent
// ones, and a transcript full of them is the worst case for a resize.
// `assistantMarkdown`, when given, is what EVERY assistant turn says — for a
// test that needs one exact markdown shape (a table of long tokens) rendered
// through the real chat pipeline.
const makeTranscript = (count, systemEvery = 0, assistantMarkdown = null) => Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    eventType: i % 2 === 0 ? "user.message" : "assistant.message",
    timestamp: 1785000000000 + (i * 1000),
    data: {
        content: (systemEvery && i % systemEvery === 0)
            ? `[SYSTEM: notice ${i}] ${PARA}\n\n${PARA}`
            : i % 2 === 0
                ? `Turn ${i}: please review PR ${2160000 + i} and summarise the blocking risk.`
                : (assistantMarkdown
                    ?? `**Assessment ${i}**\n\n${PARA}\n\n- point one\n- point two\n\n\`\`\`js\nconst x = ${i};\n\`\`\`\n\n${PARA}`),
    },
}));

// Worker registry rows (migration 0040), shaped exactly as cms_list_workers
// returns them: write-once `info`, a `health` snapshot, and per-domain `state`.
// `nowMs` is passed in so heartbeats read as seconds old rather than years.
const makeWorkers = (count, nowMs) => Array.from({ length: count }, (_, i) => ({
    workerNodeId: `copilot-runtime-worker-66f68f955c-${"abcdefgh"[i % 8]}${i}lvb`,
    pool: "aks-default",
    phase: i === 0 ? "starting" : "ready",
    updatedAt: new Date(nowMs - ((i % 3) * 9_000)).toISOString(),
    owner: null,
    info: { sdkVersion: "0.5.29", runtime: { substrate: "aks" }, consumes: ["agent-packages"] },
    health: {
        uptimeS: 96_600 + i,
        rssBytes: (208 + (i * 6)) * 1024 * 1024,
        activeSessions: 0,
        eventLoopDelayP99Ms: 20.12 + (i / 100),
    },
    state: { "agent-packages": { epoch: 13, installed: { a: { status: "ok" }, b: { status: "ok" }, c: { status: "ok" } } } },
}));

const API = {
    "/api/health": { ok: true, started: true, mode: "remote" },
    "/api/auth-config": { enabled: false, provider: "none", displayName: "No auth", client: null },
    "/api/auth/me": {
        ok: true,
        principal: { provider: "none", subject: "test", email: "test@example.com", displayName: "Test User", groups: [], roles: ["admin"] },
        authorization: { allowed: true, role: "admin", reason: "Authentication disabled", matchedGroups: [] },
    },
    "/api/portal-config": { ok: true, portal: { branding: { title: "PilotSwarm", pageTitle: "PilotSwarm" } } },
    "/api/bootstrap": {
        ok: true,
        mode: "remote",
        workerCount: 1,
        defaultModel: "github-copilot:claude-sonnet-5",
        modelsByProvider: [],
        logConfig: { available: false, availabilityReason: "test" },
        auth: { principal: { displayName: "Test User", email: "test@example.com" } },
    },
};

function rpc(method, SESSIONS, PROFILE_SETTINGS = {}) {
    switch (method) {
        case "listSessions": return { sessions: SESSIONS, hasMore: false };
        case "listModels": return [];
        case "listArtifacts": return [];
        case "getSessionEvents": return [];
        case "getCurrentUserProfile": return { ok: true, profileSettings: PROFILE_SETTINGS };
        default: return {};
    }
}

/**
 * A small in-memory canvas app registry (issue 181 PR 2): enough of the
 * /api/v1/canvas-apps surface for the Admin Console and "Publish as app"
 * tests. Every write is RECORDED in `calls` so a test can prove what reached
 * the API, and a checkOnly publish writes nothing here either.
 */
function canvasAppRegistry(seed, viewer) {
    const apps = seed.map((app) => ({ ...app }));
    const calls = [];
    const json = (res, result, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(status === 200 ? { ok: true, result } : { ok: false, error: result }));
    };
    const find = (name, scope) => apps.find((a) => a.name === name && (!scope || a.scope === scope));
    const readBody = (req) => new Promise((resolve) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
    });
    const handle = async (req, res, pathname, url) => {
        const publish = /\/management\/sessions\/([^/]+)\/canvas-apps\/publish$/.exec(pathname);
        if (publish && req.method === "POST") {
            const body = await readBody(req);
            calls.push({ op: "publishCanvasApp", sessionId: publish[1], ...body });
            if (body.checkOnly) {
                return json(res, { checkOnly: true, ok: true, code: null, error: null, sizeBytes: 1234, sha256: "a".repeat(64), manifest: { name: "Team-Board", version: "1.4.0", description: "Use when a team tracks its board.", tags: ["team", "board"] }, interface: { keys: [] }, workspace: false });
            }
            apps.push({ ...makeCanvasApp(body.name, body.scope === "shared" ? "shared" : "user", viewer), version: body.version || "1.0.0" });
            return json(res, { status: "published", appId: `id-${body.name}`, appCreated: true, versionId: "v1", version: body.version || "1.0.0", sha256: "a".repeat(64), scope: body.scope === "shared" ? "shared" : "user", active: true, card: {} });
        }
        if (!/\/canvas-apps(\/|$)/.test(pathname)) return false;
        const rest = pathname.replace(/^.*\/canvas-apps\/?/, "");
        if (rest === "" && req.method === "GET") return json(res, apps);
        if (rest === "upload" && req.method === "POST") {
            const body = await readBody(req);
            calls.push({ op: "uploadCanvasApp", ...body });
            apps.push(makeCanvasApp(body.name, body.scope === "shared" ? "shared" : "user", viewer));
            return json(res, { status: "published", version: body.version || "1.0.0", scope: body.scope || "user" });
        }
        if (rest === "import" && req.method === "POST") {
            const body = await readBody(req);
            calls.push({ op: "importCanvasApp", ...body });
            return json(res, { name: "imported-app", scope: body.scope || "user", versions: [{ version: "1.0.0", status: "imported" }] });
        }
        const [rawName, sub] = rest.split("/");
        const name = decodeURIComponent(rawName || "");
        const scope = url.searchParams.get("scope");
        if (req.method === "GET") {
            const app = find(name, scope);
            if (!app) return json(res, { code: "NOT_FOUND", message: "no such app" }, 404);
            if (!sub) return json(res, { ...app, versions: [
                { versionId: `v-${app.name}`, version: app.version, sha256: "a".repeat(64), sizeBytes: 2048, card: app.card, createdBy: "none:test", createdAt: "2026-10-01T00:00:00Z" },
                { versionId: `v0-${app.name}`, version: "0.9.0", sha256: "b".repeat(64), sizeBytes: 1024, card: {}, createdBy: "none:test", createdAt: "2026-09-01T00:00:00Z" },
            ] });
            if (sub === "editors") return json(res, app.scope === "shared" ? [{ provider: "none", subject: "dev", email: "dev@example.com", displayName: "Dev Person", grantedAt: "2026-10-01T00:00:00Z" }] : []);
            if (sub === "loads") return json(res, { rows: [{ loadId: "l1", appName: app.name, version: app.version, sessionId: "s1", user: { provider: "none", subject: "test" }, userEmail: "test@example.com", userDisplayName: "Test User", loadedAt: "2026-10-03T10:00:00Z" }], total30d: 1234, nextCursor: null });
            if (sub === "html") {
                const html = `<!doctype html><html><body><h1 id="hello">Hello from ${app.name}</h1><script>document.getElementById('hello').dataset.ran='1'</script></body></html>`;
                return json(res, { name: app.name, version: app.version, sha256: null, html });
            }
            if (sub === "export") return json(res, { filename: `${app.name}.canvas-app.tar.gz`, sha256: "c".repeat(64), sizeBytes: 3, contentBase64: "AAAA" });
        }
        if (req.method === "PUT") {
            const body = await readBody(req);
            const op = { scope: "setCanvasAppScope", enabled: "setCanvasAppEnabled", active: "pinCanvasAppVersion", metadata: "setCanvasAppMetadata" }[sub];
            calls.push({ op, name, ...body });
            const app = find(name, body.scope);
            if (app && sub === "enabled") app.enabled = Boolean(body.enabled);
            if (app && sub === "scope") { app.scope = body.targetScope; }
            return json(res, { ok: true });
        }
        if (req.method === "DELETE") {
            calls.push({ op: "deleteCanvasApp", name, scope });
            const index = apps.findIndex((a) => a.name === name && (!scope || a.scope === scope));
            if (index >= 0) apps.splice(index, 1);
            return json(res, { deleted: true, files: 1, pendingCleanup: false });
        }
        return json(res, { code: "NOT_FOUND", message: "no such route" }, 404);
    };
    return { apps, calls, handle };
}

export function makeCanvasApp(name, scope = "user", owner = { provider: "none", subject: "test" }, extra = {}) {
    return {
        appId: `id-${scope}-${owner?.subject ?? ""}-${name}`, name, scope, owner,
        ownerEmail: owner ? `${owner.subject}@example.com` : null,
        ownerDisplayName: owner?.subject === "test" ? "Test User" : (owner?.subject ?? null),
        description: `Use when the team runs ${name}.\n\nIt keeps one row per item.`,
        tags: ["team"], enabled: true, createdBy: null,
        createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
        activeVersionId: `v-${name}`, version: "1.0.0", sha256: "a".repeat(64), sizeBytes: 2048,
        card: {
            interface: { keys: [{ key: "app/item/<id>", writer: "page", note: "one row per item" }], requests: [{ op: "summarize", result: { text: "string" } }], events: [{ key: "evt/<n>", note: "status" }] },
            responseContract: { actions: { vote: { item: "string", weight: "number?" } } },
            workspace: { read: ["**/*.md"], write: ["notes/*.md"], watch: false, commands: { status: {} } },
        },
        canEdit: true, canManage: owner?.subject === "test", shadowed: false, ...extra,
    };
}

// `canvases` attaches session_canvases summaries to list rows, as the real
// sessions list does (sessionIndex -> [{ slot, name, latestRev, sizeBytes }]):
// the portal then knows a canvas revision before it reads that revision's
// draw event, which is the cold-open path.
export function startStubServer(port = 0, { sessionCount = 6, transcriptTurns = 0, systemEvery = 0, assistantMarkdown = null, groups = [], themeId = null, groupMembers = {}, admin = false, parents = {}, canvases = {}, canvasLegacyMode = false, canvasApps = null } = {}) {
    assertFreshBundle();
    const SESSIONS = makeSessions(Math.max(1, sessionCount), groupMembers, parents)
        .map((row, i) => (Array.isArray(canvases[i]) && canvases[i].length ? { ...row, canvases: canvases[i] } : row));
    const WORKERS = admin ? makeWorkers(8, Date.now()) : [];
    let liveGroups = groups;
    let groupFetches = 0;
    const TRANSCRIPT = makeTranscript(Math.max(0, transcriptTurns), systemEvery, assistantMarkdown);
    // Placement calls the drag tests assert against: [{ sessionIds, groupId }].
    const placements = [];
    // Rename calls, [{ sessionId, title }], for the same reason.
    const renames = [];
    const VIEWER = { provider: "none", subject: "test" };
    const registry = canvasApps ? canvasAppRegistry(canvasApps, VIEWER) : null;
    // With the registry on, profile settings are kept and served back so a
    // test can prove a per-viewer setting survives a reload.
    let savedProfileSettings = themeId ? { themeId } : {};
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;

        if (pathname.startsWith("/api/")) {
            if (registry && await registry.handle(req, res, pathname, url) !== false) return;
            // With the registry on, the viewer is a signed-in person, the
            // owner of the stub's sessions, as a real bootstrap reports one.
            // Without it the stub is an authentication-disabled portal, where
            // no canvas app can be published (an app needs a signed-in owner)
            // and "Publish as app" is rightly not offered.
            if (registry && /\/api\/v1\/bootstrap$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, ...(canvasLegacyMode ? { canvasLegacyMode: true } : {}), auth: {
                    principal: { ...VIEWER, email: "test@example.com", displayName: "Test User", tenantId: null, groups: [] },
                    authorization: { allowed: true, role: admin ? "admin" : "user", reason: "stub", matchedGroups: [] },
                } }));
                return;
            }
            if (registry && /\/me\/profile\/settings$/.test(pathname) && req.method === "PATCH") {
                let raw = "";
                req.on("data", (chunk) => { raw += chunk; });
                req.on("end", () => {
                    try { savedProfileSettings = JSON.parse(raw || "{}").settings || {}; } catch { /* keep the previous */ }
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: true, result: { ok: true } }));
                });
                return;
            }
            if (registry && /\/me\/profile$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { ...VIEWER, email: "test@example.com", displayName: "Test User", isAdmin: admin, profileSettings: savedProfileSettings } }));
                return;
            }
            // Session groups: list them, and RECORD placement calls so a test
            // can prove a drag reached the API with the right group id.
            if (/\/management\/session-groups$/.test(pathname) && req.method === "GET") {
                groupFetches += 1;
                res.writeHead(200, { "content-type": "application/json" });
                // `liveGroups` is mutable so a test can simulate the transient
                // EMPTY-but-successful listing that makes folders vanish.
                res.end(JSON.stringify({ ok: true, result: liveGroups }));
                return;
            }
            if (/\/management\/session-groups\/place$/.test(pathname)) {
                let raw = "";
                req.on("data", (chunk) => { raw += chunk; });
                req.on("end", () => {
                    let parsed = {};
                    try { parsed = JSON.parse(raw || "{}"); } catch { /* record the attempt anyway */ }
                    placements.push(parsed);
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: true, result: (parsed.sessionIds || []).map((id) => ({ rootSessionId: id, placed: true, reason: null })) }));
                });
                return;
            }
            // /me/profile — the last-segment heuristic maps it to "profile",
            // not the op name, so it needs its own route. This is where the
            // viewer's themeId comes from.
            if (/\/me\/profile$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { isAdmin: admin, profileSettings: themeId ? { themeId } : {} } }));
                return;
            }
            // GET /workers — the worker registry (migration 0040). Admin-gated
            // in production; here it simply answers when the stub was started
            // with { admin: true }.
            if (/\/workers$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: WORKERS }));
                return;
            }
            if (/\/events$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: TRANSCRIPT }));
                return;
            }
            // These routes are path-shaped, so the last-segment heuristic below
            // cannot answer them. The client unwraps `result`.
            if (/\/management\/sessions$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { sessions: SESSIONS, hasMore: false, nextCursor: null } }));
                return;
            }
            const sessionMatch = /\/sessions\/([^/]+)$/.exec(pathname);
            if (sessionMatch && req.method === "PATCH") {
                // A rename. RECORDED, so a test can prove a single Enter in the
                // rename box reaches the API exactly once — the box confirms
                // on Enter itself, and the modal-key handler must not add a
                // second confirm.
                let raw = "";
                req.on("data", (chunk) => { raw += chunk; });
                req.on("end", () => {
                    let parsed = {};
                    try { parsed = JSON.parse(raw || "{}"); } catch { /* record the attempt anyway */ }
                    renames.push({ sessionId: sessionMatch[1], title: parsed.title });
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: true, result: { sessionId: sessionMatch[1], title: parsed.title } }));
                });
                return;
            }
            if (sessionMatch) {
                const found = SESSIONS.find((s) => s.sessionId === sessionMatch[1]) || SESSIONS[0];
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { ...found, messages: [], events: [], pendingMessages: [] } }));
                return;
            }
            if (/\/artifacts$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: ARTIFACT_ENTRIES }));
                return;
            }
            if (/\/artifacts\/[^/]+\/text$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: CSV_ARTIFACT.content }));
                return;
            }
            if (/\/artifacts\/[^/]+\/meta$/.test(pathname)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: ARTIFACT_ENTRIES[0] }));
                return;
            }

            let body = API[pathname];
            if (body === undefined) {
                // Everything else: derive from the last path segment, which is
                // enough for the read-only surfaces these tests exercise.
                body = { ok: true, ...rpc(pathname.split("/").pop(), SESSIONS, themeId ? { themeId } : {}) };
            }
            // The canvas app transition (issue 181): this portal's switch.
            if (canvasLegacyMode && /\/bootstrap$/.test(pathname)) body = { ...body, canvasLegacyMode: true };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
            return;
        }

        const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
        const file = path.join(DIST, rel);
        if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            // SPA fallback.
            res.writeHead(200, { "content-type": MIME[".html"] });
            res.end(fs.readFileSync(path.join(DIST, "index.html")));
            return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(fs.readFileSync(file));
    });

    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
            resolve({
                server,
                port: server.address().port,
                placements,
                renames,
                canvasAppCalls: registry ? registry.calls : [],
                savedProfileSettings: () => savedProfileSettings,
                setGroups: (next) => { liveGroups = next; },
                groupFetches: () => groupFetches,
            });
        });
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { port } = await startStubServer(Number(process.env.PORT) || 4173);
    console.log(`stub portal on http://127.0.0.1:${port}`);
}
