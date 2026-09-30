# Writing a workspace provider

A workspace provider is the code that tells PilotSwarm where a session's
folders are, and makes them ready before each turn. PilotSwarm keeps the
session's workspace record, runs the checks, and gives the folders to the
Copilot CLI. Your provider decides what a folder is: a git clone, a share on
a file server, a person's own folder.

This guide is for people who build a deployment. It covers the interface,
the rules, and three recipes: shared folders, git repos, and a folder per
person. The reference deployment implements all three:
`packages/sdk/examples/repo-workspaces` (see its README). The design, with
every rule and why, is
[docs/proposals/session-workspaces.md](../../proposals/session-workspaces.md).

## Who does what

| PilotSwarm | Your provider |
|---|---|
| Stores each session's record: `{ root, folder }`, plus extra folders | Knows the roots (`listRoots`) and where each is mounted |
| Calls `ensureAttached` before every turn, for every folder, side by side | Makes the folder ready: mounts, leases, first-use setup |
| Checks the path in a child process: it exists, is a folder, stays inside its root | Answers with the path, or an error code and when to retry |
| Holds the user's message while a folder is unavailable, and retries | Says when a retry makes sense (`retryAfterMs`) |
| Adopts the folder's agents, skills and instructions when you allow it (`adopt`) | Decides per folder what may be adopted |
| Calls `release` when a session leaves the worker, ends, or changes folders | Frees what `ensureAttached` took, for example a lease |
| Applies default folders every turn | Names them (`defaultFolders`) |

## The interface

```ts
interface WorkspaceProvider {
    listRoots(): Promise<Array<{ name: string; path: string }>>;
    ensureAttached(req: WorkspaceAttachRequest): Promise<WorkspaceAttachResult>;
    release?(req: WorkspaceReleaseRequest): Promise<void>;          // best effort
    defaultFolders?(ctx: WorkspaceDefaultsContext): WorkspaceDefaults | null | Promise<WorkspaceDefaults | null>;
}

interface WorkspaceAttachRequest {
    sessionId: string;
    rootSessionId: string;        // the session tree: a session and its sub-agents
    workspace: { schema: number; root: string; folder?: string };   // ONE folder
    revision: number;
    workerNodeId: string;         // the worker's own ID (its pod name)
    turnIndex: number;            // rises every turn
    attachment?: string;          // an extra folder's name; absent for the working folder
    purpose?: "turn" | "check";   // turn: a turn runs next; check: a change or a spawn is checked
}

type WorkspaceAttachResult =
    | { ok: true; path: string;
        adopt?: { agents: boolean; skills: boolean; instructions: boolean; folder?: boolean };
        readOnly?: boolean;       // the model is told; your mount must enforce it
        notice?: string }         // a note for the model, delivered with a turn attach only
    | { ok: false; code: string; message: string; retryAfterMs?: number };
```

Register it on the worker, in code or from an extension module:

```js
// In code:
worker.setWorkspaceProvider(provider);

// Or an extension module, loaded through PILOTSWARM_EXTENSION_MODULES:
export async function register(worker) {
    worker.setWorkspaceProvider(provider);
}
```

Several providers, one per kind of root, combine into one:
`combineWorkspaceProviders([repoProvider, sharedProvider])`. A folder goes to
the provider that lists its root.

## What happens every turn

```
Before a turn (the turn preamble):
1. PilotSwarm reads the session's record: the working folder and the extra folders.
2. It adds the default folders, when your provider has defaultFolders.
3. It calls ensureAttached for each folder, side by side. Deadline: 30 s each.
4. For each answer with ok: true, it checks the path in a child process.
5. A required folder that failed: the user's message is held and retried
   (after retryAfterMs, else 30 s, 2 min, 5 min, then every 15 min).
   An optional extra folder that failed: left out of this turn; the model is told.
6. The CLI gets the working folder as its cwd, the extra folders as
   additional directories, and what `adopt` allows.
```

`release` is called with a reason: `ended`, `moved`, `changed`, `evicted`,
`shutdown`, `spawn_check` or `set_check`. Section 4.2 of the design lists
when each happens.

## Rules

- **Stable paths.** The same folder must get the same path on every worker.
  Mount every root at the same path everywhere. A changed path misses the
  model's prompt cache and restarts the CLI session.
- **No synchronous file calls on the mount inside a hook.** A hung file
  server blocks the worker's event loop, and the 30 s deadline cannot stop
  that. Run file calls in child processes with their own deadline.
- **An empty mount point is not a mount.** If the share is not mounted, the
  mount point is an empty local folder, and writes land on the worker's own
  disk. Put a marker file on the export (the reference uses
  `.pilotswarm-export`) and check it before every answer.
- **`adopt` omitted means adopt nothing.** Adopt only from folders whose
  content you trust as much as your own configuration. Adopted agents get
  tools. Repo MCP servers and hooks are never adopted.
- **Use `purpose`.** `check` is a quick look: the folder may be released at
  once and no turn follows yet. Leave one-time work, such as restoring a
  folder, to `turn`.
- **`notice` is said once.** PilotSwarm adds it to the turn's prompt and does
  not remember it. Send it once; send it again only when the same turn is
  retried (same `turnIndex`). At most 4,000 characters.
- **Error codes.** Use PilotSwarm's codes where they fit:
  `WORKSPACE_ROOT_UNKNOWN`, `WORKSPACE_PATH_INVALID`,
  `WORKSPACE_FOLDER_MISSING`, `WORKSPACE_NOT_MOUNTED`,
  `WORKSPACE_ATTACH_FAILED`, `WORKSPACE_ATTACH_TIMEOUT`,
  `WORKSPACE_STALE_MOUNT`. Your own codes pass through unchanged. Set
  `retryAfterMs` when waiting can help; leave it out when only a person can
  fix the problem.

## Recipe: a shared folder

A folder on a file server that sessions read and write. No git, no leases.

```
The file server exports /ws/shared (mode 1777: every session can add
files; the sticky bit keeps root's files, such as the marker, from being
deleted). Every worker mounts it at /ws/shared.
The provider answers ensureAttached:
1. The marker /ws/shared/.pilotswarm-export exists (checked in a child
   process). If not: WORKSPACE_NOT_MOUNTED, retryAfterMs 30000.
2. { ok: true, path: "/ws/shared/<folder>" }, no adopt.
```

The sticky bit protects only files of another uid. When every session runs
as the same uid (the reference does), any session can change or delete any
file a session added; only root's files are safe. A wall between people
needs one uid per person (below).

The reference module does this for every root in `PS_PLAIN_ROOTS`. Sessions
add the folder as an extra folder:
`set_session_workspace({ extra: { shared: { root: "shared" } } })`. Or make
it a default extra folder for everyone (a folder per person, below).

For a read-only share (logs, for example), mount it read-only and answer
`readOnly: true`, so the model is told.

## Recipe: git repos

The reference keeps one repo service next to the file server. Summary; the
design's sections 5.1 to 5.4 have the details.

```
On the repo server's disk:
  repos/<repo>.git              a mirror of the upstream, owned by the service; sessions only read it
  sessions/<tree>/<repo>/       a clone per session tree (git clone --shared from the mirror),
                                owned by the sessions' uid (1000)
  remotes/<repo>.git            a sandbox remote per repo (optional)
```

- **One clone per session tree**, not a git worktree: worktrees share
  branches, stash and hooks through the mirror.
- **Two uids.** The mirrors belong to the service; sessions run as another
  uid. So a session cannot change a mirror, and it cannot delete what other
  sessions share. Export with `root_squash`, so a client's root cannot either.
- **Leases say "in use".** A clone belongs to one session tree; another
  tree gets `WORKSPACE_IN_USE`. Every turn, `ensureAttached` adds a lease
  entry for the session (its worker and turn index), and `release` removes
  it. While a live entry exists, the service never removes the clone and
  never deletes git lock files, which could belong to a git command still
  running. An entry whose worker is gone counts as dead (the deployment
  passes `isWorkerAlive`), and a late release never deletes a newer entry.
  PilotSwarm runs a session on one worker at a time, so entries do not need
  to lock anything.
- **Pushing.** The reference pushes to a sandbox remote served by the repo
  service, whose hook refuses `main`, `master` and `release/*`. A real
  deployment points `origin` at the real remote and gives the service a
  token minter; the clone's credential helper asks the service for a token
  per push. Branch rules then live in the real git server.
- **Adopt per repo.** The deployment's repo list says, per repo, whether its
  agents, skills and instructions are adopted. A file in the repo cannot turn
  it on.
- **Idle cleanup.** Clones take disk. The reference removes a clone no
  session used for a set time (7 days by default), keeps a record of what
  was lost (branch, commit, uncommitted changes, commits no remote has), and
  makes a fresh clone when the session comes back, with a `notice` that
  says what happened. Agents are told to push before they stop.

## Recipe: a folder per person, and default folders

Give every session its person's folder and the shared folder, without the
session asking. Add `defaultFolders` to your provider:

```ts
defaultFolders(ctx) {
    // ctx.owner: { provider, subject, email?, displayName? } | null; ctx.isSystem
    return {
        home: { name: "home", root: "home", folder: `users/${folderName(ctx.owner, ctx.isSystem)}` },
        extra: { shared: { root: "shared" } },
    };
}
```

What PilotSwarm does with the answer, every turn:

```
The session's record has no working folder -> home is the working folder
The record has a working folder            -> home is extra folder "home"
Each extra entry                           -> an extra folder of that name
A name the record uses, or a folder that overlaps one of the record's -> left out
```

Rules to know:

- **An extra folder needs a working folder.** Defaults that name only extra
  folders (no `home`) reach only sessions that have a working folder of
  their own. To give every session `shared`, also give each person a
  folder.
- **System sessions.** `ctx.isSystem` marks PilotSwarm's own system agents;
  their sub-agents run as the `system` owner. Return no defaults for them,
  so they run as before. The reference provider does.
- **What the model is told.** A session with folders gets a fixed section
  that says its folders are durable, and the base prompt no longer says a
  durable working folder may vanish. Your roots must be durable storage
  that every worker mounts at the same path.
- **What the portal shows.** PilotSwarm records the defaults a turn used as
  a `session.workspace_defaults` event, when they change, and the portal
  shows them. It records the record's folders a turn opened, with their
  paths, as `session.workspace_opened`. The portal's Workspace tab serves
  only folders a worker opened, so your `ensureAttached` answer also
  decides what the session's owner can see there.

Defaults are never saved in the record, and they do not count against the
four extra folders a session may set. A default is optional unless you say
`required: true`. When the person's folder is the working folder only
because the record has none, and it cannot attach, an optional one lets the
turn run with no folders (the model is told); a required one holds the
user's message until the folder is back.

In `ensureAttached` for the home root, the reference provider:

1. Allows only the session owner's own folder. It reads the owner from the
   session catalog once per session, and answers `WORKSPACE_PATH_INVALID`
   for any other folder.
2. Makes the folder on first use, and copies starter files into it without
   replacing anything.
3. Refuses a folder whose real path leaves the person's folder (a link out).
4. Answers `adopt: { agents: true, skills: true, instructions: true, folder: true }`.
   `folder: true` lets a folder that is not a git repo adopt. The person's
   folder is the only extra folder that adopts: its agents and skills work
   also while the session is in a repo, after the repo's own.

Folder names are yours to choose. The reference uses the email, lowercased,
with other characters as `_`; `_anon` when the portal has no sign-in;
`_system` for system sessions. A name that never changes (an ID from your
identity provider) avoids a new empty folder when an email changes.

## How strong is the wall between people

| Level | What it takes | What it stops |
|---|---|---|
| 1. A path rule (the reference today) | The owner check in `ensureAttached` | A session setting another person's folder as its workspace. Not a shell command: every session runs as the same uid |
| 2. A uid per person | A person-to-uid map every worker agrees on (for example on the file server's disk); each owner's CLI process runs as that uid; folders mode 0700; the file server's port reachable only from the nodes, because NFS with AUTH_SYS trusts the client's uid | Reading or writing another person's files from a shell |
| 3. A private view per session | A sandbox (for example bubblewrap) that shows each session only its own folders | Seeing that other folders exist |
| 4. Separate pods per tenant | A worker pool per tenant | Sharing a worker with another tenant |

Pick the level that fits who uses the deployment. Level 1 guards against
mistakes, not against a person who wants to read another person's files.

## The portal's Workspace tab

The portal's Workspace tab lets a session's owner browse, edit, upload and
download the session's files (the [user guide](../../user-guide/workspaces.md)
shows it). The portal does the file calls itself, on its own mount of the
roots; it never asks a worker. So a deployment that wants the tab:

```
1. Mount the roots in the portal pod: the same export, at the same path and
   as the same uid as on the workers (so files it writes look like the agent's)
2. Tell the portal where they are, by root name:
     PORTAL_WORKSPACE_ROOTS=a=/ws/a,shared=/ws/shared,home=/ws/home
3. Optional: the file limit, in MB (default 20; also the limit of a folder .zip):
     PORTAL_WORKSPACE_MAX_FILE_MB=20
4. Optional: serve roots that have no .pilotswarm-export marker (default: refuse them):
     PORTAL_WORKSPACE_REQUIRE_MARKER=false
```

Without `PORTAL_WORKSPACE_ROOTS` the portal hides the tab. A root the portal
does not list is shown but cannot be opened.

The Azure GitOps deployment does steps 1 and 2 when `WORKSPACES_ENABLED=true`:
the portal pod mounts the node attacher's `/mnt/ps` at `/ws`, like the
workers (`deploy/providers/azure/gitops/portal/components/workspaces`). The
attacher mounts every root at start on every node, the portal's included.

The portal applies the rules, not the mount (the mount can reach every
folder):

- only the session's owner: the `session:files` access class, enforced even
  when `AUTHZ_ENFORCE_OWNERSHIP` is off, with no pass for admins;
- only folders a worker opened for the session: a folder of its record after
  a turn or a set opened it (`session.workspace_opened`, or a path in
  `session.workspace_changed`), and the default folders its last turn used.
  A record alone is not enough: nothing checked it yet. Every path stays
  inside its folder, links included;
- a root must hold its `.pilotswarm-export` marker: an unmounted share is an
  empty local folder, and writes would land on the node's own disk;
- `.git` and a root's `.pilotswarm-export` are read-only;
- every file call runs in a child process with a deadline (30 s), so a hung
  mount cannot hang the portal.

### Canvas apps on the session's files (canvas-ws)

A canvas app can make the same file calls, and run commands, through the
portal (`canvasWorkspace` in the Web API). The app's manifest declares what
it may touch; the portal reads that declaration from the drawn document and
checks every call against it (`packages/sdk/src/canvas-workspace.ts`).
Commands are off unless the deployment says where they run:

```
PORTAL_CANVAS_COMMANDS_RUNNER=local     run them as a child process of the portal
PORTAL_CANVAS_COMMANDS_ALLOW=git        the programs a command may run (default: git)
```

`local` is for development: the program runs as the portal's own user, with
a clean environment and no shell. For git it turns off hooks, fsmonitor,
pagers, editors, credential helpers and the network, stops at the session
folder when it looks for a repository, and refuses a repository whose own
settings start programs (a diff textconv, a filter, an alias with `!`). The
portal's user still reaches the portal's own files, so a shared deployment
needs a sandboxed runner (a pod with the worker image, the roots, and no
secrets) before it turns commands on.

## Testing your provider

- **Unit tests** against a temp folder: the owner rule, first use, the
  marker, links out, and every error code. See
  `test/unit/repo-workspaces-home.test.mjs` and
  `test/unit/repo-workspaces-phase3.test.mjs`.
- **A real worker with a scripted model**: `withScriptedModel` in
  `test/helpers/scripted-workers.js` runs a real worker and the real Copilot
  CLI against a model whose answers the test writes. See
  `test/local/workspace-defaults.test.js` and
  `test/local/workspace-loads.test.js`.
- **A fake provider** for PilotSwarm's side of the contract:
  `test/helpers/fake-workspace-provider.mjs`.
- **Break each rule on purpose** and check that a test fails. A test that
  cannot fail hides the bug it was written for.
