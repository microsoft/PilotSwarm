import test from "node:test";
import assert from "node:assert/strict";
import {
    parseWorkflowArgs,
    runWorkflowsCommand,
} from "../src/workflows-cli.js";

test("workflow CLI parses Git source and ownership scope", () => {
    assert.deepEqual(parseWorkflowArgs([
        "register",
        "--repo", "https://git.example.test/workflows.git",
        "--ref", "refs/heads/main",
        "--path", "workflows/change.yaml",
        "--shared",
        "--json",
    ]), {
        flags: {
            repositoryUrl: "https://git.example.test/workflows.git",
            gitRef: "refs/heads/main",
            workflowPath: "workflows/change.yaml",
            scope: "shared",
            json: true,
        },
        positional: ["register"],
    });
});

test("workflow CLI registers through the management client", async () => {
    const calls = [];
    const output = [];
    const originalLog = console.log;
    console.log = value => output.push(value);
    try {
        const exitCode = await runWorkflowsCommand([
            "register",
            "--repo", "https://git.example.test/workflows.git",
            "--ref", "refs/tags/v1",
            "--path", "workflow.yaml",
            "--shared",
            "--json",
        ], {
            makeContext: async () => ({
                mode: "web",
                client: {
                    async registerWorkflowDefinition(request, options) {
                        calls.push({ request, options });
                        return {
                            definitionId: "definition-1",
                            graphId: "change@1.0.0",
                            scope: "shared",
                        };
                    },
                },
                close: async () => calls.push({ closed: true }),
            }),
        });
        assert.equal(exitCode, 0);
    } finally {
        console.log = originalLog;
    }
    assert.deepEqual(calls, [
        {
            request: {
                scope: "shared",
                source: {
                    kind: "git",
                    repositoryUrl: "https://git.example.test/workflows.git",
                    gitRef: "refs/tags/v1",
                    workflowPath: "workflow.yaml",
                },
            },
            options: {
                scope: "shared",
                owner: null,
                isAdmin: false,
                createdBy: null,
            },
        },
        { closed: true },
    ]);
    assert.match(output[0], /"definitionId": "definition-1"/);
});

test("workflow CLI lists and shows visible definitions", async () => {
    const calls = [];
    const context = async () => ({
        mode: "web",
        client: {
            async listWorkflowDefinitions() {
                calls.push("list");
                return [];
            },
            async getWorkflowDefinition(definitionId) {
                calls.push(["show", definitionId]);
                return {
                    definitionId,
                    graphId: "change@1.0.0",
                    scope: "user",
                    packageSource: { kind: "git" },
                };
            },
        },
        close: async () => {},
    });
    assert.equal(await runWorkflowsCommand(["list"], { makeContext: context }), 0);
    assert.equal(
        await runWorkflowsCommand(["show", "definition-1"], { makeContext: context }),
        0,
    );
    assert.deepEqual(calls, ["list", ["show", "definition-1"]]);
});
