#!/bin/sh
# doriface-host keeps one WebSocket uplink to the relay and reconnects only when that socket closes. It sends a ping
# every 30 s but never checks for the pong (packages/relay-client/src/flow-control.ts keepAlive, unchanged v0.1.11 to
# v0.1.18), so when a network path dies without a FIN or RST (a company VPN dropping under it) the socket stays open
# forever: the relay reaps it after 90 s and tells every other member the host is offline, while the host itself logs
# nothing and its own `mesh status` still reads fine (it has no line for its own uplink). So this asks the relay, not
# the host: `doriface-host connect --mesh <own hostId>` goes through the running host and the relay back to this host's
# own uplink, and it fails while the relay has no live uplink for this host. When that round trip has failed for
# DORITERM_RELAY_WATCH_DOWN_MINUTES (3: longer than the relay's 90 s reap plus the uplink's own redial, at most 10 s
# connect and 30 s backoff, so a drop the host heals itself never gets here), it restarts the host's unit, at most
# DORITERM_RELAY_WATCH_MAX_RESTARTS (3) times in an hour, so a network that is simply down is not restarted every few
# minutes. DORITERM_RELAY_WATCH_RESTART=0 only says what it would do (the host a phone is paired to restarts only when
# a person says so). The unit's timer runs it every minute. POSIX sh and coreutils only: most mesh hosts run no Dori,
# so they have no bun and no checkout of this repository.
host=${DORIFACE_HOST:-$HOME/.local/bin/doriface-host}
dir=${DORIFACE_HOST_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/doriface-host}
unit=${DORITERM_RELAY_WATCH_UNIT:-doriface-host.service}
state=${DORITERM_RELAY_WATCH_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/doriterm-relay-watch}
down_min=${DORITERM_RELAY_WATCH_DOWN_MINUTES:-3}
max=${DORITERM_RELAY_WATCH_MAX_RESTARTS:-3}
restart=${DORITERM_RELAY_WATCH_RESTART:-1}
probe_s=${DORITERM_RELAY_WATCH_PROBE_SECONDS:-30}
for n in "$down_min" "$max" "$probe_s"; do
  case $n in '' | *[!0-9]*) echo "RELAY_WATCH_CONFIG_BAD a count or minutes value is not a whole number: $n"; exit 2;; esac
done
case $restart in 0 | 1) ;; *) echo "RELAY_WATCH_CONFIG_BAD DORITERM_RELAY_WATCH_RESTART is 0 or 1, not $restart"; exit 2;; esac
now=$(date +%s)
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

down_since=
restarts=
[ -f "$state" ] && . "$state"
save() {
  mkdir -p "$(dirname "$state")"
  printf 'down_since=%s\nrestarts="%s"\n' "$down_since" "$restarts" > "$state.tmp" && mv "$state.tmp" "$state"
}

if ! systemctl --user is-active --quiet "$unit"; then
  echo "RELAY_WATCH_SKIP $unit is not running; its own unit brings it back"
  down_since=; save; exit 0
fi
# a host that takes the connection and never answers would hold this oneshot run, and with it the timer, forever
status=$(timeout "$probe_s" "$host" mesh status --json --state-dir "$dir" 2>&1) || [ -n "$status" ] || status="no answer in ${probe_s} s"
self=$(printf '%s\n' "$status" | sed -n 's/.*"self"[[:space:]]*:[[:space:]]*"\([a-z0-9]*\)".*/\1/p' | head -n 1)
if [ -n "$self" ]; then
  why=$(timeout "$probe_s" "$host" connect --mesh --state-dir "$dir" "$self" < /dev/null 2>&1 > /dev/null) && ok=1 || ok=0
  [ -n "$why" ] || why="no answer in ${probe_s} s"
elif printf '%s\n' "$status" | grep -q '"meshId"'; then
  echo "RELAY_WATCH_CONFIG_BAD mesh status names no self"; exit 2
else
  # no mesh answer from a running unit: the host is wedged or in no mesh; a restart fixes the first and the cap bounds
  # the second
  ok=0 why="mesh status: $(printf '%s' "$status" | tr '\n' ' ' | cut -c1-200)"
fi

if [ "$ok" = 1 ]; then
  [ -n "$down_since" ] && echo "RELAY_WATCH_UP again after $((now - down_since)) s down" || echo "RELAY_WATCH_UP"
  down_since=; save; exit 0
fi
[ -n "$down_since" ] || down_since=$now
kept=
for t in $restarts; do [ $((now - t)) -lt 3600 ] && kept="$kept $t"; done
restarts=${kept# }
down=$((now - down_since))
if [ "$down" -lt $((down_min * 60)) ]; then
  echo "RELAY_WATCH_DOWN since $(iso "$down_since") (${down} s): $why"
elif [ "$restart" = 0 ]; then
  echo "RELAY_WATCH_WOULD_RESTART $unit, down since $(iso "$down_since") (${down} s): $why"
elif [ "$(printf '%s\n' $restarts | grep -c .)" -ge "$max" ]; then
  echo "RELAY_WATCH_CAPPED $max restarts in the last hour; down since $(iso "$down_since") (${down} s): $why"
else
  echo "RELAY_WATCH_RESTART $unit, down since $(iso "$down_since") (${down} s): $why"
  # try-restart: a host stopped by hand since the check above stays stopped
  systemctl --user try-restart "$unit" || echo "RELAY_WATCH_RESTART_FAILED $unit"
  restarts="${restarts:+$restarts }$now"
  down_since=
fi
save
