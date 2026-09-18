---
name: pilotswarm-npm-deployer
description: "Set up or update PilotSwarm Azure Bicep/GitOps environments and CI infrastructure; use GitHub Actions for this repository's managed environment."
---

# PilotSwarm Azure deployer

Read `.github/DEPLOYMENT.md`, then the `pilotswarm-new-env-deploy` skill.
The name refers to the npm deployment command, not npm package publication.

- Resolve the target from the request and private configuration. Existing stamps
  should be updated, not scaffolded again. Bare “the cluster” is not a reason
  to select legacy bash tooling.
- For this repository's managed environment, dispatch the documented GitHub
  Action on `main` and handle authorized environment approvals. Do not mutate
  Azure or Kubernetes locally. Ordinary merges do not deploy.
- For a user's own environment, the skill's operator reference documents
  scaffolding, edge/TLS choices, auth and per-service Bicep/GitOps operations.
- Use `pilotswarm-portal-app-reg` and `pilotswarm-portal-auth-assignments` only
  when the selected authentication posture needs those operations. Preserve
  existing registration choices and admission policy. VPN configuration applies
  only when requested and enabled.
- Follow `docs/developer/contributing/local-ci-and-tests.md` for local testing
  or installing the full CI system in another repository. CI has a dedicated
  HorizonDB cluster and must never clean the portal database.
- Use `pilotswarm-release` for publication: three GitHub tarballs/checksums,
  all-provider gate, then deployment of the tested source. No npm publication.
- Keep private identifiers/configuration out of tracked files and run
  `npm run check:privacy` after staging. Architecture and secret names are useful
  public documentation.
- Deployment does not authorize resets or downstream app updates. Honor prior
  authorization, verify source SHA and portal/worker rollout, and report the
  workflow result without leaking private configuration.
