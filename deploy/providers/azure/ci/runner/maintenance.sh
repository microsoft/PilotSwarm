#!/usr/bin/env bash
# Keeps the runner machine patched without touching a running job. setup.sh
# installs it; a timer runs it as root every 15 minutes.
#
# The machine is not rebuilt between jobs, so it installs its own OS updates.
# Left alone, the distribution's daily update restarts the services that use
# an upgraded library, the runner among them, in the middle of a job.
#
#   - OS updates are installed only while the runner is idle
#   - a reboot that the updates need happens only while the runner is idle
set -uo pipefail
cd / || exit 1
UNIT=pilotswarm-ci-runner.service
RUNNER_USER=runner
REBOOT_FLAG=/var/run/reboot-required
PGREP=/usr/bin/pgrep
SYSTEMCTL=/usr/bin/systemctl
LOGGER=/usr/bin/logger

job_running() { "$PGREP" -u "$RUNNER_USER" -f 'Runner\.Worker' >/dev/null 2>&1; }
note() {
  echo "$1"
  if [ -x "$LOGGER" ]; then "$LOGGER" -t pilotswarm-ci-runner "$1" || true; fi
}

if job_running; then exit 0; fi

# The distribution's own daily update. It does its work at most once a day
# and returns at once otherwise. Its drop-in skips it while a job runs, so a
# job that starts right now is safe; that job waits in its hook instead.
"$SYSTEMCTL" start apt-daily-upgrade.service || true

if job_running; then exit 0; fi
if [ -e "$REBOOT_FLAG" ]; then
  note "OS updates need a reboot and the runner is idle. Rebooting."
  # Stop taking jobs first. The runner service starts again at boot.
  "$SYSTEMCTL" stop "$UNIT" || true
  "$SYSTEMCTL" reboot
fi
