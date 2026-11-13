# Working On PilotSwarm

For installation and runnable local/CI setup steps, see [Local tests and CI setup](local-ci-and-tests.md).

This guide is for contributors changing PilotSwarm itself: the SDK runtime, worker/session plumbing, TUI, plugins, prompts, or deployment story.

## Repo Map

The two most important packages are:

- `packages/sdk/` — durable runtime, worker, client, orchestration, CMS, plugin loading, model providers
- `packages/app/tui/` — shipped TUI/CLI wrapper around the SDK

The rest of the repo mostly supports those two packages:

- `docs/` — user docs, contributor docs, design notes, and proposals
- `scripts/` — deploy, reset, debug, and inspection helpers
- `deploy/` — Dockerfile and Kubernetes manifests

## Where To Work

### SDK / Runtime

Touch `packages/sdk/src/` when you are changing:

- orchestration state transitions
- activity wiring
- client/management behavior
- session hydration/dehydration
- model provider resolution
- plugin loading
- prompt/tool/runtime contracts

Files that matter most:

- [`packages/sdk/src/orchestration.ts`](../../../packages/sdk/src/orchestration.ts)
- [`packages/sdk/src/worker.ts`](../../../packages/sdk/src/worker.ts)
- [`packages/sdk/src/session-manager.ts`](../../../packages/sdk/src/session-manager.ts)
- [`packages/sdk/src/managed-session.ts`](../../../packages/sdk/src/managed-session.ts)
- [`packages/sdk/src/session-proxy.ts`](../../../packages/sdk/src/session-proxy.ts)
- [`packages/sdk/src/client.ts`](../../../packages/sdk/src/client.ts)
- [`packages/sdk/src/management-client.ts`](../../../packages/sdk/src/management-client.ts)
- [`packages/sdk/src/types.ts`](../../../packages/sdk/src/types.ts)

### TUI / CLI

Touch `packages/app/tui/` when you are changing:

- layout and rendering
- observer/poller lifecycle
- session switching behavior
- slash commands and input handling
- local vs remote TUI boot flow

Files that matter most:

- [`packages/app/tui/src/app.js`](../../../packages/app/tui/src/app.js)
- [`packages/app/tui/src/platform.js`](../../../packages/app/tui/src/platform.js)
- [`packages/app/tui/src/index.js`](../../../packages/app/tui/src/index.js)
- [`packages/app/tui/bin/tui.js`](../../../packages/app/tui/bin/tui.js)
- [`packages/app/tui/package.json`](../../../packages/app/tui/package.json)

### Prompt / Plugin Surface

Touch `packages/sdk/plugins/` when you are changing:

- default instructions
- named agents
- system-agent behavior
- built-in skills

Files that matter most:

- [`packages/sdk/plugins/system/agents/default.agent.md`](../../../packages/sdk/plugins/system/agents/default.agent.md)
- [`packages/sdk/plugins/mgmt/agents/pilotswarm.agent.md`](../../../packages/sdk/plugins/mgmt/agents/pilotswarm.agent.md)
- [`packages/sdk/plugins/mgmt/agents/sweeper.agent.md`](../../../packages/sdk/plugins/mgmt/agents/sweeper.agent.md)
- [`packages/sdk/plugins/mgmt/agents/resourcemgr.agent.md`](../../../packages/sdk/plugins/mgmt/agents/resourcemgr.agent.md)

## Contributor Workflows

### Changing the orchestration

PilotSwarm versions orchestrations instead of editing deployed behavior in place.

When you change orchestration behavior:

1. Freeze the current latest orchestration into `packages/sdk/src/orchestration_<version>.ts`
2. Update `packages/sdk/src/orchestration.ts` to the new latest version
3. Wire the new version in `packages/sdk/src/orchestration-registry.ts`
4. Keep the client, worker, and every `continueAsNewVersioned(...)` target on the shared latest-version constant instead of hard-coding latest targets in multiple files
5. Stamp the source orchestration version into the carried `OrchestrationInput` so the new latest handler can normalize older state when needed
6. Keep version-specific logs obvious in orchestration tracing

If the change affects replay behavior, `continueAsNew`, KV state, or command/event handling, treat it as a version bump even if the diff looks small.

The compatibility bar is higher than “old JSON still parses”:

- The latest handler must accept input snapshots from the oldest orchestration version that is still registered in the repo.
- Compatibility is behavioral, not just syntactic. If version `N` can `continueAsNew` from state point `X`, version `N+1` must resume correctly from `X`.
- If the new handler only works when resumed from a new point `Y`, keep the older handoff on the frozen handler or add explicit source-version normalization in the new handler.

See [Duroxide's versioning best practices](https://github.com/microsoft/duroxide/blob/main/docs/versioning-best-practices.md) for stable orchestration names, versioned handlers, registration and upgrade timing.

### Changing the Workflow controller orchestration

Apply the same freeze, register and compatibility discipline to the Workflow controller.
Write or update these instructions before changing the controller. Keep instruction,
freeze and live-edit commits separate so the frozen-to-live diff shows the behavior change.

1. Freeze the released generator and every replay-sensitive helper into `packages/sdk/src/workflow/controller_<version>/`, preserving the live tree's file layout. A frozen tree owns its parsers, constants and generator dependencies. Its only external imports must be explicitly allow-listed and immutable or type-only; never import a live generator or helper. Hash-pin every frozen file. Keep the orchestration name stable and use a version suffix on its handler.
2. Open the next handler in `packages/sdk/src/workflow/controller/` and update the single latest-version constant, `WORKFLOW_CONTROLLER_VERSION`, in `workflow/controller-version.ts`. New runs use this constant. Before a live tree is frozen, replace its latest-version import with its own literal: frozen 1.1.0 must use `"1.1.0"` and must not import `controller-version.ts`.
3. Wire both handlers in `packages/sdk/src/workflow/controller-registry.ts`; registration must iterate that registry. The registry is the only importer of a frozen controller tree. Keep all versions needed by stored histories registered.
4. Use the shared latest-version constant for new run admission, not scattered latest literals. The current Workflow contract pins a run to its admitted `workflow_runs.controller_version`: every start and recovery uses that stored version, and each `continueAsNewVersioned(...)` stays on the same version. Unknown versions must be refused before effects. Unlike the session orchestration, Workflow does not automatically upgrade at continue-as-new.
5. Store the run's `controllerVersion` at admission; that stored value is its version stamp for its whole life. Preserve the carried controller input for same-version continuation. There is no source-version migration and no separate migration stamp in the carried input. Do not add one or change a frozen generator as part of this freeze.
6. Keep version-specific handler names and orchestration tracing obvious. Diagnose the version recorded on the run and Duroxide instance, not the version currently deployed. Changing replayed log/custom-status ordering is a behavior change, not an incidental logging cleanup.

Rules 4 and 5 are an explicit exception to the session orchestration's latest-version
handoff. Moving a run mid-life to a controller with different routing semantics changes
what its admitted definition means. For example, honoring `carry` for a run admitted at
1.0.0 breaks the carry model's gate invariant: that version must route the raw result
without a carry snapshot. A run therefore stays on its admitted controller version
through recovery and continue-as-new. New controller versions reach only new runs.
Keep a frozen version registered while any run admitted at that version can still be
live, recover or replay; deploying the new version alone is not permission to remove it.

The compatibility bar is behavioral, not merely "old JSON still parses": **each
registered version must replay every history it admitted**. That includes resume
points with pending work, unread commands, timers, parallel cursors, pause and terminal
transitions, not only initial starts. Compare released histories against the matching
frozen handler and previously bound live histories against the live handler. The
30 recorded histories in this freeze are bounded evidence, not an exhaustive claim
over all those state points. Cross-version Workflow migration is a separate future
decision; it is not implemented or required by this freeze.

Shared activities remain shared. Their version-dependent behavior must come from the run's
admitted version, never a worker default or a live-tree import. Preserve activity names,
inputs, ordering and retry contracts for frozen histories. A shared activity change that
breaks an old contract needs a versioned activity contract, not an edit to frozen code.

Follow test rule 6 in [`.github/copilot-instructions.md`](../../../.github/copilot-instructions.md)
and the [formal validation skill](../../../.github/skills/tla-formal-validation/SKILL.md).
Run the full suite, update and run affected TLA+ models under `docs/formal/workflow/`,
fix findings with regressions, and update the [formal index](../../formal/README.md).
A pure extraction may retain unchanged model results only with an exact-head correspondence
review proving frozen-source identity, live behavior equivalence, admitted-version dispatch,
shared activity guards and identical recorded schedules. Never reset durable state for a
controller upgrade. See [Duroxide's versioning best practices](https://github.com/microsoft/duroxide/blob/main/docs/versioning-best-practices.md);
its explicit version-pin option is the Workflow policy described here.

### Changing the TUI

The TUI is a shared stack across:

- `packages/app/ui/core/` — controller, reducer, selectors, shared formatting
- `packages/app/ui/react/` — shared React component tree
- `packages/app/tui/` — terminal host, input handling, platform adapter, boot flow

Start with:

- [TUI Architecture](../../architecture/tui.md)
- [TUI Design And Implementor Guide](./tui-implementor-guide.md)

Before changing rendering behavior:

- identify whether the issue lives in shared state/view models vs terminal-host rendering
- check session-switch paths and observer lifecycle
- check whether the change also affects portal/shared rendering helpers
- keep keybinding docs and TUI maintenance notes in sync

### Changing prompts, tool contracts, or agent behavior

Do not rely on prompt text alone.

For any behavior that must stay true, update all of these layers together:

- prompt or agent file
- tool descriptions / schemas
- runtime validation or normalization
- tests
- docs

This is especially important for:

- named system-agent spawning
- model selection for sub-agents
- artifact creation/export rules
- wait / ask_user semantics

See [Agent Contracts](../reference/agent-contracts.md).

### Adding or changing a model provider

Provider changes usually touch:

- `packages/sdk/src/model-providers.ts`
- `packages/sdk/src/session-manager.ts`
- worker startup/config docs
- examples and `.env` documentation

If you add something like an AWS-hosted provider, make sure the change is reflected in:

- provider discovery/loading
- runtime provider resolution
- model listing for the LLM
- docs for SDK and CLI users

## Testing And Verification

Useful local checks:

```bash
npm run build --workspace=packages/sdk
./scripts/run-tests.sh                         # full test suite (vitest)
./scripts/run-tests.sh --suite=smoke           # just smoke tests
cd packages/sdk && npx vitest run test/local/smoke-basic.test.js  # single file
node --check packages/app/tui/bin/tui.js
```

For the broader local-only runtime test matrix, see [Local Integration Test Plan](./local-integration-test-plan.md).

Useful end-to-end flows:

- `npm run tui` — local embedded workers
- `npm run tui:remote` — client-only TUI against remote workers
- `node --env-file=.env packages/sdk/examples/chat.js`
- `node --env-file=.env.remote packages/sdk/examples/worker.js`

## Deploy And Reset Loop

Common operations:

```bash
./scripts/deploy-aks.sh                                       # deploy (never resets data)
./scripts/reset-db-aks.sh --i-understand-this-deletes-all-data  # explicit destructive wipe
```

Deploys are always non-destructive. Use the explicit reset script only when you
need a clean state for orchestration/version testing and a wipe was explicitly
requested — NO RESETS otherwise.

## Docs To Keep In Sync

When behavior changes, update the user-facing docs that explain it:

- [docs/sdk/building-apps.md](../building/sdk-apps.md)
- [docs/sdk/building-agents.md](../building/sdk-agents.md)
- [docs/cli/building-cli-apps.md](../building/cli-apps.md)
- [docs/cli/building-agents.md](../building/cli-agents.md)
- [docs/contracts/agent-contracts.md](../reference/agent-contracts.md)

If the change is architectural or operational, also check:

- [docs/architecture.md](../../architecture/system.md)
- [docs/plugin-architecture-guide.md](../building/plugins.md)
- [docs/system-reference.md](../../architecture/system-reference.md)
- [docs/deploying-to-aks.md](../deploy/aks.md)

## Quick Contributor Checklist

- Reproduce the issue locally before patching if you can
- Prefer runtime backstops over prompt-only fixes
- Version orchestration changes
- Keep the default agent prompt and agent-contract docs aligned
- Verify with both local checks and at least one realistic end-to-end path
