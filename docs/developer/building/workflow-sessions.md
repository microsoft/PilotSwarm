# Workflow Sessions (Experimental)

Workflow sessions are durable child sessions controlled by a workflow state
machine rather than an LLM conversation. A conversational parent can start a
workflow, continue doing other work, and later check or wait for its durable
result.

The design motivation and intended execution model are tracked in
[PilotSwarm issue #28](https://github.com/microsoft/PilotSwarm/issues/28).
Concrete root, conversational-parent, and mixed-nesting examples are developed
in the [workflow session composition scenarios proposal](../../proposals/workflow-session-scenarios.md).

The caller-side protocol is implemented, but the workflow controller is still a
scaffold. Starting a workflow currently creates the real durable child session
and then fails its orchestration with
`WORKFLOW_CONTROLLER_NOT_IMPLEMENTED`.

## Invoke a Workflow from an Agent

Conversational sessions on orchestration version `1.0.81` or later expose these
tools:

- `start_workflow` creates a workflow child and returns its session ID.
- `check_workflows` reads any controller-written terminal results without
  waiting.
- `wait_for_workflows` durably waits until all selected workflows have written
  terminal results.

An agent package can instruct a markdown agent to use the tools:

```markdown
---
name: workflow-runner
description: Starts an inline workflow.
---

# Workflow Runner

When asked to run a workflow:

1. Call `start_workflow` exactly once using the supplied definition and inputs.
2. Report the returned workflow session ID.
3. Call `wait_for_workflows` if the caller wants the final result.
```

The model calls `start_workflow` with this shape:

```json
{
  "definition": {
    "kind": "inline",
    "yaml": "name: example\nversion: 1\nsteps: []\n"
  },
  "inputs": {
    "request": "example"
  }
}
```

Package-backed definitions use:

```json
{
  "definition": {
    "kind": "package",
    "package_name": "example-package",
    "workflow_name": "example-workflow",
    "version": "1.0.0"
  },
  "inputs": {}
}
```

The tool ends the current model turn and emits a durable orchestration action.
The parent orchestration assigns a replay-stable workflow session ID, creates
the child through a durable activity, and supplies the ID to the agent in its
next follow-up context.

The CMS `parentSessionId` is the authoritative relationship. The parent
orchestration separately tracks workflow execution state in `subWorkflows`.

## Force the Tool in an SDK Scenario

Tests and applications can require the model to call `start_workflow` during a
turn:

```js
const parent = await client.createSession({
  agentId: "workflow-runner",
});

const response = await parent.sendAndWait(
  "Start the supplied inline workflow.",
  180_000,
  undefined,
  { requiredTool: "start_workflow" },
);
```

`requiredTool` guarantees that the turn invokes the tool; the agent instructions
and user prompt still provide the workflow definition and inputs.

## Run the End-to-End Boundary Test

The synthetic integration scenario is:

- test: `packages/sdk/test/local/workflow-session-e2e.test.js`
- plugin: `packages/sdk/test/fixtures/workflow-session-e2e-plugin/`
- agent:
  `packages/sdk/test/fixtures/workflow-session-e2e-plugin/agents/workflow-runner.agent.md`

Start local PostgreSQL:

```bash
docker run --rm --name pilotswarm-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=pilotswarm \
  -p 5432:5432 \
  postgres:17 -c max_connections=500
```

Set the test connection and model credential:

```powershell
$env:PS_TEST_DATABASE_URL = "******localhost:5432/pilotswarm"
$env:GITHUB_TOKEN = "<token>"
```

From the repository root, run:

```powershell
npm --workspace packages/sdk run build
node --env-file=.env node_modules/vitest/vitest.mjs run packages/sdk/test/local/workflow-session-e2e.test.js
```

The test demonstrates the current complete boundary:

1. A real markdown agent calls the production `start_workflow` tool.
2. The parent creates a durable workflow child with the correct lineage.
3. The workflow definition and inputs are persisted in its creation config.
4. The worker starts the real `workflow-session-v1` orchestration.
5. The scaffold controller fails explicitly with
   `WORKFLOW_CONTROLLER_NOT_IMPLEMENTED`.

Once the controller exists, the final assertion should be replaced with a
controller-written durable outcome and verification that the parent consumes
that result through `wait_for_workflows`.
