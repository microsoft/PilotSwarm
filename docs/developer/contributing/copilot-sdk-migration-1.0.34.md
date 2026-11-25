# Copilot SDK 1.0.34 / CLI 1.0.112 migration

Validation date: 2026-11-22. This upgrade does not change a model catalog,
session orchestration version, database schema or Workflow controller version.

## Packaging boundary

PilotSwarm pins `@github/copilot-sdk` 1.0.34 and `@github/copilot` 1.0.112
exactly in the published SDK and HorizonDB-store manifests and in
`package-lock.json`. SDK 1.0.34 starts its own bundled Linux runtime. A fresh
install reports runtime version 1.0.112 and protocol 3 through `getStatus()`.
All SDK platform optional dependencies remain installed.

SDK 1.0.34 is the last release of the `@github/copilot-sdk` package. Version
2.0.0 is a renamed `@microsoft/copilot-sdk` package with breaking changes and is
not part of this migration.

The old postinstall script is removed. It changed SDK imports from
`vscode-jsonrpc/node` to `vscode-jsonrpc/node.js`. SDK 1.0.34 uses
`vscode-jsonrpc` 10, whose package exports do not include `./node.js`; that
rewrite makes every SDK import fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The
SDK's shipped import now resolves without a patch, including in a clean npm
install used by the worker and portal images.

## Compatibility changes

### `snippy` request field

Runtime 1.0.112 no longer adds top-level `snippy: { enabled: false }` to BYOK Chat
Completions requests. The strict synthetic provider regression accepts an
unmodified request and confirms that no request contains `snippy`.

PilotSwarm therefore removes the `snippy` deletion from
`ByokRequestCompatibility`. That handler remains only for a catalog entry that
explicitly opts into typed-dispatch tool overflow. With no overflow, requests
are forwarded by identity, including headers, unknown fields and `snippy` if an
external caller supplied it. Native GitHub Copilot, Anthropic and Responses API
clients receive no compatibility handler.

### Runtime catalog and tool selection

The raw runtime has a different default tool catalog from 1.0.83. It adds
`semantic_code_search`, `run_dynamic_workflow` and `dynamic_workflows_manage`.
PilotSwarm excludes these three runtime-only additions so this dependency move
does not silently enable new features. The existing PilotSwarm `skill` flow is
retained, and `write_agent` keeps its existing exclusion. The effective exposed
set remains the previous 15 tools. Auxiliary inference sessions that only
summarize a title or distill context are created with an empty tool allowlist,
so the three runtime additions cannot surface there either.

Two external tools with the same name are now a session-construction error on
both create and resume. The real-runtime test asserts the error at both entry
points. PilotSwarm does not silently rename or discard a conflicting caller tool.
The provider-budget tools were declared once as session-tool stubs and again as
catalog-backed tools on Token Manager sessions. Runtime 1.0.112 rejects that
internal composition. Session creation now replaces the matching provider
stubs with the catalog-backed definitions; caller collisions still fail rather
than being silently discarded. Every fact, graph, inspection, feature, MOTD and
Decision tool remains present under the existing role and session rules.

The runtime also re-validates approved shell scripts before execution. A
session-wide command grant that contains inline shell code can be retried after
that validation and fail with `script_action_changed`. The headless default now
returns `approve-once` for each shell request. Other permission kinds retain
session approval unless the runtime marks that request as unable to offer a
session grant, and worker-supplied custom permission handlers are forwarded
unchanged.

`availableTools` and `excludedTools` now compose: a tool must match the allowlist
and must not match the denylist. The migration regression allows only `view` and
`bash`, excludes `bash`, and verifies that only `view` remains.

### Model and input validation

PilotSwarm validates a model reference against its configured provider registry
before session create. A model removed from that registry, or a provider that no
longer has a usable credential or endpoint, fails the turn instead of silently
falling through to another model.

A catalog entry that declares no context tiers leaves `contextTier` unset. The
runtime can then use the model's preferred tier. PilotSwarm continues to send an
explicit tier only for a model that declares that tier and continues to pass
its matching window capacity to BYOK model metadata. A caller-supplied
unsupported tier is refused before the stricter runtime sees it. Inherited
settings from a persisted or replayed session are sanitized for the selected
model first, without changing the frozen session-orchestration action shape.

The migration also rejects:

- a relative `workingDirectory`;
- an unknown send `mode` (the runtime accepts only `enqueue` and `immediate`);
- a `reasoningEffort` that the selected model does not declare;
- an unsupported `contextTier`.

### Session ownership and cold resume

The runtime does not fence a second owner. It writes `inuse.<pid>.lock` into the
session directory, but once an active turn's events are on disk a second Copilot
process can resume the same session; a resume that races the first
`events.jsonl` flush fails only as `Session not found`. PilotSwarm's worker
ownership path therefore uses one session handle per turn and recycles a
disconnected handle instead of opening a second concurrent owner. The
real-runtime test holds a model request open in one process, waits for
`assistant.turn_start` on disk, and records that a second process can resume
it, so a runtime that adds fencing is noticed.

A clean disconnect and worker stop remain resumable. A separate regression kills
the owner process with `SIGKILL` after its turn is persisted, then resumes the
same session and completes another turn. This covers the unclean-stop handoff.
An explicit worker control-hub look now resolves only after each live turn has
accepted the control; the Web API test synchronizes on that handoff before it
releases the blocked tool. This closes the faster-runtime race without delaying
ordinary notification delivery.

Two synthetic fixtures were written by an explicitly selected SDK 1.0.13 /
runtime 1.0.83 process, with both executable paths fixed and no credentials in
the fixtures. One contains a text turn. The other contains a completed host-tool
call and its result. Runtime 1.0.112 resumes both on-disk sessions and completes
a follow-up turn. These are storage-format compatibility tests, not replays of
production sessions.

Host tool calls are not governed by the old 30-minute runtime deadline on this
version. A manual real-runtime test in
`packages/sdk/test/manual/copilot-runtime-long-tool.test.mjs` keeps one SDK tool
handler open for 30 minutes plus 5 seconds and requires the turn to complete.
It is deliberately outside the regular suite because a 30-minute timer is an
explicit migration probe, not an every-PR fixture. The 2026-11-22 Linux run
completed after 1,805,137 ms for a requested 1,805,000 ms wait.

## Validation

Run from the repository root after a clean `npm ci`:

```sh
npm run lint --workspace=packages/sdk
npm run build
npm run test:unit --workspace=packages/sdk
npm exec --workspace=packages/sdk -- vitest run \
  test/local/copilot-provider-compatibility.test.js \
  test/local/copilot-runtime-migration.test.js \
  test/local/runtime-loss.test.js \
  test/local/tool-name-collisions.test.js
./scripts/run-tests.sh --all-providers
node --env-file=.env packages/sdk/test/live-copilot-providers.mjs \
  --config .model_providers.json \
  --models <available-qualified-model-list> \
  --require-types <available-provider-types>
node packages/sdk/test/manual/copilot-runtime-long-tool.test.mjs
npm run check:privacy
```

The synthetic compatibility tests use a real bundled Copilot process and a
local model endpoint. `runtime-loss.test.js` SIGKILLs that process mid-turn and
must stay green on every SDK or Node upgrade: PilotSwarm finds the runtime
child through Node's experimental `child_process` diagnostics channel and the
SDK's undocumented `--headless --stdio` arguments (issue 329). If either
changes, the runtime is no longer watched, a death waits for the turn
inactivity watchdog, and the worker logs a one-time "no runtime process was
bound" warning and counts `pilotswarm.copilot_runtime.exits{outcome="unclaimed"}`.
The compatibility tests cover all five provider wire paths (OpenAI,
OpenAI-proxy, Azure, Anthropic and Anthropic-WIF), streaming and non-streaming
turns, an external tool call, usage, warm turns, and cold resume. Their scripted
request parser ignores runtime 1.0.112's extra user-role `<system_reminder>` and
removes its `<current_datetime>` prefix from the actual prompt, so test turn
indices continue to describe PilotSwarm turns rather than runtime context
messages. The runtime's built-in `skill` tool now lists skills in the next
request's `<available_skills>` context and injects a loaded body there, while
its direct result is an acknowledgement. A completed native shell call also
carries its command output in `textResultForLlm` and a `shellId` in structured
content; Workflow scripts keep the completed text so their pre-1.0.112 API
stays stable.

The `--all-providers` result covers the complete stock PostgreSQL suite plus all
reviewed HorizonDB provider and SDK storage paths. HorizonDB mode accepts a
configured BYOK provider as the stock phase does, rather than requiring an
unrelated GitHub Copilot token. The live-provider gate runs only explicitly
configured models and reports every required provider type that lacks a
credential as missing; missing credentials are not converted into a passing
negative-path test.

The exposed native tool names stay at 15. Seven input-schema descriptions change
between runtimes 1.0.83 and 1.0.112: `bash`, `view`, `read_agent`, `list_agents`,
`grep`, `glob` and `task`. No argument name, type, requirement or enum changes.
Workflow tool grants still pin the full schema hash. PilotSwarm admits only the
seven exact 1.0.83-to-1.0.112 hash pairs as compatible, so an old grant continues
on the new worker without broadening package or MCP tool authority. Any other
hash change remains a contract-changed refusal. A package agent that declares
Workflow definitions also activates the session's Workflow context as a lasting
flag instead of relying on the model to enable it.

The compatibility bridge is forward-only. A 1.0.83 worker does not know a grant
created with 1.0.112 hashes. A rollback while new-runtime Workflows remain active
is therefore unsupported; stop those runs and treat rollback as fix-forward.

Final counts, worker-image size, and any credential omissions belong in the pull
request for the exact tested head.

## Rollout boundary

No session data is rewritten. Existing persisted runtime 1.0.83 sessions are
resumable by runtime 1.0.112. Frozen PilotSwarm session-orchestration versions
remain unchanged; their numeric version labels are unrelated to the bundled
Copilot CLI version. The `duroxide` dependency and database format remain
unchanged.

The 1.0.34 / 1.0.112 pair must be qualified as one unit. Do not install SDK
2.0.0, omit optional platform packages, or restore the removed postinstall patch.
