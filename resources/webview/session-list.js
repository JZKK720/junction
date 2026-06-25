/**
 * session-list.js — Grouped, collapsible chats list for Junction
 *
 * Renders collapsible session groups into #session-list-items.
 * Consumes the grouped `renderSessions` payload: { groups:[{id,label,collapsed,
 * sessions[]}], activeKey }. Collapse state persists via vscode webview state.
 * Re-renders only when content actually changes (kills the reload/flicker).
 *
 * postMessage → extension:
 *   resumeSession  { key }
 *   createChat     { text?: string }
 *   setChatScope   { scope }
 */

var chatScope = 'folder';
var _lastSig = null;
var _collapse = loadCollapse();
var _taskHistory = null;

// ── Collapse persistence (per group id) ─────────────────────────────
function loadCollapse() {
  try { var s = vscode.getState && vscode.getState(); return (s && s.collapse) || {}; }
  catch (e) { return {}; }
}
function saveCollapse() {
  try { var s = (vscode.getState && vscode.getState()) || {}; s.collapse = _collapse; vscode.setState && vscode.setState(s); }
  catch (e) { /* no-op */ }
}
function isCollapsed(group) {
  if (Object.prototype.hasOwnProperty.call(_collapse, group.id)) return !!_collapse[group.id];
  return !!group.collapsed;
}

// ── Exported render (called by view-router + message listener) ──────
function renderGroups(groups, activeKey) {
  var container = document.getElementById('session-list-items');
  if (!container) return;
  renderGroupsInto(container, groups, activeKey, { signature: true });
}

function renderGroupsInto(container, groups, activeKey, opts) {
  opts = opts || {};
  groups = Array.isArray(groups) ? groups : [];

  // Skip redundant re-renders (no flicker on no-op refreshes).
  var sig = JSON.stringify({
    a: activeKey || null,
    g: groups.map(function (g) {
      return {
        i: g.id, c: isCollapsed(g),
        s: (g.sessions || []).map(function (s) { return [s.key, s.title, !!s.isActive, !!s.isArchived, s.model || '']; })
      };
    })
  });
  if (opts.signature) {
    if (sig === _lastSig) return;
    _lastSig = sig;
  }

  var total = groups.reduce(function (n, g) { return n + ((g.sessions || []).length); }, 0);
  if (!total) {
    container.innerHTML = '<div class="session-card-empty">' + window.junctionT('noChatsYet', 'No chats yet') + '</div>';
    return;
  }

  container.innerHTML = '';
  if (opts.flat) {
    groups.forEach(function (group) {
      (group.sessions || []).forEach(function (s) { container.appendChild(makeCard(s, activeKey, opts)); });
    });
    return;
  }
  groups.forEach(function (group) {
    var collapsed = isCollapsed(group);
    var groupEl = document.createElement('div');
    groupEl.className = 'session-group' + (collapsed ? ' collapsed' : '');
    groupEl.setAttribute('data-group', group.id);

    var header = document.createElement('button');
    header.className = 'session-group-header';
    header.title = window.junctionT(collapsed ? 'expand' : 'collapse', collapsed ? 'Expand' : 'Collapse') + ' ' + (group.label || window.junctionT('group', 'group'));
    header.innerHTML =
      '<span class="codicon codicon-chevron-down session-group-caret"></span>' +
      '<span class="session-group-label"></span>' +
      '<span class="session-group-count"></span>';
    header.querySelector('.session-group-label').textContent = group.label || group.id;
    header.querySelector('.session-group-count').textContent = String((group.sessions || []).length);
    header.addEventListener('click', function () {
      var nowCollapsed = !groupEl.classList.contains('collapsed');
      groupEl.classList.toggle('collapsed', nowCollapsed);
      _collapse[group.id] = nowCollapsed;
      saveCollapse();
      header.title = window.junctionT(nowCollapsed ? 'expand' : 'collapse', nowCollapsed ? 'Expand' : 'Collapse') + ' ' + (group.label || window.junctionT('group', 'group'));
    });
    groupEl.appendChild(header);

    var body = document.createElement('div');
    body.className = 'session-group-body';
    (group.sessions || []).forEach(function (s) { body.appendChild(makeCard(s, activeKey, opts)); });
    groupEl.appendChild(body);

    container.appendChild(groupEl);
  });
}

function makeCard(s, activeKey, opts) {
  opts = opts || {};
  var card = document.createElement('div');
  card.className = 'session-card';
  if (s.isActive || s.key === activeKey) card.classList.add('active');
  if (s.isArchived) card.classList.add('archived');
  card.setAttribute('data-key', s.key);

  var titleEl = document.createElement('div');
  titleEl.className = 'session-card-title';
  titleEl.textContent = s.title || window.junctionT('untitled', 'Untitled');
  card.appendChild(titleEl);

  var meta = document.createElement('div');
  meta.className = 'session-card-meta';
  if (s.model) {
    var badge = document.createElement('span');
    badge.className = 'session-card-model';
    badge.textContent = s.model;
    meta.appendChild(badge);
  }
  if (s.messageCount !== undefined && s.messageCount !== null) {
    var cnt = document.createElement('span');
    cnt.className = 'session-card-count';
    cnt.textContent = s.messageCount === 1
      ? window.junctionT('messageSingular', '1 msg')
      : window.junctionT('messagesPlural', '{count} msgs', { count: s.messageCount });
    meta.appendChild(cnt);
  }
  if (s.isArchived) {
    var arch = document.createElement('span');
    arch.className = 'session-card-archived-badge';
    arch.textContent = window.junctionT('archived', 'archived');
    meta.appendChild(arch);
  }
  if (meta.childNodes.length) card.appendChild(meta);

  card.addEventListener('click', function () {
    vscode.postMessage({ type: 'resumeSession', key: s.key });
    if (typeof opts.onSelect === 'function') opts.onSelect();
  });
  return card;
}

function filterGroups(groups, query) {
  var q = String(query || '').trim().toLowerCase();
  if (!q) return groups || [];
  return (groups || []).map(function (group) {
    return Object.assign({}, group, {
      sessions: (group.sessions || []).filter(function (s) {
        return String(s.title || '').toLowerCase().indexOf(q) >= 0 ||
          String(s.model || '').toLowerCase().indexOf(q) >= 0 ||
          String(s.key || '').toLowerCase().indexOf(q) >= 0;
      })
    });
  }).filter(function (group) { return (group.sessions || []).length > 0; });
}

function closeTaskHistoryPopover() {
  if (_taskHistory && _taskHistory.root && _taskHistory.root.parentNode) _taskHistory.root.remove();
  document.removeEventListener('click', onTaskHistoryOutside, true);
  _taskHistory = null;
}

function onTaskHistoryOutside(event) {
  if (!_taskHistory || !_taskHistory.root) return;
  if (_taskHistory.root.contains(event.target) || (_taskHistory.trigger && _taskHistory.trigger.contains(event.target))) return;
  closeTaskHistoryPopover();
}

function renderTaskHistoryBody() {
  if (!_taskHistory) return;
  _taskHistory.tabs.forEach(function (tab) {
    var active = tab.getAttribute('data-scope') === _taskHistory.scope;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  var groups = filterGroups(_taskHistory.groups, _taskHistory.query);
  renderGroupsInto(_taskHistory.list, groups, _taskHistory.activeKey, {
    onSelect: closeTaskHistoryPopover,
    compact: true,
    flat: _taskHistory.scope === 'folder'
  });
}

function requestTaskHistory(scope) {
  if (!_taskHistory) return;
  _taskHistory.scope = scope === 'all' ? 'all' : 'folder';
  _taskHistory.groups = [];
  _taskHistory.activeKey = null;
  _taskHistory.list.innerHTML = '<div class="session-card-empty">' + window.junctionT('loadingThreads', 'Loading threads...') + '</div>';
  renderTaskHistoryBody();
  vscode.postMessage({ type: 'requestTaskHistory', scope: _taskHistory.scope });
}

function openTaskHistoryPopover(trigger) {
  if (_taskHistory) {
    closeTaskHistoryPopover();
    return;
  }
  var root = document.createElement('div');
  root.className = 'task-history-popover';
  root.innerHTML =
    '<div class="task-history-tabs" role="tablist">' +
      '<button class="task-history-tab active" data-scope="folder" role="tab" aria-selected="true"><span class="codicon codicon-device-desktop"></span><span>Workspace</span></button>' +
      '<button class="task-history-tab" data-scope="all" role="tab" aria-selected="false"><span class="codicon codicon-globe"></span><span>All threads</span></button>' +
    '</div>' +
    '<div class="task-history-search"><span class="codicon codicon-search"></span><input type="search" placeholder="' + window.junctionT('searchThreads', 'Search threads...') + '" spellcheck="false"></div>' +
    '<div class="task-history-list"><div class="session-card-empty">' + window.junctionT('loadingThreads', 'Loading threads...') + '</div></div>';
  root.querySelector('[data-scope="folder"] span:last-child').textContent = window.junctionT('workspace', 'Workspace');
  root.querySelector('[data-scope="all"] span:last-child').textContent = window.junctionT('allThreads', 'All threads');
  document.body.appendChild(root);
  var rect = trigger ? trigger.getBoundingClientRect() : { right: window.innerWidth - 12, top: 34 };
  root.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
  root.style.top = Math.max(34, rect.bottom + 6) + 'px';

  var tabs = Array.prototype.slice.call(root.querySelectorAll('.task-history-tab'));
  var input = root.querySelector('.task-history-search input');
  _taskHistory = {
    root: root,
    trigger: trigger || null,
    scope: 'folder',
    tabs: tabs,
    list: root.querySelector('.task-history-list'),
    query: '',
    groups: [],
    activeKey: null
  };
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      requestTaskHistory(tab.getAttribute('data-scope'));
    });
  });
  if (input) {
    input.addEventListener('input', function () {
      _taskHistory.query = input.value;
      renderTaskHistoryBody();
    });
    setTimeout(function () { input.focus(); }, 0);
  }
  setTimeout(function () { document.addEventListener('click', onTaskHistoryOutside, true); }, 0);
  requestTaskHistory('folder');
}
window.openTaskHistoryPopover = openTaskHistoryPopover;

// Expose for view-router.
window.renderGroups = renderGroups;

/** Toggle archived card visibility. */
function setArchiveFilter(showArchived) {
  var container = document.getElementById('session-list-items');
  if (!container) return;
  container.classList.toggle('show-archived', !!showArchived);
}
window.setArchiveFilter = setArchiveFilter;

// ── Event listeners ─────────────────────────────────────────────────
(function init() {
  var input = document.getElementById('session-list-input');
  var newChatBtn = document.getElementById('btn-new-chat');

  if (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        var text = input.value.trim();
        vscode.postMessage({ type: 'createChat', text: text || undefined });
        input.value = '';
        input.style.height = 'auto';
      }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    });
  }

  if (newChatBtn) {
    newChatBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'createChat' });
    });
  }

  var scopeBtn = document.getElementById('chat-scope');
  if (scopeBtn) {
    scopeBtn.addEventListener('click', function () {
      chatScope = chatScope === 'folder' ? 'all' : 'folder';
      vscode.postMessage({ type: 'setChatScope', scope: chatScope });
    });
  }
})();

// ── Inbound messages from extension host ────────────────────────────
window.addEventListener('message', function (event) {
  var msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'renderSessions') {
    renderGroups(msg.groups, msg.activeKey);
  }

  if (msg.type === 'renderTaskHistory') {
    if (_taskHistory && (msg.scope === _taskHistory.scope || !msg.scope)) {
      _taskHistory.groups = Array.isArray(msg.groups) ? msg.groups : [];
      _taskHistory.activeKey = msg.activeKey || null;
      renderTaskHistoryBody();
    }
  }

  if (msg.type === 'switchToHome') {
    var sl = document.getElementById('session-list');
    var cv = document.getElementById('chat-view');
    if (sl) sl.style.display = 'flex';
    if (cv) cv.style.display = 'none';
    if (msg.groups) renderGroups(msg.groups, msg.activeKey);
  }

  if (msg.type === 'chatScopeLabel') {
    var lbl = document.getElementById('chat-scope-label');
    if (lbl && msg.label) lbl.textContent = msg.label;
    if (msg.scope === 'all' || msg.scope === 'folder') chatScope = msg.scope;
  }
});
