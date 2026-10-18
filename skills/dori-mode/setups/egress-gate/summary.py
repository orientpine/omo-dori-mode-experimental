#!/usr/bin/env python3
"""Print a Korean daily change summary, or nothing when there are no changes."""
import argparse
import collections
import datetime as dt
import http.client
import json
import re
from pathlib import Path
from urllib.parse import urlencode, urlsplit


def defang(text: str) -> str:
    """Titles come from the Dori; a link in them would be fetched by Discord for a preview."""
    return re.sub(r"(?i)\b(h)tt(ps?)://", r"\1xx\2[:]//", text)


def window_records(path: Path, cutoff: dt.datetime) -> list:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as stream:
        return [row for line in stream if (row := json.loads(line)) and
                dt.datetime.fromisoformat(row["ts"]) >= cutoff]


def render(changes: list, denials: list, pending: list, hours: float) -> str:
    names = {"calendar": "일정", "tasks": "할 일", "drive": "드라이브",
             "docs": "문서", "obsidian": "노트", "sheets": "시트"}
    lines = [f"최근 {hours:g}시간 변경 {len(changes)}건"]
    counts = collections.Counter((row["api"], row["op"]) for row in changes)
    lines.extend(f"{names.get(api, api)} · {op}: {count}건" for (api, op), count in sorted(counts.items()))
    kst = dt.timezone(dt.timedelta(hours=9))
    for row in changes:
        resource = row["resource"]
        title = resource.get("title") or resource.get("summary") or resource.get("name") or resource.get("id", "")
        stamp = dt.datetime.fromisoformat(row["ts"]).astimezone(kst).strftime("%m-%d %H:%M KST")
        line = f"- {stamp} {row['op']} {defang(str(title))} ({row['status']})"
        if resource.get("link"):
            line += f"\n  {resource['link']}"
        line += f"\n  근거 형 메시지: {row['owner_message']}"
        if row.get("approved_by"):
            line += f"\n  approved_by: {row['approved_by']}"
        if row["restorable"]:
            line += f"\n  되살리기: /_gate/restore/{row['id']}"
        lines.append(line)
    reasons = collections.Counter(row["reason"] for row in denials)
    lines.extend(f"거절 · {reason}: {count}건" for reason, count in sorted(reasons.items()))
    lines.append(f"열린 승인 카드 {len(pending)}건")
    lines.extend(f"- {row['reason']} {row['card']}" for row in pending)
    return "\n".join(lines)


def post_summary(config: dict, hours: float) -> int:
    state = Path(config["state"])
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)
    changes = window_records(state / "changes.jsonl", cutoff)
    denials = window_records(state / "denials.jsonl", cutoff)
    pending = []
    for path in sorted((state / "pending").glob("*.json")):
        row = json.loads(path.read_text())
        if dt.datetime.fromisoformat(row["ts"]) >= cutoff:
            pending.append(row)
    if not changes and not denials and not pending:
        print("SUMMARY_EMPTY")
        return 0
    content = render(changes, denials, pending, hours)
    base = urlsplit(config.get("discord_api_base", "https://discord.com/api/v10"))
    connection_class = http.client.HTTPSConnection if base.scheme == "https" else http.client.HTTPConnection
    authorization = "Bot " + Path(config["owner_proof"]["token_file"]).read_text().strip()
    messages = [content[i:i + 1899] for i in range(0, len(content), 1899)]
    for message in messages:
        connection = connection_class(base.hostname, base.port, timeout=30)
        try:
            body = json.dumps({"content": message, "allowed_mentions": {"parse": []}, "flags": 4}, ensure_ascii=False).encode()
            connection.request("POST", base.path.rstrip("/") +
                               f"/channels/{config['approval']['channel_id']}/messages", body,
                               {"Authorization": authorization, "Content-Type": "application/json"})
            response = connection.getresponse()
            response.read()
            if not 200 <= response.status < 300:
                raise SystemExit(f"summary post returned HTTP {response.status}")
        finally:
            connection.close()
    print(f"SUMMARY_POSTED {len(messages)} messages")
    return len(messages)


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
    print(render(changes, [], [], args.hours))


if __name__ == "__main__":
    main()
