Status: Work in progress (describes PR 270; source citations are pinned to 4fa702dc; later changes in the PR are listed in [Known issues](known-issues.md#done-in-this-pr-after-the-source-pin); not yet merged)

# Workflows: design as implemented

This document explains how a session hands a repeatable procedure to a durable graph. For example, a session can start a Workflow that checks a build, waits, checks again, asks an agent to assess the result, and sends the answer to its parent.

A **Workflow** is a PilotSwarm session whose engine executes a graph instead of a conversation. A **Workflow Definition** is reusable YAML owned by an ordinary session. Starting a definition creates a separate Workflow session with its own pinned copy and one live run. Saving the definition again does not change that run. See `packages/sdk/src/workflow/session-definitions.ts:324-386` and `packages/sdk/src/workflow/store.ts:2373-2415`.

## Scope and evidence

The source of truth is PilotSwarm commit `4fa702dc8b078b93c3e26339dc833b53d8acfee4`, a PR 270 candidate. All PilotSwarm `path:line` citations refer to that commit, not to a later branch tip. Changes the PR made after that commit (the completion refusal removed, the cleanup fixes, the fenced first start, package Workflow starts) are described where they apply and listed with their commits in [Known issues](known-issues.md#done-in-this-pr-after-the-source-pin); their line numbers are not re-pinned. The comparison with main uses `4ccbedcca57bcc6451919da98050dd7f09bbaca1`. This document describes code and recorded evidence. It is not a deployment or readiness verdict.

The Duroxide dependency has a separate source pin. [Duroxide integration](duroxide.md) gives those pins and explains what the package lock does not prove. Historical formal-model results retain their original code pins. A model pass is not a proof of the current implementation.

## Read by question

| Question | Document |
|---|---|
| What are the requirements and limits? | [Requirements](requirements.md) |
| What runs where, and how do the concepts relate? | [Architecture and concepts](architecture.md) |
| What does PostgreSQL store? What did migrations 0088 and 0089 change? | [Data model and migrations](data-model.md) |
| How does execution work, including controls, agents and recovery? | [Execution and lifecycle](execution.md) |
| What changed in the ordinary session orchestration and its snapshot path? | [Session orchestration](session-orchestration.md) |
| How does the implementation use Duroxide? Where is the two-store gap? | [Duroxide integration](duroxide.md) |
| What can a person, an agent or an MCP caller do? | [Interfaces and security](interfaces.md) |
| What tests and formal models exist? | [Test and model guide](tests-and-models.md) |
| Which individual test files exist? | [Test inventory](test-inventory.md) |
| Which TLA+ modules exist, and where are their configurations? | [Module inventory](formal-modules.md), [per-module configuration summary](formal-configurations.md) |
| What remains incomplete or unsafe to assume? | [Known issues and enhancements](known-issues.md) |

## Three important distinctions

1. There is **no separate definitions service or network service**. `workflow/service.ts` is an in-process SDK module. Agent tools, portal RPC adapters and MCP management adapters call SDK functions. The module persists session projections through CMS functions, but most Workflow state is written by transactional SQL in `WorkflowStore` and `SessionDefinitionStore`. It is not a stored-procedure-only implementation. See `packages/sdk/src/workflow/service.ts:70-85`, `packages/sdk/src/workflow/store.ts:2373-2415`, `packages/sdk/src/workflow/session-definition-store.ts:260-276`, and [interfaces](interfaces.md).
2. **`workflow-controller` is a Duroxide orchestration, not a service or an API.** `registerWorkflow` registers it at `packages/sdk/src/workflow/runtime.ts:2956`. A worker calls that registration at `packages/sdk/src/worker.ts:1043`.
3. **One live run per Workflow session, ever, is not one run per reusable definition.** `workflow_runs_one_live` has no status predicate. A definition can start many Workflow sessions. "Start another" creates another session; it does not restart the old controller. See `packages/sdk/src/migrations/workflow-0088.ts:216-218` and `packages/sdk/src/workflow/session-definitions.ts:324-386`.

## Glossary

| Term | Meaning |
|---|---|
| Owner session | The ordinary agent session that owns reusable definitions and starts Workflows. It is distinct from the human account that owns sessions. |
| Workflow session | A row in `sessions` with `session_kind = 'workflow'`; it has normal identity, parentage, access and session projections, but no conversational prompt loop. |
| Definition | Reusable YAML under one owner session and name. The engine also uses "definition" for a Workflow session's pinned execution copy. This document qualifies the two meanings. |
| Revision | An immutable saved YAML version, its diagnostics and, when valid, its compiled graph and hashes. |
| Published revision | The frozen revision of the Workflow execution copy selected for live execution. The reusable owner definition has no published-revision field. |
| IR | Intermediate representation: the compiler's validated JSON graph. IR version 1 is the only accepted version at this commit. |
| Run | One execution of a pinned graph, in live or test mode, with inputs, variables, node executions and a controller instance. |
| Node / state | One declared step of the graph. YAML calls these `states`; the runtime calls them nodes. |
| Visit / node execution | One occurrence of a node in one run and scope. A loop can visit the same node many times. |
| Scope | The outer graph or one parallel branch's independent path. |
| Outcome | A named business result that selects a declared route. A runtime error is a separate result kind. |
| KV / variables | A run's open string-to-JSON map. It is CMS state, not Duroxide's orchestration KV. |
| Receipt | A persisted answer bound to an operation identifier and request digest. Repeating the same operation can return the same answer. |
| Request | A typed message that requires a response or decline from its frozen recipient before its deadline. |
| Intake | Recipient-side machinery that can claim a Workflow message, bind it to one logical turn, and record exposure and processing. Durable-mode intake is not enabled by the default worker at this commit. |
| Wake | A queue hint to read authoritative stored state. A wake is not the result itself. |
| Test bench | A hidden `workflow-test` service session used to test a reusable definition revision. It is not a numbered live Workflow. |
| Continue-as-new | A Duroxide execution boundary that keeps the instance identity but starts a new history with explicit carried state. |
| Soft delete | Mark the session or definition deleted while retaining rows needed for history, references and operation identity. |
| Compare-and-swap | An update that wins only if the row still has the expected state or revision. Losing results cannot overwrite the winner. |

The terms above map to `packages/sdk/src/workflow/compiler.ts:18-82`, `packages/sdk/src/workflow/store.ts:61-114`, `packages/sdk/src/workflow/runtime.ts:98-112`, and `packages/sdk/src/workflow/definition-test.ts:1-26`.

## Existing documentation

| Reference | Use it for |
|---|---|
| [Durable workflows](../../developer/building/workflow-sessions.md) | User-facing authoring, the current Workflow tab, definitions, variables and agent-session behavior. |
| [Workflows and GitHub Copilot](../../developer/building/workflows-and-github-copilot.md) | The comparison with Actions, Agentic Workflows and Copilot dynamic workflows. Its external facts are dated; this design did not refresh them. |
| [Workflow milestone](../workflow-milestone.md) | Historical implementation decisions. Read the as-built header before old version or migration numbers. |
| [Messaging request and reply](../workflow-messaging-request.md) | Request authority, deadline, response and wake design history. |
| [Durable recipient intake](../workflow-durable-intake.md) | The detailed recipient protocol and its assumptions. |
| [Dynamic-workflow kind](../dynamic-workflow-kind.md) | A future second-engine proposal, not implemented by PR 270. |
| [Formal models](../../formal/README.md) | Recorded model-checking results and instructions for on-demand TLC runs. |

Where those documents disagree with the candidate code, [Known issues](known-issues.md#documentation-disagreements) records the difference. In particular, a node can end in a runtime failure without reaching a terminal node, and the presence of intake code does not mean the worker enables durable intake.
