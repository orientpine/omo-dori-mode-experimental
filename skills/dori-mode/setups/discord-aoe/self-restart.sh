#!/usr/bin/env bash
# Restart an aoe agent session (default: the Dori itself) and type a first prompt into it.
# Schedule it detached so it outlives the session it restarts:
#   systemd-run --user --on-active=20 --unit=dori-self-restart-$(date +%s) \
#     ~/.dori/src/skills/dori-mode/setups/discord-aoe/self-restart.sh
# usage: self-restart.sh [--start] [aoe-id] [tmux-session] [prompt]     (prompt "" types nothing)
#
# systemd user units get a bare PATH without ~/.bun/bin, so a restarted pane can fail to find the agent
# and die at once. This script pins PATH, refuses to restart when the agent binary is broken, waits for
# the prompt before typing, retries three times, and reports a failure to the Dori's Discord channel.
# The prompt goes in through `dori type`, which counts it only when the input box is empty again and a turn
# runs: a long prompt folds into "[paste #1 +N lines]" and can sit unsent after a plain send-keys + Enter.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
[ -f "${DORI_ENV_FILE:-$HOME/.dori/dori.env}" ] && set -a && . "${DORI_ENV_FILE:-$HOME/.dori/dori.env}" && set +a

MODE=restart
if [ "${1:-}" = --start ]; then
  MODE=start
  shift
fi

if [ -z "${1:-}" ]; then
  LEAD=$(dori lead) || exit 1
  read -r ID T _ <<<"$LEAD"
  if [ "$MODE" = start ] && [[ "$LEAD" != *" stopped" ]]; then
    echo "LEAD_ALREADY_RUNNING $T"
    exit 0
  fi
else
  ID=$1
  T=${2:-${DORI_LEAD_TMUX:?set DORI_LEAD_TMUX or pass the tmux session}}
fi
PROMPT=${3-Dori mode}
AGENT=${DORI_AGENT_BIN:-omo}
LOG=$HOME/.dori/self-restart.log
REASON=""

log() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }
notify() { dori send discord --to "${DORI_DISCORD_CHANNEL:-}" --text "$1" >>"$LOG" 2>&1 || log "SELF-RESTART-NOTIFY-FAIL"; }
ready() { tmux capture-pane -p -t "=$T:" 2>/dev/null | grep -q '^❯'; }
busy() { tmux capture-pane -p -t "=$T:" 2>/dev/null | grep -q 'esc to interrupt'; }

if ! command -v "$AGENT" >/dev/null || ! "$AGENT" --version >>"$LOG" 2>&1; then
  log "SELF-RESTART-ABORT $AGENT missing or broken; session left running"
  notify "restart of $T cancelled: $AGENT does not run. The old session is still up."
  exit 1
fi

for attempt in 1 2 3; do
  log "attempt $attempt: aoe session $MODE $ID"
  aoe session "$MODE" "$ID" >>"$LOG" 2>&1 || log "aoe $MODE rc=$?"
  for _ in $(seq 90); do ready && break; sleep 2; done
  if ready; then
    sleep 10 # let aoe's own wake-up message land first
    if [ -n "$PROMPT" ]; then
      if dori type "$T" --text "$PROMPT" >>"$LOG" 2>&1; then
        log "SELF-RESTART-OK attempt $attempt (prompt submitted)"
        exit 0
      fi
      REASON="prompt not submitted (NOT_SUBMITTED in the watch log)"
    else
      sleep 30
      if tmux has-session -t "=$T" 2>/dev/null && { ready || busy; }; then
        log "SELF-RESTART-OK attempt $attempt"
        exit 0
      fi
    fi
  else
    REASON="no ❯ prompt after restart"
  fi
  log "attempt $attempt failed; pane tail: $(tmux capture-pane -p -t "=$T:" 2>/dev/null | tail -5 | tr '\n' '|')"
done

log "SELF-RESTART-FAIL after 3 attempts"
notify "restart of $T failed 3 times (last: ${REASON:-unknown}). Log: ~/.dori/self-restart.log. Start it by hand: aoe session start $ID"
exit 1
