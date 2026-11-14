import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Read session-fixed CLI tools at each usage event; never replace a native model's transport or tools. */
export function observeNativeModelRequests(manager, requests, errors) {
    const pending = new Set();
    const subscriptions = [];
    const seen = new WeakSet();
    const originals = [];
    let ordinal = 0;
    for (const name of ["_createCopilotSession", "_resumeCopilotSession"]) {
        const own = Object.getOwnPropertyDescriptor(manager, name);
        const original = manager[name];
        if (typeof original !== "function") throw new Error(`Native model recorder needs ${name}.`);
        originals.push({ name, own });
        manager[name] = async function (...args) {
            const session = await original.apply(this, args);
            if (!seen.has(session)) {
                seen.add(session);
                subscriptions.push(session.on(event => {
                    if (event.type !== "assistant.usage") return;
                    const request = {
                        source: "cli-metadata", sessionId: session.sessionId,
                        metadataObservation: "session-fixed tools at assistant.usage",
                        requestId: event.data.apiCallId ?? event.data.serviceRequestId ?? event.id ?? `${session.sessionId}/${++ordinal}`,
                        model: event.data.model, tools: null,
                    };
                    requests.push(request);
                    const read = Promise.resolve().then(async () => {
                        const metadata = await session.rpc.tools.getCurrentMetadata();
                        if (!Array.isArray(metadata.tools)) throw new Error("CLI_TOOL_METADATA_MISSING");
                        request.tools = metadata.tools.map(tool => tool.name).sort();
                    }).catch(() => {
                        errors.push("CLI_TOOL_METADATA_UNAVAILABLE");
                    });
                    pending.add(read);
                    void read.finally(() => pending.delete(read));
                }));
            }
            return session;
        };
    }
    return {
        async flush() {
            while (pending.size) await Promise.all([...pending]);
        },
        dispose() {
            for (const unsubscribe of subscriptions) unsubscribe();
            for (const { name, own } of originals) {
                if (own) Object.defineProperty(manager, name, own);
                else delete manager[name];
            }
        },
    };
}

/** Retain only model/tool metadata; HTTP inference bytes and native transport remain unchanged. */
export async function withRealModelRecorder(env, registry, plan, fn) {
    const provider = registry.allProviders.find(item => item.id === plan.model.provider);
    if (!provider) throw new Error("BLOCKED: no usable model: the selected provider is missing.");
    const requests = [];
    const errors = [];
    const cancellations = [];
    if (!["openai", "openai-proxy", "azure", "anthropic"].includes(provider.type)) {
        const observers = [];
        const recorder = {
            source: "cli-metadata", modelProvidersPath: process.env.PS_MODEL_PROVIDERS_PATH,
            requests, cliMetadata: requests, errors, cancellations,
            observe(manager) { observers.push(observeNativeModelRequests(manager, requests, errors)); },
            async flush() { for (const observer of observers) await observer.flush(); },
        };
        try {
            return await fn(recorder);
        } finally {
            try { await recorder.flush(); } finally { for (const observer of observers) observer.dispose(); }
        }
    }
    if (!provider.baseUrl) throw new Error("BLOCKED: no usable model: the HTTP provider has no base URL.");
    const base = new URL(provider.baseUrl);
    const pendingTransports = new Set();
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
            let recorded = null;
            if (incoming.method === "POST" && /\/(chat\/completions|responses|messages)(?:\?|$)/.test(incoming.url)) {
                const body = JSON.parse(payload.toString("utf8"));
                recorded = {
                    source: "http-request",
                    model: body.model ?? null,
                    tools: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(Boolean).sort(),
                    status: null,
                };
                requests.push(recorded);
            }
            const target = new URL(base);
            const route = new URL(incoming.url, "http://127.0.0.1");
            target.pathname = route.pathname;
            target.search = route.search || base.search;
            const headers = { ...incoming.headers, host: target.host };
            let locallyCancelled = false, upstreamFailed = false, responseStarted = false;
            const transport = Promise.withResolvers();
            const settled = () => {
                pendingTransports.delete(transport.promise);
                transport.resolve();
            };
            const failed = (error, fallback) => {
                if (locallyCancelled) return;
                upstreamFailed = true;
                errors.push(error.code ?? fallback);
            };
            const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
                method: incoming.method, headers,
            }, response => {
                responseStarted = true;
                response.once("close", settled);
                if (recorded) recorded.status = response.statusCode;
                if (response.statusCode >= 400) {
                    upstreamFailed = true;
                    errors.push(`MODEL_HTTP_${response.statusCode}`);
                }
                outgoing.writeHead(response.statusCode, response.headers);
                response.on("error", error => {
                    failed(error, "MODEL_RESPONSE_FAILED");
                    outgoing.destroy();
                });
                response.pipe(outgoing);
            });
            pendingTransports.add(transport.promise);
            upstream.on("error", error => {
                failed(error, "MODEL_TRANSPORT_FAILED");
                if (!outgoing.headersSent) outgoing.writeHead(502);
                outgoing.end();
            });
            upstream.once("close", () => { if (!responseStarted) settled(); });
            const cancelUpstream = () => {
                if (outgoing.writableFinished) return;
                if (!upstreamFailed && !locallyCancelled) {
                    locallyCancelled = true;
                    cancellations.push({ request: recorded ? requests.indexOf(recorded) + 1 : null, reason: "downstream-closed" });
                }
                upstream.destroy();
            };
            outgoing.once("close", cancelUpstream);
            if (outgoing.destroyed) cancelUpstream();
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
            providers: [{ ...provider, baseUrl: `http://127.0.0.1:${server.address().port}${base.pathname}${base.search}` }],
            defaultModel: plan.model.ref,
        }), { mode: 0o600 });
        const observers = [];
        const cliMetadata = [];
        const recorder = {
            source: "http-request", modelProvidersPath, requests, cliMetadata, errors, cancellations,
            observe(manager) { observers.push(observeNativeModelRequests(manager, cliMetadata, errors)); },
            async flush() {
                for (const observer of observers) await observer.flush();
                while (pendingTransports.size) await Promise.all([...pendingTransports]);
            },
        };
        try {
            return await fn(recorder);
        } finally {
            try { await recorder.flush(); } finally { for (const observer of observers) observer.dispose(); }
        }
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
    }
}
