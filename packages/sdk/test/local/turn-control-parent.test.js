/**
 * Session turn control: a parent agent steers or stops its sub-agent's
 * running turn (message_agent deliver "now", stop_agent_turn; design 4.13).
 *
 * Real worker, PostgreSQL, Duroxide and Copilot CLI with the scripted model:
 * the test decides each tool call of the parent and the child, so every case
 * is deterministic. The child is a direct child session of the parent (the
 * same catalog link spawn_agent creates); it blocks in a test tool so its
 * turn is running when the parent acts.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForEventCount, waitForSessionState } from "../helpers/cms-helpers.js";
import { setClusterFeature, withScriptedModel } from "../helpers/scripted-workers.js";
import { messageText } from "../helpers/scripted-model.mjs";
import { createManagementClient, defineTool } from "../helpers/local-workers.js";
import { pinSessionStartVersion, sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { parentControlRequestId } from "../../src/parent-turn-control.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const WAIT = 120_000;

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};

/** A child tool that holds the child's turn until the test releases it. */
function blockingTool() {
    const started = deferred();
    const released = deferred();
    return {
        started: started.promise,
        release() { released.resolve(); },
        tool: defineTool("tc_p_block", {
            description: "Wait for the test to release this step.",
            parameters: { type: "object", properties: {} },
            handler: async () => { started.resolve(); await released.promise; return "released"; },
        }),
    };
}

/**
 * The scripted model. The parent's turns that open with "PTC-ACT" call the
 * tools in `plan.parent`; the child calls tc_p_block for "PTC-BLOCK" and
 * answers each other prompt with a marker the test can find.
 */
function responder(plan) {
    return (_body, position) => {
        if (position.firstUserText.includes("PTC-PARENT")) {
            return position.step === 0 && position.lastUserText.includes("PTC-ACT")
                ? { tools: plan.parent }
                : { content: "parent done" };
        }
        if (position.lastUserText.includes("PTC-STEER")) return { content: "child followed the steer" };
        if (position.lastUserText.includes("PTC-BLOCK") && position.step === 0) return { tools: [{ name: "tc_p_block", args: {} }] };
        if (position.lastUserText.includes("PTC-NEXT")) return { content: "child ran the next message" };
        return { content: "child done" };
    };
}

/** Each parent tool call's result text, in call order, with the call's tool call id. */
function parentToolResults(model) {
    const out = [];
    for (const request of model.sessionRequests("PTC-PARENT")) {
        const asked = request.answer?.tools;
        if (!asked?.length) continue;
        const next = model.sessionRequests("PTC-PARENT").find((r) => r.index > request.index && r.position.toolResults.length > 0);
        asked.forEach((call, i) => {
            const toolCallId = `fixture-${request.index}-${i}`;
            const message = next?.body.messages.find((m) => m.role === "tool" && m.tool_call_id === toolCallId);
            out.push({ name: call.name, toolCallId, result: message ? messageText(message) : "" });
        });
    }
    return out;
}

async function controls(catalog, sessionId, type) {
    return (await catalog.getSessionEvents(sessionId)).filter((e) => e.eventType === type);
}

async function waitForChildRequest(model, marker) {
    const deadline = Date.now() + WAIT;
    while (Date.now() < deadline) {
        if (model.requests.some((r) => r.session && !r.position.firstUserText.includes("PTC-PARENT") && r.position.lastUserText.includes(marker))) return;
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`the child never ran a turn with ${marker}`);
}

/** Parent and child sessions on one worker; `fn` gets them and the helpers. */
async function withFamily(env, { steering = true, legacyChild = false } = {}, fn) {
    const plan = { parent: [] };
    const block = blockingTool();
    await withScriptedModel(env, { tools: [block.tool], respond: responder(plan) }, async ({ client, model, qualifiedModel }) => {
        // After the scripted provider is the cluster default. The management
        // client reads the flag on every Steer.
        await setClusterFeature(env, "sessions.steering", steering);
        const catalog = await createCatalog(env);
        const mgmt = await createManagementClient(env);
        const childId = randomUUID();
        const pin = legacyChild ? pinSessionStartVersion(client, "1.0.80", { sessionId: childId }) : null;
        try {
            const parent = await client.createSession({ model: qualifiedModel, tools: [block.tool] });
            expect(await parent.sendAndWait("PTC-PARENT start", WAIT)).toContain("parent done");
            const child = await client.createSession({ sessionId: childId, parentSessionId: parent.sessionId, model: qualifiedModel, tools: [block.tool] });
            const act = async (tools) => {
                plan.parent = tools;
                return parent.sendAndWait(`PTC-ACT ${randomUUID()}`, WAIT);
            };
            await fn({ client, model, qualifiedModel, catalog, mgmt, parent, child, block, act });
        } finally {
            block.release();
            pin?.restore();
            await mgmt.stop?.();
            await catalog.close();
        }
    });
}

describe("turn control: a parent agent steers or stops its sub-agent's turn", () => {
    it("deliver now steers the running child turn once, from the parent agent; the same tool call records nothing new", { timeout: TIMEOUT }, async () => {
        await withFamily(getEnv(), {}, async ({ model, catalog, mgmt, parent, child, block, act }) => {
            await child.send("PTC-BLOCK run the blocking step", { requiredTool: "tc_p_block" });
            await block.started;
            await act([{ name: "message_agent", args: { agent_id: child.sessionId, message: "PTC-STEER use metric units", deliver: "now" } }]);

            const [steer] = await waitForEventCount(catalog, child.sessionId, "user.steer", 1);
            const [call] = parentToolResults(model);
            expect(call.result).toContain(`Steered into the running turn of sub-agent session-${child.sessionId} (control seq ${steer.seq})`);
            expect(steer.data).toMatchObject({ text: "PTC-STEER use metric units", actor: { kind: "agent", sessionId: parent.sessionId } });
            expect(typeof steer.data.actor.display).toBe("string");
            expect(steer.data.requestId).toBe(parentControlRequestId("steer", parent.sessionId, call.toolCallId));

            block.release();
            const [outcome] = await waitForEventCount(catalog, child.sessionId, "session.control_outcome", 1);
            expect(outcome.data).toMatchObject({ seq: steer.seq, outcome: "delivered" });
            await waitForSessionState(catalog, child.sessionId, "idle", WAIT);
            const childRequests = model.requests.filter((r) => r.session && r.position.firstUserText.includes("PTC-BLOCK"));
            const lastMessages = childRequests.at(-1).body.messages.filter((m) => m.role === "user" && JSON.stringify(m.content).includes("PTC-STEER"));
            expect(lastMessages).toHaveLength(1);
            expect(childRequests.at(-1).answer).toEqual({ content: "child followed the steer" });

            // The same tool call again: the catalog answers the first result.
            const replay = await mgmt.steerSessionTurn(child.sessionId, {
                text: "PTC-STEER use metric units", requestId: steer.data.requestId, caller: { sender: steer.data.actor },
            });
            expect(replay).toEqual({ outcome: "accepted", steerId: steer.seq, turn: steer.data.turn, repeat: true });
            expect(await controls(catalog, child.sessionId, "user.steer")).toHaveLength(1);
            expect(await controls(catalog, child.sessionId, "session.control_outcome")).toHaveLength(1);
        });
    });

    it("stop_agent_turn stops the child's turn; the child stays alive and runs the next message", { timeout: TIMEOUT }, async () => {
        await withFamily(getEnv(), {}, async ({ model, catalog, parent, child, block, act }) => {
            await child.send("PTC-BLOCK run the blocking step", { requiredTool: "tc_p_block" });
            await block.started;
            await act([{ name: "stop_agent_turn", args: { agent_id: `session-${child.sessionId}`, reason: "wrong file" } }]);

            const [stop] = await controls(catalog, child.sessionId, "user.stop");
            expect(stop.data).toMatchObject({ text: "wrong file", actor: { kind: "agent", sessionId: parent.sessionId } });
            const [call] = parentToolResults(model);
            expect(call.result).toContain(`Stopped the current turn of sub-agent session-${child.sessionId} (control seq ${stop.seq})`);
            const outcomes = (await controls(catalog, child.sessionId, "session.control_outcome")).filter((e) => e.data.seq === stop.seq);
            expect(outcomes.map((e) => e.data.outcome)).toEqual(["stopped"]);
            const row = await waitForSessionState(catalog, child.sessionId, "idle", WAIT);
            expect(row.activeTurnIndex).toBeNull();

            block.release();
            await act([{ name: "message_agent", args: { agent_id: child.sessionId, message: "PTC-NEXT after the stop" } }]);
            await waitForChildRequest(model, "PTC-NEXT after the stop");
            await waitForSessionState(catalog, child.sessionId, "idle", WAIT);
            expect(parentToolResults(model)[1].result).toContain(`Message sent to sub-agent session-${child.sessionId}`);
        });
    });

    it("deliver now with no running child turn queues the message for the next turn", { timeout: TIMEOUT }, async () => {
        await withFamily(getEnv(), {}, async ({ model, catalog, child, act }) => {
            expect(await child.sendAndWait("PTC-HELLO", WAIT)).toContain("child done");
            await act([{ name: "message_agent", args: { agent_id: child.sessionId, message: "PTC-NEXT idle child", deliver: "now" } }]);
            expect(parentToolResults(model)[0].result).toContain(`Not steered: the sub-agent had no running turn. Queued the message for the next turn of sub-agent session-${child.sessionId}`);
            await waitForChildRequest(model, "PTC-NEXT idle child");
            expect(await controls(catalog, child.sessionId, "user.steer")).toEqual([]);
        });
    });

    it("deliver now with steering off for the owner queues the message for the next turn", { timeout: TIMEOUT }, async () => {
        await withFamily(getEnv(), { steering: false }, async ({ model, catalog, child, block, act }) => {
            await child.send("PTC-BLOCK run the blocking step", { requiredTool: "tc_p_block" });
            await block.started;
            await act([{ name: "message_agent", args: { agent_id: child.sessionId, message: "PTC-NEXT steering off", deliver: "now" } }]);
            expect(parentToolResults(model)[0].result).toContain("Not steered: steering is turned off for this session's owner.");
            block.release();
            await waitForChildRequest(model, "PTC-NEXT steering off");
            expect(await controls(catalog, child.sessionId, "user.steer")).toEqual([]);
        });
    });

    it("a legacy (1.0.80) child: deliver now queues for the next turn and stop_agent_turn takes the earlier Stop path", { timeout: TIMEOUT }, async () => {
        await withFamily(getEnv(), { legacyChild: true }, async ({ client, model, catalog, child, block, act }) => {
            await child.send("PTC-BLOCK run the blocking step", { requiredTool: "tc_p_block" });
            await block.started;
            expect(await sessionOrchestrationVersion(client, child.sessionId)).toBe("1.0.80");
            await act([{ name: "message_agent", args: { agent_id: child.sessionId, message: "PTC-NEXT legacy child", deliver: "now" } }]);
            expect(parentToolResults(model)[0].result).toContain("Not steered: the sub-agent's running turn does not take steers");
            await act([{ name: "stop_agent_turn", args: { agent_id: child.sessionId } }]);
            expect(parentToolResults(model)[1].result).toContain(`Stopped the current turn of sub-agent session-${child.sessionId}.`);
            // The earlier path records no control and no sender (4.13).
            expect(await controls(catalog, child.sessionId, "user.stop")).toEqual([]);
            await waitForEventCount(catalog, child.sessionId, "session.turn_stopped", 1);
            block.release();
            await waitForChildRequest(model, "PTC-NEXT legacy child");
            expect(await controls(catalog, child.sessionId, "user.steer")).toEqual([]);
        });
    });

    it("an unknown or foreign agent id is refused and records nothing", { timeout: TIMEOUT }, async () => {
        await withFamily(getEnv(), {}, async ({ client, model, qualifiedModel, catalog, block, act }) => {
            const foreign = await client.createSession({ model: qualifiedModel, tools: [block.tool] });
            await foreign.send("PTC-BLOCK run the blocking step", { requiredTool: "tc_p_block" });
            await block.started;
            const unknown = randomUUID();
            await act([
                { name: "message_agent", args: { agent_id: foreign.sessionId, message: "PTC-STEER foreign", deliver: "now" } },
                { name: "stop_agent_turn", args: { agent_id: foreign.sessionId } },
                { name: "stop_agent_turn", args: { agent_id: unknown } },
            ]);
            const results = parentToolResults(model).map((r) => r.result);
            expect(results[0]).toMatch(new RegExp(`^\\[SYSTEM: message_agent failed: agent "session-${foreign.sessionId}" not found`));
            expect(results[1]).toMatch(new RegExp(`^\\[SYSTEM: stop_agent_turn failed: agent "session-${foreign.sessionId}" not found`));
            expect(results[2]).toMatch(new RegExp(`^\\[SYSTEM: stop_agent_turn failed: agent "session-${unknown}" not found`));
            expect(await controls(catalog, foreign.sessionId, "user.steer")).toEqual([]);
            expect(await controls(catalog, foreign.sessionId, "user.stop")).toEqual([]);
            block.release();
            await waitForSessionState(catalog, foreign.sessionId, "idle", WAIT);
            expect(model.requests.some((r) => JSON.stringify(r.body.messages).includes("PTC-STEER foreign") && !r.position.firstUserText.includes("PTC-PARENT"))).toBe(false);
        });
    });
});
