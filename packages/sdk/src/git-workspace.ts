import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type GitWorkspaceBlobKind = "bundle" | "patch" | "meta";

export interface GitWorkspaceState {
    baseSha: string | null;
    headSha: string | null;
    branch: string | null;
    epoch: number;
}

/** Durable, session-scoped storage for repository workspace artifacts. */
export interface GitBlobIO {
    get(kind: GitWorkspaceBlobKind): Promise<Buffer | null>;
    put(kind: GitWorkspaceBlobKind, data: Buffer): Promise<void>;
}

/** Durable storage for the workspace state row, which is the commit point. */
export interface GitStateIO {
    get(): Promise<GitWorkspaceState | null>;
    set(next: GitWorkspaceState): Promise<void>;
}

export interface GitWorkspaceMeta {
    branch: string;
    baseSha: string;
    headSha: string;
    epoch: number;
    hasBundle: boolean;
    hasPatch: boolean;
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
}

export interface DehydrateOptions {
    enlistmentDir: string;
    blobs: GitBlobIO;
    state: GitStateIO;
    trace?: (message: string) => void;
}

export interface DehydrateResult {
    epoch: number;
    headSha: string;
    branch: string;
    baseSha: string;
}

const MAX_GIT_BUFFER = 512 * 1024 * 1024;
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: gitEnv(),
        maxBuffer: MAX_GIT_BUFFER,
    }).trim();
}

function gitBuffer(cwd: string, args: string[]): Buffer {
    return execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnv(),
        maxBuffer: MAX_GIT_BUFFER,
    }) as Buffer;
}

function gitInput(cwd: string, args: string[], input: Buffer): void {
    execFileSync("git", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: gitEnv(),
        input,
        maxBuffer: MAX_GIT_BUFFER,
    });
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

function branchFromRef(ref: string): string {
    const stripped = ref.replace(/^refs\/remotes\//, "");
    const match = stripped.match(/^[^/]+\/(.+)$/);
    return match ? match[1] : stripped;
}

function temporaryFile(suffix: string): string {
    const random = Math.random().toString(36).slice(2);
    return path.join(
        os.tmpdir(),
        `pilotswarm-git-workspace-${process.pid}-${Date.now()}-${random}${suffix}`,
    );
}

function checkoutAt(cwd: string, branch: string, sha: string, detached: boolean): void {
    git(cwd, detached
        ? ["checkout", "--force", "--detach", sha]
        : ["checkout", "-B", branch, sha]);
    git(cwd, ["reset", "--hard", sha]);
}

/**
 * Pin an initial base or restore a previously dehydrated repository workspace.
 * A state row is trusted only when its epoch matches the metadata blob.
 */
export async function hydrateGitWorkspace(opts: HydrateOptions): Promise<HydrateResult> {
    const {
        enlistmentDir: dir,
        blobs,
        state,
        targetRef,
        detachedCheckout = false,
        trace,
    } = opts;
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
        await state.set({ baseSha, headSha: baseSha, branch, epoch: 0 });
        trace?.(`[git-workspace] pinned base ${baseSha.slice(0, 12)} on ${branch}`);
        return { mode: "pinned-base", baseSha, headSha: baseSha, epoch: 0 };
    }

    const baseSha = row.baseSha;
    try {
        git(dir, ["fetch", "--prune", "--no-write-fetch-head", "origin"]);
    } catch {
        // The pinned base is expected to be present locally.
    }
    const fallbackBranch = row.branch ?? branchFromRef(resolveBaseRef(dir, targetRef));
    checkoutAt(dir, fallbackBranch, baseSha, detachedCheckout);

    const metaBuffer = await blobs.get("meta");
    if (!metaBuffer) {
        return { mode: "base-only", baseSha, headSha: baseSha, epoch: row.epoch };
    }

    let meta: GitWorkspaceMeta;
    try {
        meta = JSON.parse(metaBuffer.toString("utf8")) as GitWorkspaceMeta;
    } catch {
        return { mode: "base-only", baseSha, headSha: baseSha, epoch: row.epoch };
    }

    if (meta.epoch !== row.epoch) {
        trace?.(
            `[git-workspace] ignoring uncommitted artifact epoch ${meta.epoch}; state is ${row.epoch}`,
        );
        return { mode: "base-only", baseSha, headSha: baseSha, epoch: row.epoch };
    }

    const branch = meta.branch || fallbackBranch;
    if (meta.headSha && meta.headSha !== baseSha) {
        if (meta.hasBundle) {
            const bundle = await blobs.get("bundle");
            if (bundle?.length) {
                const file = temporaryFile(".bundle");
                try {
                    fs.writeFileSync(file, bundle);
                    git(dir, ["bundle", "unbundle", file]);
                } finally {
                    fs.rmSync(file, { force: true });
                }
            }
        }
        if (!objectExists(dir, meta.headSha)) {
            checkoutAt(dir, branch, baseSha, detachedCheckout);
            return { mode: "base-only", baseSha, headSha: baseSha, epoch: row.epoch };
        }
        checkoutAt(dir, branch, meta.headSha, detachedCheckout);
    } else {
        checkoutAt(dir, branch, baseSha, detachedCheckout);
    }

    if (meta.hasPatch) {
        const patch = await blobs.get("patch");
        if (patch?.length) {
            gitInput(dir, ["apply", "--3way", "--whitespace=nowarn"], patch);
        }
    }

    return {
        mode: "replayed",
        baseSha,
        headSha: meta.headSha || baseSha,
        epoch: row.epoch,
    };
}

/**
 * Capture local commits and uncommitted changes. Artifacts are written before
 * the state row so the row remains the atomic commit point.
 */
export async function dehydrateGitWorkspace(opts: DehydrateOptions): Promise<DehydrateResult> {
    const { enlistmentDir: dir, blobs, state, trace } = opts;
    const row = await state.get();
    const headSha = git(dir, ["rev-parse", "HEAD"]);
    const baseSha = row?.baseSha ?? headSha;

    let branch: string;
    try {
        branch = git(dir, ["symbolic-ref", "--short", "HEAD"]);
    } catch {
        branch = row?.branch ?? git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    }
    const epoch = (row?.epoch ?? 0) + 1;

    let hasBundle = false;
    if (headSha !== baseSha && isAncestor(dir, baseSha, headSha)) {
        const file = temporaryFile(".bundle");
        try {
            git(dir, ["bundle", "create", file, `${baseSha}..HEAD`]);
            await blobs.put("bundle", fs.readFileSync(file));
            hasBundle = true;
        } finally {
            fs.rmSync(file, { force: true });
        }
    }

    const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"])
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
    if (untracked.length) {
        git(dir, ["add", "--intent-to-add", "--", ...untracked]);
    }

    let patch: Buffer;
    try {
        patch = gitBuffer(dir, ["diff", "--binary", "--no-color", "HEAD"]);
    } finally {
        if (untracked.length) {
            try {
                git(dir, ["reset", "--quiet", "--", "."]);
            } catch {
                // Best effort; the captured bytes are already complete.
            }
        }
    }

    const hasPatch = patch.length > 0;
    if (hasPatch) await blobs.put("patch", patch);

    const meta: GitWorkspaceMeta = {
        branch,
        baseSha,
        headSha,
        epoch,
        hasBundle,
        hasPatch,
    };
    await blobs.put("meta", Buffer.from(JSON.stringify(meta), "utf8"));
    await state.set({ baseSha, headSha, branch, epoch });

    trace?.(
        `[git-workspace] dehydrated epoch ${epoch} head=${headSha.slice(0, 12)} `
        + `bundle=${hasBundle} patch=${hasPatch}`,
    );
    return { epoch, headSha, branch, baseSha };
}
