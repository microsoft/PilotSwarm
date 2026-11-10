/**
 * Workflow Simplified stage 2.3 (spec "Packages and Agent Smith": P1, P4, P7, the card table, D7; A2), DB-less.
 *
 * - card.md: front matter fields and a body (its notes); a card is refused with every reason, never half read.
 * - The card matches its compiled definition: its name, each terminal, request and send state, a filled example that
 *   satisfies the input schema, and (when it gives them) the definition's own schemas. The digest covers the card and
 *   the interface it matched.
 * - A package ships workflows/<name>/{workflow.yaml, card.md}: the validator compiles each with every node type, checks
 *   its card, and exports both in the manifest; a manifest layout stages a declared directory to workflows/<basename>/.
 * - An agent names the definitions its session may start (workflows:, list or inline): a bare name must be in its own
 *   package; a malformed reference is refused. A2: an agent step may not use one of the package's agents that names
 *   definitions.
 * - References and the coordinating session's instructions (P3).
 *
 * Run: node --test test/unit/workflow-package-card.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    coordinatingInstructions, parseWorkflowCard, parseWorkflowPackageRef, readWorkflowCard, workflowCardDigest, workflowCardInterface,
    workflowCardMismatches, workflowCardWords, workflowEffectFacts, workflowEffectFactsWords, workflowModelHintWords, workflowPackageRef, WORKFLOW_CARD_MAX_BYTES,
    WORKFLOW_OLD_MODEL_HINTS_NOTE,
} from "../../dist/workflow/package-card.js";
import { manifestWorkflows } from "../../dist/workflow/session-packages.js";
import { catalogModelNames, ModelProviderRegistry } from "../../dist/model-providers.js";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { validateAgentPackageDir } from "../../dist/agent-package-format.js";
import { loadAgentFiles, validateAgentDefinition } from "../../dist/agent-loader.js";
export const RELEASE_WATCH_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: release-watch, version: "1.2.0" }
inputs:
  schema:
    type: object
    required: [train]
    properties:
      train: { type: string }
      intervalMinutes: { type: integer }
    additionalProperties: false
initial: progress
schemas:
  Note: { type: object, required: [q], properties: { q: { type: string } }, additionalProperties: false }
  Answer: { type: object, required: [approved], properties: { approved: { type: boolean } }, additionalProperties: false }
contracts:
  Progress@1: { schema: { $ref: "#/schemas/Note" } }
  Approval@1:
    schema: { $ref: "#/schemas/Note" }
    response: { schema: { $ref: "#/schemas/Answer" } }
states:
  progress:
    type: messaging
    mode: send
    recipient: { parent: true }
    contract: Progress@1
    input: { q: "checking the train" }
    transition: { next: { sent: approve_note, failure: failed } }
  approve_note:
    type: messaging
    mode: request
    recipient: { parent: true }
    contract: Approval@1
    input: { q: "post the blocker note?" }
    timeoutSeconds: 3600
    transition: { next: { responded: clear, declined: blocked, timed_out: blocked, failure: failed } }
  clear: { type: terminal, outcome: succeeded }
  blocked: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
`;

export const RELEASE_WATCH_CARD = `---
name: release-watch
description: Watches a release train and reports blockers.
whenToUse: A release train is rolling out and someone wants blockers reported. Not for a single pull request.
inputs:
  example: { train: M70, intervalMinutes: 30 }
outcomes:
  clear: The train finished without a blocker.
  blocked: A blocker was found, or the note was not approved.
  failed: The Workflow could not check the train.
output: Nothing; the session reads the notes it sent.
asks:
  approve_note: Whether to post the blocker note; yes posts it, no ends the Workflow blocked.
sends:
  progress: A note when it starts checking; no answer needed.
effects: No scripts; one message and one request to its session. Ends within an hour.
model: azure-openai:gpt-5.6-terra
---
Start it with the train's name. When it asks, ask the person whether to post the note.
`;

const WAIT_YAML = name => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "0.1.0" }
initial: hold
states:
  hold: { type: wait, seconds: 5, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
const WAIT_CARD = name => `---
name: ${name}
description: Waits five seconds and ends.
whenToUse: A quick check that Workflows run.
outcomes:
  done: It waited and ended.
effects: None; five seconds.
---
`;

const compiled = yaml => {
    const result = compileWorkflow(yaml);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    return result.ir;
};

test("card.md is parsed into its fields and notes; every problem is reported and no card is returned", () => {
    const { card, problems } = parseWorkflowCard(RELEASE_WATCH_CARD);
    assert.deepEqual(problems, []);
    assert.equal(card.name, "release-watch");
    assert.equal(card.description, "Watches a release train and reports blockers.");
    assert.deepEqual(card.inputs, { example: { train: "M70", intervalMinutes: 30 }, schema: null });
    assert.deepEqual(Object.keys(card.outcomes), ["clear", "blocked", "failed"]);
    assert.deepEqual(card.output, { about: "Nothing; the session reads the notes it sent.", schema: null });
    assert.equal(card.model, "azure-openai:gpt-5.6-terra");
    assert.equal(card.notes, "Start it with the train's name. When it asks, ask the person whether to post the note.");
    // CRLF reads the same.
    assert.deepEqual(parseWorkflowCard(RELEASE_WATCH_CARD.replace(/\n/g, "\r\n")).card, card);

    const missing = parseWorkflowCard("---\nname: x\nsurprise: 1\noutcomes: { done: 3 }\n---\n");
    assert.equal(missing.card, null);
    for (const want of ["unknown field 'surprise'", "description is required", "whenToUse is required", "effects is required", "outcomes.done must be text"]) {
        assert.ok(missing.problems.some(problem => problem.includes(want)), `${want}: ${missing.problems.join(" | ")}`);
    }
    assert.match(parseWorkflowCard("no front matter").problems[0], /must start with front matter/);
    assert.match(parseWorkflowCard("---\n: [\n---\n").problems[0], /not valid YAML/);
    assert.match(parseWorkflowCard(`---\nname: x\n---\n${"a".repeat(WORKFLOW_CARD_MAX_BYTES)}`).problems[0], /larger than/);
    assert.ok(parseWorkflowCard("---\nname: x\ndescription: d\nwhenToUse: w\neffects: e\n---\n").problems.some(p => p.includes("outcomes is required")));
});

test("a card must match its definition: name, terminals, requests, sends, a valid example and the definition's own schemas", () => {
    const ir = compiled(RELEASE_WATCH_YAML);
    const { card } = parseWorkflowCard(RELEASE_WATCH_CARD);
    assert.deepEqual(workflowCardMismatches(card, ir), []);
    const face = workflowCardInterface(ir);
    assert.deepEqual(face.outcomes, { clear: "succeeded", blocked: "blocked", failed: "failed" });
    assert.deepEqual(face.asks, ["approve_note"]);
    assert.deepEqual(face.sends, ["progress"]);
    assert.equal(face.inputSchema.type, "object");
    assert.equal(face.outputSchema, null);

    const wrong = {
        ...card, name: "other", outcomes: { clear: "c", gone: "g" }, asks: {}, sends: { progress: "p", extra: "e" },
        inputs: { example: { train: 7 }, schema: { type: "object" } }, output: { about: null, schema: { type: "string" } },
    };
    const problems = workflowCardMismatches(wrong, ir);
    for (const want of ["the card's name is other", "does not describe terminal state 'blocked', 'failed'", "names 'gone', which is not terminal state",
        "asks does not describe request state 'approve_note'", "names 'extra', which is not send state", "inputs.example does not satisfy",
        "inputs.schema is not exactly", "output.schema is not exactly"]) {
        assert.ok(problems.some(problem => problem.includes(want)), `${want}: ${problems.join(" | ")}`);
    }
    // A definition with inputs needs an example; one without needs none.
    assert.ok(workflowCardMismatches({ ...card, inputs: { example: null, schema: null } }, ir).some(p => p.includes("inputs.example is required")));
    const waitIr = compiled(WAIT_YAML("five-second-check"));
    assert.deepEqual(workflowCardMismatches(parseWorkflowCard(WAIT_CARD("five-second-check")).card, waitIr), []);
    // The card may give the definition's own input schema exactly.
    assert.deepEqual(workflowCardMismatches({ ...card, inputs: { ...card.inputs, schema: face.inputSchema } }, ir), []);
});

test("the digest covers the card and its interface; a stored card reads back only when well formed", () => {
    const ir = compiled(RELEASE_WATCH_YAML);
    const { card } = parseWorkflowCard(RELEASE_WATCH_CARD);
    const face = workflowCardInterface(ir);
    const digest = workflowCardDigest(card, face);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(workflowCardDigest(JSON.parse(JSON.stringify(card)), face), digest);
    assert.notEqual(workflowCardDigest({ ...card, effects: "changed" }, face), digest);
    assert.notEqual(workflowCardDigest(card, { ...face, asks: [] }), digest);
    assert.deepEqual(readWorkflowCard(JSON.parse(JSON.stringify(card))), card);
    assert.equal(readWorkflowCard({ ...card, outcomes: { a: 1 } }), null);
    assert.equal(readWorkflowCard(null), null);
});

test("references: <package>/<name>, or a bare name in the referrer's own package", () => {
    assert.deepEqual(parseWorkflowPackageRef("ops-kit/incident-digest"), { packageName: "ops-kit", name: "incident-digest" });
    assert.deepEqual(parseWorkflowPackageRef("release-watch", "release-tools"), { packageName: "release-tools", name: "release-watch" });
    assert.equal(parseWorkflowPackageRef("release-watch"), null);
    for (const bad of ["Ops/x", "ops-kit/", "/x", "ops-kit/a/b", "-x/y", 7, null, "ops kit/x"]) assert.equal(parseWorkflowPackageRef(bad, "own"), null, String(bad));
    assert.equal(workflowPackageRef("release-tools", "release-watch"), "release-tools/release-watch");
});

test("the card's words and the coordinating session's instructions (P3) name the definition, its inputs and how it ends", () => {
    const ir = compiled(RELEASE_WATCH_YAML);
    const { card } = parseWorkflowCard(RELEASE_WATCH_CARD);
    const face = workflowCardInterface(ir);
    const words = workflowCardWords("release-tools/release-watch", "1.2.0", card, face);
    for (const want of ["release-tools/release-watch 1.2.0: Watches a release train", "Example inputs: {\"train\":\"M70\",\"intervalMinutes\":30}",
        "clear (succeeded): The train finished", "It asks this session: approve_note", "It sends this session: progress",
        "Effects (the author's words): No scripts", "Notes:\nStart it"]) {
        assert.ok(words.includes(want), want);
    }
    const instructions = coordinatingInstructions("release-tools/release-watch", "1.2.0", card, face);
    for (const want of ["coordinates one Workflow Definition: release-tools/release-watch (package version 1.2.0)", "locked",
        "Ask the person for each input you do not have", `operation "start", name "release-tools/release-watch"`, "answer its requests",
        "tell the person how it ended"]) {
        assert.ok(instructions.includes(want), want);
    }
});

function writePackage(t, files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfs-pkg-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [relative, text] of Object.entries(files)) {
        if (text === null) continue;
        fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
        fs.writeFileSync(path.join(dir, relative), text);
    }
    return dir;
}

const AGENT = (name, workflows) => `---
name: ${name}
description: Watches release trains.
${workflows ?? ""}---
You watch release trains.
`;

const BASE = {
    "plugin.json": JSON.stringify({ name: "release-tools", version: "1.2.0", description: "Release tools." }),
    "agents/release-watcher.agent.md": AGENT("release-watcher", "workflows:\n  - release-watch\n  - ops-kit/incident-digest\n"),
    "workflows/release-watch/workflow.yaml": RELEASE_WATCH_YAML,
    "workflows/release-watch/card.md": RELEASE_WATCH_CARD,
};
const codes = validation => validation.errors.map(item => item.code).sort();

test("a package exports its Workflow Definitions with their cards, and its agents' workflows lists (P1, P4, P7)", async t => {
    const validation = await validateAgentPackageDir(writePackage(t, BASE), { skipSyntaxCheck: true });
    assert.deepEqual(validation.errors, []);
    const [exported] = validation.manifest.workflows;
    assert.equal(validation.manifest.workflows.length, 1);
    assert.equal(exported.name, "release-watch");
    assert.equal(exported.version, "1.2.0");
    assert.equal(exported.description, "Watches a release train and reports blockers.");
    const ir = compiled(RELEASE_WATCH_YAML);
    assert.equal(exported.yamlSha256, compileWorkflow(RELEASE_WATCH_YAML).yamlSha256);
    assert.deepEqual(exported.interface, JSON.parse(JSON.stringify(workflowCardInterface(ir))));
    assert.equal(exported.cardDigest, workflowCardDigest(exported.card, exported.interface));
    assert.deepEqual(validation.manifest.agents[0].workflows, ["release-watch", "ops-kit/incident-digest"]);
    // A package without definitions has no workflows key (its manifest is as before).
    const plain = await validateAgentPackageDir(writePackage(t, { ...BASE, "agents/release-watcher.agent.md": AGENT("release-watcher"),
        "workflows/release-watch/workflow.yaml": null, "workflows/release-watch/card.md": null }), { skipSyntaxCheck: true });
    assert.deepEqual(plain.errors, []);
    assert.equal(Object.hasOwn(plain.manifest, "workflows"), false);
    assert.equal(Object.hasOwn(plain.manifest.agents[0], "workflows"), false);
});

test("publishing refuses a definition that does not compile, lacks a file, is misnamed, or whose card does not match it", async t => {
    const cases = [
        [{ "workflows/release-watch/card.md": null }, ["workflow_missing_card"]],
        [{ "workflows/release-watch/workflow.yaml": null }, ["workflow_missing_yaml"]],
        [{ "workflows/release-watch/workflow.yaml": "apiVersion: nope\n" }, ["invalid_workflow"]],
        [{ "workflows/release-watch/workflow.yaml": RELEASE_WATCH_YAML.replace("name: release-watch", "name: renamed") }, ["workflow_name_mismatch"]],
        [{ "workflows/release-watch/card.md": RELEASE_WATCH_CARD.replace("  failed: The Workflow could not check the train.\n", "") }, ["workflow_card_mismatch"]],
        [{ "workflows/release-watch/card.md": "---\nname: release-watch\n---\n" }, ["invalid_workflow_card", "invalid_workflow_card", "invalid_workflow_card", "invalid_workflow_card"]],
        [{ "workflows/stray.yaml": "x" }, ["workflow_not_a_directory"]],
        [{ "workflows/bad name/workflow.yaml": WAIT_YAML("x"), "workflows/bad name/card.md": WAIT_CARD("x") }, ["invalid_workflow_name"]],
    ];
    for (const [change, want] of cases) {
        const validation = await validateAgentPackageDir(writePackage(t, { ...BASE, ...change }), { skipSyntaxCheck: true });
        assert.deepEqual(codes(validation), want, `${JSON.stringify(Object.keys(change))}: ${JSON.stringify(validation.errors)}`);
        assert.equal(validation.manifest, undefined);
    }
    const extra = await validateAgentPackageDir(writePackage(t, { ...BASE, "workflows/release-watch/README.md": "notes" }), { skipSyntaxCheck: true });
    assert.deepEqual(extra.errors, []);
    assert.ok(extra.warnings.some(item => item.code === "workflow_extra_file"));
});

test("an agent's workflows: a bare name must be one of its package's definitions; a malformed reference is refused", async t => {
    const unknown = await validateAgentPackageDir(writePackage(t, { ...BASE,
        "agents/release-watcher.agent.md": AGENT("release-watcher", "workflows: [release-watch, nightly-digest]\n") }), { skipSyntaxCheck: true });
    assert.deepEqual(codes(unknown), ["unknown_workflow_ref"]);
    assert.match(unknown.errors[0].message, /no Workflow Definition nightly-digest \(workflows\/nightly-digest\/\)/);
    const malformed = await validateAgentPackageDir(writePackage(t, { ...BASE,
        "agents/release-watcher.agent.md": AGENT("release-watcher", "workflows:\n  - Ops Kit/x\n") }), { skipSyntaxCheck: true });
    assert.deepEqual(codes(malformed), ["invalid_workflow_ref"]);
    // Another package's definition is checked when a session starts it, not here.
    const other = await validateAgentPackageDir(writePackage(t, { ...BASE,
        "agents/release-watcher.agent.md": AGENT("release-watcher", "workflows: [other-kit/thing]\n") }), { skipSyntaxCheck: true });
    assert.deepEqual(other.errors, []);
    assert.deepEqual(validateAgentDefinition({ workflows: ["ok/fine", "fine", "Bad/x"] }).map(issue => issue.code), ["invalid_workflow_ref"]);
});

test("A2 in the package: an agent step may not use one of the package's agents that names definitions", async t => {
    const stepYaml = (agentRef) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: delegate, version: "1.0.0" }
initial: ask
states:
  ask:
    type: agent
    invoke: { agent: ${agentRef} }
    timeoutSeconds: 600
    transition: { next: { checked: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
    const card = `---\nname: delegate\ndescription: Asks the watcher.\nwhenToUse: Never on its own.\noutcomes:\n  done: Done.\n  failed: Failed.\neffects: One agent turn.\n---\n`;
    for (const ref of ["{ name: release-watcher }", "{ name: release-watcher, package: release-tools }"]) {
        const yaml = stepYaml(ref);
        compiled(yaml);
        const validation = await validateAgentPackageDir(writePackage(t, { ...BASE, "workflows/delegate/workflow.yaml": yaml, "workflows/delegate/card.md": card }),
            { skipSyntaxCheck: true });
        assert.deepEqual(codes(validation), ["workflow_agent_brings_workflows"], JSON.stringify(validation.errors));
        assert.match(validation.errors[0].message, /state 'ask' uses agent "release-watcher", which names Workflow Definitions/);
    }
    // Another package's agent of that name is not this package's: checked at Start instead.
    const elsewhere = stepYaml("{ name: release-watcher, package: other-kit }");
    compiled(elsewhere);
    const validation = await validateAgentPackageDir(writePackage(t, { ...BASE, "workflows/delegate/workflow.yaml": elsewhere, "workflows/delegate/card.md": card }),
        { skipSyntaxCheck: true });
    assert.deepEqual(validation.errors, []);
});

test("a manifest layout stages a declared Workflow Definition directory to workflows/<basename>/", async t => {
    const dir = writePackage(t, {
        "plugin.json": JSON.stringify({ name: "release-tools", version: "1.2.0", description: "Release tools.",
            agents: ["src/release-watcher.agent.md"], workflows: ["defs/release-watch"] }),
        "src/release-watcher.agent.md": AGENT("release-watcher", "workflows: [release-watch]\n"),
        "defs/release-watch/workflow.yaml": RELEASE_WATCH_YAML,
        "defs/release-watch/card.md": RELEASE_WATCH_CARD,
    });
    const validation = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(validation.errors, []);
    assert.deepEqual(validation.manifest.workflows.map(item => item.name), ["release-watch"]);
    const missing = await validateAgentPackageDir(writePackage(t, {
        "plugin.json": JSON.stringify({ name: "release-tools", version: "1.2.0", description: "d", workflows: ["defs/nope"] }),
    }), { skipSyntaxCheck: true });
    assert.deepEqual(codes(missing), ["layout_file_missing"]);
});

test("the agent loader reads workflows as a list or an inline array, and leaves it out when empty", t => {
    const dir = writePackage(t, {
        "a.agent.md": AGENT("a", "workflows:\n  - release-watch\n  - \"ops-kit/incident-digest\"\n"),
        "b.agent.md": AGENT("b", "workflows: ['x', ops-kit/y]\n"),
        "c.agent.md": AGENT("c", "workflows:\n"),
    });
    const agents = Object.fromEntries(loadAgentFiles(dir).map(agent => [agent.name, agent]));
    assert.deepEqual(agents.a.workflows, ["release-watch", "ops-kit/incident-digest"]);
    assert.deepEqual(agents.b.workflows, ["x", "ops-kit/y"]);
    assert.equal(Object.hasOwn(agents.c, "workflows"), false);
});

// Stage 2 review S2SF-F4: a card's effects are its author's words; what the definition itself shows (its script steps,
// code that runs on a worker, and its agent steps) is said whatever the card says, and a card that says "no scripts" for a
// definition with script steps is refused at publication.
const SCRIPT_YAML = name => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: poll
states:
  poll:
    type: script
    source: |
      await setResult("done", { ok: true });
    transition: { next: { done: ask, failure: done } }
  ask:
    type: agent
    invoke: { prompt: "Say whether it is ok." }
    timeoutSeconds: 600
    transition: { next: { done: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`;
const SCRIPT_CARD = (name, effects) => `---
name: ${name}
description: Polls and asks.
whenToUse: When you want a poll.
outcomes:
  done: It polled.
effects: ${effects}
---
`;

test("S2SF-F4: the checked facts of a definition (scripts, agent steps), in words, whatever the card says", () => {
    const ir = compiled(SCRIPT_YAML("poller"));
    assert.deepEqual(workflowEffectFacts(ir), { scripts: ["poll"], agents: ["ask"] });
    assert.equal(workflowEffectFactsWords(workflowEffectFacts(ir)), "Checked from the definition: it runs scripts (step poll). A script runs code on a "
        + "worker: it can reach the network, and use the tools of the session that starts it, which can read and write files and run processes. "
        + "It has agent steps (ask): each one asks a model.");
    const none = workflowEffectFacts(compiled(WAIT_YAML("x")));
    assert.deepEqual(none, { scripts: [], agents: [] });
    assert.equal(workflowEffectFactsWords(none), "Checked from the definition: it runs no scripts and has no agent steps.");
    // The card's words and the coordinating session's instructions say both: the checked facts, and the effects as the author's words.
    const { card } = parseWorkflowCard(SCRIPT_CARD("poller", "Reads one status page."));
    const face = workflowCardInterface(ir);
    const facts = workflowEffectFacts(ir);
    for (const text of [workflowCardWords("tools/poller", "1.0.0", card, face, facts), coordinatingInstructions("tools/poller", "1.0.0", card, face, facts)]) {
        assert.ok(text.includes("Checked from the definition: it runs scripts (step poll)."), text);
        assert.ok(text.includes("Effects (the author's words): Reads one status page."), text);
    }
});

test("S2SF-F4: a card that says it runs no scripts is refused for a definition with script steps; the same words are fine without them", async t => {
    const ir = compiled(SCRIPT_YAML("poller"));
    for (const claim of ["No scripts; one wait.", "Runs without any scripts.", "zero scripts", "It never runs scripts."]) {
        const { card } = parseWorkflowCard(SCRIPT_CARD("poller", claim));
        assert.deepEqual(workflowCardMismatches(card, ir), ["effects says it runs no scripts, but the definition has script step poll: say what the scripts do"], claim);
    }
    const { card: honest } = parseWorkflowCard(SCRIPT_CARD("poller", "One script reads the status page; one agent step."));
    assert.deepEqual(workflowCardMismatches(honest, ir), []);
    const { card: waitCard } = parseWorkflowCard(WAIT_CARD("x").replace("None; five seconds.", "No scripts; five seconds."));
    assert.deepEqual(workflowCardMismatches(waitCard, compiled(WAIT_YAML("x"))), []);
    // At publication.
    const refused = await validateAgentPackageDir(writePackage(t, { ...BASE, "workflows/poller/workflow.yaml": SCRIPT_YAML("poller"),
        "workflows/poller/card.md": SCRIPT_CARD("poller", "No scripts; one agent turn.") }), { skipSyntaxCheck: true });
    assert.deepEqual(codes(refused), ["workflow_card_mismatch"]);
    assert.match(refused.errors[0].message, /effects says it runs no scripts, but the definition has script step poll/);
});

// OF-S2-7: a card's model hints say what kind of model, reasoning or context an agent node needs, in words, never a model's
// name; publication checks each names an agent node; a card without hints keeps the digest it had.
const HINTED_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: triage, version: "1.0.0" }
initial: classify
states:
  classify:
    type: agent
    invoke: { prompt: "Classify it." }
    timeoutSeconds: 600
    transition: { next: { done: pause, failure: failed } }
  pause: { type: wait, seconds: 5, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
const HINTED_CARD = hints => `---\nname: triage\ndescription: Triages.\nwhenToUse: Always.\noutcomes:\n  done: Done.\n  failed: Failed.\neffects: One agent turn.\n${hints}---\n`;

test("OF-S2-7 review OF7-R5: model hints are structured fields for agent nodes; a card without them keeps its digest", () => {
    const ir = compiled(HINTED_YAML);
    const { card, problems } = parseWorkflowCard(HINTED_CARD("modelHints:\n  classify: { strength: fast, reasoning: low, context: long_context, note: one short label }\n"));
    assert.deepEqual(problems, []);
    assert.deepEqual(card.modelHints, { classify: { strength: "fast", reasoning: "low", context: "long_context", note: "one short label" } });
    assert.deepEqual(workflowCardMismatches(card, ir), []);
    assert.deepEqual(readWorkflowCard(JSON.parse(JSON.stringify(card))), card);
    assert.equal(workflowModelHintWords(card.modelHints.classify), "fast model · low reasoning · long context · one short label");
    // Free words are no longer a hint; every field is checked.
    const refusals = [
        ["classify: fast, low reasoning", /^modelHints\.classify must be a mapping of strength/],
        ["classify: { strength: huge }", /^modelHints\.classify\.strength must be one of fast, balanced, strong$/],
        ["classify: { reasoning: extreme }", /^modelHints\.classify\.reasoning must be one of low, medium, high, xhigh, max$/],
        ["classify: { context: [long_context] }", /^modelHints\.classify\.context must be one of default, long_context$/],
        ["classify: { model: gpt-5 }", /^modelHints\.classify has an unknown field 'model'/],
        ["classify: {}", /^modelHints\.classify is empty/],
        [`classify: { note: ${"x".repeat(121)} }`, /^modelHints\.classify\.note is longer than 120 characters$/],
        // A note that names provider:model is refused at parse, whatever the catalog.
        ["classify: { note: use azure-openai:gpt-5.6-terra }", /^modelHints\.classify\.note names a model \("use azure-openai:gpt-5\.6-terra"\)/],
    ];
    for (const [hints, message] of refusals) {
        const parsed = parseWorkflowCard(HINTED_CARD(`modelHints:\n  ${hints}\n`));
        assert.equal(parsed.card, null, hints);
        assert.match(parsed.problems[0], message, hints);
    }
    // A note naming a model of the publisher's catalog (bare or qualified) is refused when the card is checked against it.
    const bare = parseWorkflowCard(HINTED_CARD("modelHints:\n  classify: { strength: strong, note: like GPT-5.6-Terra does }\n")).card;
    assert.deepEqual(workflowCardMismatches(bare, ir), []);
    assert.deepEqual(workflowCardMismatches(bare, ir, { knownModelNames: ["azure-openai:gpt-5.6-terra", "gpt-5.6-terra"] }),
        ["modelHints.classify.note names the model gpt-5.6-terra; say the kind of model with strength, reasoning and context, never a model's name"]);
    const word = parseWorkflowCard(HINTED_CARD("modelHints:\n  classify: { note: reads every terrace }\n")).card;
    assert.deepEqual(workflowCardMismatches(word, ir, { knownModelNames: ["terra"] }), [], "a model name inside another word is not that name");
    // Review D2: ".", "-" and "_" end a name: a catalog name at the end of a sentence or inside a longer token is still named.
    for (const note of ["as good as claude-opus-5.", "a gpt-5.6-terra-like model", "use_claude-opus-5_here"]) {
        const card = parseWorkflowCard(HINTED_CARD(`modelHints:\n  classify: { note: "${note}" }\n`)).card;
        assert.equal(workflowCardMismatches(card, ir, { knownModelNames: ["claude-opus-5", "gpt-5.6-terra"] }).length, 1, note);
    }
    // A hint for a node that is not an agent node (or no node) does not match the definition.
    const wrong = parseWorkflowCard(HINTED_CARD("modelHints:\n  pause: { strength: fast }\n  ghost: { strength: fast }\n")).card;
    assert.deepEqual(workflowCardMismatches(wrong, ir), ["modelHints names 'pause', 'ghost', which are not agent nodes of the definition (its agent nodes: classify)"]);
    // Without hints the card has no modelHints at all, so a card published before them keeps its digest; a stored card with
    // hints in the old free-word form does not read back.
    const plain = parseWorkflowCard(HINTED_CARD("")).card;
    assert.equal(Object.hasOwn(plain, "modelHints"), false);
    assert.equal(Object.hasOwn(readWorkflowCard(JSON.parse(JSON.stringify(plain))), "modelHints"), false);
    // Review D5: a card stored with the older free-word hints (1.4.4) keeps its Workflow; its hints are left out, with one note.
    const old = readWorkflowCard({ ...JSON.parse(JSON.stringify(plain)), notes: "Start it.", modelHints: { classify: "fast, low reasoning" } });
    assert.ok(old, "the card still reads");
    assert.equal(Object.hasOwn(old, "modelHints"), false);
    assert.equal(old.notes, `Start it.\n\n${WORKFLOW_OLD_MODEL_HINTS_NOTE}`);
    assert.match(WORKFLOW_OLD_MODEL_HINTS_NOTE, /^This card's model hints are in an older form, so they are not shown/);
    const exported = { name: "triage", version: "1.0.0", yamlSha256: "y", irSha256: "i", cardDigest: "d", interface: {},
        card: { ...JSON.parse(JSON.stringify(plain)), modelHints: { classify: "fast" } } };
    assert.deepEqual(manifestWorkflows({ workflows: [exported] }).map(item => [item.name, Object.hasOwn(item.card, "modelHints")]), [["triage", false]]);
    // The words a session reads: the hints, and that every other agent node uses the starting session's model.
    const words = workflowCardWords("ops/triage", "1.0.0", card, workflowCardInterface(ir));
    assert.match(words, /\nModel hints \(by agent node\): classify: fast model · low reasoning · long context · one short label\. For a node with a hint, choose a model that fits it from list_available_models \(the owning session's catalog\) and give it in agent_models at start; every other agent node uses the model of the session that starts it\.(\n|$)/);
    assert.match(workflowCardWords("ops/triage", "1.0.0", plain, null), /\nModels: its agent nodes use the model of the session that starts it; no node asks for another\./);
    assert.match(coordinatingInstructions("ops/triage", "1.0.0", card, null),
        /Leave agent_models out unless the person asks for a model, or a model hint above asks for a kind of model: then choose from list_available_models and say what you chose\./);
});

test("OF-S2-7: publication refuses a card that hints a node that is not an agent node, or whose note names a model in the publisher's catalog", async t => {
    const card = HINTED_CARD("modelHints:\n  pause: { strength: fast }\n");
    const validation = await validateAgentPackageDir(writePackage(t, { ...BASE, "workflows/triage/workflow.yaml": HINTED_YAML, "workflows/triage/card.md": card }),
        { skipSyntaxCheck: true });
    assert.deepEqual(codes(validation), ["workflow_card_mismatch"], JSON.stringify(validation.errors));
    assert.match(validation.errors[0].message, /modelHints names 'pause', which is not an agent node of the definition/);
    const named = HINTED_CARD("modelHints:\n  classify: { strength: strong, note: as good as claude-opus-5 }\n");
    const files = { ...BASE, "workflows/triage/workflow.yaml": HINTED_YAML, "workflows/triage/card.md": named };
    assert.deepEqual((await validateAgentPackageDir(writePackage(t, files), { skipSyntaxCheck: true })).errors, [], "no catalog given: nothing to match");
    const refused = await validateAgentPackageDir(writePackage(t, files), { skipSyntaxCheck: true, knownModelNames: ["github-copilot:claude-opus-5", "claude-opus-5"] });
    assert.deepEqual(codes(refused), ["workflow_card_mismatch"]);
    assert.match(refused.errors[0].message, /modelHints\.classify\.note names the model claude-opus-5/);
    // The deployment's catalog as publication reads it: qualified and bare names.
    const types = new ModelProviderRegistry({ providers: [{ id: "azure-openai", type: "openai", baseUrl: "https://example.test/v1", apiKey: "K",
        models: [{ name: "gpt-5.6-terra" }] }] });
    assert.deepEqual(catalogModelNames(types).sort(), ["azure-openai:gpt-5.6-terra", "gpt-5.6-terra"]);
    assert.deepEqual(catalogModelNames(null), []);
});
