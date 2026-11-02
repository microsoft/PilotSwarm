/**
 * Read-only copies of a session's folders on its compute host
 * (docs/proposals/compute-providers.md, "Skills and MCP servers on remote
 * sessions").
 *
 * A session that runs on the worker is handed its skill folders as worker
 * paths. A session that runs elsewhere cannot be: the host has no such
 * paths, and the worker will not mount its own file system there. So the
 * folders this session is authorized to see are copied to the host, and
 * the runtime is given the host's paths instead.
 *
 * Two halves live here. The worker's half walks the folders it was asked
 * for and writes down what is in them — one digest per file, one digest
 * per folder — without reading a byte more than it needs. The host's half
 * keeps the bytes by digest and lays the folders out from them.
 *
 * Because every file is named by its content, a folder that has not
 * changed costs nothing to send again: the worker asks which digests the
 * host is missing and sends only those. A folder that has changed is laid
 * out again, and a host that has been replaced has an empty store and
 * gets everything.
 *
 * What it will not do:
 *
 * - **Leave the folder.** Every path is resolved before it is used and
 *   must still be inside the folder it was found in. A link that points
 *   out of the folder is left behind with the reason, not followed. The
 *   one exception is a folder of links to folders, which is how several
 *   sources of skills reach a runtime as one folder today: each link's
 *   own folder becomes a folder in its own right, and everything inside
 *   it must stay inside it.
 * - **Carry more than it was given room for.** A session's copy has a
 *   file count and a byte count, both of which a deployment can set. Any
 *   item that does not fit is left behind with the reason; what fits
 *   still goes.
 * - **Write anywhere but its own store.** A manifest arrives from the
 *   other end of a connection, so the host's half treats every path in it
 *   as hostile: relative, no parent steps, no root, or it is refused.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The most bytes one session's copy carries, before a deployment says otherwise. */
export const COMPUTE_COPY_MAX_BYTES = 64 * 1024 * 1024;
/** The most files one session's copy carries, before a deployment says otherwise. */
export const COMPUTE_COPY_MAX_FILES = 4096;

export interface ComputeCopyLimits {
    maxBytes: number;
    maxFiles: number;
}

export function computeCopyLimits(limits?: Partial<ComputeCopyLimits>): ComputeCopyLimits {
    const maxBytes = Number(limits?.maxBytes);
    const maxFiles = Number(limits?.maxFiles);
    return {
        maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : COMPUTE_COPY_MAX_BYTES,
        maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? Math.floor(maxFiles) : COMPUTE_COPY_MAX_FILES,
    };
}

/** One file of a copied folder. `path` is relative and always uses `/`. */
export interface ComputeCopyFile {
    path: string;
    digest: string;
    size: number;
    executable: boolean;
}

/** One copied folder: what the worker calls it, where it came from, what is in it. */
export interface ComputeCopyItem {
    /** The name the host lays it out under; the worker chooses it. */
    name: string;
    /** The worker path it was read from. Never sent to the host. */
    source: string;
    files: ComputeCopyFile[];
    /** Over the whole list, so an unchanged folder is recognised without reading it. */
    digest: string;
}

/** Something that could not be copied, and why. Recorded in the session's events. */
export interface ComputeCopyRefusal {
    item: string;
    path?: string;
    reason: string;
}

export interface ComputeCopyPlan {
    items: ComputeCopyItem[];
    refusals: ComputeCopyRefusal[];
    bytes: number;
    files: number;
}

/** What a folder is laid out as on the host, by the name the worker gave it. */
export type ComputeCopyPlacement = Record<string, string>;

/**
 * What each file hashed to, while its size and time of change stay the
 * same.
 *
 * A session's folders are walked at every turn, and almost nothing in
 * them ever changes; without this every turn would read every skill
 * again. A file whose size or time of change differs is read again, so a
 * file that is edited is noticed. Bounded, and dropped oldest first.
 */
const DIGESTS = new Map<string, string>();
const DIGEST_MEMORY = 20_000;

function digestOf(file: string, size: number, modified: number): string {
    const key = `${file}\u0000${size}\u0000${modified}`;
    const held = DIGESTS.get(key);
    if (held) return held;
    const digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (DIGESTS.size >= DIGEST_MEMORY) {
        const oldest = DIGESTS.keys().next();
        if (!oldest.done) DIGESTS.delete(oldest.value);
    }
    DIGESTS.set(key, digest);
    return digest;
}

function toPosix(relative: string): string {
    return relative.split(path.sep).join("/");
}

function inside(base: string, candidate: string): boolean {
    if (candidate === base) return true;
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    return candidate.startsWith(prefix);
}

/**
 * Walk the folders the session is authorized to see and write down what
 * is in them.
 *
 * Nothing here decides which folders those are: that is the same
 * selection a session on the worker gets, made where it is made today.
 */
export function planComputeCopy(
    requests: Array<{ name: string; source: string }>,
    limits: ComputeCopyLimits = computeCopyLimits(),
): ComputeCopyPlan {
    const items: ComputeCopyItem[] = [];
    const refusals: ComputeCopyRefusal[] = [];
    let bytes = 0;
    let files = 0;

    for (const request of requests) {
        let root: string;
        try {
            root = fs.realpathSync(request.source);
            if (!fs.statSync(root).isDirectory()) {
                refusals.push({ item: request.name, reason: "it is not a folder" });
                continue;
            }
        } catch (error) {
            refusals.push({ item: request.name, reason: `it could not be read: ${String((error as Error)?.message ?? error)}` });
            continue;
        }
        const collected: ComputeCopyFile[] = [];
        let overflowed = false;

        /**
         * `bases` are the folders this item's files must stay inside. The
         * first is the folder itself; a link to a folder directly inside
         * it adds its own target, which is how a folder of links to
         * skills from several sources is carried.
         */
        const walk = (dir: string, relative: string, bases: string[], depth: number): void => {
            if (overflowed) return;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch (error) {
                refusals.push({ item: request.name, path: toPosix(relative), reason: `it could not be read: ${String((error as Error)?.message ?? error)}` });
                return;
            }
            for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
                if (overflowed) return;
                const full = path.join(dir, entry.name);
                const childRelative = relative ? path.join(relative, entry.name) : entry.name;
                let resolved: string;
                let stat: fs.Stats;
                try {
                    resolved = fs.realpathSync(full);
                    stat = fs.statSync(resolved);
                } catch (error) {
                    refusals.push({ item: request.name, path: toPosix(childRelative), reason: `it could not be read: ${String((error as Error)?.message ?? error)}` });
                    continue;
                }
                const linked = resolved !== full;
                const confined = bases.some((base) => inside(base, resolved));
                if (!confined) {
                    // A link to a folder directly inside the folder being
                    // copied is the folder-of-links shape; its target
                    // becomes a folder in its own right. Anything else
                    // that points out stays where it is.
                    if (linked && stat.isDirectory() && depth === 0) {
                        walk(resolved, childRelative, [...bases, resolved], depth + 1);
                        continue;
                    }
                    refusals.push({ item: request.name, path: toPosix(childRelative), reason: "it points out of the folder" });
                    continue;
                }
                if (stat.isDirectory()) {
                    walk(resolved, childRelative, bases, depth + 1);
                    continue;
                }
                if (!stat.isFile()) {
                    refusals.push({ item: request.name, path: toPosix(childRelative), reason: "it is not an ordinary file" });
                    continue;
                }
                if (stat.size > limits.maxBytes) {
                    refusals.push({ item: request.name, path: toPosix(childRelative), reason: `it is larger than the ${limits.maxBytes} bytes a session's copy carries` });
                    continue;
                }
                if (files + 1 > limits.maxFiles) {
                    refusals.push({ item: request.name, reason: `the session's copy is already at its limit of ${limits.maxFiles} files` });
                    overflowed = true;
                    return;
                }
                if (bytes + stat.size > limits.maxBytes) {
                    refusals.push({ item: request.name, reason: `the session's copy is already at its limit of ${limits.maxBytes} bytes` });
                    overflowed = true;
                    return;
                }
                let digest: string;
                try {
                    digest = digestOf(resolved, stat.size, stat.mtimeMs);
                } catch (error) {
                    refusals.push({ item: request.name, path: toPosix(childRelative), reason: `it could not be read: ${String((error as Error)?.message ?? error)}` });
                    continue;
                }
                files += 1;
                bytes += stat.size;
                collected.push({
                    path: toPosix(childRelative),
                    digest,
                    size: stat.size,
                    // Only the one bit that changes what a file does.
                    executable: process.platform !== "win32" && (stat.mode & 0o111) !== 0,
                });
            }
        };

        walk(root, "", [root], 0);
        if (overflowed) continue;
        collected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        items.push({
            name: request.name,
            source: request.source,
            files: collected,
            digest: createHash("sha256")
                .update(collected.map((file) => `${file.path}\u0000${file.digest}\u0000${file.executable ? "x" : "-"}`).join("\n"))
                .digest("hex"),
        });
    }

    return { items, refusals, bytes, files };
}

/** Every digest a plan needs, each one once. */
export function computeCopyDigests(items: ComputeCopyItem[]): string[] {
    const digests = new Set<string>();
    for (const item of items) for (const file of item.files) digests.add(file.digest);
    return [...digests];
}

/** The plan without the worker paths: what actually crosses to the host. */
export function computeCopyManifest(items: ComputeCopyItem[]): Array<Omit<ComputeCopyItem, "source">> {
    return items.map(({ name, files, digest }) => ({ name, files, digest }));
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * A path out of a manifest, checked before anything is written.
 *
 * The manifest comes down a connection, so nothing in it is taken on
 * trust: a path must be relative, must not step up out of the folder,
 * must not name a root or a drive, and must not carry a byte a file
 * system would read as the end of a name.
 */
export function safeCopyPath(relative: unknown): string | null {
    if (typeof relative !== "string" || !relative || relative.length > 1024) return null;
    if (relative.includes("\u0000")) return null;
    if (relative.startsWith("/") || relative.startsWith("\\") || /^[A-Za-z]:/.test(relative)) return null;
    const parts = relative.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) return null;
    return path.join(...parts);
}

/**
 * The host's half: the bytes, kept by digest, and the folders laid out
 * from them.
 *
 * It is the only thing on the host that writes into the copy, and it
 * writes nowhere else.
 */
export class ComputeAssetStore {
    private readonly blobs: string;
    private readonly trees: string;
    private readonly marks: string;

    constructor(readonly root: string, private readonly limits: ComputeCopyLimits = computeCopyLimits()) {
        this.blobs = path.join(root, "blobs");
        this.trees = path.join(root, "folders");
        this.marks = path.join(root, "marks");
        for (const dir of [this.blobs, this.trees, this.marks]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    private blobPath(digest: string): string {
        return path.join(this.blobs, digest.slice(0, 2), digest);
    }

    /** Which of these the store does not already hold. */
    missing(digests: unknown): string[] {
        if (!Array.isArray(digests)) return [];
        const wanted: string[] = [];
        for (const raw of digests) {
            const digest = String(raw ?? "");
            if (!DIGEST_PATTERN.test(digest)) continue;
            if (!fs.existsSync(this.blobPath(digest))) wanted.push(digest);
        }
        return wanted;
    }

    /**
     * Keep one file's bytes. The digest is recomputed here: a store entry
     * is only ever named by what it actually contains.
     */
    put(digest: string, body: Buffer): void {
        if (!DIGEST_PATTERN.test(digest)) throw new Error("that is not a digest this store keeps");
        if (body.length > this.limits.maxBytes) throw new Error("that file is larger than a session's copy carries");
        const actual = createHash("sha256").update(body).digest("hex");
        if (actual !== digest) throw new Error("the bytes that arrived are not the bytes the digest names");
        const target = this.blobPath(digest);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.${process.pid}.${Date.now()}.part`;
        fs.writeFileSync(temporary, body, { mode: 0o400 });
        fs.renameSync(temporary, target);
    }

    /** Where a folder is, if it is already laid out as this manifest says. */
    placed(name: string, digest: string): string | null {
        if (!NAME_PATTERN.test(name) || !DIGEST_PATTERN.test(digest)) return null;
        const mark = path.join(this.marks, `${name}.txt`);
        try {
            if (fs.readFileSync(mark, "utf8").trim() !== digest) return null;
        } catch {
            return null;
        }
        const placed = path.join(this.trees, name);
        return fs.existsSync(placed) ? placed : null;
    }

    /**
     * Lay a folder out from the store, and give back where it is.
     *
     * Built beside and moved into place, so a folder is never half
     * replaced, and written read-only: the copy is something the runtime
     * reads, not a place for it to keep things.
     */
    place(item: { name: unknown; digest: unknown; files: unknown }): string {
        const name = String(item.name ?? "");
        const digest = String(item.digest ?? "");
        if (!NAME_PATTERN.test(name)) throw new Error("that is not a folder name this store lays out");
        if (!DIGEST_PATTERN.test(digest)) throw new Error("that folder's manifest carries no digest");
        const already = this.placed(name, digest);
        if (already) return already;
        const files = Array.isArray(item.files) ? item.files : [];
        if (files.length > this.limits.maxFiles) throw new Error("that folder carries more files than a session's copy does");
        const target = path.join(this.trees, name);
        const staging = path.join(this.trees, `.${name}.${process.pid}.${Date.now()}`);
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
        try {
            let bytes = 0;
            for (const raw of files) {
                const entry = raw as { path?: unknown; digest?: unknown; size?: unknown; executable?: unknown };
                const relative = safeCopyPath(entry.path);
                if (!relative) throw new Error("that folder's manifest names a path this store will not write");
                const fileDigest = String(entry.digest ?? "");
                if (!DIGEST_PATTERN.test(fileDigest)) throw new Error("that folder's manifest names a file with no digest");
                const source = this.blobPath(fileDigest);
                if (!fs.existsSync(source)) throw new Error("that folder's manifest names a file this store was never sent");
                bytes += fs.statSync(source).size;
                if (bytes > this.limits.maxBytes) throw new Error("that folder carries more bytes than a session's copy does");
                const destination = path.join(staging, relative);
                if (!inside(staging, destination)) throw new Error("that folder's manifest names a path outside the folder");
                fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
                fs.copyFileSync(source, destination);
                try {
                    fs.chmodSync(destination, entry.executable === true ? 0o555 : 0o444);
                } catch { /* a file system that does not carry modes */ }
            }
            fs.rmSync(target, { recursive: true, force: true });
            fs.renameSync(staging, target);
        } catch (error) {
            fs.rmSync(staging, { recursive: true, force: true });
            throw error;
        }
        fs.writeFileSync(path.join(this.marks, `${name}.txt`), digest, { mode: 0o600 });
        return target;
    }
}
