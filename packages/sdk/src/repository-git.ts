import { execFileSync } from "node:child_process";

/** Injected Git runner used by the repository workspace. */
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

/** Force a checkout to one detached commit without preserving local changes. */
export function checkoutDetached(options: {
    dir: string;
    sha: string;
    runGit: RunGit;
    trace?: (message: string) => void;
}): void {
    const { dir, sha, runGit, trace = () => {} } = options;
    trace(`[repository-git] checkout ${sha}`);
    runGit(dir, ["checkout", "--force", "--detach", sha]);
    runGit(dir, ["reset", "--hard", sha]);
}
