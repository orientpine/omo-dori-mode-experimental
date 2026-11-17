# agent-discord guard

The owner's decision `no-agent-discord`: a Dori never sends through `agent-discord`, the CLI logged in as the owner's own Discord user account; every message goes out with the Dori's bot token (`dori send discord`). On a host that has `agent-discord` installed (for reading), this guard sits ahead of it on `PATH`:

```bash
ln -sf ~/.dori/src/skills/dori-mode/setups/agent-discord-guard/agent-discord ~/.local/bin/agent-discord
hash -r; command -v agent-discord   # ~/.local/bin/agent-discord, before the real one
```

It runs the real `agent-discord` (the next one on `PATH`) with the same arguments and exit code. When the command writes (`message send|edit|delete|ack`, `file upload`, `reaction add|remove`, `thread create|archive`, ...), it first prints one line to stderr and appends it to `${XDG_STATE_HOME:-~/.local/state}/dori/agent-discord-guard.log`:

```
AGENT_DISCORD_SEND agent-discord message send: the owner's user-account CLI was called to write (directive no-agent-discord; a warning until 2026-12-01, then it refuses). Send with dori send discord (bot token).
```

Reads (`message list|get|search`, `whoami`, `snapshot`, `--help`) pass silently. New checks start as warnings; after 2026-12-01, with the log showing no false positives, the guard is changed to refuse (exit 1 before the real CLI runs). The directive ledger names this file and `AGENT_DISCORD_SEND` as the entry's check (`enforced`); if the file or token goes away, the entry goes back into briefs.
