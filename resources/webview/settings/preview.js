/* ==========================================================================
   preview.js — Animation settings overlay panel
   ==========================================================================
   Floating draggable overlay that sits above chat content.
   Toggle via window.toggleChatPreviewPanel()
   ========================================================================== */
(function () {
  'use strict';

  var JUNCTION_SHOW_ANIMATION_DEBUG_INFO = !!window.MASTER_DEBUG;

  window.toggleChatPreviewPanel = function () {
    // Splash is the only shipping animation, so the panel opens splash-only.
    // The Chat + Bobber tabs (and their config sections) are legacy plumbing,
    // restored as a set by flipping JUNCTION_SHOW_LEGACY_ANIM (animations.js).
    var SHOW_LEGACY_ANIM = !!window.JUNCTION_SHOW_LEGACY_ANIM;

    var existing = document.getElementById('anim-preview-box');
    if (existing) {
      if (typeof existing._closeAnimationSettings === 'function') existing._closeAnimationSettings();
      else existing.remove();
      return;
    }

    var box = document.createElement('div');
    box.id = 'anim-preview-box';
    box.style.cssText = 'position:fixed;bottom:60px;left:16px;right:16px;z-index:9000;display:flex;flex-direction:column;background:var(--vscode-editor-background);border:1px solid var(--vscode-widget-border, transparent);border-radius:8px;box-shadow:0 8px 32px var(--vscode-widget-shadow, transparent);overflow:hidden;';

    // Top grip = RESIZE (drag the top edge; box is bottom-anchored so it grows
    // upward). Bottom grip = MOVE (reposition the panel vertically).
    var MIN_H = 140, EDGE_GAP = 12;
    var handle = document.createElement('div');
    handle.title = window.junctionT('dragToResize', 'Drag to resize');
    handle.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:6px 0;cursor:ns-resize;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-widget-border, transparent);user-select:none;';
    var handleBar = document.createElement('div');
    handleBar.style.cssText = 'width:32px;height:3px;border-radius:2px;background:var(--vscode-descriptionForeground);opacity:0.5;';
    handle.appendChild(handleBar);
    box.appendChild(handle);

    // Bottom grip (created early so drag logic can reference it)
    var bottomHandle = document.createElement('div');
    bottomHandle.title = window.junctionT('dragToMove', 'Drag to move');
    bottomHandle.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:6px 0;cursor:grab;background:var(--vscode-editor-background);border-top:1px solid var(--vscode-widget-border, transparent);user-select:none;order:99;';
    var bottomBar = document.createElement('div');
    bottomBar.style.cssText = 'width:32px;height:3px;border-radius:2px;background:var(--vscode-descriptionForeground);opacity:0.5;';
    bottomHandle.appendChild(bottomBar);

    // Drag model: the grabbed edge tracks the cursor.
    //   resize → top edge follows cursor, bottom anchored, height changes.
    //   move   → bottom edge follows cursor, height fixed, panel slides.
    var dragging = false, dragMode = '', startBottom = 0, startH = 0;
    function initDrag(mode, e) {
      dragging = true;
      dragMode = mode;
      startBottom = parseInt(box.style.bottom, 10) || 60;
      startH = box.offsetHeight;
      if (mode === 'move') bottomHandle.style.cursor = 'grabbing';
      e.preventDefault();
    }
    handle.addEventListener('mousedown', function (e) { initDrag('resize', e); });
    bottomHandle.addEventListener('mousedown', function (e) { initDrag('move', e); });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var vh = window.innerHeight;
      if (dragMode === 'resize') {
        var maxH = vh - startBottom - EDGE_GAP;
        var newH = Math.max(MIN_H, Math.min(maxH, vh - startBottom - e.clientY));
        box.style.height = newH + 'px';
        box.style.maxHeight = newH + 'px';
      } else {
        var newBottom = Math.max(EDGE_GAP, Math.min(vh - startH - EDGE_GAP, vh - e.clientY));
        box.style.bottom = newBottom + 'px';
      }
    });
    document.addEventListener('mouseup', function () {
      if (dragging && dragMode === 'move') bottomHandle.style.cursor = 'grab';
      dragging = false;
    });

    // Header row: tabs + close
    var header = document.createElement('div');
    header.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:0 10px 4px;border-bottom:1px solid var(--vscode-widget-border, transparent);';

    var tabsRow = document.createElement('div');
    tabsRow.style.cssText = 'display:flex;gap:8px;flex:1;';

    var activeTab = 'chat';

    function makeTab(label, id) {
      var tab = document.createElement('span');
      tab.textContent = label;
      tab.dataset.tab = id;
      tab.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      tab.addEventListener('click', function () {
        activeTab = id;
        refreshTabStyles();
        if (chatCtrl) chatCtrl.dom.style.display = id === 'chat' ? 'block' : 'none';
        if (bobberCtrl) bobberCtrl.dom.style.display = id === 'bobber' ? 'block' : 'none';
        splashDom.style.display = id === 'splash' ? 'block' : 'none';
        if (bubbleCtrl) bubbleCtrl.dom.style.display = id === 'chat' ? 'block' : 'none';
        if (debugDom) debugDom.style.display = id === 'debug' ? 'block' : 'none';
        applyPreviewLayout();
        window.refreshPreview();
      });
      return tab;
    }

    var tabChat = makeTab('Chat', 'chat');
    var tabBobber = makeTab('Bobber', 'bobber');
    var tabSplash = makeTab('Splash', 'splash');
    var tabDebug = JUNCTION_SHOW_ANIMATION_DEBUG_INFO ? makeTab('Debug info', 'debug') : null;
    tabsRow.appendChild(tabChat);            // always: holds non-anim bubble settings
    if (SHOW_LEGACY_ANIM) tabsRow.appendChild(tabBobber);
    tabsRow.appendChild(tabSplash);
    if (tabDebug) tabsRow.appendChild(tabDebug);
    header.appendChild(tabsRow);

    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
    closeBtn.style.cssText = 'background:transparent;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;padding:2px 4px;font-size:14px;';
    function writeAnimationDebugFile() {
      try {
        vscode.postMessage({
          type: 'writeAnimDebugFile',
          config: Object.assign({}, window.animConfig || {}),
          mode: window._junctionAnimationMode || 'matrix',
          color: window._junctionAnimColor,
          loaderColor: window._junctionLoaderAnimColor,
          splashColor: window._junctionSplashColor,
          activeTab: activeTab
        });
      } catch (e) {}
    }

    function closePanel() {
      if (_previewRO) { try { _previewRO.disconnect(); } catch (e) {} }
      window.removeEventListener('resize', scheduleSplashResize);
      if (_resizeTimer) { clearTimeout(_resizeTimer); _resizeTimer = null; }
      var c = box.querySelector('canvas.pretext-canvas');
      if (c && typeof c._stopAnimation === 'function') c._stopAnimation();
      writeAnimationDebugFile();
      box.remove();
    }
    box._closeAnimationSettings = closePanel;
    closeBtn.addEventListener('click', closePanel);
    header.appendChild(closeBtn);
    box.appendChild(header);

    function refreshTabStyles() {
      [tabChat, tabBobber, tabSplash, tabDebug].forEach(function (t) {
        if (!t) return;
        var active = t.dataset.tab === activeTab;
        t.style.color = active ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)';
        t.style.fontWeight = active ? 'bold' : 'normal';
        t.style.borderBottom = active ? '2px solid var(--vscode-button-background)' : '2px solid transparent';
      });
    }
    refreshTabStyles();

    // Scrollable content (flex column so the preview can grow to fill the panel)
    var content = document.createElement('div');
    content.style.cssText = 'flex:1 1 auto;overflow-y:auto;padding:8px 10px;scrollbar-width:thin;display:flex;flex-direction:column;';

    // Actions row
    var actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;';
    function addAction(label, icon, fn) {
      var btn = document.createElement('button');
      btn.innerHTML = '<span class="codicon codicon-' + icon + '"></span> ' + label;
      btn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:3px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-editor-foreground);cursor:pointer;font-size:10px;';
      btn.addEventListener('click', fn);
      actionsRow.appendChild(btn);
    }
    function exportAnimationSettings() {
      var config = Object.assign({}, window.animConfig || {});
      var defaultsTemplate = Object.keys(config).sort().map(function (key) {
        return '      ' + JSON.stringify(key) + ': ' + JSON.stringify(config[key]);
      }).join(',\n');
      var payload = {
        exportedAt: new Date().toISOString(),
        mode: window._junctionAnimationMode || 'matrix',
        color: window._junctionAnimColor || null,
        loaderColor: window._junctionLoaderAnimColor || null,
        splashColor: window._junctionSplashColor || null,
        config: config,
        defaultsTemplate: defaultsTemplate
      };
      var json = JSON.stringify(payload, null, 2);
      try { vscode.postMessage({ type: 'copyToClipboard', text: json }); } catch (e) {}
      try {
        var blob = new Blob([json], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'junction-animation-settings-template.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      } catch (e) {}
    }
    addAction('Play splash', 'rocket', function () {
      if (typeof window.playSplashAnimationPreview === 'function') window.playSplashAnimationPreview();
    });
    addAction('Export settings', 'export', exportAnimationSettings);
    content.appendChild(actionsRow);

    // Preview area — on the Splash tab it flexes to fill the panel so a taller
    // window grows the preview instead of leaving dead space at the bottom.
    var previewArea = document.createElement('div');
    previewArea.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:4px 0;min-height:120px;margin-bottom:8px;flex:0 0 auto;';
    content.appendChild(previewArea);

    function applyPreviewLayout() {
      previewArea.style.flex = (activeTab === 'splash') ? '1 1 auto' : '0 0 auto';
    }

    // ── Debug info tab ───────────────────────────────────────────────────────
    // Catalogue of the app's hardcoded rare-chance easter eggs. Keep in sync
    // with the constants cited in each entry's `source`.
    function buildDebugSection() {
      var EASTER_EGGS = [
        {
          name: 'Rare emoji in the rain',
          odds: '0.001% — 1 in 100,000',
          per: 'rolled per rain character, when Emoji language is OFF',
          effect: 'A random emoji sneaks into the splash matrix rain even though emoji mode is off — and the same roll permanently enables the Good Fonts typeface pack (flips the persisted junction.goodFonts setting, not just this session).',
          source: 'render/animations.js · SPLASH_RARE_EMOJI_CHANCE'
        },
        {
          name: 'Eaten dismiss-press',
          odds: '0.001% — 1 in 100,000',
          per: 'rolled on the first key/click that dismisses the splash',
          effect: 'Your first press to dismiss the splash is silently swallowed once; press again to continue. (Flags the loader with data-rare-input-eaten.)',
          source: 'view-router.js · SPLASH_RARE_INPUT_EAT_CHANCE'
        }
      ];

      var section = document.createElement('div');
      section.style.display = 'none';

      // "Easter eggs" pill — click to expand the list.
      var pill = document.createElement('button');
      pill.textContent = '🥚 Easter eggs (' + EASTER_EGGS.length + ')';
      pill.style.cssText = 'padding:3px 10px;border-radius:999px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);background:var(--vscode-button-background);color:var(--vscode-button-foreground);margin-bottom:8px;';
      section.appendChild(pill);

      var list = document.createElement('div');
      list.style.cssText = 'display:none;flex-direction:column;gap:8px;';
      section.appendChild(list);

      var open = false;
      pill.addEventListener('click', function () {
        open = !open;
        list.style.display = open ? 'flex' : 'none';
      });

      EASTER_EGGS.forEach(function (egg) {
        var card = document.createElement('div');
        card.style.cssText = 'border:1px solid var(--vscode-widget-border, var(--vscode-input-border));border-radius:6px;padding:8px 10px;background:var(--vscode-editor-background);';

        var title = document.createElement('div');
        title.textContent = egg.name;
        title.style.cssText = 'font-size:11px;font-weight:600;color:var(--vscode-editor-foreground);margin-bottom:4px;';
        card.appendChild(title);

        var odds = document.createElement('div');
        odds.innerHTML = '<span style="color:var(--vscode-descriptionForeground);">Odds:</span> ' + egg.odds;
        odds.style.cssText = 'font-size:10px;color:var(--vscode-editor-foreground);font-variant-numeric:tabular-nums;';
        card.appendChild(odds);

        var per = document.createElement('div');
        per.textContent = egg.per;
        per.style.cssText = 'font-size:9px;color:var(--vscode-descriptionForeground);margin:2px 0 5px;';
        card.appendChild(per);

        var effect = document.createElement('div');
        effect.textContent = egg.effect;
        effect.style.cssText = 'font-size:10px;color:var(--vscode-editor-foreground);line-height:1.45;';
        card.appendChild(effect);

        var src = document.createElement('div');
        src.textContent = egg.source;
        src.style.cssText = 'font-size:8px;color:var(--vscode-descriptionForeground);margin-top:5px;font-family:var(--vscode-editor-font-family, monospace);';
        card.appendChild(src);

        list.appendChild(card);
      });

      return section;
    }

    // Config sections — chat/bobber are legacy ANIMATION config (built only when
    // revived). Bubble shape is non-animation chat styling, so it stays in the
    // Chat tab regardless of the legacy flag.
    var chatCtrl = null, bobberCtrl = null, bubbleCtrl = null;
    if (SHOW_LEGACY_ANIM) {
      chatCtrl = window.buildConfigSection(false, window.refreshPreview);
      bobberCtrl = window.buildConfigSection(true, window.refreshPreview);
      chatCtrl.dom.style.display = activeTab === 'chat' ? 'block' : 'none';
      bobberCtrl.dom.style.display = 'none';
      content.appendChild(chatCtrl.dom);
      content.appendChild(bobberCtrl.dom);
    }

    bubbleCtrl = window.buildBubbleSection ? window.buildBubbleSection() : null;
    if (bubbleCtrl) {
      bubbleCtrl.dom.style.display = activeTab === 'chat' ? 'block' : 'none';
      content.appendChild(bubbleCtrl.dom);
    }

    var splashDom = window.buildSplashSection();
    splashDom.style.display = activeTab === 'splash' ? 'block' : 'none';
    content.appendChild(splashDom);

    var debugDom = JUNCTION_SHOW_ANIMATION_DEBUG_INFO ? buildDebugSection() : null;
    if (debugDom) {
      debugDom.style.display = activeTab === 'debug' ? 'block' : 'none';
      content.appendChild(debugDom);
    }

    box.appendChild(content);

    // Append bottom handle (already created above)
    box.appendChild(bottomHandle);

    // Preview renderer
    window.refreshPreview = function () {
      // Stop + remove the entire previous render. The splash tab wraps its
      // canvas in a div, so clearing only the canvas leaks the wrapper (and its
      // wordmark/logo) on every change — clear the whole preview area instead.
      previewArea.querySelectorAll('canvas.pretext-canvas').forEach(function (c) {
        if (typeof c._stopAnimation === 'function') { try { c._stopAnimation(); } catch (e) {} }
      });
      while (previewArea.firstChild) previewArea.removeChild(previewArea.firstChild);
      var existingFullScreen = document.querySelectorAll('canvas.full-screen-anim');
      existingFullScreen.forEach(function (c) {
        if (c._stopAnimation) try { c._stopAnimation(); } catch (e) {}
        else c.remove();
      });

      if (activeTab === 'chat') {
        // Chat tab shows only non-animation bubble settings unless the legacy
        // animation stack is revived — skip the curtain preview render otherwise.
        if (!SHOW_LEGACY_ANIM) return;
        var isMagic = !!(window.animConfig && window.animConfig.magic);
        var cfg = window.animConfig || {};
        var opts = {
          duration: Math.round((cfg.length || 2.0) * 1000),
          mode: cfg.mode || window._junctionAnimationMode || 'matrix',
          loop: !!cfg.loop
        };
        if (isMagic) {
          var rect = previewArea.getBoundingClientRect();
          if (rect.width <= 0) rect = { left: window.innerWidth / 2 - 150, top: window.innerHeight - 150, width: 300, height: 60 };
          opts.unbounded = true;
          opts.rect = rect;
        } else {
          opts.width = 300;
        }
        var canvas = window.createAnimatedCanvas('Hello world, this is a test.', opts);
        if (canvas) {
          if (isMagic) {
            document.body.appendChild(canvas);
            setTimeout(function () { if (canvas && canvas._stopAnimation) canvas._stopAnimation(); canvas.remove(); }, 850);
          } else {
            canvas.style.maxWidth = '280px';
            previewArea.appendChild(canvas);
          }
        }
      } else if (activeTab === 'bobber') {
        var cfg = window.animConfig || {};
        var canvas = window.createAnimatedCanvas('Junction', { loader: true, isSplash: true, width: 300, height: 60, loaderLoop: !!cfg.loaderLoop });
        if (canvas) { canvas.style.maxWidth = '280px'; previewArea.appendChild(canvas); }
      } else if (activeTab === 'debug') {
        // No preview canvas on the Debug tab — it's an informational panel.
      } else {
        var splashPreview = document.createElement('div');
        // Match the real splash, which fills the webview — preview at the LIVE
        // viewport aspect ratio (never hard-coded). Fit the largest such rect
        // inside the available preview area, which itself grows with the panel.
        var viewAspect = (window.innerWidth || 300) / (window.innerHeight || 300);
        var availWidth = Math.max(120, (previewArea.clientWidth || 300) - 8);
        var availHeight = Math.max(120, (previewArea.clientHeight || 120) - 8);
        var previewWidth = availWidth;
        var previewHeight = previewWidth / viewAspect;
        if (previewHeight > availHeight) { previewHeight = availHeight; previewWidth = previewHeight * viewAspect; }
        previewWidth = Math.round(previewWidth);
        previewHeight = Math.round(previewHeight);
        splashPreview.style.cssText = 'position:relative;width:' + previewWidth + 'px;height:' + previewHeight + 'px;overflow:hidden;border-radius:6px;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);cursor:pointer;';
        if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale(splashPreview);
        // Render the canvas at its ACTUAL display size (1:1, no CSS down-scaling).
        // The rain uses a fixed character size, so a 1:1 canvas makes the chars
        // and their on-screen speed identical to the live splash — a shrunk-down
        // canvas would visually slow the motion and mismatch the real splash.
        var splashCanvas = window.createAnimatedCanvas('Junction', { loader: true, isSplash: true, width: previewWidth, height: previewHeight, loaderLoop: true, loaderElement: splashPreview });
        if (splashCanvas) {
          splashCanvas.style.maxWidth = previewWidth + 'px';
          splashCanvas.style.width = previewWidth + 'px';
          splashCanvas.style.height = previewHeight + 'px';
          splashPreview.insertBefore(splashCanvas, splashPreview.firstChild);
        }
        splashPreview.addEventListener('click', function () {
          if (!splashCanvas || typeof splashCanvas._startSplashExit !== 'function') return;
          var modes = (window.JunctionAnimation && window.JunctionAnimation.previewSplashExitModes) || ['spiral-out', 'spiral-in', 'explode', 'explode2', 'melt', 'float-away', 'horizontal-flatten', 'explode-weak', 'starwars-crawl', 'explode3-bounce', 'explode3-no-bounce'];
          var selected = (window.animConfig && window.animConfig.splashExitMode) || 'random';
          var mode = selected === 'random' ? modes[Math.floor(Math.random() * modes.length)] : selected;
          splashCanvas._startSplashExit({ mode: mode });
          function restoreWhenDone() {
            if (typeof splashCanvas._isSplashExitComplete === 'function' && !splashCanvas._isSplashExitComplete()) {
              setTimeout(restoreWhenDone, 80);
              return;
            }
            if (activeTab === 'splash') window.refreshPreview();
          }
          restoreWhenDone();
        });
        previewArea.appendChild(splashPreview);
      }
    };

    // Rebuild the splash preview at the new size when the panel (or window) is
    // resized — the canvas needs real pixel dimensions, so a CSS stretch won't
    // do. Debounced so a drag doesn't thrash re-creation.
    var _resizeTimer = null;
    function scheduleSplashResize() {
      if (activeTab !== 'splash') return;
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(function () {
        _resizeTimer = null;
        if (activeTab === 'splash' && document.getElementById('anim-preview-box')) window.refreshPreview();
      }, 120);
    }
    var _previewRO = null;
    if (typeof ResizeObserver === 'function') {
      _previewRO = new ResizeObserver(scheduleSplashResize);
      _previewRO.observe(box);
    }
    window.addEventListener('resize', scheduleSplashResize);

    document.body.appendChild(box);
    applyPreviewLayout();
    window.refreshPreview();
  };
})();
