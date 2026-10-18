# Egress gate

Python 3.12 standard-library-only asyncio gate for an isolated Dori Linux user.
It binds only `127.0.0.1`; firewall installation and service installation are
separate tasks. Run as the dedicated, unprivileged gate user:

```sh
python3 -I gate.py --config /etc/dori-gate/config.json
```

Configure client/admin UIDs, owner IDs/emails, and the approval channel before use.
Only client UIDs may proxy APIs; only admin UIDs may use `/_admin/*`.
Both may read `/_gate/*`; client restores require an owner message.
Unknown socket UIDs are disconnected. Identity comes from the caller-side
socket entry in `/proc/net/tcp` and `/proc/net/tcp6`, not HTTP headers.

| Port | Function |
| --- | --- |
| 3128 | CONNECT only; configured names/ports, public DNS addresses only |
| 3129 | Google reverse API, journal, restores, OAuth admin, optional vault |
| 3130 | Discord `/api/v10/*`, owner guild/owner-only DMs |

The Discord Gateway uses the CONNECT port, not the Discord REST port. CONNECT
copies opaque TLS bytes in both directions; it does not decode WebSocket frames,
opcodes, or zlib streams. The listener requests JSON without compression. A
`DISCORD_LISTENER_CLOSED code=4001` can also be a locally chosen close code: check
the listener's handling of Gateway reconnect/invalid-session events before
attributing it to an upstream unknown opcode.

Owner DM history is available through `POST /api/v10/users/@me/channels` with
the owner's `recipient_id`, then `GET /api/v10/channels/<id>/messages`. The gate
checks the DM recipients on history reads too; another person's DM is refused.

Google paths look like `/www.googleapis.com/calendar/v3/calendars/primary/events`.
The gate supplies Google authorization and strips caller credentials.
Writes require `X-Dori-Owner-Message: channel_id/message_id`; proof must be an
owner message in the owner guild, no older than 24 hours. Successful proofs and
channel/calendar checks are cached for at most ten minutes.

| API | Direct writes | Approval card | Always refused |
| --- | --- | --- | --- |
| Calendar | Own/private events, calendars.create, owner ACL, ACL removal | External attendees, foreign organizer, public/non-owned calendar, external ACL | watch, quickAdd, import, move, calendar deletion/update, calendarList writes |
| Tasks | Tasklist create/update; task create/update/delete/move | Limits | clear, tasklist deletion |
| Drive | Own/private files create/update/copy/trash, owner permission, permission removal | Public/shared/non-owned targets/parents, external permission, comments/replies, spreadsheets | Permanent file deletion, emptyTrash, watch, shared-drive management |
| Docs | Create and owned/private batchUpdate | Image/URI requests, public/non-owned documents | Other writes |
| Sheets | Reads | Writes | Non-API routes |
| Gmail | Reads | Never | Every write; send-capable OAuth scopes |
| Vault | Owner-initiated Markdown writes | Limits | Delete API, traversal, hidden paths, symlinks |

Direct event writes force `sendUpdates=none` and disable legacy notifications.
Approved external invites use `sendUpdates=all`. Attachments remain refused.
Drive uploads support media and multipart; resumable sessions are refused because
their opaque upload URLs do not preserve the checked metadata endpoint.
Other unlisted endpoints are denied. Request bodies are capped at 25 MiB;
vault writes at 1 MiB. Chunked requests are decoded; trailers cannot alter headers.

## Approval and journal

Outbound changes and the 11th delete/hour or 31st write/owner message are parked,
returning `202` with a card link. The gate posts short Korean cards (kind, recipients, title,
✅/⛔ only; the reason, owner-message link and expiry stay in the pending record) and checks every
20 seconds. Only the owner's non-bot reaction counts. Cancel wins over approve.
Cards expire after 24 hours. Missing/tampered cards never execute. A SHA-256
content check precedes reactions. Clients cannot edit/delete pending cards or
add/remove their reactions through the Discord port.

Each card lives in a thread, and its result is written on the card there. A request
written inside a thread under the approval channel keeps its card in that thread; one
written in the approval channel gets a thread on that message; anything else opens a new
thread in the approval channel (any thread failure falls back to the channel). A newer card
for the same work in the same thread (same API, operation and path; for creates, the same
title) replaces the older undecided card: it is marked `🔁 새 판으로 대체됨` and never runs.
A card the owner already reacted to is left to the poller.

Pending requests are private JSON files in `pending/`. Execution is marked
durably before sending: an interrupted, uncertain write is never automatically
replayed after restart. Confirm its real upstream state before resubmitting.
`GET /_gate/pending` lists IDs, reasons, links, and ages.

Changes/denials are in `changes.jsonl`/`denials.jsonl` (0600), snapshots in
`snapshots/` (0700 directory, 0600 files). Each Google write carries its original
owner-message link, pre-change snapshot where applicable, and approval-card link
when approved. Logs exclude request bodies, authorization and query credentials;
snapshots and parked bodies are confidential state, not diagnostic logs.
New-resource creation has no previous state, so its snapshot is null.

```sh
python3 -I gatectl.py status
python3 -I gatectl.py auth-url
python3 -I gatectl.py auth-finish 'http://localhost/?code=...&state=...'
python3 -I gatectl.py tokeninfo
python3 -I gatectl.py changes --since 24h
python3 -I gatectl.py restore CHANGE_ID
python3 -I gatectl.py restore CHANGE_ID --owner-message CHANNEL_ID/MESSAGE_ID
```

OAuth uses installed-app `client_secret.json` in the state directory, PKCE S256,
offline consent, and `http://localhost`. Keep it and `owner-bot-token` at 0600.
Refresh tokens are stored in `google-token.json` (0600), access tokens in memory.
`auth-finish` rejects sending Gmail scopes and every scope outside the config.
Do not put credentials in config, command-line logs, or environment dumps.

`GET /_gate/changes?since=24h` also accepts an ISO timestamp.
`POST /_gate/restore/ID` reinserts deleted events/tasks, restores event/task
updates, reverses Drive trash and metadata/parent changes, or restores vault
content. Restores are writes, checked and journaled, and may themselves need a
card. Docs uses version history (409). Drive binary contents, ACL/permission
edits, and comment edits cannot be restored by this metadata journal.

## Optional vault

Add `"vault": {"dir": "/private/vault-clone", "remote": "git@host:repo.git",
"ssh_key": "/private/vault-key", "allowed_prefix": "Notes"}`.
The gate operates only its dedicated clone, pulls with rebase, commits and pushes
with that SSH key. Git operations have a 120-second timeout; push failure fetches
and resets the gate's clone to its upstream. Never point this at a human checkout.
`GET /_vault/note?path=Notes/example.md` reads;
`PUT` writes UTF-8 Markdown with owner proof. Without vault config: 503.

## Daily summary

```sh
python3 -I summary.py --hours 24
python3 -I summary.py --config /etc/dori-gate/config.json --hours 24 --post
```

The first command reads the gate endpoint (admin UID allowed) and prints nothing
when no changes exist. The second is suitable for an external systemd timer,
running as the gate user: reads journals/pending directly and posts a short
phone-sized message: a head line (changes in the window), one line of counts per
kind (`일정 4(추가 3·수정 1) · 할 일 1`), the latest three `HH:MM title` (KST),
titles matching `게이트 시험`/`gate test` folded into one line, a count of restorable
deletes, one line of failed/refused/pending counts, and `자세한 건 <name>에게 물어보면
올림`. Optional config `"dori_name"` names the Dori in the head and last lines.
Links, owner proof, approvals and restore IDs stay in the journal only; the Dori
reads them from `GET /_gate/changes` and `GET /_gate/pending` when the owner asks.
Posts using the gate bot to the configured approval channel in chunks below 1900
characters. Prints `SUMMARY_EMPTY` or
`SUMMARY_POSTED N messages`. No service or timer is installed by these files.

## Tests

```sh
python3 -I -m unittest discover -s . -p test_gate.py -v
python3 -I -m py_compile gate.py gatectl.py summary.py test_gate.py
```

Tests use ephemeral loopback fake Google/Discord upstreams and temporary private
state. Trusted test injection points: `upstreams` (host to base URL),
`discord_api_base`, `tokeninfo_url`, `proc_tcp_paths`, installed-client `token_uri`,
and ephemeral listener ports (`0`). Never make config writable by the client UID.

Python's isolated mode removes the current directory from the import search
path, so `python3 -I -m unittest test_gate.py -v` fails to import the test module.
Discovery explicitly adds its start directory while retaining isolated mode.
