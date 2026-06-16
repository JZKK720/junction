/* ==========================================================================
   chat-header.js — Chat view header for Junction
   ==========================================================================
   Contract:
   - Global: setChatTitle(text)
   - Wires: #btn-back, #chat-title, #btn-menu, #btn-settings, #btn-new-chat-view
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
    titleEl.textContent = text || 'New chat';
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
    var currentTitle = titleEl.textContent;

    // Replace span with input
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'title-edit';
    input.value = currentTitle === 'New chat' ? '' : currentTitle;

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      var newTitle = input.value.trim() || 'New chat';
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
      finishEdit(input, currentTitle);
      window.setChatTitle(currentTitle);
    }

    function onKeydown(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    }

    function onBlur() {
      commit();
    }

    input.addEventListener('keydown', onKeydown);
    input.addEventListener('blur', onBlur);
  }

  function finishEdit(input, text) {
    // Recreate the span
    var span = document.createElement('span');
    span.id = 'chat-title';
    span.className = 'title';
    span.title = 'Click to rename';
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
      { id: 'rename', label: 'Rename', icon: 'edit' },
      { id: 'back', label: 'Back to chats', icon: 'list-unordered' },
      { id: 'usage', label: 'Session usage', icon: 'graph' },
      { id: 'agentPicker', label: 'Agent picker', icon: 'hubot' },
      { id: 'animationSettings', label: 'Animation settings', icon: 'symbol-color', action: function () {
        if (typeof window.toggleChatPreviewPanel === 'function') window.toggleChatPreviewPanel();
      }},
      { id: 'playCurtain', label: 'Play chat curtain', icon: 'comment', action: function () {
        if (typeof window.playChatCurtainPreview === 'function') window.playChatCurtainPreview();
      }},
      { id: 'playSplash', label: 'Play splash animation', icon: 'rocket', action: function () {
        if (typeof window.playSplashAnimationPreview === 'function') window.playSplashAnimationPreview();
      }}
    ];
    if (window.betaForkRewind) {
      items.push({ id: 'fork', label: 'Fork conversation (OpenClaw beta)', icon: 'git-branch' });
    }
    items.push(
      { id: 'archive', label: 'Archive', icon: 'archive', key: _sessionKey, disabled: !_sessionKey },
      { id: 'share', label: 'Share / export chat', icon: 'clippy', action: function () {
        window.dispatchEvent(new CustomEvent('junction-share-chat', { detail: { target: anchorEl } }));
      }},
      { id: 'settings', label: 'Settings', icon: 'gear' }
    );
    window.choiceMenu.open(anchorEl, {
      title: 'Chat actions',
      selectMessage: 'selectHeaderAction',
      items: items
    });
  }

  // ── Event wiring ───────────────────────────────────────────────────────

  function init() {
    var backBtn = document.getElementById('btn-back');
    var titleEl = document.getElementById('chat-title');
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
