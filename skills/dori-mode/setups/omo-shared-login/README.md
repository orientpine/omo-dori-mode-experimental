# omo shared login

One omo login, kept by the source account (zzangdori, `oriclaw`), lent to the
other Dori accounts on the same host (`okdori`, `moodori`, `yoodori`, `gongdori`, `soodori`). The
accounts stay separate; only the login is shared. A lapsed login or a new
account needs one login, on zzangdori, instead of one per Dori.

## Why not copy auth.json

OAuth refresh grants are single-use: a refresh returns a new refresh token and
retires the old one. Two copies of one `auth.json` that both refresh cut each
other off. On 2026-10-19 the copies on okdori and moodori held a grant that
zzangdori had already rotated, and okdori's slot was `auth_error`. senpi also
cannot share one file across accounts: the path is always
`<agentDir>/auth.json`, a write stages a temp file and renames it over the path
(which replaces a symlink), and the lock is per path (`realpath: false`).

## How it works

- Only the source redeems grants. `omo-login-share sync` refreshes every source
  OAuth account whose access token expires within 90 minutes. It uses pi-ai's
  `refreshOAuthCredential`, which runs the exchange outside the lock and saves
  only if the slot's refresh token is still the same. senpi itself refreshes
  5 minutes before expiry, so the broker always gets there first.
- Anthropic accounts live in the Claude CLI store now (`store: "claude-cli"`,
  `<agentDir>/anthropic-subscription-claude/<dirId>/.credentials.json`); pi-ai
  no longer ships `auth/oauth/anthropic.js` and the old import failed every
  sync after the 2026-11-06 update. The Claude CLI owns that refresh: when a
  slot is within 5 minutes of expiry, sync runs the source CLI once
  (`claude -p ... "Reply OK."` on opus-5-5, one turn, no tools) so it renews
  itself. Borrowers get the auth.json slot as identity only (store, dirId, no
  tokens) plus `borrowCliCredential`'s access-only copy of `.credentials.json`
  (access token, expiry, scopes; never the refresh grant) in their own CLI
  directory, marked `.omo-shared-login`; a borrower that holds its own Claude
  refresh grant is never overwritten. A rejected Claude login is reported to
  the lead; its login is interactive, so the broker does not start it.
- Renewal is judged by a changed access token with a later expiry, not by the
  CLI turn's exit code (a real inference limit can reject the turn after the
  refresh), and `auth status` alone never counts as renewal.
- A borrower's Claude credential file is written to a temp file and renamed
  into place; a slot counts as usable only in a real 0700 directory with a real
  0600 file. Symlinks and a borrower-owned refresh grant are refused.
  `cli-store.test.js` runs `remote.js` against a throwaway HOME for these.
- One Claude account that cannot be read or renewed (no credential file yet,
  expired access) is skipped and alerted (`cli_unavailable:<provider>/<name>`,
  `cliSkipped` in the sync report); every other account still travels. The
  borrower's verdict state for a Claude slot (block, `blockedAt`,
  `authVerdict`, `signInRequired`) is kept while the slot names the same
  `dirId` and dropped when the source signs in again (new `dirId`).
- `login anthropic-subscription --account NAME` keeps NAME on the very first
  Claude account too (senpi itself names that one `default` without asking).
- Each borrower receives the source's OAuth providers with every refresh token
  replaced by `omo-shared-login:managed-by-oriclaw`. A borrower can use the
  access token but can never rotate a grant. The borrower keeps its own
  account-level state (rate-limit blocks, its pin). An `auth_error` block is
  dropped once the slot carries a new token. OAuth providers the source no
  longer has are removed, and API-key entries are left alone.
- The write runs as the borrower (`sudo -n -u <account>`, through
  `~/.local/bin/node-dori-do`), inside the borrower's own senpi file lock and
  atomic write. Tokens travel on stdin only, never argv, env, logs or the state
  dir. Running sessions see the new file at their next request (senpi re-reads
  auth.json when its hash changes), so nothing restarts.
- YooDori's egress gate is untouched. The borrower reads nothing of oriclaw's
  home and gets no new path, port or socket: oriclaw writes into the
  borrower's file with the sudo rule it already has.
- Triggers: `omo-login-share.timer` every 3 minutes, plus `omo-login-share.path`
  on every change of the source auth.json. A `/login` on zzangdori therefore
  reaches the borrowing accounts within seconds, and at most within 3 minutes.
- Alerts go to the live lead pane (`dori lead`, `dori type`) as
  `[ALERT] omo-shared-login | ...`. They fire when a source grant is rejected
  (and a login link is started, see below), when a source refresh keeps failing
  while its token is within 30 minutes of expiry, when a push fails, or when the
  sync unit itself fails (`OnFailure=`). Each alert repeats at most every
  6 hours and is followed by one "회복" line once it clears.

## Install, enable, roll back

```sh
sh skills/dori-mode/setups/omo-shared-login/install.sh   # as oriclaw
omo-login-share enable     # backs up each borrower's auth.json, pushes, starts timer + path unit
omo-login-share status     # one row per account and slot; last line STATUS_ALL_BORROWED
omo-login-share disable    # rollback: stops the units, restores each borrower's pre-share backup
```

The backup is `auth.json.before-shared-login-<UTC stamp>` in each borrower's
agent dir (mode 0600, the first push's content). `disable` writes it back under
the lock and reports `identical=true` when the bytes match. Note that the
backups of okdori and moodori are copies of zzangdori's grants from before the
share; some of those grants may have rotated since, so a rollback can bring
back the old breakage.

## Login: one step for the owner

When a login lapses (the sync sees the grant rejected), the broker starts
`omo-login-share login <provider> --account <slot> --notify` by itself, and the
lead receives `[LOGIN] ... 형에게 보낼 링크: <url>`. The lead forwards the link
to the owner with the bot. To add an account, or to log in by hand:

```sh
omo-login-share login xai --notify                                   # device link: the owner only approves
omo-login-share login anthropic-subscription --account cbaekdong --notify
omo-login-share login chatgpt-subscription --notify
omo-login-share code '<what the owner pasted>'                         # Anthropic / ChatGPT only
```

- xAI: the link carries the device code, so the owner opens it and approves.
- Anthropic and ChatGPT: the owner approves, then pastes the code (or the
  final page address) shown in the browser into the thread. The lead passes it
  on with `omo-login-share code`.
- When a login asks for a method, `login-method.js` answers: copy code for
  Anthropic (the code Anthropic shows; the Claude CLI login through senpi's
  `oauth-login.js`), and for ChatGPT the legacy account route, then browser
  login (the final page address). pi-ai expects the option id back; `bun test`
  in this folder checks the ChatGPT choice against the installed pi-ai without
  contacting the service.
  `login-method.d.ts` only gives tsc its types (`bunx tsc --noEmit -p .` in
  `scripts/` checks this folder too); install.sh does not ship it.
- A login that cannot finish (no link, wrong code, 30 minutes without a code)
  sends `[ALERT] ... 로그인이 끝나지 못함: <reason>` to the lead under `--notify`,
  with the command to try again.
- `/login` in zzangdori's own omo works the same way: the path unit pushes the
  result to the borrowing accounts.

## Adding a borrower

Add the account to `BORROWERS` in `omo-login-share.ts` once its Linux user exists
and `oriclaw` may `sudo -n -u <account>` (the same rule the other Dori have),
then re-run `install.sh` and `omo-login-share sync`. An account that never had
a login (gongdori, added 2026-10-19) holds an empty `auth.json` (`{}`) from the
omo install; the first push backs that up, so `disable` brings the account back
to no login at all.

형이 할 일: 짱돌이 보낸 링크를 열어 승인한다(Anthropic·ChatGPT는 화면에 나온 코드를 스레드에 한 번 붙인다). 다섯 도리에 반영하는 것은 짱돌이 한다.

## Test without touching a live session

`--test-dir REL` points every borrower at `/home/<account>/REL` (for example a
copy of the agent dir with symlinks to everything but `auth.json`), so pushes
and calls can be tried with `OMO_CODING_AGENT_DIR=/home/<account>/REL omo -p
--no-session ...` while the lead sessions keep their own files.
`bun test borrow.test.js` covers the document transform and the access-only
Claude CLI credential copy.
