import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowPackageToolError } from "../../dist/workflow/package-pins.js";
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
    assert.equal(error.message, "Tool 'notes-read_note' is not available. This Workflow is pinned to a package version that was deleted "
        + "(package id fixture-package, revision aaaaaaaaaaaa). Its name and version number were not recorded. "
        + "Start a new Workflow to use a current version.");
    assert.deepEqual(error.details, {
        package: null, version: null, revision: pin.revision, reason: "deleted",
    });
});

test("missing labels do not misreport an existing package as deleted", () => {
    assert.throws(() => new WorkflowPackageToolError("notes-read_note", {
        ...pin, package: null, version: null, ownership: null, reason: "disabled",
    }), error => !(error instanceof WorkflowToolAuthorityError)
        && error.message.includes("recorded labels"));
});
