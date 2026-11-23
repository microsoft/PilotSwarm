#!/usr/bin/env bash
# Prepares this machine as the repository's runner for the protected Azure
# workflows. manage.mjs sends it through Azure Run Command, where it runs as
# root. It is safe to run again.
#
# A registration token, when given, arrives as a protected Run Command
# parameter (an environment variable). Never enable xtrace and never write the
# token to disk.
set -euo pipefail
: "${RUNNER_REPOSITORY:?}" "${RUNNER_LABEL:?}" "${RUNNER_NAME:?}"
RUNNER_VERSION=2.338.2
RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
RUNNER_HOME=/opt/actions-runner
HOOKS=/usr/local/lib/pilotswarm-ci-runner
CONFIG=/etc/pilotswarm-ci-runner
UNIT=pilotswarm-ci-runner.service

if pgrep -f '/Runner\.Worker' >/dev/null; then
  echo 'A job is running on this runner. Run the setup again when it has finished.' >&2
  exit 1
fi
# The runner stops while its machine changes. If the setup fails, start it
# again as it was, so that a failed update does not leave the runner offline.
was_active=false
if systemctl is-active --quiet "$UNIT"; then was_active=true; fi
restore_on_failure() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$was_active" = true ]; then systemctl start "$UNIT" 2>/dev/null || true; fi
  exit "$status"
}
trap restore_on_failure EXIT
systemctl stop "$UNIT" 2>/dev/null || true

# Tools the workflows expect. GitHub-hosted runners have them preinstalled.
# The machine's automatic updates can hold the package lock: wait for it.
export DEBIAN_FRONTEND=noninteractive
apt_get() { apt-get -o DPkg::Lock::Timeout=900 "$@"; }
apt_get update -qq
apt_get install -y -qq ca-certificates curl gnupg git jq unzip zip build-essential python3 python3-venv \
  postgresql-client docker.io docker-buildx
systemctl enable --now docker
usermod -aG docker runner

install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor --yes -o /etc/apt/keyrings/microsoft.gpg
echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ noble main' > /etc/apt/sources.list.d/azure-cli.list
curl --fail --silent --show-error --location https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg
chmod 0644 /etc/apt/keyrings/*.gpg
echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list
apt_get update -qq
apt_get install -y -qq azure-cli gh

# The job hook and the maintenance script. manage.mjs writes both into $HOOKS
# before this script runs. Root owns these files, so the runner's own account
# cannot change them without sudo.
test -s "$HOOKS/job-hook.sh"
test -s "$HOOKS/maintenance.sh"
printf '#!/usr/bin/env bash\nexec %s/job-hook.sh started\n' "$HOOKS" > "$HOOKS/job-started.sh"
printf '#!/usr/bin/env bash\nexec %s/job-hook.sh completed\n' "$HOOKS" > "$HOOKS/job-completed.sh"
chown -R root:root "$HOOKS"
chmod 0755 "$HOOKS" "$HOOKS"/*.sh

# The workflow files this runner accepts, on the main branch only.
install -d -m 0755 "$CONFIG"
for workflow in tests release-tarballs deploy-azure provision-ci-database; do
  echo "${RUNNER_REPOSITORY}/.github/workflows/${workflow}.yml@refs/heads/main"
done > "$CONFIG/allowed-workflows"
chmod 0644 "$CONFIG/allowed-workflows"

# The runner program. With a token: install the pinned version and register.
# Without one: keep the existing registration; the program updates itself.
if [ -n "${RUNNER_TOKEN:-}" ]; then
  docker system prune -af --volumes >/dev/null
  rm -rf "$RUNNER_HOME"
  install -d -o runner -g runner "$RUNNER_HOME" /opt/hostedtoolcache
  cd "$RUNNER_HOME"
  curl --fail --silent --show-error --location \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" -o runner.tar.gz
  echo "${RUNNER_SHA256}  runner.tar.gz" | sha256sum --check --status
  tar xzf runner.tar.gz
  rm runner.tar.gz
  ./bin/installdependencies.sh >/dev/null
  chown -R runner:runner "$RUNNER_HOME"
  # Registered once. The registration stays valid while the runner connects
  # at least every 14 days.
  runuser -u runner -- ./config.sh --unattended --replace --no-default-labels \
    --url "https://github.com/${RUNNER_REPOSITORY}" --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" --labels "$RUNNER_LABEL" --work _work >/dev/null
  unset RUNNER_TOKEN
elif [ ! -s "$RUNNER_HOME/.runner" ] || [ ! -s "$RUNNER_HOME/.credentials" ]; then
  echo 'This machine has no runner registration. Run the setup with a registration token.' >&2
  exit 1
fi
install -d -o runner -g runner /opt/hostedtoolcache

cat > "/etc/systemd/system/$UNIT" <<UNIT_FILE
[Unit]
Description=GitHub Actions runner for the protected Azure workflows
After=network-online.target docker.service
Wants=network-online.target
[Service]
User=runner
Group=runner
SupplementaryGroups=docker
WorkingDirectory=$RUNNER_HOME
Environment=RUNNER_TOOL_CACHE=/opt/hostedtoolcache
Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=$HOOKS/job-started.sh
Environment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$HOOKS/job-completed.sh
ExecStart=$RUNNER_HOME/run.sh
Restart=always
RestartSec=15
TimeoutStopSec=90
[Install]
WantedBy=multi-user.target
UNIT_FILE
rm -f /usr/local/bin/run-ci-runner

# OS updates. The machine is not rebuilt between jobs, so it patches itself.
# Three rules keep that away from a running job:
# 1. The updater never restarts the runner, Docker or containerd. They get
#    the upgraded libraries at the next reboot.
install -d -m 0755 /etc/needrestart/conf.d
cat > /etc/needrestart/conf.d/pilotswarm-ci-runner.conf <<'NEEDRESTART'
# Written by the runner setup. Restarting one of these cuts a running job.
$nrconf{override_rc}{qr(^pilotswarm-ci-runner\.service$)} = 0;
$nrconf{override_rc}{qr(^docker\.service$)} = 0;
$nrconf{override_rc}{qr(^containerd\.service$)} = 0;
NEEDRESTART
chmod 0644 /etc/needrestart/conf.d/pilotswarm-ci-runner.conf
# 2. The daily update is skipped while a job runs. The maintenance timer
#    starts it again when the runner is idle; a job that arrives during an
#    update waits in its hook.
install -d -m 0755 /etc/systemd/system/apt-daily-upgrade.service.d
cat > /etc/systemd/system/apt-daily-upgrade.service.d/pilotswarm-ci-runner.conf <<'DROPIN'
[Service]
# Written by the runner setup. A non-zero exit skips this run; it is not a failure.
ExecCondition=/bin/sh -c '! /usr/bin/pgrep -u runner -f "Runner\.Worker" >/dev/null'
DROPIN
# 3. A reboot that the updates need happens only while the runner is idle.
cat > /etc/systemd/system/pilotswarm-ci-runner-maintenance.service <<MAINTENANCE_UNIT
[Unit]
Description=OS updates and pending reboots for the runner machine, only while it is idle
[Service]
Type=oneshot
ExecStart=$HOOKS/maintenance.sh
MAINTENANCE_UNIT
cat > /etc/systemd/system/pilotswarm-ci-runner-maintenance.timer <<'MAINTENANCE_TIMER'
[Unit]
Description=Every 15 minutes: OS updates and pending reboots while the runner is idle
[Timer]
OnBootSec=10min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
MAINTENANCE_TIMER
systemctl daemon-reload
systemctl enable --now pilotswarm-ci-runner-maintenance.timer
systemctl reset-failed "$UNIT" 2>/dev/null || true

if [ "${RUNNER_START:-true}" = true ]; then
  systemctl enable --now "$UNIT"
  sleep 5
  systemctl is-active --quiet "$UNIT"
  echo 'Runner service is running and starts at boot.'
else
  systemctl disable "$UNIT" 2>/dev/null || true
  echo 'Runner service is installed but not started.'
fi
echo "Tools: az $(az version --query '"azure-cli"' -o tsv), docker $(docker --version | awk '{print $3}' | tr -d ,), buildx $(docker buildx version | awk '{print $2}'), gh $(gh --version | awk 'NR==1{print $3}')"
echo "Accepted workflows: $(tr '\n' ' ' < "$CONFIG/allowed-workflows")"
