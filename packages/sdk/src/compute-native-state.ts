import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { ComputeExecutionIdentity } from "./compute-execution.js";

export const COMPUTE_NATIVE_STATE_PROTOCOL = 1;
export const COMPUTE_NATIVE_STATE_MAX_BYTES = 64 * 1024 * 1024;
export const COMPUTE_NATIVE_STATE_MAX_ENTRIES = 4_096;

export interface ComputeNativeStateProfile {
    id: string;
    sdkVersion: string;
    runtimeVersion: string;
    /** The session root is required. Additional required runtime-global state must be declared explicitly. */
    roots: Array<{ name: string; directory: string; requiredFiles: string[]; databases?: string[];
        /** Exact relative files only; absent optional sidecars are removed on import. Unselected ancestor contents are untouched. */
        includeFiles?: string[] }>;
    unsupportedFeatures: string[];
}

export interface ComputeCheckpointBarrier {
    identity: ComputeExecutionIdentity;
    runtimeGeneration: string;
    barrierId: string;
    kind: "writer-hold" | "runtime-stopped";
    /** Opaque evidence validated by the trusted provider, not a guest assertion of authority. */
    evidence: Record<string, unknown>;
}

/** Deployment-qualified supervision. The state service must remain alive while writers are excluded. */
export interface ComputeHostSupervisor {
    prepare(identity: ComputeExecutionIdentity): Promise<{ runtimeAddress: string; connectionToken: string; runtimeGeneration: string }>;
    checkpoint(identity: ComputeExecutionIdentity): Promise<ComputeCheckpointBarrier>;
    /** Reopen an accepted hold only for the next admitted attempt. */
    endCheckpoint(barrier: ComputeCheckpointBarrier, disposition: "committed" | "discarded", nextIdentity: ComputeExecutionIdentity): Promise<void>;
    retire(identity: ComputeExecutionIdentity): Promise<{ runtimeGeneration: string; evidence: Record<string, unknown> }>;
}

export interface ComputeNativeTree {
    directories: string[];
    files: Array<{ path: string; size: number; sha256: string; data: string }>;
}

export interface ComputeNativeState {
    protocol: typeof COMPUTE_NATIVE_STATE_PROTOCOL;
    profileId: string;
    roots: Record<string, ComputeNativeTree>;
}

export interface ComputeNativeCapture {
    state: ComputeNativeState;
    barrier: ComputeCheckpointBarrier;
}

export interface ComputeNativeStateDescription {
    protocol: 1;
    sessionId: string;
    profile: ComputeNativeStateProfile;
    retained?: { identity: ComputeExecutionIdentity; runtimeGeneration?: string; stateDigest?: string };
}

export function nativeStateDigest(state: ComputeNativeState): string {
    return digest(Buffer.from(JSON.stringify(state)));
}

function profileDigest(profile: ComputeNativeStateProfile): string {
    return digest(Buffer.from(JSON.stringify({
        id: profile.id, sdkVersion: profile.sdkVersion, runtimeVersion: profile.runtimeVersion,
        roots: profile.roots.map(root => ({ name: root.name, requiredFiles: [...root.requiredFiles].sort(),
            databases: [...(root.databases ?? [])].sort(),
            ...(root.includeFiles ? { includeFiles: [...root.includeFiles].sort() } : {}) })).sort((a, b) => a.name.localeCompare(b.name)),
        unsupportedFeatures: [...profile.unsupportedFeatures].sort(),
    })));
}

export interface ComputeNativeStateOptions {
    sessionId: string;
    profile: ComputeNativeStateProfile;
    supervisor: ComputeHostSupervisor;
    maxBytes?: number;
    maxEntries?: number;
}
export type ComputeHostNativeFactory = (context: { bindingId: string; servicesDirectory: string }) =>
    ComputeNativeStateOptions | Promise<ComputeNativeStateOptions>;

export function isComputeNativeStateOptions(value: unknown): value is ComputeNativeStateOptions {
    if (!value || typeof value !== "object") return false;
    const options = value as Record<string, unknown>;
    if (typeof options.sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(options.sessionId)
        || !options.profile || typeof options.profile !== "object" || !options.supervisor || typeof options.supervisor !== "object") return false;
    const profile = options.profile as Record<string, unknown>, supervisor = options.supervisor as Record<string, unknown>;
    return ["id", "sdkVersion", "runtimeVersion"].every(key => typeof profile[key] === "string" && String(profile[key]).length > 0)
        && Array.isArray(profile.roots) && profile.roots.length > 0 && profile.roots.every(root => {
            if (!root || typeof root !== "object") return false;
            const entry = root as Record<string, unknown>;
            return typeof entry.name === "string" && typeof entry.directory === "string" && Array.isArray(entry.requiredFiles)
                && entry.requiredFiles.every(file => typeof file === "string")
                && (entry.includeFiles === undefined || (Array.isArray(entry.includeFiles) && entry.includeFiles.length > 0
                    && entry.includeFiles.every(file => typeof file === "string")))
                && (entry.databases === undefined || (Array.isArray(entry.databases) && entry.databases.every(file => typeof file === "string")));
        })
        && Array.isArray(profile.unsupportedFeatures) && profile.unsupportedFeatures.every(feature => typeof feature === "string")
        && ["prepare", "checkpoint", "endCheckpoint", "retire"].every(key => typeof supervisor[key] === "function")
        && (options.maxBytes === undefined || (Number.isSafeInteger(options.maxBytes) && Number(options.maxBytes) > 0 && Number(options.maxBytes) <= COMPUTE_NATIVE_STATE_MAX_BYTES))
        && (options.maxEntries === undefined || (Number.isSafeInteger(options.maxEntries) && Number(options.maxEntries) > 0 && Number(options.maxEntries) <= COMPUTE_NATIVE_STATE_MAX_ENTRIES));
}
export type ComputeNativeStateValidation = Pick<ComputeNativeStateOptions, "sessionId" | "profile" | "maxBytes" | "maxEntries">;

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const rootName = /^[a-z][a-z0-9-]{0,63}$/;
const reserved = (name: string) => name.split("/").some(part => part.toLowerCase().startsWith(".ps-"));

export function nativeStatePath(value: string, empty = false): string {
    if (typeof value !== "string" || (!value && !empty) || value.includes("\\") || value.includes(":")
        || /[\x00-\x1f]/.test(value) || value.startsWith("/") || (value && value.split("/").some(part => !part || part === "." || part === ".."
            || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
        || reserved(value)) throw new Error("Invalid or worker-reserved native state path");
    return value;
}

export function validateNativeState(state: ComputeNativeState, options: ComputeNativeStateValidation): void {
    if (state?.protocol !== COMPUTE_NATIVE_STATE_PROTOCOL || state.profileId !== options.profile.id
        || !state.roots || Object.keys(state.roots).sort().join() !== options.profile.roots.map(root => root.name).sort().join()) {
        throw new Error("Native state does not match the declared runtime profile");
    }
    let bytes = 0, entries = 0;
    for (const root of options.profile.roots) {
        if (!rootName.test(root.name)) throw new Error("Invalid native state root name");
        const tree = state.roots[root.name];
        if (!Array.isArray(tree?.directories) || !Array.isArray(tree?.files)) throw new Error("Incomplete native state manifest");
        const seen = new Set<string>();
        for (const name of tree.directories) {
            nativeStatePath(name, true);
            const key = name.toLowerCase();
            if (seen.has(key)) throw new Error("Duplicate native state entry");
            seen.add(key);
        }
        for (const file of tree.files) {
            nativeStatePath(file.path);
            if (root.includeFiles && !root.includeFiles.includes(file.path)) throw new Error("Native file is outside its selected-file root");
            const key = file.path.toLowerCase();
            if (seen.has(key)) throw new Error("Duplicate native state entry");
            seen.add(key);
            if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.data !== "string"
                || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error("Invalid native state file");
            const body = Buffer.from(file.data, "base64");
            if (body.toString("base64") !== file.data || body.length !== file.size || digest(body) !== file.sha256) {
                throw new Error("Native state file digest or length mismatch");
            }
            bytes += body.length;
        }
        if (root.includeFiles && tree.directories.some(name => name && !root.includeFiles!.some(file => file.startsWith(name + "/")))) {
            throw new Error("Native directory is outside its selected-file root");
        }
        entries += tree.directories.length + tree.files.length;
        if (bytes > (options.maxBytes ?? COMPUTE_NATIVE_STATE_MAX_BYTES)
            || entries > (options.maxEntries ?? COMPUTE_NATIVE_STATE_MAX_ENTRIES)) throw new Error("Native state transfer exceeds its budget");
        for (const required of root.requiredFiles) {
            nativeStatePath(required);
            if (!tree.files.some(file => file.path === required)) throw new Error(`Native state is missing required file ${required}`);
        }
    }
}

async function collect(directory: string, options: ComputeNativeStateValidation, budget: { bytes: number; entries: number }, trusted = false,
    includeFiles?: string[]): Promise<ComputeNativeTree> {
    const tree: ComputeNativeTree = { directories: [""], files: [] };
    const home = await fs.lstat(directory);
    if (!home.isDirectory() || home.isSymbolicLink()) throw new Error("Native state root must be a regular directory");
    async function walk(relative: string): Promise<void> {
        const names = includeFiles ? [...includeFiles].sort() : (await fs.readdir(path.join(directory, relative))).sort();
        for (const entry of names) {
            const name = relative ? `${relative}/${entry}` : entry;
            if (/^inuse\..+\.lock$/i.test(entry) || (trusted && !relative && entry.toLowerCase().startsWith(".ps-"))) continue;
            nativeStatePath(name);
            const absolute = path.join(directory, ...name.split("/"));
            if (includeFiles) {
                const parts = name.split("/");
                for (let count = 1; count < parts.length; count++) {
                    const parent = parts.slice(0, count).join("/");
                    const info = await fs.lstat(path.join(directory, ...parent.split("/"))).catch(error => {
                        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
                    });
                    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Selected native path crosses a link or non-directory");
                }
            }
            const info = await fs.lstat(absolute).catch(error => {
                if (includeFiles && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
            });
            if (!info) continue;
            if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) {
                throw new Error("Native state refuses links and special files");
            }
            if (++budget.entries > (options.maxEntries ?? COMPUTE_NATIVE_STATE_MAX_ENTRIES)) throw new Error("Native state has too many entries");
            if (info.isDirectory()) {
                if (includeFiles) throw new Error("A selected native file must not be a directory");
                tree.directories.push(name); await walk(name);
            }
            else {
                if (includeFiles) {
                    const parts = name.split("/");
                    for (let count = 1; count < parts.length; count++) {
                        const parent = parts.slice(0, count).join("/");
                        if (!tree.directories.includes(parent)) { tree.directories.push(parent); budget.entries++; }
                    }
                }
                if (budget.bytes + info.size > (options.maxBytes ?? COMPUTE_NATIVE_STATE_MAX_BYTES)) throw new Error("Native state exceeds its byte budget");
                const handle = await fs.open(absolute, "r");
                let body: Buffer;
                try {
                    const opened = await handle.stat();
                    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error("Native state file changed during capture");
                    body = await handle.readFile();
                    const after = await handle.stat();
                    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || body.length !== opened.size) throw new Error("Native state changed during capture");
                } finally { await handle.close(); }
                budget.bytes += body.length;
                tree.files.push({ path: name, size: body.length, sha256: digest(body), data: body.toString("base64") });
            }
        }
    }
    await walk("");
    return tree;
}

async function materialize(directory: string, tree: ComputeNativeTree): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.readdir(directory)).length) throw new Error("Native import requires empty staging");
    for (const name of tree.directories) if (name) await fs.mkdir(path.join(directory, ...name.split("/")), { recursive: true });
    for (const file of tree.files) {
        const target = path.join(directory, ...file.path.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, Buffer.from(file.data, "base64"), { mode: 0o600, flag: "wx" });
    }
}

export function sameComputeIdentity(a: ComputeExecutionIdentity, b: ComputeExecutionIdentity): boolean {
    return ["sessionId", "transcriptEpoch", "turnKey", "attemptId", "workerNodeId", "generation"]
        .every(key => a?.[key as keyof ComputeExecutionIdentity] === b?.[key as keyof ComputeExecutionIdentity]);
}

export function assertNativeAttachmentsSeparate(profile: ComputeNativeStateProfile, attachments: string[]): void {
    for (const root of profile.roots) {
        const style = root.directory.includes("\\") || /^[a-zA-Z]:/.test(root.directory) ? path.win32 : path.posix;
        const domains = root.includeFiles ? root.includeFiles.map(file => style.resolve(root.directory, ...file.split("/"))) : [style.resolve(root.directory)];
        for (const attachment of attachments) {
            const folder = style.resolve(attachment);
            const under = (parent: string, child: string) => {
                const relative = style.relative(parent, child);
                return !relative || (relative !== ".." && !relative.startsWith(".." + style.sep) && !style.isAbsolute(relative));
            };
            if (domains.some(state => under(state, folder) || under(folder, state))) throw new Error("Independent attachments must not overlap native checkpoint roots");
        }
    }
}

/** Common host state service. It never publishes an archive or accepts host-authored completion metadata. */
export class ComputeNativeStateHost {
    private current: ComputeExecutionIdentity | null = null;
    private barrier: ComputeCheckpointBarrier | null = null;
    private endpoint: { runtimeAddress: string; connectionToken: string; runtimeGeneration: string } | null = null;
    private captured: ComputeNativeState | null = null;
    private accepted: ComputeNativeState | null = null;
    private lastIdentity: ComputeExecutionIdentity | null = null;
    private retired = false;
    private parkedBarrier: ComputeCheckpointBarrier | null = null;
    private endedBarrier: { identity: ComputeExecutionIdentity; barrierId: string; disposition: "committed" | "discarded" } | null = null;
    private closingArtifacts = false;
    private readonly artifactMutations = new Set<Promise<unknown>>();
    private artifactFailures: unknown[] = [];

    get runtimeAddress(): string {
        if (!this.endpoint) throw new Error("Native runtime has not been prepared");
        return this.endpoint.runtimeAddress;
    }

    describe(): ComputeNativeStateDescription {
        return { protocol: 1, sessionId: this.options.sessionId, profile: this.options.profile,
            ...((this.current || this.lastIdentity) ? { retained: {
                identity: (this.current ?? this.lastIdentity)!, runtimeGeneration: this.endpoint?.runtimeGeneration,
                ...(this.accepted ? { stateDigest: nativeStateDigest(this.accepted) } : {}),
            } } : {}) };
    }

    constructor(readonly options: ComputeNativeStateOptions) {
        if (!isComputeNativeStateOptions(options)) throw new Error("Invalid native state/supervision options");
        if (!options.profile.roots.some(root => root.name === "session")
            || new Set(options.profile.roots.map(root => root.name)).size !== options.profile.roots.length
            || options.profile.roots.some(root => !rootName.test(root.name) || !path.isAbsolute(root.directory))) throw new Error("Invalid native state profile roots");
        const roots = options.profile.roots.map(root => path.resolve(root.directory));
        for (const root of options.profile.roots) if (root.includeFiles) {
            if (root.name === "session") throw new Error("The native session root must be a complete tree");
            root.includeFiles.forEach(file => nativeStatePath(file));
            const names = root.includeFiles.map(file => file.toLowerCase());
            if (new Set(names).size !== names.length || names.some(file => names.some(other => file !== other && file.startsWith(other + "/")))
                || root.requiredFiles.some(file => !root.includeFiles!.includes(file))
                || root.databases?.some(file => !root.includeFiles!.includes(file))) throw new Error("Invalid selected-file native root");
        }
        if (roots.some((root, index) => roots.some((other, at) => {
            if (at === index) return false;
            const relative = path.relative(other, root).split(path.sep).join("/");
            return !relative || (relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative)
                && (!options.profile.roots[at].includeFiles || options.profile.roots[at].includeFiles!.some(file =>
                    file.toLowerCase() === relative.toLowerCase() || file.toLowerCase().startsWith(relative.toLowerCase() + "/")
                    || relative.toLowerCase().startsWith(file.toLowerCase() + "/"))));
        }))) throw new Error("Native state roots must not overlap");
    }

    private assertCurrent(identity: ComputeExecutionIdentity): void {
        if (identity.sessionId !== this.options.sessionId || !this.current || !sameComputeIdentity(identity, this.current)) throw new Error("Native state attempt is not current");
    }

    async prepare(identity: ComputeExecutionIdentity, state?: ComputeNativeState): Promise<{ runtimeAddress: string; connectionToken: string; runtimeGeneration: string }> {
        if (this.current || this.barrier) throw new Error("Native state is already owned; reconcile before replacement");
        if (identity.sessionId !== this.options.sessionId) throw new Error("Native state belongs to another session");
        if (state) validateNativeState(state, this.options);
        const retaining = Boolean(state && this.accepted && this.parkedBarrier
            && nativeStateDigest(state) === nativeStateDigest(this.accepted));
        if (this.parkedBarrier && !retaining) throw new Error("Replacing retained native state requires verified retirement");
        this.current = identity;
        this.closingArtifacts = true;
        try {
            if (state) {
                if (!retaining) {
                    for (const root of this.options.profile.roots) {
                        if (root.includeFiles) await importSelectedFiles(root.directory, state.roots[root.name], root.includeFiles, this.retired);
                        else if (this.retired) await replaceNativeRoot(root.directory, state.roots[root.name]);
                        else await materialize(root.directory, state.roots[root.name]);
                    }
                }
            } else {
                for (const root of this.options.profile.roots) {
                    if (root.includeFiles) {
                        if (this.retired) await importSelectedFiles(root.directory, { directories: [""], files: [] }, root.includeFiles, true);
                        for (const name of root.includeFiles) {
                            try { await fs.lstat(path.join(root.directory, ...name.split("/"))); throw new Error("Fresh native preparation requires empty selected files"); }
                            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
                        }
                        continue;
                    }
                    if (this.retired) await replaceNativeRoot(root.directory, { directories: [""], files: [] });
                    await fs.mkdir(root.directory, { recursive: true });
                    if ((await fs.readdir(root.directory)).length) throw new Error("Fresh native preparation requires empty declared state roots");
                }
            }
            if (retaining) {
                await this.options.supervisor.endCheckpoint(this.parkedBarrier!, "committed", identity);
                this.parkedBarrier = null;
            }
            this.endpoint = await this.options.supervisor.prepare(identity);
            this.retired = false;
            this.closingArtifacts = false;
            this.artifactFailures = [];
            return this.endpoint;
        } catch (error) {
            // An uncertain start must not authorize another writer.
            throw new AggregateError([error], "Native preparation failed; execution ownership retained");
        }
    }

    async beginCheckpoint(identity: ComputeExecutionIdentity): Promise<ComputeCheckpointBarrier> {
        this.assertCurrent(identity);
        if (this.barrier || this.closingArtifacts) throw new Error("A native checkpoint barrier is already held or pending");
        this.closingArtifacts = true;
        await this.drainArtifactMutations();
        const barrier = await this.options.supervisor.checkpoint(identity);
        if (!sameComputeIdentity(identity, barrier.identity) || !barrier.barrierId || !barrier.runtimeGeneration
            || !["writer-hold", "runtime-stopped"].includes(barrier.kind)) throw new Error("Invalid native checkpoint barrier");
        this.barrier = barrier;
        return barrier;
    }

    async exportState(identity: ComputeExecutionIdentity, barrierId: string): Promise<ComputeNativeCapture> {
        this.assertCurrent(identity);
        const barrier = this.barrier;
        if (!barrier || barrier.barrierId !== barrierId) throw new Error("Native export requires its held checkpoint barrier");
        const roots: Record<string, ComputeNativeTree> = {};
        const budget = { bytes: 0, entries: 0 };
        for (const root of this.options.profile.roots) roots[root.name] = await collect(root.directory, this.options, budget, false, root.includeFiles);
        const state: ComputeNativeState = { protocol: COMPUTE_NATIVE_STATE_PROTOCOL, profileId: this.options.profile.id, roots };
        validateNativeState(state, this.options);
        this.captured = state;
        return { state, barrier };
    }

    async endCheckpoint(identity: ComputeExecutionIdentity, barrierId: string, disposition: "committed" | "discarded"): Promise<void> {
        if (this.endedBarrier?.barrierId === barrierId && sameComputeIdentity(this.endedBarrier.identity, identity)) {
            if (this.endedBarrier.disposition !== disposition) throw new Error("Native checkpoint disposition cannot change");
            return;
        }
        this.assertCurrent(identity);
        if (!this.barrier || this.barrier.barrierId !== barrierId) throw new Error("Unknown native checkpoint barrier");
        if (disposition === "committed" && !this.captured) throw new Error("A committed native checkpoint requires a complete capture");
        this.lastIdentity = identity;
        this.accepted = disposition === "committed" ? this.captured : null;
        this.captured = null;
        this.parkedBarrier = this.barrier;
        this.endedBarrier = { identity, barrierId, disposition };
        this.barrier = null;
        this.current = null;
    }

    async retire(identity: ComputeExecutionIdentity): Promise<{ runtimeGeneration: string; evidence: Record<string, unknown> }> {
        if (this.current) this.assertCurrent(identity);
        else if (this.lastIdentity ? !sameComputeIdentity(this.lastIdentity, identity) : identity.sessionId !== this.options.sessionId) throw new Error("Native retirement attempt is not current");
        this.closingArtifacts = true;
        await this.drainArtifactMutations();
        const result = await this.options.supervisor.retire(identity);
        if (!result.runtimeGeneration || (this.endpoint && result.runtimeGeneration !== this.endpoint.runtimeGeneration)) throw new Error("Native retirement generation mismatch");
        this.lastIdentity = identity;
        this.retired = true;
        this.current = null;
        this.barrier = null;
        this.parkedBarrier = null;
        this.accepted = null;
        this.captured = null;
        return result;
    }

    private async artifactPath(identity: ComputeExecutionIdentity, candidate: string, writing: boolean): Promise<string> {
        this.assertCurrent(identity);
        if (this.barrier || this.closingArtifacts) throw new Error("Native artifact writes/reads are closed during capture");
        const root = path.join(this.options.profile.roots.find(entry => entry.name === "session")!.directory, "files");
        const relative = path.relative(root, path.resolve(root, candidate));
        nativeStatePath(relative.split(path.sep).join("/"));
        let current = root;
        const parts = relative.split(path.sep);
        for (let index = 0; index < parts.length; index++) {
            const info = await fs.lstat(current).catch(error => {
                if (writing && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
            });
            if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Native artifact path crosses a link");
            current = path.join(current, parts[index]);
        }
        try {
            const info = await fs.lstat(current);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Native artifact is not a regular unlinked file");
        } catch (error) { if (!writing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return current;
    }

    async readArtifact(identity: ComputeExecutionIdentity, candidate: string): Promise<{ path: string; data: string; sha256: string }> {
        const file = await this.artifactPath(identity, candidate, false);
        const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const info = await this.checkArtifactHandle(file, handle);
            if (info.size > (this.options.maxBytes ?? COMPUTE_NATIVE_STATE_MAX_BYTES)) throw new Error("Native artifact exceeds its byte budget");
            const body = await handle.readFile();
            if (body.length > (this.options.maxBytes ?? COMPUTE_NATIVE_STATE_MAX_BYTES)) throw new Error("Native artifact grew beyond its byte budget");
            return { path: file, data: body.toString("base64"), sha256: digest(body) };
        } finally { await handle.close(); }
    }

    async writeArtifact(identity: ComputeExecutionIdentity, candidate: string, data: string, sha256: string): Promise<{ path: string }> {
        this.assertCurrent(identity);
        if (this.barrier || this.closingArtifacts) throw new Error("Native artifact writes/reads are closed during capture");
        const mutation = this.writeArtifactBody(identity, candidate, data, sha256);
        this.artifactMutations.add(mutation);
        try { return await mutation; }
        catch (error) { this.artifactFailures.push(error); throw error; }
        finally { this.artifactMutations.delete(mutation); }
    }

    private async drainArtifactMutations(): Promise<void> {
        while (this.artifactMutations.size) await Promise.allSettled([...this.artifactMutations]);
        if (this.artifactFailures.length) throw new AggregateError(this.artifactFailures, "Native artifact mutation failed; capture/retirement remains blocked");
    }

    private async writeArtifactBody(identity: ComputeExecutionIdentity, candidate: string, data: string, sha256: string): Promise<{ path: string }> {
        const body = Buffer.from(data, "base64");
        if (body.toString("base64") !== data || body.length > (this.options.maxBytes ?? COMPUTE_NATIVE_STATE_MAX_BYTES) || digest(body) !== sha256) throw new Error("Invalid native artifact payload");
        const file = await this.artifactPath(identity, candidate, true);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
            await this.checkArtifactHandle(file, handle);
            await handle.truncate(0);
            await handle.writeFile(body);
        } finally { await handle.close(); }
        return { path: file };
    }

    private async checkArtifactHandle(file: string, handle: fs.FileHandle): Promise<import("node:fs").Stats> {
        const root = path.join(this.options.profile.roots.find(entry => entry.name === "session")!.directory, "files");
        const realRoot = await fs.realpath(root), real = await fs.realpath(file);
        const info = await handle.stat(), current = await fs.stat(real);
        if (realRoot !== root || !real.startsWith(realRoot + path.sep) || !info.isFile() || info.nlink !== 1
            || info.dev !== current.dev || info.ino !== current.ino) throw new Error("Native artifact path changed or escaped its root");
        return info;
    }
}

async function importSelectedFiles(directory: string, tree: ComputeNativeTree, selected: string[], replace: boolean): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    const root = await fs.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Selected native root must be a regular directory");
    for (const name of selected) {
        nativeStatePath(name);
        const parts = name.split("/");
        let parent = directory;
        for (const part of parts.slice(0, -1)) {
            parent = path.join(parent, part);
            await fs.mkdir(parent).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
            const info = await fs.lstat(parent);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Selected native import crosses a link");
        }
        const target = path.join(directory, ...parts);
        const existing = await fs.lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
        if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error("Selected native target is not a regular unlinked file");
        if (existing && !replace) throw new Error("Native import requires empty selected files");
        const file = tree.files.find(entry => entry.path === name);
        if (!file) { if (replace && existing) await fs.unlink(target); continue; }
        const temporary = await fs.mkdtemp(path.join(parent, ".native-file-"));
        try {
            const staged = path.join(temporary, "value");
            await fs.writeFile(staged, Buffer.from(file.data, "base64"), { mode: 0o600, flag: "wx" });
            await fs.rename(staged, target);
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    }
}

async function replaceNativeRoot(directory: string, tree: ComputeNativeTree): Promise<void> {
    const parent = path.dirname(directory);
    await fs.mkdir(parent, { recursive: true });
    const staging = await fs.mkdtemp(path.join(parent, ".native-import-"));
    const displaced = `${staging}.previous`;
    let moved = false;
    try {
        await materialize(staging, tree);
        try {
            const info = await fs.lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Native restore root is not a regular directory");
            await fs.rename(directory, displaced);
            moved = true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        try { await fs.rename(staging, directory); }
        catch (error) { if (moved) await fs.rename(displaced, directory); throw error; }
        if (moved) await fs.rm(displaced, { recursive: true, force: true });
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

/** Trusted worker staging, kept separate from independent workspace roots. */
export async function stageNativeCapture(directory: string, state: ComputeNativeState, options: ComputeNativeStateValidation): Promise<void> {
    validateNativeState(state, options);
    await fs.mkdir(path.dirname(directory), { recursive: true });
    const temporary = await fs.mkdtemp(path.join(path.dirname(directory), ".ps-native-"));
    try {
        await materialize(temporary, state.roots.session);
        for (const [name, tree] of Object.entries(state.roots)) {
            if (name !== "session") await materialize(path.join(temporary, ".ps-native-roots", name), tree);
        }
        for (const root of options.profile.roots) {
            for (const database of root.databases ?? []) {
                nativeStatePath(database);
                const file = path.join(root.name === "session" ? temporary : path.join(temporary, ".ps-native-roots", root.name), ...database.split("/"));
                const { DatabaseSync } = await import("node:sqlite");
                const validation = await fs.mkdtemp(path.join(path.dirname(temporary), ".ps-sqlite-"));
                try {
                    const target = path.join(validation, "state.db");
                    await fs.copyFile(file, target);
                    for (const suffix of ["-wal", "-shm"]) {
                        try { await fs.copyFile(file + suffix, target + suffix); }
                        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
                    }
                    const connection = new DatabaseSync(target, { readOnly: true });
                    try {
                        const rows = connection.prepare("PRAGMA integrity_check(1)").all();
                        if (rows.length !== 1 || rows[0].integrity_check !== "ok") throw new Error("Native SQLite integrity validation failed");
                    } finally { connection.close(); }
                } finally { await fs.rm(validation, { recursive: true, force: true }); }
            }
        }
        await fs.writeFile(path.join(temporary, ".ps-native-state.json"), JSON.stringify({
            protocol: state.protocol, profileId: state.profileId, sdkVersion: options.profile.sdkVersion,
            runtimeVersion: options.profile.runtimeVersion, profileDigest: profileDigest(options.profile),
            locations: Object.fromEntries(options.profile.roots.map(root => [root.name, root.directory])),
        }));
        const previous = `${temporary}.previous`;
        let displaced = false;
        try {
            await fs.rename(directory, previous);
            displaced = true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        try { await fs.rename(temporary, directory); }
        catch (error) {
            if (displaced) await fs.rename(previous, directory);
            throw error;
        }
        if (displaced) await fs.rm(previous, { recursive: true, force: true });
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function readNativeStaging(directory: string, options: ComputeNativeStateValidation): Promise<ComputeNativeState> {
    let evidence: Record<string, unknown>;
    try { evidence = JSON.parse(await fs.readFile(path.join(directory, ".ps-native-state.json"), "utf8")); }
    catch (error) { throw new Error("Native archive profile/version evidence is missing or invalid", { cause: error }); }
    if (evidence?.protocol !== COMPUTE_NATIVE_STATE_PROTOCOL || evidence.profileId !== options.profile.id
        || evidence.sdkVersion !== options.profile.sdkVersion || evidence.runtimeVersion !== options.profile.runtimeVersion
        || evidence.profileDigest !== profileDigest(options.profile)) {
        throw new Error("Native archive profile/version evidence is incompatible; implicit mode conversion is not supported");
    }
    const roots: Record<string, ComputeNativeTree> = {};
    const budget = { bytes: 0, entries: 0 };
    for (const root of options.profile.roots) {
        roots[root.name] = await collect(root.name === "session" ? directory
            : path.join(directory, ".ps-native-roots", root.name), options, budget, true, root.includeFiles);
    }
    const state: ComputeNativeState = { protocol: COMPUTE_NATIVE_STATE_PROTOCOL, profileId: options.profile.id, roots };
    validateNativeState(state, options);
    return state;
}
