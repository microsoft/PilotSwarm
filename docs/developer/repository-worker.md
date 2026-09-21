# Sticky repository worker

PilotSwarm can host repository-bound agents without embedding source-control
provider, credential, or deployment policy in the SDK. The sticky repository
worker is the smallest supported composition: one worker process owns one
persistent Git checkout and serves one session.

## Behavior

`StickyRepositoryWorkspace` clones a configured repository into an
operator-owned directory, resolves a branch, ref, or commit to a pinned commit,
and checks it out with a detached `HEAD`. The clone is built in a temporary
directory and renamed into place only after checkout and ownership state have
been written successfully. Explicit refs that are not part of the clone's
normal branch advertisement are fetched before checkout.

The first turn claims the checkout for its session. The claim is stored in
`.git/pilotswarm-repository-worker.json`, so local commits and uncommitted files
remain associated with the same session after a process restart. Turns from a
different session, or turns configured with a different working directory, fail
before repository work begins.

This mode requires:

- Exactly one worker process per persistent checkout.
- At least two activity slots so `abortTurn` can run while a turn is active.
- External scheduling that sends only the intended session to the worker.
- Git credentials supplied by the execution environment or credential helper.

It does not provide cross-worker failover, repository-affinity routing, or
portable Git checkpoints. The reference entrypoint disables PilotSwarm
management agents and rejects plugin-defined system agents so an automatically
started system session cannot claim the checkout.

## Run from the source tree

Build the SDK, then start the repository worker:

```bash
npm --workspace packages/sdk run build

DATABASE_URL=postgresql://... \
REPOSITORY_URL=https://example.com/org/repository.git \
REPOSITORY_REF=main \
REPOSITORY_WORKSPACE_DIR=/var/lib/pilotswarm/repository \
PILOTSWARM_WORKER_CONCURRENCY=2 \
node packages/sdk/examples/repository-worker.js
```

`DATABASE_URL` and `REPOSITORY_URL` are required. `REPOSITORY_REF` defaults to
the remote's default branch. `REPOSITORY_WORKSPACE_DIR` defaults to
`./repository-workspace`. `PILOTSWARM_WORKER_CONCURRENCY` defaults to `2`;
PilotSwarm's per-session turn lock serializes repository turns while the second
activity slot remains available for cancellation.

Optional worker configuration:

| Variable | Purpose |
| --- | --- |
| `REPOSITORY_READY_FILE` | Readiness sentinel written after the worker starts |
| `PLUGIN_DIRS` | Comma-separated plugin directories |
| `SESSION_STATE_DIR` | PilotSwarm session state directory |
| `GITHUB_TOKEN` | Copilot authentication when required |
| `PS_MODEL_PROVIDERS_PATH` | Model provider configuration |
| `LOG_LEVEL` | Worker logging level |
| `PILOTSWARM_WORKER_ID` | Stable worker identifier |

Credential-bearing network repository URLs are rejected to prevent credentials
from being persisted in Git configuration or exposed by startup failures.
Trusted plugin, model-provider, and session-state paths are resolved before the
process enters the repository checkout. Model-provider discovery is
canonicalized to an absolute path so later configuration reloads cannot switch
to repository-controlled files.

## Deployment shapes supported today

The reference entrypoint can run directly on a developer machine or dedicated
VM. A persistent local directory retains the checkout, while the host's Git
credential helper and installed build tools remain available to the agent.

It can also be added to a private deployment as a custom worker workload. The
operator must provide persistent storage, Git credentials, and scheduling that
routes the claimed session back to the same worker. Each worker process requires
its own checkout.

If the worker is unavailable, its claimed session must wait for that worker to
return. Another worker cannot safely take over because this mode does not copy
local repository state between workers. Automated worker provisioning,
repository-affinity routing, and portable failover are separate deployment and
runtime capabilities.

## Lifecycle integration

The SDK's optional `beforeTurn` and `afterTurn` hooks run around one complete
run-turn activity attempt. `StickyRepositoryWorkspace.beforeTurn` validates and
claims the checkout before the turn body runs.

These hooks are process-local extension points. They do not participate in the
durable session snapshot transaction and do not make external state atomic with
PilotSwarm state.
