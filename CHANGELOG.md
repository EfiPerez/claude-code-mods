# Changelog

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
