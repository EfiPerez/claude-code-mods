# Changelog

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
