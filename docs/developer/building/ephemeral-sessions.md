# Ephemeral sessions

`runEphemeralSession()` runs a tool-enabled Copilot session without retaining
its transcript. The SDK handles execution and cleanup; the application owns
the workspace, prompts, output validation and usage persistence.

This API is available through `getHostServices()` on a started worker or
direct management client with initialized CMS/provider storage and a provider
type catalog. CMS-only bindings omit it. It is not a browser, RPC or MCP API.
Check that `services.runEphemeralSession` is available before calling it;
availability does not bypass authorization or request validation.

## Example

```ts
const services = worker.getHostServices();
if (!services.runEphemeralSession) throw new Error("Host execution unavailable");

let repairs = 0;
const result = await services.runEphemeralSession({
  actor: initiatingPrincipal,
  executionId: executionCorrelationId,
  model: selectedProviderQualifiedModel,
  workingDirectory: privateHostWorkspace,
  systemMessage: applicationInstructions,
  prompt: initialPrompt,
  reasoningEffort,
  contextTier,
  signal,
  progressStages: ["reading", "working"],
  onProgress: async event => saveSafeCheckpoint(event),
  onUsage: async update => upsertUsageByInvocationId(update),
  onResponse: async () => {
    const validation = await validateApplicationOutput();
    if (validation.ok) return { action: "complete" };
    if (repairs++ >= 5) throw new Error("Repair budget exhausted");
    return { action: "continue", prompt: validation.correction };
  },
});
```

Repairs reuse the same session and workspace. The application sets the repair
limit; throwing from a callback ends execution. Responses include `text`,
1-based `iteration`, `resolvedModel` and `usage`. The final result adds resolved
model settings, `turnCount` and aggregate usage. Failures use
`EphemeralSessionError` with a typed error code.

## Authorization and isolation

- The actor must be a persisted, authenticated user or administrator. Execution
  does not create users, change roles or grant application access.
- Normal provider eligibility and credential ownership checks apply. Admins
  cannot use another owner's personal key; personal workload identity is prohibited.
- A private helper process uses isolated configuration and temporary directories.
  It does not inherit CMS credentials or discover plugins/configuration.
  Transcripts are discarded, session metadata stays in memory, and native
  tool-output spill files are disabled.
- File tools, Python via bash and synchronous native tasks can use the workspace.
  Native tasks cannot start nested work. Durable spawning, facts, schedules,
  factories, remote sessions, telemetry and web/MCP access are disabled.

**This is not an OS sandbox:** shell commands can still access worker-readable
paths and the network.

Progress uses `ephemeral_report_progress` with declared stages and validated
counts. The SDK adds sequence, time and iteration; the application must still
validate output. Progress is not proof of completion.

## Parallel native children (opt-in)

Opt in through the request options; the SDK validates assignments and progress:

```ts
nativeChildren: {
  maxConcurrent: 20,
  assignments: [{ id: "batch-0", sessionRefs: ["s0", "s1"] }],
  progressStages: ["classifying"],
},
onChildProgress: async event => saveAgentReportedProgress(event),
```

The trusted host supplies immutable, unique assignments and disjoint opaque
session references. The parent launches each once with
`task({agent_type:"swarm-task", mode:"background", name:"batch-0", description, prompt})`.
Capacity is 1–20; excess launches are denied, not queued. Use `read_agent` with
returned IDs to wait, then fill freed slots. Children inherit the selected model,
effort and context; no grandchildren, `write_agent`, respawning or detached shells.
Omitting the opt-in preserves synchronous native tasks.
Receipt IDs are verified against the native task registry even before start
events arrive; later start events must match that binding before child progress.

Children call `ephemeral_report_child_progress({stage, completedSessionRefs})`
with cumulative references, after writing their structured records. The SDK
binds the runtime child ID to its assignment, rejects foreign references,
duplicate/regressing progress and identity/global-count arguments, and adds
`assignmentId`, `childId`, execution-wide `sequence`, launch `iteration` and
`updatedAt`. Parent progress remains separate. These are **agent-reported**
observations; only the application can validate artifact coverage.

All assignments and completion-triggered parent turns must settle before
`onResponse`. Missing, failed or cancelled children fail closed; the native
drain's ten-minute timeout also fails closed. Repairs may use structured
artifacts but cannot relaunch assignments. Parent/raw-transcript separation
remains an application prompt/workspace policy, not an OS access boundary.
Cancellation and failure stop the owned process group before scratch removal.
Cleanup events retain late usage without restarting host inactivity deadlines.
Parallel usage identities are scoped per runtime child; duplicate notifications
are not additive, and incomplete failed-call usage stays unknown.

In this opt-in mode, a structured HTTP 429 may recover only when the runtime
also marks its model-call error recoverable. The same parent or child receives
at most two native retry authorizations per consecutive failure episode, with
native backoff; only a successful model dispatch resets that budget. Assignments
are never respawned or replayed. Exhaustion and other errors remain terminal,
and cancellation stops recovery. Failed-attempt usage remains included or unknown.

## Usage and accounting

**Ephemeral calls bypass provider consumption accounting:** no ledger, durable
claims, meters, allowance consumption, budget admission or holds. Provider limits
cannot constrain or reflect this spend. Durable-session accounting is unchanged.

Persist `onUsage` updates by `invocationId`, **replacing** each invocation's usage
and optional `usageDiagnostics` together rather than summing callbacks. Updates
include `iteration`, `completed` and `usageUncertain`; the final result aggregates
distinct iterations. Parent, native-task and compaction observations are reconciled.

- Unknown counters stay `null`; failure, cancellation or completion does not
  make missing usage known. Keep input, output, cache-read and cache-write fields
  separate. Completions input already includes cached input: do not add it again.
- Distinct `apiCallId`s stay distinct even when tracing IDs are shared.
  Ambiguous identities and conflicting observations remain unknown.
- Optional diagnostics report observed calls and bounded reasons for missing,
  invalid, conflicting, interrupted or unidentifiable usage. They contain no
  event bodies or call IDs. Late correlation may revise counts; empty reasons
  do not prove complete provider delivery.
- **Pinned runtime limitation:** SDK 1.0.14 / CLI 1.0.85 can convert omitted BYOK
  usage to zero before PilotSwarm sees it. Diagnostics cannot distinguish these
  zeros from measured zeros or recover missing upstream counters.

`executionId` and `invocationId` are correlation IDs, **not idempotency keys**.
Repeating an execution can incur more spend. The application owns retry
coordination and persistence; there is no independent PilotSwarm usage history
or consumption-grid entry if the caller loses or does not save the observations.

## Resetting context between batches

A session can be reused across batches with its conversation genuinely
discarded at each boundary. Opt in with `contextReset: true` and return the new
`onResponse` decision:

```ts
const result = await runEphemeralSession({
    actor, executionId, model, workingDirectory, systemMessage,
    prompt: prompts[0],
    contextReset: true,
    onResponse: async response => {
        results.push(response.text);
        const next = prompts[results.length];
        // Same session; the neutral reply can still carry prior context.
        return next ? { action: "clear_context", prompt: next } : { action: "complete" };
    },
});
```

`{ action: "clear_context", prompt }` has exactly two keys, like `continue`.
The difference is that `continue` keeps the conversation and `clear_context`
discards it: `prompt` is delivered as an ordinary turn **after** the reset is
proven, and is never handed to the runtime's own reseed.

### What actually happens at a boundary

CLI 1.0.85 applies `history.clearContext` one turn late. The turn that carries
the clear still runs against the stale window, and that turn's assistant reply
is carried into the first clean window.

PilotSwarm therefore spends the boundary as its own **internal reset turn**,
seeded with a fixed neutral prompt, and sends your real batch prompt as a
separate turn afterwards — against a window that has actually been rebuilt.
The reset tool is advertised for the whole session, but it is honoured only
during that turn and only for the root session; a call at any other time is
denied.

> **This is not total isolation, and the SDK does not claim it is.**
> The internal turn's assistant reply is written by the model while the
> finished batch is still in view, and that one message survives into the next
> batch's window. It can mention previous work. Everything else is gone: every
> earlier prompt, every earlier assistant and tool message, and the neutral
> seed itself.

The boundary is verified against facts, not prompt text:

- the model actually invoked the reset tool
- `session.context_cleared` reported a positive integer `messagesCleared`
- the turn reached idle without `session.error` or `model.call_failure`

If any of those fail, the next batch's prompt is never sent. The three
verification failures above raise `EPHEMERAL_RESET_FAILED`; other failures
inside the barrier keep their own code — a dead helper is
`EPHEMERAL_INVOCATION_FAILED`, a blown deadline `EPHEMERAL_ABORTED`, a changed
model `EPHEMERAL_MODEL_CHANGED`. So `EPHEMERAL_RESET_FAILED` proves the prompt
was not dispatched, but it is **not** the only code that means that: do not read
the converse. A reset never silently degrades into plain reuse.

**Teardown quality outranks it.** If cleanup also fails, or the final usage
callback throws, the run reports `EPHEMERAL_CLEANUP_FAILED` or
`EPHEMERAL_CALLBACK_FAILED` instead — deliberately, because an undrained process
group or a lost usage observation is a failure of the whole run and must not be
downgraded to a reset-specific code. A failed barrier often leaves the helper
unhealthy, so this is exactly the correlated case. The narrow "not dispatched"
signal is unavailable there; treat those codes as fatal and uncertain.

A `session.context_cleared` event outside the host-driven reset barrier raises
`EPHEMERAL_UNEXPECTED_CONTEXT_CLEAR`. This is a **whole-run fatal context-integrity
failure**, not a batch-local invocation failure: stop the run rather than requeue
the batch or continue other work. The current prompt may already have been sent;
the code does not provide the reset failure's "next prompt not dispatched"
guarantee. No `onResponse` or subsequent prompt follows the event; observed usage
is finalized during teardown. Cleanup and callback failures retain precedence.

#### What a boundary costs

The internal turn performs **real inference**. Measured on CLI 1.0.85 against a
scripted endpoint, a boundary the model honours on its first attempt costs
**two** provider requests, so a run of *N* batches whose every boundary lands
first time makes `N + 2 × (N − 1)` model requests. That is a floor, not a fixed
figure: a live model may decline the reset tool, and **each declined attempt
adds one further request** before the boundary is retried or fails closed.

| batches | phase sequence | requests | message counts per request |
|---|---|---|---|
| 2 | `batch-0 → reset-call → reset-seeded → batch-1` | 4 | `[2, 4, 7, 3]` |
| 4 | `batch-0 → (reset-call → reset-seeded → batch-N) × 3` | 10 | `[2, 4, 7, 3, 5, 8, 3, 5, 8, 3]` |

The second request of each boundary (`reset-seeded`) still carries the **full
stale window** — the largest request in the run. A boundary is not token-cheap:
it re-sends the finished batch's context one extra time. Every post-boundary
batch request is exactly `[system, assistant(reset reply), user(batch)]`.

That usage is reported honestly. It is attributed to the batch the boundary
precedes — the same `invocationId` and `iteration` — and is visible through
`onUsage` from the moment it is spent. `result.usage.apiCalls` counts the
internal turns, so it equals the number of requests the provider actually saw,
not the number of batches. Distinguish:

| quantity | value for *N* batches |
|---|---|
| host batches (`result.turnCount`, `onResponse` calls) | `N` |
| internal reset turns | `N − 1` |
| provider/model requests (`result.usage.apiCalls`) | `N + 2 × (N − 1)` on first-attempt boundaries, plus one per declined reset attempt |

No reset is performed after a `complete` decision.

The boundary is verified inside the SDK, against the runtime's own
`session.context_cleared` event rather than prompt text. There is no host
subscription for it: the internal reset turn never appears in `onResponse` or
`onProgress`, and a boundary that cannot be proven ends the run with an error
instead of reporting success.

### Qualifying a build without credentials

`packages/sdk/test/fixtures/consumer-context-reset/context-reset-smoke.test.mjs`
is a self-contained check that runs against an installed package — no database,
no provider credentials, no PilotSwarm checkout:

```bash
npm i ./pilotswarm-sdk-<version>.tgz vitest
npx vitest run context-reset-smoke.test.mjs
```

It drives a real session across a boundary against a scripted loopback endpoint
and asserts that no earlier prompt, and no identifier the model itself spoke in
an earlier batch, appears in the next batch's provider request body.

### Scope and restrictions

| condition | behaviour |
|---|---|
| `contextReset` absent or `false` | unchanged; the reset tool is not registered and no new traffic occurs |
| any provider type or transport | supported; the reset uses only the runtime's own RPC and never synthesizes provider traffic — see the verified matrix below |
| `nativeChildren` | refused: children issue their own model traffic a clear could land in the middle of |
| native `task` delegation | denied at the permission hook: a cleared window cannot account for children it no longer remembers spawning, so a reset session is a leaf worker. The tool descriptor stays registered (the isolation check requires it); only invocation is refused. Sessions without `contextReset` keep ordinary synchronous delegation. |
| `clear_context` returned without `contextReset` | `EPHEMERAL_RESET_UNSUPPORTED` |

The boundary is **inter-batch only**. There is no periodic or intra-batch
clearing.

### Verified transport matrix

The reset is driven through the runtime's own RPC and never synthesizes
provider traffic, so it should not depend on the wire. That argument is backed
by measurement in `test/local/ephemeral-reset-transports.test.js`, which runs
the same boundary assertions against a real scripted endpoint per wire:

| provider type | wire observed | path the runtime built | streamed | boundary |
|---|---|---|---|---|
| `openai` | chat-completions, buffered JSON | `/v1/chat/completions` | no | verified |
| `azure` | chat-completions, buffered JSON | `/v1/deployments/{model}/openai/deployments/{model}/chat/completions?api-version=…` | no | verified |
| `anthropic` | messages, SSE | `/v1/messages` | yes (every request) | verified |

All three produce the identical phase sequence
(`batch-0 → reset-call → reset-seeded → batch-1`), four provider requests at two
batches, a post-boundary window of exactly `[system, assistant(seed reply),
user(batch)]`, a preserved system instruction, and
`usage.apiCalls === requests served`. `openai-proxy` and `anthropic-wif` map
onto `openai` and `anthropic` on the wire, so they are covered by those rows.

Three honest limits on this evidence:

- These are **loopback fixtures on the real runtime**, not calls to a vendor.
  They prove the reset mechanism is wire-independent; they do not qualify any
  vendor endpoint.
- The Azure row proves the reset works for Azure's body shape and auth. It does
  **not** qualify a real Azure endpoint. The fixture accepts any path, and the
  path the runtime built shows `deployments/{model}` applied **twice** — once by
  `provider-catalog.ts` (`resolvedUrl`) and once by the Copilot SDK's own Azure
  URL construction. Against a real deployment that path would not resolve. This
  is a concrete, uncovered Azure integration issue that predates and is
  independent of the context reset; it is recorded here rather than fixed, and
  **Azure endpoint behaviour is unqualified**.
- `type: "github"` (native Copilot) is **unverified**. It resolves credentials
  rather than a `baseUrl`, so it cannot be pointed at a loopback fixture; see
  the note on the real-model smoke below.

### Verified against a real model

A boundary has been exercised end to end against a live model, two synthetic
batches and one boundary per run. The transport actually observed was **native
GitHub over HTTP**; the WebSocket path was not exercised and is unverified.

On a run where the model calls the reset tool on the first attempt, two batches
cost **four provider requests**: batch 0, the reset turn, its seeded
continuation, and batch 1. That is the first-attempt figure, not a fixed
formula — each declined reset attempt adds one further request (see below).

Credentials resolve only through the provider credential. The supported runner
accepts an explicit `credential.secretRef`, and with one supplied the run
reached a successful model call. For `type: "github"`,
`resolveProviderCredential` reads the token from that `secretRef` and has no
ambient fallback, so a local `copilot` CLI login is not picked up: without a
`secretRef` the run stops at `EPHEMERAL_MODEL_UNAVAILABLE` during model
resolution, before a session exists and before anything is billed.

A separate diagnostic probe of `GET /copilot_internal/v2/token` returned HTTP
403. That probe is **not** evidence that SDK authentication is blocked — the
supported path succeeded with the same credential — and nothing here establishes
why that endpoint refused it.

#### The reset depends on model tool-choice compliance

The clear is driven by a tool the model must choose to call, and a live model
does decline it, answering in prose instead. A declined turn leaves the window
untouched, so the boundary re-prompts rather than failing on the first refusal,
up to `RESET_ATTEMPTS` (3) attempts, and then fails closed with
`EPHEMERAL_RESET_FAILED` without sending the next batch. Every attempt is real
inference and is counted in `usage.apiCalls`.

Retry is deliberately narrow. It applies only when the turn ran to completion,
the model never called the tool, and nothing was cleared — the one case that
provably leaves the window as it was. A turn that never reached idle, a tool
call whose clear went unreported, or a clear observed without that tool call is
ambiguous or partial and fails immediately, because repeating it could clear
twice. Provider and session errors are not declines and are never retried.

Refusals proved correlated within a run rather than independent, so each attempt
is worded differently instead of repeating the same words into a window that now
contains the refusal.

What was actually run against the live model, in full: 11 runs on
`gpt-5.6-terra`, of which 1 failed with `EPHEMERAL_RESET_FAILED`. Those runs
span two different prompt revisions, and the single failure occurred before the
escalating retry prompts were added; the 6 runs after that change all passed on
the first attempt. Earlier, before any retry or prompt hardening, several
boundaries also failed closed. **No success rate should be read from this.** The
sample is small, the prompt changed within it, and it covers one model on one
transport. Treat `EPHEMERAL_RESET_FAILED` as a live outcome and handle it.

Retry behaviour itself is not inferred from those runs. A live model cannot be
made to decline on cue, so `test/local/ephemeral-reset-retry.test.js` scripts
each path against a real endpoint: a decline followed by compliance still lands
a clean window, charges all five requests, and never surfaces the refusal to the
host; a boundary that is never honoured stops after exactly `RESET_ATTEMPTS`
attempts without running the next batch; and a provider failure on the reset
turn stops immediately instead of consuming an attempt.

## Cleanup and runtime compatibility

Scratch lives under `.pilotswarm-ephemeral/` in the **host process working
directory**, not the request workspace. Ignore this directory in host checkouts.
Each invocation owns a fresh directory; previous directories are untouched.

Cleanup stops native tasks and the helper process group before deleting scratch,
including after cancellation or IPC loss. Cleanup failure prevents success.
Remove the application workspace only after execution returns. Host shutdown
drains tracked work before closing CMS.

Qualified versions: `@github/copilot-sdk` **1.0.14**, CLI **1.0.85**. Other CLI
versions fail with `EPHEMERAL_RUNTIME_UNQUALIFIED` before session creation or
prompt delivery. Upgrading requires fresh qualification; there is no bypass.

## Tests

The runtime suite uses the pinned SDK/CLI with a synthetic loopback provider;
no live credentials, operator database or external model is needed.

```sh
npm run build --workspace=packages/sdk
node --test packages/sdk/test/unit/ephemeral-*.test.mjs
npm exec --workspace=packages/sdk -- vitest run test/local/ephemeral-session-runtime.test.js
```
