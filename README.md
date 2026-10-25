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
| `effort-picker` | Sets each request's effort level from the task, not the prompt: Claude picks a level once it understands the work, and helpers get a level per job. | `/plugin install effort-picker@efi-mods` |
| `plain-language` | Claude's chat replies to you in plain, CEFR-level English (A2 or B1): no code unless asked, short task reports. Files, reviews and agent hand-offs keep full technical detail. | `/plugin install plain-language@efi-mods` |

Alternatively download the repo and load a mod locally using
`claude --plugin-dir <downloaded-repo>/<mod>` on a compatible Claude Code
runtime. This uses the plugin loader, not `~/.claude/skills/`.

Third-party marketplace auto-update is off by default. Run
`/plugin marketplace update` or enable auto-update for this marketplace.

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

## Prerequisites and supported surfaces

- Requires Claude Code with the mods/hooks engine.
- On machines with managed settings or a Team/Enterprise organization, the
  built-in `cc-plugin-sec-default` skips the user-mod events `classic.*`,
  `prompt.section`, `prompt.context`, `prompt.compose`, `skill.prompt`,
  `attribution.text` and `settings.read`. There is no user-side switch;
  an administrator must manage the plugin to lift it.
  - `effort-picker` uses none of those events.
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


