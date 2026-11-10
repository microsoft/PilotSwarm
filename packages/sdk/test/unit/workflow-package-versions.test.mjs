/**
 * Stage 2 review fixes for a chat's package Workflow Definitions (stage 2.3), without a database:
 * - S2SF-F6 / formal L4: a version is offered as newer only when it is the same package (its package id) with a strictly
 *   greater semver: never an older active version (a rollback), the same version, or another package of the same name
 *   (an owner's own copy that shadows the shared one);
 * - formal L1: Make a copy records what it was copied from (the locked definition, the revision and its package version);
 * - formal L2: a retried attach is answered from its stored receipt before the registry is read again (its active version
 *   may have moved since); another request under the same operation id is OPERATION_CONFLICT.
 *
 * Run: node --test test/unit/workflow-package-versions.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { packageVersionIsNewer } from "../../dist/workflow/chat-packages.js";
import { attachChatPackageWorkflow, copyChatPackageWorkflow, readPackageWorkflowCard, saveChatWorkflowDefinition, withPackageUpdates } from "../../dist/workflow/chat-definitions.js";

const PKG = "pkg-release";
const at = (semver, packageId = PKG) => ({ packageId, packageName: "release-tools", semver, sha256: `sha-${packageId}-${semver}`, cardDigest: "c" });

test("S2SF-F6: newer means the same package's strictly greater semver", () => {
    assert.equal(packageVersionIsNewer(at("1.1.0"), at("1.2.0")), true);
    assert.equal(packageVersionIsNewer(at("1.1.0"), at("2.0.0-rc.1")), true);
    assert.equal(packageVersionIsNewer(at("1.1.0"), at("1.0.0")), false, "a rollback");
    assert.equal(packageVersionIsNewer(at("1.1.0"), at("1.1.0")), false, "the same version");
    assert.equal(packageVersionIsNewer(at("1.1.0"), at("1.1.0-rc.1")), false, "a prerelease of it");
    assert.equal(packageVersionIsNewer(at("1.1.0"), at("2.0.0", "pkg-own-copy")), false, "another package of the same name");
    assert.equal(packageVersionIsNewer(at("1.1.0"), { packageId: PKG, semver: "not-a-version" }), false);
    assert.equal(packageVersionIsNewer(null, at("1.2.0")), false);
});

/** A locked view of release-tools/release-watch whose newest revision is `attached`. */
const view = attached => ({ definitionId: "def-pkg", name: "release-tools/release-watch", locked: true, deletedAt: null,
    current: { revision: 1, package: attached } });
const hostWith = active => ({ packageWorkflows: {
    list: async () => [{ ref: "release-tools/release-watch", packageId: active.packageId, packageName: "release-tools", semver: active.semver,
        sha256: active.sha256, workflow: { name: "release-watch" } }],
    find: async () => ({ ref: "release-tools/release-watch", packageId: active.packageId, packageName: "release-tools", semver: active.semver,
        sha256: active.sha256, workflow: { name: "release-watch" } }),
} });

test("S2SF-F6: 1.1.0 attached and 1.0.0 active (a rollback) is no offer; neither is an owner's own copy; 1.2.0 of the same package is", async () => {
    for (const [active, offered] of [[at("1.0.0"), null], [at("1.1.0"), null], [at("2.0.0", "pkg-own-copy"), null], [at("1.2.0"), "1.2.0"]]) {
        const [listed] = await withPackageUpdates(hostWith(active), [view(at("1.1.0"))], { provider: "dev", subject: "alice" });
        assert.equal(listed.packageUpdate?.semver ?? null, offered, `${active.packageId} ${active.semver}`);
    }
    // The card the chat reads says no newer version either.
    for (const [active, offered] of [[at("1.0.0"), null], [at("2.0.0", "pkg-own-copy"), null], [at("1.2.0"), "1.2.0"]]) {
        const host = { ...hostWith(active), store: { readWorkflowLineage: async () => null, chat: {
            readDefinitionByName: async () => ({ definitionId: "def-pkg", currentRevision: 1 }),
            readRevision: async () => ({ revision: 1, valid: false, package: at("1.1.0"),
                card: { name: "release-watch", description: "Watches a train.", whenToUse: "A train.", inputs: { example: null, schema: null },
                    outcomes: { done: "Done." }, output: { about: null, schema: null }, asks: {}, sends: {}, effects: "One wait.", model: null, notes: "" } }),
        } } };
        const card = await readPackageWorkflowCard(host, "chat-1", "release-tools/release-watch", null);
        assert.equal(card.newerVersion, offered, `${active.packageId} ${active.semver}`);
    }
});

test("L2: a retried attach is answered from its stored receipt, before the registry is read; another request under its id is refused", async () => {
    const receipt = { operation: "attach", definitionId: "def-pkg", name: "release-tools/release-watch", revision: 2, created: false, changed: true,
        package: at("1.1.0"), attachedAt: "2026-11-07T10:00:00.000Z" };
    const host = { store: { readWorkflowLineage: async () => null, chat: { readStoredOperation: async (owner, operationId) => (operationId === "definition:call-1:attach"
        ? { kind: "attach", receipt } : null) } },
    packageWorkflows: { find: async () => { throw new Error("the registry was read"); }, readYaml: async () => { throw new Error("read"); } } };
    const request = { ownerSessionId: "chat-1", ref: "release-tools/release-watch", viewer: null, actor: { kind: "chat", sessionId: "chat-1" },
        operationId: "definition:call-1:attach", by: "chat", newerOnly: true };
    // The registry has moved on (a republish): the retry still answers what was attached.
    assert.deepEqual(await attachChatPackageWorkflow(host, request), { receipt, replayed: true });
    assert.deepEqual(await attachChatPackageWorkflow(host, { ...request, version: { packageId: PKG, sha256: receipt.package.sha256 } }),
        { receipt, replayed: true });
    for (const other of [{ ref: "release-tools/other" }, { version: { packageId: PKG, sha256: "another" } }]) {
        await assert.rejects(attachChatPackageWorkflow(host, { ...request, ...other }), (error) => error.code === "OPERATION_CONFLICT");
    }
});

test("L1: Make a copy saves the chat's own definition and names what it was copied from", async () => {
    const yaml = "apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: release-watch, version: \"1.1.0\" }\ninitial: hold\n"
        + "states:\n  hold: { type: wait, seconds: 30, transition: { next: { elapsed: done } } }\n  done: { type: terminal, outcome: succeeded }\n";
    const saves = [];
    const host = { store: { readWorkflowLineage: async () => null, chat: {
        readDefinition: async () => ({ definitionId: "def-pkg", ownerSessionId: "chat-1", name: "release-tools/release-watch", currentRevision: 2,
            locked: true, deletedAt: null }),
        readRevision: async (definitionId, revision) => ({ revision, yaml, package: at("1.1.0") }),
        save: async (input) => { saves.push(input); return { receipt: { operation: "save", definitionId: "def-copy", name: input.name, revision: 1 }, replayed: false }; },
    } } };
    await copyChatPackageWorkflow(host, { ownerSessionId: "chat-1", definitionId: "def-pkg", revision: 2,
        actor: { kind: "user", provider: "dev", subject: "ada", display: "Ada" }, operationId: "copy-1", personWords: "Ada" });
    assert.equal(saves.length, 1);
    assert.equal(saves[0].name, "release-watch");
    assert.equal(saves[0].expected, null);
    assert.deepEqual(saves[0].copiedFrom, { definitionId: "def-pkg", name: "release-tools/release-watch", revision: 2,
        package: { packageId: PKG, packageName: "release-tools", semver: "1.1.0", sha256: at("1.1.0").sha256 } });
});

// DS-1 (TEST check at 406550a9): a person's save of a package's locked definition answers DEFINITION_LOCKED, with the words
// that say Make a copy, whatever name it gives (the definition's own <package>/<name>, a bare name, or none), before the
// name rule or the YAML is checked; nothing reaches the store's save.
test("DS-1: a save aimed at a locked definition is DEFINITION_LOCKED by its id or its <package>/<name>, whatever name it gives", async () => {
    const locked = { definitionId: "def-pkg", ownerSessionId: "chat-1", name: "release-tools/release-watch", currentRevision: 1, locked: true,
        packageName: "release-tools", deletedAt: null };
    const host = { store: { readWorkflowLineage: async () => null, chat: {
        readDefinition: async (id) => (id === "def-pkg" ? locked : null),
        readDefinitionByName: async (owner, name) => (owner === "chat-1" && name === locked.name ? locked : null),
        save: async () => { throw new Error("the store's save was reached"); },
    } } };
    const base = { ownerSessionId: "chat-1", yaml: "apiVersion: pilotswarm.dev/v1\n", actor: { kind: "user", provider: "dev", subject: "ada" },
        operationId: "save-1", by: "person" };
    for (const [name, expected] of [["release-tools/release-watch", { definitionId: "def-pkg", revision: 1 }], ["release-watch", { definitionId: "def-pkg", revision: 1 }],
        ["", { definitionId: "def-pkg", revision: 1 }], ["release-tools/release-watch", null]]) {
        await assert.rejects(saveChatWorkflowDefinition(host, { ...base, name, expected }), (error) => error.code === "DEFINITION_LOCKED"
            && /is locked: it cannot be changed here\. Make a copy of it \(in the Workflow tab\) and change the copy\. Nothing was saved\.$/.test(error.message),
        `${name} ${JSON.stringify(expected)}`);
    }
    // Another chat's locked definition is not this chat's: the ordinary checks answer.
    await assert.rejects(saveChatWorkflowDefinition(host, { ...base, ownerSessionId: "chat-2", name: "release-tools/release-watch", expected: null }),
        (error) => error.code === "WORKFLOW_COMMAND_INVALID");
});
