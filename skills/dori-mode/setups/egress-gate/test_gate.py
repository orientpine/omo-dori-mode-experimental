"""Wire-level tests: local fake upstreams only; no Google/Discord connections."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import datetime as dt
import importlib.util
import io
import json
import subprocess
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, quote, urlsplit
from unittest.mock import AsyncMock, patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


gate = load("gate")
summary = load("summary")


class GateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="dori-gate-test-")
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name)
        self.seen = []
        self.cards = {}
        self.card_channels = {}
        self.reactions = {}
        self.threads = {"555"}
        self.created_threads = []
        self.thread_names = []
        self.thread_meta = {}
        self.thread_patches = []
        self.thread_history = {}
        self.author = "1"
        self.proof_time = gate.utc()
        self.calendar_role = "owner"
        self.calendar_public = False
        self.file_owned = True
        self.file_public = False
        self.shared_drive = False
        self.file_mime = "application/vnd.google-apps.document"
        self.file_parents = []
        self.event = {"id": "e", "summary": "Before", "organizer": {"self": True},
                      "attendees": [{"email": "owner@example.com"}], "etag": "old", "iCalUID": "old"}
        self.response_status = 200
        self.order = {"number": 17, "created_at": gate.utc(), "via": "owner-device", "device": "nPHONE11CNTRL",
                      "created_by": "Owner@Example.com", "body_sha256": "a" * 64, "status": "받음", "uses": 0}
        self.order_reply = None
        self.use_reply = None
        self.scope = "openid"
        self.fake = await asyncio.start_server(self.fake_request, "127.0.0.1", 0)
        self.addAsyncCleanup(self.close_fake)
        self.base = "http://127.0.0.1:" + str(self.fake.sockets[0].getsockname()[1])
        (self.state / "bot").write_text("MTIz.fake.fake")
        (self.state / "bot").chmod(0o600)
        (self.state / "dashboard").write_text("dashboard-secret\n")
        (self.state / "client_secret.json").write_text(json.dumps({"installed": {
            "client_id": "client", "client_secret": "secret", "token_uri": self.base + "/token",
            "auth_uri": self.base + "/authorize"}}))
        (self.state / "google-token.json").write_text('{"refresh_token":"refresh-secret"}')
        self.config = {
            "state": str(self.state), "listen": dict(connect=0, google=0, discord=0),
            "clients": [os.getuid()], "admins": [], "owner_id": "1", "owner_guild": "10",
            "owner_emails": ["owner@example.com"],
            "owner_proof": {"token_file": str(self.state / "bot"), "max_age_hours": 24},
            "owner_order": {"api_base": self.base, "token_file": str(self.state / "dashboard"),
                            "owner_logins": ["owner@example.com"], "max_age_hours": 24},
            "google_scopes": ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
            "connect_allow": ["example.com", {"host": "*.example.org", "ports": [443]}],
            "upstreams": {host: self.base for host in gate.GOOGLE_HOSTS},
            "discord_api_base": self.base + "/api/v10", "tokeninfo_url": self.base + "/tokeninfo",
        }
        self.service = gate.Gate(self.config)
        await self.service.start()
        self.addAsyncCleanup(self.service.close)
        self.ports = {name: server.sockets[0].getsockname()[1] for name, server in self.service.servers.items()}

    async def close_fake(self):
        self.fake.close()
        await self.fake.wait_closed()

    async def fake_request(self, reader, writer):
        try:
            method, target, headers, body = await gate.read_request(reader)
            self.seen.append((method, target, headers, body))
            path = urlsplit(target).path
            data = {}
            status = 200
            if path == "/token":
                data = {"access_token": "access-secret", "expires_in": 3600,
                        "refresh_token": "refresh-new", "scope": self.scope}
            elif path.startswith("/api/orders/"):
                asked = "/api/orders/" + str(self.order.get("asked_as", self.order["number"]))
                if headers.get("x-pb-gate-token") != "dashboard-secret":
                    status = 403
                elif method == "POST" and path == asked + "/use":
                    if self.use_reply is not None:
                        await gate.reply(writer, *self.use_reply)
                        return
                    self.order = {**self.order, "uses": self.order["uses"] + 1}
                    data = self.order
                elif self.order_reply is not None:
                    await gate.reply(writer, *self.order_reply)
                    return
                elif method == "GET" and path == asked:
                    data = self.order
                else:
                    status = 404
            elif path == "/tokeninfo":
                data = {"scope": self.scope, "email": "owner@example.com", "expires_in": 3000,
                        "access_token": "must-not-return"}
            elif path.startswith("/api/v10/"):
                route = path[len("/api/v10"):]
                parts = route.split("/")
                if route.endswith("/threads") and method == "POST":
                    self.created_threads.append(route)
                    self.thread_names.append(json.loads(body)["name"])
                    data = {"id": parts[4] if "messages" in parts else "777"}
                    self.thread_meta[data["id"]] = {"id": data["id"], "type": 11, "parent_id": parts[2],
                                                    "name": json.loads(body)["name"]}
                elif route == "/guilds/10/threads/active":
                    data = {"threads": list(self.thread_meta.values())}
                elif route.endswith("/messages") and method == "GET" and parts[2] in self.thread_history:
                    data = self.thread_history[parts[2]]
                elif route.endswith("/messages") and method == "GET":
                    data = [{"id": m, "content": c, "author": {"bot": True}}
                            for m, c in sorted(self.cards.items(), reverse=True) if self.card_channels.get(m) == parts[2]]
                elif parts[1] == "channels" and len(parts) == 3 and parts[2] in self.thread_meta:
                    if method == "PATCH":
                        self.thread_patches.append((parts[2], json.loads(body)))
                        self.thread_meta[parts[2]].update(json.loads(body))
                    data = self.thread_meta[parts[2]]
                elif len(parts) >= 5 and parts[1] == "channels" and parts[3] == "messages":
                    message = parts[4]
                    if len(parts) >= 7 and parts[5] == "reactions":
                        if method == "GET":
                            data = self.reactions.get((message, parts[6]), [])
                        else:
                            data = {}
                    elif method == "GET":
                        if message == "100":
                            data = {"id": message, "author": {"id": self.author}, "timestamp": self.proof_time}
                        elif message in self.cards:
                            data = {"id": message, "content": self.cards[message]}
                        else:
                            status = 404
                    elif method == "PATCH":
                        self.cards[message] = json.loads(body)["content"]
                elif route.endswith("/messages") and method == "POST":
                    if parts[2] in self.thread_meta and "thread_metadata" in self.thread_meta[parts[2]]:
                        self.thread_meta[parts[2]]["thread_metadata"]["archived"] = False  # Discord reopens
                    message = str(1000 + len(self.cards))
                    self.cards[message] = json.loads(body)["content"]
                    self.card_channels[message] = parts[2]
                    data = {"id": message, "content": self.cards[message]}
                elif parts[1] == "channels" and len(parts) == 3:
                    channel = parts[2]
                    data = ({"id": channel, "type": 1, "recipients": [{"id": "1" if channel == "21" else "2"}]}
                            if channel in {"21", "22"} else
                            {"id": channel, "type": 11, "parent_id": "20", "guild_id": "10"} if channel in self.threads
                            else {"id": channel, "guild_id": "99" if channel == "99" else "10"})
            elif method in {"GET", "HEAD"}:
                if "/calendarList/" in path:
                    data = {"accessRole": self.calendar_role}
                elif path.endswith("/acl"):
                    data = {"items": [{"scope": {"type": "default"},
                                       "role": "reader" if self.calendar_public else "none"}]}
                elif "/events/" in path:
                    data = self.event
                elif path.endswith("/permissions"):
                    data = {"permissions": [{"type": "anyone" if self.file_public else "user", "role": "reader"}]}
                elif "/permissions/" in path:
                    data = {"type": "user", "emailAddress": "other@example.com"}
                elif "/drive/v3/files/" in path:
                    data = {"id": "f", "ownedByMe": self.file_owned, "mimeType": self.file_mime,
                            "trashed": False, "name": "Before", "description": "old", "parents": self.file_parents}
                    if self.shared_drive:
                        data["driveId"] = "shared"
                elif path.startswith("/v1/documents/"):
                    data = {"revisionId": "revision", "title": "Before"}
                elif path.startswith("/tasks/v1/"):
                    data = {"id": "t", "title": "Before", "notes": "old"}
                else:
                    data = {"id": "r", "name": "read"}
            else:
                status = self.response_status
                title_key = ("summary" if path.startswith("/calendar/") else
                             "title" if path.startswith(("/tasks/", "/v1/documents")) else "name")
                data = {"id": "new", title_key: "Changed", "htmlLink": "https://example.invalid/resource"}
                if body and headers.get("content-type", "").startswith("application/json"):
                    data.update(json.loads(body))
            await gate.reply(writer, status, gate.json_bytes(data))
        finally:
            writer.close()
            await writer.wait_closed()

    async def request(self, method="POST", path="/www.googleapis.com/calendar/v3/calendars/primary/events",
                      data=None, proof=True, port="google", headers=None, raw=None, origin="20/100"):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.ports[port])
        try:
            body = gate.json_bytes(data or {}) if raw is None else raw
            values = {"host": "ignored.invalid", "content-type": "application/json", **(headers or {})}
            if proof:
                values["x-dori-owner-message"] = origin
            values["content-length"] = str(len(body))
            request = f"{method} {path} HTTP/1.1\r\n".encode()
            request += "".join(f"{k}: {v}\r\n" for k, v in values.items()).encode()
            writer.write(request + b"\r\n" + body)
            await writer.drain()
            response = await asyncio.wait_for(reader.read(), 5)
            head, _, content = response.partition(b"\r\n\r\n")
            return int(head.split()[1]), content
        finally:
            writer.close()
            await writer.wait_closed()

    def approval(self):
        self.config["approval"] = {"channel_id": "20", "poll_seconds": 20}

    def writes(self):
        return [r for r in self.seen if r[0] not in gate.READS and
                not r[1].startswith(("/api/v10", "/token", "/api/orders/"))]

    def changes(self):
        return self.service.records()

    def approve(self, owner="1", emoji="✅"):
        entry = self.service.pending()[0]
        self.reactions[(entry["message"], quote(emoji))] = [{"id": owner, "bot": False}]
        return entry

    async def test_google_read_injects_gate_token(self):
        status, _ = await self.request("GET", "/www.googleapis.com/drive/v3/files/f",
                                       headers={"authorization": "Bearer caller-secret"}, proof=False)
        self.assertEqual(status, 200)
        self.assertEqual(self.seen[-1][2]["authorization"], "Bearer access-secret")

    async def test_google_drops_method_override_and_query_credentials(self):
        status, _ = await self.request("GET", "/www.googleapis.com/drive/v3/files/f?access_token=foreign&key=foreign",
            headers={"x-http-method-override": "DELETE", "authorization": "Bearer foreign"}, proof=False)
        self.assertEqual(status, 200)
        self.assertNotIn("x-http-method-override", self.seen[-1][2])
        self.assertNotIn("foreign", self.seen[-1][1])
        self.assertEqual(self.seen[-1][2]["authorization"], "Bearer access-secret")

    async def test_write_without_owner_proof_is_refused(self):
        status, _ = await self.request(proof=False)
        self.assertEqual(status, 403)
        self.assertFalse(self.writes())

    async def test_foreign_author_proof_is_refused(self):
        self.author = "2"
        status, _ = await self.request()
        self.assertEqual(status, 403)
        self.assertFalse(self.writes())

    async def test_old_proof_is_refused(self):
        self.proof_time = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=25)).isoformat()
        self.assertEqual((await self.request())[0], 403)

    async def test_foreign_guild_proof_is_refused(self):
        original = self.service.channel_allowed
        async def foreign(channel, authorization, dm=True):
            return False if not dm else await original(channel, authorization, dm)
        with patch.object(self.service, "channel_allowed", foreign):
            self.assertEqual((await self.request())[0], 403)

    async def test_calendar_notifications_are_disabled(self):
        status, _ = await self.request(path="/www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&sendNotifications=true")
        self.assertEqual(status, 200)
        query = parse_qs(urlsplit(self.writes()[-1][1]).query)
        self.assertEqual(query["sendUpdates"], ["none"])
        self.assertEqual(query["sendNotifications"], ["false"])

    async def test_external_attendee_is_parked_without_upstream_write(self):
        self.approval()
        status, content = await self.request(data={"summary": "Invite", "attendees": [{"email": "outside@example.net"}]})
        self.assertEqual(status, 202)
        self.assertEqual(json.loads(content)["status"], "pending_approval")
        self.assertTrue(self.cards)
        self.assertFalse(self.writes())

    async def test_a_card_for_a_channel_request_hangs_a_thread_on_the_owners_message(self):
        # Given / When: the owner asked in the approval channel itself.
        self.approval()
        await self.request(data={"summary": "Invite", "attendees": [{"email": "outside@example.net"}]})
        entry = self.service.pending()[0]
        # Then: the card sits in the thread on his message (thread id == message id).
        self.assertEqual(self.created_threads, ["/channels/20/messages/100/threads"])
        self.assertEqual(self.thread_names, ["🔐 일정 초대 · Invite"])
        self.assertEqual((entry["channel"], self.card_channels[entry["message"]]), ("100", "100"))

    async def test_a_card_for_a_request_inside_a_thread_stays_in_that_thread(self):
        # Given / When: the owner's request was written inside a thread under the approval channel.
        self.approval()
        await self.request(data={"summary": "Invite", "attendees": [{"email": "outside@example.net"}]},
                           origin="555/100")
        entry = self.service.pending()[0]
        # Then: no new thread; the card and later its result live in that thread.
        self.assertEqual(self.created_threads, [])
        self.assertEqual(self.card_channels[entry["message"]], "555")
        self.approve()
        await self.service.poll_approvals()
        self.assertTrue(self.cards[entry["message"]].startswith("✅ 실행됨"))

    async def test_a_card_for_a_request_elsewhere_opens_its_own_thread(self):
        # Given / When: the owner's message lives in another channel of his server.
        self.approval()
        await self.request(data={"summary": "Invite", "attendees": [{"email": "outside@example.net"}]},
                           origin="30/100")
        # Then: one new thread in the approval channel carries the card.
        self.assertEqual(self.created_threads, ["/channels/20/threads"])
        self.assertEqual(self.card_channels[self.service.pending()[0]["message"]], "777")

    async def test_a_revised_request_replaces_the_older_card_which_then_never_runs(self):
        # Given: the same invite asked twice in one thread.
        self.approval()
        invite = {"summary": "Invite", "attendees": [{"email": "outside@example.net"}]}
        await self.request(data=invite, origin="555/100")
        old = self.service.pending()[0]
        await self.request(data={**invite, "description": "고친 판"}, origin="555/100")
        # Then: only the newer card waits, the older one says it was replaced.
        pending = self.service.pending()
        self.assertEqual(len(pending), 1)
        self.assertNotEqual(pending[0]["id"], old["id"])
        self.assertTrue(self.cards[old["message"]].startswith("🔁 새 판으로 대체됨"))
        # When: the owner presses ✅ on the old card; Then: nothing is written.
        self.reactions[(old["message"], quote("✅"))] = [{"id": "1", "bot": False}]
        await self.service.poll_approvals()
        self.assertFalse(self.writes())

    async def test_a_decided_older_card_is_not_replaced(self):
        # Given: the owner already pressed ✅ on the first card.
        self.approval()
        invite = {"summary": "Invite", "attendees": [{"email": "outside@example.net"}]}
        await self.request(data=invite, origin="555/100")
        old = self.approve()
        # When: a second card for the same work arrives before the poller runs.
        await self.request(data=invite, origin="555/100")
        # Then: both stay; the decided one is left to the poller.
        self.assertEqual(len(self.service.pending()), 2)
        self.assertFalse(self.cards[old["message"]].startswith("🔁"))

    async def test_the_card_shows_only_who_what_and_the_reactions(self):
        # Given / When: an outside invite is parked.
        self.approval()
        await self.request(data={"summary": "Invite", "attendees": [{"email": "outside@example.net"}]})
        entry = self.service.pending()[0]
        card = self.cards[entry["message"]]
        # Then: recipients, title and reactions only; reason, proof link and expiry stay in the record.
        self.assertEqual(card.splitlines(), ["승인 필요 · 일정 초대", "받는 사람: outside@example.net",
                                             "내용: Invite", "✅ 실행 · ⛔ 취소"])
        self.assertTrue(entry["reason"] and entry["owner_message"].startswith("https://discord.com/channels/"))

    async def test_a_sharing_card_names_the_shared_file_and_the_access(self):
        # Given / When: a share with someone outside is parked (the body names no file).
        self.approval()
        status, _ = await self.request(path="/www.googleapis.com/drive/v3/files/f/permissions",
                                       data={"type": "user", "role": "reader", "emailAddress": "partner@example.net"})
        entry = self.service.pending()[0]
        # Then: the owner sees which file, with whom and what access, without opening anything.
        self.assertEqual(status, 202)
        self.assertEqual(self.cards[entry["message"]].splitlines(),
                         ["승인 필요 · Drive 공유", "받는 사람: partner@example.net", "내용: Before 공유(보기)",
                          "✅ 실행 · ⛔ 취소"])
        self.assertEqual(self.thread_names[-1], "🔐 Drive 공유 · Before 공유(보기)")

    async def test_owner_approval_executes_once_and_notifies(self):
        self.approval()
        await self.request(data={"attendees": [{"email": "outside@example.net"}]})
        entry = self.approve()
        await self.service.poll_approvals()
        await self.service.poll_approvals()
        self.assertEqual(len(self.writes()), 1)
        self.assertEqual(parse_qs(urlsplit(self.writes()[0][1]).query)["sendUpdates"], ["all"])
        self.assertEqual(self.changes()[0]["approved_by"], entry["card"])
        self.assertFalse(self.service.pending())
        card = self.cards[entry["message"]]
        self.assertTrue(card.startswith("✅ 실행됨\n승인 필요"), card)
        self.assertIn("outside@example.net", card)

    async def test_an_approved_share_with_query_parameters_executes_with_them(self):
        # Given: a share parked with its query (2026-10-25: the stored query came back as JSON lists
        # and the replay died in urlencode, so the owner's ✅ never ran and no later card ran either).
        self.approval()
        await self.request(path="/www.googleapis.com/drive/v3/files/f/permissions?sendNotificationEmail=true"
                                "&supportsAllDrives=true",
                           data={"type": "user", "role": "reader", "emailAddress": "partner@example.net"})
        entry = self.approve()
        # When: the poller sees the owner's ✅.
        await self.service.poll_approvals()
        # Then: the share runs once, with the same query, and the card says so.
        self.assertEqual([urlsplit(w[1]).path for w in self.writes()], ["/drive/v3/files/f/permissions"])
        self.assertEqual(parse_qs(urlsplit(self.writes()[0][1]).query),
                         {"sendNotificationEmail": ["true"], "supportsAllDrives": ["true"]})
        self.assertEqual(self.changes()[0]["approved_by"], entry["card"])
        self.assertTrue(self.cards[entry["message"]].startswith("✅ 실행됨"))
        self.assertFalse(self.service.pending())

    async def test_an_unexpected_error_in_one_poll_does_not_stop_later_polls(self):
        # Given: the first poll fails with an error no branch expects.
        self.approval()
        self.config["approval"]["poll_seconds"] = 0
        polled = asyncio.Event()
        calls = []

        async def poll():
            calls.append(1)
            if len(calls) == 1:
                raise TypeError("boom")
            polled.set()

        stderr = io.StringIO()
        with patch.object(self.service, "poll_approvals", poll), \
                patch.object(self.service, "close_decided_threads", AsyncMock()), \
                contextlib.redirect_stderr(stderr):
            loop = asyncio.create_task(self.service.approval_loop())
            try:
                # Then: the loop logs the failure by type and polls again.
                await asyncio.wait_for(polled.wait(), 5)
            finally:
                loop.cancel()
                await asyncio.gather(loop, return_exceptions=True)
        self.assertIn("GATE_APPROVAL_CHECK_FAILED TypeError", stderr.getvalue())
        self.assertNotIn("boom", stderr.getvalue())

    async def test_the_bots_own_prefilled_reactions_are_not_an_approval(self):
        self.approval()
        await self.request(data={"attendees": [{"email": "outside@example.net"}]})
        entry = self.service.pending()[0]
        for emoji in ("✅", "⛔"):
            self.reactions[(entry["message"], quote(emoji))] = [{"id": "123", "bot": True}]
        await self.service.poll_approvals()
        self.assertFalse(self.writes())
        self.assertEqual(len(self.service.pending()), 1)

    async def test_nonowner_approval_is_ignored(self):
        self.approval()
        await self.request(data={"attendees": [{"email": "outside@example.net"}]})
        self.approve(owner="2")
        await self.service.poll_approvals()
        self.assertFalse(self.writes())
        self.assertEqual(len(self.service.pending()), 1)

    async def test_owner_cancel_does_not_execute(self):
        self.approval()
        await self.request(data={"attendees": [{"email": "outside@example.net"}]})
        self.approve(emoji="⛔")
        await self.service.poll_approvals()
        self.assertFalse(self.writes())
        self.assertFalse(self.service.pending())

    async def test_a_decided_card_titles_and_archives_its_own_thread(self):
        # Owner 2026-10-19 16:44 KST: the approval result shows in the thread title.
        for emoji, status, title in (("⛔", 200, "⛔ 취소"), ("✅", 200, "✅ 완료"), ("✅", 500, "❗ 실패")):
            self.thread_meta.clear()
            self.thread_patches.clear()
            self.response_status = status
            self.approval()
            await self.request(data={"summary": "Invite", "attendees": [{"email": "outside@example.net"}]})
            entry = self.approve(emoji=emoji)
            await self.service.poll_approvals()
            self.assertEqual(self.thread_patches, [(entry["thread"], {"name": f"{title} · 🔐 일정 초대 · Invite",
                                                                     "archived": True})], emoji + str(status))

    async def test_an_expired_card_titles_its_thread_expired(self):
        self.approval()
        await self.request(data={"summary": "Invite", "attendees": [{"email": "outside@example.net"}]})
        entry = self.service.pending()[0]
        entry["ts"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=25)).isoformat()
        gate.private_write(self.state / "pending" / (entry["id"] + ".json"), gate.json_bytes(entry))
        await self.service.poll_approvals()
        self.assertEqual(self.thread_patches[-1][1]["name"], "⌛ 만료 · 🔐 일정 초대 · Invite")

    async def test_the_owners_own_thread_and_a_thread_with_an_open_card_keep_their_title(self):
        self.approval()
        await self.request(data={"summary": "Invite", "attendees": [{"email": "outside@example.net"}]},
                           origin="555/100")
        self.thread_meta["555"] = {"id": "555", "type": 11, "parent_id": "20", "name": "형의 요청"}
        self.approve(emoji="⛔")
        await self.service.poll_approvals()
        self.assertEqual(self.thread_patches, [])
        await self.request(data={"summary": "A", "attendees": [{"email": "outside@example.net"}]})
        await self.request(data={"summary": "B", "attendees": [{"email": "outside@example.net"}]})
        first = self.service.pending()[0]
        self.reactions[(first["message"], quote("⛔"))] = [{"id": "1", "bot": False}]
        await self.service.poll_approvals()
        self.assertEqual(self.thread_patches, [])
        self.assertEqual(len(self.service.pending()), 1)

    def decided_thread(self, name, archived):
        self.thread_meta["555"] = {"id": "555", "type": 11, "parent_id": "20", "guild_id": "10", "name": name,
                                    "thread_metadata": {"archived": archived}}

    async def test_a_message_into_a_closed_decided_thread_puts_it_back_in_the_archive(self):
        # 2026-10-19: a mail card's thread was renamed and archived, then YooDori's follow-up line
        # reopened it (Discord reopens an archived thread on any new message).
        self.decided_thread("⛔ 취소 · ✉️ 메일 발신 · FW: 자료", archived=True)
        status, _ = await self.request("POST", "/api/v10/channels/555/messages", data={"content": "취소됐어"},
                                       port="discord", headers={"authorization": "Bot MTIz.fake.fake"})
        self.assertEqual(status, 200)
        self.assertEqual(self.thread_patches, [("555", {"archived": True})])

    async def test_a_live_card_after_the_decision_keeps_the_thread_open(self):
        # 2026-10-19: a redone mail card went into the owner's thread already titled cancelled.
        card = {"id": "9", "type": 0, "content": "card", "reactions": [{"emoji": {"name": "✅"}},
                                                                          {"emoji": {"name": "⛔"}}]}
        rename = {"id": "8", "type": 4, "content": "⛔ 취소 · ✉️ 메일 발신 · FW: 자료"}
        old_card = dict(card, id="7")
        line = {"id": "10", "type": 0, "content": "새 카드 올렸어", "reactions": []}
        for history, patched in (([line, card, rename, old_card], False), ([line, rename, old_card], True)):
            with self.subTest(patched=patched):
                self.thread_patches.clear()
                self.thread_history["555"] = history
                self.decided_thread("⛔ 취소 · ✉️ 메일 발신 · FW: 자료", archived=True)
                status, _ = await self.request("POST", "/api/v10/channels/555/messages", data={"content": "네"},
                                               port="discord", headers={"authorization": "Bot MTIz.fake.fake"})
                self.assertEqual(status, 200)
                self.assertEqual(self.thread_patches, [("555", {"archived": True})] if patched else [])

    async def test_a_message_into_an_open_or_undecided_thread_leaves_it_open(self):
        for name, archived in (("⛔ 취소 · ✉️ 메일 발신 · FW: 자료", False), ("형의 요청", True),
                               ("✉️ 메일 발신 · FW: 자료", True)):
            with self.subTest(name=name, archived=archived):
                self.thread_patches.clear()
                self.decided_thread(name, archived)
                status, _ = await self.request("POST", "/api/v10/channels/555/messages", data={"content": "네"},
                                               port="discord", headers={"authorization": "Bot MTIz.fake.fake"})
                self.assertEqual(status, 200)
                self.assertEqual(self.thread_patches, [])

    async def test_the_start_sweep_titles_threads_decided_before_the_rule(self):
        self.approval()
        await self.request(data={"summary": "Old", "attendees": [{"email": "outside@example.net"}]})
        self.approve(emoji="⛔")
        with patch.object(self.service, "close_card_thread", lambda *a: asyncio.sleep(0)):
            await self.service.poll_approvals()
        await self.request(data={"summary": "Open", "attendees": [{"email": "outside@example.net"}]},
                           origin="30/100")
        self.assertEqual(self.thread_patches, [])
        await self.service.close_decided_threads()
        self.assertEqual(self.thread_patches, [("100", {"name": "⛔ 취소 · 🔐 일정 초대 · Old",
                                                         "archived": True})])

    async def test_tampered_card_never_executes_or_edits(self):
        self.approval()
        await self.request(data={"attendees": [{"email": "outside@example.net"}]})
        entry = self.approve()
        self.cards[entry["message"]] = "tampered"
        await self.service.poll_approvals()
        self.assertFalse(self.writes())
        self.assertEqual(self.cards[entry["message"]], "tampered")
        self.assertEqual(self.service.records("denials.jsonl")[-1]["reason"], "card-tampered")

    async def test_expired_card_does_not_execute(self):
        self.approval()
        await self.request(data={"attendees": [{"email": "outside@example.net"}]})
        entry = self.approve()
        entry["ts"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=25)).isoformat()
        gate.private_write(self.state / "pending" / (entry["id"] + ".json"), gate.json_bytes(entry))
        await self.service.poll_approvals()
        self.assertFalse(self.writes())
        self.assertFalse(self.service.pending())

    async def test_approval_does_not_execute_changed_upstream_context(self):
        self.approval()
        self.event["attendees"] = [{"email": "external@example.net"}]
        await self.request("PATCH", "/www.googleapis.com/calendar/v3/calendars/primary/events/e")
        self.approve()
        self.event["attendees"] = [{"email": "different@example.net"}]
        await self.service.poll_approvals()
        self.assertFalse(self.writes())
        self.assertEqual(self.service.records("denials.jsonl")[0]["reason"], "approval-context-changed")

    async def test_missing_card_cancels(self):
        self.approval()
        await self.request(data={"attendees": [{"email": "outside@example.net"}]})
        self.cards.clear()
        await self.service.poll_approvals()
        self.assertFalse(self.service.pending())
        self.assertFalse(self.writes())

    async def test_existing_external_attendee_needs_card(self):
        self.approval()
        self.event["attendees"] = [{"email": "external@example.net"}]
        self.assertEqual((await self.request("PATCH", "/www.googleapis.com/calendar/v3/calendars/primary/events/e"))[0], 202)
        self.assertFalse(self.writes())

    async def test_foreign_organizer_needs_card(self):
        self.approval()
        self.event["organizer"] = {"email": "other@example.net"}
        self.assertEqual((await self.request("DELETE", "/www.googleapis.com/calendar/v3/calendars/primary/events/e"))[0], 202)

    async def test_calendar_not_owned_needs_card(self):
        self.approval()
        self.calendar_role = "writer"
        self.assertEqual((await self.request())[0], 202)
        self.assertFalse(self.writes())

    async def test_public_calendar_needs_card(self):
        self.approval()
        self.calendar_public = True
        self.assertEqual((await self.request())[0], 202)

    async def test_calendar_owner_acl_is_direct_external_acl_is_card(self):
        self.approval()
        for value, expected in (("OWNER@example.com", 200), ("other@example.net", 202)):
            with self.subTest(value=value):
                status, _ = await self.request(path="/www.googleapis.com/calendar/v3/calendars/primary/acl",
                                              data={"scope": {"type": "user", "value": value}, "role": "reader"})
                self.assertEqual(status, expected)

    async def test_calendar_forbidden_routes_and_attachments(self):
        for suffix in ("events/quickAdd", "events/import", "events/e/move", "events/watch", "watch"):
            with self.subTest(suffix=suffix):
                status, _ = await self.request(path="/www.googleapis.com/calendar/v3/calendars/primary/" + suffix)
                self.assertEqual(status, 403)
        self.assertEqual((await self.request(data={"attachments": []}))[0], 403)

    async def test_drive_permanent_delete_is_refused(self):
        self.assertEqual((await self.request("DELETE", "/www.googleapis.com/drive/v3/files/f"))[0], 403)
        self.assertFalse(self.writes())

    async def test_anyone_permission_needs_card(self):
        self.approval()
        status, _ = await self.request(path="/www.googleapis.com/drive/v3/files/f/permissions",
                                       data={"type": "anyone", "role": "reader"})
        self.assertEqual(status, 202)
        self.assertFalse(self.writes())

    async def test_owner_permission_is_direct(self):
        status, _ = await self.request(path="/www.googleapis.com/drive/v3/files/f/permissions",
                                       data={"type": "user", "emailAddress": "OWNER@example.com", "role": "reader"})
        self.assertEqual(status, 200)

    async def test_drive_foreign_target_needs_card(self):
        self.approval()
        self.file_owned = False
        self.assertEqual((await self.request("PATCH", "/www.googleapis.com/drive/v3/files/f", data={"name": "new"}))[0], 202)
        self.assertFalse(self.writes())

    async def test_drive_public_parent_needs_card(self):
        self.approval()
        self.file_public = True
        self.assertEqual((await self.request(path="/www.googleapis.com/drive/v3/files", data={"parents": ["folder"]}))[0], 202)

    async def test_drive_shared_target_needs_card(self):
        self.approval()
        self.shared_drive = True
        self.assertEqual((await self.request("PATCH", "/www.googleapis.com/drive/v3/files/f"))[0], 202)

    async def test_drive_comments_need_card(self):
        self.approval()
        self.assertEqual((await self.request(path="/www.googleapis.com/drive/v3/files/f/comments", data={"content": "text"}))[0], 202)

    async def test_spreadsheet_conversion_needs_card(self):
        self.approval()
        self.assertEqual((await self.request(path="/www.googleapis.com/drive/v3/files", data={"mimeType": gate.SHEET}))[0], 202)
        self.assertFalse(self.writes())

    async def test_multipart_spreadsheet_conversion_needs_card(self):
        self.approval()
        raw = (b'--b\r\nContent-Type: application/json\r\n\r\n{"mimeType":"' + gate.SHEET.encode() +
               b'"}\r\n--b\r\nContent-Type: text/csv\r\n\r\nx,y\r\n--b--\r\n')
        status, _ = await self.request(path="/www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
                                       raw=raw, headers={"content-type": "multipart/related; boundary=b"})
        self.assertEqual(status, 202)
        self.assertFalse(self.writes())

    async def test_sheets_writes_need_card(self):
        self.approval()
        self.assertEqual((await self.request(path="/sheets.googleapis.com/v4/spreadsheets/s:batchUpdate",
                                            data={"requests": []}))[0], 202)
        self.assertFalse(self.writes())

    async def test_docs_dangerous_nested_keys_need_card(self):
        self.approval()
        for key in ("uri", "insertInlineImage", "replaceImage"):
            with self.subTest(key=key):
                status, _ = await self.request(path="/docs.googleapis.com/v1/documents/d:batchUpdate",
                                              data={"requests": [{"nested": {key: "https://outside.example/image"}}]})
                self.assertEqual(status, 202)
        self.assertFalse(self.writes())

    async def test_docs_owned_update_records_revision_and_refuses_restore(self):
        status, _ = await self.request(path="/docs.googleapis.com/v1/documents/d:batchUpdate", data={"requests": []})
        self.assertEqual(status, 200)
        row = self.changes()[0]
        self.assertEqual(json.loads((self.state / row["snapshot"]).read_text())["revisionId"], "revision")
        self.assertEqual((await self.request(path="/_gate/restore/" + row["id"]))[0], 409)

    async def test_gmail_write_is_never_proxied(self):
        self.approval()
        status, body = await self.request(path="/gmail.googleapis.com/gmail/v1/users/me/messages/send")
        self.assertEqual(status, 403)
        self.assertIn("mail-send-not-here", json.loads(body)["error"])
        self.assertFalse(self.writes())
        self.assertFalse(self.service.pending())

    async def test_gmail_settings_read_is_allowed(self):
        self.assertEqual((await self.request("GET", "/gmail.googleapis.com/gmail/v1/users/me/settings/filters", proof=False))[0], 200)

    async def test_contacts_search_and_lookup_reads_are_proxied_with_the_gate_token(self):
        for route in ["v1/people:searchContacts?query=kim&readMask=names,emailAddresses",
                      "v1/otherContacts:search?query=kim&readMask=emailAddresses",
                      "v1/otherContacts?readMask=emailAddresses", "v1/people/me/connections?personFields=names",
                      "v1/people/c123?personFields=emailAddresses", "v1/people:batchGet?resourceNames=people/c1"]:
            status, _ = await self.request("GET", "/people.googleapis.com/" + route, proof=False,
                                           headers={"authorization": "Bearer caller-secret"})
            self.assertEqual(status, 200, route)
            self.assertEqual(urlsplit(self.seen[-1][1]).path, "/" + route.partition("?")[0])
            self.assertEqual(self.seen[-1][2]["authorization"], "Bearer access-secret")

    async def test_contacts_writes_and_unlisted_reads_are_refused_before_google(self):
        self.approval()
        for method, route in [("POST", "v1/people:createContact"), ("PATCH", "v1/people/c1:updateContact"),
                              ("DELETE", "v1/people/c1:deleteContact"), ("POST", "v1/people:batchCreateContacts"),
                              ("POST", "v1/people:batchDeleteContacts"), ("PATCH", "v1/people/c1:updateContactPhoto"),
                              ("POST", "v1/otherContacts/c1:copyOtherContactToMyContactsGroup"),
                              ("POST", "v1/contactGroups"), ("GET", "v1/contactGroups"),
                              ("GET", "v1/people:searchDirectoryPeople?query=kim"),
                              ("GET", "v1/people:listDirectoryPeople"), ("GET", "v1/people/c1/photos"),
                              ("HEAD", "v1/people:searchContacts"), ("GET", "v2/people:searchContacts")]:
            before = len(self.seen)
            status, body = await self.request(method, "/people.googleapis.com/" + route)
            self.assertEqual(status, 403, (method, route))
            if method != "HEAD":
                self.assertEqual(json.loads(body)["error"], "contacts-read-only", (method, route))
            self.assertFalse([r for r in self.seen[before:] if not r[1].startswith("/api/v10")], (method, route))
        self.assertFalse(self.service.pending())

    async def test_oauth_host_is_not_proxied(self):
        self.assertEqual((await self.request("GET", "/oauth2.googleapis.com/token", proof=False))[0], 403)

    async def test_tasks_allowed_and_forbidden_routes(self):
        for method, route, expected in [
            ("POST", "users/@me/lists", 200), ("PATCH", "users/@me/lists/l", 200),
            ("POST", "lists/l/tasks", 200), ("PATCH", "lists/l/tasks/t", 200),
            ("POST", "lists/l/tasks/t/move", 200), ("DELETE", "lists/l/tasks/t", 200),
            ("POST", "lists/l/clear", 403), ("DELETE", "users/@me/lists/l", 403)]:
            with self.subTest(route=route, method=method):
                self.assertEqual((await self.request(method, "/tasks.googleapis.com/tasks/v1/" + route))[0], expected)

    async def test_trash_is_allowed_and_restorable(self):
        status, _ = await self.request("PATCH", "/www.googleapis.com/drive/v3/files/f", data={"trashed": True})
        self.assertEqual(status, 200)
        row = self.changes()[0]
        self.assertTrue(row["restorable"])
        status, _ = await self.request(path="/_gate/restore/" + row["id"])
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(self.writes()[-1][3])["trashed"])

    async def test_change_has_private_snapshot_and_owner_link(self):
        status, _ = await self.request("PATCH", "/www.googleapis.com/calendar/v3/calendars/primary/events/e?key=secret&access_token=secret",
                                      data={"summary": "new"})
        self.assertEqual(status, 200)
        row = self.changes()[0]
        self.assertEqual(row["owner_message"], "https://discord.com/channels/10/20/100")
        self.assertEqual(json.loads((self.state / row["snapshot"]).read_text())["summary"], "Before")
        self.assertEqual(row["snapshot"], f"snapshots/{row['id']}.json")
        self.assertEqual((self.state / row["snapshot"]).stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.state / "changes.jsonl").stat().st_mode & 0o777, 0o600)
        self.assertNotIn("secret", row["path"])

    async def test_deleted_event_restore_reinserts_without_sensitive_fields(self):
        await self.request("DELETE", "/www.googleapis.com/calendar/v3/calendars/primary/events/e")
        row = self.changes()[0]
        status, _ = await self.request(path="/_gate/restore/" + row["id"])
        self.assertEqual(status, 200)
        method, target, _, body = self.writes()[-1]
        self.assertEqual(method, "POST")
        self.assertTrue(urlsplit(target).path.endswith("/events"))
        self.assertFalse({"id", "etag", "iCalUID"} & json.loads(body).keys())
        self.assertEqual(parse_qs(urlsplit(target).query)["sendUpdates"], ["none"])

    async def test_failed_upstream_is_journaled_without_resource(self):
        self.response_status = 400
        self.assertEqual((await self.request())[0], 400)
        self.assertEqual(self.changes()[0]["resource"], {})
        self.assertEqual(self.changes()[0]["status"], 400)

    async def test_diagnostics_and_journals_do_not_log_credentials_or_bodies(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            await self.request(path="/tasks.googleapis.com/tasks/v1/lists/l/tasks",
                               data={"notes": "body-secret"},
                               headers={"authorization": "Bearer caller-secret"})
            await self.request(path="/gmail.googleapis.com/gmail/v1/users/me/messages/send?access_token=query-secret",
                               raw=b"body-secret", proof=False,
                               headers={"authorization": "Bearer caller-secret"})
        logs = output.getvalue()
        for name in ("changes.jsonl", "denials.jsonl"):
            logs += (self.state / name).read_text()
        for secret in ("access-secret", "refresh-secret", "caller-secret", "query-secret", "body-secret"):
            with self.subTest(secret=secret):
                self.assertNotIn(secret, logs)

    async def test_eleventh_delete_is_parked(self):
        self.approval()
        for _ in range(10):
            self.assertEqual((await self.request("DELETE", "/tasks.googleapis.com/tasks/v1/lists/l/tasks/t"))[0], 200)
        self.assertEqual((await self.request("DELETE", "/tasks.googleapis.com/tasks/v1/lists/l/tasks/t"))[0], 202)
        self.assertEqual(len(self.writes()), 10)

    async def test_drive_trash_counts_towards_delete_cap(self):
        self.approval()
        self.config["limits"] = {"deletes_per_hour": 1}
        await self.request("PATCH", "/www.googleapis.com/drive/v3/files/f", data={"trashed": True})
        self.assertEqual((await self.request("PATCH", "/www.googleapis.com/drive/v3/files/f", data={"trashed": True}))[0], 202)

    async def test_thirty_first_owner_message_write_is_card(self):
        self.approval()
        for _ in range(30):
            self.assertEqual((await self.request(path="/tasks.googleapis.com/tasks/v1/lists/l/tasks"))[0], 200)
        self.assertEqual((await self.request(path="/tasks.googleapis.com/tasks/v1/lists/l/tasks"))[0], 202)
        self.assertEqual(len(self.writes()), 30)

    async def order_request(self, order="17", **kwargs):
        return await self.request(proof=False, headers={"x-dori-owner-order": order, **kwargs.pop("headers", {})},
                                  **kwargs)

    def order_reads(self):
        return [r for r in self.seen if r[1].startswith("/api/orders/")]

    def order_uses(self):
        return [r[1] for r in self.order_reads() if r[0] == "POST"]

    async def test_dashboard_order_is_owner_proof_and_journaled(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            status, _ = await self.order_request(data={"summary": "화요일 3시 회의"})
        self.assertEqual(status, 200)
        self.assertEqual(len(self.writes()), 1)
        self.assertNotIn("x-dori-owner-order", self.writes()[0][2])
        row = self.changes()[0]
        self.assertEqual(row["owner_message"], self.base + "/api/orders/17")
        self.assertEqual(self.order_uses(), ["/api/orders/17/use"])
        self.assertEqual(row["owner_order"], {"id": "17", "url": self.base + "/api/orders/17",
                                              "body_sha256": "a" * 64, "created_at": self.order["created_at"],
                                              "device": "nPHONE11CNTRL"})
        self.assertEqual(row["resource"]["summary"], "화요일 3시 회의")
        logs = output.getvalue() + (self.state / "changes.jsonl").read_text()
        self.assertNotIn("dashboard-secret", logs)

    async def test_dashboard_order_link_setting_names_the_page(self):
        self.config["owner_order"]["link"] = "https://board.example.ts.net/orders/{id}"
        self.assertEqual((await self.order_request(path="/tasks.googleapis.com/tasks/v1/lists/l/tasks"))[0], 200)
        self.assertEqual(self.changes()[0]["owner_order"]["url"], "https://board.example.ts.net/orders/17")

    async def test_dashboard_order_that_is_not_the_owners_command_is_refused(self):
        old = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=25)).isoformat()
        ahead = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).isoformat()
        cases = {"unknown order": ({}, "18"), "too old": ({"created_at": old}, "17"),
                 "from the future": ({"created_at": ahead}, "17"), "no timezone": ({"created_at": "2026-10-21T00:00:00"}, "17"),
                 "other login": ({"created_by": "guest@example.com"}, "17"),
                 "made on the node, not through the tailnet": ({"via": "local"}, "17"),
                 "typed on a server of the owner's tailnet": ({"via": "tailnet", "device": "nSERVER11CNTRL"}, "17"),
                 "no route": ({"via": None}, "17"),
                 "no device": ({"device": ""}, "17"), "device missing": ({"device": None}, "17"),
                 "device not a name": ({"device": ["nPHONE11CNTRL"]}, "17"),
                 "done": ({"status": "끝"}, "17"), "unknown status": ({"status": "received"}, "17"),
                 "other number": ({"number": 99, "asked_as": 17}, "17"), "no body hash": ({"body_sha256": ""}, "17"),
                 "empty id": ({}, "")}
        original = dict(self.order)
        for name, (change, order) in cases.items():
            with self.subTest(name):
                self.order = {**original, **change}
                status, body = await self.order_request(order)
                self.assertEqual((status, json.loads(body)["error"]), (403, "owner-message-required" if not order
                                                                      else "owner-order-required"))
        self.assertEqual(self.writes(), [])
        self.assertEqual(self.changes(), [])
        self.assertEqual(self.order_uses(), [])

    async def test_gate_owner_devices_must_also_list_the_device(self):
        self.config["owner_order"]["owner_devices"] = ["nLAPTOP11CNTRL", "NPHONE11CNTRL"]
        self.assertEqual((await self.order_request(path="/tasks.googleapis.com/tasks/v1/lists/l/tasks"))[0], 200)
        self.order = {**self.order, "device": "nSERVER11CNTRL"}  # the board called it owner-device, the gate list disagrees
        status, body = await self.order_request(path="/tasks.googleapis.com/tasks/v1/lists/l/tasks")
        self.assertEqual((status, json.loads(body)["error"]), (403, "owner-order-required"))
        self.assertEqual(len(self.writes()), 1)
        self.assertEqual(self.changes()[0]["owner_order"]["device"], "nPHONE11CNTRL")

    async def test_malformed_order_number_never_reaches_the_dashboard(self):
        for order in ("../17", "017", "o17", "17/use", "17%2Fuse", "1" * 10, "-17"):
            with self.subTest(order):
                status, body = await self.order_request(order)
                self.assertEqual((status, json.loads(body)["error"]), (403, "owner-order-required"))
        self.assertEqual(self.order_reads(), [])
        self.assertEqual(self.writes(), [])

    async def test_dashboard_order_needs_the_setting_and_its_token(self):
        self.order_reply = None
        (self.state / "dashboard").write_text("wrong")
        self.assertEqual(json.loads((await self.order_request())[1])["error"], "owner-order-required")
        del self.config["owner_order"]
        self.assertEqual(json.loads((await self.order_request())[1])["error"], "owner-order-required")
        self.assertEqual(self.order_reads()[0][2]["x-pb-gate-token"], "wrong")
        self.assertNotIn("authorization", self.order_reads()[0][2])
        self.assertEqual(len(self.order_reads()), 1)
        self.assertEqual(self.writes(), [])

    async def test_dashboard_without_an_answer_refuses_the_write(self):
        replies = {"server error": (500, b'{"error":"x"}'), "not json": (200, b"<html>"),
                   "not an object": (200, b"[1]")}
        for name, answer in replies.items():
            with self.subTest(name):
                self.order_reply = answer
                self.assertEqual((await self.order_request())[0], 403)
        self.order_reply = None
        with socket.socket() as unused:
            unused.bind(("127.0.0.1", 0))
            self.config["owner_order"]["api_base"] = "http://127.0.0.1:%d" % unused.getsockname()[1]
        with self.subTest("dashboard down"):
            self.assertEqual(json.loads((await self.order_request())[1])["error"], "owner-order-required")
        self.assertEqual(self.writes(), [])

    async def test_dashboard_that_cannot_record_the_use_refuses_the_write(self):
        for name, answer in {"use refused": (404, b"not found"), "other order": (200, gate.json_bytes({"number": 99})),
                             "not json": (200, b"<html>")}.items():
            with self.subTest(name):
                self.use_reply = answer
                self.assertEqual(json.loads((await self.order_request())[1])["error"], "owner-order-required")
        self.assertEqual(len(self.order_uses()), 3)
        self.assertEqual(self.writes(), [])

    async def test_dashboard_order_has_no_write_count_limit_only_the_window(self):
        # Owner 2026-10-21 23:55 KST Q353 "횟수 제한 없애고 24시간 창만": neither an order cap nor the owner-message
        # write limit turns an order's later writes into a refusal or a card; every use is still recorded.
        self.approval()
        self.config["limits"] = {"writes_per_owner_order": 1, "writes_per_owner_message": 1}
        self.order = {**self.order, "uses": 500}
        for _ in range(4):
            self.assertEqual((await self.order_request(path="/tasks.googleapis.com/tasks/v1/lists/l/tasks"))[0], 200)
        self.assertEqual((len(self.writes()), len(self.order_uses()), self.service.pending()), (4, 4, []))
        self.order = {**self.order, "created_at": (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=25)).isoformat()}
        status, body = await self.order_request(path="/tasks.googleapis.com/tasks/v1/lists/l/tasks")
        self.assertEqual((status, json.loads(body)["error"]), (403, "owner-order-required"))
        self.assertEqual(len(self.writes()), 4)
        status, _ = await self.request(path="/tasks.googleapis.com/tasks/v1/lists/l/tasks")
        self.assertEqual(status, 200)
        self.assertEqual((await self.request(path="/tasks.googleapis.com/tasks/v1/lists/l/tasks"))[0], 202)

    async def test_dashboard_order_cannot_skip_the_outbound_card(self):
        self.approval()
        status, body = await self.order_request("17", data={"attendees": [{"email": "outside@example.net"}]})
        self.assertEqual((status, json.loads(body)["status"]), (202, "pending_approval"))
        self.assertEqual(self.writes(), [])
        entry = self.service.pending()[0]
        self.assertEqual(entry["owner_order"]["id"], "17")
        self.assertEqual(self.created_threads, ["/channels/20/threads"])
        self.assertFalse([r for r in self.seen if r[1].startswith("/api/v10/channels/orders")])
        status, body = await self.order_request("17", path="/gmail.googleapis.com/gmail/v1/users/me/messages/send")
        self.assertEqual((status, json.loads(body)["error"]), (403, "mail-send-not-here"))
        self.service.order_facts.clear()  # as after a restart: the pending record carries the order
        self.approve()
        await self.service.poll_approvals()
        self.assertEqual(len(self.writes()), 1)
        row = self.changes()[0]
        self.assertEqual((row["owner_order"]["id"], row["approved_by"]), ("17", entry["card"]))

    async def test_owner_message_wins_over_a_dashboard_order(self):
        status, _ = await self.request(headers={"x-dori-owner-order": "17"})
        self.assertEqual(status, 200)
        self.assertEqual(self.changes()[0]["owner_message"], "https://discord.com/channels/10/20/100")
        self.assertNotIn("owner_order", self.changes()[0])
        self.assertEqual(self.order_reads(), [])

    async def test_pending_listing_and_card_client_protection(self):
        self.approval()
        await self.request(data={"attendees": [{"email": "outside@example.net"}]})
        entry = self.service.pending()[0]
        status, body = await self.request("GET", "/_gate/pending", proof=False)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)[0]["id"], entry["id"])
        path = f"/api/v10/channels/{entry['channel']}/messages/{entry['message']}"
        for method, suffix in (("PATCH", ""), ("DELETE", ""), ("PUT", "/reactions/x/@me"),
                               ("DELETE", "/reactions/x/@me")):
            with self.subTest(method=method):
                status, body = await self.request(method, path + suffix, port="discord",
                                                  headers={"authorization": "Bot MTIz.fake.fake"})
                self.assertEqual(status, 403)
                self.assertEqual(json.loads(body)["error"], "card-protected")

    async def test_foreign_webhook_refused_and_own_application_allowed(self):
        for identity, expected in (("999", 403), ("123", 200)):
            with self.subTest(identity=identity):
                self.assertEqual((await self.request(path=f"/api/v10/webhooks/{identity}/capability-secret",
                    port="discord", headers={"authorization": "Bot MTIz.fake.fake"}))[0], expected)
        text = (self.state / "denials.jsonl").read_text()
        self.assertNotIn("capability-secret", text)
        self.assertNotIn("MTIz.fake.fake", text)

    async def test_discord_foreign_guild_channel_and_nonowner_dm_refused(self):
        for route, method, data, expected in [
            ("/channels/99/messages", "POST", {"content": "hello"}, 403), ("/channels/20/messages", "POST", {"content": "hello"}, 200),
            ("/guilds/99/channels", "GET", {}, 403), ("/users/@me/channels", "POST", {"recipient_id": "2"}, 403),
            ("/users/@me/channels", "POST", {"recipient_id": "1"}, 200),
            ("/channels/22/messages", "POST", {"content": "hello"}, 403), ("/channels/21/messages", "POST", {"content": "hello"}, 200)]:
            with self.subTest(route=route, data=data):
                self.assertEqual((await self.request(method, "/api/v10" + route, data=data,
                    port="discord", headers={"authorization": "Bot MTIz.fake.fake"}))[0], expected)

    async def test_discord_message_links_only_to_allowed_hosts(self):
        for content, expected in [
            ("see https://evil.example/?d=secret", 403),
            ("masked [doc](https://evil.example/x)", 403),
            ("https:\\/\\/evil.example", 403),
            ("doc https://docs.google.com/document/d/abc/edit", 200),
            ("no link at all", 200)]:
            with self.subTest(content=content):
                data = {"content": content} if "\\/" not in content else None
                raw = None if data else b'{"content": "https:\\/\\/evil.example"}'
                status, body = await self.request("POST", "/api/v10/channels/20/messages", data=data, raw=raw,
                    port="discord", headers={"authorization": "Bot MTIz.fake.fake", "content-type": "application/json"})
                self.assertEqual(status, expected)
                if expected == 403:
                    self.assertEqual(json.loads(body)["error"], "external-url-in-message")
        status, _ = await self.request("POST", "/api/v10/channels/20/messages", data={"embeds": [{"image": {"url": "https://evil.example/p.png"}}]},
            port="discord", headers={"authorization": "Bot MTIz.fake.fake"})
        self.assertEqual(status, 403)

    async def test_discord_invites_webhooks_and_followers_are_refused(self):
        for suffix in ("invites", "webhooks", "followers"):
            with self.subTest(suffix=suffix):
                self.assertEqual((await self.request(path="/api/v10/channels/20/" + suffix, port="discord",
                    headers={"authorization": "Bot MTIz.fake.fake"}))[0], 403)

    async def test_discord_unicode_reaction_path_is_preserved(self):
        status, _ = await self.request("PUT", "/api/v10/channels/20/messages/42/reactions/%E2%9C%85/@me",
                                       port="discord", headers={"authorization": "Bot MTIz.fake.fake"})
        self.assertEqual(status, 200)
        self.assertIn("/reactions/%E2%9C%85/", self.seen[-1][1])

    async def test_client_cannot_use_admin_paths(self):
        self.assertEqual((await self.request("GET", "/_admin/status", proof=False))[0], 403)

    async def test_admin_cannot_proxy_client_apis(self):
        self.config["clients"] = []
        self.config["admins"] = [os.getuid()]
        self.assertEqual((await self.request("GET", "/www.googleapis.com/drive/v3/files/f"))[0], 403)
        self.assertEqual((await self.request("GET", "/_gate/changes"))[0], 200)

    async def finish_auth(self, scope):
        self.config["admins"] = [os.getuid()]
        status, content = await self.request(path="/_admin/auth-url", proof=False)
        self.assertEqual(status, 200)
        params = parse_qs(urlsplit(json.loads(content)["url"]).query)
        self.assertEqual(params["code_challenge_method"], ["S256"])
        self.scope = scope
        return await self.request(path="/_admin/auth-finish", proof=False,
            data={"redirect": "http://localhost/?code=fake&state=" + params["state"][0]})

    async def test_auth_finish_rejects_all_send_capable_gmail_scopes(self):
        previous = (self.state / "google-token.json").read_bytes()
        for scope in sorted(gate.BAD_SCOPES) + ["https://mail.google.com/"]:
            actual = "https://www.googleapis.com/auth/" + scope if scope.startswith("gmail.") else scope
            self.config["google_scopes"].append(actual)
            with self.subTest(scope=actual):
                status, content = await self.finish_auth("openid " + actual)
                self.assertEqual(status, 403)
                self.assertEqual(json.loads(content)["error"], "unsafe-google-scope")
                self.assertEqual((self.state / "google-token.json").read_bytes(), previous)

    async def test_auth_finish_accepts_googles_email_alias_as_it_really_answers(self):
        status, content = await self.finish_auth("email profile openid")
        self.assertEqual(status, 200, content)

    async def test_auth_finish_accepts_configured_scopes_and_rejects_extra(self):
        self.assertEqual((await self.finish_auth("openid"))[0], 200)
        self.assertEqual((self.state / "google-token.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((await self.finish_auth("openid https://example.invalid/unconfigured"))[0], 403)

    async def test_tokeninfo_does_not_return_token(self):
        self.config["admins"] = [os.getuid()]
        status, body = await self.request("GET", "/_admin/tokeninfo", proof=False)
        self.assertEqual(status, 200)
        self.assertEqual(set(json.loads(body)), {"scope", "email", "expires_in"})

    async def test_vault_without_config_is_unavailable(self):
        self.assertEqual((await self.request("PUT", "/_vault/note?path=Notes/a.md"))[0], 503)

    async def test_invalid_reverse_paths_are_refused(self):
        for path in ("http://example.com/", "//example.com/", "/www.googleapis.com/a/../b",
                     "/www.googleapis.com/a/%2e%2e/b", "/www.googleapis.com/a/%252e%252e/b",
                     "/www.googleapis.com/a\\b", "/www.googleapis.com/a//b"):
            with self.subTest(path=path):
                self.assertEqual((await self.request("GET", path))[0], 400)

    async def test_chunked_request_decodes_and_ambiguity_is_refused(self):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.ports["google"])
        try:
            writer.write(b"POST /tasks.googleapis.com/tasks/v1/lists/l/tasks HTTP/1.1\r\nHost: ignored\r\n"
                         b"X-Dori-Owner-Message: 20/100\r\nTransfer-Encoding: chunked\r\n"
                         b"Content-Type: application/json\r\n\r\n2\r\n{}\r\n0\r\n\r\n")
            await writer.drain()
            self.assertIn(b" 200 ", (await reader.read()).split(b"\r\n", 1)[0])
            self.assertEqual(self.writes()[-1][3], b"{}")
            self.assertNotIn("transfer-encoding", self.writes()[-1][2])
        finally:
            writer.close()
            await writer.wait_closed()
        self.assertEqual((await self.request(headers={"transfer-encoding": "chunked"}))[0], 400)

    async def test_body_cap_refuses_before_reading_payload(self):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.ports["google"])
        try:
            writer.write(f"POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: {gate.BODY_CAP + 1}\r\n\r\n".encode())
            await writer.drain()
            self.assertIn(b" 413 ", await reader.read())
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_connect_unknown_host_and_plain_proxy_are_refused(self):
        self.assertEqual((await self.request("CONNECT", "unknown.example:443", port="connect"))[0], 403)
        self.assertEqual((await self.request("GET", "http://example.com/", port="connect"))[0], 405)

    async def test_connect_private_dns_is_refused(self):
        loop = asyncio.get_running_loop()
        with patch.object(loop, "getaddrinfo", return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]):
            self.assertEqual((await self.request("CONNECT", "example.com:443", port="connect"))[0], 403)

    async def test_connect_allow_uses_validated_public_address(self):
        remote_reader = asyncio.StreamReader()
        remote_reader.feed_eof()
        class Writer:
            def write(self, data): pass
            async def drain(self): pass
            def close(self): pass
            async def wait_closed(self): pass
        loop = asyncio.get_running_loop()
        original = asyncio.open_connection
        async def connection(host, port):
            if host == "93.184.216.34":
                return remote_reader, Writer()
            return await original(host, port)
        with patch.object(loop, "getaddrinfo", return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]), patch.object(
                asyncio, "open_connection", side_effect=connection):
            self.assertEqual((await self.request("CONNECT", "example.com:443", port="connect"))[0], 200)

    async def test_connect_preserves_gateway_frames_and_compressed_binary_bytes(self):
        # CONNECT carries TLS bytes, not WebSocket messages: no opcode or zlib interpretation.
        payload = b"\x81\x82mask\x89\x00\x82\x08\x78\x9c\x00\x00\xff\xff\x88\x02\x0f\xa1"
        received = asyncio.get_running_loop().create_future()

        async def echo(reader, writer):
            try:
                data = await reader.readexactly(len(payload))
                received.set_result(data)
                writer.write(data)
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        remote = await asyncio.start_server(echo, "127.0.0.1", 0)
        self.addAsyncCleanup(remote.wait_closed)
        self.addCleanup(remote.close)
        port = remote.sockets[0].getsockname()[1]
        original = asyncio.open_connection

        async def connection(host, target_port):
            return await original("127.0.0.1", port) if host == "93.184.216.34" else await original(host, target_port)

        loop = asyncio.get_running_loop()
        with patch.object(loop, "getaddrinfo", return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]), patch.object(
                asyncio, "open_connection", side_effect=connection):
            reader, writer = await original("127.0.0.1", self.ports["connect"])
            try:
                writer.write(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n")
                await writer.drain()
                self.assertIn(b" 200 ", await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5))
                writer.write(payload)
                await writer.drain()
                self.assertEqual(await asyncio.wait_for(reader.readexactly(len(payload)), 5), payload)
                self.assertEqual(await asyncio.wait_for(received, 5), payload)
            finally:
                writer.close()
                await writer.wait_closed()

    async def test_owner_dm_history_is_readable_but_other_dm_history_is_refused(self):
        for channel, expected in [("21", 200), ("22", 403)]:
            status, _ = await self.request(
                "GET", path=f"/api/v10/channels/{channel}/messages?after=100&limit=100",
                port="discord", headers={"authorization": "Bot client"})
            self.assertEqual(status, expected)

    async def test_unknown_uid_is_disconnected(self):
        self.config["proc_tcp_paths"] = [str(self.state / "missing-proc")]
        reader, writer = await asyncio.open_connection("127.0.0.1", self.ports["google"])
        try:
            self.assertEqual(await reader.read(), b"")
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_summary_posts_title_and_owner_link(self):
        self.approval()
        await self.request(data={"summary": "Daily title"})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            await asyncio.to_thread(summary.post_summary, self.config, 24)
        text = "\n".join(self.cards.values())
        self.assertIn("Daily title", text)
        self.assertNotIn("https://discord.com/channels/10/20/100", text)
        self.assertEqual(text.splitlines()[-1], "자세한 건 물어보면 올림")
        journal = (self.state / "changes.jsonl").read_text()
        self.assertIn("https://discord.com/channels/10/20/100", journal)
        self.assertTrue(output.getvalue().startswith("SUMMARY_POSTED"))
        self.assertTrue(all(len(c) < 1900 for c in self.cards.values()))

    async def test_summary_empty_posts_nothing(self):
        self.approval()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            await asyncio.to_thread(summary.post_summary, self.config, 24)
        self.assertEqual(output.getvalue().strip(), "SUMMARY_EMPTY")
        self.assertFalse(self.cards)

    async def test_startup_example_ready_shutdown_releases_ports(self):
        config = json.loads(Path(__file__).with_name("config.example.json").read_text())
        root = self.state / "startup"
        root.mkdir()
        config.update(state=str(root / "state"), listen={"connect": 0, "google": 0, "discord": 0},
                      upstreams=self.config["upstreams"], discord_api_base=self.base + "/api/v10",
                      tokeninfo_url=self.base + "/tokeninfo", connect_allow=[])
        config["owner_proof"]["token_file"] = str(self.state / "bot")
        path = root / "config.json"
        path.write_text(json.dumps(config))
        process = await asyncio.create_subprocess_exec(sys.executable, "-I", str(Path(__file__).with_name("gate.py")),
            "--config", str(path), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        try:
            ready = await asyncio.wait_for(process.stderr.readline(), 5)
            self.assertTrue(ready.startswith(b"GATE_READY ports="), ready)
            ports = [int(p) for p in ready.decode().strip().split("=", 1)[1].split(",")]
            self.assertEqual(len(set(ports)), 3)
            process.terminate()
            await asyncio.wait_for(process.wait(), 5)
            self.assertEqual(process.returncode, 0)
            for port in ports:
                with socket.socket() as check:
                    check.bind(("127.0.0.1", port))
            print("STARTUP_VERIFIED " + ready.decode().strip() + " stopped=0 ports=free")
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def test_summary_denials_pending_and_restore_details(self):
        self.approval()
        await self.request("PATCH", "/www.googleapis.com/drive/v3/files/f", data={"name": "Summary restore"})
        await self.request(proof=False)
        await self.request(data={"attendees": [{"email": "outside@example.net"}]})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            await asyncio.to_thread(summary.post_summary, self.config, 24)
        content = "\n".join(self.cards.values())
        self.assertIn("Summary restore", content)
        self.assertIn("막힌 쓰기 1건 · 승인 기다림 1건", content)
        self.assertNotIn("/_gate/restore/", content)
        self.assertNotIn(self.service.pending()[0]["card"], content)
        self.assertTrue(json.loads((self.state / "changes.jsonl").read_text().splitlines()[0])["restorable"])

    def test_summary_groups_gate_tests_and_names_deletes_from_snapshots(self):
        now = dt.datetime.now(dt.timezone.utc)
        def row(op, title, status=200, **extra):
            return {"id": op + title, "ts": now.isoformat(), "api": "calendar", "op": op, "status": status,
                    "restorable": False, "resource": {"summary": title} if title else {},
                    "owner_message": "https://discord.com/channels/1/2/3", **extra}
        changes = [row("events.insert", "Dentist"), row("events.patch", "Dinner"),
                   row("events.insert", "게이트 시험"), row("events.delete", "", 204, restorable=True, snapshot="s"),
                   row("events.insert", "Broken", 500)]
        text = summary.render(changes, [], [], 24, "유돌", lambda r: "게이트 시험")
        self.assertEqual(text.splitlines(), [
            "오늘 유돌이 바꾼 것 4건", "일정 2(추가 1·수정 1)",
            now.astimezone(dt.timezone(dt.timedelta(hours=9))).strftime("%H:%M Dentist · %H:%M Dinner"),
            "게이트 시험 2건(일정 2)", "되살릴 수 있음 1건", "실패 1건", "자세한 건 유돌에게 물어보면 올림"])

    def test_summary_counts_only_refused_writes(self):
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        def denial(port, method, path, reason):
            return {"ts": now, "uid": 1005, "port": port, "method": method, "path": path, "reason": reason}
        denials = [denial("connect", "CONNECT", "http-intake.logs.us5.datadoghq.com:443", "connect-host-denied"),
                   denial("connect", "CONNECT", "api.anthropic.com:443", "request-failed"),
                   denial("google", "GET", "/_gate/refusals", "not-found"),
                   denial("google", "GET", "/www.googleapis.com/drive/v3/files", "upstream-unavailable"),
                   denial("google", "POST", "/www.googleapis.com/calendar/v3/calendars/primary/events",
                          "upstream-unavailable"),
                   denial("google", "PATCH", "/www.googleapis.com/drive/v3/files/f", "owner-message-required"),
                   denial("discord", "POST", "/api/v10/channels/9/messages", "foreign-channel")]
        self.assertEqual(summary.render([], denials, [], 24, "유돌").splitlines(),
                         ["오늘 유돌이 바꾼 것 0건", "막힌 쓰기 2건", "자세한 건 유돌에게 물어보면 올림"])
        self.assertEqual(len(summary.refused_writes(denials[:5])), 0)

    async def test_summary_without_refused_writes_posts_nothing(self):
        self.service.deny(1005, "connect", "CONNECT", "us.i.posthog.com:443", "connect-host-denied")
        self.service.deny(1005, "connect", "CONNECT", "api.anthropic.com:443", "request-failed")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            await asyncio.to_thread(summary.post_summary, self.config, 24)
        self.assertEqual(output.getvalue().strip(), "SUMMARY_EMPTY")
        self.assertEqual(self.cards, {})

    async def test_vault_path_rejects_traversal_hidden_and_other_prefixes(self):
        self.config["vault"] = {"dir": str(self.state / "vault.git"), "allowed_prefix": "Notes"}
        for path in ("../secret.md", "/secret.md", ".secret.md", "Notes/../a.md", "Notes/.h/a.md",
                     "Other/a.md", "Notes/file.txt", "Notes//a.md", "Notes/a\\b.md"):
            with self.subTest(path=path), self.assertRaises(gate.Refused):
                self.service.vault_path(path)
        self.assertEqual(self.service.vault_path("Notes/sub/a.md"), "Notes/sub/a.md")

    async def test_vault_write_read_restore_against_a_real_remote_without_checkout(self):
        work = self.state / "seed"
        remote = self.state / "remote.git"
        run = lambda *a, cwd=None: subprocess.run(a, cwd=cwd, check=True, capture_output=True, text=True).stdout
        run("git", "init", "-q", "--bare", "-b", "main", str(remote))
        run("git", "--git-dir", str(remote), "config", "uploadpack.allowFilter", "true")
        run("git", "init", "-q", "-b", "main", str(work))
        (work / "Notes").mkdir()
        (work / "Notes" / "a.md").write_text("Before")
        (work / "Big.md").write_text("x" * 100000)
        run("git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A", cwd=work)
        run("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed", cwd=work)
        run("git", "push", "-q", str(remote), "main", cwd=work)
        url = "file://" + str(remote)
        self.config["vault"] = {"dir": str(self.state / "vault.git"), "remote": url,
                                "ssh_key": str(self.state / "unused-key"), "allowed_prefix": "Notes"}
        status, _ = await self.request("PUT", "/_vault/note?path=Notes/a.md", raw="After 한글".encode())
        self.assertEqual(status, 200)
        self.assertEqual(run("git", "--git-dir", str(remote), "show", "main:Notes/a.md"), "After 한글")
        self.assertIn("discord.com/channels/", run("git", "--git-dir", str(remote), "log", "-1", "--format=%s", "main"))
        self.assertFalse((self.state / "vault.git" / "Notes").exists())
        present = run("git", "--git-dir", str(self.state / "vault.git"), "cat-file", "--batch-all-objects", "--batch-check=%(objectname)").split()
        self.assertNotIn(run("git", "--git-dir", str(remote), "rev-parse", "main:Big.md").strip(), present)
        run("git", "pull", "-q", str(remote), "main", cwd=work)
        (work / "Other.md").write_text("moved on")
        run("git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A", cwd=work)
        run("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "elsewhere", cwd=work)
        run("git", "push", "-q", str(remote), "main", cwd=work)
        (self.state / "vault.git" / "refs" / "heads" / "main.lock").write_text("stale")
        (self.state / "vault-index.lock").write_text("killed write")
        status, _ = await self.request("PUT", "/_vault/note?path=Notes/a.md", raw="After 한글".encode())
        self.assertEqual(status, 200)
        self.assertIn("fetch rc=", self.service.vault_error)
        status, body = await self.request("GET", "/_vault/note?path=Notes/a.md", proof=False)
        self.assertEqual((status, body.decode()), (200, "After 한글"))
        status, _ = await self.request("PUT", "/_vault/note?path=Notes/new.md", raw=b"New")
        self.assertEqual(status, 200)
        rows = self.changes()
        self.assertTrue(all(r["restorable"] for r in rows))
        self.assertEqual((await self.request(path="/_gate/restore/" + rows[0]["id"]))[0], 200)
        self.assertEqual(run("git", "--git-dir", str(remote), "show", "main:Notes/a.md"), "Before")
        self.assertEqual((await self.request(path="/_gate/restore/" + rows[-1]["id"]))[0], 200)
        self.assertNotIn("Notes/new.md", run("git", "--git-dir", str(remote), "ls-tree", "-r", "--name-only", "main"))
        self.assertEqual(run("git", "--git-dir", str(remote), "show", "main:Big.md"), "x" * 100000)

    async def test_admin_restore_requires_no_owner_proof(self):
        await self.request("DELETE", "/tasks.googleapis.com/tasks/v1/lists/l/tasks/t")
        row = self.changes()[0]
        self.config["admins"] = [os.getuid()]
        self.config["clients"] = []
        status, _ = await self.request(path="/_gate/restore/" + row["id"], proof=False)
        self.assertEqual(status, 200)


class IPv6FallbackTests(unittest.TestCase):
    def test_ipv4_is_tried_first_and_a_dead_ipv6_address_does_not_block_the_connection(self):
        server = socket.socket(socket.AF_INET)
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        dead = socket.socket(socket.AF_INET6)
        dead.bind(("::1", 0))
        dead_port = dead.getsockname()[1]
        dead.close()
        infos = [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", dead_port, 0, 0)),
                 (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]
        self.assertEqual([a[0] for a in gate.ordered(infos)], [socket.AF_INET, socket.AF_INET6])
        with patch.object(gate.socket, "getaddrinfo", return_value=list(reversed(infos[::-1]))):
            sock = gate.tcp_connect("dual.example", port, 3)
        try:
            self.assertEqual(sock.getpeername(), ("127.0.0.1", port))
        finally:
            sock.close()
            server.close()
        with patch.object(gate.socket, "getaddrinfo", return_value=[infos[0]]), self.assertRaises(OSError):
            gate.tcp_connect("v6only.example", dead_port, 1)


class NodeGateTests(unittest.IsolatedAsyncioTestCase):
    """One gate holds the keys (the node); a keyless gate forwards to it over a socket like the SSH tunnel's."""

    base_setup = GateTests.asyncSetUp
    close_fake = GateTests.close_fake
    fake_request = GateTests.fake_request
    request = GateTests.request
    approval = GateTests.approval
    changes = GateTests.changes

    async def asyncSetUp(self):
        await self.base_setup()
        self.relayed = 0
        self.relayed_bytes = b""
        relay_root = tempfile.TemporaryDirectory(prefix="dori-relay-test-")
        self.addCleanup(relay_root.cleanup)
        self.socket_path = str(Path(relay_root.name) / "gate.sock")
        self.relay = await asyncio.start_unix_server(self.pipe, self.socket_path)
        self.addAsyncCleanup(self.close_relay)
        pc_root = tempfile.TemporaryDirectory(prefix="dori-gate-pc-test-")
        self.addCleanup(pc_root.cleanup)
        self.pc_state = Path(pc_root.name)
        # The forwarding gate can reach no Google or Discord upstream: any direct contact would fail.
        self.pc_config = {**self.config, "state": str(self.pc_state), "admins": [],
                          "google_forward": {"unix": self.socket_path, "timeout": 5},
                          "upstreams": {host: "http://127.0.0.1:9" for host in gate.GOOGLE_HOSTS},
                          "discord_api_base": "http://127.0.0.1:9/api/v10"}
        self.pc = gate.Gate(self.pc_config)
        await self.pc.start()
        self.addAsyncCleanup(self.pc.close)
        self.ports["pc"] = self.pc.servers["google"].sockets[0].getsockname()[1]

    async def close_relay(self):
        self.relay.close()
        await self.relay.wait_closed()

    async def pipe(self, reader, writer):
        """What `ssh -L <socket>:127.0.0.1:3129` does: bytes both ways to the node gate's port."""
        self.relayed += 1
        node_reader, node_writer = await asyncio.open_connection("127.0.0.1", self.ports["google"])

        async def copy(source, destination):
            while data := await source.read(65536):
                if destination is node_writer:
                    self.relayed_bytes += data
                destination.write(data)
                await destination.drain()
            if destination.can_write_eof():
                destination.write_eof()

        await asyncio.gather(copy(reader, node_writer), copy(node_reader, writer), return_exceptions=True)
        node_writer.close()
        writer.close()

    def pc_files(self):
        return sorted(str(p.relative_to(self.pc_state)) for p in self.pc_state.rglob("*") if p.is_file())

    async def test_a_forwarded_read_reaches_google_with_the_node_gates_token(self):
        status, body = await self.request("GET", "/www.googleapis.com/calendar/v3/calendars/primary/events/e",
                                          headers={"authorization": "Bearer caller-secret"}, proof=False, port="pc")
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["id"], "e")
        self.assertEqual(self.seen[-1][2]["authorization"], "Bearer access-secret")
        self.assertEqual(self.relayed, 1)
        self.assertNotIn(b"caller-secret", self.relayed_bytes)
        self.assertNotIn("google-token.json", self.pc_files())

    async def test_a_forwarded_own_write_runs_and_is_journaled_on_the_node_only(self):
        status, body = await self.request(data={"summary": "Own", "attendees": [{"email": "owner@example.com"}]},
                                          port="pc")
        self.assertEqual(status, 200, body)
        self.assertEqual(len(self.changes()), 1)
        self.assertEqual(self.changes()[0]["owner_message"], "https://discord.com/channels/10/20/100")
        self.assertEqual(self.pc.records(), [])
        self.assertFalse([name for name in self.pc_files() if name.endswith(".jsonl")])

    async def test_a_forwarded_outbound_write_gets_its_card_from_the_node_gate(self):
        self.approval()
        status, body = await self.request(data={"summary": "Invite", "attendees": [{"email": "outside@example.net"}]},
                                          port="pc")
        self.assertEqual(status, 202, body)
        self.assertEqual(len(self.service.pending()), 1)
        self.assertTrue(self.cards)
        self.assertEqual(self.pc.pending(), [])
        self.assertIsNone(self.pc.approval_task)

    async def test_a_forwarded_write_without_owner_proof_is_refused_by_the_node(self):
        status, body = await self.request(proof=False, port="pc")
        self.assertEqual((status, json.loads(body)["error"]), (403, "owner-message-required"))
        self.assertEqual(self.service.records("denials.jsonl")[-1]["reason"], "owner-message-required")
        self.assertEqual(self.pc.records("denials.jsonl"), [])

    async def test_the_node_gate_out_of_reach_is_a_clear_refusal_and_never_a_direct_call(self):
        await self.close_relay()
        Path(self.socket_path).unlink(missing_ok=True)
        status, body = await self.request("GET", "/www.googleapis.com/drive/v3/files/f", proof=False, port="pc")
        self.assertEqual((status, json.loads(body)["error"]), (502, "node-gate-unavailable"))
        self.assertEqual(self.seen, [])

    async def test_only_the_local_client_uid_may_forward(self):
        self.pc_config["clients"] = []
        status, body = await self.request("GET", "/www.googleapis.com/drive/v3/files/f", proof=False, port="pc")
        self.assertEqual((status, json.loads(body)["error"]), (403, "client-uid-required"))
        self.assertEqual(self.relayed, 0)

    async def test_the_forwarding_gate_admin_reports_no_keys_and_cannot_start_a_consent(self):
        self.pc_config["admins"] = [os.getuid()]
        status, body = await self.request("GET", "/_admin/status", proof=False, port="pc")
        self.assertEqual(status, 200)
        self.assertEqual({k: json.loads(body)[k] for k in ("mode", "token_present")},
                         {"mode": "forward", "token_present": False})
        status, body = await self.request(path="/_admin/auth-url", proof=False, port="pc")
        self.assertEqual((status, json.loads(body)["error"]), (409, "keys-on-node"))

    async def test_a_forwarding_gate_refuses_to_start_holding_any_credential_or_card(self):
        cases = {"google-token-present": "google-token.json", "client-secret-present": "client_secret.json",
                 "pending-cards-present": "pending/1.json"}
        for reason, name in cases.items():
            with self.subTest(reason=reason), tempfile.TemporaryDirectory(prefix="dori-gate-refuse-") as root:
                (Path(root) / "pending").mkdir()
                (Path(root) / name).write_text("{}")
                with self.assertRaises(gate.ConfigRefused) as raised:
                    await gate.Gate({**self.pc_config, "state": root}).start()
                self.assertEqual(str(raised.exception), reason)
        for reason, extra in {"vault-config-present": {"vault": {"dir": "/x"}},
                              "grants-config-present": {"token_clients": [1]},
                              "forward-config-invalid": {"google_forward": {"unix": "relative.sock"}}}.items():
            with self.subTest(reason=reason), tempfile.TemporaryDirectory(prefix="dori-gate-refuse-") as root:
                with self.assertRaises(gate.ConfigRefused) as raised:
                    await gate.Gate({**self.pc_config, "state": root, **extra}).start()
                self.assertEqual(str(raised.exception), reason)

    async def test_the_service_exits_with_a_marker_when_a_forwarding_gate_still_holds_a_token(self):
        root = self.state / "refuse"
        root.mkdir()
        (root / "google-token.json").write_text("{}")
        path = self.state / "forward.json"
        path.write_text(json.dumps({**self.pc_config, "state": str(root)}))
        process = await asyncio.create_subprocess_exec(sys.executable, "-I", str(Path(__file__).with_name("gate.py")),
            "--config", str(path), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        try:
            _, stderr = await asyncio.wait_for(process.communicate(), 10)
        finally:
            # A gate that wrongly starts must not outlive the failed test.
            if process.returncode is None:
                process.kill()
                await process.wait()
        self.assertEqual(process.returncode, 3)
        self.assertIn(b"GATE_FORWARD_REFUSED google-token-present", stderr)

    def jobs(self, consented=True):
        self.config["grants"] = {"jobs": {"scopes": ["openid", "https://www.googleapis.com/auth/gmail.send"],
                                          "token_file": "jobs-token.json"}}
        self.config["token_clients"] = [os.getuid()]
        if consented:
            (self.state / "jobs-token.json").write_text('{"refresh_token":"jobs-refresh","scope":"openid"}')

    async def test_a_token_client_gets_a_short_token_of_a_named_grant_and_the_journal_keeps_no_token(self):
        self.jobs()
        status, body = await self.request("GET", "/_gate/access-token?grant=jobs", proof=False)
        self.assertEqual(status, 200, body)
        result = json.loads(body)
        self.assertEqual(result["access_token"], "access-secret")
        self.assertGreater(result["expires_in"], 3000)
        refresh = [r for r in self.seen if r[1] == "/token"][-1]
        self.assertEqual(parse_qs(refresh[3].decode())["refresh_token"], ["jobs-refresh"])
        journal = (self.state / "tokens.jsonl").read_text()
        self.assertEqual(json.loads(journal)["grant"], "jobs")
        self.assertNotIn("access-secret", journal)
        self.assertNotIn("jobs-refresh", journal)

    async def test_access_tokens_are_refused_to_everyone_else_and_never_for_the_reverse_apis_grant(self):
        self.jobs(consented=False)
        cases = [("GET", "/_gate/access-token?grant=jobs", 503, "google-auth-required"),
                 ("GET", "/_gate/access-token", 400, "grant-required"),
                 ("GET", "/_gate/access-token?grant=default", 400, "grant-required"),
                 ("GET", "/_gate/access-token?grant=other", 404, "unknown-grant"),
                 ("POST", "/_gate/access-token?grant=jobs", 404, "not-found")]
        for method, path, status, reason in cases:
            with self.subTest(path=path, method=method):
                answer, body = await self.request(method, path, proof=False)
                self.assertEqual((answer, json.loads(body)["error"]), (status, reason))
        self.config["token_clients"] = []
        (self.state / "jobs-token.json").write_text('{"refresh_token":"jobs-refresh"}')
        answer, body = await self.request("GET", "/_gate/access-token?grant=jobs", proof=False)
        self.assertEqual((answer, json.loads(body)["error"]), (403, "token-client-required"))

    async def consent(self, grant, scope):
        self.config["admins"] = [os.getuid()]
        status, content = await self.request(path="/_admin/auth-url", proof=False,
                                             data={"grant": grant} if grant else None)
        self.assertEqual(status, 200, content)
        params = parse_qs(urlsplit(json.loads(content)["url"]).query)
        self.scope = scope
        status, content = await self.request(path="/_admin/auth-finish", proof=False,
            data={"redirect": "http://localhost/?code=fake&state=" + params["state"][0]})
        return status, content, params["scope"][0]

    async def test_a_named_grant_may_hold_a_send_scope_but_the_reverse_apis_grant_still_may_not(self):
        self.jobs(consented=False)
        default_before = (self.state / "google-token.json").read_bytes()
        send = "https://www.googleapis.com/auth/gmail.send"
        status, content, asked = await self.consent("jobs", "openid " + send)
        self.assertEqual(status, 200, content)
        self.assertIn(send, asked.split())
        self.assertEqual(json.loads((self.state / "jobs-token.json").read_text())["scope"], "openid " + send)
        self.assertEqual((self.state / "jobs-token.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.state / "google-token.json").read_bytes(), default_before)
        self.config["google_scopes"].append(send)
        status, content, _ = await self.consent(None, "openid " + send)
        self.assertEqual((status, json.loads(content)["error"]), (403, "unsafe-google-scope"))
        self.assertEqual((self.state / "google-token.json").read_bytes(), default_before)
        status, content = await self.request("GET", "/_admin/status", proof=False)
        self.assertEqual(json.loads(content)["grants"], {"jobs": {"token_present": True, "scopes": ["openid", send]}})
        self.assertNotIn("refresh", content.decode())

    async def test_a_null_listener_stays_off(self):
        node = gate.Gate({**self.config, "state": str(self.state / "node-only"),
                          "listen": {"connect": None, "google": 0, "discord": None}})
        await node.start()
        try:
            self.assertEqual(set(node.servers), {"google"})
        finally:
            await node.close()


class IdentityTests(unittest.TestCase):
    def test_uid_lookup_from_fake_proc_and_remote_endpoint(self):
        with tempfile.TemporaryDirectory(prefix="dori-proc-test-") as root:
            path = Path(root) / "tcp"
            path.write_text("sl local_address rem_address st tx_queue tr retrnsmt uid\n"
                            "0: 0100007F:CAFE 0100007F:0C39 01 0:0 0:0 0 1004 0\n")
            self.assertEqual(gate.caller_uid(("127.0.0.1", 0xCAFE), ("127.0.0.1", 3129), [str(path)]), 1004)
            self.assertIsNone(gate.caller_uid(("127.0.0.1", 0xCAFE), ("127.0.0.1", 3130), [str(path)]))

    def test_ipv6_proc_word_order(self):
        self.assertEqual(gate.proc_address("::1"), "00000000000000000000000001000000")


if __name__ == "__main__":
    unittest.main()
