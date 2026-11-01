/**
 * spawn_workflow — the declaration and the per-turn handler both build from
 * this one spec, so the schema the model sees cannot drift from the one the
 * handler accepts.
 */
export const SPAWN_WORKFLOW_TOOL_SPEC = {
    description:
        "Start a workflow session as a child of this session: a durable state machine that runs without an LLM. "
        + "When the user describes steps, branches or loops in words, translate them into Workflow YAML and pass it as yaml. "
        + "Returns at once with the workflow session id; this session receives the result as a system message when the workflow ends "
        + "(notify_on_completion=false skips that). For a recurring workflow, set cron or cron_at and call spawn_workflow on each wake-up. "
        + "A workflow's result is not a cue to start another run: starting one from each result loops forever.\n"
        + "YAML shape (this version runs script and terminal states):\n"
        + "apiVersion: pilotswarm.dev/v1alpha1\n"
        + "kind: Workflow\n"
        + "metadata: { name: <name>, version: 1.0.0 }\n"
        + "inputs:                    # optional schema for the inputs argument\n"
        + "  <input>: { type: string, required: true }   # string|number|integer|boolean|object|array\n"
        + "initial: <first state id>\n"
        + "states:\n"
        + "  <state id>:               # letter, then letters, digits, _ or -\n"
        + "    type: script\n"
        + "    runtime: node           # new workflows are JavaScript-only\n"
        + "    timeoutSeconds: 300     # optional, 1-3600\n"
        + "    source: |\n"
        + "      const previous = context.input;  // previous state's output, null initially\n"
        + "      await setResult('success', { previous, inputs: context.inputs });\n"
        + "    completion: { outcomes: [success, failure] }\n"
        + "    transition:\n"
        + "      next: { success: <state id>, failure: <state id> }   # one target per declared outcome\n"
        + "      delaySeconds: { success: 30 }   # optional controller delay after an outcome, integer 1-3600\n"
        + "  done:\n"
        + "    type: terminal\n"
        + "    outcome: succeeded      # succeeded | blocked | failed | cancelled\n"
        + "    summary: <optional one line>\n"
        + "    output: ${states.<state id>.result}   # optional; or ${inputs.x}; quote it inside { }\n"
        + "Every run must end at a terminal state. "
        + "For a finite watcher, loop unchanged outcomes with delaySeconds and end on the first meaningful change or an explicit poll-count limit. "
        + "Unchanged polls do not wake this session; only completion does. A completed watcher does not restart itself. "
        + "In a script, `context` holds inputs, input (the previous state's output), node (the state id), step, workflow and sessionId. "
        + "Use `context.input`, not bare `input` or `context.result`; only `context`, `callTool` and `setResult` are provided. "
        + "Each script is a Node ES module: await setResult(...) is valid at top level; return is not. "
        + "Carry any earlier data you need in each state's output; scripts do not get a states.<id>.result object. "
        + "Use await callTool(name, args) to invoke the parent's permitted Copilot-native, application and MCP tools as this workflow child. "
        + "The captured tool set excludes scheduling, delegation, lifecycle and capability changes. Native bash, file, search and edit tools use the normal CLI permission path. "
        + "MCP names may use \"<server>/<tool>\" when unambiguous. Tool access can be revoked while the run is active. "
        + "Scripts cannot call wait, schedule, ask the user or spawn agents. "
        + "Workflows CAN wait durably through transition.delaySeconds after a state returns: the controller owns the restart-safe timer, with no LLM turn. "
        + "Do not use sleep or JavaScript timers for a workflow delay. "
        + "Direct filesystem access is limited to temporary scratch by Node permissions; this is not a hostile-code or network sandbox. "
        + "Use tools for workspace operations. Native shell handles last only for one script state and are stopped before it finishes. "
        + "Report a state's result with await setResult(outcome, output), "
        + "or print one final JSON line {\"outcome\": ..., \"output\": ...}. Without a report, exit code 0 is outcome success (output = stdout), "
        + "any other exit code is failure, and running past the timeout is timeout. An outcome not declared in completion.outcomes fails the workflow. "
        + "Outputs are JSON and at most 256 KB; store larger data as an artifact or fact and pass its key. "
        + "New top-level workflows are not supported: start from this agent so the tool grant has a parent. "
        + "The workflow is your child: stop it with cancel_agent or delete_agent; it takes no messages.\n"
        + "Version 2 (apiVersion: pilotswarm.dev/v2-draft) adds review before execution: spawn_workflow saves a DRAFT that runs nothing "
        + "(state: published publishes revision 1; add start: true to also start its one live run). Drafts may be invalid and come back with diagnostics. "
        + "Use update_workflow to replace the draft, publish the exact reviewed definitionHash, start, set_vars (the run's open KV, read as context.kv), "
        + "pause, resume or cancel the run, or recover a run that read_workflow shows as needsRecovery; "
        + "read_workflow shows definition, graph and runs and changes nothing. "
        + "V2 states: script (source, optional input binding, inputSchema/outputSchema, transition.next routes; runtime errors route by code or 'failure'), "
        + "wait (seconds: an integer from 1 to 86400 or one ${...} binding, read once when the state is entered; a durable timer in the workflow, never a script sleep; "
        + "it routes 'elapsed' with its input, or the input binding's value, as output; a bad seconds value is invalid_input) "
        + "messaging (mode: receive; contract: a root contracts entry Name@version: {schema}; optional from: {parent: true} or a session id; "
        + "optional correlate: {key: value or binding}; optional wait: {seconds}): it takes one typed message that a session gave the run with send_workflow_input, "
        + "before or after the state was entered, and routes 'received' with the message as output, or 'elapsed' with its input when its wait comes first; "
        + "messaging (mode: send; contract; recipient: {parent: true} or a session id; the message is the state's input, or its input binding's value, "
        + "at most 16 KB and valid for the contract's schema): it sends one typed message to the workflow's parent or to an agent session of the same user, "
        + "decided when the state is entered and again when it is delivered, and routes 'sent' with the delivery receipt as output once the recipient's "
        + "session queue accepted the message (accepted, not read; delivery is at least once, so a recipient may see a message twice), "
        + "or unavailable, forbidden, unsupported_contract (a workflow session) or delivery_failed; mode request is not supported yet), "
        + "and terminal (outcome, output binding). Bindings are whole-string ${inputs.x}, ${input.x}, ${kv.x} (the KV snapshot the state was admitted with) or ${runtime.error}; schemas are JSON Schema 2020-12 under schemas, referenced as {$ref: '#/schemas/Name'}. "
        + "A v2 script reports its result with await setResult(outcome, output) (or a final stdout line {\"outcome\": ..., \"output\": ...}); "
        + "values must be plain JSON (no NaN, Infinity, undefined, getters, Date or class instances), otherwise the state fails with invalid_output; "
        + "a script that exits non-zero without reporting a result fails with execution_failed. "
        + "An optional root catchAll: <state> names the state that a runtime error goes to when its own state has no route for it (no route for its code and no failure route), "
        + "including a terminal state's invalid output; it runs at most once per run, by any route, and an unhandled error after that, or another route into it, fails the run.",
    parameters: {
        type: "object",
        properties: {
            yaml: {
                type: "string",
                description: "The complete Workflow YAML document (kind: Workflow).",
            },
            inputs: {
                type: "object",
                description: "Optional JSON object every script reads as context.inputs; checked against the workflow's inputs schema.",
            },
            notify_on_completion: {
                type: "boolean",
                description: "Tell this session the result when the workflow ends. Default true.",
            },
            key: {
                type: "string",
                description:
                    "Optional idempotency key. The same key in this session always names the same workflow session, "
                    + "so a repeated call returns it instead of starting another run. Omit it to start a new run each call.",
            },
            state: {
                type: "string",
                enum: ["draft", "published"],
                description: "v2 only: draft (default, runs nothing) or published (immutable revision 1).",
            },
            start: {
                type: "boolean",
                description: "v2 only, with state: published: also start the live run with inputs.",
            },
            vars: {
                type: "object",
                description: "v2 only, with start: the live run's initial open KV map (any keys, JSON values); states read it as context.kv or ${kv.key}.",
            },
        },
        required: ["yaml"],
    },
} as const;

export interface SpawnWorkflowToolArgs {
    yaml: string;
    inputs?: Record<string, unknown>;
    notify_on_completion?: boolean;
    key?: string;
    /** v2 documents only. */
    state?: "draft" | "published";
    /** v2 documents only, with state: published. */
    start?: boolean;
    /** v2 documents only, with start: the run's initial open KV. */
    vars?: Record<string, unknown>;
}
