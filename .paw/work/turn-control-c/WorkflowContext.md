# WorkflowContext

Work Title: Session Turn Control, workstream C (surfaces)
Work ID: turn-control-c
Base Branch: waldemort/turn-control
Target Branch: waldemort/turn-control-surfaces
Execution Mode: worktree
Repository Identity: github.com/microsoft/pilotswarm@d7b321ede780ab6da1e60a7962251508e679e97d
Execution Binding: worktree:pilotswarm:turn-control-c:waldemort/turn-control-surfaces
Workflow Mode: full (planning imported: plan r7 / spec r8 approved upstream; starts at implementation)
Review Strategy: local
Review Policy: final-pr-only
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: single-model
Final Review Interactive: false
Final Review Models: azure-openai:gpt-6.1-sol
Implementation Model: none
Implementation Review Model: azure-openai:gpt-6.1-sol
Plan of Record: .paw/work/turn-control/ImplementationPlan.md (r7), phases C1, C2, C3, C4
Spec: .paw/work/turn-control/Spec.md (r8)
Custom Workflow Instructions: Workstream C of the umbrella feature turn-control. Consumes the A1 contract without edits to workstream A or B files. Phase status for C is tracked in this folder (the umbrella plan belongs to workstream A). The parent program coordinator runs the cross-workstream final review and accepts the PR into waldemort/turn-control.
Remote: origin
Artifact Lifecycle: commit-and-clean
Artifact Paths: .paw/work/turn-control-c/
Runtime Limits: maxActiveActivityChildren=2, maxUnresolvedCorrectionRounds=3
Approved Departures: (1) execution checkout is a dedicated git worktree of the session clone on the target branch, not the clone root; (2) builds and tests run in the engineer-owned dev pod from a committed, clean worktree; (3) human acceptance of the workstream PR is delegated to the parent coordinator.

## Phase Status (workstream C)

- [x] Phase C1: Management client and Web API — efb9601e; review r1 BLOCKED (gpt-6.1-sol), r2 PASS at 0ee90a08; real-PostgreSQL cases green at e1acf4c9 (after A2); `stop-turn-live.test.js` update waits for A4 and B2
- [x] Phase C2: MCP — 269bf0e8; review r1 PASS at 4f310a15 (gpt-6.1-sol, reviewer docs patch)
- [x] Phase C3: Portal and TUI — 946e9e96; review r1 BLOCKED (gpt-6.1-sol), r2 BLOCKED (gpt-6-luna), r3 PASS at 12b78220 (gpt-6-luna)
- [x] Phase C4: Documentation, templates and samples — e944fe68, 2d240a48; review PASS at 12b78220 (gpt-6-luna, reviewer wording patch)

Reviewer model: azure-openai:gpt-6.1-sol until C3 r1; azure-openai:gpt-6-luna from C3 r2 on (parent directive for capacity).
