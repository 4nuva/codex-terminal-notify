# terminal-notify for Codex

> **From the makers of [Agent Terminal](https://4nuva.dev/agent-terminal/).**
> In Agent Terminal these notifications also reach your paired phone, where you
> can open the session and reply. [Get Agent Terminal →](https://4nuva.dev/agent-terminal/)

A Codex plugin that raises a desktop notification through your terminal when Codex:

- finishes a turn: `Task complete: Fixed the failing test. All 42 tests pass.`
- needs a permission: `Permission needed: Bash — npm run deploy`
- asks you a question: `Question: Which database should I use?`

The title names the project folder (`Codex · my-app`), so you can tell sessions apart.

## Install

From a shell:

```
codex plugin marketplace add 4nuva/codex-terminal-notify
codex plugin add terminal-notify@agent-terminal
```

Then start Codex. It shows **Hooks need review** for the plugin's three hooks: choose **Trust all and continue**, or review them with `/hooks`. Until they are trusted, they do not run.

Requires [Node.js](https://nodejs.org/) 18 or later on your `PATH`, and macOS or Linux.

## Terminals

The plugin writes a notification escape sequence to your terminal, and picks the sequence for the terminal it detects:

| Terminal | Sequence |
| --- | --- |
| [Agent Terminal](https://4nuva.dev/agent-terminal/) (desktop and phone) | OSC 777 |
| Ghostty, Warp, urxvt | OSC 777 |
| Windows Terminal, iTerm2, WezTerm, ConEmu | OSC 9 |
| kitty | OSC 99 |
| macOS Terminal, VS Code | bell |
| anything else | OSC 9 |

Codex has notifications of its own (`notification_method` and `notification_condition` under `[tui]` in `~/.codex/config.toml`). If you see two notifications, change those to keep only this plugin's.

Some terminals only show notifications while their window is in the background, and some need notifications turned on in their own settings (iTerm2: Profiles → Terminal → Notifications). Inside tmux, sequences reach the outer terminal only with `allow-passthrough on`.

## Options

Set these as environment variables in the shell you start Codex from:

| Variable | Default | What it does |
| --- | --- | --- |
| `TERMINAL_NOTIFY_FORMAT` | `auto` | `auto`, `osc777`, `osc9`, `osc99`, `all`, `bell` or `off`. `all` sends all three sequences, for a terminal `auto` does not know; a terminal that reads more than one (Ghostty reads 9 and 777) shows more than one. |
| `TERMINAL_NOTIFY_DETAILS` | on | `0`, `false`, `no` or `off` keeps the start of the reply, the command or file a permission is for, and the question out of the notification. It shows only the event. |

There is no idle reminder: Codex has no event for an idle prompt.

## How it finds your terminal

Codex runs hooks from a background daemon that has no terminal, so the hook writes to the terminal of the `codex` process running in the session's folder. Two sessions in one folder both get the notification; a session with no terminal gets none.

## Privacy

Nothing leaves your machine except through your terminal. Before any text goes into a notification, known key and token formats (API keys, GitHub and Slack tokens, JWTs, bearer tokens, `password=...`, credentials in URLs, long random strings) are replaced with `***`. Turn `TERMINAL_NOTIFY_DETAILS` off to keep reply text and commands out of notifications entirely, for example when notifications show on a lock screen.

Subagents' turns do not notify; only the main session's do.

## Development

```
node --test test/notify.test.js
```

## License

The code is MIT. The Agent Terminal name and logo (`assets/icon.png`) are not covered by that licence; all rights reserved. See [LICENSE](LICENSE).

---

**[Agent Terminal](https://4nuva.dev/agent-terminal/)** is a terminal for running coding agents, on your desktop and your phone. It shows these notifications on the desktop and forwards them to your paired phone.
