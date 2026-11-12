import cors from "cors";

const SETTING = "PORTAL_API_CORS_ALLOWED_ORIGINS";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const HEADERS = ["authorization", "content-type"];

export function parseApiCorsAllowedOrigins(raw = process.env[SETTING]) {
    if (raw == null || raw.trim() === "" || raw.trim() === "__PS_UNSET__") return [];
    let entries;
    try {
        entries = JSON.parse(raw);
    } catch {
        throw new Error(`${SETTING} must be a JSON array of canonical HTTPS origins.`);
    }
    if (!Array.isArray(entries)) throw new Error(`${SETTING} must be a JSON array.`);
    const seen = new Set();
    for (const entry of entries) {
        if (typeof entry !== "string") throw new Error(`${SETTING} entries must be strings.`);
        let url;
        try {
            url = new URL(entry);
        } catch {
            throw new Error(`${SETTING} entries must be canonical HTTPS origins.`);
        }
        if (url.protocol !== "https:" || url.origin !== entry || url.username || url.password
            || url.hostname.includes("*") || url.pathname !== "/" || url.search || url.hash) {
            throw new Error(`${SETTING} entries must be exact canonical HTTPS origins without credentials, paths, queries, fragments, or wildcards.`);
        }
        if (seen.has(entry)) throw new Error(`${SETTING} must not contain duplicate origins.`);
        seen.add(entry);
    }
    return entries;
}

export function installApiCors(app, allowedOrigins) {
    if (allowedOrigins.length === 0) return;
    const allowed = new Set(allowedOrigins);
    const middleware = cors({
        origin: (origin, callback) => callback(null, allowed.has(origin) ? origin : false),
        methods: METHODS,
        allowedHeaders: ["Authorization", "Content-Type"],
        exposedHeaders: ["Retry-After"],
        credentials: false,
        optionsSuccessStatus: 204,
    });
    app.use((req, res, next) => {
        if ((req.path !== "/api/v1" && !req.path.startsWith("/api/v1/"))
            || req.path === "/api/v1/ws") return next();
        res.vary("Origin");
        if (!req.headers.origin) return next();
        if (req.method === "OPTIONS") {
            res.vary("Access-Control-Request-Method");
            res.vary("Access-Control-Request-Headers");
            res.set("Cache-Control", "no-store");
            const method = req.headers["access-control-request-method"];
            const headers = req.headers["access-control-request-headers"];
            const requestedHeaders = typeof headers === "string" ? headers.split(",").map(h => h.trim().toLowerCase()) : [];
            // cors emits its configured lists without validating the requested
            // method/headers. Refuse the whole preflight before it can grant any permission.
            if (!allowed.has(req.headers.origin) || !METHODS.includes(method)
                || requestedHeaders.some(h => !HEADERS.includes(h))) {
                res.status(204).end();
                return;
            } else if (!METHODS.includes(req.method)) return next();
        }
        middleware(req, res, next);
    });
}
