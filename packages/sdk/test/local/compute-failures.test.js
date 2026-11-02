import { describe, expect, it, vi } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createProcessComputeProvider } from "../../src/compute-process.ts";
import { join } from "node:path";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

describe("compute failure surfacing", () => {
    it("a deleted target rejects sendAndWait in seconds, without a model request or retry", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            await catalog.computeTargets.create({ name: "shared/deleted-target", kind: "sandbox", class: "shared" }, null, true);
            await withScriptedModel(env, { respond: () => ({ content: "must not run" }) }, async ({ client, worker, model, qualifiedModel }) => {
                const preparations = vi.spyOn(worker.sessionManager, "_prepareCompute");
                const session = await client.createSession({ model: qualifiedModel, computeTarget: "shared/deleted-target" });
                await catalog.computeTargets.delete("shared/deleted-target", null, true);
                const start = Date.now();
                const failure = await session.sendAndWait("run on the deleted target", 8_000).catch(error => error);
                const currentStatus = await client._getDuroxideClient().getStatus(`session-${session.sessionId}`);
                expect(failure.message, JSON.parse(currentStatus.customStatus).error).toMatch(/COMPUTE_TARGET_NOT_FOUND:.*Choose an available compute target/);
                expect(Date.now() - start).toBeLessThan(5_000);
                expect(model.sessionRequests()).toHaveLength(0);
                const info = await session.getInfo();
                expect(info.error).toContain("Choose an available compute target");
                expect((await catalog.getSession(session.sessionId)).lastError).toContain("Choose an available compute target");
                const events = await catalog.getSessionEvents(session.sessionId, 0, 200);
                expect(events.filter(event => event.eventType === "session.compute_failure")).toHaveLength(1);
                expect(preparations.mock.calls.filter(([id]) => id === session.sessionId)).toHaveLength(1);
                const status = await client._getDuroxideClient().getStatus(`session-${session.sessionId}`);
                expect(JSON.parse(status.customStatus).computeFailure).toEqual({ code: "COMPUTE_TARGET_NOT_FOUND", permanent: true });
                preparations.mockRestore();
            });
        } finally {
            await catalog.close();
        }
    });

    it("a disabled target can be enabled and the next prompt succeeds in the same session", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const provider = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-recovery") });
        try {
            await catalog.computeTargets.create({ name: "shared/recovery", kind: "process", class: "shared" }, null, true);
            await withScriptedModel(env, { respond: () => ({ content: "recovered" }), worker: { computeProviders: [provider] } }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({ model: qualifiedModel, computeTarget: "shared/recovery" });
                await catalog.computeTargets.update("shared/recovery", { enabled: false }, null, true);
                await expect(session.sendAndWait("blocked prompt", 8_000)).rejects.toThrow(/COMPUTE_TARGET_DISABLED/);
                expect(model.sessionRequests()).toHaveLength(0);
                await catalog.computeTargets.update("shared/recovery", { enabled: true }, null, true);
                expect(await session.sendAndWait("corrected prompt", TIMEOUT)).toBe("recovered");
            });
        } finally {
            await provider.stopAll();
            await catalog.close();
        }
    });

    it("temporary provider failure is retried on today's schedule and then reaches the model", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const provider = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-retry") });
        const originalBind = provider.bind.bind(provider);
        const attempts = [];
        provider.bind = async request => {
            attempts.push(Date.now());
            if (attempts.length === 1) return { ok: false, code: "COMPUTE_UNAVAILABLE", message: "host offline" };
            return originalBind(request);
        };
        try {
            await catalog.computeTargets.create({ name: "shared/retry", kind: "process", class: "shared" }, null, true);
            await withScriptedModel(env, { respond: () => ({ content: "retried" }), worker: { computeProviders: [provider] } }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({ model: qualifiedModel, computeTarget: "shared/retry" });
                expect(await session.sendAndWait("temporary failure", TIMEOUT)).toBe("retried");
                expect(attempts).toHaveLength(2);
                expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(14_000);
                expect(model.sessionRequests().length).toBeGreaterThan(0);
            });
        } finally {
            await provider.stopAll();
            await catalog.close();
        }
    });
});
