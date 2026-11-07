#!/bin/sh
# The bridge terminal's program. `herdr client` attaches to this account's running herdr server and never starts one;
# it exits when the server is not up yet (a boot where doriface-host comes first) or goes away (a server restart), so
# attach again until the server answers. hc reports the terminal as started either way, so the retry has to live here.
while :; do
  herdr client
  sleep "${DORITERM_RETRY_SECONDS:-5}"
done
