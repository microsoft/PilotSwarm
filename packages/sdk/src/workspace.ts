/**
 * Session workspace attach (docs/proposals/session-workspaces.md, sections
 * 4.1, 4.2 and 4.4).
 *
 * Before each turn of a workspace session, on the worker that runs it:
 *   1. List the roots again (never cached across turns).
 *   2. Ask the provider to make the folder ready here (`ensureAttached`).
 *   3. Check the attach path out of process (workspace-check.ts).
 * Steps 1 and 2 share one deadline. PilotSwarm cannot stop a provider that
 * blocks its event loop; it can only stop waiting for one that is slow.
 */
import path from "node:path";
import {
    WORKSPACE_ERROR_CODES,
    type SessionWorkspace,
    type SessionWorkspaceExtra,
    type WorkspaceAdopt,
    type WorkspaceAttachRequest,
    type WorkspaceAttachResult,
    type WorkspaceDefaults,
    type WorkspaceDefaultsContext,
    type WorkspaceExtraAttach,
    type WorkspaceProvider,
    type WorkspaceReleaseReason,
    type WorkspaceReleaseRequest,
    type WorkspaceRoot,
} from "./types.js";
import {
    checkDefaultFolder,
    checkWorkspacePath,
    extraFolderRecord,
    foldersOverlap,
    validateWorkspaceText,
    workingFolderOf,
    DEFAULT_PATH_CHECK_TIMEOUT_MS,
    type RepoScan,
} from "./workspace-check.js";
import { WORKSPACE_ORCHESTRATION_MIN_VERSION } from "./orchestration-version.js";

export const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;

/**
 * The partial-changes note: what a workspace turn is told when an earlier
 * attempt of it ran, failed or was lost with its worker (section 4.7).
 */
export const WORKSPACE_PARTIAL_CHANGES_NOTE = "An earlier attempt may have changed files. Check `git status` first.";

/**
 * Whether the orchestration that scheduled a turn applies workspace
 * changes (1.0.80 and later). An older one drops the result of
 * set_session_workspace, so its turns do not get the workspace tools. The
 * version comes from the activity context; without one, the answer is yes.
 */
export function orchestrationSupportsWorkspaces(version: unknown): boolean {
    const parts = (text: unknown) => {
        const match = typeof text === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim()) : null;
        return match ? match.slice(1).map(Number) : null;
    };
    const have = parts(version);
    const need = parts(WORKSPACE_ORCHESTRATION_MIN_VERSION)!;
    if (!have) return true;
    for (let i = 0; i < 3; i += 1) {
        if (have[i] !== need[i]) return have[i] > need[i];
    }
    return true;
}

/**
 * The provider for a deployment without application code: fixed roots,
 * `path` = root path + folder, and nothing adopted.
 */
export function createBuiltInWorkspaceProvider(roots: WorkspaceRoot[]): WorkspaceProvider {
    const seen = new Set<string>();
    const list = roots.map((root) => {
        if (!root || typeof root.name !== "string" || !root.name) throw new Error("workspaceRoots: every root needs a name");
        if (typeof root.path !== "string" || !path.isAbsolute(root.path)) {
            throw new Error(`workspaceRoots: root "${root.name}" needs an absolute path`);
        }
        if (seen.has(root.name)) throw new Error(`workspaceRoots: root "${root.name}" is listed twice`);
        seen.add(root.name);
        return { name: root.name, path: root.path };
    });
    return {
        async listRoots() {
            return list.map((root) => ({ ...root }));
        },
        async ensureAttached(req) {
            const root = list.find((candidate) => candidate.name === req.workspace.root);
            if (!root) {
                return { ok: false, code: WORKSPACE_ERROR_CODES.ROOT_UNKNOWN, message: `workspace root "${req.workspace.root}" is not configured on this worker` };
            }
            return { ok: true, path: req.workspace.folder ? path.join(root.path, req.workspace.folder) : root.path };
        },
    };
}

export type WorkspacePreparation =
    | {
        ok: true;
        root: WorkspaceRoot;
        /** The provider's path: what the CLI gets as its working directory. */
        path: string;
        /** The same folder with every symlink resolved. */
        realPath: string;
        /** What to adopt from the checkout. Undefined means nothing. */
        adopt?: WorkspaceAdopt;
        /** The repo agents and skills read for adoption; only when adopt asks for them. */
        repo?: RepoScan;
        /** The provider says the folder is mounted read-only. */
        readOnly?: boolean;
        /** The provider's note for the model (WorkspaceAttachResult.notice), trimmed. */
        notice?: string;
    }
    | { ok: false; code: string; message: string; retryAfterMs?: number };

type Failure = Extract<WorkspacePreparation, { ok: false }>;

function failure(code: string, message: string, retryAfterMs?: number): Failure {
    return retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? { ok: false, code, message, retryAfterMs: Math.floor(retryAfterMs) }
        : { ok: false, code, message };
}

function normalizeAdopt(adopt: unknown): WorkspaceAdopt | undefined {
    if (!adopt || typeof adopt !== "object") return undefined;
    const raw = adopt as Record<string, unknown>;
    return {
        agents: raw.agents === true, skills: raw.skills === true, instructions: raw.instructions === true,
        ...(raw.folder === true ? { folder: true } : {}),
    };
}

/** Resolves to the value, or to `onTimeout()` when the deadline passes first. */
function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** The roots a provider serves, or an error if it cannot say. */
export async function listWorkspaceRoots(
    provider: WorkspaceProvider | null | undefined,
    timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
): Promise<{ ok: true; roots: WorkspaceRoot[] } | Failure> {
    if (!provider) return { ok: true, roots: [] };
    const timedOut = Symbol("timeout");
    try {
        const roots = await withDeadline<WorkspaceRoot[] | typeof timedOut>(
            Promise.resolve().then(() => provider.listRoots()),
            timeoutMs,
            () => timedOut,
        );
        if (roots === timedOut) return failure(WORKSPACE_ERROR_CODES.ATTACH_TIMEOUT, `listRoots gave no answer within ${timeoutMs} ms`);
        if (!Array.isArray(roots)) return failure(WORKSPACE_ERROR_CODES.ATTACH_FAILED, "listRoots did not return a list");
        return {
            ok: true,
            roots: roots
                .filter((root) => root && typeof root.name === "string" && typeof root.path === "string")
                .map((root) => ({ name: root.name, path: root.path })),
        };
    } catch (error: any) {
        return failure(WORKSPACE_ERROR_CODES.ATTACH_FAILED, `listRoots failed: ${error?.message ?? error}`);
    }
}

/** Check a record against the provider's current roots (the worker-side root rule). */
export async function checkWorkspaceRoot(
    provider: WorkspaceProvider | null | undefined,
    workspace: SessionWorkspace,
    timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
): Promise<{ ok: true; root: WorkspaceRoot } | Failure> {
    const listed = await listWorkspaceRoots(provider, timeoutMs);
    if (!listed.ok) return listed;
    const root = listed.roots.find((candidate) => candidate.name === workspace.root);
    if (!root) {
        return failure(WORKSPACE_ERROR_CODES.ROOT_UNKNOWN, provider
            ? `workspace root "${workspace.root}" is not served by this worker's provider`
            : "this worker has no workspace provider or workspace roots");
    }
    return { ok: true, root };
}

/**
 * Make a session's workspace ready on this worker: roots, attach, path check.
 * Never throws. A failure carries the code the session is held with.
 */
export async function prepareWorkspace(
    provider: WorkspaceProvider | null | undefined,
    req: WorkspaceAttachRequest,
    opts: {
        attachTimeoutMs?: number; checkTimeoutMs?: number; onAttach?: (req: WorkspaceAttachRequest) => void;
        /** An extra folder that may adopt: the deployment's default home folder (section 4.11). */
        adoptExtra?: boolean;
    } = {},
): Promise<WorkspacePreparation> {
    const attachTimeoutMs = opts.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
    const text = validateWorkspaceText(req.workspace);
    if (!text.ok) return failure(text.code, text.message);
    // The provider attaches one folder per call: the working folder here,
    // or one extra folder (req.attachment names it). Never the whole record.
    const workspace = workingFolderOf(text.workspace);
    const isExtra = typeof req.attachment === "string" && req.attachment.length > 0;
    const startedAt = Date.now();
    const rootCheck = await checkWorkspaceRoot(provider, workspace, attachTimeoutMs);
    if (!rootCheck.ok) return rootCheck;
    const remainingMs = Math.max(1, attachTimeoutMs - (Date.now() - startedAt));

    const timedOut: unique symbol = Symbol("timeout");
    let attached: WorkspaceAttachResult | typeof timedOut;
    const attachRequest = { ...req, workspace };
    opts.onAttach?.(attachRequest);
    try {
        attached = await withDeadline<WorkspaceAttachResult | typeof timedOut>(
            Promise.resolve().then(() => provider!.ensureAttached(attachRequest)),
            remainingMs,
            () => timedOut,
        );
    } catch (error: any) {
        return failure(WORKSPACE_ERROR_CODES.ATTACH_FAILED, `ensureAttached failed: ${error?.message ?? error}`);
    }
    if (attached === timedOut) {
        return failure(WORKSPACE_ERROR_CODES.ATTACH_TIMEOUT, `ensureAttached gave no answer within ${attachTimeoutMs} ms`);
    }
    if (!attached || typeof attached !== "object") {
        return failure(WORKSPACE_ERROR_CODES.ATTACH_FAILED, "ensureAttached returned no result");
    }
    if (attached.ok !== true) {
        const code = typeof (attached as any).code === "string" && (attached as any).code
            ? (attached as any).code : WORKSPACE_ERROR_CODES.ATTACH_FAILED;
        return failure(code, String((attached as any).message ?? code), (attached as any).retryAfterMs);
    }
    if (typeof attached.path !== "string" || !path.isAbsolute(attached.path)) {
        return failure(WORKSPACE_ERROR_CODES.ATTACH_FAILED, "ensureAttached returned ok without an absolute path");
    }

    // Nothing is adopted from an extra folder (section 4.10), except the
    // deployment's default home folder (4.11). The CLI reads instruction
    // files only from its working folder, so an extra folder's are read here.
    const adopt = isExtra && !opts.adoptExtra ? undefined : normalizeAdopt(attached.adopt);
    const collect = adopt && (adopt.agents || adopt.skills || adopt.instructions)
        ? {
            agents: adopt.agents, skills: adopt.skills, instructions: adopt.instructions,
            ...(adopt.folder ? { folder: true } : {}),
            ...(isExtra && adopt.instructions ? { instructionText: true } : {}),
        }
        : undefined;
    const checked = await checkWorkspacePath({
        rootName: rootCheck.root.name,
        rootPath: rootCheck.root.path,
        path: attached.path,
        timeoutMs: opts.checkTimeoutMs ?? DEFAULT_PATH_CHECK_TIMEOUT_MS,
        ...(collect ? { collect } : {}),
    });
    if (!checked.ok) return failure(checked.code, checked.message);
    return {
        ok: true,
        root: rootCheck.root,
        path: path.normalize(attached.path),
        realPath: checked.realPath,
        ...(adopt ? { adopt } : {}),
        ...(checked.repo ? { repo: checked.repo } : {}),
        ...(attached.readOnly === true ? { readOnly: true } : {}),
        ...(providerNotice(attached.notice) ? { notice: providerNotice(attached.notice) } : {}),
    };
}

/** The longest provider notice a turn carries; the rest is cut. */
export const MAX_WORKSPACE_NOTICE_CHARS = 4_000;

/** A provider's notice as the model gets it: a trimmed string, or nothing. */
function providerNotice(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (!text) return undefined;
    return text.length > MAX_WORKSPACE_NOTICE_CHARS ? `${text.slice(0, MAX_WORKSPACE_NOTICE_CHARS)}…` : text;
}

export type WorkspaceExtraPreparation =
    | {
        name: string; required: boolean; ok: true; attach: WorkspaceExtraAttach; notice?: string;
        /** Only for the folder named by opts.adoptFrom: what it adopts, and what the check read. */
        adopt?: WorkspaceAdopt; repo?: RepoScan;
    }
    | { name: string; required: boolean; root: string; folder?: string; ok: false; code: string; message: string; retryAfterMs?: number };

/**
 * Make the extra folders of a record ready on this worker (section 4.10):
 * one prepareWorkspace per folder, in parallel, each with its own deadline
 * and `attachment` set to its name. Nothing is adopted from them. `names`
 * limits the work to those folders; by default every extra folder.
 */
export async function prepareWorkspaceExtras(
    provider: WorkspaceProvider | null | undefined,
    req: WorkspaceAttachRequest,
    opts: {
        attachTimeoutMs?: number; checkTimeoutMs?: number; onAttach?: (req: WorkspaceAttachRequest) => void; names?: string[];
        /** The one extra folder that may adopt: the deployment's default home folder (section 4.11). */
        adoptFrom?: string;
    } = {},
): Promise<WorkspaceExtraPreparation[]> {
    const extras = req.workspace.extra ?? {};
    const names = (opts.names ?? Object.keys(extras)).filter((name) => extras[name]).sort();
    return Promise.all(names.map(async (name): Promise<WorkspaceExtraPreparation> => {
        const extra = extras[name];
        const required = extra.required !== false;
        const { adoptFrom: _adoptFrom, names: _names, ...attachOpts } = opts;
        const prepared = await prepareWorkspace(provider, { ...req, workspace: extraFolderRecord(extra), attachment: name },
            { ...attachOpts, ...(opts.adoptFrom === name ? { adoptExtra: true } : {}) });
        if (!prepared.ok) {
            return {
                name, required, root: extra.root, ...(extra.folder ? { folder: extra.folder } : {}),
                ok: false, code: prepared.code, message: prepared.message,
                ...(prepared.retryAfterMs !== undefined ? { retryAfterMs: prepared.retryAfterMs } : {}),
            };
        }
        return {
            name, required, ok: true,
            attach: {
                name,
                root: prepared.root.name,
                ...(extra.folder ? { folder: extra.folder } : {}),
                rootPath: prepared.root.path,
                path: prepared.path,
                realPath: prepared.realPath,
                required,
                ...(prepared.readOnly ? { readOnly: true } : {}),
            },
            ...(prepared.notice ? { notice: prepared.notice } : {}),
            ...(opts.adoptFrom === name && prepared.adopt ? { adopt: prepared.adopt } : {}),
            ...(opts.adoptFrom === name && prepared.repo ? { repo: prepared.repo } : {}),
        };
    }));
}

/**
 * Serve several kinds of roots from one worker, which has one provider:
 * each call goes to the provider that lists the request's root. Root names
 * must be unique across the providers; a name two of them list fails the
 * attach. Example: repo clones from the repo provider, plus a log share
 * from the built-in provider.
 */
export function combineWorkspaceProviders(providers: WorkspaceProvider[]): WorkspaceProvider {
    const list = providers.filter(Boolean);
    const route = async (rootName: string): Promise<WorkspaceProvider | null> => {
        for (const provider of list) {
            const roots = await provider.listRoots();
            if (Array.isArray(roots) && roots.some((root) => root?.name === rootName)) return provider;
        }
        return null;
    };
    return {
        async listRoots() {
            const all: WorkspaceRoot[] = [];
            const seen = new Set<string>();
            for (const provider of list) {
                const roots = await provider.listRoots();
                for (const root of Array.isArray(roots) ? roots : []) {
                    if (seen.has(root.name)) throw new Error(`workspace root "${root.name}" is listed by two providers`);
                    seen.add(root.name);
                    all.push({ name: root.name, path: root.path });
                }
            }
            return all;
        },
        async ensureAttached(req) {
            const provider = await route(req.workspace.root);
            if (!provider) {
                return { ok: false, code: WORKSPACE_ERROR_CODES.ROOT_UNKNOWN, message: `workspace root "${req.workspace.root}" is not served by any provider on this worker` };
            }
            return provider.ensureAttached(req);
        },
        async release(req: WorkspaceReleaseRequest) {
            const provider = await route(req.workspace.root);
            await provider?.release?.(req);
        },
        // The first provider's home wins; extra folders merge by name, the
        // first provider's winning.
        ...(list.some((provider) => provider.defaultFolders) ? {
            async defaultFolders(ctx: WorkspaceDefaultsContext) {
                let home: WorkspaceDefaults["home"];
                const extra: NonNullable<WorkspaceDefaults["extra"]> = {};
                for (const provider of list) {
                    const defaults = provider.defaultFolders ? await provider.defaultFolders(ctx) : null;
                    if (!defaults) continue;
                    if (!home && defaults.home) home = defaults.home;
                    for (const [name, value] of Object.entries(defaults.extra ?? {})) {
                        if (!Object.prototype.hasOwnProperty.call(extra, name)) extra[name] = value;
                    }
                }
                if (!home && Object.keys(extra).length === 0) return null;
                return { ...(home ? { home } : {}), ...(Object.keys(extra).length > 0 ? { extra } : {}) };
            },
        } : {}),
    };
}

/** How long PilotSwarm waits for a provider's defaultFolders. */
export const DEFAULT_FOLDERS_TIMEOUT_MS = 5_000;

/**
 * The provider's default folders for one session (section 4.11), within a
 * deadline. A provider without the hook, one that throws, or one that is too
 * slow gives no defaults: the session runs as it would without them.
 */
export async function resolveWorkspaceDefaults(
    provider: WorkspaceProvider | null | undefined,
    ctx: WorkspaceDefaultsContext,
    opts: { timeoutMs?: number; onError?: (message: string) => void } = {},
): Promise<WorkspaceDefaults | null> {
    if (!provider?.defaultFolders) return null;
    const timedOut: unique symbol = Symbol("timeout");
    try {
        const result = await withDeadline<WorkspaceDefaults | null | typeof timedOut>(
            Promise.resolve().then(() => provider.defaultFolders!(ctx)),
            opts.timeoutMs ?? DEFAULT_FOLDERS_TIMEOUT_MS,
            () => timedOut,
        );
        if (result === timedOut) {
            opts.onError?.(`defaultFolders gave no answer within ${opts.timeoutMs ?? DEFAULT_FOLDERS_TIMEOUT_MS} ms`);
            return null;
        }
        return result && typeof result === "object" ? result : null;
    } catch (error: any) {
        opts.onError?.(`defaultFolders failed: ${error?.message ?? error}`);
        return null;
    }
}

/** A session's record with the deployment's default folders applied (section 4.11). */
export interface WorkspaceWithDefaults {
    /** What this turn attaches. Null: no working folder at all (the worker's own folder is used). */
    workspace: SessionWorkspace | null;
    /** The extra folders that came from the defaults, not from the record. */
    defaultNames: string[];
    /** The default home folder's name when it was added as an extra folder. */
    homeExtra?: string;
    /** The working folder is the default home folder: the record had none, or named the same folder. */
    homeIsWorkingFolder: boolean;
    /** Defaults left out, and why. */
    skipped: Array<{ name: string; reason: string }>;
}

/**
 * Apply a provider's default folders to a session's record. Nothing here is
 * saved; the record keeps only what the session, its creator or its agent
 * set. The rules:
 *
 *   1. Working folder: the record's. With none, the default home folder.
 *      With neither, none (and the default extra folders are left out: an
 *      extra folder needs a working folder).
 *   2. The default home folder, when it is not the working folder, becomes
 *      an extra folder under its name. The same folder as the working
 *      folder: it is the working folder, not added again.
 *   3. Default extra folders are added under their names.
 *   4. A default is left out when the record uses its name, or when it
 *      overlaps a folder already in the result (the same folder, or one
 *      inside the other, in one root).
 *   5. Defaults never count against MAX_WORKSPACE_EXTRAS. They are optional
 *      unless the provider marks one required.
 */
export function applyWorkspaceDefaults(
    stored: SessionWorkspace | null | undefined,
    defaults: WorkspaceDefaults | null | undefined,
): WorkspaceWithDefaults {
    const skipped: Array<{ name: string; reason: string }> = [];
    const base: WorkspaceWithDefaults = { workspace: stored ?? null, defaultNames: [], homeIsWorkingFolder: false, skipped };
    if (!defaults) return base;
    let home: { name: string; folder: SessionWorkspaceExtra } | null = null;
    if (defaults.home) {
        const checked = checkDefaultFolder(defaults.home.name, defaults.home);
        if (checked.ok) home = checked;
        else skipped.push({ name: String(defaults.home.name ?? "home"), reason: checked.message });
    }
    const extras: Array<{ name: string; folder: SessionWorkspaceExtra }> = [];
    for (const [name, value] of Object.entries(defaults.extra ?? {})) {
        const checked = checkDefaultFolder(name, value);
        if (checked.ok) extras.push(checked);
        else skipped.push({ name, reason: checked.message });
    }

    let working: SessionWorkspace;
    let homeIsWorkingFolder = false;
    if (stored) {
        working = stored;
        if (home && home.folder.root === stored.root && (home.folder.folder ?? "") === (stored.folder ?? "")) {
            homeIsWorkingFolder = true;
        }
    } else if (home) {
        working = { schema: 1, root: home.folder.root, ...(home.folder.folder ? { folder: home.folder.folder } : {}) };
        homeIsWorkingFolder = true;
    } else {
        for (const extra of extras) skipped.push({ name: extra.name, reason: "the session has no working folder" });
        return { ...base, skipped };
    }

    const extra: Record<string, SessionWorkspaceExtra> = { ...(stored?.extra ?? {}) };
    const taken: Array<{ name: string; root: string; folder?: string }> = [
        { name: "the working folder", root: working.root, ...(working.folder ? { folder: working.folder } : {}) },
        ...Object.entries(extra).map(([name, value]) => ({ name: `extra folder "${name}"`, root: value.root, ...(value.folder ? { folder: value.folder } : {}) })),
    ];
    const defaultNames: string[] = [];
    let homeExtra: string | undefined;
    const add = (candidate: { name: string; folder: SessionWorkspaceExtra }, isHome: boolean) => {
        if (Object.prototype.hasOwnProperty.call(extra, candidate.name)) {
            skipped.push({ name: candidate.name, reason: "the session's record uses this name" });
            return;
        }
        const clash = taken.find((folder) => foldersOverlap(candidate.folder, folder));
        if (clash) {
            skipped.push({ name: candidate.name, reason: `it overlaps ${clash.name}` });
            return;
        }
        extra[candidate.name] = candidate.folder;
        taken.push({ name: `extra folder "${candidate.name}"`, root: candidate.folder.root, ...(candidate.folder.folder ? { folder: candidate.folder.folder } : {}) });
        defaultNames.push(candidate.name);
        if (isHome) homeExtra = candidate.name;
    };
    if (home && !homeIsWorkingFolder) add(home, true);
    for (const candidate of extras) add(candidate, false);
    const workspace: SessionWorkspace = {
        schema: 1,
        root: working.root,
        ...(working.folder ? { folder: working.folder } : {}),
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
    };
    return { workspace, defaultNames, ...(homeExtra ? { homeExtra } : {}), homeIsWorkingFolder, skipped };
}

/**
 * Section 4.11: the defaults a turn used, for the session.workspace_defaults
 * event. `recordHasWorkingFolder`: the session's own record names a working
 * folder, so the person's folder is not the working folder by default even
 * when it is the same folder. `skipped` lists the defaults left out, and
 * why. Null when the turn has no folders, or used no defaults and left none
 * out.
 */
export function defaultsRecordOf(
    applied: WorkspaceWithDefaults,
    recordHasWorkingFolder: boolean,
): import("./types.js").WorkspaceDefaultsRecord | null {
    const workspace = applied.workspace;
    if (!workspace) return null;
    const workingFolder = applied.homeIsWorkingFolder && !recordHasWorkingFolder
        ? { root: workspace.root, ...(workspace.folder ? { folder: workspace.folder } : {}) }
        : null;
    const extra = applied.defaultNames.flatMap((name) => {
        const folder = workspace.extra?.[name];
        return folder ? [{
            name,
            root: folder.root,
            ...(folder.folder ? { folder: folder.folder } : {}),
            ...(name === applied.homeExtra ? { home: true as const } : {}),
        }] : [];
    });
    const skipped = applied.skipped.map((skip) => ({ name: skip.name, reason: skip.reason }));
    if (!workingFolder && extra.length === 0 && skipped.length === 0) return null;
    return { workingFolder, extra, ...(skipped.length > 0 ? { skipped } : {}) };
}

/** Section 4.11: a stored session.workspace_defaults payload, checked; null when it names nothing. */
export function readDefaultsRecord(data: unknown): import("./types.js").WorkspaceDefaultsRecord | null {
    const value = data as any;
    if (!value || typeof value !== "object") return null;
    const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const working = value.workingFolder && typeof value.workingFolder === "object" && text(value.workingFolder.root)
        ? { root: value.workingFolder.root as string, ...(text(value.workingFolder.folder) ? { folder: value.workingFolder.folder as string } : {}) }
        : null;
    const extra = (Array.isArray(value.extra) ? value.extra : []).flatMap((one: any) => (one && text(one.name) && text(one.root) ? [{
        name: one.name as string,
        root: one.root as string,
        ...(text(one.folder) ? { folder: one.folder as string } : {}),
        ...(one.home === true ? { home: true as const } : {}),
    }] : []));
    const skipped = (Array.isArray(value.skipped) ? value.skipped : []).flatMap((one: any) => (one && text(one.name) && text(one.reason)
        ? [{ name: one.name as string, reason: one.reason as string }]
        : []));
    if (!working && extra.length === 0 && skipped.length === 0) return null;
    return { workingFolder: working, extra, ...(skipped.length > 0 ? { skipped } : {}) };
}

/** Section 4.11: two defaults records name the same folders and skip the same ones (key order and list order do not matter). */
export function sameDefaultsRecord(
    a: import("./types.js").WorkspaceDefaultsRecord | null,
    b: import("./types.js").WorkspaceDefaultsRecord | null,
): boolean {
    const byName = (x: unknown[], y: unknown[]) => String(x[0]).localeCompare(String(y[0])) || String(x[1]).localeCompare(String(y[1]));
    const canon = (r: import("./types.js").WorkspaceDefaultsRecord | null) => (r ? JSON.stringify([
        r.workingFolder ? [r.workingFolder.root, r.workingFolder.folder ?? ""] : null,
        r.extra.map((one) => [one.name, one.root, one.folder ?? "", one.home === true]).sort(byName),
        (r.skipped ?? []).map((one) => [one.name, one.reason]).sort(byName),
    ]) : "null");
    return canon(a) === canon(b);
}

/**
 * The folders of a session's record that a turn opened, as one comparable
 * value: the revision, the working folder's path and the extra folders'
 * paths (session.workspace_opened; the order of extra folders does not
 * matter). A stored event gives the same value as the turn that wrote it.
 */
export function workspaceOpenedKey(revision: unknown, path: unknown, extraPaths: unknown): string {
    const extras = extraPaths && typeof extraPaths === "object"
        ? Object.entries(extraPaths as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string")
            .sort(([x], [y]) => x.localeCompare(y))
        : [];
    return JSON.stringify([Number(revision) || 0, typeof path === "string" ? path : null, extras]);
}

/**
 * The release reason a provider sees, from the trigger PilotSwarm records in
 * session.workspace_released. The triggers are internal; the reasons are the
 * documented WorkspaceReleaseReason values. Every affinity release (the hold
 * window, a long wait or cron, an error retry, a lossy handoff, repeated
 * attach failures) is "moved": the session stays open.
 */
export function workspaceReleaseReason(trigger: string): WorkspaceReleaseReason {
    switch (trigger) {
        case "destroy": return "ended";
        case "workspace_changed": return "changed";
        case "eviction": return "evicted";
        case "worker_shutdown": return "shutdown";
        case "spawn_check": return "spawn_check";
        case "set_check": return "set_check";
        default: return "moved";
    }
}

export const DEFAULT_SPAWN_RELEASE_TIMEOUT_MS = 10_000;

/**
 * The quick check spawn_agent runs on the parent's worker before it creates a
 * child with a workspace record: roots, attach and path check, for the child,
 * of the working folder and every extra folder. Each attach is then
 * released, so the provider keeps no lease entry for a worker the child may
 * never run on. The child's first turn attaches for real.
 */
export async function checkWorkspaceForSpawn(
    provider: WorkspaceProvider | null | undefined,
    req: WorkspaceAttachRequest,
    opts: { attachTimeoutMs?: number; checkTimeoutMs?: number; releaseTimeoutMs?: number } = {},
): Promise<WorkspacePreparation> {
    const sent: WorkspaceAttachRequest[] = [];
    const onAttach = (request: WorkspaceAttachRequest) => { sent.push(request); };
    const checkReq: WorkspaceAttachRequest = { ...req, purpose: "check" };
    let result: WorkspacePreparation = await prepareWorkspace(provider, checkReq, { ...opts, onAttach });
    if (result.ok && req.workspace?.extra && Object.keys(req.workspace.extra).length > 0) {
        const extras = await prepareWorkspaceExtras(provider, checkReq, { ...opts, onAttach });
        const bad = extras.find((extra) => !extra.ok);
        if (bad && !bad.ok) result = failure(bad.code, `extra folder "${bad.name}": ${bad.message}`, bad.retryAfterMs);
    }
    if (sent.length > 0 && provider?.release) {
        await Promise.all(sent.map((request) => withDeadline<void>(
            Promise.resolve().then(() => provider.release!({ ...request, reason: "spawn_check" })).then(() => undefined, () => undefined),
            opts.releaseTimeoutMs ?? DEFAULT_SPAWN_RELEASE_TIMEOUT_MS,
            () => undefined,
        )));
    }
    return result;
}
