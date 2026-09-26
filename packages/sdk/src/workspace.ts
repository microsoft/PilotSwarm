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
    type WorkspaceProvider,
    type WorkspaceRoot,
} from "./types.js";
import { checkWorkspacePath, validateWorkspaceText, DEFAULT_PATH_CHECK_TIMEOUT_MS } from "./workspace-check.js";

export const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;

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
    opts: { attachTimeoutMs?: number; checkTimeoutMs?: number } = {},
): Promise<WorkspacePreparation> {
    const attachTimeoutMs = opts.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
    const text = validateWorkspaceText(req.workspace);
    if (!text.ok) return failure(text.code, text.message);
    const workspace = text.workspace;
    const startedAt = Date.now();
    const rootCheck = await checkWorkspaceRoot(provider, workspace, attachTimeoutMs);
    if (!rootCheck.ok) return rootCheck;
    const remainingMs = Math.max(1, attachTimeoutMs - (Date.now() - startedAt));

    const timedOut: unique symbol = Symbol("timeout");
    let attached: WorkspaceAttachResult | typeof timedOut;
    try {
        attached = await withDeadline<WorkspaceAttachResult | typeof timedOut>(
            Promise.resolve().then(() => provider!.ensureAttached({ ...req, workspace })),
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

    const checked = await checkWorkspacePath({
        rootName: rootCheck.root.name,
        rootPath: rootCheck.root.path,
        path: attached.path,
        timeoutMs: opts.checkTimeoutMs ?? DEFAULT_PATH_CHECK_TIMEOUT_MS,
    });
    if (!checked.ok) return failure(checked.code, checked.message);
    const adopt = normalizeAdopt(attached.adopt);
    return {
        ok: true,
        root: rootCheck.root,
        path: path.normalize(attached.path),
        realPath: checked.realPath,
        ...(adopt ? { adopt } : {}),
    };
}
