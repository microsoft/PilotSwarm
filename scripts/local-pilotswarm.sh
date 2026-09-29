#!/usr/bin/env bash
# Run the whole PilotSwarm platform on this machine, for local development
# and testing.
#
#   scripts/local-pilotswarm.sh up        start everything: PostgreSQL, the repo service, the portal and its workers
#   scripts/local-pilotswarm.sh restart   after a code change: build, then restart the repo service and the portal
#   scripts/local-pilotswarm.sh down      stop the portal, its workers and the repo service (PostgreSQL keeps running)
#   scripts/local-pilotswarm.sh reset     down, then delete the workspace folders (the database is kept)
#   scripts/local-pilotswarm.sh logs      follow the portal and repo service logs
#
# What runs:
#   PostgreSQL     the pilotswarm-pg container, when there is one (DATABASE_URL in .env)
#   portal         http://localhost:3001 with dev sign-in (pick Ada, Alice, Bob,
#                  Carol or Dave) and 2 workers inside the portal process
#   workspaces     the reference setup in packages/sdk/examples/repo-workspaces:
#     repo service http://127.0.0.1:8080: mirrors duroxide and tfenv, makes session clones
#     folders      ~/pilotswarm-local/ws: plain folders that stand in for the NFS share
#                    a/       repo clones (the repo root)
#                    shared/  a folder every session gets
#                    home/    each person's own folder (users/<person>)
#
# Needs: .env with DATABASE_URL (local PostgreSQL) and GITHUB_TOKEN (a GitHub
# Copilot token), and git 2.46 or later.
#
# Optional settings:
#   PS_LOCAL_DIR             where the folders and logs go (default ~/pilotswarm-local)
#   PS_LOCAL_REPO_PORT       the repo service's port (default 8080)
#   PORT                     the portal's port (default 3001)
#   PS_MODEL_PROVIDERS_PATH  the model catalog (default: .model_providers.json when it exists,
#                            else deploy/config/model_providers.local-docker.json, which has
#                            GitHub Copilot models only and uses GITHUB_TOKEN)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE="$REPO_ROOT/packages/sdk/examples/repo-workspaces"
LOCAL_DIR="${PS_LOCAL_DIR:-$HOME/pilotswarm-local}"
WS="$LOCAL_DIR/ws"
LOGS="$LOCAL_DIR/logs"
REPO_PORT="${PS_LOCAL_REPO_PORT:-8080}"
PORT="${PORT:-3001}"
REPO_PID="$LOCAL_DIR/repo-service.pid"
# The same two repos as the release environment (deploy/providers/azure/gitops/repo-cache).
REPOS='{"duroxide": {"upstream": "https://github.com/microsoft/duroxide.git", "sandbox": true, "adopt": {"agents": true, "skills": true, "instructions": true}},
        "tfenv": {"upstream": "https://github.com/tfutils/tfenv.git", "sandbox": true, "adopt": {"agents": true, "skills": true, "instructions": true}}}'

cd "$REPO_ROOT"

check_env() {
    if ! grep -q '^DATABASE_URL=.' .env 2>/dev/null || ! grep -q '^GITHUB_TOKEN=.' .env 2>/dev/null; then
        echo "[local] .env needs DATABASE_URL (local PostgreSQL) and GITHUB_TOKEN (a GitHub Copilot token)." >&2
        exit 1
    fi
}

# The local PostgreSQL container, when there is one: started if it is stopped.
# It has no restart policy, so it is stopped after a reboot.
start_database() {
    if ! docker info >/dev/null 2>&1; then
        echo "[local] Docker is not running. If DATABASE_URL points at the pilotswarm-pg container, start Docker Desktop first." >&2
        return
    fi
    if docker ps -a --format '{{.Names}}' | grep -qx pilotswarm-pg \
        && ! docker ps --format '{{.Names}}' | grep -qx pilotswarm-pg; then
        echo "[local] Starting PostgreSQL (the pilotswarm-pg container)..."
        docker start pilotswarm-pg >/dev/null
        for _ in $(seq 1 30); do
            if docker exec pilotswarm-pg pg_isready -q 2>/dev/null; then return; fi
            sleep 1
        done
        echo "[local] PostgreSQL did not get ready in 30 s." >&2
        exit 1
    fi
}

build() {
    echo "[local] Building the SDK..."
    npm run build --workspace=packages/sdk >"$LOGS/sdk-build.log" 2>&1 \
        || { echo "[local] The SDK build failed; see $LOGS/sdk-build.log" >&2; exit 1; }
}

# The folders, laid out like the repo pod lays out its disk.
make_folders() {
    mkdir -p "$WS/a/sessions" "$WS/shared" "$WS/home/users" "$LOCAL_DIR/repo-service"
    : >"$WS/a/.pilotswarm-export"
    : >"$WS/shared/.pilotswarm-export"
    : >"$WS/home/.pilotswarm-export"
    # The shared starter files: replaced at every start and read-only, as on
    # the repo pod (where root owns them).
    chmod -R u+w "$WS/shared/.github" "$WS/shared/README.md" 2>/dev/null || true
    cp -R "$EXAMPLE/seed/shared/." "$WS/shared/"
    chmod -R a-w "$WS/shared/.github" "$WS/shared/README.md"
}

repo_service_running() {
    [[ -f "$REPO_PID" ]] && kill -0 "$(cat "$REPO_PID")" 2>/dev/null
}

start_repo_service() {
    if repo_service_running; then
        echo "[local] The repo service is already running (pid $(cat "$REPO_PID"))."
        return
    fi
    echo "[local] Starting the repo service (the first start mirrors duroxide and tfenv)..."
    REPO_SERVICE_ROOT="$WS/a" \
    REPO_SERVICE_ROOT_NAME=a \
    REPO_SERVICE_REPOS="$REPOS" \
    REPO_SERVICE_PUBLIC_URL="http://127.0.0.1:$REPO_PORT" \
    REPO_SERVICE_HOST=127.0.0.1 \
    REPO_SERVICE_PORT="$REPO_PORT" \
    REPO_SERVICE_STATE_FILE="$LOCAL_DIR/repo-service/state.json" \
    REPO_SERVICE_CLONE_UID="$(id -u)" \
    REPO_SERVICE_CREDENTIAL_HELPER="!node $EXAMPLE/credential-helper.mjs" \
        nohup node "$EXAMPLE/repo-service.mjs" >>"$LOGS/repo-service.log" 2>&1 &
    echo $! >"$REPO_PID"
    for _ in $(seq 1 300); do
        if curl -s -m 2 -o /dev/null "http://127.0.0.1:$REPO_PORT/v1/clones?rootSessionId=local-check"; then
            echo "[local] The repo service is ready."
            return
        fi
        if ! repo_service_running; then
            echo "[local] The repo service stopped; see $LOGS/repo-service.log" >&2
            exit 1
        fi
        sleep 1
    done
    echo "[local] The repo service did not answer in 300 s; see $LOGS/repo-service.log" >&2
    exit 1
}

# The portal with its workers inside it, set up like the release
# environment's workers (deploy/providers/azure/gitops/worker/components/workspaces).
start_portal() {
    export PORTAL_AUTH_PROVIDER=dev
    export PORTAL_AUTH_DEV_ALLOW=true
    # Each person sees only their own sessions, as in the release environment.
    export AUTHZ_ENFORCE_OWNERSHIP=true
    export WORKERS=2
    # The model catalog: your own .model_providers.json when there is one (it
    # also has the models this database's system sessions already use), else
    # the GitHub Copilot catalog, which needs only GITHUB_TOKEN.
    if [[ -z "${PS_MODEL_PROVIDERS_PATH:-}" && ! -f "$REPO_ROOT/.model_providers.json" ]]; then
        export PS_MODEL_PROVIDERS_PATH="$REPO_ROOT/deploy/config/model_providers.local-docker.json"
    fi
    export PLUGIN_DIRS="$REPO_ROOT/packages/app/tui/plugins,$EXAMPLE/plugin"
    export PILOTSWARM_EXTENSION_MODULES="$EXAMPLE/index.mjs"
    export PS_WORKSPACE_ROOTS="a=$WS/a"
    export PS_PLAIN_ROOTS="shared=$WS/shared"
    export PS_HOME_ROOT="home=$WS/home"
    export PS_DEFAULT_EXTRAS=shared
    export REPO_SERVICE_URL="http://127.0.0.1:$REPO_PORT"
    export GIT_AUTHOR_NAME="PilotSwarm agent" GIT_AUTHOR_EMAIL=agent@pilotswarm.invalid
    export GIT_COMMITTER_NAME="PilotSwarm agent" GIT_COMMITTER_EMAIL=agent@pilotswarm.invalid
    PORT="$PORT" ./scripts/portal-start.sh local --port "$PORT"
}

stop_all() {
    PORT="$PORT" ./scripts/portal-stop.sh || true
    if repo_service_running; then
        kill "$(cat "$REPO_PID")"
        echo "[local] The repo service stopped."
    fi
    rm -f "$REPO_PID"
}

summary() {
    echo "[local] Portal:  http://localhost:$PORT (sign in as Ada, Alice, Bob, Carol or Dave)"
    echo "[local] Folders: $WS"
    echo "[local] Logs:    scripts/local-pilotswarm.sh logs"
}

case "${1:-}" in
    up)
        check_env
        mkdir -p "$LOGS"
        start_database
        build
        make_folders
        start_repo_service
        start_portal
        summary
        ;;
    restart)
        check_env
        mkdir -p "$LOGS"
        start_database
        build
        stop_all
        start_repo_service
        start_portal
        summary
        ;;
    down)
        stop_all
        echo "[local] PostgreSQL keeps running (the tests use it too). To stop it: docker stop pilotswarm-pg"
        ;;
    reset)
        stop_all
        chmod -R u+w "$WS" 2>/dev/null || true
        rm -rf "$WS" "$LOCAL_DIR/repo-service"
        echo "[local] Removed $WS. The database is kept."
        ;;
    logs)
        tail -n 50 -f /tmp/portal-server.log "$LOGS/repo-service.log"
        ;;
    *)
        sed -n '2,9p' "$0"
        exit 1
        ;;
esac
