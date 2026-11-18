'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const core = require('./progress-core');

const DISMISSED_KEY = 'claudeProgress.dismissed';
const TICK_MS = 5000;
const DEBOUNCE_MS = 300;
let runtime = null;

// Label of the Claude chat tab in front of the active editor group, or null when
// that tab is not a Claude chat. The webview viewType arrives prefixed
// ("mainThreadWebview-claudeVSCodePanel"), hence the suffix test.
function activeChatLabel() {
  try {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const viewType = tab && tab.input && tab.input.viewType;
    return typeof viewType === 'string' && /claudeVSCodePanel$/.test(viewType) && typeof tab.label === 'string'
      ? tab.label : null;
  } catch { return null; }
}

class ProgressViewProvider {
  constructor(context, refresh) {
    this.context = context;
    this.refresh = refresh;
    this.view = null;
    this.model = { chats: [], status: null };
    this.signature = null;
    const stored = context.globalState.get(DISMISSED_KEY, {});
    this.dismissed = Object.assign(Object.create(null),
      stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {});
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.signature = null;
    this.context.subscriptions.push(
      view.webview.onDidReceiveMessage(message => {
        if (!message || message.type !== 'dismiss' || typeof message.sessionId !== 'string') return;
        const chat = this.model.chats.find(chat => chat.sessionId === message.sessionId);
        if (!chat) return;
        if (this.dismissed[message.sessionId] !== chat.updatedAt) {
          this.dismissed[message.sessionId] = chat.updatedAt;
          this.saveDismissed();
        }
        this.refresh();
      }),
      view.onDidDispose(() => { if (this.view === view) this.view = null; }),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.refresh();
      })
    );
    this.update(this.model);
    this.refresh();
  }

  update(model) {
    this.model = model;
    if (!this.view) return;
    const signature = JSON.stringify(model.chats);
    if (signature === this.signature) return;
    // Commit the signature only after successful rendering.
    this.view.webview.html = core.renderHtml(model);
    this.signature = signature;
  }

  saveDismissed() {
    // Save a snapshot only after a map change; never log titles.
    void this.context.globalState.update(DISMISSED_KEY, { ...this.dismissed }).then(undefined, () => {});
  }
}

function activate(context) {
  deactivate();
  const cache = core.createCache();
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  item.command = 'claudeProgress.focus';
  const state = { item, cache, watcher: null, timer: null, debounce: null, stopped: false, provider: null };
  runtime = state;

  function watch() {
    if (state.stopped || state.watcher) return;
    try {
      state.watcher = fs.watch(core.PROGRESS_DIR, () => {
        clearTimeout(state.debounce);
        state.debounce = setTimeout(refresh, DEBOUNCE_MS);
      });
      state.watcher.on('error', () => {
        if (state.watcher) state.watcher.close();
        state.watcher = null;
      });
    } catch { /* The fallback tick retries after the directory becomes available. */ }
  }

  function refresh() {
    if (state.stopped) return;
    try {
      watch();
      const now = Date.now();
      const sessions = core.listSessions(core.PROGRESS_DIR, cache);
      core.housekeeping(core.PROGRESS_DIR, sessions, cache, now);
      let dismissalsChanged = false;
      for (const sid of Object.keys(state.provider.dismissed)) {
        if (!fs.existsSync(path.join(core.PROGRESS_DIR, sid + '.json'))) {
          delete state.provider.dismissed[sid];
          dismissalsChanged = true;
        }
      }
      if (dismissalsChanged) state.provider.saveDismissed();
      const model = core.buildViewModel(sessions, {
        now, dismissed: state.provider.dismissed, titles: cache.titles, activeLabel: activeChatLabel(),
      });
      state.provider.update(model);
      const chat = model.status;
      if (!chat) { item.hide(); return; }
      item.text = '$(checklist) ' + Number(chat.overallPct).toLocaleString('en-US') + '%';
      // A plain tooltip treats model titles as text rather than Markdown.
      item.tooltip = chat.title + '\n' + chat.tasks[chat.currentTask].title + '\n' + core.tasksLeftLabel(chat);
      item.show();
    } catch { /* A progress failure cannot interrupt cache/monitor status updates. */ }
  }

  state.provider = new ProgressViewProvider(context, refresh);
  context.subscriptions.push(
    item,
    { dispose: deactivate },
    vscode.window.registerWebviewViewProvider('claudeProgress.timeline', state.provider),
    vscode.commands.registerCommand('claudeProgress.focus', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.claudeProgress');
      await vscode.commands.executeCommand('claudeProgress.timeline.focus');
    })
  );
  // Re-highlight as soon as the user switches chat tabs, not on the next 5-second tick.
  try {
    const groups = vscode.window.tabGroups;
    if (groups && typeof groups.onDidChangeTabs === 'function') {
      context.subscriptions.push(groups.onDidChangeTabs(() => refresh()), groups.onDidChangeTabGroups(() => refresh()));
    }
  } catch { /* Older hosts without the tab API keep the timed refresh only. */ }
  refresh();
  state.timer = setInterval(refresh, TICK_MS);
}

function deactivate() {
  if (!runtime) return;
  const state = runtime;
  runtime = null;
  state.stopped = true;
  clearInterval(state.timer);
  clearTimeout(state.debounce);
  if (state.watcher) state.watcher.close();
  state.item.dispose();
}

module.exports = { activate, deactivate, ProgressViewProvider };
