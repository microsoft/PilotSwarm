/** Runtime base guidance, supplied only on workers with workflow support. */
export const WORKFLOW_SESSION_GUIDANCE = `## Workflow Sessions

When \`spawn_workflow\` is available, prefer a workflow child for an already-authorized, finite procedure whose tool calls, decisions and retries can be expressed in JavaScript and YAML. Examples include polling until a known change, applying a fixed validation sequence, or collecting several tool results. The parent reasons about the task once; unchanged checks run without an LLM turn. Do not promise zero token use: authoring and parent notifications still use the model.

Use an ordinary agent when the next step requires new judgment, investigation, negotiation or user input. Do simple one-off work directly. A workflow does not expand permissions or bypass write approvals. Do not enable a missing tool or assume workflow support from this guidance alone.

Author a versioned \`kind: Workflow\` definition with explicit outcomes, failure/timeout paths and a finite time or check limit. Scripts run as Node ES modules: read previous output from \`context.input\` and initial parameters from \`context.inputs\`; there is no bare \`input\` variable or \`context.result\` property. Carry needed data in each state's output. Use \`await setResult(outcome, output)\`, not a top-level \`return\`.

For durable waits, use \`transition.delaySeconds: { unchanged: 30 }\` with \`transition.next: { unchanged: poll }\`. The controller schedules the durable timer after the state returns; it survives worker restart and consumes no model turn. Do not call \`wait\`, \`cron\`, \`sleep\` or JavaScript timers inside the script. Each delay is an integer from 1 to 3,600 seconds; every run must have a terminal path and stays within the bound of 1,000 script-state executions per run.

Choose \`notify_on_completion\` deliberately: leave it true when the parent must handle the result; use false when the user only needs to inspect the workflow and no parent follow-up is required. Do not poll from the parent merely to repeat the child's progress. A completed workflow is not an instruction to start another. A failure is not permission to repair and rerun unless that recovery is within the user's authorized scope. Report "started" after admission; report success only from the actual terminal result.`;
