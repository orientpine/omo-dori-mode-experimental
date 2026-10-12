#!/usr/bin/env bash
# A scripted check with fakes on PATH; never talks to real systemd or aoe.
set -euo pipefail
S=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export CHECK_LOG="$T/log"
export PATH="$T:$PATH"
cat >"$T/dori" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == lead ]] || exit 3
[[ ${LEAD_FAIL:-0} == 0 ]] || exit 1
printf 'fresh-lead-id aoe_fresh\n'
EOF
cat >"$T/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$CHECK_LOG"
EOF
cat >"$T/aoe" <<'EOF'
#!/usr/bin/env bash
printf 'aoe %s\n' "$*" >>"$CHECK_LOG"
if [[ "$2" == start ]]; then exit 1; fi
EOF
chmod +x "$T/dori" "$T/systemctl" "$T/aoe"
bash "$S/dori.sh"
expected=$'systemctl --user start dori-inbound.service dori-google-watch.service\naoe session start fresh-lead-id\naoe session attach fresh-lead-id'
[[ "$( <"$CHECK_LOG")" == "$expected" ]] || { printf 'launcher command mismatch\n' >&2; exit 1; }
rm "$CHECK_LOG"
if LEAD_FAIL=1 bash "$S/dori.sh"; then printf 'missing lead succeeded\n' >&2; exit 1; fi
[[ ! -e "$CHECK_LOG" ]] || { printf 'missing lead touched services\n' >&2; exit 1; }
printf 'DORI_SHELL_CHECK_PASS\n'
