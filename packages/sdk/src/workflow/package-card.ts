import { parse as parseYaml } from "yaml";
import type { WorkflowIR } from "./compiler.js";
import { canonicalJson, isJsonObject, sha256Hex, assertJsonValue, type JsonObject, type JsonValue } from "./json.js";
import { normalizeSchema, WorkflowSchemaError, WorkflowSchemaSet } from "./schema.js";
import { workflowResolvedInputsSchema } from "./resolved-schema.js";

/**
 * A Workflow Definition's interface card (Workflow Simplified stage 2.3; spec "Packages and Agent Smith": P1, P3, P7 and
 * the card table). A package ships each definition as `workflows/<name>/workflow.yaml` with `workflows/<name>/card.md`:
 * YAML front matter, then a markdown body (its notes). A coordinating chat, or any chat that may start the definition,
 * reads the card to learn what the Workflow does, what it needs and how it can end, as a canvas app's manifest tells a
 * chat what the app is.
 *
 *     ---
 *     name: release-watch
 *     description: Watches a release train and reports blockers.
 *     whenToUse: A release train is rolling out and someone wants blockers reported. Not for a single PR.
 *     inputs:
 *       example: { train: M70, intervalMinutes: 30 }
 *     outcomes:
 *       clear: The train finished without a blocker.
 *       blocked: A blocker was found; the output names it.
 *     output: The blockers found, each with its work item.
 *     asks:
 *       approve_note: Whether to post the blocker note; yes posts it, no skips it.
 *     sends:
 *       progress: A note after each check; no answer needed.
 *     effects: One script per check reads the release API; about 2 minutes and one model turn per check.
 *     model: azure-openai:gpt-5.6-terra
 *     modelHints:
 *       summarize: { strength: fast, reasoning: low }
 *     ---
 *     How to start it, read its result and handle a failure.
 *
 * The machine half (the input and output schemas, the ways it can end) comes from the definition itself; the card adds
 * the words and must match it (P7): `name` is the definition's name; `outcomes` names exactly its terminal states,
 * `asks` exactly its request states and `sends` exactly its send states; `inputs.example` satisfies its input schema
 * (and is required when it has one); `inputs.schema` and `output.schema`, when a card gives them, are exactly its
 * schemas; each `modelHints` key is one of its agent nodes (OF-S2-7, review OF7-R5: the kind of model that node needs, as
 * structured fields, { strength?: fast | balanced | strong, reasoning?: low | medium | high | xhigh | max, context?: default |
 * long_context, note?: at most 120 characters }, never a provider or model name, so the package works on any deployment; a
 * chat that starts it picks a model from the owning chat's catalog for that node only when the hint asks). A note naming a
 * provider:model, or a model the publisher's catalog has, is refused at publication. The digest covers the card as parsed.
 */

/** A Workflow Definition's name in a package: its directory under workflows/ and its YAML's metadata.name. */
export const WORKFLOW_PACKAGE_DEFINITION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A package name (plugin.json name: a DNS label). */
const PACKAGE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** The most Workflow Definitions one package ships. */
export const WORKFLOW_PACKAGE_MAX_DEFINITIONS = 64;

/**
 * A reference to a package's Workflow Definition (P4, D7): `<package>/<name>`, or `<name>` alone for one in the referring
 * agent's own package (`ownPackage`; null when the referrer has no package, so a bare name names nothing). Null when it is
 * not one.
 */
export function parseWorkflowPackageRef(ref: unknown, ownPackage: string | null = null): { packageName: string; name: string } | null {
    if (typeof ref !== "string") return null;
    const trimmed = ref.trim();
    const slash = trimmed.indexOf("/");
    if (slash < 0) {
        if (!ownPackage || !WORKFLOW_PACKAGE_DEFINITION_NAME.test(trimmed)) return null;
        return { packageName: ownPackage, name: trimmed };
    }
    const packageName = trimmed.slice(0, slash);
    const name = trimmed.slice(slash + 1);
    if (!PACKAGE_NAME.test(packageName) || !WORKFLOW_PACKAGE_DEFINITION_NAME.test(name)) return null;
    return { packageName, name };
}

/** `<package>/<name>`: how a chat names a package definition attached to it (D7; a chat's own names have no slash). */
export function workflowPackageRef(packageName: string, name: string): string {
    return `${packageName}/${name}`;
}

/** The largest card.md. */
export const WORKFLOW_CARD_MAX_BYTES = 32 * 1024;
const TEXT_MAX = 4_000;
const KNOWN_FIELDS = ["name", "description", "whenToUse", "inputs", "outcomes", "output", "asks", "sends", "effects", "model", "modelHints"] as const;
/** A hint note that names a concrete model (provider:model) instead of a kind of model (OF-S2-7: hints are portable). */
const CONCRETE_MODEL = /[A-Za-z][\w.-]*:[A-Za-z0-9][\w.-]*/;

/** OF-S2-7 review OF7-R5: one agent node's model hint, as structured fields (none names a model). */
export interface WorkflowModelHint {
    strength?: "fast" | "balanced" | "strong";
    reasoning?: "low" | "medium" | "high" | "xhigh" | "max";
    context?: "default" | "long_context";
    /** At most WORKFLOW_MODEL_HINT_NOTE_MAX characters; never a provider or model name. */
    note?: string;
}
export const WORKFLOW_MODEL_HINT_STRENGTHS = Object.freeze(["fast", "balanced", "strong"] as const);
export const WORKFLOW_MODEL_HINT_REASONING = Object.freeze(["low", "medium", "high", "xhigh", "max"] as const);
export const WORKFLOW_MODEL_HINT_CONTEXTS = Object.freeze(["default", "long_context"] as const);
export const WORKFLOW_MODEL_HINT_NOTE_MAX = 120;
const HINT_FIELDS = ["strength", "reasoning", "context", "note"] as const;

/** A card's model hints: each a mapping of the structured fields; `problems` gets every reason one is not. */
function modelHintsOf(value: unknown, problems: string[]): { [state: string]: WorkflowModelHint } {
    if (value === undefined || value === null) return {};
    if (!isJsonObject(value)) {
        problems.push("modelHints must map each agent node's id to { strength?, reasoning?, context?, note? }");
        return {};
    }
    const out: { [state: string]: WorkflowModelHint } = {};
    for (const [key, raw] of Object.entries(value)) {
        const field = `modelHints.${key}`;
        if (!isJsonObject(raw)) {
            problems.push(`${field} must be a mapping of strength (fast, balanced, strong), reasoning (low to max), context (default, long_context) `
                + "and note (short words); never a model's name");
            continue;
        }
        const hint: WorkflowModelHint = {};
        let ok = true;
        for (const name of Object.keys(raw)) {
            if (!(HINT_FIELDS as readonly string[]).includes(name)) { problems.push(`${field} has an unknown field '${name}' (fields: ${HINT_FIELDS.join(", ")})`); ok = false; }
        }
        const pick = (name: "strength" | "reasoning" | "context", allowed: readonly string[]) => {
            const given = raw[name];
            if (given === undefined || given === null) return;
            if (typeof given !== "string" || !allowed.includes(given)) {
                problems.push(`${field}.${name} must be one of ${allowed.join(", ")}`);
                ok = false;
                return;
            }
            (hint as Record<string, string>)[name] = given;
        };
        pick("strength", WORKFLOW_MODEL_HINT_STRENGTHS);
        pick("reasoning", WORKFLOW_MODEL_HINT_REASONING);
        pick("context", WORKFLOW_MODEL_HINT_CONTEXTS);
        if (raw.note !== undefined && raw.note !== null) {
            const note = typeof raw.note === "string" ? raw.note.trim() : "";
            if (!note) { problems.push(`${field}.note must be text`); ok = false; }
            else if (note.length > WORKFLOW_MODEL_HINT_NOTE_MAX) { problems.push(`${field}.note is longer than ${WORKFLOW_MODEL_HINT_NOTE_MAX} characters`); ok = false; }
            else if (CONCRETE_MODEL.test(note)) {
                problems.push(`${field}.note names a model ("${note.slice(0, 80)}"); say the kind of model with strength, reasoning and context, `
                    + "never a provider or model name");
                ok = false;
            } else hint.note = note;
        }
        if (ok && Object.keys(hint).length === 0) {
            problems.push(`${field} is empty: give at least one of strength, reasoning, context or note`);
            ok = false;
        }
        if (ok) out[key] = hint;
    }
    return out;
}

/** A model hint in words: "strong model · high reasoning · long context · reads the whole diff". */
export function workflowModelHintWords(hint: WorkflowModelHint): string {
    return [hint.strength ? `${hint.strength} model` : null, hint.reasoning ? `${hint.reasoning} reasoning` : null,
        hint.context ? (hint.context === "long_context" ? "long context" : "default context") : null, hint.note ?? null].filter(Boolean).join(" · ");
}

/**
 * Whether `text` names one of `names` (a model's id or name), ignoring case: anywhere it is not part of a longer word of
 * letters and digits. Review D2: ".", "-" and "_" end a name too, so "claude-opus-5." and "gpt-5.6-terra-like" name it.
 */
function namesAModel(text: string, names: readonly string[]): string | null {
    const lower = text.toLowerCase();
    for (const name of names) {
        const wanted = name.trim().toLowerCase();
        if (wanted.length < 3) continue;
        let at = lower.indexOf(wanted);
        while (at >= 0) {
            const before = at === 0 ? "" : lower[at - 1];
            const after = lower[at + wanted.length] ?? "";
            if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return name;
            at = lower.indexOf(wanted, at + 1);
        }
    }
    return null;
}

/** A card as a package exports it (and the registry keeps it in the manifest). */
export interface WorkflowCard {
    name: string;
    description: string;
    whenToUse: string;
    inputs: { example: JsonValue | null; schema: JsonValue | null };
    outcomes: { [terminal: string]: string };
    output: { about: string | null; schema: JsonValue | null };
    asks: { [state: string]: string };
    sends: { [state: string]: string };
    effects: string;
    model: string | null;
    /**
     * OF-S2-7: per agent node (its state id), the kind of model it needs (structured; OF7-R5); present only when the card
     * gives any (a card without hints keeps the digest it had).
     */
    modelHints?: { [state: string]: WorkflowModelHint };
    notes: string;
}

/** The machine half a card is checked against, from the compiled definition. */
export interface WorkflowCardInterface {
    inputSchema: JsonValue | null;
    outputSchema: JsonValue | null;
    /** Each terminal state (not in a parallel body) with how it ends: succeeded, blocked, failed or cancelled. */
    outcomes: { [terminal: string]: string };
    asks: string[];
    sends: string[];
}

/**
 * Stage 2 review S2SF-F4: what a definition does that its YAML shows, whatever its card says: its script steps (code that
 * runs on a worker) and its agent steps (each asks a model). The card's `effects` are the author's words; these are read
 * from the definition itself.
 */
export interface WorkflowEffectFacts {
    scripts: string[];
    agents: string[];
}

/** The checked facts of a compiled definition (its script and agent steps, by id, sorted). */
export function workflowEffectFacts(ir: WorkflowIR): WorkflowEffectFacts {
    const scripts: string[] = [];
    const agents: string[] = [];
    for (const node of Object.values(ir.nodes)) {
        if (node.type === "script") scripts.push(node.id);
        if (node.type === "agent") agents.push(node.id);
    }
    return { scripts: scripts.sort(), agents: agents.sort() };
}

/** The checked facts in words, as the picker and a chat read them. */
export function workflowEffectFactsWords(facts: WorkflowEffectFacts): string {
    const steps = (ids: string[]) => ids.slice(0, 8).join(", ") + (ids.length > 8 ? ` and ${ids.length - 8} more` : "");
    const scripts = facts.scripts.length
        ? `it runs scripts (${facts.scripts.length === 1 ? "step" : "steps"} ${steps(facts.scripts)}). A script runs code on a worker: it can reach the `
            + "network, and use the tools of the chat that starts it, which can read and write files and run processes"
        : "it runs no scripts";
    const agents = facts.agents.length
        ? `${facts.scripts.length ? ". It" : "; it"} has agent steps (${steps(facts.agents)}): each one asks a model`
        : `${facts.scripts.length ? ". It" : " and"} has no agent steps`;
    return `Checked from the definition: ${scripts}${agents}.`;
}

/** A card's effects that say the Workflow runs no scripts (checked against its script steps at publication). */
const NO_SCRIPTS_CLAIM = /\b(?:no|without(?:\s+any)?|zero|never\s+runs?(?:\s+any)?)\s+scripts?\b/i;

function text(value: unknown, field: string, problems: string[], required: boolean): string | null {
    if (value === undefined || value === null) {
        if (required) problems.push(`${field} is required`);
        return null;
    }
    if (typeof value !== "string" || !value.trim()) {
        problems.push(`${field} must be text`);
        return null;
    }
    if (value.length > TEXT_MAX) problems.push(`${field} is longer than ${TEXT_MAX} characters`);
    return value.trim();
}

function wordsMap(value: unknown, field: string, problems: string[]): { [key: string]: string } {
    if (value === undefined || value === null) return {};
    if (!isJsonObject(value)) {
        problems.push(`${field} must map each state's id to words about it`);
        return {};
    }
    const out: { [key: string]: string } = {};
    for (const [key, words] of Object.entries(value)) {
        const checked = text(words, `${field}.${key}`, problems, true);
        if (checked !== null) out[key] = checked;
    }
    return out;
}

function jsonValue(value: unknown, field: string, problems: string[]): JsonValue | null {
    if (value === undefined || value === null) return null;
    try {
        assertJsonValue(value, field);
        return value;
    } catch (error) {
        problems.push(`${field} is not plain JSON data (${error instanceof Error ? error.message : String(error)})`);
        return null;
    }
}

function schemaValue(value: unknown, field: string, problems: string[]): JsonValue | null {
    const plain = jsonValue(value, field, problems);
    if (plain === null) return null;
    try {
        return normalizeSchema(plain, field);
    } catch (error) {
        problems.push(`${field} is not a workflow JSON Schema (${error instanceof Error ? error.message : String(error)})`);
        return null;
    }
}

/** Parse card.md: its front matter fields and its body. Problems say what is wrong; there is no card when there is any. */
export function parseWorkflowCard(source: string): { card: WorkflowCard | null; problems: string[] } {
    const problems: string[] = [];
    if (typeof source !== "string") return { card: null, problems: ["card.md is not text"] };
    if (Buffer.byteLength(source, "utf8") > WORKFLOW_CARD_MAX_BYTES) return { card: null, problems: [`card.md is larger than ${WORKFLOW_CARD_MAX_BYTES} bytes`] };
    const normalized = source.replace(/\r\n/g, "\n");
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
    if (!match) return { card: null, problems: ["card.md must start with front matter between two '---' lines"] };
    let meta: unknown;
    try {
        meta = parseYaml(match[1], { maxAliasCount: 0, prettyErrors: false });
    } catch (error) {
        return { card: null, problems: [`card.md front matter is not valid YAML (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`] };
    }
    if (!isJsonObject(meta)) return { card: null, problems: ["card.md front matter must be a mapping of fields"] };
    for (const key of Object.keys(meta)) {
        if (!(KNOWN_FIELDS as readonly string[]).includes(key)) problems.push(`card.md has an unknown field '${key}' (fields: ${KNOWN_FIELDS.join(", ")})`);
    }
    const name = text(meta.name, "name", problems, true);
    const description = text(meta.description, "description", problems, true);
    const whenToUse = text(meta.whenToUse, "whenToUse", problems, true);
    const effects = text(meta.effects, "effects", problems, true);
    const model = text(meta.model, "model", problems, false);
    let inputs: WorkflowCard["inputs"] = { example: null, schema: null };
    if (meta.inputs !== undefined && meta.inputs !== null) {
        if (!isJsonObject(meta.inputs)) problems.push("inputs must be a mapping of example and optionally schema");
        else {
            for (const key of Object.keys(meta.inputs)) if (!["example", "schema"].includes(key)) problems.push(`inputs has an unknown field '${key}'`);
            inputs = { example: jsonValue(meta.inputs.example, "inputs.example", problems), schema: schemaValue(meta.inputs.schema, "inputs.schema", problems) };
        }
    }
    let output: WorkflowCard["output"] = { about: null, schema: null };
    if (typeof meta.output === "string") output = { about: text(meta.output, "output", problems, true), schema: null };
    else if (meta.output !== undefined && meta.output !== null) {
        if (!isJsonObject(meta.output)) problems.push("output must be words, or a mapping of about and schema");
        else {
            for (const key of Object.keys(meta.output)) if (!["about", "schema"].includes(key)) problems.push(`output has an unknown field '${key}'`);
            output = { about: text(meta.output.about, "output.about", problems, false), schema: schemaValue(meta.output.schema, "output.schema", problems) };
        }
    }
    const outcomes = wordsMap(meta.outcomes, "outcomes", problems);
    if (meta.outcomes === undefined || meta.outcomes === null) problems.push("outcomes is required: each way the Workflow can end, with words about it");
    const asks = wordsMap(meta.asks, "asks", problems);
    const sends = wordsMap(meta.sends, "sends", problems);
    const modelHints = modelHintsOf(meta.modelHints, problems);
    const notes = match[2].trim();
    if (notes.length > WORKFLOW_CARD_MAX_BYTES) problems.push("the card's notes are too long");
    if (problems.length > 0) return { card: null, problems };
    return {
        card: { name: name!, description: description!, whenToUse: whenToUse!, inputs, outcomes, output, asks, sends, effects: effects!, model,
            ...(Object.keys(modelHints).length ? { modelHints } : {}), notes },
        problems,
    };
}

/** The machine half of a compiled definition that its card must match. */
export function workflowCardInterface(ir: WorkflowIR): WorkflowCardInterface {
    const inBody = new Set<string>();
    for (const node of Object.values(ir.nodes)) if (node.type === "parallel") for (const id of node.body.states) inBody.add(id);
    const outcomes: { [terminal: string]: string } = {};
    const asks: string[] = [];
    const sends: string[] = [];
    for (const node of Object.values(ir.nodes)) {
        if (node.type === "terminal" && !inBody.has(node.id)) outcomes[node.id] = node.outcome;
        if (node.type === "messaging" && node.mode === "request") asks.push(node.id);
        if (node.type === "messaging" && node.mode === "send") sends.push(node.id);
    }
    return {
        inputSchema: workflowResolvedInputsSchema(ir),
        outputSchema: ir.outputSchema ? workflowResolvedInputsSchema({ inputsSchema: ir.outputSchema, schemaDefs: ir.schemaDefs }) : null,
        outcomes, asks: asks.sort(), sends: sends.sort(),
    };
}

function coverProblems(field: string, given: readonly string[], wanted: readonly string[], what: string): string[] {
    const problems: string[] = [];
    const missing = wanted.filter(id => !given.includes(id));
    const extra = given.filter(id => !wanted.includes(id));
    if (missing.length) problems.push(`${field} does not describe ${what} ${missing.map(id => `'${id}'`).join(", ")}`);
    if (extra.length) problems.push(`${field} names ${extra.map(id => `'${id}'`).join(", ")}, which ${extra.length === 1 ? "is not" : "are not"} ${what} of the definition`);
    return problems;
}

/**
 * Why a card does not match its compiled definition (empty when it matches). `knownModelNames` (OF7-R5): the model ids and
 * names of the publisher's catalog; a hint's note that names one is refused.
 */
export function workflowCardMismatches(card: WorkflowCard, ir: WorkflowIR, options: { knownModelNames?: readonly string[] } = {}): string[] {
    const problems: string[] = [];
    const face = workflowCardInterface(ir);
    if (card.name !== ir.name) problems.push(`the card's name is ${card.name}, the definition's ${ir.name}`);
    problems.push(...coverProblems("outcomes", Object.keys(card.outcomes), Object.keys(face.outcomes), "terminal state"));
    problems.push(...coverProblems("asks", Object.keys(card.asks), face.asks, "request state"));
    problems.push(...coverProblems("sends", Object.keys(card.sends), face.sends, "send state"));
    if (face.inputSchema !== null) {
        if (card.inputs.example === null) problems.push("inputs.example is required: the definition takes inputs, so show one filled example");
        else if (ir.inputsSchema) {
            try {
                const found = new WorkflowSchemaSet(ir.schemaDefs).validate(ir.inputsSchema, card.inputs.example);
                if (found.length) problems.push(`inputs.example does not satisfy the definition's input schema: ${found.slice(0, 3).map(p => `${p.path} ${p.message}`).join("; ")}`);
            } catch (error) {
                problems.push(`inputs.example could not be checked (${error instanceof WorkflowSchemaError ? error.message : String(error)})`);
            }
        }
    }
    if (card.inputs.schema !== null && canonicalJson(card.inputs.schema) !== canonicalJson(face.inputSchema)) {
        problems.push("inputs.schema is not exactly the definition's input schema (leave it out; the card shows the definition's own)");
    }
    if (card.output.schema !== null && canonicalJson(card.output.schema) !== canonicalJson(face.outputSchema)) {
        problems.push("output.schema is not exactly the definition's output schema (leave it out; the card shows the definition's own)");
    }
    // S2SF-F4: an effects claim the definition contradicts, where it can be checked: "no scripts" with script steps.
    const facts = workflowEffectFacts(ir);
    // OF-S2-7: a model hint is for an agent node of the definition (by its state id); it need not cover every one.
    const notAgents = Object.keys(card.modelHints ?? {}).filter(id => !facts.agents.includes(id));
    if (notAgents.length) {
        problems.push(`modelHints names ${notAgents.map(id => `'${id}'`).join(", ")}, which ${notAgents.length === 1 ? "is not an agent node" : "are not agent nodes"} `
            + `of the definition${facts.agents.length ? ` (its agent nodes: ${facts.agents.join(", ")})` : " (it has no agent nodes)"}`);
    }
    for (const [key, hint] of Object.entries(card.modelHints ?? {})) {
        const named = hint.note ? namesAModel(hint.note, options.knownModelNames ?? []) : null;
        if (named) {
            problems.push(`modelHints.${key}.note names the model ${named}; say the kind of model with strength, reasoning and context, never a model's name`);
        }
    }
    if (facts.scripts.length && NO_SCRIPTS_CLAIM.test(card.effects)) {
        problems.push(`effects says it runs no scripts, but the definition has script ${facts.scripts.length === 1 ? "step" : "steps"} `
            + `${facts.scripts.join(", ")}: say what the scripts do`);
    }
    return problems;
}

/** The card's digest: of the card as parsed and the machine half it matched. */
export function workflowCardDigest(card: WorkflowCard, face: WorkflowCardInterface): string {
    return sha256Hex(canonicalJson({ card: card as unknown as JsonValue, interface: face as unknown as JsonValue }));
}

/** The note a card gets when its stored model hints are in an older form (review D5): they are left out, the Workflow stays. */
export const WORKFLOW_OLD_MODEL_HINTS_NOTE = "This card's model hints are in an older form, so they are not shown: its agent nodes use the "
    + "model of the chat that starts it. Publish the package again to give them as strength, reasoning, context and note.";

/** A card record as the manifest keeps it, checked again; null when it is not well formed. */
export function readWorkflowCard(value: unknown): WorkflowCard | null {
    if (!isJsonObject(value)) return null;
    const v = value as JsonObject;
    const str = (x: unknown) => typeof x === "string";
    const map = (x: unknown) => isJsonObject(x) && Object.values(x).every(str);
    if (!str(v.name) || !str(v.description) || !str(v.whenToUse) || !str(v.effects) || !str(v.notes)) return null;
    if (!map(v.outcomes) || !map(v.asks) || !map(v.sends)) return null;
    if (!isJsonObject(v.inputs) || !isJsonObject(v.output)) return null;
    if (v.model !== null && !str(v.model)) return null;
    // Review D5: a card published with the older free-word hints (1.4.4) keeps its Workflow: those hints are left out, and
    // its notes say so once.
    let modelHints: { [state: string]: WorkflowModelHint } | undefined;
    let hintsNote: string | null = null;
    if (v.modelHints !== undefined) {
        const problems: string[] = [];
        modelHints = modelHintsOf(v.modelHints, problems);
        if (problems.length) hintsNote = WORKFLOW_OLD_MODEL_HINTS_NOTE;
    }
    return {
        name: v.name as string, description: v.description as string, whenToUse: v.whenToUse as string, effects: v.effects as string,
        notes: hintsNote ? [v.notes as string, hintsNote].filter(Boolean).join("\n\n") : v.notes as string, model: (v.model as string | null) ?? null,
        ...(modelHints && Object.keys(modelHints).length ? { modelHints } : {}),
        outcomes: { ...(v.outcomes as { [k: string]: string }) }, asks: { ...(v.asks as { [k: string]: string }) }, sends: { ...(v.sends as { [k: string]: string }) },
        inputs: { example: (v.inputs.example ?? null) as JsonValue | null, schema: (v.inputs.schema ?? null) as JsonValue | null },
        output: { about: typeof v.output.about === "string" ? v.output.about : null, schema: (v.output.schema ?? null) as JsonValue | null },
    };
}

function compact(value: JsonValue | null, limit = 1_500): string {
    const textValue = JSON.stringify(value);
    return textValue.length > limit ? `${textValue.slice(0, limit)}… (cut)` : textValue;
}

/**
 * The card as a chat reads it: what the Workflow does, what it needs and how it ends. `facts` (S2SF-F4): what the
 * definition itself shows of its effects, said whatever the card says; the card's effects are labeled as its author's words.
 */
export function workflowCardWords(ref: string, semver: string | null, card: WorkflowCard, face: WorkflowCardInterface | null,
    facts: WorkflowEffectFacts | null = null): string {
    const lines: string[] = [];
    lines.push(`${ref}${semver ? ` ${semver}` : ""}: ${card.description}`);
    lines.push(`When to use it: ${card.whenToUse}`);
    if (face?.inputSchema != null) lines.push(`Inputs (JSON Schema): ${compact(face.inputSchema)}`);
    lines.push(card.inputs.example !== null ? `Example inputs: ${compact(card.inputs.example)}` : "Inputs: none.");
    const ends = Object.entries(card.outcomes).map(([id, words]) => `${id}${face?.outcomes[id] ? ` (${face.outcomes[id]})` : ""}: ${words}`);
    lines.push(`It ends: ${ends.join("; ")}`);
    if (card.output.about) lines.push(`Output: ${card.output.about}`);
    if (face?.outputSchema != null) lines.push(`Output (JSON Schema): ${compact(face.outputSchema)}`);
    if (Object.keys(card.asks).length) lines.push(`It asks this chat: ${Object.entries(card.asks).map(([id, words]) => `${id}: ${words}`).join("; ")}`);
    if (Object.keys(card.sends).length) lines.push(`It sends this chat: ${Object.entries(card.sends).map(([id, words]) => `${id}: ${words}`).join("; ")}`);
    if (facts) lines.push(workflowEffectFactsWords(facts));
    lines.push(`Effects (the author's words): ${card.effects}`);
    // OF-S2-7: what the author says some agent nodes need; every other agent node uses the starting chat's model.
    lines.push(workflowCardModelHintsWords(card));
    if (card.notes) lines.push(`Notes:\n${card.notes}`);
    return lines.join("\n");
}

/**
 * OF-S2-7: a card's model hints as a chat reads them, and what to do with them (its agent nodes use the starting chat's
 * model unless a start chooses one).
 */
export function workflowCardModelHintsWords(card: Pick<WorkflowCard, "modelHints">): string {
    const hints = Object.entries(card.modelHints ?? {});
    if (!hints.length) return "Models: its agent nodes use the model of the chat that starts it; no node asks for another.";
    return `Model hints (by agent node): ${hints.map(([id, hint]) => `${id}: ${workflowModelHintWords(hint)}`).join("; ")}. For a node with a hint, `
        + "choose a model that fits it from list_available_models (the owning chat's catalog) and give it in agent_models at start; every other "
        + "agent node uses the model of the chat that starts it.";
}

/**
 * P3: the coordinating chat's instructions. A chat made from the new-session picker for a package definition has that
 * definition attached, locked, and these instructions: read the card; learn its inputs and outputs; ask the person for a
 * missing input; start it; answer its requests; report its result.
 */
export function coordinatingInstructions(ref: string, semver: string, card: WorkflowCard, face: WorkflowCardInterface | null,
    facts: WorkflowEffectFacts | null = null): string {
    return [
        `This chat coordinates one Workflow Definition: ${ref} (package version ${semver}). It is attached to this chat and locked: `
            + "nobody changes it here. A person can make an editable copy of it in the Workflow tab.",
        "Its interface card:",
        workflowCardWords(ref, semver, card, face, facts),
        "What you do:",
        "1. Learn from the card what the Workflow needs (its inputs) and what it gives back (how it ends, and its output).",
        "2. Ask the person for each input you do not have. Do not make up an input.",
        `3. Start it with workflow_definition: operation "start", name "${ref}", and the inputs. Leave agent_models out unless the person asks `
            + "for a model, or a model hint above asks for a kind of model: then choose from list_available_models and say what you chose.",
        "4. While it runs, answer its requests and messages. When an answer is the person's to give, ask the person.",
        "5. When it ends, tell the person how it ended and what it gave back, in plain words.",
        "To run it again, start it again. Do not start a second Workflow while one is running unless the person asks.",
    ].join("\n");
}
