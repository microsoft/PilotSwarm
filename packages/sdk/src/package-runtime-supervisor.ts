import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PackageRuntimeAuthority, PackageRegistration } from "./package-runtime-authority.js";
import type { ExecutablePackageIdentity, ExecutablePackageAdmissionRequest } from "./agent-package-authorization.js";
import type { VerifiedPackageRuntime } from "./package-runtime-format.js";

export interface PackageCallbackServices {
    /** Trusted host router; published-package targets must retain their own exact admission wrappers. */
    callTool?: (name: string, args: unknown, context: { durableSessionId: string }) => Promise<unknown>;
    /** Trusted deployment MCP router; retain its current allowlist/capability admission checks. */
    callMcp?: (name: string, method: "tools/list" | "tools/call", args: unknown,
        context: { durableSessionId: string }) => Promise<unknown>;
}
interface CallbackInvocation {
    sessionId: string; name: string; services: PackageCallbackServices;
    failed: boolean; pending: number;
}
export class SupervisedPackageRuntime {
    private callbacks = new Map<string, CallbackInvocation>();
    private broker!: ChildProcess;
    private registration!: PackageRegistration;
    private timer?: ReturnType<typeof setInterval>;
    private renewing = false;
    private closed = false;
    private stopping?: Promise<void>;
    private fenceObserved = false;
    private exit!: Promise<void>;
    private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    private readonly mcp = new Map<string, string>();
    private readonly env = Object.fromEntries(["SystemRoot", "TEMP", "TMP"].flatMap(key =>
        process.env[key] ? [[key, process.env[key]!]] : []));

    private constructor(private readonly authority: PackageRuntimeAuthority, readonly identity: ExecutablePackageIdentity,
        private readonly dir: string, readonly verified: VerifiedPackageRuntime, private readonly workerId: string) {}

    static async start(authority: PackageRuntimeAuthority, identity: ExecutablePackageIdentity, dir: string,
        verified: VerifiedPackageRuntime, workerId: string, onRuntime?: (runtime: SupervisedPackageRuntime) => void): Promise<{ runtime: SupervisedPackageRuntime; tools: any[] }> {
        if (!verified || verified.artifactSha256 !== identity.sha256 || verified.policy !== 1) throw new Error("Unverified runtime content identity");
        const runtime = new SupervisedPackageRuntime(authority, identity, dir, verified, workerId);
        await authority.recoverLocal();
        runtime.registration = await authority.register(identity, workerId);
        try { runtime.verifyMaterialization(); }
        catch (error) {
            await authority.requestFence(runtime.registration);
            await authority.acknowledgeFence(runtime.registration, true);
            throw error;
        }
        runtime.broker = fork(fileURLToPath(new URL("./package-runtime-broker.js", import.meta.url)), [], {
            stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [], env: runtime.env,
        });
        runtime.broker.stdout?.resume(); runtime.broker.stderr?.resume();
        runtime.exit = new Promise(done => runtime.broker.once("exit", () => {
            runtime.closed = true;
            runtime.rejectPending(new Error("Supervised package process exited"));
            done();
        }));
        runtime.broker.on("message", (message: any) => {
            if (message.event === "callback-call") { void runtime.callbackCall(message); return; }
            if (message.event === "fenced") { runtime.fenceObserved = true; return; }
            if (message.event === "fence-failed") { runtime.rejectPending(new Error(message.error)); return; }
            const pending = runtime.pending.get(message.id);
            if (pending) {
                runtime.pending.delete(message.id);
                if (message.error) pending.reject(new Error(message.error));
                else pending.resolve(message.result);
            }
        });
        runtime.broker.on("error", error => { runtime.rejectPending(error); void runtime.stop().catch(() => {}); });
        runtime.timer = setInterval(() => { void runtime.renew(); }, 100);
        runtime.timer.unref();
        try {
            onRuntime?.(runtime);
            await runtime.renew();
            await runtime.request("initialize-broker", { configuration: await authority.brokerConfiguration(), registration: runtime.registration });
            const tools = await runtime.load();
            return { runtime, tools };
        } catch (error) { await runtime.stop().catch(() => {}); throw error; }
    }

    private async renew(): Promise<void> {
        if (this.closed || this.renewing) return;
        this.renewing = true;
        const deadline = Date.now() + 1000;
        try {
            if (!await this.authority.heartbeat(this.registration) || Date.now() >= deadline) {
                await this.stop();
            } else if (this.broker.connected) this.broker.send({ method: "lease", expiresAt: deadline });
        } catch { await this.stop().catch(() => {}); }
        finally { this.renewing = false; }
    }

    private request(method: string, body: Record<string, unknown>, signal?: AbortSignal, callback?: CallbackInvocation): Promise<any> {
        if (this.closed || !this.broker.connected) return Promise.reject(new Error("Package generation is fenced"));
        // Trusted idle preparation is not executable dispatch. Slow OS identity
        // probes must finish before, not consume, the next fresh code admission.
        const expiresAt = (signal as AbortSignal & { packageDispatchDeadline?: number })?.packageDispatchDeadline ?? Date.now() + 30_000;
        if (signal?.aborted || Date.now() > expiresAt) return Promise.reject(new Error("Package admission dispatch expired"));
        const id = randomUUID();
        if (callback) this.callbacks.set(id, callback);
        return new Promise((resolve, reject) => {
            const abort = () => { void this.stop().catch(() => {}); };
            const timer = setTimeout(abort, 30_000);
            signal?.addEventListener("abort", abort, { once: true });
            const finish = (callback: (arg: any) => void) => (arg: any) => {
                clearTimeout(timer); signal?.removeEventListener("abort", abort); callback(arg);
            };
            this.pending.set(id, { resolve: finish(value => {
                this.callbacks.delete(id);
                if (callback && (callback.failed || callback.pending)) {
                    reject(Object.assign(new Error("PACKAGE_CALLBACK_NESTED_CALL_FAILED_OR_UNFINISHED: result cannot authorize skip"),
                        { code: "PACKAGE_CALLBACK_NESTED_CALL_FAILED_OR_UNFINISHED" }));
                    if (callback.pending) void this.stop().catch(() => {});
                } else resolve(value);
            }), reject: finish(error => { this.callbacks.delete(id); reject(error); }) });
            this.broker.send({ ...body, id, method, expiresAt }, error => {
                if (error) { this.pending.delete(id); clearTimeout(timer); reject(error); void this.stop().catch(() => {}); }
            });
        });
    }

    private async load(): Promise<any[]> {
        if (!this.verified.module) return [];
        const module = this.verified.module;
        await this.request("prepare-module", { env: this.env });
        await this.authority.withLoadAdmission(this.registration, "import", signal =>
            this.request("import", { path: resolve(this.dir, module), env: this.env }, signal));
        const declarations = await this.authority.withLoadAdmission(this.registration, "factory", signal =>
            this.request("factory", { context: { workerNodeId: this.workerId } }, signal));
        if (this.verified.callbacks) await this.authority.withLoadAdmission(this.registration, "factory", signal =>
            this.request("callback-factory", { allowed: this.verified.callbacks, context: { workerNodeId: this.workerId } }, signal));
        return declarations.map((declaration: any) => ({
            ...declaration,
            handler: (args: unknown, invocation: any) => {
                if (!invocation?.durableSessionId) throw new Error("Package invocation requires durable session identity");
                return this.invoke(invocation.durableSessionId, declaration.name, args);
            },
        }));
    }
    private async admit<T>(sessionId: string, operation: ExecutablePackageAdmissionRequest["operation"], target: string,
        start: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.closed) throw new Error("Package generation is fenced");
        const context = await this.authority.context(sessionId, this.identity);
        const reg = this.registration;
        return this.authority.withAdmission({
            ...this.identity, sessionId, agentName: context.agentName, effectiveOwner: context.effectiveOwner,
            expectedOwnerEpoch: context.ownerEpoch, expectedCapabilityEpoch: context.capabilityEpoch,
            expectedReviewRevision: reg.reviewRevision, expectedRegistryEpoch: reg.registryEpoch,
            registrationId: reg.registrationId, workerNodeId: reg.workerNodeId, workerFence: reg.workerFence,
            operation, target,
        }, start);
    }
    invoke(sessionId: string, name: string, args: unknown): Promise<any> {
        return this.admit(sessionId, "tool", name, signal => this.request("tool",
            { name, args, context: { durableSessionId: sessionId, workerNodeId: this.workerId } }, signal));
    }
    invokeCallback(sessionId: string, name: string, args: unknown, services: PackageCallbackServices = {}): Promise<any> {
        if (!this.verified.callbacks?.[name]) return Promise.reject(new Error("Exact callback declaration unavailable"));
        return this.admit(sessionId, "handler", name, signal => this.request("callback",
            { name, args, context: { durableSessionId: sessionId, workerNodeId: this.workerId } }, signal,
            { sessionId, name, services, failed: false, pending: 0 }));
    }
    private async callbackCall(message: any): Promise<void> {
        const invocation = this.callbacks.get(message.invocationId);
        if (!invocation || typeof message.callId !== "string") return;
        invocation.pending++;
        let result: unknown, error: string | undefined;
        try {
            const declaration = this.verified.callbacks![invocation.name];
            if (message.kind === "tool" && declaration.tools.includes(message.name)) {
                if (!invocation.services.callTool) {
                    result = await this.invoke(invocation.sessionId, message.name, message.args);
                } else result = await this.admit(invocation.sessionId, "tool", message.name, () =>
                    invocation.services.callTool!(message.name, message.args, { durableSessionId: invocation.sessionId }));
            } else if (message.kind === "mcp" && declaration.mcpServers.includes(message.name)
                && ["tools/list", "tools/call"].includes(message.rpcMethod)) {
                if (invocation.services.callMcp) {
                    result = await this.admit(invocation.sessionId, "mcp-tool", message.name, () =>
                        invocation.services.callMcp!(message.name, message.rpcMethod, message.args, { durableSessionId: invocation.sessionId }));
                } else {
                    await this.startMcp(invocation.sessionId, message.name);
                    result = await this.callMcp(invocation.sessionId, message.name, message.rpcMethod, message.args);
                }
            } else throw new Error("Callback nested capability is not declared");
            if ((result as any)?.isError === true) throw new Error("Callback nested MCP/tool failed");
            const serialized = JSON.stringify(result ?? null, (_key, value) => {
                if (["function", "symbol", "bigint"].includes(typeof value)) throw new Error("Callback service result must be JSON data");
                return value;
            });
            if (serialized.length > 2_000_000) throw new Error("Callback service result exceeds IPC limit");
            result = JSON.parse(serialized);
        } catch (cause) { invocation.failed = true; error = cause instanceof Error ? cause.message : String(cause); }
        finally { invocation.pending--; }
        if (this.broker.connected) this.broker.send({ method: "callback-result", callId: message.callId, result, error },
            cause => { if (cause) void this.stop().catch(() => {}); });
    }
    authorizeMcp(sessionId: string, name: string): Promise<void> {
        if (!this.verified.mcp[name]) throw new Error("Unregistered package MCP server");
        return this.admit(sessionId, "mcp-tool", name, async () => {});
    }
    async startMcp(sessionId: string, name: string): Promise<void> {
        this.verifyMaterialization();
        const config = this.verified.mcp[name];
        if (!config) throw new Error("MCP server is not in the verified artifact configuration");
        const key = JSON.stringify([sessionId, name]);
        if (this.mcp.has(key)) { await this.admit(sessionId, "mcp-start", name, async () => {}); return; }
        await this.admit(sessionId, "mcp-start", name, async () => {});
        await this.request("prepare-mcp", { key, env: this.env, dir: this.dir });
        await this.admit(sessionId, "mcp-start", name, signal =>
            this.request("mcp-start", { key, name, config, dir: this.dir }, signal));
        this.mcp.set(key, sessionId);
    }
    async callMcp(sessionId: string, name: string, method: "tools/list" | "tools/call", params: unknown): Promise<any> {
        const key = JSON.stringify([sessionId, name]);
        if (this.mcp.get(key) !== sessionId) throw new Error("MCP server is not started for this exact session");
        return this.admit(sessionId, "mcp-tool", name, signal =>
            this.request("mcp-call", { key, name, rpcMethod: method, params }, signal));
    }
    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
    private verifyMaterialization(): void {
        const inspection = this.registration.inspection;
        if (!inspection || !isDeepStrictEqual(inspection.execution, this.verified)) {
            throw new Error("Runtime descriptor differs from authoritative immutable review");
        }
        const expected = new Map(inspection.files.map(file => [file.path, file]));
        const visit = (dir: string, prefix = ""): void => {
            if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error("Unverifiable runtime directory");
            for (const name of fs.readdirSync(dir)) {
                const rel = prefix ? `${prefix}/${name}` : name, full = resolve(dir, name), stat = fs.lstatSync(full);
                if (stat.isSymbolicLink()) throw new Error("Runtime symlink denied");
                if (stat.isDirectory()) visit(full, rel);
                else {
                    // Installer sidecar is not executable identity or authority.
                    if (!prefix && name === ".pilotswarm-meta.json") continue;
                    const expectedFile = expected.get(rel);
                    if (!stat.isFile() || !expectedFile) throw new Error(`Runtime artifact mismatch: ${rel}`);
                    const bytes = fs.readFileSync(full);
                    if (bytes.length !== expectedFile.sizeBytes
                        || createHash("sha256").update(bytes).digest("hex") !== expectedFile.sha256) {
                        throw new Error(`Runtime artifact mismatch: ${rel}`);
                    }
                    expected.delete(rel);
                }
            }
        };
        visit(this.dir);
        if (expected.size) throw new Error("Runtime artifact contents are incomplete");
    }
    stop(): Promise<void> {
        if (this.stopping) return this.stopping;
        this.closed = true;
        clearInterval(this.timer);
        this.rejectPending(new Error("Package generation cancelled or fenced"));
        this.stopping = (async () => {
            // Kill first even if the database is unreachable. Acknowledgement
            // follows observed exits, never a liveness timeout or cached lease.
            if (this.broker?.connected) this.broker.send({ method: "stop" });
            await Promise.race([this.exit, new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Package fencing incomplete: broker exit not observed")), 4000).unref())]);
            await this.authority.requestFence(this.registration);
            if (!this.fenceObserved) throw new Error("Package fencing incomplete: descendant exits not acknowledged");
            await this.authority.acknowledgeFence(this.registration, true);
        })();
        return this.stopping;
    }
}
