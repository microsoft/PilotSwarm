# Workflow Generator controller

## Purpose and audience

This document is the implementation and operations reference for the existing
Workflow Generator materialization subsystem. It is intended for PilotSwarm
engineers who maintain the controller and persistence layer, integrate with
the REST or SDK APIs, configure source providers, or run the controller.

For the platform resource model, worked examples, REST flow, identity rules,
and reconciliation semantics, see
[Workflow Definitions, Runs, and Generators](./WORKFLOWS.md).

It describes the currently implemented path from source evaluation through
exactly-once Workflow Run creation and initial Workflow Run session induction. It is not an
authoring guide for lifecycle Markdown or a description of the future
state-machine user experience. Those concepts are covered by
[Workflow Generator lifecycle state machines](./workflow-definitions.md).

Workflow Generator is a durable CMS aggregate that periodically evaluates an
external source and requests one Workflow Run for each stable provider key.
Definitions are independent immutable resources, and each Generator references
the Definition used for future discoveries. Shared Run identity is
`workflowType + workflowRunKey`; producer observations associate a Generator
with Runs it discovered without making the Generator their owner. This makes
reconciliation exactly-once across retries and controller restarts.

A Workflow Run owns session history rather than being a session. `workflow_run_sessions` permits
many associations, keeps prior sessions, and uses a partial unique index to
allow at most one current session. Initial session IDs are reserved before the
PilotSwarm call. A failed call leaves the reservation retryable, and the
controller resends the bootstrap message with a stable client message ID.
Each Workflow Run is pinned to the immutable definition that first materialized it, so
session retries keep the same lifecycle and agent configuration even after a
new definition version becomes active.
Pending and failed initial sessions are retried from durable Workflow Run state even if
the source no longer returns that item. Session result writes are fenced by
the active generator lease and cycle owner so an expired worker cannot
overwrite a newer worker's result.

## REST API

Publish the immutable Workflow Definition first. The server ignores
caller-supplied ownership and stamps the authenticated principal.

```json
{
  "workflowType": "hello-world",
  "name": "Hello World",
  "definition": {
    "sessionComputeAffinity": "cluster",
    "workflowDefinition": {
      "expansionAgent": "helloworld-expand",
      "states": {
        "Greet": {
          "kind": "prompt",
          "prompt": "helloworld/greet"
        },
        "Done": {
          "kind": "auto"
        }
      },
      "blockingPrincipals": ["workflowRunCreator"]
    },
    "affinities": {
      "repo": "service-repo",
      "gitRef": "main",
      "compute": ["devbox"],
      "model": "gpt-5.4"
    },
    "validationGates": [],
    "guardrails": {
      "maxOutstandingWorkflowRuns": 5,
      "maxBlockedWorkflowRuns": 2,
      "maxItemsPerCycle": 100,
      "maxAttemptsPerState": 3,
      "maxTotalSteps": 50
    }
  }
}
```

Then register the mutable Workflow Generator against that Definition:

```json
{
  "name": "HelloWorld",
  "cadenceSeconds": 300,
  "controllerComputeAffinity": "devbox",
  "workflowDefinitionId": "<definition-id>",
  "source": {
    "type": "example-source",
    "config": {
      "filter": "active"
    }
  }
}
```

`controllerComputeAffinity` and `definition.sessionComputeAffinity` are
independent nullable placement choices:

| Field | `cluster` | `devbox` | Omitted or `null` |
|---|---|---|---|
| `controllerComputeAffinity` | Only cluster controllers may claim the Generator. | Only devbox controllers may claim it. | Any controller may claim it. |
| `sessionComputeAffinity` | Induced Sessions use normal routing. | Induced Sessions require the durable execution-affinity principal's devbox worker. | Induced Sessions use normal routing. |

The controller placement predicate is evaluated inside the locked claim query,
before `FOR UPDATE SKIP LOCKED`. It is not inferred from the worker ID and does
not change Session placement.

The Workflow orchestration resource surface is:

| Method | Path | Result |
|---|---|---|
| `GET` | `/api/v1/workflow-generators?scope={visible|fleet}` | Caller-visible generators by default; `scope=fleet` requires resource administration |
| `GET` | `/api/v1/workflow-generators/{id}?scope={visible|fleet}` | Mutable aggregate; Fleet scope omits source configuration and internal error text |
| `GET` | `/api/v1/workflow-definitions` | Shared immutable definitions, optionally filtered by workflow type |
| `POST` | `/api/v1/workflow-definitions` | Publish an immutable definition |
| `GET` | `/api/v1/workflow-definitions/{id}?scope={visible|fleet}` | One definition; Fleet scope returns identity/version/repository metadata without executable definition content |
| `POST` | `/api/v1/workflow-runs` | Start a direct durable Workflow Run using its immutable Definition's entry state and affinities |
| `GET` | `/api/v1/workflow-runs?scope={visible|fleet}&workflowType={type}&workflowRunKey={key}` | Requester-visible durable Workflow Runs by default, optionally filtered by canonical identity; `scope=fleet` requires resource administration |
| `GET` | `/api/v1/workflow-runs/{id}?scope={visible|fleet}` | One durable Workflow Run; Fleet scope omits input, effective configuration, lease details, and error text |
| `GET` | `/api/v1/workflow-generators/{id}/workflow-runs` | Durable generated Workflow Runs |
| `GET` | `/api/v1/workflow-generators/{id}/cycles` | Materialization history |
| `DELETE` | `/api/v1/workflow-generators/{id}` | Logically delete the generator while retaining shared Workflow Runs |

Fleet detail calls for a Workflow Run's sessions, state runs, waits, and
journal also accept `scope=fleet`. Their projections preserve lifecycle and
timeline structure while omitting Session errors, state execution internals,
wait prompts/responses/observations/evidence, journal summaries, and
idempotency keys.
| `GET` | `/api/v1/workflow-runs/{id}` | One durable Workflow Run |
| `GET` | `/api/v1/workflow-runs/{id}/sessions` | Ordered PilotSwarm session history |
| `DELETE` | `/api/v1/workflow-runs/{id}` | Logically delete one Workflow Run without affecting its siblings |

Generator reads remain owner-scoped. Definitions, Workflow Runs, and their
session history use different visibility rules: Definitions are shared with
authenticated callers, while Workflow Run catalogs, point reads, and history
are scoped to the durable execution-affinity requester. That requester is the
authenticated caller for a direct Run and the Generator owner for a generated
Run. Resource administrators may inspect Runs across requesters.

Deletion is owner-authorized and idempotent. A normal user may delete only a
generator they own or a Workflow Run for which they are the durable requester;
an administrator may delete across requesters. Deleted aggregates disappear
from normal list and point-read APIs. The service still resolves them
internally during a repeated delete so an interrupted cleanup can be retried by
the original requester without exposing the tombstone through the read surface.

## Persistence model

| Table | Responsibility | Key invariants |
|---|---|---|
| `workflow_generators` | Mutable registration, owner, source, controller compute affinity, cadence, state, watermark, counters, lease | Unique active owner/name; references one immutable Definition |
| `workflow_definitions` | Independently owned immutable lifecycle, Session compute affinity, affinities, validation, guardrails | Unique `(workflow_type, version)` and `(workflow_type, definition_hash)`; update trigger rejects mutation |
| `workflow_generator_cycles` | One claimed evaluation/reconciliation pass | At most one running cycle per generator |
| `workflowRuns` | Durable source-native work identity and lifecycle | Unique `(workflow_generator_id, workflow_run_key)`; pinned `workflow_definition_id` |
| `workflow_run_sessions` | Workflow Run-to-PilotSwarm execution history | Many per Workflow Run; globally unique session ID; at most one current |
| `workflow_run_state_runs` | One revision-fenced execution of a lifecycle state | Unique `(workflow_run_id, state_revision)`; one durable session association |
| `workflow_run_waits` | Canonical response, observed-condition, and timer wait state | Revision-fenced status; durable check leases, attempts, cursors, observations, deadlines, and wait boundaries |
| `workflow_run_external_operations` | Infrastructure-owned provider operation identity, evidence, and signal delivery | Idempotent per state run/provider/kind/key; generated correlation and signal keys; rebinds across session replacement |
| `workflow_run_journal_entries` | Ordered state-transition handoffs | Unique state run and idempotency key; append-only sequence per Workflow Run |
| `workflow_run_cleanup_tombstones` | Durable owner, actor, complete session closure, progress, failure, and outcome record for logical deletion | One tombstone per generator or Workflow Run; `pending`, `completed`, or retryable `failed` cleanup |

Publishing later configuration creates another immutable Definition row.
Selecting it only changes `workflow_generators.active_workflow_definition_id`;
existing Workflow Runs remain pinned to their original Definition.

User affinity is not a caller-selected definition field. For a Definition with
`sessionComputeAffinity: "devbox"`, the server uses a private durable
execution-affinity principal: the authenticated requester for a direct Run or
the Generator owner for a generated Run. The public Workflow Run remains
service-owned. The inducer stamps the root and child Sessions with the private
principal only as an owner-routing boundary. Cluster and null Session placement
use normal routing without an owner-affinity requirement. Duroxide combines
owner and repository constraints into one exact `runTurn` routing tag when
owner affinity is required. Configure a personal worker with
`PILOTSWARM_WORKER_OWNER_PROVIDER`, `PILOTSWARM_WORKER_OWNER_SUBJECT`, and its
normal `PILOTSWARM_WORKER_TAGS` repo or `generic` tags. Partial owner
configuration and an owner-affined worker using the unrestricted `any` tag
filter fail at startup.

Owner-scoped workers intentionally do not accept legacy unowned `repo:*` or
`generic` work. Before converting an existing repository worker into a
personal worker, drain its pre-owner-affinity sessions or retain a legacy
global worker for those sessions until they complete. Do not advertise both
legacy and owner-scoped tags on a personal worker: that would let it dequeue
another user's unowned work during the compatibility window.

Session induction reserves the concrete session ID before creating the
PilotSwarm session, so `workflow_run_sessions` durably records the concrete
`workflow_run_id`/`session_id` relationship. Its current association transitions from
`reserved` to `unacked` after the turn is queued, then to `active` when a worker
enters `runTurn`.

## Owner-managed logical cleanup

The database transaction is the stop-new-work boundary. Deleting a
Workflow Generator disables it, releases its lease, fails any running controller
cycle, and marks every induced Workflow Run deleted and cancelled. Deleting one Workflow Run
applies the same fencing only to that Workflow Run, leaving sibling Workflow Runs available.
Both paths fail runnable state runs, release state leases, fail pending
external operations, block undelivered signals, and end current Workflow Run session
associations. `WorkflowRunStateRunStatus` has no cancelled value, so deletion records
runnable state runs as `failed` with `Workflow Run deleted` as the error.

Before enumerating a Workflow Run session tree, cleanup marks it with a durable deletion
fence. Session sends and child creation check that fence, preventing new work
from entering the tree while its transitive deletion closure is captured.

PilotSwarm then terminates or deletes every known root session and descendant.
The complete transitive session-ID closure is persisted in the tombstone
before deletion starts, so retries still target descendants hidden behind
already soft-deleted intermediate sessions.
The API reports success only after the CMS no longer returns any of those
sessions. A partial session or orchestration failure records a `failed`
tombstone and returns an explicit cleanup error; retrying the same DELETE
continues from the durable tombstone. Stale controller work cannot recreate a
deleted generator, materialize more Workflow Runs, complete a deleted cycle, or reserve
another Workflow Run session.

This MVP does not physically purge generator, definition, Workflow Run, lifecycle,
journal, session-association, or tombstone rows. Retention policy and physical
purge are separate administrative concerns.

## Direct SDK registration

Use `PgSessionCatalog` after `initialize()`:

```ts
const published = await catalog.createWorkflowDefinition({
  workflowType: "active-items",
  name: "active-items",
  owner: { provider: "entra", subject: "<object-id>" },
  sessionComputeAffinity: "cluster",
  workflowDefinition: {
    initialPrompt: "Investigate {workflowRun.key}:\n{workflowRun.payload}",
    session: { model: "gpt-5.4", repo: "service-repo" },
  },
  affinities: { repo: "service-repo", gitRef: "main" },
  guardrails: { maxItemsPerCycle: 100 },
});

const { generator, definition } = await catalog.createWorkflowGenerator({
  name: "active-items",
  owner: { provider: "entra", subject: "<object-id>" },
  controllerComputeAffinity: "devbox",
  cadenceSeconds: 300,
  workflowDefinitionId: published.workflowDefinition.workflowDefinitionId,
  sourceType: "example-source",
  sourceConfig: { filter: "active" },
});
```

Source providers are modules loaded by the platform-owned
`pilotswarm-workflow-generator-provider` runner. Domain modules implement the
versioned `SourceProvider` ABI and contain connector logic only; the runner
owns HTTP, bearer authentication, health, deadlines, cancellation, response
validation, and process lifecycle.

The controller communicates with each runner through a normalized HTTP
contract and POSTs the provider-specific configuration plus platform-owned
limits:

```json
{
  "workflowGeneratorId": "generator-id",
  "workflowDefinitionId": "definition-id",
  "config": {},
  "watermark": null,
  "limits": {
    "maxItemsPerCycle": 100
  }
}
```

`limits.maxItemsPerCycle` comes from the definition's top-level guardrails, so
providers can stop pagination before returning an oversized response. The
controller independently enforces the same limit. The provider response is:

```json
{
  "discoveries": [
    { "key": "stable-provider-key", "payload": {} }
  ],
  "watermark": {}
}
```

Provider IDs are opaque lowercase identifiers registered by the controller
deployment. Existing definitions retain their stored `sourceType`; no data
rewrite is required when an implementation moves out of the core repository.

## Configuration

Required:

- `DATABASE_URL` — PilotSwarm Postgres store.
- `WORKFLOW_GENERATOR_COMPUTE` — controller placement, exactly `cluster` or
  `devbox`.

Concrete source connectors are not implemented in this repository. Domain
repositories build modules against the public v1 ABI, compose them over the
platform-owned `pilotswarm-workflow-generator-provider` runner, and register the
resulting endpoint with the controller. PilotSwarm does not import concrete
connectors; their provider IDs, implementations, and composition remain owned
by the registering deployment.

Controller-side source configuration is:

- `WORKFLOW_GENERATOR_SOURCE_PROVIDERS_JSON` — JSON array of remote provider registrations:
  `{"id":"example-source","endpoint":"http://provider/evaluate","tokenEnv":"OPTIONAL_TOKEN_ENV"}`.
  `tokenEnv` names an environment variable; credentials are never embedded in
  the registration JSON.

Optional loop settings are `WORKFLOW_GENERATOR_POLL_INTERVAL_MS` (15000),
`WORKFLOW_GENERATOR_CLAIM_LIMIT` (10), `WORKFLOW_GENERATOR_LEASE_SECONDS` (300), and
`WORKFLOW_GENERATOR_WORKER_ID`. `WORKFLOW_GENERATOR_SOURCE_PROVIDER_TIMEOUT_MS` bounds each remote
provider request and must be shorter than the generator lease; its default is
the smaller of 90000 milliseconds and 80 percent of the configured lease.
Controller shutdown cancels an in-flight provider request.
`WORKFLOW_GENERATOR_RUN_ONCE=true` processes currently due generators once and
exits.

The producer-neutral Workflow Run inducer polls independently from Generator
evaluation. It is enabled by default; set `WORKFLOW_RUN_INDUCER_ENABLED=false`
to materialize Runs without reserving or starting PilotSwarm sessions. Its
optional settings are `WORKFLOW_RUN_INDUCER_POLL_INTERVAL_MS`,
`WORKFLOW_RUN_INDUCER_CLAIM_LIMIT`, `WORKFLOW_RUN_INDUCER_LEASE_SECONDS`, and
`WORKFLOW_RUN_INDUCER_WORKER_ID`. Their defaults match the corresponding
Generator loop settings.

The canonical Workflow Run wait scheduler is enabled by default. Set
`WORKFLOW_GENERATOR_WAIT_SCHEDULER_ENABLED=false` to disable it. Its optional settings are
`WORKFLOW_GENERATOR_WAIT_POLL_INTERVAL_MS` (500),
`WORKFLOW_GENERATOR_WAIT_DEFAULT_CHECK_INTERVAL_MS` (5000),
`WORKFLOW_GENERATOR_WAIT_RETRY_DELAY_MS` (1000),
`WORKFLOW_GENERATOR_WAIT_MAX_RETRY_DELAY_MS` (60000),
`WORKFLOW_GENERATOR_WAIT_CLAIM_LIMIT` (defaults to `WORKFLOW_GENERATOR_CLAIM_LIMIT`), and
`WORKFLOW_GENERATOR_WAIT_LEASE_SECONDS` (30).
`WORKFLOW_GENERATOR_MOCK_EXTERNAL_OPERATIONS=true` registers the deterministic mock
observer used by lifecycle demos; it is disabled by default and delivers
completions through the normal durable `sendSystemSignal` path.
The production Azure DevOps pull-request approval observer is registered by
default with the scheduler. It uses `WORKFLOW_GENERATOR_ADO_TOKEN`, then
`WORKFLOW_GENERATOR_ADO_PAT`/`AZURE_DEVOPS_EXT_PAT`, then `DefaultAzureCredential`. The
observer verifies the persisted PR source commit and uses Azure DevOps's current
enabled, blocking policy evaluations as the approval authority. Provider events
only accelerate a matching `pull_request_approval` check; reconciliation
polling remains authoritative. A companion `pull_request_completion` observer is
registered alongside it and shares the same credential precedence and repository
authorization. It verifies the persisted source commit, treats a completed PR as
the satisfying condition, an abandoned or otherwise incompatible PR as a terminal
disposition, and preserves the merge commit, completion actor, completion time,
and target branch as evidence. It never completes, abandons, or otherwise mutates
the pull request. Before using the shared credential, both observers require the
Workflow Run definition's `affinities.repo` value to match a server-owned
entry in `WORKFLOW_GENERATOR_ADO_REPOSITORY_BINDINGS`. The value is a JSON array such as
`[{"repo":"service-repo","organization":"contoso","project":"Project","repositoryId":"repository-guid"}]`.
An unbound affinity or mismatched target is rejected before any Azure DevOps
request. Repositories that require fresh approval after every source update
must configure their Azure DevOps branch policies to reset votes on source push;
the observer intentionally follows Azure DevOps's reported current policy state.
Missing provider configuration fails that cycle explicitly without advancing
its watermark.

Run the controller directly on a local machine:

```text
WORKFLOW_GENERATOR_COMPUTE=devbox
npm run workflow-generator
```

That command builds the SDK and controller, loads `.env.remote`, then runs the
continuous reconciliation loop. It claims unpinned Generators and Generators
pinned to its configured compute without owner filtering.

For a persistent private-stamp controller, use the stamp-level Windows
container launcher:

```powershell
pwsh -NoProfile -File scripts\devbox-workflow-generator.ps1 `
  -ConfigPath "$HOME\.pilotswarm\<stamp>.worker.json" `
  -Action Start
```

The concrete private-stamp configuration is consumer-owned. It may be the same
local stamp configuration used by that consumer's devbox worker launcher. The
Workflow Generator requires `privateStamp`, `stampName`, `kubernetesContext`,
`workerImage`, `environmentFile`, and `modelProvidersFile`; it also honors the
optional `credentialDirectory`, `stateRoot`, and `containerPrefix` fields.

The launcher validates private-stamp ownership and image alignment, mounts the
stamp model provider catalog configured by `modelProvidersFile` and the Azure
CLI credential directory, sets `WORKFLOW_GENERATOR_COMPUTE=devbox`, and waits
for the controller readiness file. For provider processes hosted on the Windows
devbox, it resolves the Docker `nat` gateway and maps
`host.docker.internal` into the controller container; startup fails if that
gateway cannot be resolved. `Status`, `Logs`, `Stop`, and `Validate` target the
same stamp-level container.

The managed AKS path is
`deployment/pilotswarm-workflow-generator` in the worker GitOps application.
It sets `WORKFLOW_GENERATOR_COMPUTE=cluster`, uses the worker workload-identity
service account and database configuration, and participates in worker rollout
and image verification.

When the build is already current (for example when only `.env.remote` changed),
skip the rebuild and launch the built CLI directly from the repo root:

```text
node --env-file=.env.remote packages/workflow-generator/dist/cli.js
```

This is the exact command `npm run workflow-generator` runs after its build steps.
The controller reads all `WORKFLOW_GENERATOR_*` settings — including
`WORKFLOW_GENERATOR_ADO_REPOSITORY_BINDINGS` — only at startup, so restart it after editing
`.env.remote`. On a devbox the Azure DevOps observers authenticate through the
signed-in `az login` identity via `DefaultAzureCredential`, so no PAT is
required. A successful start logs `adoRepositoryBindings=<n>` in the
`WorkflowRunWait scheduler ready` line; confirm `<n>` matches the number of configured
bindings.
