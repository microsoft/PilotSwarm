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
        + "(notify_on_completion=false skips that).\n"
        + "Polling and repeating work belong INSIDE the workflow: for \"every N minutes check X and if so do Y\" or \"every night at 02:00 do Z\", "
        + "write ONE workflow whose work loops back through a wait state, and call spawn_workflow ONCE. Do not use cron or cron_at for it: each cron "
        + "wake-up costs a model turn, while a workflow's checks and waits cost none. Such a workflow runs until it reaches a terminal "
        + "state or is cancelled (cancel_agent). If handling a finding needs judgment, the script wakes an agent with send_session_message; "
        + "only that costs a turn. A workflow's result is not a cue to start another run: starting one from each result loops forever.\n"
        + "YAML shape (this version runs script, wait and terminal states):\n"
        + "apiVersion: pilotswarm.dev/v1alpha1\n"
        + "kind: Workflow\n"
        + "metadata: { name: <name>, version: 1.0.0 }\n"
        + "inputs:                    # optional schema for the inputs argument\n"
        + "  <input>: { type: string, required: true }   # string|number|integer|boolean|object|array\n"
        + "initial: <first state id>\n"
        + "states:\n"
        + "  <state id>:               # letter, then letters, digits, _ or -\n"
        + "    type: script\n"
        + "    runtime: node           # node (preferred) | python | powershell\n"
        + "    timeoutSeconds: 300     # optional, 1-3600\n"
        + "    source: |\n"
        + "      <script>\n"
        + "    completion: { outcomes: [success, failure] }\n"
        + "    transition:\n"
        + "      next: { success: <state id>, failure: <state id> }   # one target per declared outcome\n"
        + "  <wait id>:\n"
        + "    type: wait              # a durable timer: no process, no model, no cost\n"
        + "    seconds: 600            # at least 60; OR a clock time instead of seconds:\n"
        + "    # at: { hour: 2, minute: 0, tz: America/Los_Angeles }   # daily 02:00; add day_of_week (0-6, Sun=0) or day_of_month (1-31); omit hour for hourly\n"
        + "    transition: { next: <state id> }\n"
        + "  done:\n"
        + "    type: terminal\n"
        + "    outcome: succeeded      # succeeded | blocked | failed | cancelled\n"
        + "    summary: <optional one line>\n"
        + "    output: ${states.<state id>.result}   # optional; or ${inputs.x}; quote it inside { }\n"
        + "Polling example: initial: check; check (script) outcomes [found, idle] -> next { found: handle, idle: sleep }; "
        + "handle (script) -> next { done: sleep }; sleep (wait, seconds: 600) -> next: check. "
        + "A run ends at a terminal state, or runs until cancelled when its loop passes through a wait state; "
        + "a loop of script states with no wait fails after 1,000 runs. "
        + "In a script, `context` holds inputs, input (the previous script state's output), node (the state id), step, workflow and sessionId. "
        + "Call tools with await callTool(name, args) in node, call_tool(name, args) in python, or Invoke-PilotSwarmTool -Name -Arguments in powershell. "
        + "Scripts can call YOUR tools, as they are when you call spawn_workflow, acting as the workflow session: built-ins such as bash, view and edit, "
        + "your worker and package tools, and your MCP tools (also callable as \"<server>/<tool>\"). Excluded: waiting and scheduling, "
        + "starting or managing agents and workflows, ask_user, session and turn lifecycle, changing models, packages, agents or folders, "
        + "and model sampling; a detached shell and send_session_message with expects_response are refused too. "
        + "A call fails if the tool is no longer yours (for example this session ended or the capability was removed). "
        + "Prefer runtime: node. It runs under Node's permission model: no file access outside its scratch folder and no child processes, "
        + "so use the tools for files and commands. python and powershell run as plain processes and are allowed only when you have a shell tool "
        + "(bash or powershell). A script cannot sleep for long, schedule, ask the user or spawn agents: use a wait state to pause. "
        + "Report a state's result with set_result(outcome, output) / await setResult(outcome, output) / Set-PilotSwarmResult -Outcome -Output, "
        + "or print one final JSON line {\"outcome\": ..., \"output\": ...}. Without a report, exit code 0 is outcome success (output = stdout), "
        + "any other exit code is failure, and running past the timeout is timeout. An outcome not declared in completion.outcomes fails the workflow. "
        + "Outputs are JSON and at most 256 KB; store larger data as an artifact or fact and pass its key. "
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

/**
 * The cron and cron_at descriptions on workers that run workflows. The default
 * wording invites "periodic monitoring" and "external polling", which models
 * read as the way to do any repeated check; where spawn_workflow is offered a
 * repeated check a script can do belongs in a workflow's wait loop, which
 * costs no model turns. These keep every rule of the default wording.
 */
export const WORKFLOW_AWARE_CRON_DESCRIPTION =
    "Wake THIS AGENT on a recurring interval. Use it only when each wake-up needs this agent's own judgment: "
    + "deciding what to do next, summarizing or writing for a person, or pursuing a goal autonomously until it is done. "
    + "For a fixed check or job a script can do (\"every 10 minutes check X and if so do Y\"), do NOT use cron: call spawn_workflow ONCE "
    + "with a loop through a wait state. A workflow's checks and waits cost no model turns; every cron wake-up costs one. "
    + "Do not use cron solely to poll sub-agent status; qualifying child updates wake the parent according to contract.wakeOn. "
    + "If it is genuinely ambiguous whether the task should become an ongoing recurring workflow, clarify that intent before setting cron. "
    + "Set or update the schedule with seconds + reason. Cancel it with action='cancel'. "
    + "Minimum interval is 15 seconds.";

export const WORKFLOW_AWARE_CRON_AT_DESCRIPTION =
    "Wake THIS AGENT at wall-clock times, like 'nightly at 02:00 UTC' or 'Mondays at 09:00 America/New_York'. "
    + "Use it only when each wake-up needs this agent's own judgment. For a fixed job a script can do (\"every night at 02:00 run the report\"), "
    + "do NOT use cron_at: call spawn_workflow ONCE with a loop through a wait state that has `at` (a clock time); it costs no model turns. "
    + "Do NOT implement wall-clock schedules by polling every N minutes with cron(seconds=...) and checking the clock - that wastes tokens and turns. "
    + "Recurrence is inferred from the fields you provide: minute (hourly), minute+hour (daily), minute+hour+day_of_week (weekly), minute+hour+day_of_month (monthly). "
    + "Pass max_fires=1 for a single one-shot scheduled-at-time action. "
    + "Cancel with action='cancel'.";

/** The cron or cron_at declaration as workers that run workflows describe it; other tools unchanged. */
export function workflowAwareSchedulingTool<T extends { name?: string; description?: string }>(tool: T): T {
    if (tool?.name === "cron") return { ...tool, description: WORKFLOW_AWARE_CRON_DESCRIPTION };
    if (tool?.name === "cron_at") return { ...tool, description: WORKFLOW_AWARE_CRON_AT_DESCRIPTION };
    return tool;
}
