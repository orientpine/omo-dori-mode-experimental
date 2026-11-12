# Setup

Run these once, in order. Stop and ask the owner wherever a step needs their choice or their hand.

If the owner is on Discord and lanes should run as aoe/tmux sessions rather than herdr tabs, follow `setups/discord-aoe/README.md` instead of steps 1 and 5: it installs the listener, question cards, thread hooks, lane sweeps and session watcher as user services. Steps 2 to 4 still apply.

## 1. herdr

herdr is the terminal multiplexer the Dori runs in. Every lane is a herdr tab, and herdr lets you read a pane, type into it and see which process runs there.

```sh
curl -fsSL https://herdr.dev/install.sh | sh
herdr integration install pi        # or the integration for the agent you run in
herdr --skill                       # load its skill unless it is already in your context
```

The scripts reach herdr and hc (herdr-core) through the session runtime (`scripts/src/runtime/`, upstream dori-superagent #147-#158). `"runtime": "hc"` in the config (or `DORI_RUNTIME=hc`) opens new lanes as labelled hc terminals, one per lane, with the agent's status from its own OSC 7501 report; a session the Dori stores is then the pane `hc:t<n>`, and launch, handover, revive, `dori type`, the screen reads, the lane close and doriterm's row answer it through hc. Unset, the Dori picks hc inside an hc terminal (`HC_TERMINAL_ID`), herdr inside a herdr pane (`HERDR_PANE_ID`), else hc when it is installed, else herdr (upstream #177); with both installed herdr is one config line away (`"runtime": "herdr"`). hc lanes are not supported on native Windows (hc launches through a Unix `env` line in `$SHELL`); use herdr there. An hc core keeps no `DORI_*` of the call that started it, as herdr's server does not. A Dori has one hc core: the `HC_SESSION` its `dori.env` names, else the default core; every hc call of the scripts goes there, whatever `HC_SESSION` the calling shell or unit has (an isolated test core is named in its `DORI_ENV_FILE`); doriterm's bridges stay in the bridge host's own core. doriterm attaches an hc lead with `hc attach` (the owner types into it as into a herdr lead), and `setups/discord-aoe/dori.sh` attaches it with `hc attach`; both take the Dori's core from `dori.env` through the scripts' `envFileEntries` parser and refuse to start a missing core (`scripts/src/hc-lead-core.ts`). `dori migrate` (moving sessions between runtimes) is not ported yet (`docs/follow-ups.md`).

hc is installed the same way on every account: version 0.1.18 (the one doriterm's host runs), the build for the machine from `https://releases.herdr.dev/core/0.1.18/manifest.json`, checked against that manifest's `sha256`, copied to `~/.local/bin/herdr-core` with an `hc` link beside it. The release's `install.sh` is not used: it adds `?src=install` to the download for the release server's download count. An account that cannot download (yoodori) gets the same checked file from another account. Then put `notes = false` in `~/.config/herdr-core/config.toml`, so hc never types notes into an agent itself.

### Or: aoe on tmux

If the owner already runs agents with aoe (agent-of-empires), lanes can be aoe sessions instead of herdr tabs. You need `aoe`, `tmux`, and the agent available to `aoe add --tool <name>`: a built-in agent (`aoe agents` lists them) or a custom agent in aoe's settings, as omo is. Run the Dori itself in an aoe session too, and in step 4 set:

```json
{
  "backend": "aoe",
  "leadPane": "<your own tmux session, from: tmux display-message -p '#S'>",
  "agentCommand": ["omo", "--model", "{model}", "{prompt}"],
  "ignorePanes": ["<the owner's own sessions the sweeps should skip>"]
}
```

With aoe, `agentCommand[0]` is the aoe tool name and the model goes in through `--extra-args`; `laneWorkspace` and `workspaces` are not used. How lanes differ under aoe: `references/sessions.md`, "The aoe backend".

## 2. Messenger

Install agent-messenger (github.com/agent-messenger/agent-messenger) and read which platforms it supports. Ask the owner which one to use and wait for the answer.

agent-messenger wraps part of each platform. Read the platform's current bot API changelog and call the API directly for the rest:

- Telegram: stream a reply as it grows and show "Thinking…" with message drafts, send rich messages for tables and headings, and use topics in the private chat (turn on threaded mode in BotFather's mini app; there is no API for that switch).
- Discord: edit your own messages to grow them, and use threads.

### If the owner picks Slack: user token or bot token

Ask which mode, give the trade-off as a short list, and wait for the choice:

- **User token**: the Dori acts as a real member of the workspace.
  - It needs a paid seat, which the owner pays for.
  - It reads everything that member can see.
  - It can keep a green online dot (`dori presence slack`).
- **Bot token**: the Dori is a Slack app.
  - There's no seat cost.
  - It only sees channels it is invited to, within the scopes the app was granted.
  - It shows as an app, not a person.

Record the choice in `dori.env` (Slack settings are read only from there, never from the environment). With a user token, set `DORI_SLACK_TOKEN` and `DORI_SLACK_COOKIE` (the `d` cookie from that member's browser session). With a bot token, set `DORI_SLACK_TOKEN` to the `xoxb-` token. If you run a second Dori home on the same machine, also write that home's token to `slack-token` next to its `config.json` and `chmod 600` it: `dori launch` then hands its lanes the file's path, never the token (see `dori launch` in `scripts.md`). A token file outside that home is refused unless its `dori.env` sets `DORI_SLACK_TOKEN_FILE_OUTSIDE_HOME=1`.

## 3. Bot

Finish every login in the browser. Create the bot with agent-messenger and finish its setup. Then give it its avatar: the default is `assets/dori-avatar.png` in this skill, and the owner can swap in any image.

- **Telegram**: @BotFather → `/setuserpic` → pick the bot → send the image.
- **Discord**: Developer Portal → your application → **General Information** → App Icon, and **Bot** → Icon.
- **Slack**:
  - bot token: the app's **Basic Information** → Display Information → App icon;
  - user token: the member's profile photo (`users.setPhoto`, or the profile page).

Greet the owner through the bot before doing anything else.

## 4. Scripts

```sh
cd skills/dori-mode/scripts && bun install && bun link    # puts `dori` on PATH
mkdir -p ~/.dori && cp ../references/config.example.json ~/.dori/config.json
```

`install.sh` does the same and first updates `~/.dori/src` (`DORI_SRC`) with `git pull --ff-only`. If local changes or local commits there block that pull, it exits 1 with the checkout, its `git status --short` and both ways on: rerun with `DORI_NO_PULL=1` (or `true`, `yes`) to install the checkout as it is, or drop the work (`git -C ~/.dori/src fetch && git -C ~/.dori/src reset --hard '@{u}'`) and rerun. A branch with no upstream gets git's own advice and no reset.

Then edit `~/.dori/config.json`: at least `leadPane` (your own herdr pane, from `herdr pane current`; with aoe, your tmux session name), `laneWorkspace` (herdr only), `defaultCwd`, and the two hooks if you want lane threads updated automatically. `references/scripts.md` explains every field.

## 5. Monitors

Arm these as persistent monitors in your own session:

| Monitor | Command | Filter |
|---|---|---|
| inbound messages | your messenger's watch command | new owner messages |
| done flow (and `LANE_BLOCKED` with aoe) | `dori watch` | `^LANE_` |
| dead panes | `dori dead-panes --loop 3` | `^(DEAD\|UNRECOGNISED)_PANE` |
| host guard | `dori guard --loop 1` | `^HOST_GUARD` |
| freshness | `dori freshness --loop 5` | `^(NUDGED\|NUDGE-FAILED\|LEAD-TOLD\|LEAD-TELL-FAILED\|NO-REPORT\|STUCK\|ROLLOVER_DUE\|RESEARCH_NOT_STARTED)` |
| Slack inbound (Slack only) | `dori inbound slack --loop 1` | `^INBOUND` |
| Telegram inbound (Telegram only) | `DORI_TELEGRAM_TOKEN=… DORI_TELEGRAM_OWNER_ID=… dori inbound telegram --loop 1` | `^INBOUND` |
| Slack as a bot (Socket Mode, `setups/discord-aoe/slack-watch.ts`) | `bun <fork>/skills/dori-mode/setups/discord-aoe/slack-watch.ts --wait` | `SLACK_(MSG\|WATCH_OFF\|WATCH_READY\|[A-Z_]*FAIL)` |
| presence (optional) | `dori presence slack` or `dori presence discord` | `^PRESENCE_READY` |

## 6. First look around

Once the bot is live, explore the machine: running coding-agent sessions, the tools in use, recent logs. Write what you find into memory, and adopt any running lanes with `dori adopt`.