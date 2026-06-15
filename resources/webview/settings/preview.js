/* ==========================================================================
   preview.js — Animation preview panel (toggle, refresh, preview area)
   ==========================================================================
   Toggle chat preview panel with tabs: Chat Messages, Bobber Settings, Splash.
   Exports: window.toggleChatPreviewPanel, window.refreshPreview
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
    box.style.cssText = 'padding:8px;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);border-radius:4px;margin:4px 0;';

    // Preview area defined early so refreshPreview can reference it
    var previewArea = document.createElement('div');
    previewArea.style.cssText = 'display:flex;justify-content:center;padding:4px 0;min-height:60px;';

    var activeTab = 'chat'; // 'chat' or 'bobber' or 'splash'

    window.refreshPreview = function () {
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

        var canvas = window.createAnimatedCanvas('Hello world, this is a test.', opts);
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
      } else if (activeTab === 'bobber') {
        var cfg = window.animConfig || {};
        var opts = {
          loader: true,
          isSplash: true,
          width: 300,
          height: 60,
          loaderLoop: !!cfg.loaderLoop
        };
        var canvas = window.createAnimatedCanvas('Junction', opts);
        if (canvas) {
          canvas.style.maxWidth = '280px';
          previewArea.appendChild(canvas);
        }
      } else {
        var splashPreview = document.createElement('div');
        splashPreview.style.cssText = 'position:relative;width:300px;height:120px;overflow:hidden;border-radius:6px;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);';
        if (typeof window.applySplashWordmarkScale === 'function') window.applySplashWordmarkScale(splashPreview);

        var copy = document.createElement('div');
        copy.className = 'startup-copy';
        copy.innerHTML = '<div class="startup-wordmark">Junction</div><div class="startup-sub">connecting…</div>';
        splashPreview.appendChild(copy);

        var splashCanvas = window.createAnimatedCanvas('Junction', {
          loader: true,
          isSplash: true,
          width: 300,
          height: 120,
          loaderLoop: true,
          loaderElement: splashPreview
        });
        if (splashCanvas) {
          splashCanvas.style.maxWidth = '300px';
          splashCanvas.style.height = '120px';
          splashPreview.insertBefore(splashCanvas, splashPreview.firstChild);
        }
        previewArea.appendChild(splashPreview);
      }
    };

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
    box.appendChild(actionsRow);

    var chatCtrl = window.buildConfigSection(false, window.refreshPreview);
    var bobberCtrl = window.buildConfigSection(true, window.refreshPreview);

    chatCtrl.dom.style.display = 'block';
    bobberCtrl.dom.style.display = 'none';

    box.appendChild(chatCtrl.dom);
    box.appendChild(bobberCtrl.dom);

    var splashDom = window.buildSplashSection();
    box.appendChild(splashDom);

    // Click handlers for switching tabs
    tabChat.addEventListener('click', function () {
      activeTab = 'chat';
      tabChat.style.cssText = 'cursor:pointer;font-size:11px;font-weight:bold;color:var(--vscode-button-foreground);border-bottom:2px solid var(--vscode-button-background);padding:2px 4px;';
      tabBobber.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      tabSplash.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      chatCtrl.dom.style.display = 'block';
      bobberCtrl.dom.style.display = 'none';
      splashDom.style.display = 'none';
      window.refreshPreview();
    });

    tabBobber.addEventListener('click', function () {
      activeTab = 'bobber';
      tabBobber.style.cssText = 'cursor:pointer;font-size:11px;font-weight:bold;color:var(--vscode-button-foreground);border-bottom:2px solid var(--vscode-button-background);padding:2px 4px;';
      tabChat.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      tabSplash.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      chatCtrl.dom.style.display = 'none';
      bobberCtrl.dom.style.display = 'block';
      splashDom.style.display = 'none';
      window.refreshPreview();
    });

    tabSplash.addEventListener('click', function () {
      activeTab = 'splash';
      tabSplash.style.cssText = 'cursor:pointer;font-size:11px;font-weight:bold;color:var(--vscode-button-foreground);border-bottom:2px solid var(--vscode-button-background);padding:2px 4px;';
      tabChat.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      tabBobber.style.cssText = 'cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;';
      chatCtrl.dom.style.display = 'none';
      bobberCtrl.dom.style.display = 'none';
      splashDom.style.display = 'block';
    });

    box.appendChild(previewArea);
    window.refreshPreview();

    var inputArea = document.querySelector('#composer-shell');
    if (inputArea) inputArea.parentNode.insertBefore(box, inputArea);
  };
})();
