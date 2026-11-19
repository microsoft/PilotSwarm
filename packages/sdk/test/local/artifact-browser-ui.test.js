import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BrowserPortalTransport } from "../../../app/web/src/browser-transport.js";
import { PROMPT_ARTIFACT_UPLOAD_MAX_BYTES, TEXT_ARTIFACT_MAX_BYTES } from "../../../app/ui/core/src/artifact-content-type.js";
import { NodeSdkTransport } from "../../../app/tui/src/node-sdk-transport.js";
import { PilotSwarmUiController } from "../../../app/ui/core/src/controller.js";
import { appReducer } from "../../../app/ui/core/src/reducer.js";
import { selectFileBrowserItems } from "../../../app/ui/core/src/selectors.js";
import { createInitialState } from "../../../app/ui/core/src/state.js";
import { createStore } from "../../../app/ui/core/src/store.js";
import { assertEqual, assertIncludes } from "../helpers/assertions.js";

function createController(transportOverrides = {}) {
    const transport = {
        start: async () => {},
        stop: async () => {},
        listSessions: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    return {
        store,
        transport,
        controller: new PilotSwarmUiController({ store, transport }),
    };
}

function seedSession(store, sessionId = "session-12345678") {
    store.dispatch({
        type: "sessions/loaded",
        sessions: [{
            sessionId,
            title: "Artifact Browser Test",
            status: "completed",
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }],
    });
    return sessionId;
}

describe("artifact browser UI", () => {
    it("encodes browser file uploads as base64 for binary-safe RPC transport", async () => {
        // BrowserPortalTransport is a browser-only class: its constructor reads
        // window.location.origin as the API base. Provide the minimal browser
        // global so the transport can be unit-tested in Node.
        const hadWindow = "window" in globalThis;
        if (!hadWindow) globalThis.window = { location: { origin: "http://localhost" } };
        try {
            const transport = new BrowserPortalTransport({
                getAccessToken: async () => null,
            });
            let apiCall = null;
            transport.api.call = async (method, params) => {
                apiCall = { method, params };
                return { ok: true };
            };

            await transport.uploadArtifactFromFile("session-upload", {
                name: "tiny.jpg",
                type: "image/jpeg",
                arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]).buffer,
            });

            assertEqual(apiCall?.method, "uploadArtifact", "browser uploads should still use the uploadArtifact operation");
            assertEqual(apiCall?.params?.contentEncoding, "base64", "browser uploads should mark binary payloads as base64");
            assertEqual(apiCall?.params?.content, "/9j/2wBD", "browser uploads should preserve the raw JPEG bytes in base64 form");
            assertEqual(apiCall?.params?.ifAbsent, false, "ordinary Files-pane uploads should keep overwrite behavior");
        } finally {
            if (!hadWindow) delete globalThis.window;
        }
    });

    it("normalizes browser MIME types for gzip and unknown binary uploads", async () => {
        const hadWindow = "window" in globalThis;
        if (!hadWindow) globalThis.window = { location: { origin: "http://localhost" } };
        try {
            const transport = new BrowserPortalTransport({
                getAccessToken: async () => null,
            });
            const uploads = [];
            transport.api.call = async (method, params) => {
                uploads.push({ method, params });
                return { ok: true };
            };
            const file = (name, type) => ({
                name,
                type,
                arrayBuffer: async () => Uint8Array.from([0x1f, 0x8b]).buffer,
            });

            await transport.uploadPromptArtifactFromFile("session-upload", file("empty.tar.gz", ""));
            await transport.uploadPromptArtifactFromFile("session-upload", file("empty.tgz", ""));
            await transport.uploadPromptArtifactFromFile("session-upload", file("empty.gz", ""));
            await transport.uploadPromptArtifactFromFile("session-upload", file("windows.tgz", "application/x-gzip"));
            await transport.uploadPromptArtifactFromFile("session-upload", file("windows.tar.gz", "application/x-compressed-tar"));
            await transport.uploadPromptArtifactFromFile("session-upload", file("windows.zip", "application/x-zip-compressed"));
            await transport.uploadPromptArtifactFromFile("session-upload", file("excel.csv", "application/vnd.ms-excel"));
            await transport.uploadPromptArtifactFromFile("session-upload", file("notes.md", ""));
            await transport.uploadPromptArtifactFromFile("session-upload", file("query.sql", ""));
            await transport.uploadPromptArtifactFromFile("session-upload", file("config.yaml", ""));
            await transport.uploadPromptArtifactFromFile("session-upload", file("events.jsonl", ""));
            await transport.uploadPromptArtifactFromFile("session-upload", file("server.log", ""));
            await transport.uploadPromptArtifactFromFile("session-upload", file("data.json", ""));
            for (const name of [
                "config.toml",
                "settings.ini",
                "script.py",
                "run.sh",
                "setup.ps1",
                "query.kql",
                "events.ndjson",
                "change.diff",
                "fix.patch",
                ".env",
                "Dockerfile",
            ]) {
                await transport.uploadPromptArtifactFromFile("session-upload", file(name, ""));
            }
            await transport.uploadPromptArtifactFromFile("session-upload", file("unknown.custom", ""));
            await transport.uploadArtifactFromFile("session-upload", file("files-pane.md", ""));
            await transport.uploadPromptArtifactFromFile("session-upload", file("windows.tgz", "application/x-compressed"));
            await transport.uploadPromptArtifactFromFile("session-upload", file("windows.tar.gz", "application/x-compressed"));
            await transport.uploadPromptArtifactFromFile("session-upload", file("archive.rar", "application/x-rar-compressed"));
            await transport.uploadPromptArtifactFromFile("session-upload", file("macro.xlsm", ""));
            await transport.uploadPromptArtifactFromFile("session-upload", file("legacy.xls", "application/x-cfb"));
            await transport.uploadPromptArtifactFromFile("session-upload", file("legacy.doc", "application/octet-stream"));
            await transport.uploadPromptArtifactFromFile("session-upload", file("macro.xlsm", "application/zip"));
            await transport.uploadPromptArtifactFromFile("session-upload", file("archive.rar", "application/octet-stream"));
            await transport.uploadPromptArtifactFromFile("session-upload", file("opaque.custom", "application/octet-stream"));
            await transport.uploadArtifactFromFile("session-upload", file("files-pane.bin", "application/octet-stream"));

            assertEqual(uploads[0]?.params?.contentType, "application/gzip", "empty .tar.gz MIME should normalize to application/gzip");
            assertEqual(uploads[1]?.params?.contentType, "application/gzip", "empty .tgz MIME should normalize to application/gzip");
            assertEqual(uploads[2]?.params?.contentType, "application/gzip", "empty .gz MIME should normalize to application/gzip");
            assertEqual(uploads[3]?.params?.contentType, "application/gzip", "application/x-gzip should normalize to application/gzip");
            assertEqual(uploads[4]?.params?.contentType, "application/gzip", "application/x-compressed-tar should normalize to application/gzip");
            assertEqual(uploads[5]?.params?.contentType, "application/zip", "application/x-zip-compressed should normalize to application/zip");
            assertEqual(uploads[6]?.params?.contentType, "text/csv", "CSV reported as application/vnd.ms-excel should stay readable");
            assertEqual(uploads[7]?.params?.contentType, "text/markdown", "empty-MIME Markdown should stay readable");
            assertEqual(uploads[8]?.params?.contentType, "text/plain", "empty-MIME SQL should stay readable");
            assertEqual(uploads[9]?.params?.contentType, "text/yaml", "empty-MIME YAML should stay readable");
            assertEqual(uploads[10]?.params?.contentType, "application/json", "empty-MIME JSONL should stay readable");
            assertEqual(uploads[11]?.params?.contentType, "text/plain", "empty-MIME logs should stay readable");
            assertEqual(uploads[12]?.params?.contentType, "application/json", "empty-MIME JSON should stay readable");
            for (let index = 13; index < 24; index += 1) {
                assertEqual(uploads[index]?.params?.contentType, "text/plain", "common empty-MIME text/code files should stay readable");
            }
            assertEqual(uploads[24]?.params?.contentType, "application/octet-stream", "unknown empty MIME should normalize to application/octet-stream");
            assertEqual(uploads[25]?.params?.contentType, undefined, "Files-pane uploads should preserve empty MIME for existing filename inference");
            assertEqual(uploads[25]?.params?.ifAbsent, false, "Files-pane uploads should preserve overwrite behavior");
            assertEqual(uploads[26]?.params?.contentType, "application/gzip", "application/x-compressed .tgz should normalize to gzip");
            assertEqual(uploads[27]?.params?.contentType, "application/gzip", "application/x-compressed .tar.gz should normalize to gzip");
            assertEqual(uploads[28]?.params?.contentType, "application/vnd.rar", "legacy RAR MIME should normalize to the canonical alias");
            assertEqual(uploads[29]?.params?.contentType, "application/vnd.ms-excel.sheet.macroenabled.12", "XLSM should use its macro-enabled OpenXML MIME");
            assertEqual(uploads[29]?.params?.ifAbsent, true, "composer generic uploads should be create-only");
            assertEqual(uploads[30]?.params?.contentType, "application/vnd.ms-excel", "CFB-reported XLS should use its extension's canonical MIME");
            assertEqual(uploads[31]?.params?.contentType, "application/msword", "octet-stream DOC should use its extension's canonical MIME");
            assertEqual(uploads[32]?.params?.contentType, "application/vnd.ms-excel.sheet.macroenabled.12", "ZIP-reported XLSM should use its canonical OpenXML MIME");
            assertEqual(uploads[33]?.params?.contentType, "application/vnd.rar", "octet-stream RAR should use its canonical MIME");
            assertEqual(uploads[34]?.params?.contentType, "application/octet-stream", "unknown explicit octet-stream should retain generic compatibility");
            assertEqual(uploads[35]?.params?.contentType, "application/octet-stream", "Files-pane generic binary MIME should remain compatible");
            assertEqual(uploads[35]?.params?.ifAbsent, false, "Files-pane generic binary upload should preserve overwrite behavior");
        } finally {
            if (!hadWindow) delete globalThis.window;
        }
    });

    it("rejects composer files that cannot fit the 8 MB JSON upload route before reading bytes", async () => {
        const hadWindow = "window" in globalThis;
        if (!hadWindow) globalThis.window = { location: { origin: "http://localhost" } };
        try {
            const transport = new BrowserPortalTransport({
                getAccessToken: async () => null,
            });
            let reads = 0;
            transport.api.call = async () => ({ ok: true });
            const file = (size) => ({
                name: "payload.bin",
                type: "",
                size,
                arrayBuffer: async () => {
                    reads += 1;
                    return new ArrayBuffer(0);
                },
            });

            await transport.uploadPromptArtifactFromFile(
                "session-upload",
                file(PROMPT_ARTIFACT_UPLOAD_MAX_BYTES),
            );
            let error = null;
            try {
                await transport.uploadPromptArtifactFromFile(
                    "session-upload",
                    file(PROMPT_ARTIFACT_UPLOAD_MAX_BYTES + 1),
                );
            } catch (caught) {
                error = caught;
            }

            assertEqual(reads, 1, "oversized composer files must be rejected before arrayBuffer/base64 work");
            assertIncludes(error?.message, "8 MB upload route", "oversized composer errors should explain the route limit");
        } finally {
            if (!hadWindow) delete globalThis.window;
        }
    });

    it("rejects oversized text artifacts at 1 MiB while retaining the route-derived binary maximum", async () => {
        const hadWindow = "window" in globalThis;
        if (!hadWindow) globalThis.window = { location: { origin: "http://localhost" } };
        try {
            const transport = new BrowserPortalTransport({ getAccessToken: async () => null });
            let reads = 0;
            transport.api.call = async () => ({ ok: true });
            const file = (name, type, size) => ({
                name, type, size,
                arrayBuffer: async () => { reads += 1; return new ArrayBuffer(0); },
            });

            await transport.uploadPromptArtifactFromFile("session-upload", file("archive.bin", "", TEXT_ARTIFACT_MAX_BYTES + 1));
            await assert.rejects(
                transport.uploadPromptArtifactFromFile("session-upload", file("notes.md", "", TEXT_ARTIFACT_MAX_BYTES + 1)),
                /1 MiB text-artifact limit/,
            );
            assertEqual(reads, 1, "oversized text should be rejected before arrayBuffer while binary keeps the larger route cap");
        } finally {
            if (!hadWindow) delete globalThis.window;
        }
    });

    it("decodes base64 upload payloads back to raw bytes before storing artifacts", async () => {
        let storedUpload = null;
        const transport = Object.create(NodeSdkTransport.prototype);
        transport.artifactStore = {
            uploadArtifact: async (sessionId, filename, content, contentType, opts) => {
                storedUpload = { sessionId, filename, content, contentType, opts };
            },
        };

        const upload = await transport.uploadArtifactContent(
            "session-upload",
            "tiny.jpg",
            "/9j/2wBD",
            "image/jpeg",
            "base64",
            true,
        );

        assertEqual(Buffer.isBuffer(storedUpload?.content), true, "base64 uploads should be decoded to Buffer before storage");
        assertEqual(storedUpload?.content.equals(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43])), true, "decoded upload bytes should match the original JPEG payload");
        assertEqual(upload.sizeBytes, 6, "binary upload size should reflect the decoded byte length");
        assertEqual(storedUpload?.opts?.ifAbsent, true, "node transport should forward create-only semantics to the store");
    });

    it("preserves Files-pane filename inference for empty MIME values", async () => {
        const stored = [];
        const transport = Object.create(NodeSdkTransport.prototype);
        transport.artifactStore = {
            uploadArtifact: async (_sessionId, filename, _content, contentType) => {
                stored.push({ filename, contentType });
            },
        };

        await transport.uploadArtifactContent("session-upload", "notes.md", "notes", undefined);
        await transport.uploadArtifactContent("session-upload", "table.tsv", "a\tb", undefined);
        await transport.uploadArtifactContent("session-upload", "unknown.custom", "text", undefined);

        assertEqual(stored[0]?.contentType, "text/markdown", "known Files-pane text inference should be unchanged");
        assertEqual(stored[1]?.contentType, "text/plain", "TSV should preserve the old text/plain Files-pane fallback");
        assertEqual(stored[2]?.contentType, "text/plain", "unknown Files-pane names should preserve the old text/plain fallback");
    });

    it("deletes the selected artifact through the shared controller flow", async () => {
        const sessionId = "session-delete-ui";
        let artifactEntries = [
            {
                filename: "alpha.txt",
                sizeBytes: 12,
                contentType: "text/plain",
                isBinary: false,
                uploadedAt: "2026-04-21T00:00:00.000Z",
                source: "agent",
            },
            {
                filename: "beta.txt",
                sizeBytes: 10,
                contentType: "text/plain",
                isBinary: false,
                uploadedAt: "2026-04-21T00:00:01.000Z",
                source: "agent",
            },
        ];
        const deleted = [];
        const { controller, store } = createController({
            listArtifacts: async () => artifactEntries,
            downloadArtifact: async (_sessionId, filename) => `${filename} preview`,
            deleteArtifact: async (_sessionId, filename) => {
                deleted.push(filename);
                artifactEntries = artifactEntries.filter((entry) => entry.filename !== filename);
                return true;
            },
        });
        seedSession(store, sessionId);

        await controller.ensureFilesForSession(sessionId);
        store.dispatch({ type: "files/select", sessionId, filename: "alpha.txt" });

        await controller.deleteSelectedArtifact();

        const confirmModal = store.getState().ui.modal;
        assertEqual(confirmModal?.type, "confirm", "deleting from the viewer should use the shared confirm modal");
        assertEqual(confirmModal?.action, "deleteArtifact", "the confirm modal should route back to the artifact delete action");

        await controller.confirmModal();

        const fileState = store.getState().files.bySessionId[sessionId];
        assertEqual(deleted.join(","), "alpha.txt", "the selected artifact should be deleted through the transport");
        assertEqual(fileState.entries.length, 1, "deleted artifacts should be removed from files state");
        assertEqual(fileState.entries[0].filename, "beta.txt", "the remaining artifact should stay visible");
        assertEqual(fileState.selectedFilename, "beta.txt", "selection should advance to the next remaining artifact");
        assertEqual(store.getState().ui.statusText, "Deleted alpha.txt", "the controller should surface a clear delete status");
    });

    it("keeps artifact metadata in state and skips downloading binary previews", async () => {
        let downloadCalls = 0;
        const sessionId = "session-binary-ui";
        const { controller, store } = createController({
            listArtifacts: async () => [{
                filename: "tiny.png",
                sizeBytes: 68,
                contentType: "image/png",
                isBinary: true,
                uploadedAt: "2026-04-21T00:00:00.000Z",
                source: "agent",
            }],
            downloadArtifact: async () => {
                downloadCalls += 1;
                return "should not be fetched for binary previews";
            },
        });
        seedSession(store, sessionId);

        await controller.ensureFilesForSession(sessionId);

        const fileState = store.getState().files.bySessionId[sessionId];
        const items = selectFileBrowserItems(store.getState());

        assertEqual(downloadCalls, 0, "binary previews should not call the text download path when metadata already marks the file binary");
        assertEqual(fileState.selectedFilename, "tiny.png", "the binary artifact should still become the selected file");
        assertEqual(fileState.entries[0].filename, "tiny.png", "files state should store metadata records");
        assertEqual(fileState.entries[0].isBinary, true, "files state should preserve binary metadata");
        assertEqual(fileState.previews["tiny.png"].renderMode, "note", "binary artifacts should render through the note preview path");
        assertIncludes(fileState.previews["tiny.png"].content, "Type: image/png", "binary preview notes should include the artifact content type");
        assertIncludes(fileState.previews["tiny.png"].content, "Size: 68 B", "binary preview notes should include the artifact size");
        assertEqual(items[0].entry.contentType, "image/png", "file browser items should carry the stored artifact metadata");
    });

    it("preserves the selected filename across metadata-based refreshes", async () => {
        const sessionId = "session-refresh-ui";
        let artifactEntries = [
            {
                filename: "note.md",
                sizeBytes: 16,
                contentType: "text/markdown",
                isBinary: false,
                uploadedAt: "2026-04-21T00:00:00.000Z",
                source: "agent",
            },
            {
                filename: "tiny.png",
                sizeBytes: 68,
                contentType: "image/png",
                isBinary: true,
                uploadedAt: "2026-04-21T00:00:01.000Z",
                source: "agent",
            },
        ];
        const { controller, store } = createController({
            listArtifacts: async () => artifactEntries,
            downloadArtifact: async (_sessionId, filename) => `# ${filename}\n`,
        });
        seedSession(store, sessionId);

        await controller.ensureFilesForSession(sessionId);
        store.dispatch({ type: "files/select", sessionId, filename: "note.md" });

        artifactEntries = [artifactEntries[1], artifactEntries[0]];
        await controller.ensureFilesForSession(sessionId, { force: true });

        const fileState = store.getState().files.bySessionId[sessionId];
        assertEqual(fileState.selectedFilename, "note.md", "metadata refreshes should preserve the existing filename selection when the file still exists");
        assertEqual(fileState.previews["note.md"].renderMode, "markdown", "text artifacts should remain previewable after a metadata refresh");
    });
});