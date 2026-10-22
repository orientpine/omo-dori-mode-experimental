"""transcribe_fixes.py <ledger file>: the owner's correction ledger applied to a transcript, stdin to stdout.

The ledger is CSV (or tab-separated) rows "wrong,right", the same rows as the owner's term glossary; a row with one
column, a "#" comment and the header row are skipped. Pairs whose wrong form has three characters (syllables) or more
are replaced wherever they occur in the spoken words; the "[hh:mm:ss] 화자N: " head of a line is never touched. A
particle right after the word follows the new word's final consonant (은/는, 이/가, 을/를, 과/와, 이랑/랑, 으로/로,
and 로 after a ㄹ ending). Shorter pairs are not applied: a two-syllable wrong form is often an ordinary word, and only a
reader of the context can tell. stderr gets one line, LEDGER_APPLIED pairs=<n> short_skipped=<n> edits=<n>, never words.
"""
import csv
import re
import sys

DIRECT = 3
PARTICLES = (("이랑", "랑"), ("으로", "로"), ("은", "는"), ("이", "가"), ("을", "를"), ("과", "와"))
FORMS = "|".join(sorted({f for pair in PARTICLES for f in pair}, key=len, reverse=True))
END = r"(?=[\s.,?!…)\]\"'」』]|$)"
HEAD = re.compile(r"^\[\d\d:\d\d:\d\d\] [^:]{1,30}: ")
HEADER = ("틀린표기", "올바른표기")


def read_ledger(text):
    pairs, short = {}, 0
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        row = line.split("\t") if "\t" in line else next(csv.reader([line]))
        if len(row) < 2:
            continue
        wrong, right = row[0].strip(), row[1].strip()
        if not wrong or not right or wrong == right or (wrong, right) == HEADER:
            continue
        if len(wrong) < DIRECT:
            short += 1
            continue
        pairs[wrong] = right
    # a longer wrong form first, so a pair inside another one does not cut it
    return sorted(pairs.items(), key=lambda p: len(p[0]), reverse=True), short


def final(ch):
    """None for a non-Hangul syllable, else the final consonant index (0 = none, 8 = ㄹ)."""
    o = ord(ch) - 0xAC00
    return o % 28 if 0 <= o < 11172 else None


def fit(right, particle):
    f = final(right[-1])
    if f is None:
        return particle
    for with_final, without in PARTICLES:
        if particle in (with_final, without):
            if with_final == "으로":
                return without if f in (0, 8) else with_final
            return with_final if f else without
    return particle


def apply(words, ledger):
    edits = 0
    for wrong, right in ledger:
        pattern = re.compile(re.escape(wrong) + "(?:(" + FORMS + ")" + END + ")?")

        def swap(m, right=right):
            return right + (fit(right, m.group(1)) if m.group(1) else "")

        words, n = pattern.subn(swap, words)
        edits += n
    return words, edits


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: transcribe_fixes.py <ledger file> < transcript > corrected\n")
        return 2
    with open(sys.argv[1], encoding="utf-8") as f:
        ledger, short = read_ledger(f.read())
    total, out = 0, []
    for line in sys.stdin.read().splitlines():
        m = HEAD.match(line)
        head = m.group(0) if m else ""
        words, n = apply(line[len(head):], ledger)
        total += n
        out.append(head + words)
    sys.stdout.write("\n".join(out) + ("\n" if out else ""))
    sys.stderr.write(f"LEDGER_APPLIED pairs={len(ledger)} short_skipped={short} edits={total}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
