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
6. After the job, the hook removes sign-ins, the checkout and Docker state
```

GitHub never calls the machine. A job waits in the queue until the runner
program asks for it. One job runs at a time.

## Files

| File | What it does |
| --- | --- |
| `main.bicep` | The machine: isolated network, fixed outbound address, no inbound access, system-assigned managed identity |
| `setup.sh` | Runs on the machine as root: tools, the runner program (pinned and checksummed), the registration, the job hook and a service that starts at boot |
| `job-hook.sh` | Runs before and after every job: accepts or refuses the job, then cleans up |
| `manage.mjs` | Operator tool: `setup`, `start`, `deallocate`, `status` |

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

4. Give the machine's identity its rights. `manage.mjs status` prints the
   identity's object ID.

   - Assign **Contributor** and **Role Based Access Control Administrator** on
     the stamp's resource group.
   - Assign **Reader** on
     `/subscriptions/<subscription-id>/providers/Microsoft.HorizonDb/locations/<region>`.
   - Set the environment secret `AZURE_DEPLOY_PRINCIPAL_OBJECT_ID` to the
     object ID. The stamp's Bicep then assigns **AcrPush**, **Key Vault Secrets
     Officer** and **Storage Blob Data Contributor** on the stamp's resources.
   - Run **Deploy Azure stamp** once before the first live test run, so that
     these three roles exist. Do not create them by hand: a second assignment
     of the same role fails the deployment with `RoleAssignmentExists`.

5. Set the repository Actions variable `PROVIDER_TEST_RUNNER` to the runner's
   label. Use a repository variable. Environment variables arrive after GitHub
   has picked the runner.

6. Keep the repository setting that requires approval before workflows from
   outside contributors run.

Run step 3 again, without a token, to update the tools or the job hook. It
keeps the registration.

## Day to day

- **Power.** The machine stays on. `manage.mjs deallocate` stops compute
  billing; disk and outbound address remain. While it is off, Azure jobs wait
  in the queue, for up to 24 hours. `manage.mjs start` brings it back, and the
  runner service starts at boot.
- **Registration.** GitHub removes a runner that has not connected for 14
  days. After that, run the setup again with a new token.
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
  checkout and Docker state. It cannot undo what a job changes elsewhere.
- The runner's account has `sudo` and Docker. A job that is allowed to run can
  change the machine, including the hook.
- So approving a **Tests** run of a pull request with live HorizonDB coverage
  trusts that code with the machine and its identity, also for later jobs.
  Review the commit first. To return to a known state, delete the machine and
  run the setup again.
- Use this runner only for the protected workflows on `main`. Pull request
  checks stay on GitHub-hosted runners.

References: [self-hosted runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners),
[scripts before and after a job](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts),
[Azure protected Run Command parameters](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/run-command-managed).
