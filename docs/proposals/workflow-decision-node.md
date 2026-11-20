# Workflow decision node

Status: **IMPLEMENTED** (design v11, 2026-11-20).

- Date: 2026-11-19
- Design-evidence source pin: `microsoft/PilotSwarm` at `b71f78d2e6c80603d4e3a2a43c756e4a03fe98fa`
- Implementation: `microsoft/PilotSwarm` code at `60c301ed79b27ecba508c8d8f61d01e7980877ee`, independently source-reviewed with no blocking defect.
- Verified build: commit `cfdd6d55f651639adaaccc354149d0c4131edcde` (the same code plus this document) on 2026-11-20. Install, SDK build and type check, and full monorepo build passed. Decision unit tests: 134 of 134 passed. PostgreSQL suites: 144 of 144 passed in 10 files, covering the provider-inference ledger, Decision runtime, definition tests, migrations 0099 and 0100, migration inventory, controller versions, model admission, the Cluster Decision Default, and provider reload.
- The formal artifacts below are design evidence, not evidence that this commit runs.

## Review result

v11 keeps the v10 completion semantics and clarifies when the node is available and which provider may receive workflow data. A live Decision node without its saved provider identity returns `invalid_input` instead of sending state to a same-name replacement. A test run needs no provider credential: the fixture or parent supplies the answer. These behaviors are covered by source review and the synthetic test suites above, not by live service results.

| v10 proposal | v11 result |
|---|---|
| New model completion/receipt kernel | **Removed.** Decision uses the existing Workflow effect → Duroxide history → `completeNode` CAS path. `completeAgentNode` is unchanged. |
| Stable-identity Decision replay protocol | **Removed.** The effect orchestration owns one recorded result; late work cannot replace the node row. |
| Broad attempt state machine | **Removed.** Reuse `effect_attempts`; at most two provider calls per node execution. |
| Broad 41-column inference ledger | **Reduced.** Small generic table with key, attribution, capability/purpose, token fields, and timestamps. |
| Decision entries mixed into chat models | **Changed.** Decision deployments use a separate `decisionModels` list. |
| Cluster-wide `foundry-wif` requirement | **Removed.** `decision` is an optional provider capability. No Workflow core code branches on a provider type. |
| Capability-blind authoring | **Changed.** Skills advertise the node only when the runtime reports an eligible Cluster Decision Default; save and Start validate availability. |
| Endpoint/protocol/served-model catalog fields | **Removed.** Derive the Foundry root; one v1 adapter owns the protocol. |
| Multiple Decision metrics | **Reduced.** One closed-label call counter, existing token metrics, and traces. |
| Attempt evidence in node output | **Removed.** Node output is semantic-only. |
| Real/mocked Decision test mode | **Removed.** Workflow tests always intercept. Live qualification is separate. |

## Product behavior

| Choice | v11 |
|---|---|
| Node type | First-class `decision` node, conditionally available |
| Questions | `choice`, `noul`, and `score` |
| Routing | `choice`/`noul` route to labels; `score` produces `scored` |
| Confidence | Optional for `choice`/`noul`; threshold requires `uncertain` |
| Output | Semantic result only |
| Model binding | Required Cluster Decision Default; eligible per-node override may select another Decision model |
| Fallback | No chat inheritance and no first-available fallback |
| Auth | Provider-adapter credential policy; no required provider type in Workflow core |
| Availability | An eligible Cluster Decision Default must exist; otherwise the node is unavailable and authoring fails with a diagnostic |
| Calls | At most two provider calls per node execution |
| Terminal result | Existing `completeNode` pending-only CAS |
| Images | Deferred |
| Score bands | Deferred |
| Consequential human decisions | Node is never sole authorization |

## Authoring contract

```yaml
route_ticket:
  type: decision
  input: "${input}"
  question:
    type: choice
    instructions: Which team should handle this ticket?
    criteria:
      engineering: Bugs, outages, integrations, and application failures
      billing: Charges, invoices, refunds, and payments
      support: Sign-in, account access, and how-to questions
  confidence:
    minimumProbability: 0.80
  timeoutSeconds: 30
  transition:
    next:
      engineering: investigate_engineering
      billing: investigate_billing
      support: help_support
      uncertain: ask_person
      failure: failed
```

The syntax compiler reuses Workflow schema and route machinery. It rejects dynamic options, duplicate/reserved labels, missing or extra routes, invalid thresholds, and every route mismatch.

## Conditional availability and compiler feedback

This node is available only when the active runtime catalog has an eligible Cluster Decision Default. A `decision` deployment in the catalog is not enough by itself if no default is configured.

The authoring path is capability-aware:

1. The workflow advertisement reports a small availability object.
2. `workflow-authoring` tells the LLM to use `decision` only when `workflows.decision.available` is `true`.
3. The catalog keeps `decisionModels` separate from chat `models`; `list_models` exposes `decision_models` and `decision_default_model` separately.
4. If an LLM emits the node anyway, `workflow_definition save` stores the revision as invalid with an actionable diagnostic.
5. Start repeats the availability and provider-ownership check against the current catalog before any Workflow or provider work begins.

Keep the `workflow-authoring` skill registered; its Decision section is behind a capability guard. At session creation, Workflow guidance adds one current line: either `Decision nodes are unavailable: no eligible Cluster Decision Default is configured.` or `Decision nodes are available with default <qualified model>.` The skill can therefore teach the syntax without telling an LLM on an unconfigured cluster to use it.

```json
{
  "workflows": {
    "decision": {
      "available": true,
      "defaultModel": "azure-foundry:ps-decision-1-1",
      "models": ["azure-foundry:ps-decision-1-1"]
    }
  }
}
```

When unavailable, the object has `available: false`, a null default, an empty model list, and a stable reason such as `no_cluster_decision_default`.

Keep the structural compiler environment-independent. `compileWorkflow` recognizes and validates Decision YAML/IR. A host capability validator runs immediately around it at save/publication and Start. This gives the LLM normal field diagnostics without making stored IR semantics depend permanently on a provider's current configuration.

```text
WORKFLOW_DECISION_MODEL_UNAVAILABLE
states.route_ticket.type
Decision nodes are unavailable because no eligible Cluster Decision Default is configured.
Configure an eligible Decision model in Admin Settings or replace this node.
Available decision models: none.
```

An explicit model cannot bypass a missing Cluster Decision Default. If a default exists, an override still has to name an eligible model from the active Decision catalog. A removed or inaccessible model fails Start; it never falls back to chat or to the first model.

## Confidence and result policy

The provider's selected decision is authoritative.

### `choice`

- Require every declared option and no extra option in the distribution.
- Require finite probabilities in `0..1`.
- Require the selected option to be declared.
- Confidence is the selected option's returned probability.
- Route `uncertain` only when confidence is strictly below the threshold; equality routes the selected option.
- Do not re-sort the distribution or reject a selected option merely because another probability is larger.

### `noul`

- Require a finite probability `p` in `0..1`. The live service returns only `p` (`answers.decision.noul`, the probability of true; confirmed by a live probe on 2026-11-20), so `yes = p` and `no = 1 - p`. If a `probabilities` object is present, it must hold exactly `true` and `false`.
- Select `yes` at `p >= 0.5`, otherwise `no`.
- Confidence is `max(p, 1-p)`.
- Route `uncertain` only when confidence is strictly below the configured threshold; otherwise route `yes` or `no`.

### `score`

- Require a finite returned score in the closed range `0` through the last level index.
- Require exactly one finite `0..1` probability for every declared level index; an optional provider legend must match the declared labels in order.
- Preserve the provider's score and ordered level distribution.
- Do not re-derive the score or add score bands in v1.
- Route `scored`; `confidence` and `uncertain` do not apply.

## Semantic-only node output

```json
{
  "questionType": "choice",
  "outcome": "engineering",
  "selection": "engineering",
  "confidence": 0.93,
  "probabilities": {
    "engineering": 0.93,
    "billing": 0.04,
    "support": 0.03
  },
  "policy": {
    "minimumProbability": 0.8,
    "uncertain": false
  },
  "model": {
    "qualified": "azure-foundry:ps-decision-1-1"
  }
}
```

A `noul` result uses the same policy and model convention, but names its normalized binary selection and raw probability explicitly:

```json
{
  "questionType": "noul",
  "outcome": "yes",
  "selection": "yes",
  "confidence": 0.83,
  "probability": 0.83,
  "probabilities": { "yes": 0.83, "no": 0.17 },
  "policy": { "minimumProbability": 0.8, "uncertain": false },
  "model": { "qualified": "azure-foundry:ps-decision-1-1" }
}
```

A `score` result has a narrower semantic envelope:

```json
{
  "questionType": "score",
  "outcome": "scored",
  "score": 2.37,
  "levels": [
    { "label": "Cosmetic", "probability": 0.01 },
    { "label": "Minor", "probability": 0.07 },
    { "label": "Major", "probability": 0.42 },
    { "label": "Critical", "probability": 0.5 }
  ],
  "model": { "qualified": "azure-foundry:ps-decision-1-1" }
}
```

`score` has no `selection`, `confidence`, raw `probabilities` object, or `policy`. Its ordered `levels` contain the declared labels and the normalized probabilities. Choice and `noul` always carry `policy`; `minimumProbability` is `null` when the author did not configure a threshold.

Provider request IDs, served model, HTTP status, timing, hashes, attempt IDs, and usage never enter node output. They belong in the inference-operation row or completion event. Downstream scripts and agent nodes receive the exact semantic result.

## Model binding and Cluster Decision Default

The Cluster Decision Default is the Decision capability gate, not merely a convenience fallback. An administrator may set it only from eligible `decisionModels`.

Rules:

1. With no eligible Cluster Decision Default, `decision` is unavailable to authoring, each save containing it is invalid, and a fresh Start refuses before creating a Workflow.
2. A per-node override does not bypass that availability gate; it only selects another eligible Decision model once the capability exists.
3. The additive `decision_models` Start alias accepts only Decision node ids from the exact revision, each as `{ model }`. The existing `agent_models` map can also carry Decision entries for wire compatibility; Decision entries take no reasoning or context setting.
4. The two Start aliases must be disjoint and merge into the same effective model map.
5. A Decision node without an override uses the Cluster Decision Default.
6. Chat-model inheritance and first-available fallback are forbidden.
7. Start materializes and persists the full effective map, including nested Decision nodes, before work begins.
8. Start revalidates overrides and Run again's prior effective map against the current catalog and the required default. A keyed replay returns the already-admitted map without resolving a new one.
9. There is no second run column or Run-again model path for Decision choices.

The Admin Console gains a Cluster Decision Default selector. It is admin-only and shared-provider-only. Existing personal, cluster-chat, and system-chat defaults stay chat-only.

The Cluster Decision Default can later serve a core caller, but v11 adds no core inference API or system-charge path. A future caller must define purpose, fallback, owner/charge class, and budget policy explicitly.

## Decision catalog and endpoint wiring

The core catalog is provider-neutral. For the initial Microsoft deployment, use the existing Foundry account and add one sibling deployment:

```json
{
  "name": "ps-decision-1-1",
  "model": {
    "format": "Microsoft",
    "name": "Microsoft-Decision-1.1",
    "version": "1"
  },
  "sku": {
    "name": "GlobalStandard",
    "capacity": 1
  }
}
```

Separate Decision deployments structurally from chat deployments:

```json
{
  "id": "azure-foundry",
  "baseUrl": "__FOUNDRY_ENDPOINT__/openai/v1",
  "models": [
    { "name": "gpt-5.4" }
  ],
  "decisionModels": [
    { "name": "ps-decision-1-1", "description": "Microsoft-Decision-1.1 for Workflow decisions" }
  ]
}
```

Chat readers enumerate only `models`. The Decision resolver enumerates only `decisionModels`. Auth fields remain provider-instance concerns and are not put on the decision model entry.

### Operator rollout: migrations, catalog, default and recovery

The database upgrade and Decision activation are separate. CMS migration **0097**
adds `provider_inference_operations` and changes usage reporting to add settled
inference tokens while retaining chat-only turn/session counts; **0098** adds
the initially empty Cluster Decision Default; **0099** expands the existing test
interception constraint for Decision operations; **0100** gives provider rows
an immutable ID that new live Decision runs pin at Start and use for claims
and settlement. It does not backfill old runs or claims by provider name. The
migrations run in that order after upstream migration 0096 when the new release
starts. 0097 also makes unknown provider usage a visible settled operation
count, not a fabricated zero-token call.

Operator rollout:

1. If upgrading from 0099, stop new Starts and drain live Decision runs and
outstanding inference claims before stopping old workers. A new live delivery
with no provider binding for its Decision state returns `invalid_input` before
provider admission. A pre-0100 claim that settles late retains its reported
usage but does not update live meters; reconcile only by an operator-approved
procedure. Stop old workers before starting the new release. Deploy the
type catalog with `decisionModels` separate from `models`; verify every runtime
provider instance is shared, credentialed and qualified by the concrete adapter.
2. Start the workers once so 0097-0100 finish, then start the portal and MCP
server. A Decision catalog/default/list failure must degrade only Decision to
unavailable; chat models and Workflows without Decision remain usable.
3. Configure the Cluster Decision Default from the eligible
`/models/decision` list in Admin Settings. Confirm `workflows.decision.available`
and both `list_models.decision_models` / `decision_default_model`.
4. Exercise only the synthetic fixture test path in qualification that has no
live endpoint. Record live Microsoft endpoint, RBAC and response qualification
as **NOT_RUN** unless an approved live probe actually runs.

**Rollback:** stop new Starts, drain or stop live Decision runs, and clear the
Cluster Decision Default to disable Decision authoring. On 0100 the 0099
worker's 12-argument claim returns false for `decision`; that caller returns
`execution_failed` ("already claimed") before inference transport, not proof
that a duplicate operation exists. The 0099 worker supports controller 1.2.0;
if the target image lacks that controller, also drain or stop runs awaiting a
1.2.0 start or currently executing on 1.2.0. Keep 0097-0100 and their data in
PostgreSQL. Restore the previous images before removing optional catalog
entries no new worker needs. Rollback or synthetic-fixture qualification does
not change the live Microsoft status from `NOT_RUN`.

### Provider capability and credential eligibility

A Decision model is advertised only when its registered provider adapter declares Decision support and that instance has a resolvable, qualified credential for the endpoint.

- Workflow core does not require or inspect `foundry-wif`; it asks the provider registry for capability.
- The initial Foundry adapter owns the Foundry protocol and its credential strategy. If that concrete adapter is WIF-backed, that fact stays inside the provider implementation and deployment config.
- A different provider can implement the same `DecisionProvider` contract and populate the catalog without a Workflow core change.
- Malformed provider type metadata, including a malformed `decisionModels` entry, rejects the entire candidate type catalog; the runtime keeps its last validated registry. This is fail-closed catalog behavior, not per-model fallback. Correct the file and let reconciliation reload it.
- An unqualified credential, unsupported adapter, or failed provider validation does not advertise the model and cannot become the Cluster Decision Default.
- This preserves fail-closed behavior without making one authentication type a product requirement.

For the initial Foundry adapter, derive the resource root from the existing `/openai/v1` base URL and call:

```text
<foundry-root>/providers/microsoft/v1/systemone
```

Do not add `decisionBaseUrl`, `decisionProtocol`, or `servedModel` metadata. The one v1 adapter owns the one protocol.

## Provider adapter and execution boundary

The Decision provider adapter is intentionally small:

```ts
interface DecisionProvider {
  decide(input: {
    model: string;
    state: JsonValue;
    question: DecisionQuestion;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<DecisionResponse>;
}
```

It reuses registry/provider identity, endpoint trust, the provider-declared credential strategy, owner eligibility, and budget admission. The Foundry implementation owns Foundry HTTP and result normalization. It receives no Workflow receipt, completion, or node-state object.

### Existing path reused

1. Controller starts a Workflow effect.
2. Decision activity calls the provider.
3. Duroxide records the activity result.
4. `recordEffectResult` calls existing `completeNode`.
5. `completeNode` performs the pending-only CAS.
6. Controller routes from the stored row.

No `completeModelNode`, completion hash, Decision receipt store, or change to `completeAgentNode` is added.

## Retry and indoubt recovery

Generalize the existing effect entry boundary. The existing `effect_attempts` value is the attempt identity.

### v1 policy

- Entry 1 may call the provider.
- A crash before the activity result reaches Duroxide may enter once more.
- Entry 2 is the last committed provider-attempt entry.
- Entry 3 records an `unavailable` activity result without a provider call; that result then follows the ordinary Duroxide history/CAS path.
- Network, 429, 5xx, and provider timeout do not retry inside the provider activity.
- A Workflow route may start a fresh node visit, bounded by `maxNodeExecutions`.

The attempt cap bounds committed effect entries, not the physical network. Like the existing script and agent effect paths, a worker can fail after sending a call and before the entry transaction commits. That can redeliver the external call. The terminal business/result state is still exactly-once by the existing `completeNode` pending-only CAS. A v1 provider call is a non-mutating Decision inference, so the rare duplicate affects usage evidence and cost, not external side effects. Each call attempt has its own inference-operation row.

The unresolved-effect backstop must cover both script and Decision nodes. If a Decision effect orchestration ended without storing a result, the collector records `execution_failed` only after the effect is terminal, just as it does for scripts.

### Usage settlement

Before the provider call, create an idempotent inference-operation row keyed by `(operationId, attempt)`. After a response, settle returned usage once. Duroxide result durability and usage settlement are separate boundaries; a crash after settlement may leave a recovery call with a new attempt key and separate usage evidence.

## Terminal semantics

The terminal guarantee is exactly the existing Workflow guarantee:

- pending node + valid result: one result commits;
- completed node: CAS loses and the stored row is returned;
- cancel, stop, deadline, deletion, or earlier result: that lifecycle winner stays;
- controller routes from stored `outcome`;
- next node reads stored `output` for business results or stored `error` for runtime failures.

This is the simplest common semantics. Agent-specific completion remains in `completeAgentNode`; Decision and script effects use `completeNode`.

## Runtime errors

| Condition | Outcome |
|---|---|
| Invalid provider shape | `invalid_output` |
| Invalid binding/schema | `invalid_input` |
| 401/403 | `forbidden` |
| 404/422/incompatible model | `unavailable` |
| 429/network/5xx | `unavailable` |
| Provider or node timeout | `timed_out` |
| Third entry | `unavailable` |
| Local budget/hold/allowance | `budget_exceeded` |
| Cancel/stop | `cancelled` |
| Other adapter failure | `execution_failed` |

No new runtime error codes are added.

## Budget and generic inference accounting

The existing chat ledger keeps `(session_id, turn_index)`. Add a small sibling:

```text
provider_inference_operations
  operation_id, attempt                         primary key
  capability, purpose
  session_id, workflow_run_id, node_execution_id nullable
  provider_name, model_qualified
  owner_user_id, charge_class, agent_id
  tokens_input, tokens_output
  tokens_cache_read, tokens_cache_write
  tokens_total                                  NULL = unknown
  created_at, settled_at
```

Budget unit remains tokens:

```text
tokens_total = tokens_input + tokens_output
```

The table is generic enough for a future embedding or reranking caller to add rows once that caller has provider/model/owner attribution and usage. Defer non-token units, raw provider usage, request/response hashes, HTTP/error columns, capability JSON, and embedding/reranking reports.

The usage projections union chat rows with every row whose `settled_at` is present; the settled-operation index uses that predicate so unknown usage is included. Token totals add known operation usage. `turns`, `sessions` and `turnTokens` remain chat-only, while `operations` and `unknownUsageOperations` remain visible per window, day, model, agent and charge class; Tok/turn therefore never divides Decision operation tokens by chat turns. The current durable embedder is not automatically billable: it lacks CMS provider/owner attribution and needs an explicit later cutover.

## Metrics and telemetry

Use one closed-label counter:

- `pilotswarm.inference.calls{capability,result}`

Reuse existing `pilotswarm.tokens{direction}`.

Put provider/model, operation/attempt, purpose, HTTP status, latency, token counts, and node execution in traces and durable rows. Do not add separate counters for uncertainty, attempts, replay/conflict, duration, unknown usage, or cache.

## Test mode

Workflow tests always intercept the Decision effect. A fixture or parent answer supplies the raw provider response; the same parser and confidence policy run. A missing fixture never falls back to a live provider.

Do not add `decision_mode`, a run column, a Start parameter, or a test-mode notice. Live provider qualification is a separate approved operation.

## Required test set

Keep a compact test matrix:

1. Compiler exact routes, invalid thresholds, and reserved labels.
2. Choice/noul/score structural parser and threshold equality.
3. One pinned synthetic Microsoft-shaped response fixture; it is not live Microsoft qualification.
4. One table-driven HTTP/error mapping test.
5. Effect fault test: attempt 1, redelivery attempt 2, third entry refused with no call.
6. CAS/lifecycle test: result vs cancel/deadline/stop keeps first stored winner.
7. Settled and unknown usage rows per attempt.
8. One fixture workflow proving `score` reaches a script as `context.input.score` and reaches an agent unchanged.
9. Registry test proving Decision deployments never enter chat pickers/defaults/first-available.
10. Capability and guidance test: `decision` is available only with an eligible Cluster Decision Default; static authoring guidance contains the runtime gate.
11. Save diagnostic test: a `decision` node with no configured default returns `WORKFLOW_DECISION_MODEL_UNAVAILABLE`, including when an explicit model is supplied.
12. Start revalidation test: a model removed after save refuses Start with no fallback.
13. Provider qualification test: Workflow core makes no provider-type check; the concrete adapter's supported credential mode is tested.
14. Qualification probe for real Foundry endpoint and RBAC behavior.

## Portal and TUI

Reuse existing Workflow Start, Node summary, and JSON output surfaces.

Show:

- node type;
- effective model;
- threshold/`uncertain`;
- outcome and probabilities or score;
- one warning for attempt 2 or unknown usage.

Do not show every attempt, hashes, request IDs, or a parallel detail subsystem. The Workflow Decision picker and Cluster Decision Default selector appear only when at least one eligible `decisionModels` entry exists. A default is still required for authoring availability.

## Insertion map

1. Add `WorkflowIRDecision` and strict stored-IR support.
2. Add a runtime `workflows.decision` capability plus separate `decisionModels` catalog output.
3. Add the Cluster Decision Default as the capability gate and Admin selector; allow only eligible Decision models.
4. Add the environment-aware save/publication validator and Start revalidator for `WORKFLOW_DECISION_MODEL_UNAVAILABLE`.
5. Update `workflow-authoring`, `workflow-reference`, and workflow session guidance with the runtime capability guard.
6. Parameterize the existing per-node model map for agent/Decision capability while preserving agent wire compatibility.
7. Register provider-specific Decision adapters behind the generic `DecisionProvider` interface; add no provider-type branch in Workflow core.
8. Generalize the existing effect entry helper and add `runDecision` behind the effect/test interception path.
9. Reuse `recordEffectResult` and `completeNode`; make no change to `completeAgentNode` or its receipt code.
10. Extend unresolved-effect collection to Decision nodes as well as scripts.
11. Add the small `provider_inference_operations` table and idempotent token settlement.
12. Add one inference call counter, existing token usage, and traces.
13. Add a new controller version and freeze 1.1.0. No Decision feature flag is needed because old IR cannot name the node.
14. Reuse existing Start, Node output, fixture, Portal, and TUI helpers.

## Formal review

The TLA+ model, cfg, finite mirror, saved report, and review note are **base-pinned design evidence** at `b71f78d2e6c80603d4e3a2a43c756e4a03fe98fa`. They cover the v10 effect policy: two provider deliveries, a third refusal without a call, history-before-CAS, lifecycle winner, route from stored outcome, and stored output/error handoff. The base had no effect cap in `enterScript`; the repaired implementation comparison head `6591fe14f043703c8985923ce3f96baf409932d3` enforces the cap in `runDecision` after an attempt enters. This documentation-only edit follows that code head; the model remains supporting evidence, not final-head proof.

The checked-in mirror was rerun and reproduced its report exactly: **164 distinct states**, no missing witnesses, and all mirrored invariants passed. It is supporting evidence, not TLC, a proof, or a formal PASS.

Verification status:

- **TLC: `NOT_RUN`** — Java is unavailable in the materialization environment.
- **Live Microsoft qualification: `NOT_RUN`** — no live Foundry endpoint, RBAC, or Microsoft-Decision response qualification is claimed by this PR.

Formal artifacts (all base-pinned design evidence, with the reviewed implementation head called out where relevant):

- [DecisionEffectCompletion.tla](workflow-decision-node/formal/DecisionEffectCompletion.tla)
- [DecisionEffectCompletion.cfg](workflow-decision-node/formal/DecisionEffectCompletion.cfg)
- [decision-effect-completion-enum.mjs](workflow-decision-node/formal/decision-effect-completion-enum.mjs)
- [decision-effect-completion-enum-report.json](workflow-decision-node/formal/decision-effect-completion-enum-report.json)
- [decision-node-completion-model-v10-review.md](workflow-decision-node/formal/decision-node-completion-model-v10-review.md)

## Review synthesis

Ponytail, Fable 5.2 xhigh, and the formal review agree on the smaller end state:

- keep the first-class node and Cluster Decision Default;
- remove a Decision receipt/kernel and stable identity protocol;
- reuse existing effect/history/CAS code;
- cap provider calls with the entry counter;
- keep semantic-only output;
- structurally separate Decision deployments from chat models;
- make provider authentication a provider-adapter capability, not a Workflow core requirement;
- expose `decision` conditionally through runtime capabilities and require a Cluster Decision Default;
- keep one call counter and a small token ledger;
- merge tests around the existing effect, route, and output boundaries.

The Fable credential concern remains fail-closed: a provider exposes Decision models only after its adapter and credential strategy are qualified. v11 resolves the concern without requiring one provider type cluster-wide. The formal cross-check also reinforces that receipts are not necessary on the effect path; the pending CAS is the safety boundary.

## Approval checkpoint

The product design was approved in v9. v10 simplified execution; v11 makes Decision conditional on an eligible Cluster Decision Default and explains unavailability during authoring. The final source review covered the nine-file repair from `816da77d7` to `60c301ed7`, including provider identity, fixture interception, and compatibility with the 0099 worker.

Implemented and verified as recorded at the top of this document. TLC, live Microsoft endpoint and RBAC qualification, and the live Web API model scenario remain `NOT_RUN`. The synthetic build and test results above do not change those three results.

## Appendix: a second provider, TypeSafe Jev (proposed, not implemented)

Status of this appendix: **PROPOSED** (thought exercise, 2026-11-20). Nothing in it is built. It tests the claim above that "a different provider can implement the same `DecisionProvider` contract and populate the catalog without a Workflow core change."

### What Jev is

Jev is TypeSafe AI's first "System One" model. Like Microsoft-Decision-1.1, it answers typed questions about a `state` and returns calibrated probabilities, not prose. pgEdge's AI DBA Workbench 2.0 beta uses Jev to classify monitoring alerts, with a fallback to a reasoning model when it needs an explanation.

| | Microsoft-Decision-1.1 (built) | TypeSafe Jev (this appendix) |
|---|---|---|
| Endpoint | `<foundry-root>/providers/microsoft/v1/systemone` | `https://api.typesafe.ai/v1/systemone` |
| Credential | Foundry `api-key` header, or `foundry-wif` bearer token | `Authorization: Bearer <API key>` only |
| Request | `{ model, state, questions: { <name>: question } }` | Same |
| Question types | `choice`, `noul`, `score` | Same, plus `box` (images; not used here) |
| `noul` answer | `{ type, noul }` (live probe, 2026-11-20) | `{ type, noul }` |
| `choice` answer | `choice`, `probabilities` | Same, plus a separate `confidence` |
| `score` answer | `score`, `probabilities`, optional `legend` | Same, plus `confidence`; `legend` always sent |
| Response top level | `answers`, `usage` | Same, plus `model`: the served model, which can differ from the requested alias (for example `jev-latest` served as `jev-1.13.0`) |
| Limits | Not published | `choice` 1–255 options; `score` 1–10 levels |
| Errors | 401/403, 404, 429, 5xx | 400 and 422 (request invalid), 401/403, 429, 5xx |
| Price (input) | US$0.042 per 1M tokens (Azure retail, westus3) | US$42 per 1 billion tokens (= US$0.042 per 1M); output tokens free |
| Data boundary | Inside the Azure tenant (Foundry) | External SaaS: Workflow state leaves Azure |

The two protocols are nearly identical, and the input price is the same. That suggests a common origin, but neither source read for this appendix says so.

### What already works unchanged

- **Workflow core.** The compiler, Start binding, controller 1.2.0, the Decision effect, `runDecision`, test mode and the UI do not change. The runtime asks a `DecisionProvider` to `decide()`; it does not know the vendor.
- **Parser.** `normalizeDecisionResponse` already accepts every Jev answer shape for `choice`, `noul` and `score`. It ignores `confidence` and the top-level `model`.
- **Ledger and accounting.** Rows record `provider_type_id = 'typesafe'`, tokens and `latency_ms` (0101). No migration is needed.
- **Admin and capability.** The Cluster Decision Default picker lists any shared instance that `qualifyDecisionProvider` accepts, so a qualified TypeSafe instance appears without UI change.

### Catalog and provider instance

A new, Decision-only provider type. It has no chat `models`, so no chat path can resolve it.

```json
{
  "id": "typesafe",
  "type": "typesafe",
  "baseUrl": "https://api.typesafe.ai/v1",
  "decisionModels": [
    { "name": "jev-1.13.0", "description": "TypeSafe Jev System One model, pinned release" }
  ]
}
```

- Pin a release name, not `jev-latest`, so a Workflow's behaviour does not change when TypeSafe ships a new model. `GET /v1/models` lists the names.
- The runtime instance is a **shared** provider named, for example, `typesafe`, with its API key in Key Vault like any other shared key. A personal instance cannot become the Cluster Decision Default (0098 already refuses it).
- An admin then chooses `typesafe:jev-1.13.0` as the Cluster Decision Default, or as a per-node override at Start.

### Code changes

| File | Change |
|---|---|
| `packages/sdk/src/model-providers.ts` | Add `"typesafe"` to `ProviderType`. Validation: a `typesafe` type must declare `decisionModels` and no non-empty `models`; `baseUrl` must be HTTPS without credentials and end in `/v1`. `toSdkProviderType("typesafe")` returns `"openai"` only so `ResolvedProvider.sdkProvider` carries `baseUrl` and `apiKey`, as `foundry-wif` already does; chat never reaches it because the type has no chat models. |
| `packages/sdk/src/decision-provider.ts` | Replace the single Foundry `qualify()` with a small adapter table keyed by `resolved.type`: `foundry` (today's `openai`/`foundry-wif` path, unchanged) and `typesafe`. The TypeSafe target is `<baseUrl>/systemone`, credential `bearer-key`, and refuses workload identity (`unsupported_auth`). Rename `FoundryTarget`, `FoundryCall` and `foundryDecide` to `SystemOneTarget`, `SystemOneCall` and `systemOneDecide`; `requestHeaders` gains the `bearer-key` case. The redirect refusal, 1 MiB cap, timeout and abort handling stay shared. |
| `decision-provider.ts`, `statusError` | Map per adapter. For TypeSafe, 400 and 422 mean the request was rejected; return `invalid_input` with a sanitized message, not `unavailable`. |
| `decision-provider.ts`, limits | Each adapter declares its limits. TypeSafe: at most 255 `choice` options and 10 `score` levels. A question over a limit fails with `invalid_input` before any claim or HTTP call. Optionally, Start also checks the bound model's adapter limits, so the person sees the error at Start, not mid-run. |
| `decision-provider.ts`, parser | Additive: accept an optional `confidence` from 0 to 1 on `choice` and `score` (reject it if it is out of range) and an optional top-level `model` string. Return them as `providerConfidence` and `servedModel`. |
| `applyDecisionPolicy` and node output | Additive fields: `model.served` and `providerConfidence`. Routing is unchanged: `choice` still uses the selected option's probability. A later, separate change could add `confidence.basis: probability \| provider` and allow an `uncertain` route on `score` using its `confidence`; that needs compiler, docs and UI work and is out of scope here. |
| `packages/sdk/src/provider-catalog.ts` | No logic change: `resolveQualifiedDecisionProviderCredential` already calls `qualifyDecisionProvider`. |
| UI (`workflow-decision.js`) | Optional: show "Model: typesafe:jev-1.13.0 (served jev-1.13.0)" when `model.served` differs. |
| Docs | `configuration.md`: the `typesafe` type, its key and the data-boundary warning. User guide: no change. |

Estimated size: about 250 lines of product code and 300 lines of tests. No migration, no controller or effect version, and no replay impact: the provider call happens inside the existing activity.

### Data boundary

Jev runs outside Azure. A Decision state's whole input goes to TypeSafe. Before an operator adds a `typesafe` instance:

- record a privacy and compliance approval for the data the Workflows will send;
- consider an Admin Console notice on the picker, "External provider: Workflow input leaves Azure";
- open question: should a deployment flag (default off) be required before a non-Azure Decision provider type can be loaded at all?

### Tests

| Test | What it proves |
|---|---|
| Unit, `workflow-decision-provider.test.mjs` | TypeSafe endpoint derivation (`/v1` to `/v1/systemone`); a `Bearer` header and no `api-key` header; HTTP-only, credential-in-URL and workload-identity refusals; the redirect refusal; TypeSafe-shaped `choice`, `noul` and `score` answers from its published examples; `confidence` and `model` passthrough and out-of-range refusal; 400/422 to `invalid_input`; limit pre-checks with no HTTP call. |
| Unit, catalog validation | A `typesafe` type with chat `models`, a non-HTTPS `baseUrl` or no `decisionModels` is refused. |
| Unit, availability | A shared, keyed `typesafe` instance qualifies for the Cluster Decision Default; a personal one does not. |
| PostgreSQL, existing runtime suite | One case with a `typesafe` provider type: claim, settle, latency and meters as for Foundry. |
| Live (owner approval and a TypeSafe key required) | Run the support-desk example against `typesafe:jev-1.13.0` and compare routes and latency with Microsoft-Decision-1.1. |

### Out of scope

`box` questions and image assets; several questions in one request (`questions` with more than one name); OpenAI's separate Decisions API, which uses a different protocol and would be a third adapter.

## References

- [Microsoft Foundry: Deploy and use Microsoft-Decision-1.1](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision), retrieved 2026-11-18.
- [TypeSafe System One API reference](https://docs.typesafe.ai/api/system-one.md) and [quick start](https://docs.typesafe.ai/introduction/quickstart.md), retrieved 2026-11-20.
- [TypeSafe AI: Jev](https://typesafe.ai), retrieved 2026-11-20 (input price).
- [pgEdge press release: AI DBA Workbench supports Jev and other decision models](https://www.pgedge.com/press-releases/pgedge-ai-dba-workbench-now-supports-jev-and-other-decision-models), 2026-11-19, and [pgedge-go-llm-lib](https://github.com/pgEdge/pgedge-go-llm-lib) (a `typesafe` provider in Go).
- [Microsoft-Decision-1.1 model catalog](https://ai.azure.com/catalog/models/Microsoft-Decision-1.1), retrieved 2026-11-18.
