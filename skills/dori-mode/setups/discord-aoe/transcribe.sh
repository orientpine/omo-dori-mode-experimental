#!/usr/bin/env bash
# hooks.transcribe for `dori transcribe` and `dori inbound discord`: audio file or URL in, one line of text out.
# Needs what setup-asr.sh installs: a static ffmpeg and whisper.cpp with a ggml model.
set -euo pipefail
D="${DORI_ASR_DIR:-$HOME/.dori/asr}"
LANG_CODE="${DORI_ASR_LANG:-auto}"
MODEL="${DORI_ASR_MODEL:-ggml-large-v3.bin}"
src="${1:?usage: transcribe.sh <audio file or URL>}"
cli="$D/whisper.cpp/build-cuda/bin/whisper-cli"
[ -x "$cli" ] || cli="$D/whisper.cpp/build/bin/whisper-cli"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [[ "$src" == http* ]]; then curl -fsSL -o "$tmp/in" "$src"; else cp "$src" "$tmp/in"; fi
"$D/bin/ffmpeg" -nostdin -loglevel error -i "$tmp/in" -ar 16000 -ac 1 -c:a pcm_s16le "$tmp/a.wav"
"$cli" -m "$D/models/$MODEL" -l "$LANG_CODE" -nt -np -f "$tmp/a.wav" 2>/dev/null \
  | sed -e 's/^[[:space:]]*//' | tr '\n' ' ' | sed -e 's/[[:space:]]*$//'
echo
