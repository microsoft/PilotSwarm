# Azure runner

A Linux machine in Azure that runs this repository's GitHub Actions jobs that
need Azure: deployment, release, live HorizonDB tests and CI database
provisioning. These jobs sign in to Azure as the machine's managed identity. No
job trades a GitHub token for an Azure sign-in.

[CI topology](../../../../../.github/CI-TOPOLOGY.md) draws the whole setup with
its identities and permissions.

## How a job reaches the machine

```text
1. A workflow job says  runs-on: ${{ vars.PROVIDER_TEST_RUNNER }}
2. A reviewer approves the protected `azure-deploy` environment
3. The runner program on the machine asks GitHub for jobs with its label
   (outbound HTTPS only: the machine accepts no inbound connection)
4. Before the job, the job hook checks that the job comes from an accepted
   workflow file on `main`. Otherwise it stops the job
5. `azure/login` with `auth-type: IDENTITY` signs in as the machine's identity
6. After the job, the hook removes sign-ins, the checkout, temporary files
   and Docker state
```

GitHub never calls the machine. A job waits in the queue until the runner
program asks for it. One job runs at a time.

## Files

| File | What it does |
| --- | --- |
| `main.bicep` | The machine: isolated network, fixed outbound address, no inbound access, system-assigned managed identity |
| `setup.sh` | Runs on the machine as root: tools, the runner program (pinned and checksummed), the registration, the job hook and a service that starts at boot |
| `job-hook.sh` | Runs before and after every job: accepts or refuses the job, waits for an OS update that is being installed, then cleans up |
| `maintenance.sh` | Runs every 15 minutes: installs OS updates and reboots for them, only while no job runs |
| `roles.bicep`, `roles-horizondb.bicep` | What the machine's identity may do in Azure, as code |
| `manage.mjs` | Operator tool: `setup`, `grant`, `start`, `deallocate`, `status` |

## Set up

You need an Azure CLI sign-in with rights to create the machine and to assign
roles in its resource group, and a repository administrator for one
registration token. A workflow cannot do this: a GitHub-hosted job has no
Azure sign-in.

1. Describe the runner. Keep the real values out of tracked files.

   ```bash
   export AZURE_CI_RUNNER_JSON='{"subscription":"<subscription-id>","resourceGroup":"<resource-group>","location":"<region>","name":"example-ci-runner","label":"ci-example","vmSize":"Standard_D8s_v5","repository":"<owner>/<repo>"}'
   ```

   Use the region of the dedicated CI database. Tests make many short database
   calls, and distance makes them time out.

2. As a repository administrator, create a registration token. It is valid for
   one hour and is used once.

   ```bash
   export CI_RUNNER_REGISTRATION_TOKEN="$(gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token)"
   ```

3. Create and prepare the machine.

   ```bash
   node deploy/providers/azure/ci/runner/manage.mjs setup
   ```

   This creates the machine when it does not exist, starts it and runs
   `setup.sh` through Azure Run Command. The token travels as a protected
   parameter and is not stored. Set `CI_RUNNER_START=false` to install
   everything without starting the runner service.

4. Give the machine's identity its rights. A new identity can sign in, but it
   may do nothing.

   ```bash
   node deploy/providers/azure/ci/runner/manage.mjs grant
   ```

   This applies `roles.bicep`. You need the right to assign roles on the
   stamp's resource group and, for HorizonDB, on the subscription. Running it
   again changes nothing. Add `"horizonDb": false` to `AZURE_CI_RUNNER_JSON`
   when the stamp does not use HorizonDB.

   Then set the environment secret `AZURE_DEPLOY_PRINCIPAL_OBJECT_ID` to the
   object ID that the command prints. The stamp's Bicep gives that identity
   its other roles. Run **Deploy Azure stamp** once before the first live test
   run, so that they exist. Do not create them by hand: a second grant of the
   same role fails the deployment with `RoleAssignmentExists`.

   | The identity may… | On what | Granted by |
   | --- | --- | --- |
   | Create and change resources (Contributor) | The stamp's resource group | `manage.mjs grant` |
   | Hand out roles (Role Based Access Control Administrator) | The stamp's resource group | `manage.mjs grant` |
   | Read (Reader) | The HorizonDB location of the subscription | `manage.mjs grant` |
   | Push images (AcrPush) | The container registry | The stamp's Bicep |
   | Read and write secrets (Key Vault Secrets Officer) | The Key Vault | The stamp's Bicep |
   | Read and write blobs (Storage Blob Data Contributor) | The storage account | The stamp's Bicep |
   | Administer the cluster (Azure Kubernetes Service RBAC Cluster Admin) | The AKS cluster, when `AKS_ENTRA_ID_AUTH=true` | The stamp's Bicep |

   If the machine is deleted and created again, its identity is new and has
   none of these. Run `grant` again and update the secret.

5. Set the repository Actions variable `PROVIDER_TEST_RUNNER` to the runner's
   label. Use a repository variable. Environment variables arrive after GitHub
   has picked the runner.

6. Keep the repository setting that requires approval before workflows from
   outside contributors run.

Run step 3 again, without a token, to update the tools or the job hook. It
keeps the registration.

The dev release workflow also needs this refresh after it lands on main:
`setup.sh` admits `release-dev.yml` alongside `release-tarballs.yml`. Both call
`release-common.yml`; the job hook checks the dispatch caller's
`GITHUB_WORKFLOW_REF`, not the reusable workflow file. Do not admit branch
workflow refs or the reusable workflow as an independent entrypoint.

## Day to day

- **Power.** The machine stays on. `manage.mjs deallocate` stops compute
  billing; disk and outbound address remain. While it is off, Azure jobs wait
  in the queue, for up to 24 hours. `manage.mjs start` brings it back, and the
  runner service starts at boot.
- **Registration.** GitHub removes a runner that has not connected for 14
  days. After that, run the setup again with a new token.
- **OS updates.** The machine is not rebuilt between jobs, so it patches
  itself. Left alone, Ubuntu's daily update restarts the services that use an
  upgraded library, the runner among them, and that cuts a running job. The
  setup prevents this:

  ```text
  1. The updater never restarts the runner, Docker or containerd
  2. The daily update is skipped while a job runs, and installed later
     when the runner is idle
  3. A job that arrives while an update is being installed waits for it
  4. A reboot that the updates need happens only while the runner is idle
  ```
- **Updates.** The runner program updates itself. The pinned version in
  `setup.sh` is used only for a new registration.
- **Accepted workflows.** `setup.sh` lists them. A new workflow that signs in
  to Azure must be added there, and the setup run again. A policy test fails
  until the list matches.

## What protects the identity

Any job that runs on the machine can use the identity's rights. Three things
limit which jobs run:

```text
1. Only people with write access can start the protected workflows
2. A reviewer approves each run of the `azure-deploy` environment
3. The job hook refuses a job whose workflow file is not on the accepted
   list, or is not from `main`. It stops the job's worker process, so no
   step of that job runs, including steps marked `if: always()`
```

The third point matters because the approval protects the environment's
secrets, not the machine. Without the hook, a workflow file on a branch could
ask for this runner and skip the approval.

## Limits

- The machine is not rebuilt between jobs. The hook removes sign-ins, the
  checkout, the runner account's temporary files and every container. It
  cannot undo what a job changes elsewhere.
- A job that is cut off (the machine stops, or someone restarts the runner
  service) runs no cleanup of its own. The next job's hook removes what it
  left, such as a service container that still holds a port.
- The runner's account has `sudo` and Docker. A job that is allowed to run can
  change the machine, including the hook.
- So approving a **Tests** run of a pull request with live HorizonDB coverage,
  or a **Create dev release** of that PR's exact branch head,
  trusts that code with the machine and its identity, also for later jobs.
  Review the commit first. To return to a known state, delete the machine and
  run the setup again.
- Dev approval also authorizes public prerelease publication. Review the
  selected commit/compare/PR links before approving; an open PR alone does not
  establish review. Stable release execution keeps its existing VM write token
  and one approval; dev publication uses a separate hosted write-token job.
- Use this runner only for the protected workflows on `main`. Pull request
  checks stay on GitHub-hosted runners.

References: [self-hosted runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners),
[scripts before and after a job](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts),
[Azure protected Run Command parameters](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/run-command-managed).
