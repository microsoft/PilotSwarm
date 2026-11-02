import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, createInitialState, createStore, selectAdminConsole, selectMotd } from "../src/index.js";

const admin = { provider: "test", subject: "admin", isAdmin: true };
const message = (id = "1", extra = {}) => ({ motdId: id, bodyMd: "Hello", fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z", ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(overrides = {}, profile = admin) {
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    store.dispatch({ type: "motd/patch", patch: { portalEnabled: true } });
    store.dispatch({ type: "auth/context", principal: profile, authorization: { role: profile?.isAdmin ? "admin" : "user" } });
    store.dispatch({ type: "admin/profile/loaded", profile });
    const transport = { getCurrentMotd: async () => message(), dismissMotd: async () => {},
        listMotds: async () => [message("1", { status: "live" })], ...overrides };
    const controller = new PilotSwarmUiController({ store, transport });
    return { store, controller, state: () => store.getState().motd, adminState: () => store.getState().admin.motds };
}
test("MoTD reads are throttled to 30 seconds and support expiry/deletion", async () => {
    let reads = 0;
    const { controller, store } = setup({ getCurrentMotd: async () => ++reads === 1 ? message() : null });
    await controller.refreshMotd(); assert.equal(selectMotd(store.getState()).message.motdId, "1");
    await controller.refreshMotd(); assert.equal(reads, 1);
    store.dispatch({ type: "motd/patch", patch: { readAt: Date.now() - 30_001 } });
    await controller.refreshMotd(); assert.equal(reads, 2); assert.equal(selectMotd(store.getState()).message, null);
});
test("a terminal controller does not poll or expose the browser-only MoTD tab", async () => {
    let reads = 0;
    const { controller, store } = setup({ getCurrentMotd: async () => { reads++; } });
    store.dispatch({ type: "motd/patch", patch: { portalEnabled: false } });
    await controller.refreshMotd();
    assert.equal(reads, 0);
    assert.ok(!selectAdminConsole(store.getState()).settingsTree.some(row => row.id === "motd"));
});
test("dismissing fleet-current does not refetch immediately or use hidden history as a replacement", async () => {
    let reads = 0, dismissed = false;
    const { controller, store, state } = setup({
        getCurrentMotd: async () => { reads++; return dismissed ? null : message("2"); },
        dismissMotd: async id => { assert.equal(id, "2"); dismissed = true; },
        listMotds: async () => [message("2", { status: "live" }), message("1", { status: "hidden" })],
    });
    await controller.refreshMotd();
    await controller.refreshAdminMotds();
    await controller.dismissCurrentMotd();
    assert.equal(reads, 1);
    assert.equal(selectMotd(store.getState()).message, null);
    store.dispatch({ type: "motd/patch", patch: { readAt: Date.now() - 30_001 } });
    await controller.refreshMotd();
    assert.equal(reads, 2);
    assert.equal(state().current, null);
    assert.equal(selectMotd(store.getState()).message, null);
    assert.equal(store.getState().admin.motds.history[1].status, "hidden");
});
test("dismissal hides immediately, retries failure and never writes profile settings", async () => {
    let dismissals = 0, profileWrites = 0;
    let release;
    const { controller, store, state } = setup({ dismissMotd: () => {
        dismissals++;
        if (dismissals === 1) return new Promise((_, reject) => { release = reject; });
        return Promise.resolve();
    }, setCurrentUserProfileSettings: async () => { profileWrites++; } });
    await controller.refreshMotd();
    const dismiss = controller.dismissCurrentMotd(); await tick();
    assert.equal(selectMotd(store.getState()).message, null);
    release(new Error("not saved")); await dismiss;
    assert.deepEqual(state().pendingDismissals, ["1"]);
    store.dispatch({ type: "motd/patch", patch: { readAt: 0 } });
    await controller.refreshMotd(); assert.equal(dismissals, 2); assert.deepEqual(state().pendingDismissals, []);
    assert.equal(selectMotd(store.getState()).message, null); assert.equal(profileWrites, 0);
    store.dispatch({ type: "motd/patch", patch: { current: message("2") } });
    assert.equal(selectMotd(store.getState()).message.motdId, "2");
});
test("signed-in readers have navigation and previews without dismissal writes", async () => {
    let writes = 0;
    const { controller, store } = setup({ dismissMotd: async () => { writes++; } });
    assert.ok(selectAdminConsole(store.getState()).settingsTree.some(row => row.id === "motd"));
    controller.previewMotd(message(), { mobile: true });
    assert.equal(selectMotd(store.getState()).preview, true);
    await controller.dismissCurrentMotd(); assert.equal(writes, 0);
    store.dispatch({ type: "admin/profile/loaded", profile: { ...admin, isAdmin: false } });
    assert.ok(selectAdminConsole(store.getState()).settingsTree.some(row => row.id === "motd"));
    store.dispatch({ type: "admin/section", section: "motd" });
    assert.equal(store.getState().admin.section, "motd");
    controller.previewMotd(message()); assert.equal(selectMotd(store.getState()).preview, true);
    await controller.dismissCurrentMotd(); assert.equal(writes, 0);
});
test("unsigned viewers cannot enter the history tab or preview", () => {
    const { controller, store } = setup();
    store.dispatch({ type: "auth/context", principal: null, authorization: null });
    assert.ok(!selectAdminConsole(store.getState()).settingsTree.some(row => row.id === "motd"));
    store.dispatch({ type: "admin/section", section: "motd" });
    assert.notEqual(store.getState().admin.section, "motd");
    controller.previewMotd(message());
    assert.equal(selectMotd(store.getState()).message, null);
});
test("transports with only an authenticated profile still expose reader history", async () => {
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    store.dispatch({ type: "motd/patch", patch: { portalEnabled: true } });
    store.dispatch({ type: "auth/context", principal: { displayName: "Profile-only reader" }, authorization: null });
    store.dispatch({ type: "admin/profile/loaded", profile: { ...admin, isAdmin: false } });
    const controller = new PilotSwarmUiController({ store, transport: { listMotds: async () => [message("9", { status: "ended" })] } });
    assert.ok(selectAdminConsole(store.getState()).settingsTree.some(row => row.id === "motd"));
    await controller.refreshAdminMotds();
    assert.equal(store.getState().admin.motds.history[0].motdId, "9");
    store.dispatch({ type: "motd/patch", patch: { current: message(), dismissed: ["9"] } });
    store.dispatch({ type: "admin/profile/loaded", profile: { ...admin, subject: "different-reader", isAdmin: false } });
    assert.equal(store.getState().motd.current, null);
    assert.deepEqual(store.getState().motd.dismissed, []);
});
test("a non-admin can read and expand picture history without gaining mutation rights", async () => {
    let creates = 0, deletes = 0, pictureReads = 0;
    const older = message("9", { status: "ended", hasImage: true });
    const { controller, store, state, adminState } = setup({
        listMotds: async () => [older], getCurrentMotd: async () => null,
        getMotdImage: async () => { pictureReads++; return { base64: "AAAA", contentType: "image/png", alt: "Older picture" }; },
        createMotd: async () => { creates++; }, deleteMotd: async () => { deletes++; },
    }, { ...admin, isAdmin: false });
    await controller.refreshAdminMotds();
    assert.equal(adminState().history[0].motdId, "9");
    controller.setMotdHistoryExpanded("9", true); await tick();
    assert.equal(pictureReads, 1); assert.ok(state().images["9"]);
    await controller.refreshMotd(); assert.ok(state().images["9"]);
    await controller.createAdminMotd(); await controller.deleteAdminMotd("9");
    assert.equal(creates, 0); assert.equal(deletes, 0);
    controller.previewMotd(older); assert.equal(selectMotd(store.getState()).preview, true);
    await controller.dismissCurrentMotd();
    controller.setMotdHistoryExpanded("9", false);
    assert.equal(state().images["9"], undefined);
});
test("identity changes clear state and reject slow previous-user replies", async () => {
    let resolve;
    const { controller, store, state } = setup({ getCurrentMotd: () => new Promise(r => { resolve = r; }) });
    const read = controller.refreshMotd(); await tick();
    store.dispatch({ type: "auth/context", principal: { provider: "test", subject: "next" }, authorization: { role: "user" } });
    resolve(message()); await read;
    assert.equal(state().current, null); assert.equal(state().reading, false); assert.deepEqual(state().dismissed, []);
});
test("admin draft keeps retry identity, history labels and explicit errors", async () => {
    const calls = [];
    const { controller, store, adminState } = setup({ createMotd: async input => { calls.push(input); if (calls.length === 1) throw new Error("uncertain response"); } });
    controller.setMotdDraft({ fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z", bodyMd: "Hello" });
    await controller.createAdminMotd(); assert.match(adminState().error, /uncertain/);
    await controller.createAdminMotd(); assert.equal(calls[0].requestId, calls[1].requestId);
    assert.equal(adminState().notice, "Message published."); assert.equal(adminState().today.status, "live");
    store.dispatch({ type: "admin/profile/loaded", profile: { ...admin, isAdmin: false } });
    await controller.createAdminMotd(); assert.equal(calls.length, 2);
});
test("delete immediately clears the current splash, preview and pictures", async () => {
    const { controller, store, state } = setup({ deleteMotd: async () => {}, listMotds: async () => [] });
    store.dispatch({ type: "motd/patch", patch: { current: message(), preview: message(), images: { "1": { desktop: {} } } } });
    await controller.deleteAdminMotd("1");
    assert.equal(state().current, null); assert.equal(state().preview, null); assert.deepEqual(state().images, {});
});
test("delete waits while a Duplicate is filling the draft", async () => {
    let deletes = 0;
    const { controller, store } = setup({ deleteMotd: async () => { deletes += 1; }, listMotds: async () => [] });
    store.dispatch({ type: "admin/motds", patch: { duplicatingId: "7" } });
    await controller.deleteAdminMotd("1");
    assert.equal(deletes, 0);
    store.dispatch({ type: "admin/motds", patch: { duplicatingId: null } });
    await controller.deleteAdminMotd("1");
    assert.equal(deletes, 1);
});
test("closing a preview never dismisses the current message", async () => {
    let dismissed = 0;
    const { controller, store, state } = setup({ dismissMotd: async () => { dismissed += 1; } });
    store.dispatch({ type: "motd/patch", patch: { current: message(), preview: message("2") } });
    controller.closeMotdPreview();
    assert.equal(state().preview, null);
    controller.closeMotdPreview();
    assert.equal(state().current?.motdId, message().motdId);
    assert.equal(dismissed, 0);
});
test("request timeout releases reads and rejects late replies", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let resolve;
    const { controller, state } = setup({ getCurrentMotd: () => new Promise(r => { resolve = r; }) });
    const read = controller.refreshMotd(); await tick(); t.mock.timers.tick(10_000); await read;
    assert.equal(state().reading, false); assert.match(state().error, /timed out/);
    resolve(message()); await tick(); assert.equal(state().current, null);
});
test("pictures load only for the active device and do not block metadata reads", async () => {
    const calls = [];
    const { controller, store, state } = setup({ getCurrentMotd: async () => message("1", { hasImage: true, hasMobileImage: true }),
        getMotdImage: async (_id, mobile) => { calls.push(mobile); return { base64: "AAAA", contentType: "image/png", alt: "Picture" }; } });
    store.dispatch({ type: "ui/sessionViewDevice", device: "mobile" });
    await controller.refreshMotd(); await tick();
    assert.deepEqual(calls, [true]); assert.equal(state().reading, false);
    store.dispatch({ type: "ui/sessionViewDevice", device: "desktop" });
    await controller.refreshMotd(); await tick();
    assert.deepEqual(calls, [true, false]);
});
test("failed pictures back off for five minutes and keep today's admin cache", async () => {
    let calls = 0;
    const { controller, store, state } = setup({ getCurrentMotd: async () => message("1", { hasImage: true }),
        getMotdImage: async () => { calls++; throw new Error("picture unavailable"); } });
    await controller.refreshMotd(); await tick();
    assert.equal(calls, 1); assert.equal(state().images["1"].failures.desktop, true);
    store.dispatch({ type: "motd/patch", patch: { readAt: 0 } });
    await controller.refreshMotd(); await tick(); assert.equal(calls, 1);
    const cached = state().images["1"];
    store.dispatch({ type: "motd/patch", patch: { images: { "1": { ...cached, attempted: { desktop: Date.now() - 300_001 } } } } });
    await controller.refreshMotd(); await tick(); assert.equal(calls, 2);
    store.dispatch({ type: "admin/motds", patch: { today: message("1", { status: "live" }) } });
    store.dispatch({ type: "motd/patch", patch: { readAt: 0, dismissed: ["1"] } });
    await controller.refreshMotd();
    assert.ok(state().images["1"], "dismissed today's admin preview keeps its picture entry");
});
test("a timed-out picture request is aborted", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    const { controller, state } = setup({ getMotdImage: (_id, _mobile, options) => {
        signal = options.signal; return new Promise(() => {});
    } });
    const loading = controller._motdPictures(message("1", { hasImage: true })); await tick();
    t.mock.timers.tick(60_000); await loading;
    assert.equal(signal.aborted, true); assert.equal(state().images["1"].failures.desktop, true);
});
test("first profile seed for the signed-in person keeps the splash and a pending dismissal", async () => {
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    store.dispatch({ type: "auth/context", principal: admin, authorization: { role: "admin" } });
    store.dispatch({ type: "motd/patch", patch: { portalEnabled: true, current: message(), dismissed: ["9"], pendingDismissals: ["9"] } });
    const before = store.getState().motd;
    store.dispatch({ type: "admin/profile/loaded", profile: admin });
    assert.equal(store.getState().motd, before);
    store.dispatch({ type: "admin/profile/loaded", profile: { ...admin, isAdmin: false } });
    assert.deepEqual(store.getState().motd.pendingDismissals, ["9"]);
});
test("late list and current replies cannot restore a deleted message", async () => {
    let listResolve, currentResolve, reads = 0;
    const { controller, store, state, adminState } = setup({
        getCurrentMotd: () => new Promise(resolve => { currentResolve = resolve; }),
        listMotds: () => ++reads === 1 ? new Promise(resolve => { listResolve = resolve; }) : Promise.resolve([]),
        deleteMotd: async () => {},
    });
    const current = controller.refreshMotd();
    const listing = controller.refreshAdminMotds(); await tick();
    await controller.deleteAdminMotd("1");
    listResolve([message("1", { status: "live" })]); currentResolve(message("1"));
    await Promise.all([current, listing]);
    assert.equal(reads, 2); assert.deepEqual(adminState().history, []);
    assert.equal(state().current, null); assert.equal(adminState().loading, false);
});
test("a role-only change can retry an in-flight picture without accepting its stale reply", async () => {
    let calls = 0, resolveOld;
    const fresh = { base64: "AAAA", contentType: "image/png", alt: "New picture" };
    const { controller, store, state } = setup({ getMotdImage: () => ++calls === 1
        ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(fresh) });
    const old = controller._motdPictures(message("1", { hasImage: true })); await tick();
    store.dispatch({ type: "admin/profile/loaded", profile: { ...admin, isAdmin: false } });
    await controller._motdPictures(message("1", { hasImage: true }));
    resolveOld({ ...fresh, alt: "Stale picture" }); await old;
    assert.equal(calls, 2); assert.equal(state().images["1"].desktop.alt, "New picture");
});
test("a reply that is not a message never reaches the splash", async () => {
    const { isMotdMessage, formatMotdWindow } = await import("../src/motd.js");
    for (const reply of [{ ok: true }, {}, undefined, null, "x", message("1", { fromAt: "not a date" }), { bodyMd: "no id", fromAt: "2020-01-01T00:00:00Z" }]) {
        const { controller, store } = setup({ getCurrentMotd: async () => reply });
        await controller.refreshMotd();
        assert.equal(selectMotd(store.getState()).message, null, `reply ${JSON.stringify(reply)}`);
        assert.equal(isMotdMessage(reply), false);
    }
    assert.equal(isMotdMessage(message("1")), true);
    assert.equal(isMotdMessage(message(7)), true);
    assert.doesNotThrow(() => formatMotdWindow({ fromAt: undefined, toAt: null }));
    assert.match(formatMotdWindow({ fromAt: "garbage", toAt: "also garbage" }), /^an unknown time until an unknown time \(/);
});
test("publishing works on a plain-HTTP origin without crypto.randomUUID", async () => {
    const { motdRequestId } = await import("../src/motd.js");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert.match(motdRequestId({ getRandomValues: bytes => globalThis.crypto.getRandomValues(bytes) }), uuid);
    assert.match(motdRequestId({}), uuid);
    const original = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
    const sent = [];
    try {
        Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
        const { controller, store } = setup({ createMotd: async input => { sent.push(input); return { motdId: "9" }; }, listMotds: async () => [] });
        controller.setMotdDraft?.({ bodyMd: "QA plain HTTP", startMode: "now", endMode: "never" });
        if (!controller.setMotdDraft) store.dispatch({ type: "admin/motds", patch: { draft: { ...store.getState().admin.motds.draft, bodyMd: "QA plain HTTP" } } });
        await controller.createAdminMotd();
        assert.equal(sent.length, 1);
        assert.match(sent[0].requestId, uuid);
        assert.equal(store.getState().admin.motds.error, null);
    } finally {
        if (original) Object.defineProperty(globalThis.crypto, "randomUUID", original);
    }
});
