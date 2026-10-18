#!/bin/sh
# dori-gate install (root, once). Puts a sandboxed Dori user behind the gate:
#   system user dori-gate runs gate.py (/opt/dori-gate, owned by the admin user so the lead can update it),
#   /etc/dori-gate holds the config and the rendered firewall, /var/lib/dori-gate the state (tokens, change log),
#   nftables lets the Dori uid out only to the gate ports and the node's SSH, sudoers lets the admin restart the gate.
#
#   sudo sh install.sh --dori yoodori --admin oriclaw --node-ip 192.168.200.12 --staging /home/oriclaw/.dori/state/dori-gate-staging
#   sudo sh install.sh ... --dry-run   (renders and checks everything in a temp dir, changes nothing)
#   sudo sh install.sh --rollback      (firewall table and units off, sudoers line gone; state and code kept)
#
# The staging dir (admin-owned, 0700) carries config.json and the state files (client_secret.json,
# owner-proof-token, google-token.json, changes.jsonl ...). They are moved into the state dir and removed from it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
dori=""; admin=""; node_ip=""; staging=""; rollback=0; dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dori) dori=$2; shift 2 ;;
    --admin) admin=$2; shift 2 ;;
    --node-ip) node_ip=$2; shift 2 ;;
    --staging) staging=$2; shift 2 ;;
    --rollback) rollback=1; shift ;;
    --dry-run) dry=1; shift ;;
    *) echo "GATE_INSTALL_FAIL unknown argument $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || [ "$dry" = 1 ] || { echo "GATE_INSTALL_FAIL run with sudo" >&2; exit 2; }

if [ "$rollback" = 1 ]; then
  systemctl disable --now dori-gate-summary.timer dori-gate-nft.service dori-gate-nft-early.service dori-gate.service 2>/dev/null || true
  nft delete table inet dori_gate 2>/dev/null || true
  rm -f /etc/sudoers.d/dori-gate
  echo "GATE_ROLLBACK_OK (state /var/lib/dori-gate and code /opt/dori-gate kept)"
  exit 0
fi

[ -n "$dori" ] && [ -n "$admin" ] && [ -n "$node_ip" ] && [ -n "$staging" ] || { echo "GATE_INSTALL_FAIL need --dori --admin --node-ip --staging" >&2; exit 2; }
uid=$(id -u "$dori"); admin_uid=$(id -u "$admin")
[ -f "$staging/config.json" ] || { echo "GATE_INSTALL_FAIL $staging/config.json missing" >&2; exit 2; }
command -v nft >/dev/null || [ -x /usr/sbin/nft ] || { echo "GATE_INSTALL_FAIL nft missing" >&2; exit 2; }
ports=$(/usr/bin/python3 -I -c 'import json,sys; l=json.load(open(sys.argv[1]))["listen"]; print(", ".join(str(l[k]) for k in ("connect","google","discord")))' "$staging/config.json")

if [ "$dry" = 1 ]; then
  t=$(mktemp -d)
  render_to() { sed -e "s/@UID@/$uid/g" -e "s/@NODE_IP@/$node_ip/g" -e "s/@PORTS@/$ports/g" -e "s|@SELF_LO@|$1|" "$here/nft/dori-gate.nft.in"; }
  render_to "socket cgroupv2 level 2 \"user.slice/user-$uid.slice\" accept" > "$t/dori-gate-full.nft"
  render_to "# strict: no own-slice sockets" > "$t/dori-gate-strict.nft"
  echo "$admin ALL=(root) NOPASSWD: /usr/bin/systemctl restart dori-gate.service, /usr/bin/systemctl restart dori-gate-nft.service, /usr/sbin/nft list table inet dori_gate" > "$t/sudoers"
  ok=1
  if [ "$(id -u)" = 0 ]; then
    for f in strict full; do nft -c -f "$t/dori-gate-$f.nft" && echo "OK nft $f form parses" || { echo "FAIL nft $f form"; ok=0; }; done
  else echo "SKIP nft -c (needs root)"; fi
  /usr/sbin/visudo -cf "$t/sudoers" >/dev/null && echo "OK sudoers line parses" || { echo "FAIL sudoers"; ok=0; }
  for f in gate.py gatectl.py summary.py; do /usr/bin/python3 -I -m py_compile "$here/$f" 2>/dev/null && echo "OK $f compiles" || { echo "FAIL $f"; ok=0; }; done
  find "$here" -name __pycache__ -prune -exec rm -rf {} +
  for f in client_secret.json owner-bot-token; do [ -s "$staging/$f" ] && echo "OK staging $f" || { echo "FAIL staging $f missing"; ok=0; }; done
  echo "PLAN user dori-gate $(id dori-gate >/dev/null 2>&1 && echo exists || echo new) | /opt/dori-gate (owner $admin) | /etc/dori-gate | /var/lib/dori-gate <- $(ls "$staging" | grep -vx config.json | tr '\n' ' ')"
  echo "PLAN firewall: uid $uid may reach loopback ports $ports, its own slice sockets, $node_ip:22; everything else rejected"
  echo "PLAN units: dori-gate dori-gate-nft-early dori-gate-nft dori-gate-summary.timer; sudoers /etc/sudoers.d/dori-gate"
  rm -rf "$t"
  [ "$ok" = 1 ] && { echo "GATE_DRYRUN_OK (nothing changed)"; exit 0; } || { echo "GATE_DRYRUN_FAIL"; exit 1; }
fi
# 1 user
id dori-gate >/dev/null 2>&1 || useradd --system --home-dir /var/lib/dori-gate --no-create-home --shell /usr/sbin/nologin dori-gate
# 2 code (admin-owned: the lead updates it, then restarts through sudoers)
install -d -o "$admin" -g "$admin" -m 0755 /opt/dori-gate
for f in gate.py gatectl.py summary.py; do install -o "$admin" -g "$admin" -m 0644 "$here/$f" "/opt/dori-gate/$f"; done
# 3 config + firewall (root)
install -d -m 0755 /etc/dori-gate
install -m 0644 "$staging/config.json" /etc/dori-gate/config.json
render() { sed -e "s/@UID@/$uid/g" -e "s/@NODE_IP@/$node_ip/g" -e "s/@PORTS@/$ports/g" -e "s|@SELF_LO@|$1|" "$here/nft/dori-gate.nft.in"; }
render "socket cgroupv2 level 2 \"user.slice/user-$uid.slice\" accept" > /etc/dori-gate/dori-gate-full.nft
render "# strict: no own-slice sockets" > /etc/dori-gate/dori-gate-strict.nft
chmod 0644 /etc/dori-gate/dori-gate-full.nft /etc/dori-gate/dori-gate-strict.nft
nft -c -f /etc/dori-gate/dori-gate-strict.nft
nft -c -f /etc/dori-gate/dori-gate-full.nft
# 4 state
install -d -o dori-gate -g dori-gate -m 0700 /var/lib/dori-gate
for f in "$staging"/*; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in config.json) continue ;; esac
  install -o dori-gate -g dori-gate -m 0600 "$f" "/var/lib/dori-gate/$(basename "$f")"
done
for d in snapshots pending; do
  [ -d "$staging/$d" ] && { cp -r "$staging/$d" /var/lib/dori-gate/; chown -R dori-gate:dori-gate "/var/lib/dori-gate/$d"; chmod 0700 "/var/lib/dori-gate/$d"; }
done
# 5 units
for u in dori-gate.service dori-gate-nft-early.service dori-gate-nft.service dori-gate-summary.service dori-gate-summary.timer; do
  sed "s/@UID@/$uid/g" "$here/systemd/$u" > "/etc/systemd/system/$u"; chmod 0644 "/etc/systemd/system/$u"
done
# 6 sudoers: the admin may restart the gate, reload the firewall and read it - nothing else
tmp=$(mktemp)
cat > "$tmp" <<EOF
$admin ALL=(root) NOPASSWD: /usr/bin/systemctl restart dori-gate.service, /usr/bin/systemctl restart dori-gate-nft.service, /usr/sbin/nft list table inet dori_gate
EOF
visudo -cf "$tmp" >/dev/null && install -m 0440 "$tmp" /etc/sudoers.d/dori-gate; rm -f "$tmp"
# 7 the admin's temporary gate (same ports) steps aside
runuser -u "$admin" -- env XDG_RUNTIME_DIR="/run/user/$admin_uid" systemctl --user disable --now dori-gate-staging.service 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now dori-gate-nft-early.service dori-gate.service dori-gate-nft.service dori-gate-summary.timer
# 8 checks
ok=1
for u in dori-gate.service dori-gate-nft-early.service dori-gate-nft.service dori-gate-summary.timer; do
  systemctl is-active --quiet "$u" && echo "OK $u active" || { echo "FAIL $u $(systemctl is-active "$u")"; ok=0; }
done
nft list table inet dori_gate | grep -q "socket cgroupv2" && echo "OK firewall full form" || { echo "FAIL firewall not in full form"; ok=0; }
i=0; while ! runuser -u "$dori" -- curl -s -o /dev/null --max-time 3 http://127.0.0.1:"$(echo "$ports" | cut -d, -f2 | tr -d ' ')"/_gate/changes?since=1h; do i=$((i+1)); [ $i -gt 10 ] && break; sleep 1; done
runuser -u "$dori" -- curl -s -o /dev/null --max-time 5 --noproxy '*' https://example.com && { echo "FAIL $dori reached example.com directly"; ok=0; } || echo "OK $dori direct example.com blocked"
runuser -u "$dori" -- curl -s -o /dev/null --max-time 5 --noproxy '*' https://discord.com/api/v10/gateway && { echo "FAIL $dori reached discord.com directly"; ok=0; } || echo "OK $dori direct discord.com blocked"
code=$(runuser -u "$dori" -- curl -s -o /dev/null -w '%{http_code}' --max-time 8 -x "http://127.0.0.1:$(echo "$ports" | cut -d, -f1)" https://example.com || true)
[ "$code" = 000 ] || [ "$code" = 403 ] && echo "OK proxy refuses example.com ($code)" || { echo "FAIL proxy let example.com through ($code)"; ok=0; }
code=$(runuser -u "$dori" -- curl -s -o /dev/null -w '%{http_code}' --max-time 8 -x "http://127.0.0.1:$(echo "$ports" | cut -d, -f1)" https://api.anthropic.com/ || true)
[ "$code" != 000 ] && echo "OK proxy reaches api.anthropic.com ($code)" || { echo "FAIL proxy cannot reach api.anthropic.com"; ok=0; }
[ "$ok" = 1 ] && { find "$staging" -mindepth 1 -delete; echo "GATE_INSTALL_OK"; } || { echo "GATE_INSTALL_CHECK_FAIL (staging kept; undo: sudo sh $0 --rollback)"; exit 1; }
