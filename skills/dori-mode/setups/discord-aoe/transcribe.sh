#!/usr/bin/env bash
# hooks.transcribe for `dori transcribe` and `dori inbound discord`: audio file or URL in, text out.
# Short audio (a voice note) gives one line. Audio of DORI_ASR_DIARIZE_MIN_SEC (300) seconds or more (a meeting) goes
# through transcribe_long.py: repeat-loop repair and one "[hh:mm:ss] 화자N: ..." line per speaker turn.
# Needs what setup-asr.sh installs: a static ffmpeg and whisper.cpp with a ggml model; speaker labels need
# setup-diarize.sh (without it long audio comes out time-stamped, unlabeled).
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
secs=$(( ($(wc -c <"$tmp/a.wav") - 44) / 32000 ))
if [ "$secs" -ge "${DORI_ASR_DIARIZE_MIN_SEC:-300}" ]; then
  DORI_ASR_LANG="$LANG_CODE" DORI_ASR_DIR="$D" \
    python3 -I "$(dirname "${BASH_SOURCE[0]}")/transcribe_long.py" "$cli" "$D/models/$MODEL" "$tmp/a.wav"
  exit
fi
"$cli" -m "$D/models/$MODEL" -l "$LANG_CODE" -nt -np -f "$tmp/a.wav" 2>/dev/null \
  | sed -e 's/^[[:space:]]*//' | tr '\n' ' ' | sed -e 's/[[:space:]]*$//'
echo
