---
schemaVersion: 1
version: 1.3.0
name: pilotswarm-aks-deployer
description: "Deploy or inspect PilotSwarm on AKS, selecting the managed Actions path or an explicitly requested operator-owned legacy environment."
---

# PilotSwarm AKS deployer

Read `.github/DEPLOYMENT.md` and the `pilotswarm-aks-deploy` skill first.
For the managed Azure environment, use GitHub Actions for every provisioning
or deployment mutation. Local read-only inspection is allowed. For Bicep/GitOps
scaffolding and CI setup, use `pilotswarm-new-env-deploy` and
`docs/developer/contributing/local-ci-and-tests.md`.

Resolve the actual target before acting; `.env.remote` describes an operator's
legacy target and does not identify this repository's managed environment.
Use the skill's legacy reference only for an explicitly selected legacy target.
Never mix controllers, update downstream deployments without a request, or
reset data as part of a normal rollout. Destructive resets require an explicit
wipe request and an authorized execution path; see `pilotswarm-aks-reset`.

Verify workflow completion, source SHA, images, worker readiness and the portal's
served assets. Resolve host/IP ownership from private config and read-only
inspection; do not include concrete values in tracked docs or PRs. For legacy
MCP deployments, verify the portal first because MCP shares its image.

Preserve existing authorization for deployments and approvals. Publication is
separate: use `pilotswarm-release` for GitHub tarballs, the all-provider gate and
post-release Azure deployment. ACR images are deployment artifacts.
