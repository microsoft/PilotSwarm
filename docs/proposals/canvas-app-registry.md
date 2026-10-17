# Canvas app registry

Status: **implemented** (issue 181). Canonical docs:
[canvas architecture](../architecture/canvas.md#the-app-registry),
[user guide](../user-guide/canvas-apps.md),
[security and sharing](../user-guide/security-and-sharing.md#canvas-apps),
[API reference](../api/reference.md#canvas-apps).

## Problem

`publish_canvas_app` saved a page as a pinned artifact on the publishing
session and a shared fact `apps/<name>`. Apps had no user owner, no private
scope, no versions, no unpublish, no contributors and no export. Anyone
could overwrite anyone's app from any session, the card then pointed at the
new file and the old one was orphaned. A shared app's workspace calls ran as
whoever drew it, and nobody approved them.

## Design

- **Registry in the CMS** (migration 0084, stored procedures only): apps,
  versions, contributors, tombstones, loads, workspace grants. An app is
  `(scope, owner, name)`; shared names are unique, private names unique per
  owner; a user's private app hides a shared app of the same name for that
  user.
- **Versions** are SemVer: the publisher's, else the manifest's, else the
  next patch. Bytes are content-addressed per app: the same bytes again
  change nothing. Publishing reserves, uploads to the app's own artifact
  space, then commits, so a crash never leaves a visible half-version.
- **Rights.** Private by default. Anyone may publish shared. Contributors
  of a shared app publish versions; owner or unrestricted admin shares,
  unshares, deletes and manages contributors. Agents act with their session
  owner's rights. A cluster-scoped admin is an ordinary user here.
- **Surfaces.** `PilotSwarmManagementClient` first (direct and Web API),
  then the Web API, MCP tools, the `pilotswarm apps` CLI and agent tools
  (`publish_canvas_app`, `find_canvas_app`, `manage_canvas_app`,
  `draw_canvas({fromApp})`).
- **Export/import**: one deterministic `.tar.gz`, no identities; import is
  checked whole first and is idempotent.
- **Legacy migration**: a one-time admin operation; `apps/` facts become
  read-only for agents.
- **Loads**: one row per app draw (time, session, user, app, version), 400
  days.
- **Security.** Draws are classified (`owner`, `agent`, `cross-owner`) for
  wording, network blocking of other users' pages and labels on their
  actions and KV values. Workspace access needs the session owner's positive
  approval of each exact program (page bytes, declaration, folder bindings,
  slot), whoever wrote the page. The artifact tools withhold
  registry-identified foreign app bytes as defense in depth.

## Amendment (adopted during implementation)

The signed specification required approval only for another user's app.
Two independent security reviews showed that recognizing an app by its
bytes cannot stop an agent from rewriting it slightly, so approval is now
required for every new workspace program. This is a narrow first-use change:
pages without a `workspace` block, authoring, publishing, existing
approvals of the identical program and live data updates are unchanged.

## Not done here

Package-shipped apps (`fromPackage`), and the same read check for agent
package tarballs.
