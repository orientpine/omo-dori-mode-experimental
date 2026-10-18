#!/usr/bin/env python3
"""Loopback egress policy, OAuth custody, change journal, and restores."""
from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import datetime as dt
import email.parser
import email.policy
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import sys
import time
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit

BODY_CAP = 25 * 1024 * 1024
HEADER_CAP = 65536
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailer", "transfer-encoding", "upgrade"}
GOOGLE_HOSTS = {"www.googleapis.com", "gmail.googleapis.com", "docs.googleapis.com",
                "tasks.googleapis.com", "sheets.googleapis.com"}
BAD_SCOPES = {"gmail.send", "gmail.compose", "gmail.insert", "gmail.modify",
              "gmail.settings.basic", "gmail.settings.sharing"}
SHEET = "application/vnd.google-apps.spreadsheet"
READS = {"GET", "HEAD"}
# Discord fetches every linked URL to build a preview, so a link in a bot message is a request to that host.
URL = re.compile(r"https?://([^/\s<>\"'`\\)\]|?#]+)", re.I)
DISCORD_URL_ALLOW = ["discord.com", "*.discord.com", "discordapp.com", "*.discordapp.com", "discord.gg",
                     "docs.google.com", "drive.google.com", "calendar.google.com", "www.google.com",
                     "github.com", "*.github.com"]


def ordered(addresses):
    """IPv4 first: on a host without working IPv6 an IPv6 attempt only hangs until its timeout."""
    return sorted(addresses, key=lambda a: a[0] != socket.AF_INET)


def tcp_connect(host: str, port: int, timeout: float) -> socket.socket:
    last: OSError | None = None
    for family, kind, proto, _, address in ordered(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)):
        sock = socket.socket(family, kind, proto)
        sock.settimeout(min(timeout, 5) if family == socket.AF_INET6 else timeout)
        try:
            sock.connect(address)
        except OSError as error:
            last = error
            sock.close()
            continue
        sock.settimeout(timeout)
        return sock
    raise last or OSError("no address")


class PlainUpstream(http.client.HTTPConnection):
    def connect(self):
        self.sock = tcp_connect(self.host, self.port, self.timeout)


class TlsUpstream(http.client.HTTPSConnection):
    def connect(self):
        self.sock = self._context.wrap_socket(tcp_connect(self.host, self.port, self.timeout),
                                              server_hostname=self.host)


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def message_texts(headers: dict, body: bytes) -> list[str]:
    """Every text a Discord write carries: the JSON body, or the non-file parts of a multipart body."""
    if not body:
        return []
    content_type = headers.get("content-type", "application/json")
    raw = [body]
    if content_type.lower().startswith("multipart/"):
        message = email.parser.BytesParser(policy=email.policy.default).parsebytes(
            b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
        raw = [part.get_payload(decode=True) or b"" for part in message.iter_parts() if not part.get_filename()]
    texts = []
    for item in raw:
        text = item.decode("utf-8", "replace")
        try:
            texts.extend(strings(json.loads(text)))
        except ValueError:
            texts.append(text)
    return texts


def defang(text: str) -> str:
    """A title the Dori chose must not become a link the bot posts (Discord would fetch it)."""
    return re.sub(r"(?i)\b(h)tt(ps?)://", r"\1xx\2[:]//", text)


def url_host_allowed(host: str, allowed: list[str]) -> bool:
    host = host.lower().rsplit("@", 1)[-1].split(":", 1)[0].rstrip(".")
    return any(host == name or name.startswith("*.") and host.endswith(name[1:]) for name in allowed)


class Refused(Exception):
    """An intentional boundary rejection; never includes upstream text."""

    def __init__(self, reason: str, status: int = 403):
        super().__init__(reason)
        self.reason = reason
        self.status = status


def utc() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def private_write(path: Path, data: bytes) -> None:
    """Atomically replace a private state file without following symlinks."""
    temporary = path.with_name(path.name + "." + secrets.token_hex(8))
    try:
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def json_object(body: bytes) -> dict:
    try:
        value = json.loads(body or b"{}")
    except (ValueError, UnicodeError):
        raise Refused("invalid-json", 400) from None
    if not isinstance(value, dict):
        raise Refused("json-object-required", 400)
    return value


def clean_path(target: str) -> tuple[str, list[tuple[str, str]]]:
    """Decode once, reject ambiguous routing and never accept absolute form."""
    if not target.startswith("/") or target.startswith("//") or "#" in target:
        raise Refused("invalid-path", 400)
    parts = urlsplit(target)
    path = unquote(parts.path, errors="strict")
    if ("%" in path or "//" in path or "\\" in path
            or any(ord(c) < 33 or ord(c) == 127 for c in path)
            or any(p == ".." for p in path.split("/"))):
        raise Refused("invalid-path", 400)
    return path, parse_qsl(parts.query, keep_blank_values=True)


def safe_path(path: str) -> str:
    """Strip queries and Discord capability tokens from all journal paths."""
    path = path.split("?", 1)[0]
    path = re.sub(r"(/webhooks/\d+/)[^/]+", r"\1[redacted]", path)
    return re.sub(r"(/interactions/\d+/)[^/]+", r"\1[redacted]", path)


def journal_path(path: str, query: list[tuple[str, str]]) -> str:
    query = [(k, v) for k, v in query if k.lower() not in {"key", "access_token"}]
    return path + ("?" + urlencode(query) if query else "")


def google_headers(headers: dict, token: str) -> dict:
    # In particular, never forward method-override or caller credentials.
    return {**{k: v for k, v in headers.items() if k.lower() in {
        "content-type", "accept", "accept-language", "range", "if-match", "if-none-match"}},
        "authorization": "Bearer " + token}


def proc_address(address: str) -> str:
    packed = ipaddress.ip_address(address).packed
    return b"".join(packed[i:i + 4][::-1] for i in range(0, len(packed), 4)).hex().upper()


def caller_uid(peer: tuple, local: tuple, paths: list[str]) -> int | None:
    """Match the caller's socket, including its remote server endpoint."""
    source = f"{proc_address(peer[0])}:{peer[1]:04X}"
    destination = f"{proc_address(local[0])}:{local[1]:04X}"
    for path in paths:
        try:
            with open(path, encoding="ascii") as stream:
                for line in stream:
                    cells = line.split()
                    if len(cells) > 7 and cells[1].upper() == source and cells[2].upper() == destination:
                        return int(cells[7])
        except (OSError, ValueError):
            continue
    return None


def forbidden_scope(scope: str) -> bool:
    return scope == "https://mail.google.com/" or scope.rsplit("/", 1)[-1] in BAD_SCOPES


def hidden_doc_key(value) -> bool:
    if isinstance(value, dict):
        return any(k in {"uri", "insertInlineImage", "replaceImage"} or hidden_doc_key(v)
                   for k, v in value.items())
    return isinstance(value, list) and any(hidden_doc_key(v) for v in value)


async def read_request(reader: asyncio.StreamReader) -> tuple[str, str, dict[str, str], bytes]:
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 30)
    except (asyncio.LimitOverrunError, asyncio.IncompleteReadError):
        raise Refused("invalid-headers", 400) from None
    if len(raw) > HEADER_CAP:
        raise Refused("headers-too-large", 431)
    try:
        lines = raw.decode("ascii").split("\r\n")
        method, target, version = lines[0].split(" ")
    except (ValueError, UnicodeError):
        raise Refused("invalid-request", 400) from None
    if not re.fullmatch(r"[A-Z]+", method) or version != "HTTP/1.1":
        raise Refused("invalid-request", 400)
    headers = {}
    for line in lines[1:-2]:
        if ":" not in line or line.startswith((" ", "\t")):
            raise Refused("invalid-headers", 400)
        name, value = line.split(":", 1)
        name = name.lower()
        if not re.fullmatch(r"[!#$%&'*+\-.^_`|~0-9a-z]+", name) or name in headers:
            raise Refused("invalid-headers", 400)
        if any(ord(c) < 32 and c != "\t" or ord(c) == 127 for c in value):
            raise Refused("invalid-headers", 400)
        headers[name] = value.strip()
    if "transfer-encoding" in headers and "content-length" in headers:
        raise Refused("ambiguous-framing", 400)
    body = bytearray()
    if "transfer-encoding" in headers:
        if headers["transfer-encoding"].lower() != "chunked":
            raise Refused("unsupported-transfer-encoding", 400)
        while True:
            line = await reader.readuntil(b"\r\n")
            try:
                size_text = line[:-2].split(b";", 1)[0]
                if not re.fullmatch(b"[0-9a-fA-F]+", size_text):
                    raise ValueError
                size = int(size_text, 16)
            except ValueError:
                raise Refused("invalid-chunk", 400) from None
            if len(body) + size > BODY_CAP:
                raise Refused("body-too-large", 413)
            if size == 0:
                # Ignore trailer fields; they never alter credentials or routing.
                total = 0
                while True:
                    trailer = await reader.readuntil(b"\r\n")
                    total += len(trailer)
                    if total > HEADER_CAP:
                        raise Refused("headers-too-large", 431)
                    if trailer == b"\r\n":
                        break
                    if b":" not in trailer or trailer.startswith((b" ", b"\t")):
                        raise Refused("invalid-trailers", 400)
                break
            body.extend(await reader.readexactly(size))
            if await reader.readexactly(2) != b"\r\n":
                raise Refused("invalid-chunk", 400)
    else:
        text = headers.get("content-length", "0")
        if not text.isdigit():
            raise Refused("invalid-content-length", 400)
        length = int(text)
        if length > BODY_CAP:
            raise Refused("body-too-large", 413)
        body.extend(await reader.readexactly(length))
    return method, target, headers, bytes(body)


async def reply(writer: asyncio.StreamWriter, status: int, body: bytes, headers=None) -> None:
    headers = headers or {"content-type": "application/json"}
    writer.write(f"HTTP/1.1 {status} {http.client.responses.get(status, 'Response')}\r\n".encode())
    for key, value in headers.items():
        if key.lower() not in HOP | {"content-length"}:
            writer.write(f"{key}: {value}\r\n".encode("latin1"))
    writer.write(f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
    await writer.drain()


CARD_KIND = {"calendar": "일정 초대", "drive": "Drive 공유", "docs": "문서 공유", "gmail": "메일",
             "tasks": "할 일", "obsidian": "노트"}

class Gate:
    """Mutable service state: cached credentials, proofs, and listener ownership."""

    def __init__(self, config: dict):
        self.config = config
        self.state = Path(config["state"])
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state.chmod(0o700)
        (self.state / "snapshots").mkdir(exist_ok=True, mode=0o700)
        (self.state / "snapshots").chmod(0o700)
        self.cache = {}
        self.access = ""
        self.expiry = 0.0
        self.auth_pending = None
        self.servers = {}
        self.connections = set()
        self.tunnels = 0
        self.token_lock = asyncio.Lock()
        self.write_lock = asyncio.Lock()
        self.vault_lock = asyncio.Lock()
        self.approval_lock = asyncio.Lock()
        self.approval_task = None
        (self.state / "pending").mkdir(exist_ok=True, mode=0o700)
        (self.state / "pending").chmod(0o700)

    def cached(self, key):
        entry = self.cache.get(key)
        return entry[1] if entry and entry[0] > time.monotonic() else None

    def remember(self, key, value):
        self.cache[key] = (time.monotonic() + 600, value)
        return value

    def append(self, name: str, value: dict) -> None:
        path = self.state / name
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600),
                       "ab") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(json_bytes(value) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())

    def records(self, name="changes.jsonl", since="24h") -> list:
        try:
            cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=float(since[:-1]))
                      if since.endswith("h") else dt.datetime.fromisoformat(since.replace("Z", "+00:00")))
            if cutoff.tzinfo is None:
                raise ValueError
        except ValueError:
            raise Refused("invalid-since", 400) from None
        path = self.state / name
        if not path.exists():
            return []
        with path.open(encoding="utf-8") as stream:
            return [row for line in stream if (row := json.loads(line))
                    and dt.datetime.fromisoformat(row["ts"]) >= cutoff]

    def deny(self, uid, port, method, path, reason) -> None:
        path = safe_path(path)
        self.append("denials.jsonl", dict(ts=utc(), uid=uid, port=port,
                                         method=method, path=path, reason=reason))
        print(f"GATE_DENY {port} {reason} {method} {path}", file=sys.stderr, flush=True)

    def base(self, host: str) -> str:
        return self.config.get("upstreams", {}).get(host, "https://" + host)

    async def upstream(self, method: str, url: str, headers: dict, body: bytes = b""):
        """No redirects, ambient proxies, or implicit credential forwarding."""
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or parts.username or parts.password:
            raise Refused("invalid-upstream", 502)
        connection_class = TlsUpstream if parts.scheme == "https" else PlainUpstream
        connection = connection_class(parts.hostname, parts.port, timeout=30)
        outgoing = {k: v for k, v in headers.items()
                    if k.lower() not in HOP | {"host", "content-length", "x-dori-owner-message"}}
        outgoing["Connection"] = "close"
        outgoing["Content-Length"] = str(len(body))
        try:
            await asyncio.to_thread(connection.request, method, parts.path + ("?" + parts.query if parts.query else ""),
                                    body=body, headers=outgoing)
            response = await asyncio.to_thread(connection.getresponse)
            return connection, response
        except (OSError, http.client.HTTPException):
            connection.close()
            raise Refused("upstream-unavailable", 502) from None

    async def fetch(self, method: str, url: str, headers=None, body=b"") -> tuple[int, dict, bytes]:
        connection, response = await self.upstream(method, url, headers or {}, body)
        try:
            content = await asyncio.to_thread(response.read, BODY_CAP + 1)
            if len(content) > BODY_CAP:
                raise Refused("upstream-response-too-large", 502)
            return response.status, dict(response.getheaders()), content
        finally:
            connection.close()

    async def fetch_json(self, method, url, headers=None, body=b"") -> dict:
        status, _, content = await self.fetch(method, url, headers, body)
        if not 200 <= status < 300:
            raise Refused("upstream-check-failed", 502)
        return json_object(content)

    def secret(self) -> dict:
        data = json.loads((self.state / "client_secret.json").read_text())
        return data.get("installed", data)

    async def access_token(self) -> str:
        async with self.token_lock:
            if self.access and self.expiry > time.time() + 60:
                return self.access
            path = self.state / "google-token.json"
            if not path.exists():
                raise Refused("google-auth-required", 503)
            token = json.loads(path.read_text())
            secret = self.secret()
            result = await self.fetch_json("POST", secret["token_uri"],
                {"content-type": "application/x-www-form-urlencoded"},
                urlencode(dict(client_id=secret["client_id"], client_secret=secret["client_secret"],
                               refresh_token=token["refresh_token"], grant_type="refresh_token")).encode())
            self.access = result["access_token"]
            self.expiry = time.time() + int(result.get("expires_in", 3600))
            return self.access

    async def google_json(self, path: str) -> dict:
        host, rest = path.lstrip("/").split("/", 1)
        return await self.fetch_json("GET", self.base(host) + "/" + rest,
                                     {"Authorization": "Bearer " + await self.access_token()})

    async def discord_json(self, path: str, authorization: str) -> dict:
        return await self.fetch_json("GET", self.config.get("discord_api_base", "https://discord.com/api/v10")
                                     + path, {"Authorization": authorization})

    async def channel_allowed(self, channel: str, authorization: str, dm: bool = True) -> bool:
        key = ("channel", channel, hashlib.sha256(authorization.encode()).hexdigest(), dm)
        cached = self.cached(key)
        if cached is not None:
            return cached
        data = await self.discord_json("/channels/" + channel, authorization)
        guild = data.get("guild_id")
        if not guild and data.get("parent_id"):
            parent = await self.discord_json("/channels/" + str(data["parent_id"]), authorization)
            guild = parent.get("guild_id")
        allowed = (str(guild) == str(self.config["owner_guild"]) if guild
                   else dm and data.get("type") == 1 and
                   [str(r.get("id")) for r in data.get("recipients", [])] == [str(self.config["owner_id"])])
        return self.remember(key, allowed)

    async def proof(self, headers: dict) -> str:
        reference = headers.get("x-dori-owner-message", "")
        if not re.fullmatch(r"\d+/\d+", reference):
            raise Refused("owner-message-required")
        cached = self.cached(("proof", reference))
        if cached is not None:
            return cached
        channel, message = reference.split("/")
        try:
            authorization = "Bot " + Path(self.config["owner_proof"]["token_file"]).read_text().strip()
            if not await self.channel_allowed(channel, authorization, dm=False):
                raise Refused("owner-message-required")
            data = await self.discord_json(f"/channels/{channel}/messages/{message}", authorization)
            stamp = dt.datetime.fromisoformat(data["timestamp"].replace("Z", "+00:00"))
            age = (dt.datetime.now(dt.timezone.utc) - stamp).total_seconds()
            maximum = self.config["owner_proof"].get("max_age_hours", 24) * 3600
            if str(data["author"]["id"]) != str(self.config["owner_id"]) or age < 0 or age > maximum:
                raise Refused("owner-message-required")
        except (Refused, OSError, ValueError, KeyError, TypeError):
            raise Refused("owner-message-required") from None
        link = f"https://discord.com/channels/{self.config['owner_guild']}/{reference}"
        # The cache must not extend the original message's age allowance.
        self.cache[("proof", reference)] = (time.monotonic() + min(600, maximum - age), link)
        return link

    def owner_attendees(self, data: dict, reasons: list, existing=False) -> None:
        owners = {email.lower() for email in self.config["owner_emails"]}
        attendees = data.get("attendees", [])
        if not isinstance(attendees, list) or any(not isinstance(a, dict) or
                str(a.get("email", "")).lower() not in owners for a in attendees):
            reasons.append("external-attendee")
        if "attachments" in data:
            raise Refused("attachments-not-allowed")
        organizer = data.get("organizer", {})
        if existing and not (organizer.get("self") is True or
                             str(organizer.get("email", "")).lower() in owners):
            reasons.append("foreign-organizer")

    async def calendar_owned(self, calendar: str, reasons: list) -> None:
        key = ("calendar", calendar)
        cached = self.cached(key)
        if cached is not None:
            reasons.extend(cached)
            return
        found = []
        base = "/www.googleapis.com/calendar/v3/"
        data = await self.google_json(base + "users/me/calendarList/" + quote(calendar, safe=""))
        if data.get("accessRole") != "owner":
            found.append("calendar-not-owned")
            self.remember(key, found)
            reasons.extend(found)
            return
        page = ""
        while True:
            acl = await self.google_json(base + "calendars/" + quote(calendar, safe="") + "/acl" + page)
            if any(r.get("scope", {}).get("type") == "default" and
                   r.get("role") not in {"none", "freeBusyReader"} for r in acl.get("items", [])):
                found.append("public-calendar")
            token = acl.get("nextPageToken")
            if not token:
                break
            page = "?" + urlencode({"pageToken": token})
        self.remember(key, found)
        reasons.extend(found)

    async def drive_owned(self, file_id: str, reasons: list | None = None) -> dict:
        base = "/www.googleapis.com/drive/v3/files/" + quote(file_id, safe="")
        fields = "ownedByMe,driveId,mimeType,trashed,name,parents,webViewLink,description,id"
        data = await self.google_json(base + "?" + urlencode({"fields": fields, "supportsAllDrives": "true"}))
        found = []
        if data.get("ownedByMe") is not True or data.get("driveId"):
            found.append("drive-not-owned")
        page = ""
        while True:
            permissions = await self.google_json(base + "/permissions?fields=nextPageToken,permissions(type,role)" + page)
            if any(p.get("type") == "anyone" for p in permissions.get("permissions", [])):
                found.append("public-drive-target")
            token = permissions.get("nextPageToken")
            if not token:
                break
            page = "&" + urlencode({"pageToken": token})
        if reasons is not None:
            reasons.extend(found)
        elif found:
            raise Refused(found[0])
        return data

    def metadata(self, headers: dict, body: bytes, upload: bool) -> dict:
        content_type = headers.get("content-type", "application/json")
        if upload and content_type.lower().startswith("multipart/related"):
            message = email.parser.BytesParser(policy=email.policy.default).parsebytes(
                b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
            if not message.is_multipart():
                raise Refused("invalid-upload", 400)
            parts = list(message.iter_parts())
            if not parts or parts[0].get_content_type() != "application/json":
                raise Refused("metadata-required", 400)
            return json_object(parts[0].get_payload(decode=True))
        if upload and not content_type.lower().startswith("application/json"):
            return {}
        return json_object(body)

    async def policy(self, method, path, query, headers, body, reasons) -> tuple[str, str, dict | None]:
        host, _, route = path[1:].partition("/")
        route = "/" + route
        if host == "gmail.googleapis.com" or route.startswith("/gmail/"):
            raise Refused("mail-send-not-here")
        if host == "sheets.googleapis.com":
            if not re.fullmatch(r"/v4/spreadsheets(?:/[^/]+(?::[^/]+)?(?:/.*)?)?(?::batchUpdate)?", route):
                raise Refused("write-not-allowed")
            reasons.append("sheets-write")
            return "sheets", "spreadsheets.write", None
        data = self.metadata(headers, body, route.startswith("/upload/drive/v3/"))
        if host == "www.googleapis.com" and route.startswith("/calendar/v3/"):
            acl = re.fullmatch(r"/calendar/v3/calendars/([^/]+)/acl(?:/([^/]+))?", route)
            if acl:
                if not ((method == "POST" and not acl[2]) or
                        (method in {"PUT", "PATCH", "DELETE"} and acl[2])):
                    raise Refused("write-not-allowed")
                snapshot = await self.google_json(path) if acl[2] else None
                scope = data.get("scope", (snapshot or {}).get("scope", {}))
                owners = {e.lower() for e in self.config["owner_emails"]}
                if method != "DELETE" and not (scope.get("type") == "user" and
                        str(scope.get("value", "")).lower() in owners):
                    reasons.append("calendar-sharing")
                return "calendar", "acl." + {"POST": "insert", "PUT": "update", "PATCH": "patch", "DELETE": "delete"}[method], snapshot
            if route == "/calendar/v3/calendars" and method == "POST":
                return "calendar", "calendars.insert", None
            match = re.fullmatch(r"/calendar/v3/calendars/([^/]+)/events(?:/([^/]+))?", route)
            if not match or (method, bool(match[2])) not in {
                    ("POST", False), ("PUT", True), ("PATCH", True), ("DELETE", True)}:
                raise Refused("write-not-allowed")
            await self.calendar_owned(match[1], reasons)
            self.owner_attendees(data, reasons)
            snapshot = await self.google_json(path) if match[2] else None
            if snapshot is not None:
                self.owner_attendees(snapshot, reasons, existing=True)
            query[:] = [(k, v) for k, v in query if k.lower() not in {"sendupdates", "sendnotifications"}]
            query.extend([("sendUpdates", "none"), ("sendNotifications", "false")])
            return "calendar", "events." + {"POST": "insert", "PUT": "update", "PATCH": "patch", "DELETE": "delete"}[method], snapshot
        if host == "tasks.googleapis.com":
            match = re.fullmatch(r"/tasks/v1/(?:users/@me/lists|lists/([^/]+)/tasks)(?:/([^/]+))?(/move)?", route)
            if not match:
                raise Refused("write-not-allowed")
            task = bool(match[1])
            identity = match[2]
            move = match[3]
            allowed = (method == "POST" if move else
                       method in ({"PUT", "PATCH", "DELETE"} if task else {"PUT", "PATCH"}) if identity
                       else method == "POST")
            if not allowed or identity == "clear" or move and not identity:
                raise Refused("write-not-allowed")
            snapshot = await self.google_json(path) if identity and not move else None
            op = "move" if move else {"POST": "insert", "PUT": "update", "PATCH": "patch", "DELETE": "delete"}[method]
            return "tasks", ("tasks." if task else "tasklists.") + op, snapshot
        if host == "www.googleapis.com" and re.match(r"/(?:upload/)?drive/v3/", route):
            permission = re.fullmatch(r"/drive/v3/files/([^/]+)/permissions(?:/([^/]+))?", route)
            comment = re.fullmatch(r"/drive/v3/files/([^/]+)/comments(?:/([^/]+))?(?:/replies(?:/([^/]+))?)?", route)
            if permission or comment:
                found = permission or comment
                if method not in {"POST", "PATCH", "PUT", "DELETE"}:
                    raise Refused("write-not-allowed")
                if method != "POST" and not found[2] or method == "POST" and permission and found[2]:
                    raise Refused("write-not-allowed")
                snapshot = await self.google_json(path) if method != "POST" else None
                if permission:
                    merged = {**(snapshot or {}), **data}
                    owners = {e.lower() for e in self.config["owner_emails"]}
                    if method != "DELETE" and not (merged.get("type") == "user" and
                            str(merged.get("emailAddress", "")).lower() in owners):
                        reasons.append("drive-sharing")
                    op = "permissions."
                else:
                    reasons.append("drive-comments")
                    op = "comments."
                if method != "DELETE":
                    await self.drive_owned(found[1], reasons)
                return "drive", op + {"POST": "create", "PATCH": "update", "PUT": "update", "DELETE": "delete"}[method], snapshot
            match = re.fullmatch(r"/(?:upload/)?drive/v3/files(?:/([^/]+))?(/copy)?", route)
            if not match or not ((method == "POST" and (not match[1] or match[2]))
                                 or (method == "PATCH" and match[1] and not match[2])):
                raise Refused("write-not-allowed")
            if data.get("mimeType") == SHEET:
                reasons.append("spreadsheet-write")
            snapshot = await self.drive_owned(match[1], reasons) if match[1] else None
            if snapshot and snapshot.get("mimeType") == SHEET:
                reasons.append("spreadsheet-write")
            parents = data.get("parents", [])
            if not isinstance(parents, list) or not all(isinstance(p, str) for p in parents):
                raise Refused("invalid-parents", 400)
            for key, value in query:
                if key == "addParents":
                    parents = parents + value.split(",")
                if key == "uploadType" and value == "resumable":
                    # A session URL bypasses metadata checks; the gate supports media/multipart only.
                    raise Refused("resumable-upload-not-allowed")
                if key == "convert" and value.lower() == "true":
                    reasons.append("spreadsheet-conversion")
            for parent in parents:
                await self.drive_owned(parent, reasons)
            return "drive", "files." + ("update" if method == "PATCH" else "copy" if match[2] else "create"), snapshot if method == "PATCH" else None
        if host == "docs.googleapis.com":
            match = re.fullmatch(r"/v1/documents(?:/([^/:]+):batchUpdate)?", route)
            if method != "POST" or not match:
                raise Refused("write-not-allowed")
            if hidden_doc_key(data):
                reasons.append("docs-image")
            snapshot = None
            if match[1]:
                await self.drive_owned(match[1], reasons)
                snapshot = await self.google_json("/docs.googleapis.com/v1/documents/" +
                                                  quote(match[1], safe="") + "?fields=revisionId,title")
            return "docs", "documents.batchUpdate" if match[1] else "documents.create", snapshot
        raise Refused("write-not-allowed")

    def record(self, uid, api, op, method, path, query, status, response, proof, snapshot, approved_by=None,
               deleting=False, prepared=None) -> dict:
        identity = Path(prepared).stem if prepared else f"{time.time_ns():020d}-{secrets.token_hex(6)}"
        snapname = None
        if prepared is not None:
            snapname = prepared
        elif snapshot is not None:
            snapname = f"snapshots/{identity}.json"
            private_write(self.state / snapname, json_bytes(snapshot))
        resource = {}
        if 200 <= status < 300:
            with contextlib.suppress(Refused):
                data = json_object(response)
                resource = {k: data[k] for k in ("id", "title", "summary", "name") if k in data}
                link = data.get("htmlLink") or data.get("webViewLink")
                if not link and api == "docs" and data.get("documentId"):
                    resource["id"] = data["documentId"]
                    link = "https://docs.google.com/document/d/" + data["documentId"]
                if link:
                    resource["link"] = link
        restorable = (snapshot is not None and
                      (api == "calendar" and op.removeprefix("restore.") in {"events.update", "events.patch", "events.delete"}
                       or api == "tasks" and op.removeprefix("restore.").split(".")[-1] in {"update", "patch", "delete"}
                       or api == "drive" and op.removeprefix("restore.") == "files.update"
                       or api == "obsidian"))
        row = dict(id=identity, ts=utc(), uid=uid, api=api, op=op, method=method,
                   path=journal_path(path, query), status=status, resource=resource,
                   owner_message=proof, snapshot=snapname,
                   restorable=restorable and 200 <= status < 300)
        if approved_by:
            row["approved_by"] = approved_by
        if deleting:
            row["delete"] = True
        self.append("changes.jsonl", row)
        print(f"GATE_WRITE {api} {op} {status}", file=sys.stderr, flush=True)
        return row

    async def google_write(self, uid, method, path, query, headers, body, proof=None, restore=False,
                           approved_by=None, writer=None, approved_context=None):
        link = proof if proof is not None else await self.proof(headers)
        reasons = []
        api, op, snapshot = await self.policy(method, path, query, headers, body, reasons)
        if approved_context:
            if (set(reasons) - set(approved_context["reason"].split(",")) or
                    hashlib.sha256(json_bytes(snapshot)).hexdigest() != approved_context["snapshot_hash"]):
                raise Refused("approval-context-changed")
        data = self.metadata(headers, body, "/upload/drive/" in path)
        reasons.extend(self.limit_reasons(uid, link, method, op, data))
        if reasons and not approved_by:
            return await self.park(uid, method, path, query, headers, body, link, api, op, reasons, data, snapshot,
                                   restoring=restore)
        if approved_by and api == "calendar" and op.startswith("events."):
            query[:] = [(k, v) for k, v in query if k.lower() not in {"sendupdates", "sendnotifications"}]
            query.append(("sendUpdates", "all" if any(r in reasons for r in {
                "external-attendee", "foreign-organizer", "calendar-not-owned", "public-calendar"}) else "none"))
        host, _, route = path[1:].partition("/")
        url = self.base(host) + "/" + quote(route, safe="/:@!$&'()*+,;=-._~") + ("?" + urlencode(query) if query else "")
        outgoing = google_headers(headers, await self.access_token())
        streaming = writer is not None
        prepared = None
        if snapshot is not None:
            prepared = f"snapshots/{time.time_ns():020d}-{secrets.token_hex(6)}.json"
            private_write(self.state / prepared, json_bytes(snapshot))
        status = 502
        try:
            connection, answer = await self.upstream(method, url, outgoing, body)
            status, response_headers = answer.status, dict(answer.getheaders())
            chunks = []
            try:
                if writer:
                    self.response_head(writer, answer)
                while chunk := await asyncio.to_thread(answer.read, 65536):
                    chunks.append(chunk)
                    if writer:
                        try:
                            writer.write(chunk)
                            await writer.drain()
                        except OSError:
                            # Still drain and journal an upstream change after a client disconnect.
                            writer = None
                response = b"".join(chunks)
            finally:
                connection.close()
        except (Refused, OSError, http.client.HTTPException):
            self.record(uid, api, op, method, path, query, status, b"{}", link, snapshot,
                        approved_by, prepared=prepared)
            raise Refused("upstream-unavailable", 502) from None
        self.record(uid, api, ("restore." if restore else "") + op, method, path, query,
                    status, response, link, snapshot, approved_by,
                    deleting=op == "files.update" and data.get("trashed") is True, prepared=prepared)
        if api == "calendar" and op.startswith("acl."):
            self.cache = {key: value for key, value in self.cache.items() if key[0] != "calendar"}
        if streaming:
            return None
        return status, response_headers, response

    def pending(self) -> list:
        return [json.loads(path.read_text()) for path in sorted((self.state / "pending").glob("*.json"))]

    def limit_reasons(self, uid, proof, method, op, data) -> list:
        if uid not in self.config["clients"]:
            return []
        limits = self.config.get("limits", {})
        rows = self.records(since="1970-01-01T00:00:00+00:00")
        waiting = self.pending()
        reasons = []
        if (sum(r["owner_message"] == proof for r in rows) +
                sum(r["owner_message"] == proof for r in waiting)
                >= limits.get("writes_per_owner_message", 30)):
            reasons.append("owner-message-write-limit")
        deleting = (op in {"events.delete", "tasks.delete"} or
                    op == "files.update" and data.get("trashed") is True)
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)
        if deleting:
            count = sum(r["uid"] == uid and dt.datetime.fromisoformat(r["ts"]) >= cutoff and
                        (r["op"].removeprefix("restore.") in {"events.delete", "tasks.delete"} or
                         r.get("delete", False)) for r in rows)
            # Drive trash bodies are not journaled: snapshot/current op gets an explicit marker.
            count += sum(r["uid"] == uid and r.get("delete") and
                         dt.datetime.fromisoformat(r["ts"]) >= cutoff for r in waiting)
            if count >= limits.get("deletes_per_hour", 10):
                reasons.append("delete-rate-limit")
        return reasons

    async def bot_call(self, method, path, data=None):
        authorization = "Bot " + Path(self.config["owner_proof"]["token_file"]).read_text().strip()
        url = self.config.get("discord_api_base", "https://discord.com/api/v10") + path
        return await self.fetch(method, url, {"Authorization": authorization, "Content-Type": "application/json"},
                                json_bytes(data) if data is not None else b"")

    async def park(self, uid, method, path, query, headers, body, proof, api, op, reasons, data, snapshot=None,
                   restoring=False):
        approval = self.config.get("approval")
        if not approval:
            raise Refused("approval-not-configured", 503)
        channel = str(approval["channel_id"])
        authorization = "Bot " + Path(self.config["owner_proof"]["token_file"]).read_text().strip()
        if not await self.channel_allowed(channel, authorization, dm=False):
            raise Refused("approval-channel-not-owned")
        destinations = []

        def destination(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key in {"email", "emailAddress", "value", "domain", "uri"} and isinstance(item, str):
                        destinations.append(urlsplit(item).hostname or item)
                    elif key == "type" and item == "anyone":
                        destinations.append("링크 있는 누구나")
                    else:
                        destination(item)
            elif isinstance(value, list):
                for item in value:
                    destination(item)

        destination(data)
        destination(snapshot)
        fallback = snapshot or {}
        title = " ".join(str(data.get("title") or data.get("summary") or data.get("name") or
                             fallback.get("title") or fallback.get("summary") or fallback.get("name") or "").splitlines())
        thread = await self.card_thread(channel, proof, f"{CARD_KIND.get(api, api)} · {(title or op)[:40]}")
        await self.supersede(thread, api, op, path, method, title)
        # Owner 2026-10-19 00:00 KST: the card shows who, what and the reactions; the reason,
        # the owner-message link and the expiry stay in the pending record.
        content = (f"승인 필요 · {CARD_KIND.get(api, api)}\n"
                   f"받는 사람: {', '.join(sorted(set(destinations)))[:500] or path[:500]}\n"
                   f"내용: {defang(title[:200])}\n✅ 실행 · ⛔ 취소")
        channel = thread
        status, _, response = await self.bot_call("POST", f"/channels/{channel}/messages",
                                                 {"content": content, "allowed_mentions": {"parse": []}, "flags": 4})
        if not 200 <= status < 300:
            raise Refused("approval-post-failed", 502)
        message = str(json_object(response)["id"])
        identity = f"{time.time_ns():020d}-{secrets.token_hex(6)}"
        link = f"https://discord.com/channels/{self.config['owner_guild']}/{channel}/{message}"
        host, _, route = path[1:].partition("/")
        entry = dict(id=identity, ts=utc(), uid=uid, method=method, path=path, query=query,
                     upstream_url=self.base(host) + "/" + quote(route, safe="/:@") + ("?" + urlencode(query) if query else ""),
                     headers={k: v for k, v in headers.items() if k.lower() in {"content-type", "accept"}},
                     body=base64.b64encode(body).decode(), owner_message=proof,
                     reason=",".join(sorted(set(reasons))), api=api, op=op,
                     channel=channel, message=message, card=link, title=title, thread=thread,
                     content_hash=hashlib.sha256(json_object(response).get("content", content).encode()).hexdigest(), status="pending",
                     snapshot_hash=hashlib.sha256(json_bytes(snapshot)).hexdigest(),
                     restoring=restoring,
                     delete=op in {"events.delete", "tasks.delete"} or op == "files.update" and data.get("trashed") is True)
        if api == "obsidian":
            entry["vault_path"] = dict(query)["path"]
            entry["vault_content"] = data["restore_content"] if restoring else body.decode("utf-8")
        private_write(self.state / "pending" / (identity + ".json"), json_bytes(entry))
        for emoji in ("✅", "⛔"):
            status, _, _ = await self.bot_call("PUT", f"/channels/{channel}/messages/{message}/reactions/{quote(emoji)}/@me")
            if not 200 <= status < 300:
                self.deny(uid, "google", method, path, "approval-reaction-failed")
        return 202, {}, json_bytes(dict(status="pending_approval", id=identity, card=link, reason=entry["reason"]))

    async def card_thread(self, channel, proof, title) -> str:
        """Where a card goes (owner 2026-10-18/19): the owner's request thread, or a thread of its own.

        A request written inside a thread keeps its card there; one written in the approval channel
        gets a thread on that message (Discord: thread id == message id); anything else opens a new
        thread in the approval channel. Any failure keeps the old place, the channel itself.
        """
        parts = proof.rsplit("/", 2)
        origin, message = (parts[-2], parts[-1]) if len(parts) == 3 and parts[-1].isdigit() else ("", "")
        name = f"🔐 {title}"[:100]
        try:
            if origin and origin != channel:
                status, _, body = await self.bot_call("GET", f"/channels/{origin}")
                info = json_object(body) if 200 <= status < 300 else {}
                if info.get("type") in (11, 12) and str(info.get("parent_id")) == channel:
                    return origin
            if origin == channel and message:
                status, _, _ = await self.bot_call(
                    "POST", f"/channels/{channel}/messages/{message}/threads",
                    {"name": name, "auto_archive_duration": 10080})
                if 200 <= status < 300 or status == 400:  # 400: that message already has its thread
                    return message
            status, _, body = await self.bot_call(
                "POST", f"/channels/{channel}/threads", {"name": name, "type": 11, "auto_archive_duration": 10080})
            created = str(json_object(body).get("id", "")) if 200 <= status < 300 else ""
            if created.isdigit():
                return created
        except (OSError, ValueError, KeyError, http.client.HTTPException):
            pass
        print("GATE_CARD_THREAD_FALLBACK", file=sys.stderr, flush=True)
        return channel

    async def supersede(self, thread, api, op, path, method, title) -> None:
        """A newer card for the same work in the same thread replaces the older undecided one."""
        async with self.approval_lock:
            for entry in self.pending():
                if (entry.get("thread") != thread or entry.get("api") != api or entry.get("op") != op
                        or entry.get("path") != path or entry.get("status") != "pending"
                        or method == "POST" and entry.get("title") != title):
                    continue
                base = f"/channels/{entry['channel']}/messages/{entry['message']}"
                if await self.owner_reacted(base, "⛔") or await self.owner_reacted(base, "✅"):
                    continue  # the owner already decided that card; the poller handles it
                (self.state / "pending" / (entry["id"] + ".json")).unlink(missing_ok=True)
                self.deny(entry["uid"], "google", entry["method"], entry["path"], "superseded")
                status, _, body = await self.bot_call("GET", base)
                original = json_object(body).get("content", "") if 200 <= status < 300 else ""
                await self.bot_call("PATCH", base, {
                    "content": ("🔁 새 판으로 대체됨 — 이 카드는 실행되지 않습니다\n" + original)[:2000],
                    "allowed_mentions": {"parse": []}})

    async def owner_reacted(self, base, emoji) -> bool:
        after = None
        while True:
            query = "?limit=100" + ("&after=" + after if after else "")
            status, _, body = await self.bot_call("GET", base + "/reactions/" + quote(emoji) + query)
            if not 200 <= status < 300:
                raise Refused("approval-reactions-unavailable", 502)
            users = json.loads(body)
            if any(str(u.get("id")) == str(self.config["owner_id"]) and not u.get("bot", False) for u in users):
                return True
            if len(users) < 100:
                return False
            after = str(users[-1]["id"])

    async def poll_approvals(self):
        async with self.approval_lock:
            for entry in self.pending():
                pending_path = self.state / "pending" / (entry["id"] + ".json")
                base = f"/channels/{entry['channel']}/messages/{entry['message']}"
                if entry.get("status") == "executing":
                    # Never replay an uncertain write after a crash.
                    self.deny(entry["uid"], "google", entry["method"], entry["path"], "approval-execution-uncertain")
                    pending_path.unlink()
                    continue
                status, _, body = await self.bot_call("GET", base)
                outcome = None
                edit = True
                if status == 404:
                    outcome, edit = "card-gone", False
                elif status != 200:
                    continue
                elif hashlib.sha256(json_object(body).get("content", "").encode()).hexdigest() != entry["content_hash"]:
                    outcome, edit = "card-tampered", False
                elif (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(entry["ts"])).total_seconds() >= 86400:
                    outcome = "만료됨"
                elif await self.owner_reacted(base, "⛔"):
                    outcome = "⛔ 취소됨"
                elif await self.owner_reacted(base, "✅"):
                    entry["status"] = "executing"
                    private_write(pending_path, json_bytes(entry))
                    try:
                        async with self.write_lock:
                            if entry["api"] == "obsidian":
                                status, _, _ = await self.vault_write(entry["uid"], entry["vault_path"],
                                    entry["vault_content"], entry["owner_message"],
                                    approved_by=entry["card"], restoring=entry.get("restoring", False))
                            else:
                                status, _, _ = await self.google_write(entry["uid"], entry["method"], entry["path"],
                                    entry["query"], entry["headers"], base64.b64decode(entry["body"]),
                                    proof=entry["owner_message"], approved_by=entry["card"], approved_context=entry,
                                    restore=entry.get("restoring", False))
                        outcome = f"✅ 실행됨 ({status})"
                    except Refused as error:
                        outcome = "실행 실패"
                        self.deny(entry["uid"], "google", entry["method"], entry["path"], error.reason)
                if outcome:
                    pending_path.unlink()
                    if not outcome.startswith("✅"):
                        self.deny(entry["uid"], "google", entry["method"], entry["path"], outcome)
                    if edit:
                        # Keep what was approved on the card: the outcome goes on top of the posted text.
                        original = json_object(body).get("content", "")
                        await self.bot_call("PATCH", base, {"content": (outcome + "\n" + original)[:2000],
                                                             "allowed_mentions": {"parse": []}})

    async def approval_loop(self):
        while True:
            try:
                await self.poll_approvals()
            except (Refused, OSError, ValueError, KeyError, http.client.HTTPException):
                # A transient Discord failure leaves the card parked, never executes blindly.
                print("GATE_APPROVAL_CHECK_FAILED", file=sys.stderr, flush=True)
            await asyncio.sleep(self.config.get("approval", {}).get("poll_seconds", 20))

    async def discord_policy(self, method, path, headers, body):
        if not path.startswith("/api/v10/"):
            raise Refused("not-allowed")
        route = path[len("/api/v10"):]
        for entry in self.pending():
            protected = f"/channels/{entry['channel']}/messages/{entry['message']}"
            if (route == protected and method in {"PATCH", "DELETE"} or
                    route.startswith(protected + "/reactions") and method in {"PUT", "DELETE"}):
                raise Refused("card-protected")
            if (method == "POST" and route == f"/channels/{entry['channel']}/messages/bulk-delete"
                    and entry["message"] in [str(m) for m in json_object(body).get("messages", [])]):
                raise Refused("card-protected")
        if method not in READS:
            allowed = self.config.get("discord_url_allow", DISCORD_URL_ALLOW)
            for text in message_texts(headers, body):
                for host in URL.findall(text):
                    if not url_host_allowed(host, allowed):
                        raise Refused("external-url-in-message")
        if method == "GET" and route in {"/gateway", "/gateway/bot", "/users/@me",
                                        "/applications/@me", "/oauth2/applications/@me"}:
            return
        authorization = headers.get("authorization", "")
        if not authorization.startswith("Bot "):
            raise Refused("bot-authorization-required")
        match = re.fullmatch(r"/channels/(\d+)(/.*)?", route)
        if match:
            tail = match[2] or ""
            if tail.startswith("/followers") or method == "POST" and tail in {"/invites", "/webhooks"}:
                raise Refused("channel-egress-not-allowed")
            if not await self.channel_allowed(match[1], authorization):
                raise Refused("foreign-channel")
            return
        match = re.fullmatch(r"/guilds/(\d+)(/.*)?", route)
        if match:
            if match[1] != str(self.config["owner_guild"]):
                raise Refused("foreign-guild")
            # Guild-level creation routes must not bypass channel-level prohibitions.
            if "/webhooks" in (match[2] or "") and method not in READS:
                raise Refused("webhook-creation-not-allowed")
            return
        if route == "/users/@me/channels" and method == "POST":
            if str(json_object(body).get("recipient_id")) != str(self.config["owner_id"]):
                raise Refused("foreign-dm")
            return
        match = re.fullmatch(r"/webhooks/(\d+)/[^/]+(?:/.*)?", route)
        if match:
            try:
                segment = authorization[4:].split(".", 1)[0]
                application = base64.b64decode(segment + "=" * (-len(segment) % 4), validate=True).decode("ascii")
            except (ValueError, UnicodeError):
                raise Refused("foreign-webhook") from None
            if match[1] != application:
                raise Refused("foreign-webhook")
            return
        if re.fullmatch(r"/interactions/\d+/[^/]+/callback", route):
            return
        raise Refused("not-allowed")

    async def tokeninfo(self):
        url = self.config.get("tokeninfo_url", "https://oauth2.googleapis.com/tokeninfo")
        result = await self.fetch_json("GET", url + "?" + urlencode({"access_token": await self.access_token()}))
        return {key: result[key] for key in ("scope", "email", "expires_in") if key in result}

    async def admin(self, method, path, body):
        if (method, path) == ("GET", "/_admin/status"):
            present = (self.state / "google-token.json").exists()
            info = await self.tokeninfo() if present else {}
            return dict(token_present=present, scopes=info.get("scope", "").split(),
                        changes=len(self.records()), denials=len(self.records("denials.jsonl")),
                        vault_last_error=getattr(self, "vault_error", ""))
        if (method, path) == ("GET", "/_admin/tokeninfo"):
            return await self.tokeninfo()
        if (method, path) == ("POST", "/_admin/auth-url"):
            secret = self.secret()
            verifier = secrets.token_urlsafe(64)
            state = secrets.token_urlsafe(32)
            self.auth_pending = dict(verifier=verifier, state=state, created=time.time())
            private_write(self.state / "auth-pending.json", json_bytes(self.auth_pending))
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
            query = dict(client_id=secret["client_id"], redirect_uri="http://localhost", response_type="code",
                         state=state, code_challenge=challenge, code_challenge_method="S256",
                         access_type="offline", prompt="consent", scope=" ".join(self.config["google_scopes"]))
            return {"url": secret.get("auth_uri", "https://accounts.google.com/o/oauth2/v2/auth") + "?" + urlencode(query)}
        if (method, path) == ("POST", "/_admin/auth-finish"):
            redirect = urlsplit(json_object(body).get("redirect", ""))
            if redirect.scheme != "http" or redirect.netloc != "localhost" or redirect.path not in {"", "/"}:
                raise Refused("invalid-redirect", 400)
            params = dict(parse_qsl(redirect.query))
            pending_path = self.state / "auth-pending.json"
            if not pending_path.exists():
                raise Refused("oauth-state-required")
            pending = self.auth_pending or json.loads(pending_path.read_text())
            if (not secrets.compare_digest(params.get("state", ""), pending["state"])
                    or time.time() - pending["created"] > 86400 or not params.get("code")):
                raise Refused("oauth-state-required")
            pending_path.unlink()
            self.auth_pending = None
            secret = self.secret()
            token = await self.fetch_json("POST", secret["token_uri"],
                {"content-type": "application/x-www-form-urlencoded"}, urlencode(dict(
                    code=params["code"], client_id=secret["client_id"], client_secret=secret["client_secret"],
                    redirect_uri="http://localhost", grant_type="authorization_code",
                    code_verifier=pending["verifier"])).encode())
            scope = token.get("scope")
            if scope is None:
                info = await self.fetch_json("GET", self.config.get("tokeninfo_url",
                    "https://oauth2.googleapis.com/tokeninfo") + "?" + urlencode({"access_token": token["access_token"]}))
                scope = info.get("scope", "")
            granted = scope.split()
            if (not granted or any(forbidden_scope(s) for s in granted)
                    or not set(granted) <= set(self.config["google_scopes"]) | {"email", "profile"}):
                raise Refused("unsafe-google-scope")
            if not token.get("refresh_token"):
                raise Refused("refresh-token-required", 400)
            private_write(self.state / "google-token.json",
                          json_bytes({"refresh_token": token["refresh_token"], "scope": " ".join(granted)}))
            self.access = ""
            self.expiry = 0
            return {"scopes": granted}
        raise Refused("not-found", 404)

    async def restore(self, uid, identity, headers):
        rows = self.records(since="1970-01-01T00:00:00+00:00")
        original = next((r for r in rows if r["id"] == identity), None)
        if original is None:
            raise Refused("change-not-found", 404)
        proof = await self.proof(headers) if uid not in self.config["admins"] else "admin"
        if original["api"] == "docs":
            raise Refused("use-Docs-version-history", 409)
        if not original["restorable"]:
            raise Refused("change-not-restorable", 409)
        snapshot = json.loads((self.state / original["snapshot"]).read_text())
        if original["api"] == "obsidian":
            reasons = self.limit_reasons(uid, proof, "PUT", "note.write", {})
            if reasons:
                return await self.park(uid, "PUT", "/_vault/note", [("path", snapshot["path"])], {}, b"",
                    proof, "obsidian", "note.write", reasons,
                    {"title": snapshot["path"], "restore_content": snapshot["content"]}, restoring=True)
            return await self.vault_write(uid, snapshot["path"], snapshot["content"], proof, restoring=True)
        path, query = clean_path(original["path"])
        method = "PUT"
        if original["api"] == "calendar":
            snapshot = {k: v for k, v in snapshot.items() if k not in {
                "id", "etag", "iCalUID", "sequence", "created", "updated", "htmlLink",
                "creator", "organizer", "kind", "recurringEventId", "originalStartTime"}}
            if original["method"] == "DELETE":
                path = path.rsplit("/", 1)[0]
                method = "POST"
        elif original["api"] == "tasks":
            snapshot = {k: v for k, v in snapshot.items() if k in {
                "title", "notes", "status", "due", "completed"}}
            if original["method"] == "DELETE":
                path = path.rsplit("/", 1)[0]
                method = "POST"
        elif original["api"] == "drive":
            method = "PATCH"
            current_id = path.rsplit("/", 1)[1]
            current = await self.drive_owned(current_id, [])
            target_parents = snapshot.get("parents", [])
            query = [(k, v) for k, v in query if k not in {"addParents", "removeParents", "uploadType"}]
            for key, parents in (("addParents", set(target_parents) - set(current.get("parents", []))),
                                 ("removeParents", set(current.get("parents", [])) - set(target_parents))):
                if parents:
                    query.append((key, ",".join(sorted(parents))))
            snapshot = {k: v for k, v in snapshot.items() if k in {"name", "description", "trashed"}}
            path = path.replace("/upload/drive/v3/", "/drive/v3/")
        return await self.google_write(uid, method, path, query, {"content-type": "application/json"},
                                       json_bytes(snapshot), proof=proof, restore=True)

    async def git(self, *args, clone=False, stdin=None, env=None, check=True):
        vault = self.config["vault"]
        known = str(self.state / "vault-known-hosts")
        full = {**os.environ, "GIT_TERMINAL_PROMPT": "0",
                "GIT_SSH_COMMAND": "ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="
                + shlex.quote(known) + " -i " + shlex.quote(vault["ssh_key"]),
                "GIT_AUTHOR_NAME": "YooDori (dori-gate)", "GIT_AUTHOR_EMAIL": "dori-gate@localhost",
                "GIT_COMMITTER_NAME": "YooDori (dori-gate)", "GIT_COMMITTER_EMAIL": "dori-gate@localhost", **(env or {})}
        command = ("git", *args) if clone else ("git", "--git-dir", vault["dir"], *args)
        process = await asyncio.create_subprocess_exec(*command, env=full, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            output, errors = await asyncio.wait_for(process.communicate(stdin), 120)
        except asyncio.CancelledError:
            process.kill()
            await process.communicate()
            raise
        except TimeoutError:
            process.kill()
            await process.communicate()
            raise Refused("vault-git-timeout", 502) from None
        if check and process.returncode:
            last = (errors.decode("utf-8", "replace").strip().splitlines() or [""])[-1][:300]
            self.vault_error = f"{utc()} {args[0]} rc={process.returncode}: {last}"
            print(f"GATE_GIT_FAIL {args[0]} rc={process.returncode}", file=sys.stderr, flush=True)
            raise Refused("vault-git-failed", 502)
        return output if check else (process.returncode, output)

    def vault_path(self, relative: str) -> str:
        """A vault note path: relative .md under allowed_prefix, no hidden or empty parts, no traversal."""
        vault = self.config["vault"]
        parts = relative.split("/")
        if (not relative or relative.startswith("/") or "\\" in relative or
                any(not p or p.startswith(".") for p in parts) or not relative.endswith(".md") or
                any(ord(c) < 32 or ord(c) == 127 for c in relative)):
            raise Refused("invalid-vault-path", 400)
        prefix = vault.get("allowed_prefix", "").rstrip("/")
        if prefix and not relative.startswith(prefix + "/"):
            raise Refused("vault-prefix-required")
        return relative

    async def vault_sync(self) -> str:
        """The gate's own bare, shallow, blob-less clone (a large vault never gets checked out); returns the branch."""
        vault = self.config["vault"]
        branch = vault.get("branch", "main")
        if not Path(vault["dir"]).exists():
            await self.git("clone", "--bare", "--filter=blob:none", "--depth=1", "--single-branch",
                           "--branch", branch, "--", vault["remote"], vault["dir"], clone=True)
        remote = (await self.git("remote", "get-url", "origin")).decode().strip()
        if remote != vault["remote"]:
            raise Refused("vault-remote-mismatch")
        try:
            await self.git("fetch", "--depth=1", "--filter=blob:none", "origin", f"+refs/heads/{branch}:refs/heads/{branch}")
        except Refused:
            # A clone left broken (an interrupted fetch, a stale lock) is cheaper to take again than to repair.
            shutil.rmtree(vault["dir"])
            await self.git("clone", "--bare", "--filter=blob:none", "--depth=1", "--single-branch",
                           "--branch", branch, "--", vault["remote"], vault["dir"], clone=True)
        return branch

    async def vault_read(self, branch: str, relative: str) -> str | None:
        code, _ = await self.git("cat-file", "-e", f"{branch}:{relative}", check=False)
        if code:
            return None
        return (await self.git("cat-file", "blob", f"{branch}:{relative}")).decode("utf-8")

    async def vault_write(self, uid, relative, content, proof, restoring=False, approved_by=None):
        async with self.vault_lock:
            self.vault_path(relative)
            for attempt in (1, 2):
                branch = await self.vault_sync()
                previous = await self.vault_read(branch, relative)
                index = {"GIT_INDEX_FILE": str(self.state / "vault-index")}
                # A write killed mid-way leaves vault-index.lock behind and every later read-tree refuses; the index is
                # rebuilt from the branch each time, so both files are disposable under the vault lock.
                for stale in ("vault-index", "vault-index.lock"):
                    (self.state / stale).unlink(missing_ok=True)
                await self.git("read-tree", branch, env=index)
                if content is None:
                    await self.git("update-index", "--index-info", env=index,
                                   stdin=f"0 {'0' * 40}\t{relative}\n".encode())
                else:
                    blob = (await self.git("hash-object", "-w", "--stdin", stdin=content.encode())).decode().strip()
                    await self.git("update-index", "--add", "--cacheinfo", f"100644,{blob},{relative}", env=index)
                # --missing-ok: the blob-less clone lacks every other blob, and write-tree would fetch them all to check
                tree = (await self.git("write-tree", "--missing-ok", env=index)).decode().strip()
                commit = (await self.git("commit-tree", tree, "-p", branch, "-m",
                                         f"yoodori: {relative} ({proof})")).decode().strip()
                code, _ = await self.git("push", "origin", f"{commit}:refs/heads/{branch}", check=False)
                if not code:
                    await self.git("update-ref", f"refs/heads/{branch}", commit)
                    break
                if attempt == 2:
                    snapshot = {"path": relative, "content": previous}
                    self.record(uid, "obsidian", "note.write", "PUT", "/_vault/note", [("path", relative)],
                                502, b"{}", proof, snapshot, approved_by)
                    raise Refused("vault-push-failed", 502)
            snapshot = {"path": relative, "content": previous}
            prepared = f"snapshots/{time.time_ns():020d}-{secrets.token_hex(6)}.json"
            private_write(self.state / prepared, json_bytes(snapshot))
            response = json_bytes({"name": relative, "commit": commit})
            self.record(uid, "obsidian", "restore.note" if restoring else "note.write", "PUT",
                        "/_vault/note", [("path", relative)], 200, response, proof,
                        snapshot, approved_by, prepared=prepared)
            return 200, {}, response

    async def vault(self, uid, method, path, query, headers, body):
        if not self.config.get("vault"):
            raise Refused("vault-not-configured", 503)
        if path != "/_vault/note" or method not in {"GET", "PUT"}:
            raise Refused("not-allowed")
        relative = self.vault_path(dict(query).get("path", ""))
        if method == "GET":
            async with self.vault_lock:
                text = await self.vault_read(await self.vault_sync(), relative)
            if text is None:
                raise Refused("note-not-found", 404)
            return 200, {"content-type": "text/markdown; charset=utf-8"}, text.encode("utf-8")
        if len(body) > 1024 * 1024:
            raise Refused("body-too-large", 413)
        proof = await self.proof(headers)
        reasons = self.limit_reasons(uid, proof, "PUT", "note.write", {})
        if reasons:
            return await self.park(uid, "PUT", "/_vault/note", query, headers, body, proof,
                                   "obsidian", "note.write", reasons, {"title": relative})
        return await self.vault_write(uid, relative, body.decode("utf-8"), proof)

    async def stream_proxy(self, writer, method, url, headers, body):
        connection, response = await self.upstream(method, url, headers, body)
        try:
            self.response_head(writer, response)
            while chunk := await asyncio.to_thread(response.read, 65536):
                writer.write(chunk)
                await writer.drain()
        finally:
            connection.close()

    def response_head(self, writer, response):
        writer.write(f"HTTP/1.1 {response.status} Response\r\n".encode())
        nominated = {value.strip().lower() for value in response.getheader("Connection", "").split(",")}
        for key, value in response.getheaders():
            if key.lower() not in HOP | nominated | {"content-length"}:
                writer.write(f"{key}: {value}\r\n".encode("latin1"))
        writer.write(b"Connection: close\r\n\r\n")

    async def connect(self, reader, writer, method, target):
        if method != "CONNECT":
            raise Refused("connect-only", 405)
        match = re.fullmatch(r"([A-Za-z0-9.-]+):(\d+)", target)
        if not match:
            raise Refused("invalid-connect", 400)
        host, port = match[1].lower().rstrip("."), int(match[2])
        if host == "discord.com" or host.endswith((".google.com", ".googleapis.com")) or host in {"google.com", "googleapis.com"}:
            raise Refused("connect-host-denied")
        permitted = False
        for entry in self.config["connect_allow"]:
            name = entry if isinstance(entry, str) else entry["host"]
            ports = [443] if isinstance(entry, str) else entry.get("ports", [443])
            if (host == name or name.startswith("*.") and host.endswith(name[1:]) and host != name[2:]) and port in ports:
                permitted = True
        if not permitted:
            raise Refused("connect-host-denied")
        addresses = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise Refused("connect-private-address")
        if self.tunnels >= 256:
            raise Refused("tunnel-limit", 503)
        self.tunnels += 1
        remote_writer = None
        try:
            for family, *_, address in ordered(addresses):
                try:
                    remote_reader, remote_writer = await asyncio.wait_for(
                        asyncio.open_connection(address[0], port), 5 if family == socket.AF_INET6 else 30)
                    break
                except (OSError, TimeoutError):
                    continue
            else:
                raise Refused("connect-upstream-unreachable", 502)
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            activity = asyncio.Event()

            async def pump(source, destination):
                while chunk := await source.read(65536):
                    activity.set()
                    destination.write(chunk)
                    await destination.drain()

            async def idle():
                while True:
                    activity.clear()
                    try:
                        await asyncio.wait_for(activity.wait(), 600)
                    except TimeoutError:
                        return

            pumps = [asyncio.create_task(pump(reader, remote_writer)),
                     asyncio.create_task(pump(remote_reader, writer)),
                     asyncio.create_task(idle())]
            try:
                await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in pumps:
                    task.cancel()
                await asyncio.gather(*pumps, return_exceptions=True)
        finally:
            self.tunnels -= 1
            if remote_writer:
                remote_writer.close()
                await remote_writer.wait_closed()

    async def handle(self, port, reader, writer):
        task = asyncio.current_task()
        self.connections.add(task)
        uid = None
        method, target = "-", "/"
        try:
            uid = caller_uid(writer.get_extra_info("peername"), writer.get_extra_info("sockname"),
                             self.config.get("proc_tcp_paths", ["/proc/net/tcp", "/proc/net/tcp6"]))
            if uid is None:
                return
            method, target, headers, body = await asyncio.wait_for(read_request(reader), 60)
            if port == "connect":
                if uid not in self.config["clients"]:
                    raise Refused("client-uid-required")
                await self.connect(reader, writer, method, target)
                return
            path, query = clean_path(target)
            if port == "google" and path.startswith("/_admin/"):
                if uid not in self.config["admins"]:
                    raise Refused("admin-uid-required")
                result = await self.admin(method, path, body)
                await reply(writer, 200, json_bytes(result))
                return
            gate_path = port == "google" and path.startswith("/_gate/")
            if uid not in self.config["clients"] and not (gate_path and uid in self.config["admins"]):
                raise Refused("client-uid-required")
            if gate_path:
                if path == "/_gate/changes" and method == "GET":
                    await reply(writer, 200, json_bytes(self.records(since=dict(query).get("since", "24h"))))
                    return
                if path == "/_gate/pending" and method == "GET":
                    now = dt.datetime.now(dt.timezone.utc)
                    await reply(writer, 200, json_bytes([dict(id=e["id"], reason=e["reason"],
                        card=e["card"], age=(now - dt.datetime.fromisoformat(e["ts"])).total_seconds())
                        for e in self.pending()]))
                    return
                if re.fullmatch(r"/_gate/restore/[0-9a-f-]+", path) and method == "POST":
                    async with self.write_lock:
                        status, response_headers, response = await self.restore(uid, path.rsplit("/", 1)[1], headers)
                else:
                    raise Refused("not-found", 404)
            elif port == "google" and path.startswith("/_vault/"):
                if method == "GET":
                    status, response_headers, response = await self.vault(uid, method, path, query, headers, body)
                else:
                    async with self.write_lock:
                        status, response_headers, response = await self.vault(uid, method, path, query, headers, body)
            elif port == "google":
                host, _, route = path[1:].partition("/")
                if host not in GOOGLE_HOSTS:
                    raise Refused("google-host-denied")
                query = [(k, v) for k, v in query if k.lower() not in {"access_token", "key"}]
                if method in READS:
                    outgoing = google_headers(headers, await self.access_token())
                    url = self.base(host) + "/" + quote(route, safe="/:@!$&'()*+,;=-._~") + ("?" + urlencode(query) if query else "")
                    await self.stream_proxy(writer, method, url, outgoing, body)
                    return
                async with self.write_lock:
                    result = await self.google_write(uid, method, path, query, headers, body, writer=writer)
                if result is None:
                    return
                status, response_headers, response = result
            else:
                await self.discord_policy(method, path, headers, body)
                url = self.config.get("discord_api_base", "https://discord.com/api/v10") + quote(
                    path[len("/api/v10"):], safe="/:@!$&'()*+,;=-._~")
                if query:
                    url += "?" + urlencode(query)
                await self.stream_proxy(writer, method, url, headers, body)
                return
            await reply(writer, status, response, response_headers)
        except Refused as error:
            self.deny(uid, port, method, target, error.reason)
            payload = {"error": error.reason}
            if error.reason == "mail-send-not-here":
                payload["message"] = "Mail goes through the owner's approval card."
            await reply(writer, error.status, json_bytes(payload))
        except (OSError, ValueError, KeyError, TypeError, UnicodeError, http.client.HTTPException,
                asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
            # Boundary errors deliberately omit exception strings: they may contain credentials.
            self.deny(uid, port, method, target, "request-failed")
            with contextlib.suppress(OSError):
                await reply(writer, 502, b'{"error":"request-failed"}')
        finally:
            writer.close()
            with contextlib.suppress(OSError):
                await writer.wait_closed()
            self.connections.discard(task)

    async def start(self):
        try:
            for name in ("connect", "google", "discord"):
                self.servers[name] = await asyncio.start_server(
                    lambda r, w, name=name: self.handle(name, r, w), "127.0.0.1",
                    self.config["listen"][name], limit=HEADER_CAP)
        except OSError:
            await self.close()
            raise
        ports = ",".join(str(self.servers[n].sockets[0].getsockname()[1])
                         for n in ("connect", "google", "discord"))
        print("GATE_READY ports=" + ports, file=sys.stderr, flush=True)
        if self.config.get("approval"):
            self.approval_task = asyncio.create_task(self.approval_loop())

    async def close(self):
        if self.approval_task:
            self.approval_task.cancel()
            await asyncio.gather(self.approval_task, return_exceptions=True)
        for server in self.servers.values():
            server.close()
        # Python 3.12 wait_closed() waits for open connections (a long CONNECT tunnel), so end them first.
        tasks = list(self.connections)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for server in self.servers.values():
            await server.wait_closed()


async def serve(config: dict):
    gate = Gate(config)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stopped.set)
    try:
        await gate.start()
        await stopped.wait()
    finally:
        await gate.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    asyncio.run(serve(config))


if __name__ == "__main__":
    main()
