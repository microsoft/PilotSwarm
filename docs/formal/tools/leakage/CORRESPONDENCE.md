# Model-to-code correspondence

This mapping applies to the production files in the commit containing this
packet. Adding tests and this packet does not change those files. An independent
TLC report must name that exact commit. A matching abstraction is not a proof
that the implementation satisfies it.

All source paths below are under `packages/sdk/src/`.

| Model action or rule | Production correspondence | Executable witness |
|---|---|---|
| `LeakCore`: role and declared sets | `session-manager.ts` `_resolveTools`; the named-definition resolution in `getOrCreate` | `tool-composition-child-sets.test.js`: frozen baseline equality and foreign-package declared export |
| `LeakCore`: grant selection | `tool-grant.ts` grant validation and selection; `session-manager.ts` `captureSpawnTools` and `describeWorkflowAgentTools` | `workflow-tool-composition.test.mjs`: inline/named defaults and selectors; real child-set refusals |
| `LeakCore`: the legacy exception | `orchestration/agents.ts` `handleSubAgentAction`; `session-proxy.ts` the `spawnAgent` activity | `session-real-source-upgrade.test.js`: the same parent's `tool_names` before and after its version move |
| `LeakCore` and `LeakChain`: ancestor ceiling | `captureSpawnTools`; the stored `toolCeiling` in `client.ts`; `getOrCreate`'s effective tool limit | `tool-composition-child-sets.test.js`: a ceiling cuts the actual grandchild request |
| `LeakRules`: required-tool admission | `workflow/compiler.ts` `compileAgent`; `workflow/tool-requirements.ts` admission diagnostics; Start in `workflow/session-definitions.ts` | `workflow-agent-tool-admission.test.js`: unavailable startup tool names the state and creates no child |
| `LeakRules`: sub-agent role | The depth guard in `handleSubAgentAction`; CLI tool filtering in `session-manager.ts` and `managed-session.ts` | `tool-composition-child-sets.test.js`: named and unnamed depth-two children cannot spawn |
| `LeakStore`: capture at Start | `captureWorkflowToolBinding`; `workflow/agent-tools.ts` state snapshot capture; persisted `agentStepBindings` | `tool-composition-workflow-sets.test.js`: late activation cannot enter a running Workflow's captured grant |
| `LeakStore`: pinned call after unload or publication | `workflow/package-pins.ts` `resolveWorkflowCapabilitySnapshot`; attached handler checks and `authorizeWorkflowTools` | `workflow-tool-package-pins.test.js`; real Workflow child call after parent unload |
| `LeakStore`: lost pin and registry failure | `refuseLostWorkflowTool`; `retryWorkflowPackageCheck`; delegated package handlers | `workflow-package-agent-dependencies.test.js`; real agent/child registry-failure cases name the tool |
| `LeakStore`: deployment tool changes | Called-tool schema comparison in `authorizeWorkflowTools`; description excluded from the schema hash | `workflow-tool-pins-authority.test.js`: script, scoped agent-step and spawned-child contract matrix |
| `LeakStore`: unchanged old child | Frozen handlers in `orchestration_1_0_83/`; version registration in `orchestration-registry.ts`; continue-as-new in the lifecycle | `session-real-source-upgrade.test.js`: native history prefix and earlier child creation config are unchanged |
| `LeakStore`: design-only handover | No shipping correspondence is asserted | Separate hypothetical cases only |

The completion evidence gate is not modeled by this packet. Its separate
real-worker witness is `workflow-agent-required-tools-worker.test.js`, and its
transactional behavior is checked by `workflow-agent-required-tools.test.js`.
The model's required-set admission invariant must not be described as a proof
of that per-visit transaction.

The migration and omitted-field compatibility checks are outside the model:
`tool-composition-historical.test.js` compares the pre-composition migration
inventory and contents and the earlier compiler's exact canonical IR bytes and
hash.
