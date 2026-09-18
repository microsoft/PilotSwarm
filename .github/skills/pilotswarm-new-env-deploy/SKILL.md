---
name: pilotswarm-new-env-deploy
description: Scaffold a PilotSwarm Azure environment or update an existing Bicep/GitOps stamp; route managed deployments through Actions.
---

# PilotSwarm Azure environment setup

Read `.github/DEPLOYMENT.md` first to select the target and execution path.
For this repository's managed Azure environment, use the documented Actions
from `main`; local deployment/reset commands are not an alternative. Keep
real identifiers and credentials in ignored config and protected secrets.

For a fresh machine, local provider tests or a fork's CI installation, follow
`docs/developer/contributing/local-ci-and-tests.md` and `.github/CI.md`.
For releases use the `pilotswarm-release` skill: tarballs in GitHub Releases,
complete PostgreSQL baseline plus additive HDB gate, then Azure deployment.
Ordinary merges do not deploy. Release publication requires a publication request.

Local `deploy:new-env` scaffolding is allowed; inspect existing ignored stamp
config before creating or replacing files. Resolve the intended auth posture
before creating an Entra app or assigning access. Reusing an existing app does
not require creating another one. Match the operator's tenant requirements.

Only for an explicitly selected operator-managed environment, consult
[the detailed operations reference](references/operator-managed-environments.md).
Do not assume bare “the cluster” means a legacy bash target. Keep the selected
controller, resource group and namespace consistent. Deployment never implies
permission to wipe data. Preserve already-granted authorization; request only
missing target information or authorization needed for a new operation.

Verify workflow completion, deployed source/images, readiness and the public
portal assets before declaring success. Keep output free of private endpoints
and credentials. Read-only local inspection is permitted.
