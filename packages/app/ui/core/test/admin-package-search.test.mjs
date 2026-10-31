/**
 * Admin package list search stays in browser state.
 * A keystroke filters the loaded list. It does not call the package API.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
    matchAdminPackage,
    selectAdminConsole,
} from "../src/index.js";

function pkg(name, extras = {}) {
    return {
        packageId: name,
        name,
        scope: extras.scope || "shared",
        enabled: true,
        owner: extras.owner || null,
        createdBy: extras.createdBy || "agent-manager",
        active: {
            semver: "0.1.0",
            manifest: {
                agents: extras.agents || [],
                author: extras.author,
                contributors: extras.contributors,
            },
        },
    };
}

function loaded(store, list) {
    store.dispatch({ type: "admin/profile/loaded", profile: { provider: "test", subject: "alice", email: "alice@test", isAdmin: true, githubCopilotKeySet: false, profileSettings: {} } });
    store.dispatch({ type: "admin/packages/loaded", list, workerState: [] });
    store.dispatch({ type: "admin/section", section: "packages" });
}

function packageNames(store) {
    return selectAdminConsole(store.getState()).settingsTree
        .filter((row) => row.kind === "package")
        .map((row) => row.name);
}

test("search matches package, agent, author, and contributor without a reload", () => {
    const store = createStore(appReducer, createInitialState());
    let loads = 0;
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            listAgentPackages: async () => { loads += 1; return []; },
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "test", subject: "alice", isAdmin: true }),
            listCreatableAgents: async () => [],
            getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        },
    });
    loaded(store, [
        pkg("director-sovereign", { agents: [{ name: "director-sovereign" }], createdBy: "Affan Dar" }),
        pkg("pgrelay-engineer", { agents: [{ name: "nux" }, { name: "slit" }], createdBy: "Affan Dar" }),
        pkg("cawl", { createdBy: "Affan Dar", contributors: ["sample-editor"] }),
    ]);

    controller.setAdminPackageQuery("nux");
    assert.deepEqual(packageNames(store), ["pgrelay-engineer"]);
    const hit = selectAdminConsole(store.getState()).settingsTree.find((row) => row.kind === "package");
    assert.equal(hit.matchField, "agent");
    assert.equal(hit.matchText, "nux");

    controller.setAdminPackageQuery("sample-editor", "contributor");
    assert.deepEqual(packageNames(store), ["cawl"]);

    controller.setAdminPackageQuery("Affan", "author");
    assert.equal(packageNames(store).length, 3);

    controller.setAdminPackageQuery("sovereign", "package");
    assert.deepEqual(packageNames(store), ["director-sovereign"]);

    controller.setAdminPackageQuery("");
    assert.equal(packageNames(store).length, 3);
    assert.equal(loads, 0, "typing does not load packages");
});

test("matchAdminPackage reads only the loaded record", () => {
    const row = pkg("kit", { agents: ["runner"], author: { name: "Ada" }, contributors: [{ name: "Gus" }] });
    assert.equal(matchAdminPackage(row, "runner", "agent").matched, true);
    assert.equal(matchAdminPackage(row, "Ada", "author").matched, true);
    assert.equal(matchAdminPackage(row, "Gus", "contributor").matched, true);
    assert.equal(matchAdminPackage(row, "Gus", "package").matched, false);
});
