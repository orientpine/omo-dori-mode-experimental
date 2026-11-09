# doriterm (pilot)

[doriterm](https://doriterm.com) (Sisyphus Labs, AGPL-3.0) puts a machine's terminals in one app on a phone or a
browser: agents grouped by whether they need you, a key bar with Ctrl, Esc and the arrows, web push. Its host,
`doriface-host`, serves herdr-core (`hc`) terminals only; it cannot read herdr 0.9.5 panes, which is what a Dori runs
in. So this setup adds a bridge: one hc terminal running a plain `herdr` client attached to the account's own herdr
server with `herdr client`, the attach-only form (plain `herdr` starts a server when none runs; `herdr client` exits
1 instead). The Dori shows as one row in the app; opening it shows the herdr
TUI reflowed to the phone's width.

Owner decision: card Q522 (2026-11-07 13:27 KST) "짱돌 하나로 시범", a two-week pilot on one account (until 2026-11-21);
widened the same day (2026-11-07 22:28 KST, "모든 도리들도 여기 붙여") to one row per Dori on the host, see "Six Doris"
below. The herdr-web browser terminal that came before it was removed on 2026-11-08 (owner Q22: "doriterm을 쓰면서 더이상
안 쓰게 된 herdr 웹은 없애고"); doriterm is the one way to see the Doris from a phone or a browser.

## Install (one account)

```sh
# the host binary, checked against the release's SHA256SUMS.txt
curl -fsSLO https://github.com/sisyphuslabs/doriterm/releases/download/v0.1.11/doriface-host-linux-arm64
curl -fsSLO https://github.com/sisyphuslabs/doriterm/releases/download/v0.1.11/SHA256SUMS.txt
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
`attach.sh`, or leaves it if it is already live, or replaces it if it ended. `attach.sh` runs `herdr client` again
every 5 seconds (`DORITERM_RETRY_SECONDS`) after it exits, so the bridge attaches once the herdr server is up (a boot
where this unit starts first) and again after a herdr server restart. The bridge only attaches: it types
nothing and focuses no pane. hc runs its core as its own systemd user service (`systemd-run`), outside this unit, so
`ExecStopPost` runs `bridge.ts stop`, which ends and removes only the bridge rows it lists (a row of a bridge's name
counts only when `hc get` shows it runs `attach.sh`; any other or unreadable row is left alone) and leaves the core running:
once the account's own Dori runs on hc, however it chose hc, that core also holds its lead and lanes. With no core running
(no `$XDG_RUNTIME_DIR/herdr-core/<HC_SESSION or default>.sock`) it asks hc nothing, so it starts none. The unit drops `HERDR_PANE_ID` and the other pane variables so a unit started from a herdr pane does not pass
the pane's identity to the client.

## Web app

The phone opens the stock web app at https://app.doriterm.com. On an iPhone every browser, Chrome included, is
WebKit, and WebKit reads a stored X25519 `CryptoKey` back from IndexedDB as `null`
([WebKit bug 312279](https://bugs.webkit.org/show_bug.cgi?id=312279)), so before doriterm v0.1.10 the app made a new
device key on every load and the host refused the phone as an "unknown device" (sisyphuslabs/doriterm#1329). Upstream
fixed it in v0.1.10 (sisyphuslabs/doriterm#1333): the app checks once whether IndexedDB gives a `CryptoKey` back and,
where it does not, keeps the device key as bytes. app.doriterm.com serves that fix. The patched copy this setup served
on `https://<machine>.<tailnet>.ts.net:7780` until then (`web/`, `doriterm-web.service`, #379) is gone. A host that
still runs it turns it off with `systemctl --user disable --now doriterm-web.service` and
`tailscale serve --https=7780 off`, and its phone pairs again on app.doriterm.com, because storage is per origin.

## Pair a phone

```sh
doriface-host pair --web-origin https://app.doriterm.com --no-qr --wait-host 15
```

It prints a one-time link (10 minutes), an 8-character code and the host fingerprint. The owner opens the link on the
phone, compares the ten groups of the fingerprint with the printed ones and taps "They match". The link and code are a
credential: hand them over privately, never in a channel. `doriface-host devices list` shows the paired device.

If a row is gone from the app (its terminal was closed there, or the hc core restarted), `doriterm-bridges.timer`
starts it again within a minute (below); `systemctl --user start doriterm-bridges.service` does it at once, with this
host's list (`bun bridge.ts` alone reads only the environment it is given, without the list: the one `zzangdori` row).

## Six Doris on one host

One paired phone reaches every Dori on the machine: one row per Dori, each a bridge terminal attached to that Dori's
own herdr server. The host runs on one account (here oriclaw, the `zzangdori` row); the other Doris' rows attach as
their own accounts with `sudo -n -u <account> -H` (`attach.sh <account>`), so the herdr servers, sockets and panes
stay each account's and nothing runs on the other accounts beyond the herdr client while a row is open. A new herdr
client opens on the tab its server focused last (a lane, a stray shell), so before each attach `attach.sh` focuses the
lead's tab with the account's own `focus-lead.ts` (this directory) and its Dori config (`~/.<user>/config.json` for an
instance account, else `~/.dori/config.json`). herdr's `tab focus` moves every client of that server; it happens when a
row attaches, not each time it is opened. It needs a
NOPASSWD sudo rule from the host account to each Dori account (the same rule `node-dori-do` uses). No other account
gets a host, a relay connection or a listening port, so an egress-gated account (yoodori's dori-gate) is not widened:
the client only talks to its account's herdr unix socket.

This host's list is local, in `~/.config/doriterm/bridges.env` (`name[:account]`, names 1-32 of a-z 0-9 - _ as hc
requires, in the order the rows are first made):

```sh
mkdir -p ~/.config/doriterm
echo 'DORITERM_BRIDGES="zzangdori okdori:okdori moodori:moodori yoodori:yoodori gongdori:gongdori soodori:soodori"' > ~/.config/doriterm/bridges.env
for f in doriterm-bridges.service doriterm-bridges.timer; do ln -sf ~/.dori/src/skills/dori-mode/setups/doriterm/$f ~/.config/systemd/user/; done
systemctl --user daemon-reload && systemctl --user enable --now doriterm-bridges.timer
systemctl --user restart doriface-host.service   # makes the new rows at once; the paired devices stay paired
```

Without the file the unit makes the one pilot row `zzangdori` as before. `doriface-host.service` makes the rows
when it starts; `doriterm-bridges.timer` runs `bridge.ts` every minute while the host runs (`ExecCondition`: with the
host off it starts no hc core), so a row closed in the app or lost to an hc core restart comes back. `attach.sh`
re-attaches after a Dori's herdr server restarts. A running row keeps the `attach.sh` it started with, and the timer leaves a live row
alone, so a change to `attach.sh` or to the files it runs reaches the rows only on a restart: once every listed
account's `~/.dori/src` has the change (each pulls it on its own `dori-update-pull` timer), run
`systemctl --user restart doriface-host.service` on the host account; the paired devices stay paired. Until then an old
row whose focus file was removed says "the lead tab was not focused" and still attaches. A Dori restarting its service or its lead does not touch its herdr
server, so the row stays. With `loginctl enable-linger` on the host account the units come back after a reboot.

A paired device now reaches every listed account's herdr, where it can type into the lead and lanes and open panes:
the same reach the host account already has through sudo, now from the paired phone. Remove a Dori from the list and
`hc kill <name>` to take its row away. A harmless check that a row's input reaches its herdr: `ctrl+b` shows
herdr's `PREFIX` bar and `Esc` cancels it; neither reaches the pane (Esc outside the prefix bar does).

## Other machines: one mesh

The owner's other machines join this host's doriterm mesh, so they show in the sidebar of the phone already paired here
with no pairing of their own (upstream README, "A mesh of your machines"). Since 2026-11-08 (owner card Q535 "응, 셋 다
붙이기" and "cha(linux)와 kimm(windows pc) doriterm에 붙여줘") the mesh of ori0a83 holds ori4eae (oriclaw), ori644d and
ori4b69 (orisaac, the training sparks) and cha-system-product-name (cha). Each runs doriface-host v0.1.11 for its
architecture (checked against `SHA256SUMS.txt`), `--install-hc`, a plain user unit without this setup's
`ExecStartPost` (those machines run no herdr Dori, so there is no bridge row), and one hc terminal kept alive as a shell:

```sh
hc run --bg --no-parent --keep --name shell -- bash -l
```

To add a machine: on ori0a83 `doriface-host mesh pair --auto --no-qr` (a single-use offer for 10 minutes, admitted
without asking), and on the machine `doriface-host mesh join --from-file <0600 file with the link> --yes --name <name>
--wait-host 15`. The link is a credential like a pairing link: keep it in a 0600 file, never on a command line or in a
channel, and shred it after the join. `doriface-host mesh status` on ori0a83 lists every member as `present`; never
restart ori0a83's host to add one (the phone is paired to it). The Windows PC kimm-cha has no doriface-host build
(v0.1.11 ships linux and mac only), so it joins from inside WSL2.

## Turn it off

```sh
doriface-host devices list
doriface-host devices revoke <id>           # the device is refused at once ("unknown device")
systemctl --user disable --now doriterm-bridges.timer doriface-host.service   # the relay connection and the bridge clients end
```

Stopping the unit ends the bridge rows and their herdr client (`ExecStopPost`); the hc core, the herdr server and every
agent in either keep running.
To retire the host identity as well, remove `~/.local/state/doriface-host` after stopping the unit. On the phone, clear
the site data of app.doriterm.com to drop its device key.

## What it trusts

A paired device gets this account's hc, which can run commands and read and write files as the account: treat it as a
shell login. The app's code comes from app.doriterm.com (no integrity pin), and the stock web app only talks to the
public relay; the relay sees connection metadata (who, when, sizes), not terminal content (Noise IK, ChaCha20-Poly1305).
The full review, with source line references, is the doriterm-review lane report
(`~/.dori/qa/doriterm-review/REPORT.md`, `evidence/source-review.md`).

## Tests

`bun test skills/dori-mode/setups/doriterm` runs `bridge.ts` against a fake `hc` (no bridge, a live one, an ended one,
`stop`, a list of rows with accounts, a malformed list), `attach.sh <account>` against a fake `sudo`, `attach.sh` against a fake `herdr` whose server answers only on the third try, and `focus-lead.ts` against a fake herdr runner. The unit's start and stop were also run under systemd against the real hc (see the PR).
