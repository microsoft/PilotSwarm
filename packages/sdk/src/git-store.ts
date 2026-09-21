import { execFileSync } from "node:child_process";

/** Injected git runner: run `git <args>` in `cwd`, returning trimmed stdout. */
export type RunGit = (cwd: string, args: string[]) => string;

function assertValidRef(ref: string): void {
    const invalid = (
        ref.startsWith("-")
        || ref === "@"
        || ref.startsWith("/")
        || ref.endsWith("/")
        || ref.endsWith(".")
        || ref.includes("//")
        || ref.includes("..")
        || ref.includes("@{")
        || /[\u0000-\u0020\u007f~^:?*[\]\\]/.test(ref)
        || ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
    );
    if (invalid) {
        throw new Error(`Invalid git ref: ${JSON.stringify(ref)}`);
    }
}

/**
 * Build a Git runner. Interactive credential prompts are disabled so missing
 * credentials fail fast. Callers can inject environment-based authentication.
 */
export function makeRunGit(extraEnv: Record<string, string> = {}): RunGit {
    return (cwd, args) => execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    }).trim();
}

/**
 * Normalize a caller-supplied ref. Bare branch names map to origin/<branch>;
 * qualified refs and raw SHAs pass through unchanged.
 */
export function normalizeRef(ref: string | null | undefined): string {
    const normalized = String(ref ?? "").trim();
    if (!normalized) return normalized;
    assertValidRef(normalized);
    if (/^(origin\/|refs\/)/.test(normalized)) return normalized;
    if (/^[0-9a-f]{7,40}$/i.test(normalized)) return normalized;
    return `origin/${normalized}`;
}

/**
 * Resolve a target ref using session, worker, then repository-default
 * precedence.
 */
export function resolveTargetRef(
    sessionGitRef: string | null | undefined,
    opts: { dir: string; runGit: RunGit; envRef?: string | null },
): string {
    const { dir, runGit, envRef } = opts;
    const session = sessionGitRef != null ? String(sessionGitRef).trim() : "";
    const environment = envRef != null ? String(envRef).trim() : "";
    const explicit = session || environment;
    if (explicit) return normalizeRef(explicit);

    try {
        return runGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    } catch {
        for (const branch of ["origin/main", "origin/master"]) {
            try {
                runGit(dir, ["rev-parse", "--verify", branch]);
                return branch;
            } catch {
                // Try the next conventional default branch.
            }
        }
        throw new Error("could not resolve a default ref (set an explicit repository ref)");
    }
}

export interface GitStoreOptions {
    /** Directory whose .git directory owns the object store. */
    dir: string;
    runGit: RunGit;
    trace?: (message: string) => void;
}

/**
 * Writer role for a repository object store. Callers are responsible for
 * serializing concurrent writers.
 */
export class GitStore {
    readonly dir: string;
    private readonly git: RunGit;
    private readonly trace: (message: string) => void;

    constructor({ dir, runGit, trace }: GitStoreOptions) {
        this.dir = dir;
        this.git = runGit;
        this.trace = trace ?? (() => {});
    }

    applyConfig({ accelerators = true }: { accelerators?: boolean } = {}): void {
        this.git(this.dir, ["config", "gc.auto", "0"]);
        if (!accelerators) return;
        for (const [key, value] of [
            ["checkout.workers", "0"],
            ["core.fscache", "true"],
        ] as Array<[string, string]>) {
            try {
                this.git(this.dir, ["config", key, value]);
            } catch (error) {
                this.trace(
                    `[git-store] config ${key} skipped: ${(error as Error)?.message ?? error}`,
                );
            }
        }
    }

    hasCommit(rev: string): boolean {
        try {
            this.git(this.dir, ["cat-file", "-e", `${rev}^{commit}`]);
            return true;
        } catch {
            return false;
        }
    }

    revParse(rev: string): string {
        return this.git(this.dir, ["rev-parse", rev]);
    }

    fetchAll({ prune = true, noTags = false }: { prune?: boolean; noTags?: boolean } = {}): void {
        const args = ["fetch", prune ? "--prune" : "--no-prune"];
        if (noTags) args.push("--no-tags");
        args.push("--no-write-fetch-head", "origin");
        this.git(this.dir, args);
    }

    fetchRef(ref: string, { noTags = true }: { noTags?: boolean } = {}): void {
        const args = ["fetch"];
        if (noTags) args.push("--no-tags");
        args.push("--no-write-fetch-head", "origin", ref);
        this.git(this.dir, args);
    }

    /**
     * Ensure a target commit exists locally, using a narrow fetch before a
     * whole-branch fallback.
     */
    ensureObjects({ ref, sha }: { ref?: string; sha?: string } = {}): string {
        if (sha && this.hasCommit(sha)) return this.revParse(sha);
        if (ref) {
            const bare = String(ref).replace(/^origin\//, "");
            try {
                this.fetchRef(bare);
            } catch {
                this.fetchAll({ prune: false, noTags: true });
            }
        } else {
            this.fetchAll({ prune: false, noTags: true });
        }
        return this.revParse(sha || normalizeRef(ref));
    }

    /** Additively refresh remote branches without touching a working tree. */
    tick(): void {
        this.fetchAll({ prune: false, noTags: true });
    }

    addWorktree(worktreeDir: string, sha: string): void {
        this.git(this.dir, ["worktree", "add", "--detach", worktreeDir, sha]);
    }

    removeWorktree(worktreeDir: string): void {
        try {
            this.git(this.dir, ["worktree", "remove", "--force", worktreeDir]);
        } catch (error) {
            this.trace(
                `[git-store] worktree remove skipped: ${(error as Error)?.message ?? error}`,
            );
        }
    }

    pruneWorktrees(): void {
        try {
            this.git(this.dir, ["worktree", "prune"]);
        } catch (error) {
            this.trace(
                `[git-store] worktree prune skipped: ${(error as Error)?.message ?? error}`,
            );
        }
    }

    /** Pin a session commit as a reachability root while the session is active. */
    keep(session: string, sha: string): void {
        this.git(this.dir, ["update-ref", `refs/pilotswarm/keep/${session}`, sha]);
    }

    unkeep(session: string): void {
        try {
            this.git(this.dir, ["update-ref", "-d", `refs/pilotswarm/keep/${session}`]);
        } catch (error) {
            this.trace(`[git-store] unkeep skipped: ${(error as Error)?.message ?? error}`);
        }
    }
}

export interface RunnerOptions {
    dir: string;
    runGit: RunGit;
    trace?: (message: string) => void;
}

/** Reader role for one working tree pinned to a specific commit. */
export class Runner {
    readonly dir: string;
    private readonly git: RunGit;
    private readonly trace: (message: string) => void;

    constructor({ dir, runGit, trace }: RunnerOptions) {
        this.dir = dir;
        this.git = runGit;
        this.trace = trace ?? (() => {});
    }

    checkout(sha: string, { clean = false }: { clean?: boolean } = {}): void {
        this.trace(`[git-runner] checkout ${sha}`);
        this.git(this.dir, ["checkout", "--force", "--detach", sha]);
        this.git(this.dir, ["reset", "--hard", sha]);
        if (clean) this.git(this.dir, ["clean", "-fdx"]);
    }

    head(): string {
        return this.git(this.dir, ["rev-parse", "HEAD"]);
    }
}
