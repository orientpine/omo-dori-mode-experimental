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
# An hc lead is attached with hc attach, so the owner types into it from the row as into a herdr lead's client. Its core is the HC_SESSION in the
# Dori's dori.env, else the default core, never the bridge host's inherited core.
account=${1:-}
env='export XDG_RUNTIME_DIR=/run/user/$(id -u) PATH=$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin; '
attach='c=$HOME/.$(id -un)/config.json; [ -f "$c" ] || c=$HOME/.dori/config.json
e=$HOME/.$(id -un)/dori.env
[ -f "$e" ] || e=$HOME/.dori/dori.env
unset DORI_LEAD_PANE DORI_LEAD_TMUX DORI_LEAD_AOE_ID
resolved=$(DORI_CONFIG=$c DORI_ENV_FILE=$e "$HOME/.bun/bin/bun" "$HOME/.dori/src/skills/dori-mode/scripts/src/hc-lead-core.ts") || exit 1
core=${resolved%% *}
selected=${resolved#* }
case $selected in
  hc:*)
  lead=${selected#hc:}
  echo "doriterm: $(id -un) lead $selected; attaching"
  if [ -n "$core" ]; then
    HC_SESSION=$core
    export HC_SESSION
  else
    unset HC_SESSION
  fi
  unset HC_SOCKET
  exec hc attach "$lead"
  ;;
esac
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
