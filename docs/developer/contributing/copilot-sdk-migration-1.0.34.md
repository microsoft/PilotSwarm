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
set remains the previous 15 tools.

Two external tools with the same name are now a session-construction error on
both create and resume. The real-runtime test asserts the error at both entry
points. PilotSwarm does not silently rename or discard a conflicting caller tool.

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

A headless session with an active turn cannot be resumed by a second Copilot
process. PilotSwarm's existing worker ownership path therefore uses one session
handle per turn and recycles a disconnected handle instead of opening a second
concurrent owner. The real-runtime test holds a model request open in one
process and verifies that a second process cannot resume it.

A clean disconnect and worker stop remain resumable. A separate regression kills
the owner process with `SIGKILL` after its turn is persisted, then resumes the
same session and completes another turn. This covers the unclean-stop handoff.

A small synthetic fixture was written by an explicitly selected SDK 1.0.13 /
runtime 1.0.83 process, with both executable paths fixed, with no credentials in
the fixture. The new runtime
resumes that on-disk session and completes a follow-up turn. This is a storage
format compatibility test, not a replay of a production session.

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
local model endpoint. They cover all five provider wire paths (OpenAI,
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
