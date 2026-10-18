import { pathToFileURL } from "node:url";

let module: any;
let tools = new Map<string, any>();
const send = (message: unknown) => process.send?.(message);
process.on("disconnect", () => process.exit(1));
process.on("message", async (message: any) => {
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
                : module?.default?.tools ?? module?.tools;
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
