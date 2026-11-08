#!/usr/bin/env bash
# Runs this folder's TLA+ models: SANY on every module named in cases.tsv, then TLC on every case, in order.
# Usage: run-tlc.sh [<out-dir>]   (default: ./results). Requires Java 17+ (21 used), bash, GNU timeout, sha256sum.
# Tools: TLA_TOOLS must hold tla2tools.jar v1.7.4 (TLC 2.19), checked against its sha256 below. Download:
#   https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
# Settings: -workers 2, -Xmx2g, a per-case limit TLC_CASE_SECONDS (default 300 s; rc 124 = timed out = PARTIAL, never PASS).
# Deadlock policy: each .cfg states CHECK_DEADLOCK explicitly. The exit code of this script is not the verdict:
# read <out>/executions.tsv and each case's tlc.log (rc 0 = no violation in the bounded search, 12 = safety violation,
# 13 = liveness violation, 124 = timeout, others = setup error).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/results}
tools=${TLA_TOOLS:?set TLA_TOOLS to the folder holding tla2tools.jar}
jar="$tools/tla2tools.jar"
jar_sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
java=${JAVA:-java}
case_limit=${TLC_CASE_SECONDS:-300}
mkdir -p "$out" && out=$(cd "$out" && pwd)
cd "$here" || exit 2
printf '%s  %s\n' "$jar_sha" "$jar" | sha256sum --check --quiet || { echo "tla2tools.jar is not v1.7.4"; exit 3; }
sha256sum --check --quiet SHA256SUMS > "$out/inputs-check.txt" 2>&1 || { echo "input hash mismatch"; exit 3; }
"$java" -version > "$out/java-version.txt" 2>&1
printf 'step\tkind\ttarget\texit_code\tstarted_at\tfinished_at\telapsed_seconds\n' > "$out/executions.tsv"

run() {  # step kind target dir -- command...
  local step=$1 kind=$2 target=$3 dir=$4; shift 4
  mkdir -p "$dir"
  printf '%q ' "$@" > "$dir/command.txt"
  local start; start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local t0=$SECONDS
  timeout --signal=TERM --kill-after=10s "$case_limit" "$@" > "$dir/tlc.log" 2>&1
  local code=$?
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$step" "$kind" "$target" "$code" "$start" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$((SECONDS - t0))" >> "$out/executions.tsv"
  printf '%s %s exit=%s\n' "$step" "$target" "$code"
  return $code
}

# 1. Syntax: every module named in cases.tsv must parse; otherwise nothing else runs.
for module in $(cut -f3 cases.tsv | sort -u); do
  [[ "$module" =~ ^[A-Za-z0-9]+$ ]] || { echo "bad module name"; exit 2; }
  run "sany.$module" sany "$module.tla" "$out/sany.$module" "$java" -Xmx2g -cp "$jar" tla2sany.SANY "$module.tla" \
    || { echo "SANY failed for $module"; exit 4; }
  grep -q '\*\*\* Errors' "$out/sany.$module/tlc.log" && { echo "SANY reported errors for $module"; exit 4; }
done

# 2. Every case, in the order of cases.tsv. A case's exit code is recorded; the batch goes on.
while IFS=$'\t' read -r case_id config module; do
  [[ "$case_id" =~ ^[a-z0-9.-]+$ && "$config" =~ ^[a-z0-9.-]+\.cfg$ && "$module" =~ ^[A-Za-z0-9]+$ ]] || { echo "bad case line"; exit 2; }
  run "$case_id" tlc "$config" "$out/$case_id" \
    "$java" -Xms256m -Xmx2g -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 2 \
      -config "$config" -metadir "$out/$case_id/states" "$module.tla" || true
  grep -E '^Error:|is violated|Temporal properties were violated|Deadlock reached|distinct states found|Model checking completed' \
    "$out/$case_id/tlc.log" | tail -4 || true
  rm -rf "$out/$case_id/states"
done < cases.tsv
