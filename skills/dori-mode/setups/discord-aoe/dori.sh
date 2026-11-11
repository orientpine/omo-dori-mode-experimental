#!/usr/bin/env bash
set -euo pipefail
# The account's own files win over an inherited instance, and its config's stateDir over an inherited DORI_STATE_DIR. For an
# hc lead the helper checks its core before dori lead or revive can call hc; a herdr or aoe lead needs no core check. The
# lead is looked up and revived by this checkout's CLI with those same files, never a dori wrapper on PATH that may pick
# another instance's (review 1 of #453).
account_config=$HOME/.$(id -un)/config.json
if [[ -f "$account_config" ]]; then export DORI_CONFIG="$account_config"; else export DORI_CONFIG="$HOME/.dori/config.json"; fi
account_env=$HOME/.$(id -un)/dori.env
if [[ -f "$account_env" ]]; then export DORI_ENV_FILE="$account_env"; else export DORI_ENV_FILE="$HOME/.dori/dori.env"; fi
unset DORI_LEAD_PANE DORI_LEAD_TMUX DORI_LEAD_AOE_ID DORI_STATE_DIR
bun_bin=$HOME/.bun/bin/bun
[[ -x "$bun_bin" ]] || bun_bin=bun
src=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts/src" && pwd)
dori() { "$bun_bin" "$src/cli.ts" "$@"; }
resolved=$("$bun_bin" "$src/hc-lead-core.ts")
core=${resolved%% *}
lead=$(dori lead)
read -r AOE_ID PANE STATE <<< "$lead"
if [[ -z "$AOE_ID" ]]; then
  printf 'dori lead returned no session id\n' >&2
  exit 1
fi
systemctl --user start dori-inbound.service dori-google-watch.service
# aoe without any DORI_*: if it starts the tmux server, every pane inherits that server's environment
unset_dori=$(env | sed -n 's/^\(DORI_[A-Za-z0-9_]*\)=.*/-u \1/p')
# an hc lead attaches through hc in the core its dori.env names, else the default core, not the caller's inherited core
if [[ "${PANE:-}" == hc:* ]]; then
  if [[ "${STATE:-}" == stopped ]]; then dori revive "$PANE" || true; fi
  if [[ -n "$core" ]]; then export HC_SESSION="$core"; else unset HC_SESSION; fi
  unset HC_SOCKET
  # shellcheck disable=SC2086
  exec env $unset_dori hc attach "${PANE#hc:}"
fi
# a herdr lead (dori lead prints "<omo session> <pane>[ stopped]"; only a herdr pane id holds ":"): a stopped one is started
# again in its recorded session, then this attaches herdr's client to the server
if [[ "${PANE:-}" == *:* ]]; then
  if [[ "${STATE:-}" == stopped ]]; then dori revive "$PANE" || true; fi
  # shellcheck disable=SC2086
  exec env $unset_dori herdr
fi
# shellcheck disable=SC2086
env $unset_dori aoe session start "$AOE_ID" >/dev/null 2>&1 || true
# shellcheck disable=SC2086
exec env $unset_dori aoe session attach "$AOE_ID"
