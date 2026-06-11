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
  if (sig === _lastSig) return;
  _lastSig = sig;

  var total = groups.reduce(function (n, g) { return n + ((g.sessions || []).length); }, 0);
  if (!total) {
    container.innerHTML = '<div class="session-card-empty">No chats yet</div>';
    return;
  }

  container.innerHTML = '';
  groups.forEach(function (group) {
    var collapsed = isCollapsed(group);
    var groupEl = document.createElement('div');
    groupEl.className = 'session-group' + (collapsed ? ' collapsed' : '');
    groupEl.setAttribute('data-group', group.id);

    var header = document.createElement('button');
    header.className = 'session-group-header';
    header.title = (collapsed ? 'Expand ' : 'Collapse ') + (group.label || 'group');
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
      header.title = (nowCollapsed ? 'Expand ' : 'Collapse ') + (group.label || 'group');
    });
    groupEl.appendChild(header);

    var body = document.createElement('div');
    body.className = 'session-group-body';
    (group.sessions || []).forEach(function (s) { body.appendChild(makeCard(s, activeKey)); });
    groupEl.appendChild(body);

    container.appendChild(groupEl);
  });
}

function makeCard(s, activeKey) {
  var card = document.createElement('div');
  card.className = 'session-card';
  if (s.isActive || s.key === activeKey) card.classList.add('active');
  if (s.isArchived) card.classList.add('archived');
  card.setAttribute('data-key', s.key);

  var titleEl = document.createElement('div');
  titleEl.className = 'session-card-title';
  titleEl.textContent = s.title || 'Untitled';
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
    cnt.textContent = s.messageCount === 1 ? '1 msg' : s.messageCount + ' msgs';
    meta.appendChild(cnt);
  }
  if (s.isArchived) {
    var arch = document.createElement('span');
    arch.className = 'session-card-archived-badge';
    arch.textContent = 'archived';
    meta.appendChild(arch);
  }
  if (meta.childNodes.length) card.appendChild(meta);

  card.addEventListener('click', function () {
    vscode.postMessage({ type: 'resumeSession', key: s.key });
  });
  return card;
}

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
