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

test("only package rows scroll; a section after the packages stays outside the scroller", async () => {
    const { readFileSync } = await import("node:fs");
    const webApp = readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    assert.match(webApp, /const nextSection = tree\.findIndex\(\(row, index\) => index >= headEnd && row\.kind !== "group" && row\.kind !== "package"\);/);
    assert.doesNotMatch(webApp, /const tailStart = workersIndex >= 0/, "the scroller no longer ends at Workers by name");
});

test("Find highlights matches inline in package rows only", async () => {
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { readFileSync } = await import("node:fs");
    const webApp = readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
    assert.match(webApp, /row\.kind === "package" \? highlightPackageQuery\(row\.label, query\) : row\.label/,
        "section rows such as Appearance are never highlighted");
    assert.match(webApp, /React\.createElement\("span", \{ className: "ps-admin-tree__text" \},/,
        "the label and its mark share one inline span inside the column");
    assert.match(css, /\.ps-admin-tree__text, \.ps-admin-tree__match \{[^}]*white-space: nowrap;/);
    assert.match(css, /\.ps-admin-tree__mark \{ display: inline;/);
    const html = renderToStaticMarkup(React.createElement("span", { className: "ps-admin-tree__text" }, ["", React.createElement("mark", { key: "hit" }, "a"), "gent-manager"]));
    assert.equal(html, "<span class=\"ps-admin-tree__text\"><mark>a</mark>gent-manager</span>");
});
