# High-severity dependency remediation plan

Snapshot: 2026-09-20, source `7d03d22b50dddb0ec644f72fedfe7ca8c7609ada`.
GitHub reports **30 open high-severity Dependabot alerts across 13 packages**.
This is a remediation plan, not a claim of exploitation or completed upgrades.
Alert numbers below are Dependabot identifiers, not issue numbers.

Inventory source:
`gh api 'repos/microsoft/PilotSwarm/dependabot/alerts?state=open&severity=high&per_page=100'`.
Dependency paths were checked using `npm ls --all --package-lock-only --json`.
Refresh both before implementing: advisories and available fixed versions change.

## Fix batches

| Batch | Locked package and path | Minimum version addressing these high alerts | Dependabot alert IDs |
| --- | --- | --- | --- |
| 1: portal/MCP runtime | `fast-uri@3.1.2` via app -> MCP SDK -> `ajv` | `3.1.6`; evaluate the existing `3.1.8` dependency PR | 78, 77, 76, 54, 50, 48 |
| 1 | `ip-address@10.2.0` via app -> MCP SDK -> `express-rate-limit` | `10.3.1` | 57 |
| 1 | `hono@4.12.18` direct in app and via MCP SDK/`@hono/node-server` | `4.12.25`; evaluate the existing `4.13.5` dependency PR | 39 |
| 1 | `ws@8.19.0` direct in app and via Ink | `8.21.0` | 28 |
| 1 | `path-to-regexp@8.3.0` via app -> Express -> router | `8.4.0` | 5 |
| 2: telemetry runtime | `@opentelemetry/propagator-jaeger@2.7.1` via root `@opentelemetry/sdk-node` | `2.9.0` | 49 |
| 2 | `@grpc/grpc-js@1.14.3` via OpenTelemetry gRPC exporters | `1.14.4` | 26, 25 |
| 2 | `protobufjs@8.0.1` via OpenTelemetry transformer; `7.5.8` via gRPC proto-loader | **Both** `8.4.1` and `7.6.1`, on their respective major lines | 35, 34, 16, 14, 13, 12 |
| 3: build/test tooling | `vite@8.0.1` via Vitest, its mocker and plugin peers | `8.0.16` on the 8.x line; retain the app's intentional `vite@7.3.5` unless its own advisories require a separate change | 30, 8, 7 |
| 3 | `postcss@8.5.8` via both Vite lines | `8.5.18` | 52, 51 |
| 3 | `nanoid@3.3.11` via PostCSS | `3.3.18` on the 3.x line, not an unrelated major upgrade | 73, 70, 68 |
| 3 | `browserslist@4.28.2` via Babel/plugin-react | `4.28.7` | 72, 71 |
| 3 | `picomatch@4.0.3` via Vitest, tinyglobby and Vite/fdir | `4.0.4` | 3 |

Prefer compatible parent/dependency updates and lockfile regeneration over
permanent root overrides. Check parent ranges and peer requirements first.
Update the related OpenTelemetry packages as a compatible family; do not force
one protobuf major across both dependency paths. Preserve the aligned
`@github/copilot-sdk` and `@github/copilot` pins: these alerts do not justify an
unrelated Copilot upgrade.

A root override alone is insufficient for published packages: consumers do not
inherit this workspace's lockfile or its root overrides. For direct runtime
dependencies, raise the published manifest's minimum compatible version. For
transitives, prefer a parent release that requires a fixed version; inspect fresh
tarball-consumer resolutions as well as this workspace's dependency tree.

Keep each batch in a separate reviewable PR. Reconcile overlapping Dependabot
PRs rather than merging competing lockfile updates blindly. Do not dismiss an
alert merely because it is a development dependency: builds process source
files and dev servers can be exposed accidentally.

## Validation and release gates

1. Capture the starting alert list and dependency tree; select available fixed
   versions meeting every applicable advisory, including newly published ones.
2. Regenerate the lockfile without unrelated major bumps. Run `npm ci` and the
   workspace build. Check all duplicate/nested entries, not just hoisted modules.
3. Batch 1: run SDK API/unit tests and the app's TUI, Web API, shared UI and MCP
   suites, including authentication, transport, URL/import guards and WebSocket
   behavior. Do not infer exploitability solely from an advisory's title.
4. Batch 2: exercise telemetry registration and shutdown with local OTLP
   receivers for the configured transports; run SDK unit tests and a local
   PostgreSQL smoke. Keep telemetry opt-in and preserve provider boundaries.
5. Batch 3: build the browser bundle and run application tests, real Vitest
   qualification fixtures under `.github/scripts/integration/`, and the normal
   provider test harness. Retain all eight-worker defaults and assertions.
6. Pack all three packages; check license contents and perform fresh consumer
   installs without the monorepo root overrides. Verify the relevant runtime
   dependencies resolve to fixed versions there too.
7. Requery Dependabot after each merge and use the registry advisory report to
   confirm coverage. A pending GitHub rescan is not proof that a dependency
   remains vulnerable; retain the resolved-version evidence.
8. Before a new release, run the unchanged complete PostgreSQL plus real HDB
   qualification gate. The existing bounded sequential policy still applies.
   Plan execution does not authorize publication or deployment.

## Complete high-advisory ledger

| Alert | Package | Advisory |
| --- | --- | --- |
| 78 | fast-uri | [Malformed IPv6 normalization](https://github.com/advisories/GHSA-f65p-4m7j-42xc) |
| 77 | fast-uri | [Repeated hostname percent-decoding](https://github.com/advisories/GHSA-fph4-wmhf-6fwf) |
| 76 | fast-uri | [Percent-encoded scheme normalization](https://github.com/advisories/GHSA-jqff-g426-hqxp) |
| 73 | nanoid | [Integer overflow/wraparound](https://github.com/advisories/GHSA-xwg4-73v4-xw9w) |
| 72 | browserslist | [Unbounded result-cache growth](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) |
| 71 | browserslist | [Untrusted custom statistics](https://github.com/advisories/GHSA-73wf-gq98-2v4g) |
| 70 | nanoid | [Zero-size custom generator loop](https://github.com/advisories/GHSA-2v37-7h3g-55p8) |
| 68 | nanoid | [Negative-size non-secure generator loop](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) |
| 57 | ip-address | [Leading-zero IPv4 interpretation](https://github.com/advisories/GHSA-mwp4-54f8-5fhr) |
| 54 | fast-uri | [Backslash authority introducer](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) |
| 52 | postcss | [Previous source-map path traversal](https://github.com/advisories/GHSA-r28c-9q8g-f849) |
| 51 | postcss | [Source-map arbitrary file read](https://github.com/advisories/GHSA-6g55-p6wh-862q) |
| 50 | fast-uri | [Backslash authority delimiter](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) |
| 49 | @opentelemetry/propagator-jaeger | [Malformed-header exception](https://github.com/advisories/GHSA-45rx-2jwx-cxfr) |
| 48 | fast-uri | [Failed IDN canonicalization](https://github.com/advisories/GHSA-4c8g-83qw-93j6) |
| 39 | hono | [Credentialed wildcard CORS](https://github.com/advisories/GHSA-88fw-hqm2-52qc) |
| 35 | protobufjs 8.x | [Unbounded Any expansion](https://github.com/advisories/GHSA-wcpc-wj8m-hjx6) |
| 34 | protobufjs 7.x | [Unbounded Any expansion](https://github.com/advisories/GHSA-wcpc-wj8m-hjx6) |
| 30 | vite | [Windows alternate-path fs.deny bypass](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) |
| 28 | ws | [Small-fragment memory exhaustion](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) |
| 26 | @grpc/grpc-js | [Malformed-request crash](https://github.com/advisories/GHSA-5375-pq7m-f5r2) |
| 25 | @grpc/grpc-js | [Malformed compressed-message crash](https://github.com/advisories/GHSA-99f4-grh7-6pcq) |
| 16 | protobufjs | [Generated bytes-default code injection](https://github.com/advisories/GHSA-66ff-xgx4-vchm) |
| 14 | protobufjs | [Code-generation gadget after prototype pollution](https://github.com/advisories/GHSA-75px-5xx7-5xc7) |
| 13 | protobufjs | [Unsafe option-path denial of service](https://github.com/advisories/GHSA-jvwf-75h9-cwgg) |
| 12 | protobufjs | [Unbounded protobuf recursion](https://github.com/advisories/GHSA-685m-2w69-288q) |
| 8 | vite | [Query-based fs.deny bypass](https://github.com/advisories/GHSA-v2wj-q39q-566r) |
| 7 | vite | [Dev-server WebSocket file read](https://github.com/advisories/GHSA-p9ff-h696-f583) |
| 5 | path-to-regexp | [Sequential optional-group denial of service](https://github.com/advisories/GHSA-j3q9-mxjg-w52f) |
| 3 | picomatch | [Extglob-quantifier ReDoS](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj) |
