/**
 * The opaque-archive `store-wins` contract of the session stores: the filesystem store and the blob store (on an in-memory container, no credentials or network).
 *
 * What is held to (and what is NOT claimed):
 *   - the compressed archive is stored as OPAQUE bytes under its own object names (`S.sandbox.bin`, `S.e<N>.sandbox.bin`), so a worker that predates this contract
 *     never sees them as a local tar; the local tar commit and hydrate also refuse an object that carries the opaque marker;
 *   - the same conditional store-wins CAS as the local tar chain: version chain, idempotent turn key, conflict on a foreign advance, and `expectedEtag` pinning the
 *     exact head (a head that was deleted and recreated at the same version is a conflict);
 *   - the turn's record is written BEFORE the head, create-only and scoped by the turn key; the head stamps its digest, and a record is trusted only for the head that
 *     stamped it; a crash between the record and the head leaves an orphan that the next attempt of the same turn replaces;
 *   - an empty, oversized (16 MiB) or malformed commit is refused before any storage write; a stored archive that no longer matches its SHA-256 is refused on read;
 *   - a large turn result is stored as a bounded compact record instead of being dropped.
 * Fakes only. These prove nothing about real Blob Storage or a real sandbox.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { SessionBlobStore } from "../../src/blob-store.ts";
import {
    REMOTE_SNAPSHOT_ARCHIVE_MAX_BYTES,
    REMOTE_TURN_COMMIT_MAX_BYTES,
    SnapshotConflictError,
    fitTurnCommit,
    parseOpaqueObjectName,
    supportsOpaqueArchives,
    turnCommitObjectName,
} from "../../src/snapshot-protocol.ts";
import { makeFakeContainer } from "../helpers/fake-container-client.js";
import { makeSessionLayout } from "../helpers/snapshot-conformance.js";

const SESSION = "sess-opaque";
const roots = [];
afterAll(() => {
    for (const root of roots) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
});

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const bytes = (text) => new Uint8Array(Buffer.from(text, "utf8"));
const text = (archive) => Buffer.from(archive).toString("utf8");

async function rejection(promise) {
    try { await promise; } catch (error) { return error; }
    return null;
}

function makeFs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-opaque-fs-"));
    roots.push(root);
    const storeDir = path.join(root, "store");
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(sessionStateDir, { recursive: true });
    const store = new FilesystemSessionStore(storeDir, sessionStateDir);
    return {
        store, sessionStateDir, names: () => fs.readdirSync(storeDir).filter((name) => !name.endsWith(".lock")).sort(),
        headName: (epoch) => (epoch ? `${SESSION}.e${epoch}.sandbox.meta.json` : `${SESSION}.sandbox.meta.json`),
        /** Leave an orphan turn record exactly as a crash between the record and the head would. */
        putOrphanRecord: (turnKey, content, epoch) => fs.writeFileSync(path.join(storeDir, turnCommitObjectName(SESSION, epoch, turnKey)), content),
        readRecord: (turnKey, epoch) => fs.readFileSync(path.join(storeDir, turnCommitObjectName(SESSION, epoch, turnKey)), "utf8"),
        writeRecord: (turnKey, content, epoch) => fs.writeFileSync(path.join(storeDir, turnCommitObjectName(SESSION, epoch, turnKey)), content),
        tamperArchive: () => {
            const bin = fs.readdirSync(storeDir).find((name) => name.endsWith(".bin"));
            fs.writeFileSync(path.join(storeDir, bin), "tampered");
        },
        misplacedTar: () => {
            fs.writeFileSync(path.join(storeDir, `${SESSION}.v3.tar.br`), "not a tar");
            fs.writeFileSync(path.join(storeDir, `${SESSION}.meta.json`), JSON.stringify({ version: 3, turnKey: "x", tarFile: `${SESSION}.v3.tar.br`, opaque: true, codec: "brotli" }));
        },
    };
}

function makeBlob() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-opaque-blob-"));
    roots.push(root);
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(sessionStateDir, { recursive: true });
    const fake = makeFakeContainer();
    const store = new SessionBlobStore({ containerClient: fake.containerClient, containerName: "fake-container", sessionStateDir });
    return {
        store, fake, sessionStateDir, names: () => fake.names(SESSION),
        headName: (epoch) => (epoch ? `${SESSION}.e${epoch}.sandbox.bin` : `${SESSION}.sandbox.bin`),
        putOrphanRecord: (turnKey, content, epoch) => fake.replace(turnCommitObjectName(SESSION, epoch, turnKey), content),
        readRecord: (turnKey, epoch) => fake.text(turnCommitObjectName(SESSION, epoch, turnKey)),
        writeRecord: (turnKey, content, epoch) => fake.replace(turnCommitObjectName(SESSION, epoch, turnKey), content),
        tamperArchive: () => fake.replace(`${SESSION}.sandbox.bin`, "tampered", { psver: "1", psturnkey: "t1", pssha: "0".repeat(64), pscodec: "brotli", psopaque: "1" }),
        misplacedTar: () => fake.replace(`${SESSION}.tar.gz`, "not a tar", { psver: "3", psturnkey: "x", pssha: "1".repeat(64), pscodec: "brotli", psopaque: "1" }),
    };
}

for (const [label, make] of [["filesystem", makeFs], ["blob", makeBlob]]) {
    describe(`${label} store: the opaque-archive contract`, () => {
        it("commits under store-wins CAS: version chain, idempotent turn key, foreign advance, pinned head", async () => {
            const w = make();
            expect(supportsOpaqueArchives(w.store)).toBe(true);
            expect(await w.store.probeSnapshotArchive(SESSION)).toEqual({ exists: false, version: 0 });

            const first = await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t1", archiveBytes: bytes("one"), codec: "gzip", rawSizeBytes: 9, turnCommit: { turnKey: "t1", result: { ok: 1 } } });
            expect(first).toMatchObject({ version: 1, contentHash: sha256(Buffer.from("one")), sizeBytes: 3, rawSizeBytes: 9, alreadyCommitted: false });
            const probe = await w.store.probeSnapshotArchive(SESSION);
            expect(probe).toMatchObject({ exists: true, version: 1, turnKey: "t1", contentHash: first.contentHash, rawSizeBytes: 9, codec: "gzip" });
            expect(probe.etag).toBeTruthy();

            // A retry of the landed commit answers with the head and writes nothing (not even with different bytes).
            const before = w.names();
            const retry = await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t1", archiveBytes: bytes("different"), codec: "gzip" });
            expect(retry).toMatchObject({ version: 1, contentHash: first.contentHash, alreadyCommitted: true });
            expect(w.names()).toEqual(before);

            const read = await w.store.readSnapshotArchive(SESSION);
            expect(text(read.archiveBytes)).toBe("one");
            expect(read).toMatchObject({ version: 1, turnKey: "t1", contentHash: first.contentHash, codec: "gzip", sizeBytes: 3, rawSizeBytes: 9, etag: probe.etag });

            // A stale base, a missing head and a wrong pin are conflicts and change nothing.
            expect(await rejection(w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t2", archiveBytes: bytes("two"), codec: "gzip" }))).toMatchObject({ name: "SnapshotConflictError", storedVersion: 1, storedTurnKey: "t1" });
            expect(await rejection(w.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "t2", archiveBytes: bytes("two"), codec: "gzip", expectedEtag: "not-the-head" }))).toBeInstanceOf(SnapshotConflictError);
            const none = make();
            expect(await rejection(none.store.commitSnapshotArchive(SESSION, { baseVersion: 3, turnKey: "t9", archiveBytes: bytes("x"), codec: "gzip" }))).toBeInstanceOf(SnapshotConflictError);
            expect(await rejection(none.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t9", archiveBytes: bytes("x"), codec: "gzip", expectedEtag: "anything" }))).toBeInstanceOf(SnapshotConflictError);
            expect(none.names()).toEqual([]);

            const second = await w.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "t2", archiveBytes: bytes("two"), codec: "gzip", expectedEtag: probe.etag });
            expect(second).toMatchObject({ version: 2, alreadyCommitted: false });
        });

        it("ABA: a head deleted and recreated at the same version is not the head the caller pinned", async () => {
            const w = make();
            await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t1", archiveBytes: bytes("original"), codec: "brotli" });
            const pinned = (await w.store.probeSnapshotArchive(SESSION)).etag;
            await w.store.delete(SESSION);
            await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t1b", archiveBytes: bytes("recreated"), codec: "brotli" });
            expect((await w.store.probeSnapshotArchive(SESSION)).version).toBe(1);
            const error = await rejection(w.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "t2", archiveBytes: bytes("two"), codec: "brotli", expectedEtag: pinned }));
            expect(error).toBeInstanceOf(SnapshotConflictError);
            expect(text((await w.store.readSnapshotArchive(SESSION)).archiveBytes)).toBe("recreated");
        });

        it("stores the chain under its own names, apart from the local tar chain and for each epoch", async () => {
            const w = make();
            await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t1", archiveBytes: bytes("epoch zero"), codec: "brotli", turnCommit: { turnKey: "t1", result: 1 } });
            await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "e1t1", archiveBytes: bytes("epoch one"), codec: "brotli", turnCommit: { turnKey: "e1t1", result: 2 } }, 1);
            // A worker that only knows the local tar chain sees nothing.
            for (const epoch of [undefined, 1]) {
                expect(await w.store.probeSnapshot(SESSION, epoch)).toEqual({ exists: false, version: 0 });
                expect(await w.store.exists(SESSION, epoch)).toBe(false);
            }
            const names = w.names();
            expect(names.some((name) => name.endsWith(".tar.gz") || name.endsWith(".tar.br") || name.endsWith(".tar"))).toBe(false);
            expect(names.some((name) => name === `${SESSION}.meta.json` || name === `${SESSION}.e1.meta.json`)).toBe(false);
            expect(names).toContain(w.headName());
            expect(names).toContain(w.headName(1));
            for (const name of names) expect(parseOpaqueObjectName(SESSION, name), name).not.toBeNull();
            expect(text((await w.store.readSnapshotArchive(SESSION, 1)).archiveBytes)).toBe("epoch one");
            expect(text((await w.store.readSnapshotArchive(SESSION)).archiveBytes)).toBe("epoch zero");
            expect(await w.store.readTrustedTurnCommit(SESSION, 1)).toEqual({ turnKey: "e1t1", result: 2 });
            expect(await w.store.readTrustedTurnCommit(SESSION)).toEqual({ turnKey: "t1", result: 1 });
        });

        it("the local tar commit and hydrate refuse an object that carries the opaque marker", async () => {
            const w = make();
            w.misplacedTar();
            makeSessionLayout(w.sessionStateDir, SESSION);
            expect(await rejection(w.store.hydrateSnapshot(SESSION))).toMatchObject({ name: "OpaqueArchiveError", code: "ARCHIVE_REPRESENTATION_CONFLICT" });
            expect(await rejection(w.store.commitSnapshot(SESSION, { baseVersion: 3, turnKey: "local" }))).toMatchObject({ name: "OpaqueArchiveError", code: "ARCHIVE_REPRESENTATION_CONFLICT" });
            // Nothing was extracted over, or committed from, the local directory.
            expect(fs.readFileSync(path.join(w.sessionStateDir, SESSION, "session.db"), "utf8")).toBe("db-seed");
            // The legacy whole-directory restore refuses too (it clears the local directory before it downloads, as it always has).
            expect(await rejection(w.store.hydrate(SESSION))).toMatchObject({ name: "OpaqueArchiveError", code: "ARCHIVE_REPRESENTATION_CONFLICT" });
        });

        it("refuses an empty, oversized, malformed or mismatched commit without touching storage", async () => {
            const w = make();
            const base = { baseVersion: 0, turnKey: "t1", codec: "brotli" };
            const before = w.names();
            expect(await rejection(w.store.commitSnapshotArchive(SESSION, { ...base, archiveBytes: new Uint8Array(REMOTE_SNAPSHOT_ARCHIVE_MAX_BYTES + 1) }))).toMatchObject({ code: "ARCHIVE_TOO_LARGE" });
            expect(await rejection(w.store.commitSnapshotArchive(SESSION, { ...base, archiveBytes: new Uint8Array(0) }))).toMatchObject({ code: "ARCHIVE_INVALID" });
            expect(await rejection(w.store.commitSnapshotArchive(SESSION, { ...base, archiveBytes: new Uint8Array(10), maxArchiveBytes: 9 }))).toMatchObject({ code: "ARCHIVE_TOO_LARGE" });
            expect(await rejection(w.store.commitSnapshotArchive(SESSION, { ...base, archiveBytes: new Uint8Array(10), maxArchiveBytes: REMOTE_SNAPSHOT_ARCHIVE_MAX_BYTES + 1 }))).toMatchObject({ code: "ARCHIVE_INVALID" });
            expect(await rejection(w.store.commitSnapshotArchive(SESSION, { ...base, archiveBytes: new Uint8Array(10), codec: "zip" }))).toMatchObject({ code: "ARCHIVE_INVALID" });
            expect(await rejection(w.store.commitSnapshotArchive(SESSION, { ...base, archiveBytes: "not bytes" }))).toMatchObject({ code: "ARCHIVE_INVALID" });
            expect(await rejection(w.store.commitSnapshotArchive(SESSION, { ...base, archiveBytes: new Uint8Array(10), turnCommit: { turnKey: "other", result: {} } }))).toMatchObject({ code: "ARCHIVE_INVALID" });
            expect(await rejection(w.store.commitSnapshotArchive(SESSION, { ...base, archiveBytes: new Uint8Array(10), turnCommit: { turnKey: "t1", result: { text: "x".repeat(REMOTE_TURN_COMMIT_MAX_BYTES) } } }))).toMatchObject({ code: "ARCHIVE_TOO_LARGE" });
            expect(w.names()).toEqual(before);
            expect(await w.store.probeSnapshotArchive(SESSION)).toEqual({ exists: false, version: 0 });
        });

        it("refuses to read an archive over the cap or one that no longer matches its SHA-256", async () => {
            const w = make();
            await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t1", archiveBytes: bytes("0123456789"), codec: "brotli" });
            expect(await rejection(w.store.readSnapshotArchive(SESSION, undefined, { maxBytes: 5 }))).toMatchObject({ code: "ARCHIVE_TOO_LARGE" });
            expect(await rejection(w.store.readSnapshotArchive(SESSION, undefined, { maxBytes: 0 }))).toMatchObject({ code: "ARCHIVE_INVALID" });
            expect(await w.store.readSnapshotArchive("no-such-session")).toBeNull();
            w.tamperArchive();
            expect(await rejection(w.store.readSnapshotArchive(SESSION))).toMatchObject({ code: "ARCHIVE_CORRUPT" });
        });
    });

    describe(`${label} store: the turn record is written before the head`, () => {
        const commit = (w, turnKey, base, result, extra = {}) => w.store.commitSnapshotArchive(SESSION, { baseVersion: base, turnKey, archiveBytes: bytes(`state of ${turnKey}`), codec: "brotli", turnCommit: { turnKey, result }, ...extra });

        it("binds the record to the head that stamped it, and trusts nothing else", async () => {
            const w = make();
            await commit(w, "t1", 0, { type: "completed", content: "one" });
            expect(await w.store.readTrustedTurnCommit(SESSION)).toEqual({ turnKey: "t1", result: { type: "completed", content: "one" } });
            const good = w.readRecord("t1");

            // A record for another head, a torn record, a replaced record: all read as absent.
            w.writeRecord("t1", good.replace('"version":1', '"version":7'));
            expect(await w.store.readTrustedTurnCommit(SESSION)).toBeNull();
            w.writeRecord("t1", good.slice(0, good.length - 5));
            expect(await w.store.readTrustedTurnCommit(SESSION)).toBeNull();
            w.writeRecord("t1", good.replace("one", "two"));
            expect(await w.store.readTrustedTurnCommit(SESSION)).toBeNull();
            w.writeRecord("t1", good);
            expect(await w.store.readTrustedTurnCommit(SESSION)).toEqual({ turnKey: "t1", result: { type: "completed", content: "one" } });
            expect(await w.store.readTrustedTurnCommit("no-such-session")).toBeNull();

            // A commit with no turn record leaves a head with none.
            await w.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "t2", archiveBytes: bytes("two"), codec: "brotli" });
            expect(await w.store.readTrustedTurnCommit(SESSION)).toBeNull();
        });

        it("a crash after the record and before the head leaves an orphan that the retry of the same turn replaces", async () => {
            const w = make();
            await commit(w, "t1", 0, "first");
            // The crash: this attempt's record landed, its head did not (another result than the retry will produce).
            w.putOrphanRecord("t2", JSON.stringify({ schema: "pilotswarm.turn-commit/v2", sessionId: SESSION, epoch: 0, version: 2, contentHash: "0".repeat(64), turnKey: "t2", result: "from the crashed attempt" }));
            expect(await w.store.readTrustedTurnCommit(SESSION)).toEqual({ turnKey: "t1", result: "first" });
            const retry = await commit(w, "t2", 1, "from the retry");
            expect(retry).toMatchObject({ version: 2, alreadyCommitted: false });
            expect(await w.store.readTrustedTurnCommit(SESSION)).toEqual({ turnKey: "t2", result: "from the retry" });
        });

        it("a committed turn key is answered from its record and never rewrites it", async () => {
            const w = make();
            await commit(w, "t1", 0, "first");
            const record = w.readRecord("t1");
            const retry = await commit(w, "t1", 0, "a different result");
            expect(retry.alreadyCommitted).toBe(true);
            expect(w.readRecord("t1")).toBe(record);
            expect(await w.store.readTrustedTurnCommit(SESSION)).toEqual({ turnKey: "t1", result: "first" });
        });

        it("keeps only the current head's record and removes every record with the chain", async () => {
            const w = make();
            await commit(w, "t1", 0, 1);
            await commit(w, "t2", 1, 2);
            await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "e1t1", archiveBytes: bytes("e1"), codec: "brotli", turnCommit: { turnKey: "e1t1", result: 3 } }, 1);
            expect(w.names().filter((name) => name.includes("turn-commit"))).toHaveLength(2);
            expect(w.names().some((name) => name === turnCommitObjectName(SESSION, undefined, "t1"))).toBe(false);
            await w.store.deleteAllEpochs(SESSION);
            expect(w.names().filter((name) => /turn-commit|sandbox|\.tar\.|\.meta\.json/.test(name))).toEqual([]);
        });
    });
}

describe("the blob store, specifically", () => {
    it("a crash between the record and the head (the head write fails once) leaves the stored head and its record untouched, and the retry lands", async () => {
        const w = makeBlob();
        await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t1", archiveBytes: bytes("one"), codec: "brotli", turnCommit: { turnKey: "t1", result: "first" } });
        let crashed = false;
        w.fake.hooks.beforeUpload = async (name) => {
            if (name === `${SESSION}.sandbox.bin` && !crashed) { crashed = true; throw new Error("process died before the head write"); }
        };
        const failed = await rejection(w.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "t2", archiveBytes: bytes("two"), codec: "brotli", turnCommit: { turnKey: "t2", result: "second" } }));
        expect(failed).toMatchObject({ message: "process died before the head write" });
        expect(await w.store.probeSnapshotArchive(SESSION)).toMatchObject({ version: 1, turnKey: "t1" });
        expect(await w.store.readTrustedTurnCommit(SESSION)).toEqual({ turnKey: "t1", result: "first" });
        expect(w.names()).toContain(turnCommitObjectName(SESSION, undefined, "t2"));

        const retry = await w.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "t2", archiveBytes: bytes("two"), codec: "brotli", turnCommit: { turnKey: "t2", result: "second" } });
        expect(retry).toMatchObject({ version: 2, alreadyCommitted: false });
        expect(await w.store.readTrustedTurnCommit(SESSION)).toEqual({ turnKey: "t2", result: "second" });
        expect(w.names()).not.toContain(turnCommitObjectName(SESSION, undefined, "t1"));
    });

    it("loses a head race cleanly: the foreign winner stands and the loser's record is never trusted", async () => {
        const w = makeBlob();
        await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t1", archiveBytes: bytes("one"), codec: "brotli", turnCommit: { turnKey: "t1", result: "first" } });
        w.fake.hooks.beforeUpload = async (name) => {
            if (name === `${SESSION}.sandbox.bin`) {
                w.fake.hooks.beforeUpload = null;
                await w.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "foreign", archiveBytes: bytes("foreign"), codec: "brotli", turnCommit: { turnKey: "foreign", result: "won" } });
            }
        };
        const lost = await rejection(w.store.commitSnapshotArchive(SESSION, { baseVersion: 1, turnKey: "mine", archiveBytes: bytes("mine"), codec: "brotli", turnCommit: { turnKey: "mine", result: "lost" } }));
        expect(lost).toMatchObject({ name: "SnapshotConflictError", storedVersion: 2, storedTurnKey: "foreign" });
        expect(await w.store.readTrustedTurnCommit(SESSION)).toEqual({ turnKey: "foreign", result: "won" });
        expect(text((await w.store.readSnapshotArchive(SESSION)).archiveBytes)).toBe("foreign");
    });

    it("keeps the key-shape invariant: no opaque object ends .tar.gz or .meta.json", async () => {
        const w = makeBlob();
        await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t1", archiveBytes: bytes("one"), codec: "brotli", turnCommit: { turnKey: "t1", result: 1 } });
        await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "e1", archiveBytes: bytes("one"), codec: "brotli", turnCommit: { turnKey: "e1", result: 1 } }, 3);
        for (const name of w.names()) expect(/\.tar\.gz$|\.meta\.json$/.test(name), name).toBe(false);
    });
});

describe("a large turn result is stored as a bounded compact record", () => {
    it("keeps a result that fits, drops the events of one that does not, and truncates the rest", () => {
        const small = { type: "completed", content: "hello", events: [{ n: 1 }] };
        expect(fitTurnCommit("k", small)).toEqual({ turnCommit: { turnKey: "k", result: small }, record: "stored" });

        const withEvents = { type: "completed", content: "answer", events: [{ blob: "e".repeat(REMOTE_TURN_COMMIT_MAX_BYTES) }] };
        expect(fitTurnCommit("k", withEvents)).toEqual({ turnCommit: { turnKey: "k", result: { type: "completed", content: "answer" } }, record: "compacted" });

        const huge = { type: "completed", status: "ok", content: "c".repeat(REMOTE_TURN_COMMIT_MAX_BYTES * 3), extra: { nested: "n".repeat(REMOTE_TURN_COMMIT_MAX_BYTES) }, events: [] };
        const fit = fitTurnCommit("k", huge);
        expect(fit.record).toBe("compacted");
        expect(fit.turnCommit.result).toMatchObject({ type: "completed", status: "ok", truncated: true });
        expect(fit.turnCommit.result.content.length).toBeLessThan(huge.content.length);
        expect(Buffer.byteLength(JSON.stringify(fit.turnCommit), "utf8")).toBeLessThanOrEqual(REMOTE_TURN_COMMIT_MAX_BYTES);
        expect(fitTurnCommit("k", "x".repeat(REMOTE_TURN_COMMIT_MAX_BYTES * 2)).turnCommit.result).toEqual({ truncated: true });
    });

    it("the compact record is accepted by both stores", async () => {
        for (const make of [makeFs, makeBlob]) {
            const w = make();
            const { turnCommit } = fitTurnCommit("t1", { type: "completed", content: "c".repeat(REMOTE_TURN_COMMIT_MAX_BYTES * 2) });
            await w.store.commitSnapshotArchive(SESSION, { baseVersion: 0, turnKey: "t1", archiveBytes: bytes("one"), codec: "brotli", turnCommit });
            expect(await w.store.readTrustedTurnCommit(SESSION)).toEqual(turnCommit);
        }
    });
});
