#!/usr/bin/env bash
# The dori lane sweeps (watch, freshness, dead-panes, guard) in one unit, each output line stamped and tagged,
# so one log file shows everything. systemd restarts the unit when any sweep exits.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

tagged() {
  local tag=$1
  shift
  dori "$@" 2>&1 | while IFS= read -r line; do printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$tag" "$line"; done
}

tagged watch watch &
tagged freshness freshness --loop 2 &
tagged dead-panes dead-panes --loop 5 &
tagged guard guard --loop 1 &
wait -n
echo "$(date -u +%FT%TZ) dori-lanes a sweep exited; restarting the unit"
exit 1
