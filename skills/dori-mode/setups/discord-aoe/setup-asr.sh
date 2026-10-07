#!/usr/bin/env bash
# Installs local speech-to-text for transcribe.sh: a static ffmpeg, whisper.cpp (CUDA when nvcc is present,
# otherwise CPU) and a ggml model. Re-running skips what is already there.
set -euo pipefail
D="${DORI_ASR_DIR:-$HOME/.dori/asr}"
MODEL="${DORI_ASR_MODEL:-ggml-large-v3.bin}"
mkdir -p "$D/bin" "$D/models"
export PATH="/usr/local/cuda/bin:$PATH"

if [ ! -x "$D/bin/ffmpeg" ]; then
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "no static ffmpeg build for $(uname -m); put an ffmpeg binary at $D/bin/ffmpeg" >&2; exit 1 ;;
  esac
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/ff.tar.xz" "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-$arch-static.tar.xz"
  tar -xJf "$tmp/ff.tar.xz" -C "$tmp"
  cp "$tmp"/ffmpeg-*-static/ffmpeg "$D/bin/ffmpeg"
  rm -rf "$tmp"
fi
"$D/bin/ffmpeg" -version | head -1

[ -d "$D/whisper.cpp" ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$D/whisper.cpp"
cd "$D/whisper.cpp"
if command -v nvcc >/dev/null; then
  [ -x build-cuda/bin/whisper-cli ] || {
    cmake -B build-cuda -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=native
    cmake --build build-cuda -j "$(nproc)" --target whisper-cli
  }
else
  [ -x build/bin/whisper-cli ] || {
    cmake -B build -DCMAKE_BUILD_TYPE=Release
    cmake --build build -j "$(nproc)" --target whisper-cli
  }
fi

if [ ! -s "$D/models/$MODEL" ]; then
  curl -fL --retry 3 -o "$D/models/$MODEL.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
  mv "$D/models/$MODEL.part" "$D/models/$MODEL"
fi
echo "ASR-SETUP-DONE"
