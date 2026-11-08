#!/usr/bin/env bash
# Checks this folder before a run: every cases.tsv line passes run-tlc.sh's own guard (read from run-tlc.sh, so the two
# cannot drift), every .cfg exists and names CHECK_DEADLOCK, and SHA256SUMS matches.
set -euo pipefail
cd "$(dirname "$0")"
guard=$(grep -o '\[\[ "\$case_id" =~ .* \]\]' run-tlc.sh)
[[ -n "$guard" ]] || { echo "no guard found in run-tlc.sh"; exit 2; }
n=0; bad=0
while IFS=$'\t' read -r case_id config module; do
  n=$((n + 1))
  if ! eval "$guard"; then echo "line $n fails the runner guard: $case_id"; bad=1; fi
  [[ -f "$config" ]] || { echo "line $n: missing $config"; bad=1; continue; }
  grep -q '^CHECK_DEADLOCK ' "$config" || { echo "line $n: $config has no CHECK_DEADLOCK"; bad=1; }
  [[ -f "$module.tla" ]] || { echo "line $n: missing $module.tla"; bad=1; }
done < cases.tsv
sha256sum --check --quiet SHA256SUMS || bad=1
[[ $bad -eq 0 ]] && echo "OK: $n cases; SHA256SUMS OK" || { echo "NOT OK"; exit 1; }
