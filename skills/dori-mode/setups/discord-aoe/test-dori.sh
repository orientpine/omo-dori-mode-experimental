#!/usr/bin/env bash
# A scripted check with fakes on PATH; never talks to real systemd, aoe or an hc core.
set -euo pipefail
S=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$S/../../../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export CHECK_LOG="$T/log"
export PATH="$T:$PATH"
export HOME="$T/home"
export XDG_RUNTIME_DIR="$T/run"
mkdir -p "$HOME/.bun/bin" "$HOME/.dori"
REAL_BUN=$(command -v bun)
export REAL_BUN
ln -s "$R" "$HOME/.dori/src"
unset DORI_CONFIG DORI_ENV_FILE DORI_LEAD_PANE HC_SESSION HC_SOCKET || true
# another instance's state dir, which the launcher must drop for the account's own config
export DORI_STATE_DIR="$T/other-instance-state"
# dori.sh runs this checkout's CLI with bun; that CLI is faked here, every other bun run is the real bun
cat >"$HOME/.bun/bin/bun" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" != */scripts/src/cli.ts ]]; then exec "$REAL_BUN" "$@"; fi
shift
[[ -z "${DORI_STATE_DIR:-}" ]] || { printf 'inherited state %s\n' "$DORI_STATE_DIR" >>"$CHECK_LOG"; exit 4; }
if [[ "$1" == revive ]]; then printf 'dori %s\n' "$*" >>"$CHECK_LOG"; exit 0; fi
[[ "$*" == lead ]] || exit 3
[[ ${LEAD_FAIL:-0} == 0 ]] || exit 1
printf '%s\n' "${LEAD_LINE:-fresh-lead-id aoe_fresh}"
EOF
# a dori wrapper on PATH that picks other files, as ~/.second/bin/dori does; the launcher must not use it
cat >"$T/dori" <<'EOF'
#!/usr/bin/env bash
printf 'wrapper dori %s\n' "$*" >>"$CHECK_LOG"
exit 5
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
cat >"$T/herdr" <<'EOF'
#!/usr/bin/env bash
printf 'herdr %s\n' "$*" >>"$CHECK_LOG"
EOF
cat >"$T/hc" <<'EOF'
#!/usr/bin/env bash
printf 'hc session=%s %s\n' "${HC_SESSION:-default}" "$*" >>"$CHECK_LOG"
EOF
chmod +x "$HOME/.bun/bin/bun" "$T/dori" "$T/systemctl" "$T/aoe" "$T/herdr" "$T/hc"
bash "$S/dori.sh"
expected=$'systemctl --user start dori-inbound.service dori-google-watch.service\naoe session start fresh-lead-id\naoe session attach fresh-lead-id'
[[ "$( <"$CHECK_LOG")" == "$expected" ]] || { printf 'launcher command mismatch\n' >&2; exit 1; }
rm "$CHECK_LOG"
if LEAD_FAIL=1 bash "$S/dori.sh"; then printf 'missing lead succeeded\n' >&2; exit 1; fi
[[ ! -e "$CHECK_LOG" ]] || { printf 'missing lead touched services\n' >&2; exit 1; }
# a herdr lead: a stopped one is revived in its pane, then herdr's client attaches; aoe is not used
LEAD_LINE="11111111-2222-4333-8444-555555555555 w1:p2 stopped" bash "$S/dori.sh"
expected=$'systemctl --user start dori-inbound.service dori-google-watch.service\ndori revive w1:p2\nherdr '
[[ "$( <"$CHECK_LOG")" == "$expected" ]] || { printf 'herdr launcher command mismatch\n' >&2; cat "$CHECK_LOG" >&2; exit 1; }
rm "$CHECK_LOG"
LEAD_LINE="11111111-2222-4333-8444-555555555555 w1:p2" bash "$S/dori.sh"
expected=$'systemctl --user start dori-inbound.service dori-google-watch.service\nherdr '
[[ "$( <"$CHECK_LOG")" == "$expected" ]] || { printf 'live herdr lead was revived\n' >&2; exit 1; }
rm "$CHECK_LOG"
# an hc lead: the account's own file beats the inherited one; a live lead attaches in its named core
printf '{"runtime":"hc","leadPane":"hc:t4"}\n' >"$HOME/.dori/config.json"
printf 'HC_SESSION=agents\n' >"$HOME/.dori/dori.env"
printf 'HC_SESSION=foreign\n' >"$T/wrong.env"
export DORI_ENV_FILE="$T/wrong.env"
mkdir -p "$XDG_RUNTIME_DIR/herdr-core"
# a core socket that accepts connections, as a running core's does (a plain file is a socket a killed core left)
mkfifo "$T/up"
"$REAL_BUN" -e 'require("node:net").createServer().listen(process.argv[1], () => console.log("up"))' "$XDG_RUNTIME_DIR/herdr-core/agents.sock" >"$T/up" &
listener=$!
trap 'kill "$listener" 2>/dev/null; rm -rf "$T"' EXIT
read -r _ <"$T/up"
LEAD_LINE="11111111-2222-4333-8444-555555555555 hc:t4" bash "$S/dori.sh"
expected=$'systemctl --user start dori-inbound.service dori-google-watch.service\nhc session=agents attach t4'
[[ "$( <"$CHECK_LOG")" == "$expected" ]] || { printf 'hc launcher command mismatch\n' >&2; cat "$CHECK_LOG" >&2; exit 1; }
rm "$CHECK_LOG"
# a stopped hc lead is revived before the same attach
LEAD_LINE="11111111-2222-4333-8444-555555555555 hc:t4 stopped" bash "$S/dori.sh"
expected=$'systemctl --user start dori-inbound.service dori-google-watch.service\ndori revive hc:t4\nhc session=agents attach t4'
[[ "$( <"$CHECK_LOG")" == "$expected" ]] || { printf 'stopped hc launcher command mismatch\n' >&2; cat "$CHECK_LOG" >&2; exit 1; }
rm "$CHECK_LOG"
# a socket a killed core left (no listener): the same refusal as no socket
kill "$listener"
wait "$listener" 2>/dev/null || true
rm -f "$XDG_RUNTIME_DIR/herdr-core/agents.sock"
: >"$XDG_RUNTIME_DIR/herdr-core/agents.sock"
if out=$(LEAD_LINE="11111111-2222-4333-8444-555555555555 hc:t4" bash "$S/dori.sh" 2>&1); then printf 'stale hc socket launched\n' >&2; exit 1; fi
[[ "$out" == *"not starting one"* ]] || { printf 'stale-socket refusal line missing: %s\n' "$out" >&2; exit 1; }
[[ ! -e "$CHECK_LOG" ]] || { printf 'stale socket touched lead resolution or services\n' >&2; cat "$CHECK_LOG" >&2; exit 1; }
# no core socket: the guard runs before dori lead, systemctl, revive or hc, so no core is started
rm "$XDG_RUNTIME_DIR/herdr-core/agents.sock"
if out=$(LEAD_LINE="11111111-2222-4333-8444-555555555555 hc:t4" bash "$S/dori.sh" 2>&1); then printf 'missing hc core launched\n' >&2; exit 1; fi
[[ "$out" == *"not starting one"* ]] || { printf 'missing-core refusal line missing: %s\n' "$out" >&2; exit 1; }
[[ ! -e "$CHECK_LOG" ]] || { printf 'missing core touched lead resolution or services\n' >&2; cat "$CHECK_LOG" >&2; exit 1; }
printf 'DORI_SHELL_CHECK_PASS\n'
