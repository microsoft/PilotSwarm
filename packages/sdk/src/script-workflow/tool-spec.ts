/**
 * spawn_workflow — the declaration and the per-turn handler both build from
 * this one spec, so the schema the model sees cannot drift from the one the
 * handler accepts.
 */
export const SPAWN_WORKFLOW_TOOL_SPEC = {
    description:
        "Start a script workflow session: a durable state machine of script nodes that runs without an LLM, as a child of this session. "
        + "When the user describes steps, branches or loops in words, translate them into ScriptWorkflow YAML and pass it as yaml. "
        + "Returns at once with the workflow session id; this session receives the result as a system message when the workflow ends "
        + "(notify_on_completion=false skips that). For a recurring workflow, set cron or cron_at and call spawn_workflow on each wake-up. "
        + "A workflow's result is not a cue to start another run: starting one from each result loops forever.\n"
        + "YAML shape:\n"
        + "apiVersion: pilotswarm.dev/v1alpha1\n"
        + "kind: ScriptWorkflow\n"
        + "metadata: { name: <name> }\n"
        + "spec:\n"
        + "  entry: <first node id>\n"
        + "  nodes:\n"
        + "    <node id>:              # letter, then letters, digits, _ or -\n"
        + "      type: script          # the only node type\n"
        + "      runtime: python       # python | node | powershell\n"
        + "      timeoutSeconds: 300   # optional, 1-3600\n"
        + "      source: |\n"
        + "        <script>\n"
        + "      next:                 # outcome -> next node id, or null to finish with that outcome\n"
        + "        success: <node id>\n"
        + "        failure: null\n"
        + "In a script, `context` holds inputs, input (the previous node's output), node, step, workflow and sessionId. "
        + "Call tools with call_tool(name, args) in python, await callTool(name, args) in node, or Invoke-PilotSwarmTool -Name -Arguments in powershell. "
        + "Scripts get the tools a generic agent session has, acting as the workflow session: this deployment's default agent tools, "
        + "the fact and artifact tools, list_sessions, send_session_message (one-way), read_agent_events, and the default MCP servers' tools "
        + "called as \"<server>/<tool>\" (list_mcp_tools lists them). They cannot wait, schedule, ask the user or spawn agents. "
        + "Report a node's result with set_result(outcome, output) / await setResult(outcome, output) / Set-PilotSwarmResult -Outcome -Output, "
        + "or print one final JSON line {\"outcome\": ..., \"output\": ...}. Without a report, exit code 0 is outcome success (output = stdout), "
        + "any other exit code is failure, and running past the timeout is timeout. An outcome not listed in next fails the workflow. "
        + "Outputs are JSON and at most 256 KB; store larger data as an artifact or fact and pass its key. "
        + "The workflow is your child: stop it with cancel_agent or delete_agent; it takes no messages.",
    parameters: {
        type: "object",
        properties: {
            yaml: {
                type: "string",
                description: "The complete ScriptWorkflow YAML document.",
            },
            inputs: {
                type: "object",
                description: "Optional JSON object every script reads as context.inputs.",
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
