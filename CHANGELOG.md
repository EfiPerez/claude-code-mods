# Changelog

## [effort-picker 1.0.1] - 2026-10-25
### Fixed
- A skill's `effort:` frontmatter is now detected only when the closing `---` is a line of its own (`----` or `---suffix` no longer ends the frontmatter early).
- `effort` and its `:` must be on the same line; only spaces or tabs may sit between them.

## [1.0.0] - 2026-10-25
### Added
- Initial publish: `effort-picker` 1.0.0, `plain-language` 1.0.0
