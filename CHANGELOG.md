# Changelog

## [task-progress 1.0.0] - 2026-11-18
### Added
- `task-progress` - a live task list for Claude's multi-step work: a line above the prompt in Claude Desktop and the terminal, and a Tasks sidebar for VS Code-family editors installed with `/install-viewer` (detects VS Code, Cursor, Windsurf and VSCodium and asks which to use). The list's heading is the real goal of the work, not the command that started it

## [cache-monitor 1.2.0] - 2026-11-15
### Added
- Windows: while the monitor is on, the bundled `lib/keep-awake.ps1` keeps the PC out of sleep so the cache keep-alive and the idle handoff run before the PC sleeps, not on a cold cache after it wakes (the screen still turns off and locks). This includes an idle chat waiting for your next message. It lets go after the idle handoff, after a handoff skill records `stop` (until you type again), after `/monitor-off`, 2 h 15 min after your last message or answered question, and on battery below 30%
- If the idle handoff falls due while Claude's own question is waiting for your answer, the mod adds the handoff to the running task and ends that question with "no answer, the user is away". Before, the handoff waited until someone closed the question. Questions from other mods or from subagents are left alone
### Fixed
- A background shell that has finished no longer counts as running work for up to 3 hours when its completion notice is held back (for example behind an open question): the mod reads the shell's output file for the `[exited with code N]` line. The 3-hour limit stays as a fallback
### Security
- Windows: PowerShell and Node.js are started by their full paths (Node.js from the first full-path `PATH` folder that holds `node.exe`), and every child process runs in the mod's own folder. Before, a program named `node.exe` placed in a project folder could run instead of Node.js when a chat was opened in that folder. A Windows folder setting that is not a plain local-drive path switches the keep-awake helper off instead of being trusted
### Changed
- While a background agent or background shell is running, the mod now sends a keep-alive every 45-50 minutes instead of letting the cache expire. It still never starts a handoff during background work, and these keep-alives do not use up the one idle keep-alive. Before, a long background task (for example a multi-hour test run) could leave the chat with a cold cache

## [cache-monitor 1.1.0] - 2026-11-05
### Added
- 5-minute cache detection: when the last 3 cache-writing replies all used the 5-minute tier, the idle keep-alive and idle handoff are off for that chat, and a one-time notice suggests `"promptCacheTtl": "1h"` in `settings.json`. Context and usage handoffs are unchanged
### Changed
- The 99% usage handoff no longer waits for a running task to end (it could land 3-16 minutes late): it is added to the running task, and Claude reads it at its next step. If the engine refuses that, the turn ends first, or the task ends without running `/handoff`, the usual handoff prompt is sent instead

## [cache-monitor 1.0.1] - 2026-11-05
### Fixed
- No second handoff after a handoff: the mod's own `[cache-monitor]` handoff prompt no longer counts as a typed message, and after any handoff the chat gets no idle keep-alive or idle handoff until you type again
- The idle handoff comes ~2 hours after your last message again: a keep-alive now schedules the next check at least 45 minutes out, and 5-hour usage pacing no longer shortens it
- After `/clear`, a turn left open in the old session no longer delays the new session's context handoff, and `/monitor-off` / `/monitor-on` always act on the current session
- Windows: a record no longer fails while another record is releasing the state lock; a note containing a line break stays on one log line

## [cache-monitor 1.0.0] - 2026-11-04
### Added
- `cache-monitor` - keeps the 1-hour prompt cache warm (one keep-alive after ~55 idle minutes) and asks Claude to write a `/handoff` at 35-40% context, after ~2 hours idle, or at 98%/99% of the 5-hour usage limit. Zero-token checks by the bundled `lib/monitor.js` on a 60-second timer; `/monitor-off` and `/monitor-on` per session. Needs Node.js and a `/handoff` skill (`session-handoff` in `EfiPerez/claude-code-skills`)

## [plan-review 1.0.0] - 2026-11-04
### Added
- `plan-review` - when you approve a plan in plan mode, saves it to `plans/<slug>.md` and has Claude run the `codec-review` skill on it before writing any code. On Windows it keeps a review record (`plans/.codec-reviewed.json`) so an unchanged plan is not reviewed twice; on macOS/Linux it skips that record (macOS untested). If `codec-review` is not installed, it saves the plan, requests no review and shows how to install it. Needs `codec-loop` 1.1.0 or later from `EfiPerez/claude-code-skills`

## [effort-picker 1.0.1] - 2026-10-25
### Fixed
- A skill's `effort:` frontmatter is now detected only when the closing `---` is a line of its own (`----` or `---suffix` no longer ends the frontmatter early).
- `effort` and its `:` must be on the same line; only spaces or tabs may sit between them.

## [1.0.0] - 2026-10-25
### Added
- Initial publish: `effort-picker` 1.0.0, `plain-language` 1.0.0
