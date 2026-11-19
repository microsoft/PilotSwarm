import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import { NodeSdkTransport } from "../../../app/tui/src/node-sdk-transport.js";
import { FilesystemArtifactStore, resolveArtifactUpload } from "../../src/session-store.ts";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";

const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92,
    0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe("binary artifact store", () => {
    it("round-trips binary artifacts with metadata and blocks text reads", async () => {
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-artifacts-"));
        const store = new FilesystemArtifactStore(artifactDir);

        try {
            const metadata = await store.uploadArtifact("session-binary", "tiny.png", PNG_BYTES, "image/png");

            assertEqual(metadata.filename, "tiny.png", "uploaded metadata should preserve the filename");
            assertEqual(metadata.contentType, "image/png", "uploaded metadata should preserve the mime type");
            assertEqual(metadata.isBinary, true, "png uploads should be marked binary");
            assertEqual(metadata.sizeBytes, PNG_BYTES.length, "binary uploads should report the decoded byte size");

            const download = await store.downloadArtifact("session-binary", "tiny.png");
            assertEqual(download.isBinary, true, "binary download should stay marked binary");
            assertEqual(download.contentType, "image/png", "binary download should keep its mime type");
            assertEqual(Buffer.compare(download.body, PNG_BYTES), 0, "downloaded bytes should match the uploaded bytes");

            const listed = await store.listArtifacts("session-binary");
            assertEqual(listed.length, 1, "listArtifacts should return one metadata record");
            assertEqual(listed[0].filename, "tiny.png", "listed metadata should include the filename");
            assertEqual(listed[0].isBinary, true, "listed metadata should mark png as binary");

            let error = null;
            try {
                await store.downloadArtifactText("session-binary", "tiny.png");
            } catch (err) {
                error = err;
            }

            assert(error, "downloadArtifactText should reject binary artifacts");
            assertEqual(error.code, "ARTIFACT_IS_BINARY", "binary text reads should throw the binary error code");
            assertEqual(error.contentType, "image/png", "binary text read errors should expose the content type");
            assertEqual(error.sizeBytes, PNG_BYTES.length, "binary text read errors should expose the byte size");
        } finally {
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });

    it("decodes base64 uploads and preserves default text behavior", async () => {
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-artifacts-"));
        const store = new FilesystemArtifactStore(artifactDir);

        try {
            const binaryMetadata = await store.uploadArtifact(
                "session-base64",
                "tiny.png",
                PNG_BYTES.toString("base64"),
                "image/png",
                { encoding: "base64" },
            );
            assertEqual(binaryMetadata.sizeBytes, PNG_BYTES.length, "base64 uploads should report decoded byte size");

            await store.uploadArtifact("session-base64", "note.md", "# hello artifacts\n");
            const note = await store.downloadArtifactText("session-base64", "note.md");
            assertIncludes(note, "# hello artifacts", "text uploads should remain readable as utf-8 text");
        } finally {
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });
});

describe("artifact create-only and MIME compatibility", () => {
    it("publishes create-only filesystem uploads atomically and preserves overwrite defaults", async () => {
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-artifacts-create-"));
        const store = new FilesystemArtifactStore(artifactDir);
        try {
            const attempts = await Promise.allSettled([
                store.uploadArtifact("session-create", "same.md", "first", "text/markdown", { ifAbsent: true }),
                store.uploadArtifact("session-create", "same.md", "second", "text/markdown", { ifAbsent: true }),
            ]);
            assertEqual(attempts.filter(result => result.status === "fulfilled").length, 1, "exactly one create-only publisher should win");
            const conflict = attempts.find(result => result.status === "rejected");
            assertEqual(conflict?.reason?.code, "ARTIFACT_ALREADY_EXISTS", "the losing publisher should receive the stable conflict code");
            assertEqual(conflict?.reason?.status, 409, "filesystem conflicts should carry HTTP conflict status");
            const won = await store.downloadArtifactText("session-create", "same.md");
            assert(["first", "second"].includes(won), "the published body should be one complete contender");

            await store.uploadArtifact("session-create", "same.md", "replacement", "text/markdown");
            assertEqual(await store.downloadArtifactText("session-create", "same.md"), "replacement", "ordinary uploads should still overwrite");
            const files = fs.readdirSync(path.join(artifactDir, "session-create"));
            assertEqual(files.some(name => name.includes("tmp")), false, "temporary publish files should always be cleaned");
            assertEqual(files.filter(name => !name.startsWith(".")).length, 1, "only the artifact should be visible");
        } finally {
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });

    it("supports max-length names and keeps metadata sidecars separate from artifact names", async () => {
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-artifacts-long-"));
        const store = new FilesystemArtifactStore(artifactDir);
        const longName = `${"x".repeat(251)}.bin`;
        try {
            await store.uploadArtifact("session-long", longName, PNG_BYTES, "application/octet-stream", { ifAbsent: true });
            await store.uploadArtifact("session-long", "report", "plain", "text/plain", { ifAbsent: true });
            await store.uploadArtifact("session-long", "report.meta.json", "real artifact", "text/plain", { ifAbsent: true });
            const listed = await store.listArtifacts("session-long");
            assertEqual(listed.some(item => item.filename === longName), true, "NAME_MAX artifact should upload and list");
            assertEqual(listed.some(item => item.filename === "report"), true, "base artifact should list");
            assertEqual(listed.some(item => item.filename === "report.meta.json"), true, "metadata-looking artifact should remain independent");
            const files = fs.readdirSync(path.join(artifactDir, "session-long"));
            assertEqual(files.some(name => name.includes("tmp")), false, "hidden temp files should be cleaned");
            assertEqual(files.filter(name => name.startsWith(".ps-artifact-meta-")).length, 3, "metadata should use hidden fixed-length names");
        } finally {
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });

    it("surfaces a stable error when hard-link atomic publication is unsupported", async () => {
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-artifacts-link-"));
        const store = new FilesystemArtifactStore(artifactDir);
        const link = vi.spyOn(fs, "linkSync").mockImplementation(() => {
            throw Object.assign(new Error("hard links disabled"), { code: "EPERM" });
        });
        try {
            let error = null;
            try {
                await store.uploadArtifact("session-link", "safe.bin", PNG_BYTES, "application/octet-stream", { ifAbsent: true });
            } catch (caught) {
                error = caught;
            }
            assertEqual(error?.code, "ARTIFACT_ATOMIC_CREATE_UNSUPPORTED", "unsupported hard links should have a stable error");
            assertEqual(await store.statArtifact("session-link", "safe.bin"), null, "unsupported atomic create must not expose a target");
            const files = fs.readdirSync(path.join(artifactDir, "session-link"));
            assertEqual(files.length, 0, "failed atomic create should clean hidden temporary files");
        } finally {
            link.mockRestore();
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });

    it("accepts explicit Office, RAR, and XLSM container compatibility without accepting unrelated mismatches", async () => {
        const cfb = Buffer.alloc(512);
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cfb);
        for (const declared of ["application/vnd.ms-excel", "application/msword", "application/vnd.ms-powerpoint"]) {
            const resolved = await resolveArtifactUpload(cfb, declared);
            assertEqual(resolved.metadata.contentType, declared, "CFB should be compatible with " + declared);
        }

        const rar = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x00]);
        for (const declared of ["application/vnd.rar", "application/x-rar-compressed"]) {
            const resolved = await resolveArtifactUpload(rar, declared);
            assertEqual(resolved.metadata.contentType, "application/vnd.rar", "RAR aliases should canonicalize compatibly");
        }

        const emptyZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
        const xlsm = await resolveArtifactUpload(emptyZip, "application/vnd.ms-excel.sheet.macroenabled.12");
        assertEqual(xlsm.metadata.contentType, "application/vnd.ms-excel.sheet.macroenabled.12", "XLSM should accept ZIP container bytes");

        let mismatch = null;
        try {
            await resolveArtifactUpload(PNG_BYTES, "application/pdf");
        } catch (error) {
            mismatch = error;
        }
        assertEqual(mismatch?.code, "ARTIFACT_CONTENT_TYPE_MISMATCH", "unrelated declared and sniffed types must still be rejected");

        const sniffedFormats = [
            ["gzip", Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0x03])],
            ["zip", Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)])],
            ["7z", Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04, 0, 0, 0, 0])],
            ["zstd", Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00, 0x00])],
            ["CFB", cfb],
            ["SQLite", Buffer.from("SQLite format 3\u0000", "binary")],
            ["HEIC", Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63])],
        ];
        for (const [name, bytes] of sniffedFormats) {
            const generic = await resolveArtifactUpload(bytes, "application/octet-stream");
            assertEqual(generic.metadata.contentType, "application/octet-stream", `${name} bytes should retain a generic declaration`);
        }
    });
});

describe("binary artifact transport", () => {
    it("uploads file paths as raw bytes and saves raw-byte downloads intact", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-artifact-transport-"));
        const sourcePath = path.join(tempDir, "tiny.png");
        fs.writeFileSync(sourcePath, PNG_BYTES);

        const uploaded = [];
        const fakeTransport = {
            artifactStore: {
                async uploadArtifact(sessionId, filename, content, contentType) {
                    uploaded.push({ sessionId, filename, content, contentType });
                    return {
                        filename,
                        sizeBytes: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content || ""), "utf8"),
                        contentType,
                        isBinary: true,
                        uploadedAt: new Date().toISOString(),
                        source: "user",
                    };
                },
                async downloadArtifact(sessionId, filename) {
                    return {
                        filename,
                        sizeBytes: PNG_BYTES.length,
                        contentType: "image/png",
                        isBinary: true,
                        uploadedAt: new Date().toISOString(),
                        source: "user",
                        body: PNG_BYTES,
                    };
                },
                async downloadArtifactText() {
                    throw new Error("downloadArtifactText should not be called in this test");
                },
            },
        };

        let saved = null;
        try {
            const uploadResult = await NodeSdkTransport.prototype.uploadArtifactFromPath.call(fakeTransport, "session-transport", sourcePath);
            assertEqual(uploaded.length, 1, "uploadArtifactFromPath should write exactly one artifact");
            assert(Buffer.isBuffer(uploaded[0].content), "path uploads should pass raw bytes to the artifact store");
            assertEqual(uploaded[0].contentType, "image/png", "path uploads should infer the png content type");
            assertEqual(uploadResult.sizeBytes, PNG_BYTES.length, "path uploads should report the file byte size");

            saved = await NodeSdkTransport.prototype.saveArtifactDownload.call(fakeTransport, "session-transport", "tiny.png");
            const written = fs.readFileSync(saved.localPath);
            assertEqual(Buffer.compare(written, PNG_BYTES), 0, "saveArtifactDownload should write raw artifact bytes to disk");
        } finally {
            if (saved?.localPath) {
                fs.rmSync(path.dirname(saved.localPath), { recursive: true, force: true });
            }
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});