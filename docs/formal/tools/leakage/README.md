# Tool-composition leakage model

This packet checks bounded instances of the rules in
[`tool-composition.md`](../../../proposals/workflows/tool-composition.md).
It checks which tools a child may hold, whether admission refuses an invalid
grant, and whether a stored grant can widen after its parent changes.
It does not prove the TypeScript implementation correct.

## Models and cases

| Module | Scope |
|---|---|
| `LeakCore` | Shared pure rules: role tools, declared tools, grants, legacy `tool_names`, ceilings and required-tool admission |
| `LeakRules` | Every configured one-hop input combination; deliberate mutants show that the invariants detect widening and missing refusal |
| `LeakChain` | Composition through a child and grandchild, including an ancestor ceiling and the legacy exception |
| `LeakStore` | A captured grant across parent selection changes, publication changes, lost pins, version moves and a design-only handover |

`cases.tsv` lists 58 cases in run order. `cases.json` stores each case's settings
and expected verdict: `PASS` or `VIOLATION:<property>`. `tlc-templates.json`
defines the reproducible configuration layout. Generated `.cfg` files are
ignored and must not be committed.

The `tl.*` cases check intended rules. `mut.*` cases deliberately break a rule
and must violate the named property. `head.*` and `find.*` preserve historical
implementation shapes, including defects that were fixed before this packet
was added. Their expected violations are not findings against the current
implementation. Historical identifiers are retained to compare previous runs
without renaming cases.

## Findings preserved by the packet

| Finding | Counterexample | Meaning for the current implementation |
|---|---|---|
| F1 | A stored Workflow grant with no per-state snapshot uses the intermediate build's broad named-step fallback | A new Start captures each state's grant. A binding without state snapshots retains its legacy role default instead of applying a new default |
| F2 | An intermediate worker silently ignores new fields while another worker applies the new rules | Stop all workers before deployment. Mixed-version and rollback cases are compatibility models, not a supported rolling-deployment promise |
| F3 | A legacy `tool_names` spawn bypasses an ancestor's ceiling | Keep the legacy replacement semantics, but intersect every descendant with the stored ancestor ceiling |

A legacy `tool_names` list may reach a registered deployment tool its parent
does not hold. This is the specified compatibility exception, not leakage.
A `grant` list does not have that exception.

The design-only handover cases are reported separately. They preserve a model
question; they do not promise that handover ships.

## Assumptions and limits

- The finite tool universe uses neutral stand-ins. Tool aliases, JSON schemas,
  namespaced provider lookup and actual CLI metadata need executable tests.
- The model abstracts the registry to available, changed or lost pins. The
  production retry duration and its error text are tested outside TLC.
- A failed tool invocation counts as an invocation. The completion gate's
  evidence transaction is outside this leakage model.
- Start captures authority once. Every later call checks the persisted binding
  and current access. Unloading a parent's selection does not revoke a pin;
  losing access to that package blocks its tools without adding authority.
- A tool ceiling removes tools from every category. A Workflow step keeps its
  completion tool; a sub-agent does not acquire that exception.
- Stopping all workers is an explicit deployment assumption. These models do
  not establish safety for unsupported mixed versions.
- The models check safety over their configured finite bounds. They do not
  prove liveness, arbitrary-depth induction, database behavior or deployment
  readiness.

## Reproduce

Run from a build/test environment with Python 3, Java and Bash:

```bash
./check-packet.sh
./run-tlc.sh /tmp/tool-leakage-results
```

The runner pins `tla2tools` v1.7.4 and its SHA-256. It regenerates settings from
the committed tables. Its process exit code is not a model verdict: inspect
`executions.tsv` and each case's TLC log. Compare every observed verdict with
`cases.json`. Exhaustive successful cases must also retain their distinct-state
counts when compared with an earlier run of the same model and settings.
Counterexample counts can differ with TLC worker ordering.

`SHA256SUMS` covers committed input files, not generated settings, the downloaded
JAR or output logs. `CORRESPONDENCE.md` maps the abstractions to production code.
An independent run must bind its report to the exact source commit and packet
hash; a prior model run is not evidence for a later source head.
