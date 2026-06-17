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

var splashDismissed = false;
var splashInputBound = false;
var splashRareInputEaten = false;
var SPLASH_RARE_INPUT_EAT_CHANCE = 0.00001; // 0.001%
var splashExitModes = ['spiral-out', 'spiral-in', 'explode', 'explode2', 'float-away', 'horizontal-flatten', 'explode-weak', 'starwars-crawl', 'explode3'];

function ensureStartupPrompt(loader) {
  var prompt = document.getElementById('startup-start-prompt');
  if (!prompt && loader) {
    prompt = document.createElement('div');
    prompt.id = 'startup-start-prompt';
    prompt.textContent = 'push any to start';
    loader.appendChild(prompt);
  }
  return prompt;
}

function finishStartupLoader() {
  var loader = document.getElementById('startup-loader');
  if (!loader || loader.classList.contains('dismissed') || splashDismissed) return;
  var animConfig = window.animConfig || {};
  splashDismissed = true;
  var selectedMode = animConfig.splashExitMode || 'random';
  var exitMode = selectedMode === 'random'
    ? splashExitModes[Math.floor(Math.random() * splashExitModes.length)]
    : selectedMode;
  var canvas = loader.querySelector('canvas');
  if (canvas && typeof canvas._startSplashExit === 'function') {
    try { canvas._startSplashExit({ mode: exitMode }); } catch (e) {}
  }
  loader.setAttribute('data-splash-exit-mode', exitMode);
  loader.style.pointerEvents = 'none';
  var splashFade = animConfig.splashBackgroundFade !== undefined
    ? parseFloat(animConfig.splashBackgroundFade)
    : (animConfig.splashFade !== undefined ? parseFloat(animConfig.splashFade) : 0.3);
  if (!isFinite(splashFade)) splashFade = 0.3;
  var splashDelay = animConfig.splashBackgroundFadeDelay !== undefined ? parseFloat(animConfig.splashBackgroundFadeDelay) : 0;
  if (!isFinite(splashDelay)) splashDelay = 0;
  splashDelay = Math.max(0, splashDelay);
  loader.style.setProperty('--junction-splash-fade-duration', (splashFade * 1000) + 'ms');
  setTimeout(function () {
    loader.classList.add('dismissed');
  }, splashDelay * 1000);
  function cleanupWhenExitComplete() {
    var fadeDoneAt = (splashDelay + splashFade) * 1000;
    var startedAt = Date.now();
    function tick() {
      var fadeDone = Date.now() - startedAt >= fadeDoneAt;
      var exitDone = !canvas || typeof canvas._isSplashExitComplete !== 'function' || canvas._isSplashExitComplete();
      if (!fadeDone || !exitDone) {
        setTimeout(tick, 80);
        return;
      }
      if (!loader.parentNode) return;
      if (canvas && typeof canvas._stopAnimation === 'function') {
        try { canvas._stopAnimation(); } catch (e) {}
      }
      loader.remove();
    }
    tick();
  }
  cleanupWhenExitComplete();
}

function bindStartupInput(loader) {
  if (splashInputBound) return;
  splashInputBound = true;
  function handleStartupInput() {
    if (!splashRareInputEaten && Math.random() < SPLASH_RARE_INPUT_EAT_CHANCE) {
      splashRareInputEaten = true;
      loader.setAttribute('data-rare-input-eaten', 'true');
      return;
    }
    finishStartupLoader();
  }
  loader.addEventListener('click', handleStartupInput);
  document.addEventListener('keydown', handleStartupInput);
}

function dismissStartupLoader() {
  var loader = document.getElementById('startup-loader');
  if (!loader || loader.classList.contains('dismissed') || splashDismissed) return;
  var animConfig = window.animConfig || {};
  if (animConfig.splashDisabled) {
    finishStartupLoader();
    return;
  }
  ensureStartupPrompt(loader);
  loader.classList.add('loaded');
  bindStartupInput(loader);
  if (animConfig.splashAutoClose) {
    var splashLength = animConfig.splashLength !== undefined ? parseFloat(animConfig.splashLength) : 1.0;
    if (!isFinite(splashLength)) splashLength = 1.0;
    setTimeout(finishStartupLoader, Math.max(500, splashLength * 1000));
  }
}
window.dismissStartupLoader = dismissStartupLoader;

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
      dismissStartupLoader(true);
      showSessionList();
      if (msg.groups && typeof window.renderGroups === 'function') {
        window.renderGroups(msg.groups, msg.activeKey);
      }
      break;

    case 'switchToChat':
      window.setChatTitle?.(msg.title);
      showChatView();
      if (msg.history) {
        renderRouterHistory(msg.history, msg.activeRunId);
      }
      dismissStartupLoader();
      break;

    // ── Data updates ────────────────────────────────────────────

    case 'renderSessions':
      if (typeof window.renderGroups === 'function') {
        window.renderGroups(msg.groups, msg.activeKey);
      }
      break;

    case 'updateTitle':
      window.setChatTitle?.(msg.title);
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
