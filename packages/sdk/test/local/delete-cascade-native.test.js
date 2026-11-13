import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { cancelSession } from "../../src/orchestration/agents.ts";
import { createSessionManagerProxy, registerActivities } from "../../src/session-proxy.ts";
import { commandResponseKey } from "../../src/types.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);

describe("live delete branch with native replay, real activities and CMS", () => {
    it.each([false, true])("persists its reply and retains only failed subtrees (failure=%s)", { timeout: 120_000 }, async fail => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
        const root = randomUUID(), branch = randomUUID(), leaf = randomUUID(), sibling = randomUUID();
        const commandId = `delete-${root}`;
        let spy;
        try {
            await catalog.createSession(root);
            await catalog.createSession(branch, { parentSessionId: root });
            await catalog.createSession(leaf, { parentSessionId: branch });
            await catalog.createSession(sibling, { parentSessionId: root });
            if (fail) {
                const original = PgSessionCatalog.prototype.softDeleteSession;
                spy = vi.spyOn(PgSessionCatalog.prototype, "softDeleteSession").mockImplementation(function (id, opts) {
                    if (id === leaf) throw Object.assign(new Error("injected permanent delete failure"), { code: "42501" });
                    return original.call(this, id, opts);
                });
            }
            const activities = new Map();
            registerActivities({ registerActivity: (name, handler) => activities.set(name, handler) }, {}, null,
                undefined, catalog, undefined, env.store, env.cmsSchema,
                { duroxideSchema: env.duroxideSchema, factsSchema: env.factsSchema });
            for (const name of ["getDescendantSessionIds", "deleteSession", "recordSessionEvent", "updateCmsState"]) {
                runtime.registerActivity(name, activities.get(name));
            }
            runtime.registerActivity("testDestroySession", async () => {});
            runtime.registerOrchestration("delete-branch-proof", function* (ctx, input) {
                const state = { iteration: 1, subAgents: [], carriedSteers: [], orchestrationResult: null };
                const scope = {
                    input, ctx, state, options: {},
                    manager: createSessionManagerProxy(ctx),
                    // Model-session disposal is the only lifecycle double; deletion uses production activities.
                    session: { destroy: () => ctx.scheduleActivity("testDestroySession", {}) },
                };
                yield* cancelSession(scope, "native cascade regression", commandId, true);
                return state.orchestrationResult;
            });
            await runtime.start();
            await client.startOrchestration(`session-${root}`, "delete-branch-proof", { sessionId: root });
            const ended = await client.waitForOrchestration(`session-${root}`, 60_000);
            expect(ended.status).toBe("Completed");
            const raw = await client.getValue(`session-${root}`, commandResponseKey(commandId));
            const reply = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (fail) {
                expect(reply.error).toContain("Failed to delete session");
                expect(reply.result?.ok).not.toBe(true);
                expect(await catalog.getSession(root)).toMatchObject({ state: "failed" });
                expect(await catalog.getSession(branch)).not.toBeNull();
                expect(await catalog.getSession(leaf)).not.toBeNull();
            } else {
                expect(reply.result).toMatchObject({ ok: true, message: "Session deleted" });
                expect(await catalog.getSession(root)).toBeNull();
                expect(await catalog.getSession(branch)).toBeNull();
                expect(await catalog.getSession(leaf)).toBeNull();
            }
            expect(await catalog.getSession(sibling)).toBeNull();
        } finally {
            spy?.mockRestore();
            await runtime.shutdown(10_000);
            await catalog.close();
        }
    });
});
