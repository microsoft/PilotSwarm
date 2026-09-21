import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type GitWorkspaceArtifactKind = "bundle" | "workspace" | "meta";

export interface GitWorkspaceState {
    baseSha: string | null;
    headSha: string | null;
    branch: string | null;
    epoch: number;
    generation: string | null;
}

export interface GitWorkspaceVersion {
    epoch: number;
    generation: string | null;
}

/** Durable, session-scoped storage for repository workspace artifacts. */
export interface GitBlobIO {
    get(key: string): Promise<Buffer | null>;
    put(key: string, data: Buffer): Promise<void>;
}

/** Durable storage for the workspace state row, which is the commit point. */
export interface GitStateIO {
    get(): Promise<GitWorkspaceState | null>;
    compareAndSet(
        expected: GitWorkspaceVersion | null,
        next: GitWorkspaceState,
    ): Promise<boolean>;
}

export interface GitWorkspaceMeta {
    branch: string | null;
    baseSha: string;
    headSha: string;
    epoch: number;
    generation: string;
    hasBundle: boolean;
    hasWorkspace: boolean;
    workspaceSize: number;
    workspaceSha256: string | null;
}

export interface HydrateOptions {
    enlistmentDir: string;
    blobs: GitBlobIO;
    state: GitStateIO;
    targetRef?: string;
    detachedCheckout?: boolean;
    trace?: (message: string) => void;
}

export interface HydrateResult {
    mode: "pinned-base" | "replayed" | "base-only";
    baseSha: string;
    headSha: string;
    epoch: number;
    generation: string | null;
}

export interface DehydrateOptions {
    enlistmentDir: string;
    blobs: GitBlobIO;
    state: GitStateIO;
    /** Version returned by the hydrate that produced this working tree. */
    expectedState: GitWorkspaceVersion;
    trace?: (message: string) => void;
}

export interface DehydrateResult {
    epoch: number;
    headSha: string;
    branch: string | null;
    baseSha: string;
    generation: string;
}

const MAX_GIT_BUFFER = 512 * 1024 * 1024;
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

/** Stable, immutable key for one committed workspace artifact generation. */
export function gitWorkspaceBlobKey(
    epoch: number,
    generation: string,
    kind: GitWorkspaceArtifactKind,
): string {
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
        throw new Error(`Invalid git workspace epoch: ${epoch}`);
    }
    if (!/^[0-9a-f-]{36}$/i.test(generation)) {
        throw new Error(`Invalid git workspace generation: ${JSON.stringify(generation)}`);
    }
    return `epoch-${epoch}/${generation}/${kind}`;
}

function git(
    cwd: string,
    args: string[],
    extraEnv: Record<string, string> = {},
): string {
    return execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...gitEnv(), ...extraEnv },
        maxBuffer: MAX_GIT_BUFFER,
    }).trim();
}

function gitBuffer(
    cwd: string,
    args: string[],
    extraEnv: Record<string, string> = {},
): Buffer {
    return execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...gitEnv(), ...extraEnv },
        maxBuffer: MAX_GIT_BUFFER,
    }) as Buffer;
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
    try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
            cwd,
            stdio: "ignore",
            env: gitEnv(),
        });
        return true;
    } catch {
        return false;
    }
}

function objectExists(cwd: string, sha: string): boolean {
    try {
        execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
            cwd,
            stdio: "ignore",
            env: gitEnv(),
        });
        return true;
    } catch {
        return false;
    }
}

function resolveBaseRef(cwd: string, explicit?: string): string {
    if (explicit) return explicit;
    try {
        return git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    } catch {
        for (const branch of ["origin/main", "origin/master"]) {
            try {
                git(cwd, ["rev-parse", "--verify", branch]);
                return branch;
            } catch {
                // Try the next conventional default branch.
            }
        }
        throw new Error("git-workspace: could not resolve a default ref (pass targetRef)");
    }
}

function branchFromRef(ref: string): string | null {
    const remote = ref.match(/^refs\/remotes\/[^/]+\/(.+)$/);
    if (remote) return remote[1];
    if (ref.startsWith("origin/")) return ref.slice("origin/".length);
    if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
    if (ref.startsWith("refs/tags/") || /^[0-9a-f]{7,40}$/i.test(ref)) return null;
    return ref;
}

function temporaryFile(suffix: string): string {
    const random = Math.random().toString(36).slice(2);
    return path.join(
        os.tmpdir(),
        `pilotswarm-git-workspace-${process.pid}-${Date.now()}-${random}${suffix}`,
    );
}

function checkoutAt(
    cwd: string,
    branch: string | null,
    sha: string,
    detached: boolean,
): void {
    git(cwd, detached || !branch
        ? ["checkout", "--force", "--detach", sha]
        : ["checkout", "-B", branch, sha]);
    git(cwd, ["reset", "--hard", sha]);
}

function cleanUntracked(cwd: string): void {
    git(cwd, ["clean", "-fdx"]);
}

function parseGitWorkspaceMeta(buffer: Buffer): GitWorkspaceMeta {
    const value: unknown = JSON.parse(buffer.toString("utf8"));
    if (!value || typeof value !== "object") {
        throw new Error("metadata is not an object");
    }
    const candidate = value as Record<string, unknown>;
    if (
        !(
            candidate.branch === null
            || (typeof candidate.branch === "string" && candidate.branch.length > 0)
        )
        || typeof candidate.baseSha !== "string"
        || !/^[0-9a-f]{40}$/i.test(candidate.baseSha)
        || typeof candidate.headSha !== "string"
        || !/^[0-9a-f]{40}$/i.test(candidate.headSha)
        || !Number.isSafeInteger(candidate.epoch)
        || (candidate.epoch as number) < 1
        || typeof candidate.generation !== "string"
        || !/^[0-9a-f-]{36}$/i.test(candidate.generation)
        || typeof candidate.hasBundle !== "boolean"
        || typeof candidate.hasWorkspace !== "boolean"
        || !Number.isSafeInteger(candidate.workspaceSize)
        || (candidate.workspaceSize as number) < 0
        || !(
            candidate.workspaceSha256 === null
            || (
                typeof candidate.workspaceSha256 === "string"
                && /^[0-9a-f]{64}$/i.test(candidate.workspaceSha256)
            )
        )
    ) {
        throw new Error("metadata schema is invalid");
    }
    if (candidate.headSha !== candidate.baseSha && candidate.hasBundle !== true) {
        throw new Error("metadata requires a bundle for a non-base head");
    }
    if (
        (
            candidate.hasWorkspace === true
            && (
                (candidate.workspaceSize as number) <= 0
                || typeof candidate.workspaceSha256 !== "string"
            )
        )
        || (
            candidate.hasWorkspace === false
            && (candidate.workspaceSize !== 0 || candidate.workspaceSha256 !== null)
        )
    ) {
        throw new Error("metadata workspace integrity fields are inconsistent");
    }
    return candidate as unknown as GitWorkspaceMeta;
}

interface WorkspaceEntry {
    path: string;
    kind: "file" | "symlink" | "delete";
    mode?: number;
    content?: string;
}

interface WorkspaceArchive {
    version: 1;
    entries: WorkspaceEntry[];
}

function nulSeparatedPaths(buffer: Buffer): string[] {
    return buffer
        .toString("utf8")
        .split("\0")
        .filter((value) => value.length > 0);
}

function assertWorkspaceRelativePath(value: string): void {
    if (
        !value
        || path.isAbsolute(value)
        || value.includes("\\")
        || value.split("/").some((part) => !part || part === "." || part === "..")
    ) {
        throw new Error(`git-workspace: invalid workspace path ${JSON.stringify(value)}`);
    }
}

function workspacePath(root: string, relativePath: string): string {
    assertWorkspaceRelativePath(relativePath);
    const candidate = path.resolve(root, ...relativePath.split("/"));
    const relative = path.relative(root, candidate);
    if (
        !relative
        || relative === ".."
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
    ) {
        throw new Error(`git-workspace: workspace path escaped root: ${relativePath}`);
    }
    return candidate;
}

function sha256(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

function decodeCanonicalBase64(value: string): Buffer {
    if (
        value.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) {
        throw new Error("workspace file content is not canonical base64");
    }
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) {
        throw new Error("workspace file content is not canonical base64");
    }
    return decoded;
}

function assertNoSymlinkAncestors(root: string, candidate: string): void {
    let current = path.dirname(candidate);
    while (current !== root) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
            throw new Error(`git-workspace: symbolic path ancestor is not allowed: ${current}`);
        }
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`git-workspace: path is not rooted under workspace: ${candidate}`);
        }
        current = parent;
    }
}

function captureWorkspaceArchive(
    dir: string,
    previouslyDurablePaths: Iterable<string> = [],
): Buffer {
    const changed = nulSeparatedPaths(
        gitBuffer(dir, ["diff", "--name-only", "--no-renames", "-z", "HEAD"]),
    );
    const untracked = nulSeparatedPaths(
        gitBuffer(dir, ["ls-files", "--others", "--exclude-standard", "-z"]),
    );
    const paths = [
        ...new Set([...changed, ...untracked, ...previouslyDurablePaths]),
    ].sort();
    const entries: WorkspaceEntry[] = paths.map((relativePath) => {
        const absolutePath = workspacePath(dir, relativePath);
        assertNoSymlinkAncestors(dir, absolutePath);
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(absolutePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return { path: relativePath, kind: "delete" };
            }
            throw error;
        }
        if (!stat) {
            return { path: relativePath, kind: "delete" };
        }
        if (stat.isSymbolicLink()) {
            return {
                path: relativePath,
                kind: "symlink",
                content: fs.readlinkSync(absolutePath),
            };
        }
        if (!stat.isFile()) {
            throw new Error(
                `git-workspace: unsupported workspace entry type at ${relativePath}`,
            );
        }
        return {
            path: relativePath,
            kind: "file",
            mode: stat.mode & 0o777,
            content: fs.readFileSync(absolutePath).toString("base64"),
        };
    });
    return Buffer.from(JSON.stringify({ version: 1, entries } satisfies WorkspaceArchive), "utf8");
}

function parseWorkspaceArchive(buffer: Buffer): WorkspaceArchive {
    const value: unknown = JSON.parse(buffer.toString("utf8"));
    if (!value || typeof value !== "object") {
        throw new Error("workspace archive is not an object");
    }
    const archive = value as { version?: unknown; entries?: unknown };
    if (archive.version !== 1 || !Array.isArray(archive.entries)) {
        throw new Error("workspace archive schema is invalid");
    }
    for (const entry of archive.entries) {
        if (!entry || typeof entry !== "object") {
            throw new Error("workspace archive entry is invalid");
        }
        const candidate = entry as Record<string, unknown>;
        if (
            typeof candidate.path !== "string"
            || !["file", "symlink", "delete"].includes(String(candidate.kind))
        ) {
            throw new Error("workspace archive entry schema is invalid");
        }
        assertWorkspaceRelativePath(candidate.path);
        if (candidate.kind === "file") {
            if (
                typeof candidate.mode !== "number"
                || !Number.isInteger(candidate.mode)
                || candidate.mode < 0
                || candidate.mode > 0o777
                || typeof candidate.content !== "string"
            ) {
                throw new Error("workspace file entry schema is invalid");
            }
        } else if (
            candidate.kind === "symlink"
            && typeof candidate.content !== "string"
        ) {
            throw new Error("workspace symlink entry schema is invalid");
        }
    }
    return archive as WorkspaceArchive;
}

function assertMetaMatchesState(
    meta: GitWorkspaceMeta,
    row: GitWorkspaceState,
): void {
    if (
        meta.epoch !== row.epoch
        || meta.generation !== row.generation
        || meta.baseSha !== row.baseSha
        || meta.headSha !== row.headSha
        || meta.branch !== row.branch
    ) {
        throw new Error(
            `git-workspace: committed epoch ${row.epoch} metadata does not match state`,
        );
    }
}

function restoreWorkspaceArchive(dir: string, archive: WorkspaceArchive): void {
    for (const entry of archive.entries.filter((candidate) => candidate.kind === "delete")) {
        const target = workspacePath(dir, entry.path);
        assertNoSymlinkAncestors(dir, target);
        fs.rmSync(target, { recursive: true, force: true });
    }
    for (const entry of archive.entries.filter((candidate) => candidate.kind === "file")) {
        const target = workspacePath(dir, entry.path);
        assertNoSymlinkAncestors(dir, target);
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, decodeCanonicalBase64(entry.content!));
        fs.chmodSync(target, entry.mode!);
    }
    for (const entry of archive.entries.filter((candidate) => candidate.kind === "symlink")) {
        const target = workspacePath(dir, entry.path);
        assertNoSymlinkAncestors(dir, target);
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(entry.content!, target);
    }
}

/**
 * Pin an initial base or restore a previously dehydrated repository workspace.
 * A state row is trusted only when its epoch matches the metadata blob.
 */
export async function hydrateGitWorkspace(opts: HydrateOptions): Promise<HydrateResult> {
    const {
        enlistmentDir,
        blobs,
        state,
        targetRef,
        detachedCheckout = false,
        trace,
    } = opts;
    const dir = path.resolve(enlistmentDir);
    const row = await state.get();

    if (!row?.baseSha) {
        try {
            git(dir, ["fetch", "--prune", "--no-write-fetch-head", "origin"]);
        } catch {
            // The target may already be available locally.
        }
        const ref = resolveBaseRef(dir, targetRef);
        const baseSha = git(dir, ["rev-parse", ref]);
        const branch = branchFromRef(ref);
        checkoutAt(dir, branch, baseSha, detachedCheckout);
        cleanUntracked(dir);
        const pinned = {
            baseSha,
            headSha: baseSha,
            branch,
            epoch: 0,
            generation: null,
        };
        if (!await state.compareAndSet(null, pinned)) {
            throw new Error("git-workspace: state changed while pinning the repository base");
        }
        trace?.(`[git-workspace] pinned base ${baseSha.slice(0, 12)} on ${branch}`);
        return {
            mode: "pinned-base",
            baseSha,
            headSha: baseSha,
            epoch: 0,
            generation: null,
        };
    }

    const baseSha = row.baseSha;
    try {
        git(dir, ["fetch", "--prune", "--no-write-fetch-head", "origin"]);
    } catch {
        // The pinned base is expected to be present locally.
    }
    const fallbackBranch = row.branch;
    checkoutAt(dir, fallbackBranch, baseSha, detachedCheckout);
    cleanUntracked(dir);

    if (row.epoch === 0 && row.generation == null) {
        return {
            mode: "base-only",
            baseSha,
            headSha: baseSha,
            epoch: row.epoch,
            generation: row.generation,
        };
    }
    if (!row.generation) {
        throw new Error(`git-workspace: committed epoch ${row.epoch} has no generation`);
    }

    const metaBuffer = await blobs.get(
        gitWorkspaceBlobKey(row.epoch, row.generation, "meta"),
    );
    if (!metaBuffer) {
        throw new Error(`git-workspace: committed epoch ${row.epoch} is missing metadata`);
    }

    let meta: GitWorkspaceMeta;
    try {
        meta = parseGitWorkspaceMeta(metaBuffer);
    } catch (error) {
        throw new Error(
            `git-workspace: committed epoch ${row.epoch} has invalid metadata`,
            { cause: error },
        );
    }

    assertMetaMatchesState(meta, row);

    const branch = meta.branch ?? fallbackBranch;
    if (meta.headSha && meta.headSha !== baseSha) {
        if (meta.hasBundle) {
            const bundle = await blobs.get(
                gitWorkspaceBlobKey(row.epoch, row.generation, "bundle"),
            );
            if (!bundle?.length) {
                throw new Error(
                    `git-workspace: committed epoch ${row.epoch} is missing its bundle`,
                );
            }
            const file = temporaryFile(".bundle");
            try {
                fs.writeFileSync(file, bundle);
                git(dir, ["bundle", "unbundle", file]);
            } finally {
                fs.rmSync(file, { force: true });
            }
        } else {
            throw new Error(
                `git-workspace: committed epoch ${row.epoch} cannot restore head without a bundle`,
            );
        }
        if (!objectExists(dir, meta.headSha)) {
            throw new Error(
                `git-workspace: committed epoch ${row.epoch} bundle does not contain its head`,
            );
        }
        checkoutAt(dir, branch, meta.headSha, detachedCheckout);
    } else {
        checkoutAt(dir, branch, baseSha, detachedCheckout);
    }

    if (meta.hasWorkspace) {
        const workspace = await blobs.get(
            gitWorkspaceBlobKey(row.epoch, row.generation, "workspace"),
        );
        if (!workspace?.length) {
            throw new Error(
                `git-workspace: committed epoch ${row.epoch} is missing its workspace archive`,
            );
        }
        if (
            workspace.length !== meta.workspaceSize
            || sha256(workspace) !== meta.workspaceSha256
        ) {
            throw new Error(
                `git-workspace: committed epoch ${row.epoch} workspace archive failed integrity validation`,
            );
        }
        restoreWorkspaceArchive(dir, parseWorkspaceArchive(workspace));
    }

    return {
        mode: "replayed",
        baseSha,
        headSha: meta.headSha || baseSha,
        epoch: row.epoch,
        generation: row.generation,
    };
}

/**
 * Capture local commits and uncommitted changes. Artifacts are written before
 * the state row so the row remains the atomic commit point.
 */
export async function dehydrateGitWorkspace(opts: DehydrateOptions): Promise<DehydrateResult> {
    const { enlistmentDir, blobs, state, expectedState, trace } = opts;
    const dir = path.resolve(enlistmentDir);
    const expectedVersion: GitWorkspaceVersion = {
        epoch: expectedState.epoch,
        generation: expectedState.generation,
    };
    const row = await state.get();
    if (
        !row
        || row.epoch !== expectedVersion.epoch
        || row.generation !== expectedVersion.generation
    ) {
        throw new Error("git-workspace: durable state advanced since this workspace was hydrated");
    }
    const headSha = git(dir, ["rev-parse", "HEAD"]);
    if (!row.baseSha) {
        throw new Error("git-workspace: hydrated state has no pinned base");
    }
    const baseSha = row.baseSha;

    let branch: string | null;
    try {
        branch = git(dir, ["symbolic-ref", "--short", "HEAD"]);
    } catch {
        branch = row.branch;
    }
    const epoch = row.epoch + 1;
    const generation = randomUUID();
    let previouslyDurablePaths: string[] = [];
    if (row.epoch > 0) {
        if (!row.generation) {
            throw new Error(`git-workspace: committed epoch ${row.epoch} has no generation`);
        }
        const priorMetaBuffer = await blobs.get(
            gitWorkspaceBlobKey(row.epoch, row.generation, "meta"),
        );
        if (!priorMetaBuffer) {
            throw new Error(`git-workspace: committed epoch ${row.epoch} is missing metadata`);
        }
        const priorMeta = parseGitWorkspaceMeta(priorMetaBuffer);
        assertMetaMatchesState(priorMeta, row);
        if (priorMeta.hasWorkspace) {
            const priorWorkspaceBuffer = await blobs.get(
                gitWorkspaceBlobKey(row.epoch, row.generation, "workspace"),
            );
            if (!priorWorkspaceBuffer) {
                throw new Error(
                    `git-workspace: committed epoch ${row.epoch} is missing its workspace archive`,
                );
            }
            if (
                priorWorkspaceBuffer.length !== priorMeta.workspaceSize
                || sha256(priorWorkspaceBuffer) !== priorMeta.workspaceSha256
            ) {
                throw new Error(
                    `git-workspace: committed epoch ${row.epoch} workspace archive failed integrity validation`,
                );
            }
            previouslyDurablePaths = parseWorkspaceArchive(priorWorkspaceBuffer)
                .entries
                .map((entry) => entry.path);
        }
    }

    let hasBundle = false;
    if (headSha !== baseSha && !isAncestor(dir, baseSha, headSha)) {
        throw new Error(
            `git-workspace: HEAD ${headSha} does not descend from pinned base ${baseSha}`,
        );
    }
    if (headSha !== baseSha) {
        const file = temporaryFile(".bundle");
        try {
            git(dir, ["bundle", "create", file, `${baseSha}..HEAD`]);
            await blobs.put(
                gitWorkspaceBlobKey(epoch, generation, "bundle"),
                fs.readFileSync(file),
            );
            hasBundle = true;
        } finally {
            fs.rmSync(file, { force: true });
        }
    }

    const workspace = captureWorkspaceArchive(dir, previouslyDurablePaths);
    const hasWorkspace = parseWorkspaceArchive(workspace).entries.length > 0;
    const workspaceSize = hasWorkspace ? workspace.length : 0;
    const workspaceSha256 = hasWorkspace ? sha256(workspace) : null;
    if (hasWorkspace) {
        await blobs.put(
            gitWorkspaceBlobKey(epoch, generation, "workspace"),
            workspace,
        );
    }

    const meta: GitWorkspaceMeta = {
        branch,
        baseSha,
        headSha,
        epoch,
        generation,
        hasBundle,
        hasWorkspace,
        workspaceSize,
        workspaceSha256,
    };
    await blobs.put(
        gitWorkspaceBlobKey(epoch, generation, "meta"),
        Buffer.from(JSON.stringify(meta), "utf8"),
    );
    const next = { baseSha, headSha, branch, epoch, generation };
    if (!await state.compareAndSet(expectedVersion, next)) {
        throw new Error(
            `git-workspace: state changed while committing epoch ${epoch}`,
        );
    }

    trace?.(
        `[git-workspace] dehydrated epoch ${epoch} head=${headSha.slice(0, 12)} `
        + `bundle=${hasBundle} workspace=${hasWorkspace}`,
    );
    return { epoch, headSha, branch, baseSha, generation };
}
