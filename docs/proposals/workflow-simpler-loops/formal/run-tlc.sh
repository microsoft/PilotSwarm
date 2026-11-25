#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
export LC_ALL=C
jar=${1:?usage: bash run-tlc.sh /path/to/tla2tools.jar}
printf '%s  %s\n' fdffef247f563ef6edbfd44958d2a82db79e7564e07cb673262d896353fa6713 "$jar" | sha256sum -c -
mkdir -p logs witnesses

run() {
    local config=$1 log=$2
    local -a cmd=(java -Xmx512m -XX:+UseParallelGC -cp "$jar" tlc2.TLC
                  -workers 1 -coverage 1 -config "$config" SimplerLoops.tla)
    {
        printf 'Command:'; printf ' %q' "${cmd[@]}"; printf '\n'
        "${cmd[@]}"
    } > "$log" 2>&1
}

expect_invariant() {
    local config=$1 log=$2 invariant=$3 rc=0
    run "$config" "$log" || rc=$?
    if [[ $rc -ne 12 ]] || ! grep -Fxq "Error: Invariant $invariant is violated." "$log"; then
        printf 'Unexpected exit %s or trace for %s; see %s\n' "$rc" "$invariant" "$log" >&2
        return 1
    fi
}

run SimplerLoops.cfg logs/main.log
grep -Fq 'Model checking completed. No error has been found.' logs/main.log

for witness in NoPThenE NoArrival NoEntryElapsed NoExhausted NoDuplicateEntry \
               NoQWaiting NoDuplicateAccept NoTimerElapsed NoLateArrivalThenTimer \
               NoSpentEntryWithMessage; do
    config="witnesses/$witness.cfg"
    printf 'SPECIFICATION Spec\nCONSTANT SplitCommit = FALSE\nINVARIANT %s\n' "$witness" > "$config"
    expect_invariant "$config" "logs/$witness.log" "$witness"
done
expect_invariant SplitCommit.cfg logs/split-commit.log NoLostDelivery
