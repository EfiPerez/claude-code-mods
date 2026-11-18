'use strict';

// File contracts and presentation only; this module also runs in plain Node.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PROGRESS_DIR = path.join(os.homedir(), '.claude', 'task-progress');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const OPEN_MS = 3 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const number = n => Number(n).toLocaleString('en-US');

function createCache() {
  return { files: new Map(), titles: new Map() };
}

function isProgress(value, sid) {
  if (!value || value.v !== 1 || value.sessionId !== sid ||
      !['active', 'done'].includes(value.state) || typeof value.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.updatedAt)) ||
      typeof value.projectRoot !== 'string' ||
      (value.label != null && (typeof value.label !== 'string' || Array.from(value.label).length > 60)) ||
      !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 30) return false;
  let done = 0;
  let total = 0;
  let tasksDone = 0;
  let activeTask = null;
  let firstPendingTask = null;
  for (let i = 0; i < value.tasks.length; i++) {
    const task = value.tasks[i];
    if (!task || typeof task.title !== 'string' || Array.from(task.title).length > 80 ||
        !Array.isArray(task.steps) || task.steps.length < 1 || task.steps.length > 20) return false;
    let complete = true;
    for (const step of task.steps) {
      if (!step || typeof step.title !== 'string' || Array.from(step.title).length > 80 ||
          !['done', 'active', 'pending'].includes(step.status)) return false;
      total++;
      if (step.status === 'done') done++;
      else {
        complete = false;
        if (firstPendingTask === null) firstPendingTask = i;
      }
      if (step.status === 'active') {
        if (activeTask !== null) return false;
        activeTask = i;
      }
    }
    if (complete) tasksDone++;
  }
  const current = activeTask === null ? firstPendingTask : activeTask;
  const task = current === null ? null : value.tasks[current];
  return value.currentTask === current && value.tasksDone === tasksDone &&
    value.tasksTotal === value.tasks.length && value.overallPct === pct(done, total) &&
    value.currentPct === (task ? pct(task.steps.filter(s => s.status === 'done').length, task.steps.length) : null) &&
    value.state === (done === total ? 'done' : 'active');
}

function pct(done, total) {
  return done === total ? 100 : Math.min(99, Math.round(100 * done / total));
}

function readJson(file, cache, validate = () => true) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validate(value)) throw new Error('Invalid progress contract');
    cache.set(file, value);
    return value;
  } catch {
    return cache.get(file) || null;
  }
}

function listSessions(directory, cache) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { cache.files.clear(); return []; }
  const files = new Set();
  const sessions = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^(.*)\.(alive|json)$/.exec(entry.name);
    if (!match || !SESSION_ID.test(match[1])) continue;
    const [, sid, kind] = match;
    const file = path.join(directory, entry.name);
    files.add(file);
    const value = readJson(file, cache.files, kind === 'json'
      ? data => isProgress(data, sid)
      : data => data && Number.isFinite(Date.parse(data.aliveAt)) && typeof data.projectRoot === 'string');
    if (!sessions.has(sid)) sessions.set(sid, { sessionId: sid, alive: null, progress: null });
    sessions.get(sid)[kind === 'alive' ? 'alive' : 'progress'] = value;
  }
  for (const file of cache.files.keys()) if (!files.has(file)) cache.files.delete(file);
  return Array.from(sessions.values());
}

function isOpen(alive, now = Date.now()) {
  if (!alive || alive.state === 'ended') return false;
  const age = now - Date.parse(alive.aliveAt);
  return Number.isFinite(age) && age >= 0 && age <= OPEN_MS;
}

function housekeeping(directory, sessions, cache, now = Date.now()) {
  const removed = [];
  for (const session of sessions) {
    if (!session.alive || now - Date.parse(session.alive.aliveAt) <= RETENTION_MS) continue;
    if (!SESSION_ID.test(session.sessionId)) continue;
    for (const suffix of ['alive', 'json']) {
      const file = path.join(directory, session.sessionId + '.' + suffix);
      try { fs.unlinkSync(file); removed.push(file); cache.files.delete(file); } catch {}
    }
    cache.titles.delete(session.sessionId);
  }
  return removed;
}

function findTranscript(projectsDir, sid) {
  if (!SESSION_ID.test(sid)) return null;
  let entries;
  try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(projectsDir, entry.name, sid + '.jsonl');
    try { if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

function promptText(record) {
  if (record.type !== 'user' || record.isMeta) return null;
  const content = record.message && record.message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n') : '';
  const trimmed = text.trim();
  return trimmed ? Array.from(trimmed).slice(0, 60).join('') : null;
}

function consumeTitleLine(line, metadata) {
  // Do not JSON-parse assistant/tool traffic. User content is inspected only until
  // the first prompt is found; it is never retained beyond its 60-char label.
  const titleLine = /"type"\s*:\s*"(?:custom-title|ai-title)"/.test(line);
  const userLine = metadata.firstPrompt === null && /"type"\s*:\s*"user"/.test(line);
  if (!titleLine && !userLine) return;
  let record;
  try { record = JSON.parse(line); } catch { return; }
  if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
    metadata.lastCustomTitle = record.customTitle;
  } else if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
    metadata.lastAiTitle = record.aiTitle;
  } else if (userLine && metadata.firstPrompt === null) {
    metadata.firstPrompt = promptText(record);
  }
}

function scanTitle(file, previous) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const identity = stat.dev + ':' + stat.ino + ':' + stat.birthtimeMs;
    const metadata = !previous || previous.file !== file || previous.identity !== identity || stat.size < previous.offset
      ? { file, identity, offset: 0, lastCustomTitle: null, lastAiTitle: null, firstPrompt: null }
      : Object.assign({}, previous);
    let position = metadata.offset;
    let tail = Buffer.alloc(0);
    const chunk = Buffer.alloc(64 * 1024);
    while (position < stat.size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (!count) break;
      position += count;
      const data = Buffer.concat([tail, chunk.subarray(0, count)]);
      let start = 0;
      let newline;
      while ((newline = data.indexOf(10, start)) !== -1) {
        consumeTitleLine(data.subarray(start, newline).toString('utf8'), metadata);
        metadata.offset += newline + 1 - start;
        start = newline + 1;
      }
      tail = Buffer.from(data.subarray(start));
    }
    // Deliberately leave a partial final record unconsumed, including on scan 1.
    return metadata;
  } catch { return previous || null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function chatTitle(sessionId, fallback, projectsDir, titles) {
  let metadata = titles.get(sessionId);
  let file = metadata && metadata.file;
  if (!file || !fs.existsSync(file)) file = findTranscript(projectsDir, sessionId);
  if (file) {
    metadata = scanTitle(file, metadata);
    if (metadata) titles.set(sessionId, metadata);
  }
  return (metadata && (metadata.lastCustomTitle ?? metadata.lastAiTitle ?? metadata.firstPrompt)) ?? fallback ?? 'Untitled';
}

function ageLabel(updatedAt, now) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 60000));
  if (!minutes) return 'just now';
  if (minutes < 60) return number(minutes) + ' min ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return number(hours) + ' h ago';
  return number(Math.floor(hours / 24)) + ' d ago';
}

// Claude Code's chat tab label is the session title cut by its webview (2.1.327
// FWe(): over 25 chars -> first 24 UTF-16 units + an ellipsis). VS Code exposes no
// session id for the focused chat, so the view matches that label instead; two
// chats whose titles share the cut label both get highlighted.
function tabLabel(title) {
  if (!title) return 'Claude Code';
  return title.length > 25 ? title.substring(0, 24) + '…' : title;
}

function buildViewModel(sessions, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const activeLabel = typeof options.activeLabel === 'string' ? options.activeLabel : null;
  const dismissed = options.dismissed && typeof options.dismissed === 'object' && !Array.isArray(options.dismissed)
    ? options.dismissed : {};
  const titles = options.titles || new Map();
  const projectsDir = options.projectsDir || PROJECTS_DIR;
  const chats = sessions.filter(s => isOpen(s.alive, now) && isProgress(s.progress, s.sessionId))
    .sort((a, b) => Date.parse(b.progress.updatedAt) - Date.parse(a.progress.updatedAt) || a.sessionId.localeCompare(b.sessionId))
    .map(session => {
      const progress = session.progress;
      // The heading shows the tool's label (the real main task, e.g. a resumed
      // handoff's goal) when Claude set one; the chat title - often just the first
      // command, like "/resume-handoff" - is the fallback. Focus matching must keep
      // using the chat title, because that is what the VS Code tab shows.
      const chat = chatTitle(session.sessionId, progress.label, projectsDir, titles);
      const label = typeof progress.label === 'string' ? progress.label.trim() : '';
      return Object.assign({}, progress, {
        title: label || chat,
        focused: activeLabel !== null && tabLabel(chat) === activeLabel,
        projectName: progress.projectRoot.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || progress.projectRoot,
        tasksLeft: progress.tasksTotal - progress.tasksDone,
        age: ageLabel(progress.updatedAt, now),
      });
    });
  const liveIds = new Set(sessions.filter(s => isOpen(s.alive, now)).map(s => s.sessionId));
  for (const sid of titles.keys()) if (!liveIds.has(sid)) titles.delete(sid);
  const visibleChats = chats.filter(chat => dismissed[chat.sessionId] !== chat.updatedAt);
  return { chats: visibleChats, status: visibleChats.find(chat => chat.state === 'active') || null };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function tasksLeftLabel(chat) {
  return number(chat.tasksLeft) + ' of ' + number(chat.tasksTotal) + ' tasks left';
}

function renderChat(chat) {
  const clear = '<button class="clear" data-dismiss="' + escapeHtml(chat.sessionId) + '" aria-label="Clear chat">&times;</button>';
  const focusTag = chat.focused ? '<span class="here">This chat</span>' : '';
  if (chat.state === 'done') {
    return '<section class="completed' + (chat.focused ? ' focused' : '') + '"><span>&#10004; ' + escapeHtml(chat.title) +
      ' &mdash; done' + focusTag + '</span>' + clear + '</section>';
  }
  const tasks = chat.tasks.map((task, index) => {
    const done = task.steps.every(step => step.status === 'done');
    const current = index === chat.currentTask;
    let detail = '';
    if (current) {
      const active = task.steps.findIndex(step => step.status === 'active');
      const next = task.steps.find(step => step.status === 'pending');
      detail = active >= 0
        ? 'step ' + number(active + 1) + ' of ' + number(task.steps.length) + ': ' + task.steps[active].title
        : 'next: ' + (next ? next.title : '');
    }
    // The current task lists every step, so steps still to come are visible too.
    const steps = current ? '<ol class="steps">' + task.steps.map(step =>
      '<li class="step ' + step.status + '"><span class="sub-dot" aria-hidden="true">' +
      (step.status === 'done' ? '&#9679;' : step.status === 'active' ? '&#9673;' : '&#9675;') + '</span>' +
      '<span>' + escapeHtml(step.title) + '</span></li>').join('') + '</ol>' : '';
    return '<li class="' + (done ? 'done' : current ? 'current' : 'pending') + '">' +
      '<span class="dot" aria-hidden="true">' + (done ? '&#9679;' : current ? '&#9673;' : '&#9675;') + '</span>' +
      '<div class="task"><div class="task-heading"><span>' + escapeHtml(task.title) + '</span>' +
      '<span class="task-state">' + (done ? 'done' : current ? number(chat.currentPct) + '%' : '') + '</span></div>' +
      (detail ? '<div class="detail">' + escapeHtml(detail) + '</div>' : '') + steps + '</div></li>';
  }).join('');
  return '<section' + (chat.focused ? ' class="focused"' : '') + '><div class="chat-header"><details open data-session="' + escapeHtml(chat.sessionId) + '">' +
    '<summary><span class="title">' + escapeHtml(chat.title) + focusTag + '</span><span class="percent">' + number(chat.overallPct) + '%</span>' +
    '<span class="bar" role="progressbar" aria-label="Overall progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + chat.overallPct + '">' +
    '<progress max="100" value="' + chat.overallPct + '"></progress></span></summary>' +
    '<div class="meta">' + escapeHtml(chat.projectName) + ' &middot; ' + tasksLeftLabel(chat) + ' &middot; ' + escapeHtml(chat.age) + '</div>' +
    '<ol class="timeline">' + tasks + '</ol></details>' + clear + '</div></section>';
}

function renderHtml(model, nonce = crypto.randomBytes(18).toString('hex')) {
  // Nonce appears in a CSP attribute as well as style/script attributes.
  if (!/^[a-zA-Z0-9_-]+$/.test(nonce)) throw new Error('Invalid nonce');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Claude Progress</title><style nonce="${nonce}">
:root { color-scheme: light dark; --current:#f6a074; --done:#65d3ac; --pending:#cccbcd; --accent:#ff94c9; --warn:#fcaa57; }
body { padding:12px; margin:0; background:var(--vscode-sideBar-background); color:var(--vscode-sideBar-foreground, var(--vscode-foreground)); font-family:var(--vscode-font-family); font-size:var(--vscode-font-size); }
section { margin-bottom:18px; padding-bottom:14px; border-bottom:1px solid var(--vscode-panel-border); }
.chat-header { display:flex; align-items:flex-start; gap:6px; } details { flex:1; min-width:0; }
summary { cursor:pointer; display:flex; align-items:center; gap:8px; flex-wrap:wrap; } .title { flex:1; min-width:80px; overflow-wrap:anywhere; font-weight:600; }
.percent { color:var(--current); } .bar { flex-basis:100%; } progress { display:block; width:100%; height:4px; border:0; background:var(--vscode-progressBar-background, var(--pending)); accent-color:var(--current); }
progress::-webkit-progress-bar { background:var(--vscode-editorWidget-background); } progress::-webkit-progress-value { background:var(--current); }
.meta,.detail { color:var(--vscode-descriptionForeground); font-size:0.9em; margin-top:6px; overflow-wrap:anywhere; }
.clear { flex:none; border:0; background:transparent; color:var(--vscode-descriptionForeground); cursor:pointer; font-size:18px; padding:0 3px; } .clear:hover { color:var(--accent); }
button:focus-visible,summary:focus-visible { outline:1px solid var(--vscode-focusBorder, var(--warn)); outline-offset:2px; }
.timeline { padding:0; margin:16px 0 0; list-style:none; } li { position:relative; display:flex; gap:9px; padding-bottom:17px; }
li:not(:last-child)::before { content:''; position:absolute; left:7px; top:17px; bottom:0; width:1px; background:var(--pending); }
.dot { flex:none; width:15px; text-align:center; font-size:16px; line-height:18px; } .done .dot,.done .task-state,.completed { color:var(--done); }
.current .dot,.current .task-state { color:var(--current); } .pending .dot { color:var(--pending); } .task { flex:1; min-width:0; }
.task-heading { display:flex; gap:8px; justify-content:space-between; overflow-wrap:anywhere; } .task-state { flex:none; } .completed { display:flex; gap:8px; align-items:center; justify-content:space-between; overflow-wrap:anywhere; }
.empty { color:var(--vscode-descriptionForeground); }
section.focused { margin-left:-12px; margin-right:-12px; padding:10px 12px 14px 9px; border-left:3px solid var(--current); background:color-mix(in srgb, var(--current) 10%, transparent); }
.here { display:inline-block; margin-left:6px; padding:0 6px; border-radius:8px; background:var(--current); color:#000000; font-size:0.8em; font-weight:600; vertical-align:middle; }
.steps { list-style:none; padding:0; margin:6px 0 0; } li.step { display:flex; gap:7px; padding:2px 0 0; font-size:0.9em; color:var(--vscode-descriptionForeground); overflow-wrap:anywhere; }
li.step::before { content:none; } .sub-dot { flex:none; width:11px; text-align:center; font-size:11px; line-height:16px; }
.step.done .sub-dot { color:var(--done); } .step.active .sub-dot { color:var(--current); } .step.pending .sub-dot { color:var(--pending); } .step.active { color:inherit; }
</style></head><body>${model.chats.length ? model.chats.map(renderChat).join('') : '<p class="empty">No multi-step work in progress.</p>'}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
const collapsed = new Set(Array.isArray(saved.collapsed) ? saved.collapsed : []);
document.querySelectorAll('details[data-session]').forEach(details => {
  details.open = !collapsed.has(details.dataset.session);
  details.addEventListener('toggle', () => {
    if (details.open) collapsed.delete(details.dataset.session); else collapsed.add(details.dataset.session);
    vscode.setState({ collapsed: Array.from(collapsed) });
  });
});
document.querySelectorAll('[data-dismiss]').forEach(button => {
  button.addEventListener('click', () => vscode.postMessage({ type: 'dismiss', sessionId: button.dataset.dismiss }));
});
</script></body></html>`;
}

module.exports = {
  PROGRESS_DIR, PROJECTS_DIR, OPEN_MS, RETENTION_MS, createCache, pct,
  isProgress, readJson, listSessions, isOpen, housekeeping, findTranscript,
  promptText, consumeTitleLine, scanTitle, chatTitle, ageLabel, buildViewModel,
  escapeHtml, tasksLeftLabel, renderChat, renderHtml, tabLabel,
};
