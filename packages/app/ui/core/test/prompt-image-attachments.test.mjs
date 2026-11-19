// Image prompt attachments in the shared composer controller
// (docs/proposals/image-attachments-in-chat.md, Phase 2).
//
// Covers the send path both UIs share: staging validation (type/size/count),
// upload-before-send with deterministic filenames, attachment refs on the
// outbox item and the transport.sendMessage options, and the fail-closed
// behavior when an upload dies (prompt + chips survive; nothing is sent).
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    artifactUri,
    classifyPromptImageContentType,
    createInitialState,
    createStore,
    selectPromptUploadInFlight,
} from "../src/index.js";
import { clipboardImageFiles, handleComposerFileDrop, partitionPromptFiles } from "../../react/src/image-transfer.js";

function fakeFile(name, type, size) {
    return { name, type, size };
}

const fakeImageFile = fakeFile;

function makeController(overrides = {}) {
    const sessions = [{ sessionId: "s1", title: "Session", status: "idle" }];
    const calls = { uploads: [], sendMessage: [] };
    const transport = {
        listSessions: async () => sessions,
        getSession: async (sessionId) => sessions.find((s) => s.sessionId === sessionId) || null,
        subscribeSession: () => () => {},
        listSessionEvents: async () => [],
        listArtifacts: async () => [],
        supportsPromptImageAttachments: () => true,
        uploadArtifactFromFile: async (sessionId, file, filename) => {
            calls.uploads.push({ sessionId, name: file.name, filename });
            return { sessionId, filename: filename || file.name, sizeBytes: file.size, contentType: file.type };
        },
        sendMessage: async (sessionId, prompt, options) => {
            calls.sendMessage.push({ sessionId, prompt, options });
        },
        ...overrides,
    };
    if (typeof transport.uploadPromptArtifactFromFile !== "function") {
        transport.uploadPromptArtifactFromFile = (...args) => transport.uploadArtifactFromFile(...args);
    }
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions });
    store.dispatch({ type: "sessions/active", sessionId: "s1" });
    return { controller, calls, store };
}

test("staging validates type, size, and count", () => {
    const { controller } = makeController();

    const result = controller.addPendingImageFiles([
        fakeImageFile("ok.png", "image/png", 1024),
        fakeImageFile("vector.svg", "image/svg+xml", 512),
        fakeImageFile("huge.jpg", "image/jpeg", 5 * 1024 * 1024),
    ]);

    assert.equal(result.accepted, 1);
    assert.equal(result.rejected.length, 2);
    assert.deepEqual(result.rejected.map((r) => r.reason), ["unsupported type", "over 4 MB"]);

    // Count cap: stage 4 total, the 5th is rejected.
    controller.addPendingImageFiles([
        fakeImageFile("b.png", "image/png", 10),
        fakeImageFile("c.png", "image/png", 10),
        fakeImageFile("d.png", "image/png", 10),
        fakeImageFile("e.png", "image/png", 10),
    ]);
    const staged = controller.getPromptAttachments().filter((a) => a.kind === "image");
    assert.equal(staged.length, 4);
});

test("send uploads staged images then references them on the message", async () => {
    const { controller, calls } = makeController();

    controller.addPendingImageFiles([fakeImageFile("shot.png", "image/png", 2048)]);
    controller.setPrompt("what is this error?", 0);
    await controller.sendPrompt();

    assert.equal(calls.uploads.length, 1);
    assert.equal(calls.uploads[0].sessionId, "s1");
    assert.match(calls.uploads[0].filename, /^attach-[a-zA-Z0-9_-]+-1\.png$/);

    assert.equal(calls.sendMessage.length, 1);
    const sent = calls.sendMessage[0];
    assert.equal(sent.prompt, "what is this error?");
    assert.deepEqual(sent.options.attachments, [{ filename: calls.uploads[0].filename }]);

    // Chips are cleared after a successful send.
    assert.equal(controller.getPromptAttachments().length, 0);
});

test("images alone are sendable — a default caption fills the empty prompt", async () => {
    const { controller, calls } = makeController();

    controller.addPendingImageFiles([fakeImageFile("shot.png", "image/png", 2048)]);
    controller.setPrompt("", 0);
    await controller.sendPrompt();

    assert.equal(calls.sendMessage.length, 1);
    assert.equal(calls.sendMessage[0].prompt, "See the attached image(s).");
    assert.equal(calls.sendMessage[0].options.attachments.length, 1);
});

test("a failed upload keeps the prompt and chips and sends nothing", async () => {
    const { controller, calls, store } = makeController({
        uploadArtifactFromFile: async () => { throw new Error("blob store down"); },
    });

    controller.addPendingImageFiles([fakeImageFile("shot.png", "image/png", 2048)]);
    controller.setPrompt("please look", 0);
    await controller.sendPrompt();

    assert.equal(calls.sendMessage.length, 0);
    assert.equal(store.getState().ui.prompt, "please look");
    assert.equal(controller.getPromptAttachments().filter((a) => a.kind === "image").length, 1);
    assert.match(store.getState().ui.statusText || "", /Image upload failed/);
});

test("image upload notices stay with their source session across a switch", async () => {
    let releaseUpload, markUploadStarted;
    const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
    const uploadStarted = new Promise((resolve) => { markUploadStarted = resolve; });
    const { controller, calls, store } = makeController({
        uploadArtifactFromFile: async () => {
            markUploadStarted();
            await uploadGate;
            throw new Error("image store down");
        },
    });
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "s2", title: "Other session", status: "idle" },
    });
    controller.addPendingImageFiles([fakeImageFile("shot.png", "image/png", 2048)]);
    controller.setPrompt("please look", 0);
    const send = controller.sendPrompt();
    await uploadStarted;
    assert.match(store.getState().ui.promptStatusBySession.s1, /Uploading 1 image/);

    store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    assert.equal(store.getState().ui.statusText, "");
    releaseUpload();
    await send;

    assert.equal(calls.sendMessage.length, 0);
    assert.equal(store.getState().sessions.activeSessionId, "s2");
    assert.equal(store.getState().ui.statusText, "");
    assert.match(store.getState().ui.promptStatusBySession.s1, /Image upload failed: image store down/);
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    assert.match(store.getState().ui.statusText, /Image upload failed: image store down/);
});

test("plain text sends carry no attachments key (byte-shape regression)", async () => {
    const { controller, calls } = makeController();

    controller.setPrompt("hello", 0);
    await controller.sendPrompt();

    assert.equal(calls.sendMessage.length, 1);
    assert.equal(
        Object.prototype.hasOwnProperty.call(calls.sendMessage[0].options, "attachments"),
        false,
    );
});

test("generic tar.gz uploads become artifact prompt refs, not model image attachments", async () => {
    const { controller, calls } = makeController();

    await controller.uploadPromptAttachmentFiles([
        fakeFile("diagnostics.tar.gz", "", 4096),
    ]);
    controller.setPrompt(`${controller.getState().ui.prompt} inspect this`, controller.getState().ui.prompt.length + 13);
    await controller.sendPrompt();

    assert.equal(calls.uploads.length, 1);
    assert.equal(calls.uploads[0].name, "diagnostics.tar.gz");
    assert.equal(calls.sendMessage.length, 1);
    assert.match(calls.sendMessage[0].prompt, /artifact:\/\/s1\/diagnostics\.tar\.gz/);
    assert.match(calls.sendMessage[0].prompt, /inspect this/);
    assert.equal(
        Object.prototype.hasOwnProperty.call(calls.sendMessage[0].options, "attachments"),
        false,
        "generic artifacts must not enter the model image attachment array",
    );
});

test("composer file partition keeps only supported raster MIME types on the image path", () => {
    const png = fakeFile("shot.png", "image/png", 100);
    const emptyMimeJpeg = fakeFile("camera.JPEG", "", 100);
    const svg = fakeFile("diagram.svg", "image/svg+xml", 100);
    const archive = fakeFile("logs.tar.gz", "", 100);
    const { images, artifacts } = partitionPromptFiles(
        [png, emptyMimeJpeg, svg, archive],
        classifyPromptImageContentType,
    );

    assert.deepEqual(images, [png, emptyMimeJpeg]);
    assert.deepEqual(artifacts, [svg, archive]);
    const { controller } = makeController();
    assert.equal(controller.addPendingImageFiles([emptyMimeJpeg]).accepted, 1);
    assert.equal(controller.getPromptAttachments()[0].contentType, "image/jpeg");
    const clipboard = {
        items: [{ kind: "file", type: "", getAsFile: () => emptyMimeJpeg }],
    };
    assert.deepEqual(clipboardImageFiles(clipboard, classifyPromptImageContentType), [emptyMimeJpeg]);
});

test("mixed image and generic files keep their separate send routes", async () => {
    const { controller, calls } = makeController();
    const image = fakeImageFile("shot.png", "image/png", 2048);
    const archive = fakeFile("logs.tar.gz", "application/x-gzip", 4096);

    controller.addPendingImageFiles([image]);
    await controller.uploadPromptAttachmentFiles([archive]);
    controller.setPrompt(`${controller.getState().ui.prompt} compare these`, controller.getState().ui.prompt.length + 14);
    await controller.sendPrompt();

    assert.equal(calls.uploads.length, 2);
    assert.deepEqual(calls.uploads.map((upload) => upload.name), ["logs.tar.gz", "shot.png"]);
    assert.match(calls.sendMessage[0].prompt, /artifact:\/\/s1\/logs\.tar\.gz/);
    assert.deepEqual(calls.sendMessage[0].options.attachments, [{ filename: calls.uploads[1].filename }]);
});

test("generic upload finalization failure never claims or sends the attachment", async () => {
    const { controller, calls, store } = makeController();
    controller.applyUploadedPromptAttachment = async () => {
        throw new Error("prompt finalization failed");
    };

    await controller.uploadPromptAttachmentFiles([
        fakeFile("diagnostics.tar.gz", "", 4096),
    ]);

    assert.equal(calls.uploads.length, 1);
    assert.equal(controller.getPromptAttachments().length, 0);
    assert.equal(store.getState().ui.prompt, "");
    assert.match(store.getState().ui.statusText || "", /Attachment upload failed.*prompt finalization failed/);
    assert.doesNotMatch(store.getState().ui.statusText || "", /^Attached /);
});

test("generic selection is clearly refused while a queued message is selected", async () => {
    const { controller, calls, store } = makeController();
    const queued = controller.buildOutboxItem("queued words", "queued");
    controller.setSessionOutboxItems("s1", [queued]);
    assert.equal(controller.enterPendingPromptEdit("s1", queued.id), true);

    await controller.uploadPromptAttachmentFiles([fakeFile("notes.log", "", 10)]);

    assert.equal(calls.uploads.length, 0);
    assert.match(store.getState().ui.statusText, /Finish editing.*before attaching/i);
    assert.equal(store.getState().ui.prompt, "queued words");
});

test("generic upload completion attaches to the source draft and stops the remaining batch after a session change", async () => {
    let releaseUpload;
    let markUploadStarted;
    const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
    const uploadStarted = new Promise((resolve) => { markUploadStarted = resolve; });
    const { controller, calls, store } = makeController({
        uploadArtifactFromFile: async (sessionId, file) => {
            calls.uploads.push({ sessionId, name: file.name });
            markUploadStarted();
            await uploadGate;
            return { sessionId, filename: file.name, sizeBytes: file.size, contentType: file.type };
        },
    });
    const upload = controller.uploadPromptAttachmentFiles([
        fakeFile("diagnostics.tar.gz", "", 4096),
        fakeFile("must-not-upload.log", "", 20),
    ]);
    await uploadStarted;
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "s2", title: "Other session", status: "idle" },
    });
    store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    releaseUpload();
    await upload;

    assert.equal(controller.getPromptAttachments().length, 0);
    assert.equal(store.getState().sessions.activeSessionId, "s2");
    assert.deepEqual(calls.uploads.map((entry) => entry.name), ["diagnostics.tar.gz"]);
    assert.match(store.getState().ui.promptDraftBySession.s1.prompt, /diagnostics\.tar\.gz/);
    assert.equal(store.getState().ui.promptDraftBySession.s1.attachments.length, 1);
    assert.match(store.getState().ui.promptStatusBySession.s1, /Attached 1\/2.*must-not-upload\.log/);
    assert.equal(store.getState().ui.statusText, "", "source-session status must not leak into the active session");
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    assert.match(store.getState().ui.prompt, /diagnostics\.tar\.gz/);
    assert.match(store.getState().ui.statusText, /Attached 1\/2/);
});

test("switching away and back preserves the source cursor and still stops the remaining batch", async () => {
    let releaseUpload, markUploadStarted;
    const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
    const uploadStarted = new Promise((resolve) => { markUploadStarted = resolve; });
    const { controller, calls, store } = makeController({
        uploadArtifactFromFile: async (sessionId, file, filename) => {
            calls.uploads.push({ sessionId, name: file.name, filename });
            markUploadStarted();
            await uploadGate;
            return { sessionId, filename: filename || file.name, sizeBytes: file.size, contentType: file.type };
        },
    });
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "s2", title: "Other session", status: "idle" },
    });
    controller.setPrompt("before after", 6);
    const upload = controller.uploadPromptAttachmentFiles([
        fakeFile("cursor.log", "", 10),
        fakeFile("skipped.log", "", 10),
    ]);
    await uploadStarted;
    store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    releaseUpload();
    await upload;

    assert.deepEqual(calls.uploads.map((entry) => entry.name), ["cursor.log"]);
    assert.match(store.getState().ui.prompt, /^before📎 "cursor\.log"  after$/);
    assert.match(store.getState().ui.statusText, /Attached 1\/2.*skipped\.log/);
});

test("upload generations in different sessions cannot clear or unblock each other", async () => {
    const gates = new Map();
    const started = new Map();
    for (const sessionId of ["s1", "s2"]) {
        let release, markStarted;
        gates.set(sessionId, {
            wait: new Promise((resolve) => { release = resolve; }),
            release: () => release(),
        });
        started.set(sessionId, new Promise((resolve) => { markStarted = resolve; }));
        gates.get(sessionId).markStarted = markStarted;
    }
    const { controller, store } = makeController({
        uploadArtifactFromFile: async (sessionId, file, filename) => {
            gates.get(sessionId).markStarted();
            await gates.get(sessionId).wait;
            return { sessionId, filename: filename || file.name, sizeBytes: file.size, contentType: file.type };
        },
    });
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "s2", title: "Other session", status: "idle" },
    });

    const first = controller.uploadPromptAttachmentFiles([fakeFile("one.log", "", 10)]);
    await started.get("s1");
    store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    const second = controller.uploadPromptAttachmentFiles([fakeFile("two.log", "", 10)]);
    await started.get("s2");
    assert.equal(store.getState().ui.promptUploads.s1.count, 1);
    assert.equal(store.getState().ui.promptUploads.s2.count, 1);

    gates.get("s1").release();
    await first;
    assert.equal(store.getState().ui.promptUploads.s1, undefined);
    assert.equal(store.getState().ui.promptUploads.s2.count, 1);
    assert.equal(controller.isPromptUploadInFlight("s2"), true);

    gates.get("s2").release();
    await second;
    assert.deepEqual(store.getState().ui.promptUploads, {});
});

test("a second selection in the same session joins the upload state instead of being dropped", async () => {
    const releases = [];
    const starts = [];
    const { controller, calls, store } = makeController({
        uploadArtifactFromFile: async (sessionId, file, filename) => {
            calls.uploads.push({ sessionId, name: file.name, filename });
            let release, started;
            const wait = new Promise((resolve) => { release = resolve; });
            starts.push(new Promise((resolve) => { started = resolve; }));
            releases.push(release);
            started();
            await wait;
            return { sessionId, filename: filename || file.name, sizeBytes: file.size, contentType: file.type };
        },
    });

    const first = controller.uploadPromptAttachmentFiles([fakeFile("one.log", "", 10)]);
    while (starts.length < 1) await Promise.resolve();
    await starts[0];
    const second = controller.uploadPromptAttachmentFiles([fakeFile("two.log", "", 10)]);
    while (starts.length < 2) await Promise.resolve();
    await starts[1];

    assert.equal(store.getState().ui.promptUploads.s1.count, 2);
    assert.equal(Object.keys(store.getState().ui.promptUploads.s1.generations).length, 2);
    releases.forEach((release) => release());
    await Promise.all([first, second]);
    assert.deepEqual(calls.uploads.map((entry) => entry.name).sort(), ["one.log", "two.log"]);
    assert.equal(controller.getPromptAttachments().filter((entry) => entry.kind !== "image").length, 2);
    assert.deepEqual(store.getState().ui.promptUploads, {});
});

test("creating the first session preserves typed text and staged images before adding a generic file", async () => {
    const { controller, store } = makeController({
        createSession: async () => ({ sessionId: "new-session", title: "New", status: "idle" }),
    });
    store.dispatch({ type: "sessions/selected", sessionId: null });
    controller.setPrompt("keep these words", 5);
    controller.addPendingImageFiles([fakeImageFile("shot.png", "image/png", 100)]);

    await controller.uploadPromptAttachmentFiles([fakeFile("notes.log", "", 10)]);

    assert.equal(store.getState().sessions.activeSessionId, "new-session");
    assert.match(store.getState().ui.prompt, /^keep .*these words$/);
    assert.match(store.getState().ui.prompt, /notes\.log/);
    assert.equal(controller.getPromptAttachments().filter((entry) => entry.kind === "image").length, 1);
    assert.equal(controller.getPromptAttachments().filter((entry) => entry.kind !== "image").length, 1);
});

test("concurrent first-session selections share creation and preserve edits made while it resolves", async () => {
    let releaseCreate;
    const createGate = new Promise((resolve) => { releaseCreate = resolve; });
    let createCalls = 0;
    const { controller, store } = makeController({
        createSession: async () => {
            createCalls += 1;
            await createGate;
            return { sessionId: "new-session", title: "New", status: "idle" };
        },
    });
    store.dispatch({ type: "sessions/selected", sessionId: null });
    controller.setPrompt("initial", 7);
    controller.addPendingImageFiles([fakeImageFile("shot.png", "image/png", 100)]);

    const first = controller.uploadPromptAttachmentFiles([fakeFile("one.log", "", 10)]);
    const second = controller.uploadPromptAttachmentFiles([fakeFile("two.log", "", 10)]);
    controller.setPrompt("latest words", 6);
    releaseCreate();
    await Promise.all([first, second]);

    assert.equal(createCalls, 1);
    assert.equal(store.getState().sessions.activeSessionId, "new-session");
    assert.match(store.getState().ui.prompt, /^latest.* words$/);
    assert.equal(controller.getPromptAttachments().filter((entry) => entry.kind === "image").length, 1);
    assert.equal(controller.getPromptAttachments().filter((entry) => entry.kind !== "image").length, 2);
});

test("duplicate basenames and existing artifacts receive collision-safe filenames", async () => {
    const { controller, calls } = makeController({
        listArtifacts: async () => [{ filename: "report.csv" }],
    });

    await controller.uploadPromptAttachmentFiles([
        fakeFile("report.csv", "text/csv", 10),
        fakeFile("report.csv", "text/csv", 20),
    ]);

    assert.deepEqual(calls.uploads.map((entry) => entry.filename), [
        "report (2).csv",
        "report (3).csv",
    ]);
});

test("artifact refs encode delimiters and token stripping does not collapse filename prefixes", async () => {
    const { controller, calls } = makeController();
    await controller.uploadPromptAttachmentFiles([
        fakeFile("a [draft].txt", "text/plain", 10),
        fakeFile("a [draft].txtx", "text/plain", 10),
    ]);
    await controller.sendPrompt();

    const sent = calls.sendMessage[0].prompt;
    assert.match(sent, /artifact:\/\/s1\/a%20%5Bdraft%5D\.txt/);
    assert.match(sent, /artifact:\/\/s1\/a%20%5Bdraft%5D\.txtx/);
    assert.doesNotMatch(sent, /📎/);
});

test("TUI attach-by-path: upload modal stages the image; send refs it without re-upload", async () => {
    const { controller, calls } = makeController({
        uploadArtifactFromPath: async (sessionId, filePath) => ({ sessionId, filename: "shot.png", filePath }),
        getArtifactMetadata: async () => null,
        statArtifact: async () => null,
        finalize: null,
    });
    // finalizeArtifactUpload consults the artifact list; stub the minimum.
    controller.finalizeArtifactUpload = async (upload, { sessionId }) => ({
        sessionId,
        filename: upload.filename,
        contentType: "image/png",
        sizeBytes: 2048,
    });

    controller.dispatch({
        type: "ui/modal",
        modal: { type: "artifactUpload", sessionId: "s1", value: "/tmp/shot.png", cursorIndex: 0 },
    });
    await controller.confirmArtifactUploadModal();

    const staged = controller.getPromptAttachments().filter((a) => a.kind === "image");
    assert.equal(staged.length, 1);
    assert.equal(staged[0].uploaded, true);
    assert.equal(staged[0].filename, "shot.png");

    controller.setPrompt("what does this show?", 0);
    await controller.sendPrompt();

    assert.equal(calls.uploads.length, 0, "pre-uploaded attachments must not re-upload");
    assert.equal(calls.sendMessage.length, 1);
    assert.deepEqual(calls.sendMessage[0].options.attachments, [{ filename: "shot.png" }]);
});

// Regression repro (2026-07-21 local portal): with a send already in flight
// (busy session — "queue it behind the pending batch"), an image message's
// uploads landed on disk but the durable user.message carried no refs.
test("attachments survive a deferred dispatch behind an in-flight send", async () => {
    let releaseFirstSend;
    const firstSendGate = new Promise((resolve) => { releaseFirstSend = resolve; });
    let sendCount = 0;
    const { controller, calls } = makeController({
        sendMessage: async function slowSend(sessionId, prompt, options) {
            sendCount += 1;
            calls.sendMessage.push({ sessionId, prompt, options });
            if (sendCount === 1) await firstSendGate;
        },
    });

    // First: a plain text send whose transport call hangs (turn running).
    controller.setPrompt("first message", 0);
    const firstSend = controller.sendPrompt();
    await Promise.resolve();

    // Second: an image message while the first enqueue is still in flight.
    controller.addPendingImageFiles([fakeImageFile("shot.png", "image/png", 2048)]);
    controller.setPrompt("and here?", 0);
    const secondSend = controller.sendPrompt();
    await Promise.resolve();

    // Release the first enqueue; let the deferred dispatch drain.
    releaseFirstSend();
    await firstSend;
    await secondSend;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const imageSend = calls.sendMessage.find((c) => c.prompt.includes("and here?"));
    assert.ok(imageSend, "the image message must eventually dispatch");
    assert.ok(
        Array.isArray(imageSend.options.attachments) && imageSend.options.attachments.length === 1,
        `image message lost its attachments: ${JSON.stringify(imageSend.options)}`,
    );
});


test("create-only attachment upload retries only explicit conflicts and preserves compound suffixes", async () => {
    const attempted = [];
    const { controller } = makeController({
        listArtifacts: async () => { throw new Error("listing unavailable"); },
        uploadPromptArtifactFromFile: async (sessionId, file, filename) => {
            attempted.push(filename);
            if (attempted.length <= 2) {
                const error = new Error("already exists");
                if (attempted.length === 1) error.code = "ARTIFACT_ALREADY_EXISTS";
                else error.status = 409;
                throw error;
            }
            return { sessionId, filename, sizeBytes: file.size, contentType: file.type };
        },
    });

    await controller.uploadPromptAttachmentFiles([fakeFile("bundle.tar.xz", "", 10)]);
    assert.deepEqual(attempted, ["bundle.tar.xz", "bundle (2).tar.xz", "bundle (3).tar.xz"]);
    assert.equal(controller.getPromptAttachments()[0].filename, "bundle (3).tar.xz");
});

test("composer generic uploads refuse transports without atomic create-only support", async () => {
    const { controller, calls, store } = makeController();
    delete controller.transport.uploadPromptArtifactFromFile;

    await controller.uploadPromptAttachmentFiles([fakeFile("must-not-overwrite.log", "", 10)]);

    assert.equal(calls.uploads.length, 0);
    assert.match(store.getState().ui.statusText, /collision-safe composer file uploads are not supported/i);
});

test("collision retry is bounded at ten attempts and arbitrary failures are never retried", async () => {
    const conflicts = [];
    const conflict = makeController({
        uploadPromptArtifactFromFile: async (_sessionId, _file, filename) => {
            conflicts.push(filename);
            throw Object.assign(new Error("occupied"), { code: "ARTIFACT_ALREADY_EXISTS", status: 409 });
        },
    });
    await conflict.controller.uploadPromptAttachmentFiles([fakeFile("bundle.tar.zst", "", 10)]);
    assert.equal(conflicts.length, 10);
    assert.equal(conflicts.at(-1), "bundle (10).tar.zst");

    let failures = 0;
    const ordinary = makeController({
        uploadPromptArtifactFromFile: async () => {
            failures += 1;
            throw Object.assign(new Error("different conflict"), {
                code: "SESSION_BUSY",
                status: 409,
            });
        },
    });
    await ordinary.controller.uploadPromptAttachmentFiles([fakeFile("notes.txt", "", 10)]);
    assert.equal(failures, 1);
});

test("queued edit refuses an upload intent before filename listing resolves", async () => {
    let releaseList, markListed;
    const listGate = new Promise((resolve) => { releaseList = resolve; });
    const listed = new Promise((resolve) => { markListed = resolve; });
    const { controller, store } = makeController({
        listArtifacts: async () => {
            markListed();
            await listGate;
            return [];
        },
    });
    const queued = controller.buildOutboxItem("queued", "queued");
    controller.setSessionOutboxItems("s1", [queued]);

    const upload = controller.uploadPromptAttachmentFiles([fakeFile("slow.log", "", 10)]);
    assert.equal(controller.selectPreviousPendingPrompt("s1"), false);
    assert.equal(controller.enterPendingPromptEdit("s1", queued.id), false);
    assert.match(store.getState().ui.statusText, /attachment upload.*editing queued/i);
    await listed;
    releaseList();
    await upload;
});

test("queued edit snapshots attachments and Esc restores text, cursor, and chips together", () => {
    const { controller, store } = makeController();
    controller.setPrompt("draft words", 5);
    controller.addPendingImageFiles([fakeImageFile("draft.png", "image/png", 10)]);
    const queued = controller.buildOutboxItem("queued words", "queued");
    controller.setSessionOutboxItems("s1", [queued]);

    assert.equal(controller.enterPendingPromptEdit("s1", queued.id), true);
    assert.equal(controller.getPromptAttachments().length, 0);
    assert.equal(controller.exitPendingPromptEdit({ restoreDraft: true }), true);
    assert.equal(store.getState().ui.prompt, "draft words");
    assert.equal(store.getState().ui.promptCursor, 5);
    assert.equal(controller.getPromptAttachments()[0].filename, "draft.png");
    assert.equal(store.getState().ui.promptEdit, null);
});

test("an upload finalized during queued edit updates only the saved draft", async () => {
    const { controller, store } = makeController();
    controller.setPrompt("normal draft", 6);
    controller.addPendingImageFiles([fakeImageFile("draft.png", "image/png", 10)]);
    const queued = controller.buildOutboxItem("selected message", "queued");
    controller.setSessionOutboxItems("s1", [queued]);
    assert.equal(controller.enterPendingPromptEdit("s1", queued.id), true);

    await controller.applyUploadedPromptAttachment({ sessionId: "s1", filename: "race.log" }, {
        sessionId: "s1",
        suppressStatus: true,
        activateSession: false,
    });
    assert.equal(store.getState().ui.prompt, "selected message");
    assert.doesNotMatch(store.getState().ui.prompt, /race\.log/);
    controller.exitPendingPromptEdit({ restoreDraft: true });
    assert.match(store.getState().ui.prompt, /race\.log/);
    assert.deepEqual(controller.getPromptAttachments().map((item) => item.filename), ["draft.png", "race.log"]);
});

test("send-first and attachment-first share one default session and send waits for finalization", async () => {
    let releaseCreate, markCreate;
    const createGate = new Promise((resolve) => { releaseCreate = resolve; });
    const createStarted = new Promise((resolve) => { markCreate = resolve; });
    let releaseUpload, markUpload;
    const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
    const uploadStarted = new Promise((resolve) => { markUpload = resolve; });
    let creates = 0;
    const { controller, calls, store } = makeController({
        createSession: async () => {
            creates += 1;
            markCreate();
            await createGate;
            return { sessionId: "only-session", title: "Only", status: "idle" };
        },
        uploadPromptArtifactFromFile: async (sessionId, file, filename) => {
            markUpload();
            await uploadGate;
            return { sessionId, filename, sizeBytes: file.size, contentType: file.type };
        },
    });
    store.dispatch({ type: "sessions/selected", sessionId: null });
    controller.setPrompt("do not lose me", 4);

    const send = controller.sendPrompt();
    await createStarted;
    const upload = controller.uploadPromptAttachmentFiles([fakeFile("joined.log", "", 10)]);
    releaseCreate();
    await uploadStarted;
    await send;

    assert.equal(creates, 1);
    assert.equal(calls.sendMessage.length, 0);
    assert.equal(store.getState().sessions.activeSessionId, "only-session");
    assert.equal(store.getState().ui.prompt, "do not lose me");
    assert.equal(controller.isPromptUploadInFlight("only-session"), true);
    releaseUpload();
    await upload;
});

test("first-session creation never adopts a different session's live draft", async () => {
    let releaseCreate, markCreate;
    const createGate = new Promise((resolve) => { releaseCreate = resolve; });
    const createStarted = new Promise((resolve) => { markCreate = resolve; });
    const { controller, store } = makeController({
        createSession: async () => {
            markCreate();
            await createGate;
            return { sessionId: "created", title: "Created", status: "idle" };
        },
    });
    store.dispatch({ type: "sessions/selected", sessionId: null });
    controller.setPrompt("orphan draft", 6);
    controller.addPendingImageFiles([fakeImageFile("orphan.png", "image/png", 10)]);
    const upload = controller.uploadPromptAttachmentFiles([fakeFile("owned.log", "", 10)]);
    await createStarted;

    store.dispatch({ type: "sessions/merged", session: { sessionId: "s2", title: "Other", status: "idle" } });
    store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    controller.setPrompt("other session draft", 3);
    releaseCreate();
    await upload;

    assert.equal(store.getState().sessions.activeSessionId, "created");
    assert.match(store.getState().ui.prompt, /^orphan.*draft$/s);
    assert.match(store.getState().ui.prompt, /owned\.log/);
    assert.doesNotMatch(store.getState().ui.prompt, /other session draft/);
    assert.equal(controller.getPromptAttachments().some((item) => item.filename === "orphan.png"), true);
    assert.equal(store.getState().ui.promptDraftBySession.s2.prompt, "other session draft");
});

test("no-session upload intent gates only its initiating composer, not session B", async () => {
    let releaseCreate, markCreate;
    const createGate = new Promise((resolve) => { releaseCreate = resolve; });
    const createStarted = new Promise((resolve) => { markCreate = resolve; });
    const { controller, calls, store } = makeController({
        createSession: async () => {
            markCreate();
            await createGate;
            return { sessionId: "created", title: "Created", status: "idle" };
        },
    });
    store.dispatch({ type: "sessions/selected", sessionId: null });
    controller.setPrompt("orphan draft", 6);
    const upload = controller.uploadPromptAttachmentFiles([fakeFile("owned.log", "", 10)]);
    await createStarted;

    assert.equal(selectPromptUploadInFlight(store.getState(), null), true);
    store.dispatch({ type: "sessions/merged", session: { sessionId: "s2", title: "Other", status: "idle" } });
    store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    controller.setPrompt("send from B", 11);
    assert.equal(selectPromptUploadInFlight(store.getState(), "s2"), false);
    await controller.sendPrompt();
    assert.equal(calls.sendMessage.at(-1)?.sessionId, "s2");
    assert.equal(calls.sendMessage.at(-1)?.prompt, "send from B");

    releaseCreate();
    await upload;
    assert.equal(store.getState().sessions.activeSessionId, "created");
});

test("Send keeps its created-session draft across hydration navigation and never clears session B", async () => {
    let releaseHydration, markHydration;
    const hydrationGate = new Promise((resolve) => { releaseHydration = resolve; });
    const hydrationStarted = new Promise((resolve) => { markHydration = resolve; });
    const created = { sessionId: "created", title: "Created", status: "idle" };
    const { controller, calls, store } = makeController({
        createSession: async () => created,
        getSession: async (sessionId) => {
            if (sessionId === "created") {
                markHydration();
                await hydrationGate;
                return created;
            }
            return { sessionId, title: sessionId, status: "idle" };
        },
    });
    store.dispatch({ type: "sessions/selected", sessionId: null });
    controller.setPrompt("draft A", 7);

    const send = controller.sendPrompt();
    await hydrationStarted;
    store.dispatch({ type: "sessions/merged", session: { sessionId: "s2", title: "Session B", status: "idle" } });
    store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    controller.setPrompt("private draft B", 15);
    releaseHydration();
    await send;

    assert.equal(calls.sendMessage.length, 1);
    assert.equal(calls.sendMessage[0].sessionId, "created");
    assert.equal(calls.sendMessage[0].prompt, "draft A");
    assert.equal(store.getState().sessions.activeSessionId, "s2");
    assert.equal(store.getState().ui.prompt, "private draft B");
    assert.equal(store.getState().ui.promptDraftBySession.created, undefined);
});

test("no-session edits during create are captured before departure and never replaced by session B", async () => {
    let releaseCreate, markCreate;
    const createGate = new Promise((resolve) => { releaseCreate = resolve; });
    const createStarted = new Promise((resolve) => { markCreate = resolve; });
    const { controller, store } = makeController({
        createSession: async () => {
            markCreate();
            await createGate;
            return { sessionId: "created", title: "Created", status: "idle" };
        },
    });
    store.dispatch({ type: "sessions/selected", sessionId: null });
    controller.setPrompt("draft A", 7);
    const upload = controller.uploadPromptAttachmentFiles([fakeFile("owned.log", "", 10)]);
    await createStarted;
    controller.setPrompt("draft A plus edits", 12);
    controller.addPendingImageFiles([fakeImageFile("late.png", "image/png", 10)]);

    store.dispatch({ type: "sessions/merged", session: { sessionId: "s2", title: "Session B", status: "idle" } });
    store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    controller.setPrompt("private B", 9);
    releaseCreate();
    await upload;

    assert.equal(store.getState().sessions.activeSessionId, "created");
    assert.match(store.getState().ui.prompt, /draft A plus/);
    assert.match(store.getState().ui.prompt, /edits/);
    assert.match(store.getState().ui.prompt, /owned\.log/);
    assert.equal(controller.getPromptAttachments().some(item => item.filename === "late.png"), true);
    assert.equal(store.getState().ui.promptDraftBySession.s2.prompt, "private B");
});

test("terminal session removal suppresses a late upload callback and prunes filename state", async () => {
    let releaseUpload, markUpload;
    const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
    const uploadStarted = new Promise((resolve) => { markUpload = resolve; });
    const { controller, store } = makeController({
        uploadPromptArtifactFromFile: async (sessionId, file, filename) => {
            markUpload();
            await uploadGate;
            return { sessionId, filename, sizeBytes: file.size, contentType: file.type };
        },
    });
    const upload = controller.uploadPromptAttachmentFiles([fakeFile("late.log", "", 10)]);
    await uploadStarted;
    controller.handleSessionGone("s1");
    releaseUpload();
    await upload;

    assert.equal(store.getState().sessions.goneIds.includes("s1"), true);
    assert.equal(store.getState().ui.promptDraftBySession.s1, undefined);
    assert.equal(store.getState().ui.promptStatusBySession.s1, undefined);
    assert.equal(store.getState().ui.promptUploads.s1, undefined);
    assert.equal(controller.getPromptAttachments().some(item => item.filename === "late.log"), false);
    assert.equal(controller._knownPromptArtifactNames?.has("s1") || false, false);
    assert.equal(controller._reservedPromptArtifactNames?.has("s1") || false, false);
});

test("mixed image rejection and artifact completion produce one source-session status", async () => {
    let releaseUpload, markUpload;
    const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
    const uploadStarted = new Promise((resolve) => { markUpload = resolve; });
    const { controller, store } = makeController({
        uploadPromptArtifactFromFile: async (sessionId, file, filename) => {
            markUpload();
            await uploadGate;
            return { sessionId, filename, sizeBytes: file.size, contentType: file.type };
        },
    });
    store.dispatch({ type: "sessions/merged", session: { sessionId: "s2", title: "Other", status: "idle" } });
    const imageResult = controller.addPendingImageFiles([
        fakeImageFile("huge.png", "image/png", 5 * 1024 * 1024),
    ], { suppressStatus: true, sessionId: "s1" });
    const upload = controller.uploadPromptAttachmentFiles([fakeFile("good.log", "", 10)], {
        rejectedImages: imageResult.rejected,
    });
    await uploadStarted;
    store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    releaseUpload();
    await upload;

    assert.match(store.getState().ui.promptStatusBySession.s1, /Attached good\.log; Skipped huge\.png \(over 4 MB\)/);
    assert.equal(store.getState().ui.statusText, "");
});

test("model-visible attachment labels neutralize line and bidi controls while artifact URI filenames stay exact", async () => {
    const filename = "bad\n\u2028\u202e\u2066name]\\tail.txt";
    const { controller, calls } = makeController({
        uploadPromptArtifactFromFile: async (sessionId, file) => ({
            sessionId,
            filename,
            sizeBytes: file.size,
            contentType: file.type,
        }),
    });
    await controller.uploadPromptAttachmentFiles([fakeFile("source.txt", "text/plain", 10)]);
    await controller.sendPrompt();

    const sent = calls.sendMessage[0].prompt;
    assert.ok(sent.includes(artifactUri("s1", filename)));
    const label = /^\[Attached file: (.*?) — artifact:\/\//u.exec(sent)?.[1];
    assert.ok(label);
    assert.doesNotMatch(label, /[\r\n\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\[\]\\]/u);
    assert.ok(sent.includes("bad%0A%E2%80%A8%E2%80%AE%E2%81%A6name%5D%5Ctail.txt"));
});

test("sending generic attachments consumes their session-owned status", async () => {
    const { controller, store } = makeController();
    await controller.uploadPromptAttachmentFiles([fakeFile("done.log", "", 10)]);
    assert.match(store.getState().ui.promptStatusBySession.s1, /Attached done\.log/);

    await controller.sendPrompt();

    assert.equal(store.getState().ui.promptStatusBySession.s1, undefined);
    assert.equal(store.getState().ui.statusText, "");
});

test("composer file drop always prevents browser navigation and forwards files", () => {
    let prevented = 0;
    let forwarded = null;
    const files = [fakeFile("drop.log", "text/plain", 10)];
    const handled = handleComposerFileDrop({
        dataTransfer: { types: ["Files"], files },
        preventDefault: () => { prevented += 1; },
    }, (nextFiles) => { forwarded = nextFiles; });
    assert.equal(handled, true);
    assert.equal(prevented, 1);
    assert.equal(forwarded, files);
});

test("image paste/staging is refused with source-owned status during queued edit", () => {
    const { controller, store } = makeController();
    const queued = controller.buildOutboxItem("queued", "queued");
    controller.setSessionOutboxItems("s1", [queued]);
    assert.equal(controller.enterPendingPromptEdit("s1", queued.id), true);

    const result = controller.addPendingImageFiles([fakeImageFile("paste.png", "image/png", 10)]);

    assert.equal(result.accepted, 0);
    assert.equal(controller.getPromptAttachments().length, 0);
    assert.match(store.getState().ui.promptStatusBySession.s1, /Finish editing.*before attaching files/);
});

test("TUI clipboard image paste is refused before capture during queued edit", async () => {
    let captures = 0;
    const { controller, store } = makeController({
        captureClipboardImage: async () => {
            captures += 1;
            return { path: "/tmp/never.png" };
        },
        uploadArtifactFromPath: async () => {
            throw new Error("must not upload");
        },
    });
    const queued = controller.buildOutboxItem("queued", "queued");
    controller.setSessionOutboxItems("s1", [queued]);
    assert.equal(controller.enterPendingPromptEdit("s1", queued.id), true);

    assert.equal(await controller.pasteImageFromClipboard(), false);
    assert.equal(captures, 0);
    assert.match(store.getState().ui.promptStatusBySession.s1, /Finish editing.*before attaching files/);
});


test("collision planning stays case-sensitive and places suffixes before common compound extensions", async () => {
    const { controller, calls } = makeController({
        listArtifacts: async () => [
            { filename: "Report.csv" },
            { filename: "archive.tar.bz2" },
            { filename: "trace.tar.xz" },
            { filename: "snapshot.tar.zst" },
        ],
    });
    await controller.uploadPromptAttachmentFiles([
        fakeFile("report.csv", "", 1),
        fakeFile("archive.tar.bz2", "", 1),
        fakeFile("trace.tar.xz", "", 1),
        fakeFile("snapshot.tar.zst", "", 1),
    ]);
    assert.deepEqual(calls.uploads.map((item) => item.filename), [
        "report.csv",
        "archive (2).tar.bz2",
        "trace (2).tar.xz",
        "snapshot (2).tar.zst",
    ]);
});
