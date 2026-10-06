import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopilotClient } from "../../src/copilot-client.ts";
import { startScriptedModel } from "./scripted-model.mjs";

/** Fixture owns its CLI process and home; it cannot affect the deployment's client. */
export async function withSteeringCli(respond, fn) {
    const home = mkdtempSync(join(tmpdir(), "ps-steering-cli-"));
    const model = await startScriptedModel({ respond });
    const provider = { type: "openai", baseUrl: model.baseUrl, apiKey: "synthetic-key" };
    const options = { useLoggedInUser: false, env: { ...process.env, COPILOT_HOME: home }, logLevel: "error" };
    let client = createCopilotClient(options, provider);
    const config = { model: "fixture-model", provider, onPermissionRequest: () => ({ kind: "approved" }) };
    try {
        await fn({
            home, model, config,
            get client() { return client; },
            async restart() {
                await client.stop();
                client = createCopilotClient(options, provider);
                return client;
            },
        });
    } finally {
        await client.stop();
        await model.close();
        rmSync(home, { recursive: true, force: true });
    }
}

/** Subscribe before issuing work, including work whose event precedes its RPC response. */
export function nextSdkEvent(session, type, predicate = () => true) {
    const pending = Promise.withResolvers();
    const unsubscribe = session.on(type, (event) => {
        if (!predicate(event)) return;
        unsubscribe();
        pending.resolve(event);
    });
    return { promise: pending.promise, unsubscribe };
}

export async function within(promise, label, timeoutMs = 10_000) {
    const signal = AbortSignal.timeout(timeoutMs);
    const expired = Promise.withResolvers();
    const fail = () => expired.reject(new Error(`fixture deadline: ${label} did not settle within ${timeoutMs} ms`));
    signal.addEventListener("abort", fail, { once: true });
    try {
        return await Promise.race([promise, expired.promise]);
    } finally {
        signal.removeEventListener("abort", fail);
    }
}
