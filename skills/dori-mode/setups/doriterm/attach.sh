#!/bin/sh
# A bridge terminal's program. `herdr client` attaches to a running herdr server and never starts one; it exits when the
# server is not up yet (a boot where doriface-host comes first) or goes away (a server restart), so attach again until
# the server answers. hc reports the terminal as started either way, so the retry has to live here.
# With an account argument it attaches to that account's own herdr server: sudo -n as the account (its HOME, runtime dir
# and PATH, as node-dori-do sets them), so the server, its socket and every pane stay that account's.
# A new herdr client opens on the tab the server focused last (a lane, a stray shell), so before each attach it focuses
# the lead's tab with that account's own focus-lead.ts (next to this file), with the Dori's config at
# ~/.<user>/config.json (an instance account) or else ~/.dori/config.json. herdr's tab focus moves every attached client
# of that server. If it fails the row still attaches.
# A Dori on hc (its config's leadPane is an hc terminal, "hc:t<n>") has its lead in that account's own hc core, which
# doriface-host does not list: the row then runs `hc attach` on the lead and reads the config again every
# DORITERM_LEAD_CHECK_SECONDS (5) while attached; once leadPane names another terminal (a lead handover keeps the old one
# frozen, not closed) it leaves the old attach and attaches to the new lead. hc ids are per core, so the attach runs in
# the Dori's own core: the HC_SESSION its dori.env (beside the config) names, else the default core, never the one the
# bridge host's environment selects (review 8 of #404).
account=${1:-}
env='export XDG_RUNTIME_DIR=/run/user/$(id -u) PATH=$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin; '
attach='c=$HOME/.$(id -un)/config.json; [ -f "$c" ] || c=$HOME/.dori/config.json
leadof() { sed -n "s/.*\"leadPane\"[[:space:]]*:[[:space:]]*\"hc:\(t[1-9][0-9bcdfghjkmnpqrstvwxyz]*\)\".*/\1/p" "$c" 2>/dev/null | head -n 1; }
lead=$(leadof)
if [ -n "$lead" ]; then
  core=$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}HC_SESSION=[\"'\'']\{0,1\}\([^\"'\'' ]*\).*/\2/p" "${c%/*}/dori.env" 2>/dev/null | tail -n 1)
  if [ -n "$core" ]; then export HC_SESSION="$core"; else unset HC_SESSION; fi
  exec 3<&0
  hc attach "$lead" <&3 & a=$!
  while kill -0 "$a" 2>/dev/null; do
    sleep "${DORITERM_LEAD_CHECK_SECONDS:-5}"
    [ "$(leadof)" = "$lead" ] || { kill "$a" 2>/dev/null; break; }
  done
  wait "$a" 2>/dev/null
  exit 0
fi
DORI_CONFIG=$c "$HOME/.bun/bin/bun" "$HOME/.dori/src/skills/dori-mode/setups/doriterm/focus-lead.ts" || echo "doriterm: the lead tab was not focused; attaching anyway" >&2
exec herdr client'
while :; do
  if [ -n "$account" ]; then
    sudo -n -u "$account" -H /bin/sh -c "$env$attach"
  else
    /bin/sh -c "$attach"
  fi
  sleep "${DORITERM_RETRY_SECONDS:-5}"
done
