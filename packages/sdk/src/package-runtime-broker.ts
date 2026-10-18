import { fork, type ChildProcess } from "node:child_process";
import pg from "pg";
import { PgPackageRuntimeAuthority, type PackageRegistration } from "./package-runtime-authority.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Only this trusted broker owns descendants. Executable package code runs in
// another process, so synchronous package JS cannot block fencing or this watchdog.
let code: ChildProcess | undefined;
const children = new Set<ChildProcess>();
const mcp = new Map<string, { child: ChildProcess; requests: Map<number, any>; next: number }>();
let deadline = Date.now() + 1500;
let stopping = false;
let authority: PgPackageRuntimeAuthority | undefined;
let registration: PackageRegistration | undefined;
let pool: pg.Pool | undefined;
const send = (message: unknown) => { if (process.connected) process.send?.(message, () => {}); };
const kill = async (child: ChildProcess): Promise<void> => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`Could not observe package process ${child.pid} exit`)), 3000);
        child.once("exit", () => { clearTimeout(timer); done(); });
        child.kill("SIGKILL");
    });
};
async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    try {
        await Promise.all([...children].map(kill));
        if (authority && registration) {
            // An outage cannot turn missing acknowledgement into completion.
            for (;;) {
                try {
                    await authority.requestFence(registration);
                    await authority.acknowledgeFence(registration, true);
                    break;
                } catch { await new Promise(done => setTimeout(done, 500)); }
            }
        }
        send({ event: "fenced" });
        await pool?.end();
        process.disconnect?.();
        process.exit(0);
    } catch (error) {
        send({ event: "fence-failed", error: String(error) });
        // No exit/ack: the parent must retain an incomplete fence.
    }
}
const watch = setInterval(() => { if (Date.now() > deadline) void stop(); }, 50);
watch.unref();
process.on("disconnect", () => { void stop(); });
process.on("message", async (message: any) => {
    if (message?.method === "lease") { deadline = message.expiresAt; return; }
    if (message?.method === "callback-result") { if (code?.connected && !stopping) code.send(message); return; }
    if (message?.method === "stop") { void stop(); return; }
    if (stopping || !message?.id) return;
    try {
        if (Date.now() > message.expiresAt) throw new Error("Admission dispatch expired");
        if (message.method === "initialize-broker") {
            if (authority) throw new Error("Broker already initialized");
            pool = new pg.Pool({ ...message.configuration.connection,
                application_name: `pilotswarm-package-broker:${message.registration.registrationId}` });
            pool.on("error", () => { /* Retry acknowledgement after authority connectivity returns. */ });
            authority = new PgPackageRuntimeAuthority(pool, message.configuration.schema);
            registration = message.registration;
            await authority.noteProcess(registration!, process.pid, "broker");
            send({ id: message.id, result: true });
        } else if (message.method === "prepare-module") {
            if (code) throw new Error("A package generation imports once");
            if (!authority || !registration) throw new Error("Broker recovery authority unavailable");
            code = fork(fileURLToPath(new URL("./package-runtime-child.js", import.meta.url)), [], {
                stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [], env: message.env,
            });
            children.add(code);
            code.stdout?.resume(); code.stderr?.resume();
            code.on("message", (reply: any) => {
                if (reply?.event === "callback-call") { send(reply); return; }
                if (typeof reply?.id === "string") send({ id: reply.id, result: reply.result, error: reply.error });
            });
            code.once("error", () => { void stop(); });
            code.once("exit", () => { children.delete(code!); if (!stopping) void stop(); });
            await authority.noteProcess(registration, code.pid!, "module");
            send({ id: message.id, result: true });
        } else if (message.method === "import") {
            if (!code?.connected) throw new Error("Package module process unavailable");
            code.send(message);
        } else if (["factory", "callback-factory", "callback", "tool"].includes(message.method)) {
            if (!code?.connected) throw new Error("Package generation is unavailable");
            code.send(message);
        } else if (message.method === "prepare-mcp") {
            if (!authority || !registration || mcp.has(message.key)) throw new Error("MCP preparation unavailable or duplicate");
            const child = fork(fileURLToPath(new URL("./package-runtime-mcp-child.js", import.meta.url)), [], {
                cwd: message.dir, env: message.env, execArgv: [], stdio: ["pipe", "pipe", "pipe", "ipc"],
            });
            children.add(child);
            const state = { child, requests: new Map<number, any>(), next: 1 };
            mcp.set(message.key, state);
            let buffer = "";
            child.stderr?.resume();
            child.once("error", error => {
                for (const pending of state.requests.values()) pending.reject(error);
                void stop();
            });
            child.stdout!.on("data", chunk => {
                buffer += chunk.toString("utf8");
                if (buffer.length > 2_000_000) { void stop(); return; }
                for (;;) {
                    const newline = buffer.indexOf("\n");
                    if (newline < 0) break;
                    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
                    try {
                        const response = JSON.parse(line), pending = state.requests.get(response.id);
                        if (pending) {
                            state.requests.delete(response.id);
                            if (response.error) pending.reject(new Error(response.error.message));
                            else pending.resolve(response.result);
                        }
                    } catch { void stop(); }
                }
            });
            child.once("exit", () => {
                children.delete(child);
                for (const pending of state.requests.values()) pending.reject(new Error("Package MCP process exited"));
                if (!stopping) void stop();
            });
            await authority.noteProcess(registration, child.pid!, "mcp");
            send({ id: message.id, result: true });
        } else if (message.method === "mcp-start") {
            const state = mcp.get(message.key);
            if (!state || !state.child.connected) throw new Error("Prepared MCP process unavailable");
            state.child.send({ method: "start", path: resolve(message.dir, message.config.entry),
                args: message.config.args, env: message.config.env, expiresAt: message.expiresAt });
            const initialized = await rpc(state, "initialize", { protocolVersion: "2024-11-05",
                capabilities: {}, clientInfo: { name: "pilotswarm-supervised", version: "1" } });
            state.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            send({ id: message.id, result: initialized });
        } else if (message.method === "mcp-call") {
            const state = mcp.get(message.key);
            if (!state) throw new Error("Package MCP server is not started");
            if (!["tools/list", "tools/call"].includes(message.rpcMethod)) throw new Error("Unsupported MCP operation");
            const result = await rpc(state, message.rpcMethod, message.params);
            send({ id: message.id, result });
        } else throw new Error("Unsupported supervised operation");
    } catch (error) { send({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
});
function rpc(state: { child: ChildProcess; requests: Map<number, any>; next: number }, method: string, params: unknown): Promise<any> {
    const id = state.next++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { state.requests.delete(id); reject(new Error("Package MCP response timeout")); }, 10_000);
        state.requests.set(id, { resolve: (value: unknown) => { clearTimeout(timer); resolve(value); },
            reject: (error: Error) => { clearTimeout(timer); reject(error); } });
        state.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
}
