/* ==========================================================================
   config-section.js — Animation settings panel (mode buttons, sliders, toggles)
   ==========================================================================
   Builds the DOM for the chat/bobber animation config sections.
   Exports: window.buildConfigSection(isLoader, refreshPreview, animModes)
   ========================================================================== */
(function () {
  'use strict';

  /**
   * Build the config section for either chat messages (isLoader=false)
   * or the bobber/loader (isLoader=true).
   * Returns { dom: <HTMLElement> }
   */
  window.buildConfigSection = function (isLoader, refreshPreview, animModesOverride) {
    var section = document.createElement('div');
    var animModes = animModesOverride || window.ANIM_MODES || ['matrix','zalgo','fire','bounce','spiral','galaxy','leak'];

    // ── Mode Selector ───────────────────────────────────────────────────────
    var modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;align-items:center;';
    var modeLabel = document.createElement('span');
    modeLabel.textContent = isLoader ? 'Style:' : 'Mode:';
    modeLabel.style.cssText = 'font-size:10px;color:var(--vscode-editor-foreground);margin-right:4px;';
    modeRow.appendChild(modeLabel);

    var modesList = isLoader 
      ? [{val:'default', label:'Same as Chat'}, {val:'matrix', label:'Matrix'}, {val:'zalgo', label:'Zalgo'}, {val:'fire', label:'Fire'}, {val:'bounce', label:'Bounce'}, {val:'spiral', label:'Spiral'}, {val:'galaxy', label:'Galaxy'}, {val:'leak', label:'Leak'}]
      : animModes.map(function(m) { return {val: m, label: m.charAt(0).toUpperCase() + m.slice(1)}; });

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
          window._junctionAnimationMode = opt.val;
        }
        refreshPreview();
        syncModes();
        if (typeof window.refreshWorking === 'function') window.refreshWorking();
        if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
      });
      modeRow.appendChild(btn);
    });

    var syncModes = function () {
      var current = isLoader 
        ? (window.animConfig.loaderMode || 'default') 
        : (window._junctionAnimationMode || 'matrix');
      modeRow.querySelectorAll('button').forEach(function (b, idx) {
        var activeVal = modesList[idx].val;
        var isActive = (current === activeVal);
        b.style.background = isActive ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
        b.style.color = isActive ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
      });
    };
    window.settingsSyncFunctions.push(syncModes);
    section.appendChild(modeRow);

    // ── Sliders Row ─────────────────────────────────────────────────────────
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
      if (key === 'curtainFade') defaultVal = 0.3;
      
      slider.value = window.animConfig[actualKey] !== undefined ? window.animConfig[actualKey] : defaultVal;
      slider.style.cssText = 'width:60px;height:12px;accent-color:var(--vscode-button-background);';
      
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

      var syncSlider = function () {
        var currentVal = window.animConfig[actualKey] !== undefined ? window.animConfig[actualKey] : defaultVal;
        slider.value = currentVal;
        val.textContent = currentVal;
      };
      window.settingsSyncFunctions.push(syncSlider);

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
    if (!isLoader) ctrlRow.appendChild(makeSlider('Curtain Fade', 'curtainFade', 0, 2, 0.1));
    ctrlRow.appendChild(makeSlider('Diff Area', 'diffusionHeight', 1.0, 6.0, 0.2));
    ctrlRow.appendChild(makeSlider('Noise Res', 'noiseRes', 1, 12, 1));
    ctrlRow.appendChild(makeSlider('Text Fade', 'textFade', 0, 1.0, 0.1));
    ctrlRow.appendChild(makeSlider('Cooling', 'cooling', 0.4, 0.95, 0.05));
    ctrlRow.appendChild(makeSlider('Spread', 'spread', 0.05, 0.45, 0.05));
    ctrlRow.appendChild(makeSlider('Splash', 'splashLength', 1.0, 10.0, 0.5));
    section.appendChild(ctrlRow);

    // ── Toggles Row ─────────────────────────────────────────────────────────
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
      syncLoop();
      refreshPreview();
      if (typeof window.refreshWorking === 'function') window.refreshWorking();
      if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
    });
    var syncLoop = function () {
      var isLoopVal = window.animConfig[loopKey] !== undefined ? window.animConfig[loopKey] : (isLoader ? true : false);
      loopBtn.textContent = 'Loop: ' + (isLoopVal ? 'ON' : 'OFF');
      loopBtn.style.background = isLoopVal ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
      loopBtn.style.color = isLoopVal ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
    };
    window.settingsSyncFunctions.push(syncLoop);
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
      var parsed = window.parseAnimColor(raw || def);
      colorInput.value = parsed.hex;
      alphaInput.value = parsed.a;
      alphaVal.textContent = Math.round(parsed.a * 100) + '%';
    }
    colorInput.addEventListener('input', function () {
      var a = parseFloat(alphaInput.value);
      var val = window.toRgba(colorInput.value, a);
      if (isLoader) window._junctionLoaderAnimColor = val;
      else window._junctionAnimColor = val;
      refreshPreview();
      if (typeof window.refreshWorking === 'function') window.refreshWorking();
      if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
    });
    alphaInput.addEventListener('input', function () {
      var a = parseFloat(this.value);
      alphaVal.textContent = Math.round(a * 100) + '%';
      var val = window.toRgba(colorInput.value, a);
      if (isLoader) window._junctionLoaderAnimColor = val;
      else window._junctionAnimColor = val;
      refreshPreview();
      if (typeof window.refreshWorking === 'function') window.refreshWorking();
      if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
    });
    syncColorFromConfig();
    window.settingsSyncFunctions.push(syncColorFromConfig);
    colorWrap.appendChild(colorInput);
    colorWrap.appendChild(alphaInput);
    colorWrap.appendChild(alphaVal);
    togglesRow.appendChild(colorWrap);

    // BG Color Selector
    var bgKey = isLoader ? 'loaderBgColor' : 'bgColor';
    var bgAlphaKey = isLoader ? 'loaderBgAlpha' : 'bgAlpha';

    var bgWrap = document.createElement('div');
    bgWrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:8px;';
    var bgLabel = document.createElement('span');
    bgLabel.textContent = 'BG:';
    bgLabel.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);';
    bgWrap.appendChild(bgLabel);

    var bgSelect = document.createElement('select');
    bgSelect.style.cssText = 'font-size:10px;background:var(--vscode-input-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:1px 2px;cursor:pointer;';
    var optTheme = document.createElement('option');
    optTheme.value = 'theme';
    optTheme.textContent = 'Theme';
    var optCustom = document.createElement('option');
    optCustom.value = 'custom';
    optCustom.textContent = 'Custom';
    bgSelect.appendChild(optTheme);
    bgSelect.appendChild(optCustom);
    bgWrap.appendChild(bgSelect);

    var bgColorInput = document.createElement('input');
    bgColorInput.type = 'color';
    bgColorInput.style.cssText = 'width:24px;height:18px;border:1px solid var(--vscode-input-border);border-radius:3px;padding:0;cursor:pointer;background:transparent;display:none;';
    
    var bgAlphaInput = document.createElement('input');
    bgAlphaInput.type = 'range';
    bgAlphaInput.min = '0'; bgAlphaInput.max = '1'; bgAlphaInput.step = '0.05';
    bgAlphaInput.style.cssText = 'width:40px;height:12px;accent-color:var(--vscode-button-background);';
    
    var bgAlphaVal = document.createElement('span');
    bgAlphaVal.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:22px;text-align:right;';

    function syncBgFromConfig() {
      var currentBg = window.animConfig[bgKey] || 'theme';
      var currentBgAlpha = window.animConfig[bgAlphaKey] !== undefined ? window.animConfig[bgAlphaKey] : (window.animConfig.bgAlpha !== undefined ? window.animConfig.bgAlpha : 0.05);
      if (currentBg === 'theme') {
        bgSelect.value = 'theme';
        bgColorInput.style.display = 'none';
        bgColorInput.value = '#000000';
      } else {
        bgSelect.value = 'custom';
        bgColorInput.style.display = 'inline-block';
        bgColorInput.value = currentBg;
      }
      bgAlphaInput.value = currentBgAlpha;
      bgAlphaVal.textContent = Math.round(currentBgAlpha * 100) + '%';
    }

    function updateBgConfig() {
      if (bgSelect.value === 'theme') {
        window.animConfig[bgKey] = 'theme';
        bgColorInput.style.display = 'none';
      } else {
        window.animConfig[bgKey] = bgColorInput.value;
        bgColorInput.style.display = 'inline-block';
      }
      var alphaValNum = parseFloat(bgAlphaInput.value);
      window.animConfig[bgAlphaKey] = alphaValNum;
      if (!isLoader) window.animConfig.bgAlpha = alphaValNum;
      else window.animConfig.loaderBgAlpha = alphaValNum;

      refreshPreview();
      if (typeof window.updateAllCanvasBackgrounds === 'function') {
        window.updateAllCanvasBackgrounds();
      }
      if (typeof window.refreshWorking === 'function') window.refreshWorking();
      if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
    }

    bgSelect.addEventListener('change', function () {
      updateBgConfig();
      syncBgFromConfig();
    });
    bgColorInput.addEventListener('input', updateBgConfig);
    bgAlphaInput.addEventListener('input', function () {
      bgAlphaVal.textContent = Math.round(parseFloat(this.value) * 100) + '%';
      updateBgConfig();
    });

    syncBgFromConfig();
    window.settingsSyncFunctions.push(syncBgFromConfig);
    bgWrap.appendChild(bgColorInput);
    bgWrap.appendChild(bgAlphaInput);
    bgWrap.appendChild(bgAlphaVal);
    togglesRow.appendChild(bgWrap);

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
      if (typeof window.refreshWorking === 'function') window.refreshWorking();
      if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
    });
    updateSizeOffButton();
    window.settingsSyncFunctions.push(updateSizeOffButton);
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
      if (typeof window.refreshWorking === 'function') window.refreshWorking();
      if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
    });
    updateMagicButton();
    window.settingsSyncFunctions.push(updateMagicButton);
    togglesRow.appendChild(magicBtn);

    if (!isLoader) {
      var reactionWrap = document.createElement('div');
      reactionWrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:8px;';
      
      var reactionLbl = document.createElement('span');
      reactionLbl.textContent = 'Reactions:';
      reactionLbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);';
      
      var reactionSelect = document.createElement('select');
      reactionSelect.style.cssText = 'font-size:9px;background:var(--vscode-input-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:1px 2px;cursor:pointer;';
      
      var optionsList = [
        { val: 'arrow-caret', text: '↑↓ Arrows' },
        { val: 'thumbs', text: '👍/👎' },
        { val: 'faces', text: '😊/😠' },
        { val: 'words', text: 'good/bad' },
        { val: 'hearts', text: '❤️/💔' },
        { val: 'arrows', text: '⬆️/⬇️' },
        { val: 'vector-arrows', text: 'Vector Arrows' },
        { val: 'wacky', text: 'Wacky' }
      ];
      
      optionsList.forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt.val;
        o.textContent = opt.text;
        reactionSelect.appendChild(o);
      });
      
      reactionSelect.value = window.animConfig.reactionPair || 'arrow-caret';
      reactionSelect.addEventListener('change', function () {
        window.animConfig.reactionPair = this.value;
        
        var rows = document.querySelectorAll('.chat-row.assistant:not(.running)');
        rows.forEach(function (row) {
          var msgActions = row.querySelector('.msg-actions');
          if (msgActions) {
            var mid = row.getAttribute('data-message-id') || row.getAttribute('data-run-id');
            if (mid) {
              msgActions.remove();
              row.appendChild(window.buildMsgActions(mid, true));
            }
          }
        });
        
        if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
      });
      
      var syncReactions = function () {
        reactionSelect.value = window.animConfig.reactionPair || 'thumbs';
      };
      window.settingsSyncFunctions.push(syncReactions);

      reactionWrap.appendChild(reactionLbl);
      reactionWrap.appendChild(reactionSelect);
      togglesRow.appendChild(reactionWrap);
    }

    section.appendChild(togglesRow);
    return { dom: section };
  };
})();
