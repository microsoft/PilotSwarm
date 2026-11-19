# PSE Decision 1.1 test environment scripts

This directory freezes the local command contract for the `pse-decision11-test` environment. `config.json` is a checked-in policy template; private subscription IDs, Azure resource IDs, owner attribution, image hosts, and ledger UIDs must come from a caller-supplied reviewed bindings receipt. Do not track that receipt. Receipts contain references and digests, never credentials, key bytes, SAS values, raw tokens, or connection strings.

The five wrappers are thin entry points to the stdlib-only `decision11.mjs` driver. They use no shell command construction. Every command requires `--bindings-receipt <path>`, and the driver verifies its canonical binding digest against the checked-in pin. A runner and synthetic bindings can be injected by unit tests; the default runner executes reviewed CLI operations or uses Node's fetch implementation for application HTTP.

## Safety gates

Every mutating command refuses at or after `2026-11-22T04:12:38.699Z`, five minutes before the absolute expiry `2026-11-22T04:17:38.699Z`. No command can extend that time.

`setup` accepts only:

- the exact frozen-plan, cost, create-approval, and VPN-approval receipt identifiers;
- the exact target and a caller-supplied full reviewed source SHA;
- digest-pinned reviewed image receipts;
- exact operation, generation, epoch, target, lease and ledger receipts;
- exact CA, client URI SAN, server DNS SAN, and named Secret references with no material bytes;
- caller-supplied reviewed manifest files whose hashes match the reviewed-manifest receipt.

Immediately before apply, `setup` re-reads the configured T3 effective outbound public-IP identity, the public-IP address, and the outbound load-balancer rule. It refuses source drift from `4.148.50.242/32`. It never creates an unreviewed manifest or falls back to another target, region, SKU, source, or network range.

`reset` calls the reviewed application API once for each of the six fixed synthetic prefixes. It never selects a namespace or database for deletion.

`verify` performs only `show`, `list`, `get`, and application GET requests. It verifies the Azure expiry tags, non-zonal two-node AKS shape, network policy and exact source rule, origin mTLS metadata, all three negative-proof receipts, portal health, Foundry deployment, digest-pinned images, database, storage, and leases.

`smoke` requires a real `live-decision` response for choice, noul, score, uncertain, and recovery/replay. It also requires the `WORKFLOW_DECISION_MODEL_UNAVAILABLE` diagnostic with no billable call. Evidence stores only a truncated SHA-256 identifier for each synthetic session.

`teardown` accepts an exact confirmation string and a reviewed exact-asset list. It re-reads every Kubernetes UID or Azure canonical UID before closing the named workloads and deleting only listed assets. The command never deletes a namespace or resource group blindly.

## Commands

```sh
deploy/environments/pse-decision11-test/setup.sh \
  --bindings-receipt <path>/bindings-receipt.json \
  --target-id ai-ops-independent-tests \
  --head <reviewed-full-sha> \
  --plan-receipt <path>/plan-receipt.json \
  --cost-receipt <path>/cost-receipt.json \
  --approval-receipt <path>/approval-receipt.json \
  --source-receipt <path>/source-receipt.json \
  --image-receipt <path>/image-receipt.json \
  --trust-receipt <path>/trust-receipt.json \
  --lease-receipt <path>/lease-receipt.json \
  --ledger-receipt <path>/ledger-receipt.json \
  --manifest-receipt <path>/manifest-receipt.json \
  --evidence-out <path>/setup-evidence.json
```

```sh
deploy/environments/pse-decision11-test/reset.sh \
  --bindings-receipt <path>/bindings-receipt.json \
  --reset-receipt <path>/reset-receipt.json \
  --evidence-out <path>/reset-evidence.json
```

```sh
deploy/environments/pse-decision11-test/verify.sh \
  --bindings-receipt <path>/bindings-receipt.json \
  --verify-receipt <path>/verify-receipt.json \
  --head <deployed-full-sha> \
  --evidence-out <path>/verify-evidence.json
```

```sh
deploy/environments/pse-decision11-test/smoke.sh \
  --bindings-receipt <path>/bindings-receipt.json \
  --smoke-receipt <path>/smoke-receipt.json \
  --evidence-out <path>/smoke-evidence.json
```

```sh
deploy/environments/pse-decision11-test/teardown.sh \
  --bindings-receipt <path>/bindings-receipt.json \
  --teardown-receipt <path>/teardown-receipt.json \
  --asset-confirmation '<exact generated confirmation>' \
  --evidence-out <path>/teardown-evidence.json
```

The application API operations name `DECISION11_TEST_API_TOKEN`. Supply its value only through the invoking process environment; do not add it to a receipt, command line, file, fact, or evidence document. The driver sends it in memory and omits it from evidence.

## Test

From the repository root:

```sh
node --test deploy/scripts/test/decision11-environment.test.mjs
```

The unit suite uses fake runners and does not contact Azure, Kubernetes, Foundry, storage, PostgreSQL, or a live portal.
