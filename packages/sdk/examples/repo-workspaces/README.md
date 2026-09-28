# Repo workspaces (reference)

A working example of session workspaces on a repo pod: sessions work in real
git clones that live on the repo pod and are reached over NFS. The design is
in [docs/proposals/session-workspaces.md](../../../../docs/proposals/session-workspaces.md),
sections 5 and 12.1.

The release environment runs this example when its settings have
`WORKSPACES_ENABLED=true` (see [Deploying it](#deploying-it)). There the repo
pod mirrors two public repos, and every session can also use a shared folder
that all sessions read and write:

| Repo | What it shows |
|---|---|
| github.com/microsoft/duroxide | repo instructions and a repo skill |
| github.com/tfutils/tfenv | repo instructions and 11 repo agents (`.github/agents`): architect, bug-finder, documenter, reviewer and more |

## Files

| File | Runs on | What it does |
|---|---|---|
| `repo-service.mjs` | the repo pod | Owns the mirrors (`repos/<repo>.git`) and the session clones (`sessions/<rootSessionId>/<repo>`). Mirrors each repo at start and fetches every few minutes. Keeps the leases, removes stale git lock files, removes clones no session has used for a while (idle cleanup, below), runs named mirror maintenance only, and mints tokens for the remotes of the repos it serves. Mirror fetch and maintenance need the admin token (`REPO_SERVICE_ADMIN_TOKEN`), which workers never get. `node repo-service.mjs` starts it; see `main()` for the environment. |
| `sandbox-remote.mjs` | the repo pod | A sandbox remote per repo (`remotes/<repo>.git`), served over git smart HTTP by the repo service. Session clones push there, never to the real upstream. Its `pre-receive` hook refuses deletions, pushes to `main`, `master` and `release/*`, and non-fast-forward updates. |
| `nfs-server.sh` | the repo pod | Starts the node kernel's NFS server for the repo pod's exports (NFS 4.1 and 4.2 only). Needs a privileged container. |
| `attacher.mjs` | each worker node | The node attacher: mounts each root's NFS export at `/mnt/ps/<root>` on the node, at start and when asked over a unix socket. A root it cannot mount at start (the repo pod may come up later) is retried every 30 s. Worker pods see `/mnt/ps` at `/ws`. It never unmounts. |
| `provider.mjs` | each worker | The `WorkspaceProvider`s. The repo provider checks the root's `.pilotswarm-export` marker in a child process, then takes a lease on the session clone that holds the folder; it serves session clones and folders inside them only. For a turn, it asks the service to restore a clone that idle cleanup removed, and passes the service's note to PilotSwarm once. The plain-root provider checks the marker and nothing else: no leases. Both ask the attacher to mount a root that is not mounted, and to remount one that answers `ESTALE`. |
| `tools.mjs` | each worker | Agent tools: `create_session_clone`, `list_session_clones`, `remove_session_clone`. |
| `credential-helper.mjs` | each worker | The git credential helper each clone sets after an empty one. It sends the repo service the protocol, host and path git asks about. The service answers only for the remote of a repo it serves; it does not check that the remote is the calling clone's own. |
| `index.mjs` | each worker | `register(worker)`: the providers (repo roots, plus plain roots from `PS_PLAIN_ROOTS`) and the tools, loaded through `PILOTSWARM_EXTENSION_MODULES`. |
| `plugin/` | each worker, the portal | The `repo-coder` agent, loaded through `PLUGIN_DIRS`. The portal lists and starts only agents it loads itself, so it loads this folder too. |

## The repo pod's disk

```text
/ws/a                     root 0755   the repo root, exported over NFS
  .pilotswarm-export      root 0644   the marker the providers check
  repos/<repo>.git        root        mirrors; sessions only read them
  remotes/<repo>.git      root        sandbox remotes; reached over HTTP, never through the mount
  sessions/               1000 0755   session clones, made as uid 1000 (the worker's uid)
/ws/shared                root 1777   a plain root, exported over NFS: every session may
  .pilotswarm-export      root 0644   read and write; the sticky bit keeps the marker
/ws/.repo-service/        root        clone records, leases and removal records (not exported)
/ws/.nfsdcld/             root        the NFS server's client list (not exported)
```

Each root has the same path on the repo pod and in worker pods (`/ws/a`,
`/ws/shared`). The NFS server squashes root, so nothing that belongs to root
can be changed over NFS.

## Environment

Worker:

```text
PILOTSWARM_EXTENSION_MODULES=/app/packages/sdk/examples/repo-workspaces/index.mjs
PS_WORKSPACE_ROOTS=a=/ws/a                  repo roots: root name = its path in this pod
REPO_SERVICE_URL=http://repo-cache:8080     the tools and the credential helper use this one;
                                            the provider also reads REPO_SERVICE_URL_<NAME> per root
PS_PLAIN_ROOTS=shared=/ws/shared            optional plain roots: folders with no repo service,
                                            such as a shared folder or a log share; each needs
                                            the .pilotswarm-export marker
ATTACHER_SOCKET=/run/pilotswarm-attacher/sock   optional: the node attacher; a root that is not
                                            mounted in this pod is mounted through it on first use
PLUGIN_DIRS=/app/packages/sdk/examples/repo-workspaces/plugin   the repo-coder agent
```

Repo service (`main()` in `repo-service.mjs` has the full list):

```text
REPO_SERVICE_ROOT=/ws/a                     the export root
REPO_SERVICE_ROOT_NAME=a                    its name in workspace records
REPO_SERVICE_REPOS={"duroxide": {"upstream": "https://github.com/microsoft/duroxide.git",
                                 "sandbox": true,
                                 "adopt": {"agents": true, "skills": true, "instructions": true}},
                    "tfenv": {"upstream": "https://github.com/tfutils/tfenv.git", "sandbox": true,
                              "adopt": {"agents": true, "skills": true, "instructions": true}}}
REPO_SERVICE_PUBLIC_URL=http://repo-cache:8080   how workers reach this service; a sandbox
                                            repo's remote is <this URL>/git/<repo>.git
REPO_SERVICE_CREDENTIAL_HELPER=!node /app/packages/sdk/examples/repo-workspaces/credential-helper.mjs
REPO_SERVICE_IDLE_CLONE_HOURS=168           remove a clone no session has used for this long
                                            (default 168 = 7 days; 0 = never; the test stamp uses 6)
```

A repo with `remote` instead of `sandbox` uses its real remote, and the
deployment then passes its own token minter (`mintToken`) to
`createRepoService()`.

Attacher (`attacher.mjs`):

```text
ATTACHER_ROOTS=a=repo-cache.pilotswarm.svc.cluster.local:/ws/a,shared=repo-cache.pilotswarm.svc.cluster.local:/ws/shared
ATTACHER_MOUNT_BASE=/mnt/ps
ATTACHER_SOCKET=/run/pilotswarm-attacher/sock
```

## What `adopt` does

`adopt` is set per repo, in `REPO_SERVICE_REPOS`, by the deployment. A file in
the repo cannot turn it on. The service returns it with every lease, the
provider hands it to PilotSwarm, and PilotSwarm then adopts the repo's
`.github/agents`, `.github/skills` and instruction files (`AGENTS.md` and the
like) for sessions whose working folder is in that repo's clone. Only an exact
`true` counts; a repo with no `adopt` adopts nothing. Repo MCP servers and
hooks never run, whatever it says. Proposal section 4.6 has the rules.
duroxide has `.github/copilot-instructions.md` and a skill, so a session in a
duroxide clone gets both. tfenv adds agents. An adopted agent runs as a native
task on the session's model (its own `model` line is dropped), so it needs
workers with `PILOTSWARM_NATIVE_SUBAGENTS=sync` and the `copilot.native_tasks`
feature flag on (Admin Console, Features). Agents that work through GitHub
issues or `gh` cannot do their job against the sandbox remote.

## How an agent works

Start working in a repo:

```text
1. create_session_clone({ repo: "duroxide" })   -> { workspace: { root: "a", folder: "sessions/<tree>/duroxide" } }
2. set_session_workspace(workspace)             -> this turn ends; the next one runs in the clone
   or spawn_agent({ task, workspace })          -> a sub-agent works there
3. git switch -c agent/<topic>; edit; commit
4. git push -u origin agent/<topic>             -> the sandbox remote; the helper supplies a token
```

Add the shared folder next to the clone, as an extra folder (section 4.10):

```text
set_session_workspace({ extra: { shared: { root: "shared" } } })
                                              -> ready in this turn at /ws/shared;
                                                 the working folder stays the clone
set_session_workspace({ extra: { shared: null } })  -> removes it again
```

`createWorkspaceProvider()` in `index.mjs` combines the plain-root provider
with the repo provider (`combineWorkspaceProviders`). A plain root that has a
repo root's name, or whose path overlaps a repo root's path, stops the worker
at start.

## Idle cleanup

A clone that no session has used for `REPO_SERVICE_IDLE_CLONE_HOURS` is
removed. "Used" means a session took or released a lease on it: every turn
takes one, and a session releases it when it leaves the worker. A clone with
a live lease entry is never removed. Pushed branches live in the remote, so
they outlast the clone; uncommitted and unpushed work does not.

```text
Every 1 to 15 minutes (a twelfth of the idle time):
1. For each clone idle longer than the limit, with no live lease entry:
   a. look inside it, as the session uid: branch, commit, uncommitted
      changes, commits no remote has
   b. delete it (and its tree folder, when it was the last clone there)
   c. keep a removal record, and log one JSON line: event "clone.removed"

When a session of that tree next runs a turn in the clone:
2. The provider finds the folder missing -> POST /v1/clones/restore
3. The service makes a fresh clone at the same path (only after an idle
   removal; a clone removed on request stays removed) -> "clone.restored"
4. The turn runs. Each session that used the old clone gets one note in
   its prompt: when and why it was removed, what was lost, the last branch
   and commit, and how to get a pushed branch back. The note is also in
   the session's history.
```

Checks never restore: the check behind `set_session_workspace` or
`spawn_agent` attaches with `purpose: "check"` and gets `WORKSPACE_FOLDER_MISSING`.
The agent can then call `create_session_clone`, whose answer shows the old
removal.

Where to look afterwards:

```text
list_session_clones()          this tree's clones (last use, when each goes) and removed clones
GET /v1/clones?rootSessionId=  the same, from the repo service
the repo pod's log             one JSON line per clone.created, clone.removed, clone.restored,
                               clone.remove_failed; kept by the cluster's log collector
```

On the Azure stamp, the log lines are in Log Analytics, table `ContainerLogV2`
(kept 30 days by default):

```kusto
ContainerLogV2
| where ContainerName == "repo-service" and LogMessage has "clone."
| project TimeGenerated, LogMessage
```

The removal records stay in the service's state file for a year.

## Deploying it

The Azure deployment ships this example when `WORKSPACES_ENABLED=true` is in
the environment settings (default `false`). Set `USER_POOL_MIN_COUNT=2` too,
so cross-node tests have two worker nodes:

```text
deploy/Dockerfile.repo-cache                        the repo pod image: git, the NFS server, this folder
deploy/Dockerfile.worker                            + git, nfs-common, this folder
deploy/Dockerfile.portal                            + plugin/
deploy/providers/azure/services/repo-cache/         the repo-cache service (bicep: manifest container + Flux)
deploy/providers/azure/services/base-infra/bicep/aks.bicep   the `repocache` node pool: one node, no
                                                    autoscaling, tainted so only the repo pod runs there
deploy/providers/azure/gitops/repo-cache/           the repo pod: Deployment (init layout, repo-service,
                                                    privileged nfs), disk, Service (2049, 8080),
                                                    NetworkPolicy (8080 from worker pods only)
deploy/providers/azure/gitops/worker/components/workspaces/   the attacher DaemonSet and the worker patch
deploy/providers/azure/gitops/portal/components/workspaces/   the portal's PLUGIN_DIRS
deploy/scripts/lib/workspaces.mjs                   the switch: deploy repo-cache, and add the two
                                                    components to the staged worker and portal overlays
```

The nodes need the kernel NFS server module (`nfsd`); Azure Linux has it. The
NFSv4 root of the repo pod's server is a small in-memory folder with the disk
mounted under it: the kernel cannot export a container's own root (overlayfs).

Turning the switch off later stops deploying these parts but does not remove
what is running: Flux keeps the repo pod from its last upload, and the node
pool stays. To remove them, delete the `repo-cache` Flux configuration
(`az k8s-configuration flux delete`; Flux then deletes the pod and its disk)
and the node pool (`az aks nodepool delete --name repocache`).

What a copy with real repos changes: its repo list and `adopt` per repo, real
remotes with a token minter that uses the deployment identity, server-side
branch rules in its git servers instead of the sandbox hook, and the worker
registry the lease rules read (`isWorkerAlive`). Without `isWorkerAlive`, only
an entry's age decides. Proposal section 12.2 has the list.

## Tests

- `test/unit/repo-workspaces-example.test.mjs`: the service rules.
- `test/unit/repo-workspaces-phase3.test.mjs`: the sandbox remote, clones made
  as another uid than the mirror's owner, the attacher, the plain-root provider.
- `test/unit/repo-workspaces-idle-cleanup.test.mjs`: idle cleanup, removal
  records, restore and the one-time note (I1 to I8).
- `test/local/repo-workspaces.test.js`: a real worker, including a git clone
  and a log share mounted at once, and a clone removed while idle and made
  again on the next turn (I9).
- `deploy/scripts/test/workspaces.test.mjs`: the switch and the rendered
  Kubernetes objects.
