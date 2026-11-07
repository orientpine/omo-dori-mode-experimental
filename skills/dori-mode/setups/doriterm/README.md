# doriterm (pilot)

[doriterm](https://doriterm.com) (Sisyphus Labs, AGPL-3.0) puts a machine's terminals in one app on a phone or a
browser: agents grouped by whether they need you, a key bar with Ctrl, Esc and the arrows, web push. Its host,
`doriface-host`, serves herdr-core (`hc`) terminals only; it cannot read herdr 0.9.5 panes, which is what a Dori runs
in. So this setup adds a bridge: one hc terminal running a plain `herdr` client attached to the account's own herdr
server with `herdr client`, the attach-only form (plain `herdr` starts a server when none runs; `herdr client` exits
1 instead). The Dori shows as one row in the app; opening it shows the herdr
TUI reflowed to the phone's width.

Owner decision: card Q522 (2026-11-07 13:27 KST) "짱돌 하나로 시범", a two-week pilot on one account (until 2026-11-21).
`herdr-web` stays as it is.

## Install (one account)

```sh
# the host binary, checked against the release's SHA256SUMS.txt
curl -fsSLO https://github.com/sisyphuslabs/doriterm/releases/download/v0.1.5/doriface-host-linux-arm64
curl -fsSLO https://github.com/sisyphuslabs/doriterm/releases/download/v0.1.5/SHA256SUMS.txt
sha256sum --check --ignore-missing SHA256SUMS.txt
install -m 0755 doriface-host-linux-arm64 ~/.local/bin/doriface-host
# herdr-core: ~/.local/bin/herdr-core plus an hc link; ~/.local/bin/herdr and the herdr server are not touched
~/.local/bin/doriface-host --install-hc
ln -s ~/.dori/src/skills/dori-mode/setups/doriterm/doriface-host.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now doriface-host.service
```

`doriface-host.service` runs the host with its keys in `~/.local/state/doriface-host` (0700, files 0600) and keeps one
encrypted outbound connection to `relay-doriface.omo.dev:443`; it opens no listening port beyond loopback 7766. Its
`ExecStartPost` runs `bridge.ts`, which starts the hc terminal `zzangdori` (`DORITERM_BRIDGE_NAME`) running
`herdr client`, or leaves it if it is already live, or replaces it if it ended. The bridge only attaches: it types
nothing and focuses no pane. hc runs its core as its own systemd user service (`systemd-run`), outside this unit, so
`ExecStopPost` runs `bridge.ts stop`, which stops the core (`hc server stop`; with no core it starts none) and the
bridge client with it. On this account hc exists only for the pilot. The unit drops `HERDR_PANE_ID` and the other pane variables so a unit started from a herdr pane does not pass
the pane's identity to the client.

## Pair a phone

```sh
doriface-host pair --web-origin https://app.doriterm.com --no-qr
```

It prints a one-time link (10 minutes), an 8-character code and the host fingerprint. The owner opens the link on the
phone, compares the ten groups of the fingerprint with the printed ones and taps "They match". The link and code are a
credential: hand them over privately, never in a channel. `doriface-host devices list` shows the paired device.

## Turn it off

```sh
doriface-host devices list
doriface-host devices revoke <id>           # the device is refused at once ("unknown device")
systemctl --user disable --now doriface-host.service   # the relay connection and the bridge client end
```

Stopping the unit stops the hc core and its herdr client (`ExecStopPost`); the herdr server and every agent in it keep
running.
To retire the host identity as well, remove `~/.local/state/doriface-host` after stopping the unit. On the phone, clear
the site data of app.doriterm.com to drop its device key.

## What it trusts

A paired device gets this account's hc, which can run commands and read and write files as the account: treat it as a
shell login. The app's code comes from app.doriterm.com (no integrity pin), and the stock web app only talks to the
public relay; the relay sees connection metadata (who, when, sizes), not terminal content (Noise IK, ChaCha20-Poly1305).
The full review, with source line references, is the doriterm-review lane report
(`~/.dori/qa/doriterm-review/REPORT.md`, `evidence/source-review.md`).

## Tests

`bun test skills/dori-mode/setups/doriterm` runs `bridge.ts` against a fake `hc`: no bridge, a live one, an ended one,
and `stop`. The unit's start and stop were also run under systemd against the real hc (see the PR).
