/**
 * Freezing 1.0.85 and opening 1.0.86 (a spawned child's workspace selection).
 *
 * The 1.0.86 live tree changes what the session orchestration passes to its spawn
 * activities: the child config goes through applySessionWorkspaceSelection, and a
 * Workflow agent step's sub-agent gets a different system message. Duroxide compares an
 * activity's input on replay, so 1.0.85 is frozen in orchestration_1_0_85/ and in-flight
 * 1.0.85 sessions keep replaying on it.
 *
 * The frozen copy is the live tree of release 0.8.12 (tag v0.8.12), the release that
 * shipped 1.0.85, with two kinds of literal only: its version ("1.0.85") and its proxy
 * routing contract ("tool-composition-v1"). It is not a copy of the tree that carried the
 * 1.0.86 change under the 1.0.85 name.
 *
 * Freeze obligation (formal binding): the frozen copy never imports the live contract
 * constant (orchestration/proxy-contract.ts). If the constant changes for a later
 * version, the frozen 1.0.85 histories must keep routing exactly as they were recorded.
 *
 * Coverage: three spawn histories are pinned below. This is not a claim that every
 * 1.0.85 history is covered.
 *
 * Run: node --test test/unit/orchestration-freeze-1-0-85.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import { handleSubAgentAction as frozenSpawn } from "../../dist/orchestration_1_0_85/agents.js";
import { handleSubAgentAction as liveSpawn } from "../../dist/orchestration/agents.js";

const SRC = new URL("../../src/", import.meta.url);
const FROZEN = "orchestration_1_0_85";
const read = name => readFileSync(new URL(name, SRC), "utf8").replace(/\r\n/g, "\n");
const tsFiles = dir => readdirSync(new URL(`${dir}/`, SRC)).filter(name => name.endsWith(".ts")).sort();

function allSourceFiles(dir = "") {
    const out = [];
    for (const name of readdirSync(new URL(dir || ".", SRC))) {
        const path = dir ? `${dir}/${name}` : name;
        if (statSync(new URL(path, SRC)).isDirectory()) out.push(...allSourceFiles(path));
        else if (name.endsWith(".ts")) out.push(path);
    }
    return out;
}

function importsOf(text) {
    return [...text.matchAll(/^(?:import|export)\b[^\n]*?\sfrom\s+"([^"]+)"|^\}\s+from\s+"([^"]+)"|\bimport\("([^"]+)"\)/gm)]
        .map(match => match[1] ?? match[2] ?? match[3]);
}

test("the registry keeps 1.0.85 frozen and registers 1.0.86 from the live tree", () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.86");
    const frozen = DURABLE_SESSION_ORCHESTRATION_REGISTRY.filter(entry => entry.version === "1.0.85");
    assert.equal(frozen.length, 1);
    assert.equal(frozen[0].handler.name, "durableSessionOrchestration_1_0_85");
    const latest = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1);
    assert.deepEqual([latest.version, latest.handler.name], ["1.0.86", "durableSessionOrchestration_1_0_86"]);
    assert.notEqual(latest.handler, frozen[0].handler);
    const registry = read("orchestration-registry.ts");
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_85 \} from "\.\/orchestration_1_0_85\/index\.js";/);
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_86 \} from "\.\/orchestration\/index\.js";/);
    assert.match(registry, /\{ version: "1\.0\.85", handler: durableSessionOrchestration_1_0_85 \}/);
    assert.match(registry, /\{ version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_86 \}/);
});

test("frozen 1.0.85 names its version as a literal and continues as new to the live latest", () => {
    assert.match(read(`${FROZEN}/runtime.ts`), /^export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.85";$/m);
    const index = read(`${FROZEN}/index.ts`);
    assert.match(index, /latestVersion: DURABLE_SESSION_LATEST_VERSION/);
    assert.match(index, /export function\* durableSessionOrchestration_1_0_85\(/);
});

test("freeze obligation: frozen 1.0.85 routes every proxy with the literal contract and never imports the live constant", () => {
    let proxies = 0;
    for (const name of tsFiles(FROZEN)) {
        const text = read(`${FROZEN}/${name}`);
        assert.doesNotMatch(text, /LIVE_SESSION_PROXY_CONTRACT/, `${name} names the live contract constant`);
        assert.ok(!importsOf(text).some(specifier => specifier.includes("proxy-contract")), `${name} imports proxy-contract`);
        const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
        const visit = node => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                const argumentIndex = node.expression.text === "createSessionProxy" ? 4
                    : node.expression.text === "createSessionManagerProxy" ? 1 : null;
                if (argumentIndex !== null) {
                    proxies++;
                    assert.equal(node.arguments[argumentIndex]?.getText(source), "\"tool-composition-v1\"",
                        `${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    assert.equal(proxies, 8, "seven session proxies and one manager proxy");
});

const frozenHashes = {
    "agents.ts": "e9c916e083e747bd2c41298620f26152b15d2066a2d3e248b1847876a807742b",
    "index.ts": "6641d71dd8f869fdec0358ce99bb6245c0882e63a0d97aa591c541b6035e3687",
    "intake-machine.ts": "9a9cd67f531620445bcb26e24d8af1818772acfcb714a677f782e35f99e4e4bf",
    "intake-state.ts": "ba4e7de0ca9b17a6c43aaf094b107c7ff82dcc1dab7604444254c50811c351bf",
    "intake-wiring.ts": "e0fb80e51261152803667c99c72f8797ada8693946b237c740315d4cd65ce23d",
    "lifecycle.ts": "abc05df28b46e9f4bad90f57bb86734ab087512ba80885d4971e422979799b4d",
    "queue.ts": "24bc5edb4bc01798b2c63244c3ffc5451923da56214e29f4110d9c40e7d66803",
    "runtime.ts": "630a8e805d53fd4d6b40f3b247048719e9ce28e374267ddc82f88beef3b8cb63",
    "state.ts": "775105f65cd0cccfefa54f41e140d868deff1f7fd20cacd6d7f98db5660cbbf3",
    "turn.ts": "092f314f276ffa48d907d47a3225c8ed195d9af1b0a16d4261a97103e30e4b92",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "workflow-turn-failure.ts": "8f1f412f4caba5c7f3b5a4f688160d8425cd1548bcbb5b046066705824b7474a",
};

test("frozen 1.0.85 has exactly its files", () => {
    assert.deepEqual(tsFiles(FROZEN), Object.keys(frozenHashes).sort());
});

for (const [name, hash] of Object.entries(frozenHashes)) {
    test(`frozen 1.0.85 ${name} remains unchanged`, () => {
        assert.equal(createHash("sha256").update(read(`${FROZEN}/${name}`)).digest("hex"), hash);
    });
}

/** The modules the frozen copy imports: shared ones and its own files, never the live orchestration or another version. */
const frozenImports = [
    "../activity-routing.js", "../child-notifications.js", "../cron-at.js", "../message-sender.js", "../orchestration-version.js",
    "../prompt-system-context.js", "../provider-budgets.js", "../session-list-timestamps.js", "../session-proxy.js",
    "../turn-control-contract.js", "../types.js", "../wait-affinity.js", "../workflow/agent-ids.js", "../workflow/intake.js",
    "../workspace-check.js",
    "./agents.js", "./intake-machine.js", "./intake-state.js", "./intake-wiring.js", "./lifecycle.js", "./queue.js",
    "./runtime.js", "./state.js", "./turn.js", "./utils.js", "./workflow-turn-failure.js",
    "node:crypto",
];

test("frozen 1.0.85 imports only shared modules and its own files, and not the workspace selection helper", () => {
    const seen = new Set();
    for (const name of tsFiles(FROZEN)) {
        for (const specifier of importsOf(read(`${FROZEN}/${name}`))) {
            assert.ok(frozenImports.includes(specifier), `${name} imports ${specifier}`);
            seen.add(specifier);
        }
    }
    assert.deepEqual([...seen].sort(), [...frozenImports].sort());
    assert.ok(!seen.has("../workspace.js"), "1.0.85 selects a child's workspace inline, as release 0.8.12 did");
    assert.ok(importsOf(read("orchestration/agents.ts")).includes("../workspace.js"), "1.0.86 uses applySessionWorkspaceSelection");
});

test("only the registry imports the frozen 1.0.85 copy", () => {
    for (const path of allSourceFiles()) {
        if (path.startsWith(`${FROZEN}/`)) continue;
        for (const specifier of importsOf(read(path))) {
            if (specifier.includes(FROZEN)) assert.equal(path, "orchestration-registry.ts", `${path} imports ${specifier}`);
        }
    }
});

// ─── Replay: what a spawn passes to its activities ───────────────────────────
//
// A spawn handled by the orchestration schedules captureSpawnTools and then
// spawnChildSession. Their arguments are the activity inputs that Duroxide compares on
// replay. The digests below were recorded by running handleSubAgentAction of the real
// v0.8.12 source (packages/sdk/src/orchestration/agents.ts at tag v0.8.12) with the same
// driver and cases. Frozen 1.0.85 must produce the same bytes; live 1.0.86 does not.

/** Drive one spawn and return the arguments of the two activities it schedules. */
function spawnInputs(handler, config, action) {
    const calls = {};
    const runtime = {
        ctx: { traceInfo() {} },
        state: { config: structuredClone(config), subAgents: [], transcriptEpoch: 3, workspaceRevision: 2, iteration: 7 },
        options: { nestingLevel: 1 },
        input: { sessionId: "parent-session" },
        session: { captureSpawnTools: (...args) => { calls.captureSpawnTools = structuredClone(args); return { activity: "captureSpawnTools" }; } },
        manager: { spawnChildSession: (...args) => { calls.spawnChildSession = structuredClone(args); return { activity: "spawnChildSession" }; } },
    };
    const generator = handler(runtime, structuredClone(action));
    assert.deepEqual(generator.next().value, { activity: "captureSpawnTools" });
    assert.deepEqual(generator.next({}).value, { activity: "spawnChildSession" });
    return calls;
}
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const recorded = {
    "a Workflow agent step's session spawns a sub-agent that inherits the workspace": {
        config: { model: "parent:model", workflowInsideWorkflow: true, workspace: { root: "repo", folder: "main" }, systemMessage: "PARENT PERSONA" },
        action: { type: "spawn_agent", task: "Inspect the failing test", lockTitle: false },
        v0812: "e7e1126fa1090acc47acbb3b2ba2a1f64ab758a5996db0e6f9f155a310ee5a00",
    },
    "a session with a working directory spawns a sub-agent with its own workspace record": {
        config: { model: "parent:model", workingDirectory: "/work/parent", workspaceDefaults: { workingFolder: null, extra: [] } },
        action: { type: "spawn_agent", task: "Review the proposal", lockTitle: false, workspace: { root: "repo", folder: "review" } },
        v0812: "51b91d605ab9c02b9a0c33d26347ccc5249d6e5f715e61673f49c9be68a125e8",
    },
    "a session with a working directory clears the record for its sub-agent": {
        config: { model: "parent:model", workingDirectory: "/work/parent", workspace: { root: "repo", folder: "main" } },
        action: { type: "spawn_agent", task: "Summarize", lockTitle: false, workspace: null },
        v0812: "315cc152b7fefae4872f33625d74bb0f6ee77bb30f0d91f6d6d559a32a594347",
    },
};

for (const [name, { config, action, v0812 }] of Object.entries(recorded)) {
    test(`replay: ${name}: frozen 1.0.85 schedules the activity inputs v0.8.12 recorded; live 1.0.86 schedules others`, () => {
        assert.equal(digest(spawnInputs(frozenSpawn, config, action)), v0812, "frozen 1.0.85 differs from the v0.8.12 recording");
        assert.notEqual(digest(spawnInputs(liveSpawn, config, action)), v0812, "1.0.86 no longer differs: is the freeze still needed?");
    });
}

test("replay: the difference is the one 1.0.86 opens for: the child's workspace fields and the Workflow sub-agent note", () => {
    const inherit = recorded["a Workflow agent step's session spawns a sub-agent that inherits the workspace"];
    const [frozenConfig] = spawnInputs(frozenSpawn, inherit.config, inherit.action).captureSpawnTools;
    const [liveConfig] = spawnInputs(liveSpawn, inherit.config, inherit.action).captureSpawnTools;
    assert.match(frozenConfig.systemMessage, /The artifact store is the ONLY shared byte channel/);
    assert.match(liveConfig.systemMessage, /Attached durable workspace folders are shared/);
    assert.deepEqual({ ...frozenConfig, systemMessage: "" }, { ...liveConfig, systemMessage: "" }, "only the system message differs");

    const record = recorded["a session with a working directory spawns a sub-agent with its own workspace record"];
    const [frozenRecord] = spawnInputs(frozenSpawn, record.config, record.action).captureSpawnTools;
    const [liveRecord] = spawnInputs(liveSpawn, record.config, record.action).captureSpawnTools;
    assert.deepEqual(frozenRecord.workspace, { root: "repo", folder: "review" });
    assert.deepEqual(liveRecord.workspace, { root: "repo", folder: "review" });
    assert.equal(frozenRecord.workingDirectory, "/work/parent", "1.0.85 keeps the parent's working directory beside the record");
    assert.equal(liveRecord.workingDirectory, undefined, "1.0.86 drops it");
    assert.equal("workspaceDefaults" in liveRecord, false, "1.0.86 drops the parent's captured defaults for an explicit record");
});
