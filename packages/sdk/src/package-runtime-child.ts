import { pathToFileURL } from "node:url";

let module: any;
let tools = new Map<string, any>();
const callbacks = new Map<string, any>();
const nested = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let sequence = 0;
const send = (message: unknown) => process.send?.(message);
process.on("disconnect", () => process.exit(1));
process.on("message", async (message: any) => {
    if (message?.method === "callback-result") {
        const pending = nested.get(message.callId);
        if (pending) {
            nested.delete(message.callId);
            if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
        }
        return;
    }
    if (!message || typeof message.id !== "string") return;
    try {
        if (Date.now() > message.expiresAt) throw new Error("Admission expired before executable dispatch");
        let result: unknown;
        if (message.method === "import") {
            module = await import(pathToFileURL(message.path).href);
            result = { imported: true };
        } else if (message.method === "factory") {
            const factory = module?.createTools ?? module?.default?.createTools;
            const declarations = typeof factory === "function" ? await factory(message.context)
                : module?.default?.tools ?? module?.tools ?? [];
            if (!Array.isArray(declarations) || declarations.length > 256) throw new Error("Invalid tool declaration list");
            const serialized = declarations.map((tool: any) => {
                if (!tool || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/.test(tool.name)
                    || typeof tool.handler !== "function" || tools.has(tool.name)
                    || typeof tool.description !== "string" || !tool.parameters || typeof tool.parameters !== "object") {
                    throw new Error("Unsupported nonserializable/duplicate tool declaration");
                }
                tools.set(tool.name, tool.handler);
                return JSON.parse(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters },
                    (_key, value) => {
                        if (["function", "symbol", "bigint"].includes(typeof value)) throw new Error("Tool declaration must be JSON data");
                        return value;
                    }));
            });
            result = serialized;
        } else if (message.method === "callback-factory") {
            const factory = module?.createCallbacks ?? module?.default?.createCallbacks;
            const declarations = typeof factory === "function" ? await factory(message.context)
                : module?.callbacks ?? module?.default?.callbacks ?? [];
            if (!Array.isArray(declarations) || declarations.length > 256) throw new Error("Invalid callback declarations");
            for (const declaration of declarations) {
                if (!declaration || !Object.hasOwn(message.allowed, declaration.name)
                    || callbacks.has(declaration.name) || typeof declaration.handler !== "function") throw new Error("Unapproved callback declaration");
                callbacks.set(declaration.name, declaration.handler);
            }
            if (callbacks.size !== Object.keys(message.allowed).length) throw new Error("Approved callback declarations missing");
            result = [...callbacks.keys()];
        } else if (message.method === "callback") {
            const handler = callbacks.get(message.name);
            if (!handler) throw new Error("Exact registered callback unavailable");
            const call = (kind: string, name: string, args: unknown, rpcMethod?: string) => new Promise((resolve, reject) => {
                const callId = String(++sequence);
                nested.set(callId, { resolve, reject });
                send({ event: "callback-call", invocationId: message.id, callId, kind, name, args, rpcMethod });
            });
            result = await handler(message.args, { ...message.context,
                callTool: (name: string, args: unknown) => call("tool", name, args),
                callMcp: (name: string, rpcMethod: string, args: unknown) => call("mcp", name, args, rpcMethod) });
        } else if (message.method === "tool") {
            const handler = tools.get(message.name);
            if (!handler) throw new Error("Exact registered handler unavailable");
            result = await handler(message.args, message.context);
        } else throw new Error("Unsupported executable operation");
        const serialized = JSON.stringify(result ?? null);
        if (serialized.length > 2_000_000) throw new Error("Package response exceeds supervised IPC limit");
        send({ id: message.id, result: JSON.parse(serialized) });
    } catch (error) {
        send({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
});
