import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, createStore, createInitialState, duplicateMotdDraft, motdDraftWindow } from "../src/index.js";
import { imageFiles, clipboardImageFiles, handleImagePaste, handleImageDrop, hasFileDrag } from "../../react/src/image-transfer.js";

const admin = { provider: "test", subject: "admin", isAdmin: true };
const main = { base64: "AAAA", contentType: "image/png", alt: "Main picture" };
const mobile = { base64: "BBBB", contentType: "image/webp", alt: "Mobile picture" };
const source = { motdId: "7", fromAt: "2020-01-01T00:00:00Z", toAt: "2020-01-03T02:30:00Z",
    bodyMd: "Source markdown", mobileBodyMd: "Short mobile body", imagePlacement: "beside",
    hasImage: true, hasMobileImage: true, imageAlt: main.alt, mobileImageAlt: mobile.alt };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}, profile = admin) {
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    store.dispatch({ type: "motd/patch", patch: { portalEnabled: true } });
    store.dispatch({ type: "auth/context", principal: profile, authorization: { role: profile.isAdmin ? "admin" : "user" } });
    store.dispatch({ type: "admin/profile/loaded", profile });
    store.dispatch({ type: "admin/motds", patch: { today: source, history: [source] } });
    const calls = { create: [], remove: [], images: [] };
    const controller = new PilotSwarmUiController({ store, transport: {
        createMotd: async input => { calls.create.push(input); }, deleteMotd: async id => { calls.remove.push(id); },
        listMotds: async () => [source], getMotdImage: async (id, phone) => { calls.images.push([id, phone]); return phone ? mobile : main; },
        ...overrides,
    } });
    return { controller, store, calls, state: () => store.getState().admin.motds };
}
test("duplicate fills an editable draft with both bodies, placement, pictures, alts and fresh dates", async t => {
    const now = Date.parse("2026-11-01T20:10:15.123Z");
    t.mock.timers.enable({ apis: ["Date"], now });
    const { controller, store, calls, state } = fixture();
    store.dispatch({ type: "motd/patch", patch: { images: { "7": { desktop: main, mobile } } } });
    store.dispatch({ type: "admin/motds", patch: { retry: { requestId: "old-retry" } } });
    assert.equal(await controller.duplicateAdminMotd("7"), true);
    assert.equal(state().draft.bodyMd, source.bodyMd);
    assert.equal(state().draft.mobileBodyMd, source.mobileBodyMd);
    assert.equal(state().draft.imagePlacement, "beside");
    assert.deepEqual(state().draft.image, main); assert.deepEqual(state().draft.mobileImage, mobile);
    assert.notEqual(state().draft.image, main); assert.notEqual(state().draft.mobileImage, mobile);
    assert.equal(state().draft.startMode, "now"); assert.equal(state().draft.endMode, "custom");
    const window = motdDraftWindow(state().draft, now);
    assert.equal(window.from, now);
    assert.equal(window.to - now, Date.parse(source.toAt) - Date.parse(source.fromAt));
    assert.equal(state().retry, null); assert.equal(state().draftFocusVersion, 1);
    assert.match(state().copyNotice, /Copied from message 7/);
    assert.deepEqual(calls, { create: [], remove: [], images: [] });
    assert.equal(state().today, source); assert.equal(state().history[0], source);
    controller.setMotdDraft({ bodyMd: "Edited draft" });
    assert.equal(source.bodyMd, "Source markdown");
});
test("Duplicate starts Now and preserves Never or exact duration presets", () => {
    const now = Date.parse("2026-11-01T20:10:00Z");
    const draft = duplicateMotdDraft({ ...source, hasImage: false, hasMobileImage: false, mobileBodyMd: null }, {}, now);
    assert.equal(draft.startMode, "now");
    assert.equal(draft.mobileBodyMd, ""); assert.equal(draft.image, undefined);
    assert.equal(draft.mobileImage, undefined);
    const never = duplicateMotdDraft({ ...source, toAt: null, hasImage: false, hasMobileImage: false }, {}, now);
    assert.equal(never.endMode, "never"); assert.equal(motdDraftWindow(never, now).to, null);
    for (const [mode, duration] of [["hour", 3_600_000], ["day", 86_400_000], ["week", 604_800_000]]) {
        const copied = duplicateMotdDraft({ ...source, hasImage: false, hasMobileImage: false,
            toAt: new Date(Date.parse(source.fromAt) + duration).toISOString() }, {}, now);
        assert.equal(copied.endMode, mode);
        assert.equal(motdDraftWindow(copied, now).to - now, duration);
    }
});
test("duplicate loads only the missing picture and publishes only after an explicit Publish", async () => {
    const { controller, store, calls, state } = fixture();
    store.dispatch({ type: "motd/patch", patch: { images: { "7": { desktop: main } } } });
    await controller.duplicateAdminMotd("7");
    assert.deepEqual(calls.images, [["7", true]]);
    assert.equal(calls.create.length, 0);
    controller.setMotdDraft({ bodyMd: "Edited before publishing" });
    await controller.createAdminMotd();
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].bodyMd, "Edited before publishing");
    assert.deepEqual(calls.create[0].image, main); assert.deepEqual(calls.create[0].mobileImage, mobile);
    assert.equal(calls.remove.length, 0); assert.equal(state().history[0], source);
});
test("duplicate waits for a picture already loading instead of dropping it or fetching twice", async () => {
    let resolve; let reads = 0;
    const { controller, store, state } = fixture({ getMotdImage: async () => { reads++; return new Promise(r => { resolve = r; }); } });
    store.dispatch({ type: "admin/motds", patch: { today: { ...source, hasMobileImage: false }, history: [{ ...source, hasMobileImage: false }] } });
    const pictureRead = controller._motdPictures(state().today); await tick();
    const copying = controller.duplicateAdminMotd("7"); await tick();
    assert.equal(state().duplicatingId, "7"); assert.equal(reads, 1);
    resolve(main); await pictureRead;
    assert.equal(await copying, true); assert.deepEqual(state().draft.image, main);
    assert.equal(state().draft.mobileImage, undefined);
});
test("failed picture copy preserves the old draft and exposes a retry error", async () => {
    const { controller, state } = fixture({ getMotdImage: async () => { throw new Error("picture unavailable"); } });
    controller.setMotdDraft({ bodyMd: "Keep this draft" });
    assert.equal(await controller.duplicateAdminMotd("7"), false);
    assert.equal(state().draft.bodyMd, "Keep this draft"); assert.equal(state().duplicatingId, null);
    assert.match(state().error, /source picture could not be loaded/);
});
test("Duplicate retries a failed picture immediately without discarding loaded variants", async () => {
    let attempts = 0;
    const { controller, store, state } = fixture({ getMotdImage: async (_id, phone) => {
        assert.equal(phone, true);
        if (++attempts === 1) throw new Error("temporary picture failure");
        return mobile;
    } });
    store.dispatch({ type: "motd/patch", patch: { images: { "7": { desktop: main } } } });
    assert.equal(await controller.duplicateAdminMotd("7"), false);
    assert.equal(await controller.duplicateAdminMotd("7"), true);
    assert.equal(attempts, 2); assert.deepEqual(state().draft.image, main); assert.deepEqual(state().draft.mobileImage, mobile);
});
test("unchanged duplicate dates preserve the exact duration through a DST repeated hour", async t => {
    const prior = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    const now = Date.parse("2026-11-01T08:10:15Z");
    t.mock.timers.enable({ apis: ["Date"], now });
    const foldSource = { ...source, fromAt: "2020-01-01T00:00:00Z", toAt: "2020-01-01T01:00:00Z" };
    try {
        const { controller, store, calls, state } = fixture({ listMotds: async () => [foldSource] });
        store.dispatch({ type: "admin/motds", patch: { today: foldSource, history: [foldSource] } });
        store.dispatch({ type: "motd/patch", patch: { images: { "7": { desktop: main, mobile } } } });
        await controller.duplicateAdminMotd("7");
        assert.equal(state().draft.startMode, "now"); assert.equal(state().draft.endMode, "hour");
        await controller.createAdminMotd();
        assert.equal(calls.create[0].startsAt, undefined);
        assert.equal(calls.create[0].endsAt, "2026-11-01T09:10:15.000Z");
        await controller.duplicateAdminMotd("7");
        controller.setMotdDraft({ endMode: "custom", endDate: "2026-11-01", endTime: "03:00" });
        await controller.createAdminMotd();
        assert.equal(calls.create[1].endsAt, "2026-11-01T11:00:00.000Z", "an edited field uses the admin's new local time");
    } finally {
        if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior;
    }
});
test("readers cannot duplicate, and a demotion rejects a pending copy", async () => {
    const reader = fixture({}, { ...admin, isAdmin: false });
    assert.equal(await reader.controller.duplicateAdminMotd("7"), false);
    assert.equal(reader.state().draft.bodyMd, "");
    let resolve;
    const { controller, store, state } = fixture({ getMotdImage: async () => new Promise(r => { resolve = r; }) });
    const copy = controller.duplicateAdminMotd("7"); await tick();
    store.dispatch({ type: "admin/profile/loaded", profile: { ...admin, isAdmin: false } });
    resolve(main); assert.equal(await copy, false);
    assert.equal(state().draft.bodyMd, ""); assert.equal(state().copyNotice, null);
});
test("Publish refuses an image with empty alt text without sending a request", async () => {
    const { controller, calls, state } = fixture();
    controller.setMotdDraft({ fromAt: "2026-11-01T12:00", toAt: "2026-11-02T12:00", bodyMd: "Body", image: { ...main, alt: "" } });
    await controller.createAdminMotd();
    assert.equal(calls.create.length, 0); assert.match(state().error, /alt text is required/);
});
test("the shared paste/drop helpers preserve text and chat rejection behavior", () => {
    const file = { name: "image.png", type: "image/png" };
    assert.deepEqual(imageFiles([file, { type: "text/plain" }]), [file]);
    const data = { items: [{ kind: "file", type: "image/png", getAsFile: () => file }, { kind: "string", type: "text/plain" }] };
    assert.deepEqual(clipboardImageFiles(data), [file]);
    let prevented = 0;
    const event = { clipboardData: data, preventDefault: () => { prevented++; } };
    handleImagePaste(event, () => 1); assert.equal(prevented, 1);
    handleImagePaste(event, () => 0); assert.equal(prevented, 1);
    handleImagePaste(event, () => 0, { consumeRejected: true }); assert.equal(prevented, 2);
    handleImagePaste({ ...event, clipboardData: { items: [{ kind: "string", type: "text/plain" }] } }, () => { throw new Error("Text must not be staged"); });
    assert.equal(prevented, 2);
    let dropped;
    handleImageDrop({ dataTransfer: { files: [file] }, preventDefault: () => { prevented++; } }, files => { dropped = files; });
    assert.deepEqual(dropped, [file]); assert.equal(prevented, 3);
    assert.equal(hasFileDrag({ types: ["Files"] }), true); assert.equal(hasFileDrag({ types: ["text/plain"] }), false);
});
test("the editor prefers mixed clipboard text in a text field without changing chat's default", () => {
    let staged = 0, prevented = 0;
    const file = { type: "image/png" };
    const event = { target: { matches: () => true }, clipboardData: {
        getData: () => "Copied text", items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
    }, preventDefault: () => { prevented++; } };
    handleImagePaste(event, () => { staged++; return 1; }, { preferText: true, consumeRejected: true });
    assert.equal(staged, 0); assert.equal(prevented, 0);
    handleImagePaste(event, () => { staged++; return 1; });
    assert.equal(staged, 1); assert.equal(prevented, 1);
});
