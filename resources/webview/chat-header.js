/* ==========================================================================
   chat-header.js — Chat view header for Junction
   ==========================================================================
   Contract:
   - Global: setChatTitle(text)
   - Wires: #btn-back, #chat-title, #btn-task-history, #btn-menu, #btn-settings, #btn-new-chat-view
   - Listens for: updateTitle { key, title }
   - Sends via postMessage: backToSessions, renameSession, archiveSession,
     openSettings, createChat
   ========================================================================== */
(function () {
  'use strict';

  // ── Module state ───────────────────────────────────────────────────────
  var _sessionKey = null;

  // ── Public API (global, called by Worker 3 router) ─────────────────────
  /**
   * Update the chat header title.
   * @param {string} text — new title; empty/null shows "New chat"
   */
  window.setChatTitle = function setChatTitle(text) {
    var titleEl = document.getElementById('chat-title');
    if (!titleEl) return;
    titleEl.textContent = text || window.junctionT('newChat', 'New chat');
  };

  /**
   * Update the session key used by rename/archive messages.
   * @param {string} key
   */
  function setSessionKey(key) {
    _sessionKey = key;
  }

  /**
   * Store session key from extension response, then delegate to title update.
   * Called by the message listener when updateTitle arrives.
   */
  window.updateSessionKey = setSessionKey;

  // ── Inline title editing ───────────────────────────────────────────────

  function startRename(titleEl) {
    if (!titleEl || !titleEl.isConnected || document.querySelector('.title-edit')) return;
    var currentTitle = titleEl.textContent;
    var finished = false;

    // Replace span with input
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'title-edit';
    input.value = currentTitle === window.junctionT('newChat', 'New chat') ? '' : currentTitle;

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      if (finished) return;
      finished = true;
      var newTitle = input.value.trim() || window.junctionT('newChat', 'New chat');
      finishEdit(input, newTitle);

      // Send rename to extension host
      if (_sessionKey) {
        vscode.postMessage({
          type: 'renameSession',
          key: _sessionKey,
          label: newTitle
        });
      }

      // Optimistic local update
      window.setChatTitle(newTitle);
    }

    function cancel() {
      if (finished) return;
      finished = true;
      finishEdit(input, currentTitle);
      window.setChatTitle(currentTitle);
    }

    function onKeydown(e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    }

    function onPaste(e) {
      e.stopPropagation();
      var text = e.clipboardData && e.clipboardData.getData ? e.clipboardData.getData('text/plain') : '';
      if (!text) return;
      e.preventDefault();
      var start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
      var end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      var cursor = start + text.length;
      if (input.setSelectionRange) input.setSelectionRange(cursor, cursor);
    }

    function onBlur() {
      commit();
    }

    input.addEventListener('keydown', onKeydown);
    input.addEventListener('paste', onPaste);
    input.addEventListener('input', function (e) { e.stopPropagation(); });
    input.addEventListener('blur', onBlur);
  }

  function finishEdit(input, text) {
    if (!input || !input.isConnected) return;
    // Recreate the span
    var span = document.createElement('span');
    span.id = 'chat-title';
    span.className = 'title';
    span.title = window.junctionT('clickToRename', 'Click to rename');
    span.textContent = text;

    // Re-attach click listener for future edits
    span.addEventListener('click', function () {
      startRename(span);
    });

    input.replaceWith(span);
  }

  function toggleMenu(anchorEl) {
    if (!window.choiceMenu) return;
    var items = [
      { id: 'rename', label: window.junctionT('rename', 'Rename'), icon: 'edit' },
      { id: 'back', label: window.junctionT('backToChats', 'Back to chats'), icon: 'list-unordered' },
      { id: 'usage', label: window.junctionT('sessionUsage', 'Session usage'), icon: 'graph' },
      { id: 'agentPicker', label: window.junctionT('agentPicker', 'Agent picker'), icon: 'hubot' },
      { id: 'animationSettings', label: window.junctionT('animationSettings', 'Animation settings'), icon: 'symbol-color', action: function () {
        if (typeof window.toggleChatPreviewPanel === 'function') window.toggleChatPreviewPanel();
      }},
      { id: 'playSplash', label: window.junctionT('playSplashAnimation', 'Play splash animation'), icon: 'rocket', action: function () {
        if (typeof window.playSplashAnimationPreview === 'function') window.playSplashAnimationPreview();
      }}
    ];
    if (window.betaForkRewind) {
      items.push({ id: 'fork', label: window.junctionT('forkConversationOpenClawBeta', 'Fork conversation (OpenClaw beta)'), icon: 'git-branch' });
    }
    items.push(
      { id: 'archive', label: window.junctionT('archive', 'Archive'), icon: 'archive', key: _sessionKey, disabled: !_sessionKey },
      { id: 'share', label: window.junctionT('shareExportChat', 'Share / export chat'), icon: 'clippy', action: function () {
        window.dispatchEvent(new CustomEvent('junction-share-chat', { detail: { target: anchorEl } }));
      }},
      { id: 'settings', label: window.junctionT('settings', 'Settings'), icon: 'gear' }
    );
    window.choiceMenu.open(anchorEl, {
      title: window.junctionT('chatActions', 'Chat actions'),
      selectMessage: 'selectHeaderAction',
      items: items
    });
  }

  // ── Event wiring ───────────────────────────────────────────────────────

  function init() {
    var backBtn = document.getElementById('btn-back');
    var titleEl = document.getElementById('chat-title');
    var taskHistoryBtn = document.getElementById('btn-task-history');
    var menuBtn = document.getElementById('btn-menu');
    var settingsBtn = document.getElementById('btn-settings');
    var newChatBtn = document.getElementById('btn-new-chat-view');

    // ← Back button
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'backToSessions' });
      });
    }

    // Click title → inline edit
    if (titleEl) {
      titleEl.addEventListener('click', function () {
        startRename(titleEl);
      });
    }

    if (taskHistoryBtn) {
      taskHistoryBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (typeof window.openTaskHistoryPopover === 'function') window.openTaskHistoryPopover(taskHistoryBtn);
        else vscode.postMessage({ type: 'viewSessionList' });
      });
    }

    // ☰ Menu button → dropdown
    if (menuBtn) {
      menuBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleMenu(menuBtn);
      });
    }

    // ⚙ Settings button
    if (settingsBtn) {
      settingsBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'openSettings' });
      });
    }

    // [+] New chat button (in-chat view)
    if (newChatBtn) {
      newChatBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'createChat' });
      });
    }

    // Environment switcher moved to the composer footer (see composer.js).
  }

  // ── Message listener ───────────────────────────────────────────────────

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'updateTitle':
        if (msg.key !== undefined) {
          setSessionKey(msg.key);
        }
        if (msg.title !== undefined) {
          window.setChatTitle(msg.title);
        }
        break;
      case 'agentChoices':
        var menuBtn = document.getElementById('btn-menu');
        if (window.choiceMenu && menuBtn) {
          window.choiceMenu.open(menuBtn, {
            items: msg.items || [],
            emptyText: 'No agents available',
            selectMessage: 'selectAgentChoice'
          });
        }
        break;
      case 'startRename':
        var titleEl = document.getElementById('chat-title');
        if (titleEl) startRename(titleEl);
        break;
    }
  });

  // ── Bootstrap ──────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
