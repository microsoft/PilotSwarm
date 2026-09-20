# Install release packages

PilotSwarm is an open-source project distributed through public
[GitHub Releases](https://github.com/microsoft/PilotSwarm/releases). The three
npm-format tarballs are `pilotswarm-sdk`, `pilotswarm-horizon-store` and
`pilotswarm` (TUI, portal and MCP). Microsoft does not publish these releases to
the npm registry. Node.js 24 or later is required.

## Download and verify

Choose a published version. The following example downloads v0.6.0 without a
GitHub account or token:

```bash
VERSION=0.6.0
mkdir -p dist-tarballs
for file in "pilotswarm-sdk-$VERSION.tgz" \
            "pilotswarm-horizon-store-$VERSION.tgz" \
            "pilotswarm-$VERSION.tgz" SHA256SUMS LICENSE; do
  curl --fail --location \
    "https://github.com/microsoft/PilotSwarm/releases/download/v$VERSION/$file" \
    --output "dist-tarballs/$file" || exit 1
done
(cd dist-tarballs && shasum -a 256 -c SHA256SUMS)
```

Stop if a download or checksum check fails. On systems without `shasum`, use
`sha256sum -c SHA256SUMS`. The release also provides `LICENSE`, containing both
the copyright and permission notices. Preserve it when redistributing packages.
Releases produced by the current packaging tooling embed that same file in
each tarball; v0.6.0 has a supplemental release notice without repacked tarballs.

An authenticated GitHub CLI is another download option:
`gh release download v0.6.0 --repo microsoft/PilotSwarm --pattern '*.tgz' --pattern SHA256SUMS --dir dist-tarballs`.
Authentication is a CLI choice, not a requirement to read the public release.

## Install into an application

Install the matching files together so internal PilotSwarm dependencies resolve
locally rather than against an unrelated registry publication:

```bash
npm install --save-exact ./dist-tarballs/pilotswarm-sdk-0.6.0.tgz \
  ./dist-tarballs/pilotswarm-horizon-store-0.6.0.tgz \
  ./dist-tarballs/pilotswarm-0.6.0.tgz
```

SDK-only applications can install just the SDK tarball. Add the matching
Horizon-store tarball when using its optional providers. npm still resolves
third-party dependencies through the application's configured registry.

Commit the application manifest and lockfile. If `dist-tarballs/` is ignored,
restore and verify the same release files at those relative paths before
`npm ci`, including in CI and Docker build contexts. Do not silently replace
bytes under an existing version or substitute a sibling source checkout.

Use the installed binaries without triggering registry downloads:

```bash
./node_modules/.bin/pilotswarm remote --api-url https://portal.example.com
./node_modules/.bin/pilotswarm-mcp --api-url https://portal.example.com
```

## Global CLI installation

Add `-g` to the three-file install command above, then use `pilotswarm`,
`pilotswarm-web` and `pilotswarm-mcp` from your PATH. For a checkout-based helper:

```bash
scripts/install-from-release.sh 0.6.0
```

The helper supports anonymous public downloads, `--prefix`, `--registry`,
`--keep` and `--dry-run`. A GitHub/model credential may still be needed to run
agents, and a deployed portal may require sign-in; neither is source-download
authorization.
