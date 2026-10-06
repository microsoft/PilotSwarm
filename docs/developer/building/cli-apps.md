# Building CLI Apps

This guide is for people building on the shipped PilotSwarm CLI/TUI.

If you want one concrete layered-app reference while reading this guide, use the DevOps sample in [examples/devops-command-center](../../../examples/devops-command-center).

If you want reusable Copilot custom agents that help scaffold this kind of app in another repository, see [Builder Agent Templates](./builder-agents.md).

The current CLI story is simple:

- you use the existing TUI binary
- you provide a plugin directory
- optionally, you provide a worker module with custom tools

Download and verify the three matching public release assets using the
[package installation guide](../../quickstart/packages.md), then install them:

```bash
npm install --save-exact ./dist-tarballs/pilotswarm-sdk-X.Y.Z.tgz \
  ./dist-tarballs/pilotswarm-horizon-store-X.Y.Z.tgz \
  ./dist-tarballs/pilotswarm-X.Y.Z.tgz
```

The SDK supplies runtime imports such as `defineTool`. Microsoft distributes
these packages as GitHub Release assets, not registry publications.

This is different from the older `tui-apps.md` AppAdapter concept. Today, the supported path is plugin- and worker-module-driven.

## What The CLI Package Is

The `pilotswarm` package ships the terminal UI with two modes:

- `local` — embeds workers in the same process as the TUI
- `remote` — runs only the client/TUI and connects to a deployment's Web API (already-running workers)

The binary names are:

- `pilotswarm`
- `pilotswarm` (the application package; `pilotswarm-cli` remains as a bin alias)

## When To Use This Path

Choose the CLI/TUI path when:

- you want a ready-made multi-session terminal UI
- you are happy with the built-in layout and interaction model
- you mainly want to customize prompts, skills, tools, and plugins

Choose the SDK path when:

- you want a different UI or service API
- you need app-specific behavior outside the shipped TUI
- you want to embed PilotSwarm into another product

## The Two Extension Hooks

### Noninteractive session steering

The `sessions` command family uses the same public management client in Web API
mode and does not start Ink or require database credentials:

```bash
pilotswarm sessions steering-state <session-id> --api-url <portal-url> --json
pilotswarm sessions steer <session-id> --stdin --client-request-id <caller-id> --expected-target <observed-token> --api-url <portal-url> --json
pilotswarm sessions steering-status <session-id> <request-id> --api-url <portal-url> --json
pilotswarm sessions steering-list <session-id> --api-url <portal-url> --json
pilotswarm sessions withdraw-steering <session-id> <request-id> --api-url <portal-url> --json
```

Authenticate with the existing `pilotswarm auth login` command. Preserve the
caller identity after ambiguous failures; never auto-refresh a stale target.
Use exactly one of `--text`, `--text-file`, or `--stdin`. Exit zero means the
control operation succeeded, not that the agent understood or obeyed guidance.
See [session steering](../../user-guide/session-steering.md).

### 1. Plugin directory

The plugin directory supplies:

- `plugin.json`
- `agents/*.agent.md`
- `skills/*/SKILL.md`
- `.mcp.json`

`plugin.json` is not just metadata anymore. The CLI reads it for TUI branding:

- `tui.title` → terminal/tab title and root system-session title
- `tui.splash` or `tui.splashFile` → startup splash and root system-session splash

Pass it with:

```bash
npx pilotswarm --plugin ./plugin
```

### 2. Worker module

The worker module supplies local worker-side code such as custom tools.

Pass it with:

```bash
npx pilotswarm --plugin ./plugin --worker ./worker-tools.js
```

The module is loaded in local mode and can export:

- `tools`
- `systemMessage`
- `skillDirectories`
- `customAgents`
- `mcpServers` — inline configs apply to every session (legacy); plugin `.mcp.json` servers form a catalog that agents opt into via frontmatter (see the plugins guide, §6)

The most common use is exporting `tools`.

## Recommended App Layout

```text
my-cli-app/
├── .env
├── plugin/
│   ├── plugin.json
│   ├── agents/
│   │   ├── default.agent.md
│   │   └── reviewer.agent.md
│   ├── skills/
│   │   └── code-review/
│   │       └── SKILL.md
│   └── .mcp.json
└── worker-tools.js
```

For a fuller example with layered agents, skills, session policy, TUI branding, and mock tools, see [examples/devops-command-center](../../../examples/devops-command-center).
The repo-root launcher for that sample is [scripts/run-devops-cli-sample.sh](../../../scripts/run-devops-cli-sample.sh).

Minimal `plugin.json` example:

```json
{
  "name": "devops",
  "description": "DevOps Command Center",
  "version": "1.0.0",
  "tui": {
    "title": "DevOps Command Center",
    "splashFile": "./tui-splash.txt"
  }
}
```

## Minimal Worker Module

```js
import { defineTool } from "pilotswarm-sdk";

const summarizeRepo = defineTool("summarize_repo", {
  description: "Summarize the current repository",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    return "Repository summary goes here.";
  },
});

export default {
  tools: [summarizeRepo],
};
```

## Running Locally

```bash
npx pilotswarm local --env .env --plugin ./plugin --worker ./worker-tools.js
```

In local mode:

- the TUI starts the client
- the TUI starts embedded workers
- your plugin directory and worker module are loaded in the same process

This is the easiest way to build and test a CLI app.

## Running Against Remote Workers

Remote mode connects the TUI to a deployment over its Web API (see the [API reference](../../api/reference.md)). The only value you need is the portal URL:

```bash
npx pilotswarm remote --api-url https://portal.example.com
```

You can also set `PILOTSWARM_API_URL` instead of passing the flag, including via `--env .env.remote`.

Compared to the old database-connected remote mode:

- no `DATABASE_URL` or database credentials
- no `kubectl` — logs stream over the API
- auth is discovered from the deployment: no-auth deployments start immediately; Entra deployments open your browser for an interactive sign-in (authorization code + PKCE), with a token cache at `~/.config/pilotswarm/auth/`. Use `--device-code` for headless hosts where the tenant allows it

You can manage sign-in explicitly with the auth subcommands:

```bash
npx pilotswarm auth login --api-url https://portal.example.com
npx pilotswarm auth status --api-url https://portal.example.com
npx pilotswarm auth logout --api-url https://portal.example.com
```

For operators and internal use, the direct store-connected variant still works:

```bash
npx pilotswarm remote --env .env.remote --store "$DATABASE_URL"
```

The K8s log-tail flags (`-c`, `--namespace`, `--label`) only apply in this direct mode. Passing `--api-url` and `--store` together is an error.

In remote mode:

- the TUI is client-only
- your local `--plugin` and `--worker` do not magically change the remote workers
- the remote worker image or process must already include the same plugins and tool code

This is the most important CLI caveat.

## What You Can And Cannot Customize Today

### Easy

- prompts
- agents
- skills
- MCP config
- local worker-side tools
- model and app-level default prompt overlays

### Harder / contributor-level

- layout
- panes
- rendering rules
- observer lifecycle
- session-list behavior
- prompt editor behavior and keybindings

For those, you are working on PilotSwarm itself. See [Working On PilotSwarm](../contributing/working-on-pilotswarm.md).

## TUI Contracts Worth Knowing

- The CLI always prefers the root `pilotswarm` system session as the initially selected session when it exists.
- `?` opens the keybinding modal in navigation modes.
- In prompt mode, `Esc` returns focus to navigation mode.
- The prompt editor supports multiline input: `Option+Enter` inserts a newline instead of submitting.
- If you change keybindings in the TUI implementation, update the startup help hint, the help modal, and any contextual status hints together.

## What To Read Next

- [Building Agents For CLI Apps](./cli-agents.md)
- [Keybindings](../../user-guide/keybindings.md)
- [Examples](./examples.md)
- [Getting Started](../../quickstart/local.md)
