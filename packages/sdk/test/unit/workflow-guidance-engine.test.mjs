/**
 * The Workflow guidance and the engine every session has (owner decision 2026-11-08T15:30Z, which supersedes the
 * always-on review's AOS-F1 fix): session orchestration 1.0.83 is the latest version and every worker runs the full
 * Workflow engine, so every session's host compiles agent, parallel and request states (compileWorkflow),
 * and every session is taught them.
 * a) a default worker (scripts off, no request-turn flag) carries the full text (trimmed, owner 2026-11-08T16:55Z): agent
 *    nodes, the request answer and the skills, and a scripts-off line that names agent and parallel nodes;
 * b) every state type and inline example that prompt teaches compiles, with the real compiler, on the host every session
 *    has;
 * c) a 1.0.83 turn (a workflow request turn) has the same text, with clock waits and revision tests;
 * d) the basic-engine text of 0f03f215 is gone.
 *
 * Run: node --test test/unit/workflow-guidance-engine.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../dist/session-manager.js";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import * as guidance from "../../dist/workflow/guidance.js";
import { workflowTestModeFromEnv } from "../../dist/workflow/test-mode-switch.js";

const { workflowSessionGuidance, WORKFLOW_SESSION_GUIDANCE } = guidance;

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
    const start = prompt.indexOf("## Workflows");
    assert.ok(start >= 0, "the prompt carries the Workflow guidance");
    const rest = prompt.slice(start);
    const end = rest.slice(3).search(/\n#{1,2} /);
    return end < 0 ? rest : rest.slice(0, end + 3);
}

const definition = (states, extra = {}) => JSON.stringify({
    apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "guidance-example", version: "1.0.0" },
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
        const yaml = ["apiVersion: pilotswarm.dev/v1", "kind: Workflow", "metadata: { name: guidance-inline, version: \"1.0.0\" }",
            `initial: ${id}`, "states:", `  ${id}: ${body}`, ...[...targets].map(target => `  ${target}: { type: terminal, outcome: succeeded }`)].join("\n");
        examples.push({ example: match[0], yaml });
    }
    return examples;
}

const compileErrors = (yaml) => compileWorkflow(yaml).diagnostics.filter(item => item.severity === "error");

test("the canonical examples are real: each compiles on the host every session has", () => {
    for (const [type, { yaml }] of Object.entries(STATE_TYPES)) {
        assert.deepEqual(compileErrors(yaml), [], type);
    }
});

test("(a) a default worker (scripts off, no request-turn flag) carries the full text, and its scripts-off line names agent and parallel nodes", () => {
    const block = workflowBlock(systemPrompt({ scripts: false, requestTurn: false }));
    for (const phrase of ["at the agent nodes that need judgment", "call `load_skill` with name `workflow-authoring`",
        "Test a revision only when the user asks"]) {
        assert.ok(block.includes(phrase), phrase);
    }
    // G-3: a frozen 1.0.82 turn is not declared respond_session_request, so its guidance does not name it.
    assert.ok(!block.includes("respond_session_request"), "not named on a frozen 1.0.82 turn");
    assert.match(block, /Use wait, messaging, agent and parallel nodes/);
});

test("(b) every state type and inline example the default worker's prompt teaches compiles on the host every session has", () => {
    for (const scripts of [false, true]) {
        const block = workflowBlock(systemPrompt({ scripts, requestTurn: false }));
        const taught = Object.entries(STATE_TYPES).filter(([, { named }]) => named.test(block));
        for (const type of ["wait", "agent"]) assert.ok(taught.some(([name]) => name === type), `scripts ${scripts}: it teaches ${type}`);
        for (const [type, { yaml }] of taught) assert.deepEqual(compileErrors(yaml), [], `scripts ${scripts}: ${type}`);
        // The trimmed guidance shows no inline state; any it shows must compile.
        for (const { example, yaml } of inlineExamples(block)) assert.deepEqual(compileErrors(yaml), [], `scripts ${scripts}: ${example}`);
    }
});

test("(c) a 1.0.83 turn has the same text, with clock waits and revision tests", () => {
    const testMode = workflowTestModeFromEnv();
    for (const scripts of [false, true]) {
        const prompt = systemPrompt({ scripts, requestTurn: true });
        assert.ok(prompt.includes(workflowSessionGuidance(testMode, { scripts, clockWaits: true, requests: true })), `scripts ${scripts}`);
        const block = workflowBlock(prompt);
        assert.ok(block.includes("Test a revision only when the user asks"));
        assert.ok(block.includes("`request`: answer it once with `respond_session_request` before its deadline, never as plain text."));
        assert.match(block, /A wait state can wait until a clock time: `at: \{/);
        for (const [type, { named, yaml }] of Object.entries(STATE_TYPES)) {
            if (named.test(block)) assert.deepEqual(compileErrors(yaml), [], `scripts ${scripts}: ${type}`);
        }
    }
    assert.equal(workflowSessionGuidance(false), WORKFLOW_SESSION_GUIDANCE);
});

test("(d) the basic-engine text is gone: no export, and no option gives a session less than the full text", () => {
    for (const name of ["WORKFLOW_BASIC_ENGINE_INTRO", "WORKFLOW_BASIC_ENGINE_SIMPLE", "WORKFLOW_SCRIPTS_OFF_BASIC_ENGINE_GUIDANCE"]) {
        assert.equal(name in guidance, false, name);
    }
    assert.equal(workflowSessionGuidance(false, { scripts: true, fullEngine: false }), workflowSessionGuidance(false, { scripts: true }));
    for (const phrase of ["at the agent nodes that need judgment", "every field: `workflow-reference`"]) {
        assert.ok(workflowSessionGuidance(false, { scripts: true }).includes(phrase), phrase);
    }
});
