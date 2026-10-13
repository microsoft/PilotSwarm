# Final review resolution (workstream C)

Reviewer: azure-openai:gpt-6-luna, single-model, non-interactive.

| Finding | Severity | Resolution |
|---|---|---|
| R1-1 Steer retry after the flag was turned off got `steering_disabled` | must-fix | Fixed in af84793b: the flag gates new steers only; a recorded request id goes to `cms_turn_control_add` and gets its first answer. Real-PostgreSQL regression test added. |
| R1-2 MCP rejected `timeout_ms: 0` | should-fix | Fixed in af84793b (0..300000, boundary tests). |
| R2-1 A request id recorded in an earlier orchestration lifetime can bypass a disabled flag | must-fix | Accepted residual by the parent (2026-10-13 05:59Z). Hand-off to workstream A, phase A5: the flag decision moves into `cms_turn_control_add`, so dedup and the flag check share one row lock and one lifetime rule; after this PR merges, A replaces the client-side `_steerRequestRecorded` lookup with a flag parameter on the add call. |
