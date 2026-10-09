# Dynamic session instantiation

**Status:** Proposal

**Example target design:** [Workflow sessions](workflow-session-scenarios.md)

**In one sentence:** evaluate deterministic or agentic sources, produce zero or
many candidate starts, and admit them as any supported session type.

## Motivation

The same kind of work often applies independently to many discovered items.
Evaluation may occur more frequently than those items can be resolved, and
multiple sources may discover the same item.

This is not specific to structured workflows. A discovered item may start any
supported session type, so source evaluation, fan-out, and deduplication belong
to a shared session-platform feature.

## Scenario

```text
source evaluation
  -> candidate(item A) -> session S1
  -> candidate(item B) -> session S2
  -> candidate(item C) -> existing session S3
```

One evaluation may produce zero or many independently keyed candidates. New
keys create independent, potentially concurrent sessions. Repeated keys follow
the configured deduplication policy.

## Design

### Candidate-start contract

All sources produce the same logical envelope:

```text
candidateStart = {
  targetKind,
  targetSource,
  payload,
  initiator,
  trigger,
  correlation,
  deduplicationNamespace,
  deduplicationKey,
  idempotencyKey
}
```

`targetKind` selects the target session type and its admission contract. For a
workflow, `targetSource` is a registered reference or inline definition and
`payload` contains its inputs. Workflow admission compiles, validates, hashes,
and freezes the definition and inputs before execution. Other session types
interpret the target source and payload through their own admission contracts.

### Trigger resources

Triggers are managed independently from target definitions and active sessions.
Each trigger configures:

- execution mode and source;
- activation lifecycle;
- target kind and source;
- payload mapping;
- deduplication policy.

A deterministic trigger consumes a configured callback or query and treats its
structured result as authoritative. An agentic trigger uses an explicit bounded
agent invocation to interpret source data. Both produce schema-valid candidates
and neither creates sessions directly.

### Admission and deduplication

```text
trigger evaluation
  -> candidate starts
  -> shared session admission
  -> target-specific admission
  -> session
```

Shared admission owns authorization, provenance, and deduplication.
Target-specific admission validates the target and creates the session.

Deduplication is configurable and enabled by default. It uses a namespace and
key independent of trigger identity, allowing multiple triggers to converge on
one session for the same logical work. Duplicate observations remain durable
provenance. Disabling deduplication creates an independent session for each
occurrence.

## Responsibility boundary

| Component | Responsibility |
|---|---|
| Portal and REST API | Register, activate, inspect, and disable triggers |
| SDK | Author trigger configurations and candidate mappings |
| Trigger evaluator | Execute the deterministic callback/query or bounded agent |
| Shared admission | Authorize, deduplicate, and record provenance |
| Target admission | Validate the target and create the requested session kind |
| Session controller | Execute the admitted session without managing its trigger |

## Open design questions

- Define trigger registration, activation, scheduling, and failure handling.
- Define candidate and mapping schemas.
- Define deduplication key, namespace, lifetime, terminal behavior, and re-arm
  semantics.
- Define backpressure, evaluation concurrency, and per-trigger fan-out limits.
- Define provenance retention and management visibility.
- Define admission policy for agent-proposed targets and inline definitions.

## Test plan

- One evaluation may produce zero, one, or many candidates.
- Distinct keys create independently correlated sessions.
- Repeated candidates deduplicate when enabled.
- Equivalent candidates from different triggers deduplicate when configured
  with the same namespace and key.
- Disabling deduplication creates independent runs.
- Duplicate observations remain attached as provenance.
- Deterministic and agentic triggers produce equivalent candidate contracts.
- Unauthorized targets and invalid payload mappings fail before creation.
- Retry and replay do not duplicate evaluations, candidates, or sessions.

## Decisions

1. Dynamic instantiation is session-platform functionality, not workflow
   controller functionality.
2. Triggers are independent managed resources.
3. Deterministic and agentic triggers share one candidate-start contract.
4. One evaluation may fan out to many independently keyed sessions.
5. Deduplication is configurable, enabled by default, and may span triggers.
6. Every supported session type uses target-specific admission behind shared
   authorization, provenance, and deduplication.
