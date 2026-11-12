---
name: workflow-approval
description: Owner-only approval states: authoring fields, frozen context, identity, deadlines, audit, person-only answers and simulated tests.
---

# Workflow owner approval

An owner-only decision, answered directly in the portal. This is not a request
to an agent session. Available to new runs at controller 1.1.0; existing 1.0.0
runs keep their original behavior. An agent may author this state but cannot
answer it.

| Field | Rule |
|---|---|
| `question` | Required plain text, 1 to 4,000 characters; not a binding. |
| `approver` | Optional literal `owner`, the default and only value. |
| `timeoutSeconds` | Required literal integer, 1 to 2,592,000 seconds (30 days). |
| `input`, `inputSchema` | Optional; evaluate and check once at admission, then freeze the input. |
| `transition.next` | Must include `approved`, `rejected` and `timed_out`. |

```yaml
consent:
  type: approval
  question: Approve this exact proposal?
  input: "${input}"
  timeoutSeconds: 172800
  transition:
    next: { approved: release, rejected: hold, timed_out: hold }
```

The owner reads the full frozen question and context, the pinned owner and
the effective deadline before answering. Rejection needs a nonblank reason
of at most 2,000 characters; an approval reason is optional. No reader,
shared writer, nonowner admin, system or agent can consent. Both the pinned
owner and current owner must match the person answering. An ownerless
Workflow or one started inside an agent step fails `forbidden`.

The deadline is the earlier of admission plus `timeoutSeconds` and the run's
deadline. Pause does not extend it. Started work and timers continue while
paused; an accepted decision routes only after resume. Stop, cancel, deletion
or a branch cutoff prevents a fresh answer or further routing. A response at
the deadline is too late.

`approved` and `rejected` are business outcomes. Their output is
`{ decision, reason, decidedAt, decidedBy: { provider, subject, displayName },
contextSha256 }`. Expiry is the runtime error `timed_out`; other errors use
the normal error routes. Decisions and exact-retry receipts are saved
atomically with the node result and audit event. Consent grants no additional
permission to Azure, Git, ADO or any other downstream operation.

The person-only API answers an exact visit (`approval_id`, the node execution
id) with its exact `context_sha256`. The host stamps identity. It commits
the result, audit, receipt and event atomically; an exact authorized retry
returns the original acceptance even after the run ends. Never forward a
person's approval through MCP or an agent tool. Use the portal to answer.

In test mode, only an `approval` fixture/interception answer is accepted:
`{ decision: "approved" | "rejected", reason? }`. The result is marked
simulated and creates no live consent audit. Advance virtual time to test
48-hour or 30-day deadlines.
