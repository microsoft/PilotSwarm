#!/usr/bin/env bash
set -euo pipefail
# Azure Managed Run Command supplies named protected parameters as environment
# variables. Never enable xtrace or write the registration token to disk.
: "${RUNNER_TOKEN:?}" "${RUNNER_REPOSITORY:?}" "${RUNNER_LABEL:?}" "${RUNNER_NAME:?}"
if pgrep -f '/Runner.Listener|/Runner.Worker' >/dev/null; then
  echo 'An existing runner is active; refusing to replace it.' >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git jq unzip zip build-essential python3 python3-venv postgresql-client docker.io
systemctl enable --now docker
usermod -aG docker runner

install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor --yes -o /etc/apt/keyrings/microsoft.gpg
echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ noble main' > /etc/apt/sources.list.d/azure-cli.list
curl --fail --silent --show-error --location https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg
chmod 0644 /etc/apt/keyrings/*.gpg
echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list
apt-get update -qq
apt-get install -y -qq azure-cli gh

# Each registration serves one job. Discard the previous workspace and Docker
# state before registering again; this host is dedicated to disposable CI.
docker system prune -af --volumes >/dev/null
rm -rf /opt/actions-runner
install -d -o runner -g runner /opt/actions-runner /opt/hostedtoolcache
cd /opt/actions-runner
curl --fail --silent --show-error --location https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz -o runner.tar.gz
echo '70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613  runner.tar.gz' | sha256sum --check --status
tar xzf runner.tar.gz
rm runner.tar.gz
./bin/installdependencies.sh
chown -R runner:runner /opt/actions-runner
runuser -u runner -- ./config.sh --unattended --ephemeral --no-default-labels \
  --url "https://github.com/${RUNNER_REPOSITORY}" --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" --labels "$RUNNER_LABEL" --work _work
unset RUNNER_TOKEN

cat > /usr/local/bin/run-ci-runner <<'SH'
#!/usr/bin/env bash
set -uo pipefail
cd /opt/actions-runner
./run.sh
result=$?
# The ephemeral registration has finished. Remove checkout/env files and CLI
# credentials while retaining runner diagnostic logs for operator inspection.
rm -rf /opt/actions-runner/_work /home/runner/.azure /home/runner/.config/gh
exit "$result"
SH
chmod 0755 /usr/local/bin/run-ci-runner
cat > /etc/systemd/system/pilotswarm-ci-runner.service <<'UNIT'
[Unit]
Description=Ephemeral repository CI runner
After=network-online.target docker.service
Wants=network-online.target
[Service]
User=runner
Group=runner
SupplementaryGroups=docker
WorkingDirectory=/opt/actions-runner
Environment=RUNNER_TOOL_CACHE=/opt/hostedtoolcache
ExecStart=/usr/local/bin/run-ci-runner
Restart=no
TimeoutStopSec=90
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
# Intentionally not enabled at boot: a stopped/used runner must be explicitly
# registered with a fresh short-lived token through the management Action.
systemctl reset-failed pilotswarm-ci-runner.service || true
systemctl start pilotswarm-ci-runner.service
systemctl is-active --quiet pilotswarm-ci-runner.service
echo 'Ephemeral CI runner service started.'
