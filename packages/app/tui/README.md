# PilotSwarm TUI

Terminal UI for PilotSwarm.

Download and verify a public release using the
[package installation guide](https://github.com/microsoft/PilotSwarm/blob/main/docs/quickstart/packages.md),
then install the matching packages:

```bash
gh release download vX.Y.Z --repo microsoft/PilotSwarm --pattern '*.tgz' --dir dist-tarballs
npm install ./dist-tarballs/pilotswarm-sdk-X.Y.Z.tgz \
  ./dist-tarballs/pilotswarm-horizon-store-X.Y.Z.tgz \
  ./dist-tarballs/pilotswarm-X.Y.Z.tgz
```

Microsoft releases npm-format assets on GitHub, not to the npm registry.

Run locally against a plugin directory:

```bash
npx pilotswarm local --env .env --plugin ./plugin --worker ./worker-module.js
```

The `pilotswarm` package provides the shipped TUI (`pilotswarm-cli` remains a
bin alias). Your app customizes it with `plugin/plugin.json`,
`plugin/agents/*.agent.md`, `plugin/skills/*/SKILL.md`, and optional worker-side
tools.

The shipped files inspector supports shared artifact browsing, download, local open, and delete flows. Binary artifacts download intact rather than being coerced through UTF-8 text previews.

Portal/runtime helpers are exported from `pilotswarm/host`; shared UI layers
are exported from `pilotswarm/ui-core` and `pilotswarm/ui-react`.

Common docs:

- CLI apps: `https://github.com/microsoft/PilotSwarm/blob/main/docs/developer/building/cli-apps.md`
- CLI agents: `https://github.com/microsoft/PilotSwarm/blob/main/docs/developer/building/cli-agents.md`
- Keybindings: `https://github.com/microsoft/PilotSwarm/blob/main/docs/user-guide/keybindings.md`
- DevOps sample: `https://github.com/microsoft/PilotSwarm/tree/main/examples/devops-command-center`
