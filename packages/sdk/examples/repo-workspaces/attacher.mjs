/**
 * The node attacher (docs/proposals/session-workspaces.md, section 5.2).
 *
 * One per agent node, as a DaemonSet: privileged, on the host network, with
 * the host folder /mnt/ps mounted Bidirectional. It mounts each workspace
 * root's NFS export at /mnt/ps/<root>; worker pods see /mnt/ps at /ws
 * (HostToContainer), so a mount made later shows up in running pods.
 *
 * Worker pods ask it over a unix socket on a hostPath. Any process in a
 * worker pod can call it, the agent's shell included, so it accepts only the
 * root names it was configured with, and it has no unmount call. It never
 * unmounts on SIGTERM either: a restart leaves the mounts in place, because
 * the kernel ties an NFS mount to the mounting process's network namespace,
 * and the host's never goes away.
 *
 * Environment:
 *   ATTACHER_ROOTS          name=server:/export,...  (for example a=repo-cache-nfs.pilotswarm.svc.cluster.local:/ws/a)
 *   ATTACHER_MOUNT_BASE     default /mnt/ps
 *   ATTACHER_SOCKET         default /run/pilotswarm-attacher/sock
 *   ATTACHER_MOUNT_OPTIONS  default nfsvers=4.1,hard,timeo=600,retrans=2,actimeo=3,lookupcache=positive,nconnect=4,nosharecache
 *   ATTACHER_EAGER          "1" (default): mount every root at start; "0": only when asked
 *
 * HTTP over the socket:
 *   POST /mount   { root }   mount it unless it is mounted     -> { root, path, mounted: true }
 *   POST /remount { root }   lazy unmount, then mount again (after ESTALE)
 *   GET  /status             each root and whether it is mounted
 */
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// nosharecache: a remount after ESTALE must get a new kernel instance. With the
// default (sharecache), a mount of the same export reuses the old instance, stale
// root included, while any process still holds the lazily unmounted one (seen:
// the new mount kept the old device number). Each root is mounted once per node,
// so nothing else is lost.
export const DEFAULT_MOUNT_OPTIONS = "nfsvers=4.1,hard,timeo=600,retrans=2,actimeo=3,lookupcache=positive,nconnect=4,nosharecache";
const ROOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** "a=host:/ws/a,shared=host:/ws/shared" -> [{ name, server, exportPath }] */
export function parseAttacherRoots(value) {
    return String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
        const eq = entry.indexOf("=");
        const colon = entry.indexOf(":", eq + 1);
        if (eq <= 0 || colon <= eq + 1) throw new Error(`ATTACHER_ROOTS entry "${entry}" must be name=server:/export`);
        const name = entry.slice(0, eq).trim();
        const server = entry.slice(eq + 1, colon).trim();
        const exportPath = entry.slice(colon + 1).trim();
        if (!ROOT_NAME.test(name)) throw new Error(`ATTACHER_ROOTS: bad root name "${name}"`);
        if (!exportPath.startsWith("/")) throw new Error(`ATTACHER_ROOTS: the export of "${name}" must be an absolute path`);
        return { name, server, exportPath };
    });
}

/** Whether `mountPoint` is a mount point in a /proc/self/mountinfo text (field 5). */
export function isMountedAt(mountPoint, mountinfoText) {
    const target = path.resolve(mountPoint);
    return String(mountinfoText || "").split("\n").some((line) => {
        const fields = line.split(" ");
        // Spaces and the like are octal-escaped in mountinfo.
        const point = (fields[4] ?? "").replace(/\\([0-7]{3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
        return point === target;
    });
}

function defaultRun(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 60_000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`${command} ${args.join(" ")}: ${String(stderr || error.message).trim()}`));
            else resolve(String(stdout).trim());
        });
    });
}

/**
 * @param {object} options
 * @param {Array<{ name: string, server: string, exportPath: string }>} options.roots
 * @param {string} [options.mountBase]
 * @param {string} [options.mountOptions]
 * @param {(command: string, args: string[]) => Promise<string>} [options.run]
 * @param {() => string} [options.readMountinfo]
 * @param {(host: string) => Promise<string>} [options.resolveHost]
 * @param {(message: string) => void} [options.log]
 */
export function createAttacher(options) {
    const mountBase = options.mountBase ?? "/mnt/ps";
    const mountOptions = options.mountOptions ?? DEFAULT_MOUNT_OPTIONS;
    const run = options.run ?? defaultRun;
    const readMountinfo = options.readMountinfo ?? (() => fs.readFileSync("/proc/self/mountinfo", "utf8"));
    const resolveHost = options.resolveHost ?? (async (host) => (net.isIP(host) ? host : (await lookup(host)).address));
    const log = options.log ?? ((message) => console.log(`[attacher] ${message}`));
    const roots = new Map(options.roots.map((root) => [root.name, root]));
    // One mount at a time per root: two sessions asking at once get one mount.
    const busy = new Map();

    const mountPointOf = (root) => path.join(mountBase, root.name);
    const mounted = (root) => isMountedAt(mountPointOf(root), readMountinfo());

    const serial = (name, work) => {
        const previous = busy.get(name) ?? Promise.resolve();
        const next = previous.then(work, work);
        busy.set(name, next.catch(() => undefined));
        return next;
    };

    const known = (name) => {
        const root = roots.get(String(name || ""));
        if (!root) throw Object.assign(new Error(`unknown root "${name}"; this attacher serves ${[...roots.keys()].join(", ")}`), { status: 404 });
        return root;
    };

    async function doMount(root) {
        const point = mountPointOf(root);
        fs.mkdirSync(point, { recursive: true });
        const address = await resolveHost(root.server);
        await run("mount", ["-t", "nfs4", "-o", mountOptions, `${address}:${root.exportPath}`, point]);
        log(`mounted ${root.name}: ${address}:${root.exportPath} at ${point}`);
    }

    async function mount(name) {
        const root = known(name);
        return serial(root.name, async () => {
            if (!mounted(root)) await doMount(root);
            return { root: root.name, path: mountPointOf(root), mounted: true };
        });
    }

    async function remount(name) {
        const root = known(name);
        return serial(root.name, async () => {
            // A plain umount hangs on a dead server or answers EBUSY while a
            // process is inside; a lazy one detaches at once.
            if (mounted(root)) await run("umount", ["-l", mountPointOf(root)]).catch((error) => log(`umount -l ${root.name}: ${error.message}`));
            await doMount(root);
            return { root: root.name, path: mountPointOf(root), mounted: true };
        });
    }

    function status() {
        const info = readMountinfo();
        return { roots: [...roots.values()].map((root) => ({ root: root.name, path: mountPointOf(root), mounted: isMountedAt(mountPointOf(root), info) })) };
    }

    const server = http.createServer(async (req, res) => {
        const reply = (code, body) => {
            res.writeHead(code, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        try {
            const url = new URL(req.url, "http://attacher");
            if (req.method === "GET" && url.pathname === "/status") return reply(200, status());
            if (req.method !== "POST" || (url.pathname !== "/mount" && url.pathname !== "/remount")) return reply(404, { error: "not found" });
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
            reply(200, url.pathname === "/mount" ? await mount(body.root) : await remount(body.root));
        } catch (error) {
            reply(error?.status ?? 500, { error: String(error?.message ?? error) });
        }
    });

    return { mount, remount, status, server, mountPointOf };
}

/** Worker side: ask the attacher over its socket. */
export function callAttacher(socketPath, method, pathname, body, timeoutMs = 25_000) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request({
            socketPath, method, path: pathname, timeout: timeoutMs,
            headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                let data = {};
                try { data = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* keep {} */ }
                if (res.statusCode >= 300) reject(new Error(data.error || `attacher ${pathname}: HTTP ${res.statusCode}`));
                else resolve(data);
            });
        });
        req.on("timeout", () => req.destroy(new Error(`attacher ${pathname}: no answer within ${timeoutMs} ms`)));
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function main() {
    const env = process.env;
    const roots = parseAttacherRoots(env.ATTACHER_ROOTS);
    if (roots.length === 0) throw new Error("ATTACHER_ROOTS is empty");
    const socket = env.ATTACHER_SOCKET || "/run/pilotswarm-attacher/sock";
    const attacher = createAttacher({
        roots,
        mountBase: env.ATTACHER_MOUNT_BASE || "/mnt/ps",
        mountOptions: env.ATTACHER_MOUNT_OPTIONS || DEFAULT_MOUNT_OPTIONS,
    });
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    try { fs.unlinkSync(socket); } catch { /* not there */ }
    await new Promise((resolve) => attacher.server.listen(socket, resolve));
    // Worker pods run as uid 1000; they must be able to connect.
    fs.chmodSync(socket, 0o666);
    console.log(`[attacher] listening on ${socket}; roots ${roots.map((root) => root.name).join(", ")}`);
    if ((env.ATTACHER_EAGER ?? "1") !== "0") {
        for (const root of roots) {
            // A root whose server is not up yet is mounted on the first ask.
            await attacher.mount(root.name).catch((error) => console.error(`[attacher] mount ${root.name} at start: ${error.message}`));
        }
    }
    // Never unmount: on SIGTERM, stop taking requests and leave the mounts.
    const stop = () => attacher.server.close(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
