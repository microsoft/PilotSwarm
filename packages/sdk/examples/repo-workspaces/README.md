# Repo workspaces (reference)

A working example of session workspaces on a repo pod: sessions work in real
git clones that live on the repo pod and are reached over NFS. The design is
in [docs/proposals/session-workspaces.md](../../../../docs/proposals/session-workspaces.md),
sections 5 and 12.1.

| File | Runs on | What it does |
|---|---|---|
| `repo-service.mjs` | the repo pod | Owns the mirrors (`repos/<repo>.git`) and the session clones (`sessions/<rootSessionId>/<repo>`). Keeps the leases, removes stale git lock files, runs named mirror maintenance only, and mints tokens for the remotes of the repos it serves. Mirror fetch and maintenance need the admin token (`REPO_SERVICE_ADMIN_TOKEN`), which workers never get. `node repo-service.mjs` starts it; see `main()` for the environment. |
| `provider.mjs` | each worker | The `WorkspaceProvider`: checks the root's `.pilotswarm-export` marker in a child process, then takes a lease on the session clone that holds the folder. It serves session clones and folders inside them only. A release deletes only this worker's own lease entry. |
| `tools.mjs` | each worker | Agent tools: `create_session_clone`, `list_session_clones`, `remove_session_clone`. |
| `credential-helper.mjs` | each worker | The git credential helper each clone sets after an empty one. It sends the repo service the protocol, host and path git asks about. The service answers only for the remote of a repo it serves; it does not check that the remote is the calling clone's own. |
| `index.mjs` | each worker | `register(worker)`: the provider and the tools, loaded through `PILOTSWARM_EXTENSION_MODULES`. |

Worker environment:

```text
PILOTSWARM_EXTENSION_MODULES=/app/examples/repo-workspaces/index.mjs
PS_WORKSPACE_ROOTS=a=/ws/a                  root name = its path on this pod
REPO_SERVICE_URL=http://repo-cache:8080     the tools and the credential helper use this one;
                                            the provider also reads REPO_SERVICE_URL_<NAME> per root
```

How an agent starts working in a repo:

```text
1. create_session_clone({ repo })            -> { workspace: { root, folder } }
2. set_session_workspace(workspace)           -> this turn ends; the next one runs in the clone
   or spawn_agent({ task, workspace })        -> a sub-agent works there
```

What this example leaves to a deployment: the NFS export and the attacher
that mounts it on each node (the provider's `attach` option), the token
minter (`mintToken`), and the worker registry the lease rules read
(`isWorkerAlive`). Without `isWorkerAlive`, only an entry's age decides.

Tests: `test/unit/repo-workspaces-example.test.mjs` (the service rules) and
`test/local/repo-workspaces.test.js` (a real worker).
