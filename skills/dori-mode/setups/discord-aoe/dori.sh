#!/usr/bin/env bash
set -euo pipefail
# dori lead must be installed (the lead-resolution PR supplies it).
lead=$(dori lead)
read -r AOE_ID _ <<< "$lead"
if [[ -z "$AOE_ID" ]]; then
  printf 'dori lead returned no session id\n' >&2
  exit 1
fi
systemctl --user start dori-inbound.service dori-google-watch.service
aoe session start "$AOE_ID" >/dev/null 2>&1 || true
exec aoe session attach "$AOE_ID"
