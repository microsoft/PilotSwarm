import { randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalRequestPath, createPortalPaths, safePortalReturnUrl } from "../../packages/app/web/portal-paths.js";

export const COOKIE = "pilotswarm_proxy_demo";
export const ASSERTION_HEADER = "x-pilotswarm-demo-assertion";
export const AUTH_PATH = "/example-auth";
export const PERSONAS = Object.freeze({
    ada: Object.freeze({ sub: "demo-ada", name: "Ada (demo admin)", email: "ada@example.invalid", roles: ["admin"] }),
    alice: Object.freeze({ sub: "demo-alice", name: "Alice (demo user)", email: "alice@example.invalid", roles: ["user"] }),
    bob: Object.freeze({ sub: "demo-bob", name: "Bob (demo user)", email: "bob@example.invalid", roles: ["user"] }),
    denied: Object.freeze({ sub: "demo-denied", name: "Denied (demo policy control)", email: "denied@example.invalid", roles: ["denied"] }),
});

export class RequestError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function loopbackOrigin(value, { https = false } = {}) {
    const url = new URL(value);
    if (!["http:", ...(https ? ["https:"] : [])].includes(url.protocol)
        || url.hostname !== "127.0.0.1" || !url.port
        || url.username || url.password || url.pathname !== "/" || url.search || url.hash
        || value !== url.origin) {
        throw new Error("Demo origins must be explicit 127.0.0.1 origins with a non-default port and no path.");
    }
    return url;
}

export function boundedInteger(value, min, max, name) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return value;
}

export function rawHeader(req, name) {
    const values = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1]);
    }
    if (values.length > 1) throw new RequestError(400, "Duplicate security header.");
    return values[0];
}

export function checkRequest(req, origin, { upgrade = false, paths = createPortalPaths() } = {}) {
    if (rawHeader(req, "host") !== origin.host) throw new RequestError(421, "Unexpected Host.");
    const pathname = upgrade ? canonicalRequestPath(req.url) : paths.requestPath(req.url);
    if (pathname === null) throw new RequestError(400, "Non-canonical request target.");
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        throw new RequestError(405, "Method not supported.");
    }
    if (upgrade || !["GET", "HEAD"].includes(req.method)) {
        if (rawHeader(req, "origin") !== origin.origin) throw new RequestError(403, "Same-origin request required.");
    }
}

export function sessionCookie(req) {
    const cookies = (rawHeader(req, "cookie") || "").split(";").map((part) => part.trim());
    const values = cookies.filter((part) => part.startsWith(`${COOKIE}=`)).map((part) => part.slice(COOKIE.length + 1));
    if (values.length > 1) throw new RequestError(400, "Ambiguous session cookie.");
    return values.length === 1 && /^[A-Za-z0-9_-]{43}$/u.test(values[0]) ? values[0] : null;
}

export function cookieValue(id, ttlSeconds, secure) {
    return `${COOKIE}=${id || ""}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${id ? ttlSeconds : 0}${secure ? "; Secure" : ""}`;
}

export function secret() {
    return randomBytes(32).toString("base64url");
}

export function equalSecret(actual, expected) {
    if (typeof actual !== "string" || typeof expected !== "string") return false;
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function returnTarget(value, basePath) {
    return safePortalReturnUrl(value, createPortalPaths(basePath));
}

export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/gu, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
}

export async function readBody(req, maxBytes) {
    const length = req.headers["content-length"];
    if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
        throw new RequestError(413, "Request body too large.");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) throw new RequestError(413, "Request body too large.");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
}
