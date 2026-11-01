import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, createInitialState, createStore, selectAdminConsole, selectMotd } from "../src/index.js";

const admin = { provider: "test", subject: "admin", isAdmin: true };
const message = (id = "1", extra = {}) => ({ motdId: id, bodyMd: "Hello", fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z", ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(overrides = {}, profile = admin) {
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    store.dispatch({ type: "motd/patch", patch: { portalEnabled: true } });
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
test("admin-only navigation and previews cannot write dismissals", async () => {
    let writes = 0;
    const { controller, store } = setup({ dismissMotd: async () => { writes++; } });
    assert.ok(selectAdminConsole(store.getState()).settingsTree.some(row => row.id === "motd"));
    controller.previewMotd(message(), { mobile: true });
    assert.equal(selectMotd(store.getState()).preview, true);
    await controller.dismissCurrentMotd(); assert.equal(writes, 0);
    store.dispatch({ type: "admin/profile/loaded", profile: { ...admin, isAdmin: false } });
    assert.ok(!selectAdminConsole(store.getState()).settingsTree.some(row => row.id === "motd"));
    store.dispatch({ type: "admin/section", section: "motd" });
    assert.notEqual(store.getState().admin.section, "motd");
    controller.previewMotd(message()); assert.equal(selectMotd(store.getState()).preview, false);
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
test("request timeout releases reads and rejects late replies", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let resolve;
    const { controller, state } = setup({ getCurrentMotd: () => new Promise(r => { resolve = r; }) });
    const read = controller.refreshMotd(); await tick(); t.mock.timers.tick(10_000); await read;
    assert.equal(state().reading, false); assert.match(state().error, /timed out/);
    resolve(message()); await tick(); assert.equal(state().current, null);
});
