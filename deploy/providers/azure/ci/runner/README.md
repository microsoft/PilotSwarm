# Dedicated CI runner

`Manage Azure CI runner` provisions a Linux VM through Bicep in the dedicated CI
database's region. It uses an isolated network, explicit outbound IP, no inbound
access, no managed identity, and a checksummed GitHub runner package. Jobs use
their normal protected-environment OIDC access. Application resources are not
modified. Azure network infrastructure remains inside this provider directory.

## Configuration

Set protected environment secret `AZURE_CI_RUNNER_JSON`:

```json
{"name":"example-ci-runner","label":"ci-example","vmSize":"Standard_D8s_v5"}
```

The subscription, resource group and region derive from `AZURE_CI_DATABASE_JSON`.
Actual values stay in secrets/ignored local configuration. Set repository Actions
variable `PROVIDER_TEST_RUNNER` to the matching label. Linux Docker service
containers, Azure CLI, GitHub CLI and build tools are installed on the VM.

Before each registration, a repository administrator obtains a short-lived token
using `POST /repos/{owner}/{repo}/actions/runners/registration-token` and stores
only that token in environment secret `CI_RUNNER_REGISTRATION_TOKEN`. Do not
store the administrator's personal access token. Registration tokens expire
after one hour, so generate one immediately before dispatch/approval.

1. Run `provision-ci-runner.yml` with `operation=register` from `main` and approve
   the protected environment. This creates or starts the dedicated VM.
2. Verify the repository runner is online, then dispatch the provider test or
   release workflow. This registration handles **exactly one job**.
3. The runner unregisters after the job and removes its checkout and CLI state.
   Register again with a fresh token before another job; the Action refuses to
   replace an active listener. Registration clears old runner and Docker state.
4. When finished, run the management Action with `operation=deallocate`. Compute
   billing stops; disk and outbound address remain. No token is needed to stop.

Management shares the provider database concurrency group, preventing shutdown
or registration while a protected provider/release job is running. Dispatch
registration before queueing its consumer: a queued consumer otherwise holds the
concurrency slot needed to start its runner. This is operator-managed one-job
registration, not an automatic runner autoscaler. Future automated registration
should use a narrowly scoped GitHub App, not a broad personal credential.

Use this runner only for trusted protected `main` workflows. Keep PR jobs on
standard hosted runners. Repository administrators must consider organization
runner-group/workflow restrictions before allowing untrusted fork execution;
labels alone are routing, not an authorization boundary. Clearing the workspace
does not reimage the VM. Runner diagnostics remain on its private disk and can
be inspected through an authorized management workflow.

References: [GitHub ephemeral runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners),
[Azure protected Run Command parameters](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/run-command-managed).
