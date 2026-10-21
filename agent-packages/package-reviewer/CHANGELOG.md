# Package Reviewer

## 1.0.0

First release. An advisory review assistant for executable package candidates.

- Reads the exact pending candidate and its review baseline through five
  read-only tools; both artifacts are verified against their recorded digests.
- Saves one advisory report per exact candidate and baseline: facts, analysis,
  a step-by-step guide and open risks. The report has no verdict field.
- Holds no other tools: no shell, files, web, MCP, sub-agents or messaging.
  Every tool requires the session owner to be an unrestricted fleet
  administrator. The administrator still decides from the review diff.
