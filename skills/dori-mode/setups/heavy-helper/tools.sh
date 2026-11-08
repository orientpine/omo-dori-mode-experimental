#!/usr/bin/env bash
# Tools a dori heavy helper offers to `dori heavy --kind ...` runs, in the helper account's own space (no sudo, no system
# package), under ~/.local/share/dori-heavy/tools, which the box mounts read-only at /run/dori-tools/tools with its bin
# on PATH. Playwright browsers for browser tests are not here: the helper installs the caller's playwright version on
# demand into its own ~/.cache/ms-playwright. bun is the helper's own.
#   tools.sh [tools dir]            a static ffmpeg and ffprobe in bin/        prints TOOLS_OK <dir> <ffmpeg version line>
#   tools.sh rv <tag|commit> [dir]  the tool bundle "rv", which a job asks for with dori heavy --tools rv, in a new
#                                   generation folder rv-gens/<version>-<time> that is never moved or changed after:
#                                   rv <tag> from the public repo (its own scripts/install.sh), a uv that installs only
#                                   from the bundle's wheels (every package rv's `uv run --with` lines name, for the
#                                   system python3), the same packages in py/ for rv's plain python3 (PYTHONPATH), and
#                                   the chromium of that playwright, and bin/python3, the python3 the packages are for;
#                                   bin/rv starts it (the job's own rv tree when it sent one, DORI_TOOL_TREE_RV), and
#                                   PACKAGES lists the packages, what a job's own tree may ask of this runtime. Run it
#                                   again when the rv tag changes (or to repair one): the links rv@<version> and rv (the
#                                   current version) turn to the new generation only when every step worked; a job keeps
#                                   the generation the helper picked when it admitted it. A commit (7-40 hex digits, an rv
#                                   before its tag) is built from exactly its files as <VERSION>+g<commit>, linked only
#                                   as rv@<VERSION>+g<commit> (and as rv when there is none).
#                                   prints TOOLS_OK rv <generation> <version> RV_TREE <sha256> <files> playwright <version>
#                                   packages <list>
set -euo pipefail

# every uv run --with in a tree, as uv takes it (--with p or --with=p, quoted or not, a comma list), its name only (a
# version after it, or a version-only part of a list, is dropped), read as heavy-tools.ts reads a caller's tree
rv_packages() {
  { grep -rhoE -- "--with([[:space:]]+|=)['\"]?[A-Za-z0-9_.,<>=!~-]+" "$1" || true; } | sed -E "s/^--with([[:space:]]+|=)['\"]?//" | tr ',' '\n' | { grep -E '^[A-Za-z0-9]' || true; } | sed -E 's/^([A-Za-z0-9_.-]+).*/\1/' | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//'
}

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
  local version tree label commit=
  if [[ $tag =~ ^[0-9a-f]{7,40}$ ]]; then
    # a commit (rv before its tag, a branch head): exactly its files and its own VERSION, as <VERSION>+g<commit>
    git clone -q "$repo" "$tmp/src" >&2
    git -C "$tmp/src" cat-file -e "$tag^{commit}" 2>/dev/null || { echo "TOOLS_FAIL no commit $tag in $repo" >&2; exit 3; }
    mkdir "$new/rv-video-tool"
    git -C "$tmp/src" archive "$tag" | tar -x -C "$new/rv-video-tool"
    commit=$(git -C "$tmp/src" rev-parse --short=7 "$tag^{commit}")
    version=$(head -1 "$new/rv-video-tool/VERSION")
    label=$version+g$commit
  else
    # rv: exactly the files of the tag, by the repo's own installer
    curl -fsSL --retry 3 "https://raw.githubusercontent.com/orientpine/rv-video-tool/$tag/scripts/install.sh" | bash -s -- "$repo" "$tag" "$new/rv-video-tool" >&2
    version=$(head -1 "$new/rv-video-tool/VERSION")
    [ "v$version" = "$tag" ] || { echo "TOOLS_FAIL rv $tag says it is version $version" >&2; exit 3; }
    label=$version
  fi
  tree=$(bash "$new/rv-video-tool/scripts/verify.sh" "$new/rv-video-tool")
  printf '%s\n' "$label" > "$new/VERSION"
  # the box has no network: uv installs only from these wheels, for the python3 the box runs
  cat > "$new/bin/uv" <<'EOF'
#!/bin/sh
# uv of the dori heavy tool bundle "rv": no network, packages only from the bundle's wheels, the system python3
b=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
export UV_OFFLINE=1 UV_NO_INDEX=1 UV_FIND_LINKS="$b/wheels" UV_PYTHON_DOWNLOADS=never UV_PYTHON="${UV_PYTHON:-/usr/bin/python3}"
# the chromium of the bundle's playwright, for a job's own uv run --with playwright (the box may name another cache)
export PLAYWRIGHT_BROWSERS_PATH="$b/ms-playwright"
exec "$b/uv/uv" "$@"
EOF
  cat > "$new/bin/rv" <<'EOF'
#!/bin/sh
# rv of the dori heavy tool bundle "rv": the bundle's uv first on PATH, the bundle's chromium (HOME is empty in a box);
# the code is the job's own rv tree when it sent one (DORI_TOOL_TREE_RV), else the bundle's copy
b=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
if [ -z "${RV_CHROME:-}" ]; then for c in "$b"/ms-playwright/chromium-*/chrome-linux*/chrome; do [ -x "$c" ] && RV_CHROME=$c; done; fi
PATH="$b/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH="$b/ms-playwright" PYTHONPATH="$b/py${PYTHONPATH:+:$PYTHONPATH}"
export PATH RV_CHROME PLAYWRIGHT_BROWSERS_PATH PYTHONPATH
exec "${DORI_TOOL_TREE_RV:-$b/rv-video-tool}/rv" "$@"
EOF
  chmod 755 "$new/bin/uv" "$new/bin/rv"
  # rv's plain python3 is the one py/ is for, not another python3 earlier on a box's PATH
  ln -s /usr/bin/python3 "$new/bin/python3"
  local pkgs
  pkgs=$(rv_packages "$new/rv-video-tool")
  [ -n "$pkgs" ] || { echo "TOOLS_FAIL no uv run --with package found in rv $tag" >&2; exit 3; }
  # what a job that sends its own rv tree may ask of this runtime (heavy-tools.ts toolBundles)
  # shellcheck disable=SC2086 # one line per package
  printf '%s\n' $pkgs > "$new/PACKAGES"
  # shellcheck disable=SC2086 # one word per package
  UV_CACHE_DIR="$tmp/cache" "$new/uv/uv" run -q --no-project --python /usr/bin/python3 --with pip python -m pip download -q --only-binary=:all: -d "$new/wheels" $pkgs
  # rv also starts plain python3 on scripts that import these (lib/xfade.py: PIL), which a helper may not have
  # shellcheck disable=SC2086
  UV_CACHE_DIR="$tmp/cache" "$new/uv/uv" pip install -q --python /usr/bin/python3 --no-index --find-links "$new/wheels" --target "$new/py" $pkgs
  mkdir "$tmp/other" && printf '#!/bin/sh\nexit 97\n' > "$tmp/other/python3" && chmod 755 "$tmp/other/python3"
  env -i PATH="$new/bin:$tmp/other:/usr/bin:/bin" PYTHONPATH="$new/py" python3 -c "import sys, PIL, numpy; sys.exit(0 if PIL.__file__.startswith('$new/py/') else 1)" || { echo "TOOLS_FAIL plain python3 on the bundle's PATH does not take PIL from $new/py" >&2; exit 3; }
  # the chromium of the playwright in the wheels, and an offline check of what rv's uv lines ask for
  local with=() p
  for p in $pkgs; do with+=(--with "$p"); done
  env -i PATH="$new/bin:/usr/bin:/bin" HOME="$tmp/home" PLAYWRIGHT_BROWSERS_PATH="$new/ms-playwright" "$new/bin/uv" run -q --no-project --with playwright python -m playwright install chromium >&2
  local pw
  pw=$(env -i PATH="$new/bin:/usr/bin:/bin" HOME="$tmp/home2" "$new/bin/uv" run -q --no-project "${with[@]}" python -c "import importlib.metadata as m; [__import__(n) for n in ('playwright', 'PIL', 'numpy')]; print(m.version('playwright'))")
  compgen -G "$new/ms-playwright/chromium-*/chrome-linux*/chrome" >/dev/null || { echo "TOOLS_FAIL no chromium in $new/ms-playwright" >&2; exit 3; }
  # a job runs from the generation folder the helper resolved when it admitted it: only links move, atomically
  local stamp gen
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  gen=$dir/rv-gens/$label-$stamp
  mkdir --parents "$dir/rv-gens"
  mv "$new" "$gen"
  if [ -e "$dir/rv@$label" ] && [ ! -L "$dir/rv@$label" ]; then mv "$dir/rv@$label" "$dir/rv-gens/$label-unlinked-$stamp"; fi
  ln -sfn "rv-gens/$label-$stamp" "$dir/rv@$label.link-$$"
  mv -Tf "$dir/rv@$label.link-$$" "$dir/rv@$label"
  # a tag becomes the current rv; a commit only gets its own rv@<VERSION>+g<commit>, unless there is no current one
  if [ -z "$commit" ] || [ ! -e "$b" ]; then
    if [ -e "$b" ] && [ ! -L "$b" ]; then mv "$b" "$dir/rv-gens/unversioned-$stamp"; fi
    ln -sfn "rv@$label" "$dir/rv.link-$$"
    mv -Tf "$dir/rv.link-$$" "$b"
    ln -sfn ../rv/bin/rv "$dir/bin/rv"
  fi
  echo "TOOLS_OK rv $gen $label $tree playwright $pw packages $(echo $pkgs)"
}

if [ "${1:-}" = packages ]; then
  rv_packages "${2:?usage: tools.sh packages <tree>}"
  echo
  exit 0
fi
if [ "${1:-}" = rv ]; then
  rv_bundle "${2:?usage: tools.sh rv <tag or commit> [tools dir]}" "${3:-$HOME/.local/share/dori-heavy/tools}"
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
