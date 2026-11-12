---
name: workflow-carry
description: Preserve loop counters and payloads through Workflow errors, receipts and agent results with opt-in carry. Admission snapshots, size limits, branch isolation and a bounded read-only retry example.
---

# Workflow carry

Call `load_skill` with name `workflow-authoring` first. Nonterminals may opt in:
`carry: { loop: "${input.loop}", payload: "${input.payload}" }`.
Entry freezes this object before `input:` maps the effect's payload.
The successor receives `{ carry: snapshot, result: outputOrError }`;
read `${input.carry.loop}` and `${input.result}`. `runtime.error` remains the
original envelope. Output schemas and message contracts check only the
ordinary output/payload. A successor's input schema checks the wrapper
unless its `input:` maps it. Without carry, route shapes are unchanged.

Carry is at most 64 KiB; the wrapper at most 256 KiB. Oversize carry fails
that state; an oversize wrapper fails the receiving state with
`invalid_input` before its input mapping. No truncation. Failed selection
starts no effect and routes null carry; a later input failure keeps the
selected snapshot. Each execution and branch owns its snapshot; a parallel
state's outer carry wraps its join, not its manifest. KV updates, crashes
and replay never replace an admitted snapshot. Existing 1.0.0 runs keep
their old behavior; new 1.1.0 runs support carry.

Carry preserves entry data, not mutations inside a crashing script.
Increment an attempt counter in a completed state before the fallible
effect. Do not reset a missing counter to zero, carry the whole previous
wrapper recursively, or treat preservation as permission to retry a write.
No state writes run variables. Reconcile ambiguous effects first.

```yaml
# example: carry-retry
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: carry-retry, version: "1.0.0" }
initial: count
initialInput: { attempts: 0 }
limits: { maxNodeExecutions: 20 }
states:
  count:
    type: script
    source: |
      const n = context.input.attempts;
      if (n >= 3) await setResult("stop", { attempts: n });
      else await setResult("try", { attempts: n + 1 });
    transition: { next: { try: poll, stop: unknown, failure: failed } }
  poll:
    type: script
    carry: { attempts: "${input.attempts}" }
    source: |
      const status = await callTool("get_ci_state", {});
      if (!["pending", "success", "failure"].includes(status.state)) throw new Error("Unrecognized CI state");
      await setResult(status.state === "pending" ? "pending" : "done", status);
    transition: { next: { pending: pause, done: done, failure: pause } }
  pause:
    type: wait
    seconds: 60
    input: { attempts: "${input.carry.attempts}" }
    transition: { next: { elapsed: count, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "${input.result}" }
  unknown: { type: terminal, outcome: blocked, output: { outcome: unknown, attempts: "${input.attempts}" } }
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```

This retries only a read. A failed third observation still reaches the
bounded stop. The entry counter survives a runtime error or agent result;
an agent used instead of `poll` need not echo it. Observation success means
CI reached a final state, not that CI passed.
