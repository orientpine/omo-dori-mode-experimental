"""Speaker turns for transcribe_long.py: pyannote speaker-diarization-community-1 on a 16 kHz mono wav.

usage: <diar venv>/bin/python -I diarize.py <in.wav> <out.json>
Writes [[start_s, end_s, "SPEAKER_xx"], ...] (exclusive turns: one speaker at a time). Runs offline from the
model cache setup-diarize.sh filled (HF_HOME, HF_HUB_OFFLINE=1); GPU when torch sees one, else CPU.
"""
import json
import sys
import wave

import numpy as np
import torch
from pyannote.audio import Pipeline


def main() -> int:
    src, out = sys.argv[1], sys.argv[2]
    with wave.open(src) as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    # Audio goes in as a tensor: pyannote's own file decoding (torchcodec) is not needed then.
    waveform = torch.from_numpy(pcm.astype(np.float32) / 32768.0)[None]
    pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1")
    if torch.cuda.is_available():
        pipeline.to(torch.device("cuda"))
    result = pipeline({"waveform": waveform, "sample_rate": rate})
    turns = getattr(result, "exclusive_speaker_diarization", None) or result.speaker_diarization
    rows = [[round(t.start, 3), round(t.end, 3), str(s)] for t, _, s in turns.itertracks(yield_label=True)]
    with open(out, "w") as f:
        json.dump(rows, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
