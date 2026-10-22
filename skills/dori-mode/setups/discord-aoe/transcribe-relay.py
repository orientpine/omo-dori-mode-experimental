"""transcribe-relay.py [--worker-src DIR]: every Dori account hands recordings to one transcriber account, files only.

Runs as the queue host's account (unit dori-transcribe-relay, settings from its dori.env): DORI_TRANSCRIBE_WORKER is the
transcriber account, DORI_TRANSCRIBE_FROM the accounts that may ask (space or comma separated; this account itself and
the worker may be among them), DORI_TRANSCRIBE_LEDGER the command the worker runs to print the owner's correction
ledger (empty: none). Accounts are reached through sudo -n -u rules the host already has; no new right is needed.

A request is ~<acct>/outbox/transcribe/<id>.<ext>, written by dori-transcribe. It is read through a helper as that
account (regular file, one link, no symlink, size cap), copied into ~<worker>/transcribe/in/, and transcribed there by
transcribe-job.sh as the worker inside dori heavy (GPU slot, speaker turns, ledger applied). The worker keeps the text in
~<worker>/transcribe/done/<acct>-<id>.txt, so it can look back at it when the owner points out a mistake; the audio copy
is deleted. The text goes back as ~<acct>/inbox/transcribe/<id>.txt (or <id>.err) through a temp name and rename,
mode 0600, and the request is deleted. Log (~/.local/state/dori-transcribe-relay/relay.log): names, bytes, sha256,
seconds and speaker count only, never words.
"""
import getpass
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

MAX_BYTES = 1024 * 2**20
JOB_LIMIT_SEC = 4 * 3600
NAME = re.compile(
    r"^[0-9]+-[0-9]+-[0-9]+\.(ogg|oga|opus|mp3|m4a|aac|wav|flac|webm|mp4|mov|mkv|amr|3gp|wma|caf|aiff)$")
SPEAKER = re.compile(r"^\[\d\d:\d\d:\d\d\] ([^:]{1,30}): ", re.M)
LOG = Path.home() / ".local/state/dori-transcribe-relay/relay.log"
ME = getpass.getuser()

WATCH = r"""
import os, time
d = os.path.expanduser("~/outbox/transcribe")
os.makedirs(d, mode=0o700, exist_ok=True)
os.makedirs(os.path.expanduser("~/inbox/transcribe"), mode=0o700, exist_ok=True)
seen, tick = set(), 0
while True:
    now = {e.name for e in os.scandir(d) if not e.name.startswith(".")}
    for n in sorted(now - seen):
        print(n, flush=True)
    seen, tick = now, tick + 1
    if tick % 30 == 0:
        print("", flush=True)
    time.sleep(1)
"""

READ = r"""
import os, stat, sys
p = os.path.join(os.path.expanduser(sys.argv[1]), sys.argv[2])
try:
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
except FileNotFoundError:
    sys.exit(4)
except OSError:
    sys.exit(3)
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > int(sys.argv[3]):
    sys.exit(3)
with os.fdopen(fd, "rb") as f:
    while b := f.read(1 << 20):
        sys.stdout.buffer.write(b)
"""

PUT = r"""
import os, sys
d = os.path.expanduser(sys.argv[1])
os.makedirs(d, mode=0o700, exist_ok=True)
tmp = os.path.join(d, "." + sys.argv[2] + ".part")
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "wb") as f:
    while b := sys.stdin.buffer.read(1 << 20):
        f.write(b)
req = sys.argv[3] if len(sys.argv) > 3 else ""
if req and not os.path.lexists(os.path.join(os.path.expanduser("~/outbox/transcribe"), req)):
    os.unlink(tmp)
    sys.exit(5)
os.rename(tmp, os.path.join(d, sys.argv[2]))
if req:
    os.unlink(os.path.join(os.path.expanduser("~/outbox/transcribe"), req))
"""

DROP = r"""
import os, sys
try:
    os.unlink(os.path.join(os.path.expanduser(sys.argv[1]), sys.argv[2]))
except FileNotFoundError:
    pass
"""


def as_user(acct):
    if acct == ME:
        return []
    return ["sudo", "-n", "-u", acct, "-H", "--"]


def run_as(acct, code, *args, stdin=None, stdout=subprocess.PIPE, timeout=600):
    return subprocess.run([*as_user(acct), "/usr/bin/python3", "-I", "-c", code, *args], stdin=stdin, stdout=stdout,
                          stderr=subprocess.PIPE, start_new_session=True, timeout=timeout, check=False)


def log(**row):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **row}) + "\n")


def accounts(value):
    return [a for a in re.split(r"[\s,]+", value or "") if a]


class Relay:
    def __init__(self, worker, asking, ledger, src):
        self.worker, self.asking, self.ledger, self.src = worker, asking, ledger, src

    def answer(self, acct, req, name, path):
        with open(path, "rb") as f:
            w = run_as(acct, PUT, "~/inbox/transcribe", name, req, stdin=f)
        if w.returncode == 5:
            log(acct=acct, req=req, event="withdrawn_before_answer")
        elif w.returncode != 0:
            log(acct=acct, req=req, event="answer_failed", code=w.returncode)

    def refuse(self, acct, req, tmp, why):
        err = Path(tmp) / "err"
        err.write_text(f"transcribe relay: {why}\n")
        self.answer(acct, req, req.rsplit(".", 1)[0] + ".err", err)

    def handle(self, acct, req, tmp):
        stem = req.rsplit(".", 1)[0]
        if not NAME.match(req):
            log(acct=acct, req=req, event="refused_name")
            if "." in req:
                self.refuse(acct, req, tmp, "refused file name or type")
            return
        audio = Path(tmp) / req
        with audio.open("wb") as f:
            r = run_as(acct, READ, "~/outbox/transcribe", req, str(MAX_BYTES), stdout=f)
        if r.returncode == 4:
            return log(acct=acct, req=req, event="withdrawn")
        if r.returncode != 0:
            log(acct=acct, req=req, event="refused_read", code=r.returncode)
            return self.refuse(acct, req, tmp, "not a regular file, a link, or larger than 1 GiB")
        data_sha, size = sha256(audio), audio.stat().st_size
        job = f"{acct}-{stem}"
        with audio.open("rb") as f:
            w = run_as(self.worker, PUT, "~/transcribe/in", job + audio.suffix, stdin=f)
        audio.unlink()
        if w.returncode != 0:
            log(acct=acct, req=req, event="handover_failed", code=w.returncode)
            return self.refuse(acct, req, tmp, "could not hand the file to the transcriber")
        home = Path("~" + self.worker).expanduser()
        src = self.src or str(home / ".dori/src/skills/dori-mode/setups/discord-aoe")
        inner = [str(Path(src) / "transcribe-job.sh"), str(home / "transcribe/in" / (job + audio.suffix)),
                 str(home / "transcribe/done" / (job + ".txt")), *self.ledger]
        wrap = ("export XDG_RUNTIME_DIR=/run/user/$(id -u) PATH=$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:"
                "/usr/bin:/bin; exec timeout %d bash \"$@\"" % JOB_LIMIT_SEC)
        t = time.monotonic()
        p = subprocess.run(["dori", "heavy", "transcribe-" + job, "--", *as_user(self.worker), "bash", "-c", wrap,
                            "transcribe-job", *inner], capture_output=True, check=False)
        sec = round(time.monotonic() - t, 1)
        run_as(self.worker, DROP, "~/transcribe/in", job + audio.suffix)
        notes = [l for l in p.stderr.decode(errors="replace").splitlines()
                 if l.startswith(("LEDGER_", "REPEAT_FIXED", "HEAVY_"))]
        out = Path(tmp) / "out.txt"
        if p.returncode == 0:
            with out.open("wb") as f:
                r = run_as(self.worker, READ, "~/transcribe/done", job + ".txt", str(MAX_BYTES), stdout=f)
        if p.returncode != 0 or r.returncode != 0:
            log(acct=acct, req=req, event="transcribe_failed", code=p.returncode, bytes=size, sha256=data_sha, sec=sec)
            tail = p.stderr.decode(errors="replace")[-600:]
            return self.refuse(acct, req, tmp, f"transcription failed (exit {p.returncode}): {tail}")
        text = out.read_text(errors="replace")
        log(acct=acct, req=req, event="done", bytes=size, sha256=data_sha, sec=sec, lines=text.count("\n"),
            speakers=len(set(SPEAKER.findall(text))), txt_sha256=sha256(out), notes=notes)
        self.answer(acct, req, stem + ".txt", out)

    def watch(self, acct, jobs, lock):
        while True:
            h = subprocess.Popen([*as_user(acct), "/usr/bin/python3", "-I", "-u", "-c", WATCH], stdout=subprocess.PIPE,
                                 text=True, start_new_session=True)
            for line in h.stdout:
                if not line.strip():
                    continue
                with lock:
                    jobs.append((acct, line.strip()))
            log(acct=acct, event="watch_restart", code=h.wait())
            time.sleep(5)

    def serve(self):
        jobs, lock = [], threading.Lock()
        for a in self.asking:
            threading.Thread(target=self.watch, args=(a, jobs, lock), daemon=True).start()
        log(event="start", worker=self.worker, accounts=self.asking, ledger=bool(self.ledger))
        while True:
            with lock:
                job = jobs.pop(0) if jobs else None
            if not job:
                time.sleep(0.5)
                continue
            with tempfile.TemporaryDirectory(prefix="dori-transcribe-relay-", dir="/dev/shm") as tmp:
                try:
                    self.handle(*job, tmp)
                except Exception as e:  # one bad request must not stop the queue; logged and answered
                    log(acct=job[0], req=job[1], event="error", reason=f"{type(e).__name__}: {e}"[:300])
                    self.refuse(job[0], job[1], tmp, "relay error, see the queue host's relay.log")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while b := f.read(1 << 20):
            h.update(b)
    return h.hexdigest()


def sweep_stale():
    for old in Path("/dev/shm").glob("dori-transcribe-relay-*"):
        if old.is_dir() and old.owner() == ME:
            shutil.rmtree(old, ignore_errors=True)
            log(event="swept", path=old.name)


def main():
    args = sys.argv[1:]
    src = ""
    if args[:1] == ["--worker-src"] and len(args) == 2:
        src = args[1]
    elif args:
        sys.stderr.write("usage: transcribe-relay.py [--worker-src DIR]\n")
        return 2
    worker = os.environ.get("DORI_TRANSCRIBE_WORKER", "").strip()
    asking = accounts(os.environ.get("DORI_TRANSCRIBE_FROM", ""))
    if not worker or not asking:
        sys.stderr.write("transcribe-relay: set DORI_TRANSCRIBE_WORKER and DORI_TRANSCRIBE_FROM\n")
        return 2
    sweep_stale()
    Relay(worker, asking, shlex.split(os.environ.get("DORI_TRANSCRIBE_LEDGER", "")), src).serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
