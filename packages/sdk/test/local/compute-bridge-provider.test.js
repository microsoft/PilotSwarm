/**
 * A full turn through a provider that opens its own connections
 * (docs/proposals/compute-providers.md, "Transport contract").
 *
 * The other local compute test drives a provider whose hosts are reachable
 * at an address, which is the built-in way. This one drives the other
 * kind: the provider hands PilotSwarm no address at all, only the code to
 * open a connection. PilotSwarm puts a bridge on this machine in front of
 * it, and the rest of a turn is unchanged — prompts, tool calls, model
 * requests with their credentials swapped back in, and session state in the
 * worker's own folder all travel through the provider's connection.
 *
 * The connection here is deliberately dull: it reaches a runtime the
 * `process` provider already started on this machine. What matters is that
 * PilotSwarm never learns that — it is handed a two-way stream and asks no
 * questions — so a provider whose connection is built some other way
 * plugs in at exactly this seam.
 *
 * Run: npx vitest run test/local/compute-bridge-provider.test.js
 */
import { describe, expect, it } from "vitest";
import net from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createProcessComputeProvider } from "../../src/compute-process.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function registerTarget(env, name, kind) {
    const catalog = await createCatalog(env);
    try {
        await catalog.computeTargets.create({ name: `shared/${name}`, kind, class: "shared", displayName: name }, null, true);
    } finally {
        await catalog.close?.();
    }
}

function listTree(dir, prefix = "") {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
        ? listTree(join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`]);
}

async function waitForSessionError(env, sessionId, pattern) {
    const catalog = await createCatalog(env);
    try {
        for (let i = 0; i < 60; i++) {
            const events = await catalog.getSessionEvents(sessionId, 0, 200);
            const hit = events.find((event) => pattern.test(JSON.stringify(event.data ?? {})));
            if (hit) return hit;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        return null;
    } finally {
        await catalog.close?.();
    }
}

/**
 * A provider that is reached only through code of its own.
 *
 * It leans on the `process` provider to have a runtime at all, then hides
 * every trace of where it is: `connect` returns no address, just the
 * opaque details its own `openConnection` will need. Those details are
 * what a real provider would use to reach a host elsewhere.
 */
function createPipeComputeProvider(inner, options = {}) {
    const opened = [];
    return {
        kind: "pipe-kind",
        transport: "pipe",
        capabilities: { ...inner.capabilities, ...(options.capabilities ?? {}) },
        hosts: () => inner.hosts(),
        openedCount: () => opened.length,
        liveCount: () => opened.filter((pipe) => !pipe.destroyed).length,
        breakAll: () => { for (const pipe of opened) pipe.destroy(new Error("the connection to the host was lost")); },

        async bind(req) { return inner.bind(req); },

        async connect(req) {
            const connected = await inner.connect(req);
            if (!connected.ok) return connected;
            const { address, connectionToken, handshake } = connected.endpoint;
            if (options.failToOpen) {
                return { ok: true, endpoint: { transport: "pipe", connectionToken, handshake, details: { unreachable: true } }, workspace: connected.workspace };
            }
            // Only this provider ever reads `details`. The handshake is
            // carried through unchanged: the worker proves itself to the
            // host component at the far end of the connection, whatever
            // the connection is made of.
            return {
                ok: true,
                endpoint: { transport: "pipe", connectionToken, handshake, details: { reach: address } },
                workspace: connected.workspace,
            };
        },

        async openConnection(req) {
            if (req.details.unreachable) throw new Error("this host cannot be reached");
            const [host, port] = String(req.details.reach).split(":");
            const pipe = await new Promise((resolve, reject) => {
                const socket = net.connect({ host, port: Number(port) }, () => resolve(socket));
                socket.once("error", reject);
                req.signal.addEventListener("abort", () => socket.destroy(new Error("the attempt was abandoned")), { once: true });
            });
            opened.push(pipe);
            return pipe;
        },

        async release(req) { return inner.release(req); },
        async stopAll() { return inner.stopAll(); },
    };
}

describe("a compute provider that opens its own connections", () => {
    it("runs a whole turn through the provider's connection", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await registerTarget(env, "by-pipe", "pipe-kind");
        const inner = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-pipe") });
        const provider = createPipeComputeProvider(inner);
        const marker = `bridged-${env.runId}`;
        let probeOutput = "";

        const respond = (body, position) => {
            if (position.turn === 1) {
                if (position.step === 0) {
                    return { tools: [{ name: "bash", args: { command: 'echo "home=$COPILOT_HOME db=${PS_TEST_DATABASE_URL:-none}"', description: "probe" } }] };
                }
                probeOutput = position.toolResults.join("\n");
                return { content: `turn1:${marker}` };
            }
            const sawHistory = JSON.stringify(body.messages).includes(`turn1:${marker}`);
            return { content: `turn2:${sawHistory ? "history" : "no-history"}` };
        };

        await withScriptedModel(env, { respond, worker: { computeProviders: [provider] } }, async ({ client, model, qualifiedModel }) => {
            const session = await client.createSession({ model: qualifiedModel, computeTarget: "shared/by-pipe" });
            expect(await session.sendAndWait("first prompt", TIMEOUT)).toBe(`turn1:${marker}`);

            // The turn really ran in the separate runtime, reached only
            // through the provider's own connection.
            expect(provider.openedCount(), "the worker went through the provider's connection").toBeGreaterThan(0);
            const hosts = provider.hosts();
            expect(hosts).toHaveLength(1);
            expect(probeOutput).toContain(`home=${hosts[0].homeDir}`);
            expect(probeOutput).toContain("db=none");

            // Credentials still stayed with the worker: the runtime held
            // placeholders and the model saw the real key.
            const requests = model.sessionRequests("first prompt");
            expect(requests.length).toBeGreaterThanOrEqual(2);
            for (const request of requests) {
                expect(request.headers.authorization).toBe("Bearer synthetic");
                expect(JSON.stringify(request.headers)).not.toContain("pilotswarm-worker-secret");
            }

            // And session state is still the worker's.
            const workerFiles = listTree(join(env.sessionStateDir, session.sessionId));
            expect(workerFiles).toContain("events.jsonl");

            // A second turn on the same binding reuses the same bridge.
            expect(await session.sendAndWait("second prompt", TIMEOUT)).toBe("turn2:history");

            // Ending the session closes the connections it was using.
            await client.deleteSession?.(session.sessionId).catch(() => {});
        });

        await provider.stopAll();
        // Every pipe the worker opened is closed once nothing holds the host.
        expect(provider.liveCount()).toBe(0);
    });

    it("fails the turn clearly when the provider cannot open a connection", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await registerTarget(env, "by-broken-pipe", "pipe-kind");
        const inner = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-pipe-broken") });
        const provider = createPipeComputeProvider(inner, { failToOpen: true });

        await withScriptedModel(env, { respond: () => ({ content: "should not run" }), worker: { computeProviders: [provider] } }, async ({ client, model, qualifiedModel }) => {
            const session = await client.createSession({ model: qualifiedModel, computeTarget: "by-broken-pipe" });
            await session.send("hello");
            // The connection cannot be made, so the turn fails and says so
            // rather than waiting on a connection that will never work.
            // The turn says what went wrong in compute's own words, rather
            // than leaving a raw socket error to stand for it.
            const hit = await waitForSessionError(env, session.sessionId, /COMPUTE_UNAVAILABLE/);
            expect(hit, "the session records a compute failure").toBeTruthy();
            expect(JSON.stringify(hit.data)).toMatch(/cannot be reached/);
            expect(model.sessionRequests()).toHaveLength(0);
        });
        await provider.stopAll();
    });
});
