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
const DEV = { provider: "test", subject: "cat-tools-dev", email: "dev@example.invalid", displayName: "Dev" };
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
                // The page embeds no contract; the draw arms one explicitly.
                { name: "draw_canvas", args: { html: page(shared, "", ws), responseContract: { actions: { pick: { row: "number" } } } } },
                { name: "publish_canvas_app", args: { name: shared, description: DESCRIPTION } },
                { name: "find_canvas_app", args: { name: shared } },
                { name: "manage_canvas_app", args: { action: "share", name: shared } },
                { name: "draw_canvas", args: { html: page(secret) } },
                { name: "publish_canvas_app", args: { name: secret, description: DESCRIPTION } },
                { name: "draw_canvas", args: { fromApp: { name: shared } } },
                // A disabled app is not drawn, not even by its owner (R15).
                { name: "manage_canvas_app", args: { action: "disable", name: shared } },
                { name: "draw_canvas", args: { fromApp: { name: shared }, slot: 2 } },
                { name: "manage_canvas_app", args: { action: "enable", name: shared } },
                // Review T01: Dev becomes a contributor of the shared app.
                { name: "manage_canvas_app", args: { action: "add_contributor", name: shared, user: { provider: DEV.provider, subject: DEV.subject } } },
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
                // Review G3: another user's page on a slot is not republished as Bob's own app,
                // neither the fromApp draw (slot 1) nor an inline copy of the same bytes (slot 3).
                { name: "publish_canvas_app", args: { name: `bob-copy-${env.runId}`, description: DESCRIPTION, slot: 1 } },
                { name: "publish_canvas_app", args: { name: `bob-copy3-${env.runId}`, description: DESCRIPTION, slot: 3 } },
            ]),
        };
        // Dev (a contributor, review T01): draws Alice's shared app and publishes into it,
        // first the unchanged page, then an edited page that keeps Alice's workspace block.
        scripts.dev = toolTurn([
            { name: "draw_canvas", args: { fromApp: { name: shared } } },
            { name: "publish_canvas_app", args: { name: shared, scope: "shared", description: DESCRIPTION, slot: 1 } },
            { name: "draw_canvas", args: { html: page(shared, "<p>edited by a contributor</p>", ws), slot: 2 } },
            { name: "publish_canvas_app", args: { name: shared, scope: "shared", description: DESCRIPTION, slot: 2 } },
        ]);
        const respond = (body, position) => {
            const who = position.firstUserText.includes("bob") ? "bob" : position.firstUserText.includes("dev") ? "dev" : "alice";
            const step = scripts[who][position.step];
            if (!step) return { content: "ok" };
            return typeof step === "function" ? step(body, position) : step;
        };

        await withScriptedModel(env, { respond }, async ({ client, qualifiedModel }) => {
            // A contributor must have signed in before they can be added. The CMS schema exists
            // only once the worker has started (inside withScriptedModel), so register Dev here.
            {
                const c = new pg.Client({ connectionString: env.store });
                await c.connect();
                try { await c.query(`SELECT "${env.cmsSchema}".cms_register_user($1, $2, $3, $4)`, [DEV.provider, DEV.subject, DEV.email, DEV.displayName]); } finally { await c.end(); }
            }
            const alice = await client.createSession({ model: qualifiedModel, owner: ALICE });
            const aliceResults = JSON.parse(await alice.sendAndWait("alice", TIMEOUT));
            const published = JSON.parse(aliceResults[1]);
            assertEqual(published.scope, "user", "private by default");
            assertEqual(published.version, "1.0.0");
            const card = JSON.parse(aliceResults[2]);
            assertEqual(card.app.name, shared);
            assert(card.app.card?.interface, "find by name returns the full card with its interface");
            assertEqual(JSON.parse(aliceResults[3]).scope, "shared");
            assert(String(aliceResults[8]).includes("APP_DISABLED"), `the owner cannot draw a disabled app: ${aliceResults[8]}`);
            assert(JSON.parse(aliceResults[10]).contributors?.includes(`${DEV.provider}:${DEV.subject}`), `Dev is a contributor: ${aliceResults[10]}`);

            const aliceEvents = await canvasEvents(env, alice.sessionId);
            const ownRedraw = aliceEvents.at(-1);
            assertEqual(ownRedraw.trust, "owner", "Alice drawing her own app is owner trust");
            assertEqual(ownRedraw.source?.kind, "app");
            assertEqual(JSON.stringify(ownRedraw.responseContract), JSON.stringify({ actions: { pick: { row: "number" } } }),
                "fromApp arms the contract recorded at publish, not only the page's embedded one");
            assertEqual(aliceEvents[0].trust, "agent", "a page drawn before it was published is agent trust");

            const bob = await client.createSession({ model: qualifiedModel, owner: BOB });
            const bobResults = JSON.parse(await bob.sendAndWait("bob", TIMEOUT));
            const found = JSON.parse(bobResults[0]);
            assert(found.apps.some((a) => a.name === shared), "Bob finds the shared app");
            assert(!found.apps.some((a) => a.name === secret), "Bob does not find Alice's private app");
            assert(String(bobResults[2]).includes("NOT_FOUND"), `private app is NOT_FOUND to Bob: ${bobResults[2]}`);
            assert(String(bobResults[6]).includes("FORBIDDEN"), `Bob cannot delete Alice's shared app: ${bobResults[6]}`);
            assert(String(bobResults[7]).includes("another user"), `Bob's agent does not publish Alice's app from the slot: ${bobResults[7]}`);
            assert(String(bobResults[8]).includes("another user"), `nor an inline copy of her bytes: ${bobResults[8]}`);
            const copies = await (async () => {
                const c = new pg.Client({ connectionString: env.store });
                await c.connect();
                try { return (await c.query(`SELECT name FROM "${env.cmsSchema}".canvas_apps WHERE name LIKE 'bob-copy%'`)).rows; } finally { await c.end(); }
            })();
            assertEqual(copies.length, 0, "no copy was published");

            const bobEvents = await canvasEvents(env, bob.sessionId);
            const bySlot = (slot) => bobEvents.filter((e) => e.slot === slot).at(-1);
            assertEqual(bySlot(1).trust, "cross-owner", "Alice's app drawn by Bob");
            assertEqual(bySlot(1).app?.name, shared);
            assertEqual(bySlot(3).trust, "cross-owner", "an inline copy of the same bytes is still Alice's");
            assertEqual(bySlot(4).trust, "cross-owner", "an edited copy that keeps Alice's workspace block is still cross-owner");
            assertEqual(bySlot(4).app, undefined, "the workspace rule never attributes an app");
            assertEqual(bySlot(5).trust, "agent", "Bob's own new page behaves as today");

            const dev = await client.createSession({ model: qualifiedModel, owner: DEV });
            const devResults = JSON.parse(await dev.sendAndWait("dev", TIMEOUT));
            const devSame = JSON.parse(devResults[1]);
            assert(!devSame.error, `a contributor publishes the shared app's own page without refusal: ${devResults[1]}`);
            assertEqual(devSame.unchanged, true, "the same bytes are the existing version");
            const devEdit = JSON.parse(devResults[3]);
            assert(!devEdit.error, `a contributor publishes an edited page that keeps the workspace block: ${devResults[3]}`);
            assertEqual(devEdit.published, true);
            assertEqual(devEdit.scope, "shared");

            const rows = await loads(env);
            const forShared = rows.filter((r) => r.app_name === shared);
            assertEqual(forShared.length, 3, `one load per fromApp draw (Alice's redraw, Bob's and Dev's), inline draws none: ${JSON.stringify(forShared)}`);
            assert(forShared.some((r) => r.user_subject === BOB.subject && r.session_id === bob.sessionId), "Bob's load names Bob and his session");
        });
    });
});
