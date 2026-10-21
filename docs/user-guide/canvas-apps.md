# Canvas apps

A canvas app is one HTML page with a `CANVAS-APP-MANIFEST` comment that an
agent draws on a session canvas: a sign-off board, a poll, a review
workbench. Apps you want to use again live in the **canvas app registry**.

- Each app belongs to a user, its **owner**.
- An app is **private** (its owner and unrestricted admins) or **shared**
  (everyone in the deployment). Publishing is private unless you ask to share.
- Each app has **versions** (SemVer, at most 95 bytes so every version
  fits in an exported archive). One version is active; you can pin another.
- A shared app can have **contributors**, who may publish new versions.
- An app does not depend on the session it was published from.

How an app behaves does not change: the page, its manifest and `interface`
block, canvas actions, the KV store and the `workspace` block work as
before. See [the canvas architecture](../architecture/canvas.md) for the
details an app author needs.

## With an agent

Ask in plain words. The agent uses `publish_canvas_app`, `find_canvas_app`,
`draw_canvas({fromApp})` and `manage_canvas_app`, with your rights.

- "Save this canvas as an app called release-signoff." — a private app.
- "Share release-signoff with everyone." — it becomes shared.
- "Is there an app for reviewing a pull request?" — it searches first.
- "Show the release-signoff app." — it draws the active version.
- "Let dev@contoso.com publish versions of release-signoff." — a contributor.

If you have a private app and there is a shared app with the same name, you
get yours unless you ask for the shared one.

## From the command line

`pilotswarm apps` talks to a deployment's Web API with your own sign-in.

```
pilotswarm auth login --api-url https://<portal-host>
pilotswarm apps list
pilotswarm apps search "sign off a release"
pilotswarm apps show release-signoff
pilotswarm apps push board.html --name release-signoff --description "Use when several approvers sign off a release train together."
pilotswarm apps pull release-signoff --version 1.2.0 -o board.html
pilotswarm apps describe release-signoff --tags release,approval   # description and tags only; no new version
pilotswarm apps share release-signoff          # unshare to make it private again
pilotswarm apps pin release-signoff@1.1.0
pilotswarm apps editors add release-signoff entra:<object-id>
pilotswarm apps loads release-signoff          # owner or admin
pilotswarm apps rm release-signoff --yes
```

`--shared` and `--user` pick which same-named app a command means, and make
`push` and `import` publish shared or private. Add `--json` for scripts. For
CI, set `PILOTSWARM_API_TOKEN` instead of `auth login`.

The same operations are in the SDK (`PilotSwarmManagementClient`, direct or
with `apiUrl`), the Web API (`/api/v1`, see the
[API reference](../api/reference.md#canvas-apps)) and the MCP server
(`list_canvas_apps`, `publish_canvas_app_html`, `export_canvas_app`, …).

## Export and import

An export is one `.tar.gz` with every version and the app's card. It holds
no owner, scope, contributors or user and session ids, and the same app
always exports to the same bytes.

```
pilotswarm apps export release-signoff -o release-signoff.tar.gz
pilotswarm apps import release-signoff.tar.gz            # private on the other deployment
pilotswarm apps import release-signoff.tar.gz --shared
```

Import checks the whole archive before it writes anything. A version that
already exists with the same bytes is skipped; one that exists with other
bytes fails alone (`VERSION_EXISTS`), and the command exits with code 2.
Importing the same archive again changes nothing.

## Workspace access needs your approval

An app can declare access to the session's folders and commands (its
`workspace` block): a git history viewer, a notes editor. **Before such a
page touches your folders, the portal asks you once**, and shows what it
would read, change and run, and which folders those names point to.

- This applies to every page, whoever wrote it — you, an agent, another
  user.
- The same page drawn again in the same canvas keeps your answer. A changed
  page, a changed `workspace` block or a different folder asks again.
- Only you, the session's owner, can answer. The agent cannot, and neither
  can the page.

Read the prompt before you allow it: an approved page runs as you. See
[security and sharing](./security-and-sharing.md#canvas-apps).

## The old app catalog during the transition

Before the registry, `publish_canvas_app` saved a page as an artifact on
the publishing session and a shared fact `apps/<name>`. Those apps keep
working while the canvas app transition is on:

| `PILOTSWARM_CANVAS_LEGACY_MODE` | What the old catalog does |
|---|---|
| `on` (default) | `find_canvas_app` returns old apps next to registry apps, marked `legacy: true`, with their `key` and `source`; an agent draws one with `draw_canvas({fromArtifact: source})`. `find_canvas_app({name})` falls back to the old card. A registry app of the same name wins. Agents write and delete `apps/*` facts as before. An old app's page, and a canvas drawn before the registry, work as before: no workspace approval, no labels, framed directly, readable by agents. |
| `off` | Only the registry is searched. `apps/*` facts are read-only. Every page follows the registry's rules. |

An old app's page qualifies only while its card in the old catalog is
unchanged since before the registry was installed. An edited copy is a new
page and follows the registry's rules. Any write to an old app's card, even
one that keeps the same page, ends its exemption; each worker and portal
re-reads the old catalog at most once a minute, so the change takes effect
within about a minute. If the old catalog cannot be read,
old pages ask for approval again until it can (see
[security and sharing](./security-and-sharing.md#canvas-apps)).
`pilotswarm apps label <sessionId> [--slot n]` shows how a session's canvas
is handled.

Workers and the portal read the variable separately; set the same value on
both. To move an app into the new format, draw it, then publish it: the
registry app wins by name from then on, and the old fact stays until an
admin removes it.

## Moving the old app catalog

After the transition, an admin moves the remaining old apps into the
registry once. Applying it needs the transition switched off
(`PILOTSWARM_CANVAS_LEGACY_MODE=off` on the portal or management client that
runs it): it removes the old `apps/<name>` facts, which would end the old
apps' exemption while the transition promises nothing changes. While the
switch is on, `--apply` (and `dryRun: false`) is refused with
`CANVAS_LEGACY_MODE_ON` (409); a dry run still works and ends with
`--apply is blocked: …` (`applyBlocked` in JSON).

```
pilotswarm auth login --api-url https://<portal-host>
pilotswarm apps migrate-legacy                # dry run: changes nothing
  release-signoff      -> shared 1.0.0   owner entra:<alice>  ok
  pr-review-board      -> shared 2.1.0   owner (none)         ok
  old-poll             -> skipped        source artifact missing; fact kept
dry run: 2 to migrate, 1 skipped — run again with --apply
pilotswarm apps migrate-legacy --apply        # imports, checks sha256, removes each migrated fact
pilotswarm apps migrate-legacy --apply        # again: 0 migrated, 1 skipped
```

Every migrated app is shared, as it was before. Its owner is the owner of
the session that held its page; an app whose session is gone has no owner
and admins manage it. The version is the manifest's `version`, else
`1.0.0`. A skipped app keeps its fact and says why.

For a script or CI, use `PILOTSWARM_API_TOKEN` instead of `auth login`. The
SDK equivalent:

```js
const mgmt = new PilotSwarmManagementClient({ apiUrl, getAccessToken });
await mgmt.start();
const plan = await mgmt.migrateLegacyCanvasApps({ dryRun: true });
const done = await mgmt.migrateLegacyCanvasApps({ dryRun: false });
```

## Who can do what

| | Owner | Contributor (shared app) | Other user | Unrestricted admin |
|---|---|---|---|---|
| Find and draw a private app | yes | — | no (not found) | yes |
| Find and draw a shared app | yes | yes | yes | yes |
| Publish a new version | yes | yes | no | yes |
| Enable, disable, describe, pin | yes | yes | no | yes |
| Share, unshare, delete, change contributors | yes | no | no | yes |
| See loads | yes | no | no | yes |

A cluster-scoped admin has the rights of an ordinary user here. Making a
shared app private removes its contributors. Deleting an app removes every
version; canvases already drawn keep working.
