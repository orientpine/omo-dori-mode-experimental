#!/bin/sh
# Installs omo-login-share for the source account (zzangdori). Re-run after an update.
set -eu
src=$(cd "$(dirname "$0")" && pwd)
dest="$HOME/.local/share/omo-shared-login"
mkdir -p "$dest" "$HOME/.local/bin"
for f in omo-login-share.ts borrow.js remote.js login-method.js; do install -m 0755 "$src/$f" "$dest/$f"; done
ln -sfn "$dest/omo-login-share.ts" "$HOME/.local/bin/omo-login-share"
echo "installed $dest; next: omo-login-share enable"
