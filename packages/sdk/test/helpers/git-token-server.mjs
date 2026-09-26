import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { gitEnv } from "./git-fixture.mjs";

/**
 * Token-protected git smart-HTTP server for the session-workspaces tests
 * (proposal section 9, "Token-protected git server"). A loopback Node server
 * in front of `git http-backend`: every request needs HTTP Basic auth whose
 * password is a live token from this server's fake minter. The stand-in for a
 * GitHub or Azure DevOps remote reached with a short-lived deployment token.
 */

const REALM = "pilotswarm-fixture";

function httpBackendPath() {
    const execPath = execFileSync("git", ["--exec-path"], { env: gitEnv(), encoding: "utf8" }).trim();
    return path.join(execPath, "git-http-backend");
}

function basicPassword(header) {
    const match = /^Basic\s+(\S+)$/i.exec(header || "");
    if (!match) return null;
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon < 0 ? null : { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** Splits the CGI header block off the backend's stdout. Returns null until the blank line arrives. */
function parseCgiHead(buffer) {
    const text = buffer.toString("latin1");
    const crlf = text.indexOf("\r\n\r\n"), lf = text.indexOf("\n\n");
    let end, sepLength;
    if (crlf >= 0 && (lf < 0 || crlf < lf)) { end = crlf; sepLength = 4; } else if (lf >= 0) { end = lf; sepLength = 2; } else return null;
    let status = 200, statusText = "OK";
    const headers = {};
    for (const line of text.slice(0, end).split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") {
            status = Number(value.split(" ")[0]);
            statusText = value.split(" ").slice(1).join(" ") || statusText;
        } else headers[key] = value;
    }
    return { status, statusText, headers, body: buffer.subarray(end + sepLength) };
}

/**
 * Serves every repo under `projectRoot` (for a fixture: its root, so
 * url("remotes/app.git") is the bare remote). Pushes go through
 * receive-pack, which runs the repo's pre-receive hook; nothing here sets an
 * env that would skip it.
 *
 * `backendPath` replaces git-http-backend; only the server's own tests use it.
 */
export async function startGitTokenServer({ projectRoot, backendPath } = {}) {
    const backend = backendPath ?? httpBackendPath();
    const tokens = new Map();
    const log = [];

    const server = createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        const entry = {
            method: req.method,
            path: url.pathname,
            query: url.search,
            contentEncoding: req.headers["content-encoding"] ?? null,
            transferEncoding: req.headers["transfer-encoding"] ?? null,
            status: null,
            user: null,
            stderr: "",
        };
        log.push(entry);
        const credentials = basicPassword(req.headers.authorization);
        const expiry = credentials && tokens.get(credentials.password);
        if (!expiry || expiry <= Date.now()) {
            entry.status = 401;
            req.resume();
            res.writeHead(401, { "WWW-Authenticate": `Basic realm="${REALM}"`, "Content-Type": "text/plain" });
            res.end("authentication required\n");
            return;
        }
        entry.user = credentials.user || "token";

        let pathInfo;
        try {
            pathInfo = decodeURIComponent(url.pathname);
        } catch {
            entry.status = 400;
            req.resume();
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("bad path encoding\n");
            return;
        }

        const env = gitEnv({
            GIT_PROJECT_ROOT: projectRoot,
            GIT_HTTP_EXPORT_ALL: "1",
            // http-backend enables receive-pack only for an authenticated user.
            REMOTE_USER: entry.user,
            REMOTE_ADDR: req.socket.remoteAddress ?? "127.0.0.1",
            GATEWAY_INTERFACE: "CGI/1.1",
            SERVER_PROTOCOL: `HTTP/${req.httpVersion}`,
            REQUEST_METHOD: req.method,
            PATH_INFO: pathInfo,
            QUERY_STRING: url.search.replace(/^\?/, ""),
            CONTENT_TYPE: req.headers["content-type"] ?? "",
            // Unset for chunked bodies: http-backend then reads stdin to EOF.
            ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
            // http-backend inflates gzip request bodies itself; pass them through untouched.
            ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
            ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: req.headers["git-protocol"] } : {}),
        });
        const child = spawn(backend, [], { env, stdio: ["pipe", "pipe", "pipe"] });
        // The client went away, or close() dropped the connection, before the
        // backend finished: stop the backend.
        res.on("close", () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
        child.stderr.on("data", chunk => { entry.stderr += chunk; });
        child.stdin.on("error", () => { /* backend may exit before reading a rejected body */ });
        req.pipe(child.stdin);

        let head = Buffer.alloc(0), started = false;
        child.stdout.on("data", chunk => {
            if (started) { res.write(chunk); return; }
            head = Buffer.concat([head, chunk]);
            const parsed = parseCgiHead(head);
            if (!parsed) return;
            started = true;
            entry.status = parsed.status;
            res.writeHead(parsed.status, parsed.statusText, parsed.headers);
            if (parsed.body.length) res.write(parsed.body);
        });
        // A failed spawn emits "error" and then "close"; answer only once.
        const fail = message => {
            if (res.headersSent || res.writableEnded) { res.end(); return; }
            entry.status = 502;
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end(message);
        };
        child.on("close", code => {
            if (!started) { fail(`git http-backend exited ${code} without headers\n${entry.stderr}`); return; }
            res.end();
        });
        child.on("error", error => {
            entry.stderr += String(error);
            fail(`git http-backend failed: ${error.message}\n`);
        });
    });

    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    return {
        baseUrl: base,
        log,
        /** A token valid for `ttlMs`, usable as the Basic password with any username. */
        mintToken({ ttlMs = 5 * 60 * 1000 } = {}) {
            const token = `fixture_${randomBytes(20).toString("hex")}`;
            tokens.set(token, Date.now() + ttlMs);
            return token;
        },
        revokeAll() { tokens.clear(); },
        /** URL of a repo under projectRoot; `token` embeds Basic credentials in the URL. */
        url(repoRelativePath, { token, user = "x-token" } = {}) {
            const clean = repoRelativePath.replace(/^\/+/, "");
            if (!token) return `${base}/${clean}`;
            return `http://${encodeURIComponent(user)}:${encodeURIComponent(token)}@127.0.0.1:${server.address().port}/${clean}`;
        },
        async close() {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        },
    };
}
