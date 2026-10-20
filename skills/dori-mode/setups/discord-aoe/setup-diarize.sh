#!/usr/bin/env bash
# Installs speaker labels for long recordings in transcribe.sh: a Python venv with torch and pyannote.audio
# under $DORI_DIAR_DIR/venv and the pyannote/speaker-diarization-community-1 model under $DORI_DIAR_DIR/hf
# (DORI_DIAR_DIR defaults to $DORI_ASR_DIR/diar; set it when the ASR dir is not writable).
# The model is gated: accept its conditions on huggingface.co once, then either run with HF_TOKEN set (the token is
# only used for the download, never stored), or set DORI_DIAR_FROM to a hub cache folder that already holds it.
# Re-running skips what is already there. Run setup-asr.sh first.
set -euo pipefail
D="${DORI_ASR_DIR:-$HOME/.dori/asr}"
X="${DORI_DIAR_DIR:-$D/diar}"
V="$X/venv"
HUB="$X/hf/hub"
REPO=models--pyannote--speaker-diarization-community-1
mkdir -p "$X/bin" "$HUB"

uv=$(command -v uv || true)
if [ -z "$uv" ]; then
  [ -x "$X/bin/uv" ] || curl -4 -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$X/bin" UV_NO_MODIFY_PATH=1 sh
  uv="$X/bin/uv"
fi
if [ ! -x "$V/bin/python" ] || ! "$V/bin/python" -I -c "import pyannote.audio" 2>/dev/null; then
  "$uv" venv --allow-existing -p python3 "$V"
  cuda=cpu; command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1 && cuda=cu129
  "$uv" pip install --link-mode copy --python "$V/bin/python" --index-url "https://download.pytorch.org/whl/$cuda" \
    torch==2.8.0 torchaudio==2.8.0
  "$uv" pip install --link-mode copy --python "$V/bin/python" pyannote.audio==4.0.7
fi

if [ ! -d "$HUB/$REPO/snapshots" ]; then
  if [ -n "${DORI_DIAR_FROM:-}" ]; then
    cp -r "$DORI_DIAR_FROM/$REPO" "$HUB/"
  elif [ -n "${HF_TOKEN:-}" ]; then
    HF_HOME="$X/hf" "$V/bin/python" -I -c '
import os, socket
from huggingface_hub import snapshot_download
real = socket.getaddrinfo
socket.getaddrinfo = lambda h, p, f=0, *a, **k: real(h, p, socket.AF_INET, *a, **k)
snapshot_download("pyannote/speaker-diarization-community-1", token=os.environ["HF_TOKEN"])'
  else
    echo "no model: accept pyannote/speaker-diarization-community-1 on huggingface.co, then re-run with HF_TOKEN=... or DORI_DIAR_FROM=<hub folder holding $REPO>" >&2
    exit 1
  fi
fi

"$V/bin/python" -I -c "import torch, pyannote.audio; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), 'pyannote', pyannote.audio.__version__)"
echo "DIARIZE-SETUP-DONE"
