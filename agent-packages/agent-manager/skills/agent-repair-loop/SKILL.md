---
name: agent-repair-loop
description: |
  The order of operations for changing a live package safely — diagnose,
  patch, publish, converge, verify, roll back. Use whenever you are about
  to modify an agent package that something is already running on.
---

# Repairing a live package

The steps are ordered because each one exists to catch a specific failure.

## 1. Diagnose

Never patch on a hypothesis. Pull the evidence first:

| Question | Tool |
| --- | --- |
| What did the agent actually do? | `read_agent_events` |
| Where did the orchestration go? | `read_execution_history` |
| Is it a context/token problem? | `read_session_metric_summary` |
| Is it a retrieval problem? | `read_session_retrieval_usage` |
| What does the agent's prompt currently say? | `read_agent_package` |

State what the evidence shows **and what it rules out**. "The turn failed
after the third tool call" is a finding. "The prompt is probably confusing"
is a guess.

## 2. Establish which copy you are editing

Run `list_agent_packages` and look at `scope` and `shadowed`.

- `shadowed: true` on a shared package means the user's own copy is
  overriding it. Editing the shared one will appear to do nothing.
- If the user has no copy of a shared package, editing means publishing
  their own — which changes behaviour for them alone, not the deployment.

Tell the user which of these is about to happen before you do it.

## 3. Propose the change as a diff

`propose_agent_patch` writes ordered `.patch` artifacts to the session. The
portal renders them with gutter markers.

Do this even when the change is small. A one-line prompt edit that the user
can see is a decision they made; the same edit described in prose is one they
took on trust.

## 4. Publish

Versions are immutable: republishing the same semver with different content
is refused outright. Bump.

- Content unchanged → identical hash → the publish is a no-op. That is a
  success, not a failure.
- Publishing to `shared` affects everyone. Publishing user-scope affects only
  the owner. Prefer the narrower one unless the user asked otherwise.

## 5. Wait for convergence — do not sleep

Publishes land on workers at the next registry poll (observed under 30s).
Anything that runs before convergence runs the **old** definition, silently.
That failure looks exactly like "the edit did nothing", and it has cost real
debugging time.

Poll `read_agent_package` until `activeVersionId` matches what you published.
Then proceed. A fixed sleep is not a convergence check.

## 6. Verify the changed capabilities

Packages can contain reusable skills, executable tools/MCP integrations, and
authored agent workflows. Zero-agent packages are valid. Verify the surfaces
that changed: discover and load skills, activate permitted integrations, and
check real tool/MCP execution evidence in a representative permissions context.
Do not add an agent or create a durable session solely to test a skill or tool.

For an authored workflow, also use `create_agent_session` to test a top-level
session bound to the new version. Do not substitute `spawn_agent`: its child
preamble differs from the entry point a user runs. Tag the test with `test_of`,
reuse its key when appropriate, and observe its events and actual outputs.
Respect the session owner's authorization before messaging or ending it.

For a Workflow Definition (`workflows/<name>/` with its card), first check that
it is simple: few nodes, a straight path, readable in one look. It does not
encode every corner case: it writes the common path and routes the rest to an
agent node. Judgement, parsing, many branches, nested conditions or string
logic belong in an agent node with a short, clear prompt, not in conditions,
expressions or scripts. Scripts do work, not decisions; no code in YAML. The
aim is fewer tokens on the repetitive parts, and an agent node for the hard
part beats a brittle definition. When unsure, choose the simpler definition
and tell the person what the agent node now handles. Different branches
running different nodes at once (a different prompt or model for each) are one
Workflow, never several: a parallel state with named `branches`, each its own
small graph whose agent node has its own state id, joined as
`{ <name>: output }`. When the branches come from a list, the older router
pattern (a router script first in a For each body over a literal list of
lanes) does it. The `workflow-patterns` skill has both, with examples.

Test it before you publish the package that adds or changes it: save that exact YAML in your
own chat (`workflow_definition` `save`), run `workflow_definition` `test` on
the revision the save returned, read the report, and publish only on a pass.
On a fail, fix, save and test again. A fixture answers one step: a tool call's
success value is what the tool returns; an agent node's is `{ outcome, output }`;
an ask (request) node's is `{ response: <the contract's response> }` or
`{ decline: { reason } }`; a send's is any value. A failed test is never followed
by a publish plan: quote the report's failure (its code and message), fix, and
test again; the same failure twice, stop and show the person the report and the
fixtures. The person's request to publish is their request for this test. Tell
them the passing result with the publish plan. If the test
operation is not offered in your session (it runs only where the deployment
runs Workflow tests), say so and do not publish without the person's explicit
yes. Then have it started once from the new-session
picker in a disposable chat before the shared publish, and check that the chat
asks for the card's inputs and that the Workflow ends as the card says.

**The named-entry-point check is mandatory when you were spawned by the agent
you are editing.** In that arrangement you are the child and the thing you are about
to break is your own parent — the argument that "the publisher still runs the
old version and can pin itself back" does not hold, because the publisher is
not the victim.

## 7. Know the rollback

`pin_agent_package_version` restores a previous version; the fleet converges
on the next poll. Two other levers:

- **Disable the user's copy** → resolution falls back to shared. Fastest way
  out of a bad personal copy.
- **Pin, then investigate.** Restore service first. The broken version is
  still there to look at.

## What not to do

- Do not delete a package to "clean up" a bad publish. Deletion destroys every
  version, including the good one you would have rolled back to.
- Do not promote to `shared` to make a fix reach more people. Promotion hands
  your change to the whole deployment and is refused if the name is taken.
- Do not chain publish → regenerate without the convergence check between.
