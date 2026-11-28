---
name: workflow-approval
description: Owner approval state fields, frozen context, identity, deadlines, audit, and answers from any surface or the controlling session.
---

# Workflow owner approval

An owner decision. The owner answers it in the portal, over MCP or the API, or
the session that controls the Workflow answers it for the owner with
`update_workflow` `approval_respond`; it gets an `approval` notice when the
visit opens. The first answer wins. Available to new runs at controller 1.1.0;
existing 1.0.0 runs keep their original behavior. An agent may author this
state and answer it for the owner.

| Field | Rule |
|---|---|
| `question` | Required plain text, 1 to 4,000 characters; not a binding. |
| `approver` | Optional literal `owner`, the default and only value. |
| `timeoutSeconds` | Required literal integer, 1 to 2,592,000 seconds (30 days). |
| `input`, `inputSchema` | Optional; evaluate and check once at admission, then freeze the input. |
| `transition.next` | Must include `approved`, `rejected` and `timed_out`. |

```yaml
# example: owner-consent
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: owner-consent, version: "1.0.0" }
initial: consent
states:
  consent:
    type: approval
    question: Approve this exact proposal?
    input: "${input}"
    timeoutSeconds: 172800
    transition:
      next: { approved: release, rejected: hold, timed_out: hold }
  release: { type: terminal, outcome: succeeded }
  hold: { type: terminal, outcome: failed }
```

Read the full frozen question and context, the pinned owner and the
effective deadline before answering. Rejection needs a nonblank reason
of at most 2,000 characters; an approval reason is optional. No reader,
shared writer, nonowner admin or system can consent. A session answers as its
own owner: both the pinned owner and current owner must match that person. An ownerless
Workflow or one started inside an agent step fails `forbidden`.

The deadline is the earlier of admission plus `timeoutSeconds` and the run's
deadline. Pause does not extend it. Started work and timers continue while
paused; an accepted decision routes only after resume. Stop, cancel, deletion
or a branch cutoff prevents a fresh answer or further routing. A response at
the deadline is too late.

`approved` and `rejected` are business outcomes. Their output is
`{ decision, reason, decidedAt, decidedBy, contextSha256 }`.
`${states.<approval>.output.decidedBy}` is `{ by: "a person", name? }`,
never a sign-in identity. Expiry is the runtime error `timed_out`; other errors use
the normal error routes. Decisions and exact-retry receipts are saved
atomically with the node result and audit event. Consent grants no additional
permission to Azure, Git, ADO or any other downstream operation.

Every surface sends the same `approval_respond` (`run_id`, `approval_id`, the
node execution id, its exact `context_sha256`, `decision` `approved` or
`rejected`, `reason`, `operation_id`) to the same check. The host stamps
identity; an answer through a session records `viaSessionId` in the receipt.
A session sees `decidedBy` as `{ by: "a person", name }`, as for pause.
It commits the result, audit, receipt and event atomically; an exact
authorized retry returns the original receipt even after the run ends. A
later answer fails `APPROVAL_CLOSED`; a late one, `APPROVAL_EXPIRED`.
