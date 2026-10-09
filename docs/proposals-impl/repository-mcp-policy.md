# Repository MCP Policy

## Decision

`PilotSwarmWorker` exposes `repositoryMcpEnabled` as a generic security control.
It defaults to `true` for compatibility. Applications that run sessions in
caller-controlled repositories can set it to `false`.

When disabled, PilotSwarm:

- disables native Copilot configuration discovery for repository workspaces;
- removes inline MCP definitions from repository-authored agents; and
- preserves separately approved repository instructions and skills.

## Why this belongs in PilotSwarm

The session manager selects the Copilot working directory and therefore controls
whether native repository configuration discovery occurs. A downstream worker
cannot reliably close that path after session creation.

This option is not an MCP catalog or authentication extension point. Endpoint
selection, server grants, credentials, and any stdio-to-HTTP bridges remain
application-owned. Its only responsibility is enforcing whether repository
content may become executable MCP configuration.

## Security invariant

When `repositoryMcpEnabled` is `false`, changing the checked-out repository or
Git ref must not introduce, replace, or reconfigure an MCP server.
