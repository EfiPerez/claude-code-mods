import type { CommandInfo, EngineInterface, Register } from 'claude-code'
import { update } from 'claude-code'
import type {
  EffortPickerCategory as Category,
  EffortPickerLevel as Level,
  EffortPickerLoop as LoopState,
  EffortPickerManual as Manual,
} from '../types'
import { RUBRIC, type Rubric } from './rubric'

// effort-picker: each Claude request runs at the effort level the TASK needs,
// not the prompt. The model calls set_effort once it understands the task, in the
// same message as its next real tool calls (zero added latency, R9); a
// turn.step hook rewrites `effort` on every later request of that loop. Every
// automatic main turn starts at the baseline B (R7). A manual choice (/effort,
// ultrathink, a skill with `effort:` frontmatter, a user-named helper level)
// wins for that prompt only (R5). Helpers: the parent sets the native Agent
// `effort` per job (tool.describe addendum below); a child that can see
// set_effort may refine (R3).
//
// Failure means "the mod stops changing levels", never "requests fail": every
// own-code path is wrapped, and turn.step's .catch passes the step through on
// the replay-safe `next` (one request, never two).

export const LEVELS: readonly Level[] = ['low', 'medium', 'high', 'xhigh', 'max']

// The category names are code (the closed enum in types/index.d.ts); this order
// is the tool description's and the input schema's. Defaults and guidance per
// category are data: hooks/rubric.ts.
const CATEGORY_NAMES: Category[] = [
  'chat_or_question',
  'lookup_or_search',
  'trivial_edit',
  'contained_change',
  'multi_file_change',
  'unknown_root_cause',
  'review_or_plan',
  'strict_rules',
  'long_agentic',
  'architecture_security_data',
  'prior_attempt_failed',
]

export const CATEGORIES: Readonly<Record<Category, { level: Level; label: string; when: string }>> = RUBRIC.categories

export const TOOL_NAME = 'set_effort'
export const TOOL_FULL = 'mcp__effort-picker__set_effort'

export const TOOL_DESCRIPTION = [
  'Sets the effort level (how hard you think) for your next model requests in this loop, from the TASK, not the prompt.',
  'Call it once you understand the task (after reading any handoff, plan or file the prompt points to), in the SAME message as your next real tool calls, never as a step of its own. Skip it only when you answer without using any tool. Call it again only if the task category changes materially; never flip back and forth.',
  '',
  'Pick the category that fits; use its default level, or one step away when you have a concrete reason:',
  ...CATEGORY_NAMES.map(c => `- ${c} -> ${CATEGORIES[c].level}: ${CATEGORIES[c].when}`),
  '',
  'Rules:',
  '- `max` is allowed ONLY with category `prior_attempt_failed` ("on most workloads max adds significant cost for relatively small quality gains"); any other pairing is refused.',
  '- `xhigh` and `max` need the user\'s approval: the call asks them, and if they say no (or nobody can answer) you get `high`. Do not ask again in the same prompt after a no.',
  ...RUBRIC.rules.map(r => `- ${r}`),
].join('\n')

export const PROMPT_CONTEXT =
  'Effort: once you understand the task - after reading any handoff, plan or file the prompt points to - call ' +
  '`mcp__effort-picker__set_effort` in the same message as your next real tool calls, never as a step of its own. ' +
  'Skip it only when you answer without using any tool. Call it again only if the task\'s difficulty changes materially.'

export const AGENT_ADDENDUM =
  '\n\neffort-picker: set `effort` on every Agent call from the effort-picker rubric (the set_effort tool\'s categories) ' +
  'for the child\'s job (this is the explicit instruction that parameter requires). If the user named a level for this ' +
  'agent, pass theirs and begin `description` with `[effort-locked] `.'

// xhigh only with the user's approval (max sits above it, so it asks too).
// A dismissed dialog or a -p run (ui.ask rejects) counts as "no".
export const NEEDS_APPROVAL: readonly Level[] = ['xhigh', 'max']
export const DECLINED_LEVEL: Level = 'high'

async function userApproves($: EngineInterface, level: Level, why: string): Promise<boolean> {
  const allow = `Allow ${level}`
  try {
    const answer = await $.ui.ask(`Claude wants ${level} effort (${why}). Allow it?`, {
      options: [allow, `No, use ${DECLINED_LEVEL}`],
      header: 'Effort',
    })
    return answer === allow
  } catch {
    return false
  }
}

export const LOCK_MARK = '[effort-locked] '
export const KEEP_IT = 'The user set the effort for this prompt; keep it.'
const ULTRATHINK = /\bultrathink\b/i
const FRONTMATTER = /^�?---\r?\n([\s\S]*?)\r?\n---/
const EFFORT_KEY = /^effort\s*:/m

const LOOPS = { plugin: 'effort-picker', key: 'loops' } as const
const PENDING = { plugin: 'effort-picker', key: 'pendingManual' } as const
const LOCKED = { plugin: 'effort-picker', key: 'lockedSpawns' } as const
const SPAWNED = { plugin: 'effort-picker', key: 'spawned' } as const
const SHOWN = { plugin: 'effort-picker', key: 'lastShownMain' } as const
const DISABLED = { plugin: 'effort-picker', key: 'disabled' } as const
const FAILURES = { plugin: 'effort-picker', key: 'failures' } as const

const MAX_CONSECUTIVE_FAILURES = 2
const LOG_PART_BYTES = 3_000_000 // $.fs.read refuses files over 4 MiB

export const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
export const isCategory = (v: unknown): v is Category =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(CATEGORIES, v)

// ---- rubric validation (phase 2 reuses it for a downloaded copy) ----

const RUBRIC_TEXT_MAX = 300
const RUBRIC_LIST_MAX = 10
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const RUBRIC_VERSION = /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A non-empty single-line string under the cap, without the lock marker. The
 * marker check is defense in depth only: a paraphrase gets past it.
 */
function rubricText(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '' || v.length > RUBRIC_TEXT_MAX || CONTROL_CHARS.test(v)) return null
  if (v.includes(LOCK_MARK) || v.toLowerCase().includes('effort-locked')) return null
  return v
}

function rubricTexts(v: unknown, minLength: number): string[] | null {
  if (!Array.isArray(v) || v.length < minLength || v.length > RUBRIC_LIST_MAX) return null
  const out: string[] = []
  for (const item of v) {
    const s = rubricText(item)
    if (s === null) return null
    out.push(s)
  }
  return out
}

function isoDay(v: unknown): string | null {
  if (typeof v !== 'string' || !ISO_DAY.test(v)) return null
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null
}

/**
 * The rubric as a fresh copy of its known fields, or null when malformed:
 * exactly the 11 category names, each level in LEVELS, `max` on
 * prior_attempt_failed and nowhere else, capped single-line strings.
 */
export function validateRubric(x: unknown): Rubric | null {
  try {
    if (!isRecord(x) || x.schema !== 1) return null
    const version = rubricText(x.version)
    const checkedAt = isoDay(x.checkedAt)
    const source = rubricText(x.source)
    const checkedModels = rubricTexts(x.checkedModels, 1)
    const rules = rubricTexts(x.rules, 0)
    if (version === null || !RUBRIC_VERSION.test(version) || checkedAt === null) return null
    if (source === null || !source.startsWith('https://') || checkedModels === null || rules === null) return null
    if (!isRecord(x.categories)) return null
    const given = Object.keys(x.categories)
    if (given.length !== CATEGORY_NAMES.length || !given.every(k => (CATEGORY_NAMES as string[]).includes(k))) return null
    const categories = {} as Record<Category, { level: Level; label: string; when: string }>
    for (const name of CATEGORY_NAMES) {
      const c = x.categories[name]
      if (!isRecord(c) || !isLevel(c.level) || (c.level === 'max') !== (name === 'prior_attempt_failed')) return null
      const label = rubricText(c.label)
      const when = rubricText(c.when)
      if (label === null || when === null) return null
      categories[name] = { level: c.level, label, when }
    }
    return { schema: 1, version, checkedAt, source, checkedModels, categories, rules }
  } catch {
    return null
  }
}

// A built-in rubric that fails validation leaves the mod inert, like any other failure.
let rubricOk = false

export function footerLine(level: Level | number, was: Level | number, category: Category | null): string {
  const why = category === null ? '' : ` - ${CATEGORIES[category].label}`
  return `Effort: ${level} (was ${was})${why}`
}

/** True when a SKILL.md / command file's frontmatter declares `effort:`. */
export function declaresEffort(text: string): boolean {
  const m = FRONTMATTER.exec(text)
  return m !== null && EFFORT_KEY.test(m[1] ?? '')
}

const fresh = (turnId: string, manual: Manual = false): LoopState => ({
  turnId,
  manual,
  desired: null,
  applied: null,
  appliedUnknown: false,
  lastIncoming: null,
})

// ---- session-level facts (reset on reload; session.start fires again) ----

let inert = false
let baseline: Level = 'high'
let sessionId = ''
let projectSlug = ''
let home = ''
let logDay = ''

// ---- log: enums, ids and counts only (§3.7); one file per session ----

type LogRow = {
  ts: number
  sessionId: string
  projectSlug: string
  turnId: string
  loop: 'main' | 'sub'
  step: number | null
  desired: Level | null
  applied: Level | number | null
  category: Category | null
  manual: Manual
  event: string
  model?: string // model_unchecked rows only
}

let pendingRows: string[] = []
let flushing: Promise<void> = Promise.resolve()

async function log(
  $: EngineInterface,
  k: string,
  row: Partial<Omit<LogRow, 'ts' | 'sessionId' | 'projectSlug' | 'loop'>> & { event: string },
): Promise<void> {
  try {
    const full: LogRow = {
      ts: await $.clock.now(),
      sessionId,
      projectSlug,
      turnId: row.turnId ?? '',
      loop: k === 'main' ? 'main' : 'sub',
      step: row.step ?? null,
      desired: row.desired ?? null,
      applied: row.applied ?? null,
      category: row.category ?? null,
      manual: row.manual ?? false,
      event: row.event,
      ...(row.model !== undefined ? { model: row.model } : {}),
    }
    pendingRows.push(JSON.stringify(full))
  } catch {
    // logging never breaks the turn
  }
}

function flush($: EngineInterface): Promise<void> {
  flushing = flushing.then(async () => {
    if (pendingRows.length === 0 || home === '' || sessionId === '') return
    const rows = pendingRows
    pendingRows = []
    try {
      const dir = `${home}/.claude/effort-picker/logs`
      let part = 0
      let path = `${dir}/${logDay}_${sessionId.slice(0, 8)}.jsonl`
      while ((await $.fs.exists(path)) && (await $.fs.stat(path)).size > LOG_PART_BYTES) {
        part += 1
        path = `${dir}/${logDay}_${sessionId.slice(0, 8)}_p${part}.jsonl`
      }
      const before = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
      await $.fs.write(path, before + rows.join('\n') + '\n')
    } catch {
      // a lost log batch is acceptable; the turn is not
    }
  })
  return flushing
}

// ---- state helpers ----

async function readLoops($: EngineInterface): Promise<Record<string, LoopState>> {
  return (await $.state.get(LOOPS)).value ?? {}
}

async function patchLoop(
  $: EngineInterface,
  k: string,
  change: (loop: LoopState | undefined) => LoopState | undefined,
): Promise<void> {
  await update($, LOOPS, loops => {
    const next = { ...(loops ?? {}) }
    const changed = change(next[k])
    if (changed === undefined) delete next[k]
    else next[k] = changed
    return next
  })
}

// ---- skill candidate rule (§3.4) ----

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

async function listDirs($: EngineInterface, path: string): Promise<string[]> {
  try {
    return (await $.fs.list(path)).filter(e => e.kind === 'dir').map(e => e.name)
  } catch {
    return []
  }
}

/**
 * Every file that could be the skill or command `name`. No API names the file
 * the engine picked, so all candidates are read and any `effort:` wins.
 */
async function candidateFiles($: EngineInterface, name: string, pluginHint?: string): Promise<string[]> {
  const colon = name.indexOf(':')
  const plugin = colon >= 0 ? name.slice(0, colon) : pluginHint
  const skill = colon >= 0 ? name.slice(colon + 1) : name
  const paths: string[] = []
  let root = ''
  try {
    root = await $.session.root()
  } catch {
    root = ''
  }
  if (colon < 0) {
    if (root !== '') {
      paths.push(`${root}/.claude/skills/${skill}/SKILL.md`, `${root}/.claude/commands/${skill}.md`)
    }
    if (home !== '') {
      paths.push(`${home}/.claude/skills/${skill}/SKILL.md`, `${home}/.claude/commands/${skill}.md`)
    }
  }
  if (plugin !== undefined && home !== '') {
    const cache = `${home}/.claude/plugins/cache`
    for (const marketplace of await listDirs($, cache)) {
      const pluginDir = `${cache}/${marketplace}/${plugin}`
      for (const version of await listDirs($, pluginDir)) {
        paths.push(`${pluginDir}/${version}/skills/${skill}/SKILL.md`, `${pluginDir}/${version}/commands/${skill}.md`)
      }
    }
  }
  const dirs = (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS').catch(() => undefined)) ?? ''
  for (const raw of dirs.split(';')) {
    const dir = raw.trim().replace(/^~(?=[\\/]|$)/, home)
    if (dir !== '') paths.push(`${dir}/skills/${skill}/SKILL.md`, `${dir}/commands/${skill}.md`)
  }
  const found: string[] = []
  for (const p of paths) if (await exists($, p)) found.push(p)
  return found
}

/**
 * Manual unless every candidate file was found, read, and declares no
 * `effort:`. Absence of evidence never counts as "no override" (§3.4).
 */
export async function skillIsManual($: EngineInterface, name: string, pluginHint?: string): Promise<boolean> {
  const files = await candidateFiles($, name, pluginHint)
  if (files.length === 0) return true
  for (const f of files) {
    try {
      if (declaresEffort(await $.fs.read(f))) return true
    } catch {
      return true
    }
  }
  return false
}

// ---- stale-rubric notice ----

const STALE_DAY_KEY = 'staleNoticeDay'
const STALE_DAYS_DEFAULT = 90
const DAY_MS = 86_400_000
let staleDays = STALE_DAYS_DEFAULT
let staleShown = false
let staleQuietDay = '' // another session showed it on this UTC day: recheck on the next

/**
 * One toast once the rubric's `checkedAt` is more than `staleDays` whole (UTC)
 * days old. At most once per session; once per day per machine through
 * `$.store`, which a probe (18/10/2026) showed is shared live across sessions
 * but has no compare-and-set, so sessions starting at the same moment can each
 * show it. A notice, not a gate. Fresh rubric: one clock read, no store I/O.
 */
async function staleNotice($: EngineInterface, turnId?: string): Promise<void> {
  if (inert || staleShown || staleDays === 0) return
  const today = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${RUBRIC.checkedAt}T00:00:00Z`)) / DAY_MS)
  if (!(age > staleDays) || today === staleQuietDay) return
  let claimed: unknown
  try {
    claimed = await $.store.get(STALE_DAY_KEY)
  } catch {
    claimed = undefined // unreadable counts as "not shown today"
  }
  if (claimed === today) {
    staleQuietDay = today
    return
  }
  staleShown = true
  try {
    await $.store.set(STALE_DAY_KEY, today)
  } catch {
    // a lost claim only risks a second notice today
  }
  $.ui.toast(`effort-picker: effort rules last checked ${RUBRIC.checkedAt} — check for a plugin update.`)
  await log($, 'main', { turnId, event: 'stale_notice' })
}

// ---- model-coverage notice ----

let warnedModels = new Set<string>()

/**
 * The bare Claude model id (`claude-opus-5-5`) from what a request carries:
 * context markers (`[1m]`), provider prefixes (`us.anthropic.`), version and
 * date suffixes (`-v1:0`, `@20260101`, `-20251001`) removed. Null for an id
 * with no `claude-` in it (gateway alias, test model): coverage unknowable.
 */
export function normaliseModel(id: unknown): string | null {
  if (typeof id !== 'string') return null
  const m = /claude-[a-z0-9-]*/.exec(id.toLowerCase().replace(/\[[^\]]*\]/g, ''))
  if (m === null) return null
  let bare = m[0].replace(/-+$/, '')
  for (let prev = ''; prev !== bare; ) {
    prev = bare
    bare = bare.replace(/-v\d+$/, '').replace(/-\d{8}$/, '')
  }
  return bare === 'claude' ? null : bare
}

/**
 * One toast per model per session when a request runs on a Claude model the
 * rubric was not checked against. Same switch as the stale notice
 * (`staleDays: 0` turns both off). Synchronous up to the toast; the log row is
 * fire-and-forget, so the step is never delayed.
 */
function modelNotice($: EngineInterface, k: string, turnId: string, step: number, model: unknown): void {
  if (inert || staleDays === 0) return
  const bare = normaliseModel(model)
  if (bare === null || warnedModels.has(bare)) return
  if (RUBRIC.checkedModels.some(m => normaliseModel(m) === bare)) return
  warnedModels.add(bare)
  try {
    $.ui.toast(`effort-picker: effort rules were not checked for ${bare} — check for a plugin update.`)
  } catch {
    // a lost toast is a lost notice, never a failed step
  }
  void log($, k, { turnId, step, event: 'model_unchecked', model: bare }).catch(() => undefined)
}

// ---- the hooks ----

export const register: Register = (on, options) => {
  baseline = isLevel(options?.baseline) && options.baseline !== 'max' ? options.baseline : 'high'
  const days = options?.staleDays
  staleDays = typeof days === 'number' && Number.isFinite(days) && days >= 0 ? days : STALE_DAYS_DEFAULT
  rubricOk = validateRubric(RUBRIC) !== null

  on('session.start', async ($, e, next) => {
    staleShown = false
    staleQuietDay = ''
    warnedModels = new Set()
    try {
      if (!rubricOk) $.ui.log('effort-picker: built-in rubric failed validation, not changing levels', { to: 'debug' })
      inert = !rubricOk || (await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')) !== undefined
      home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
      sessionId = await $.session.id()
      const root = await $.session.root().catch(() => e.cwd)
      projectSlug = root.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '')
      logDay = new Date(await $.clock.now()).toISOString().slice(0, 10)
      if (!inert) {
        await $.tool.register({
          name: TOOL_NAME,
          description: TOOL_DESCRIPTION,
          isDeferred: false,
          inputSchema: {
            type: 'object',
            properties: {
              level: { type: 'string', enum: [...LEVELS] },
              category: { type: 'string', enum: CATEGORY_NAMES },
            },
            required: ['level', 'category'],
            additionalProperties: false,
          },
        })
      }
    } catch (error) {
      $.ui.log(`effort-picker: session start failed, staying at today's behaviour: ${String(error)}`, { to: 'debug' })
    }
    await staleNotice($).catch(() => undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flush($)
    return next(e)
  })

  // One fixed, byte-identical string per prompt: it never varies the cached prefix.
  on('prompt.submit', async ($, e, next) => {
    if (inert) return next(e)
    return next({ ...e, context: [...(e.context ?? []), PROMPT_CONTEXT] })
  })

  // Manual signals typed as slash commands: consumed by the next main turn.start.
  on('command.run', async ($, e, next) => {
    if (!inert) {
      try {
        let kind: false | 'effort-command' | 'skill' = false
        if (e.command === 'effort') kind = 'effort-command'
        else {
          const commands: CommandInfo[] = await $.command.list().catch(() => [])
          const info = commands.find(c => c.name === e.command)
          if (info === undefined || info.source === 'builtin') kind = 'skill' // unresolvable: err toward manual
          else if (info.source !== 'mcp' && (await skillIsManual($, e.command, info.plugin))) kind = 'skill'
        }
        if (kind !== false) {
          await $.state.set(PENDING, kind)
          await log($, 'main', { event: 'pending-manual', manual: kind })
        }
      } catch {
        // detection failure: leave the next turn automatic
      }
    }
    return next(e)
  })

  // Main only. The types say a subagent's run raises no turn.start, but 2.1.296
  // raises one carrying `agentId` (G2 capture 14/10/2026): treating it as a new
  // main turn wiped the main loop mid-turn.
  on('turn.start', async ($, e, next) => {
    if (!inert && (e as { agentId?: string }).agentId === undefined) {
      try {
        const pending = (await $.state.get(PENDING)).value ?? false
        if (pending !== false) await $.state.set(PENDING, false)
        const manual: Manual = pending !== false ? pending : ULTRATHINK.test(e.text) ? 'ultrathink' : false
        await patchLoop($, 'main', () => fresh(e.turnId, manual))
        if (manual !== false) await log($, 'main', { turnId: e.turnId, event: 'manual', manual })
      } catch {
        // untracked turn: turn.step passes it through
      }
      // Every main turn, so a session open across the threshold still sees it.
      await staleNotice($, e.turnId).catch(() => undefined)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (inert || e.effort === undefined) return yield* next(e)
    const k = e.agentId ?? 'main'
    try {
      modelNotice($, k, e.turnId, e.index, e.model)
    } catch {
      // the notice never touches the step
    }

    // Decide what to send. Own-code failures fall back to passing the step through.
    let send: Level | number = e.effort
    let rewrite = false
    let loopForLog: LoopState | null = null
    try {
      const loops = await readLoops($)
      let loop = loops[k]
      if (k === 'main') {
        // Not this turn's (a fork, a turn that began before the mod loaded): untouched.
        if (loop === undefined || loop.turnId !== e.turnId) return yield* next(e)
      } else {
        if (loop === undefined || loop.turnId !== e.turnId) loop = fresh(e.turnId)
        const spawned = (await $.state.get(SPAWNED)).value ?? {}
        if (spawned[k]?.locked === true) loop = { ...loop, manual: 'agent-request' }
      }
      // Extra skill detector: the engine's own value moved mid-loop with no explicit signal.
      if (loop.manual === false && loop.lastIncoming !== null && loop.lastIncoming !== e.effort) {
        const pending = (await $.state.get(PENDING)).value ?? false
        loop = { ...loop, manual: pending === 'effort-command' ? 'effort-command' : 'skill' }
        await log($, k, { turnId: e.turnId, step: e.index, event: 'unexplained-effort-change', manual: loop.manual })
      }
      const disabled = (await $.state.get(DISABLED)).value ?? null
      if (disabled === null && loop.manual === false) {
        const target = loop.desired?.level ?? (k === 'main' ? baseline : undefined)
        if (target !== undefined) {
          send = target
          rewrite = true
        }
      }
      const settled = loop
      await patchLoop($, k, current => ({
        ...(current !== undefined && current.turnId === settled.turnId ? current : settled),
        turnId: settled.turnId,
        manual: settled.manual,
        lastIncoming: e.effort ?? null,
      }))
      loopForLog = settled
    } catch {
      send = e.effort
      rewrite = false
    }

    // Exactly one `next` per hook run; chunks are delegated untouched.
    let r
    try {
      r = yield* next(rewrite ? { ...e, effort: send } : e)
    } catch (error) {
      // Failed beneath (refused rewrite, API error): the sent value is unknown.
      try {
        await patchLoop($, k, current => (current === undefined ? current : { ...current, applied: null, appliedUnknown: true }))
        if (rewrite) {
          const failures = await update($, FAILURES, n => (n ?? 0) + 1)
          if (failures >= MAX_CONSECUTIVE_FAILURES) await $.state.set(DISABLED, 'rewritten-steps-failed')
        }
        await log($, k, { turnId: e.turnId, step: e.index, event: rewrite ? 'rewrite-failed' : 'step-failed' })
      } catch {
        // nothing more to record
      }
      throw error
    }

    // Accounting: only a request that came back counts as applied.
    try {
      const known = r.stopReason !== null
      await patchLoop($, k, current =>
        current === undefined
          ? current
          : known
            ? { ...current, applied: { level: send, step: e.index } }
            : { ...current, applied: null, appliedUnknown: true },
      )
      if (rewrite && known) await $.state.set(FAILURES, 0)
      await log($, k, {
        turnId: e.turnId,
        step: e.index,
        event: known ? 'step' : 'step-unknown',
        desired: loopForLog?.desired?.level ?? null,
        category: loopForLog?.desired?.category ?? null,
        applied: known ? send : null,
        manual: loopForLog?.manual ?? false,
      })
    } catch {
      // accounting failure never touches the response
    }
    return r
  })
  // No .catch on turn.step: its replay-safe `next` re-ran a request that had
  // failed beneath (two requests, measured in the 2.1.296 kit). The engine's
  // default already fits: a hook failing before `next` is skipped (the step
  // goes out unchanged), one failing after keeps that single run.

  // Model-invoked skill (plan 3.4 row 4): candidate rule; manual for this loop
  // from this call to the end of its turn.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (!inert) {
      try {
        const k = e.agentId ?? 'main'
        const name = String(e.skill ?? '')
        const commands: CommandInfo[] = await $.command.list().catch(() => [])
        const info = commands.find(c => c.name === name)
        const manual =
          info?.source === 'builtin' || info?.source === 'mcp'
            ? info.source === 'builtin'
            : await skillIsManual($, name, info?.plugin)
        if (manual) {
          await patchLoop($, k, current => (current === undefined ? current : { ...current, manual: 'skill' }))
          await log($, k, { event: 'manual', manual: 'skill' })
        }
      } catch {
        // detection failure: the loop stays as it was
      }
    }
    return next(e)
  })

  // The model's own choice. A pure state write: no permission dialog.
  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    const input = e as unknown as { level?: unknown; category?: unknown; agentId?: string }
    const { level, category } = input
    if (!isLevel(level) || !isCategory(category)) {
      return { deny: `level must be one of ${LEVELS.join(', ')}; category one of ${CATEGORY_NAMES.join(', ')}.` }
    }
    if (level === 'max' && category !== 'prior_attempt_failed') {
      return { deny: 'max is allowed only with category prior_attempt_failed (xhigh already failed on this problem).' }
    }
    const k = input.agentId ?? 'main'
    // After repeated request failures turn.step stops rewriting: say so, never ask or promise a level.
    if (((await $.state.get(DISABLED)).value ?? null) !== null) {
      await log($, k, { event: 'set-refused-disabled', desired: level, category })
      return { result: 'Not applied: effort-picker stopped changing levels in this session after repeated request failures. Keep working.' }
    }
    const loops = await readLoops($)
    const loop = loops[k]
    const spawned = (await $.state.get(SPAWNED)).value ?? {}
    const lockedPending = ((await $.state.get(LOCKED)).value ?? []).length > 0
    const keep =
      loop?.manual !== undefined && loop.manual !== false
        ? true
        : spawned[k]?.locked === true
          ? true
          : k !== 'main' && spawned[k] === undefined && lockedPending // fail toward manual
    if (keep) {
      await log($, k, { turnId: loop?.turnId, event: 'set-refused-manual', desired: level, category })
      return { result: KEEP_IT }
    }
    if (loop === undefined) {
      await log($, k, { event: 'set-untracked', desired: level, category })
      return { result: 'Not applied: this turn started before effort-picker loaded. Keep working.' }
    }
    if (NEEDS_APPROVAL.includes(level) && !(await userApproves($, level, CATEGORIES[category].label))) {
      await patchLoop($, k, current =>
        current === undefined ? current : { ...current, desired: { level: DECLINED_LEVEL, category } },
      )
      await log($, k, { turnId: loop.turnId, event: 'set-declined', desired: DECLINED_LEVEL, category })
      return {
        result: `The user did not approve ${level}. Effort ${DECLINED_LEVEL} requested from your next request; do not ask for ${level} again this prompt.`,
      }
    }
    await patchLoop($, k, current => (current === undefined ? current : { ...current, desired: { level, category } }))
    await log($, k, { turnId: loop.turnId, event: 'set', desired: level, category })
    return { result: `Effort ${level} requested from your next request.` }
  })

  // Helpers: the parent picks each child's level per job via the native `effort` param.
  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const r = await next(e)
    if (inert || r.description.includes('effort-picker:')) return r
    return { ...r, description: r.description + AGENT_ADDENDUM }
  })

  // User-named child levels are enforced: the marker locks that spawn. An
  // unlocked helper asked to run at xhigh/max needs the user's approval, like set_effort.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (inert) return next(e)
    if (!e.description.startsWith(LOCK_MARK)) {
      const level = e.effort
      if (isLevel(level) && NEEDS_APPROVAL.includes(level) && !(await userApproves($, level, `helper: ${e.description}`))) {
        await log($, e.agentId ?? 'main', { event: 'agent-declined', desired: DECLINED_LEVEL })
        return next({ ...e, effort: DECLINED_LEVEL })
      }
      return next(e)
    }
    const id = e.tool_use_id
    await update($, LOCKED, ids => [...(ids ?? []), id])
    try {
      return await next({ ...e, description: e.description.slice(LOCK_MARK.length) })
    } finally {
      await update($, LOCKED, ids => (ids ?? []).filter(x => x !== id)).catch(() => undefined)
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (inert || r.deny !== undefined || r.agentId === undefined) return r
    try {
      const locked = ((await $.state.get(LOCKED)).value ?? []).includes(e.tool_use_id)
      const agentId = r.agentId
      await update($, SPAWNED, s => ({ ...(s ?? {}), [agentId]: { locked } }))
      if (locked) await log($, agentId, { event: 'spawn-locked', manual: 'agent-request' })
    } catch {
      // an unrecorded spawn is an unlocked one
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (inert) return r
    try {
      if (e.agentId !== undefined) {
        const agentId = e.agentId
        const loop = (await readLoops($))[agentId]
        await patchLoop($, agentId, () => undefined)
        await update($, SPAWNED, s => {
          const rest = { ...(s ?? {}) }
          delete rest[agentId]
          return rest
        })
        await log($, agentId, {
          turnId: e.turnId,
          event: 'sub-complete',
          applied: loop?.applied?.level ?? null,
          manual: loop?.manual ?? false,
        })
        return r
      }
      if (e.reason !== 'answer') return r
      const loop = (await readLoops($)).main
      if (loop === undefined || loop.turnId !== e.turnId || loop.appliedUnknown || loop.applied === null) {
        await $.state.set(SHOWN, null)
        return r
      }
      const level = loop.applied.level
      // Never set this session: compare against the baseline every turn starts at.
      // The null written after an unknown turn still suppresses the line.
      const stored = (await $.state.get(SHOWN)).value
      const was = stored === undefined ? baseline : stored
      await $.state.set(SHOWN, level)
      await log($, 'main', {
        turnId: e.turnId,
        event: 'turn-complete',
        applied: level,
        desired: loop.desired?.level ?? null,
        category: loop.desired?.category ?? null,
        manual: loop.manual,
      })
      if (was === null || was === level || loop.manual !== false) return r
      const line = footerLine(level, was, loop.desired?.category ?? null)
      return { ...r, text: r.text === e.answer ? line : `${r.text}\n\n${line}` }
    } catch {
      return r
    } finally {
      if (e.agentId === undefined) void flush($)
    }
  })
}

/**
 * Test seam: `register`, judged against another rubric. The test kit can't
 * swap a module, so this is how the "invalid built-in -> inert" contract is
 * exercised. Only the inert decision follows `rubric`; the description and
 * categories stay the built-in ones.
 */
export const registerWithRubric =
  (rubric: unknown): Register =>
  (on, options) => {
    register(on, options)
    rubricOk = validateRubric(rubric) !== null
  }
