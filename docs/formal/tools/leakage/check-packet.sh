#!/usr/bin/env bash
# Checks this folder before a run: the settings files generate from cases.json and tlc-templates.json (tlc_cases.py,
# in this folder or above it), every cases.tsv line passes the runner's identifier guard,
# every generated .cfg names CHECK_DEADLOCK, and SHA256SUMS matches.
set -euo pipefail
cd "$(dirname "$0")"
gen=; d=$(pwd)
for _ in 1 2 3 4 5; do [[ -f "$d/tlc_cases.py" ]] && { gen=$d/tlc_cases.py; break; }; d=$(dirname "$d"); done
[[ -n "$gen" ]] || { echo "tlc_cases.py not found in this folder or above it"; exit 2; }
"${PYTHON:-python3}" "$gen" gen "$(pwd)" > /dev/null || { echo "settings not generated"; exit 1; }
n=0; bad=0
while IFS=$'\t' read -r case_id config module; do
  n=$((n + 1))
  if ! [[ "$case_id" =~ ^[a-z0-9.-]+$ && "$config" == "$case_id.cfg" && "$module" =~ ^[A-Za-z0-9]+$ ]]; then
    echo "line $n fails the runner guard: $case_id"; bad=1
  fi
  [[ -f "$config" ]] || { echo "line $n: missing $config"; bad=1; continue; }
  grep -q '^CHECK_DEADLOCK ' "$config" || { echo "line $n: $config has no CHECK_DEADLOCK"; bad=1; }
  [[ -f "$module.tla" ]] || { echo "line $n: missing $module.tla"; bad=1; }
done < cases.tsv
sha256sum --check --quiet SHA256SUMS || bad=1
[[ $bad -eq 0 ]] && echo "OK: $n cases; SHA256SUMS OK" || { echo "NOT OK"; exit 1; }
