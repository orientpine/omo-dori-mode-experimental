#!/usr/bin/env bash
# Restart an aoe agent session (default: the Dori itself) and type a first prompt into it.
# Schedule it detached so it outlives the session it restarts:
#   systemd-run --user --on-active=20 --unit=dori-self-restart-$(date +%s) \
#     ~/.dori/src/skills/dori-mode/setups/discord-aoe/self-restart.sh
# usage: self-restart.sh [aoe-id] [tmux-session] [prompt]     (prompt "" types nothing)
#
# systemd user units get a bare PATH without ~/.bun/bin, so a restarted pane can fail to find the agent
# and die at once. This script pins PATH, refuses to restart when the agent binary is broken, waits for
# the prompt before typing, retries three times, and reports a failure to the Dori's Discord channel.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
[ -f "${DORI_ENV_FILE:-$HOME/.dori/dori.env}" ] && set -a && . "${DORI_ENV_FILE:-$HOME/.dori/dori.env}" && set +a

ID=${1:-${DORI_LEAD_AOE_ID:?set DORI_LEAD_AOE_ID or pass the aoe id}}
T=${2:-${DORI_LEAD_TMUX:?set DORI_LEAD_TMUX or pass the tmux session}}
PROMPT=${3-Dori mode}
AGENT=${DORI_AGENT_BIN:-omo}
LOG=$HOME/.dori/self-restart.log

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
  log "attempt $attempt: aoe session restart $ID"
  aoe session restart "$ID" >>"$LOG" 2>&1 || log "aoe restart rc=$?"
  for _ in $(seq 90); do ready && break; sleep 2; done
  if ready; then
    sleep 10 # let aoe's own wake-up message land first
    [ -n "$PROMPT" ] && tmux send-keys -t "=$T:" -l -- "$PROMPT" && tmux send-keys -t "=$T:" Enter
    sleep 30
    if tmux has-session -t "=$T" 2>/dev/null && { ready || busy; }; then
      log "SELF-RESTART-OK attempt $attempt"
      exit 0
    fi
  fi
  log "attempt $attempt failed; pane tail: $(tmux capture-pane -p -t "=$T:" 2>/dev/null | tail -5 | tr '\n' '|')"
done

log "SELF-RESTART-FAIL after 3 attempts"
notify "restart of $T failed 3 times. Log: ~/.dori/self-restart.log. Start it by hand: aoe session start $ID"
exit 1
