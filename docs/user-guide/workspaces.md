# Working in folders and repos

A session can work in a real folder: a git clone of a repo, your own
folder, or a folder you share with other people. The agent uses its normal
tools there (shell, file edits, git), as on a developer's machine. The
session can move between workers and keep its files.

This page is for people who use a deployment that has workspaces turned on.
What exists (which repos, your own folder, a shared folder) is up to the
deployment. The examples use the reference deployment
(`packages/sdk/examples/repo-workspaces`). The design is in
[docs/proposals/session-workspaces.md](../proposals/session-workspaces.md).

## The words

| Word | What it is |
|---|---|
| Workspace | The folders a session works in: one working folder, and up to four extra folders |
| Working folder | The session's current folder (its cwd). The shell starts there, and the repo's agents, skills and instructions come from there |
| Extra folder | Another folder the session can read and write next to the working folder, under a name. Example: `shared`. Nothing is loaded from it, except from your own folder (below) |
| Root | A named place folders live in, for example `a` (repo clones), `home` (people's folders) or `shared`. Every worker sees a root at the same path |
| Clone | A git clone of a repo, made for your session and its sub-agents. It lives on a repo server, not on the worker |
| Your own folder | One folder per person, for your files, notes, agents, skills and instructions. Every session of yours gets it |
| The shared folder | A folder every person's sessions can read and write |

## Where a session works

| You started the session... | Working folder | Extra folders |
|---|---|---|
| With no workspace | Your own folder | `shared` |
| And then the agent moved into a repo clone | The clone | `home` (your own folder), `shared` |

Ask the agent "where are you working?" It answers from
`get_session_workspace`, which lists every folder, its path and its state.

In the portal: **Manage session** → **Workspace** shows the workspace, with
**Set…**, **Clear** and **Retry now**. A session with no workspace of its own
shows "<folder> (your folder)", and a line lists the default extra folders.

**What is kept.** Files in the working folder and the extra folders are on
durable storage: they survive turns, moves to other workers, and restarts.
The agent is told so. Everything else on the worker (`/tmp`, the home
folder) is scratch and can be gone at the next turn.

## Working in a repo

Ask for it in plain words, for example "clone duroxide and fix the typo in
the README". In the reference deployment the agent does this:

```
1. create_session_clone({ repo: "duroxide" })
       -> a clone for this session and its sub-agents
2. set_session_workspace(<the clone>)
       -> this turn ends; the next turn runs in the clone, by itself
3. git switch -c agent/<topic>, edit, commit
4. git push -u origin agent/<topic>
```

What you get in a clone:

- The repo's instructions (`AGENTS.md`, `.github/copilot-instructions.md`),
  skills (`.github/skills`) and agents (`.github/agents`), when the
  deployment allows them for that repo. Repo MCP servers and hooks never
  run.
- A remote you can push branches to. In the reference deployment it is a
  sandbox copy of the repo: pushes never reach the real upstream, and
  pushes to `main`, `master` and `release/*` are refused.

A sub-agent can work in the same clone or in its own:
`spawn_agent({ task, workspace })`.

**Push before you stop.** A clone that no session uses for a while is
removed, and uncommitted or unpushed work goes with it. The reference
deployment waits 7 days by default (the release test stamp: 6 hours).
Pushed branches stay in the remote.

When a session comes back to a removed clone, it gets a fresh clone at the
same place, on the default branch. Its next turn tells the agent, once:
which branch and commit the old clone was on, and whether work was lost.
Fetch a pushed branch back with `git fetch origin <branch>`.

## Your own folder

Every session of yours gets your folder. It is the working folder when the
session has no other, and extra folder `home` when it works in a repo.

```
users/<you>/
  AGENTS.md                         instructions for every session of yours
  .github/agents/<name>.agent.md    your agents
  .github/skills/<name>/SKILL.md    your skills
  anything else                     your files and notes
```

- A new folder starts with a few starter files: an `AGENTS.md`, a `notes`
  skill and a `summarizer` agent. Change or delete them; they are never put
  back.
- Your `AGENTS.md`, agents and skills work in every session, also while it
  works in a repo. There, the repo's agent or skill wins if both have the
  same name, and your instructions come before the repo's.
- Agents run as native tasks, so your deployment must have native tasks on.
- Your folder is named from your email, for example `ada_example.com`. A
  deployment without sign-in has one folder for everyone: `_anon`.

**Who can see it.** Sessions are refused when they try to use another
person's folder as a workspace. That is a rule against mistakes, not a
lock: in the reference deployment every session runs as the same system
user, so a shell command could still read another person's files. Do not
keep secrets there.

## The shared folder

Every session of every person can read `shared` and add files to it (in the
reference deployment, `/ws/shared`). Use it to hand files to other people.

- Put files in a topic folder, with a line in its `README.md`: the file, who
  you are, the date.
- Do not change or delete other people's files. Nothing stops it: in the
  reference deployment every session runs as the same system user, so any
  session can change a file another session added. Do not keep anything
  there you cannot lose.
- `.github/` there holds agents and skills anyone can load (next section).
  They are read-only; copy one into your own folder to change it.

## Loading an agent or a skill from a file

Point the agent at a file anywhere in its folders, for example "load the
agent in `notes/tools/finder.agent.md`" or "load the share-a-file skill from
the shared folder".

```
load_agent({ path: "notes/tools/finder.agent.md" })
    The turn ends. The next turn continues by itself, and the agent can run
    it through the task tool.
load_skill({ path: "/ws/shared/.github/skills/share-a-file" })
    The skill's text comes back at once.
load_agent({ unload: "finder" }), load_skill({ unload: "share-a-file" })
    Drop a load.
```

- A relative path starts at the working folder. The file must be inside the
  working folder or an extra folder.
- A load stays with the session, on every worker, until you unload it. The
  file is read again every turn, so edits take effect.
- If the file is gone later, or its folder is not attached, the load is left
  out of that turn; `get_session_workspace` says why under `skipped`.
- Other people can write the shared folder. Load only what you trust: a
  loaded agent runs with the tools its file names.

## Which one wins a name

When two agents or two skills have the same name:

```
1. one you loaded by path
2. the working folder's (the repo's; or yours, when your folder is the working folder)
3. yours, from extra folder "home"
```

The one that lost is listed under `skipped`, with the reason.

## Limits

| What | Limit |
|---|---|
| Extra folders a session sets itself | 4 (the deployment's default folders do not count) |
| Agents and skills loaded by path | 32 per session |
| One agent or skill file | 64 KB |
| Your instruction files, read from extra folder `home` | 32 KB |

## When something goes wrong

| You see | What it means | What to do |
|---|---|---|
| The session waits, and the workspace shows "unavailable" | The folder could not be reached before the turn. Your message is held, not lost | It retries by itself (after 30 s, 2 min, 5 min, then every 15 min). **Retry now** retries at once |
| `WORKSPACE_FOLDER_MISSING` | The folder is gone, for example a clone you removed | Make it again, or set another workspace |
| `WORKSPACE_PATH_INVALID` | The folder is not allowed, for example another person's folder, or a link out of the root | Use your own folder, or a folder you are allowed to use |
| `WORKSPACE_BUSY` | A background shell or agent task is running, and the change would stop it | Wait for it, or stop it, then ask again |
| `WORKSPACE_NOT_MOUNTED` | The deployment's storage is not reachable from this worker | It retries by itself; tell the deployment's admins if it lasts |
| The agent says your own folder is not available | A session with no workspace could not reach your folder. The turn ran anyway, in a temporary folder on the worker | Files written in that turn are not kept. Ask again later for work that needs your folder |
