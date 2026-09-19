---
name: pilotswarm-release
description: Prepare and cut Microsoft PilotSwarm releases through GitHub Actions, with all-provider testing, package tarballs and automatic test deployment.
---

# PilotSwarm Release

Use for release preparation or publication in `microsoft/PilotSwarm`. Verify the
checkout's origin and run GitHub commands with `--repo microsoft/PilotSwarm`.
Prepare changes on a `feature/` branch and squash-merge the PR into `main`.
Keep private configuration in protected GitHub environment secrets and ignored
local files. Never put environment names, endpoints or credentials in a PR.

See `.github/DEPLOYMENT.md` for deployment routing and
`docs/developer/contributing/local-ci-and-tests.md` for local validation setup.
Run `npm run check:privacy` after staging release changes.

## Release contract

- The first post-migration release is planned as **v0.6.0**. Check remote tags and
  releases before selecting a version; never replace a published tag.
- **Create release** (`release-tarballs.yml`) is a manual GitHub Action on `main`.
  Merging a PR or pushing a tag does not publish a release.
- One protected-environment approval precedes all cloud work. The Action captures
  the triggering main commit, validates package versions, runs the complete
  PostgreSQL baseline plus additive HorizonDB storage coverage, then builds the three npm-format tarballs.
- Real HorizonDB initialize/store/read coverage is mandatory in CI. Missing
  configuration, skipped preflight or a failed test blocks publication. Do not
  substitute a filtered/sequential rerun for the complete successful gate.
- The Action creates an annotated tag, a draft release, uploads the three `.tgz`
  files plus `SHA256SUMS`, verifies assets, and publishes the release.
- It then automatically deploys the **same tested source commit** to the test
  stamp using the shared Azure Action. This builds worker/portal deployment
  images in Azure Container Registry; it does not install the release tarballs.
- Distribution is GitHub Release assets. Never run `npm publish` or publish a
  starter image. Azure deployment images are a separate deployment concern.
- All provisioning and deployments run through GitHub Actions. No local `az`,
  `kubectl` or legacy shell mutations to deploy this repository's environment.
- Setting up this workflow is not publishing a release. Dispatch **Create
  release** only when the user requests publication.

## Preparation

1. Check working tree, remote tags/releases and the changes since the last
   release. Report the proposed version before publication.
2. Align the versions of `packages/sdk`, `packages/horizon-store`, `packages/app`,
   their internal dependency/peer references, and `package-lock.json`.
3. Add a dated `CHANGELOG.md` entry. Update canonical documentation, relevant
   templates and examples when the shipped behavior changes.
4. Build locally and inspect `npm pack --dry-run` for each package. Confirm each
   package includes its own README and expected runtime files/plugins.
5. Merge the preparation PR with successful **Basic checks**. The release
   candidate is the captured main SHA; later unrelated main commits must not
   change the running release's source.

## Publication

If `PROVIDER_TEST_RUNNER` selects the dedicated one-job Azure runner, obtain a
fresh repository registration token, store it in protected environment secret
`CI_RUNNER_REGISTRATION_TOKEN`, and run `provision-ci-runner.yml` with
`operation=register` **before** dispatching the release. Verify the runner is
online. A prior test consumes its registration. See the
[runner procedure](../../../deploy/providers/azure/ci/runner/README.md).
Use `operation=deallocate` after the release job finishes and verification is
complete. Never store an administrator PAT as the registration secret.

```bash
gh workflow run release-tarballs.yml --repo microsoft/PilotSwarm --ref main -f version=0.6.0
```

Use the prepared version, not a guessed next imported tag. Monitor the Action,
resolve its environment gate with the authorized reviewer, and investigate any
failure. Never weaken the full-provider gate to publish. CI database setup and
required protected secrets are documented in `.github/CI.md`.

Verify separately:

- complete baseline plus additive HDB pass, including real HorizonDB preflight;
- annotated tag resolves to the workflow's tested commit;
- GitHub Release is published and has `pilotswarm-sdk-<version>.tgz`,
  `pilotswarm-horizon-store-<version>.tgz`, `pilotswarm-<version>.tgz` and checksums;
- subsequent Azure worker and portal deployment succeeds and portal health is
  verified against the intended private configuration.

If deployment fails after publication, retain the valid release and retry only
**Deploy Azure stamp** with `release_tag=v<version>`. Never retag or republish.
If publication stops after creating a tag/draft, inspect that unpublished state;
resolve it deliberately before rerunning. Never delete a published release to
work around a failed run. Report release and deployment status separately.

## Package surface

- `pilotswarm-sdk`: runtime, plugins, browser-safe `pilotswarm-sdk/api`.
- `pilotswarm-horizon-store`: optional enhanced facts and graph providers.
- `pilotswarm`: TUI, portal/Web API and MCP server application.

There are exactly three package tarballs. GitHub's generated source archives
are additional source downloads, not the package artifacts.

## Storage test modes

`--all-providers` is the release coverage plan: complete stock PostgreSQL once,
then HDB provider tests and reviewed SDK storage integration tests. It does not
repeat unrelated SDK permutations. `--with-horizondb` runs the entire suite
with CMS/orchestration/facts/graphs on HDB. No flag means stock PostgreSQL only.
Parallelism defaults to eight test files. See `.github/CI.md` and the reviewed
`scripts/provider-test-coverage.json` exclusions; new suites default into HDB.
