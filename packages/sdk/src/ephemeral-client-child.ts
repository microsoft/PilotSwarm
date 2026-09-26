import type { CopilotSession, CopilotClientOptions, SessionConfig } from "@github/copilot-sdk";
import { createCopilotClient } from "./copilot-client.js";
import { EphemeralFilesystem } from "./ephemeral-filesystem.js";
import path from "node:path";
import { EphemeralModelRecovery } from "./ephemeral-model-recovery.js";

if (process.env.PILOTSWARM_EPHEMERAL_CHILD !== "1" || typeof process.send !== "function"
    || (process.platform !== "linux" && process.platform !== "darwin")) {
    throw new Error("This module is only available to the ephemeral host.");
}

let client: ReturnType<typeof createCopilotClient> | undefined;
let session: CopilotSession | undefined;
let filesystem: EphemeralFilesystem | undefined;
let recovery: EphemeralModelRecovery | undefined;
let nextBearerId = 0;
let nextHostId = 0;
const hostCalls = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const tokens = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();
const send = (message: object) => {
    if (process.connected) process.send?.(message, () => {});
};
const fixedFailure = () => new Error("Isolated runtime operation failed.");
const host = (value: object): Promise<any> => new Promise((resolve, reject) => {
    const id = ++nextHostId;
    hostCalls.set(id, { resolve, reject });
    send({ kind: "host", id, value });
});
const destroyOwnedGroup = () => {
    // The parent exclusively starts this helper as a new POSIX process group.
    // IPC loss must not strand a CLI or an in-progress startup after host loss.
    try { process.kill(-process.pid, "SIGKILL"); } finally { process.exit(1); }
};

process.on("disconnect", destroyOwnedGroup);
process.on("uncaughtException", () => { send({ kind: "failed" }); destroyOwnedGroup(); });
process.on("unhandledRejection", () => { send({ kind: "failed" }); destroyOwnedGroup(); });

async function execute(method: string, input: unknown): Promise<unknown> {
    if (method === "initialize") {
        if (client) throw fixedFailure();
        const value = input as { options: CopilotClientOptions; provider: unknown };
        const root = value.options.baseDirectory!;
        filesystem = new EphemeralFilesystem(path.dirname(root), value.options.workingDirectory!);
        value.options.sessionFs = { initialCwd: value.options.workingDirectory!, sessionStatePath: root,
            conventions: "posix", capabilities: { sqlite: false } };
        delete value.options.baseDirectory;
        client = createCopilotClient({ ...value.options, onGetTraceContext: () => ({}) }, value.provider);
        return true;
    }
    if (!client) throw fixedFailure();
    if (method === "createSession") {
        const value = input as { config: SessionConfig; hostBearer: boolean; retryModelRateLimits?: boolean };
        if (session) throw fixedFailure();
        recovery = value.retryModelRateLimits ? new EphemeralModelRecovery(value.config.sessionId!) : undefined;
        if (value.hostBearer && value.config.provider) {
            value.config.provider.bearerTokenProvider = args => new Promise<string>((resolve, reject) => {
                const id = ++nextBearerId;
                tokens.set(id, { resolve, reject }); send({ kind: "bearer", id, value: args });
            });
        }
        session = await client.createSession({
            ...value.config,
            createSessionFsProvider: () => filesystem!,
            tools: value.config.tools?.map(tool => ({
                ...tool, handler: (input, invocation) => host({ method: "tool", name: tool.name, input,
                    invocation: { sessionId: invocation.sessionId } }),
            })),
            onEvent: value => { recovery?.observe(value); send({ kind: "event", value }); },
            onPermissionRequest: (input, invocation) => host({ method: "permission", input, invocation }),
            hooks: {
                onPreToolUse: (input, invocation) => host({ method: "preTool", input, invocation }),
                onErrorOccurred: input => {
                    const decision = recovery?.decide(input);
                    if (decision?.errorHandling === "retry") return decision;
                    send({ kind: "failed" });
                    return { errorHandling: "abort", suppressOutput: true };
                },
            },
        });
        return session.sessionId;
    }
    // getStatus does not open the CLI connection, unlike createSession. Start
    // it here so the host's runtime-version gate can run before any session.
    if (method === "getStatus") { await client.start(); return client.getStatus(); }
    if (method === "stop") { recovery?.stop(); return (await client.stop()).length === 0; }
    if (!session) throw fixedFailure();
    switch (method) {
        case "send": return session.send(input as Parameters<CopilotSession["send"]>[0]);
        case "abort": recovery?.stop(); return session.abort();
        case "recovery.gate": recovery?.setGate(input === true); return true;
        case "options.update": return session.rpc.options.update(input as Parameters<CopilotSession["rpc"]["options"]["update"]>[0]);
        case "tools.initializeAndValidate": return session.rpc.tools.initializeAndValidate();
        case "tools.getCurrentMetadata": return session.rpc.tools.getCurrentMetadata();
        case "model.getCurrent": return session.rpc.model.getCurrent();
        case "history.compact": return session.rpc.history.compact(input as Parameters<CopilotSession["rpc"]["history"]["compact"]>[0]);
        case "history.cancelBackgroundCompaction": return session.rpc.history.cancelBackgroundCompaction();
        case "history.clearContext": return session.rpc.history.clearContext(input as Parameters<CopilotSession["rpc"]["history"]["clearContext"]>[0]);
        case "tasks.list": return session.rpc.tasks.list();
        case "tasks.waitForPending": return session.rpc.tasks.waitForPending();
        case "tasks.cancel": return session.rpc.tasks.cancel(input as Parameters<CopilotSession["rpc"]["tasks"]["cancel"]>[0]);
        case "tasks.remove": return session.rpc.tasks.remove(input as Parameters<CopilotSession["rpc"]["tasks"]["remove"]>[0]);
        default: throw fixedFailure();
    }
}

process.on("message", (message: unknown) => {
    const data = message as { kind: string; id: number; method?: string; input?: unknown; ok?: boolean; value?: string };
    if (data?.kind === "host-reply") {
        const waiting = hostCalls.get(data.id);
        hostCalls.delete(data.id);
        if (data.ok) waiting?.resolve(data.value);
        else waiting?.reject(fixedFailure());
    } else if (data?.kind === "bearer-reply") {
        const waiting = tokens.get(data.id);
        tokens.delete(data.id);
        if (data.ok && typeof data.value === "string") waiting?.resolve(data.value);
        else waiting?.reject(fixedFailure());
    } else if (data?.kind === "call" && typeof data.id === "number" && typeof data.method === "string") {
        void execute(data.method, data.input).then(
            value => send({ kind: "reply", id: data.id, ok: true, value }),
            () => send({ kind: "reply", id: data.id, ok: false }),
        );
    }
});
