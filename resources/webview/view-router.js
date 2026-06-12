/**
 * view-router.js — Stage 3, Worker 3
 *
 * View navigation state machine for the Junction webview.
 * Coordinates between the session-list home screen and the chat view.
 *
 * Architecture:
 *   - Both #session-list and #chat-view live in the DOM permanently.
 *   - Navigation toggles `display: flex` / `display: none`.
 *   - Views are never removed from the DOM — only hidden.
 *   - Calls Worker 1 (renderSessionCards) and Worker 2 (setChatTitle)
 *     by name; both are defined in the global scope.
 *   - renderHistory is a no-op stub until Stage 6 provides the real
 *     message renderer.
 */

// ── Startup loader dismissal (first real view wins) ────────────

function dismissStartupLoader() {
  var loader = document.getElementById('startup-loader');
  if (!loader || loader.classList.contains('dismissed')) return;

  var animConfig = window.animConfig || {};
  var isDisabled = !!animConfig.splashDisabled;

  var splashLength = isDisabled ? 0.01 : (animConfig.splashLength !== undefined ? animConfig.splashLength : 1.0);
  var splashFade = isDisabled ? 0.01 : (animConfig.splashFade !== undefined ? animConfig.splashFade : 0.3);

  setTimeout(function () {
    loader.style.transition = 'opacity ' + splashFade + 's ease-out';
    loader.classList.add('dismissed');
    setTimeout(function () {
      loader.remove();
    }, splashFade * 1000 + 50);
  }, splashLength * 1000);
}

// ── View navigation (override template.html inline stubs) ──────

function showSessionList() {
  var sl = document.getElementById('session-list');
  var cv = document.getElementById('chat-view');
  if (sl) {
    sl.style.display = 'flex';
    sl.classList.add('view-visible');
    sl.classList.remove('view-hidden');
  }
  if (cv) {
    cv.style.display = 'none';
    cv.classList.add('view-hidden');
    cv.classList.remove('view-visible');
  }
}

function showChatView() {
  var sl = document.getElementById('session-list');
  var cv = document.getElementById('chat-view');
  if (sl) {
    sl.style.display = 'none';
    sl.classList.add('view-hidden');
    sl.classList.remove('view-visible');
  }
  if (cv) {
    cv.style.display = 'flex';
    cv.classList.add('view-visible');
    cv.classList.remove('view-hidden');
  }
}

// ── History delegate ───────────────────────────────────────────

function renderRouterHistory(history, activeRunId) {
  if (typeof window.renderHistory === 'function') {
    window.renderHistory(history, activeRunId);
  }
}

// ── Message routing (central dispatcher) ───────────────────────

window.addEventListener('message', function (event) {
  var msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {

    // ── Navigation ──────────────────────────────────────────────

    case 'switchToHome':
      dismissStartupLoader();
      showSessionList();
      if (msg.groups && typeof window.renderGroups === 'function') {
        window.renderGroups(msg.groups, msg.activeKey);
      }
      break;

    case 'switchToChat':
      dismissStartupLoader();
      setChatTitle(msg.title);
      showChatView();
      if (msg.history) {
        renderRouterHistory(msg.history, msg.activeRunId);
      }
      break;

    // ── Data updates ────────────────────────────────────────────

    case 'renderSessions':
      if (typeof window.renderGroups === 'function') {
        window.renderGroups(msg.groups, msg.activeKey);
      }
      break;

    case 'updateTitle':
      setChatTitle(msg.title);
      break;
  }
});

// ── Init — smart reopen ────────────────────────────────────────

// Ensure VS Code API is available before posting
function postInit() {
  if (typeof vscode !== 'undefined' && vscode.postMessage) {
    vscode.postMessage({ type: 'initRequest' });
  } else {
    setTimeout(postInit, 50);
  }
}
if (document.readyState === 'complete') {
  postInit();
} else {
  window.addEventListener('load', postInit);
}
