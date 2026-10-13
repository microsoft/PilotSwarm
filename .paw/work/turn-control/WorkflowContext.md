# WorkflowContext

Work Title: Session Turn Control
Work ID: turn-control
Base Branch: waldemort/turn-control
Target Branch: waldemort/turn-control-runtime
Execution Mode: worktree
Repository Identity: github.com/microsoft/pilotswarm@d7b321ede780ab6da1e60a7962251508e679e97d
Execution Binding: worktree:pilotswarm:turn-control:waldemort/turn-control-runtime
Workflow Mode: full
Review Strategy: local
Review Policy: planning-only
Session Policy: continuous
Final Agent Review: enabled
Final Review Mode: single-model
Final Review Interactive: false
Final Review Models: azure-openai:gpt-6.1-sol
Final Review Specialists: all
Final Review Interaction Mode: parallel
Final Review Specialist Models: none
Final Review Perspectives: none
Final Review Perspective Cap: 2
Implementation Model: none
Implementation Review Model: azure-openai:gpt-6.1-sol
Plan Generation Mode: single-model
Plan Generation Models: none
Planning Docs Review: enabled
Planning Review Mode: multi-model
Planning Review Interactive: false
Planning Review Models: azure-openai:gpt-6.1-sol, anthropic-wif:claude-opus-5-5
Planning Review Specialists: all
Planning Review Interaction Mode: parallel
Planning Review Specialist Models: none
Planning Review Perspectives: none
Planning Review Perspective Cap: 2
Custom Workflow Instructions: Umbrella planning covers the whole feature in three workstreams with disjoint file ownership (A runtime, B orchestration, C surfaces). This branch implements workstream A only. The parent program coordinator runs the cross-workstream final review and accepts the workstream PR into waldemort/turn-control.
Initial Prompt: Implement session turn control (Stop and Steer through the CMS) as designed in docs/proposals/session-turn-control.md (revision 5), with R1-R7 and D1-D5 at their proposed defaults.
Issue URL: none (design PR https://github.com/microsoft/PilotSwarm/pull/169)
Remote: origin
Artifact Lifecycle: commit-and-clean
Artifact Paths: auto-derived
Additional Inputs: docs/proposals/session-turn-control.md; prior code research at main 12dfd3ee
Runtime Limits: maxActiveActivityChildren=2, maxUnresolvedCorrectionRounds=3
User Configuration: none
Approved Departures: (1) execution checkout is a dedicated git worktree of the session clone on the target branch, not the clone root; (2) builds and tests run in the engineer-owned dev pod from a committed, clean worktree; (3) human acceptance of the workstream PR is delegated to the parent coordinator.
