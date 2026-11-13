import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** A loopback relay: forward live inference unchanged; retain tool names, never credentials or model text. */
export async function withRealModelRecorder(env, registry, plan, fn) {
    const provider = registry.allProviders.find(item => item.id === plan.model.provider);
    if (!provider?.baseUrl || !["openai", "openai-proxy", "azure", "anthropic"].includes(provider.type)) {
        throw new Error("BLOCKED: no usable model: this request-recording witness needs a key-based HTTP model provider.");
    }
    const base = new URL(provider.baseUrl);
    const requests = [];
    const errors = [];
    const server = createServer(async (incoming, outgoing) => {
        try {
            const chunks = [];
            let bytes = 0;
            for await (const chunk of incoming) {
                bytes += chunk.length;
                if (bytes > 32 * 1024 * 1024) throw new Error("MODEL_REQUEST_TOO_LARGE");
                chunks.push(chunk);
            }
            const payload = Buffer.concat(chunks);
            if (incoming.method === "POST" && /\/(chat\/completions|responses|messages)(?:\?|$)/.test(incoming.url)) {
                const body = JSON.parse(payload.toString("utf8"));
                requests.push({
                    model: body.model ?? null,
                    tools: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(Boolean).sort(),
                });
            }
            const target = new URL(base);
            const route = new URL(incoming.url, "http://127.0.0.1");
            target.pathname = base.pathname.replace(/\/$/, "") + route.pathname;
            target.search = route.search || base.search;
            const headers = { ...incoming.headers, host: target.host };
            const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
                method: incoming.method, headers,
            }, response => {
                if (response.statusCode >= 400) errors.push(`MODEL_HTTP_${response.statusCode}`);
                outgoing.writeHead(response.statusCode, response.headers);
                response.on("error", error => {
                    errors.push(error.code ?? "MODEL_RESPONSE_FAILED");
                    outgoing.destroy();
                });
                response.pipe(outgoing);
            });
            upstream.on("error", error => {
                errors.push(error.code ?? "MODEL_TRANSPORT_FAILED");
                if (!outgoing.headersSent) outgoing.writeHead(502);
                outgoing.end();
            });
            outgoing.on("close", () => { if (!outgoing.writableFinished) upstream.destroy(); });
            upstream.end(payload);
        } catch (error) {
            errors.push(error.code ?? "MODEL_REQUEST_FAILED");
            if (!outgoing.headersSent) outgoing.writeHead(502);
            outgoing.end();
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        const modelProvidersPath = join(env.baseDir, "recorded-model-providers.json");
        writeFileSync(modelProvidersPath, JSON.stringify({
            providers: [{ ...provider, baseUrl: `http://127.0.0.1:${server.address().port}` }],
            defaultModel: plan.model.ref,
        }), { mode: 0o600 });
        return await fn({ modelProvidersPath, requests, errors });
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
    }
}
