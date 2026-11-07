#!/bin/sh
# A bridge terminal's program. `herdr client` attaches to a running herdr server and never starts one; it exits when the
# server is not up yet (a boot where doriface-host comes first) or goes away (a server restart), so attach again until
# the server answers. hc reports the terminal as started either way, so the retry has to live here.
# With an account argument it attaches to that account's own herdr server: sudo -n as the account (its HOME, runtime dir
# and PATH, as node-dori-do sets them), so the server, its socket and every pane stay that account's.
account=${1:-}
while :; do
  if [ -n "$account" ]; then
    sudo -n -u "$account" -H /bin/sh -c 'export XDG_RUNTIME_DIR=/run/user/$(id -u) PATH=$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin; exec herdr client'
  else
    herdr client
  fi
  sleep "${DORITERM_RETRY_SECONDS:-5}"
done
