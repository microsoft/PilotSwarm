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
        + "(notify_on_completion=false skips that). For recurring or polling work, loop inside one workflow (a v2 wait state, or v1 transition.delaySeconds); "
        + "never use cron or cron_at to call spawn_workflow on each wake-up: each call starts another workflow. "
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
        + "Version 2 (apiVersion: pilotswarm.dev/v2-draft) definitions belong to this chat, with revisions: spawn_workflow is kept for one release, "
        + "and workflow_definition (list, read, save, start) replaces it. Here a v2 YAML is saved as the next revision of this chat's definition "
        + "named by its metadata.name (refused when someone saved a revision you have not read: read it with workflow_definition and redo your "
        + "change); with state: published and start: true that revision is also started as a new Workflow (each start is another Workflow, and "
        + "many Workflows of one definition may run at once). A revision with errors is saved with "
        + "them and does not start. "
        + "Use update_workflow on a Workflow to set_vars (the run's open KV, read as context.kv), "
        + "pause, resume or cancel its run, or recover a run that read_workflow shows as needsRecovery; "
        + "read_workflow shows definition, graph and runs and changes nothing. "
        + "V2 states: script (source, optional input binding, inputSchema/outputSchema, transition.next routes; runtime errors route by code or 'failure'), "
        + "wait (seconds: an integer from 1 to 86400 or one ${...} binding, read once when the state is entered; a durable timer in the workflow, never a script sleep; "
        + "it routes 'elapsed' with its input, or the input binding's value, as output; a bad seconds value is invalid_input) "
        + "messaging (mode: receive; contract: a root contracts entry Name@version: {schema}; optional from: {parent: true} or a session id; "
        + "optional correlate: {key: value or binding}; optional wait: {seconds}): it takes one typed message that a session gave the run with send_workflow_input, "
        + "before or after the state was entered, and routes 'received' with the message as output, or 'elapsed' with its input when its wait comes first; "
        + "messaging (mode: send; contract; recipient: {parent: true} or a session id; optional correlate: {key: value or binding}; the message is "
        + "the state's input, or its input binding's value, at most 16 KB and valid for the contract's schema): it sends one typed message to the "
        + "workflow's parent, to an agent session of the same user (its session queue; delivery is at least once, so a session may see a message "
        + "twice) or to a workflow of the same user (typed input for one of its receive states, which match the correlation; accepted once), "
        + "decided when the state is entered and again when it is delivered, and routes 'sent' with the delivery receipt as output once the "
        + "recipient accepted the message (accepted, not read), or unavailable, forbidden, unsupported_contract (a workflow that takes no such "
        + "message) or delivery_failed; mode request is not supported yet), "
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
                description: "Tell this session the result when the workflow ends. Default true. "
                    + "If a parent session waits for your answer, pass false and check the run with read_workflow after each wait until it "
                    + "ends: the end notice would start a new turn, and your parent would get your answer twice.",
            },
            key: {
                type: "string",
                description:
                    "Optional idempotency key. The same key in this session always names the same workflow session, "
                    + "so a repeated call returns it instead of starting another run. Omit it to start a new run each call. "
                    + "To start another Workflow of a v2 definition, use workflow_definition start; never rename the definition to start another.",
            },
            state: {
                type: "string",
                enum: ["draft", "published"],
                description: "v2 only: draft (default: save the revision, start nothing) or published (with start: true, also start it).",
            },
            start: {
                type: "boolean",
                description: "v2 only, with state: published: also start the saved revision as a new Workflow with inputs. Use it when the person asks to run it now.",
            },
            vars: {
                type: "object",
                description: "v2 only, with start: the live run's initial open KV map (any keys, JSON values); states read it as context.kv or ${kv.key}.",
            },
            agent_models: {
                type: "object",
                description: "v2 only, with start, optional (OF-S2-7): agent node id (its key under states:; one key for all items of a For each) → "
                    + "{ model: exact provider:model from list_available_models (the owning chat's catalog), reasoning_effort?, context_tier? }. Leave it out so every agent node "
                    + "uses this chat's model, reasoning and context; give it only when the person asks for a model, or a package card's hint asks "
                    + "for a kind of model, and say what you chose.",
            },
        },
        required: ["yaml"],
    },
} as const;

/**
 * spawn_workflow as a turn of a worker that runs controller 1.9.0 shows it
 * (R26, T125; INACTIVE: only tests register such a worker): its definitions
 * may also hold request, agent and parallel states, so the description says
 * so instead of "mode request is not supported yet". Every other turn keeps
 * SPAWN_WORKFLOW_TOOL_SPEC byte for byte.
 */
export const SPAWN_WORKFLOW_MILESTONE_TOOL_SPEC = {
    description: SPAWN_WORKFLOW_TOOL_SPEC.description.replace("; mode request is not supported yet)", ")")
        + " This host also compiles and runs: messaging (mode: request; contract with response: {schema}; recipient; timeoutSeconds 1-86400 "
        + "or one binding; the payload is the state's input): one typed request that its recipient answers with respond_session_request, "
        + "routing 'responded' with the response or 'declined' with {reason}, and timed_out at its deadline (write input, not request, and "
        + "timed_out, not timeout); agent (invoke: {prompt: <task>} or {agent: {name, package?, version?}}; timeoutSeconds; optional input, "
        + "inputSchema, outputSchema, outcomes, chat): an ordinary child agent session that finishes the state only with complete_workflow_node, "
        + "routing one of its outcomes, needs_input, execution_failed or timed_out; chat: new (default) gives each visit a new chat (clean, "
        + "cheaper; for independent visits), chat: continue keeps one chat across the state's visits in the Workflow, each later visit arriving "
        + "as cycle N with the input, the variables now, which changed and the previous result (for memory of earlier cycles; its context "
        + "grows; refused in a parallel body; each completion gives node_execution_id); and parallel (forEach: one binding or a list of at most 64 "
        + "items; concurrency 1-16, default 1; join: all (or all_required; every branch) or {first: k} (joined at the first k successes); "
        + "failFast; optional timeoutSeconds, which needs a timed_out route; body: {initial, states}): one branch per item through its body, "
        + "whose states read ${branch.item} and ${branch.index}, routing 'joined' with the branch outputs in order (with {first: k}, "
        + "[{index, output}] of the first k, in the order their successes were stored, the others cancelled), 'blocked' with every branch's result "
        + "once k successes can no longer happen, or timed_out when fewer than k successes were stored by its time limit. "
        + "Instead of forEach and body, a parallel state may give named branches: {<name>: {initial, states, input?}}, each its own graph "
        + "(its states also read ${branch.name}), joined as {<name>: output} (with {first: k}, the winners only). "
        + "A wait may give at instead of seconds (at: {minute, hour?, day_of_week? or day_of_month? (each with hour), tz: an IANA zone}): "
        + "it waits until the next such time in that zone (daylight saving included), decided when the state is entered.",
    parameters: SPAWN_WORKFLOW_TOOL_SPEC.parameters,
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
    /** v2 documents only, with start (OF-S2-7): agent node models by state id. */
    agent_models?: Record<string, unknown>;
}
