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
   ========================================================================== */
(function () {
  'use strict';

  // Cross-script globals (set by chat-stream.js; fallback if loaded first)
  var ANIM_MODES = window.ANIM_MODES || ['matrix','zalgo','fire','bounce','spiral'];
  var createAnimatedCanvas = window.createAnimatedCanvas || function () { return null; };
  var animationMode = window._junctionAnimationMode || 'matrix';
  // Re-sync when chat-stream.js loads later
  Object.defineProperty(window, 'ANIM_MODES', {
    get: function () { return ANIM_MODES; },
    set: function (v) { ANIM_MODES = v; },
    configurable: true
  });
  Object.defineProperty(window, 'createAnimatedCanvas', {
    get: function () { return createAnimatedCanvas; },
    set: function (v) { createAnimatedCanvas = v; },
    configurable: true
  });

  var composerInput = document.getElementById('composer-input');
  var btnAttachFile = document.getElementById('btn-attach-file');
  var btnSend = document.getElementById('btn-send');
  var btnStop = document.getElementById('btn-stop');
  var slashMenu = document.getElementById('slash-menu');
  var modelChip = document.getElementById('model-display');
  var sandboxChip = document.getElementById('sandbox-display');
  var envChip = document.getElementById('env-switcher');
  var contextHints = document.getElementById('context-hints');

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

  var sendBehavior = 'enter';
  var isSending = false;

  function post(type, data) { vscode.postMessage(Object.assign({ type: type }, data || {})); }
  function isSingleLine() { return !composerInput.value.includes('\n'); }

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

  // ── Keydown: send-behavior modes ────────────────────────────────────────────
  composerInput.addEventListener('keydown', function (e) {
    if (slashMenu && !slashMenu.hidden && e.key === 'Escape') { hideSlashMenu(); return; }
    if (e.key !== 'Enter') return;
    // Ctrl+Shift+Enter always sends (steer override)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault(); send('steer'); return;
    }
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

  if (btnSend) btnSend.addEventListener('click', send);

  // ── Re-animate all text messages ──────────────────────────────────────────
  var btnReanimate = document.getElementById('btn-reanimate');
  if (btnReanimate) {
    btnReanimate.addEventListener('click', function () {
      if (typeof window.reanimateAllMessages === 'function') {
        window.reanimateAllMessages();
      }
    });
  }

  // ── Animation preview + controls ──────────────────────────────────────────
  var btnPreviewAnim = document.getElementById('btn-preview-anim');
  if (btnPreviewAnim) {
    btnPreviewAnim.addEventListener('click', function () {
      var existing = document.getElementById('anim-preview-box');
      if (existing) {
        var oldCanvas = existing.querySelector('canvas.pretext-canvas');
        if (oldCanvas && typeof oldCanvas._stopAnimation === 'function') {
          oldCanvas._stopAnimation();
        }
        existing.remove();
        return;
      }
      var box = document.createElement('div');
      box.id = 'anim-preview-box';
      box.style.cssText = 'padding:8px;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);border-radius:4px;margin:4px 0;';

      // Preview area defined early so refreshPreview can reference it
      var previewArea = document.createElement('div');
      previewArea.style.cssText = 'display:flex;justify-content:center;padding:4px 0;min-height:60px;';

      function refreshPreview() {
        var oldCanvas = previewArea.querySelector('canvas.pretext-canvas');
        if (oldCanvas) {
          if (typeof oldCanvas._stopAnimation === 'function') {
            oldCanvas._stopAnimation();
          }
          oldCanvas.remove();
        }
        var canvas = createAnimatedCanvas('Hello world, this is a test.', { width: 300 });
        if (canvas) {
          canvas.style.maxWidth = '280px';
          if (window.animConfig.opacity !== undefined) {
            canvas.style.opacity = window.animConfig.opacity;
          }
          previewArea.appendChild(canvas);
        }
      }

      // Mode selector row
      var modeRow = document.createElement('div');
      modeRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;align-items:center;';
      var modeLabel = document.createElement('span');
      modeLabel.textContent = 'Mode:';
      modeLabel.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);margin-right:4px;';
      modeRow.appendChild(modeLabel);

      ANIM_MODES.forEach(function (mode) {
        var btn = document.createElement('button');
        btn.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
        btn.style.cssText = 'background:' + (animationMode === mode ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)') + ';color:' + (animationMode === mode ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)') + ';border:1px solid var(--vscode-input-border);padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;';
        btn.addEventListener('click', function () {
          animationMode = mode;
          window._junctionAnimationMode = mode;
          refreshPreview();
          // Update button styles
          modeRow.querySelectorAll('button').forEach(function (b) {
            b.style.background = 'var(--vscode-input-background)';
            b.style.color = 'var(--vscode-editor-foreground)';
          });
          btn.style.background = 'var(--vscode-button-background)';
          btn.style.color = 'var(--vscode-button-foreground)';
          if (typeof window.refreshWorking === 'function') window.refreshWorking();
        });
        modeRow.appendChild(btn);
      });
      box.appendChild(modeRow);

      // Controls row
      var ctrlRow = document.createElement('div');
      ctrlRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px;align-items:center;';
      function makeSlider(label, key, min, max, step) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;align-items:center;gap:3px;';
        var lbl = document.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'font-size:9px;color:var(--vscode-descriptionForeground);min-width:32px;';
        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = min; slider.max = max; slider.step = step;
        slider.value = window.animConfig[key] !== undefined ? window.animConfig[key] : 1.0;
        slider.style.cssText = 'width:60px;height:12px;';
        var val = document.createElement('span');
        val.textContent = slider.value;
        val.style.cssText = 'font-size:9px;color:var(--vscode-descriptionForeground);min-width:20px;text-align:right;';
        slider.addEventListener('input', function () {
          var num = parseFloat(this.value);
          window.animConfig[key] = num;
          val.textContent = this.value;
          refreshPreview();
          if (key === 'bgAlpha' && typeof window.updateAllCanvasBackgrounds === 'function') {
            window.updateAllCanvasBackgrounds();
          }
          if (typeof window.refreshWorking === 'function') window.refreshWorking();
        });
        wrap.appendChild(lbl);
        wrap.appendChild(slider);
        wrap.appendChild(val);
        return wrap;
      }
      ctrlRow.appendChild(makeSlider('Speed', 'speed', 0.25, 4, 0.25));
      ctrlRow.appendChild(makeSlider('Size', 'fontSize', 0.5, 2, 0.1));
      ctrlRow.appendChild(makeSlider('Dens', 'density', 0.25, 2, 0.25));
      ctrlRow.appendChild(makeSlider('Int', 'intensity', 0.25, 2, 0.25));
      ctrlRow.appendChild(makeSlider('Len', 'length', 0.5, 5, 0.1));
      ctrlRow.appendChild(makeSlider('BG Opacity', 'bgAlpha', 0, 1.0, 0.05));
      box.appendChild(ctrlRow);

      // Toggles row (Loop & Color)
      var togglesRow = document.createElement('div');
      togglesRow.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center;flex-wrap:wrap;';

      var loopBtn = document.createElement('button');
      loopBtn.textContent = 'Loop: ' + (window.animConfig.loop ? 'ON' : 'OFF');
      loopBtn.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);background:' + (window.animConfig.loop ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)') + ';color:' + (window.animConfig.loop ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)') + ';';
      loopBtn.addEventListener('click', function () {
        window.animConfig.loop = !window.animConfig.loop;
        loopBtn.textContent = 'Loop: ' + (window.animConfig.loop ? 'ON' : 'OFF');
        loopBtn.style.background = window.animConfig.loop ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
        loopBtn.style.color = window.animConfig.loop ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
        refreshPreview();
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
      });
      togglesRow.appendChild(loopBtn);

      var colorLabel = document.createElement('span');
      colorLabel.textContent = 'Color:';
      colorLabel.style.cssText = 'font-size:9px;color:var(--vscode-descriptionForeground);margin-left:8px;';
      togglesRow.appendChild(colorLabel);

      var greenBtn = document.createElement('button');
      greenBtn.textContent = 'Green';
      greenBtn.style.cssText = 'padding:2px 6px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);background:' + (window._junctionAnimColor === '#10a37f' ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)') + ';color:' + (window._junctionAnimColor === '#10a37f' ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)') + ';';

      var themeBtn = document.createElement('button');
      themeBtn.textContent = 'Theme';
      themeBtn.style.cssText = 'padding:2px 6px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);background:' + (window._junctionAnimColor !== '#10a37f' ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)') + ';color:' + (window._junctionAnimColor !== '#10a37f' ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)') + ';';

      greenBtn.addEventListener('click', function () {
        window._junctionAnimColor = '#10a37f';
        greenBtn.style.background = 'var(--vscode-button-background)';
        greenBtn.style.color = 'var(--vscode-button-foreground)';
        themeBtn.style.background = 'var(--vscode-input-background)';
        themeBtn.style.color = 'var(--vscode-editor-foreground)';
        refreshPreview();
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
      });

      themeBtn.addEventListener('click', function () {
        window._junctionAnimColor = getComputedStyle(document.body).color || '#ccc';
        themeBtn.style.background = 'var(--vscode-button-background)';
        themeBtn.style.color = 'var(--vscode-button-foreground)';
        greenBtn.style.background = 'var(--vscode-input-background)';
        greenBtn.style.color = 'var(--vscode-editor-foreground)';
        refreshPreview();
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
      });

      togglesRow.appendChild(greenBtn);
      togglesRow.appendChild(themeBtn);
      box.appendChild(togglesRow);

      box.appendChild(previewArea);
      refreshPreview();

      var inputArea = document.querySelector('#composer-shell');
      if (inputArea) inputArea.parentNode.insertBefore(box, inputArea);
    });
  }

  // ── Animation settings dropdown ──────────────────────────────────────────
  var btnAnimSettings = document.getElementById('btn-anim-settings');
  if (btnAnimSettings) {
    btnAnimSettings.addEventListener('click', function (e) {
      e.stopPropagation();
      var existing = document.getElementById('anim-settings-box');
      if (existing) { existing.remove(); return; }
      var box = document.createElement('div');
      box.id = 'anim-settings-box';
      box.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:9999;padding:10px;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.3);min-width:260px;max-width:320px;';

      // Header
      var hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
      var title = document.createElement('span');
      title.textContent = 'Animation Settings';
      title.style.cssText = 'font-size:11px;font-weight:600;color:var(--vscode-editor-foreground);';
      var closeBtn = document.createElement('button');
      closeBtn.className = 'codicon codicon-close';
      closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--vscode-descriptionForeground);font-size:14px;padding:0;';
      closeBtn.addEventListener('click', function () { box.remove(); });
      hdr.appendChild(title);
      hdr.appendChild(closeBtn);
      box.appendChild(hdr);

      // Mode selector
      var modeRow = document.createElement('div');
      modeRow.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;margin-bottom:8px;';
      ANIM_MODES.forEach(function (mode) {
        var btn = document.createElement('button');
        btn.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
        btn.style.cssText = 'background:' + (animationMode === mode ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)') + ';color:' + (animationMode === mode ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)') + ';border:1px solid var(--vscode-input-border);padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;';
        btn.addEventListener('click', function () {
          animationMode = mode;
          window._junctionAnimationMode = mode;
          modeRow.querySelectorAll('button').forEach(function (b) {
            b.style.background = 'var(--vscode-input-background)';
            b.style.color = 'var(--vscode-editor-foreground)';
          });
          btn.style.background = 'var(--vscode-button-background)';
          btn.style.color = 'var(--vscode-button-foreground)';
          if (typeof window.refreshWorking === 'function') window.refreshWorking();
        });
        modeRow.appendChild(btn);
      });
      box.appendChild(modeRow);

      // Sliders
      function makeSlider(label, key, min, max, step, onChange) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;';
        var lbl = document.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);min-width:50px;';
        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = min; slider.max = max; slider.step = step;
        slider.value = window.animConfig[key];
        slider.style.cssText = 'flex:1;height:12px;';
        var val = document.createElement('span');
        val.textContent = window.animConfig[key];
        val.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);min-width:24px;text-align:right;';
        slider.addEventListener('input', function () {
          window.animConfig[key] = parseFloat(this.value);
          val.textContent = this.value;
          if (onChange) onChange(this.value);
          if (typeof window.refreshWorking === 'function') window.refreshWorking();
        });
        wrap.appendChild(lbl);
        wrap.appendChild(slider);
        wrap.appendChild(val);
        return wrap;
      }
      box.appendChild(makeSlider('Speed', 'speed', 0.25, 4, 0.25));
      box.appendChild(makeSlider('Size', 'fontSize', 0.5, 2, 0.1));
      box.appendChild(makeSlider('Dens', 'density', 0.25, 2, 0.25));
      box.appendChild(makeSlider('Int', 'intensity', 0.25, 2, 0.25));

      // Color mode toggle
      var colorRow = document.createElement('div');
      colorRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;margin-bottom:4px;';
      var colorLabel = document.createElement('span');
      colorLabel.textContent = 'Color:';
      colorLabel.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);';
      var greenBtn = document.createElement('button');
      greenBtn.textContent = 'Green';
      greenBtn.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);background:' + (window._junctionAnimColor === '#10a37f' ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)') + ';color:' + (window._junctionAnimColor === '#10a37f' ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)') + ';';
      var themeBtn = document.createElement('button');
      themeBtn.textContent = 'Theme';
      themeBtn.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);background:' + (window._junctionAnimColor !== '#10a37f' ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)') + ';color:' + (window._junctionAnimColor !== '#10a37f' ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)') + ';';
      greenBtn.addEventListener('click', function () {
        window._junctionAnimColor = '#10a37f';
        greenBtn.style.background = 'var(--vscode-button-background)';
        greenBtn.style.color = 'var(--vscode-button-foreground)';
        themeBtn.style.background = 'var(--vscode-input-background)';
        themeBtn.style.color = 'var(--vscode-editor-foreground)';
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
      });
      themeBtn.addEventListener('click', function () {
        window._junctionAnimColor = getComputedStyle(document.body).color || '#ccc';
        themeBtn.style.background = 'var(--vscode-button-background)';
        themeBtn.style.color = 'var(--vscode-button-foreground)';
        greenBtn.style.background = 'var(--vscode-input-background)';
        greenBtn.style.color = 'var(--vscode-editor-foreground)';
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
      });
      colorRow.appendChild(colorLabel);
      colorRow.appendChild(greenBtn);
      colorRow.appendChild(themeBtn);
      box.appendChild(colorRow);

      // Background color selector - single cycle button
      var bgRow = document.createElement('div');
      bgRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;margin-bottom:4px;';
      var bgLabel = document.createElement('span');
      bgLabel.textContent = 'BG Color:';
      bgLabel.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);min-width:50px;';

      var bgBtn = document.createElement('button');
      bgBtn.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-editor-foreground);flex:1;';

      var bgOptions = [
        { val: 'theme', text: 'Theme BG' },
        { val: '#000000', text: 'Black' },
        { val: '#ffffff', text: 'White' },
        { val: '#1e1e1e', text: 'Dark Grey' },
        { val: '#101014', text: 'Midnight' }
      ];

      function updateBgButton() {
        var currentVal = window.animConfig.bgColor || 'theme';
        var currentOpt = bgOptions.find(function (o) { return o.val === currentVal; }) || bgOptions[0];
        bgBtn.textContent = currentOpt.text;
      }

      bgBtn.addEventListener('click', function () {
        var currentVal = window.animConfig.bgColor || 'theme';
        var idx = bgOptions.findIndex(function (o) { return o.val === currentVal; });
        var nextIdx = (idx + 1) % bgOptions.length;
        window.animConfig.bgColor = bgOptions[nextIdx].val;
        updateBgButton();
        if (typeof window.updateAllCanvasBackgrounds === 'function') {
          window.updateAllCanvasBackgrounds();
        }
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
      });

      updateBgButton();
      bgRow.appendChild(bgLabel);
      bgRow.appendChild(bgBtn);
      box.appendChild(bgRow);

      // BG Opacity slider (controls CSS element background color opacity)
      box.appendChild(makeSlider('BG Opacity', 'bgAlpha', 0, 1, 0.05, function (v) {
        if (typeof window.updateAllCanvasBackgrounds === 'function') {
          window.updateAllCanvasBackgrounds();
        }
      }));

      document.body.appendChild(box);

      // Close on click outside
      setTimeout(function () {
        document.addEventListener('click', function handler(ev) {
          if (!box.contains(ev.target) && ev.target !== btnAnimSettings) {
            box.remove();
            document.removeEventListener('click', handler);
          }
        });
      }, 0);
    });
  }


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
        title: 'Bridge / agent',
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
            title: 'Bridge / agent',
            items: msg.items || [],
            emptyText: 'No gateways or agents available',
            selectMessage: 'selectEnvironmentChoice',
          });
        }
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
