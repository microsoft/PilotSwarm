---
name: azure-ps-test-runner-vm
description: Create a throwaway Azure VM next to the HorizonDB server and run the full `./scripts/run-tests.sh --all-providers` suite on it, with credentials copied for one run only. Use when HorizonDB tests time out from a laptop far from the server, when GitHub runners are slow or unavailable, or when asked to set up, use or tear down a PilotSwarm test runner VM.
---

# Azure test runner VM

A plain Ubuntu VM in the same Azure region as the HorizonDB server. It runs
the full all-providers suite from a clone of the repo. It is not a GitHub
Actions runner; for that, see the `Manage Azure CI runner` workflow and
`deploy/providers/azure/ci/runner/README.md`.

## Why

The HorizonDB phase makes many short database calls in a row. Distance
decides whether it passes:

| Where the tests run | One `SELECT 1` | Result |
|---|---|---|
| A laptop on another continent | 130–160 ms | Most HorizonDB SDK tests hit their time limits |
| A VM in the server's region | 0–1 ms | The full suite passes |

Measure it first (step 6) when in doubt.

## What you need

- Azure CLI signed in, with rights to create a resource group and a VM.
- The repo's local test config files: `.env`, `.env.horizondb` and
  `.model_providers.json`. They hold credentials (a GitHub token, model keys,
  the HorizonDB connection). See "Credentials" below before copying them.

Set these once in your shell. Use your own values:

```bash
SUB=<subscription-id>
RG=<resource-group>            # a new, dedicated group, e.g. pilotswarm-testrunner-rg
VM=<vm-name>                   # e.g. ps-testrunner
LOC=<horizondb-region>         # the region of your HorizonDB server
KEY=~/.ssh/id_ed25519_ps_testrunner
MYIP=$(curl -s https://api.ipify.org)
```

## 1. SSH key and setup script

```bash
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C 'pilotswarm test runner' -f "$KEY"

cat > cloud-init.yaml <<'EOF'
#cloud-config
package_update: true
packages: [git, build-essential, python3, jq, ca-certificates, curl, docker.io, unzip]
runcmd:
  - curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  - apt-get install -y nodejs
  - usermod -aG docker azureuser
  - systemctl enable --now docker
EOF
```

## 2. Create the VM

Use 8 cores. The suite runs 8 test files at once, each with its own workers,
plus PostgreSQL in Docker. On 4 cores the tests compete for CPU and hit their
time limits.

```bash
az group create --subscription "$SUB" -n "$RG" -l "$LOC" -o none
az vm create --subscription "$SUB" -g "$RG" -n "$VM" \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --size Standard_D8s_v5 --os-disk-size-gb 128 --storage-sku Premium_LRS \
  --admin-username azureuser --ssh-key-values "$KEY.pub" --authentication-type ssh \
  --public-ip-sku Standard --nsg-rule NONE --custom-data cloud-init.yaml \
  --query publicIpAddress -o tsv
```

Write down the IP it prints.

## 3. SSH from your IP only, and a nightly shutdown

```bash
NSG=$(az network nsg list --subscription "$SUB" -g "$RG" --query '[0].name' -o tsv)
az network nsg rule create --subscription "$SUB" -g "$RG" --nsg-name "$NSG" \
  -n ssh-from-me --priority 1000 --direction Inbound --access Allow --protocol Tcp \
  --source-address-prefixes "$MYIP/32" --destination-port-ranges 22 -o none
az vm auto-shutdown --subscription "$SUB" -g "$RG" -n "$VM" --time 0200 -o none   # UTC
```

Add an alias to `~/.ssh/config`:

```
Host ps-testrunner
    HostName <vm-ip>
    User azureuser
    IdentityFile ~/.ssh/id_ed25519_ps_testrunner
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
    ServerAliveInterval 30
```

Then wait for the setup script: `ssh ps-testrunner 'cloud-init status --wait; node --version; docker --version'`.

**If SSH times out** while the VM runs, check the security rules:
`az network nsg rule list -g "$RG" --nsg-name "$NSG" -o table`. Some
organizations add their own deny rule for port 22 from the internet, with a
higher priority than yours. Do not edit those rules. Connect from the network
they allow, or drive the VM with Run Command (see "Without SSH").

## 4. The repo

```bash
ssh ps-testrunner 'git clone -q https://github.com/microsoft/PilotSwarm.git pilotswarm
  cd pilotswarm && git checkout -q -B <branch> origin/<branch> && npm ci --no-audit --no-fund'
```

To test another commit later: `git fetch origin <branch> && git checkout -B <branch> origin/<branch> && npm ci`.

## 5. PostgreSQL

The container's password must match `DATABASE_URL` in the `.env` you copy.
`run-tests.sh` refuses to run with fewer than 1500 connections.

```bash
ssh ps-testrunner 'docker run -d --name pilotswarm-pg --restart unless-stopped \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=<password-from-DATABASE_URL> \
    -e POSTGRES_DB=pilotswarm -p 127.0.0.1:5432:5432 postgres:16 \
  && sleep 5 \
  && docker exec pilotswarm-pg psql -U postgres -qc "ALTER SYSTEM SET max_connections = 1500;" \
  && docker restart pilotswarm-pg'
```

## 6. Credentials: copy for one run, delete after

The three config files hold real credentials. Keep them on the VM only while a
run needs them:

1. Copy them right before the run.
2. In the same step, start a watcher that deletes them when the run ends.
3. Never leave them between runs. Ask the person before copying them to a
   machine that did not hold them before.

**With SSH:**

```bash
scp .env .env.horizondb .model_providers.json ps-testrunner:pilotswarm/
ssh ps-testrunner 'cd pilotswarm && chmod 600 .env .env.horizondb .model_providers.json
  grep -q "^HORIZON_DATABASE_URL=." .env.horizondb && echo "hdb config: ok"'
```

Check the HorizonDB latency once:

```bash
ssh ps-testrunner 'cd pilotswarm && node --env-file=.env.horizondb -e "
const pg = require(\"pg\");
(async () => {
  const u = new URL(process.env.HORIZON_DATABASE_URL);
  u.searchParams.delete(\"sslmode\"); u.searchParams.delete(\"uselibpqcompat\");
  const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const t = []; for (let i = 0; i < 5; i++) { const s = Date.now(); await c.query(\"SELECT 1\"); t.push(Date.now() - s); }
  console.log(\"SELECT 1 ms:\", t.join(\", \")); await c.end();
})().catch((e) => console.log(\"error:\", e.code || e.message));"'
```

## 7. Run the suite

Start it detached, so it keeps going when your laptop sleeps. Then start the
watcher that deletes the credentials when the run ends.
`PS_TEST_SKIP_STALE_CLEANUP=1` skips the global sweep of old test schemas, so
the run cannot drop schemas another run on the same HorizonDB still uses.

```bash
ssh ps-testrunner 'cd pilotswarm
  PS_TEST_SKIP_STALE_CLEANUP=1 setsid nohup bash -c "./scripts/run-tests.sh --all-providers > ~/all-providers.log 2>&1; echo EXIT=\$? >> ~/all-providers.log" > /dev/null 2>&1 < /dev/null &
  sleep 3
  setsid nohup bash -c "while pgrep -f \"[r]un-tests.sh --all-providers\" > /dev/null; do sleep 30; done; shred -u ~/pilotswarm/.env ~/pilotswarm/.env.horizondb ~/pilotswarm/.model_providers.json; echo \"credentials removed \$(date -u)\" >> ~/secrets-cleanup.log" > /dev/null 2>&1 < /dev/null &
  echo started'
```

Progress and result:

```bash
ssh ps-testrunner 'sed "s/\x1b\[[0-9;]*m//g" ~/all-providers.log | grep -aE "Provider phase|Test Files|Tests  |Combined provider result|EXIT="'
```

A full run takes about 35–40 minutes: the stock PostgreSQL pass (about 22),
then the HorizonDB phase. To run only some files on HorizonDB:
`./scripts/run-tests.sh --with-horizondb --suite=<name> --suite=<name>`.

## Without SSH: Run Command

Use `az vm run-command invoke` for commands that carry no secret (status,
logs, pkill). It returns the output, but Azure keeps the script, so **never
put credentials in it**.

To copy the credential files, use Run Command v2 with protected parameters.
Azure stores them encrypted and never returns them:

```bash
az vm run-command create --subscription "$SUB" -g "$RG" --vm-name "$VM" \
  --name copy-and-run-$(date +%H%M%S) --location "$LOC" --timeout-in-seconds 600 \
  --script "$(cat vm-run.sh)" \
  --protected-parameters "PSENV=$(base64 < .env | tr -d '\n')" \
                         "PSHDB=$(base64 < .env.horizondb | tr -d '\n')" \
                         "PSMP=$(base64 < .model_providers.json | tr -d '\n')"
az vm run-command delete --subscription "$SUB" -g "$RG" --vm-name "$VM" --name <that-name> --yes
```

- Do **not** pass `--run-as-user`: with it, the parameters do not reach the
  script. Run as root, and inside the script write the files, then
  `chown azureuser:azureuser` and `chmod 600` them.
- The parameters arrive as environment variables: `printf '%s' "$PSENV" | base64 -d > .env`.
- Start the run as the user: `sudo -u azureuser -H setsid nohup <script> &`.
- Delete the run command afterwards.

## Gotchas

- **`pkill -f run-tests.sh` over SSH kills your own SSH command,** whose text
  contains the pattern. Use `pkill -f "[r]un-tests.sh"`.
- **zsh reads `$name:a` as a path modifier.** `"image-$svc:tag"` becomes a
  file path. Write `"image-${svc}:tag"`.
- **Two HorizonDB tests sit close to their 60 s limit:** the first test of
  `delete-cascade` and of `pg-migrator` sets up a fresh schema (about 55 s).
  Under the full parallel load they can time out. Re-run them alone with
  `--with-horizondb --suite=delete-cascade --suite=pg-migrator` before calling
  it a failure.
- **Which keys the run uses:**
  - Model calls go through the test catalog
    (`packages/sdk/test/fixtures/model-providers.test.json`), that is GitHub
    Copilot with `GITHUB_TOKEN`.
  - The HorizonDB phase also calls the embedding endpoint set by the
    `HORIZON_EMBED_*` values in `.env.horizondb`.
- **A test that prints a database URL must hide the password.**
  `packages/sdk/test/helpers/local-env.js` does; keep it that way, because
  the run log stays on the VM.

## Tear down

```bash
az group delete --subscription "$SUB" -n "$RG" --yes --no-wait
```

This deletes the VM, its disk, IP and network, and any credentials still on
it. Remove the SSH alias and key if you will not create the VM again.
