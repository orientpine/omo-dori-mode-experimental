#!/usr/bin/env bash
# Tools a dori heavy helper offers to `dori heavy --kind ...` runs, in the helper account's own space (no sudo, no system
# package), under ~/.local/share/dori-heavy/tools, which the box mounts read-only at /run/dori-tools/tools with its bin
# on PATH. Playwright browsers for browser tests are not here: the helper installs the caller's playwright version on
# demand into its own ~/.cache/ms-playwright. bun is the helper's own.
#   tools.sh [tools dir]            a static ffmpeg and ffprobe in bin/        prints TOOLS_OK <dir> <ffmpeg version line>
#   tools.sh rv <tag> [tools dir]   the tool bundle "rv", which a job asks for with dori heavy --tools rv: rv <tag> from
#                                   the public repo (its own scripts/install.sh), a uv that installs only from the bundle's
#                                   wheels (every package rv's `uv run --with` lines name, for the system python3), and
#                                   the chromium of that playwright; bin/rv starts it. Run it again when the rv tag
#                                   changes: it builds the new bundle beside the old one and swaps them when it works.
#                                   prints TOOLS_OK rv <dir>/rv <version> RV_TREE <sha256> <files> playwright <version>
set -euo pipefail

rv_bundle() {
  local tag=$1 dir=$2
  local repo=https://github.com/orientpine/rv-video-tool uv_version=${UV_VERSION:-0.13.7} uvt
  case $(uname -m) in
    aarch64) uvt=uv-aarch64-unknown-linux-gnu ;;
    x86_64) uvt=uv-x86_64-unknown-linux-gnu ;;
    *) echo "TOOLS_FAIL no uv build for $(uname -m)" >&2; exit 2 ;;
  esac
  local b=$dir/rv
  new=$dir/rv.new tmp=$(mktemp -d)
  trap 'rm -rf "$tmp" "$new"' EXIT
  rm -rf "$new"
  mkdir --parents "$new/bin" "$new/uv" "$new/wheels" "$dir/bin"
  # uv, checked against its release's sha256
  curl -fsSL --retry 3 -o "$tmp/$uvt.tar.gz" "https://github.com/astral-sh/uv/releases/download/$uv_version/$uvt.tar.gz"
  curl -fsSL --retry 3 -o "$tmp/uv.sha256" "https://github.com/astral-sh/uv/releases/download/$uv_version/$uvt.tar.gz.sha256"
  (cd "$tmp" && sha256sum -c uv.sha256 >/dev/null) || { echo "TOOLS_FAIL $uvt.tar.gz sha256 does not match" >&2; exit 3; }
  tar -xzf "$tmp/$uvt.tar.gz" -C "$tmp"
  install -m 755 "$tmp/$uvt/uv" "$new/uv/uv"
  # rv: exactly the files of the tag, by the repo's own installer
  curl -fsSL --retry 3 "https://raw.githubusercontent.com/orientpine/rv-video-tool/$tag/scripts/install.sh" | bash -s -- "$repo" "$tag" "$new/rv-video-tool" >&2
  local version tree
  version=$(head -1 "$new/rv-video-tool/VERSION")
  [ "v$version" = "$tag" ] || { echo "TOOLS_FAIL rv $tag says it is version $version" >&2; exit 3; }
  tree=$(bash "$new/rv-video-tool/scripts/verify.sh" "$new/rv-video-tool")
  printf '%s\n' "$version" > "$new/VERSION"
  # the box has no network: uv installs only from these wheels, for the python3 the box runs
  cat > "$new/bin/uv" <<'EOF'
#!/bin/sh
# uv of the dori heavy tool bundle "rv": no network, packages only from the bundle's wheels, the system python3
b=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
export UV_OFFLINE=1 UV_NO_INDEX=1 UV_FIND_LINKS="$b/wheels" UV_PYTHON_DOWNLOADS=never UV_PYTHON="${UV_PYTHON:-/usr/bin/python3}"
exec "$b/uv/uv" "$@"
EOF
  cat > "$new/bin/rv" <<'EOF'
#!/bin/sh
# rv of the dori heavy tool bundle "rv": the bundle's uv first on PATH, the bundle's chromium (HOME is empty in a box)
b=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
if [ -z "${RV_CHROME:-}" ]; then for c in "$b"/ms-playwright/chromium-*/chrome-linux*/chrome; do [ -x "$c" ] && RV_CHROME=$c; done; fi
PATH="$b/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH="$b/ms-playwright"
export PATH RV_CHROME PLAYWRIGHT_BROWSERS_PATH
exec "$b/rv-video-tool/rv" "$@"
EOF
  chmod 755 "$new/bin/uv" "$new/bin/rv"
  local pkgs
  pkgs=$(grep -rhoE -- '--with [A-Za-z0-9_.-]+' "$new/rv-video-tool" | awk '{print $2}' | LC_ALL=C sort -u | tr '\n' ' ')
  [ -n "$pkgs" ] || { echo "TOOLS_FAIL no uv run --with package found in rv $tag" >&2; exit 3; }
  # shellcheck disable=SC2086 # one word per package
  UV_CACHE_DIR="$tmp/cache" "$new/uv/uv" run -q --no-project --python /usr/bin/python3 --with pip python -m pip download -q --only-binary=:all: -d "$new/wheels" $pkgs
  # the chromium of the playwright in the wheels, and an offline check of what rv's uv lines ask for
  local with=() p
  for p in $pkgs; do with+=(--with "$p"); done
  env -i PATH="$new/bin:/usr/bin:/bin" HOME="$tmp/home" PLAYWRIGHT_BROWSERS_PATH="$new/ms-playwright" "$new/bin/uv" run -q --no-project --with playwright python -m playwright install chromium >&2
  local pw
  pw=$(env -i PATH="$new/bin:/usr/bin:/bin" HOME="$tmp/home2" "$new/bin/uv" run -q --no-project "${with[@]}" python -c "import importlib.metadata as m; [__import__(n) for n in ('playwright', 'PIL', 'numpy')]; print(m.version('playwright'))")
  compgen -G "$new/ms-playwright/chromium-*/chrome-linux*/chrome" >/dev/null || { echo "TOOLS_FAIL no chromium in $new/ms-playwright" >&2; exit 3; }
  rm -rf "$b.old"
  if [ -e "$b" ]; then mv "$b" "$b.old"; fi
  mv "$new" "$b"
  rm -rf "$b.old"
  ln -sfn ../rv/bin/rv "$dir/bin/rv"
  echo "TOOLS_OK rv $b $version $tree playwright $pw"
}

if [ "${1:-}" = rv ]; then
  rv_bundle "${2:?usage: tools.sh rv <tag> [tools dir]}" "${3:-$HOME/.local/share/dori-heavy/tools}"
  exit 0
fi

dir=${1:-$HOME/.local/share/dori-heavy/tools}
case $(uname -m) in
  aarch64) arch=linuxarm64 ;;
  x86_64) arch=linux64 ;;
  *) echo "TOOLS_FAIL no static ffmpeg build for $(uname -m)" >&2; exit 2 ;;
esac
base=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest
name=ffmpeg-n8.1-latest-$arch-gpl-8.1.tar.xz
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/$name" "$base/$name"
curl -fsSL --retry 3 -o "$tmp/sums" "$base/checksums.sha256"
grep " $name\$" "$tmp/sums" > "$tmp/want" || { echo "TOOLS_FAIL $name is not in checksums.sha256" >&2; exit 3; }
(cd "$tmp" && sha256sum -c want >/dev/null) || { echo "TOOLS_FAIL $name sha256 does not match" >&2; exit 3; }
tar -xJf "$tmp/$name" -C "$tmp"
mkdir --parents "$dir/bin"
install -m 755 "$tmp"/ffmpeg-*/bin/ffmpeg "$tmp"/ffmpeg-*/bin/ffprobe "$dir/bin/"
echo "TOOLS_OK $dir $("$dir/bin/ffmpeg" -hide_banner -version | head -1)"
