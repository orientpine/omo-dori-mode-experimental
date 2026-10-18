"""Wire-level tests: local fake upstreams only; no Google/Discord connections."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, quote, urlsplit
from unittest.mock import patch


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
        self.reactions = {}
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
        self.scope = "openid"
        self.fake = await asyncio.start_server(self.fake_request, "127.0.0.1", 0)
        self.addAsyncCleanup(self.close_fake)
        self.base = "http://127.0.0.1:" + str(self.fake.sockets[0].getsockname()[1])
        (self.state / "bot").write_text("MTIz.fake.fake")
        (self.state / "bot").chmod(0o600)
        (self.state / "client_secret.json").write_text(json.dumps({"installed": {
            "client_id": "client", "client_secret": "secret", "token_uri": self.base + "/token",
            "auth_uri": self.base + "/authorize"}}))
        (self.state / "google-token.json").write_text('{"refresh_token":"refresh-secret"}')
        self.config = {
            "state": str(self.state), "listen": dict(connect=0, google=0, discord=0),
            "clients": [os.getuid()], "admins": [], "owner_id": "1", "owner_guild": "10",
            "owner_emails": ["owner@example.com"],
            "owner_proof": {"token_file": str(self.state / "bot"), "max_age_hours": 24},
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
            elif path == "/tokeninfo":
                data = {"scope": self.scope, "email": "owner@example.com", "expires_in": 3000,
                        "access_token": "must-not-return"}
            elif path.startswith("/api/v10/"):
                route = path[len("/api/v10"):]
                parts = route.split("/")
                if len(parts) >= 5 and parts[1] == "channels" and parts[3] == "messages":
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
                    message = str(1000 + len(self.cards))
                    self.cards[message] = json.loads(body)["content"]
                    data = {"id": message, "content": self.cards[message]}
                elif parts[1] == "channels" and len(parts) == 3:
                    channel = parts[2]
                    data = ({"id": channel, "type": 1, "recipients": [{"id": "1" if channel == "21" else "2"}]}
                            if channel in {"21", "22"} else {"id": channel, "guild_id": "99" if channel == "99" else "10"})
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
                      data=None, proof=True, port="google", headers=None, raw=None):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.ports[port])
        try:
            body = gate.json_bytes(data or {}) if raw is None else raw
            values = {"host": "ignored.invalid", "content-type": "application/json", **(headers or {})}
            if proof:
                values["x-dori-owner-message"] = "20/100"
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
                not r[1].startswith(("/api/v10", "/token"))]

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
        self.assertIn("https://discord.com/channels/10/20/100", text)
        self.assertIn("KST", text)
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
        self.assertIn("되살리기: /_gate/restore/", content)
        self.assertIn("owner-message-required", content)
        self.assertIn(self.service.pending()[0]["card"], content)

    async def test_vault_path_rejects_traversal_and_symlinks(self):
        root = self.state / "vault"
        root.mkdir()
        self.config["vault"] = {"dir": str(root), "allowed_prefix": "Notes"}
        (root / "Notes").mkdir()
        (root / "Notes" / "link.md").symlink_to(self.state / "bot")
        for path in ("../secret.md", "/secret.md", ".secret.md", "Notes/../a.md",
                     "Other/a.md", "Notes/link.md", "Notes/file.txt"):
            with self.subTest(path=path), self.assertRaises(gate.Refused):
                self.service.vault_path(path)

    async def test_vault_write_snapshot_and_restore_with_fake_git(self):
        root = self.state / "vault"
        (root / "Notes").mkdir(parents=True)
        note = root / "Notes" / "a.md"
        note.write_text("Before")
        self.config["vault"] = {"dir": str(root), "remote": "local-fixture",
                                "ssh_key": str(self.state / "unused-key"), "allowed_prefix": "Notes"}
        calls = []
        async def git(*args, **kwargs):
            calls.append(args)
            return b"local-fixture\n" if args[:2] == ("remote", "get-url") else b""
        with patch.object(self.service, "git", side_effect=git):
            status, _ = await self.request("PUT", "/_vault/note?path=Notes/a.md", raw=b"After")
            self.assertEqual(status, 200)
            self.assertEqual(note.read_text(), "After")
            row = self.changes()[0]
            self.assertTrue(row["restorable"])
            self.assertEqual((await self.request(path="/_gate/restore/" + row["id"]))[0], 200)
        self.assertEqual(note.read_text(), "Before")
        self.assertIn(("pull", "--rebase"), calls)
        self.assertIn(("push", "origin", "HEAD"), calls)

    async def test_admin_restore_requires_no_owner_proof(self):
        await self.request("DELETE", "/tasks.googleapis.com/tasks/v1/lists/l/tasks/t")
        row = self.changes()[0]
        self.config["admins"] = [os.getuid()]
        self.config["clients"] = []
        status, _ = await self.request(path="/_gate/restore/" + row["id"], proof=False)
        self.assertEqual(status, 200)


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
