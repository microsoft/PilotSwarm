/**
 * The canvas app transition (issue 181), part L1: the old `apps/<name>`
 * catalog next to the registry.
 *
 * A real worker with the real Copilot CLI runs scripted turns (no live
 * model). With PILOTSWARM_CANVAS_LEGACY_MODE on, find_canvas_app returns old
 * cards in their old shape (legacy: true, key, source) next to registry apps,
 * a registry app of the same name wins, find by name falls back to the old
 * card, and agents write apps/* facts as before. With it off, none of that.
 * The exemption cutoff is the registry migration's applied_at minus 5
 * minutes: only cards last written no later than that keep the old rules.
 * The cutoff is checked with the facts store's own timestamps (no raw SQL),
 * so it holds on any storage layout, including facts on a separate server.
 *
 * Run: npx vitest run test/local/canvas-legacy-bridge.test.js
 */
import { describe, it } from "vitest";
import { createHash } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { CanvasLegacyCatalog, CANVAS_LEGACY_CUTOFF_MARGIN_MS, canvasLegacyCatalogFor, PilotSwarmManagementClient } from "../../src/index.ts";

const TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);

const ALICE = { provider: "test", subject: "legacy-bridge-alice", email: "alice@example.invalid", displayName: "Alice" };
const BOB = { provider: "test", subject: "legacy-bridge-bob", email: "bob@example.invalid", displayName: "Bob" };
const DESCRIPTION = "Use when testing the old canvas app catalog next to the registry.";

function page(title) {
    const manifest = { name: title, description: DESCRIPTION, interface: { keys: [{ key: "app/rows/*", purpose: "rows" }], requests: [], events: [] } };
    return `<!doctype html>\n<!-- CANVAS-APP-MANIFEST ${JSON.stringify(manifest)} -->\n<html><body><h1>${title}</h1></body></html>\n`;
}

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

/** An old catalog card, written the way main's publish_canvas_app wrote it. */
async function seedLegacyCard(factStore, artifactStore, name) {
    const html = page(name);
    const sha256 = createHash("sha256").update(html, "utf8").digest("hex");
    const sourceSession = `00000000-0000-4000-8000-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
    const filename = `app-${name}.html`;
    await artifactStore.uploadArtifact(sourceSession, filename, html, "text/html", { pinned: true });
    await factStore.storeFact({
        key: `apps/${name}`, shared: true, tags: ["canvas-app"],
        value: { name, description: DESCRIPTION, version: "1.0.0", tags: ["legacy"], kv: { write: "owner", shared: [] }, source: { sessionId: sourceSession, filename, sha256 }, card: { name } },
    });
    return { html, sha256, sourceSession, filename };
}

/** The card's updated_at, as the facts store's own procedure returns it. */
async function factUpdatedAt(factStore, key) {
    const res = await factStore.readFacts({ scopeKeys: [`shared:${key}`], scope: "shared", limit: 1 });
    const at = res.facts.find((f) => f.key === key)?.updatedAt;
    return at instanceof Date ? at : new Date(at);
}

function scriptsFor(names) {
    const alice = toolTurn([
        { name: "draw_canvas", args: { html: page(names.shadow) } },
        { name: "publish_canvas_app", args: { name: names.shadow, description: DESCRIPTION } },
        { name: "find_canvas_app", args: { query: "old canvas app catalog next to the registry", limit: 20 } },
        { name: "find_canvas_app", args: { name: names.legacy } },
        { name: "find_canvas_app", args: { name: names.shadow } },
        { name: "store_fact", args: { key: `apps/${names.legacy}/publication`, value: { appName: names.legacy }, shared: true } },
        { name: "delete_fact", args: { key: `apps/${names.legacy}/publication`, shared: true } },
        // Review F3/R2: Alice shares, then disables, the registry app with an old card's name.
        { name: "manage_canvas_app", args: { action: "share", name: names.shadow } },
        { name: "manage_canvas_app", args: { action: "disable", name: names.shadow } },
    ]);
    // Bob does not see a disabled shared app in the registry's search, and its
    // lookup answers APP_DISABLED: the registry still has it, so it wins.
    const bob = toolTurn([
        { name: "find_canvas_app", args: { query: "old canvas app catalog next to the registry", limit: 20 } },
        { name: "find_canvas_app", args: { name: names.shadow } },
    ]);
    return { alice, bob };
}

function responder(scripts) {
    return (body, position) => {
        const steps = position.firstUserText.includes("bob") ? scripts.bob : scripts.alice;
        const step = steps[position.step];
        if (!step) return { content: "ok" };
        return typeof step === "function" ? step(body, position) : step;
    };
}

describe("canvas app transition: the old catalog next to the registry", () => {
    it("on: old cards are found in their old shape, the registry wins by name, apps/* is writable, and only pre-registry cards exempt", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const names = { legacy: `old-board-${env.runId}`, shadow: `both-${env.runId}` };
        const respond = responder(scriptsFor(names));
        await withScriptedModel(env, { respond, worker: { canvasLegacyMode: true } }, async ({ client, qualifiedModel, worker }) => {
            const factStore = worker.factStore;
            const registry = worker._catalog.canvasApps;
            const legacy = await seedLegacyCard(factStore, worker.artifactStore, names.legacy);
            await seedLegacyCard(factStore, worker.artifactStore, names.shadow);

            const alice = await client.createSession({ model: qualifiedModel, owner: ALICE });
            const results = JSON.parse(await alice.sendAndWait("alice", TIMEOUT));

            const found = JSON.parse(results[2]);
            const old = found.apps.find((a) => a.name === names.legacy);
            assert(old, `the old card is found: ${results[2]}`);
            assertEqual(old.legacy, true);
            assertEqual(old.key, `apps/${names.legacy}`, "main's shape: key");
            assertEqual(old.source?.sha256, legacy.sha256, "main's shape: source");
            const both = found.apps.filter((a) => a.name === names.shadow);
            assertEqual(both.length, 1, `a name in both is listed once: ${results[2]}`);
            assertEqual(both[0].legacy, undefined, "the registry app wins");
            assertEqual(both[0].scope, "user");
            assert(/fromArtifact/.test(found.next), "the hint says how to draw an old app");

            const byName = JSON.parse(results[3]);
            assertEqual(byName.app.legacy, true, `find by name falls back to the old card: ${results[3]}`);
            assertEqual(byName.app.key, `apps/${names.legacy}`);
            assertEqual(byName.app.source.filename, legacy.filename);
            assert(byName.next.includes(legacy.sourceSession) && byName.next.includes("fromArtifact"), byName.next);

            const shadowByName = JSON.parse(results[4]);
            assertEqual(shadowByName.app.scope, "user", `by name, the registry app wins: ${results[4]}`);
            assertEqual(shadowByName.app.legacy, undefined);

            assert(!JSON.parse(results[5]).error, `apps/* is writable while the transition is on: ${results[5]}`);
            assert(!JSON.parse(results[6]).error, `and deletable: ${results[6]}`);

            assert(!JSON.parse(results[8]).error, `Alice disables her shared app: ${results[8]}`);
            const bob = await client.createSession({ model: qualifiedModel, owner: BOB });
            const bobResults = JSON.parse(await bob.sendAndWait("bob", TIMEOUT));
            const bobFound = JSON.parse(bobResults[0]);
            assert(!bobFound.apps.some((a) => a.name === names.shadow), `a disabled shared registry app still wins over its old card, for another user too: ${bobResults[0]}`);
            assert(bobFound.apps.some((a) => a.name === names.legacy && a.legacy), `the other old card is still found: ${bobResults[0]}`);
            assert(String(bobResults[1]).includes("APP_DISABLED"), `by name, no fallback to the old card: ${bobResults[1]}`);

            // The cutoff: the registry migration's applied_at, read from the CMS.
            const installedAt = await registry.installedAt();
            assert(installedAt instanceof Date, "the registry's install time is known");
            const key = `apps/${names.legacy}`;
            assertEqual(await new CanvasLegacyCatalog({ factStore, installedAt: () => registry.installedAt(), ttlMs: 0 }).isExemptSha256(legacy.sha256), false,
                "a card written after the registry was installed exempts nothing");
            // The rest uses the facts store's own clock for both sides of the comparison.
            const written = await factUpdatedAt(factStore, key);
            const cutoffAt = (deltaMs) => new CanvasLegacyCatalog({ factStore, installedAt: async () => new Date(written.getTime() + CANVAS_LEGACY_CUTOFF_MARGIN_MS + deltaMs), ttlMs: 0 });
            assertEqual(await cutoffAt(0).isExemptSha256(legacy.sha256), true, "written exactly 5 minutes before an install: exempt");
            assertEqual(await cutoffAt(-1).isExemptSha256(legacy.sha256), false, "1 ms less: not exempt");
            // Overwriting the old card (any write) moves it past that cutoff.
            await new Promise((resolve) => setTimeout(resolve, 5));
            await factStore.storeFact({ key, shared: true, value: { name: names.legacy, source: { sessionId: legacy.sourceSession, filename: legacy.filename, sha256: legacy.sha256 } } });
            assert((await factUpdatedAt(factStore, key)).getTime() > written.getTime(), "the database set a newer updated_at");
            assertEqual(await cutoffAt(0).isExemptSha256(legacy.sha256), false, "an overwritten old card no longer exempts");
        });
    });

    it("off: only the registry is searched, find by name has no fallback, and apps/* is not writable", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const names = { legacy: `old-board-off-${env.runId}`, shadow: `both-off-${env.runId}` };
        const respond = responder(scriptsFor(names));
        await withScriptedModel(env, { respond, worker: { canvasLegacyMode: false } }, async ({ client, qualifiedModel, worker }) => {
            await seedLegacyCard(worker.factStore, worker.artifactStore, names.legacy);
            await seedLegacyCard(worker.factStore, worker.artifactStore, names.shadow);
            const alice = await client.createSession({ model: qualifiedModel, owner: ALICE });
            const results = JSON.parse(await alice.sendAndWait("alice", TIMEOUT));
            const found = JSON.parse(results[2]);
            assert(!found.apps.some((a) => a.legacy || a.name === names.legacy), `no old card is found: ${results[2]}`);
            assert(String(results[3]).includes("NOT_FOUND"), `no fallback by name: ${results[3]}`);
            assertEqual(JSON.parse(results[4]).app.scope, "user");
            assert(String(results[5]).includes("legacy canvas app catalog"), `apps/* is not writable: ${results[5]}`);
            assert(String(results[6]).includes("legacy canvas app catalog"), `nor deletable: ${results[6]}`);
        });
    });
});

/**
 * L2: the server-side decisions about an old app's page, each made when the
 * page is used. The worker's old catalog is created here first (one per fact
 * store, first creation wins) with no cache and an install time after the
 * cards, so a card change shows on the next use.
 */
function pagesTurns(scripts) {
    // The prompt that opened the turn (lastUserText) can carry injected
    // notes, so each script is picked by a unique token the prompt includes;
    // no token is a substring of another. A prompt that matches no script
    // fails the turn loudly instead of answering "ok".
    return (body, position) => {
        const matches = Object.keys(scripts).filter((token) => position.lastUserText.includes(token));
        if (matches.length !== 1) {
            throw new Error(`no single script for this turn (matched ${JSON.stringify(matches)}): ${JSON.stringify(position.lastUserText.slice(0, 200))}`);
        }
        const step = scripts[matches[0]][position.step];
        if (!step) return { content: "ok" };
        return typeof step === "function" ? step(body, position) : step;
    };
}

async function latestCanvasDraw(mgmt, sessionId) {
    const events = await mgmt.getSessionEventsBefore(sessionId, Number.MAX_SAFE_INTEGER, 30, ["session.canvas_updated"]);
    return [...events].sort((a, b) => Number(b.data?.rev) - Number(a.data?.rev))[0]?.data ?? {};
}

async function legacyScene(env, worker, name) {
    const factStore = worker.factStore;
    const installedAt = new Date(Date.now() + 3_600_000);
    canvasLegacyCatalogFor(factStore, async () => installedAt, { ttlMs: 0 });
    const card = await seedLegacyCard(factStore, worker.artifactStore, name);
    return { factStore, card, installedAt };
}

describe("canvas app transition: server decisions about an old app's page (L2)", () => {
    it("on: the old page is read and unlabelled while its card qualifies; once the card changes it is withheld and labelled", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const name = `old-page-${env.runId}`;
        let card;
        const scripts = {};
        const respond = pagesTurns(scripts);
        await withScriptedModel(env, { respond, worker: { canvasLegacyMode: true } }, async ({ client, qualifiedModel, worker }) => {
            const scene = await legacyScene(env, worker, name);
            card = scene.card;
            // Alice also publishes the old page's exact bytes as a shared registry app:
            // to Bob those bytes are another user's app, unless the old card exempts them.
            scripts["L2-ALICE"] = toolTurn([
                { name: "draw_canvas", args: { html: card.html } },
                { name: "publish_canvas_app", args: { name: `${name}-v2`, description: DESCRIPTION, scope: "shared" } },
            ]);
            const from = { sessionId: card.sourceSession, filename: card.filename };
            scripts["L2-BOB-1"] = toolTurn([
                { name: "draw_canvas", args: { fromArtifact: from } },
                { name: "read_canvas", args: {} },
                { name: "canvas_kv", args: { op: "put", key: "app/x", value: 1 } },
                { name: "canvas_kv", args: { op: "get", key: "app/x" } },
                { name: "read_artifact", args: from },
            ]);
            scripts["L2-BOB-2"] = toolTurn([
                { name: "read_canvas", args: {} },
                { name: "canvas_kv", args: { op: "get", key: "app/x" } },
                { name: "read_artifact", args: from },
            ]);
            const alice = await client.createSession({ model: qualifiedModel, owner: ALICE });
            const aliceResults = JSON.parse(await alice.sendAndWait("L2-ALICE", TIMEOUT));
            assert(!JSON.parse(aliceResults[1]).error, `Alice publishes the bytes: ${aliceResults[1]}`);

            // The portal side judges with its own switch and its own old catalog.
            const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, canvasLegacyMode: true });
            await mgmt.start();
            try {
                // The portal reads the same artifacts the worker wrote.
                mgmt._artifactStore = worker.artifactStore;
                canvasLegacyCatalogFor(mgmt._factStore, async () => scene.installedAt, { ttlMs: 0 });
                const bob = await client.createSession({ model: qualifiedModel, owner: BOB });
                const first = JSON.parse(await bob.sendAndWait("L2-BOB-1", TIMEOUT));
                const draw = await latestCanvasDraw(mgmt, bob.sessionId);
                assertEqual(draw.trust, "cross-owner", "the true trust: Alice's registry app has these bytes");
                assertEqual(draw.legacy, true, "flagged as an old app's page");
                const read1 = JSON.parse(first[1]);
                assert(!read1.withheld && String(read1.content ?? "").includes(name), `the old page is read as on main: ${first[1]}`);
                assertEqual(JSON.parse(first[2]).ok, true, `the agent writes the old page's KV: ${first[2]}`);
                const get1 = JSON.parse(first[3]);
                assert(get1.found === true && get1.key === "app/x" && get1.v === 1, `the value is read back: ${first[3]}`);
                assertEqual(get1.page, undefined, "no page label on the old page's values");
                const art1 = JSON.parse(first[4]);
                assert(art1.success === true && art1.content === card.html && art1.sha256 === card.sha256, `its artifact is read in full: ${String(first[4]).slice(0, 200)}`);
                const label1 = await mgmt.getCanvasRevisionLabel({ sessionId: bob.sessionId, slot: 1 });
                assertEqual(label1.legacy, true, "the portal judges it legacy now");
                assertEqual(label1.pageSha256, card.sha256);

                // The old card changes: it now names other bytes.
                await scene.factStore.storeFact({ key: `apps/${name}`, shared: true, value: { name, source: { sessionId: card.sourceSession, filename: card.filename, sha256: "e".repeat(64) } } });
                const second = JSON.parse(await bob.sendAndWait("L2-BOB-2", TIMEOUT));
                const read2 = JSON.parse(second[0]);
                assertEqual(read2.withheld, true, `withheld once the card changed: ${second[0]}`);
                const get2 = JSON.parse(second[1]);
                assert(get2.found === true && get2.v === 1, `the same value is read: ${second[1]}`);
                assertEqual(get2.page?.trust, "cross-owner", "and now labelled");
                assertEqual(JSON.parse(second[2]).error, "CANVAS_APP_BYTES", `the artifact is refused: ${String(second[2]).slice(0, 200)}`);
                assertEqual((await mgmt.getCanvasRevisionLabel({ sessionId: bob.sessionId, slot: 1 })).legacy, false, "the portal no longer judges it legacy");
            } finally {
                await mgmt.stop().catch(() => {});
            }
        });
    });

    it("off: the same old page is withheld and labelled, and its draw carries no legacy flag", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const name = `old-page-off-${env.runId}`;
        const scripts = {};
        const respond = pagesTurns(scripts);
        await withScriptedModel(env, { respond, worker: { canvasLegacyMode: false } }, async ({ client, qualifiedModel, worker }) => {
            const { card } = await legacyScene(env, worker, name);
            scripts["L2-ALICE"] = toolTurn([
                { name: "draw_canvas", args: { html: card.html } },
                { name: "publish_canvas_app", args: { name: `${name}-v2`, description: DESCRIPTION, scope: "shared" } },
            ]);
            const from = { sessionId: card.sourceSession, filename: card.filename };
            scripts["L2-BOB-OFF"] = toolTurn([
                { name: "draw_canvas", args: { fromArtifact: from } },
                { name: "read_canvas", args: {} },
                { name: "canvas_kv", args: { op: "put", key: "app/x", value: 1 } },
                { name: "canvas_kv", args: { op: "get", key: "app/x" } },
            ]);
            const alice = await client.createSession({ model: qualifiedModel, owner: ALICE });
            const aliceResults = JSON.parse(await alice.sendAndWait("L2-ALICE", TIMEOUT));
            assert(!JSON.parse(aliceResults[1]).error, `Alice publishes the bytes: ${aliceResults[1]}`);
            const bob = await client.createSession({ model: qualifiedModel, owner: BOB });
            const results = JSON.parse(await bob.sendAndWait("L2-BOB-OFF", TIMEOUT));
            assertEqual(JSON.parse(results[1]).withheld, true, `withheld: ${results[1]}`);
            assertEqual(JSON.parse(results[2]).ok, true, `the agent writes the KV: ${results[2]}`);
            const get = JSON.parse(results[3]);
            assert(get.found === true && get.key === "app/x" && get.v === 1, `the value is read back: ${results[3]}`);
            assertEqual(get.page?.trust, "cross-owner", "labelled");
            const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, canvasLegacyMode: false });
            await mgmt.start();
            try {
                mgmt._artifactStore = worker.artifactStore;
                const draw = await latestCanvasDraw(mgmt, bob.sessionId);
                assertEqual(draw.trust, "cross-owner");
                assertEqual(draw.legacy, undefined, "no legacy flag when the worker's switch is off");
                assertEqual((await mgmt.getCanvasRevisionLabel({ sessionId: bob.sessionId, slot: 1 })).legacy, false);
            } finally {
                await mgmt.stop().catch(() => {});
            }
        });
    });
});
