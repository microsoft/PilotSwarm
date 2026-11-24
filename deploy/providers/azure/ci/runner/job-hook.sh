#!/usr/bin/env bash
# Job hook for the Azure runner. The runner program calls it before every job
# ("started") and after every job ("completed"); setup.sh installs it.
#
# A job on this machine can sign in to Azure as the machine's managed identity.
# The protected environment's approval does not guard that sign-in, so this
# hook does. Before a job, it lets the job continue only when the job comes
# from one of the listed workflow files on the main branch. Before and after a
# job, it removes what a job leaves behind: sign-ins, the checkout, temporary
# files and Docker state. The machine is not rebuilt between jobs. Before a
# job it also waits for the machine's OS update, if one is being installed.
#
# Fixed absolute paths on purpose: nothing here is read from the job's
# environment except the values the runner program sets itself.
set -uo pipefail
# Work from a folder every account can enter. `find` stops without removing
# anything when it cannot return to the folder it was started in.
cd / || exit 1
ALLOWED=/etc/pilotswarm-ci-runner/allowed-workflows
WORK_ROOT=/opt/actions-runner/_work
TMP_ROOT=/tmp
PKILL=/usr/bin/pkill
DOCKER=/usr/bin/docker
LOGGER=/usr/bin/logger
SYSTEMCTL=/usr/bin/systemctl
SLEEP=/usr/bin/sleep

clean() {
  : "${HOME:?}"
  # Azure, GitHub, Kubernetes and registry sign-ins.
  rm -rf -- "$HOME/.azure" "$HOME/.config/gh" "$HOME/.kube" "$HOME/.docker"
  # The checkout, with any configuration files a job wrote into it.
  case "${GITHUB_WORKSPACE:-}" in
    "$WORK_ROOT"/?*)
      if [ -d "$GITHUB_WORKSPACE" ]; then
        find "$GITHUB_WORKSPACE" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || echo "::warning::The runner's job hook could not empty the checkout folder."
      fi ;;
  esac
  # What earlier jobs left in the shared temporary folder.
  if [ -d "$TMP_ROOT" ]; then
    find "$TMP_ROOT" -mindepth 1 -maxdepth 1 -user "$(id -un)" -exec rm -rf -- {} + 2>/dev/null || true
  fi
  # Every container, then images, build cache and volumes. No container
  # belongs to a running job at either hook time: the runner program starts a
  # job's service containers after the "started" hook and stops them before
  # the "completed" hook. A job that was cut off leaves its containers
  # behind, and a leftover one can hold the port the next job needs.
  if [ -x "$DOCKER" ]; then
    leftover="$("$DOCKER" ps --all --quiet 2>/dev/null)"
    if [ -n "$leftover" ]; then
      # shellcheck disable=SC2086
      "$DOCKER" rm --force $leftover >/dev/null 2>&1 || true
    fi
    "$DOCKER" system prune --all --force --volumes >/dev/null 2>&1 || true
  fi
}

# The machine installs its own OS updates. That replaces libraries and can
# restart Docker, so a job must not start in the middle of it. The update
# itself never starts while a job runs (see setup.sh).
wait_for_os_update() {
  [ -x "$SYSTEMCTL" ] || return 0
  waited=0
  while [ "$("$SYSTEMCTL" is-active apt-daily-upgrade.service 2>/dev/null)" = activating ] && [ "$waited" -lt 180 ]; do
    if [ "$waited" -eq 0 ]; then echo "The runner machine is installing OS updates. This job waits until that is done."; fi
    "$SLEEP" 10
    waited=$((waited + 1))
  done
}

case "${1:-}" in
  started)
    workflow="${GITHUB_WORKFLOW_REF:-}"
    allowed=false
    if [ -n "$workflow" ] && [ -r "$ALLOWED" ]; then
      while IFS= read -r line; do
        if [ "$line" = "$workflow" ]; then allowed=true; fi
      done < "$ALLOWED"
    fi
    if [ "$allowed" != true ]; then
      message="This runner accepts only the protected Azure workflows on main. Refused: ${workflow:-unknown workflow}."
      echo "::error::$message"
      if [ -x "$LOGGER" ]; then "$LOGGER" -t pilotswarm-ci-runner "$message" || true; fi
      # A failing hook fails the job, but steps marked `if: always()` would
      # still run. Stop this job's worker process so that no step of a refused
      # job runs on this machine.
      "$PKILL" -KILL -u "$(id -u)" -f 'Runner\.Worker' || true
      exit 1
    fi
    wait_for_os_update
    clean
    ;;
  completed)
    clean
    ;;
  *)
    echo "Usage: job-hook.sh started|completed" >&2
    exit 2
    ;;
esac
