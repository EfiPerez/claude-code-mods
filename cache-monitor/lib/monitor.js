#!/usr/bin/env node
'use strict';
/*
 * Cache monitor CLI. Run by the cache-monitor mod (hooks/register.ts) on its timer;
 * it can also be run by hand. All transcript reading lives in ./core.js.
 *
 *   node monitor.js status  --project "<workspace path>"
 *   node monitor.js record  --project "<path>" --action <a> [--interval <min>] [--note "..."]
 *   node monitor.js reset   --project "<path>"
 *
 * Actions: start | noop | keepalive | handoff-context | handoff-idle | handoff-usage | stop
 * Exit codes: 0 ok, 2 bad usage, 3 no session data.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const core = require('./core.js');

// Claude Code's config folder: CLAUDE_CONFIG_DIR when set, else ~/.claude.
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const DIR = path.join(CONFIG_DIR, 'cache-timer');

// --- tuning policy -------------------------------------------------------
const BASE_INTERVAL_MIN = 45;   // below the 35% window; also the cache keep-alive
const WINDOW_INTERVAL_MIN = 5;  // inside 35-40%, so we cannot sail past the ceiling
const MIN_INTERVAL_MIN = 15;    // floor; never tighten into a busy-loop
const IDLE_TRIGGER_MIN = 55;    // cache is 60 min; fire before it lapses
const PING_CAP = 1;             // handoff after 1 keep-alive (~2h idle)
// An idle check scheduled a full interval out can land past the 60-min cache: at 15-min
// checks, idle 51 -> next check at 66, cache gone at 60 (a 112K-token miss).
// So a 'noop' check is pulled in to land this many minutes before expiry.
const CACHE_LEAD_MIN = 5;
// Nothing clears loopRunning when a session simply ends, so the flag can latch "true"
// forever. It reads as "stale" once lastCheck is older than intervalMin +
// core.OVERDUE_GRACE_MIN; the logic lives in core.js.
const OVERDUE_GRACE_MIN = core.OVERDUE_GRACE_MIN;
// 5-hour account usage. Same shape as the context trigger: from 98%
// hand off at a natural boundary (the running task gets to finish), at 99% hand off
// now. Not 100%: at the limit Claude cannot write the handoff at all. The limit is
// account-wide, so every session that is actually working (cache still warm) hands
// off once per 5h window. Checks get closer together as usage climbs, assuming a
// worst-case burn of 2 points a minute.
const USAGE_HANDOFF_PCT = 98;
const USAGE_CEIL_PCT = 99;
const USAGE_MAX_BURN_PER_MIN = 2;
const USAGE_IDLE_FLOOR_MIN = 10;   // cold session: nothing is burning here, don't check every minute
const WINDOW_MATCH_MS = 30 * 60000; // sources disagree on resets_at by ~300 ms; windows are 5h apart

// The calling session, when monitor.js runs from inside one (Claude Code sets this
// for tool shells). core.computeStatus only honours it if that transcript is in the
// resolved project, so running this from another project's session is safe.
const SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID || null;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

// Optional: cache-timer/config.json may hold {"dashboardUsageUrl": "<url>"}, an endpoint
// returning {realFiveHourPct, realFiveHourResetsAt, realAt}. No config -> that source is
// skipped and the statusline cache alone feeds readFiveHour.
function dashboardUsageUrl() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).dashboardUsageUrl || null; }
  catch { return null; }
}

const toMs = v => typeof v === 'number' ? (v < 1e12 ? v * 1000 : v)
  : typeof v === 'string' ? Date.parse(v) : NaN;

/* The account's 5h usage, from whichever local source is freshest:
 *   - <config dir>/rate-limits-cache.json: a copy of the statusLine payload, written by
 *     your status line script whenever it carries .rate_limits (resets_at in seconds;
 *     age = file mtime)
 *   - optional dashboardUsageUrl from config.json (resets/at in ms)
 * A source whose window has already reset is skipped: its percentage is for a dead
 * window. Returns {pct, resetsAt, source, ageMin}; pct null when nothing is usable. */
async function readFiveHour(now = Date.now()) {
  const found = [];
  try {
    const f = path.join(CONFIG_DIR, 'rate-limits-cache.json');
    const fh = JSON.parse(fs.readFileSync(f, 'utf8')).rate_limits.five_hour;
    found.push({ pct: Number(fh.used_percentage), resetsAt: toMs(fh.resets_at),
                 at: fs.statSync(f).mtimeMs, source: 'statusline' });
  } catch {}
  const url = dashboardUsageUrl();
  if (url) try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const u = await r.json();
    if (u.realFiveHourPct != null) {
      found.push({ pct: Number(u.realFiveHourPct), resetsAt: toMs(u.realFiveHourResetsAt),
                   at: toMs(u.realAt), source: 'dashboard' });
    }
  } catch {}
  const live = found.filter(s => isFinite(s.pct) && isFinite(s.resetsAt) && s.resetsAt > now)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  if (!live.length) return { pct: null, resetsAt: null, source: 'none', ageMin: null };
  const s = live[0];
  return { pct: s.pct, resetsAt: s.resetsAt, source: s.source,
           ageMin: isFinite(s.at) ? +((now - s.at) / 60000).toFixed(1) : null };
}

const sameWindow = (a, b) => a != null && b != null && Math.abs(a - b) < WINDOW_MATCH_MS;

function slugFor(projectPath) {
  const r = core.resolveProjectDir(projectPath);
  if (r) return r.slug;
  return String(projectPath || 'unknown').replace(/[^a-zA-Z0-9]/g, '-');
}

const statePath = slug => path.join(DIR, slug + '.json');
const logPath = slug => path.join(DIR, slug + '.log');

function loadState(slug) {
  try { return JSON.parse(fs.readFileSync(statePath(slug), 'utf8')); }
  catch {
    return {
      slug, sessionId: null, loopRunning: false, pings: 0, pingCap: PING_CAP,
      handoffFired: false, contextHandoffFired: false,
      intervalMin: BASE_INTERVAL_MIN, checks: 0,
      lastCheck: null, lastCacheAgeMin: null, lastCtxPct: null,
    };
  }
}

// Pure, so they are unit-testable without waiting for real thresholds.
const loopStaleMin = core.loopAgeMin;
const isLoopStale = core.isLoopOverdue;

// Stores this session's counters under its id and drops entries untouched for
// SESSION_TTL_MS: a session that old has no warm cache and no loop left to protect.
const SESSION_TTL_MS = 7 * 24 * 3600000;
function withSession(sessions, sessionId, st, now) {
  const out = Object.create(null);   // a session id of "__proto__" must stay a plain key
  for (const [id, v] of Object.entries(sessions || {})) {
    if (v && typeof v.at === 'number' && now - v.at <= SESSION_TTL_MS) out[id] = v;
  }
  if (sessionId) {
    const entry = { at: now };
    for (const k of Object.keys(core.SESSION_FIELDS)) entry[k] = st[k];
    out[sessionId] = entry;
  }
  return out;
}

// Two chats in one project can record at once (separate node processes). cmdRecord holds this
// per-project lock file from loadState to saveState, so one record cannot overwrite another's.
// The file holds an owner token; release deletes it only while it still holds that token. A
// lock older than LOCK_STALE_MS outlived the mod's 20 s subprocess timeout, so its owner is
// gone and it is taken over. A live lock is never taken: after LOCK_WAIT_MS the record fails
// (exit 1) and the mod treats it as a failed record, rather than risk a lost update.
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 10000;
// Removing a stale lock is itself serialized by a short-lived `.lock.recover` file: two
// processes that both saw the old lock cannot both delete it, because the second one re-checks
// under the recover lock and then finds the first one's fresh lock (not stale) and leaves it.
// The recover file is held for microseconds. One left behind by a crash is never removed
// automatically (removing it safely would need the same protection again); records then fail
// with a message naming it, and deleting that file by hand clears it.
function reclaimStale(lock) {
  const rec = lock + '.recover';
  try { fs.writeFileSync(rec, String(process.pid), { flag: 'wx' }); }
  catch (e) {
    let age = 0;
    try { age = Date.now() - fs.statSync(rec).mtimeMs; } catch {}
    if (age > LOCK_STALE_MS) throw new Error('abandoned lock-recovery file; delete it to resume: ' + rec);
    return;
  }
  try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock); }
  catch {}
  finally { try { fs.unlinkSync(rec); } catch {} }
}

async function lockState(slug) {
  ensureDir();
  const lock = statePath(slug) + '.lock';
  const token = process.pid + '-' + Math.random().toString(36).slice(2);
  const start = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx' });
      let held = true;
      const release = () => {
        if (!held) return;
        held = false;
        try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch {}
      };
      process.on('exit', release);
      return release;
    } catch (e) {
      // Windows reports EPERM/EACCES/EBUSY while another process is deleting the lock
      // file: that is contention too, not a failure.
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; }
      catch {
        if (Date.now() - start > LOCK_WAIT_MS) throw new Error('state file is locked by another record; try again');
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      if (age > LOCK_STALE_MS) { reclaimStale(lock); continue; }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error('state file is locked by another record; try again');
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

// Under the lock, plus a second guard: re-read the file just before writing and keep every
// OTHER session's entry from disk. Then write a temp file and rename it over the state file,
// so a reader never sees a half-written file.
function saveState(slug, st) {
  ensureDir();
  const disk = loadState(slug);
  if (disk.sessions && typeof disk.sessions === 'object') {
    const merged = Object.create(null);
    for (const [id, v] of Object.entries(disk.sessions)) merged[id] = v;
    for (const [id, v] of Object.entries(st.sessions || {})) {
      if (id === st.sessionId || !merged[id] || (v && merged[id].at < v.at)) merged[id] = v;
    }
    st.sessions = merged;
  }
  st.updatedAt = new Date().toISOString();
  const tmp = statePath(slug) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n', 'utf8');
  try { fs.renameSync(tmp, statePath(slug)); }
  catch (e) {   // Windows can refuse a rename over a file another process has open
    fs.writeFileSync(statePath(slug), JSON.stringify(st, null, 2) + '\n', 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function appendLog(slug, fields) {
  ensureDir();
  // One physical line per record: a note may carry a line break (e.g. an engine error text).
  const line = Object.entries(fields).map(([k, v]) => k + '=' + String(v).replace(/[\r\n]+/g, ' ')).join('\t');
  fs.appendFileSync(logPath(slug), new Date().toISOString() + '\t' + line + '\n', 'utf8');
}

/* Two failure signatures, per the approved plan:
 *   - cache lapsed before a check landed  -> tighten base by 5
 *   - context jumped past the ceiling between checks -> tighten base by 10
 * Returns {intervalMin, changed, reason}. */
function selfTune(slug, st, status) {
  const prevCtx = st.lastCtxPct;
  let interval = st.intervalMin || BASE_INTERVAL_MIN;
  let changed = false, reason = null;

  if (status.expired) {
    const next = Math.max(MIN_INTERVAL_MIN, interval - 5);
    if (next !== interval) { interval = next; changed = true; reason = 'cache lapsed before this check landed'; }
  } else if (prevCtx != null && prevCtx < core.CTX_CEIL && status.ctxPct >= core.CTX_CEIL) {
    const next = Math.max(MIN_INTERVAL_MIN, interval - 10);
    if (next !== interval) { interval = next; changed = true; reason = 'context crossed the 40% ceiling between two checks'; }
  }
  return { intervalMin: interval, changed, reason };
}

// status.fiveHour is attached by the CLI (readFiveHour); missing means no usage data.
function decide(status, st) {
  const fh = status.fiveHour;
  const usageLive = !!fh && fh.pct != null && fh.resetsAt != null &&
                    !sameWindow(st.usageHandoffWindow, fh.resetsAt);
  if (usageLive && fh.pct >= USAGE_CEIL_PCT && !status.expired) {
    return { action: 'handoff-usage', urgency: 'usage-ceiling', nextMin: 1,
             why: '5-hour usage is at ' + fh.pct + '%, at/over the ' + USAGE_CEIL_PCT + '% ceiling - fire now regardless of what is in flight' };
  }
  const d = decideContextIdle(status, st);
  // A context ceiling still fires now; the usage window only ever waits.
  if (usageLive && fh.pct >= USAGE_HANDOFF_PCT && !status.expired && d.action !== 'handoff-context') {
    return { action: 'consider-handoff-usage', urgency: 'usage-window', nextMin: 1,
             why: '5-hour usage is at ' + fh.pct + '%, inside the ' + USAGE_HANDOFF_PCT + '-' + USAGE_CEIL_PCT + '% window - fire once the current task finishes, otherwise wait' };
  }
  // Not after a keep-alive: an earlier check would find the chat still idle with the
  // keep-alive spent and fire handoff-idle ~1 h early instead of after ~2 h idle.
  if (usageLive && d.nextMin != null && d.action !== 'keepalive') {
    const floor = status.expired ? USAGE_IDLE_FLOOR_MIN : 1;
    const n = Math.max(floor, Math.floor((USAGE_HANDOFF_PCT - fh.pct) / USAGE_MAX_BURN_PER_MIN));
    if (n < d.nextMin) { d.nextMin = n; d.why += '; 5-hour usage ' + fh.pct + '%, next check in ' + n + ' min'; }
  }
  return d;
}

function decideContextIdle(status, st) {
  // Returns the recommended action + the delay to schedule next.
  if (status.ctxPct >= core.CTX_CEIL && !st.contextHandoffFired) {
    return { action: 'handoff-context', urgency: 'ceiling', nextMin: WINDOW_INTERVAL_MIN,
             why: 'context ' + pct(status.ctxPct) + ' is at/over the 40% ceiling - fire now regardless of what is in flight' };
  }
  if (status.ctxPct >= core.CTX_WARN && !st.contextHandoffFired) {
    return { action: 'consider-handoff-context', urgency: 'window', nextMin: WINDOW_INTERVAL_MIN,
             why: 'context ' + pct(status.ctxPct) + ' is inside the 35-40% window - fire at a natural boundary, otherwise wait' };
  }
  // idleMin counts from the user's last TYPED message, so a long autonomous run (Claude replying
  // every few seconds) read as idle: 82 min idle with the cache 0.4 min old spent a keep-alive
  // and then fired handoff-idle mid-work. Claude's own reply keeps the cache warm,
  // so the idle branch waits until the cache is near expiry. The extra minute is the check
  // granularity: the noop clamp below floors to whole minutes and the mod ticks once a minute,
  // so a check aimed at CACHE_LEAD_MIN before expiry can land up to a minute early.
  const repliedRecently = !status.expired && Number.isFinite(status.remainMs) &&
    status.remainMs > (CACHE_LEAD_MIN + 1) * 60000;
  if (status.idleMin != null && status.idleMin >= IDLE_TRIGGER_MIN && !repliedRecently) {
    // A handoff (usage, context or idle) already went out and nothing was typed since: the
    // state is saved, so a keep-alive is wasted spend and a second handoff a duplicate.
    // The user's next typed message moves lastTypedAt past handoffAt and the idle path is live again.
    if (st.handoffAt != null && (status.lastTypedAt == null || status.lastTypedAt <= st.handoffAt)) {
      return { action: 'noop', urgency: 'handed-off', nextMin: st.intervalMin || BASE_INTERVAL_MIN,
               why: 'idle ' + status.idleMin + ' min, but a handoff was already sent and nothing was typed since - no keep-alive or idle handoff' };
    }
    if (st.pings >= (st.pingCap == null ? PING_CAP : st.pingCap)) {
      return { action: 'handoff-idle', urgency: 'idle-final', nextMin: null,
               why: 'idle ' + status.idleMin + ' min with a keep-alive already spent - write the handoff and stop' };
    }
    // At least BASE_INTERVAL_MIN: the self-tuned interval can sit at the 15-min floor, which
    // fired the idle handoff ~15 min after the keep-alive instead of ~2 h idle. Not more than
    // 45 either: the mod treats a keep-alive as warm for 55 min only.
    return { action: 'keepalive', urgency: 'idle', nextMin: Math.max(st.intervalMin || BASE_INTERVAL_MIN, BASE_INTERVAL_MIN),
             why: 'idle ' + status.idleMin + ' min - this wake-up refreshed the cache' };
  }
  // Only here: after a keep-alive the transcript still shows the old cache age, so
  // clamping the keepalive branch would turn the ~2h idle handoff into ~1h.
  const interval = st.intervalMin || BASE_INTERVAL_MIN;
  let nextMin = interval;
  let why = 'active, context ' + pct(status.ctxPct) + ' - nothing to do';
  if (!status.expired && Number.isFinite(status.remainMs)) {
    const beforeExpiry = Math.max(1, Math.floor(status.remainMs / 60000 - CACHE_LEAD_MIN));
    if (beforeExpiry < interval) {
      nextMin = beforeExpiry;
      why += '; next check in ' + nextMin + ' min, before the cache expires';
    }
  }
  return { action: 'noop', urgency: 'active', nextMin, why };
}

const pct = p => (p * 100).toFixed(1) + '%';

async function cmdStatus(a) {
  const project = a.project || null;
  const status = core.computeStatus(project, Date.now(), SESSION_ID);
  if (!status.ok) { console.log(JSON.stringify({ ok: false, reason: status.reason }, null, 2)); process.exit(3); }
  status.fiveHour = await readFiveHour();
  const slug = status.slug;
  // Keep-alives and handoff flags from an earlier session read as zero here, so a
  // new session's context triggers are live again.
  const st = core.sessionScoped(loadState(slug), status.sessionId);
  const tune = selfTune(slug, st, status);
  const d = decide(status, st);

  console.log(JSON.stringify({
    ok: true,
    project: slug,
    sessionId: status.sessionId,
    model: status.model,
    contextPct: +(status.ctxPct * 100).toFixed(1),
    contextState: status.ctxState,
    conversationTokens: status.prefixTokens,
    cacheMinutesLeft: +(status.remainMs / 60000).toFixed(1),
    cacheExpired: status.expired,
    nextMessageCost: core.fmtCost(status.costUsd),
    idleMinutes: status.idleMin,
    fiveHourUsage: {
      pct: status.fiveHour.pct, source: status.fiveHour.source, ageMin: status.fiveHour.ageMin,
      resetsAt: status.fiveHour.resetsAt ? new Date(status.fiveHour.resetsAt).toISOString() : null,
    },
    state: {
      // Effective, not raw: a stale flag must read as "not running" so the mod
      // re-arms. Both raw and stale are reported too -- never render a state only
      // when it is healthy.
      loopRunning: st.loopRunning && !isLoopStale(st, Date.now()),
      loopRunningRaw: st.loopRunning,
      loopStale: isLoopStale(st, Date.now()),
      loopLastCheckAgeMin: (function () {
        const a = loopStaleMin(st, Date.now());
        return a == null ? null : +a.toFixed(1);
      })(),
      keepalives: st.pings, keepaliveCap: st.pingCap,
      contextHandoffFired: st.contextHandoffFired, handoffFired: st.handoffFired,
      usageHandoffWindow: st.usageHandoffWindow ? new Date(st.usageHandoffWindow).toISOString() : null,
      intervalMin: st.intervalMin, checks: st.checks,
    },
    tuning: tune,
    recommend: d,
  }, null, 2));
}

async function cmdRecord(a) {
  const action = a.action;
  const VALID = ['start', 'noop', 'keepalive', 'handoff-context', 'handoff-idle', 'handoff-usage', 'stop'];
  if (!VALID.includes(action)) {
    console.error('bad --action. one of: ' + VALID.join(', ')); process.exit(2);
  }
  const status = core.computeStatus(a.project || null, Date.now(), SESSION_ID);
  if (!status.ok) { console.error('no session data: ' + status.reason); process.exit(3); }

  const slug = status.slug;
  const unlock = await lockState(slug);
  const st = loadState(slug);
  // A file from before the map holds its owner's counters only at the top level: move
  // them into the map first, or the first other chat to record would wipe them.
  if (st.sessionId && !(st.sessions && Object.hasOwn(st.sessions, st.sessionId))) {
    st.sessions = withSession(st.sessions, st.sessionId, st, Date.now());
  }
  // This session's counters, from its own entry in st.sessions (zero for a new one),
  // so another chat's record can neither inherit nor wipe them.
  Object.assign(st, core.sessionFields(st, status.sessionId));
  st.sessionId = status.sessionId;
  const tune = selfTune(slug, st, status);

  if (action === 'start') { st.loopRunning = true; st.checks = 0; }
  if (action === 'stop') st.loopRunning = false;
  if (action === 'keepalive') st.pings += 1;
  if (action === 'handoff-context') { st.contextHandoffFired = true; st.handoffFired = true; }
  if (action === 'handoff-idle') { st.handoffFired = true; st.loopRunning = false; }
  if (action.startsWith('handoff-')) st.handoffAt = Date.now();
  if (action === 'handoff-usage') {
    // Once per 5h window: the next window's 98% fires again. No window known (no
    // usage data) still latches, until the next session.
    st.handoffFired = true;
    st.usageHandoffWindow = (await readFiveHour()).resetsAt || Date.now() + 5 * 3600000;
  } else if (action.startsWith('handoff-')) {
    // Any handoff written at >=98% covers the usage one too; a second handoff right
    // after would spend the last of the window on a duplicate.
    const fh = await readFiveHour();
    if (fh.pct != null && fh.pct >= USAGE_HANDOFF_PCT) st.usageHandoffWindow = fh.resetsAt;
  }

  if (a.interval) st.intervalMin = Math.max(MIN_INTERVAL_MIN, parseInt(a.interval, 10));
  else if (tune.changed) st.intervalMin = tune.intervalMin;

  st.checks = (st.checks || 0) + 1;
  st.lastCheck = new Date().toISOString();
  st.lastCtxPct = status.ctxPct;
  st.lastCacheAgeMin = +((core.CACHE_TTL_MIN * 60000 - status.remainMs) / 60000).toFixed(1);
  st.sessions = withSession(st.sessions, st.sessionId, st, Date.now());
  saveState(slug, st);
  unlock();

  appendLog(slug, {
    action,
    ctx: (status.ctxPct * 100).toFixed(1) + '%',
    cacheAgeMin: st.lastCacheAgeMin,
    cacheExpired: status.expired,
    idleMin: status.idleMin,
    tokens: status.prefixTokens,
    interval: st.intervalMin,
    keepalives: st.pings,
    tuned: tune.changed ? '"' + tune.reason + '"' : 'no',
    note: a.note ? '"' + a.note + '"' : '-',
  });

  console.log(JSON.stringify({
    recorded: action, project: slug, sessionId: st.sessionId, intervalMin: st.intervalMin,
    keepalives: st.pings, contextHandoffFired: st.contextHandoffFired,
    loopRunning: st.loopRunning,
    tuned: tune.changed ? tune.reason : null,
    nextCheckMin: st.intervalMin,
  }, null, 2));
}

function cmdReset(a) {
  const status = core.computeStatus(a.project || null);
  const slug = status.ok ? status.slug : slugFor(a.project);
  try { fs.unlinkSync(statePath(slug)); } catch {}
  console.log(JSON.stringify({ reset: slug }, null, 2));
}

// Exported for tests; the CLI below only runs when invoked directly.
module.exports = {
  decide, selfTune, loadState, slugFor, withSession, SESSION_TTL_MS, isLoopStale, loopStaleMin, readFiveHour,
  BASE_INTERVAL_MIN, WINDOW_INTERVAL_MIN, MIN_INTERVAL_MIN, IDLE_TRIGGER_MIN, PING_CAP, CACHE_LEAD_MIN,
  OVERDUE_GRACE_MIN, USAGE_HANDOFF_PCT, USAGE_CEIL_PCT,
};

if (require.main === module) {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  const fail = e => { console.error(e && e.message || e); process.exit(1); };
  if (cmd === 'status') cmdStatus(a).catch(fail);
  else if (cmd === 'record') cmdRecord(a).catch(fail);
  else if (cmd === 'reset') cmdReset(a);
  else {
    console.error('usage: monitor.js <status|record|reset> --project "<path>" [--action <a>] [--interval <min>] [--note "..."]');
    process.exit(2);
  }
}
