// A worker's provider-registry refresh that fails (the catalog's database not reachable) leaves the registry empty on
// purpose, so a turn fails closed (FU-10 keeps that). While it is so, a model that does not resolve is reported as the
// model list not loaded, retryably, not as an unknown model; the next refresh that reads the catalog restores both.
import test from "node:test";
import assert from "node:assert/strict";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { buildRuntimeRegistry } from "../../dist/provider-catalog.js";
import { MODEL_LIST_UNAVAILABLE_TEXT, ModelListUnavailableError, SessionManager } from "../../dist/session-manager.js";

const MODEL = "azure-openai:gpt-5.6-terra";
const types = new ModelProviderRegistry({
    providers: [{ id: "azure-openai", type: "openai", baseUrl: "https://example.invalid/openai/v1", apiKey: "type-key", models: ["gpt-5.6-terra"] }],
});
const credential = {
    name: "azure-openai", typeId: "azure-openai", class: "shared", ownerUserId: null,
    baseUrl: null, secretRef: { kind: "apiKey", value: "instance-key" },
};

/** A worker as _refreshProviderRegistry sees it, with a catalog whose reads fail while `down` is set. */
function workerWith(manager, state) {
    const read = async value => {
        if (state.down) throw new Error("Connection terminated due to connection timeout");
        return value;
    };
    return {
        sessionManager: manager,
        _modelProviderTypes: types,
        _modelProviders: null,
        _catalog: { providers: {
            allCredentials: () => read([credential]),
            getDefaults: () => read({ cluster: { model: MODEL } }),
        } },
    };
}

test("a failed provider refresh keeps the registry closed and says the model list could not be loaded, retryably", async (t) => {
    t.mock.method(console, "warn", () => {});
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    const refresh = worker => PilotSwarmWorker.prototype._refreshProviderRegistry.call(worker);
    const manager = new SessionManager(undefined, null, { modelProviders: buildRuntimeRegistry(types, [credential], MODEL) });
    const state = { down: false };
    const worker = workerWith(manager, state);

    await refresh(worker);
    assert.equal(manager.normalizeModelRef(MODEL), MODEL);
    assert.equal(manager.modelListUnavailable, false);

    // The refresh fails: still closed (no provider, so nothing resolves), and the error says why, retryably.
    state.down = true;
    await refresh(worker);
    assert.equal(manager.modelListUnavailable, true);
    assert.equal(worker._modelProviders.allProviders.length, 0, "the registry stays closed (FU-10)");
    for (const ref of [MODEL, undefined, "nobody:nothing"]) {
        assert.throws(() => manager.normalizeModelRef(ref), error => {
            assert.ok(error instanceof ModelListUnavailableError);
            assert.equal(error.message, MODEL_LIST_UNAVAILABLE_TEXT);
            assert.equal(error.message, "The model list could not be loaded right now (the database is not reachable); try again shortly.");
            assert.equal(error.code, "MODEL_LIST_UNAVAILABLE");
            assert.equal(error.retryable, true);
            assert.doesNotMatch(error.message, /Unknown model/);
            return true;
        }, `model ${ref ?? "(default)"}`);
    }
    assert.throws(() => manager.resolveModelSwitchConfig(MODEL), ModelListUnavailableError);

    // The next refresh that reads the catalog restores the model; an unknown model is unknown again.
    state.down = false;
    await refresh(worker);
    assert.equal(manager.modelListUnavailable, false);
    assert.equal(manager.normalizeModelRef(MODEL), MODEL);
    assert.throws(() => manager.normalizeModelRef("nobody:nothing"), error => {
        assert.ok(!(error instanceof ModelListUnavailableError));
        assert.match(error.message, /^Unknown model "nobody:nothing"/);
        return true;
    });
});

test("a registry set without the unavailable mark (a file reload, a good refresh) clears it", () => {
    const manager = new SessionManager(undefined, null, { modelProviders: buildRuntimeRegistry(types, [], null) });
    manager.setModelProviders(buildRuntimeRegistry(types, [], null), { unavailable: true });
    assert.equal(manager.modelListUnavailable, true);
    manager.setModelProviders(buildRuntimeRegistry(types, [credential], MODEL));
    assert.equal(manager.modelListUnavailable, false);
    assert.equal(manager.normalizeModelRef(MODEL), MODEL);
});
