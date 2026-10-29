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
| 3131 | Web window: `GET /fetch?url=`, `GET /search?q=` (optional, `listen.web`) |

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

A dashboard order is the other proof (owner 2026-10-21 23:23 KST "문지기가 대시보드 지시도
형 명령으로 인정"): `X-Dori-Owner-Order: <n>` (the dashboard order number, 1-999999999) when no
`X-Dori-Owner-Message` is sent; an owner message always wins. With `owner_order` set, the gate
asks the project-board dashboard on every write, never cached:
`GET <api_base>/api/orders/<n>` with `X-PB-Gate-Token: <token_file contents>` (`token_header`).
The answer must be a JSON object with `number` equal to the asked number, `via` `"owner-device"` (made in
the browser through `tailscale serve` on one of the owner's own devices, as the board decides from its
`owner_devices`; `tailnet` - a server or other device under the owner's login - and `local` are refused),
`device` the sending device's tailnet stable node id (and, when the gate config lists `owner_devices`,
one of them, case-insensitive; the servers share the owner's login, so the login alone cannot tell
them apart), `created_by` one of `owner_logins` (the owner's tailnet login, case-insensitive), `created_at` an ISO time with zone no older than
`max_age_hours` (24) and not in the future, `status` one of `open_statuses` (default `받음`, `넘김`,
`처리 중`; `끝` is refused) and `body_sha256` 64 hex characters.
Anything else, a non-2xx answer, no answer within `timeout_seconds` (5) or a missing setting is
`403 owner-order-required` before Google. An order has no write count limit, only the time window
(owner 2026-10-21 23:55 KST Q353 "횟수 제한 없애고 24시간 창만"; the owner-message write limit below does
not apply to orders either). Then the gate records the use on the dashboard
(`POST <api_base>/api/orders/<n>/use`, same header; the answer's `number` must match) and refuses
the write if that fails; the use is recorded when the proof is accepted, so a write the policy then
parks or refuses is still recorded. The order changes only the proof: outbound writes still park on the
approval card, and Gmail send stays refused. The dashboard keeps its gate token in the agent
account (0600); the owner's root apply copies it to `/etc/dori-gate/dashboard-orders-token`
(root:dori-gate 0640) and again whenever the dashboard makes a new one.

| API | Direct writes | Approval card | Always refused |
| --- | --- | --- | --- |
| Calendar | Own/private events, calendars.create, owner ACL, ACL removal | External attendees, foreign organizer, public/non-owned calendar, external ACL | watch, quickAdd, import, move, calendar deletion/update, calendarList writes |
| Tasks | Tasklist create/update; task create/update/delete/move | Limits | clear, tasklist deletion |
| Drive | Own/private files create/update/copy/trash, owner permission, permission removal | Public/shared/non-owned targets/parents, external permission, comments/replies, spreadsheets | Permanent file deletion, emptyTrash, watch, shared-drive management |
| Docs | Create and owned/private batchUpdate | Image/URI requests, public/non-owned documents | Other writes |
| Sheets | Reads | Writes | Non-API routes |
| Gmail | Reads | Never | Every write; send-capable OAuth scopes |
| Contacts (`people.googleapis.com`) | GET `people:searchContacts`, `people:batchGet`, `people/<id>`, `people/me/connections`, `otherContacts`, `otherContacts:search` | Never | Every write, contact groups, directory, other paths (`403 contacts-read-only`) |
| Vault | Owner-initiated Markdown writes | Limits | Delete API, traversal, hidden paths, symlinks |

Direct event writes force `sendUpdates=none` and disable legacy notifications.
Approved external invites use `sendUpdates=all`. Attachments remain refused.
Drive uploads support media and multipart; resumable sessions are refused because
their opaque upload URLs do not preserve the checked metadata endpoint.
Other unlisted endpoints are denied. Request bodies are capped at 25 MiB;
vault writes at 1 MiB. Chunked requests are decoded; trailers cannot alter headers.

## Web window

Owner 2026-10-29 10:02 KST "그래 그럼 그렇게 한번 해보자" (stage 1 of the web window, for the gated Dori only).
The gate reads pages and searches for the Dori; the Dori itself still has no DNS and no web. Off unless
`listen.web` is set. Both calls are `GET` only and need the same owner proof as a write
(`X-Dori-Owner-Message`, or `X-Dori-Owner-Order`); one owner message (or order) is one task.

```sh
W=http://127.0.0.1:3131; O='X-Dori-Owner-Message: <channel id>/<message id>'
curl -sG -H "$O" --data-urlencode 'url=https://arxiv.org/abs/2503.18813' "$W/fetch"
curl -sG -H "$O" --data-urlencode 'q=prompt injection defenses' "$W/search"
```

- **Which URLs open.** Only a URL that is, character for character (fragment aside), one of:
  (a) a URL written in the owner message of the proof (an order has none);
  (b) a search result or page link the window returned earlier in the same task, or a redirect target;
  (c) an `https` URL without `?` on a host in `web.public_sites`.
  Anything else is `403 url-without-source` with `"message": "출처 없는 주소. 검색으로 찾아"`.
  Userinfo and ports other than the scheme's own are refused.
- **How it fetches.** The gate resolves the name, refuses if any address is not public
  (`web-private-address`), connects to that checked address (no second lookup), and sends a fixed
  `GET` with no body, cookie, authorization or caller header. Redirects are followed up to
  `max_redirects` (3), each hop resolved and checked again; one more is `502 too-many-redirects`.
  The body is read up to `max_bytes` (2 MiB) and cut there. HTML becomes text (scripts, styles, frames
  dropped, never run) plus its absolute links; text, JSON and XML pass as text; anything else is
  `415 unsupported-content-type`.
- **What it returns.** `text/plain`: the address, status and size, then the content between
  `[남의 글 시작 - ...]` and `[남의 글 끝]`, then the links the task may open next.
- **Search.** The query is refused before it leaves when it is empty or longer than `max_query_chars`
  (120), carries a key shape (`query-secret-shape`) or a mail address, phone, resident or account
  number shape (`query-personal-shape`). Without a search key (`web.search`: `provider` `brave`,
  `key_file` readable by the gate user only) the answer is then `503 search-off`, and the window
  still fetches. With one, a name, address or phone of the owner's contacts is `query-contact`
  (read through the gate's own Contacts grant, plus `owner_emails` and `owner_names`;
  `503 contacts-check-unavailable` when they cannot be read), and only then is the one search API
  asked. The key never leaves the gate.
- **Limits per task.** `max_opens_per_task` (40) fetches and `max_searches_per_task` (20) searches,
  then `429`. Tasks are kept in memory for 24 hours; a restart empties them (rule (b) starts over).
- **Log.** Every fetch hop and search appends `{ts, uid, kind, owner_message, host, status, bytes}` to
  `web.jsonl` (0600) and prints `GATE_WEB <kind> <host> <status> <bytes>`; never a path, query or
  content. Refusals go to `denials.jsonl` as `GET /fetch` or `GET /search` with the reason.

The firewall must let the Dori reach the new port: `install.sh` adds `listen.web` to `gate_ports`.

## Approval and journal

Outbound changes and the 11th delete/hour or 31st write/owner message are parked,
returning `202` with a card link. The gate posts short Korean cards (kind, recipients, title,
✅/⛔ only; the reason, owner-message link and expiry stay in the pending record) and checks every
20 seconds. A sharing or comment card on a Drive file shows that file's name and the access asked for
(`내용: <file> 공유(보기)`; an unreadable name says so with the file id), so the card alone tells who gets what. Only the owner's non-bot reaction counts. Cancel wins over approve.
Cards expire after 24 hours. Missing/tampered cards never execute. A SHA-256
content check precedes reactions. Clients cannot edit/delete pending cards or
add/remove their reactions through the Discord port.

Each card lives in a thread, and its result is written on the card there. A request
written inside a thread under the approval channel keeps its card in that thread; one
written in the approval channel gets a thread on that message; anything else opens a new
thread in the approval channel (any thread failure falls back to the channel). A newer card
for the same work in the same thread (same API, operation and path; for creates, the same
title) replaces the older undecided card: it is marked `🔁 새 판으로 대체됨` and never runs.
Once the last card in a thread the gate opened (its name starts `🔐 `) is decided, the thread is
renamed `✅ 완료 · ` (executed, 2xx), `⛔ 취소 · `, `⌛ 만료 · ` or `❗ 실패 · ` plus its name and archived; the
owner's own threads and threads with an open card keep their title. At start the gate also titles
open card threads whose cards were all decided earlier (owner 2026-10-19 "승인 결과를 스레드 제목에
반영하게 해줘").
Discord reopens an archived thread on any new message. When a message posted through the
Discord port goes into a thread that was archived under one of those four titles (the gate's
own card threads and the node's request threads use the same words), the gate archives it again
right after the post. A decided thread someone else reopened, or one without a status title,
stays as it is. So does a decided thread that holds a live card: a message newer than the
thread's last title change that carries both ✅ and ⛔ reactions (a newer card for the same work
can land in a thread already titled decided). If the thread's history cannot be read, the gate
leaves it open rather than hide a card.
A card the owner already reacted to is left to the poller.

Pending requests are private JSON files in `pending/`. Execution is marked
durably before sending: an interrupted, uncertain write is never automatically
replayed after restart. Confirm its real upstream state before resubmitting.
An approved write is replayed with its original query string. The poller keeps running when
one check fails: a failure it does not expect is logged as `GATE_APPROVAL_CHECK_FAILED <type>`
(never the error text). On 2026-10-25 a Drive share with a query string ended the poller with
an unlogged TypeError, and no card ran after it until a restart.
`GET /_gate/pending` lists IDs, reasons, links, and ages.

Changes/denials are in `changes.jsonl`/`denials.jsonl` (0600), snapshots in
`snapshots/` (0700 directory, 0600 files). Each Google write carries its original
owner-message link, pre-change snapshot where applicable, and approval-card link
when approved. A write on a dashboard order has the order link as `owner_message` and
`owner_order` `{id, url, body_sha256, created_at, device}` (`url` is `owner_order.link` with `{id}`
filled in, else the API address), next to the written resource's title, so each change can be
matched with the order's text. Logs exclude request bodies, authorization and query credentials;
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
Contacts lookup needs `contacts.readonly` and `contacts.other.readonly` in `google_scopes`;
after adding them, run `auth-url` again and have the owner consent once (the old token keeps
working until then, and contacts reads return Google's 403 until it is replaced).
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
`막힌 쓰기` counts refused writes only: a `denials.jsonl` row whose method is not
`GET`/`HEAD`/`CONNECT` and whose reason is not an upstream failure (`request-failed`,
`upstream-unavailable`, ...). Refused CONNECT tunnels (a tool's telemetry host off the allow
list), refused reads and upstream failures stay in the journal and are not posted; with
nothing else to say the summary prints `SUMMARY_EMPTY`.
Links, owner proof, approvals and restore IDs stay in the journal only; the Dori
reads them from `GET /_gate/changes` and `GET /_gate/pending` when the owner asks.
Posts using the gate bot to the configured approval channel in chunks below 1900
characters. Prints `SUMMARY_EMPTY` or
`SUMMARY_POSTED N messages`. No service or timer is installed by these files.

## One gate holds the keys: forward mode and named grants

When the Dori host and the machine that keeps the owner's keys are different, run this same gate on
both and keep every Google (and vault) credential, every approval card and the journal on one of them
("the node gate"). Without the keys below in the config nothing changes.

**Forward mode** (the keyless gate, on the Dori host). Add
`"google_forward": {"unix": "/run/dori-gate-node/gate.sock", "timeout": 120}`. The Google port then
checks only the caller uid (`clients`) and passes the request (path, query, body,
`X-Dori-Owner-Message`; never `Authorization`) unchanged to the node gate, which does the owner proof,
the direct-or-card decision, the card, the write and the journal. The CONNECT allow list and the Discord
port stay local and unchanged. It parks nothing and runs no approval poller. `/_admin/status` answers
`mode: forward`; every other admin path answers `409 keys-on-node`. A node gate out of reach is
`502 node-gate-unavailable`, never a direct Google call. It refuses to start (`GATE_FORWARD_REFUSED
<reason>`, exit 3) while its state still holds `*-token.json` or `client_secret.json`, an open card in
`pending/`, or the config still has `vault`, `grants` or `token_clients`: move those first.

The socket comes from `systemd/dori-gate-node-tunnel.service` (`ssh -N -L <socket>:127.0.0.1:3129`, as
the gate user, its own key `/var/lib/dori-gate/node-tunnel-key` and a pinned `node-known-hosts`; the
socket is 0600) plus the drop-in `systemd/dori-gate.service.d/forward.conf`. On the node, a relay account
with one authorized_keys line that allows only this forward:
`restrict,port-forwarding,permitopen="127.0.0.1:3129",command="/usr/bin/false",from="<dori host>" <key>`.
The node gate sees the relay account's uid, so its `clients` is `[<relay uid>]`.

**Node gate.** A listener whose port is `null` stays off (`"listen": {"connect": null, "google": 3129,
"discord": null}` until the Dori itself lives there). Named grants hold other refresh tokens for local
jobs that cannot carry an owner message (scheduled reminders, Drive publishing):

```json
"grants": {"jobs": {"scopes": ["openid", "https://www.googleapis.com/auth/calendar", "..."],
                    "token_file": "jobs-token.json"}},
"token_clients": [1002]
```

`GET /_gate/access-token?grant=jobs` from a `token_clients` uid returns
`{"access_token", "expires_in", "scope"}` (never a refresh token) and appends
`{ts, uid, grant}` to `tokens.jsonl`; everyone else gets `403 token-client-required`, a grant not yet
consented `503 google-auth-required`, and the reverse API's own grant is never minted
(`400 grant-required`). A named grant may hold send-capable scopes (the jobs it serves send approved
mail themselves); the reverse API's grant still may not. Consent per grant:
`gatectl.py auth-url --grant jobs`, then `gatectl.py auth-finish --grant jobs '<redirect>'`.
`gatectl.py status` lists `grants` with presence and scopes only.

## Tests

```sh
python3 -I -m unittest discover -s . -p test_gate.py -v
python3 -I -m py_compile gate.py gatectl.py summary.py test_gate.py
```

Tests use ephemeral loopback fake Google/Discord upstreams and temporary private
state. Trusted test injection points: `upstreams` (host to base URL),
`web.dial` (checked public address to a loopback plain-HTTP `[host, port]`), `web.search.endpoint`,
`discord_api_base`, `tokeninfo_url`, `proc_tcp_paths`, installed-client `token_uri`,
and ephemeral listener ports (`0`). Never make config writable by the client UID.

Python's isolated mode removes the current directory from the import search
path, so `python3 -I -m unittest test_gate.py -v` fails to import the test module.
Discovery explicitly adds its start directory while retaining isolated mode.
