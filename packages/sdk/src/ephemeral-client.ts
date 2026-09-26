import { fork, type ChildProcess } from "node:child_process";
import type { CopilotClient, CopilotClientOptions, CopilotSession, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { EphemeralSessionError } from "./ephemeral-errors.js";
import { ephemeralEnvironment, type EphemeralScratch } from "./ephemeral-scratch.js";

export type EphemeralSession = Pick<CopilotSession, "sessionId" | "send" | "abort"> & {
    /**
     * @internal Closes or reopens the helper's native rate-limit recovery. Not
     * a public surface: the host owns the windows in which a retry is unsafe.
     */
    setModelRecoveryGate(gated: boolean): Promise<boolean>;
    rpc: {
        options: Pick<CopilotSession["rpc"]["options"], "update">;
        tools: Pick<CopilotSession["rpc"]["tools"], "initializeAndValidate" | "getCurrentMetadata">;
        model: Pick<CopilotSession["rpc"]["model"], "getCurrent">;
        history: Pick<CopilotSession["rpc"]["history"], "compact" | "cancelBackgroundCompaction" | "clearContext">;
        tasks: Pick<CopilotSession["rpc"]["tasks"], "list" | "cancel" | "remove" | "waitForPending">;
    };
};
export type EphemeralClient = Pick<CopilotClient, "getStatus" | "stop" | "forceStop"> & {
    createSession(config: SessionConfig, retryModelRateLimits?: boolean): Promise<EphemeralSession>;
};

export function ephemeralClientOptions(scratch: EphemeralScratch, gitHubToken?: string): CopilotClientOptions {
    return {
        mode: "empty",
        workingDirectory: scratch.cwd,
        baseDirectory: scratch.copilotHome,
        env: ephemeralEnvironment(scratch),
        useLoggedInUser: false,
        ...(gitHubToken ? { gitHubToken } : {}),
        logLevel: "none",
        enableRemoteSessions: false,
        onGetTraceContext: () => ({}),
    };
}

/** Cleanup deadline only; never an inference or metadata-request limit. */
export async function cleanupStep<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new EphemeralSessionError("EPHEMERAL_CLEANUP_FAILED")), 10_000);
        })]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * SDK 1.0.13 forwards CLI stderr and some RPC failures even at logLevel:none.
 * Keep the unchanged shared client factory in an owned helper process rather
 * than globally monkeypatching console or depending on SDK private fields.
 * Its IPC is private execution data; stdout is discarded and stderr is drained
 * without decoding/retaining it. Only fixed diagnostic codes leave this layer.
 */
export function createEphemeralClient(
    options: CopilotClientOptions,
    provider: unknown,
    onFailure: () => void,
    onDiagnostic: () => void,
    spawn: typeof fork = fork,
): EphemeralClient {
    if (process.platform !== "linux" && process.platform !== "darwin") {
        throw new EphemeralSessionError("EPHEMERAL_ISOLATION_FAILED");
    }
    let child: ChildProcess;
    let closed = false, exited = false, reported = false, failureReported = false, nextId = 0;
    let cleanup: Promise<void> | undefined;
    let onEvent: SessionConfig["onEvent"];
    let bearerToken: NonNullable<SessionConfig["provider"]>["bearerTokenProvider"];
    let hostConfig: SessionConfig;
    const pending = new Map<number, { method: string; resolve(value: unknown): void; reject(error: Error): void }>();
    let resolveExit!: () => void;
    const exit = new Promise<void>(resolve => { resolveExit = resolve; });
    const failure = () => new EphemeralSessionError("EPHEMERAL_INVOCATION_FAILED");
    const rejectPending = (preserveCleanup = false) => {
        for (const [id, value] of pending) {
            if (preserveCleanup && ["abort", "tasks.list", "tasks.cancel", "tasks.remove", "stop"].includes(value.method)) continue;
            value.reject(failure());
            pending.delete(id);
        }
    };
    const close = () => { closed = true; rejectPending(); };
    const notifyFailure = () => {
        if (!failureReported) { failureReported = true; onFailure(); }
    };
    const failChannel = () => { close(); notifyFailure(); };
    const send = (message: unknown) => {
        if (closed) throw failure();
        try {
            if (!child.connected) throw failure();
            child.send(message as object, error => {
                if (error && !closed) failChannel();
            });
        } catch {
            failChannel();
            throw failure();
        }
    };
    const reply = (message: object) => {
        if (closed) return;
        try { send(message); } catch { failChannel(); }
    };
    const call = <T>(method: string, input?: unknown): Promise<T> => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { method, resolve: value => resolve(value as T), reject });
        try { send({ kind: "call", id, method, input }); } catch {
            pending.delete(id); reject(failure());
        }
    });
    const killOwnedGroup = () => {
        if (cleanup) return cleanup;
        close();
        // Closed IPC or a reaped helper does not prove its process group is gone.
        cleanup = (async () => {
            if (child.pid) {
                // Once reaped, a live process at the old PID may be unrelated.
                if (exited) {
                    try { process.kill(child.pid, 0); throw new EphemeralSessionError("EPHEMERAL_CLEANUP_FAILED"); }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
                    }
                }
                try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "EPERM" && !exited && !child.connected) {
                        // macOS can reject a signal to an exiting, unreaped group.
                        // Require both helper exit and group absence, not EPERM alone.
                        await exit;
                        try { process.kill(-child.pid, 0); }
                        catch (probeError) {
                            if ((probeError as NodeJS.ErrnoException).code === "ESRCH") return;
                        }
                    }
                    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
                }
            }
            await exit;
        })();
        return cleanup;
    };

    child = spawn(new URL("./ephemeral-client-child.js", import.meta.url), [], {
        cwd: options.workingDirectory,
        env: { ...options.env, PILOTSWARM_EPHEMERAL_CHILD: "1" },
        execArgv: [],
        // Own process group, not an unreferenced/background daemon. Cleanup
        // kills this exact helper and its CLI even during an incomplete start.
        detached: true,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "advanced",
    });
    child.stderr!.on("data", () => {
        if (!reported) { reported = true; onDiagnostic(); }
    });
    child.on("error", () => {
        if (!child.pid) { exited = true; resolveExit(); }
        if (!closed) failChannel();
    });
    child.on("disconnect", () => {
        if (!closed) failChannel();
    });
    child.on("exit", () => {
        exited = true; resolveExit();
        if (!closed) failChannel();
    });
    child.on("message", (message: unknown) => {
        if (closed) return;
        const data = message as { kind?: string; id?: number; value?: unknown; ok?: boolean };
        if (data?.kind === "reply" && typeof data.id === "number") {
            const waiting = pending.get(data.id);
            pending.delete(data.id);
            if (data.ok) waiting?.resolve(data.value); else waiting?.reject(failure());
        } else if (data?.kind === "event") {
            onEvent?.(data.value as SessionEvent);
        } else if (data?.kind === "host" && typeof data.id === "number") {
            const value = data.value as { method: string; input: any; invocation: { sessionId: string }; name?: string };
            void (async () => {
                const result = value.method === "tool"
                    ? await hostConfig.tools?.find(tool => tool.name === value.name)?.handler?.(value.input, value.invocation as any)
                    : value.method === "permission"
                        ? await hostConfig.onPermissionRequest?.(value.input, value.invocation)
                        : await hostConfig.hooks?.onPreToolUse?.(value.input, value.invocation);
                reply({ kind: "host-reply", id: data.id, ok: true, value: result });
            })().catch(() => {
                reply({ kind: "host-reply", id: data.id, ok: false });
                notifyFailure();
            });
        } else if (data?.kind === "failed") {
            // A child model error can arrive after parent abort has started
            // cleanup. It is not an IPC failure: let cleanup RPCs finish.
            rejectPending(true); notifyFailure();
        } else if (data?.kind === "bearer" && typeof data.id === "number") {
            void (async () => {
                let token: string | undefined;
                try {
                    token = await bearerToken?.(data.value as Parameters<NonNullable<typeof bearerToken>>[0]);
                } catch { /* fixed IPC failure only */ }
                reply({ kind: "bearer-reply", id: data.id, value: token, ok: typeof token === "string" });
            })().catch(notifyFailure);
        }
    });
    const { onGetTraceContext: _trace, ...clientOptions } = options;
    const route = provider as { type?: string; wireApi?: string } | undefined;
    const ready = call("initialize", { options: clientOptions, provider: route
        ? { type: route.type, wireApi: route.wireApi } : undefined });
    void ready.catch(() => {});

    return {
        async createSession(config, retryModelRateLimits = false) {
            await ready;
            hostConfig = config;
            onEvent = config.onEvent;
            bearerToken = config.provider?.bearerTokenProvider;
            const { onEvent: _event, onPermissionRequest: _permission, hooks: _hooks, ...wire } = config;
            wire.tools = config.tools?.map(({ handler: _handler, ...tool }) => tool) as SessionConfig["tools"];
            if (config.provider) {
                const { bearerTokenProvider: _bearer, ...providerConfig } = config.provider;
                wire.provider = providerConfig;
            }
            const sessionId = await call<string>("createSession", { config: wire, hostBearer: Boolean(bearerToken), retryModelRateLimits });
            return {
                sessionId,
                send: input => call("send", input),
                abort: () => call("abort"),
                setModelRecoveryGate: gated => call("recovery.gate", gated),
                rpc: {
                    options: { update: input => call("options.update", input) },
                    tools: {
                        initializeAndValidate: () => call("tools.initializeAndValidate"),
                        getCurrentMetadata: () => call("tools.getCurrentMetadata"),
                    },
                    model: { getCurrent: () => call("model.getCurrent") },
                    history: {
                        compact: input => call("history.compact", input),
                        cancelBackgroundCompaction: () => call("history.cancelBackgroundCompaction"),
                        // Only legal from inside a pending tool handler; the helper's
                        // message loop stays re-entrant while a host reply is owed.
                        clearContext: input => call("history.clearContext", input),
                    },
                    tasks: {
                        waitForPending: () => call("tasks.waitForPending"),
                        list: () => call("tasks.list"),
                        cancel: input => call("tasks.cancel", input),
                        remove: input => call("tasks.remove", input),
                    },
                },
            };
        },
        async getStatus() { await ready; return call("getStatus"); },
        async stop() {
            const clean = await call<boolean>("stop");
            if (clean) await killOwnedGroup();
            return clean ? [] : [new EphemeralSessionError("EPHEMERAL_CLEANUP_FAILED")];
        },
        forceStop: killOwnedGroup,
    };
}
