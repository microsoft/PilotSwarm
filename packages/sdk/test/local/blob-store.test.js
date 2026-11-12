import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SessionBlobStore } from "../../src/blob-store.ts";
import { makeSessionLayout } from "../helpers/snapshot-conformance.js";

function makeConnectionString() {
    const accountKey = Buffer.from("pilotswarm-test-key").toString("base64");
    return [
        "DefaultEndpointsProtocol=https",
        "AccountName=pilotswarmtest",
        `AccountKey=${accountKey}`,
        "EndpointSuffix=core.windows.net",
    ].join(";");
}

describe("SessionBlobStore", () => {
    it("scopes commit and hydrate fault hits to the session with a synthetic blob transport", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-blob-fault-"));
        const sessionStateDir = path.join(root, "session-state");
        const blobs = new Map();
        const store = new SessionBlobStore({
            containerClient: {
                getBlockBlobClient(name) {
                    return {
                        async getProperties() {
                            if (!blobs.has(name)) throw Object.assign(new Error("not found"), { statusCode: 404 });
                            return { metadata: blobs.get(name).metadata, etag: "test-etag" };
                        },
                        async upload(body, _length, options) {
                            blobs.set(name, { body: Buffer.from(body), metadata: options.metadata });
                        },
                        async downloadToFile(file) {
                            const blob = blobs.get(name);
                            fs.writeFileSync(file, blob.body);
                            return { metadata: blob.metadata };
                        },
                    };
                },
            },
            containerName: "test-container",
            sharedKeyCredential: null,
            sessionStateDir,
        });
        const other = `other-${randomUUID()}`;
        const target = `target-${randomUUID()}`;
        const points = ["store.commit.before-write", "store.commit.after-write", "store.hydrate.before-swap"];
        const savedSpec = process.env.PILOTSWARM_FAULT_INJECT;
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            for (const id of [other, target]) makeSessionLayout(sessionStateDir, id);
            process.env.PILOTSWARM_FAULT_INJECT = points.map(point => `${point}:log:2`).join(",");
            for (const [id, baseVersion] of [[other, 0], [target, 0], [target, 1]]) {
                await store.commitSnapshot(id, { baseVersion, turnKey: `t${baseVersion + 1}` }, 1);
                await store.hydrateSnapshot(id, 1);
            }
            for (const point of points) {
                expect(log.mock.calls.map(([line]) => line)
                    .filter(line => line.startsWith(`[fault-injection] hit point=${point} `))).toEqual([
                    `[fault-injection] hit point=${point} action=log hit=1/2 session=${other} fired=false`,
                    `[fault-injection] hit point=${point} action=log hit=1/2 session=${target} fired=false`,
                    `[fault-injection] hit point=${point} action=log hit=2/2 session=${target} fired=true`,
                ]);
            }
        } finally {
            if (savedSpec === undefined) delete process.env.PILOTSWARM_FAULT_INJECT;
            else process.env.PILOTSWARM_FAULT_INJECT = savedSpec;
            log.mockRestore();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("archives the current session snapshot layout on dehydrate", async () => {
        // The post-disconnect contract: by the time we call dehydrate, the SDK
        // has either flushed durably or it never will. There is no race to
        // wait for; the directory either has the layout or it doesn't.
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-blob-store-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "current-layout-session";
        const sessionDir = path.join(sessionStateDir, sessionId);

        const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
        const uploads = [];
        const metadataWrites = [];

        store.containerClient = {
            getBlockBlobClient(name) {
                return {
                    async uploadFile(filePath) {
                        uploads.push({ name, filePath, exists: fs.existsSync(filePath) });
                    },
                    async upload(body) {
                        metadataWrites.push({ name, body: String(body) });
                    },
                    async deleteIfExists() {},
                    async downloadToFile() {
                        throw new Error("downloadToFile should not be called in this test");
                    },
                    async exists() {
                        return true;
                    },
                    url: `https://example.test/${name}`,
                };
            },
            async *listBlobsFlat() {},
        };

        // Write the layout synchronously, the way a healthy post-disconnect
        // session directory looks on disk.
        fs.mkdirSync(path.join(sessionDir, "checkpoints"), { recursive: true });
        fs.mkdirSync(path.join(sessionDir, "files"), { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "checkpoints", "index.md"), "# checkpoint\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "files", "README.md"), "workspace file\n", "utf-8");

        try {
            await store.dehydrate(sessionId, { reason: "cron" });

            expect(uploads).toHaveLength(1);
            expect(uploads[0].name).toBe(`${sessionId}.tar.gz`);
            expect(uploads[0].exists).toBe(true);
            expect(metadataWrites).toHaveLength(1);
            expect(metadataWrites[0].name).toBe(`${sessionId}.meta.json`);
            expect(JSON.parse(metadataWrites[0].body).reason).toBe("cron");
            expect(fs.existsSync(sessionDir)).toBe(false);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("rejects when the session directory is missing the required layout", async () => {
        // Single-shot semantics: if the dir is missing or empty when dehydrate
        // is called, that's terminal — the SDK will never produce more state
        // for this session.
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-blob-store-empty-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "missing-layout-session";

        const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
        store.containerClient = {
            getBlockBlobClient() {
                return {
                    async uploadFile() { throw new Error("uploadFile should not be called"); },
                    async upload() { throw new Error("upload should not be called"); },
                    async deleteIfExists() {},
                    async exists() { return false; },
                    url: "https://example.test/missing",
                };
            },
            async *listBlobsFlat() {},
        };

        try {
            await expect(store.dehydrate(sessionId, { reason: "cron" }))
                .rejects.toThrow(/Session state directory not ready during dehydrate/i);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("continues to accept the legacy events.jsonl snapshot layout", async () => {
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-blob-store-legacy-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "legacy-session";
        const sessionDir = path.join(sessionStateDir, sessionId);

        const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
        const uploads = [];

        store.containerClient = {
            getBlockBlobClient(name) {
                return {
                    async uploadFile(filePath) {
                        uploads.push({ name, filePath, exists: fs.existsSync(filePath) });
                    },
                    async upload() {},
                    async deleteIfExists() {},
                    async downloadToFile() {
                        throw new Error("downloadToFile should not be called in this test");
                    },
                    async exists() {
                        return true;
                    },
                    url: `https://example.test/${name}`,
                };
            },
            async *listBlobsFlat() {},
        };

        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "events.jsonl"), "{}\n", "utf-8");

        try {
            await store.dehydrate(sessionId, { reason: "legacy" });

            expect(uploads).toHaveLength(1);
            expect(uploads[0].name).toBe(`${sessionId}.tar.gz`);
            expect(fs.existsSync(sessionDir)).toBe(false);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("throws NotSupportedInManagedIdentityMode when generating a SAS URL in MI mode", () => {
        // MI-mode invariant: when the store is constructed via the
        // managed-identity factory branch (no shared-key credential),
        // generateArtifactSasUrl() must refuse with a typed error so
        // callers (TUI / portal) know to proxy the download through the
        // worker instead of relying on a shared-key SAS. This is the
        // contract the JSDoc on createSessionBlobStore() and on
        // generateArtifactSasUrl() promises; locking it in a test means
        // a future "helpful" fallback that silently mints a UDK SAS or
        // returns a public URL would break this assertion loudly.
        const fakeContainerClient = {
            getBlockBlobClient() {
                throw new Error("getBlockBlobClient should not be reached in MI-mode SAS test");
            },
            async *listBlobsFlat() {},
        };

        const store = new SessionBlobStore({
            containerClient: fakeContainerClient,
            containerName: "copilot-sessions",
            sharedKeyCredential: null,
            sessionStateDir: os.tmpdir(),
        });

        let caught;
        try {
            store.generateArtifactSasUrl("session-mi", "out.txt", 1);
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(Error);
        expect(caught.code).toBe("NotSupportedInManagedIdentityMode");
        expect(caught.message).toMatch(/managed-identity mode/i);
    });
});
