import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowPackageToolError, WorkflowPackageCheckError, WorkflowTemporaryToolError, retryWorkflowPackageCheck,
    resolveWorkflowCapabilitySnapshot, refuseLostWorkflowTool,
    workflowUnavailableToolMessages } from "../../dist/workflow/package-pins.js";
import { readWorkflowModel } from "../../dist/workflow/tools.js";
import { WorkflowToolAuthorityError } from "../../dist/workflow/tool-policy.js";

const pin = {
    packageId: "fixture-package",
    package: "fixture-tools",
    version: "1.0.0",
    revision: "a".repeat(64),
    ownership: "owned",
    state: "unavailable",
};

for (const [reason, words] of Object.entries({
    deleted: "was deleted",
    disabled: "was disabled",
    private: "is now private to its owner",
    version_removed: "is no longer in the package",
})) {
    test(`a ${reason} package carries its exact stored-error words and details`, () => {
        const error = new WorkflowPackageToolError("notes-read_note", { ...pin, reason });
        assert.ok(error instanceof WorkflowToolAuthorityError);
        assert.equal(error.message, `Tool 'notes-read_note' is not available. This Workflow is pinned to fixture-tools 1.0.0, `
            + `and that version ${words}. Start a new Workflow to use a current version.`);
        assert.deepEqual(error.details, {
            package: "fixture-tools", version: "1.0.0", revision: pin.revision, reason,
        });
    });
}

test("a deleted legacy package with missing labels reports only its known identity", () => {
    const error = new WorkflowPackageToolError("notes-read_note", {
        ...pin, package: null, version: null, ownership: null, reason: "deleted",
    });

    test("a removed legacy version keeps its known package name without inventing a version", () => {
        const error = new WorkflowPackageToolError("lookup", { ...pin, version: null, reason: "version_removed" });
        assert.match(error.message, /Its package is fixture-tools; its version number was not recorded/);
        assert.equal(error.details.version, null);
    });

    test("temporary check retries stop at the budget and never retry effects or authority failures", async () => {
        const checkError = new WorkflowPackageCheckError("load",
            { package: pin.package, version: pin.version, revision: pin.revision }, new Error("download failed"));
        let calls = 0;
        await assert.rejects(retryWorkflowPackageCheck("lookup", async () => { calls++; throw checkError; },
            { deadline: Date.now() }), error => error instanceof WorkflowTemporaryToolError
                && error.details.reason === "temporary" && error.details.retryable === true);
        assert.equal(calls, 1);
        assert.equal(new WorkflowTemporaryToolError("lookup", checkError).message,
            "Tool 'lookup' could not be checked just now: fixture-tools 1.0.0 could not be loaded. The package is not lost. Call the tool again.");
        for (const error of [new Error("handler failed"), new WorkflowToolAuthorityError("owner changed"),
            new WorkflowPackageToolError("lookup", { ...pin, reason: "disabled" })]) {
            calls = 0;
            await assert.rejects(retryWorkflowPackageCheck("lookup", async () => { calls++; throw error; }), actual => actual === error);
            assert.equal(calls, 1);
        }
    });
    assert.equal(error.message, "Tool 'notes-read_note' is not available. This Workflow is pinned to a package version that was deleted "
        + "(package id fixture-package, revision aaaaaaaaaaaa). Its name and version number were not recorded. "
        + "Start a new Workflow to use a current version.");
    assert.deepEqual(error.details, {
        package: null, version: null, revision: pin.revision, reason: "deleted",
    });
});

test("missing labels do not misreport an existing package as deleted", () => {
    const error = new WorkflowPackageToolError("notes-read_note", {
        ...pin, package: null, version: null, ownership: null, reason: "disabled",
    });
    assert.match(error.message, /version that was disabled/);
    assert.equal(error.details.reason, "disabled");
});

function fixture(activeVersion = "1.0.0") {
    const version = { semver: "1.0.0", sha256: pin.revision };
    const pkg = { packageId: pin.packageId, name: pin.package, enabled: true, scope: "user",
        owner: { provider: "test", subject: "owner" }, active: { ...version, semver: activeVersion } };
    const detail = { ...pkg, versions: [version] };
    const binding = {
        policy: "node-parent-tools-v1", parentSessionId: "parent", owner: pkg.owner, config: {},
        capabilities: { revision: 1, selections: [{ sourceId: pin.packageId, tools: ["lookup"], mcpServers: ["notes"] }] },
        tools: [{ name: "lookup", schemaHash: "schema" },
            { name: "notes-read_note", mcpServerName: "notes", mcpToolName: "read_note", schemaHash: "schema" }],
        sourceRevisions: { [pin.packageId]: pin.revision }, excludedTools: [], boundAgentFingerprint: "",
    };
    const catalog = { listAgentPackages: async () => [pkg], getAgentPackage: async () => detail };
    const tool = { name: "lookup", handler: async () => "captured" };
    const source = { id: pin.packageId, packageId: pin.packageId, name: pin.package, source: "published",
        revision: pin.revision, scope: "user", owner: pkg.owner, tools: new Map([["lookup", tool]]),
        mcpServers: { notes: {} }, artifacts: [] };
    return { pkg, detail, catalog, binding, source };
}

for (const [active, state] of [["1.0.0", "current"], ["1.1.0", "newer_available"],
    ["0.9.0", "rolled_back"], ["1.0.0-beta.1", "rolled_back"], ["1.10.0", "newer_available"]]) {
    test(`pins derive ${state} with active version ${active}, without loading code`, async () => {
        const f = fixture(active);
        const view = await resolveWorkflowCapabilitySnapshot(f.binding, undefined, f.catalog, []);
        assert.deepEqual(view.pins, [{ ...pin, state, activeVersion: active }]);
        assert.deepEqual(view.sources, []);
        assert.deepEqual(view.labels.toolSources, { lookup: pin.packageId, "notes-read_note": pin.packageId });
        assert.deepEqual(view.labels.packagePins[pin.packageId],
            { package: pin.package, version: "1.0.0", ownership: "owned" });
        assert.equal(JSON.stringify(view.labels).includes('"subject"'), false);
        assert.equal(f.binding.packagePins, undefined, "legacy binding is not rewritten");
    });
}

test("a cold loader receives only captured revisions and its sources stay private to the view", async () => {
    const f = fixture("1.1.0");
    const live = [{ ...f.source, revision: "b".repeat(64) }];
    const calls = [];
    const view = await resolveWorkflowCapabilitySnapshot(f.binding, undefined, f.catalog, live, async (id, revision) => {
        calls.push({ id, revision });
        return { ...f.source, id: `${id}@${revision}`, packageId: `${id}@${revision}` };
    });
    assert.deepEqual(calls, [{ id: pin.packageId, revision: pin.revision }]);
    assert.equal(view.sources[0].id, pin.packageId);
    assert.equal(view.sources[0].revision, pin.revision);
    assert.equal(live.length, 1);
    assert.equal(live[0].revision, "b".repeat(64));
});

for (const reason of ["deleted", "disabled", "private", "version_removed"]) {
    test(`${reason} omits only that package and identifies its exact tool, including MCP names`, async () => {
        const f = fixture();
        const retained = { packagePins: { [pin.packageId]: {
            package: pin.package, version: pin.version, ownership: "owned",
        } }, toolSources: {} };
        if (reason === "deleted") f.catalog.listAgentPackages = async () => [];
        if (reason === "disabled") f.detail.enabled = false;
        if (reason === "private") f.detail.owner = f.pkg.owner = { provider: "test", subject: "someone-else" };
        if (reason === "version_removed") f.detail.versions = [];
        const staticSource = { ...f.source, id: "static:fixture", source: "static", scope: "shared",
            tools: new Map([["unrelated", { name: "unrelated" }]]), mcpServers: {} };
        const view = await resolveWorkflowCapabilitySnapshot(f.binding, retained, f.catalog, [staticSource]);
        assert.equal(view.pins[0].state, "unavailable");
        assert.equal(view.pins[0].reason, reason);
        assert.deepEqual(view.sources, [staticSource]);
        assert.doesNotThrow(() => refuseLostWorkflowTool("unrelated", view));
        assert.throws(() => refuseLostWorkflowTool("notes-read_note", view),
            error => error instanceof WorkflowPackageToolError && error.details.reason === reason);
        assert.equal(workflowUnavailableToolMessages(view).size, 2);
    });
}

test("labels do not grant private access even if ownership says owned", async () => {
    const f = fixture();
    f.detail.owner = f.pkg.owner = { provider: "test", subject: "different-owner" };
    f.binding.packagePins = { [pin.packageId]: { package: pin.package, version: pin.version, ownership: "owned" } };
    const view = await resolveWorkflowCapabilitySnapshot(f.binding, undefined, f.catalog, [f.source]);
    assert.equal(view.pins[0].reason, "private");
    assert.equal(view.pins[0].ownership, "other_shared");
    assert.deepEqual(view.sources, []);
});

test("a legacy package deleted before recovery has explicitly unknown labels", async () => {
    const f = fixture();
    f.catalog.listAgentPackages = async () => [];
    const view = await resolveWorkflowCapabilitySnapshot(f.binding, undefined, f.catalog, []);
    assert.deepEqual(view.pins, [{ ...pin, package: null, version: null, ownership: null,
        state: "unavailable", reason: "deleted" }]);
    assert.throws(() => refuseLostWorkflowTool("lookup", view),
        error => error.message.includes("Its name and version number were not recorded."));
});

test("a shared package label survives loss but never keeps its owner's identity", async () => {
    const f = fixture();
    f.detail.scope = f.pkg.scope = "shared";
    f.detail.owner = f.pkg.owner = { provider: "test", subject: "publisher" };
    const first = await resolveWorkflowCapabilitySnapshot(f.binding, undefined, f.catalog, []);
    f.catalog.listAgentPackages = async () => [];
    const gone = await resolveWorkflowCapabilitySnapshot(f.binding, first.labels, f.catalog, []);
    assert.equal(gone.pins[0].ownership, "other_shared");
    assert.equal(gone.pins[0].package, pin.package);
    assert.equal(JSON.stringify(gone).includes("publisher"), false);
});

test("deployment revisions are not compared, and only the called contract decides access", async () => {
    const f = fixture();
    const source = { ...f.source, id: "static:fixture", source: "static", revision: "changed",
        scope: "shared" };
    f.binding.sourceRevisions = { "static:fixture": "captured" };
    const view = await resolveWorkflowCapabilitySnapshot(f.binding, undefined, f.catalog, [source]);
    assert.deepEqual(view.sources, [source]);
    assert.deepEqual(view.pins, []);
});

test("registry, identity and download faults are retries, never inferred loss", async () => {
    for (const fault of ["list", "detail", "identity", "missing detail", "load"]) {
        const f = fixture();
        if (fault === "list") f.catalog.listAgentPackages = async () => { throw new Error("registry unavailable"); };
        if (fault === "detail") f.catalog.getAgentPackage = async () => { throw new Error("registry detail unavailable"); };
        if (fault === "identity") f.detail.packageId = "someone-elses-copy";
        if (fault === "missing detail") f.catalog.getAgentPackage = async () => null;
        await assert.rejects(resolveWorkflowCapabilitySnapshot(f.binding, undefined, f.catalog, [],
            async () => { throw new Error("download unavailable"); }), error => !(error instanceof WorkflowToolAuthorityError));
    }
});

test("pins are additive only on full reads, including when a specialized option is zero", async () => {
    let pinReads = 0;
    const host = {
        store: {
            readDefinition: async () => ({ state: "draft", currentRevision: 1, publishedRevision: null, notifyParent: false }),
            readRevision: async () => ({ revision: 1, valid: false, yamlSha256: "hash", name: "fixture", diagnostics: [], yaml: "" }),
            listRuns: async () => [], readWorkflowToolsDelegated: async () => null,
        },
        readPackagePins: async () => { pinReads++; return [{ ...pin, state: "current" }]; },
    };
    assert.deepEqual((await readWorkflowModel(host, "wf", {}, "api")).pins, [{ ...pin, state: "current" }]);
    assert.equal(pinReads, 1);
    await assert.rejects(readWorkflowModel(host, "wf", { kvRevision: 0 }, "api"),
        error => error.code === "WORKFLOW_READ_INVALID");
    assert.equal(pinReads, 1);
});

for (const provider of ["selection", "bound agent"]) {
    for (const scope of ["user", "shared"]) {
        test(`${provider} attribution ignores an unselected ${scope} package with colliding exports`, async () => {
            const f = fixture();
            const other = { ...f.source, id: "other-package", packageId: "other-package", name: "never-granted",
                revision: "b".repeat(64), scope, owner: { provider: "test", subject: "other-owner" } };
            f.binding.sourceRevisions = { [other.id]: other.revision, ...f.binding.sourceRevisions };
            if (provider === "bound agent") {
                f.binding.capabilities.selections = [];
                f.binding.config.boundAgentPackageId = f.source.id;
            }
            const catalog = {
                listAgentPackages: async () => [{ packageId: other.id, name: other.name, scope, owner: other.owner,
                    active: { semver: "9.0.0" } }, f.pkg],
                getAgentPackage: async name => name === other.name ? { packageId: other.id, name, scope, owner: other.owner,
                    enabled: true, versions: [{ sha256: other.revision, semver: "9.0.0" }] } : f.detail,
            };
            const loads = [];
            const view = await resolveWorkflowCapabilitySnapshot(f.binding, undefined, catalog,
                [other, { ...f.source, revision: "c".repeat(64) }], async id => {
                loads.push(id);
                return id === other.id ? other : f.source;
            });
            assert.deepEqual(view.pins.map(pin => pin.packageId), [f.source.id]);
            assert.equal(view.labels.toolSources.lookup, f.source.id);
            assert.equal(JSON.stringify(view.labels).includes("never-granted"), false);
            assert.deepEqual(loads, [f.source.id]);
            assert.doesNotThrow(() => refuseLostWorkflowTool("lookup", view));
        });
    }
}
