# WorkflowContext

Work Title: Session Turn Control - Orchestration
Work ID: turn-control-b
Base Branch: waldemort/turn-control
Target Branch: waldemort/turn-control-orchestration
Execution Mode: worktree
Repository Identity: github.com/microsoft/pilotswarm@d7b321ede780ab6da1e60a7962251508e679e97d
Execution Binding: worktree:pilotswarm:turn-control-b:waldemort/turn-control-orchestration
Workflow Mode: full
Review Strategy: local
Review Policy: final-pr-only
Session Policy: continuous
Implementation Model: none
Implementation Review Model: anthropic-wif:claude-opus-5-5
Final Agent Review: enabled
Final Review Mode: single-model
Final Review Models: anthropic-wif:claude-opus-5-5
Final Review Interactive: false
Artifact Lifecycle: commit-and-clean
Remote: origin
Plan of Record: .paw/work/turn-control/ImplementationPlan.md (r7)
Specification: .paw/work/turn-control/Spec.md (r8)
Approved Configuration: owner-approved umbrella planning imported; start at implementation B1, then B2 and B3
Runtime Limits: maxActiveActivityChildren=2, maxUnresolvedCorrectionRounds=3
User Configuration: none
Approved Departures: dedicated worktree of the session clone; committed clean candidates verified in the engineer-owned dev pod; parent accepts the workstream PR into the umbrella branch.
Custom Workflow Instructions: B-owned paths only. Do not edit the umbrella plan or A-owned files. B2 live tests wait for the parent's A4 merge notice. Preserve every frozen version. Parent owns provider coverage registration and cross-workstream final review.

## Phase Status

- [x] B1: Freeze 1.0.80 (Opus PASS at 8cacf9d0)
- [ ] B2: Orchestration 1.0.81
- [ ] B3: Documentation
