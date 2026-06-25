/* ==========================================================================
   splash-section.js — Splash/bobber settings panel
   ==========================================================================
   Builds splash settings DOM and registers sync functions.
   Per-mode exit sliders swap when the dropdown changes.
   Non-exit settings split into two collapsible accordions.
   Exports: window.buildSplashSection()
   ========================================================================== */
(function () {
  'use strict';

  var animationRegistry = window.JunctionAnimation || {};
  var SPLASH_EXIT_MODES = animationRegistry.splashExitModes || {};
  var SLIDER_DEFS = animationRegistry.sliderDefs || {};

  function getModeSliders(mode) {
    if (typeof animationRegistry.getSplashExitSliderLabels === 'function') {
      return animationRegistry.getSplashExitSliderLabels(mode);
    }
    var entry = SPLASH_EXIT_MODES[mode] || SPLASH_EXIT_MODES.random;
    return entry && entry.sliders ? entry.sliders.slice() : [];
  }

  window.buildSplashSection = function () {
    var section = document.createElement('div');
    section.style.display = 'none';

    function saveAndRefresh(refreshPreview) {
      if (typeof refreshPreview === 'function') refreshPreview();
      if (typeof window.saveAnimSettings === 'function') window.saveAnimSettings();
    }

    function makeRow(parent) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px;';
      (parent || section).appendChild(row);
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

    /* ---- accordion helper ---- */
    function makeAccordion(title, startOpen) {
      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'margin-bottom:6px;border:1px solid var(--vscode-widget-border, transparent);border-radius:4px;overflow:hidden;';

      var header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;user-select:none;background:var(--vscode-editor-background);';
      var arrow = document.createElement('span');
      arrow.style.cssText = 'font-size:9px;transition:transform 0.15s;color:var(--vscode-descriptionForeground);';
      var titleSpan = document.createElement('span');
      titleSpan.textContent = title;
      titleSpan.style.cssText = 'font-size:10px;font-weight:600;color:var(--vscode-editor-foreground);';
      header.appendChild(arrow);
      header.appendChild(titleSpan);

      var body = document.createElement('div');
      body.style.cssText = 'padding:6px 8px;display:' + (startOpen ? 'block' : 'none') + ';';
      arrow.style.transform = startOpen ? 'rotate(90deg)' : 'rotate(0deg)';

      var open = !!startOpen;
      header.addEventListener('click', function () {
        open = !open;
        body.style.display = open ? 'block' : 'none';
        arrow.style.transform = open ? 'rotate(90deg)' : 'rotate(0deg)';
      });

      wrapper.appendChild(header);
      wrapper.appendChild(body);
      section.appendChild(wrapper);

      return { wrapper: wrapper, header: header, body: body };
    }

    /* ============================================================
       ACCORDION 1 — Appearance
       ============================================================ */
    var appearance = makeAccordion(window.junctionT('appearance', 'Appearance'), true);
    var appBody = appearance.body;

    var colorRow = makeRow(appBody);

    var splashCustomBtn = document.createElement('button');
    splashCustomBtn.style.cssText = 'padding:2px 6px;border-radius:3px;cursor:pointer;font-size:9px;border:1px solid var(--vscode-input-border);';
    function syncSplashCustom() {
      var active = !!window.animConfig.splashColorCustom;
      splashCustomBtn.textContent = window.junctionT('customColor', 'Custom color');
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

    makeSlider(colorRow, window.junctionT('length', 'Length'), 'splashLength', 1, 10, 0.5, 1.0, 64);
    makeSlider(colorRow, window.junctionT('bgDelay', 'Bg delay'), 'splashBackgroundFadeDelay', 0, 5, 0.1, 0, 64);
    makeSlider(colorRow, window.junctionT('bgFade', 'Bg fade'), 'splashBackgroundFade', 0.1, 5, 0.1, 0.3, 64);
    makeSlider(colorRow, window.junctionT('rainExit', 'Rain exit'), 'splashCanvasExitDuration', 0.2, 6, 0.1, 1.2, 64);
    makeToggle(colorRow, 'splashDisabled', window.junctionT('off', 'OFF'), window.junctionT('on', 'ON'), window.junctionT('splash', 'Splash'));
    makeToggle(colorRow, 'splashAutoClose', window.junctionT('on', 'ON'), window.junctionT('off', 'OFF'), window.junctionT('autoClose', 'Auto-close'));

    var rainRow = makeRow(appBody);
    var rainDirBtn = document.createElement('button');
    rainDirBtn.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);';
    function syncRainDir() {
      var down = !!window.animConfig.splashRainDown;
      rainDirBtn.textContent = window.junctionT('rainDirection', 'Rain {direction}', { direction: down ? '\u25BC' : '\u25B2' });
      rainDirBtn.style.background = 'var(--vscode-input-background)';
      rainDirBtn.style.color = 'var(--vscode-editor-foreground)';
    }
    rainDirBtn.addEventListener('click', function () {
      window.animConfig.splashRainDown = !window.animConfig.splashRainDown;
      syncRainDir();
      saveAndRefresh(window.refreshPreview);
    });
    rainRow.appendChild(rainDirBtn);
    syncRainDir();

    var revWrap = document.createElement('div');
    revWrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:4px;';
    var revLbl = document.createElement('span');
    revLbl.textContent = window.junctionT('reversePercent', 'Reverse %');
    revLbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);';
    var revInput = document.createElement('input');
    revInput.type = 'number';
    revInput.min = '0';
    revInput.max = '100';
    revInput.step = '0.0001';
    revInput.style.cssText = 'width:72px;font-size:10px;background:var(--vscode-input-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:2px 4px;';
    revInput.addEventListener('input', function () {
      var v = Math.max(0, Math.min(100, parseFloat(this.value) || 0));
      window.animConfig.splashRainReverseChance = v;
      saveAndRefresh(window.refreshPreview);
    });
    revWrap.appendChild(revLbl);
    revWrap.appendChild(revInput);
    rainRow.appendChild(revWrap);

    var bounceBtn = document.createElement('button');
    bounceBtn.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);margin-left:4px;';
    function syncBounceSides() {
      var on = !!window.animConfig.splashRainBounceSides;
      bounceBtn.textContent = window.junctionT('bounceSides', 'Bounce sides');
      bounceBtn.style.background = on ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
      bounceBtn.style.color = on ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
    }
    bounceBtn.addEventListener('click', function () {
      window.animConfig.splashRainBounceSides = !window.animConfig.splashRainBounceSides;
      syncBounceSides();
      saveAndRefresh(window.refreshPreview);
    });
    rainRow.appendChild(bounceBtn);

    // Spawn cadence: constant stream (default) vs the old wavey/batched spawning.
    makeToggle(rainRow, 'splashRainWaves', 'waves', 'stream', 'Spawn');

    window.settingsSyncFunctions.push(syncRainDir);
    window.settingsSyncFunctions.push(syncBounceSides);
    window.settingsSyncFunctions.push(function () {
      revInput.value = window.animConfig.splashRainReverseChance !== undefined ? window.animConfig.splashRainReverseChance : 0.0001;
    });

    // Spawn controls — grouped with the stream/waves toggle since they shape the
    // spawn (how many chars, how fast, how often they re-roll, how spread out).
    var spawnRow = makeRow(appBody);
    makeSlider(spawnRow, 'Quantity', 'splashQuantity', 0.4, 8, 0.1, 1.4, 72);
    makeSlider(spawnRow, 'Rain speed', 'splashRainSpeed', 0.1, 4, 0.1, 1.0, 72);
    makeSlider(spawnRow, 'Flicker', 'splashRainFlicker', 0, 1, 0.01, 0.16, 72);
    makeSlider(spawnRow, 'Spread', 'splashRainSpread', 0, 4, 0.05, 1.0, 72);

    var emojiRow = makeRow(appBody);
    var emojiToggle = document.createElement('button');
    emojiToggle.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);';
    function syncEmojiToggle() {
      var on = !!window.animConfig.splashEmojiMix;
      emojiToggle.textContent = window.junctionT('emojiChance', 'Emoji chance');
      emojiToggle.style.background = on ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
      emojiToggle.style.color = on ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
      emojiInputWrap.style.display = on ? 'flex' : 'none';
    }
    emojiToggle.addEventListener('click', function () {
      window.animConfig.splashEmojiMix = !window.animConfig.splashEmojiMix;
      syncEmojiToggle();
      saveAndRefresh(window.refreshPreview);
    });
    emojiRow.appendChild(emojiToggle);

    var emojiInputWrap = document.createElement('div');
    emojiInputWrap.style.cssText = 'display:none;align-items:center;gap:4px;margin-left:4px;';
    var emojiLbl = document.createElement('span');
    emojiLbl.textContent = '1/';
    emojiLbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);';
    var emojiInput = document.createElement('input');
    emojiInput.type = 'number';
    emojiInput.min = '1';
    emojiInput.step = '1';
    emojiInput.style.cssText = 'width:64px;font-size:10px;background:var(--vscode-input-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:2px 4px;';
    emojiInput.addEventListener('input', function () {
      var v = Math.max(1, Math.round(parseFloat(this.value) || 100));
      window.animConfig.splashEmojiRarity = v;
      this.value = v;
      saveAndRefresh(window.refreshPreview);
    });
    emojiInputWrap.appendChild(emojiLbl);
    emojiInputWrap.appendChild(emojiInput);
    emojiRow.appendChild(emojiInputWrap);

    window.settingsSyncFunctions.push(syncEmojiToggle);
    window.settingsSyncFunctions.push(function () {
      emojiInput.value = Math.max(1, Math.round(window.animConfig.splashEmojiRarity || 100));
    });
    syncEmojiToggle();

    var charsetRow = makeRow(appBody);
    var presetWrap = document.createElement('div');
    presetWrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
    var presetLbl = document.createElement('span');
    presetLbl.textContent = window.junctionT('language', 'Language:');
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
      ['emoji', 'Emoji'],
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
    extraLbl.textContent = window.junctionT('addChars', 'Add chars:');
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

    /* ============================================================
       ACCORDION 2 — Motion / Physics
       ============================================================ */
    var motion = makeAccordion(window.junctionT('motion', 'Motion'), true);
    var motBody = motion.body;

    var motionRow = makeRow(motBody);
    makeSlider(motionRow, 'Variety', 'splashCharVariety', 0.05, 1, 0.05, 1.0, 72);
    makeSlider(motionRow, 'Opacity min', 'splashMinOpacity', 0.05, 1, 0.05, 0.2, 72);
    makeSlider(motionRow, 'Opacity max', 'splashMaxOpacity', 0.05, 1, 0.05, 0.9, 72);
    makeSlider(motionRow, 'Size var', 'splashSizeVariance', 0, 1.4, 0.05, 0.45, 72);
    makeSlider(motionRow, 'Color var', 'splashColorVariance', 0, 1, 0.05, 0.32, 72);
    makeSlider(motionRow, 'Gravity', 'splashGravity', 0.1, 4, 0.1, 1.0, 72);
    makeSlider(motionRow, 'Bounce', 'splashBounce', 0, 3, 0.1, 1.1, 72);
    makeSlider(motionRow, 'Collision', 'splashCollisionForce', 0, 4, 0.1, 1.4, 72);
    makeSlider(motionRow, 'Logo light', 'splashLogoLightness', 0.1, 4, 0.1, 1.0, 72);
    makeSlider(motionRow, 'Junction', 'splashWordmarkScale', 0.6, 2.4, 0.05, 1.0, 72, function () {
      if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale();
    });

    /* ============================================================
       EXIT MODE — dropdown + per-mode slider row
       ============================================================ */
    var exitRow = makeRow();
    var exitWrap = document.createElement('div');
    exitWrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
    var exitLbl = document.createElement('span');
    exitLbl.textContent = window.junctionT('exit', 'Exit:');
    exitLbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:56px;';
    var exitSelect = document.createElement('select');
    exitSelect.style.cssText = 'font-size:10px;background:var(--vscode-input-background);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:1px 4px;cursor:pointer;';
    Object.keys(SPLASH_EXIT_MODES).forEach(function (mode) {
      var opt = document.createElement('option');
      opt.value = mode;
      opt.textContent = SPLASH_EXIT_MODES[mode].label || mode;
      exitSelect.appendChild(opt);
    });
    exitWrap.appendChild(exitLbl);
    exitWrap.appendChild(exitSelect);
    exitRow.appendChild(exitWrap);

    /* Per-mode slider container — swapped on dropdown change */
    var exitSliderRow = document.createElement('div');
    exitSliderRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px;margin-left:64px;';
    section.appendChild(exitSliderRow);

    var exitSliderEls = {};   // label -> { wrap, input, value, sync }

    function buildExitSliders(mode) {
      /* clear existing */
      while (exitSliderRow.firstChild) exitSliderRow.removeChild(exitSliderRow.firstChild);
      exitSliderEls = {};

      var labels = getModeSliders(mode);
      labels.forEach(function (label) {
        var def = SLIDER_DEFS[label];
        if (!def) return;
        var els = makeSlider(exitSliderRow, label, def.key, def.min, def.max, def.step, def.fallback, 72);
        exitSliderEls[label] = els;
      });

      /* rain-push: toggle whether the Junction letters bounce off the side
         walls or slide off the sides. Self-contained (rebuilt per mode switch). */
      if (mode === 'rain-push') {
        var bounceBtn = document.createElement('button');
        bounceBtn.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);';
        var syncBounce = function () {
          var on = !!window.animConfig.splashRainPushBounceSides;
          bounceBtn.textContent = on ? window.junctionT('lettersBounceSides', 'Letters: bounce sides') : window.junctionT('lettersSlideOff', 'Letters: slide off');
          bounceBtn.style.background = on ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
          bounceBtn.style.color = on ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
        };
        bounceBtn.addEventListener('click', function () {
          window.animConfig.splashRainPushBounceSides = !window.animConfig.splashRainPushBounceSides;
          syncBounce();
          saveAndRefresh(window.refreshPreview);
        });
        syncBounce();
        exitSliderRow.appendChild(bounceBtn);
      }

      if (mode === 'explode3') {
        var gibBounceBtn = document.createElement('button');
        gibBounceBtn.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);';
        var syncGibBounce = function () {
          var on = window.animConfig.splashExitExplode3BounceSides !== false;
          gibBounceBtn.textContent = on ? window.junctionT('gibsBounceSides', 'Gibs: bounce sides') : window.junctionT('gibsLeaveSides', 'Gibs: leave sides');
          gibBounceBtn.style.background = on ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
          gibBounceBtn.style.color = on ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
        };
        gibBounceBtn.addEventListener('click', function () {
          window.animConfig.splashExitExplode3BounceSides = !(window.animConfig.splashExitExplode3BounceSides !== false);
          syncGibBounce();
          saveAndRefresh(window.refreshPreview);
        });
        syncGibBounce();
        exitSliderRow.appendChild(gibBounceBtn);
      }
    }

    exitSelect.addEventListener('change', function () {
      window.animConfig.splashExitMode = this.value;
      buildExitSliders(this.value);
      saveAndRefresh(window.refreshPreview);
    });

    /* initial build */
    buildExitSliders(window.animConfig.splashExitMode || 'random');

    /* ---- sync functions ---- */
    window.syncSplashConfig = function () {
      presetSelect.value = window.animConfig.splashCharsetPreset || 'katakana';
      exitSelect.value = window.animConfig.splashExitMode || 'random';
      extraInput.value = window.animConfig.splashCharsetCustom || '';
      buildExitSliders(exitSelect.value);
      if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale();
    };

    window.syncSplashColor();
    window.syncSplashConfig();
    window.settingsSyncFunctions.push(window.syncSplashColor);
    window.settingsSyncFunctions.push(window.syncSplashConfig);

    return section;
  };
})();
