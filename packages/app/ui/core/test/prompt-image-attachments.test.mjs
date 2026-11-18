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
    createInitialState,
    createStore,
} from "../src/index.js";
import { partitionPromptFiles } from "../../react/src/image-transfer.js";

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
    const svg = fakeFile("diagram.svg", "image/svg+xml", 100);
    const archive = fakeFile("logs.tar.gz", "", 100);
    const { images, artifacts } = partitionPromptFiles(
        [png, svg, archive],
        new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    );

    assert.deepEqual(images, [png]);
    assert.deepEqual(artifacts, [svg, archive]);
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

test("generic upload fails closed when the active session changes before finalization", async () => {
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
    ]);
    await uploadStarted;
    store.dispatch({
        type: "sessions/merged",
        session: { sessionId: "s2", title: "Other session", status: "idle" },
    });
    store.dispatch({ type: "sessions/active", sessionId: "s2" });
    releaseUpload();
    await upload;

    assert.equal(controller.getPromptAttachments().length, 0);
    assert.equal(store.getState().sessions.activeSessionId, "s2");
    assert.match(store.getState().ui.statusText || "", /active session changed/);
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
