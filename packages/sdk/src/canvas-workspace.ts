/**
 * canvas-ws: a canvas app's access to its session's folders (the files the
 * portal's Workspace tab shows), and to commands the drawing agent declared,
 * without a turn of the agent.
 *
 * The app declares everything in its CANVAS-APP-MANIFEST:
 *
 *   "workspace": {
 *     "read":  ["work/**", "home/notes/*.md"],     paths it may list and read
 *     "write": ["home/notes/*.md"],                paths it may write, move and delete
 *     "watch": true,                               the portal tells it when files change
 *     "commands": {
 *       "history": {
 *         "in": "work",                            the folder it runs in ("work/tfenv": a folder inside one)
 *         "run": ["git", "log", "-n", "{limit}", "--", "{path}"],
 *         "params": { "path": { "type": "path" }, "limit": { "type": "int", "min": 1, "max": 200 } }
 *       }
 *     }
 *   }
 *
 * Paths are "<folder>/<path inside it>": the working folder is "work", an
 * extra folder keeps its own name ("home", "shared", ...).
 *
 * Rules:
 * - The server reads the declaration from the canvas document the agent
 *   drew. A page can only use what its agent declared.
 * - A command's program is written out. Each parameter fills one whole
 *   argument after a type check. There is no shell.
 * - The deployment decides whether commands run at all, and which programs
 *   may run (canvasCommands config). The local runner is for development:
 *   it runs the program as the portal's own user, so a repository's own git
 *   settings (a diff textconv program, say) would run there too. A
 *   deployment needs a sandboxed runner instead.
 */
import { spawn } from "node:child_process";
import { CANVAS_WORKING_FOLDER_NAME } from "./workspace-check.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CANVAS_WS_ERROR_CODES = {
    UNDECLARED: "CANVAS_WS_UNDECLARED",
    DENIED: "CANVAS_WS_DENIED",
    FOLDER_UNKNOWN: "CANVAS_WS_FOLDER_UNKNOWN",
    COMMAND_UNKNOWN: "CANVAS_WS_COMMAND_UNKNOWN",
    PARAM_INVALID: "CANVAS_WS_PARAM_INVALID",
    COMMANDS_DISABLED: "CANVAS_WS_COMMANDS_DISABLED",
    PROGRAM_NOT_ALLOWED: "CANVAS_WS_PROGRAM_NOT_ALLOWED",
    BUSY: "CANVAS_WS_BUSY",
    TIMEOUT: "CANVAS_WS_TIMEOUT",
    RUN_FAILED: "CANVAS_WS_RUN_FAILED",
} as const;
const E = CANVAS_WS_ERROR_CODES;

const STATUS: Record<string, number> = {
    [E.UNDECLARED]: 403, [E.DENIED]: 403, [E.PROGRAM_NOT_ALLOWED]: 403, [E.COMMANDS_DISABLED]: 403,
    [E.FOLDER_UNKNOWN]: 404, [E.COMMAND_UNKNOWN]: 404,
    [E.PARAM_INVALID]: 400, [E.BUSY]: 429, [E.RUN_FAILED]: 422, [E.TIMEOUT]: 504,
};

export function canvasWsError(code: string, message: string): Error {
    // A timeout's message is fixed and the page should see it (the Web API
    // hides other 5xx messages).
    return Object.assign(new Error(message), { code, status: STATUS[code] ?? 400, ...(code === E.TIMEOUT ? { expose: true } : {}) });
}

// ─── The declaration ──────────────────────────────────────────────────

export type CanvasCommandParam =
    | { type: "path"; optional?: boolean }
    | { type: "int"; min: number; max?: number; default?: number }
    | { type: "enum"; values: string[]; default?: string }
    | { type: "ref"; default?: string }
    | { type: "sha" }
    | { type: "text"; maxLength: number; default?: string };

export interface CanvasCommand {
    /** The folder it runs in: "work", an extra folder's name, or a folder inside one ("work/tfenv"). */
    in: string;
    /** The program, then its arguments. "{name}" is a parameter; it must be a whole argument. */
    run: string[];
    params?: Record<string, CanvasCommandParam>;
    /** 1–60. Default 20. */
    timeoutSeconds?: number;
    /** Standard output kept, 1 KB – 1 MB. Default 256 KB. */
    maxOutputBytes?: number;
}

export interface CanvasWorkspaceDeclaration {
    read: string[];
    write: string[];
    watch: boolean;
    commands: Record<string, CanvasCommand>;
}

const GLOB_CAP = 32;
const COMMAND_CAP = 16;
const PARAM_CAP = 16;
const RUN_CAP = 64;
const DECLARATION_MAX_BYTES = 8 * 1024;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const PROGRAM_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const PLACEHOLDER_RE = /^\{([A-Za-z][A-Za-z0-9_]{0,31})\}$/;
const REF_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/~^-]{1,200}$/;
const SHA_RE = /^[0-9a-fA-F]{4,64}$/;

function normalizeGlobs(raw: unknown, what: string): string[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new Error(`workspace.${what} must be a list of path patterns`);
    if (raw.length > GLOB_CAP) throw new Error(`workspace.${what} has more than ${GLOB_CAP} patterns`);
    return raw.map((glob) => {
        const bad = typeof glob !== "string" || !glob.trim() || glob.length > 200 || glob.includes("\0")
            || glob.trim().startsWith("/") || glob.split("/").some((part) => part === ".." || part === ".");
        if (bad) throw new Error(`workspace.${what}: ${JSON.stringify(glob)} is not a "<folder>/<path>" pattern`);
        return glob.trim().replace(/\/+$/, "");
    });
}

function normalizeParam(name: string, raw: any): CanvasCommandParam {
    if (!raw || typeof raw !== "object") throw new Error(`parameter "${name}" must be an object with a type`);
    const integer = (value: unknown, what: string): number | undefined => {
        if (value === undefined) return undefined;
        const n = Number(value);
        if (!Number.isSafeInteger(n)) throw new Error(`parameter "${name}": ${what} must be a whole number`);
        return n;
    };
    switch (raw.type) {
        case "path":
            return { type: "path", ...(raw.optional === true ? { optional: true } : {}) };
        case "int": {
            // Without a declared minimum, 0: a negative number reads as an option ("-5").
            const min = integer(raw.min, "min") ?? 0;
            const max = integer(raw.max, "max");
            const fallback = integer(raw.default, "default");
            if (max !== undefined && max < min) throw new Error(`parameter "${name}": max is below min`);
            if (fallback !== undefined && (fallback < min || (max !== undefined && fallback > max))) throw new Error(`parameter "${name}": default is outside min..max`);
            return { type: "int", min, ...(max !== undefined ? { max } : {}), ...(fallback !== undefined ? { default: fallback } : {}) };
        }
        case "enum": {
            if (!Array.isArray(raw.values) || raw.values.length === 0 || raw.values.length > 64) throw new Error(`parameter "${name}": values must be a list of 1–64 strings`);
            const values = raw.values.map((value: unknown) => {
                if (typeof value !== "string" || !value || value.length > 200 || value.includes("\0")) throw new Error(`parameter "${name}": each value must be a string`);
                return value;
            });
            if (raw.default !== undefined && !values.includes(raw.default)) throw new Error(`parameter "${name}": default must be one of the values`);
            return { type: "enum", values, ...(raw.default !== undefined ? { default: raw.default } : {}) };
        }
        case "ref":
            if (raw.default !== undefined && (typeof raw.default !== "string" || !REF_RE.test(raw.default))) throw new Error(`parameter "${name}": default must be a branch, tag or commit name`);
            return { type: "ref", ...(raw.default !== undefined ? { default: raw.default } : {}) };
        case "sha":
            return { type: "sha" };
        case "text": {
            const maxLength = integer(raw.maxLength, "maxLength") ?? 200;
            if (maxLength < 1 || maxLength > 2000) throw new Error(`parameter "${name}": maxLength must be 1–2000`);
            if (raw.default !== undefined && typeof raw.default !== "string") throw new Error(`parameter "${name}": default must be a string`);
            return { type: "text", maxLength, ...(raw.default !== undefined ? { default: raw.default } : {}) };
        }
        default:
            throw new Error(`parameter "${name}": type must be path, int, enum, ref, sha or text`);
    }
}

// Git subcommands a canvas command may run: ones that start no program with
// the runner's settings and cannot reach the network. Not: difftool,
// mergetool, bisect, rebase (--exec), filter-branch, submodule, archive,
// config, fetch/pull/push/clone/remote, send-email.
const GIT_SUBCOMMANDS = new Set([
    "add", "apply", "blame", "branch", "cat-file", "checkout", "cherry-pick", "clean", "commit", "count-objects",
    "describe", "diff", "diff-files", "diff-index", "diff-tree", "for-each-ref", "grep", "log", "ls-files",
    "ls-tree", "merge", "merge-base", "mv", "name-rev", "range-diff", "reflog", "reset", "restore", "rev-list",
    "rev-parse", "revert", "rm", "shortlog", "show", "show-ref", "stash", "status", "switch", "tag", "whatchanged",
]);
// Options that start a program, write output somewhere else, or read files
// outside the repository.
const GIT_REFUSED_OPTION = /^(?:--(?:output|output-directory|open-files-in-pager|exec|extcmd|upload-pack|receive-pack|no-index|git-dir|work-tree|namespace|exec-path|config-env|template|file)(?:=|$)|-O)/;

function checkGitRun(name: string, run: string[]): void {
    const subcommand = run[1];
    if (!subcommand || PLACEHOLDER_RE.test(subcommand) || !GIT_SUBCOMMANDS.has(subcommand)) {
        throw new Error(`command "${name}": run[1] must be a git subcommand canvas apps may use (${[...GIT_SUBCOMMANDS].join(", ")}); no options before it; choose the folder with "in"`);
    }
    for (const part of run.slice(2)) {
        if (PLACEHOLDER_RE.test(part)) continue;
        if (GIT_REFUSED_OPTION.test(part)) throw new Error(`command "${name}": git option ${JSON.stringify(part)} is not allowed in canvas commands`);
        const value = part.includes("=") ? part.slice(part.indexOf("=") + 1) : part;
        if (value.startsWith("/") || value === ".." || value.startsWith("../") || value.includes("/../") || value.endsWith("/..")) {
            throw new Error(`command "${name}": ${JSON.stringify(part)} names a place outside the command's folder`);
        }
    }
}

function normalizeCommand(name: string, raw: any): CanvasCommand {
    if (!NAME_RE.test(name)) throw new Error(`command name ${JSON.stringify(name)} must be letters, digits, _ or - (up to 32, starting with a letter)`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`command "${name}" must be an object`);
    const where: string = typeof raw.in === "string" ? raw.in.trim().replace(/\/+$/, "") : "";
    if (!where || where.length > 512 || where.startsWith("/") || where.includes("\0") || where.split("/").some((part: string) => !part || part === "." || part === "..")) {
        throw new Error(`command "${name}": "in" must be a session folder ("work", "home", ...) or a folder inside one ("work/tfenv")`);
    }
    if (!Array.isArray(raw.run) || raw.run.length === 0 || raw.run.length > RUN_CAP) throw new Error(`command "${name}": "run" must be a list of 1–${RUN_CAP} strings`);
    const rawParams = raw.params ?? {};
    if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) throw new Error(`command "${name}": params must be an object`);
    const paramNames = Object.keys(rawParams);
    if (paramNames.length > PARAM_CAP) throw new Error(`command "${name}" has more than ${PARAM_CAP} parameters`);
    const params: Record<string, CanvasCommandParam> = {};
    for (const paramName of paramNames) {
        if (!PARAM_NAME_RE.test(paramName)) throw new Error(`command "${name}": parameter name ${JSON.stringify(paramName)} is not allowed`);
        params[paramName] = normalizeParam(paramName, rawParams[paramName]);
    }
    const run: string[] = raw.run.map((part: unknown, index: number) => {
        if (typeof part !== "string" || part.length > 500 || part.includes("\0")) throw new Error(`command "${name}": run[${index}] must be a string`);
        const placeholder = PLACEHOLDER_RE.exec(part);
        if (index === 0) {
            if (!PROGRAM_RE.test(part)) throw new Error(`command "${name}": run[0] must be a program name, like "git" (no path, no parameter)`);
        } else if (placeholder) {
            if (!params[placeholder[1]]) throw new Error(`command "${name}": run uses {${placeholder[1]}}, which is not in params`);
        } else if (/\{[A-Za-z][A-Za-z0-9_]*\}/.test(part)) {
            throw new Error(`command "${name}": run[${index}] mixes text and a parameter; a parameter must be a whole argument`);
        }
        return part;
    });
    if (run[0] === "git") checkGitRun(name, run);
    const timeoutSeconds = raw.timeoutSeconds === undefined ? undefined : Number(raw.timeoutSeconds);
    if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60)) {
        throw new Error(`command "${name}": timeoutSeconds must be 1–60`);
    }
    const maxOutputBytes = raw.maxOutputBytes === undefined ? undefined : Number(raw.maxOutputBytes);
    if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 1024 * 1024)) {
        throw new Error(`command "${name}": maxOutputBytes must be 1024 – 1048576`);
    }
    return {
        in: where,
        run,
        ...(paramNames.length ? { params } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    };
}

/**
 * A manifest's `workspace` block, checked. `workspace` is null when there is
 * none; `error` says what is wrong when it is there and broken (the draw
 * then fails, like a broken manifest).
 */
export function normalizeCanvasWorkspaceManifest(raw: unknown): { workspace: CanvasWorkspaceDeclaration | null; error?: string } {
    if (raw === undefined || raw === null) return { workspace: null };
    if (typeof raw !== "object" || Array.isArray(raw)) return { workspace: null, error: "workspace must be an object" };
    const r = raw as Record<string, any>;
    try {
        const commands: Record<string, CanvasCommand> = {};
        if (r.commands !== undefined) {
            if (!r.commands || typeof r.commands !== "object" || Array.isArray(r.commands)) throw new Error("workspace.commands must be an object of named commands");
            const names = Object.keys(r.commands);
            if (names.length > COMMAND_CAP) throw new Error(`workspace.commands has more than ${COMMAND_CAP} commands`);
            for (const name of names) commands[name] = normalizeCommand(name, r.commands[name]);
        }
        const workspace: CanvasWorkspaceDeclaration = {
            read: normalizeGlobs(r.read, "read"),
            write: normalizeGlobs(r.write, "write"),
            watch: r.watch === true,
            commands,
        };
        if (!workspace.read.length && !workspace.write.length && !Object.keys(commands).length) return { workspace: null };
        const bytes = Buffer.byteLength(JSON.stringify(workspace), "utf8");
        if (bytes > DECLARATION_MAX_BYTES) throw new Error(`the workspace block is ${bytes} bytes; the limit is ${DECLARATION_MAX_BYTES}`);
        return { workspace };
    } catch (error: any) {
        return { workspace: null, error: error?.message ?? String(error) };
    }
}

// ─── Paths and patterns ───────────────────────────────────────────────

/** A pattern as a regular expression: `**` any depth, `*` and `?` inside one part. */
export function canvasGlobRegExp(glob: string): RegExp {
    let out = "";
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === "*" && glob[i + 1] === "*") {
            const slash = glob[i + 2] === "/";
            out += slash ? "(?:.*/)?" : ".*";
            i += slash ? 2 : 1;
        } else if (ch === "*") out += "[^/]*";
        else if (ch === "?") out += "[^/]";
        else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${out}$`);
}

export function canvasGlobMatch(glob: string, target: string): boolean {
    return canvasGlobRegExp(glob).test(target);
}

/** Could `glob` match something inside `dir`, or `dir` itself? (A folder the app lists on its way to its files.) */
export function canvasGlobReaches(glob: string, dir: string): boolean {
    if (canvasGlobMatch(glob, dir)) return true;
    const globParts = glob.split("/");
    const dirParts = dir.split("/").filter(Boolean);
    for (let i = 0; i < dirParts.length; i++) {
        const part = globParts[i];
        if (part === undefined) return false;
        if (part.includes("**")) return true;
        if (!canvasGlobMatch(part, dirParts[i])) return false;
    }
    return globParts.length > dirParts.length;
}

export type CanvasAccessMode = "read" | "write";

/** May the app read (or write) this path? Write patterns also allow reading. */
export function canvasPathAllowed(declaration: CanvasWorkspaceDeclaration, target: string, mode: CanvasAccessMode): boolean {
    const globs = mode === "write" ? declaration.write : [...declaration.read, ...declaration.write];
    return globs.some((glob) => canvasGlobMatch(glob, target));
}

/** May the app list this folder? Only when one of its patterns reaches into it. */
export function canvasDirListable(declaration: CanvasWorkspaceDeclaration, dir: string): boolean {
    return [...declaration.read, ...declaration.write].some((glob) => canvasGlobReaches(glob, dir));
}

/**
 * May the app read everything inside this folder (a folder download)? Only
 * when a pattern ending in `**` covers the whole folder.
 */
export function canvasTreeReadable(declaration: CanvasWorkspaceDeclaration, dir: string): boolean {
    return [...declaration.read, ...declaration.write].some((glob) => glob.endsWith("**") && canvasGlobMatch(glob, `${dir}/`));
}

/** May the app change everything inside this folder (delete it with its contents)? */
export function canvasTreeWritable(declaration: CanvasWorkspaceDeclaration, dir: string): boolean {
    return declaration.write.some((glob) => glob.endsWith("**") && canvasGlobMatch(glob, `${dir}/`));
}

/** May the app make this folder? When one of its write patterns reaches into it. */
export function canvasDirWritable(declaration: CanvasWorkspaceDeclaration, dir: string): boolean {
    return declaration.write.some((glob) => canvasGlobReaches(glob, dir));
}

/** "<folder>/<path>" to its parts. The path may be "" (the folder itself). */
export function splitCanvasPath(value: unknown): { folder: string; path: string } {
    if (typeof value !== "string" || !value.trim()) throw canvasWsError(E.PARAM_INVALID, "a path is \"<folder>/<path>\", for example \"work/README.md\"");
    if (value.includes("\0") || value.startsWith("/") || value.length > 4096) throw canvasWsError(E.PARAM_INVALID, "a path is \"<folder>/<path>\", relative");
    const clean = value.replace(/\/+$/, "");
    if (clean.split("/").some((part) => part === ".." || part === "." || part === "")) throw canvasWsError(E.PARAM_INVALID, `${JSON.stringify(value)} has an empty, "." or ".." part`);
    const at = clean.indexOf("/");
    return at < 0 ? { folder: clean, path: "" } : { folder: clean.slice(0, at), path: clean.slice(at + 1) };
}

/** The name a canvas app uses for a folder: "work" for the working folder. */
export function canvasFolderName(folder: { id: string; name: string }): string {
    return folder.id === "working" ? CANVAS_WORKING_FOLDER_NAME : folder.id.startsWith("extra:") ? folder.id.slice("extra:".length) : folder.name;
}

// ─── Commands ─────────────────────────────────────────────────────────

/**
 * The page's values for a command, checked against its parameters. Path
 * values stay "<folder>/<path>" here; the caller checks and converts them.
 */
export function checkCanvasCommandParams(command: CanvasCommand, values: unknown): Record<string, { type: CanvasCommandParam["type"]; value: string | null }> {
    if (values !== undefined && values !== null && (typeof values !== "object" || Array.isArray(values))) {
        throw canvasWsError(E.PARAM_INVALID, "params must be an object of parameter values");
    }
    const given = (values ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(given)) {
        if (!command.params?.[key]) throw canvasWsError(E.PARAM_INVALID, `the command has no parameter "${key}"`);
    }
    const out: Record<string, { type: CanvasCommandParam["type"]; value: string | null }> = {};
    for (const [name, param] of Object.entries(command.params ?? {})) {
        let value = given[name];
        if ((value === undefined || value === null) && "default" in param && param.default !== undefined) value = param.default;
        switch (param.type) {
            case "path":
                if (value === undefined || value === null || value === "") {
                    if (!param.optional) throw canvasWsError(E.PARAM_INVALID, `"${name}" is required`);
                    out[name] = { type: "path", value: null };
                } else if (typeof value !== "string") {
                    throw canvasWsError(E.PARAM_INVALID, `"${name}" must be a "<folder>/<path>" path`);
                } else {
                    out[name] = { type: "path", value };
                }
                break;
            case "int": {
                const n = typeof value === "string" && /^-?\d{1,15}$/.test(value) ? Number(value) : value;
                if (typeof n !== "number" || !Number.isSafeInteger(n)) throw canvasWsError(E.PARAM_INVALID, `"${name}" must be a whole number`);
                if (n < param.min || (param.max !== undefined && n > param.max)) {
                    throw canvasWsError(E.PARAM_INVALID, `"${name}" must be ${param.min}${param.max !== undefined ? `..${param.max}` : " or more"}`);
                }
                out[name] = { type: "int", value: String(n) };
                break;
            }
            case "enum":
                if (typeof value !== "string" || !param.values.includes(value)) throw canvasWsError(E.PARAM_INVALID, `"${name}" must be one of: ${param.values.join(", ")}`);
                out[name] = { type: "enum", value };
                break;
            case "ref":
                if (typeof value !== "string" || !REF_RE.test(value)) throw canvasWsError(E.PARAM_INVALID, `"${name}" must be a branch, tag or commit name`);
                out[name] = { type: "ref", value };
                break;
            case "sha":
                if (typeof value !== "string" || !SHA_RE.test(value)) throw canvasWsError(E.PARAM_INVALID, `"${name}" must be a commit id (4–64 hex digits)`);
                out[name] = { type: "sha", value };
                break;
            case "text":
                if (typeof value !== "string" || value.length > param.maxLength || value.startsWith("-") || /[\u0000-\u001f\u007f]/.test(value)) {
                    throw canvasWsError(E.PARAM_INVALID, `"${name}" must be one line of text, up to ${param.maxLength} characters, not starting with "-"`);
                }
                out[name] = { type: "text", value };
                break;
        }
    }
    return out;
}

/** The program and its arguments, with each parameter as one whole argument. A missing optional path leaves its argument out. */
export function canvasCommandArgv(command: CanvasCommand, values: Record<string, string | null>): { program: string; args: string[] } {
    const args: string[] = [];
    for (const part of command.run.slice(1)) {
        const placeholder = PLACEHOLDER_RE.exec(part);
        if (!placeholder) {
            args.push(part);
            continue;
        }
        const value = values[placeholder[1]];
        if (value !== null && value !== undefined) args.push(value);
    }
    return { program: command.run[0], args };
}

/** Where commands run, and which programs may run. */
export interface CanvasCommandsConfig {
    /** "local": a child process of this process (development only). */
    runner: "local";
    /** Programs a command may run, by name. Default: git only. */
    allow: string[];
}

/** PORTAL_CANVAS_COMMANDS_RUNNER=local turns commands on; PORTAL_CANVAS_COMMANDS_ALLOW lists the programs (default git). */
export function canvasCommandsConfigFromEnv(env: Record<string, string | undefined> = process.env): CanvasCommandsConfig | null {
    const runner = String(env.PORTAL_CANVAS_COMMANDS_RUNNER ?? "").trim().toLowerCase();
    if (runner !== "local") return null;
    const allow = String(env.PORTAL_CANVAS_COMMANDS_ALLOW ?? "git").split(",").map((p) => p.trim()).filter((p) => PROGRAM_RE.test(p));
    return { runner: "local", allow };
}

/**
 * Git reads settings from the repository, and some of them start programs
 * (fsmonitor, hooks, ssh, pagers, editors, credential helpers). Every git
 * run turns those off, and cannot reach the network.
 */
const GIT_OVERRIDES: Array<[string, string]> = [
    ["core.fsmonitor", "false"],
    ["core.hooksPath", "/dev/null"],
    ["core.pager", "cat"],
    ["core.editor", "true"],
    ["sequence.editor", "true"],
    ["core.sshCommand", "false"],
    ["core.askPass", ""],
    ["credential.helper", ""],
    // No transport at all. A more specific protocol.<name>.allow in the
    // repository would beat the general one, so each is set here too.
    ["protocol.allow", "never"],
    ["protocol.ext.allow", "never"],
    ["protocol.file.allow", "never"],
    ["protocol.ssh.allow", "never"],
    ["protocol.git.allow", "never"],
    ["protocol.http.allow", "never"],
    ["protocol.https.allow", "never"],
    ["gpg.program", "false"],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
];

/**
 * Repository settings that start a program and that no override can turn
 * off (an empty diff.external breaks git diff instead). A repository that
 * sets one gets no canvas git commands. So does one whose files live
 * somewhere else (core.worktree).
 */
const GIT_PROGRAM_SETTINGS = [
    /^diff\.external$/,
    /^diff\..+\.(textconv|command)$/,
    /^filter\..+\.(clean|smudge|process)$/,
    /^merge\..+\.driver$/,
    /^(diff|merge)tool\..+\.cmd$/,
    /^core\.(gitproxy|alternaterefscommand|worktree)$/,
    /^gpg\..*program$/,
    /^uploadpack\.packobjectshook$/,
    /^remote\..+\.(uploadpack|receivepack|vcs|proxy)$/,
    /^protocol\./,
    /^submodule\..+\.update$/,
    // A trailer command runs on `git commit --trailer`; pager.<cmd> beats the
    // core.pager override for that command.
    /^trailer\..+\.(command|cmd)$/,
    /^pager\./,
];

/** Runs git with the canvas environment; its output, or null when it fails, times out or cannot start. */
function gitOutput(args: string[], cwd: string, env: Record<string, string>): Promise<string | null> {
    return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"], shell: false });
        } catch {
            resolve(null);
            return;
        }
        const chunks: Buffer[] = [];
        let done = false;
        const finish = (value: string | null) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, 5_000);
        child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", () => finish(null));
        child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks).toString("utf8") : null));
    });
}

/**
 * Why git must not run here; null when it may. Fails closed: settings git
 * cannot list, a repository whose own settings start a program or name an
 * ext:: transport, or a repository (a .git file) that lives outside the
 * session folder.
 */
async function gitSettingsRefusal(cwd: string, top: string, env: Record<string, string>): Promise<string | null> {
    const listed = await gitOutput(["config", "--list", "--show-scope", "--includes", "-z"], cwd, env);
    if (listed === null) return "git could not list this folder's settings; canvas commands do not run git here";
    const parts = listed.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const scope = parts[i];
        if (scope === "command") continue;
        const entry = parts[i + 1];
        const at = entry.indexOf("\n");
        const key = (at < 0 ? entry : entry.slice(0, at)).toLowerCase();
        const value = at < 0 ? "" : entry.slice(at + 1);
        if (GIT_PROGRAM_SETTINGS.some((re) => re.test(key))
            || (key.startsWith("alias.") && value.trimStart().startsWith("!"))
            || entry.toLowerCase().includes("ext::")) {
            return `the repository's git settings set ${key}, which can start a program; canvas commands do not run git here`;
        }
    }
    // Where the repository really is: its git folder and its files must both
    // be inside the session folder (a .git FILE can point anywhere).
    const where = await gitOutput(["rev-parse", "--absolute-git-dir", "--show-toplevel"], cwd, env);
    if (where === null) return null; // not a repository: the command itself says so
    const realTop = fs.realpathSync(top);
    const within = (p: string) => {
        let real: string;
        try { real = fs.realpathSync(p); } catch { return false; }
        const rel = path.relative(realTop, real);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    const [gitDir, workTree] = where.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!gitDir || !within(gitDir) || (workTree && !within(workTree))) {
        return "the repository lives outside the session folder; canvas commands do not run git here";
    }
    return null;
}

export interface CanvasCommandResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    /** Standard output was cut at maxOutputBytes. */
    truncated: boolean;
    durationMs: number;
}

const MAX_CONCURRENT_COMMANDS = 4;
let runningCommands = 0;

/** Runs a command in `cwd` as a child of this process (the local runner). */
export async function runCanvasCommandLocally(
    argv: { program: string; args: string[] },
    cwd: string,
    options: {
        timeoutSeconds?: number;
        maxOutputBytes?: number;
        author?: { name: string; email: string } | null;
        /** Git looks for a repository up to here, never above: the session folder. Default: `cwd`. */
        top?: string;
    } = {},
): Promise<CanvasCommandResult> {
    const timeoutSeconds = options.timeoutSeconds ?? 20;
    const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    if (runningCommands >= MAX_CONCURRENT_COMMANDS) throw canvasWsError(E.BUSY, "too many canvas commands are running; try again");
    let home: string;
    try {
        home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-canvas-cmd-"));
    } catch (error: any) {
        throw canvasWsError(E.RUN_FAILED, `could not make a home folder for the command: ${error?.message ?? error}`);
    }
    // Counted only from here: every path below ends in the finally.
    runningCommands += 1;
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TERM: "dumb",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
    };
    if (argv.program === "git") {
        // A repository inside the session folder, never one above it.
        env.GIT_CEILING_DIRECTORIES = path.dirname(options.top ?? cwd);
        env.GIT_CONFIG_COUNT = String(GIT_OVERRIDES.length);
        GIT_OVERRIDES.forEach(([key, value], index) => {
            env[`GIT_CONFIG_KEY_${index}`] = key;
            env[`GIT_CONFIG_VALUE_${index}`] = value;
        });
        // A commit from a canvas is the session owner's commit.
        if (options.author) {
            env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = options.author.name;
            env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = options.author.email;
        }
    }
    const started = Date.now();
    try {
        if (argv.program === "git") {
            const refusal = await gitSettingsRefusal(cwd, options.top ?? cwd, env);
            if (refusal) throw canvasWsError(E.DENIED, refusal);
        }
        return await new Promise<CanvasCommandResult>((resolve, reject) => {
            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(argv.program, argv.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
            } catch (error: any) {
                reject(canvasWsError(E.RUN_FAILED, `could not start ${argv.program}: ${error?.message ?? error}`));
                return;
            }
            const out: Buffer[] = [];
            const err: Buffer[] = [];
            let outSize = 0;
            let errSize = 0;
            let truncated = false;
            let done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                child.kill("SIGKILL");
                reject(canvasWsError(E.TIMEOUT, `${argv.program} did not finish within ${timeoutSeconds} s`));
            }, timeoutSeconds * 1000);
            child.stdout?.on("data", (chunk: Buffer) => {
                const room = maxOutputBytes - outSize;
                if (room <= 0) { truncated = true; return; }
                out.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
                outSize += Math.min(chunk.length, room);
                if (chunk.length > room) truncated = true;
            });
            child.stderr?.on("data", (chunk: Buffer) => {
                if (errSize >= 64 * 1024) return;
                err.push(chunk);
                errSize += chunk.length;
            });
            child.on("error", (error: any) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                reject(canvasWsError(E.RUN_FAILED, error?.code === "ENOENT" ? `${argv.program} is not installed here` : `${argv.program} did not start: ${error?.message ?? error}`));
            });
            child.on("close", (code) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({
                    exitCode: code,
                    stdout: Buffer.concat(out).toString("utf8"),
                    stderr: Buffer.concat(err).toString("utf8").slice(0, 64 * 1024),
                    truncated,
                    durationMs: Date.now() - started,
                });
            });
        });
    } finally {
        runningCommands -= 1;
        fs.rmSync(home, { recursive: true, force: true });
    }
}
