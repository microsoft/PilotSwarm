# Agent harness abstraction for Copilot and Pi

Draft · MVP stage 1 · 19 October 2026

## Decision

Put an internal `AgentHarnessClient` / `AgentHarnessSession` contract between
PilotSwarm session orchestration and any coding-agent harness. Keep GitHub
Copilot as the default adapter. Add Pi as a second adapter only after the
Copilot path passes unchanged through this seam.

This is intentionally staged. The first change does **not** add Pi as a runtime
dependency or claim Pi sessions work. It establishes and tests the smallest
boundary needed for that work without changing production behavior.

## Why this boundary

A local Graphify structural/semantic run over `packages/sdk/src` (`graphify query
"Trace how SessionManager creates or resumes CopilotClient and CopilotSession"`)
found the runtime path concentrated in three communities:

- `SessionManager` pools clients and creates, resumes, deletes, and shuts down
  harness sessions (`packages/sdk/src/session-manager.ts`).
- `ManagedSession` translates harness events and tools into PilotSwarm turn
  results (`packages/sdk/src/managed-session.ts`).
- `createCopilotClient` owns Copilot transport and request compatibility
  (`packages/sdk/src/copilot-client.ts`).

The orchestration and public client already depend on `ManagedSession`, not on
Copilot directly. Therefore the narrowest useful seam is below
`SessionManager`/`ManagedSession`, not a rewrite of orchestration or provider
routing.

The generated graph is an investigation artifact, not a committed product
artifact; the source locations below are the reproducible evidence.

The current session wrapper uses these harness operations:

- client: start, create, resume, delete, list models, stop, force-stop;
- session: send, subscribe, abort, disconnect, retrieve events, refresh tools;
- optional native-task RPC: list, inspect, cancel, and remove tasks.

Everything else remains PilotSwarm-owned.

## Contract

`AgentHarnessClient` owns one harness process/runtime and can create or resume
sessions. `AgentHarnessSession` represents one live conversation and exposes a
normalized event subscription and lifecycle API. `AgentHarnessClientFactory`
is the injection point used by `SessionManager`.

The MVP contract deliberately keeps session configuration and event payloads
opaque. Normalizing every Copilot event and configuration field before a second
adapter exists would create a speculative mirror of the Copilot SDK. The Pi
adapter stage will add only the normalized fields proven necessary by parity
tests.

The interface is internal-first but exported as types so adapter packages can
be developed without importing Copilot SDK classes.

## Stages

### Stage 1 — MVP: behavior-preserving seam

1. Add harness client/session interfaces.
2. Add a Copilot adapter factory that translates generic client options to the
   pinned Copilot SDK client.
3. Route `SessionManager`, `ManagedSession`, native cleanup, and task
   observation through the interfaces.
4. Keep `createCopilotClient()` and `getCopilotSession()` as compatibility
   surfaces for existing callers and tests.
5. Add contract tests proving factory injection and the default Copilot path.

**Exit:** existing Copilot build and focused lifecycle tests pass; an injected
fake harness can create and run a session without importing Copilot classes.

### Stage 2 — Pi experimental adapter

1. Security-review and pin one exact `@earendil-works/pi-coding-agent` version.
2. Implement `PiHarnessClient` with Pi's in-process TypeScript SDK.
3. Map PilotSwarm session IDs to Pi `SessionManager` JSONL files under the
   exact `sessionStateDir` supplied to the harness factory. PilotSwarm snapshot
   probes and the adapter must use that same root; never infer it from ambient
   Pi or Copilot configuration.
4. Map `send` to `AgentSession.prompt`, `abort` to `abort`, `disconnect` to
   `dispose`, and Pi subscriptions to the normalized event protocol. An
   accepted run must emit one authoritative final-message event followed by
   exactly one `session.idle`; steer sends must return an ID later confirmed by
   `user.message`.
5. Adapt PilotSwarm tools through a Pi inline extension/custom-tool bridge.
   Declarations may be fixed for a live handle, but handlers are refreshed at
   every turn. If a turn changes the declaration set, recycle the handle before
   execution; never run stale handlers.
6. Select the adapter with an explicit worker option; default remains Copilot.

**MVP subset for Pi:** text prompts, streaming text, application tools, abort,
warm reuse, cold resume, and final error/completion. Images, live steering,
native subagents, MCP adoption, and dynamic tool refresh fail closed with a
clear unsupported-capability error until their stage lands.

**Exit:** the same scripted black-box turn suite passes against Copilot and Pi
for the MVP subset, including event ordering/settlement and cold resume on
another worker process using a non-default `sessionStateDir`.

### Stage 3 — capability parity

Add explicit harness capabilities rather than adapter-name checks:

- image attachments;
- steering/follow-up during a live turn;
- dynamic tool and system-prompt refresh;
- model/thinking/context mutation;
- MCP and repository resource adoption;
- native synchronous subagents and background-task control.

A session is admitted only when its requested PilotSwarm features are supported
by the selected harness. Unsupported combinations fail before model execution.

### Stage 4 — operations and rollout

Add harness identity to worker registration and turn diagnostics, canary Pi
workers in a separate pool, compare completion/error/abort/resume metrics, then
allow mixed pools only after session routing pins a session to a compatible
harness.

## Pi mapping notes

Pi's documented SDK provides `createAgentSession()`, `AgentSession.prompt()`,
`subscribe()`, `abort()`, `dispose()`, and persistent `SessionManager` JSONL
sessions. These cover the Stage 2 subset. Important differences are:

- Pi uses `agent_settled` as the end of automatic work; `agent_end` can be
  followed by recovery or queued work.
- `message_end` is authoritative; streaming updates are deltas.
- Pi persistence is a JSONL entry tree, while current PilotSwarm snapshots copy
  a Copilot session-state directory. The Pi adapter must own that translation;
  the orchestration must not learn Pi's file format.
- Pi tools are registered as custom tools/extensions, not Copilot `Tool`
  objects. Tool invocation context and result/error shapes need adapter tests.
- Pi has no equivalent guarantee for Copilot task RPC. Native subagents stay
  disabled until represented by an explicit capability.

## Configuration

Stage 2 should add one explicit option:

```ts
new PilotSwarmWorker({
  agentHarness: "pi", // default: "copilot"
});
```

Do not infer the harness from model provider names. Harness selection controls
session storage, event semantics, and tools; model selection controls inference.
Changing harness for an existing session requires an explicit migration or a
new session.

## Failure and compatibility rules

- Copilot remains the default and must be byte-for-byte configuration
  compatible in Stage 1.
- The selected harness is recorded with session ownership metadata before the
  first turn in Stage 2.
- A worker that cannot serve the recorded harness refuses the activity so it
  can be routed elsewhere; it must not silently fall back.
- Adapter errors use normalized categories (`transport_lost`, `aborted`,
  `unsupported`, `model_error`) while retaining a redacted original message for
  diagnostics.
- Harness state is never shared between adapters under the same session-state
  directory.

## Test plan

### Stage 1 (implemented with the MVP)

```bash
npm run build --workspace=packages/sdk
# Expect: TypeScript build succeeds.

node --test packages/sdk/test/unit/agent-harness.test.mjs
# Expect: injected fake harness and default Copilot adapter contract tests pass.

npm run test:unit --workspace=packages/sdk
# Expect: SDK unit suite passes with unchanged Copilot behavior.
```

### Stage 2 Pi adapter

1. **Unit:** event translation, tool argument/result/error conversion,
   completion settlement, abort, unsupported capability gates, and session-path
   isolation using fake Pi sessions.
2. **Component:** run one scripted local model server through both adapters and
   assert the same PilotSwarm `TurnResult` and persisted CMS events.
3. **Cold resume:** finish turn 1, stop worker A, restore on worker B, run turn 2,
   and verify both turns are in model context.
4. **Crash recovery:** kill the worker during generation and verify the durable
   activity retries without duplicate tool side effects.
5. **Real smoke:** with existing authenticated profiles, run a read-only
   repository question through each harness; verify streamed output, one tool
   call, final completion, and no secrets in logs.

### Stage 3 parity matrix

Maintain a table-driven suite where each feature is `supported`, `unsupported`
(fails before execution), or `degraded` with an asserted diagnostic. Never skip
a feature silently based on adapter name.

## Non-goals

- Replacing Duroxide orchestration or PilotSwarm's durable session API.
- Converting existing Copilot session files to Pi in the MVP.
- Making Copilot and Pi event payloads identical beyond PilotSwarm's needs.
- Adding a generic plugin marketplace for arbitrary harnesses.
- Enabling Pi native subagents or MCP before lifecycle and authority parity is
  proven.
