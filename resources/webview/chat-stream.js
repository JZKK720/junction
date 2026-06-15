/* ==========================================================================
   chat-stream.js — Message stream renderer (the chat transcript)
   ==========================================================================
   Thin coordinator that imports render submodules in dependency order.
   Each module sets window.* globals for cross-module access.

   Inbound messages handled:
     history · userEcho · response · assistant_stream_start/delta/end ·
     thinking_chunk · thinking_end · tool_start · tool_update · tool_result ·
     subagentInfo · tokenUsage
   ========================================================================== */
(function () {
  'use strict';

  var messagesDiv = document.getElementById('chat-messages');
  if (!messagesDiv) return;
  var pinnedThrobber = document.getElementById('pinned-anim-throbber');

  // ── State (extends what modules define) ──────────────────────────────────
  var isRestoringHistory = false;
  var userScrollSticky = true;
  var isProgrammaticScroll = false;
  var historyFragment = null;

  // Sync module-window state references via shared names that modules already set
  // (activeRuns, reasoningBlocks, toolCalls, toolContainers are set by messages.js)

  // ── Scroll sync ──────────────────────────────────────────────────────────
  (function () {
    if (!messagesDiv) return;
    messagesDiv.addEventListener('scroll', function () {
      if (window.isProgrammaticScroll) { window.isProgrammaticScroll = false; return; }
      var atBottom = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 50;
      window.userScrollSticky = atBottom;
      maybeLoadMoreFromScroll();
    });
    messagesDiv.addEventListener('transitionend', function () { window.scrollToBottom(); });
    messagesDiv.addEventListener('animationend', function () { window.scrollToBottom(); });
  })();

  // ── clearMessages (needs access to all modules) ──────────────────────────
  function clearMessages() {
    if (typeof window.stopChatCurtain === 'function') window.stopChatCurtain(true);
    document.querySelectorAll('canvas.full-screen-anim').forEach(function (c) {
      if (c._stopAnimation) { try { c._stopAnimation(); } catch (e) {} }
      c.width = 0; c.height = 0; c.remove();
    });
    Array.prototype.slice.call(messagesDiv.children).forEach(function (child) {
      if (child.id !== 'pinned-anim-throbber') child.remove();
    });
    if (pinnedThrobber && pinnedThrobber.parentNode !== messagesDiv) {
      messagesDiv.appendChild(pinnedThrobber);
    }
    window.activeRuns.clear();
    window.runSubagentInfo.clear();
    window.reasoningBlocks.clear();
    window.toolCalls.clear();
    window.toolContainers.clear();
    if (window.thinkingTextState) window.thinkingTextState.clear();
  }

  // ── renderHistory ────────────────────────────────────────────────────────
  function renderHistory(history, activeRunId) {
    window.isRestoringHistory = true;
    clearMessages();
    if (activeRunId) messagesDiv.dataset.activeRun = activeRunId;
    window.historyFragment = document.createDocumentFragment();
    (history || []).forEach(function (item, index) {
      if (!item) return;
      if (item.role === 'assistant') {
        if (!item.content && !item.thinking && !(item.tools && item.tools.length) && !(item.activityTimeline && item.activityTimeline.length)) return;
        window.addAssistantHistoryRow(item, index);
      } else {
        if (!item.content) return;
        window.addUserRow(item.content, item.messageId, item.hasCheckpoint, null, item.isSteer);
      }
    });
    var wr = window.workingRow || document.getElementById('pinned-anim-throbber');
    if (wr && wr.parentNode === messagesDiv) {
      messagesDiv.insertBefore(window.historyFragment, wr);
    } else {
      messagesDiv.appendChild(window.historyFragment);
    }
    window.historyFragment = null;
    window.isRestoringHistory = false;
    window.hideForkOverlay();
    var activeRunIdVal = messagesDiv.dataset.activeRun;
    if (activeRunIdVal) {
      var block = window.reasoningBlocks.get(activeRunIdVal);
      if (block) {
        var bar = block.querySelector('.thinking-bar');
        if (bar && bar.dataset.active !== 'running') {
          window.startThinkingBar(bar);
          window.scheduleBarTick(bar);
        }
        block.classList.add('thinking');
        block.open = (window.reasoningMode === 'compact');
      }
    }
    window.forceScrollToBottom();
    showSeeMoreIfNeeded();
    if (typeof window.dismissStartupLoader === 'function') window.dismissStartupLoader(true);
  }
  window.renderHistory = renderHistory;

  // ── "See more" history button ──────────────────────────────────────────
  var _seeMoreBtn = null;
  var _loadingMore = false;
  var _hasMoreHistory = true;
  var _jsonlOffset = 0;
  var _useJsonlMode = false;

  function ensureSeeMoreButton() {
    if (_seeMoreBtn && _seeMoreBtn.parentNode) return _seeMoreBtn;
    _seeMoreBtn = document.createElement('button');
    _seeMoreBtn.id = 'see-more-history';
    _seeMoreBtn.textContent = 'See more';
    _seeMoreBtn.className = 'see-more-btn';
    _seeMoreBtn.addEventListener('click', function () {
      if (_loadingMore || !_hasMoreHistory) return;
      _loadingMore = true;
      _seeMoreBtn.textContent = 'Loading\u2026';
      _seeMoreBtn.classList.add('loading');
      if (_useJsonlMode) { vscode.postMessage({ type: 'loadMoreHistoryFromJsonl', offset: _jsonlOffset }); }
      else { vscode.postMessage({ type: 'loadMoreHistory' }); }
    });
    messagesDiv.insertBefore(_seeMoreBtn, messagesDiv.firstChild);
    return _seeMoreBtn;
  }

  function showSeeMoreIfNeeded() {
    if (_hasMoreHistory && messagesDiv.children.length > 2) ensureSeeMoreButton();
  }

  function hideSeeMoreButton() {
    if (_seeMoreBtn && _seeMoreBtn.parentNode) { _seeMoreBtn.parentNode.removeChild(_seeMoreBtn); }
    _seeMoreBtn = null;
  }

  function maybeLoadMoreFromScroll() {
    if (_loadingMore || !_hasMoreHistory) return;
    if (messagesDiv.scrollTop < 60) {
      showSeeMoreIfNeeded();
      if (_useJsonlMode && !_loadingMore) {
        _loadingMore = true;
        ensureSeeMoreButton();
        _seeMoreBtn.textContent = 'Loading\u2026';
        _seeMoreBtn.classList.add('loading');
        vscode.postMessage({ type: 'loadMoreHistoryFromJsonl', offset: _jsonlOffset });
      }
    }
  }

  (function injectSeeMoreStyles() {
    var s = document.createElement('style');
    s.textContent =
      '#see-more-history {' +
      '  display: block;' +
      '  margin: 8px auto 12px;' +
      '  padding: 4px 16px;' +
      '  border: 1px solid var(--vscode-widget-border, #444);' +
      '  border-radius: 14px;' +
      '  background: var(--vscode-sideBar-background, transparent);' +
      '  color: var(--vscode-descriptionForeground, #999);' +
      '  font-size: 11px;' +
      '  cursor: pointer;' +
      '  transition: background .15s, color .15s;' +
      '}' +
      '#see-more-history:hover {' +
      '  background: var(--vscode-widget-background, #333);' +
      '  color: var(--vscode-foreground, #ccc);' +
      '}' +
      '#see-more-history.loading {' +
      '  opacity: .6;' +
      '  cursor: default;' +
      '}';
    document.head.appendChild(s);
  })();

  function applyTokenColors(colors) {
    if (!colors || typeof colors !== 'object') return;
    Object.keys(colors).forEach(function (key) {
      if (colors[key]) document.documentElement.style.setProperty('--junction-token-' + key, colors[key]);
    });
  }

  // ── Startup animation override ───────────────────────────────────────────
  function overrideStartupAnimation() {
    var startupLoader = document.getElementById('startup-loader');
    if (startupLoader && !startupLoader.classList.contains('dismissed')) {
      if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale(startupLoader);
      var oldCanvas = document.getElementById('startup-matrix');
      if (oldCanvas) { oldCanvas._stopStartupDraw = true; oldCanvas.remove(); }
      var w = window.innerWidth;
      var h = window.innerHeight;
      var canvas = window.createAnimatedCanvas('Junction', { loader: true, isSplash: true, width: w, height: h, loaderMagic: window.getAnimVal('loaderMagic', false) });
      if (canvas) { canvas.id = 'startup-matrix'; startupLoader.insertBefore(canvas, startupLoader.firstChild); }
    }
  }

  try { overrideStartupAnimation(); } catch (e) {}

  // ── Splash preview ──────────────────────────────────────────────────────
  function playSplashAnimationPreview() {
    var loader = document.getElementById('startup-loader');
    var isNew = false;
    if (!loader) { loader = document.createElement('div'); loader.id = 'startup-loader'; loader.setAttribute('aria-hidden', 'true'); document.body.appendChild(loader); isNew = true; }
    loader.classList.remove('dismissed');
    loader.style.opacity = '1'; loader.style.pointerEvents = 'auto'; loader.style.display = 'block';
    if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale(loader);
    loader.innerHTML = '<div class="startup-copy"><div class="startup-wordmark">Junction</div><div class="startup-sub">connecting\u2026</div></div>';
    var w = window.innerWidth, h = window.innerHeight;
    var canvas = window.createAnimatedCanvas('Junction', { loader: true, isSplash: true, width: w, height: h, loaderMagic: window.getAnimVal('loaderMagic', false) });
    if (canvas) { canvas.id = 'startup-matrix'; loader.insertBefore(canvas, loader.firstChild); }
    setTimeout(function () {
      loader.classList.add('dismissed'); loader.style.opacity = '0'; loader.style.pointerEvents = 'none';
      if (canvas && typeof canvas._stopAnimation === 'function') { try { canvas._stopAnimation(); } catch (e) {} }
      setTimeout(function () { if (isNew) { loader.remove(); } else { loader.style.display = 'none'; canvas.remove(); } }, 220);
    }, 3000);
  }
  window.playSplashAnimationPreview = playSplashAnimationPreview;

  // ── Inbound dispatch ────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'clearChat':
        clearMessages();
        break;
      case 'forkStarted':
        window.showForkOverlay();
        break;
      case 'config':
        if (msg.reasoningDisplay) window.reasoningMode = msg.reasoningDisplay;
        if (msg.activityLayout) window.streamCfg.layout = msg.activityLayout;
        if (msg.activityRail !== undefined) window.streamCfg.rail = !!msg.activityRail;
        if (msg.activityDots) window.streamCfg.dots = msg.activityDots;
        window.applyStreamConfig();
        if (msg.animConfig) Object.assign(window.animConfig, msg.animConfig);
        if (msg.animationMode) window._junctionAnimationMode = msg.animationMode;
        if (msg.animColor) window._junctionAnimColor = msg.animColor;
        if (msg.loaderColor) window._junctionLoaderAnimColor = msg.loaderColor;
        if (msg.splashColor) window._junctionSplashColor = msg.splashColor;
        if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale(document.getElementById('startup-loader') || document.documentElement);
        if (msg.tokenColors) applyTokenColors(msg.tokenColors);
        if (msg.showFullHistory !== undefined) _useJsonlMode = !!msg.showFullHistory;
        try { overrideStartupAnimation(); } catch (e) {}
        break;
      case 'history':
        _loadingMore = false; _hasMoreHistory = true;
        renderHistory(msg.messages, msg.activeRunId);
        break;
      case 'moreHistory':
        _loadingMore = false; _hasMoreHistory = msg.hasMore; _jsonlOffset = msg.nextOffset || 0;
        if (msg.turns && msg.turns.length > 0) {
          window.isRestoringHistory = true;
          var scrollHeightBefore = messagesDiv.scrollHeight;
          var baseIndex = _jsonlOffset;
          var firstMessageRow = null;
          for (var i = 0; i < messagesDiv.children.length; i++) {
            var child = messagesDiv.children[i];
            if (child.classList.contains('chat-row') && child !== window.workingRow) { firstMessageRow = child; break; }
          }
          (msg.turns || []).forEach(function (turn, index) {
            if (!turn) return;
            if (turn.role === 'assistant') {
              if (!turn.content && !turn.thinking && !(turn.tools && turn.tools.length) && !(turn.activityTimeline && turn.activityTimeline.length)) return;
              window.addAssistantHistoryRow(turn, baseIndex + index, firstMessageRow);
            } else {
              if (!turn.content) return;
              window.addUserRow(turn.content, turn.messageId, turn.hasCheckpoint, firstMessageRow, turn.isSteer);
            }
          });
          window.isRestoringHistory = false;
          messagesDiv.scrollTop = messagesDiv.scrollHeight - scrollHeightBefore;
        }
        if (!_hasMoreHistory) hideSeeMoreButton();
        break;
      case 'noMoreHistory':
        _loadingMore = false; _hasMoreHistory = false; hideSeeMoreButton();
        break;
      case 'userEcho':
        if (!window.isWorkspaceContext(msg.text)) window.addUserRow(msg.text, msg.messageId, msg.hasCheckpoint, null, msg.isSteer);
        break;
      case 'steerFailed':
        var row = document.querySelector('[data-message-id="' + msg.messageId + '"]');
        if (row) {
          var bubble = row.querySelector('.msg-text');
          if (bubble) {
            var notice = document.createElement('div');
            notice.className = 'steer-notice';
            notice.style.cssText = 'font-size:10px;color:var(--vscode-errorForeground);margin-top:4px;font-style:italic;';
            notice.textContent = '(Steering failed; queued as follow-up)';
            bubble.appendChild(notice);
          }
          var badge = row.querySelector('.steer-badge');
          if (badge) badge.remove();
        }
        break;
      case 'queuedUserUpdated':
        var queuedRow = messagesDiv.querySelector('[data-message-id="' + msg.messageId + '"]');
        if (queuedRow) {
          var queuedText = queuedRow.querySelector('.msg-text');
          if (queuedText) {
            queuedText.dataset.rawText = msg.text || '';
            queuedText.innerHTML = window.renderMarkdown(msg.text || '');
          }
        }
        break;
      case 'queuedUserRemoved':
        var removedRow = messagesDiv.querySelector('[data-message-id="' + msg.messageId + '"]');
        if (removedRow) removedRow.remove();
        break;
      case 'response':
        if (!window.isWorkspaceContext(msg.text)) {
          window.setAssistantText('response', msg.text);
        }
        window.activeRuns.delete('response');
        break;
      case 'assistant_stream_start':
        window.getOrCreateAssistantMessage(msg.runId);
        if (window.setWorklogState) window.setWorklogState(msg.runId, 'running');
        break;
      case 'assistant_stream_delta':
        if (msg.fullText !== undefined && !window.isWorkspaceContext(msg.fullText)) {
          window.setAssistantText(msg.runId, msg.fullText);
        }
        break;
      case 'assistant_stream_end':
        var finishingRow = document.querySelector('[data-run-id="' + msg.runId + '"]');
        if (window.flushActivityNotes) window.flushActivityNotes(msg.runId, finishingRow);
        window.activeRuns.delete(msg.runId);
        var activeRow = document.querySelector('[data-run-id="' + msg.runId + '"]');
        if (activeRow) {
          activeRow.classList.remove('running');
          if (msg.messageId) activeRow.setAttribute('data-message-id', msg.messageId);
          var oldActions = activeRow.querySelector('.msg-actions');
          if (oldActions) oldActions.remove();
          activeRow.appendChild(window.buildMsgActions(msg.messageId || msg.runId, true));
        }
        if (window.setWorklogState) window.setWorklogState(msg.runId, 'done');
        window.groupToolRows(window.toolContainers.get(msg.runId));
        break;
      case 'runActive':
        window.setWorking(!!msg.active);
        break;
      case 'thinking_chunk':
        window.renderReasoning(msg.runId, msg.fullText, { deltaText: msg.text || '' });
        window.suppressWorking(true);
        break;
      case 'thinking_end':
        window.finalizeReasoning(msg.runId, msg.durationMs);
        if (window.setWorklogState) window.setWorklogState(msg.runId, 'done', msg.durationMs);
        window.suppressWorking(false);
        break;
      case 'tool_start':
        window.handleToolStart(msg);
        break;
      case 'tool_update':
        window.handleToolUpdate(msg);
        break;
      case 'tool_result':
        window.handleToolResult(msg);
        break;
      case 'subagentInfo':
        window.runSubagentInfo.set(msg.runId, msg);
        var row = window.activeRuns.get(msg.runId);
        if (row) {
          var subLabel = document.createElement('div');
          subLabel.className = 'subagent-label';
          subLabel.textContent = '[' + (msg.subagentRole || 'Subagent') + ']' + (msg.spawnDepth ? ' (D' + msg.spawnDepth + ')' : '');
          row.insertBefore(subLabel, row.firstChild);
          row.classList.add(msg.spawnDepth > 2 ? 'subagent-deep' : 'subagent');
        }
        break;
      case 'tokenUsage':
        var r = window.activeRuns.get(msg.runId);
        if (r) {
          var footer = r.querySelector('.token-footer');
          if (!footer) { footer = document.createElement('div'); footer.className = 'token-footer'; r.appendChild(footer); }
          footer.textContent = '\u2191 ' + (msg.inputTokens || 0).toLocaleString() + '  \u2193 ' + (msg.outputTokens || 0).toLocaleString();
        }
        break;
    }
  });

  // ── File link click handler ─────────────────────────────────────────────
  messagesDiv.addEventListener('click', function (e) {
    var target = e.target.closest('.file-link');
    if (!target) return;
    var filePath = target.getAttribute('data-file');
    if (filePath) vscode.postMessage({ type: 'openFile', filePath: filePath });
  });

  // ── Hamburger menu share ───────────────────────────────────────────────
  window.addEventListener('junction-share-chat', function (ev) {
    var trigger = ev.detail && ev.detail.target;
    if (typeof window.openShareMenu === 'function') window.openShareMenu(trigger || null);
  });

})();
