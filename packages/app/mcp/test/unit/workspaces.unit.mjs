#!/usr/bin/env node
// Unit test: set_session_workspace answers every refusal in one JSON shape.
//
// A folder with ".." is refused by the tool's own check; an unknown root,
// a stale revision or a session with no turn yet is refused by the
// management client, which throws an error with a `code`. Both answers are
// { error, code, session_id, revision? } with isError set. A thrown error
// without a code keeps the standard "Error: ..." answer.
//
// No DB, no SDK client: `mgmt` is a fake. Run after `npm run build:mcp`.
import assert from "node:assert/strict";
import { registerWorkspaceTools } from "../../dist/src/tools/workspaces.js";

const SID = "a7f23cda-5cfd-4f0e-aff1-d6b0400b8da5";

function toolsWith(mgmt) {
    const handlers = new Map();
    const server = { registerTool: (name, _spec, handler) => { handlers.set(name, handler); } };
    registerWorkspaceTools(server, { mgmt });
    return handlers;
}

const fakeMgmt = (setSessionWorkspace) => ({
    getSessionWorkspace: async () => ({ workspace: { schema: 1, root: "a", folder: "repo-x" }, revision: 2 }),
    setSessionWorkspace,
});

const parse = (result) => {
    assert.equal(result.isError, true, "an error answer");
    const text = result.content[0].text;
    assert.ok(text.startsWith("{"), `a JSON answer, not plain text: ${text}`);
    return JSON.parse(text);
};

// 1. The management client refuses with a code.
{
    const set = toolsWith(fakeMgmt(async () => {
        throw Object.assign(new Error("WORKSPACE_ROOT_UNKNOWN: workspace root \"zz\" is not configured on this worker"), { code: "WORKSPACE_ROOT_UNKNOWN", status: 422, revision: 2 });
    })).get("set_session_workspace");
    const body = parse(await set({ session_id: SID, expected_revision: 2, root: "zz" }));
    assert.deepEqual(body, {
        error: "WORKSPACE_ROOT_UNKNOWN: workspace root \"zz\" is not configured on this worker",
        code: "WORKSPACE_ROOT_UNKNOWN",
        session_id: SID,
        revision: 2,
    });
}

// 2. The tool's own check refuses a folder with "..": the same shape.
{
    let called = false;
    const set = toolsWith(fakeMgmt(async () => { called = true; return {}; })).get("set_session_workspace");
    const body = parse(await set({ session_id: SID, expected_revision: 2, root: "a", folder: "../escape" }));
    assert.equal(called, false, "the check refuses before any change is sent");
    assert.equal(body.code, "WORKSPACE_PATH_INVALID");
    assert.match(body.error, /^WORKSPACE_PATH_INVALID: /);
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "revision", "session_id"], "the same keys as a thrown refusal");
    assert.equal(body.session_id, SID);
}

// 3. A session with no turn yet: the code and no revision.
{
    const set = toolsWith(fakeMgmt(async () => {
        throw Object.assign(new Error("WORKSPACE_SESSION_NOT_STARTED: the session has not run its first turn"), { code: "WORKSPACE_SESSION_NOT_STARTED", status: 409 });
    })).get("set_session_workspace");
    const body = parse(await set({ session_id: SID, expected_revision: 0, root: "a" }));
    assert.equal(body.code, "WORKSPACE_SESSION_NOT_STARTED");
    assert.equal("revision" in body, false);
}

// 4. A thrown error without a code keeps the standard answer.
{
    const set = toolsWith(fakeMgmt(async () => { throw new Error("connection reset"); })).get("set_session_workspace");
    const result = await set({ session_id: SID, expected_revision: 2, root: "a" });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Error: connection reset");
}

console.log("workspaces.unit: set_session_workspace errors share one shape — OK");
