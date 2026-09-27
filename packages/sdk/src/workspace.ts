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
    type WorkspaceAdopt,
    type WorkspaceAttachRequest,
    type WorkspaceAttachResult,
    type WorkspaceExtraAttach,
    type WorkspaceProvider,
    type WorkspaceReleaseReason,
    type WorkspaceReleaseRequest,
    type WorkspaceRoot,
} from "./types.js";
import {
    checkWorkspacePath,
    extraFolderRecord,
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
    return { agents: raw.agents === true, skills: raw.skills === true, instructions: raw.instructions === true };
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
    opts: { attachTimeoutMs?: number; checkTimeoutMs?: number; onAttach?: (req: WorkspaceAttachRequest) => void } = {},
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

    // Nothing is adopted from an extra folder (section 4.10).
    const adopt = isExtra ? undefined : normalizeAdopt(attached.adopt);
    const collect = adopt && (adopt.agents || adopt.skills || adopt.instructions)
        ? { agents: adopt.agents, skills: adopt.skills, instructions: adopt.instructions }
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
    };
}

export type WorkspaceExtraPreparation =
    | { name: string; required: boolean; ok: true; attach: WorkspaceExtraAttach }
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
    opts: { attachTimeoutMs?: number; checkTimeoutMs?: number; onAttach?: (req: WorkspaceAttachRequest) => void; names?: string[] } = {},
): Promise<WorkspaceExtraPreparation[]> {
    const extras = req.workspace.extra ?? {};
    const names = (opts.names ?? Object.keys(extras)).filter((name) => extras[name]).sort();
    return Promise.all(names.map(async (name): Promise<WorkspaceExtraPreparation> => {
        const extra = extras[name];
        const required = extra.required !== false;
        const prepared = await prepareWorkspace(provider, { ...req, workspace: extraFolderRecord(extra), attachment: name }, opts);
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
    };
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
    let result: WorkspacePreparation = await prepareWorkspace(provider, req, { ...opts, onAttach });
    if (result.ok && req.workspace?.extra && Object.keys(req.workspace.extra).length > 0) {
        const extras = await prepareWorkspaceExtras(provider, req, { ...opts, onAttach });
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
