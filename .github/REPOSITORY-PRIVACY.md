# Repository privacy

Keep current tracked files useful for people deploying their own environments:
architecture, generic resource/secret names, configuration schemas, workflow
examples and public Azure service/role identifiers are welcome. Use placeholders
for real subscription/tenant/application IDs, resource names, endpoints and
credentials. Private files belong in ignored local directories, GitHub secrets
or Key Vault.

## Automated PR check

`npm run check:privacy` runs without credentials or external services. It scans
all **indexed tracked files**, matching what a commit contains. It runs in
**PR checks / Basic checks**, including fork PRs, before dependency installation.
Stage edited/new files before checking locally.

It flags concrete Azure resource hostnames, Azure identity literals in configuration
contexts, literal resource IDs, common credential token/private-key/storage-key/SAS
patterns, literal deployment settings and accidentally tracked private config.
Diagnostics contain only the file, line and rule, never the matched value.

`scripts/repository-privacy-policy.json` documents synthetic hosts used in tests
and public Azure DNS zones and Microsoft application IDs. Entries must be examples or public service
identifiers, never exceptions for a live deployment. Prefer `example.invalid`,
`<your-resource>`, variable references, or an existing allowed synthetic endpoint.

This is a targeted text guard, not an exhaustive secret scanner or a substitute
for review. Binary content is not inspected. Split/encoded values, arbitrary
credentials and identifiers outside recognized contexts need human review and
GitHub secret scanning/push protection where available. Do not weaken the check
or add inline bypasses to pass a PR containing private configuration.

## History

The index check does not scan Git history. Do not publish private deployment
identifiers, session databases/logs or credentials through archived branches,
tags or old commits. Keep source provenance in `docs/migration/README.md`
without restoring imported history as public archive refs. Removing a value
from today's files does not erase old commits. A history rewrite requires an
explicitly authorized ref plan, a private recovery backup, release provenance
handling, and GitHub Support review where PR refs/cached objects retain content.
Actions logs also become public with repository visibility; review retained
runs separately. Never assume a resource or identity is obsolete because the
document is old.

For deployment routing and local test setup, see [deployment operations](DEPLOYMENT.md)
and [local CI and tests](../docs/developer/contributing/local-ci-and-tests.md).
