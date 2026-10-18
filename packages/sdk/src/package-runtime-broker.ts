import { fork, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Only this trusted broker owns descendants. Executable package code runs in
// another process, so synchronous package JS cannot block fencing or this watchdog.
let code: ChildProcess | undefined;
const children = new Set<ChildProcess>();
const mcp = new Map<string, { child: ChildProcess; requests: Map<number, any>; next: number }>();
let deadline = Date.now() + 1500;
let stopping = false;
const send = (message: unknown) => process.send?.(message);
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
        send({ event: "fenced" });
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
    if (message?.method === "stop") { void stop(); return; }
    if (stopping || !message?.id) return;
    try {
        if (Date.now() > message.expiresAt) throw new Error("Admission dispatch expired");
        if (message.method === "import") {
            if (code) throw new Error("A package generation imports once");
            code = fork(fileURLToPath(new URL("./package-runtime-child.js", import.meta.url)), [], {
                stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [], env: message.env,
            });
            children.add(code);
            code.stdout?.resume(); code.stderr?.resume();
            code.on("message", (reply: any) => {
                if (typeof reply?.id === "string") send({ id: reply.id, result: reply.result, error: reply.error });
            });
            code.once("error", () => { void stop(); });
            code.once("exit", () => { children.delete(code!); if (!stopping) void stop(); });
            code.send(message);
        } else if (message.method === "factory" || message.method === "tool") {
            if (!code?.connected) throw new Error("Package generation is unavailable");
            code.send(message);
        } else if (message.method === "mcp-start") {
            if (mcp.has(message.name)) throw new Error("MCP server already started for this generation");
            const child = spawn(process.execPath, [resolve(message.dir, message.config.entry), ...message.config.args], {
                cwd: message.dir, env: { ...message.env, ...message.config.env }, stdio: ["pipe", "pipe", "pipe"],
            });
            children.add(child);
            const state = { child, requests: new Map<number, any>(), next: 1 };
            mcp.set(message.name, state);
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
            const initialized = await rpc(state, "initialize", { protocolVersion: "2024-11-05",
                capabilities: {}, clientInfo: { name: "pilotswarm-supervised", version: "1" } });
            child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            send({ id: message.id, result: initialized });
        } else if (message.method === "mcp-call") {
            const state = mcp.get(message.name);
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
