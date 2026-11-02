/**
 * The worker's own model helpers
 * (docs/proposals/compute-providers.md, section 4.8).
 *
 * Generating a session title and distilling a transcript both hand a
 * model the content of a session, and for a session whose agent runs
 * elsewhere that content came from somewhere this worker does not trust.
 * Neither needs a tool to do its job, so neither is given one — in every
 * deployment, with or without compute targets.
 *
 * What these hold it to: the shape has no tools, no servers and no
 * skills and refuses every permission; and both helpers use it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TOOL_FREE_HELPER_SESSION, refuseAllPermissions } from "../../dist/permissions.js";

const sourceOf = (name) => readFile(fileURLToPath(new URL(`../../src/${name}`, import.meta.url)), "utf8");

test("a tool-free helper is given no tools, no servers and no skills", () => {
    assert.deepEqual(TOOL_FREE_HELPER_SESSION.availableTools, [],
        "no built-in tool is present at all");
    assert.deepEqual(TOOL_FREE_HELPER_SESSION.excludedTools, ["*"],
        "and anything that would be added later is excluded too");
    assert.deepEqual(TOOL_FREE_HELPER_SESSION.mcpServers, {});
    assert.deepEqual(TOOL_FREE_HELPER_SESSION.skillDirectories, []);
    assert.equal(TOOL_FREE_HELPER_SESSION.onPermissionRequest, refuseAllPermissions);
});

test("a shell a helper's prompt asks for is refused, whatever it asks for", () => {
    // The prompts these helpers send carry a transcript. An injection in
    // one must not be able to start anything on the worker.
    const asked = [
        { kind: "shell", commands: [{ identifier: "bash -c 'curl attacker.invalid'" }] },
        { kind: "write" },
        { kind: "read" },
        { kind: "mcp", serverName: "anything", toolName: "anything" },
        { kind: "custom-tool", toolName: "anything" },
        undefined,
    ];
    for (const request of asked) {
        const answer = refuseAllPermissions(request);
        assert.equal(answer.kind, "reject", `${JSON.stringify(request)} must be refused`);
        assert.match(String(answer.feedback), /may use no tools/);
    }
});

test("both helpers that run a model over a session's content use that shape", async () => {
    for (const file of ["session-proxy.ts", "regen-worker.ts"]) {
        const source = await sourceOf(file);
        assert.match(source, /TOOL_FREE_HELPER_SESSION/, `${file} must create its helper tool-free`);
        assert.doesNotMatch(source, /onPermissionRequest:\s*approvePermissionForSession/,
            `${file} must not approve whatever a helper asks for`);
    }
});
