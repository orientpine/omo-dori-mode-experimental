#!/usr/bin/env bash
# transcribe-job.sh <audio> <out.txt> [ledger command ...]: one handed-over recording, run as the transcriber account by
# transcribe-relay.py inside dori heavy. A handed-over file is a recording, never a quick voice note, so it always gets
# speaker turns ([hh:mm:ss] 화자N: lines, DORI_ASR_DIARIZE_MIN_SEC=0). The ledger command (the owner's correction
# ledger, "wrong,right" rows on stdout) runs as this account; its pairs go through transcribe_fixes.py. A ledger that
# cannot be read leaves the transcript as heard and says LEDGER_UNAVAILABLE on stderr.
set -euo pipefail
src="${1:?usage: transcribe-job.sh <audio> <out.txt> [ledger command ...]}"
out="${2:?usage: transcribe-job.sh <audio> <out.txt> [ledger command ...]}"
shift 2
here="$(dirname "${BASH_SOURCE[0]}")"
envf="$HOME/.$USER/dori.env"
[ -f "$envf" ] || envf="$HOME/.dori/dori.env"
if [ -f "$envf" ]; then
  while IFS= read -r line; do
    case "$line" in
      DORI_ASR_DIR=* | DORI_ASR_LANG=* | DORI_ASR_MODEL=* | DORI_DIAR_DIR=*)
        v="${line#*=}"; v="${v#[\"\']}"; v="${v%[\"\']}"
        export "${line%%=*}=$v" ;;
    esac
  done <"$envf"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
DORI_ASR_DIARIZE_MIN_SEC=0 bash "$here/transcribe.sh" "$src" >"$tmp/heard.txt"
: >"$tmp/ledger.csv"
if [ $# -gt 0 ]; then
  rc=0
  "$@" >"$tmp/ledger.csv" 2>/dev/null || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "LEDGER_UNAVAILABLE exit $rc" >&2
    : >"$tmp/ledger.csv"
  fi
fi
python3 -I "$here/transcribe_fixes.py" "$tmp/ledger.csv" <"$tmp/heard.txt" >"$tmp/out.txt"
mkdir -p -m 700 "$(dirname "$out")"
install -m 600 "$tmp/out.txt" "$out"
