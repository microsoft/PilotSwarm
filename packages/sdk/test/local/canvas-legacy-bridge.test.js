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
import { CanvasLegacyCatalog, CANVAS_LEGACY_CUTOFF_MARGIN_MS } from "../../src/index.ts";

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
