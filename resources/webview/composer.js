/* ==========================================================================
   composer.js — Composer input, send/stop, slash menu, footer chips
   ==========================================================================
   Owns #composer-input, #btn-attach-file, #btn-send, #btn-stop, #slash-menu, #composer-footer.
   - Send-behavior modes: 'enter' | 'ctrlEnter' | 'smartEnter' (via `config`)
   - Slash-command menu: type '/' → suggestions from extension
   - Footer chips: model/reasoning + environment/sandbox controls
   - Drag-and-drop file paths into the composer
   Sends: sendMessage · stopRun · attachFile · slashComplete · requestModelChoices
   Listens: config · runActive · runComplete · slashSuggestions · modelDisplay · modelChoices

   Thin coordinator — imports logic from settings/config-section.js,
   settings/preview.js, and settings/splash-section.js.
   ========================================================================== */
(function () {
  'use strict';

  // Cross-script globals (set by chat-stream.js; fallback if loaded first)
  if (!window.animConfig) {
    window.animConfig = {
      speed: 1.0,
      fontSize: 1.0,
      density: 1.0,
      intensity: 1.0,
      loop: false,
      length: 2.0,
      bgColor: 'theme',
      bgAlpha: 0.0,
      widthMode: 'full',
      sizeOff: false,
      magic: false,
      curtainFade: 0.3,
      diffusionHeight: 1.0,
      noiseRes: 4,
      textFade: 0.5,
      cooling: 0.65,
      spread: 0.3,

      loaderMode: 'default',
      loaderSpeed: 1.0,
      loaderFontSize: 1.0,
      loaderDensity: 1.0,
      loaderIntensity: 1.0,
      loaderLength: 2.0,
      loaderBgColor: 'theme',
      loaderBgAlpha: 0.0,
      loaderLoop: true,
      loaderWidthMode: 'text',
      loaderSizeOff: false,
      loaderMagic: false,
      loaderNoiseRes: 4,
      loaderTextFade: 0.5,
      loaderCooling: 0.65,
      loaderSpread: 0.3
    };
  }
  try {
    var savedState = vscode.getState();
    if (savedState) {
      if (savedState.animConfig) {
        Object.assign(window.animConfig, savedState.animConfig);
      }
      if (savedState._junctionAnimationMode) {
        window._junctionAnimationMode = savedState._junctionAnimationMode;
      }
      if (savedState._junctionAnimColor) {
        window._junctionAnimColor = savedState._junctionAnimColor;
      }
    }
  } catch (e) {}

  var ANIM_MODES = window.ANIM_MODES || ['matrix','zalgo','fire','bounce','spiral','galaxy','leak'];
  window.ANIM_MODES = ANIM_MODES;
  var createAnimatedCanvas = window.createAnimatedCanvas || function () { return null; };
  window.createAnimatedCanvas = createAnimatedCanvas;
  var animationMode = window._junctionAnimationMode || 'matrix';
  var settingsSyncFunctions = [];
  window.settingsSyncFunctions = settingsSyncFunctions;

  // ── Color helpers (hoisted — used by chat + bobber + splash settings) ──
  window.parseAnimColor = function (str) {
    if (!str || str === '') return { hex: '#cccccc', a: 1 };
    var m = str.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
    if (m) {
      var r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      var hex = '#' + [r,g,b].map(function(v){return v.toString(16).padStart(2,'0');}).join('');
      return { hex: hex, a: m[4] !== undefined ? parseFloat(m[4]) : 1 };
    }
    if (str.charAt(0) === '#' && str.length === 7) return { hex: str, a: 1 };
    if (str.charAt(0) === '#' && str.length === 4) {
      return { hex: '#' + str[1]+str[1]+str[2]+str[2]+str[3]+str[3], a: 1 };
    }
    return { hex: '#cccccc', a: 1 };
  };
  window.toRgba = function (hex, a) {
    var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    if (a >= 0.99) return hex;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(2) + ')';
  };

  var composerInput = document.getElementById('composer-input');
  var btnAttachFile = document.getElementById('btn-attach-file');
  var btnSend = document.getElementById('btn-send');
  var btnStop = document.getElementById('btn-stop');
  var slashMenu = document.getElementById('slash-menu');
  var modelChip = document.getElementById('model-display');
  var sandboxChip = document.getElementById('sandbox-display');
  var envChip = document.getElementById('env-switcher');
  var contextHints = document.getElementById('context-hints');
  var queueList = document.getElementById('queued-followups');

  // ── Resizable composer input ─────────────────────────────────────────────
  (function () {
    var handle = document.getElementById('composer-resize-handle');
    var textarea = document.getElementById('composer-input');
    if (!handle || !textarea) return;
    var startY, startH;
    function onMove(ev) {
      var newH = startH + (startY - ev.clientY);
      newH = Math.max(48, Math.min(400, newH));
      textarea.style.height = newH + 'px';
      textarea.style.minHeight = newH + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist height
      try { vscode.setState(Object.assign({}, vscode.getState() || {}, { composerHeight: textarea.style.height })); } catch (_) {}
    }
    handle.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      startY = ev.clientY;
      startH = textarea.offsetHeight;
      document.body.style.cursor = 'n-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // Restore persisted height
    try {
      var st = vscode.getState();
      if (st && st.composerHeight) {
        textarea.style.height = st.composerHeight;
        textarea.style.minHeight = st.composerHeight;
      }
    } catch (_) {}
  })();

  if (!composerInput) return;

  // ── Expand button & Modal logic ──────────────────────────────────────────
  (function () {
    var expandBtn = document.getElementById('btn-composer-expand');
    if (!expandBtn) return;

    expandBtn.addEventListener('click', function () {
      var modal = document.createElement('div');
      modal.id = 'chat-expand-modal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';

      var panel = document.createElement('div');
      panel.style.cssText = 'width:90vw;max-width:900px;height:80vh;display:flex;flex-direction:column;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);border-radius:8px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);';

      var hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--vscode-input-border);';
      var hdrTitle = document.createElement('span');
      hdrTitle.textContent = 'Composer';
      hdrTitle.style.cssText = 'font-size:12px;font-weight:600;color:var(--vscode-editor-foreground);';
      var closeBtn = document.createElement('button');
      closeBtn.className = 'codicon codicon-close';
      closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--vscode-descriptionForeground);font-size:16px;padding:0;';
      hdr.appendChild(hdrTitle);
      hdr.appendChild(closeBtn);
      panel.appendChild(hdr);

      var ta = document.createElement('textarea');
      ta.style.cssText = 'flex:1;padding:12px;border:none;background:transparent;color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,14px);line-height:1.6;resize:none;outline:none;';
      ta.placeholder = 'Ask agent...';
      ta.value = composerInput.value;
      panel.appendChild(ta);

      var ftr = document.createElement('div');
      ftr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 12px;border-top:1px solid var(--vscode-input-border);';
      var ftrHint = document.createElement('span');
      ftrHint.textContent = 'ESC to close · Ctrl+Enter to send';
      ftrHint.style.cssText = 'font-size:10px;color:var(--vscode-editor-foreground);';
      var sendBtn = document.createElement('button');
      sendBtn.textContent = 'Send';
      sendBtn.style.cssText = 'padding:4px 16px;border-radius:3px;border:1px solid var(--vscode-button-background);background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font-size:12px;';
      ftr.appendChild(ftrHint);
      ftr.appendChild(sendBtn);
      panel.appendChild(ftr);

      modal.appendChild(panel);
      document.body.appendChild(modal);
      ta.focus();

      function closeModal() {
        composerInput.value = ta.value;
        composerInput.style.height = 'auto';
        composerInput.style.height = composerInput.scrollHeight + 'px';
        modal.remove();
      }

      closeBtn.addEventListener('click', closeModal);
      sendBtn.addEventListener('click', function () {
        closeModal();
        send();
      });

      modal.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
          closeModal();
        }
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          closeModal();
          send();
        }
      });

      modal.addEventListener('click', function (ev) {
        if (ev.target === modal) closeModal();
      });
    });
  })();

  var sendBehavior = 'enter';
  var steerKeybinding = '';
  var isSending = false;

  function post(type, data) { vscode.postMessage(Object.assign({ type: type }, data || {})); }
  function isSingleLine() { return !composerInput.value.includes('\n'); }

  function parseKeybindingEvent(e, binding) {
    var parts = binding.toLowerCase().split('+');
    var hasCtrl = false;
    var hasShift = false;
    var hasAlt = false;
    var hasMeta = false;
    var key = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p === 'ctrl' || p === 'control') hasCtrl = true;
      else if (p === 'shift') hasShift = true;
      else if (p === 'alt') hasAlt = true;
      else if (p === 'meta' || p === 'cmd' || p === 'command') hasMeta = true;
      else key = p;
    }
    var eKey = e.key.toLowerCase();
    if (e.ctrlKey !== hasCtrl) return false;
    if (e.shiftKey !== hasShift) return false;
    if (e.altKey !== hasAlt) return false;
    if (e.metaKey !== hasMeta) return false;
    if (eKey !== key) return false;
    return true;
  }

  function setSending(active) {
    isSending = !!active;
    updateSendButton();
  }

  function updateSendButton() {
    if (!btnSend) return;
    var hasText = composerInput && composerInput.value.trim().length > 0;
    if (isSending && !hasText) {
      // Running + empty → stop
      btnSend.className = 'codicon codicon-circle-slash';
      btnSend.title = 'Stop';
      btnSend.onclick = function () { post('stopRun', {}); };
    } else {
      // Idle, or running+hasText → send
      btnSend.className = 'codicon codicon-send';
      btnSend.title = 'Send';
      btnSend.onclick = function () { window.composerSend && window.composerSend(); };
    }
  }

  // When user types/clears while running, update button state
  composerInput.addEventListener('input', function () {
    if (isSending) updateSendButton();
  });

  function send(dispatchOverride) {
    var text = composerInput.value.trim();
    if (!text) return;
    post('sendMessage', { text: text, dispatchOverride: dispatchOverride });
    composerInput.value = '';
    composerInput.style.height = 'auto';
    hideSlashMenu();
    // Don't disable here — wait for 'runActive' from extension.
    // If gateway doesn't support lifecycle events, button stays enabled.
  }

  function renderQueue(items) {
    if (!queueList) return;
    queueList.innerHTML = '';
    var list = Array.isArray(items) ? items : [];
    queueList.hidden = list.length === 0;
    list.forEach(function (item, index) {
      var row = document.createElement('div');
      row.className = 'queued-followup' + (item.groupWithPrevious ? ' grouped' : '');
      row.dataset.index = String(index);

      var idx = document.createElement('span');
      idx.className = 'queued-followup-index';
      idx.textContent = String(index + 1);
      row.appendChild(idx);

      var text = document.createElement('div');
      text.className = 'queued-followup-text';
      text.textContent = item.text || '';
      text.title = item.text || '';
      row.appendChild(text);

      var actions = document.createElement('div');
      actions.className = 'queued-followup-actions';
      function iconButton(icon, title, fn) {
        var btn = document.createElement('button');
        btn.className = 'codicon codicon-' + icon;
        btn.title = title;
        btn.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          fn(btn);
        });
        actions.appendChild(btn);
        return btn;
      }
      var up = iconButton('chevron-up', 'Move up', function () {
        post('moveQueuedFollowUp', { index: index, direction: 'up' });
      });
      up.disabled = index === 0;
      var down = iconButton('chevron-down', 'Move down', function () {
        post('moveQueuedFollowUp', { index: index, direction: 'down' });
      });
      down.disabled = index === list.length - 1;
      var group = iconButton('link', 'Group with previous', function () {
        post('toggleQueuedFollowUpGroup', { index: index });
      });
      group.disabled = index === 0;
      if (item.groupWithPrevious) group.classList.add('active');
      iconButton('edit', 'Edit queued text', function () {
        startQueueEdit(row, index, item.text || '');
      });
      iconButton('trash', 'Remove queued text', function () {
        post('removeQueuedFollowUp', { index: index });
      });
      row.appendChild(actions);
      queueList.appendChild(row);
    });
  }

  function startQueueEdit(row, index, value) {
    if (!row || row.querySelector('.queued-followup-edit')) return;
    var textarea = document.createElement('textarea');
    textarea.className = 'queued-followup-edit';
    textarea.value = value;
    var save = document.createElement('button');
    save.className = 'codicon codicon-check';
    save.title = 'Save queued text';
    var cancel = document.createElement('button');
    cancel.className = 'codicon codicon-close';
    cancel.title = 'Cancel edit';
    var actions = row.querySelector('.queued-followup-actions');
    function closeEdit() {
      textarea.remove();
      save.remove();
      cancel.remove();
    }
    save.addEventListener('click', function () {
      post('editQueuedFollowUp', { index: index, text: textarea.value });
      closeEdit();
    });
    cancel.addEventListener('click', closeEdit);
    row.appendChild(textarea);
    if (actions) {
      actions.appendChild(save);
      actions.appendChild(cancel);
    }
    textarea.focus();
    textarea.select();
  }

  // ── Keydown: send-behavior modes ────────────────────────────────────────────
  composerInput.addEventListener('keydown', function (e) {
    if (slashMenu && !slashMenu.hidden && e.key === 'Escape') { hideSlashMenu(); return; }

    // Check if custom steer keybinding matches
    if (steerKeybinding && steerKeybinding.trim() !== '') {
      if (parseKeybindingEvent(e, steerKeybinding)) {
        e.preventDefault();
        send('steer');
        return;
      }
    }

    if (e.key !== 'Enter') return;
    // Ctrl+Enter always sends in any mode
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault(); send(); return;
    }
    // Plain Enter behavior depends on mode
    if (sendBehavior === 'ctrlEnter') {
      return; // plain Enter adds newline in ctrlEnter mode
    } else if (sendBehavior === 'smartEnter') {
      if (isSingleLine()) { e.preventDefault(); send(); }
    } else {
      e.preventDefault(); send();
    }
  });

  // ── Auto-resize + slash detection ────────────────────────────────────────────
  composerInput.addEventListener('input', function () {
    composerInput.style.height = 'auto';
    composerInput.style.height = composerInput.scrollHeight + 'px';
    var val = composerInput.value;
    if (val.startsWith('/') && !val.includes('\n')) {
      post('slashComplete', { prefix: val.slice(1) });
    } else {
      hideSlashMenu();
    }
  });

  if (btnStop) btnStop.addEventListener('click', function () { post('stopRun'); });
  if (btnAttachFile) btnAttachFile.addEventListener('click', function () { post('attachFile'); });

  if (contextHints) {
    contextHints.addEventListener('click', function (e) {
      var target = e.target.closest('button');
      if (!target) return;
      var action = target.dataset.action;
      if (action === 'attach-current') post('attachCurrentFile');
    });
  }

  // ── Slash menu ───────────────────────────────────────────────────────────────
  function hideSlashMenu() { if (slashMenu) { slashMenu.hidden = true; slashMenu.innerHTML = ''; } }
  function renderSlash(suggestions) {
    if (!slashMenu) return;
    slashMenu.innerHTML = '';
    if (!suggestions || !suggestions.length) { hideSlashMenu(); return; }
    suggestions.forEach(function (cmd) {
      var item = document.createElement('div');
      item.className = 'slash-item';
      item.title = cmd.description || ('/' + cmd.name);
      item.innerHTML = '<span class="slash-name">/' + escapeHtml(cmd.name) + '</span>' +
        (cmd.description ? '<span class="slash-desc">' + escapeHtml(cmd.description) + '</span>' : '');
      item.addEventListener('click', function () {
        composerInput.value = '/' + cmd.name + ' ';
        hideSlashMenu();
        composerInput.focus();
      });
      slashMenu.appendChild(item);
    });
    slashMenu.hidden = false;
  }
  function escapeHtml(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Footer chips ───────────────────────────────────────────────────────────────
  if (modelChip) modelChip.addEventListener('click', function () {
    if (window.choiceMenu) {
      window.choiceMenu.open(modelChip, {
        title: 'Model',
        loading: true,
        selectMessage: 'selectModelChoice',
      });
    }
    post('requestModelChoices');
  });
  if (sandboxChip) sandboxChip.addEventListener('click', function () {
    if (window.choiceMenu) {
      window.choiceMenu.open(sandboxChip, {
        title: 'Sandbox / approvals',
        loading: true,
        selectMessage: 'selectSandboxChoice',
      });
    }
    post('requestSandboxChoices');
  });
  // Environment switcher (bridge/runtime + agent) — bottom-left of the footer.
  if (envChip) envChip.addEventListener('click', function () {
    if (window.choiceMenu) {
      window.choiceMenu.open(envChip, {
        loading: true,
        selectMessage: 'selectEnvironmentChoice',
      });
    }
    post('requestEnvironmentChoices');
  });
  // ── Drag-and-drop file paths ───────────────────────────────────────────────────
  composerInput.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  composerInput.addEventListener('drop', function (e) {
    e.preventDefault();
    var uriList = e.dataTransfer.getData('text/uri-list');
    var text = '';
    if (uriList) {
      var fileUris = uriList.split('\n').filter(function (l) { return l.startsWith('file://'); });
      if (fileUris.length) text = fileUris.map(function (u) { return decodeURIComponent(u.replace('file://', '')); }).join('\n');
    }
    if (!text) text = e.dataTransfer.getData('text/plain');
    if (text) {
      var pos = composerInput.selectionStart;
      composerInput.value = composerInput.value.substring(0, pos) + text + composerInput.value.substring(composerInput.selectionEnd);
    }
  });

  // ── Inbound ──────────────────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'config':
        if (msg.sendBehavior) sendBehavior = msg.sendBehavior;
        if (msg.steerKeybinding !== undefined) steerKeybinding = msg.steerKeybinding;
        if (msg.animConfig) {
          Object.assign(window.animConfig, msg.animConfig);
        }
        if (msg.animationMode) {
          animationMode = msg.animationMode;
          window._junctionAnimationMode = msg.animationMode;
        }
        if (msg.animColor) {
          window._junctionAnimColor = msg.animColor;
        }
        if (msg.loaderColor) {
          window._junctionLoaderAnimColor = msg.loaderColor;
        }
        if (msg.splashColor) {
          window._junctionSplashColor = msg.splashColor;
        }
        // Run all registered sync functions (updates mode buttons, sliders, colors, etc.)
        settingsSyncFunctions.forEach(function (fn) {
          try { fn(); } catch (e) {}
        });
        break;
      case 'runActive':
        setSending(!!msg.active);
        break;
      case 'runComplete':
        setSending(false);
        break;
      case 'slashSuggestions':
        renderSlash(msg.suggestions);
        break;
      case 'modelDisplay':
        if (modelChip) {
          var label = msg.model || 'Model';
          if (msg.reasoning) label += ' · ' + msg.reasoning;
          modelChip.textContent = label;
          modelChip.title = msg.reasoning ? 'Change model / reasoning' : 'Change model';
        }
        break;
      case 'modelChoices':
        if (window.choiceMenu && modelChip) {
          window.choiceMenu.open(modelChip, {
            title: 'Model',
            items: msg.items || [],
            emptyText: 'No models available',
            selectMessage: 'selectModelChoice',
          });
        }
        break;
      case 'sandboxDisplay':
        if (sandboxChip) {
          sandboxChip.textContent = msg.label || 'Sandbox';
          sandboxChip.title = msg.description || 'Sandbox / approvals';
        }
        break;
      case 'sandboxChoices':
        if (window.choiceMenu && sandboxChip) {
          window.choiceMenu.open(sandboxChip, {
            title: 'Sandbox / approvals',
            items: msg.items || [],
            emptyText: 'No sandbox controls available',
            selectMessage: 'selectSandboxChoice',
          });
        }
        break;
      case 'envLabel':
        var envLabel = document.getElementById('env-switcher-label');
        if (envLabel && msg.label) envLabel.textContent = msg.label;
        break;
      case 'environmentChoices':
        if (window.choiceMenu && envChip) {
          window.choiceMenu.open(envChip, {
            items: msg.items || [],
            emptyText: 'No gateways or agents available',
            selectMessage: 'selectEnvironmentChoice',
          });
        }
        break;
      case 'queueState':
        renderQueue(msg.items || []);
        break;
    }
  });

  // Public API for other modules
  window.resetComposer = function () { composerInput.value = ''; composerInput.style.height = 'auto'; setSending(false); };
  window.setComposerActive = function (active) { setSending(active); };
  window.composerSend = function () { send(); };
  // Animation mode access — shared between composer and chat-stream
  Object.defineProperty(window, 'junctionAnimationMode', {
    get: function () { return window._junctionAnimationMode || 'matrix'; },
    set: function (v) { window._junctionAnimationMode = v; },
    configurable: true
  });
})();
