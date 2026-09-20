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

- The first Microsoft release was **v0.6.0**. Check remote tags and releases
  before selecting the next version; never replace a published tag as part of
  an ordinary release.
- **Create release** (`release-tarballs.yml`) is a manual GitHub Action on `main`.
  Merging a PR or pushing a tag does not publish a release.
- One protected-environment approval precedes all cloud work. The Action captures
  the triggering main commit, validates package versions, runs the complete
  PostgreSQL baseline plus additive HorizonDB storage coverage, then builds the three npm-format tarballs.
- Real HorizonDB initialize/store/read coverage is mandatory in CI. Missing
  configuration or skipped/failed preflight blocks publication.
- The complete initial run may qualify directly, or through **one sequential
  verification of 1-5 failed test cases total** across its provider phases.
  **All selected cases passing meets the release bar. Six or more failures fail
  immediately at qualification, without sequential execution.** The original
  result remains visible; the accepted outcome is **qualified after sequential
  verification**, not a clean initial pass.
- Each package carries a package-local `LICENSE` identical to the root license,
  including Microsoft and original-contributor copyright notices and MIT
  permission text. Validate the actual tarball contents, not just manifest
  `"license": "MIT"` metadata.
- The Action creates an annotated tag, a draft release, uploads the three `.tgz`
  files plus `SHA256SUMS` and `LICENSE`, verifies assets, and publishes the release.
- It then automatically deploys the **same tested source commit** to the test
  stamp using the shared Azure Action. This builds worker/portal deployment
  images in Azure Container Registry; it does not install the release tarballs.
  Refresh Azure OIDC login after the long test gate and immediately before
  deployment, before manifest uploads need a storage-audience token.
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
4. Build locally and pack each package. Confirm every tarball includes its own
   README, the complete canonical `package/LICENSE`, and expected runtime
   files/plugins. `validatePackageLicenses` rejects source notice drift;
   `validatePackedLicense` rejects missing or altered notices in the artifact.
5. Merge the preparation PR with successful **Basic checks**. The release
   candidate is the captured main SHA; later unrelated main commits must not
   change the running release's source.

## Publication

Releases use `ubuntu-latest`: the complete baseline runs on local Docker
PostgreSQL, followed by additive remote HorizonDB coverage. No Azure runner
registration is needed. Full-suite-on-HDB runs are optional and separate from
the release gate; only those runs use `PROVIDER_TEST_RUNNER`.

```bash
gh workflow run release-tarballs.yml --repo microsoft/PilotSwarm --ref main -f version=X.Y.Z
```

Use the prepared version, not a guessed next imported tag. Monitor the Action,
resolve its environment gate with the authorized reviewer, and investigate any
failure. Never weaken the full-provider gate to publish. CI database setup and
required protected secrets are documented in `.github/CI.md`.

### Bounded sequential release qualification

Do not immediately repeat the entire release gate when a few tests fail.
The Action collects complete initial Vitest reports and run-health metadata,
then counts failed **test-case executions**, not files:

| Initial failures | Release decision |
| --- | --- |
| 0 | Pass; no sequential verification |
| 1-5 total | Verify exactly those cases once, sequentially; all passing qualifies |
| 6 or more | Fail; do not launch sequential verification |

The cap is global across PostgreSQL SDK, Horizon unit/provider and HDB SDK
phases. A case failing on two providers counts twice and must pass on both.
Verification uses one worker, no file parallelism and concurrency one for
concurrent test cases. It keeps the source SHA, assertions, model, provider and
storage configuration unchanged; already-passing cases are not rerun.

Missing/incomplete results, interrupted processes, failed prerequisites,
suite-level setup/hook or unhandled errors cannot be reclassified as a small case
failure set. A missing, skipped, still-failing or ambiguous selected case blocks
publication. The real HDB preflight and other build/validation prerequisites
remain mandatory. Do not add framework retry settings or repeat the verification.

Preserve the original JSON and sequential JSON reports on the private runner.
The job summary records the original failure count, verification count and
qualification outcome without raw error text or secrets. Keep the run URL,
source SHA and `ciHealth` evidence. Report whether a run passed initially or
qualified after sequential verification; the latter is release-ready, but is
not proof that a load/concurrency issue was fixed.

### Standalone diagnosis

For HDB SDK failures, run the affected files through the protected **Tests**
workflow. A requested sequential diagnostic run uses:

```bash
gh workflow run tests.yml --repo microsoft/PilotSwarm --ref main \
  -f providers=horizondb -f mode=sequential \
  -f 'suite=test/local/cms-seq-nodemap.test.js test/local/contracts.test.js test/local/management.test.js'
```

Replace the example paths with the actual failed files. This runs only those
files plus the real HDB preflight on a hosted runner; it does not repeat the
PostgreSQL baseline. The job is explicitly labelled as diagnostics, cannot
publish, and leaves normal release parallelism unchanged. For baseline failures,
use the baseline suite filter or the documented local targeted test command.

A standalone filtered run has no complete initial-run evidence and therefore
cannot independently qualify a release. Use the automatic bounded qualification
stage above for the release decision; retain separate diagnostics for investigation.

### Verify publication and deployment separately

Verify separately:

- complete baseline plus additive HDB qualification (initial pass or accepted
  sequential verification of at most five failures), including real HDB preflight;
- annotated tag resolves to the workflow's tested commit;
- GitHub Release is published and has `pilotswarm-sdk-<version>.tgz`,
  `pilotswarm-horizon-store-<version>.tgz`, `pilotswarm-<version>.tgz`, checksums
  and `LICENSE`;
- subsequent Azure worker and portal deployment succeeds and portal health is
  verified against the intended private configuration.

If deployment fails after publication, retain the valid release and retry only
**Deploy Azure stamp** with `release_tag=v<version>`. Never retag or republish.
If a deployment-template/configuration fix is required, merge its validated PR
and use `reconcile_release_config=true` with that published tag. This uses current
main's deployment configuration without rebuilding/pushing the existing release
images. Record both configuration and release/image SHAs; verify the effective
portal policy, not only the protected input or pod readiness.
If publication stops after creating a tag/draft, inspect that unpublished state;
resolve it deliberately before rerunning. Never delete a published release to
work around a failed run. Report release and deployment status separately.

### Adding a missing notice to an existing release

Use **Add release license notice** (`release-notices.yml`) from main, with the
existing version. This separately approved, additive maintenance workflow only
uploads `LICENSE`; it never rebuilds packages, replaces checksums, changes tags
or deploys. It verifies all prior asset IDs, sizes and digests remain unchanged,
rejects a conflicting existing notice, and is idempotent for an identical one.
Use this for v0.6.0's omitted embedded notice; do not silently repack its assets.
Future tarballs must embed the notice as well as publishing the sidecar.

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
