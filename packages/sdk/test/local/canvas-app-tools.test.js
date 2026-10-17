/**
 * Canvas app registry: the agent tools end to end (issue 181, plan r5 phase 4a).
 *
 * A real worker with the real Copilot CLI runs scripted turns (no live model):
 * Alice's agent draws a page, publishes it (private by default), finds it by
 * name, shares it; Bob's agent finds and draws it with fromApp (cross-owner,
 * one load row); Bob cannot see Alice's private app; Alice's own redraw is
 * owner trust; an inline copy of Bob-visible bytes is cross-owner; agent
 * pages stay agent trust.
 *
 * Run: npx vitest run test/local/canvas-app-tools.test.js
 */
import { describe, it } from "vitest";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";

const TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);

const ALICE = { provider: "test", subject: "cat-tools-alice", email: "alice@example.invalid", displayName: "Alice" };
const BOB = { provider: "test", subject: "cat-tools-bob", email: "bob@example.invalid", displayName: "Bob" };
const DESCRIPTION = "Use when testing the canvas app registry tools end to end.";

function page(title, extra = "", workspace = null) {
    const manifest = {
        name: title, description: DESCRIPTION,
        interface: { keys: [{ key: "app/rows/*", purpose: "rows" }], requests: [], events: [] },
        ...(workspace ? { workspace } : {}),
    };
    return `<!doctype html>\n<!-- CANVAS-APP-MANIFEST ${JSON.stringify(manifest)} -->\n<html><body><h1>${title}</h1>${extra}</body></html>\n`;
}

/**
 * One scripted turn that calls the tools in order, one per step, and answers
 * with every result as JSON. position.toolResults holds only the results since
 * the last assistant message, so each step collects the previous step's result.
 */
function toolTurn(calls) {
    const results = [];
    const steps = [{ tools: [calls[0]] }];
    for (let i = 1; i <= calls.length; i++) {
        steps.push((_body, position) => {
            results.push(...position.toolResults);
            return i < calls.length ? { tools: [calls[i]] } : { content: JSON.stringify(results) };
        });
    }
    return steps;
}

async function canvasEvents(env, sessionId) {
    const client = new pg.Client({ connectionString: env.store });
    await client.connect();
    try {
        const { rows } = await client.query(
            `SELECT data FROM "${env.cmsSchema}".session_events WHERE session_id = $1 AND event_type = 'session.canvas_updated' ORDER BY seq`,
            [sessionId],
        );
        return rows.map((r) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data));
    } finally {
        await client.end();
    }
}

async function loads(env) {
    const client = new pg.Client({ connectionString: env.store });
    await client.connect();
    try {
        const { rows } = await client.query(`SELECT app_name, version, session_id, user_subject FROM "${env.cmsSchema}".canvas_app_loads ORDER BY load_id`);
        return rows;
    } finally {
        await client.end();
    }
}

describe("canvas app registry: agent tools", () => {
    it("publish private, find by name, share, draw fromApp across owners, trust and loads", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const shared = `cat-tools-${env.runId}`;
        const secret = `cat-secret-${env.runId}`;
        const ws = { read: ["work/**"] };
        // One script per person, chosen by the session's first prompt: each
        // session's first turn is turn 1, so a turn index cannot tell them apart.
        const scripts = {
            // Alice: draw, publish (private), find by name, share.
            alice: toolTurn([
                { name: "draw_canvas", args: { html: page(shared, "", ws) } },
                { name: "publish_canvas_app", args: { name: shared, description: DESCRIPTION } },
                { name: "find_canvas_app", args: { name: shared } },
                { name: "manage_canvas_app", args: { action: "share", name: shared } },
                { name: "draw_canvas", args: { html: page(secret) } },
                { name: "publish_canvas_app", args: { name: secret, description: DESCRIPTION } },
                { name: "draw_canvas", args: { fromApp: { name: shared } } },
            ]),
            // Bob: search, draw Alice's shared app, try her private one, copy her shared bytes inline, draw his own page.
            bob: toolTurn([
                { name: "find_canvas_app", args: { query: "registry tools end to end" } },
                { name: "draw_canvas", args: { fromApp: { name: shared } } },
                { name: "draw_canvas", args: { fromApp: { name: secret }, slot: 2 } },
                { name: "draw_canvas", args: { html: page(shared, "", ws), slot: 3 } },
                { name: "draw_canvas", args: { html: page(shared, "<p>one byte more</p>", ws), slot: 4 } },
                { name: "draw_canvas", args: { html: page(`bob-own-${env.runId}`), slot: 5 } },
                { name: "manage_canvas_app", args: { action: "delete", name: shared, scope: "shared", confirm: true } },
            ]),
        };
        const respond = (body, position) => {
            const who = position.firstUserText.includes("bob") ? "bob" : "alice";
            const step = scripts[who][position.step];
            if (!step) return { content: "ok" };
            return typeof step === "function" ? step(body, position) : step;
        };

        await withScriptedModel(env, { respond }, async ({ client, qualifiedModel }) => {
            const alice = await client.createSession({ model: qualifiedModel, owner: ALICE });
            const aliceResults = JSON.parse(await alice.sendAndWait("alice", TIMEOUT));
            const published = JSON.parse(aliceResults[1]);
            assertEqual(published.scope, "user", "private by default");
            assertEqual(published.version, "1.0.0");
            const card = JSON.parse(aliceResults[2]);
            assertEqual(card.app.name, shared);
            assert(card.app.card?.interface, "find by name returns the full card with its interface");
            assertEqual(JSON.parse(aliceResults[3]).scope, "shared");

            const aliceEvents = await canvasEvents(env, alice.sessionId);
            const ownRedraw = aliceEvents.at(-1);
            assertEqual(ownRedraw.trust, "owner", "Alice drawing her own app is owner trust");
            assertEqual(ownRedraw.source?.kind, "app");
            assertEqual(aliceEvents[0].trust, "agent", "a page drawn before it was published is agent trust");

            const bob = await client.createSession({ model: qualifiedModel, owner: BOB });
            const bobResults = JSON.parse(await bob.sendAndWait("bob", TIMEOUT));
            const found = JSON.parse(bobResults[0]);
            assert(found.apps.some((a) => a.name === shared), "Bob finds the shared app");
            assert(!found.apps.some((a) => a.name === secret), "Bob does not find Alice's private app");
            assert(String(bobResults[2]).includes("NOT_FOUND"), `private app is NOT_FOUND to Bob: ${bobResults[2]}`);
            assert(String(bobResults[6]).includes("FORBIDDEN"), `Bob cannot delete Alice's shared app: ${bobResults[6]}`);

            const bobEvents = await canvasEvents(env, bob.sessionId);
            const bySlot = (slot) => bobEvents.filter((e) => e.slot === slot).at(-1);
            assertEqual(bySlot(1).trust, "cross-owner", "Alice's app drawn by Bob");
            assertEqual(bySlot(1).app?.name, shared);
            assertEqual(bySlot(3).trust, "cross-owner", "an inline copy of the same bytes is still Alice's");
            assertEqual(bySlot(4).trust, "cross-owner", "an edited copy that keeps Alice's workspace block is still cross-owner");
            assertEqual(bySlot(4).app, undefined, "the workspace rule never attributes an app");
            assertEqual(bySlot(5).trust, "agent", "Bob's own new page behaves as today");

            const rows = await loads(env);
            const forShared = rows.filter((r) => r.app_name === shared);
            assertEqual(forShared.length, 2, `one load per fromApp draw (Alice's redraw and Bob's), inline draws none: ${JSON.stringify(forShared)}`);
            assert(forShared.some((r) => r.user_subject === BOB.subject && r.session_id === bob.sessionId), "Bob's load names Bob and his session");
        });
    });
});
