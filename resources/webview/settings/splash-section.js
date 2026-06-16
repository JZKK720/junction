/* ==========================================================================
   splash-section.js — Splash/bobber settings panel
   ==========================================================================
   Builds splash settings DOM and registers sync functions.
   Exports: window.buildSplashSection()
   ========================================================================== */
(function () {
  'use strict';

  window.buildSplashSection = function () {
    var section = document.createElement('div');
    section.style.display = 'none';

    function saveAndRefresh(refreshPreview) {
      if (typeof refreshPreview === 'function') refreshPreview();
      if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
    }

    function makeRow() {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px;';
      section.appendChild(row);
      return row;
    }

    function makeSlider(row, label, key, min, max, step, fallback, width, onSync) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
      var lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:56px;';
      var input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.style.cssText = 'width:' + (width || 72) + 'px;height:12px;accent-color:var(--vscode-button-background);';
      var val = document.createElement('span');
      val.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:28px;text-align:right;';

      function sync() {
        var current = window.animConfig[key] !== undefined ? window.animConfig[key] : fallback;
        input.value = current;
        val.textContent = current;
        if (onSync) onSync(current);
      }

      input.addEventListener('input', function () {
        window.animConfig[key] = parseFloat(this.value);
        sync();
        saveAndRefresh(window.refreshPreview);
      });

      window.settingsSyncFunctions.push(sync);
      wrap.appendChild(lbl);
      wrap.appendChild(input);
      wrap.appendChild(val);
      row.appendChild(wrap);
      sync();
      return { wrap: wrap, input: input, value: val, sync: sync };
    }

    function makeToggle(row, key, onLabel, offLabel, titlePrefix) {
      var btn = document.createElement('button');
      btn.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);';
      btn.addEventListener('click', function () {
        window.animConfig[key] = !window.animConfig[key];
        sync();
        saveAndRefresh(window.refreshPreview);
      });
      function sync() {
        var enabled = !!window.animConfig[key];
        btn.textContent = titlePrefix + ': ' + (enabled ? onLabel : offLabel);
        btn.style.background = enabled ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
        btn.style.color = enabled ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
      }
      window.settingsSyncFunctions.push(sync);
      row.appendChild(btn);
      sync();
      return btn;
    }

    var colorRow = makeRow();

    // Custom color toggle for splash
    var splashCustomBtn = document.createElement('button');
    splashCustomBtn.style.cssText = 'padding:2px 6px;border-radius:3px;cursor:pointer;font-size:9px;border:1px solid var(--vscode-input-border);';
    function syncSplashCustom() {
      var active = !!window.animConfig.splashColorCustom;
      splashCustomBtn.textContent = 'Custom color';
      splashCustomBtn.style.background = active ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
      splashCustomBtn.style.color = active ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
    }
    splashCustomBtn.addEventListener('click', function () {
      window.animConfig.splashColorCustom = !window.animConfig.splashColorCustom;
      syncSplashCustom();
      syncSplashColorVisibility();
      saveAndRefresh(window.refreshPreview);
    });
    syncSplashCustom();
    window.settingsSyncFunctions.push(syncSplashCustom);
    colorRow.appendChild(splashCustomBtn);

    var splashColorWrap = document.createElement('div');
    splashColorWrap.style.cssText = 'display:none;align-items:center;gap:4px;margin-left:4px;';
    var splashColorInput = document.createElement('input');
    splashColorInput.type = 'color';
    splashColorInput.style.cssText = 'width:24px;height:18px;border:1px solid var(--vscode-input-border);border-radius:3px;padding:0;cursor:pointer;background:transparent;';
    var splashAlphaInput = document.createElement('input');
    splashAlphaInput.type = 'range';
    splashAlphaInput.min = '0';
    splashAlphaInput.max = '1';
    splashAlphaInput.step = '0.05';
    splashAlphaInput.style.cssText = 'width:54px;height:12px;accent-color:var(--vscode-button-background);';
    var splashAlphaVal = document.createElement('span');
    splashAlphaVal.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:28px;text-align:right;';

    window.syncSplashColor = function () {
      var raw = window._junctionSplashColor || '';
      var def = getComputedStyle(document.body).color;
      var parsed = window.parseAnimColor(raw || def);
      splashColorInput.value = parsed.hex;
      splashAlphaInput.value = parsed.a;
      splashAlphaVal.textContent = Math.round(parsed.a * 100) + '%';
    };

    splashColorInput.addEventListener('input', function () {
      window._junctionSplashColor = window.toRgba(splashColorInput.value, parseFloat(splashAlphaInput.value));
      saveAndRefresh(window.refreshPreview);
    });
    splashAlphaInput.addEventListener('input', function () {
      var alpha = parseFloat(this.value);
      splashAlphaVal.textContent = Math.round(alpha * 100) + '%';
      window._junctionSplashColor = window.toRgba(splashColorInput.value, alpha);
      saveAndRefresh(window.refreshPreview);
    });

    splashColorWrap.appendChild(splashColorInput);
    splashColorWrap.appendChild(splashAlphaInput);
    splashColorWrap.appendChild(splashAlphaVal);
    colorRow.appendChild(splashColorWrap);

    function syncSplashColorVisibility() {
      var custom = !!window.animConfig.splashColorCustom;
      splashColorWrap.style.display = custom ? 'flex' : 'none';
    }
    syncSplashColorVisibility();
    window.settingsSyncFunctions.push(syncSplashColorVisibility);

    makeSlider(colorRow, 'Length', 'splashLength', 1, 10, 0.5, 1.0, 64);
    makeSlider(colorRow, 'Fade', 'splashFade', 0.1, 3, 0.1, 0.3, 64);
    makeToggle(colorRow, 'splashDisabled', 'OFF', 'ON', 'Splash');
    makeToggle(colorRow, 'splashFadeOnChatLoad', 'ON', 'OFF', 'Fade on chat');

    var charsetRow = makeRow();
    var presetWrap = document.createElement('div');
    presetWrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
    var presetLbl = document.createElement('span');
    presetLbl.textContent = 'Language:';
    presetLbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:56px;';
    var presetSelect = document.createElement('select');
    presetSelect.style.cssText = 'font-size:10px;background:var(--vscode-input-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:1px 4px;cursor:pointer;';
    [
      ['katakana', 'Katakana'],
      ['matrix', 'Matrix Latin'],
      ['latin', 'Latin'],
      ['hiragana', 'Hiragana'],
      ['cjk', 'CJK'],
      ['hangul', 'Hangul'],
      ['binary', 'Binary'],
      ['symbols', 'Symbols'],
      ['custom', 'Custom only']
    ].forEach(function (entry) {
      var opt = document.createElement('option');
      opt.value = entry[0];
      opt.textContent = entry[1];
      presetSelect.appendChild(opt);
    });
    presetSelect.addEventListener('change', function () {
      window.animConfig.splashCharsetPreset = this.value;
      saveAndRefresh(window.refreshPreview);
    });
    presetWrap.appendChild(presetLbl);
    presetWrap.appendChild(presetSelect);
    charsetRow.appendChild(presetWrap);

    var extraWrap = document.createElement('div');
    extraWrap.style.cssText = 'display:flex;align-items:center;gap:4px;flex:1 1 260px;min-width:240px;';
    var extraLbl = document.createElement('span');
    extraLbl.textContent = 'Add chars:';
    extraLbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:56px;';
    var extraInput = document.createElement('input');
    extraInput.type = 'text';
    extraInput.placeholder = '追加0123<>';
    extraInput.style.cssText = 'flex:1 1 auto;min-width:140px;font-size:10px;background:var(--vscode-input-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:3px 6px;';
    extraInput.addEventListener('input', function () {
      window.animConfig.splashCharsetCustom = this.value || '';
      saveAndRefresh(window.refreshPreview);
    });
    extraWrap.appendChild(extraLbl);
    extraWrap.appendChild(extraInput);
    charsetRow.appendChild(extraWrap);

    var motionRow = makeRow();
    makeSlider(motionRow, 'Quantity', 'splashQuantity', 0.4, 4, 0.1, 1.4, 72);
    makeSlider(motionRow, 'Opacity min', 'splashMinOpacity', 0.05, 1, 0.05, 0.2, 72);
    makeSlider(motionRow, 'Opacity max', 'splashMaxOpacity', 0.05, 1, 0.05, 0.9, 72);
    makeSlider(motionRow, 'Size var', 'splashSizeVariance', 0, 1.4, 0.05, 0.45, 72);
    makeSlider(motionRow, 'Color var', 'splashColorVariance', 0, 1, 0.05, 0.32, 72);
    makeSlider(motionRow, 'Bounce', 'splashBounce', 0, 3, 0.1, 1.1, 72);
    makeSlider(motionRow, 'Junction', 'splashWordmarkScale', 0.6, 2.4, 0.05, 1.0, 72, function () {
      if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale();
    });

    window.syncSplashConfig = function () {
      presetSelect.value = window.animConfig.splashCharsetPreset || 'katakana';
      extraInput.value = window.animConfig.splashCharsetCustom || '';
      if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale();
    };

    window.syncSplashColor();
    window.syncSplashConfig();
    window.settingsSyncFunctions.push(window.syncSplashColor);
    window.settingsSyncFunctions.push(window.syncSplashConfig);

    return section;
  };
})();
