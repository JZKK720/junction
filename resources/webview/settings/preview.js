/* ==========================================================================
   preview.js — Animation settings overlay panel
   ==========================================================================
   Floating draggable overlay that sits above chat content.
   Toggle via window.toggleChatPreviewPanel()
   ========================================================================== */
(function () {
  'use strict';

  window.toggleChatPreviewPanel = function () {
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
    box.style.cssText = 'position:fixed;bottom:60px;left:16px;right:16px;z-index:9000;max-height:60vh;display:flex;flex-direction:column;background:var(--vscode-editor-background);border:1px solid var(--vscode-widget-border, transparent);border-radius:8px;box-shadow:0 8px 32px var(--vscode-widget-shadow, transparent);overflow:hidden;';

    // Drag handle
    var handle = document.createElement('div');
    handle.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:6px 0;cursor:ns-resize;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-widget-border, transparent);user-select:none;';
    var handleBar = document.createElement('div');
    handleBar.style.cssText = 'width:32px;height:3px;border-radius:2px;background:var(--vscode-descriptionForeground);opacity:0.5;';
    handle.appendChild(handleBar);
    box.appendChild(handle);

    // Bottom resize handle (created early so drag logic can reference it)
    var bottomHandle = document.createElement('div');
    bottomHandle.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:6px 0;cursor:ns-resize;background:var(--vscode-editor-background);border-top:1px solid var(--vscode-widget-border, transparent);user-select:none;order:99;';
    var bottomBar = document.createElement('div');
    bottomBar.style.cssText = 'width:32px;height:3px;border-radius:2px;background:var(--vscode-descriptionForeground);opacity:0.5;';
    bottomHandle.appendChild(bottomBar);

    // Drag-to-resize logic (top handle pulls up, bottom handle pulls down)
    var dragging = false, dragDir = '', startY = 0, startH = 0, startBottom = 0;
    function initDrag(dir, e) {
      dragging = true;
      dragDir = dir;
      startY = e.clientY;
      startH = box.offsetHeight;
      startBottom = parseInt(box.style.bottom, 10) || 60;
      e.preventDefault();
    }
    handle.addEventListener('mousedown', function (e) { initDrag('top', e); });
    bottomHandle.addEventListener('mousedown', function (e) { initDrag('bottom', e); });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      if (dragDir === 'top') {
        var delta = startY - e.clientY;
        var newH = Math.max(120, Math.min(window.innerHeight * 0.85, startH + delta));
        box.style.maxHeight = newH + 'px';
      } else {
        var delta = e.clientY - startY;
        var newH = Math.max(120, Math.min(window.innerHeight * 0.85, startH - delta));
        box.style.maxHeight = newH + 'px';
        var newBottom = Math.max(0, Math.min(window.innerHeight * 0.5, startBottom - delta));
        box.style.bottom = newBottom + 'px';
      }
    });
    document.addEventListener('mouseup', function () { dragging = false; });

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
        chatCtrl.dom.style.display = id === 'chat' ? 'block' : 'none';
        bobberCtrl.dom.style.display = id === 'bobber' ? 'block' : 'none';
        splashDom.style.display = id === 'splash' ? 'block' : 'none';
        if (bubbleCtrl) bubbleCtrl.dom.style.display = id === 'chat' ? 'block' : 'none';
        window.refreshPreview();
      });
      return tab;
    }

    var tabChat = makeTab('Chat', 'chat');
    var tabBobber = makeTab('Bobber', 'bobber');
    var tabSplash = makeTab('Splash', 'splash');
    tabsRow.appendChild(tabChat);
    tabsRow.appendChild(tabBobber);
    tabsRow.appendChild(tabSplash);
    header.appendChild(tabsRow);

    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
    closeBtn.style.cssText = 'background:transparent;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;padding:2px 4px;font-size:14px;';
    closeBtn.addEventListener('click', function () {
      var c = box.querySelector('canvas.pretext-canvas');
      if (c && typeof c._stopAnimation === 'function') c._stopAnimation();
      box.remove();
    });
    header.appendChild(closeBtn);
    box.appendChild(header);

    function refreshTabStyles() {
      [tabChat, tabBobber, tabSplash].forEach(function (t) {
        var active = t.dataset.tab === activeTab;
        t.style.color = active ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)';
        t.style.fontWeight = active ? 'bold' : 'normal';
        t.style.borderBottom = active ? '2px solid var(--vscode-button-background)' : '2px solid transparent';
      });
    }
    refreshTabStyles();

    // Scrollable content
    var content = document.createElement('div');
    content.style.cssText = 'flex:1 1 auto;overflow-y:auto;padding:8px 10px;scrollbar-width:thin;';

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
    addAction('Play curtain', 'comment', function () {
      if (typeof window.playChatCurtainPreview === 'function') window.playChatCurtainPreview();
    });
    addAction('Play splash', 'rocket', function () {
      if (typeof window.playSplashAnimationPreview === 'function') window.playSplashAnimationPreview();
    });
    content.appendChild(actionsRow);

    // Preview area
    var previewArea = document.createElement('div');
    previewArea.style.cssText = 'display:flex;justify-content:center;padding:4px 0;min-height:60px;margin-bottom:8px;';
    content.appendChild(previewArea);

    // Config sections
    var chatCtrl = window.buildConfigSection(false, window.refreshPreview);
    var bobberCtrl = window.buildConfigSection(true, window.refreshPreview);
    var bubbleCtrl = window.buildBubbleSection ? window.buildBubbleSection() : null;

    chatCtrl.dom.style.display = 'block';
    bobberCtrl.dom.style.display = 'none';

    content.appendChild(chatCtrl.dom);
    if (bubbleCtrl) {
      bubbleCtrl.dom.style.display = 'block';
      content.appendChild(bubbleCtrl.dom);
    }
    content.appendChild(bobberCtrl.dom);

    var splashDom = window.buildSplashSection();
    splashDom.style.display = 'none';
    content.appendChild(splashDom);

    box.appendChild(content);

    // Append bottom handle (already created above)
    box.appendChild(bottomHandle);

    // Preview renderer
    window.refreshPreview = function () {
      var oldCanvas = previewArea.querySelector('canvas.pretext-canvas');
      if (oldCanvas) {
        if (typeof oldCanvas._stopAnimation === 'function') oldCanvas._stopAnimation();
        oldCanvas.remove();
      }
      var existingFullScreen = document.querySelectorAll('canvas.full-screen-anim');
      existingFullScreen.forEach(function (c) {
        if (c._stopAnimation) try { c._stopAnimation(); } catch (e) {}
        else c.remove();
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
      } else {
        var splashPreview = document.createElement('div');
        splashPreview.style.cssText = 'position:relative;width:300px;height:120px;overflow:hidden;border-radius:6px;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);';
        if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale(splashPreview);
        var splashCanvas = window.createAnimatedCanvas('Junction', { loader: true, isSplash: true, width: 300, height: 120, loaderLoop: true, loaderElement: splashPreview });
        if (splashCanvas) { splashCanvas.style.maxWidth = '300px'; splashCanvas.style.height = '120px'; splashPreview.insertBefore(splashCanvas, splashPreview.firstChild); }
        previewArea.appendChild(splashPreview);
      }
    };

    document.body.appendChild(box);
    window.refreshPreview();
  };
})();
