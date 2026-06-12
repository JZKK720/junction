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
      widthMode: 'text',
      sizeOff: false,
      magic: false,
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

  // ── Color helpers (hoisted — used by chat + bobber + splash settings) ──
  function parseAnimColor(str) {
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
  }
  function toRgba(hex, a) {
    var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    if (a >= 0.99) return hex;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(2) + ')';
  }

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
    btnReanimate.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.choiceMenu) {
        window.choiceMenu.open(btnReanimate, {
          title: 'Play Animation',
          items: [
            {
              id: 'play_splash',
              label: 'Play splash animation',
              icon: 'rocket',
              action: function () {
                if (typeof window.playSplashAnimationPreview === 'function') {
                  window.playSplashAnimationPreview();
                }
              }
            },
            {
              id: 'play_chat',
              label: 'Play chat animation',
              icon: 'comment',
              action: function () {
                if (typeof window.reanimateAllMessages === 'function') {
                  window.reanimateAllMessages();
                }
              }
            }
          ]
        });
      } else {
        if (typeof window.reanimateAllMessages === 'function') {
          window.reanimateAllMessages();
        }
      }
    });
  }

  // ── Animation preview + controls ──────────────────────────────────────────
  var btnPreviewAnim = document.getElementById('btn-preview-anim');

  function toggleChatPreviewPanel() {
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

    var activeTab = 'chat'; // 'chat' or 'bobber'

    function refreshPreview() {
      var oldCanvas = previewArea.querySelector('canvas.pretext-canvas');
      if (oldCanvas) {
        if (typeof oldCanvas._stopAnimation === 'function') {
          oldCanvas._stopAnimation();
        }
        oldCanvas.remove();
      }
      var existingFullScreen = document.querySelectorAll('canvas.full-screen-anim');
      existingFullScreen.forEach(function (c) {
        if (c._stopAnimation) {
          try { c._stopAnimation(); } catch (e) {}
        } else {
          c.remove();
        }
      });

      if (activeTab === 'chat') {
        var isMagic = !!(window.animConfig && window.animConfig.magic);
        var cfg = window.animConfig || {};
        var opts = {
          duration: Math.round((cfg.length || 2.0) * 1000),
          mode: cfg.mode || window._junctionAnimationMode || 'matrix',
          loop: !!cfg.loop
        };
        if (isMagic) {
          var rect = previewArea.getBoundingClientRect();
          if (rect.width <= 0) {
            rect = { left: window.innerWidth / 2 - 150, top: window.innerHeight - 150, width: 300, height: 60 };
          }
          opts.unbounded = true;
          opts.rect = rect;
        } else {
          opts.width = 300;
        }

        var canvas = createAnimatedCanvas('Hello world, this is a test.', opts);
        if (canvas) {
          if (isMagic) {
            document.body.appendChild(canvas);
            setTimeout(function () {
              if (canvas && typeof canvas._stopAnimation === 'function') {
                canvas._stopAnimation();
              }
              canvas.remove();
            }, 850);
          } else {
            canvas.style.maxWidth = '280px';
            if (window.animConfig.opacity !== undefined) {
              canvas.style.opacity = window.animConfig.opacity;
            }
            previewArea.appendChild(canvas);
          }
        }
      } else {
        // activeTab === 'bobber'
        var cfg = window.animConfig || {};
        var opts = {
          loader: true,
          isSplash: true,
          width: 300,
          height: 60,
          loaderLoop: !!cfg.loaderLoop
        };
        var canvas = createAnimatedCanvas('Junction', opts);
        if (canvas) {
          canvas.style.maxWidth = '280px';
          previewArea.appendChild(canvas);
        }
      }
    }

    // Tabs Row
    var tabsRow = document.createElement('div');
    tabsRow.style.cssText = 'display:flex;border-bottom:1px solid var(--vscode-panel-border);margin-bottom:8px;padding-bottom:4px;gap:12px;';

    var tabChat = document.createElement('span');
    tabChat.textContent = 'Chat Messages';
    tabChat.style.cssText = 'cursor:pointer;font-size:11px;font-weight:bold;color:var(--vscode-button-foreground);border-bottom:2px solid var(--vscode-button-background);padding:2px 4px;';

    var tabBobber = document.createElement('span');
    tabBobber.textContent = 'Bobber Settings';
    tabBobber.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';

    var tabSplash = document.createElement('span');
    tabSplash.textContent = 'Splash';
    tabSplash.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';

    tabsRow.appendChild(tabChat);
    tabsRow.appendChild(tabBobber);
    tabsRow.appendChild(tabSplash);
    box.appendChild(tabsRow);

    function buildConfigSection(isLoader) {
      var section = document.createElement('div');

      // Mode Selector
      var modeRow = document.createElement('div');
      modeRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;align-items:center;';
      var modeLabel = document.createElement('span');
      modeLabel.textContent = isLoader ? 'Style:' : 'Mode:';
      modeLabel.style.cssText = 'font-size:10px;color:var(--vscode-editor-foreground);margin-right:4px;';
      modeRow.appendChild(modeLabel);

      var modesList = isLoader 
        ? [{val:'default', label:'Same as Chat'}, {val:'matrix', label:'Matrix'}, {val:'zalgo', label:'Zalgo'}, {val:'fire', label:'Fire'}, {val:'bounce', label:'Bounce'}, {val:'spiral', label:'Spiral'}, {val:'galaxy', label:'Galaxy'}, {val:'leak', label:'Leak'}]
        : ANIM_MODES.map(function(m) { return {val: m, label: m.charAt(0).toUpperCase() + m.slice(1)}; });

      modesList.forEach(function (opt) {
        var btn = document.createElement('button');
        btn.textContent = opt.label;
        var currentMode = isLoader 
          ? (window.animConfig.loaderMode || 'default') 
          : (window._junctionAnimationMode || 'matrix');
        
        btn.style.cssText = 'background:' + (currentMode === opt.val ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)') + ';color:' + (currentMode === opt.val ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)') + ';border:1px solid var(--vscode-input-border);padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;';
        btn.addEventListener('click', function () {
          if (isLoader) {
            window.animConfig.loaderMode = opt.val;
          } else {
            animationMode = opt.val;
            window._junctionAnimationMode = opt.val;
          }
          refreshPreview();
          modeRow.querySelectorAll('button').forEach(function (b, idx) {
            var activeVal = modesList[idx].val;
            var isActive = isLoader 
              ? (window.animConfig.loaderMode === activeVal)
              : (window._junctionAnimationMode === activeVal);
            b.style.background = isActive ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
            b.style.color = isActive ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
          });
          if (typeof window.refreshWorking === 'function') window.refreshWorking();
          if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
        });
        modeRow.appendChild(btn);
      });
      section.appendChild(modeRow);

      // Sliders Row
      var ctrlRow = document.createElement('div');
      ctrlRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px;align-items:center;';
      
      function makeSlider(label, key, min, max, step) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;align-items:center;gap:3px;';
        var lbl = document.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:32px;';
        
        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = min; slider.max = max; slider.step = step;
        
        var actualKey = isLoader ? ('loader' + key.charAt(0).toUpperCase() + key.slice(1)) : key;
        var defaultVal = key === 'loop' ? (isLoader ? true : false) : 1.0;
        if (key === 'length') defaultVal = 2.0;
        if (key === 'bgAlpha') defaultVal = 0.0;
        if (key === 'cooling') defaultVal = 0.65;
        if (key === 'spread') defaultVal = 0.3;
        if (key === 'textFade') defaultVal = 0.5;
        
        slider.value = window.animConfig[actualKey] !== undefined ? window.animConfig[actualKey] : defaultVal;
        slider.style.cssText = 'width:60px;height:12px;';
        
        var val = document.createElement('span');
        val.textContent = slider.value;
        val.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:20px;text-align:right;';
        
        slider.addEventListener('input', function () {
          var num = parseFloat(this.value);
          window.animConfig[actualKey] = num;
          val.textContent = this.value;
          refreshPreview();
          if (key === 'bgAlpha' && typeof window.updateAllCanvasBackgrounds === 'function') {
            window.updateAllCanvasBackgrounds();
          }
          if (typeof window.refreshWorking === 'function') window.refreshWorking();
          if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
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
      ctrlRow.appendChild(makeSlider('Diff Area', 'diffusionHeight', 1.0, 6.0, 0.2));
      ctrlRow.appendChild(makeSlider('Noise Res', 'noiseRes', 1, 12, 1));
      ctrlRow.appendChild(makeSlider('Text Fade', 'textFade', 0, 1.0, 0.1));
      ctrlRow.appendChild(makeSlider('Cooling', 'cooling', 0.4, 0.95, 0.05));
      ctrlRow.appendChild(makeSlider('Spread', 'spread', 0.05, 0.45, 0.05));
      ctrlRow.appendChild(makeSlider('Splash', 'splashLength', 1.0, 10.0, 0.5));
      section.appendChild(ctrlRow);

      // Toggles Row
      var togglesRow = document.createElement('div');
      togglesRow.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center;flex-wrap:wrap;';

      // Loop button
      var loopKey = isLoader ? 'loaderLoop' : 'loop';
      var loopBtn = document.createElement('button');
      var isLoop = window.animConfig[loopKey] !== undefined ? window.animConfig[loopKey] : (isLoader ? true : false);
      loopBtn.textContent = 'Loop: ' + (isLoop ? 'ON' : 'OFF');
      loopBtn.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);background:' + (isLoop ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)') + ';color:' + (isLoop ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)') + ';';
      loopBtn.addEventListener('click', function () {
        window.animConfig[loopKey] = !window.animConfig[loopKey];
        var updatedVal = window.animConfig[loopKey];
        loopBtn.textContent = 'Loop: ' + (updatedVal ? 'ON' : 'OFF');
        loopBtn.style.background = updatedVal ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
        loopBtn.style.color = updatedVal ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
        refreshPreview();
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
        if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
      });
      togglesRow.appendChild(loopBtn);

      // Color picker with alpha
      var colorKey = isLoader ? 'loaderColor' : 'chatColor';
      var colorWrap = document.createElement('div');
      colorWrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:8px;';
      var colorLbl = document.createElement('span');
      colorLbl.textContent = 'Color:';
      colorLbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);';
      colorWrap.appendChild(colorLbl);

      var colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.style.cssText = 'width:24px;height:18px;border:1px solid var(--vscode-input-border);border-radius:3px;padding:0;cursor:pointer;background:transparent;';
      var alphaInput = document.createElement('input');
      alphaInput.type = 'range';
      alphaInput.min = '0'; alphaInput.max = '1'; alphaInput.step = '0.05';
      alphaInput.style.cssText = 'width:40px;height:12px;accent-color:var(--vscode-button-background);';
      var alphaVal = document.createElement('span');
      alphaVal.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:22px;text-align:right;';

      function syncColorFromConfig() {
        var raw = isLoader ? window._junctionLoaderAnimColor : window._junctionAnimColor;
        var def = getComputedStyle(document.body).color || '#cccccc';
        var parsed = parseAnimColor(raw || def);
        colorInput.value = parsed.hex;
        alphaInput.value = parsed.a;
        alphaVal.textContent = Math.round(parsed.a * 100) + '%';
      }
      colorInput.addEventListener('input', function () {
        var a = parseFloat(alphaInput.value);
        var val = toRgba(colorInput.value, a);
        if (isLoader) window._junctionLoaderAnimColor = val;
        else window._junctionAnimColor = val;
        refreshPreview();
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
        if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
      });
      alphaInput.addEventListener('input', function () {
        var a = parseFloat(this.value);
        alphaVal.textContent = Math.round(a * 100) + '%';
        var val = toRgba(colorInput.value, a);
        if (isLoader) window._junctionLoaderAnimColor = val;
        else window._junctionAnimColor = val;
        refreshPreview();
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
        if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
      });
      syncColorFromConfig();
      colorWrap.appendChild(colorInput);
      colorWrap.appendChild(alphaInput);
      colorWrap.appendChild(alphaVal);
      togglesRow.appendChild(colorWrap);

      // BG Color Selector
      var bgLabel = document.createElement('span');
      bgLabel.textContent = 'BG:';
      bgLabel.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);margin-left:8px;';
      togglesRow.appendChild(bgLabel);

      var bgBtn = document.createElement('button');
      bgBtn.style.cssText = 'padding:2px 6px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-editor-foreground);';
      var bgOptions = [
        { val: 'theme', text: 'Theme BG' },
        { val: '#000000', text: 'Black' },
        { val: '#ffffff', text: 'White' },
        { val: '#1e1e1e', text: 'Dark Grey' },
        { val: '#101014', text: 'Midnight' }
      ];
      var bgKey = isLoader ? 'loaderBgColor' : 'bgColor';
      function updateBgButton() {
        var currentVal = window.animConfig[bgKey] || 'theme';
        var currentOpt = bgOptions.find(function (o) { return o.val === currentVal; }) || bgOptions[0];
        bgBtn.textContent = currentOpt.text;
      }
      bgBtn.addEventListener('click', function () {
        var currentVal = window.animConfig[bgKey] || 'theme';
        var idx = bgOptions.findIndex(function (o) { return o.val === currentVal; });
        var nextIdx = (idx + 1) % bgOptions.length;
        window.animConfig[bgKey] = bgOptions[nextIdx].val;
        updateBgButton();
        refreshPreview();
        if (typeof window.updateAllCanvasBackgrounds === 'function') {
          window.updateAllCanvasBackgrounds();
        }
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
        if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
      });
      updateBgButton();
      togglesRow.appendChild(bgBtn);

      // Width button
      var widthBtn = document.createElement('button');
      widthBtn.style.cssText = 'padding:2px 6px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-editor-foreground);margin-left:4px;';
      var widthKey = isLoader ? 'loaderWidthMode' : 'widthMode';
      function updateWidthButton() {
        var mode = window.animConfig[widthKey] || 'text';
        if (mode === 'full') {
          widthBtn.textContent = 'Width: Full';
        } else {
          widthBtn.textContent = 'Width: Element';
        }
      }
      widthBtn.addEventListener('click', function () {
        var current = window.animConfig[widthKey] || 'text';
        window.animConfig[widthKey] = (current === 'full') ? 'text' : 'full';
        updateWidthButton();
        refreshPreview();
        if (typeof window.reanimateAllMessages === 'function') {
          window.reanimateAllMessages();
        }
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
        if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
      });
      updateWidthButton();
      togglesRow.appendChild(widthBtn);

      // Burst button
      var sizeOffBtn = document.createElement('button');
      sizeOffBtn.style.cssText = 'padding:2px 6px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);margin-left:4px;';
      var sizeOffKey = isLoader ? 'loaderSizeOff' : 'sizeOff';
      function updateSizeOffButton() {
        var active = !!(window.animConfig && window.animConfig[sizeOffKey]);
        sizeOffBtn.textContent = 'Burst: ' + (active ? 'ON' : 'OFF');
        if (active) {
          sizeOffBtn.style.background = 'var(--vscode-button-background)';
          sizeOffBtn.style.color = 'var(--vscode-button-foreground)';
        } else {
          sizeOffBtn.style.background = 'var(--vscode-input-background)';
          sizeOffBtn.style.color = 'var(--vscode-editor-foreground)';
        }
      }
      sizeOffBtn.addEventListener('click', function () {
        window.animConfig[sizeOffKey] = !window.animConfig[sizeOffKey];
        updateSizeOffButton();
        refreshPreview();
        if (typeof window.reanimateAllMessages === 'function') {
          window.reanimateAllMessages();
        }
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
        if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
      });
      updateSizeOffButton();
      togglesRow.appendChild(sizeOffBtn);

      // TV Magic button
      var magicBtn = document.createElement('button');
      magicBtn.style.cssText = 'padding:2px 6px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);margin-left:4px;';
      var magicKey = isLoader ? 'loaderMagic' : 'magic';
      function updateMagicButton() {
        var active = !!(window.animConfig && window.animConfig[magicKey]);
        magicBtn.textContent = 'TV Magic: ' + (active ? 'ON' : 'OFF');
        if (active) {
          magicBtn.style.background = 'var(--vscode-button-background)';
          magicBtn.style.color = 'var(--vscode-button-foreground)';
        } else {
          magicBtn.style.background = 'var(--vscode-input-background)';
          magicBtn.style.color = 'var(--vscode-editor-foreground)';
        }
      }
      magicBtn.addEventListener('click', function () {
        window.animConfig[magicKey] = !window.animConfig[magicKey];
        updateMagicButton();
        refreshPreview();
        if (typeof window.reanimateAllMessages === 'function') {
          window.reanimateAllMessages();
        }
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
        if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
      });
      updateMagicButton();
      togglesRow.appendChild(magicBtn);

      section.appendChild(togglesRow);
      return { dom: section };
    }

    var chatCtrl = buildConfigSection(false);
    var bobberCtrl = buildConfigSection(true);

    chatCtrl.dom.style.display = 'block';
    bobberCtrl.dom.style.display = 'none';

    box.appendChild(chatCtrl.dom);
    box.appendChild(bobberCtrl.dom);

    // Splash section
    var splashSection = document.createElement('div');
    splashSection.style.display = 'none';
    var splashRow = document.createElement('div');
    splashRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;';

    // Splash color picker
    var splashColorWrap = document.createElement('div');
    splashColorWrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
    var splashColorLbl = document.createElement('span');
    splashColorLbl.textContent = 'Splash Color:';
    splashColorLbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);';
    splashColorWrap.appendChild(splashColorLbl);

    var splashColorInput = document.createElement('input');
    splashColorInput.type = 'color';
    splashColorInput.style.cssText = 'width:24px;height:18px;border:1px solid var(--vscode-input-border);border-radius:3px;padding:0;cursor:pointer;background:transparent;';
    var splashAlphaInput = document.createElement('input');
    splashAlphaInput.type = 'range';
    splashAlphaInput.min = '0'; splashAlphaInput.max = '1'; splashAlphaInput.step = '0.05';
    splashAlphaInput.style.cssText = 'width:40px;height:12px;accent-color:var(--vscode-button-background);';
    var splashAlphaVal = document.createElement('span');
    splashAlphaVal.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:22px;text-align:right;';

    function syncSplashColor() {
      var raw = window._junctionSplashColor || '';
      var def = getComputedStyle(document.body).color || '#cccccc';
      var parsed = parseAnimColor(raw || def);
      splashColorInput.value = parsed.hex;
      splashAlphaInput.value = parsed.a;
      splashAlphaVal.textContent = Math.round(parsed.a * 100) + '%';
    }
    splashColorInput.addEventListener('input', function () {
      var a = parseFloat(splashAlphaInput.value);
      window._junctionSplashColor = toRgba(splashColorInput.value, a);
      if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
    });
    splashAlphaInput.addEventListener('input', function () {
      var a = parseFloat(this.value);
      splashAlphaVal.textContent = Math.round(a * 100) + '%';
      window._junctionSplashColor = toRgba(splashColorInput.value, a);
      if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
    });
    syncSplashColor();
    splashColorWrap.appendChild(splashColorInput);
    splashColorWrap.appendChild(splashAlphaInput);
    splashColorWrap.appendChild(splashAlphaVal);
    splashRow.appendChild(splashColorWrap);

    // Splash length slider
    var splashLenWrap = document.createElement('div');
    splashLenWrap.style.cssText = 'display:flex;align-items:center;gap:3px;';
    var splashLenLbl = document.createElement('span');
    splashLenLbl.textContent = 'Length (s):';
    splashLenLbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:48px;';
    var splashLenInput = document.createElement('input');
    splashLenInput.type = 'range';
    splashLenInput.min = '1'; splashLenInput.max = '10'; splashLenInput.step = '0.5';
    splashLenInput.style.cssText = 'width:60px;height:12px;accent-color:var(--vscode-button-background);';
    var splashLenVal = document.createElement('span');
    splashLenVal.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:20px;text-align:right;';
    splashLenInput.value = window.animConfig.splashLength || 4.0;
    splashLenVal.textContent = splashLenInput.value;
    splashLenInput.addEventListener('input', function () {
      window.animConfig.splashLength = parseFloat(this.value);
      splashLenVal.textContent = this.value;
      if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
    });
    splashLenWrap.appendChild(splashLenLbl);
    splashLenWrap.appendChild(splashLenInput);
    splashLenWrap.appendChild(splashLenVal);
    splashRow.appendChild(splashLenWrap);

    splashSection.appendChild(splashRow);
    box.appendChild(splashSection);

    // Click handlers for switching tabs
    tabChat.addEventListener('click', function () {
      activeTab = 'chat';
      tabChat.style.cssText = 'cursor:pointer;font-size:11px;font-weight:bold;color:var(--vscode-button-foreground);border-bottom:2px solid var(--vscode-button-background);padding:2px 4px;';
      tabBobber.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      tabSplash.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      chatCtrl.dom.style.display = 'block';
      bobberCtrl.dom.style.display = 'none';
      splashSection.style.display = 'none';
      refreshPreview();
    });

    tabBobber.addEventListener('click', function () {
      activeTab = 'bobber';
      tabBobber.style.cssText = 'cursor:pointer;font-size:11px;font-weight:bold;color:var(--vscode-button-foreground);border-bottom:2px solid var(--vscode-button-background);padding:2px 4px;';
      tabChat.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      tabSplash.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      chatCtrl.dom.style.display = 'none';
      bobberCtrl.dom.style.display = 'block';
      splashSection.style.display = 'none';
      refreshPreview();
    });

    tabSplash.addEventListener('click', function () {
      activeTab = 'splash';
      tabSplash.style.cssText = 'cursor:pointer;font-size:11px;font-weight:bold;color:var(--vscode-button-foreground);border-bottom:2px solid var(--vscode-button-background);padding:2px 4px;';
      tabChat.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      tabBobber.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      chatCtrl.dom.style.display = 'none';
      bobberCtrl.dom.style.display = 'none';
      splashSection.style.display = 'block';
    });

    box.appendChild(previewArea);
    refreshPreview();

    var inputArea = document.querySelector('#composer-shell');
    if (inputArea) inputArea.parentNode.insertBefore(box, inputArea);
  }

  if (btnPreviewAnim) {
    btnPreviewAnim.addEventListener('click', function () {
      toggleChatPreviewPanel();
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
