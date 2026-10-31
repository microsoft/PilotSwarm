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
        + "      <script>\n"
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
        + "Use await callTool(name, args) to invoke the parent's permitted Copilot-native, application and MCP tools as this workflow child. "
        + "The captured tool set excludes scheduling, delegation, lifecycle and capability changes. Native bash, file, search and edit tools use the normal CLI permission path. "
        + "MCP names may use \"<server>/<tool>\" when unambiguous. Tool access can be revoked while the run is active. "
        + "Scripts cannot wait, schedule, ask the user or spawn agents. Direct filesystem access is limited to temporary scratch by Node permissions; this is not a hostile-code or network sandbox. "
        + "Use tools for workspace operations. Native shell handles last only for one script state and are stopped before it finishes. "
        + "Report a state's result with await setResult(outcome, output), "
        + "or print one final JSON line {\"outcome\": ..., \"output\": ...}. Without a report, exit code 0 is outcome success (output = stdout), "
        + "any other exit code is failure, and running past the timeout is timeout. An outcome not declared in completion.outcomes fails the workflow. "
        + "Outputs are JSON and at most 256 KB; store larger data as an artifact or fact and pass its key. "
        + "New top-level workflows are not supported: start from this agent so the tool grant has a parent. "
        + "The workflow is your child: stop it with cancel_agent or delete_agent; it takes no messages.",
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
        },
        required: ["yaml"],
    },
} as const;

export interface SpawnWorkflowToolArgs {
    yaml: string;
    inputs?: Record<string, unknown>;
    notify_on_completion?: boolean;
    key?: string;
}
