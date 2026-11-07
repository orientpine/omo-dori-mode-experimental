#!/bin/sh
# Builds the doriterm web app with the WebKit device-key fix (webkit-x25519.patch) and installs it where
# doriterm-web.service serves it: ~/.local/share/doriterm-web/<commit>-<patch sha>, then points `current` at it.
# app.doriterm.com cannot be patched from here, and on an iPhone every browser is WebKit, so until upstream ships the
# fix the phone opens this build (README "Web app").
set -eu
COMMIT="${DORITERM_WEB_COMMIT:-1d5ff01e0a4e182ee6d628a286315ff28c03edda}"
HERE=$(cd "$(dirname "$0")" && pwd)
PATCH="$HERE/webkit-x25519.patch"
DEST="${DORITERM_WEB_DIR:-$HOME/.local/share/doriterm-web}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git clone -q https://github.com/sisyphuslabs/doriterm "$WORK/src"
cd "$WORK/src"
git -c advice.detachedHead=false checkout -q "$COMMIT"
git apply "$PATCH"
bun install --frozen-lockfile
(cd apps/web && bun test src/connection/device-key.test.ts && bun run build)
TAG="$(git rev-parse --short=8 HEAD)-$(sha256sum "$PATCH" | cut -c1-8)"
mkdir -p "$DEST"
rm -rf "$DEST/$TAG.new"
cp -R apps/web/dist "$DEST/$TAG.new"
rm -rf "$DEST/$TAG"
mv "$DEST/$TAG.new" "$DEST/$TAG"
ln -sfn "$TAG" "$DEST/current"
echo "doriterm web $TAG installed at $DEST/current"
