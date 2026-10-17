/**
 * Canvas app registry: the service (issue 181, plan r4 phase 2). No LLM turns.
 *
 * Publishes real pages through publishCanvasAppHtml into a filesystem
 * artifact store, then reads, deletes, prunes, exports and imports them.
 *
 * Run: npx vitest run test/local/canvas-app-registry.test.js
 */

import * as path from "node:path";
import * as zlib from "node:zlib";
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { FilesystemArtifactStore, createFactStoreForUrl } from "../../src/index.ts";
import {
    publishCanvasAppHtml, readCanvasAppHtml, deleteCanvasApp, pruneCanvasAppArtifacts,
    exportCanvasApp, importCanvasApp, readCanvasAppArchive, canvasAppArtifactSessionId, migrateLegacyCanvasApps,
    looksLikeCanvasAppSpace, sha256Hex, CANVAS_APP_PENDING_TTL_MS,
} from "../../src/canvas-app-registry.ts";
import { buildCanonicalTarGz } from "../../src/agent-package-format.ts";
import { CanvasAppError } from "../../src/canvas-app-store.ts";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

const ALICE = { provider: "test", subject: "car-alice" };
const BOB = { provider: "test", subject: "car-bob" };
const V = { alice: { principal: ALICE, resourceAdmin: false }, bob: { principal: BOB, resourceAdmin: false } };
const DESCRIPTION = "Use when testing the canvas app registry service end to end.";

function page(title, extra = "") {
    const manifest = {
        name: title, description: DESCRIPTION,
        interface: { keys: [{ key: "app/items/*", purpose: "rows" }], requests: [], events: [] },
    };
    return `<!doctype html>\n<!-- CANVAS-APP-MANIFEST ${JSON.stringify(manifest)} -->\n<html><body><h1>${title}</h1>${extra}</body></html>\n`;
}

function readCanvasAppArchiveJson(bytes) {
    const tar = zlib.gunzipSync(bytes);
    // First member is canvas-app.json: header 512 bytes, then the body.
    const size = parseInt(tar.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    return tar.subarray(512, 512 + size).toString("utf8");
}

async function expectCode(promise, code) {
    try {
        await promise;
    } catch (error) {
        assertEqual(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
        return error;
    }
    throw new Error(`expected ${code}, but the call succeeded`);
}

async function setup(env) {
    const catalog = await createCatalog(env);
    const artifactStore = new FilesystemArtifactStore(path.join(env.baseDir, "canvas-app-artifacts"));
    return { catalog, deps: { store: catalog.canvasApps, artifactStore } };
}

describe("canvas app registry: service", () => {
    it("byte space ids are a recognisable family that real session ids are never in", { timeout: TIMEOUT }, async () => {
        const id = canvasAppArtifactSessionId("app-1");
        assert(looksLikeCanvasAppSpace(id), "derived ids are in the family");
        assertEqual(id, canvasAppArtifactSessionId("app-1"), "deterministic");
        assert(id !== canvasAppArtifactSessionId("app-2"), "one space per app");
        assertEqual(id[14], "8", "UUID version nibble 8");
        for (let i = 0; i < 200; i++) assert(!looksLikeCanvasAppSpace(crypto.randomUUID()), "v4 ids are never in the family");
    });

    it("publish, read back, checks and errors", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const name = `car-pub-${env.runId}`;
            const html = page(name);
            const first = await publishCanvasAppHtml(deps, { html, name, viewer: V.alice, description: DESCRIPTION });
            assertEqual(first.status, "published");
            assertEqual(first.scope, "user", "private by default");
            assertEqual(first.version, "1.0.0");
            assertEqual(first.sha256, sha256Hex(html));
            assert(first.card.interface, "card carries the interface");

            const read = await readCanvasAppHtml(deps, { name }, V.alice);
            assertEqual(read.html, html, "byte-identical");
            assert(looksLikeCanvasAppSpace(read.resolved.artifactSessionId), "stored in the app's own space");

            const again = await publishCanvasAppHtml(deps, { html, name, viewer: V.alice });
            assertEqual(again.status, "unchanged");

            const manifestVersion = page(name, "").replace(`"name":"${name}"`, `"name":"${name}","version":"4.2.0"`);
            const mv = await publishCanvasAppHtml(deps, { html: manifestVersion, name, viewer: V.alice });
            assertEqual(mv.version, "4.2.0", "the manifest's SemVer version is used when none is given");

            await expectCode(publishCanvasAppHtml(deps, { html: "<!doctype html><p>no manifest</p>", name, viewer: V.alice }), "BAD_REQUEST");
            await expectCode(publishCanvasAppHtml(deps, { html: page(name, "x".repeat(900_001)), name, viewer: V.alice }), "BAD_REQUEST");
            await expectCode(publishCanvasAppHtml(deps, { html, name: "Bad Name", viewer: V.alice }), "BAD_REQUEST");
            await expectCode(publishCanvasAppHtml(deps, { html, name, viewer: { principal: null, resourceAdmin: false } }), "NO_OWNER");
            await expectCode(readCanvasAppHtml(deps, { name }, V.bob), "NOT_FOUND");
        } finally {
            await catalog.close();
        }
    });

    it("two owners' private apps with the same name, version and bytes live apart; deleting one leaves the other", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const name = `car-twin-${env.runId}`;
            const html = page(name);
            const a = await publishCanvasAppHtml(deps, { html, name, viewer: V.alice });
            const b = await publishCanvasAppHtml(deps, { html, name, viewer: V.bob });
            assert(a.appId !== b.appId, "two apps");
            const ra = await readCanvasAppHtml(deps, { name }, V.alice);
            const rb = await readCanvasAppHtml(deps, { name }, V.bob);
            assert(ra.resolved.artifactSessionId !== rb.resolved.artifactSessionId, "separate byte spaces");
            const del = await deleteCanvasApp(deps, { name }, V.alice);
            assertEqual(del.files, 1);
            await expectCode(readCanvasAppHtml(deps, { name }, V.alice), "NOT_FOUND");
            assertEqual((await readCanvasAppHtml(deps, { name }, V.bob)).html, html, "Bob's copy is intact");
        } finally {
            await catalog.close();
        }
    });

    it("crashes converge: after reserve, after upload, and during delete", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const store = deps.store;
            // Crash after reserve (and after upload): a pending row stays; prune removes row and bytes.
            const name = `car-crash-${env.runId}`;
            await publishCanvasAppHtml(deps, { html: page(name), name, viewer: V.alice });
            const space0 = (await readCanvasAppHtml(deps, { name }, V.alice)).resolved.artifactSessionId;
            const crashing = {
                ...deps,
                store: Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
                    commit: async () => { throw new Error("simulated crash before commit"); },
                }),
            };
            const html2 = page(name, "<p>v2</p>");
            await publishCanvasAppHtml(crashing, { html: html2, name, viewer: V.alice }).catch(() => {});
            assertEqual((await deps.artifactStore.listArtifacts(space0)).length, 2, "the uploaded bytes of the uncommitted version are there");
            assertEqual((await store.get({ name }, V.alice)).versions.length, 1, "the pending version is invisible");
            const pruned = await pruneCanvasAppArtifacts(deps, new Date(Date.now() + CANVAS_APP_PENDING_TTL_MS + 60_000));
            assert(pruned.pendingRemoved >= 1, "prune removes the stale pending row");
            assertEqual((await deps.artifactStore.listArtifacts(space0)).length, 1, "and its bytes");
            const retry = await publishCanvasAppHtml(deps, { html: html2, name, viewer: V.alice });
            assertEqual(retry.status, "published", "the same publish succeeds afterwards");

            // Crash during delete: rows gone, bytes left; prune finishes from the tombstone.
            const space = (await readCanvasAppHtml(deps, { name }, V.alice)).resolved.artifactSessionId;
            const failingBytes = { ...deps, artifactStore: Object.assign(Object.create(Object.getPrototypeOf(deps.artifactStore)), deps.artifactStore, {
                deleteArtifact: async () => { throw new Error("simulated storage outage"); },
            }) };
            const gone = await store.delete({ name }, V.alice);
            for (const f of gone.artifactFilenames) await failingBytes.artifactStore.deleteArtifact(gone.artifactSessionId, f).catch(() => {});
            assert((await deps.artifactStore.listArtifacts(space)).length > 0, "bytes left behind");
            await pruneCanvasAppArtifacts(deps);
            assertEqual((await deps.artifactStore.listArtifacts(space)).length, 0, "prune finished the delete");
        } finally {
            await catalog.close();
        }
    });

    it("a version becomes ready only for its own bytes: a store that keeps other bytes publishes nothing", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const name = `car-rehash-${env.runId}`;
            const real = deps.artifactStore;
            const tampering = {
                ...deps,
                artifactStore: Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
                    uploadArtifact: (sessionId, filename, content, ...rest) => real.uploadArtifact(sessionId, filename, `${content}<!-- swapped -->`, ...rest),
                }),
            };
            await expectCode(publishCanvasAppHtml(tampering, { html: page(name), name, viewer: V.alice }), "BAD_REQUEST");
            const after = await deps.store.get({ name }, V.alice).catch((error) => error);
            assert(after?.code === "NOT_FOUND" || after?.versions?.length === 0, `no ready version exists: ${JSON.stringify(after?.versions ?? after?.code)}`);
            const ok = await publishCanvasAppHtml(deps, { html: page(name), name, viewer: V.alice });
            assertEqual(ok.status, "published", "the honest store publishes the same page");
            assertEqual((await readCanvasAppHtml(deps, { name }, V.alice)).html, page(name));
        } finally {
            await catalog.close();
        }
    });

    it("service delete and pending prune keep their cleanup records when storage fails, and finish later", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const real = deps.artifactStore;
            const outage = { ...deps, artifactStore: Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
                deleteArtifact: async () => { throw new Error("simulated storage outage"); },
                listArtifacts: async () => { throw new Error("simulated storage outage"); },
            }) };
            // Delete through the SERVICE during an outage: rows go, bytes stay, tombstone stays.
            const name = `car-outage-${env.runId}`;
            await publishCanvasAppHtml(deps, { html: page(name), name, viewer: V.alice });
            const space = (await readCanvasAppHtml(deps, { name }, V.alice)).resolved.artifactSessionId;
            const del = await deleteCanvasApp(outage, { name }, V.alice);
            assertEqual(del.pendingCleanup, true, "the caller is told cleanup is pending");
            assert((await real.listArtifacts(space)).length > 0, "bytes are still there");
            assert((await deps.store.listTombstones(1000)).some((t) => t.artifactSessionId === space), "the tombstone is kept");
            // A prune during the outage keeps it too.
            const failedPrune = await pruneCanvasAppArtifacts(outage);
            assert(failedPrune.failures >= 1, "the prune reports the failure");
            assert((await deps.store.listTombstones(1000)).some((t) => t.artifactSessionId === space), "still kept");
            // After recovery the next prune finishes.
            await pruneCanvasAppArtifacts(deps);
            assertEqual((await real.listArtifacts(space)).length, 0, "bytes removed after recovery");
            assert(!(await deps.store.listTombstones(1000)).some((t) => t.artifactSessionId === space), "tombstone purged");

            // A stale pending version whose bytes cannot be deleted stays pending for the next run.
            const name2 = `car-outage2-${env.runId}`;
            await publishCanvasAppHtml(deps, { html: page(name2), name: name2, viewer: V.alice });
            const crashing = { ...deps, store: Object.assign(Object.create(Object.getPrototypeOf(deps.store)), deps.store, {
                commit: async () => { throw new Error("simulated crash before commit"); },
            }) };
            await publishCanvasAppHtml(crashing, { html: page(name2, "<p>v2</p>"), name: name2, viewer: V.alice }).catch(() => {});
            const later = new Date(Date.now() + CANVAS_APP_PENDING_TTL_MS + 60_000);
            const space2 = (await readCanvasAppHtml(deps, { name: name2 }, V.alice)).resolved.artifactSessionId;
            const blocked = await pruneCanvasAppArtifacts(outage, later);
            assertEqual(blocked.pendingRemoved, 0, "nothing is claimed removed during the outage");
            assertEqual((await real.listArtifacts(space2)).length, 2, "the abandoned bytes are still tracked");
            const done = await pruneCanvasAppArtifacts(deps, later);
            assert(done.pendingRemoved >= 1, "the next prune removes them");
            assertEqual((await real.listArtifacts(space2)).length, 1, "only the committed version's bytes remain");
        } finally {
            await catalog.close();
        }
    });

    it("no new session may take a canvas app byte-space id", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog } = await setup(env);
        try {
            const reserved = canvasAppArtifactSessionId(`probe-${env.runId}`);
            assert(looksLikeCanvasAppSpace(reserved));
            await expectCode(catalog.createSession(reserved, { model: "m" }), "RESERVED_SESSION_ID");
            const ordinary = `00000000-0000-4000-8000-${env.runId.padStart(12, "0").slice(-12)}`;
            assert(!looksLikeCanvasAppSpace(ordinary));
            await catalog.createSession(ordinary, { model: "m" });
        } finally {
            await catalog.close();
        }
    });

    it("every successful export fits the importer's expanded budget; a history that would not is refused up front", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const name = `car-big-${env.runId}`;
            // Distinct, highly compressible pages just under the 900 KB cap,
            // far below 20 MB compressed in any case. The importer expands at
            // most 40 MiB (41,943,040 bytes): 48 pages total about 41.8 MB and
            // still fit; 52 total over 45 MB and do not.
            const filler = "x".repeat(870_000);
            const publish = async (i) => publishCanvasAppHtml(deps, { html: page(name, `<p>v${i}</p><!-- ${filler} -->`), name, viewer: V.alice, version: `1.0.${i}` });
            for (let i = 0; i < 48; i++) await publish(i);
            const near = await exportCanvasApp(deps, { name }, V.alice);
            for (let i = 48; i < 52; i++) await publish(i);
            const refused = await expectCode(exportCanvasApp(deps, { name }, V.alice), "BAD_REQUEST");
            assert(/an import would refuse/.test(refused.message), `refused for the expanded budget: ${refused.message}`);
            // The near-limit export it did produce imports back, every version.
            await deleteCanvasApp(deps, { name }, V.alice);
            const imported = await importCanvasApp(deps, near.bytes, V.bob);
            assertEqual(imported.versions.filter((v) => v.status === "imported").length, 48, "the near-limit archive imports");
        } finally {
            await catalog.close();
        }
    });

    it("a repeated import changes nothing, metadata included", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const name = `car-reimport-${env.runId}`;
            await publishCanvasAppHtml(deps, { html: page(name), name, viewer: V.alice, description: DESCRIPTION, tags: ["one"] });
            const archive = await exportCanvasApp(deps, { name }, V.alice);
            await deleteCanvasApp(deps, { name }, V.alice);
            await importCanvasApp(deps, archive.bytes, V.bob);
            await deps.store.setMetadata({ name }, { description: "Use when Bob edited the description after importing.", tags: ["bob"] }, V.bob);
            const edited = await deps.store.get({ name }, V.bob);
            const again = await importCanvasApp(deps, archive.bytes, V.bob);
            assert(again.versions.every((v) => v.status === "unchanged"), JSON.stringify(again.versions));
            const after = await deps.store.get({ name }, V.bob);
            assertEqual(after.description, edited.description, "the edited description stays");
            assertEqual(after.tags.join(","), edited.tags.join(","), "the edited tags stay");
        } finally {
            await catalog.close();
        }
    });

    it("export/import keeps a version's explicit effective contract", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const name = `car-contract-${env.runId}`;
            const contract = { actions: { pick: { row: "number" } } };
            await publishCanvasAppHtml(deps, { html: page(name), name, viewer: V.alice, responseContract: contract });
            const before = (await deps.store.get({ name }, V.alice)).versions[0].card;
            assertEqual(JSON.stringify(before.responseContract), JSON.stringify(contract), "published with the explicit contract");
            const archive = await exportCanvasApp(deps, { name }, V.alice);
            await deleteCanvasApp(deps, { name }, V.alice);
            await importCanvasApp(deps, archive.bytes, V.bob);
            const after = (await deps.store.get({ name }, V.bob)).versions[0].card;
            assertEqual(JSON.stringify(after.responseContract), JSON.stringify(contract), "the imported version arms the same contract");
            const parsed = readCanvasAppArchive(archive.bytes);
            assertEqual(JSON.stringify(parsed.manifest.versions[0].card.responseContract), JSON.stringify(contract));
            // An archived contract that fails the checks is refused whole, never silently dropped.
            const other = `car-contract-bad-${env.runId}`;
            const html = page(other);
            const badArchive = buildCanonicalTarGz([
                { name: "canvas-app.json", body: Buffer.from(JSON.stringify({ format: 1, name: other, description: DESCRIPTION, tags: [], versions: [
                    { version: "1.0.0", sha256: sha256Hex(html), size: Buffer.byteLength(html), card: { name: other, responseContract: { actions: { pick: { row: "banana" } } } } },
                ] })) },
                { name: "versions/1.0.0.html", body: Buffer.from(html) },
            ]);
            await expectCode(importCanvasApp(deps, badArchive, V.bob), "BAD_REQUEST");
            await expectCode(deps.store.get({ name: other }, V.bob), "NOT_FOUND");
        } finally {
            await catalog.close();
        }
    });

    it("export is byte-stable and carries no identity; import round-trips, repeats as a no-op and isolates version conflicts", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const name = `car-exp-${env.runId}`;
            await publishCanvasAppHtml(deps, { html: page(name), name, viewer: V.alice, scope: "shared", version: "1.0.0", tags: ["b", "a"] });
            await publishCanvasAppHtml(deps, { html: page(name, "<p>2</p>"), name, viewer: V.alice, scope: "shared", version: "2.0.0" });
            const one = await exportCanvasApp(deps, { name, scope: "shared" }, V.alice);
            const two = await exportCanvasApp(deps, { name, scope: "shared" }, V.alice);
            assertEqual(one.sha256, two.sha256, "byte-stable");
            const parsed = readCanvasAppArchive(one.bytes);
            assertEqual(parsed.manifest.versions.map((v) => v.version).join(","), "1.0.0,2.0.0");
            const text = zlib.gunzipSync(one.bytes).toString("latin1");
            assert(!text.includes(ALICE.subject), "no user identity in the archive");
            const json = JSON.parse(readCanvasAppArchiveJson(one.bytes));
            const forbidden = ["owner", "scope", "enabled", "contributors", "editors", "sessionId", "source", "createdBy", "appId"];
            for (const key of forbidden) {
                assert(!(key in json), `archive manifest must not carry ${key}`);
                for (const v of json.versions) assert(!(key in v), `archive version must not carry ${key}`);
            }
            assertEqual(Object.keys(json).sort().join(","), "description,format,name,tags,versions", "whitelist");

            // Bob imports it as his private app (another cluster in practice).
            const imp = await importCanvasApp(deps, one.bytes, V.bob);
            assertEqual(imp.scope, "user");
            assertEqual(imp.versions.map((v) => v.status).join(","), "imported,imported");
            const bobActive = await readCanvasAppHtml(deps, { name, scope: "user" }, V.bob);
            assertEqual(bobActive.resolved.version, "2.0.0", "a new app gets its highest version");
            const repeat = await importCanvasApp(deps, one.bytes, V.bob);
            assertEqual(repeat.versions.map((v) => v.status).join(","), "unchanged,unchanged", "repeat import is a no-op");

            // A conflicting version fails alone.
            await deps.store.pin({ name, scope: "user" }, "1.0.0", V.bob);
            const conflictName = `car-conflict-${env.runId}`;
            await publishCanvasAppHtml(deps, { html: page(name, "<p>other 2</p>"), name: conflictName, viewer: V.bob, version: "2.0.0" });
            const files = [
                { name: "canvas-app.json", body: Buffer.from(JSON.stringify({ format: 1, name: conflictName, description: DESCRIPTION, tags: [], versions: [
                    { version: "2.0.0", sha256: sha256Hex(page(name, "<p>2</p>")), size: 1, card: {} },
                    { version: "3.0.0", sha256: sha256Hex(page(name, "<p>3</p>")), size: 1, card: {} },
                ] })) },
                { name: "versions/2.0.0.html", body: Buffer.from(page(name, "<p>2</p>")) },
                { name: "versions/3.0.0.html", body: Buffer.from(page(name, "<p>3</p>")) },
            ];
            const mixed = await importCanvasApp(deps, buildCanonicalTarGz(files), V.bob);
            assertEqual(mixed.versions.map((v) => `${v.version}:${v.status}${v.code ? ":" + v.code : ""}`).join(","), "2.0.0:failed:VERSION_EXISTS,3.0.0:imported");
            assertEqual((await readCanvasAppHtml(deps, { name: conflictName }, V.bob)).resolved.version, "2.0.0", "import does not move an established app's pointer");
        } finally {
            await catalog.close();
        }
    });

    it("bad archives are refused whole, with nothing written", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const name = `car-bad-${env.runId}`;
            const good = page(name);
            const manifest = (versions) => ({ name: "canvas-app.json", body: Buffer.from(JSON.stringify({ format: 1, name, description: DESCRIPTION, tags: [], versions })) });
            const v1 = { version: "1.0.0", sha256: sha256Hex(good), size: 1, card: {} };
            const v2 = { version: "2.0.0", sha256: sha256Hex(good + " "), size: 1, card: {} };
            const cases = {
                badHashOnLastMember: buildCanonicalTarGz([manifest([v1, v2]), { name: "versions/1.0.0.html", body: Buffer.from(good) }, { name: "versions/2.0.0.html", body: Buffer.from(good + "tampered") }]),
                extraMember: buildCanonicalTarGz([manifest([v1]), { name: "versions/1.0.0.html", body: Buffer.from(good) }, { name: "evil.sh", body: Buffer.from("x") }]),
                duplicateMember: buildCanonicalTarGz([manifest([v1]), { name: "versions/1.0.0.html", body: Buffer.from(good) }, { name: "versions/1.0.0.html", body: Buffer.from(good) }]),
                badPath: buildCanonicalTarGz([manifest([v1]), { name: "../versions/1.0.0.html", body: Buffer.from(good) }]),
                missingManifest: buildCanonicalTarGz([{ name: "versions/1.0.0.html", body: Buffer.from(good) }]),
                truncated: buildCanonicalTarGz([manifest([v1]), { name: "versions/1.0.0.html", body: Buffer.from(good) }]).subarray(0, 60),
                bomb: zlib.gzipSync(Buffer.alloc(45 * 1024 * 1024)),
            };
            for (const [label, bytes] of Object.entries(cases)) {
                try {
                    await importCanvasApp(deps, bytes, V.alice);
                    throw new Error(`${label}: accepted`);
                } catch (error) {
                    assertEqual(error?.code, "BAD_REQUEST", `${label}: ${error?.message}`);
                }
            }
            await expectCode(deps.store.get({ name }, V.alice), "NOT_FOUND");
        } finally {
            await catalog.close();
        }
    });

    it("pending cleanup cannot delete a version committed after its listing: a claimed publish is refused and leaves nothing", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const name = `car-claim-${env.runId}`;
            await publishCanvasAppHtml(deps, { html: page(name), name, viewer: V.alice });
            const space = (await readCanvasAppHtml(deps, { name }, V.alice)).resolved.artifactSessionId;
            // Barrier: the publisher stops inside its upload; the prune runs
            // (as if the pending window had passed), then the upload resumes.
            let reachUpload; const reached = new Promise((resolve) => { reachUpload = resolve; });
            let releaseUpload; const released = new Promise((resolve) => { releaseUpload = resolve; });
            const real = deps.artifactStore;
            const slow = { ...deps, artifactStore: Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
                uploadArtifact: async (...args) => { reachUpload(); await released; return real.uploadArtifact(...args); },
            }) };
            const publishing = publishCanvasAppHtml(slow, { html: page(name, "<p>v2</p>"), name, viewer: V.alice, version: "2.0.0" });
            await reached;
            const later = new Date(Date.now() + CANVAS_APP_PENDING_TTL_MS + 60_000);
            const prune = await pruneCanvasAppArtifacts(deps, later);
            assertEqual(prune.pendingRemoved, 1, "the stale version was claimed and removed");
            releaseUpload();
            const refused = await publishing.then(() => null, (error) => error);
            assert(refused, "the late publish is refused");
            assert(refused.code === "ABORTED" || refused.code === "NOT_FOUND", `refused as not committed: ${refused.code}`);
            const detail = await deps.store.get({ name }, V.alice);
            assertEqual(detail.versions.map((v) => v.version).join(","), "1.0.0", "no 2.0.0 version, ready or otherwise");
            assertEqual((await real.listArtifacts(space)).length, 1, "the late upload left no orphan bytes");
            assertEqual((await readCanvasAppHtml(deps, { name }, V.alice)).html, page(name), "1.0.0 still reads back");

            // The other order: the publish commits first; a later prune touches nothing.
            const v3 = await publishCanvasAppHtml(deps, { html: page(name, "<p>v3</p>"), name, viewer: V.alice, version: "3.0.0" });
            assertEqual(v3.status, "published");
            const after = await pruneCanvasAppArtifacts(deps, later);
            assertEqual(after.pendingRemoved, 0);
            assertEqual((await readCanvasAppHtml(deps, { name }, V.alice, "3.0.0")).html, page(name, "<p>v3</p>"), "the committed bytes stay");
        } finally {
            await catalog.close();
        }
    });

    it("a failed read-back removes the uploaded bytes, or keeps the pending row as the cleanup record until they are gone", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const name = `car-readback-${env.runId}`;
            await publishCanvasAppHtml(deps, { html: page(name), name, viewer: V.alice });
            const space = (await readCanvasAppHtml(deps, { name }, V.alice)).resolved.artifactSessionId;
            const real = deps.artifactStore;
            const mismatching = { ...deps, artifactStore: Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
                downloadArtifactText: async () => "<p>other bytes</p>",
            }) };
            await expectCode(publishCanvasAppHtml(mismatching, { html: page(name, "<p>v2</p>"), name, viewer: V.alice, version: "2.0.0" }), "BAD_REQUEST");
            assertEqual((await real.listArtifacts(space)).length, 1, "the uploaded bytes were removed");
            // Claiming with a cutoff in the future returns every pending row there is.
            const later = new Date(Date.now() + CANVAS_APP_PENDING_TTL_MS + 60_000);
            assertEqual((await deps.store.prunePending(later)).length, 0, "and no pending row is left");

            // When the bytes cannot be removed, the pending row stays; the prune finishes later.
            const stuck = { ...mismatching, artifactStore: Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
                downloadArtifactText: async () => "<p>other bytes</p>",
                deleteArtifact: async () => { throw new Error("simulated storage outage"); },
            }) };
            await expectCode(publishCanvasAppHtml(stuck, { html: page(name, "<p>v3</p>"), name, viewer: V.alice, version: "3.0.0" }), "BAD_REQUEST");
            assertEqual((await real.listArtifacts(space)).length, 2, "the bytes are still there");
            const done = await pruneCanvasAppArtifacts(deps, later);
            assertEqual(done.pendingRemoved, 1, "the prune claims and removes the leftover");
            assertEqual((await real.listArtifacts(space)).length, 1, "only the ready version's bytes remain");
        } finally {
            await catalog.close();
        }
    });

    it("every successful export fits the expanded budget with large valid cards, counted exactly", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        try {
            const name = `car-cards-${env.runId}`;
            // A near-maximal interface block: 28 keys of about 210 bytes each.
            const keys = Array.from({ length: 28 }, (_, i) => ({ key: `app/k${String(i).padStart(2, "0")}/${"x".repeat(200)}`.slice(0, 200) }));
            const SIZE = 889_000;
            const bigPage = (i) => {
                const manifest = { name, description: DESCRIPTION, interface: { keys, requests: [], events: [] } };
                const head = `<!doctype html>\n<!-- CANVAS-APP-MANIFEST ${JSON.stringify(manifest)} -->\n<html><body><h1>${name}</h1><p>v${i}</p><!-- `;
                const tail = " --></body></html>\n";
                return head + "x".repeat(SIZE - Buffer.byteLength(head + tail)) + tail;
            };
            assertEqual(Buffer.byteLength(bigPage(0)), SIZE);
            for (let i = 0; i < 46; i++) await publishCanvasAppHtml(deps, { html: bigPage(i), name, viewer: V.alice, version: `1.0.${i}` });
            const card = (await deps.store.get({ name }, V.alice)).versions[0].card;
            assert(Buffer.byteLength(JSON.stringify(card)) >= 6000, `each card is large (${Buffer.byteLength(JSON.stringify(card))} bytes)`);
            const near = await exportCanvasApp(deps, { name }, V.alice);
            assert(zlib.gunzipSync(near.bytes).length <= 40 * 1024 * 1024, "the export expands within the import limit");
            await publishCanvasAppHtml(deps, { html: bigPage(46), name, viewer: V.alice, version: "1.0.46" });
            // Pages alone would pass the old per-page estimate; the cards push it over.
            const refused = await expectCode(exportCanvasApp(deps, { name }, V.alice), "BAD_REQUEST");
            assert(/an import accepts/.test(refused.message), `refused for the expanded budget: ${refused.message}`);
            await deleteCanvasApp(deps, { name }, V.alice);
            const imported = await importCanvasApp(deps, near.bytes, V.bob);
            assertEqual(imported.versions.filter((v) => v.status === "imported").length, 46, "the fitting archive imports every version");
        } finally {
            await catalog.close();
        }
    });

    it("legacy migration deletes only the revision it migrated, atomically, and never extends an app someone created meanwhile", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        const factStore = await createFactStoreForUrl(env.store, env.factsSchema);
        await factStore.initialize();
        try {
            const admin = { principal: { provider: "test", subject: "car-admin" }, resourceAdmin: true };
            const changed = `car-leg-chg-${env.runId}`;
            const raced = `car-leg-race-${env.runId}`;
            const sameOwner = `car-leg-own-${env.runId}`;
            for (const name of [changed, raced, sameOwner]) {
                await deps.artifactStore.uploadArtifact(`sess-${name}`, `app-${name}.html`, page(name), "text/html");
                await factStore.storeFact({ key: `apps/${name}`, shared: true, value: {
                    name, description: DESCRIPTION, tags: ["legacy"],
                    source: { kind: "artifact", sessionId: `sess-${name}`, filename: `app-${name}.html`, sha256: sha256Hex(page(name)) },
                } });
            }
            // After the migration's pre-check: Bob publishes a shared app with
            // the raced name, and Alice (the owner the migration publishes as)
            // publishes other bytes under the sameOwner name.
            await publishCanvasAppHtml(deps, { html: page(raced, "<p>bob</p>"), name: raced, scope: "shared", viewer: V.bob });
            await publishCanvasAppHtml(deps, { html: page(sameOwner, "<p>alice later</p>"), name: sameOwner, scope: "shared", viewer: V.alice });
            const racingStore = Object.assign(Object.create(Object.getPrototypeOf(deps.store)), deps.store, {
                getVersion: async (target, viewer, version) => (target.name === raced || target.name === sameOwner
                    ? Promise.reject(new CanvasAppError("NOT_FOUND", "not yet"))
                    : deps.store.getVersion(target, viewer, version)),
            });
            // The changed fact is REPLACED at the delete boundary: after the
            // migration decided to delete it, before the store deletes.
            const replacement = { name: changed, description: "replaced meanwhile", tags: ["new"] };
            const changingFacts = Object.assign(Object.create(Object.getPrototypeOf(factStore)), factStore, {
                deleteFactIfEtag: async (input) => {
                    if (input.key === `apps/${changed}`) await factStore.storeFact({ key: input.key, shared: true, value: replacement });
                    return factStore.deleteFactIfEtag(input);
                },
            });
            const owners = { [`sess-${sameOwner}`]: ALICE };
            const mdeps = { ...deps, store: racingStore, factStore: changingFacts, sessionOwner: async (sid) => owners[sid] ?? null };
            const run = await migrateLegacyCanvasApps(mdeps, admin, { dryRun: false });
            const by = Object.fromEntries(run.lines.filter((l) => l.name.includes(env.runId)).map((l) => [l.name, l]));
            assertEqual(by[changed].outcome, "migrated");
            assertEqual(by[changed].reason, "the fact changed during migration; fact kept");
            const kept = (await factStore.readFacts({ keyPattern: `apps/${changed}`, scope: "shared" })).facts;
            assertEqual(kept.length, 1, "the replacement survives");
            assertEqual(kept[0].value?.description, "replaced meanwhile", "and it is the replacement, not the migrated revision");
            assertEqual(by[raced].outcome, "skipped", `another owner's race is refused: ${JSON.stringify(by[raced])}`);
            assertEqual((await deps.store.get({ name: raced, scope: "shared" }, V.bob)).versions.length, 1, "Bob's app gained no version");
            assert((await factStore.readFacts({ keyPattern: `apps/${raced}`, scope: "shared" })).facts.length === 1, "the raced fact is kept");
            assertEqual(by[sameOwner].outcome, "skipped", `the same owner's other bytes are not extended: ${JSON.stringify(by[sameOwner])}`);
            assert(/NAME_TAKEN/.test(by[sameOwner].reason ?? ""), "refused by the reservation itself");
            assertEqual((await deps.store.get({ name: sameOwner, scope: "shared" }, V.alice)).versions.length, 1, "Alice's app gained no version");
            assert((await factStore.readFacts({ keyPattern: `apps/${sameOwner}`, scope: "shared" })).facts.length === 1, "its fact is kept");
            // A store that cannot compare-and-delete keeps every migrated fact.
            const plainName = `car-leg-plain-${env.runId}`;
            await deps.artifactStore.uploadArtifact(`sess-${plainName}`, `app-${plainName}.html`, page(plainName), "text/html");
            await factStore.storeFact({ key: `apps/${plainName}`, shared: true, value: {
                name: plainName, description: DESCRIPTION,
                source: { kind: "artifact", sessionId: `sess-${plainName}`, filename: `app-${plainName}.html`, sha256: sha256Hex(page(plainName)) },
            } });
            const noCas = Object.assign(Object.create(Object.getPrototypeOf(factStore)), factStore, { deleteFactIfEtag: undefined });
            const run2 = await migrateLegacyCanvasApps({ ...deps, factStore: noCas, sessionOwner: async () => null }, admin, { dryRun: false });
            const plain = run2.lines.find((l) => l.name === plainName);
            assertEqual(plain.outcome, "migrated");
            assertEqual(plain.reason, "this fact store cannot delete only the migrated revision; fact kept");
            assert((await factStore.readFacts({ keyPattern: `apps/${plainName}`, scope: "shared" })).facts.length === 1, "kept");
        } finally {
            await catalog.close();
        }
    });

    it("legacy migration: dry run, apply, apply again; owner from the bytes' session; deleted session migrates ownerless; bad sources keep their fact", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const { catalog, deps } = await setup(env);
        const factStore = await createFactStoreForUrl(env.store, env.factsSchema);
        await factStore.initialize();
        try {
            const owners = new Map();
            const mdeps = { ...deps, factStore, sessionOwner: async (id) => owners.get(id) ?? null };
            const admin = { principal: { provider: "test", subject: "car-admin" }, resourceAdmin: true };
            const plant = async (name, sessionId, html, overrides = {}) => {
                const filename = `app-${name}.html`;
                await deps.artifactStore.uploadArtifact(sessionId, filename, html, "text/html");
                await factStore.storeFact({ key: `apps/${name}`, shared: true, value: {
                    name, description: DESCRIPTION, tags: ["legacy"],
                    source: { kind: "artifact", sessionId, filename, sha256: sha256Hex(html) }, ...overrides,
                } });
            };
            const ok = `car-leg-ok-${env.runId}`;
            const orphan = `car-leg-orphan-${env.runId}`;
            const missing = `car-leg-missing-${env.runId}`;
            const tampered = `car-leg-tamper-${env.runId}`;
            const versioned = `car-leg-ver-${env.runId}`;
            owners.set("sess-alice", ALICE);
            await plant(ok, "sess-alice", page(ok));
            await plant(orphan, "sess-deleted", page(orphan));
            await plant(missing, "sess-alice", page(missing));
            await deps.artifactStore.deleteArtifact("sess-alice", `app-${missing}.html`);
            await plant(tampered, "sess-alice", page(tampered), { source: { kind: "artifact", sessionId: "sess-alice", filename: `app-${tampered}.html`, sha256: "0".repeat(64) } });
            await plant(versioned, "sess-alice", page(versioned).replace(`"name":"${versioned}"`, `"name":"${versioned}","version":"2.3.0"`));

            const mine = (r) => r.lines.filter((l) => l.name.includes(env.runId));
            const dry = await migrateLegacyCanvasApps(mdeps, admin, {});
            assertEqual(dry.dryRun, true);
            const dryBy = Object.fromEntries(mine(dry).map((l) => [l.name, l]));
            assertEqual(dryBy[ok].outcome, "migrate");
            assertEqual(dryBy[orphan].outcome, "migrate", "a deleted session with intact bytes migrates");
            assertEqual(dryBy[missing].outcome, "skipped");
            assertEqual(dryBy[tampered].outcome, "skipped");
            assertEqual(dryBy[versioned].version, "2.3.0", "the manifest's version is used");
            await expectCode(deps.store.get({ name: ok, scope: "shared" }, admin), "NOT_FOUND");

            await expectCode(migrateLegacyCanvasApps(mdeps, { principal: ALICE, resourceAdmin: false }, { dryRun: false }), "FORBIDDEN");
            const run = await migrateLegacyCanvasApps(mdeps, admin, { dryRun: false });
            const by = Object.fromEntries(mine(run).map((l) => [l.name, l]));
            assertEqual(by[ok].outcome, "migrated");
            assertEqual(by[orphan].outcome, "migrated");
            const okApp = await deps.store.get({ name: ok, scope: "shared" }, admin);
            assertEqual(okApp.owner?.subject, ALICE.subject, "owner from the session that holds the bytes");
            assertEqual(okApp.versions[0].version, "1.0.0");
            const orphanApp = await deps.store.get({ name: orphan, scope: "shared" }, admin);
            assertEqual(orphanApp.owner, null, "no owner when the session is gone");
            const left = (await factStore.readFacts({ keyPattern: "apps/*", scope: "shared", limit: 100 })).facts.map((f) => f.key);
            assert(!left.includes(`apps/${ok}`) && !left.includes(`apps/${orphan}`), "migrated facts are deleted");
            assert(left.includes(`apps/${missing}`) && left.includes(`apps/${tampered}`), "bad facts are kept");
            assert((await deps.artifactStore.listArtifacts("sess-alice")).some((f) => (f.filename ?? f.name) === `app-${ok}.html`), "old artifacts are never deleted");

            const again = await migrateLegacyCanvasApps(mdeps, admin, { dryRun: false });
            assertEqual(mine(again).filter((l) => l.outcome !== "skipped").length, 0, "a second run has nothing to migrate");
        } finally {
            await catalog.close();
            await factStore.close?.();
        }
    });
});
