/**
 * Git in the portal's Workspace tab: for a session folder that is a git
 * repository, what changed (the Changes list, the letters in the file tree)
 * and its commits (the History list). Read-only: nothing here changes the
 * repository.
 *
 *   { op: "git", folder, what: "status", since? }   changed files, branch, ahead/behind
 *   { op: "git", folder, what: "log", skip? }        commits, newest first, a page at a time
 *   { op: "git", folder, what: "show", sha }         one commit and the files it changed
 *   { op: "git", folder, what: "file", rev, path }   a file's text at HEAD, in the index ("INDEX"), or at a commit
 *   { op: "git", folder, what: "compare", from, to } the files that differ between two commits
 *   { op: "git", folder, what: "checkout", sha | branch, stash? }  put the folder on a commit
 *       (detached) or back on a branch; with uncommitted changes, only with stash: true
 *   { op: "git", folder, what: "restore" }           put back the changes the tab stashed
 *
 * checkout and restore are the only calls that change the repository.
 *
 * `since` compares the files on disk with another commit instead of HEAD:
 * "main" (where this branch left the main branch) or a commit id.
 *
 * Every git run goes through the canvas commands' local runner
 * (runCanvasCommandLocally): no shell, a clean environment, git's settings
 * that start programs turned off, no network, and a repository whose own
 * settings start a program is refused. So git shows here only where the
 * deployment runs canvas commands with git allowed.
 */
import { CANVAS_WS_ERROR_CODES } from "./canvas-workspace.js";
import { WORKSPACE_FILE_ERROR_CODES, checkWorkspaceFilePath, workspaceFileError } from "./workspace-files.js";

/** M modified, A added, D deleted, R renamed, U untracked (new, not added), C conflict. */
export type WorkspaceGitLetter = "M" | "A" | "D" | "R" | "U" | "C";

export interface WorkspaceGitFile {
    /** Relative to the repository's top, which is the session folder. */
    path: string;
    /** A renamed file's old path. */
    from?: string;
    letter: WorkspaceGitLetter;
    /** Has changes added to the next commit (git add). */
    staged: boolean;
    /** Has changes not added yet, or is untracked. */
    unstaged: boolean;
    /** Lines added and removed; null for a binary file or when git did not count them. */
    added: number | null;
    removed: number | null;
    /** The same, for the staged part (HEAD ↔ index) and the rest (index ↔ disk) of a file in both groups. */
    staged_counts?: { added: number | null; removed: number | null } | null;
    unstaged_counts?: { added: number | null; removed: number | null } | null;
    /** An untracked folder: git lists it as one entry. */
    dir?: boolean;
}

export interface WorkspaceGitCommit {
    sha: string;
    short: string;
    author: string;
    email: string;
    /** Seconds since 1970. */
    time: number;
    parents: string[];
    /** Branch and tag names that point here ("HEAD -> main", "origin/main", "tag: v1"). */
    refs: string[];
    subject: string;
}

export type GitRun = (args: string[], maxOutputBytes?: number) => Promise<{ exitCode: number | null; stdout: string; stderr: string; truncated: boolean }>;

export const WORKSPACE_GIT_WHAT = ["status", "log", "show", "file", "compare", "checkout", "restore"] as const;
/** The message of a stash the Workspace tab made; restore finds it by this start. */
export const WORKSPACE_GIT_STASH_PREFIX = "pilotswarm: before checking out";
/** A file bigger than this is not sent for a diff. */
export const WORKSPACE_GIT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const WORKSPACE_GIT_LOG_PAGE = 50;
export const WORKSPACE_GIT_MAX_FILES = 2000;

const SHA_RE = /^[0-9a-f]{4,64}$/i;
// Options every diff here carries: never a program from the repository's settings.
// --ignore-submodules: git would otherwise run git inside a nested repository,
// which reads that repository's own settings (a filter there starts a program).
const DIFF_SAFE = ["--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all"];
const US = "\x1f";
const RS = "\x1e";

/** Splits `line` at its first `count` spaces: the last field keeps any spaces (a path). */
function splitFields(line: string, count: number): string[] {
    const out: string[] = [];
    let rest = line;
    for (let i = 0; i < count; i++) {
        const at = rest.indexOf(" ");
        if (at < 0) return [...out, rest];
        out.push(rest.slice(0, at));
        rest = rest.slice(at + 1);
    }
    out.push(rest);
    return out;
}

function letterOf(x: string, y: string): WorkspaceGitLetter {
    if (x === "R" || x === "C") return "R";
    if (x === "A") return y === "D" ? "D" : "A";
    if (x === "D" || y === "D") return "D";
    return "M";
}

/** `git status --porcelain=v2 --branch -z` output: the branch and the changed files. */
export function parseGitStatus(out: string): {
    head: string | null;
    branch: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    files: WorkspaceGitFile[];
} {
    let head: string | null = null;
    let branch: string | null = null;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    const files: WorkspaceGitFile[] = [];
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
        const line = parts[i];
        if (!line) continue;
        if (line.startsWith("# ")) {
            const [key, value = ""] = splitFields(line.slice(2), 1);
            if (key === "branch.oid") head = value === "(initial)" ? null : value;
            else if (key === "branch.head") branch = value === "(detached)" ? null : value;
            else if (key === "branch.upstream") upstream = value || null;
            else if (key === "branch.ab") {
                const m = /^\+(\d+) -(\d+)$/.exec(value);
                if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
            }
            continue;
        }
        const kind = line[0];
        if (kind === "?") {
            const raw = line.slice(2);
            const dir = raw.endsWith("/");
            files.push({ path: dir ? raw.slice(0, -1) : raw, letter: "U", staged: false, unstaged: true, added: null, removed: null, ...(dir ? { dir: true } : {}) });
        } else if (kind === "1") {
            // 1 XY sub mH mI mW hH hI path
            const f = splitFields(line, 8);
            const [x, y] = [f[1][0], f[1][1]];
            files.push({ path: f[8], letter: letterOf(x, y), staged: x !== ".", unstaged: y !== ".", added: null, removed: null });
        } else if (kind === "2") {
            // 2 XY sub mH mI mW hH hI Xscore path, then the old path as its own record
            const f = splitFields(line, 9);
            const [x, y] = [f[1][0], f[1][1]];
            const from = parts[++i];
            files.push({ path: f[9], from, letter: letterOf(x, y), staged: x !== ".", unstaged: y !== ".", added: null, removed: null });
        } else if (kind === "u") {
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            const f = splitFields(line, 10);
            files.push({ path: f[10], letter: "C", staged: false, unstaged: true, added: null, removed: null });
        }
    }
    return { head, branch, upstream, ahead, behind, files };
}

/** `git diff --numstat -z` output: lines added and removed per path (null: binary). */
export function parseNumstat(out: string): Map<string, { added: number | null; removed: number | null }> {
    const counts = new Map<string, { added: number | null; removed: number | null }>();
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
        const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i]);
        if (!m) continue;
        let file = m[3];
        // A rename: "added\tremoved\t", then the old path, then the new one.
        if (file === "") {
            file = parts[i + 2] ?? "";
            i += 2;
        }
        if (!file) continue;
        counts.set(file, { added: m[1] === "-" ? null : Number(m[1]), removed: m[2] === "-" ? null : Number(m[2]) });
    }
    return counts;
}

/** `git diff --name-status -z` output: the changed files, by letter. */
export function parseNameStatus(out: string): WorkspaceGitFile[] {
    const files: WorkspaceGitFile[] = [];
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
        const code = parts[i];
        if (!code) continue;
        const kind = code[0];
        if (kind === "R" || kind === "C") {
            const from = parts[++i];
            const to = parts[++i];
            if (to) files.push({ path: to, from, letter: "R", staged: false, unstaged: false, added: null, removed: null });
            continue;
        }
        const file = parts[++i];
        if (!file) continue;
        const letter: WorkspaceGitLetter = kind === "A" ? "A" : kind === "D" ? "D" : kind === "U" ? "C" : "M";
        files.push({ path: file, letter, staged: false, unstaged: false, added: null, removed: null });
    }
    return files;
}

/** `git log --format=<COMMIT_FORMAT>` output. */
const COMMIT_FORMAT = ["%H", "%h", "%an", "%ae", "%at", "%P", "%D", "%s"].join("%x1f") + "%x1e";
export function parseCommits(out: string): WorkspaceGitCommit[] {
    return out.split(RS).map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
        const [sha, short, author, email, time, parents, refs, subject] = record.split(US);
        return {
            sha, short, author, email,
            time: Number(time) || 0,
            parents: parents ? parents.split(" ").filter(Boolean) : [],
            refs: refs ? refs.split(", ").filter(Boolean) : [],
            subject: subject ?? "",
        };
    }).filter((commit) => SHA_RE.test(commit.sha || ""));
}

function withCounts(files: WorkspaceGitFile[], ...counts: Array<Map<string, { added: number | null; removed: number | null }>>): WorkspaceGitFile[] {
    return files.map((file) => {
        let added: number | null = null;
        let removed: number | null = null;
        let binary = false;
        for (const map of counts) {
            const one = map.get(file.path);
            if (!one) continue;
            if (one.added === null || one.removed === null) { binary = true; continue; }
            added = (added ?? 0) + one.added;
            removed = (removed ?? 0) + one.removed;
        }
        return binary && added === null ? file : { ...file, added, removed };
    });
}

function capped<T>(files: T[]): { files: T[]; truncated: boolean } {
    return files.length > WORKSPACE_GIT_MAX_FILES
        ? { files: files.slice(0, WORKSPACE_GIT_MAX_FILES), truncated: true }
        : { files, truncated: false };
}

async function output(run: GitRun, args: string[], maxOutputBytes = 2 * 1024 * 1024): Promise<{ ok: boolean; text: string; truncated: boolean; stderr: string }> {
    const ran = await run(args, maxOutputBytes);
    return { ok: ran.exitCode === 0, text: ran.stdout, truncated: ran.truncated, stderr: ran.stderr };
}

/** A commit id from the caller, checked, as the full id; null when it names no commit here. */
async function resolveCommit(run: GitRun, value: string): Promise<string | null> {
    const found = await output(run, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${value}^{commit}`], 4096);
    const sha = found.text.trim();
    return found.ok && SHA_RE.test(sha) ? sha : null;
}

/** Where this branch left the main branch: the merge base with origin/HEAD, main or master. */
async function mainBase(run: GitRun): Promise<{ sha: string; name: string } | null> {
    const names: string[] = [];
    const remoteHead = await output(run, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], 4096);
    if (remoteHead.ok && remoteHead.text.trim()) names.push(remoteHead.text.trim());
    names.push("main", "master", "origin/main", "origin/master");
    for (const name of names) {
        const tip = await resolveCommit(run, name);
        if (!tip) continue;
        const base = await output(run, ["merge-base", "HEAD", tip], 4096);
        const sha = base.text.trim();
        if (base.ok && SHA_RE.test(sha)) return { sha, name };
    }
    return null;
}

/**
 * A merge or rebase that stopped on conflicts: "merge", "rebase" or null.
 * Asked only when a file has a conflict, so a normal status runs no more git.
 */
async function stoppedState(run: GitRun, files: WorkspaceGitFile[]): Promise<"merge" | "rebase" | null> {
    if (!files.some((file) => file.letter === "C")) return null;
    const merge = await output(run, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], 4096);
    if (merge.ok) return "merge";
    const rebase = await output(run, ["rev-parse", "-q", "--verify", "REBASE_HEAD"], 4096);
    return rebase.ok ? "rebase" : null;
}

async function status(run: GitRun, since: unknown): Promise<Record<string, any>> {
    const listed = await output(run, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--ignore-submodules=all"]);
    if (!listed.ok) return { repo: true, available: false, reason: listed.stderr.trim() || "git status failed" };
    const parsed = parseGitStatus(listed.text);
    const base = {
        repo: true, available: true, head: parsed.head, branch: parsed.branch, upstream: parsed.upstream, ahead: parsed.ahead, behind: parsed.behind,
        // On a commit (detached): the branch it came from, to go back to.
        previousBranch: parsed.branch === null ? await previousBranch(run) : null,
        // Changes the tab stashed before a checkout, waiting to be put back.
        stash: await tabStash(run),
    };

    if (since === undefined || since === null || since === "" || since === "HEAD") {
        const staged = parsed.head ? await output(run, ["diff", "--cached", "--numstat", "-z", "-M", ...DIFF_SAFE]) : null;
        const unstaged = await output(run, ["diff", "--numstat", "-z", "-M", ...DIFF_SAFE]);
        const stagedCounts = parseNumstat(staged?.text ?? "");
        const unstagedCounts = parseNumstat(unstaged.text);
        // Each group shows its own part: a file staged and changed again
        // counts its staged lines in Staged and the rest in Changes.
        const files = withCounts(parsed.files, stagedCounts, unstagedCounts).map((file) => ({
            ...file,
            staged_counts: file.staged ? stagedCounts.get(file.path) ?? null : null,
            unstaged_counts: file.unstaged ? unstagedCounts.get(file.path) ?? null : null,
        }));
        const out = capped(files);
        return { ...base, since: null, state: await stoppedState(run, parsed.files), files: out.files, truncated: out.truncated || listed.truncated };
    }

    // The files on disk against another commit: every change since then,
    // committed or not, plus the untracked files.
    let against: { sha: string; label: string } | null = null;
    if (since === "main") {
        const found = await mainBase(run);
        if (!found) return { ...base, since: null, sinceError: "This repository has no main or master branch to compare with.", files: [], truncated: false };
        against = { sha: found.sha, label: found.name };
    } else if (typeof since === "string" && SHA_RE.test(since)) {
        const sha = await resolveCommit(run, since);
        if (!sha) return { ...base, since: null, sinceError: `No commit ${since} here.`, files: [], truncated: false };
        against = { sha, label: sha.slice(0, 7) };
    } else {
        throw workspaceFileError(WORKSPACE_FILE_ERROR_CODES.PATH_INVALID, 'since must be "HEAD", "main" or a commit id');
    }
    const names = await output(run, ["diff", "--name-status", "-z", "-M", ...DIFF_SAFE, against.sha, "--"]);
    const counts = await output(run, ["diff", "--numstat", "-z", "-M", ...DIFF_SAFE, against.sha, "--"]);
    const untracked = parsed.files.filter((file) => file.letter === "U");
    const changed = parseNameStatus(names.text).map((file) => ({ ...file, unstaged: true }));
    const files = withCounts([...changed, ...untracked], parseNumstat(counts.text));
    const out = capped(files);
    return { ...base, since: { sha: against.sha, label: against.label }, files: out.files, truncated: out.truncated || names.truncated || listed.truncated };
}

async function log(run: GitRun, skip: unknown): Promise<Record<string, any>> {
    const from = Number.isInteger(skip) && (skip as number) >= 0 && (skip as number) <= 100_000 ? (skip as number) : 0;
    const listed = await output(run, ["log", `--max-count=${WORKSPACE_GIT_LOG_PAGE + 1}`, `--skip=${from}`, `--format=${COMMIT_FORMAT}`, "--no-color"], 1024 * 1024);
    // A repository with no commit yet: git log fails, and there is nothing to show.
    if (!listed.ok) return { repo: true, available: true, commits: [], more: false };
    const commits = parseCommits(listed.text);
    return { repo: true, available: true, commits: commits.slice(0, WORKSPACE_GIT_LOG_PAGE), more: commits.length > WORKSPACE_GIT_LOG_PAGE };
}

async function show(run: GitRun, value: unknown): Promise<Record<string, any>> {
    if (typeof value !== "string" || !SHA_RE.test(value)) throw workspaceFileError(WORKSPACE_FILE_ERROR_CODES.PATH_INVALID, "sha must be a commit id");
    const sha = await resolveCommit(run, value);
    if (!sha) throw workspaceFileError(WORKSPACE_FILE_ERROR_CODES.NOT_FOUND, `no commit ${value} here`);
    const format = ["%H", "%h", "%an", "%ae", "%at", "%cn", "%ce", "%ct", "%P", "%D", "%B"].join("%x1f");
    const head = await output(run, ["show", "-s", `--format=${format}`, "--no-color", sha], 256 * 1024);
    const [full, short, author, email, time, committer, committerEmail, committedAt, parents, refs, body = ""] = head.text.split(US);
    const parentList = parents ? parents.split(" ").filter(Boolean) : [];
    // The files, against the first parent (a merge: what it brought in);
    // the first commit: everything it added.
    const diffArgs = (what: string) => parentList.length
        ? ["diff", what, "-z", "-M", ...DIFF_SAFE, parentList[0], sha, "--"]
        : ["diff-tree", "-r", "--root", "--no-commit-id", what, "-z", "-M", ...DIFF_SAFE, sha, "--"];
    const names = await output(run, diffArgs("--name-status"));
    const counts = await output(run, diffArgs("--numstat"));
    const out = capped(withCounts(parseNameStatus(names.text), parseNumstat(counts.text)));
    const message = body.replace(/\s+$/, "");
    const newline = message.indexOf("\n");
    return {
        repo: true,
        available: true,
        commit: {
            sha: full, short, author, email, time: Number(time) || 0,
            committer, committerEmail, committedAt: Number(committedAt) || 0,
            parents: parentList,
            refs: refs ? refs.split(", ").filter(Boolean) : [],
            subject: newline < 0 ? message : message.slice(0, newline),
            body: newline < 0 ? "" : message.slice(newline + 1).replace(/^\n+/, ""),
        },
        files: out.files,
        truncated: out.truncated || names.truncated,
    };
}

/** The branch the folder was on before it went to a commit (git's @{-1}), or null. */
async function previousBranch(run: GitRun): Promise<string | null> {
    const found = await output(run, ["rev-parse", "--abbrev-ref", "@{-1}"], 4096);
    const name = found.text.trim();
    return found.ok && name && name !== "HEAD" ? name : null;
}

/** The newest stash the tab made before a checkout: { ref, message }, or null. */
async function tabStash(run: GitRun): Promise<{ ref: string; message: string } | null> {
    const listed = await output(run, ["stash", "list", `--format=%gd${US}%s${RS}`], 64 * 1024);
    if (!listed.ok) return null;
    for (const record of listed.text.split(RS)) {
        const [ref, subject] = record.replace(/^\n/, "").split(US);
        // git writes "On <branch>: " before the message.
        const at = subject?.indexOf(WORKSPACE_GIT_STASH_PREFIX) ?? -1;
        if (ref && at >= 0) return { ref: ref.trim(), message: subject.slice(at).trim() };
    }
    return null;
}

/**
 * Put the folder on a commit (detached HEAD) or back on a branch. With
 * uncommitted changes (untracked files too) it answers { needsStash, changes }
 * and changes nothing, unless `stash` is true: then it stashes them first,
 * and restore puts them back. Ignored files stay where they are.
 */
async function checkout(run: GitRun, call: Record<string, unknown>): Promise<Record<string, any>> {
    const C = WORKSPACE_FILE_ERROR_CODES;
    let target: string;
    let label: string;
    if (typeof call.sha === "string") {
        if (!SHA_RE.test(call.sha)) throw workspaceFileError(C.PATH_INVALID, "sha must be a commit id");
        const sha = await resolveCommit(run, call.sha);
        if (!sha) throw workspaceFileError(C.NOT_FOUND, `no commit ${call.sha} here`);
        target = sha;
        label = sha.slice(0, 7);
    } else if (typeof call.branch === "string" && call.branch) {
        // A local branch that exists, named as git allows.
        const checked = await output(run, ["check-ref-format", "--branch", call.branch], 4096);
        const name = checked.text.trim();
        if (!checked.ok || name !== call.branch || name.startsWith("-")) throw workspaceFileError(C.PATH_INVALID, "branch must be a branch name");
        const exists = await output(run, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], 4096);
        if (!exists.ok) throw workspaceFileError(C.NOT_FOUND, `no branch ${name} here`);
        target = name;
        label = name;
    } else {
        throw workspaceFileError(C.PATH_INVALID, "checkout needs a sha or a branch");
    }
    const listed = await output(run, ["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignore-submodules=all"]);
    if (!listed.ok) return { repo: true, available: true, done: false, error: listed.stderr.trim() || "git status failed" };
    const changes = parseGitStatus(listed.text).files.length;
    const head = await output(run, ["rev-parse", "--abbrev-ref", "HEAD"], 4096);
    const from = head.text.trim() === "HEAD" ? (await output(run, ["rev-parse", "--short", "HEAD"], 4096)).text.trim() : head.text.trim();
    if (changes && call.stash !== true) return { repo: true, available: true, done: false, needsStash: true, changes };
    let stashed = false;
    if (changes) {
        const saved = await output(run, ["stash", "push", "--include-untracked", "-m", `${WORKSPACE_GIT_STASH_PREFIX} ${label} (from ${from})`], 64 * 1024);
        if (!saved.ok) return { repo: true, available: true, done: false, error: saved.stderr.trim() || "git stash failed" };
        stashed = true;
    }
    const moved = await output(run, typeof call.sha === "string" ? ["switch", "--detach", target] : ["switch", target], 64 * 1024);
    if (!moved.ok) {
        // Nothing moved: put the stashed changes straight back.
        if (stashed) await output(run, ["stash", "pop"], 64 * 1024);
        return { repo: true, available: true, done: false, error: moved.stderr.trim() || "git switch failed" };
    }
    return { repo: true, available: true, done: true, to: label, from, stashed, detached: typeof call.sha === "string" };
}

/** Put back the newest stash the tab made. A clash leaves the stash where it is. */
async function restore(run: GitRun): Promise<Record<string, any>> {
    const stash = await tabStash(run);
    if (!stash) return { repo: true, available: true, done: false, error: "There are no stashed changes from the Workspace tab." };
    const popped = await output(run, ["stash", "pop", stash.ref], 64 * 1024);
    if (!popped.ok) return { repo: true, available: true, done: false, error: (popped.stderr || popped.text).trim() || "git stash pop failed" };
    return { repo: true, available: true, done: true, message: stash.message };
}

/** The files that differ between two commits, with line counts (from ↔ to). */
async function compare(run: GitRun, fromValue: unknown, toValue: unknown): Promise<Record<string, any>> {
    for (const value of [fromValue, toValue]) {
        if (typeof value !== "string" || !SHA_RE.test(value)) throw workspaceFileError(WORKSPACE_FILE_ERROR_CODES.PATH_INVALID, "from and to must be commit ids");
    }
    const from = await resolveCommit(run, fromValue as string);
    const to = await resolveCommit(run, toValue as string);
    if (!from || !to) throw workspaceFileError(WORKSPACE_FILE_ERROR_CODES.NOT_FOUND, `no commit ${!from ? fromValue : toValue} here`);
    const names = await output(run, ["diff", "--name-status", "-z", "-M", ...DIFF_SAFE, from, to, "--"]);
    const counts = await output(run, ["diff", "--numstat", "-z", "-M", ...DIFF_SAFE, from, to, "--"]);
    const out = capped(withCounts(parseNameStatus(names.text), parseNumstat(counts.text)));
    return {
        repo: true,
        available: true,
        from: { sha: from, short: from.slice(0, 7) },
        to: { sha: to, short: to.slice(0, 7) },
        files: out.files,
        truncated: out.truncated || names.truncated,
    };
}

/**
 * A file's text at a revision, for a diff: HEAD, the index ("INDEX": what
 * the next commit holds), or a commit. `exists: false` when the file is not
 * there (an added file has no HEAD side). A binary or too-large file comes
 * back without its text.
 */
async function fileAt(run: GitRun, rev: unknown, value: unknown): Promise<Record<string, any>> {
    if (rev !== "HEAD" && rev !== "INDEX" && !(typeof rev === "string" && SHA_RE.test(rev))) {
        throw workspaceFileError(WORKSPACE_FILE_ERROR_CODES.PATH_INVALID, 'rev must be "HEAD", "INDEX" or a commit id');
    }
    const file = checkWorkspaceFilePath(value);
    if (!file || file.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw workspaceFileError(WORKSPACE_FILE_ERROR_CODES.PATH_INVALID, "path must name a file inside the repository");
    }
    // cat-file gives the bytes git stored: no filter, no textconv.
    const ran = await run(["cat-file", "blob", rev === "INDEX" ? `:${file}` : `${rev}:${file}`], WORKSPACE_GIT_MAX_FILE_BYTES + 1);
    if (ran.exitCode !== 0 && !ran.truncated) return { repo: true, available: true, exists: false };
    if (ran.truncated) return { repo: true, available: true, exists: true, tooLarge: true };
    if (ran.stdout.slice(0, 8000).includes("\0")) return { repo: true, available: true, exists: true, binary: true };
    return { repo: true, available: true, exists: true, text: ran.stdout };
}

/**
 * One git call for the Workspace tab, in a folder already known to be a
 * repository. `run` runs git there (the canvas commands' local runner).
 * A repository the runner refuses answers { available: false, reason }.
 */
export async function workspaceGit(run: GitRun, call: Record<string, unknown>): Promise<Record<string, any>> {
    const what = call?.what;
    if (!(WORKSPACE_GIT_WHAT as readonly unknown[]).includes(what)) {
        throw workspaceFileError(WORKSPACE_FILE_ERROR_CODES.PATH_INVALID, `git call "what" must be ${WORKSPACE_GIT_WHAT.join(", ")}`);
    }
    try {
        if (what === "status") return await status(run, call.since);
        if (what === "log") return await log(run, call.skip);
        if (what === "file") return await fileAt(run, call.rev, call.path);
        if (what === "compare") return await compare(run, call.from, call.to);
        if (what === "checkout") return await checkout(run, call);
        if (what === "restore") return await restore(run);
        return await show(run, call.sha);
    } catch (error: any) {
        if (error?.code === CANVAS_WS_ERROR_CODES.DENIED) return { repo: true, available: false, reason: String(error.message || "git does not run in this repository") };
        if (error?.code === CANVAS_WS_ERROR_CODES.BUSY) throw workspaceFileError(WORKSPACE_FILE_ERROR_CODES.BUSY, "too many git calls are running; try again");
        if (error?.code === CANVAS_WS_ERROR_CODES.TIMEOUT) throw workspaceFileError(WORKSPACE_FILE_ERROR_CODES.TIMEOUT, "git took too long in this folder");
        if (error?.code === CANVAS_WS_ERROR_CODES.RUN_FAILED) return { repo: true, available: false, reason: String(error.message || "git did not run") };
        throw error;
    }
}
