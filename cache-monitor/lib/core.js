'use strict';
// Core logic for the cache monitor: pure functions + filesystem reads only, so it
// can be unit-tested on its own. The render* helpers serve an optional status bar.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Claude Code's config folder: CLAUDE_CONFIG_DIR when set, else ~/.claude.
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CONFIG_DIR, 'projects');
const STATE_DIR = path.join(CONFIG_DIR, 'cache-timer');

const CACHE_TTL_MIN = 60;          // measured: Claude Code writes the 1h ephemeral tier
const CTX_WARN = 0.35;             // handoff discretion window opens
const CTX_CEIL = 0.40;             // hard ceiling
const TAIL_BYTES = 64 * 1024;      // never read the whole transcript; they reach 36MB

// Context % must match Claude Code's own indicator, or the user sees two different
// numbers. Its webview computes the denominator as:
//     contextWindow - maxOutputTokens - 13000
// i.e. the window MINUS the reserved output budget and a ~13K working margin --
// the space actually usable for conversation, not the raw window. Those two
// values arrive from the CLI at runtime and are not constants in the bundle, so
// we use Claude Code's documented default output cap.
const MAX_OUTPUT_RESERVE = 32000;
const WORKING_MARGIN = 13000;
const usableContext = raw => Math.max(1, raw - MAX_OUTPUT_RESERVE - WORKING_MARGIN);

// Claude Code's own pill is hidden until context passes 50% used — its gate is
// `if (remaining >= 50) return null`, i.e. it appears only above 50% used.
// We cover the blind spot below that and then hand over, so exactly one context
// percentage is on screen at any moment. Same denominator on both sides, so the
// handover is seamless rather than a jump.
const CC_PILL_SHOWS_ABOVE = 0.50;

// $ per 1M input tokens. Cache read = 0.1x, 1-hour cache write = 2x.
const MODELS = {
  'claude-fable-5':  { input: 10, ctx: 1e6 },
  'claude-mythos-5': { input: 10, ctx: 1e6 },
  'claude-opus-5':   { input: 5,  ctx: 1e6 },
  'claude-opus-4-8': { input: 5,  ctx: 1e6 },
  'claude-opus-4-7': { input: 5,  ctx: 1e6 },
  'claude-opus-4-6': { input: 5,  ctx: 1e6 },
  'claude-sonnet-5': { input: 3,  ctx: 1e6 },
  'claude-sonnet-4-6': { input: 3, ctx: 1e6 },
  'claude-haiku-4-5': { input: 1, ctx: 2e5 },
};
const DEFAULT_MODEL = { input: 5, ctx: 1e6 };

function modelInfo(id) {
  if (!id) return DEFAULT_MODEL;
  const base = String(id).replace(/\[1m\]$/, '');
  return MODELS[base] || DEFAULT_MODEL;
}

/** 'claude-sonnet-5' -> 'Sonnet 5', 'claude-opus-4-8' -> 'Opus 4.8',
 *  'claude-haiku-4-5' -> 'Haiku 4.5'. Best-effort label for the status bar —
 *  falls back to the raw id for anything that doesn't match the usual shape. */
function shortModelLabel(id) {
  if (!id) return null;
  const base = String(id).replace(/\[1m\]$/, '').replace(/^claude-/, '');
  const parts = base.split('-');
  if (parts.length < 2) return base;
  const [name, ...version] = parts;
  if (!version.every(v => /^\d+$/.test(v))) return base;
  return name[0].toUpperCase() + name.slice(1) + ' ' + version.join('.');
}

/** Workspace path -> the folder name Claude Code already uses under ~/.claude/projects.
 *  EVERY non-alphanumeric character becomes a hyphen, not just separators:
 *    c:\work\my-app             -> c--work-my-app
 *    c:\work\Budget tracker     -> c--work-Budget-tracker   (spaces)
 *    c:\work\Ops tools\.claude  -> c--work-Ops-tools--claude (dots)
 *  Matched case-insensitively, because the drive letter's case is inconsistent
 *  across the folders Claude Code has already created. */
function resolveProjectDir(workspacePath) {
  if (!workspacePath) return null;
  const slug = workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
  let entries;
  try { entries = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  // Exact name first: on a case-sensitive filesystem /work/Foo and /work/foo are two projects.
  const hit = entries.find(e => e === slug) ||
    entries.find(e => e.toLowerCase() === slug.toLowerCase());
  return hit ? { dir: path.join(PROJECTS_DIR, hit), slug: hit, anchored: true } : null;
}

/** Fallback when no folder is open: newest transcript anywhere. Flagged unanchored. */
function newestProjectDirAnywhere() {
  let entries;
  try { entries = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  let best = null;
  for (const e of entries) {
    const d = path.join(PROJECTS_DIR, e);
    let t = 0;
    try {
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.jsonl')) continue;
        const m = fs.statSync(path.join(d, f)).mtimeMs;
        if (m > t) t = m;
      }
    } catch { continue; }
    if (t && (!best || t > best.t)) best = { t, dir: d, slug: e };
  }
  return best ? { dir: best.dir, slug: best.slug, anchored: false } : null;
}

// A status bar is one item per VS Code window, picked by file mtime, so two tabs on the same project (or a subagent
// writing its own transcript) can silently render as one confident reading of
// the wrong tab. There is no supported way to ask VS Code which tab is really
// focused for Claude Code's webview (checked — no public API, no command, and
// the tab label is a human title, not a session id), so we can't fix *which*
// transcript wins. What we can do is stop presenting a guess as a certainty:
// flag it when 2+ transcripts in the resolved project were modified within the
// last few ticks, i.e. something else is actively writing right now.
const AMBIGUOUS_WINDOW_MS = 15000; // 3x extension.js's TICK_MS

/** True when 2+ transcripts in dir were modified within AMBIGUOUS_WINDOW_MS of
 *  now — more than one session is actively writing to this project, so "the
 *  newest file" is not reliably "the tab on screen". */
function multipleActiveTranscripts(dir, now = Date.now()) {
  let count = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      if (now - fs.statSync(path.join(dir, f)).mtimeMs <= AMBIGUOUS_WINDOW_MS) count++;
    }
  } catch { return false; }
  return count > 1;
}

function transcriptExistsAnywhere(sessionId) {
  let entries;
  try { entries = fs.readdirSync(PROJECTS_DIR); } catch { return false; }
  return entries.some(e => fs.existsSync(path.join(PROJECTS_DIR, e, sessionId + '.jsonl')));
}

function newestTranscript(dir) {
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  } catch { return null; }
  return best ? best.p : null;
}

/** Read only the final TAIL_BYTES of the file. Discards the leading partial line. */
function tailLines(file, bytes = TAIL_BYTES) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  const start = Math.max(0, size - bytes);
  const len = size - start;
  if (len <= 0) return [];
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return lines.filter(l => l.trim());
}

// Text that appears as a "user" turn but was not typed by the user.
const ARTIFACT_PREFIXES = [
  '<local-command-caveat>', '<command-name>', '<command-message>',
  '<local-command-stdout>', '<system-reminder>', 'Base directory for this skill:',
  '[CACHE-MONITOR]',   // the loop's own wake-ups carry this sentinel
  '<task-notification>',   // background task finished; not typed
];

function userText(entry) {
  const c = entry.message && entry.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // A turn carrying tool_result blocks is machine output, never a typed message.
    if (c.some(b => b && b.type === 'tool_result')) return null;
    return c.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  }
  return null;
}

function isGenuineUserMessage(entry) {
  if (entry.type !== 'user') return false;
  // Harness-injected expansions (skill bodies, e.g. the /loop wake-up's
  // "# /loop — schedule ...") are flagged isMeta and match no prefix.
  if (entry.isMeta) return false;
  const t = userText(entry);
  if (!t || !t.trim()) return false;
  const head = t.trimStart();
  return !ARTIFACT_PREFIXES.some(p => head.startsWith(p));
}

/** Newest assistant turn carrying usage. The last few lines always suffice. */
function readUsage(file) {
  const lines = tailLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type === 'assistant' && o.message && o.message.usage) {
      return { ts: o.timestamp, model: o.message.model, u: o.message.usage };
    }
  }
  return null;
}

// Escalating tail sizes for the idle scan. A single turn can be hundreds of KB
// once skills and large tool results are in play, so 64KB routinely contains
// nothing but tool_result blocks and the last typed message sits much further back.
const IDLE_TAIL_STEPS = [64 * 1024, 512 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];
const idleMemo = new Map();   // file -> { size, ts }

/** Newest genuinely-typed user message, searching progressively further back.
 *  Memoised on file size: while idle nothing is rewritten, so this costs nothing
 *  on repeat ticks; during active work the size changes and we rescan (which is
 *  exactly when the answer needs to be fresh). */
function findLastUserTs(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  const memo = idleMemo.get(file);
  if (memo && memo.size === size) return memo.ts;

  let ts = null;
  for (const step of IDLE_TAIL_STEPS) {
    const lines = tailLines(file, step);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (isGenuineUserMessage(o)) { ts = o.timestamp; break; }
    }
    if (ts) break;
    if (step >= size) break;          // already read the whole file
  }
  idleMemo.set(file, { size, ts });
  return ts;
}

function readSession(file) {
  return { usage: readUsage(file), lastUser: findLastUserTs(file) };
}

function readState(slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, slug + '.json'), 'utf8'));
  } catch { return null; }
}

// State is per PROJECT, but keep-alives and handoff flags describe one SESSION.
// They used to latch across sessions: one context handoff left
// contextHandoffFired=true for six days, so every later session was told a handoff
// had been written, and decide() skipped the context triggers entirely. The state
// now records which session its counters belong to, and a different session reads
// them as zero. Missing sessionId (pre-fix state) counts as a different session.
const SESSION_FIELDS = { pings: 0, handoffFired: false, contextHandoffFired: false, usageHandoffWindow: null };

// Those fields are kept per session in st.sessions[id]: with only the
// top-level copy, a second chat in the same project zeroed them on its first record,
// so chat A re-fired a context handoff onto an expired cache 2.5 h after its first.
// The top-level copy still mirrors the last session that recorded; it is only read
// for state written before the map existed.
function sessionFields(st, sessionId) {
  const out = Object.assign({}, SESSION_FIELDS);
  if (!sessionId) return out;
  const src = (st.sessions && st.sessions[sessionId]) || (st.sessionId === sessionId ? st : null);
  if (src) for (const k of Object.keys(SESSION_FIELDS)) if (src[k] != null) out[k] = src[k];
  return out;
}

function sessionScoped(st, sessionId) {
  return Object.assign({}, st, sessionFields(st, sessionId));
}

// A healthy loop records every intervalMin (or every 5 min inside the 35-40%
// window, which is more often). One that has not checked in for intervalMin + 15
// has missed the 60-min cache boundary it exists to protect, so it has failed at its
// job, however late a wake-up eventually lands.
const OVERDUE_GRACE_MIN = 15;
const DEFAULT_INTERVAL_MIN = 45;

function loopAgeMin(st, nowMs) {
  if (!st.lastCheck) return null;
  const t = Date.parse(st.lastCheck);
  if (!isFinite(t)) return null;
  return (nowMs - t) / 60000;
}

function isLoopOverdue(st, nowMs) {
  if (!st.loopRunning) return false;            // not claiming to run; nothing to be overdue
  const ageMin = loopAgeMin(st, nowMs);
  if (ageMin == null) return true;              // claims running but never checked in
  return ageMin > (st.intervalMin || DEFAULT_INTERVAL_MIN) + OVERDUE_GRACE_MIN;
}

/** Everything the status bar needs. now is injectable so tests are deterministic.
 *  sessionId (optional) pins the transcript to the calling session; monitor.js
 *  passes CLAUDE_CODE_SESSION_ID. Ignored unless that transcript is in this
 *  project, so a shell from another session can't misattribute its own id. */
function computeStatus(workspacePath, now = Date.now(), sessionId = null) {
  const proj = resolveProjectDir(workspacePath) || newestProjectDirAnywhere();
  if (!proj) return { ok: false, reason: 'no project transcripts found' };

  const pinned = sessionId ? path.join(proj.dir, sessionId + '.jsonl') : null;
  // A brand-new session has no transcript until its first message. Falling back to
  // the newest transcript then reads ANOTHER session as this one: the cache-monitor
  // mod in a just-opened tab saw an old idle session, submitted /handoff into the
  // empty tab, and wrote "idle, no work done" handoffs. An id with
  // no transcript in any project is that case; an id found in another project is a
  // shell from a different session, which still falls back as before.
  if (pinned && !fs.existsSync(pinned) && !transcriptExistsAnywhere(sessionId)) {
    return { ok: false, reason: 'this session has no transcript yet' };
  }
  const file = pinned && fs.existsSync(pinned) ? pinned : newestTranscript(proj.dir);
  if (!file) return { ok: false, reason: 'no session transcript yet' };
  const sid = path.basename(file, '.jsonl');

  const { usage, lastUser } = readSession(file);
  if (!usage) return { ok: false, reason: 'no usage data in session yet' };

  const u = usage.u;
  const prefix = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) +
                 (u.cache_creation_input_tokens || 0);
  const m = modelInfo(usage.model);

  const ageMs = now - Date.parse(usage.ts);
  const remainMs = CACHE_TTL_MIN * 60000 - ageMs;
  const expired = remainMs <= 0;

  // Warm: pay a cache read (0.1x). Expired: pay a 1-hour cache write (2x).
  const costUsd = (prefix / 1e6) * m.input * (expired ? 2 : 0.1);
  const ctxPct = prefix / usableContext(m.ctx);

  const raw = readState(proj.slug) || {};
  const st = sessionScoped(raw, sid);
  const overdue = isLoopOverdue(raw, now);
  return {
    ok: true,
    slug: proj.slug,
    sessionId: sid,
    anchored: proj.anchored,
    ambiguous: multipleActiveTranscripts(proj.dir, now),
    model: usage.model,
    prefixTokens: prefix,
    ctxPct,
    ctxState: ctxPct >= CTX_CEIL ? 'ceiling' : ctxPct >= CTX_WARN ? 'window' : 'normal',
    // Show our percentage only while Claude Code's own pill is hidden.
    showCtx: ctxPct <= CC_PILL_SHOWS_ABOVE,
    remainMs: Math.max(0, remainMs),
    expired,
    costUsd,
    pings: st.pings || 0,
    pingCap: st.pingCap == null ? 1 : st.pingCap,
    handoffFired: !!st.handoffFired,
    // Effective: an overdue loop is not doing its job, so it must not read as
    // running (the status bar and the mod's re-arm both key off this).
    loopRunning: !!raw.loopRunning && !overdue,
    loopOverdue: overdue,
    // No typed message at all: a chat opened with a slash command (/resume-handoff)
    // and then run on its own reported idle as null, so the keep-alive and idle
    // handoff never fired and the cache lapsed. Fall back to Claude's
    // last reply. The keep-alive fork never lands in the transcript, so this still
    // gives the ~2h keep-alive -> handoff sequence.
    idleMin: Math.round((now - Date.parse(lastUser || usage.ts)) / 60000),
  };
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function fmtCost(usd) {
  return usd < 1 ? '~' + Math.round(usd * 100) + '¢' : '~$' + usd.toFixed(2);
}

function renderLabel(s) {
  if (!s.ok) return '$(clock) cache --';
  const clock = s.expired ? 'EXPIRED' : fmtDuration(s.remainMs);
  const parts = ['$(clock) ' + clock];
  const modelLabel = shortModelLabel(s.model);
  if (modelLabel) parts.push(modelLabel);
  // Below 50% Claude Code shows nothing, so we show the percentage. Above 50%
  // its own pill takes over and we drop ours to avoid two numbers on screen.
  if (s.showCtx) parts.push('ctx ' + Math.round(s.ctxPct * 100) + '%');
  parts.push(fmtCost(s.costUsd));
  if (s.ctxState === 'ceiling') parts.push('handoff due');
  else if (s.ctxState === 'window') parts.push('handoff window');
  // Keep-alive count moved to its own status bar item (renderLoopLabel) — it used
  // to render here only while loopRunning, which meant the one state the user most
  // needed to see ("the monitor is OFF") was the one state that showed nothing.
  return parts.join(' · ') + (s.anchored === false || s.ambiguous ? ' ?' : '');
}

// Below this the session is a quick one-off and the monitor is legitimately off,
// so "off" is not worth colouring. This threshold only drives the colour.
const AUTOSTART_MIN_PCT = 0.10;

/** Second status bar item: is the monitor alive? Always renders a state — never
 *  goes blank, which is the whole point of splitting it out. */
function renderLoopLabel(s) {
  if (!s.ok) return '$(circle-slash) monitor --';
  // Claims to run but has stopped checking in: its wake-up is being held or is far
  // behind. Distinct from "off" so the reason is visible, not just the absence.
  if (s.loopOverdue) return '$(warning) monitor overdue';
  if (s.loopRunning) {
    const label = '$(pulse) monitor ' + s.pings + '/' + s.pingCap;
    return s.handoffFired ? label + ' · $(check) handoff' : label;
  }
  return '$(circle-slash) monitor off';
}

/** Amber only when it is off and the session is big enough that it should be on. */
function loopSeverity(s) {
  if (!s.ok || s.loopRunning) return 'none';
  if (s.loopOverdue) return 'warning';
  return s.ctxPct >= AUTOSTART_MIN_PCT ? 'warning' : 'none';
}

/** Red for anything needing action now; amber for approaching. */
function severity(s) {
  if (!s.ok) return 'none';
  if (s.expired || s.ctxState === 'ceiling') return 'error';
  if (s.ctxState === 'window' || s.remainMs <= 5 * 60000) return 'warning';
  return 'none';
}

module.exports = {
  computeStatus, renderLabel, severity, renderLoopLabel, loopSeverity, AUTOSTART_MIN_PCT,
  sessionScoped, sessionFields, SESSION_FIELDS, isLoopOverdue, loopAgeMin, OVERDUE_GRACE_MIN, DEFAULT_INTERVAL_MIN,
  fmtDuration, fmtCost,
  resolveProjectDir, newestProjectDirAnywhere, newestTranscript, multipleActiveTranscripts, AMBIGUOUS_WINDOW_MS,
  tailLines, isGenuineUserMessage, readSession, readUsage, findLastUserTs, modelInfo, shortModelLabel,
  usableContext, MAX_OUTPUT_RESERVE, WORKING_MARGIN, CC_PILL_SHOWS_ABOVE,
  CACHE_TTL_MIN, CTX_WARN, CTX_CEIL, STATE_DIR, PROJECTS_DIR,
};
