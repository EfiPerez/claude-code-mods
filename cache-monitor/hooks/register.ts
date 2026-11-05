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
// When this session's last keep-alive fork was answered. The fork re-warms the cache but never
// lands in the transcript, so monitor.js still reports the cache as expired an hour after the
// user's last turn; without this the idle handoff was blocked right after a keep-alive.
let lastKeepaliveAt = 0
let generation = 0 // bumped on every session change; a check started earlier is discarded
const KEEPALIVE_WARM_MS = 55 * 60_000 // 1-hour TTL minus a margin

// Between turns Claude can still be working: it waits on background agents or shells, and
// their completion notices wake the chat. The transcript is quiet meanwhile, so monitor.js
// reads it as idle and would spend a keep-alive and fire handoff-idle mid-build.
// Background shells of the main loop: task id -> its tool_use_id and start. Their notice
// names both ids. Not turnRunning: a turn held open on a question to the user must still go idle.
const shells = new Map<string, { use: string; ts: number }>()
const SHELL_STALE_MS = 3 * 60 * 60_000 // a lost completion notice must not block idle forever
async function backgroundWork($: EngineInterface): Promise<string> {
  try {
    const agents = await $.agent.list()
    if (agents.some(a => !a.parentId && ['pending', 'running', 'waiting'].includes(a.status))) return 'background agent running'
  } catch { /* no agent list: fall through to shells */ }
  const now = await $.clock.now()
  for (const [task, info] of shells) if (now - info.ts > SHELL_STALE_MS) shells.delete(task)
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
// Off for this session only: one file per session, holding that session's id while it is off,
// so a second chat in the same project turning itself off cannot clear the first one's switch.
const offMarker = () => `${configDir}/cache-timer/${slug}.${sessionId}.off`
async function isOff($: EngineInterface) {
  if (!slug || !(await $.fs.exists(offMarker()))) return false
  return String(await $.fs.read(offMarker())).trim() === sessionId
}

async function monitor($: EngineInterface, args: string[], sid = sessionId) {
  return $.process.run(['node', monitorPath($), ...args, '--project', root], {
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

const HANDOFF = (why: string) =>
  `${HANDOFF_TAG} ${why} Run the handoff skill now to save this session's state ` +
  '(/handoff; installed from a marketplace it is listed as session-handoff:handoff). ' +
  'Then post a short plain-English note: which trigger fired, ' +
  'the handoff file path, the current context %, and that /resume-handoff picks it up. ' +
  'Do not start a /loop or record monitor actions: the cache-monitor mod already did.'

type Status = {
  ok: boolean; project: string; contextPct: number; cacheExpired?: boolean
  fiveHourUsage?: { pct: number | null }
  state: { loopRunning: boolean }
  recommend: { action: string; nextMin: number | null; why: string }
}

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
    if (working) { await rec('noop', `${action} deferred: ${working}`); return RETRY_MIN }
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
      if (!(await submitHandoff($, why, gen))) { if (gen === generation) await rec('noop', `handoff prompt not accepted: ${lastDrop}`); return RETRY_MIN }
      await rec('handoff-usage')
      break
    }
    case 'handoff-idle':
      if (!(await submitHandoff($, 'The session has been idle past the cache keep-alive.', gen))) {
        if (gen === generation) await rec('noop', `handoff prompt not accepted: ${lastDrop}`); return RETRY_MIN
      }
      await rec('handoff-idle')
      if (gen === generation) paused = true
      break
    default:
      await rec('noop')
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
  turnRunning = false // a turn left open in the old session must not defer the new one's handoff
  lastKeepaliveAt = 0
  shells.clear()
  nextDueAt = (await $.clock.now()) + 2 * 60_000
}

async function tick($: EngineInterface) {
  await syncSession($)
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
    nextDueAt = (await $.clock.now()) + 2 * 60_000
    void pruneSent($)
    $.clock.every(TICK_MS, () => { void tick($) })
    for (const [name, description] of [
      ['monitor-off', 'Stop the cache + context monitor for this session'],
      ['monitor-on', 'Restart the cache + context monitor for this session'],
    ]) {
      try { await $.command.register({ name, description }) } catch { /* name taken: skip */ }
    }
    return r
  })

  on('turn.start', ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) {
      turnRunning = true
      if (e.text.startsWith(HANDOFF_TAG)) handoffTurnId = e.turnId
    }
    return next(e)
  })
  on('turn.complete', ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) {
      turnRunning = false
      if (handoffTurnId && e.turnId === handoffTurnId) {
        handoffTurnId = ''
        if (inPanel) void playSound($)
      }
    }
    return next(e)
  })

  // A skill that records `stop` through monitor.js (e.g. a handoff skill ending an old /loop)
  // clears `armed`, so the next prompt re-arms.
  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const ran = await next(e)
      const c = String((e as { command?: unknown }).command ?? '')
      if (/monitor\.js/.test(c) && /--action\s+stop\b/.test(c)) armed = false
      const task = (ran.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
      if (!e.agentId && typeof task === 'string' && task) shells.set(task, { use: e.tool_use_id, ts: await $.clock.now() })
      return ran
    })
  }
  // Re-arm on the person's next prompt (after an idle handoff, or after a `stop`). This uses
  // prompt.submit rather than classic.UserPromptSubmit, which managed/Team machines skip.
  on('prompt.submit', async ($, e, next) => {
    await syncSession($)
    const origin = e.origin as { kind: string; asUser?: boolean }
    // The engine also queues idle notices and delivery receipts as unclassified + isMeta.
    const machineNotice = origin.kind === 'unclassified' && (e as { isMeta?: boolean }).isMeta === true
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
