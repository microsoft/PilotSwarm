import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    WORKFLOW_CANVAS_TOOLS, WORKFLOW_SCRIPT_CANVAS_TOOLS, admittedWorkflowToolGrant, allowedWorkflowTool, captureWorkflowTools,
    isWorkflowCanvasTool, isWorkflowControlTool, isWorkflowScriptRefusedCanvasTool, resolveWorkflowTool, validateWorkflowToolArguments,
    workflowCanvasToolMissingMessage, workflowScriptCanvasResult, workflowScriptCanvasToolMessage, workflowToolGrant,
    workflowToolGrantHashMatches,
} from "../../dist/workflow/tool-policy.js";
import * as policy from "../../dist/workflow/tool-policy.js";
import { WORKFLOW_SCRIPT_MUST_NAME_CANVAS } from "../../dist/canvas-support.js";
import { workflowToolResult } from "../../dist/workflow/tool-executor.js";
import { requireWorkflowToolRequirements, workflowToolDiagnostics } from "../../dist/workflow/tool-requirements.js";
import { ManagedSession } from "../../dist/managed-session.js";

const allowed = ["draw_canvas", "update_canvas", "show_canvas", "read_canvas", "canvas_kv"];
const refused = ["publish_canvas_app", "find_canvas_app"];
const metadata = name => ({ name, description: name, input_schema: { type: "object" } });
const M3 = 'A Workflow script must name a canvas: pass session_id "parent" (the agent that started this Workflow) or the session id of an agent above it.';
const M4 = name => `Canvas tool '${name}' cannot run in a Workflow script.`;
const M5 = name => `Canvas tool '${name}' is not available to this Workflow: the agent that starts it cannot use it.`;
/** Names a script might use for a canvas tool other than its bare system name: namespaced, MCP-style and dotted aliases. */
const namespacedForms = name => [`x/${name}`, `srv/${name}`, `canvas/${name}`, `functions.${name}`, `x.${name}`];

test("D2: seven canvas tools; scripts may call five of them", () => {
    assert.deepEqual([...WORKFLOW_CANVAS_TOOLS].sort(), [...allowed, ...refused].sort());
    assert.deepEqual([...WORKFLOW_SCRIPT_CANVAS_TOOLS].sort(), [...allowed].sort());
    for (const name of [...allowed, ...refused]) {
        assert.equal(isWorkflowCanvasTool(name), true, name);
        assert.equal(isWorkflowCanvasTool(`x/${name}`), true, `leaf of x/${name}`);
        assert.equal(isWorkflowControlTool(name), false, name);
    }
    for (const name of allowed) assert.equal(isWorkflowScriptRefusedCanvasTool(name), false, name);
    for (const name of refused) assert.equal(isWorkflowScriptRefusedCanvasTool(name), true, name);
    // Amendment 6: one rule. Every canvas name that is not exactly one of the five bare names is refused to a script.
    for (const name of [...allowed, ...refused]) {
        for (const form of namespacedForms(name)) assert.equal(isWorkflowScriptRefusedCanvasTool(form), true, form);
    }
    assert.equal(isWorkflowCanvasTool("read_facts"), false);
    for (const name of ["read_facts", "x/read_facts", "functions.read_facts", "draw_canvas_v2", "x/canvas"]) {
        assert.equal(isWorkflowScriptRefusedCanvasTool(name), false, name);
    }
    assert.equal(workflowScriptCanvasToolMessage("publish_canvas_app"), M4("publish_canvas_app"));
    assert.equal(workflowCanvasToolMissingMessage("draw_canvas"), M5("draw_canvas"));
});

test("Copilot 1.0.112 accepts only the measured 1.0.83 description-only tool schemas", () => {
    const evidence = JSON.parse(readFileSync(new URL(
        "../fixtures/copilot-native-tool-schema/1.0.83-to-1.0.112.json", import.meta.url,
    ), "utf8"));
    const withoutDescriptions = value => Array.isArray(value) ? value.map(withoutDescriptions) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description")
            .map(([key, child]) => [key, withoutDescriptions(child)])) : value;
    assert.equal(evidence.oldRuntime, "1.0.83");
    assert.equal(evidence.newRuntime, "1.0.112");
    assert.equal(evidence.changedCount, 7);
    assert.equal(evidence.changed.length, 7);
    for (const item of evidence.changed) {
        const oldTool = { name: item.name, input_schema: item.old };
        const newTool = { name: item.name, input_schema: item.new };
        const grant = workflowToolGrant(oldTool);
        assert.equal(grant.schemaHash, item.oldHash, `${item.name} old metadata`);
        assert.equal(workflowToolGrant(newTool).schemaHash, item.newHash, `${item.name} new metadata`);
        assert.deepEqual(withoutDescriptions(item.old), withoutDescriptions(item.new), `${item.name} description-only change`);
        assert.equal(workflowToolGrantHashMatches(grant, item.newHash), true, item.name);
        if (allowedWorkflowTool(newTool)) {
            assert.equal(resolveWorkflowTool(item.name, [grant], [newTool]), newTool,
                `${item.name} old grant resolves on the new runtime`);
        } else {
            assert.throws(() => resolveWorkflowTool(item.name, [grant], [newTool]), /not permitted/,
                `${item.name} remains a refused Workflow control tool`);
        }
        assert.equal(workflowToolGrantHashMatches({ ...grant, schemaHash: item.newHash }, item.oldHash), false, `${item.name} reverse transition`);
        assert.equal(workflowToolGrantHashMatches(grant, `${item.newHash}0`), false, `${item.name} structural change`);
    }
    const first = evidence.changed[0];
    assert.equal(workflowToolGrantHashMatches({ name: first.name, schemaHash: first.oldHash, mcpServerName: "x" }, first.newHash),
        false, "MCP tools do not receive native runtime migration aliases");
    assert.equal(workflowToolGrantHashMatches({ name: "custom", schemaHash: "same" }, "same"), true, "unchanged custom tool");
});

test("D4: the old live-session predicate and message are gone", () => {
    assert.deepEqual(Object.keys(policy).filter(name => /LiveSession/.test(name)), []);
});

test("D2: the five script canvas tools are captured as bare system tools; the two refused ones are not", () => {
    const tools = [...allowed, ...refused].map(metadata).concat([metadata("read_facts")]);
    assert.deepEqual(captureWorkflowTools(tools).map(tool => tool.name), [...allowed, "read_facts"]);
    for (const name of allowed) assert.equal(allowedWorkflowTool(metadata(name)), true, name);
    for (const name of refused) assert.equal(allowedWorkflowTool(metadata(name)), false, name);
});

test("D2: an MCP or package tool named like a canvas tool is never admitted", () => {
    for (const name of [...allowed, ...refused]) {
        for (const tool of [
            { ...metadata(name), mcpServerName: "x", mcpToolName: name },
            metadata(`x/${name}`),
            { ...metadata(`functions.${name}`), namespacedName: `functions.${name}` },
            { ...metadata(name), namespacedName: `x/${name}` },
            { ...metadata(`mcp_${name}`), mcpServerName: "canvas", mcpToolName: name },
            { ...metadata("alias"), namespacedName: `canvas/${name}` },
        ]) {
            assert.equal(allowedWorkflowTool(tool), false, JSON.stringify(tool));
            assert.deepEqual(captureWorkflowTools([tool]), [], JSON.stringify(tool));
        }
    }
});

test("Review focus 5: a starter holding both a bare and an MCP draw_canvas captures only the bare one, and a script's call resolves to it", () => {
    const bare = metadata("draw_canvas");
    const mcp = { ...metadata("draw_canvas"), namespacedName: "x/draw_canvas", mcpServerName: "x", mcpToolName: "draw_canvas",
        input_schema: { type: "object", properties: { other: { type: "string" } } } };
    const grants = captureWorkflowTools([bare, mcp]);
    assert.deepEqual(grants, [workflowToolGrant(bare)]);
    assert.equal(resolveWorkflowTool("draw_canvas", grants, [bare, mcp]), bare);
    assert.throws(() => resolveWorkflowTool("x/draw_canvas", grants, [bare, mcp]), { message: M4("x/draw_canvas") });
    // An old stored grant that holds the MCP tool still never resolves to it.
    const stale = [workflowToolGrant(mcp)];
    assert.throws(() => resolveWorkflowTool("draw_canvas", stale, [bare, mcp]), /not uniquely admitted/);
    assert.throws(() => resolveWorkflowTool("x/draw_canvas", stale, [bare, mcp]), { message: M4("x/draw_canvas") });
    assert.throws(() => admittedWorkflowToolGrant("x/draw_canvas", stale), { message: M4("x/draw_canvas") });
});

test("Amendment 6: a namespaced canvas name, and bare publish_canvas_app and find_canvas_app, get M4 at Start, at live resolution and at admission, whatever the grant holds", () => {
    const source = form => `await callTool(${JSON.stringify(form)}, { session_id: "parent", html: "x" });`;
    const ir = text => ({ nodes: { poll: { id: "poll", type: "script", source: text } } });
    // Every refused form: the namespaced forms of all seven canvas names, and the two refused bare names themselves.
    const refusals = [...allowed, ...refused].flatMap(name => namespacedForms(name).map(form => ({ name, form })))
        .concat(refused.map(name => ({ name, form: name })));
    assert.equal(refusals.length, 37);
    for (const { name, form } of refusals) {
        const bare = metadata(name);
        const namespaced = form === name ? `x/${name}` : form;
        const mcp = { ...metadata(name), namespacedName: namespaced, mcpServerName: namespaced.split(/[/.]/)[0], mcpToolName: name };
        const plain = metadata(namespaced);
        const offered = [bare, mcp, plain];
        // No grant, today's capture (the bare tool only, or nothing for a refused name), and an old stored grant that holds
        // the namespaced tools (and, for a refused bare name, the bare tool itself).
        const stale = [workflowToolGrant(mcp), workflowToolGrant(plain), ...(form === name ? [workflowToolGrant(bare)] : [])];
        for (const grants of [[], captureWorkflowTools(offered), stale, [...captureWorkflowTools(offered), ...stale]]) {
            const label = `${form} with ${JSON.stringify(grants.map(grant => grant.namespacedName ?? grant.name))}`;
            assert.throws(() => resolveWorkflowTool(form, grants, offered), { message: M4(form) }, label);
            assert.throws(() => resolveWorkflowTool(form, grants, offered, [form]), { message: M4(form) }, `${label}, excluded`);
            assert.throws(() => admittedWorkflowToolGrant(form, grants), { message: M4(form) }, label);
            assert.throws(() => admittedWorkflowToolGrant(form, grants, [form]), { message: M4(form) }, `${label}, excluded`);
        }
        for (const binding of [null, { tools: stale, excludedTools: [] }, { tools: captureWorkflowTools(offered), excludedTools: [] }]) {
            const label = `Start ${form} with ${binding ? JSON.stringify(binding.tools.map(grant => grant.namespacedName ?? grant.name)) : "no grant"}`;
            assert.deepEqual(workflowToolDiagnostics(ir(source(form)), binding).map(({ code, message }) => ({ code, message })),
                [{ code: "WORKFLOW_TOOL_LIVE_SESSION", message: M4(form) }], label);
            assert.throws(() => requireWorkflowToolRequirements(ir(source(form)), binding, "board-sync"), error => {
                assert.equal(error.code, "WORKFLOW_TOOLS_UNAVAILABLE", label);
                assert.equal(error.message, `board-sync was not started: states.poll.source: ${M4(form)} Nothing was started.`, label);
                assert.deepEqual(error.details.diagnostics.map(item => item.code), ["WORKFLOW_TOOL_LIVE_SESSION"], label);
                return true;
            }, label);
        }
    }
    // The five bare names keep working: captured, admitted, resolved and started; M5 when the starter cannot use one.
    for (const name of allowed) {
        const grants = captureWorkflowTools([metadata(name)]);
        assert.equal(resolveWorkflowTool(name, grants, [metadata(name)]).name, name);
        assert.deepEqual(admittedWorkflowToolGrant(name, grants), grants[0]);
        assert.deepEqual(workflowToolDiagnostics(ir(source(name)), { tools: grants, excludedTools: [] }), []);
        assert.deepEqual(requireWorkflowToolRequirements(ir(source(name)), { tools: grants, excludedTools: [] }, "board-sync"), []);
        assert.deepEqual(workflowToolDiagnostics(ir(source(name)), { tools: [], excludedTools: [] }).map(({ code, message }) => ({ code, message })),
            [{ code: "WORKFLOW_TOOL_NOT_GRANTED", message: M5(name) }]);
    }
});

test("D4: a script call of publish_canvas_app or find_canvas_app is refused with M4, even with an old grant", () => {
    for (const name of refused) {
        const grant = workflowToolGrant(metadata(name));
        assert.throws(() => resolveWorkflowTool(name, [grant], [metadata(name)]), { message: M4(name) });
        assert.throws(() => admittedWorkflowToolGrant(name, [grant]), { message: M4(name) });
        assert.throws(() => admittedWorkflowToolGrant(name, []), { message: M4(name) });
    }
    for (const name of allowed) {
        const grant = workflowToolGrant(metadata(name));
        assert.equal(resolveWorkflowTool(name, [grant], [metadata(name)]).name, name);
        assert.deepEqual(admittedWorkflowToolGrant(name, [grant]), grant);
        assert.throws(() => admittedWorkflowToolGrant(name, []), /not uniquely admitted/);
    }
});

test("D8: script canvas arguments name a canvas and, when given, a slot 1-10", () => {
    assert.equal(WORKFLOW_SCRIPT_MUST_NAME_CANVAS, M3);
    for (const name of allowed) {
        for (const args of [{}, { data: {} }, { session_id: "" }, { session_id: "   " }, { session_id: 7 }, { session_id: null }]) {
            assert.throws(() => validateWorkflowToolArguments(name, args), { message: M3 }, `${name} ${JSON.stringify(args)}`);
        }
        for (const slot of [0, 11, 1.5, "eleven", -1]) {
            assert.throws(() => validateWorkflowToolArguments(name, { session_id: "parent", slot }),
                { message: "slot must be an integer 1-10" }, `${name} slot ${JSON.stringify(slot)}`);
        }
        for (const args of [{ session_id: "parent" }, { session_id: "parent", slot: 10 }, { session_id: "parent", slot: 1 }]) {
            assert.doesNotThrow(() => validateWorkflowToolArguments(name, args), `${name} ${JSON.stringify(args)}`);
        }
    }
    assert.throws(() => validateWorkflowToolArguments("update_canvas", { data: {} }), { message: M3 });
    assert.throws(() => validateWorkflowToolArguments("update_canvas", { session_id: "parent", slot: 11 }), /slot must be an integer 1-10/);
    assert.doesNotThrow(() => validateWorkflowToolArguments("update_canvas", { session_id: "parent", data: {} }));
    assert.doesNotThrow(() => validateWorkflowToolArguments("bash", { session_id: "" }));
    assert.doesNotThrow(() => validateWorkflowToolArguments("read_facts", { slot: 11 }));
});

test("D3: a script gets a canvas tool's JSON object text as the object; other text and other tools are unchanged", () => {
    const drawn = workflowScriptCanvasResult("draw_canvas", '{"drawn":true,"slot":7}');
    assert.equal(drawn.resultType, "success");
    assert.equal(drawn.textResultForLlm, '{"drawn":true,"slot":7}');
    assert.deepEqual(drawn.structuredContent, { drawn: true, slot: 7 });
    assert.deepEqual(workflowToolResult(drawn), { drawn: true, slot: 7 });
    for (const name of allowed) {
        assert.deepEqual(workflowScriptCanvasResult(name, '{"a":{"b":[1]}}').structuredContent, { a: { b: [1] } }, name);
    }
    const none = "No canvas has been drawn on this session yet.";
    assert.equal(workflowScriptCanvasResult("read_canvas", none), none);
    assert.equal(workflowScriptCanvasResult("list_sessions", '{"count":2}'), '{"count":2}');
    for (const name of refused) assert.equal(workflowScriptCanvasResult(name, '{"count":2}'), '{"count":2}', name);
    for (const text of ["[1,2]", "null", "42", '"text"', "{not json", ""]) {
        assert.equal(workflowScriptCanvasResult("canvas_kv", text), text, text);
    }
    const object = { count: 2 };
    assert.equal(workflowScriptCanvasResult("canvas_kv", object), object);
    const failure = { textResultForLlm: "Tool failed: Could not draw the canvas: SHA_MISMATCH: no", resultType: "failure",
        error: "Could not draw the canvas: SHA_MISMATCH: no", toolTelemetry: {} };
    assert.equal(workflowScriptCanvasResult("draw_canvas", failure), failure);
    const uncoded = { textResultForLlm: "Tool failed: canvas_kv get failed: key is required", resultType: "failure",
        error: "canvas_kv get failed: key is required", toolTelemetry: {} };
    assert.equal(workflowScriptCanvasResult("canvas_kv", uncoded), uncoded);
});

test("Review focus 4: a script's canvas_kv write that the store refuses with a code rejects with a message that starts with the code", () => {
    for (const op of ["put", "delete"]) {
        const message = `canvas_kv ${op} failed: CONFLICT: rev mismatch (current 1)`;
        const failure = { textResultForLlm: `Tool failed: ${message}`, resultType: "failure", error: message, toolTelemetry: {} };
        const shaped = workflowScriptCanvasResult("canvas_kv", failure);
        assert.equal(shaped.resultType, "failure");
        assert.equal(shaped.error, "CONFLICT: rev mismatch (current 1)");
        assert.equal(shaped.textResultForLlm, "CONFLICT: rev mismatch (current 1)");
        assert.throws(() => workflowToolResult(shaped), { message: "CONFLICT: rev mismatch (current 1)" });
        // The same failure from a tool that is not a script canvas tool is unchanged.
        assert.equal(workflowScriptCanvasResult("publish_canvas_app", failure), failure);
    }
    // A failure carried only as text (no error field) is shaped the same way.
    const textOnly = workflowScriptCanvasResult("canvas_kv", { textResultForLlm: "Tool failed: canvas_kv put failed: QUOTA: full", resultType: "failure" });
    assert.throws(() => workflowToolResult(textOnly), { message: "QUOTA: full" });
});

test("D3: prepareWorkflowTools gives a script's canvas bridge to the five canvas handlers only", async () => {
    const prepare = async (opts) => {
        const registered = new Map();
        const session = { registerTools: tools => { for (const tool of tools) registered.set(tool.name, tool); },
            rpc: { tools: { initializeAndValidate: async () => {} } } };
        const managed = new ManagedSession("workflow-fixture", session, {});
        await managed.prepareWorkflowTools(new Set([...allowed, ...refused, "check_agents"]), new Map(), opts);
        return name => registered.get(name).handler;
    };
    const calls = [];
    const bridge = {
        drawCanvas: async args => { calls.push(["drawCanvas", args]); return { rev: 1, slot: args.slot ?? 1, sizeBytes: 8 }; },
        updateCanvas: async args => { calls.push(["updateCanvas", args]); return { dataRev: 1, slot: 7, sizeBytes: 7, mode: "data" }; },
        showCanvas: async args => { calls.push(["showCanvas", args]); return { presented: true, slot: 7, rev: 1 }; },
        readCanvas: async args => { calls.push(["readCanvas", args]); return { exists: false }; },
        canvasKv: async args => { calls.push(["canvasKv", args]); return { error: "CONFLICT: rev mismatch (current 1)", key: args.key, rev: 1 }; },
        publishCanvasApp: async args => { calls.push(["publishCanvasApp", args]); return { published: true }; },
        findCanvasApp: async () => { calls.push(["findCanvasApp"]); return { count: 1, apps: [] }; },
    };
    const handler = await prepare({ controlToolBridge: bridge });
    const drawn = workflowToolResult(await handler("draw_canvas")({ session_id: "parent", slot: 7, html: "<p>x</p>" }, {}));
    assert.equal(drawn.drawn, true);
    assert.equal(drawn.slot, 7);
    const ticked = workflowToolResult(await handler("update_canvas")({ session_id: "parent", slot: 7, data: { n: 1 } }, {}));
    assert.equal(ticked.updated, true);
    assert.equal(ticked.dataRev, 1);
    assert.deepEqual(workflowToolResult(await handler("show_canvas")({ session_id: "parent", slot: 7 }, {})).presented, true);
    assert.equal(workflowToolResult(await handler("read_canvas")({ session_id: "parent" }, {})), "No canvas has been drawn on this session yet.");
    const conflict = await handler("canvas_kv")({ session_id: "parent", op: "put", key: "app/progress", value: 1, ifMatch: 0 }, {});
    assert.throws(() => workflowToolResult(conflict), { message: "CONFLICT: rev mismatch (current 1)" });
    // publish_canvas_app and find_canvas_app never get the bridge (policy refuses them to scripts before any handler).
    for (const name of refused) {
        const result = await handler(name)({ query: "x", name: "x" }, {});
        assert.equal(result.resultType, "failure", name);
        assert.match(result.error, /the canvas bridge is unavailable on this session/, name);
    }
    assert.deepEqual(calls.map(([method]) => method), ["drawCanvas", "updateCanvas", "showCanvas", "readCanvas", "canvasKv"]);
    assert.deepEqual([calls[0][1].session_id, calls[0][1].slot, calls[0][1].html], ["parent", 7, "<p>x</p>"]);
    // Other handlers behave as they do with no bridge: check_agents still asks for a turn, which a script cannot have.
    await assert.rejects(handler("check_agents")({}, {}), /Workflow tool 'check_agents' attempted conversational control/);

    // No bridge: the canvas handlers refuse, as before.
    const bare = await prepare(undefined);
    const refusal = await bare("draw_canvas")({ session_id: "parent", html: "<p>x</p>" }, {});
    assert.equal(refusal.resultType, "failure");
    assert.match(refusal.error, /the canvas bridge is unavailable on this session/);
    await assert.rejects(bare("check_agents")({}, {}), /Workflow tool 'check_agents' attempted conversational control/);
});
