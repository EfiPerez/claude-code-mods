import type { EffortPickerCategory as Category, EffortPickerLevel as Level } from '../types'

// effort-picker's rubric: default level and guidance per task category, as data.
// Data only - register.ts
// validates it (validateRubric) and renders the set_effort tool description from
// it. Safety policy never lives here: the level enum, the category names, the
// xhigh/max approval, the max-only-with-prior_attempt_failed refusal and the
// baseline clamp are code in register.ts.
//
// Release rule (README "Rubric"): `checkedAt` moves only after a comparison
// against `source`, recorded in the README's "Rubric check log"; bump `version`
// on every release that touches this object. Any text change here changes the
// tool description and costs every session one prompt-cache miss.

export type Rubric = {
  readonly schema: 1
  readonly version: string
  readonly checkedAt: string
  readonly source: string
  readonly checkedModels: readonly string[]
  readonly categories: Readonly<Record<Category, { readonly level: Level; readonly label: string; readonly when: string }>>
  readonly rules: readonly string[]
}

export const RUBRIC: Rubric = {
  schema: 1,
  version: '2026.10.21',
  checkedAt: '2026-10-18',
  source: 'https://platform.claude.com/docs/en/build-with-claude/effort',
  checkedModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-7'],
  categories: {
    chat_or_question: { level: 'low', label: 'chat or question', when: 'answering from what you already know' },
    lookup_or_search: { level: 'low', label: 'lookup or search', when: 'finding files, reading status, short lookups' },
    trivial_edit: { level: 'low', label: 'trivial edit', when: 'one-line edit, rename, formatting, obvious fix' },
    contained_change: {
      level: 'medium',
      label: 'contained change',
      when: 'known-cause bug fix, small feature in 1-2 files, doc from known facts',
    },
    multi_file_change: { level: 'high', label: 'multi-file change', when: 'changes across several files' },
    unknown_root_cause: { level: 'high', label: 'unknown root cause', when: 'debugging where the cause is not yet known' },
    review_or_plan: { level: 'high', label: 'review or plan', when: 'reviews, plans, designs' },
    strict_rules: {
      level: 'high',
      label: 'strict rules',
      when: 'skills/CLAUDE.md rules to follow exactly, personal or sensitive data handling',
    },
    long_agentic: { level: 'high', label: 'long agentic work', when: 'work expected to run >30 min' },
    architecture_security_data: {
      level: 'high',
      label: 'architecture, security or data',
      when: 'architecture, security, migrations, financial calculation correctness',
    },
    prior_attempt_failed: {
      level: 'max',
      label: 'prior attempt failed',
      when: 'ONLY when xhigh already failed on this same problem in this session',
    },
  },
  // Guidance bullets of the description's "Rules:" list, after the two
  // code-generated ones (max refusal, xhigh/max approval). "Never flip back and
  // forth" stays in the call-mechanics paragraph in register.ts: moving it into
  // a bullet would change the tool description.
  rules: [
    'Never `low` for code changes of unclear scope or any sensitive-data work (at low the model is more likely to skip a search, stop early, or skip a check).',
  ],
}
