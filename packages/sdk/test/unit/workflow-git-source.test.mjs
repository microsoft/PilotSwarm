import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    parseAllowlistEntry,
} from "../../dist/agent-package-import-policy.js";
import {
    resolveWorkflowGitPackage,
} from "../../dist/workflow-orchestration/git-source.js";

const policy = {
    entries: [parseAllowlistEntry("https://example.test/workflows/")],
    mode: "replace",
    configPath: null,
};

test("resolves a Git workflow source to an immutable commit and package directory", async () => {
    const commands = [];
    const resolved = await resolveWorkflowGitPackage(
        {
            kind: "git",
            repositoryUrl: "https://example.test/workflows/repository.git",
            gitRef: "refs/heads/main",
            workflowPath: "delivery/workflow.yaml",
        },
        policy,
        {
            resolveHost: async hostname => {
                assert.equal(hostname, "example.test");
            },
            runGit: async (cwd, _hooksDirectory, args) => {
                commands.push(args);
                if (args[0] === "rev-parse") return "a".repeat(40);
                if (args[0] === "checkout") {
                    await mkdir(path.join(cwd, "delivery"), { recursive: true });
                    await writeFile(
                        path.join(cwd, "delivery", "workflow.yaml"),
                        "apiVersion: pilotswarm.dev/v1alpha1\n",
                    );
                }
                return "";
            },
        },
    );

    try {
        assert.equal(resolved.source.commitSha, "a".repeat(40));
        assert.equal(resolved.source.gitRef, "refs/heads/main");
        assert.equal(resolved.source.workflowPath, "delivery/workflow.yaml");
        assert.equal(resolved.workflowYaml, "apiVersion: pilotswarm.dev/v1alpha1\n");
        assert.equal(path.basename(resolved.packageRoot), "delivery");
        assert.ok(commands.some(args => args[0] === "fetch"));
        assert.ok(commands.some(args => args[0] === "checkout"));
    } finally {
        await resolved.cleanup();
    }
});

test("rejects disallowed repositories, option-like refs, and path traversal", async () => {
    await assert.rejects(
        () => resolveWorkflowGitPackage(
            {
                kind: "git",
                repositoryUrl: "https://other.test/repository.git",
                gitRef: "main",
                workflowPath: "workflow.yaml",
            },
            policy,
            { resolveHost: async () => undefined },
        ),
        error => error?.code === "WORKFLOW_GIT_REPOSITORY_REFUSED",
    );
    await assert.rejects(
        () => resolveWorkflowGitPackage(
            {
                kind: "git",
                repositoryUrl: "https://example.test/workflows/repository.git",
                gitRef: "--upload-pack=evil",
                workflowPath: "workflow.yaml",
            },
            policy,
            { resolveHost: async () => undefined },
        ),
        error => error?.code === "WORKFLOW_GIT_REF_INVALID",
    );
    await assert.rejects(
        () => resolveWorkflowGitPackage(
            {
                kind: "git",
                repositoryUrl: "https://example.test/workflows/repository.git",
                gitRef: "main:refs/heads/injected",
                workflowPath: "workflow.yaml",
            },
            policy,
            { resolveHost: async () => undefined },
        ),
        error => error?.code === "WORKFLOW_GIT_REF_INVALID",
    );
    await assert.rejects(
        () => resolveWorkflowGitPackage(
            {
                kind: "git",
                repositoryUrl: "https://example.test/workflows/repository.git",
                gitRef: "main",
                workflowPath: "../workflow.yaml",
            },
            policy,
            { resolveHost: async () => undefined },
        ),
        error => error?.code === "WORKFLOW_GIT_PATH_INVALID",
    );
    await assert.rejects(
        () => resolveWorkflowGitPackage(
            {
                kind: "git",
                repositoryUrl: "https://example.test/workflows/repository.git?token=secret",
                gitRef: "main",
                workflowPath: "workflow.yaml",
            },
            policy,
            { resolveHost: async () => undefined },
        ),
        error => error?.code === "WORKFLOW_GIT_REPOSITORY_REFUSED",
    );
});
