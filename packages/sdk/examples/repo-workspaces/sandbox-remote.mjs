/**
 * Sandbox remotes for the reference deployment
 * (docs/proposals/session-workspaces.md, section 12.1).
 *
 * The reference deployment mirrors a public repo from GitHub, and sessions
 * must never push there. So each repo gets a sandbox: a bare repo on the repo
 * pod that session clones use as `origin`. Sessions reach it over HTTP only,
 * with a short-lived token from the repo service, never through the mount:
 *
 *   <root>/remotes/<repo>.git    bare, owned by the service, mode 0755
 *
 * Rules on push, in the sandbox's pre-receive hook (section 5.4): no branch
 * deletion, no push to a protected branch (main, master, release/*), no
 * non-fast-forward update. The service itself keeps the protected branches
 * equal to the mirror, with a local fetch that no hook sees.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SANDBOX_PRE_RECEIVE_MESSAGES = Object.freeze({
    deletion: "sandbox-pre-receive: deleting a branch is not allowed",
    protectedBranch: "sandbox-pre-receive: pushes to a protected branch are not allowed",
    nonFastForward: "sandbox-pre-receive: non-fast-forward updates are not allowed",
});

/** Branches sessions may not push to; the service keeps them equal to the mirror. */
export const SANDBOX_PROTECTED = ["main", "master"];

function preReceiveScript() {
    return `#!/bin/sh
status=0
while read old new ref; do
    case "$new" in
        *[!0]*) ;;
        *) echo "${SANDBOX_PRE_RECEIVE_MESSAGES.deletion}: $ref" >&2; status=1; continue ;;
    esac
    case "$ref" in
        refs/heads/main|refs/heads/master|refs/heads/release/*)
            echo "${SANDBOX_PRE_RECEIVE_MESSAGES.protectedBranch}: $ref" >&2; status=1; continue ;;
    esac
    case "$old" in
        *[!0]*)
            if ! git merge-base --is-ancestor "$old" "$new"; then
                echo "${SANDBOX_PRE_RECEIVE_MESSAGES.nonFastForward}: $ref" >&2; status=1
            fi ;;
    esac
done
exit $status
`;
}

function basicCredentials(header) {
    const match = /^Basic\s+(\S+)$/i.exec(header || "");
    if (!match) return null;
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon < 0 ? null : { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** Splits the CGI header block off the backend's stdout; null until the blank line arrives. */
function parseCgiHead(buffer) {
    const text = buffer.toString("latin1");
    const crlf = text.indexOf("\r\n\r\n");
    const lf = text.indexOf("\n\n");
    let end;
    let sepLength;
    if (crlf >= 0 && (lf < 0 || crlf < lf)) { end = crlf; sepLength = 4; } else if (lf >= 0) { end = lf; sepLength = 2; } else return null;
    let status = 200;
    let statusText = "OK";
    const headers = {};
    for (const line of text.slice(0, end).split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") {
            status = Number(value.split(" ")[0]);
            statusText = value.split(" ").slice(1).join(" ") || statusText;
        } else headers[key] = value;
    }
    return { status, statusText, headers, body: buffer.subarray(end + sepLength) };
}

/**
 * @param {object} options
 * @param {string} options.root                     the export root; sandboxes live in <root>/remotes
 * @param {(token: string) => boolean} options.isValidToken
 * @param {(args: string[], opts?: object) => Promise<string>} options.runGit
 * @param {string} [options.httpBackend]            path to git-http-backend
 * @param {string} [options.urlPrefix]              the HTTP path prefix (default "/git/")
 */
export function createSandboxRemotes(options) {
    const remotesDir = path.join(path.resolve(options.root), "remotes");
    const prefix = options.urlPrefix ?? "/git/";
    const sandboxPath = (repo) => path.join(remotesDir, `${repo}.git`);

    /** Makes the sandbox if it is not there: bare, the hook, and every branch and tag of the mirror. */
    async function ensure(repo, mirror) {
        const target = sandboxPath(repo);
        if (!fs.existsSync(target)) {
            fs.mkdirSync(remotesDir, { recursive: true });
            await options.runGit(["init", "-q", "--bare", target]);
            await options.runGit(["-C", target, "config", "http.receivepack", "true"]);
            await options.runGit(["-C", target, "config", "receive.denyDeletes", "true"]);
            await options.runGit(["-C", target, "config", "receive.denyNonFastForwards", "true"]);
            await options.runGit(["-C", target, "fetch", "-q", mirror, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
            const head = await options.runGit(["-C", mirror, "symbolic-ref", "HEAD"]).catch(() => "");
            if (head) await options.runGit(["-C", target, "symbolic-ref", "HEAD", head]);
        }
        const hook = path.join(target, "hooks", "pre-receive");
        fs.mkdirSync(path.dirname(hook), { recursive: true });
        fs.writeFileSync(hook, preReceiveScript(), { mode: 0o755 });
        fs.chmodSync(hook, 0o755);
        return target;
    }

    /** Keeps the protected branches and the tags equal to the mirror. Other branches are the sessions'. */
    async function syncFromMirror(repo, mirror) {
        const target = sandboxPath(repo);
        if (!fs.existsSync(target)) return;
        const branches = (await options.runGit(["-C", mirror, "for-each-ref", "--format=%(refname:short)", "refs/heads/"]))
            .split("\n").map((line) => line.trim()).filter((name) => SANDBOX_PROTECTED.includes(name) || name.startsWith("release/"));
        const refspecs = [...branches.map((name) => `+refs/heads/${name}:refs/heads/${name}`), "+refs/tags/*:refs/tags/*"];
        await options.runGit(["-C", target, "fetch", "-q", mirror, ...refspecs]);
    }

    /**
     * Serves git smart HTTP for a sandbox under the prefix. Returns false for
     * any other path. Every request needs HTTP Basic auth whose password is a
     * live token; receive-pack runs the sandbox's pre-receive hook.
     */
    function handle(req, res) {
        const url = new URL(req.url, "http://repo-service");
        if (!url.pathname.startsWith(prefix)) return false;
        const credentials = basicCredentials(req.headers.authorization);
        if (!credentials || !options.isValidToken(credentials.password)) {
            req.resume();
            res.writeHead(401, { "WWW-Authenticate": 'Basic realm="pilotswarm-sandbox"', "Content-Type": "text/plain" });
            res.end("authentication required\n");
            return true;
        }
        let pathInfo;
        try {
            pathInfo = decodeURIComponent(url.pathname.slice(prefix.length - 1));
        } catch {
            req.resume();
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("bad path encoding\n");
            return true;
        }
        const repoDir = pathInfo.split("/").filter(Boolean)[0] ?? "";
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.git$/.test(repoDir) || !fs.existsSync(path.join(remotesDir, repoDir))) {
            req.resume();
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("no such sandbox\n");
            return true;
        }
        const env = {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "/tmp",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_PROJECT_ROOT: remotesDir,
            GIT_HTTP_EXPORT_ALL: "1",
            // http-backend enables receive-pack only for an authenticated user.
            REMOTE_USER: credentials.user || "token",
            REMOTE_ADDR: req.socket.remoteAddress ?? "127.0.0.1",
            GATEWAY_INTERFACE: "CGI/1.1",
            SERVER_PROTOCOL: `HTTP/${req.httpVersion}`,
            REQUEST_METHOD: req.method,
            PATH_INFO: pathInfo,
            QUERY_STRING: url.search.replace(/^\?/, ""),
            CONTENT_TYPE: req.headers["content-type"] ?? "",
            ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
            ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
            ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: req.headers["git-protocol"] } : {}),
        };
        const backend = options.httpBackend ?? "git-http-backend";
        const [file, argv] = backend === "git-http-backend" ? ["git", ["http-backend"]] : [backend, []];
        const child = spawn(file, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
        res.on("close", () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
        child.stdin.on("error", () => { /* the backend may exit before reading a rejected body */ });
        req.pipe(child.stdin);
        let head = Buffer.alloc(0);
        let started = false;
        child.stdout.on("data", (chunk) => {
            if (started) { res.write(chunk); return; }
            head = Buffer.concat([head, chunk]);
            const parsed = parseCgiHead(head);
            if (!parsed) return;
            started = true;
            res.writeHead(parsed.status, parsed.statusText, parsed.headers);
            if (parsed.body.length) res.write(parsed.body);
        });
        const fail = (message) => {
            if (res.headersSent || res.writableEnded) { res.end(); return; }
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end(message);
        };
        child.on("error", (error) => fail(`git-http-backend failed to start: ${error.message}\n`));
        child.on("close", () => {
            if (!started) fail("git-http-backend gave no response\n");
            else res.end();
        });
        return true;
    }

    return { ensure, syncFromMirror, handle, sandboxPath };
}
