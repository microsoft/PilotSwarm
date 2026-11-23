#!/usr/bin/env bash
# Job hook for the Azure runner. The runner program calls it before every job
# ("started") and after every job ("completed"); setup.sh installs it.
#
# A job on this machine can sign in to Azure as the machine's managed identity.
# The protected environment's approval does not guard that sign-in, so this
# hook does. Before a job, it lets the job continue only when the job comes
# from one of the listed workflow files on the main branch. Before and after a
# job, it removes what a job leaves behind: sign-ins, the checkout and Docker
# state. The machine is not rebuilt between jobs.
#
# Fixed absolute paths on purpose: nothing here is read from the job's
# environment except the values the runner program sets itself.
set -uo pipefail
# Work from a folder every account can enter. `find` stops without removing
# anything when it cannot return to the folder it was started in.
cd / || exit 1
ALLOWED=/etc/pilotswarm-ci-runner/allowed-workflows
WORK_ROOT=/opt/actions-runner/_work
PKILL=/usr/bin/pkill
DOCKER=/usr/bin/docker
LOGGER=/usr/bin/logger

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
  # Stopped containers, images, build cache and volumes. Containers that are
  # running for the current job are in use and stay.
  if [ -x "$DOCKER" ]; then
    "$DOCKER" system prune --all --force --volumes >/dev/null 2>&1 || true
  fi
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
