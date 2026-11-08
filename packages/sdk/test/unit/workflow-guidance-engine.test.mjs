/**
 * AOS-F1 (always-on review of 6290e66f..f2e793ca, high): with Workflows always on, every session's base instructions carry the
 * Workflow guidance, but only a workflow request turn's host runs the full engine (session-proxy.ts gives it requests: true;
 * compileWorkflowV2ForHost). Every other host, so every default deployment, compiles script, wait, messaging (receive and send)
 * and terminal states only, and refuses agent and parallel states (WORKFLOW_NODE_TYPE_UNSUPPORTED) and request states
 * (WORKFLOW_FEATURE_UNSUPPORTED). The guidance now follows the session's actual engine:
 * a) a default worker with scripts off and no request turn: its system prompt recommends no agent, parallel or request state,
 *    no For each, no agent model choice, and no tool it is not declared (respond_session_request, complete_workflow_node);
 * b) every Workflow example and every state type that prompt recommends compiles on the default host, with the real compiler;
 * c) a request turn (the isolated full engine) keeps the full text, and what it recommends compiles on its host.
 * (a) and (b) fail at f2e793ca, whose default prompt teaches agent and parallel states and the request answer.
 *
 * Run: node --test test/unit/workflow-guidance-engine.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../dist/session-manager.js";
import { compileWorkflowV2ForHost } from "../../dist/workflow/v2/service.js";
import { workflowSessionGuidance, WORKFLOW_SESSION_GUIDANCE } from "../../dist/workflow/guidance.js";
import { workflowTestModeFromEnv } from "../../dist/workflow/v2/test-mode-switch.js";

const DEFAULT_HOST = { requests: undefined };
const FULL_HOST = { requests: true };

/** The whole system prompt a session manager builds for one session, as text. */
function systemPrompt({ scripts, requestTurn }) {
    const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base." });
    manager.workflowScriptsEnabled = scripts;
    const message = manager._buildSystemMessage("s-engine", {
        baseAgentPolicy: { version: "v2", fingerprint: "test", revision: null }, ...(requestTurn ? { workflowMilestoneTurn: true } : {}) });
    const texts = [];
    const collect = value => {
        if (typeof value === "string") texts.push(value);
        else if (value && typeof value === "object") for (const item of Object.values(value)) collect(item);
    };
    collect(message);
    return texts.join("\n");
}

/** The prompt's Workflow block: from its heading to the next top-level heading, or the end. */
function workflowBlock(prompt) {
    const start = prompt.indexOf("## Workflow Sessions");
    assert.ok(start >= 0, "the prompt carries the Workflow guidance");
    const rest = prompt.slice(start);
    const end = rest.slice(3).search(/\n#{1,2} /);
    return end < 0 ? rest : rest.slice(0, end + 3);
}

/** What only the full engine runs, as the guidance would teach it. */
const FULL_ENGINE_TEACHING = [
    /agent (node|state|step)s?\b/i, /agent and parallel/i, /parallel (state|node)s?\b/i, /`branches`/, /named branches/i,
    /request (state|step)s?\b/i, /`request`/, /mode: request/, /type: (agent|parallel)/, /respond_session_request/, /complete_workflow_node/,
    /agent_models/, /chat: (new|continue)/, /For each/i, /`joined`/,
];

const definition = (states, extra = {}) => JSON.stringify({
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "guidance-example", version: "1.0.0" },
    initial: Object.keys(states)[0], ...extra,
    states: { ...states, done: { type: "terminal", outcome: "succeeded" }, failed: { type: "terminal", outcome: "failed" } },
}, null, 2);

/** A canonical minimal definition for each state type the guidance can recommend, and how its words name it. */
const STATE_TYPES = {
    script: {
        named: /\bscripts?\b/i,
        yaml: definition({ work: { type: "script", outcomes: ["done"], source: "await setResult(\"done\", context.input);\n",
            transition: { next: { done: "done", failure: "failed" } } } }),
    },
    wait: { named: /wait state/i, yaml: definition({ pause: { type: "wait", seconds: 60, transition: { next: { elapsed: "done" } } } }) },
    send: {
        named: /\bsend\b/i,
        yaml: definition({ tell: { type: "messaging", mode: "send", contract: "Note@1", recipient: { parent: true }, input: { text: "checked" },
            transition: { next: { sent: "done", failure: "failed" } } } }, { contracts: { "Note@1": { schema: { type: "object" } } } }),
    },
    receive: {
        named: /\breceive\b/i,
        yaml: definition({ hear: { type: "messaging", mode: "receive", contract: "Go@1", wait: { seconds: 60 },
            transition: { next: { received: "done", elapsed: "done", failure: "failed" } } } }, { contracts: { "Go@1": { schema: { type: "object" } } } }),
    },
    request: {
        named: /`request`|respond_session_request|request (state|step)s?\b|mode: request/i,
        yaml: definition({ ask: { type: "messaging", mode: "request", recipient: { parent: true }, contract: "Ask@1", input: { q: "post it?" },
            timeoutSeconds: 3600, transition: { next: { responded: "done", declined: "failed", timed_out: "failed", failure: "failed" } } } },
        { contracts: { "Ask@1": { schema: { type: "object" }, response: { schema: { type: "object" } } } } }),
    },
    agent: {
        named: /agent (node|state|step)s?\b|agent and parallel/i,
        yaml: definition({ judge: { type: "agent", invoke: { prompt: "Decide whether it changed." }, outcomes: ["done"], timeoutSeconds: 600,
            transition: { next: { done: "done", failure: "failed" } } } }),
    },
    parallel: {
        named: /parallel (state|node)s?\b|`branches`|named branches/i,
        yaml: definition({ views: { type: "parallel", branches: {
            quick: { initial: "quick_end", states: { quick_end: { type: "terminal", outcome: "succeeded" } } },
            careful: { initial: "careful_end", states: { careful_end: { type: "terminal", outcome: "succeeded" } } },
        }, transition: { next: { joined: "done", blocked: "failed", failure: "failed" } } } }),
    },
    clock: {
        named: /`at`|clock time/i,
        yaml: definition({ pause: { type: "wait", at: { minute: 0, hour: 9, tz: "UTC" }, transition: { next: { elapsed: "done" } } } }),
    },
};

/** Each inline state example in the text (`<id>: { type: <type>, … }`), wrapped as a whole definition whose routes end it. */
function inlineExamples(text) {
    const examples = [];
    for (const match of text.matchAll(/`(\w+): (\{ type: \w+[^`]*\})`/g)) {
        const [, id, body] = match;
        const targets = new Set();
        for (const next of body.matchAll(/next: \{([^}]*)\}/g)) {
            for (const route of next[1].split(",")) {
                const target = route.split(":")[1]?.trim();
                if (target && target !== id) targets.add(target);
            }
        }
        const yaml = ["apiVersion: pilotswarm.dev/v2-draft", "kind: Workflow", "metadata: { name: guidance-inline, version: \"1.0.0\" }",
            `initial: ${id}`, "states:", `  ${id}: ${body}`, ...[...targets].map(target => `  ${target}: { type: terminal, outcome: succeeded }`)].join("\n");
        examples.push({ example: match[0], yaml });
    }
    return examples;
}

const compileErrors = (host, yaml) => compileWorkflowV2ForHost(host, yaml).diagnostics.filter(item => item.severity === "error");

test("the canonical examples are real: each compiles on the full engine's host; agent, parallel, request and clock waits only there", () => {
    for (const [type, { yaml }] of Object.entries(STATE_TYPES)) {
        assert.deepEqual(compileErrors(FULL_HOST, yaml), [], `${type} on the full engine`);
        const onDefault = compileErrors(DEFAULT_HOST, yaml);
        assert.equal(onDefault.length > 0, ["request", "agent", "parallel", "clock"].includes(type), `${type} on the default host: ${JSON.stringify(onDefault)}`);
    }
});

test("AOS-F1 (a): a default worker (scripts off, no request turn) is taught no agent, parallel or request state, and no tool it lacks", () => {
    const prompt = systemPrompt({ scripts: false, requestTurn: false });
    for (const pattern of FULL_ENGINE_TEACHING) assert.doesNotMatch(prompt, pattern);
    const block = workflowBlock(prompt);
    assert.doesNotMatch(block, /\bparallel\b/i, "the Workflow block names no parallel work");
    // It still teaches what this engine runs, and says scripts are off in words that name only those states.
    assert.match(block, /runs script, wait, messaging \(receive and send\) and terminal states only/);
    assert.match(block, /Script nodes are turned off on this server \(PILOTSWARM_WORKFLOW_SCRIPTS\)[^\n]*can only wait and send or receive messages/);
    assert.doesNotMatch(block, /Use wait, messaging, agent and parallel nodes instead/);
});

test("AOS-F1 (b): every Workflow example and state type the default worker's prompt recommends compiles on its host", () => {
    for (const scripts of [false, true]) {
        const block = workflowBlock(systemPrompt({ scripts, requestTurn: false }));
        const recommended = Object.entries(STATE_TYPES).filter(([, { named }]) => named.test(block));
        assert.ok(recommended.some(([type]) => type === "wait"), "it teaches the wait state");
        for (const [type, { yaml }] of recommended) {
            assert.deepEqual(compileErrors(DEFAULT_HOST, yaml), [], `scripts ${scripts}: the prompt names ${type}, which this host must run`);
        }
        const inline = inlineExamples(block);
        assert.ok(inline.length >= 1, "the wait example is there");
        for (const { example, yaml } of inline) assert.deepEqual(compileErrors(DEFAULT_HOST, yaml), [], `scripts ${scripts}: ${example}`);
    }
});

test("AOS-F1 (c): a request turn (the isolated full engine) keeps the full text, and what it teaches compiles on its host", () => {
    const testMode = workflowTestModeFromEnv();
    for (const scripts of [false, true]) {
        const prompt = systemPrompt({ scripts, requestTurn: true });
        const full = workflowSessionGuidance(testMode, { scripts, clockWaits: true, tests: true, fullEngine: true });
        assert.ok(prompt.includes(full), `scripts ${scripts}: the full-engine guidance`);
        const block = workflowBlock(prompt);
        for (const phrase of ["An agent node has two chat modes.", "a parallel state with named `branches`", "`agent_models`",
            "answer it once with `respond_session_request`", "Testing is optional."]) {
            assert.ok(block.includes(phrase), `scripts ${scripts}: ${phrase}`);
        }
        if (!scripts) assert.match(block, /Use wait, messaging, agent and parallel nodes instead/);
        for (const [type, { named, yaml }] of Object.entries(STATE_TYPES)) {
            if (named.test(block)) assert.deepEqual(compileErrors(FULL_HOST, yaml), [], `scripts ${scripts}: ${type}`);
        }
        for (const { example, yaml } of inlineExamples(block)) assert.deepEqual(compileErrors(FULL_HOST, yaml), [], example);
    }
    // Test mode on gives the full text exactly; the basic text is the full one less what only the full engine runs.
    assert.equal(workflowSessionGuidance(true, { fullEngine: true }), WORKFLOW_SESSION_GUIDANCE);
    assert.ok(workflowSessionGuidance(true).length < WORKFLOW_SESSION_GUIDANCE.length);
});

test("AOS-F1: the default text is the full one less the full-engine paragraphs; no option turns the engine on", () => {
    const basic = workflowSessionGuidance(false, { scripts: true });
    for (const kept of ["Your Workflow Definitions belong to this chat.", "To wait, use a wait state:", "For recurring or polling work",
        "Choose `notify_on_completion` on each `start` deliberately", "### Messages from workflow children", "- `ended`: the run ended",
        "- `message`: a send step's typed message.", "A person's \"Ask the parent agent\" note"]) {
        assert.ok(basic.includes(kept), kept);
    }
    assert.ok(!/\n{3}/.test(basic), "no paragraph gap is left where a full-engine paragraph was");
    // Neither tests nor a clock wait make a default session's text the full engine's.
    assert.equal(workflowSessionGuidance(false, { scripts: true, tests: true }), basic);
    const testModeOn = workflowSessionGuidance(true, { scripts: false, tests: true });
    for (const pattern of FULL_ENGINE_TEACHING) assert.doesNotMatch(testModeOn, pattern);
    assert.doesNotMatch(testModeOn, /test_waiting|test_respond/, "no test run reaches a basic-engine session, so no held-call notice");
});
