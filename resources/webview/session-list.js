/**
 * session-list.js — Session card list for Junction
 *
 * Renders session cards inside #session-list-items.
 * Exports renderSessionCards() and setArchiveFilter() (called by view-router).
 * Listens for renderSessions / switchToHome messages from extension host.
 *
 * postMessage → extension:
 *   resumeSession          { key }
 *   createChat             { text?: string }
 *   showArchivedSessions   { show: boolean }
 */

var chatScope = 'folder';

// ── Exported API (called by view-router.js) ─────────────────────────

/**
 * Render session cards into #session-list-items.
 *
 * @param {Array<{ key: string, title: string, model?: string,
 *   messageCount?: number, isArchived?: boolean, isActive?: boolean }>} sessions
 */
function renderSessionCards(sessions) {
  var container = document.getElementById('session-list-items');
  if (!container) return;

  container.innerHTML = '';

  if (!sessions || sessions.length === 0) {
    container.innerHTML =
      '<div class="session-card-empty">No sessions yet</div>';
    return;
  }

  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    var card = document.createElement('div');
    card.className = 'session-card';
    if (s.isActive)  card.classList.add('active');
    if (s.isArchived) card.classList.add('archived');
    card.setAttribute('data-key', s.key);

    // Title
    var titleEl = document.createElement('div');
    titleEl.className = 'session-card-title';
    titleEl.textContent = s.title || 'Untitled';
    card.appendChild(titleEl);

    // Meta row: model badge / message count / archived badge
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
        ? '1 msg'
        : s.messageCount + ' msgs';
      meta.appendChild(cnt);
    }

    if (s.isArchived) {
      var arch = document.createElement('span');
      arch.className = 'session-card-archived-badge';
      arch.textContent = 'archived';
      meta.appendChild(arch);
    }

    card.appendChild(meta);

    // Click → resume
    card.addEventListener('click', function (key) {
      return function () {
        vscode.postMessage({ type: 'resumeSession', key: key });
      };
    }(s.key));

    container.appendChild(card);
  }
}

/**
 * Toggle archived session card visibility.
 * @param {boolean} showArchived
 */
function setArchiveFilter(showArchived) {
  var container = document.getElementById('session-list-items');
  if (!container) return;
  if (showArchived) {
    container.classList.add('show-archived');
  } else {
    container.classList.remove('show-archived');
  }
}

// ── Event listeners ─────────────────────────────────────────────────

(function init() {
  var input = document.getElementById('session-list-input');
  var newChatBtn = document.getElementById('btn-new-chat');

  // "Type a message…" textarea → Enter auto-creates new chat
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

    // Auto-height
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    });
  }

  // + New chat button
  if (newChatBtn) {
    newChatBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'createChat' });
    });
  }

  // Scope dropdown: toggle current-binding chats vs all chats.
  // Label "task"/"workspace" intentionally avoided — derived dynamically.
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
    renderSessionCards(msg.sessions);
    // Apply .active to the card matching activeKey
    if (msg.activeKey) {
      var cards = document.querySelectorAll('#session-list-items .session-card');
      for (var i = 0; i < cards.length; i++) {
        cards[i].classList.toggle(
          'active',
          cards[i].getAttribute('data-key') === msg.activeKey
        );
      }
    }
  }

  if (msg.type === 'switchToHome') {
    document.getElementById('session-list').style.display = 'flex';
    document.getElementById('chat-view').style.display = 'none';
    if (msg.sessions) {
      renderSessionCards(msg.sessions);
    }
  }

  if (msg.type === 'chatScopeLabel') {
    var lbl = document.getElementById('chat-scope-label');
    if (lbl && msg.label) lbl.textContent = msg.label;
    if (msg.scope === 'all' || msg.scope === 'folder') chatScope = msg.scope;
  }
});
