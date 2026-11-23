#!/usr/bin/env python3
"""Print a Korean daily change summary, or nothing when there are no changes."""
import argparse
import collections
import datetime as dt
import http.client
import json
import re
import secrets
from pathlib import Path
from urllib.parse import urlencode, urlsplit


def defang(text: str) -> str:
    """Titles come from the Dori; a link in them would be fetched by Discord for a preview."""
    return re.sub(r"(?i)\b(h)tt(ps?)://", r"\1xx\2[:]//", text)


# Credential shapes a title or path could carry (Discord bot, Google access/refresh, Slack, GitHub tokens).
SECRET = re.compile(r"[\w-]{23,28}\.[\w-]{6}\.[\w-]{27,}|ya29\.[\w.-]+|1//[\w-]{20,}|xox[abprs]-[\w-]+|gh[pousr]_\w{20,}")


def redact(text: str, *known: str) -> str:
    """The post and its attachment are read by people: never a credential, the gate's own bot token first."""
    for secret in known:
        if secret:
            text = text.replace(secret, "[가림]")
    return SECRET.sub("[가림]", text)


def window_records(path: Path, cutoff: dt.datetime) -> list:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as stream:
        return [row for line in stream if (row := json.loads(line)) and
                dt.datetime.fromisoformat(row["ts"]) >= cutoff]


KST = dt.timezone(dt.timedelta(hours=9))
NAMES = {"calendar": "일정", "tasks": "할 일", "drive": "드라이브",
         "docs": "문서", "obsidian": "노트", "sheets": "시트", "forms": "폼"}
REASONS = {"owner-message-write-limit": "근거 글당 쓰기 한도", "owner-message-required": "근거 글 없음",
           "delete-rate-limit": "삭제 속도 한도", "drive-sharing": "드라이브 공유", "drive-comments": "드라이브 댓글",
           "drive-not-owned": "남의 드라이브", "external-attendee": "바깥 참석자", "spreadsheet-write": "시트 쓰기"}
TEST_TITLE = re.compile(r"게이트\s*시험|gate[ -]?test", re.IGNORECASE)
NO_TITLE = "제목 없음"
JOB_LINES = 5
WAIT_LINES = 3
MESSAGE_LIMIT = 1900
MESSAGE_LINK = re.compile(r"https://discord\.com/channels/(?:\d+|@me)/(\d+)/(\d+)")
# A refused write is a write request the gate turned down. CONNECT tunnels (a Dori tool calling a host off
# the allow list), reads, and upstreams that did not answer stay in denials.jsonl but are not writes.
NOT_WRITES = {"GET", "HEAD", "CONNECT"}
UPSTREAM_FAILURES = {"request-failed", "upstream-unavailable", "upstream-check-failed",
                     "upstream-response-too-large", "connect-upstream-unreachable", "node-gate-unavailable"}


def refused_writes(denials: list) -> list:
    return [row for row in denials
            if row.get("method") not in NOT_WRITES and row.get("reason") not in UPSTREAM_FAILURES]


def verb(row: dict) -> str:
    op = row["op"]
    if op.startswith("restore."):
        return "되살림"
    if op.startswith("permissions."):
        return "공유"
    if op.startswith("comments."):
        return "댓글"
    if row.get("delete") or op.endswith(".delete"):
        return "삭제"
    if op.endswith((".insert", ".create", ".copy")):
        return "추가"
    return "수정"


def title_of(row: dict, snapshot_title=None) -> str:
    resource = row.get("resource") or {}
    title = resource.get("title") or resource.get("summary") or resource.get("name") or row.get("title")
    if not title and snapshot_title:
        title = snapshot_title(row)
    title = " ".join(str(title or NO_TITLE).split())
    return title.rsplit("/", 1)[-1].removesuffix(".md") if row["api"] == "obsidian" else title


def short(text: str, width: int = 20) -> str:
    return text if len(text) <= width else text[:width - 1] + "…"


def by_kind(rows: list, verbs_shown: bool = True) -> str:
    """일정 4(추가 3·수정 1) · 할 일 1 - kinds by count, verbs inside when more than one."""
    kinds = collections.defaultdict(collections.Counter)
    for row in rows:
        kinds[row["api"]][verb(row)] += 1
    parts = []
    for api, verbs in sorted(kinds.items(), key=lambda item: (-sum(item[1].values()), item[0])):
        part = f"{NAMES.get(api, api)} {sum(verbs.values())}"
        if verbs_shown and len(verbs) > 1:
            part += "(" + "·".join(f"{v} {n}" for v, n in verbs.most_common()) + ")"
        parts.append(part)
    return " · ".join(parts)


def what(rows: list) -> str:
    kinds = collections.defaultdict(collections.Counter)
    for row in rows:
        kinds[row["api"]][verb(row)] += 1
    return " · ".join(f"{NAMES.get(api, api)} " + "·".join(f"{v} {n}건" for v, n in verbs.most_common())
                      for api, verbs in sorted(kinds.items(), key=lambda item: -sum(item[1].values())))


def source(link, today=None) -> str:
    """근거 글 <#thread> 17:53: Discord shows the thread's name; the message link is in the attachment."""
    match = MESSAGE_LINK.fullmatch(str(link or ""))
    if not match:
        return ""
    sent = dt.datetime.fromtimestamp(((int(match[2]) >> 22) + 1420070400000) / 1000, KST)
    today = today or dt.datetime.now(KST).date()
    return f"근거 글 <#{match[1]}> " + sent.strftime("%H:%M" if sent.date() == today else "%m-%d %H:%M")


def folders(row: dict) -> tuple:
    return tuple(folder.get("id", "") for folder in row.get("folders") or [] if isinstance(folder, dict))


def job_key(row: dict) -> tuple:
    """One job: a batch card's writes, or one owner message's writes of one kind into the same folders."""
    if row.get("batch"):
        return ("batch", row["batch"])
    return ("message", row.get("owner_message") or "", row["api"], folders(row))


def jobs(rows: list, key=job_key) -> list:
    grouped = collections.defaultdict(list)
    for row in sorted(rows, key=lambda row: row["ts"]):
        grouped[key(row)].append(row)
    return list(grouped.values())


def where(rows: list, batch_titles: dict) -> str:
    first = rows[0]
    if first.get("batch"):
        return f"묶음 「{defang(short(batch_titles.get(first['batch']) or first['batch'], 24))}」"
    names = [folder.get("name") or folder.get("id", "") for folder in first.get("folders") or []
             if isinstance(folder, dict)]
    return f"폴더 「{defang(short(', '.join(names), 24))}」" if names else ""


def titles(rows: list, snapshot_title=None) -> str:
    named = [title for row in rows if (title := title_of(row, snapshot_title)) != NO_TITLE]
    if not named:
        return ""
    shown = "·".join(defang(short(title)) for title in named[:2]) if len(rows) == 2 else defang(short(named[0]))
    return shown + (f" 외 {len(rows) - 1}건" if len(rows) > 2 or len(rows) == 2 and len(named) < 2 else "")


def job_line(rows: list, snapshot_title, batch_titles: dict, today) -> str:
    parts = [what(rows), where(rows, batch_titles), titles(rows, snapshot_title),
             source(rows[0].get("owner_message"), today)]
    return "- " + " · ".join(part for part in parts if part)


def wait_key(entry: dict) -> tuple:
    return (entry.get("owner_message") or "", entry.get("api", ""), entry.get("reason", ""))


def wait_line(entries: list, today) -> str:
    first = entries[0]
    reasons = "·".join(REASONS.get(reason, reason) for reason in str(first.get("reason", "")).split(",") if reason)
    parts = ["승인 기다림 " + what(entries), reasons, source(first.get("owner_message"), today)]
    return "- " + " · ".join(part for part in parts if part)


def batch_wait_line(batch: dict, today) -> str:
    parts = [f"승인 기다림 묶음 「{defang(short(str(batch.get('title') or batch.get('id', '')), 24))}」 "
             f"{len(batch.get('items') or [])}개", source(batch.get("owner_message"), today)]
    return "- " + " · ".join(part for part in parts if part)


def render(changes: list, denials: list, pending: list, hours: float, name: str = "",
           snapshot_title=None, batches=(), batch_titles=None, today=None,
           job_lines: int = JOB_LINES, wait_lines: int = WAIT_LINES) -> str:
    """One phone-sized post: a line per job (kind, batch or folder, titles, the owner message it came from)
    and a line per group of waiting cards; every row, link and restore ID goes in the attachment (details)."""
    final = name and 0xAC00 <= ord(name[-1]) <= 0xD7A3 and (ord(name[-1]) - 0xAC00) % 28
    who = f"{name}{'이' if final else '가'} " if name else ""
    span = "오늘" if hours == 24 else f"최근 {hours:g}시간"
    batch_titles = batch_titles or {}
    done = [row for row in changes if 200 <= row["status"] < 300]
    failed = len(changes) - len(done)
    tests = [row for row in done if TEST_TITLE.search(title_of(row, snapshot_title))]
    real = [row for row in done if row not in tests]
    lines = [f"{span} {who}바꾼 것 {len(done)}건"]
    groups = jobs(real)
    lines.extend(job_line(rows, snapshot_title, batch_titles, today) for rows in groups[:job_lines])
    if len(groups) > job_lines:
        rest = groups[job_lines:]
        lines.append(f"- 외 {len(rest)}묶음 {sum(len(rows) for rows in rest)}건")
    if tests:
        lines.append(f"게이트 시험 {len(tests)}건({by_kind(tests, False).replace(' · ', '·')})")
    restorable = sum(1 for row in done if row["restorable"] and verb(row) == "삭제")
    if restorable:
        lines.append(f"되살릴 수 있음 {restorable}건")
    refused = len(refused_writes(denials))
    waiting = len(pending) + len(batches)
    others = [text for count, text in ((failed, f"실패 {failed}건"), (refused, f"막힌 쓰기 {refused}건"),
                                       (waiting, f"승인 기다림 {waiting}건")) if count]
    if others:
        lines.append(" · ".join(others))
    waits = [wait_line(entries, today) for entries in jobs(pending, wait_key)]
    waits += [batch_wait_line(batch, today) for batch in batches]
    lines.extend(waits[:wait_lines])
    if len(waits) > wait_lines:
        lines.append(f"- 승인 기다림 외 {len(waits) - wait_lines}묶음")
    lines.append("자세한 목록은 첨부 파일")
    return "\n".join(lines)


def message(*args, **kwargs) -> str:
    """render(), with fewer job and waiting lines until it fits one Discord message."""
    jobs_shown, waits_shown = JOB_LINES, WAIT_LINES
    while True:
        content = render(*args, **kwargs, job_lines=jobs_shown, wait_lines=waits_shown)
        if len(content) <= MESSAGE_LIMIT or jobs_shown == waits_shown == 0:
            return content[:MESSAGE_LIMIT]
        if jobs_shown:
            jobs_shown -= 1
        else:
            waits_shown -= 1


def target(row: dict) -> str:
    """A refused request names its host only, unless it is a Google API path (resource ids) or a Discord API
    path (safe_path already masks webhook and interaction tokens): other services carry capabilities in the
    path, and safe_path strips only queries."""
    path = str(row.get("path", ""))
    host = path.lstrip("/").split("/", 1)[0]
    return path if row.get("port") == "discord" or host.endswith(".googleapis.com") else host


def stamp(ts: str) -> str:
    return dt.datetime.fromisoformat(ts).astimezone(KST).strftime("%m-%d %H:%M")


def change_item(row: dict, snapshot_title=None, with_folders=False) -> str:
    resource = row.get("resource") or {}
    parts = [f"{stamp(row['ts'])} {verb(row)} {NAMES.get(row['api'], row['api'])} {row['op']}",
             defang(title_of(row, snapshot_title)), "성공" if 200 <= row["status"] < 300 else f"실패 HTTP {row['status']}"]
    if resource.get("link"):
        parts.append(resource["link"])
    elif resource.get("id"):
        parts.append("id " + str(resource["id"]))
    if with_folders:
        parts += [f"폴더 {defang(str(folder.get('name') or ''))} (id {folder.get('id', '')})"
                  for folder in row.get("folders") or [] if isinstance(folder, dict)]
    if row.get("approved_by"):
        parts.append("승인 카드 " + str(row["approved_by"]))
    if row.get("restorable") and 200 <= row["status"] < 300:
        parts.append(f"되살리기 POST /_gate/restore/{row['id']}")
    return "- " + " · ".join(parts)


def details(changes: list, denials: list, pending: list, hours: float, name: str = "", snapshot_title=None,
            batches=(), batch_titles=None, now=None) -> str:
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(KST)
    batch_titles = batch_titles or {}
    lines = [f"# {name + ' ' if name else ''}바깥 쓰기 상세 · {now:%Y-%m-%d %H:%M} KST까지 {hours:g}시간", ""]
    tests = [row for row in changes if 200 <= row["status"] < 300 and TEST_TITLE.search(title_of(row, snapshot_title))]
    for heading, rows in ((f"바꾼 것 {len(changes) - len(tests)}건", [r for r in changes if r not in tests]),
                          (f"게이트 시험 {len(tests)}건", tests)):
        if not rows:
            continue
        lines += [f"## {heading}", ""]
        for group in jobs(rows):
            first = group[0]
            lines.append(f"### {' · '.join(p for p in (what(group), where(group, batch_titles)) if p)}")
            if first.get("batch"):
                lines.append(f"- 묶음 id {first['batch']}")
            else:
                lines += [f"- 폴더 {defang(str(folder.get('name') or ''))} (id {folder.get('id', '')})"
                          for folder in first.get("folders") or [] if isinstance(folder, dict)]
            lines.append(f"- 근거 글 {first.get('owner_message') or '없음'}")
            lines += [change_item(row, snapshot_title, bool(first.get("batch"))) for row in group] + [""]
    refused = refused_writes(denials)
    if refused:
        lines += [f"## 막힌 쓰기 {len(refused)}건", ""]
        lines += [f"- {stamp(row['ts'])} {row.get('method', '')} {target(row)} · "
                  f"{REASONS.get(row.get('reason', ''), row.get('reason', ''))} ({row.get('reason', '')})"
                  for row in sorted(refused, key=lambda row: row["ts"])] + [""]
    if pending or batches:
        lines += [f"## 승인 기다림 {len(pending) + len(batches)}건", ""]
        for group in jobs(pending, wait_key):
            first = group[0]
            lines += [f"### {what(group)} · {first.get('reason', '')}", f"- 근거 글 {first.get('owner_message') or '없음'}"]
            lines += [f"- {stamp(entry['ts'])} {entry.get('op', '')} · {defang(title_of(entry))} · 카드 {entry.get('card', '')}"
                      for entry in group] + [""]
        for batch in batches:
            lines += [f"### 묶음 「{defang(str(batch.get('title') or ''))}」 {len(batch.get('items') or [])}개",
                      f"- 근거 글 {batch.get('owner_message') or '없음'}",
                      f"- {stamp(batch['ts'])} 카드 {batch.get('card', '')}"]
            states = batch.get("state") or []
            lines += [f"- {item.get('kind', '')} " + " · ".join(f"{key} {defang(str(value))}" for key, value in item.items()
                                                                if key != "kind")
                      + (f" ({states[index]})" if index < len(states) else "")
                      for index, item in enumerate(batch.get("items") or []) if isinstance(item, dict)] + [""]
    return "\n".join(lines).rstrip() + "\n"


def multipart(payload: dict, filename: str, data: bytes) -> tuple[bytes, str]:
    boundary = "gate-summary-" + secrets.token_hex(12)
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n"
            "Content-Type: application/json\r\n\r\n").encode() + json.dumps(payload, ensure_ascii=False).encode()
    body += (f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"{filename}\"\r\n"
             "Content-Type: text/markdown; charset=utf-8\r\n\r\n").encode() + data
    body += f"\r\n--{boundary}--\r\n".encode()
    return body, "multipart/form-data; boundary=" + boundary


def post_summary(config: dict, hours: float) -> int:
    state = Path(config["state"])
    now = dt.datetime.now(dt.timezone.utc)
    cutoff = now - dt.timedelta(hours=hours)
    changes = window_records(state / "changes.jsonl", cutoff)
    denials = window_records(state / "denials.jsonl", cutoff)
    pending = []
    for path in sorted((state / "pending").glob("*.json")):
        row = json.loads(path.read_text())
        # A card merged into a batch card waits on that card, not on its own.
        if row.get("status", "pending") == "pending" and dt.datetime.fromisoformat(row["ts"]) >= cutoff:
            pending.append(row)
    batch_titles, batches = {}, []
    for path in sorted((state / "batches").glob("*.json")):
        batch = json.loads(path.read_text())
        batch_titles[batch.get("id")] = str(batch.get("title") or "")
        if batch.get("status") == "pending" and dt.datetime.fromisoformat(batch["ts"]) >= cutoff:
            batches.append(batch)
    if not changes and not refused_writes(denials) and not pending and not batches:
        print("SUMMARY_EMPTY")
        return 0
    def snapshot_title(row: dict) -> str:
        """A delete returns no body; its title is in the snapshot taken before it."""
        try:
            data = json.loads((state / row["snapshot"]).read_text())
        except (KeyError, TypeError, OSError, ValueError):
            return ""
        return str(data.get("title") or data.get("summary") or data.get("name") or "") if isinstance(data, dict) else ""

    name = config.get("dori_name", "")
    content = message(changes, denials, pending, hours, name, snapshot_title, batches, batch_titles,
                      now.astimezone(KST).date())
    attachment = details(changes, denials, pending, hours, name, snapshot_title, batches, batch_titles, now)
    filename = f"gate-summary-{now.astimezone(KST):%Y-%m-%d}.md"
    base = urlsplit(config.get("discord_api_base", "https://discord.com/api/v10"))
    connection_class = http.client.HTTPSConnection if base.scheme == "https" else http.client.HTTPConnection
    token = Path(config["owner_proof"]["token_file"]).read_text().strip()
    authorization = "Bot " + token
    content, attachment = redact(content, token), redact(attachment, token)
    body, content_type = multipart({"content": content, "allowed_mentions": {"parse": []}, "flags": 4,
                                    "attachments": [{"id": 0, "filename": filename}]}, filename, attachment.encode())
    connection = connection_class(base.hostname, base.port, timeout=30)
    try:
        connection.request("POST", base.path.rstrip("/") + f"/channels/{config['approval']['channel_id']}/messages",
                           body, {"Authorization": authorization, "Content-Type": content_type})
        response = connection.getresponse()
        response.read()
        if not 200 <= response.status < 300:
            raise SystemExit(f"summary post returned HTTP {response.status}")
    finally:
        connection.close()
    print(f"SUMMARY_POSTED 1 message + {filename}")
    return 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3129)
    parser.add_argument("--hours", type=float, default=24)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--post", action="store_true")
    args = parser.parse_args()
    if args.hours <= 0:
        parser.error("--hours must be positive")
    if args.post:
        if not args.config:
            parser.error("--post requires --config")
        post_summary(json.loads(args.config.read_text()), args.hours)
        return
    connection = http.client.HTTPConnection("127.0.0.1", args.port, timeout=30)
    try:
        connection.request("GET", "/_gate/changes?" + urlencode({"since": f"{args.hours}h"}))
        response = connection.getresponse()
        if response.status != 200:
            raise SystemExit(f"gate returned HTTP {response.status}")
        changes = json.loads(response.read())
    finally:
        connection.close()
    if not changes:
        return
    print(redact(message(changes, [], [], args.hours)))
    print()
    print(redact(details(changes, [], [], args.hours)), end="")


if __name__ == "__main__":
    main()
