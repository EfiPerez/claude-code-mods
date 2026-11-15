import type { EngineInterface, Register } from 'claude-code'

// Runs the bundled lib/monitor.js on an in-process timer. monitor.js decides (thresholds,
// idle rules, self-tuning, state file, log); this mod only runs it and acts on its advice.
// Why a mod and not a /loop: a /loop only starts when something asks Claude to start it,
// resolves the project from the shell's cwd (a `cd` misdirects it), and cannot wake while
// a turn is held open on a question. A timer here starts with the session, uses the session
// root, and runs between and during turns. Checks cost no tokens; the keep-alive is a
// $.model.fork over the cached conversation, which adds nothing to the transcript.

const TICK_MS = 60_000
const RETRY_MIN = 5 // no session data yet (before the first response), or monitor.js failed

let home = ''
let configDir = '' // CLAUDE_CONFIG_DIR, else ~/.claude
let root = ''
let sessionId = ''
let slug = ''
let nextDueAt = 0
let busy = false
let paused = false   // after an idle handoff, until the user sends a prompt
let armed = false    // monitor.js state says loopRunning for this session
let turnRunning = false
let inPanel = false
let handoffTurnId = ''
let currentTurnId = '' // the main loop's running turn, from turn.start
const ttlToasted = new Set<string>() // sessions already told they run on the 5-minute cache (A -> B -> A stays one)
// When this session's last keep-alive fork was answered. The fork re-warms the cache but never
// lands in the transcript, so monitor.js still reports the cache as expired an hour after the
// user's last turn; without this the idle handoff was blocked right after a keep-alive.
let lastKeepaliveAt = 0
let generation = 0 // bumped on every session change; a check started earlier is discarded
const KEEPALIVE_WARM_MS = 55 * 60_000 // 1-hour TTL minus a margin
// Re-fork during background work once the last keep-alive is this old: with 5-min rechecks
// the fork lands 45-50 min after the previous one, inside KEEPALIVE_WARM_MS.
const BG_KEEPALIVE_EVERY_MS = 45 * 60_000

// Between turns Claude can still be working: it waits on background agents or shells, and
// their completion notices wake the chat. The transcript is quiet meanwhile, so monitor.js
// reads it as idle and would spend a keep-alive and fire handoff-idle mid-build.
// Background shells of the main loop: task id -> its tool_use_id and start. Their notice
// names both ids. Not turnRunning: a turn held open on a question to the user must still go idle.
const shells = new Map<string, { use: string; ts: number }>()
const SHELL_STALE_MS = 3 * 60 * 60_000 // a lost completion notice must not block idle forever
// A finished shell whose notice cannot arrive (it waits behind an open question dialog) would
// count as running for hours and block the idle handoff. The harness ends the shell's output
// file, <TEMP>/claude/<hash>/<session>/tasks/<task>.output, with "[exited with code N]".
// Undocumented, so SHELL_STALE_MS stays as the fallback.
const EXITED_RE = /\[exited with code -?\d+\]\s*$/
const OUTPUT_MAX_BYTES = 4 * 1024 * 1024 // $.fs.read rejects past 4 MiB
let tasksDir = '' // this session's tasks folder once found; '' = not found yet
async function shellExited($: EngineInterface, task: string): Promise<boolean> {
  try {
    if (!tasksDir) {
      const base = localDir(await $.env.get('TEMP'))
      if (!base || !sessionId) return false
      for (const d of await $.fs.list(`${base}/claude`)) {
        if (d.kind !== 'dir') continue
        const dir = `${base}/claude/${d.name}/${sessionId}/tasks`
        if (await $.fs.exists(`${dir}/${task}.output`)) { tasksDir = dir; break }
      }
      if (!tasksDir) return false
    }
    const file = `${tasksDir}/${task}.output`
    if (!(await $.fs.exists(file)) || (await $.fs.stat(file)).size > OUTPUT_MAX_BYTES) return false
    return EXITED_RE.test(String(await $.fs.read(file)))
  } catch { return false }
}
async function backgroundWork($: EngineInterface): Promise<string> {
  try {
    const agents = await $.agent.list()
    if (agents.some(a => !a.parentId && ['pending', 'running', 'waiting'].includes(a.status))) return 'background agent running'
  } catch { /* no agent list: fall through to shells */ }
  const now = await $.clock.now()
  for (const [task, info] of [...shells]) {
    if (now - info.ts > SHELL_STALE_MS || (await shellExited($, task))) shells.delete(task)
  }
  return shells.size ? 'background shell running' : ''
}
// Ids read whole from the notice's own tags: a substring test would let "review-task-extended"
// also end "review-task".
function shellNotice(text: string) {
  const ids = new Set([...text.matchAll(/<(?:task-id|tool-use-id)>([^<]+)<\/(?:task-id|tool-use-id)>/g)].map(m => m[1]!.trim()))
  for (const [task, info] of shells) if (ids.has(task) || ids.has(info.use)) shells.delete(task)
}

// Push notifications do not reach the VS Code panel, so there the mod raises its own notice
// once the handoff turn ends. A sound mod that listens for `ui.notify` can play a chime on it.
const HANDOFF_TAG = '[cache-monitor]'
async function playSound($: EngineInterface) {
  try {
    await $.ui.notify('The handoff turn has finished. /resume-handoff picks it up in a new session.', { title: 'cache-monitor' })
  } catch { /* a missed notice must not break the monitor */ }
}

// One context handoff per session, remembered here rather than only in monitor.js: its state
// file is per project, and another chat in the same project can reset it on its first record,
// which once fired a second handoff hours later onto an expired cache. $.store is keyed per
// session id.
const SENT_PREFIX = 'contextHandoffSent:'
const SENT_TTL_MS = 7 * 24 * 60 * 60_000
async function contextHandoffSent($: EngineInterface, sid = sessionId) {
  try { return (await $.store.get(SENT_PREFIX + sid)) != null } catch { return false }
}
async function markContextHandoffSent($: EngineInterface, sid = sessionId) {
  try { await $.store.set(SENT_PREFIX + sid, await $.clock.now()) } catch { /* best effort */ }
}
async function pruneSent($: EngineInterface) {
  try {
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(SENT_PREFIX)) continue
      const at = await $.store.get(key)
      if (typeof at !== 'number' || now - at > SENT_TTL_MS) await $.store.delete(key)
    }
  } catch { /* housekeeping only */ }
}

// monitor.js ships inside this mod; its state and log files go to <configDir>/cache-timer/.
const monitorPath = ($: EngineInterface) => `${$.plugin.root.replace(/\\/g, '/')}/lib/monitor.js`

// Keep Windows out of Modern Standby while this chat still has something to protect: a sleeping
// PC freezes the 60 s timer, the cache expires unseen, and on wake the cold-cache rule skips the
// keep-alive. lib/keep-awake.ps1 holds ES_SYSTEM_REQUIRED only (the screen still turns off and
// locks) and lets go on battery below 30%. Held while the monitor is armed and on and the idle
// handoff has not fired yet (it sets `paused`), idle chats included, and the person typed
// within the last AWAKE_CAP_MS: holding only during turns let the PC sleep, and the idle
// handoff was then written on wake onto a cold cache. $.process.spawn ties the helper to the read loop: leaving it, or
// the module unloading, kills the helper, so a crashed chat cannot keep the PC awake.
// Windows only; on other systems this does nothing.
const keepAwakePath = ($: EngineInterface) => `${$.plugin.root.replace(/\\/g, '/')}/lib/keep-awake.ps1`
// Windows: child processes start by full path and in the mod's own folder. A bare name is
// looked up in the working directory first, which defaults to the chat's project: a
// powershell.exe or node.exe planted in a cloned repo would run instead. Env values can come
// from a project's settings, so only a plain local-drive path is accepted; anything else
// fails closed (no keep-awake helper; node falls back to its bare name in the mod's folder).
let systemRoot = '' // set at session start; '' = no trusted Windows folder, so no helper
let nodeExe = 'node' // Windows: node.exe from the first absolute PATH folder holding one
const powershellPath = () => `${systemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe`
const trustedCwd = ($: EngineInterface) => $.plugin.root.replace(/\\/g, '/')
// A local drive path (X:/...), forward slashes, no '..' segment, no UNC; else ''. Not
// trimmed: a value with a leading space is not a drive path, so it fails closed. A drive
// root (X:/) comes back as X: so callers can append '/...'; a bare X: (drive-relative) fails.
function localDir(value: string | undefined): string {
  const raw = (value ?? '').replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(raw) && !raw.split('/').includes('..') ? raw.replace(/\/+$/, '') : ''
}
async function resolveNode($: EngineInterface): Promise<string> {
  // PATH only when Path is unset: an empty Path is a value, not a reason to look elsewhere.
  const path = (await $.env.get('Path')) ?? (await $.env.get('PATH')) ?? ''
  for (const entry of path.split(';')) {
    const dir = localDir(entry)
    try { if (dir && (await $.fs.exists(`${dir}/node.exe`))) return `${dir}/node.exe` } catch { /* next */ }
  }
  return 'node' // not found: the bare name, still run from the mod's folder
}
const AWAKE_CAP_MS = 135 * 60_000 // past the ~2 h idle handoff, with margin
const AWAKE_RETRY_MS = 10 * 60_000 // after a helper that would not start or died at once
let isWindows = false
let lastPersonAt = 0 // the person's last own prompt in this session (session start until then)
let wantAwake = false
let awakeRun = 0 // the live helper loop's id; 0 = none
let awakeSeq = 0
let awakeFailedAt = 0
// A `record stop` (e.g. from a handoff skill) ends keep-awake until the person's next own
// prompt, even though the next check records `start` again and re-arms the monitor itself:
// the handoff is written, so there is nothing left to stay awake for.
let stoppedSincePerson = false
async function shouldStayAwake($: EngineInterface): Promise<boolean> {
  if (!isWindows || !systemRoot || !sessionId || paused || !armed || stoppedSincePerson) return false
  if ((await $.clock.now()) - lastPersonAt >= AWAKE_CAP_MS) return false
  return !(await isOff($))
}
async function syncAwake($: EngineInterface) {
  try { wantAwake = await shouldStayAwake($) } catch { wantAwake = false }
  if (!wantAwake || awakeRun) return
  const now = await $.clock.now()
  if (awakeFailedAt && now - awakeFailedAt < AWAKE_RETRY_MS) return
  const run = ++awakeSeq
  awakeRun = run
  const startedAt = now
  void (async () => {
    let lines = 0
    try {
      const helper = $.process.spawn({ argv: [powershellPath(), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', keepAwakePath($)], cwd: trustedCwd($) })
      for await (const piece of helper) {
        if ('text' in piece && piece.stream === 'stdout') lines++
        if (!wantAwake || awakeRun !== run) break // leaving the loop kills the helper
      }
    } catch { /* could not start: retried after AWAKE_RETRY_MS */ }
    finally {
      if (awakeRun === run) {
        awakeRun = 0
        // Ended on its own while still wanted: missing script, blocked PowerShell, or its cap.
        // Guarded: after the module unloads $ refuses every call, and that must not escape.
        try {
          if (wantAwake && (lines === 0 || (await $.clock.now()) - startedAt < 60_000)) awakeFailedAt = await $.clock.now()
        } catch { /* module gone: nothing left to schedule */ }
      }
    }
  })()
}
// Off for this session only: one file per session, holding that session's id while it is off,
// so a second chat in the same project turning itself off cannot clear the first one's switch.
const offMarker = () => `${configDir}/cache-timer/${slug}.${sessionId}.off`
async function isOff($: EngineInterface) {
  if (!slug || !(await $.fs.exists(offMarker()))) return false
  return String(await $.fs.read(offMarker())).trim() === sessionId
}

async function monitor($: EngineInterface, args: string[], sid = sessionId) {
  return $.process.run([nodeExe, monitorPath($), ...args, '--project', root], {
    cwd: trustedCwd($),
    env: { CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CONFIG_DIR: configDir },
    timeoutMs: 20_000,
  })
}

// sid/gen: the session a check started in. The record always goes to that session, and its
// result touches `armed` only if no session switch happened meanwhile.
async function record($: EngineInterface, action: string, note?: string, sid = sessionId, gen = generation) {
  const r = await monitor($, ['record', '--action', action, ...(note ? ['--note', note] : [])], sid)
  if (r.exitCode === 0 && gen === generation) armed = action !== 'stop' && action !== 'handoff-idle'
  return r.exitCode === 0
}

// Submits a handoff prompt; true only when it entered the session (or was queued). A dropped or
// rejected prompt must not latch "handoff sent", or the handoff is lost for good.
let lastDrop = ''
async function submitHandoff($: EngineInterface, why: string, gen: number): Promise<boolean> {
  if (gen !== generation) { lastDrop = 'session changed during the check'; return false }
  try {
    const r = await $.prompt.submit({ text: HANDOFF(why) })
    if (r && typeof r.drop === 'string') { lastDrop = r.drop; return false }
    return gen === generation // switched sessions while it was pending: the caller does nothing more
  } catch (err) { lastDrop = String(err); return false }
}

const HANDOFF_TAIL = 'Then post a short plain-English note: which trigger fired, ' +
  'the handoff file path, the current context %, and that /resume-handoff picks it up. ' +
  'Do not start a /loop or record monitor actions: the cache-monitor mod already did.'
const HANDOFF = (why: string) =>
  `${HANDOFF_TAG} ${why} Run the handoff skill now to save this session's state ` +
  `(/handoff; installed from a marketplace it is listed as session-handoff:handoff). ${HANDOFF_TAIL}`
const HANDOFF_IN_TURN = (why: string) =>
  `${HANDOFF_TAG} ${why} Finish only the step you are on, then run the handoff skill now (/handoff; installed from a marketplace it is listed as session-handoff:handoff), ` +
  `before any other work in this task, to save this session's state. ${HANDOFF_TAIL}`

// The 99% usage handoff while a turn runs. $.prompt.submit queues until the turn ends: 3, 8
// and 16.5 min late in three chats (04/11/2026), long enough for the limit to cut the chat
// off first. A user-role row appended with $.session.append is read at the model's next step
// inside the running turn (probe 05/11/2026; a self-addressed $.session.send was refused:
// "no live session"). If that turn ends without /handoff's Step 0 `record stop`, the queued
// prompt goes out after all. The appended row is isMeta, so it never counts as typed.
let inTurn: { turnId: string; why: string; gen: number } | null = null
// The main-loop turn in which a `record stop` was last seen: kept per turn, not on inTurn,
// so a stop that ran before or while the row was appended still counts.
let stopTurnId = ''
async function deliverIntoTurn($: EngineInterface, why: string, gen: number): Promise<boolean> {
  const turnId = currentTurnId
  inTurn = null
  if (gen !== generation) { lastDrop = 'session changed during the check'; return false }
  try {
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: HANDOFF_IN_TURN(why) }] } })
    if (r && typeof (r as { deny?: unknown }).deny === 'string') return submitHandoff($, why, gen)
  } catch { return submitHandoff($, why, gen) }
  if (gen !== generation) return false
  // The turn ended while the row was being added: nobody will read it until the next prompt.
  if (!turnRunning || currentTurnId !== turnId) return submitHandoff($, why, gen)
  inTurn = { turnId, why, gen }
  handoffTurnId = turnId // the panel's done sound then plays when this turn ends
  return true
}
// Claude's own main-loop question, while its dialog waits. A queued $.prompt.submit waits for
// the dialog to close, so an idle handoff would run only when the person comes back. When the
// idle handoff falls due while a question is open, the handoff is delivered into the running
// turn and the question's call is ended with a refusal, so the turn goes on to run the handoff.
let openQuestion: { close: () => void; gen: number } | null = null
const QUESTION_CLOSED = 'No answer: the user is away, and the cache-monitor idle handoff is due. ' +
  'Do not ask again now; follow the cache-monitor instruction that comes next.'
async function afterHandoffTurn($: EngineInterface, p: { why: string; gen: number }) {
  if (!(await submitHandoff($, p.why, p.gen)) && p.gen === generation) {
    await record($, 'noop', `in-turn usage handoff not run; queued prompt not accepted: ${lastDrop}`)
  }
}

type Status = {
  ok: boolean; project: string; contextPct: number; cacheExpired?: boolean; cacheTtl?: string
  fiveHourUsage?: { pct: number | null }
  state: { loopRunning: boolean }
  recommend: { action: string; nextMin: number | null; why: string; urgency?: string }
}

const TTL_TOAST = 'cache-monitor: this chat\'s prompt cache lasts 5 minutes, so cache keep-alives and the idle handoff are off. ' +
  'Add "promptCacheTtl": "1h" to settings.json; new chats then keep the 1-hour cache.'

async function check($: EngineInterface): Promise<number> {
  // A check belongs to the session it started in: if /clear or a resume switches sessions while
  // it waits, its result is dropped rather than acted on in the new conversation.
  const gen = generation
  const sid = sessionId
  const rec = (action: string, note?: string) => record($, action, note, sid, gen)
  const r = await monitor($, ['status'], sid)
  if (gen !== generation || r.exitCode !== 0) return RETRY_MIN
  const s = JSON.parse(r.stdout) as Status
  slug = s.project
  if (await isOff($)) { paused = true; return RETRY_MIN }
  // Once per chat (05/11/2026). The log gets it too, from the noop note below.
  if (s.cacheTtl === '5m' && !ttlToasted.has(sid)) {
    ttlToasted.add(sid)
    try { $.ui.toast(TTL_TOAST) } catch { /* no surface: the log still says it */ }
  }
  const { action, nextMin } = s.recommend
  // Never start a turn or a fork on a cold cache: it re-writes the whole conversation at
  // full price in a chat nobody is using. Wait for the user's own next prompt.
  // Checked before the `start` record so an idle cold chat does not claim the loop either.
  const warmByKeepalive = lastKeepaliveAt > 0 && (await $.clock.now()) - lastKeepaliveAt < KEEPALIVE_WARM_MS
  if (s.cacheExpired && !warmByKeepalive && action !== 'noop') {
    await rec('noop', `cache cold: ${action} skipped, waiting for the user`)
    return nextMin ?? RETRY_MIN
  }
  if (!s.state.loopRunning) await rec('start', 'cache-monitor mod')
  if (action === 'keepalive' || action === 'handoff-idle') {
    const working = await backgroundWork($)
    if (working) {
      // Keep the cache warm while Claude waits on background work, but never hand off
      // (a 5-hour background test run once let a 15%-context chat go cold). Recorded as
      // noop so it does not spend the idle path's one keep-alive (pings).
      const now = await $.clock.now()
      if (lastKeepaliveAt > 0 && now - lastKeepaliveAt < BG_KEEPALIVE_EVERY_MS) {
        await rec('noop', `${action} deferred: ${working}`); return RETRY_MIN
      }
      const f = await $.model.fork({ prompt: 'Cache keep-alive from the cache-monitor mod. Reply with only: OK' })
      if (gen !== generation) return RETRY_MIN
      if (f.isAnswered) lastKeepaliveAt = await $.clock.now()
      await rec('noop', f.isAnswered ? `background keep-alive (${action} deferred: ${working})` : `keep-alive fork failed: ${f.reason}`)
      return RETRY_MIN
    }
  }
  if (gen !== generation) return RETRY_MIN
  switch (action) {
    case 'keepalive': {
      const f = await $.model.fork({ prompt: 'Cache keep-alive from the cache-monitor mod. Reply with only: OK' })
      if (gen !== generation) return RETRY_MIN
      if (f.isAnswered && gen === generation) lastKeepaliveAt = await $.clock.now()
      await rec(f.isAnswered ? 'keepalive' : 'noop', f.isAnswered ? undefined : `keep-alive fork failed: ${f.reason}`)
      break
    }
    case 'consider-handoff-context':
    case 'handoff-context': {
      if (await contextHandoffSent($, sid)) { await rec('noop', 'context handoff already sent this session'); break }
      const ceiling = action === 'handoff-context'
      if (!ceiling && turnRunning) { await rec('noop', 'deferred: turn in flight'); break }
      const why = ceiling
        ? `Context is at ${s.contextPct}%, at or past the 40% ceiling.`
        : `Context is at ${s.contextPct}%, inside the 35-40% handoff window, and the session is at a boundary.`
      if (!(await submitHandoff($, why, gen))) { if (gen === generation) await rec('noop', `handoff prompt not accepted: ${lastDrop}`); return RETRY_MIN }
      await markContextHandoffSent($, sid)
      await rec('handoff-context')
      break
    }
    // 5-hour usage limit: 98% waits for the running task to finish, 99% fires now.
    case 'consider-handoff-usage':
    case 'handoff-usage': {
      if (action === 'consider-handoff-usage' && turnRunning) { await rec('noop', 'usage handoff deferred: turn in flight'); break }
      const why = action === 'handoff-usage'
        ? `The 5-hour usage limit is at ${s.fiveHourUsage?.pct}%, the last point before it cuts the session off.`
        : `The 5-hour usage limit is at ${s.fiveHourUsage?.pct}% and the current task has finished.`
      const now = action === 'handoff-usage' && turnRunning && !!currentTurnId
      const sent = now ? await deliverIntoTurn($, why, gen) : await submitHandoff($, why, gen)
      if (!sent) { if (gen === generation) await rec('noop', `handoff prompt not accepted: ${lastDrop}`); return RETRY_MIN }
      await rec('handoff-usage', now && inTurn && inTurn.gen === gen ? 'delivered into the running turn' : undefined)
      break
    }
    case 'handoff-idle': {
      const idleWhy = 'The session has been idle past the cache keep-alive.'
      const q = openQuestion && openQuestion.gen === gen && turnRunning && currentTurnId ? openQuestion : null
      const sent = q ? await deliverIntoTurn($, idleWhy, gen) : await submitHandoff($, idleWhy, gen)
      if (!sent) {
        if (gen === generation) await rec('noop', `handoff prompt not accepted: ${lastDrop}`); return RETRY_MIN
      }
      // After the delivery: the turn then reads the refusal and the handoff row at one step.
      if (q) { q.close(); if (openQuestion === q) openQuestion = null }
      await rec('handoff-idle', q ? 'open question closed; handoff delivered into the running turn' : undefined)
      if (gen === generation) paused = true
      break
    }
    default:
      await rec('noop', s.recommend.urgency === 'ttl-5m' ? 'cache TTL is 5 min: keep-alive and idle handoff off' : undefined)
  }
  return nextMin ?? RETRY_MIN
}

// /clear and resume continue the process under a new session id, and no session.start fires
// for them. Re-read the id; on a change, every per-session flag starts fresh.
async function syncSession($: EngineInterface) {
  let id = ''
  try { id = await $.session.id() } catch { return }
  if (!id || id === sessionId) return
  sessionId = id
  generation++
  paused = false
  armed = false
  handoffTurnId = ''
  currentTurnId = ''
  inTurn = null
  stopTurnId = ''
  turnRunning = false // a turn left open in the old session must not defer the new one's handoff
  lastKeepaliveAt = 0
  shells.clear()
  tasksDir = ''
  openQuestion = null // a dialog of the old session is never closed from the new one
  nextDueAt = (await $.clock.now()) + 2 * 60_000
  lastPersonAt = await $.clock.now()
  stoppedSincePerson = false
  wantAwake = false // the next tick decides again for the new session
}

async function tick($: EngineInterface) {
  await syncSession($)
  await syncAwake($)
  const now = await $.clock.now()
  if (busy || paused || now < nextDueAt) return
  busy = true
  const gen = generation // a check that outlives a session switch must not reschedule the new one
  try { const min = await check($); if (gen === generation) nextDueAt = now + min * 60_000 }
  catch { if (gen === generation) nextDueAt = now + RETRY_MIN * 60_000 }
  finally { busy = false }
}

// Prompts that were not the person's own: background notices, schedules, other sessions,
// coordinators, observers, relayed channels, and another plugin's prompt unless it submitted a
// person's choice (asUser). A denylist, not an allowlist: the engine does not document which
// kind a typed prompt in every surface carries, and a missed re-arm there would leave the
// monitor paused for good.
const AUTOMATED_ORIGINS = [
  'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay',
  'channel', 'coordinator', 'observer', 'observer-activity',
]
function notThePerson(origin: { kind: string; asUser?: boolean }) {
  if (AUTOMATED_ORIGINS.includes(origin.kind)) return true
  return origin.kind === 'plugin' && !origin.asUser
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
    configDir = ((await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`).replace(/\\/g, '/')
    root = await $.session.root()
    sessionId = await $.session.id()
    inPanel = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-vscode'
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    // The first value set wins; if it is not a plain local-drive path, fail closed ('').
    systemRoot = localDir((await $.env.get('SystemRoot')) || (await $.env.get('windir'))
      || `${(await $.env.get('SystemDrive')) || 'C:'}/Windows`)
    if (isWindows) nodeExe = await resolveNode($)
    nextDueAt = (await $.clock.now()) + 2 * 60_000
    lastPersonAt = await $.clock.now()
    void pruneSent($)
    $.clock.every(TICK_MS, () => { void tick($) })
    for (const [name, description] of [
      ['monitor-off', 'Stop the cache + context monitor for this session'],
      ['monitor-on', 'Restart the cache + context monitor for this session'],
    ] as const) {
      try { await $.command.register({ name, description }) } catch { /* name taken: skip */ }
    }
    return r
  })

  on('turn.start', (_$, e, next) => {
    if (!(e as { agentId?: string }).agentId) {
      turnRunning = true
      currentTurnId = e.turnId
      if (e.text.startsWith(HANDOFF_TAG)) handoffTurnId = e.turnId
    }
    return next(e)
  })
  on('turn.complete', ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) {
      turnRunning = false
      const p = inTurn && inTurn.turnId === e.turnId ? inTurn : null
      if (p) inTurn = null
      if (p && stopTurnId !== e.turnId) {
        // The in-turn handoff was not run: send the queued prompt now; its own turn plays the sound.
        if (handoffTurnId === e.turnId) handoffTurnId = ''
        void afterHandoffTurn($, p)
      } else if (handoffTurnId && e.turnId === handoffTurnId) {
        handoffTurnId = ''
        if (inPanel) void playSound($)
      }
    }
    return next(e)
  })

  // A skill that records `stop` through monitor.js (e.g. a handoff skill ending an old /loop)
  // clears `armed`, so the next prompt re-arms.
  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool } as { tool: 'Bash' }, async ($, e, next) => {
      const ran = await next(e)
      const c = String((e as { command?: unknown }).command ?? '')
      if (/monitor\.js/.test(c) && /--action\s+stop\b/.test(c)) {
        armed = false
        stoppedSincePerson = true
        if (!e.agentId && turnRunning) stopTurnId = currentTurnId
      }
      const task = (ran.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
      if (!e.agentId && typeof task === 'string' && task) shells.set(task, { use: e.tool_use_id, ts: await $.clock.now() })
      return ran
    })
  }
  // An answered question restarts the keep-awake cap like a typed prompt. Only a call that
  // came back with at least one answer counts; a rejected, failed or unanswered dialog does not.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    // Only Claude's own main-loop question can be closed for the idle handoff; another mod's
    // $.ui.ask (origin.plugin = its name) and a subagent's question are left alone.
    const mine = !e.agentId && (next.origin as { plugin?: string }).plugin === 'engine'
    const call = next(e)
    let ran: Awaited<typeof call>
    if (mine) {
      let close = () => {}
      const due = new Promise<'closed'>(r => { close = () => r('closed') })
      const q = { close, gen: generation }
      openQuestion = q
      try {
        call.catch(() => { /* abandoned once closed: its later settle must not go unhandled */ })
        const first = await Promise.race([call, due])
        if (first === 'closed') return { deny: QUESTION_CLOSED }
        ran = first
      } finally { if (openQuestion === q) openQuestion = null }
    } else ran = await call
    const answers = (ran.result as { answers?: unknown } | undefined)?.answers
    const failed = (ran as { isError?: boolean }).isError === true
    if (!failed && answers && typeof answers === 'object' && Object.keys(answers).length > 0) lastPersonAt = await $.clock.now()
    return ran
  })

  // Re-arm on the person's next prompt (after an idle handoff, or after a `stop`). This uses
  // prompt.submit rather than classic.UserPromptSubmit, which managed/Team machines skip.
  on('prompt.submit', async ($, e, next) => {
    await syncSession($)
    const origin = e.origin as { kind: string; asUser?: boolean }
    // The engine also queues idle notices and delivery receipts as unclassified + isMeta.
    const machineNotice = origin.kind === 'unclassified' && (e as { isMeta?: boolean }).isMeta === true
    if (!machineNotice && !notThePerson(origin)) { lastPersonAt = await $.clock.now(); stoppedSincePerson = false }
    if (origin.kind === 'task-notification') shellNotice(String(e.text ?? ''))
    else if (!machineNotice && !notThePerson(origin) && sessionId && (paused || !armed) && !(await isOff($))) {
      paused = false
      try { if (await record($, 'start', 'cache-monitor mod: re-armed on prompt')) nextDueAt = 0 } catch { /* retry on the timer */ }
    }
    return next(e)
  })

  // Both commands sync first: right after /clear the id may not have been re-read yet, and the
  // old session's off file must not be written or cleared from the new one.
  on('command.run', { command: 'monitor-off' }, async $ => {
    await syncSession($)
    if (!slug) return { text: 'The monitor has no session data yet; nothing to turn off.' }
    await $.fs.write(offMarker(), sessionId)
    paused = true
    await record($, 'stop', 'turned off by the user for this session')
    return { text: 'Cache + context monitor is off for this session. /monitor-on restarts it.' }
  })
  on('command.run', { command: 'monitor-on' }, async $ => {
    await syncSession($)
    if (await isOff($)) await $.fs.write(offMarker(), '')
    paused = false
    nextDueAt = 0
    return { text: 'Cache + context monitor is on again for this session.' }
  })
}
