import { describe, expect, it, vi } from "vitest";
import { assertEqual } from "../helpers/assertions.js";

let mockSession;
let mockManager;
vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

import { DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../src/orchestration-registry.ts";

function drive(handler, manifest) {
    const values = new Map();
    const effects = [];
    const statuses = [];
    let now = 1_750_000_000_000;
    let guid = 0;
    let turns = 0;
    const proxy = (prefix) => new Proxy({}, {
        get: (_target, property) => (...args) => ({ effect: `${prefix}.${String(property)}`, args }),
    });
    mockSession = proxy("session");
    mockManager = proxy("manager");
    const ctx = {
        traceInfo() {},
        setCustomStatus: (status) => statuses.push(JSON.parse(status)),
        getValue: (key) => values.get(key) ?? null,
        setValue: (key, value) => values.set(key, value),
        clearValue: (key) => values.delete(key),
        utcNow: () => ({ effect: "utcNow" }),
        newGuid: () => ({ effect: "newGuid" }),
        scheduleTimer: (ms) => ({ effect: "timer", ms }),
        dequeueEvent: (name) => ({ effect: "dequeue", name }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "continue", input, version }),
    };
    const result = { type: "completed", content: "deterministic completed reply", ...(manifest ? { steering: manifest } : {}) };
    const resolve = (effect) => {
        if (effect?.effect === "utcNow") return now;
        if (effect?.effect === "newGuid") return `fixture-guid-${++guid}`;
        if (effect?.effect === "session.runTurn") { turns++; return result; }
        if (effect?.effect === "session.needsHydration") return false;
        if (effect?.effect === "manager.getWorkerSessionPolicy") return { policy: null, allowedAgentNames: [] };
        if (effect?.effect === "manager.getOrchestrationStats") return { historyEventCount: 0, historySizeBytes: 0 };
        if (effect?.effect === "manager.listModels") return [];
        if (effect?.effect === "manager.resolveAgentConfig") return null;
        if (effect?.effect === "timer") { now += effect.ms; return undefined; }
        if (effect?.effect === "race") {
            const sides = [effect.left, effect.right];
            const index = sides.findIndex((side) => side?.effect === "session.runTurn");
            if (index >= 0) return { index, value: resolve(sides[index]) };
            const sweep = sides.findIndex((side) => side?.effect === "timer" && side.ms <= 1_000);
            if (sweep >= 0) { resolve(sides[sweep]); return { index: sweep }; }
            return { parked: true };
        }
        if (effect?.effect === "dequeue" || effect?.effect === "continue") return { parked: true };
        if (effect?.effect?.startsWith("session.") || effect?.effect?.startsWith("manager.")) return undefined;
        throw new Error(`Unrecognized deterministic effect: ${JSON.stringify(effect)}`);
    };
    const generator = handler(ctx, {
        sessionId: "steering-replay-fixture", prompt: "one deterministic work turn",
        config: { model: "fixture:model" }, iteration: 0, isSystem: false, blobEnabled: true,
    });
    let input;
    for (let step = 0; step < 1_000; step++) {
        const next = generator.next(input);
        if (next.done) return { effects, statuses, turns };
        effects.push(next.value);
        input = resolve(next.value);
        if (input?.parked) return { effects, statuses, turns };
    }
    throw new Error("The deterministic handler did not reach its post-turn boundary");
}

describe.concurrent("steering metadata replay-shape compatibility", () => {
    for (const { version, handler } of DURABLE_SESSION_ORCHESTRATION_REGISTRY) {
        it(`ST-I14: registered ${version} yields identical action descriptors with an extra steering manifest`, () => {
            const original = drive(handler, null);
            const steered = drive(handler, { delivered: [{
                requestId: "request-a", attemptId: "attempt-a", sdkMessageId: "sdk-a", kind: "steering",
            }] });
            assertEqual(original.turns, 1, `the fixture actually completed a runTurn; effects=${JSON.stringify(original.effects)}`);
            assertEqual(steered.turns, 1);
            expect(steered.effects).toEqual(original.effects);
            expect(steered.statuses).toEqual(original.statuses);
        });
    }
});
