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
  var scrollToBottomBtn = document.getElementById('scroll-to-bottom');
  var composerShell = document.getElementById('composer-shell');

  // ── State (extends what modules define) ──────────────────────────────────
  var isRestoringHistory = false;
  var userScrollSticky = true;
  var isProgrammaticScroll = false;
  var historyFragment = null;

  function scrollBottomGap() {
    return messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight;
  }

  function updateScrollToBottomButton() {
    if (!scrollToBottomBtn) return;
    if (composerShell) {
      document.documentElement.style.setProperty('--composer-shell-height', composerShell.offsetHeight + 'px');
    }
    var show = scrollBottomGap() > 96;
    scrollToBottomBtn.hidden = !show;
    scrollToBottomBtn.classList.toggle('visible', show);
  }
  window.updateScrollToBottomButton = updateScrollToBottomButton;

  if (scrollToBottomBtn) {
    scrollToBottomBtn.addEventListener('click', function () {
      window.forceScrollToBottom();
      updateScrollToBottomButton();
    });
  }
  window.addEventListener('resize', updateScrollToBottomButton);
  if (composerShell && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(updateScrollToBottomButton).observe(composerShell);
  }

  // Sync module-window state references via shared names that modules already set
  // (activeRuns, reasoningBlocks, toolCalls, toolContainers are set by messages.js)

  // ── Scroll sync ──────────────────────────────────────────────────────────
  (function () {
    if (!messagesDiv) return;
    messagesDiv.addEventListener('scroll', function () {
      if (window.isProgrammaticScroll) {
        window.isProgrammaticScroll = false;
        updateScrollToBottomButton();
        return;
      }
      var atBottom = scrollBottomGap() < 50;
      window.userScrollSticky = atBottom;
      updateScrollToBottomButton();
      maybeLoadMoreFromScroll();
    });
    messagesDiv.addEventListener('transitionend', function () { window.scrollToBottom(); updateScrollToBottomButton(); });
    messagesDiv.addEventListener('animationend', function () { window.scrollToBottom(); updateScrollToBottomButton(); });
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
    if (window.reasoningInterrupted) window.reasoningInterrupted.clear();
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
        block.open = (window.reasoningMode === 'chronological');
      }
    }
    window.forceScrollToBottom();
    showSeeMoreIfNeeded();
    updateScrollToBottomButton();
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
    _seeMoreBtn.textContent = window.junctionT('seeMore', 'See more');
    _seeMoreBtn.className = 'see-more-btn';
    _seeMoreBtn.addEventListener('click', function () {
      if (_loadingMore || !_hasMoreHistory) return;
      _loadingMore = true;
      _seeMoreBtn.textContent = window.junctionT('loading', 'Loading...');
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
        _seeMoreBtn.textContent = window.junctionT('loading', 'Loading...');
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
      '  border: 1px solid var(--vscode-widget-border, transparent);' +
      '  border-radius: 14px;' +
      '  background: var(--vscode-sideBar-background, transparent);' +
      '  color: var(--vscode-descriptionForeground, var(--vscode-foreground));' +
      '  font-size: 11px;' +
      '  cursor: pointer;' +
      '  transition: background .15s, color .15s;' +
      '}' +
      '#see-more-history:hover {' +
      '  background: var(--vscode-list-hoverBackground, var(--vscode-sideBar-background));' +
      '  color: var(--vscode-foreground);' +
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

  function applyChatMotionConfig() {
    var cfg = window.animConfig || {};
    var root = document.documentElement;
    if (cfg.chatRiseDistance !== undefined) root.style.setProperty('--junction-chat-rise-distance', Number(cfg.chatRiseDistance) + 'px');
    if (cfg.chatRiseDuration !== undefined) root.style.setProperty('--junction-chat-rise-duration', Number(cfg.chatRiseDuration) + 's');
    if (cfg.chatRiseTilt !== undefined) root.style.setProperty('--junction-chat-rise-tilt', Number(cfg.chatRiseTilt) + 'deg');
    if (cfg.chatRiseBlur !== undefined) root.style.setProperty('--junction-chat-rise-blur', Number(cfg.chatRiseBlur) + 'px');
  }
  window.applyChatMotionConfig = applyChatMotionConfig;
  try { applyChatMotionConfig(); } catch (e) {}

  // ── Startup animation override ───────────────────────────────────────────
  // Gate: don't build the real splash until the persisted config has been
  // applied once. Building eagerly races ahead with default settings (e.g. the
  // katakana charset) and then visibly swaps to the user's charset the moment
  // host config lands. The neutral inline fallback (template.html) holds the
  // screen until config is ready, so boot goes fallback → user charset with no
  // intermediate flash.
  var _splashConfigApplied = false;
  function overrideStartupAnimation() {
    if (!_splashConfigApplied) return;
    var startupLoader = document.getElementById('startup-loader');
    if (startupLoader && !startupLoader.classList.contains('dismissed')) {
      if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale(startupLoader);
      var oldCanvas = document.getElementById('startup-matrix');
      if (oldCanvas) {
        oldCanvas._stopStartupDraw = true;
        if (typeof oldCanvas._stopAnimation === 'function') {
          try { oldCanvas._stopAnimation(); } catch (e) {}
        }
        oldCanvas.remove();
      }
      var w = window.innerWidth;
      var h = window.innerHeight;
      var canvas = window.createAnimatedCanvas('Junction', { loader: true, isSplash: true, width: w, height: h, loaderMagic: window.getAnimVal('loaderMagic', false) });
      if (canvas) {
        canvas.id = 'startup-matrix';
        startupLoader.classList.add('real-splash-ready');
        var fallbackWordmark = document.getElementById('startup-fallback-wordmark');
        if (fallbackWordmark) setTimeout(function () { fallbackWordmark.remove(); }, 220);
        startupLoader.insertBefore(canvas, startupLoader.firstChild);
      }
    }
  }

  try { overrideStartupAnimation(); } catch (e) {}

  // The real splash canvas is baked at boot-time pixel dimensions, so rebuild it
  // to the new viewport when the window resizes while the loader is still up.
  // (The inline boot fallback self-resizes; this covers the createMatrixLoader.)
  var _splashResizeTimer = null;
  window.addEventListener('resize', function () {
    var loader = document.getElementById('startup-loader');
    if (!loader || loader.classList.contains('dismissed')) return;
    if (_splashResizeTimer) clearTimeout(_splashResizeTimer);
    _splashResizeTimer = setTimeout(function () {
      _splashResizeTimer = null;
      try { overrideStartupAnimation(); } catch (e) {}
    }, 120);
  });

  // ── Splash preview ──────────────────────────────────────────────────────
  function playSplashAnimationPreview() {
    var loader = document.getElementById('startup-loader');
    var isNew = false;
    if (!loader) { loader = document.createElement('div'); loader.id = 'startup-loader'; loader.setAttribute('aria-hidden', 'true'); document.body.appendChild(loader); isNew = true; }
    loader.classList.remove('dismissed');
    loader.classList.add('real-splash-ready');
    loader.style.opacity = '1'; loader.style.pointerEvents = 'auto'; loader.style.display = 'block';
    if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale(loader);
    loader.innerHTML = '';
    var w = window.innerWidth, h = window.innerHeight;
    var canvas = window.createAnimatedCanvas('Junction', { loader: true, isSplash: true, width: w, height: h, loaderMagic: window.getAnimVal('loaderMagic', false) });
    if (canvas) { canvas.id = 'startup-matrix'; loader.insertBefore(canvas, loader.firstChild); }
    var prompt = document.createElement('div');
    prompt.id = 'startup-start-prompt';
    prompt.textContent = 'push any to start';
    loader.appendChild(prompt);
    function dismissPreview() {
      loader.removeEventListener('click', dismissPreview);
      document.removeEventListener('keydown', dismissPreview);
      loader.classList.remove('accepting-input');
      var cfg = window.animConfig || {};
      var modes = (window.JunctionAnimation && window.JunctionAnimation.previewSplashExitModes) || ['spiral-out', 'spiral-in', 'explode', 'explode2', 'melt', 'float-away', 'horizontal-flatten', 'explode-weak', 'starwars-crawl', 'explode3-bounce', 'explode3-no-bounce'];
      var selected = cfg.splashExitMode || 'random';
      var mode = selected === 'random' ? modes[Math.floor(Math.random() * modes.length)] : selected;
      if (canvas && typeof canvas._startSplashExit === 'function') { try { canvas._startSplashExit({ mode: mode }); } catch (e) {} }
      loader.style.pointerEvents = 'none';
      var delay = cfg.splashBackgroundFadeDelay !== undefined ? parseFloat(cfg.splashBackgroundFadeDelay) : 0;
      if (!isFinite(delay)) delay = 0;
      var fade = cfg.splashBackgroundFade !== undefined ? parseFloat(cfg.splashBackgroundFade) : 0.3;
      if (!isFinite(fade)) fade = 0.3;
      loader.style.setProperty('--junction-splash-fade-duration', (fade * 1000) + 'ms');
      setTimeout(function () { loader.classList.add('dismissed'); }, Math.max(0, delay) * 1000);
      var startedAt = Date.now();
      var fadeDoneAt = (Math.max(0, delay) + fade) * 1000;
      function cleanupPreviewWhenExitComplete() {
        var fadeDone = Date.now() - startedAt >= fadeDoneAt;
        var exitDone = !canvas || typeof canvas._isSplashExitComplete !== 'function' || canvas._isSplashExitComplete();
        if (!fadeDone || !exitDone) {
          setTimeout(cleanupPreviewWhenExitComplete, 80);
          return;
        }
        if (canvas && typeof canvas._stopAnimation === 'function') { try { canvas._stopAnimation(); } catch (e) {} }
        if (isNew) { loader.remove(); } else { loader.style.display = 'none'; if (canvas) canvas.remove(); }
      }
      cleanupPreviewWhenExitComplete();
    }
    loader.addEventListener('click', dismissPreview);
    document.addEventListener('keydown', dismissPreview);
    loader.classList.add('loaded', 'accepting-input');
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
        if (msg.activeBridge) window.junctionActiveBridge = msg.activeBridge;
        if (msg.sessionKey !== undefined) window.junctionActiveSessionKey = msg.sessionKey || null;
        window.messageReactionsEnabled = msg.messageReactions === true;
        window.timelineInterleave = msg.interleaveTimeline === true;
        window.compactTimelineMode = msg.compactTimelineMode === true;
        if (msg.feedbackGlyphs) window.feedbackGlyphs = msg.feedbackGlyphs;
        if (msg.reasoningDisplay) window.reasoningMode = msg.reasoningDisplay;
        if (msg.activityLayout) window.streamCfg.layout = window.normalizeActivityLayout ? window.normalizeActivityLayout(msg.activityLayout) : (msg.activityLayout === 'timeline' ? 'timeline' : 'accordion');
        if (msg.activityRail !== undefined) window.streamCfg.rail = !!msg.activityRail;
        if (msg.activityDots) window.streamCfg.dots = msg.activityDots;
        if (msg.activityCondensed !== undefined) window.streamCfg.condensed = !!msg.activityCondensed;
        if (msg.goodFonts !== undefined) document.body.classList.toggle('good-fonts', !!msg.goodFonts);
        if (msg.toolOutputWordWrap) {
          var wrapTools = msg.toolOutputWordWrap === 'on';
          document.body.classList.toggle('tool-output-wrap', wrapTools);
          document.body.classList.toggle('tool-output-nowrap', !wrapTools);
        }
        if (msg.queueDisplayMode) {
          document.body.classList.remove('queue-display-timeline', 'queue-display-compact');
          if (msg.queueDisplayMode === 'timeline') document.body.classList.add('queue-display-timeline');
          else if (msg.queueDisplayMode === 'compact') document.body.classList.add('queue-display-compact');
        }
        if (msg.betaForkRewind !== undefined) window.betaForkRewind = !!msg.betaForkRewind;
        if (msg.bubbleRadius !== undefined) document.documentElement.style.setProperty('--junction-bubble-radius', msg.bubbleRadius + 'px');
        if (msg.bubbleTip !== undefined) document.documentElement.style.setProperty('--junction-bubble-tip', msg.bubbleTip);
        window.applyStreamConfig();
        // Host 'config' comes from globalState, written via async saveAnimConfig,
        // so it can lag the webview's own getState (written synchronously on every
        // settings change). Apply host as the base, then let the fresher getState
        // values win — otherwise a stale host charset (e.g. the katakana default)
        // clobbers the user's saved choice for the first splash build.
        if (msg.animConfig) Object.assign(window.animConfig, msg.animConfig);
        try {
          var _savedAnim = (vscode.getState() || {}).animConfig;
          if (_savedAnim) Object.assign(window.animConfig, _savedAnim);
        } catch (e) {}
        applyChatMotionConfig();
        if (msg.animationMode) window._junctionAnimationMode = msg.animationMode;
        if (msg.animColor) window._junctionAnimColor = msg.animColor;
        if (msg.loaderColor) window._junctionLoaderAnimColor = msg.loaderColor;
        if (msg.splashColor) window._junctionSplashColor = msg.splashColor;
        if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale(document.getElementById('startup-loader') || document.documentElement);
        if (msg.tokenColors) applyTokenColors(msg.tokenColors);
        if (msg.showFullHistory !== undefined) _useJsonlMode = !!msg.showFullHistory;
        _splashConfigApplied = true;   // persisted config now in — safe to build the real splash
        try { overrideStartupAnimation(); } catch (e) {}
        break;
      case 'history':
        if (msg.activeBridge) window.junctionActiveBridge = msg.activeBridge;
        if (msg.sessionKey !== undefined) window.junctionActiveSessionKey = msg.sessionKey || null;
        if (msg.interleaveTimeline !== undefined) window.timelineInterleave = msg.interleaveTimeline === true;
        if (msg.compactTimelineMode !== undefined) window.compactTimelineMode = msg.compactTimelineMode === true;
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
      case 'checkpointReady':
        var cpRow = messagesDiv.querySelector('[data-message-id="' + msg.messageId + '"]');
        if (cpRow) {
          cpRow.setAttribute('data-has-checkpoint', 'true');
          var cpActions = cpRow.querySelector('.msg-actions');
          if (cpActions) cpActions.remove();
          cpRow.appendChild(window.buildMsgActions(msg.messageId, cpRow.classList.contains('assistant'), true));
        }
        break;
      case 'steerFailed':
        var row = document.querySelector('[data-message-id="' + msg.messageId + '"]');
        if (row) {
          row.setAttribute('data-queued', 'true');
          var bubble = row.querySelector('.msg-text');
          if (bubble) {
            var notice = document.createElement('div');
            notice.className = 'steer-notice';
            notice.textContent = '(Steering failed; queued as follow-up)';
            bubble.appendChild(notice);
            if (!bubble.querySelector('.queue-badge')) {
              var failedQueueBadge = document.createElement('span');
              failedQueueBadge.className = 'queue-badge';
              failedQueueBadge.textContent = window.junctionT('queued', 'QUEUED');
              bubble.insertBefore(failedQueueBadge, bubble.firstChild);
            }
          }
          var badge = row.querySelector('.steer-badge');
          if (badge) badge.remove();
          // Clean up any stale inline actions so queueState can rebuild
          var oldInline = row.querySelector('.queue-inline-actions');
          if (oldInline) oldInline.remove();
        }
        break;
      case 'queuedUserAdded':
        var addedRow = messagesDiv.querySelector('[data-message-id="' + msg.messageId + '"]');
        if (addedRow) {
          addedRow.setAttribute('data-queued', 'true');
          var addedBubble = addedRow.querySelector('.msg-text');
          if (addedBubble && !addedBubble.querySelector('.queue-badge')) {
            var qBadge = document.createElement('span');
            qBadge.className = 'queue-badge';
            qBadge.textContent = window.junctionT('queued', 'QUEUED');
            addedBubble.insertBefore(qBadge, addedBubble.firstChild);
          }
          // Queue actions will be attached by queueState → buildAllInlineQueueActions
        }
        break;
      case 'queuedUserActivated':
        var activeRow = messagesDiv.querySelector('[data-message-id="' + msg.messageId + '"]');
        if (activeRow) {
          activeRow.removeAttribute('data-queued');
          var activeBadge = activeRow.querySelector('.queue-badge');
          if (activeBadge) activeBadge.remove();
          var activeInlineActions = activeRow.querySelector('.queue-inline-actions');
          if (activeInlineActions) activeInlineActions.remove();
          var activeInlineEdit = activeRow.querySelector('.queue-inline-edit');
          if (activeInlineEdit) activeInlineEdit.remove();
          activeRow.classList.remove('queue-editing');
        }
        break;
      case 'queuedUserSteered':
        var steeredRow = messagesDiv.querySelector('[data-message-id="' + msg.messageId + '"]');
        if (steeredRow) {
          steeredRow.removeAttribute('data-queued');
          steeredRow.setAttribute('data-steer', 'true');
          var steeredBubble = steeredRow.querySelector('.msg-text');
          if (steeredBubble) {
            var oldQueue = steeredBubble.querySelector('.queue-badge');
            if (oldQueue) oldQueue.remove();
            if (!steeredBubble.querySelector('.steer-badge')) {
              var sBadge = document.createElement('span');
              sBadge.className = 'steer-badge';
              sBadge.textContent = window.junctionT('steer', 'STEER');
              steeredBubble.insertBefore(sBadge, steeredBubble.firstChild);
            }
          }
          // Remove inline queue actions
          var steeredInlineActions = steeredRow.querySelector('.queue-inline-actions');
          if (steeredInlineActions) steeredInlineActions.remove();
          var steeredInlineEdit = steeredRow.querySelector('.queue-inline-edit');
          if (steeredInlineEdit) steeredInlineEdit.remove();
          steeredRow.classList.remove('queue-editing');
        }
        break;
      case 'queuedUserUpdated':
        var queuedRow = messagesDiv.querySelector('[data-message-id="' + msg.messageId + '"]');
        if (queuedRow) {
          var queuedText = queuedRow.querySelector('.msg-text');
          if (queuedText) {
            queuedText.dataset.rawText = msg.text || '';
            queuedText.innerHTML = window.renderMarkdown(msg.text || '');
            var updatedBadge = document.createElement('span');
            updatedBadge.className = 'queue-badge';
            updatedBadge.textContent = window.junctionT('queued', 'QUEUED');
            queuedText.insertBefore(updatedBadge, queuedText.firstChild);
          }
          // Refresh inline actions
          var existingActions = queuedRow.querySelector('.queue-inline-actions');
          if (existingActions) existingActions.remove();
          var existingEdit = queuedRow.querySelector('.queue-inline-edit');
          if (existingEdit) existingEdit.remove();
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
        if (msg.commandOutput && window.setAssistantCommandOutput) {
          window.setAssistantCommandOutput(msg.runId, msg.commandOutput, msg.fullText || '');
        } else if (msg.fullText !== undefined && !window.isWorkspaceContext(msg.fullText)) {
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
        if (msg.sessionKey && window.junctionActiveSessionKey && msg.sessionKey !== window.junctionActiveSessionKey) break;
        window.renderReasoning(msg.runId, msg.fullText, { deltaText: msg.text || '' });
        window.suppressWorking(true);
        break;
      case 'thinking_end':
        if (msg.sessionKey && window.junctionActiveSessionKey && msg.sessionKey !== window.junctionActiveSessionKey) break;
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
    e.preventDefault();
    e.stopPropagation();
    var filePath = target.getAttribute('data-file');
    if (filePath) vscode.postMessage({ type: 'openFile', filePath: filePath });
  });

  messagesDiv.addEventListener('click', function (e) {
    if (!document.body.classList.contains('stream-layout-timeline')) return;
    var summary = e.target.closest('.activity-thought > summary');
    if (!summary) return;
    var thought = summary.parentElement;
    if (!thought) return;
    e.preventDefault();
    var nextOpen = !thought.open;
    var row = thought.closest('.chat-row.assistant');
    var scope = row || messagesDiv;
    scope.querySelectorAll('.activity-thought').forEach(function (block) {
      block.open = nextOpen;
    });
  }, true);

  // ── Hamburger menu share ───────────────────────────────────────────────
  window.addEventListener('junction-share-chat', function (ev) {
    var trigger = ev.detail && ev.detail.target;
    if (typeof window.openShareMenu === 'function') window.openShareMenu(trigger || null);
  });

})();
