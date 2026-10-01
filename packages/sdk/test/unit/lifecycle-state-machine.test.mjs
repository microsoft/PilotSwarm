import assert from "node:assert/strict";
import test from "node:test";

import {
    compileLifecycleStateMachine,
    validateLifecycleStateMachineSnapshot,
} from "../../dist/lifecycle-state-machine.js";

function workflowFiles() {
    return new Map([
        ["Example.Initial.md", [
            "# Initial",
            "",
            "Inspect the source record.",
            "",
            "## Possible next states",
            "- [Fixed](./Example.Fixed.md)",
        ].join("\n")],
        ["Example.Fixed.md", "# Fixed\n\nThe workflow is complete.\n"],
    ]);
}

test("compiles a complete immutable lifecycle snapshot from one resolved source revision", async () => {
    const files = workflowFiles();
    const resolutions = [];
    const reads = [];
    const snapshot = await compileLifecycleStateMachine({
        lifecycleName: "Example",
        initialState: "Initial",
        sources: [{
            sourceId: "example",
            owner: "user",
            filePrefix: "Example",
            requestedRef: "main",
        }],
        reader: {
            async resolveSourceCommit(source) {
                resolutions.push(source.requestedRef);
                return "commit-one";
            },
            async readStateMarkdown(source, sourcePath) {
                reads.push([source.resolvedCommit, sourcePath]);
                return files.get(sourcePath) ?? null;
            },
        },
    });

    assert.deepEqual(resolutions, ["main"]);
    assert.deepEqual(reads, [
        ["commit-one", "Example.Initial.md"],
        ["commit-one", "Example.Fixed.md"],
    ]);
    assert.equal(snapshot.initialState, "Initial");
    assert.equal(snapshot.states.Initial.sourceCommit, "commit-one");
    assert.deepEqual(snapshot.states.Initial.outcomes, [{ outcome: "Fixed", toState: "Fixed" }]);
    assert.equal(snapshot.states.Fixed.terminal, true);
    assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);
    assert.equal(validateLifecycleStateMachineSnapshot(snapshot), snapshot);

    files.set("Example.Initial.md", "# Changed after publication");
    assert.match(snapshot.states.Initial.markdown, /Inspect the source record/);
});

test("rejects a definition whose reachable target cannot be resolved", async () => {
    const files = workflowFiles();
    files.delete("Example.Fixed.md");
    await assert.rejects(
        compileLifecycleStateMachine({
            lifecycleName: "Example",
            initialState: "Initial",
            sources: [{
                sourceId: "example",
                owner: "user",
                filePrefix: "Example",
                resolvedCommit: "commit-one",
            }],
            reader: {
                async readStateMarkdown(_source, sourcePath) {
                    return files.get(sourcePath) ?? null;
                },
            },
        }),
        /state Fixed was not found/,
    );
});

test("detects persisted snapshot content tampering", async () => {
    const snapshot = await compileLifecycleStateMachine({
        lifecycleName: "Example",
        initialState: "Initial",
        sources: [{
            sourceId: "example",
            owner: "user",
            filePrefix: "Example",
            resolvedCommit: "commit-one",
        }],
        reader: {
            async readStateMarkdown(_source, sourcePath) {
                return workflowFiles().get(sourcePath) ?? null;
            },
        },
    });
    const tampered = structuredClone(snapshot);
    tampered.states.Initial.markdown = "# Tampered";
    assert.throws(
        () => validateLifecycleStateMachineSnapshot(tampered),
        /Markdown hash is invalid/,
    );
});

test("canonical hash is independent of source metadata property order", async () => {
    const reader = {
        async readStateMarkdown(_source, sourcePath) {
            return workflowFiles().get(sourcePath) ?? null;
        },
    };
    const first = await compileLifecycleStateMachine({
        lifecycleName: "Example",
        initialState: "Initial",
        sources: [{
            sourceId: "example",
            owner: "user",
            filePrefix: "Example",
            repository: "org/repo",
            resolvedCommit: "commit-one",
        }],
        reader,
    });
    const second = await compileLifecycleStateMachine({
        lifecycleName: "Example",
        initialState: "Initial",
        sources: [{
            resolvedCommit: "commit-one",
            repository: "org/repo",
            filePrefix: "Example",
            owner: "user",
            sourceId: "example",
        }],
        reader,
    });

    assert.equal(first.sha256, second.sha256);
});

test("detects transition metadata that does not match persisted Markdown", async () => {
    const snapshot = await compileLifecycleStateMachine({
        lifecycleName: "Example",
        initialState: "Initial",
        sources: [{
            sourceId: "example",
            owner: "user",
            filePrefix: "Example",
            resolvedCommit: "commit-one",
        }],
        reader: {
            async readStateMarkdown(_source, sourcePath) {
                return workflowFiles().get(sourcePath) ?? null;
            },
        },
    });
    const tampered = structuredClone(snapshot);
    tampered.states.Initial.outcomes = [];
    tampered.states.Initial.terminal = true;

    assert.throws(
        () => validateLifecycleStateMachineSnapshot(tampered),
        /transitions are invalid/,
    );
});
