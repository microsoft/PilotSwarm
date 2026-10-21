/**
 * Cron prechecks in orchestration 1.0.83: an interval cron schedule that names
 * a worker-registered precheck asks it first, and a `skip` re-arms the
 * schedule without running a model turn. A schedule without a precheck is
 * unchanged. Driven against the generator with a scripted context; no worker,
 * database or model.
 */
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/orchestration/runtime.ts";
import { processTimer, processPrompt } from "../../src/orchestration/turn.ts";
import { applyCronAction, buildContinueInput, handleCommand } from "../../src/orchestration/lifecycle.ts";
import { cronPrecheckStatusFields, PilotSwarmManagementClient } from "../../src/management-client.ts";

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: (ctx) => ctx.proxy("session"),
    createSessionManagerProxy: (ctx) => ctx.proxy("manager"),
}));

const SCHEDULE = { intervalSeconds: 300, reason: "check the work queue", precheck: "queue" };

function harness(overrides = {}, resolvedAgent = null) {
    const calls = [];
    const turns = [];
    const prechecks = [];
    const precheckAnswers = [];
    let now = 1_750_000_000_000;
    let guid = 0;
    const kv = new Map();
    const statuses = [];
    const ctx = {
        traceInfo() {},
        setCustomStatus(status) { statuses.push(typeof status === "string" ? JSON.parse(status) : status); },
        getValue: key => kv.get(key) ?? null,
        setValue: (key, value) => kv.set(key, value),
        clearValue: key => kv.delete(key),
        utcNow: () => ({ effect: "now" }),
        newGuid: () => ({ effect: "guid" }),
        scheduleTimer: ms => ({ effect: "timer", ms }),
        dequeueEvent: name => ({ effect: "dequeue", name }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "can", input, version }),
        proxy(prefix) {
            return new Proxy({}, {
                get: (_, name) => (...args) => ({ effect: `${prefix}.${String(name)}`, args }),
            });
        },
    };
    function resolve(effect) {
        if (effect == null) return undefined;
        calls.push(effect);
        switch (effect.effect) {
            case "now": return now;
            case "guid": return `recorded-guid-${++guid}`;
            case "timer": now += effect.ms; return undefined;
            case "manager.runCronPrecheck": {
                prechecks.push(effect.args[0]);
                const answer = precheckAnswers.shift();
                if (answer instanceof Error) throw answer;
                return answer ?? { skip: false, outcome: "unregistered", precheck: effect.args[0].precheck };
            }
            case "session.runTurn":
                turns.push(effect.args);
                return { type: "completed", content: "cycle done" };
            case "manager.listChildSessions": return "[]";
            case "manager.getWorkerSessionPolicy": return { policy: null, allowedAgentNames: [] };
            case "manager.resolveAgentConfig": return resolvedAgent;
            case "manager.getOrchestrationStats": return { historySizeBytes: 0 };
            default: return undefined;
        }
    }
    function drive(gen) {
        let value;
        let failure;
        for (let step = 0; step < 800; step++) {
            const next = failure ? gen.throw(failure) : gen.next(value);
            failure = undefined;
            if (next.done) return next.value;
            try { value = resolve(next.value); } catch (error) { failure = error; }
        }
        throw new Error("generator exceeded bound");
    }
    const runtime = drive(createRuntime(ctx, {
        sessionId: "cron-precheck-fixture",
        config: {},
        iteration: 4,
        isSystem: true,
        blobEnabled: false,
        cronSchedule: { ...SCHEDULE },
        ...overrides,
    }, { currentVersion: "1.0.83", latestVersion: "1.0.83" }));
    calls.length = 0;
    const fire = (...answers) => {
        precheckAnswers.push(...answers);
        const timer = { type: "cron", reason: SCHEDULE.reason, deadlineMs: now, originalDurationMs: SCHEDULE.intervalSeconds * 1000 };
        runtime.state.activeTimer = null;
        drive(processTimer(runtime, { kind: "timer", timer, firedAtMs: now }));
    };
    const events = () => calls
        .filter(call => call.effect === "manager.recordSessionEvent")
        .flatMap(call => call.args[1].map(event => event.eventType));
    const eventData = (type) => calls
        .filter(call => call.effect === "manager.recordSessionEvent")
        .flatMap(call => call.args[1])
        .filter(event => event.eventType === type)
        .map(event => event.data);
    const command = (cmd, args) => {
        const id = `cmd-${cmd}-${calls.length}`;
        drive(handleCommand(runtime, { type: "cmd", cmd, id, args }));
        const stored = [...kv.values()]
            .map(value => (typeof value === "string" ? JSON.parse(value) : value))
            .find(value => value?.id === id);
        return stored;
    };
    const prompt = text => drive(processPrompt(runtime, text, false));
    return { runtime, calls, turns, prechecks, fire, events, eventData, command, prompt, statuses, now: () => now };
}

describe("1.0.83 cron precheck", () => {
    it("a schedule without a precheck runs exactly as before, with no precheck activity", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 300, reason: SCHEDULE.reason } });
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks).toHaveLength(0);
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toContain(`Scheduled cron wake-up for: "${SCHEDULE.reason}"`);
        expect(h.runtime.state.cronSchedule).toEqual({ intervalSeconds: 300, reason: SCHEDULE.reason });
    });

    it("a skip re-arms the schedule without a model turn", () => {
        const h = harness();
        h.fire({ skip: true, outcome: "skip", precheck: "queue", shadow: false });

        expect(h.turns).toHaveLength(0);
        expect(h.prechecks).toEqual([{
            sessionId: "cron-precheck-fixture",
            precheck: "queue",
            reason: SCHEDULE.reason,
            intervalSeconds: SCHEDULE.intervalSeconds,
            consecutiveSkips: 0,
            agent: {},
        }]);
        expect(h.runtime.state.cronSchedule).toEqual({ ...SCHEDULE, precheckSkips: 1 });
        expect(h.runtime.state.activeTimer).toMatchObject({
            type: "cron",
            reason: SCHEDULE.reason,
            originalDurationMs: SCHEDULE.intervalSeconds * 1000,
            deadlineMs: h.now() + SCHEDULE.intervalSeconds * 1000,
        });
        expect(h.events()).toEqual(["session.cron_fired", "session.cron_started"]);
    });

    it("counts consecutive skips and resets the count when the model runs", () => {
        const h = harness();
        h.fire({ skip: true, outcome: "skip" });
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks.map(p => p.consecutiveSkips)).toEqual([0, 1]);
        expect(h.runtime.state.cronSchedule.precheckSkips).toBe(2);

        h.fire({ skip: false, outcome: "run" });
        expect(h.prechecks.at(-1).consecutiveSkips).toBe(2);
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toContain(`Scheduled cron wake-up for: "${SCHEDULE.reason}"`);
        expect(h.runtime.state.cronSchedule).toEqual({ ...SCHEDULE, precheckSkips: 0 });
    });

    it("a shadow decision still runs the model turn", () => {
        const h = harness();
        h.fire({ skip: false, outcome: "skip", precheck: "queue", shadow: true });
        expect(h.prechecks).toHaveLength(1);
        expect(h.turns).toHaveLength(1);
        expect(h.runtime.state.cronSchedule.precheckSkips).toBeUndefined();
    });

    it("a real interactive or carried-work turn resets the consecutive idle-skip count", () => {
        for (const carried of [false, true]) {
            const h = harness({ cronSchedule: { ...SCHEDULE, precheckSkips: 3 },
                ...(carried ? { runtimeModelNotice: "The model changed." } : {}) });
            if (carried) h.fire();
            else h.prompt("Inspect the new work");
            expect(h.turns).toHaveLength(1);
            expect(h.prechecks).toHaveLength(0);
            expect(h.runtime.state.cronSchedule.precheckSkips).toBe(0);
        }
    });

    it("fails open when the precheck activity throws", () => {
        const h = harness();
        h.fire(new Error("activity not available"));
        expect(h.turns).toHaveLength(1);
        expect(h.runtime.state.cronSchedule.precheckSkips).toBeUndefined();
    });

    it("an unregistered name runs the model turn", () => {
        const h = harness();
        h.fire();
        expect(h.prechecks).toHaveLength(1);
        expect(h.turns).toHaveLength(1);
    });

    it("does not consult the precheck when the wake-up carries a child digest", () => {
        const h = harness({
            pendingChildDigest: {
                startedAtMs: 1,
                updates: [{ sessionId: "child", updateType: "completed", content: "found a job", observedAtMs: 1 }],
            },
        });
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks).toHaveLength(0);
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toContain("found a job");
    });

    it("does not consult the precheck when a held note must reach the model", () => {
        const h = harness({ runtimeModelNotice: "The model changed." });
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks).toHaveLength(0);
        expect(h.turns).toHaveLength(1);
    });

    it("a stale cron fire after cancel neither prechecks nor runs", () => {
        const h = harness();
        h.runtime.state.cronSchedule = undefined;
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks).toHaveLength(0);
        expect(h.turns).toHaveLength(0);
    });

    it("the skip count survives continue-as-new with the schedule", () => {
        const h = harness();
        h.fire({ skip: true, outcome: "skip" });
        const input = buildContinueInput(h.runtime);
        expect(input.cronSchedule).toEqual({ ...SCHEDULE, precheckSkips: 1 });
    });

    it("a cron call sets the schedule's precheck, and a later call without one clears it", () => {
        const h = harness({ cronSchedule: undefined });
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 60, reason: "poll", precheck: "queue" });
        expect(h.runtime.state.cronSchedule).toEqual({ intervalSeconds: 60, reason: "poll", precheck: "queue", revision: 1 });
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 60, reason: "poll" });
        expect(h.runtime.state.cronSchedule).toEqual({ intervalSeconds: 60, reason: "poll", revision: 2 });
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 60, reason: "poll", precheckPackageId: "pkg-1" });
        expect(h.runtime.state.cronSchedule).toEqual({ intervalSeconds: 60, reason: "poll", revision: 3 }, "a package without a precheck name is dropped");
    });

    it("a package precheck sends its package to the activity", () => {
        const h = harness({ cronSchedule: { ...SCHEDULE, precheckPackageId: "pkg-1" } });
        h.fire({ skip: true, outcome: "skip", precheck: "queue" });
        expect(h.prechecks[0]).toMatchObject({ precheck: "queue", packageId: "pkg-1" });
        expect(h.turns).toHaveLength(0);
        expect(buildContinueInput(h.runtime).cronSchedule).toEqual({ ...SCHEDULE, precheckPackageId: "pkg-1", precheckSkips: 1 });
    });

    it("agentId-only startup dispatches resolved provenance and tools and retains them across continue-as-new", () => {
        const identity = { packageId: "pkg-shared", versionId: "v1", sha256: "a".repeat(64) };
        const h = harness({
            agentId: "poller",
            iteration: 0,
            isSystem: false,
            config: { toolNames: ["caller_tool"] },
            cronSchedule: { ...SCHEDULE, precheckPackageId: "pkg-shared", precheckIdentity: identity, precheckBindingRevision: 7 },
        }, { name: "poller", packageId: "pkg-shared", tools: ["queue_tool"] });
        h.fire({ skip: true, outcome: "skip" });
        const expectedAgent = {
            boundAgentName: "poller",
            boundAgentPackageId: "pkg-shared",
            toolNames: ["queue_tool", "caller_tool"],
        };
        expect(h.prechecks[0].agent).toMatchObject(expectedAgent);
        expect(h.prechecks[0]).toMatchObject({ packageIdentity: identity, packageBindingRevision: 7 });
        expect(h.runtime.input.config.boundAgentPackageId).toBeUndefined();
        const next = buildContinueInput(h.runtime);
        expect(next.config).toMatchObject(expectedAgent);
        const resumed = harness({ ...next, iteration: 1 });
        resumed.fire({ skip: true, outcome: "skip" });
        expect(resumed.prechecks[0].agent).toEqual(h.prechecks[0].agent);
        expect(resumed.prechecks[0].packageId).toBe("pkg-shared");
        expect(resumed.prechecks[0]).toMatchObject({ packageIdentity: identity, packageBindingRevision: 7 });
    });

    it("schedule arming clones the full immutable identity and preserves it through continue-as-new", () => {
        const h = harness({ cronSchedule: undefined });
        const identity = { packageId: "pkg", versionId: "v1", sha256: "a".repeat(64) };
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 60, reason: "poll",
            precheck: "queue", precheckPackageId: "pkg", precheckIdentity: identity, precheckBindingRevision: 3 });
        identity.versionId = "substituted";
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks[0].packageIdentity.versionId).toBe("v1");
        const next = buildContinueInput(h.runtime);
        expect(next.cronSchedule.precheckIdentity).toEqual({ ...identity, versionId: "v1" });
        expect(next.cronSchedule.precheckBindingRevision).toBe(3);
    });
});

describe("session view PRECHECK fields", () => {
    it("are shape-checked, interval-only, and never carry package pins", () => {
        const status = {
            cronPrecheck: "pkg-queue",
            cronPrecheckSource: "operator",
            cronRevision: 4,
            cronPrecheckOptions: [
                { name: "queue", kind: "worker" },
                { name: "pkg-queue", kind: "package", packageIdentity: { sha256: "c".repeat(64) } },
                { name: 7, kind: "worker" },
                { name: "x", kind: "other" },
            ],
            cronPrecheckHealth: { outcome: "error", since: 10, count: 3 },
        };
        expect(cronPrecheckStatusFields(status, true)).toEqual({
            cronPrecheck: "pkg-queue",
            cronPrecheckSource: "operator",
            cronRevision: 4,
            cronPrecheckOptions: [{ name: "queue", kind: "worker" }, { name: "pkg-queue", kind: "package" }],
            cronPrecheckHealth: { outcome: "error", since: 10, count: 3 },
        });
        expect(cronPrecheckStatusFields(status, false)).toEqual({});
        expect(cronPrecheckStatusFields({ cronPrecheckSource: "admin", cronRevision: 1.5, cronPrecheckHealth: { outcome: "error" } }, true)).toEqual({});
    });
});

describe("management setSessionCronPrecheck", () => {
    const client = (response) => {
        const mgmt = Object.create(PilotSwarmManagementClient.prototype);
        mgmt._started = true;
        mgmt.sent = [];
        mgmt.sendCommand = async (sessionId, command) => { mgmt.sent.push({ sessionId, command }); };
        mgmt._awaitCommandResponse = async () => response;
        return mgmt;
    };
    const input = { precheck: "pkg-queue", expectedRevision: 2, reason: "use the package check", actor: "owner@example.com" };

    it("sends the command with the stamped actor and returns the orchestration's answer", async () => {
        const mgmt = client({ result: { ok: true, precheck: "pkg-queue", revision: 3, appliesOn: "next_fire" } });
        await expect(mgmt.setSessionCronPrecheck("s1", input)).resolves.toEqual({ ok: true, precheck: "pkg-queue", revision: 3, appliesOn: "next_fire" });
        expect(mgmt.sent[0]).toMatchObject({ sessionId: "s1", command: { cmd: "set_cron_precheck", args: input } });
    });

    it("maps STALE to CONFLICT and other refusals to INVALID_REQUEST", async () => {
        await expect(client({ error: "STALE: cron schedule revision is 3; refresh and retry" }).setSessionCronPrecheck("s1", input))
            .rejects.toMatchObject({ code: "CONFLICT", status: 409 });
        await expect(client({ error: "Unknown precheck" }).setSessionCronPrecheck("s1", input))
            .rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    });

    it("validates input before sending", async () => {
        const mgmt = client(null);
        for (const bad of [{ precheck: "" }, { precheck: 3 }, { expectedRevision: -1 }, { expectedRevision: 1.5 }, { reason: " " }, { actor: "" }]) {
            await expect(mgmt.setSessionCronPrecheck("s1", { ...input, ...bad })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        }
        expect(mgmt.sent).toHaveLength(0);
        await expect(mgmt.setSessionCronPrecheck("s1", { ...input, precheck: null })).resolves.toMatchObject({ status: "pending" });
    });

    it("never reports success for a missing or mismatched command result", async () => {
        const valid = { ok: true, precheck: input.precheck, revision: 3, appliesOn: "next_fire" };
        for (const result of [undefined, {}, { ...valid, ok: false }, { ...valid, revision: undefined },
            { ...valid, revision: 9 }, { ...valid, precheck: null }, { ...valid, appliesOn: undefined }]) {
            await expect(client({ result }).setSessionCronPrecheck("s1", input))
                .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
        }
    });
});

describe("1.0.83 operator PRECHECK selection", () => {
    const IDENTITY = { packageId: "pkg", versionId: "v2", sha256: "b".repeat(64) };
    const OPTIONS = [
        { name: "queue", kind: "worker" },
        { name: "pkg-queue", kind: "package", packageId: "pkg", packageIdentity: IDENTITY, packageBindingRevision: 5 },
    ];
    const armed = () => {
        const h = harness({ cronSchedule: undefined });
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 300, reason: SCHEDULE.reason, precheck: "queue", precheckOptions: OPTIONS });
        return h;
    };
    const change = (h, precheck, extra = {}) => h.command("set_cron_precheck", {
        precheck, expectedRevision: h.runtime.state.cronSchedule?.revision ?? 0, actor: "owner@example.com", reason: "use the package check", ...extra,
    });

    it("selects a package option, pins its identity, audits it, and the next fire uses it", () => {
        const h = armed();
        const response = change(h, "pkg-queue");
        expect(response).toMatchObject({ result: { ok: true, precheck: "pkg-queue", revision: 2, appliesOn: "next_fire" } });
        expect(h.runtime.state.cronSchedule).toMatchObject({
            precheck: "pkg-queue", precheckPackageId: "pkg", precheckIdentity: IDENTITY, precheckBindingRevision: 5, revision: 2,
            operatorPrecheck: { name: "pkg-queue", actor: "owner@example.com", reason: "use the package check" },
        });
        expect(h.eventData("session.cron_precheck_changed")).toEqual([{
            actor: "owner@example.com", reason: "use the package check", before: "queue", after: "pkg-queue", kind: "package", revision: 2,
        }]);
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks[0]).toMatchObject({ precheck: "pkg-queue", packageId: "pkg", packageIdentity: IDENTITY, packageBindingRevision: 5 });
    });

    it("None removes the precheck, so every wake-up reaches the model", () => {
        const h = armed();
        expect(change(h, null).result).toMatchObject({ ok: true, precheck: null });
        expect(h.runtime.state.cronSchedule.precheck).toBeUndefined();
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks).toHaveLength(0);
        expect(h.turns).toHaveLength(1);
    });

    it("rejects a stale revision, an unlisted name, a missing reason, and wall-clock schedules", () => {
        const h = armed();
        expect(change(h, "pkg-queue", { expectedRevision: 0 }).error).toMatch(/^STALE:/);
        expect(change(h, "other-agent-check").error).toMatch(/Unknown precheck/);
        expect(change(h, "pkg-queue", { reason: "  " }).error).toMatch(/reason/);
        expect(h.runtime.state.cronSchedule).toMatchObject({ precheck: "queue", revision: 1 });
        expect(h.runtime.state.cronSchedule.operatorPrecheck).toBeUndefined();

        const none = harness({ cronSchedule: undefined });
        expect(change(none, "queue").error).toMatch(/active interval cron/);
    });

    it("survives the agent re-arming the cron and continue-as-new; cancel clears it", () => {
        const h = armed();
        change(h, "pkg-queue");
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 120, reason: SCHEDULE.reason, precheck: "queue", precheckOptions: OPTIONS });
        expect(h.runtime.state.cronSchedule).toMatchObject({ intervalSeconds: 120, precheck: "pkg-queue", precheckIdentity: IDENTITY, revision: 3 });
        const next = buildContinueInput(h.runtime);
        expect(next.cronSchedule.operatorPrecheck).toMatchObject({ name: "pkg-queue" });
        expect(next.cronSchedule.precheckOptions).toEqual(OPTIONS);

        change(h, null);
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 120, reason: SCHEDULE.reason, precheck: "queue", precheckOptions: OPTIONS });
        expect(h.runtime.state.cronSchedule.precheck).toBeUndefined();

        applyCronAction(h.runtime, { type: "cron", action: "cancel" });
        expect(h.runtime.state.cronSchedule).toBeUndefined();
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 60, reason: "poll", precheck: "queue" });
        expect(h.runtime.state.cronSchedule).toEqual({ intervalSeconds: 60, reason: "poll", precheck: "queue", revision: 1 });
    });

    it("publishes the selection, its source, revision, options and health for the session view", () => {
        const h = armed();
        change(h, "pkg-queue");
        expect(h.statuses.at(-1)).toMatchObject({
            cronPrecheck: "pkg-queue",
            cronPrecheckSource: "operator",
            cronRevision: 2,
            cronPrecheckOptions: [{ name: "queue", kind: "worker" }, { name: "pkg-queue", kind: "package" }],
        });
        expect(JSON.stringify(h.statuses.at(-1))).not.toContain(IDENTITY.sha256);
    });

    it("tracks a broken streak without rolling back, and clears it only on the next real run/skip answer", () => {
        const h = harness();
        h.fire({ skip: false, outcome: "error", precheck: "queue" });
        h.fire({ skip: false, outcome: "timeout", precheck: "queue" });
        expect(h.turns).toHaveLength(2);
        expect(h.runtime.state.cronSchedule).toMatchObject({ precheck: "queue", precheckHealth: { outcome: "timeout", count: 2 } });
        const since = h.runtime.state.cronSchedule.precheckHealth.since;
        expect(Number.isFinite(since)).toBe(true);
        expect(h.prechecks.map(p => p.previouslyBroken)).toEqual([undefined, true]);

        // max_skips never calls the precheck, so it neither proves recovery nor extends the streak.
        h.fire({ skip: false, outcome: "max_skips", precheck: "queue" });
        expect(h.runtime.state.cronSchedule.precheckHealth).toEqual({ outcome: "timeout", since, count: 2 });
        h.fire({ skip: false, outcome: "invalid", precheck: "queue" });
        expect(h.runtime.state.cronSchedule.precheckHealth).toEqual({ outcome: "invalid", since, count: 3 });
        expect(h.prechecks.slice(2).map(p => p.previouslyBroken)).toEqual([true, true]);
        h.fire({ skip: true, outcome: "skip", precheck: "queue" });
        expect(h.prechecks.at(-1).previouslyBroken).toBe(true);
        expect(h.runtime.state.cronSchedule.precheckHealth).toBeUndefined();
        expect(h.runtime.state.cronSchedule.precheck).toBe("queue");
    });
});
