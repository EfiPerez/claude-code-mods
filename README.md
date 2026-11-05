# claude-code-mods

Claude Code mods for everyday workflows, by Efi Perez ([@EfiPerez](https://github.com/EfiPerez)).

A *mod* is a Claude Code plugin with a hooks module: code that runs inside
Claude Code on events such as a prompt being sent, a tool being called or a
model request going out.

## Install

Add the marketplace once:

```
/plugin marketplace add EfiPerez/claude-code-mods
```

Then install only the mods you want:

| Mod | What it does | Install command |
|---|---|---|
| `cache-monitor` | Keeps the 1-hour prompt cache warm while you step away, and asks Claude to write a `/handoff` before a session gets too big: at 35-40% context, after ~2 hours idle, or near the 5-hour usage limit. **Needs Node.js and a `/handoff` skill** — see below. | `/plugin install cache-monitor@efi-mods` |
| `effort-picker` | Sets each request's effort level from the task, not the prompt: Claude picks a level once it understands the work, and helpers get a level per job. | `/plugin install effort-picker@efi-mods` |
| `plain-language` | Claude's chat replies to you in plain, CEFR-level English (A2 or B1): no code unless asked, short task reports. Files, reviews and agent hand-offs keep full technical detail. | `/plugin install plain-language@efi-mods` |
| `plan-review` | When you approve a plan in plan mode, saves it to `plans/` and has Claude run the `codec-review` skill on it before any code is written. **Needs `codec-review`** — see below. | `/plugin install plan-review@efi-mods` |

Alternatively download the repo and load a mod locally using
`claude --plugin-dir <downloaded-repo>/<mod>` on a compatible Claude Code
runtime. This uses the plugin loader, not `~/.claude/skills/`.

Third-party marketplace auto-update is off by default. Run
`/plugin marketplace update` or enable auto-update for this marketplace.

## cache-monitor

- **Why:** Claude Code caches the conversation for 1 hour. A message after the cache
  expires re-writes the whole conversation at about 20x the price of a cache hit, and
  very long sessions get expensive on every turn. This mod watches both and acts at the
  right moment, so you don't have to.
- **How it works:** from session start, a 60-second timer runs the bundled
  `lib/monitor.js` when a check is due (every ~45 minutes, closer together near a
  threshold). The check reads only the tail of the session transcript and costs **no
  tokens**. It then follows the recommendation:

  | Trigger | When | What the mod does |
  |---|---|---|
  | Context window | 35-40% of usable context | Asks Claude to run `/handoff` once the current turn ends |
  | Context ceiling | 40% or more | Asks for `/handoff` now |
  | Idle keep-alive | ~55 min since your last message and Claude's last reply | One keep-alive: a forked request that re-reads the cache (about the price of a cache read) and adds nothing to the transcript |
  | Idle handoff | idle again after that keep-alive (~2 h total) | Asks for `/handoff`, then pauses until your next prompt |
  | 5-hour usage | 98% (waits for the turn to end) / 99% (now) | Asks for `/handoff`, once per 5-hour window. At 99% while Claude is mid-task, the request is added to the running task (Claude reads it at its next step) instead of waiting for the task to end. Off unless a usage source exists (below) |

- **5-minute cache:** if the last 3 replies that wrote cache all used the 5-minute cache
  tier (no `"promptCacheTtl": "1h"` setting), the idle keep-alive and idle handoff are
  switched off for that chat, because the cache is long gone by then. A one-time notice per
  chat says so and suggests adding `"promptCacheTtl": "1h"` to `settings.json`. The context
  and usage handoffs stay on.

- Safety rules: one context handoff per session; it **never** spends a keep-alive or starts
  a handoff on an already-expired cache (it waits for your own next prompt); it waits while
  a background agent or background shell is still running; after a handoff it sends no
  keep-alive or second handoff until you type again; a brand-new tab with no
  transcript yet is never read as some other session.
- `/monitor-off` stops it for the current session only; `/monitor-on` restarts it. In
  surfaces that don't list mod commands, write the session id into
  `~/.claude/cache-timer/<project-folder-name>.<session-id>.off` instead. After `/clear` or a
  resume (a new session id) the monitor starts fresh for the new conversation.
- If the engine refuses a handoff prompt, nothing is marked as sent and the check is retried
  in 5 minutes.
- Two chats in one project share the state file under a lock file
  (`<project>.json.lock`). If a crash ever leaves `<project>.json.lock.recover` behind, the
  log stops updating for that project and `node lib/monitor.js record` reports the file to
  delete; delete it by hand.
- In the VS Code panel it raises a `ui.notify` notice when the handoff turn ends (a sound
  mod listening for `ui.notify` can play a chime on it). The notice means the turn finished,
  not that a file was certainly written.
- **Files it writes**, under `~/.claude/cache-timer/` (or `$CLAUDE_CONFIG_DIR/cache-timer/`):
  `<project>.json` (per-project state, with per-session counters) and `<project>.log` (one
  tab-separated line per check: action, context %, cache age, idle minutes, token count).
  No prompt or file text is written. It also keeps one `$.store` value per session (the
  context-handoff latch, pruned after 7 days).
- **Requires:**
  - **Node.js** on `PATH` (`node`), because the checks run as `node lib/monitor.js`.
  - **A `/handoff` skill**, which the handoff prompt tells Claude to run, and
    `/resume-handoff` to pick it up in a new session. Both are in the `session-handoff`
    plugin of the companion marketplace
    [`EfiPerez/claude-code-skills`](https://github.com/EfiPerez/claude-code-skills):

    ```
    /plugin marketplace add EfiPerez/claude-code-skills
    /plugin install session-handoff@efi-skills
    ```

    Without a `/handoff` skill the mod still keeps the cache warm, but at a handoff
    trigger Claude is asked to run a skill that does not exist and will improvise or say so.
- **Optional, for the 5-hour usage trigger:** a usage source. Either make your status line
  script copy its JSON input (it carries `rate_limits.five_hour`) to
  `~/.claude/rate-limits-cache.json`, or put `{"dashboardUsageUrl": "<url>"}` in
  `~/.claude/cache-timer/config.json`, pointing at an endpoint that returns
  `{realFiveHourPct, realFiveHourResetsAt, realAt}`. With neither, that trigger is silently off.
- Thresholds are fixed in `lib/monitor.js` and `lib/core.js` (35%/40% context, 55-minute
  idle, 1 keep-alive, 98%/99% usage). Context % uses the same usable-window denominator as
  Claude Code's own indicator. Model prices in `lib/core.js` feed only the cost estimate
  in the log.

## effort-picker

- Every automatic prompt starts at a **baseline** effort (setting `baseline`,
  default `high`).
- Once Claude understands the task it calls the tool
  `mcp__effort-picker__set_effort {level, category}` in the same message as
  its next tool calls. The mod then rewrites the effort of every later request
  in that loop. Categories (chat, lookup, trivial edit, contained change,
  multi-file change, unknown root cause, review/plan, strict rules, long
  agentic work, architecture/security/data, prior attempt failed) each carry a
  default level.
- **`xhigh` and `max` need your approval.** The mod asks with a question card;
  a "no", a dismissed card or a headless run (`claude -p`) falls back to
  `high`. `max` is only accepted with the category `prior_attempt_failed`.
- Helpers (subagents): the parent sets the Agent tool's `effort` per job. Start
  an Agent `description` with `[effort-locked] ` to lock the child at that level.
- Your manual choice wins for that prompt: `/effort`, `ultrathink`, a skill whose
  frontmatter declares `effort:`. Setting `CLAUDE_CODE_EFFORT_LEVEL` turns the
  mod off for the whole session.
- A one-line footer under the answer shows the level when it changed.
- Notices: a toast when the built-in effort rules are older than `staleDays`
  (default 90, `0` turns it off), or when a session runs on a Claude model the
  rules were not checked against. Either means: check for a plugin update.
- Files it writes: a per-session log at
  `~/.claude/effort-picker/logs/<YYYY-MM-DD>_<session>.jsonl` holding only
  levels, categories, ids and counts (never prompt or file text), and one
  `$.store` value (the day the stale notice was last shown).
- The per-category defaults follow Anthropic's effort guidance
  (<https://platform.claude.com/docs/en/build-with-claude/effort>) as of the
  date in `hooks/rubric.ts` (`checkedAt`).

## plain-language

- Adds style rules for chat replies only: CEFR `B1` by default, `A2` via the
  `cefrLevel` setting. Files Claude writes, prompts for subagents or other AI
  tools, and subagent results keep full technical detail.
- Two delivery paths: a system-prompt section (`prompt.compose`), and the same
  rules attached once as hidden context to the first accepted prompt of each
  conversation (again after `/clear`). On compaction the summarizer is asked
  to keep the rules.
- Skipped on every path for headless runs (`claude -p`, the SDK); the
  system-prompt section is also skipped for `--bare` and teammates.

## plan-review

- **Requires the `codec-review` skill**, from the `codec-loop` plugin (version 1.1.0 or later)
  in the companion marketplace
  [`EfiPerez/claude-code-skills`](https://github.com/EfiPerez/claude-code-skills):

  ```
  /plugin marketplace add EfiPerez/claude-code-skills
  /plugin install codec-loop@efi-skills
  ```

  `codec-review` in turn needs the OpenAI Codex CLI (or its same-family fallback) — see that
  repository's README, including its **Privacy** section. If `codec-review` is not installed,
  `plan-review` still saves the plan, requests no review, and shows a notice with the install
  commands.
- When you approve a plan (`ExitPlanMode`), it saves the plan to `plans/<slug>.md` in the
  session's project folder (a timestamp is added if that name exists) and tells Claude to run
  `codec-review` on that absolute path, and not to start implementing until the review is
  signed off. Plans approved by subagents are ignored.
- **Windows:** it also keeps a review record, `plans/.codec-reviewed.json`, keyed by the plan's
  SHA-256, using Windows PowerShell (`hooks/sentinel.ps1`). An unchanged plan approved again
  is not reviewed twice, and a second approval while a review is running does not start
  another. `codec-review` updates the record as it works (renews a 20-minute lease each round,
  marks the plan `reviewed` at the end, removes it on abort). Commit or ignore `plans/` as you
  prefer; the `.codec-*` files are bookkeeping.
- **macOS / Linux:** no review record is kept, so an unchanged plan approved again is reviewed
  again. Everything else works the same. Not tested on macOS.
- Off switch: start Claude Code with the environment variable `CODEC_REVIEW_ACTIVE` set to any
  value, and the mod does nothing.

## Prerequisites and supported surfaces

- Requires Claude Code with the mods/hooks engine.
- On machines with managed settings or a Team/Enterprise organization, the
  built-in `cc-plugin-sec-default` skips the user-mod events `classic.*`,
  `prompt.section`, `prompt.context`, `prompt.compose`, `skill.prompt`,
  `attribution.text` and `settings.read`. There is no user-side switch;
  an administrator must manage the plugin to lift it.
  - `cache-monitor`, `effort-picker` and `plan-review` use none of those events.
  - `plain-language` loses its system-prompt section there and falls back to
    the first-prompt context path described above. The rules then reach the
    model as part of the first message's context rather than the system
    prompt.
- VS Code panel support depends on the extension version. Question cards
  (`effort-picker`'s approval) and toasts show in the panel; do not expect
  terminal/Desktop UI parity.
- Tests are not included in this published copy. Engine-generated
  `.claude-plugin/types/` declarations are regenerated at load time.

## Licence

MIT — see [LICENSE](LICENSE).

## Credit

Built by Efi Perez.
