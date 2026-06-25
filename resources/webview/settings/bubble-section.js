/* ==========================================================================
   bubble-section.js — User bubble shape settings (roundness, tip)
   ========================================================================== */
(function () {
  'use strict';

  window.buildBubbleSection = function () {
    var section = document.createElement('div');
    section.style.cssText = 'margin-top:8px;padding-top:6px;border-top:1px solid var(--vscode-widget-border, transparent);';

    var title = document.createElement('span');
    title.textContent = window.junctionT('bubbleShape', 'Bubble Shape');
    title.style.cssText = 'font-size:10px;font-weight:600;color:var(--vscode-editor-foreground);margin-right:8px;';
    section.appendChild(title);

    // ── Roundness slider ─────────────────────────────────────────────────
    var radiusRow = document.createElement('div');
    radiusRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:4px;';
    var radiusLbl = document.createElement('span');
    radiusLbl.textContent = window.junctionT('roundness', 'Roundness');
    radiusLbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:52px;';
    radiusRow.appendChild(radiusLbl);

    var radiusSlider = document.createElement('input');
    radiusSlider.type = 'range';
    radiusSlider.min = '0';
    radiusSlider.max = '32';
    radiusSlider.step = '1';
    radiusSlider.style.cssText = 'width:80px;height:12px;accent-color:var(--vscode-button-background);';
    radiusRow.appendChild(radiusSlider);

    var radiusVal = document.createElement('span');
    radiusVal.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:24px;text-align:right;';
    radiusRow.appendChild(radiusVal);

    var radiusDesc = document.createElement('span');
    radiusDesc.style.cssText = 'font-size:8px;color:var(--vscode-descriptionForeground);margin-left:4px;';
    radiusRow.appendChild(radiusDesc);

    function syncRadius() {
      var raw = getComputedStyle(document.documentElement).getPropertyValue('--junction-bubble-radius').trim();
      var parsed = parseInt(raw, 10);
      var px = Number.isFinite(parsed) ? parsed : 16;
      radiusSlider.value = Math.min(32, Math.max(0, px));
      radiusVal.textContent = radiusSlider.value + 'px';
      if (px === 0) radiusDesc.textContent = window.junctionT('hard', 'hard');
      else if (px >= 32) radiusDesc.textContent = window.junctionT('circle', 'circle');
      else radiusDesc.textContent = '';
    }

    radiusSlider.addEventListener('input', function () {
      var v = parseInt(this.value, 10);
      radiusVal.textContent = v + 'px';
      if (v === 0) radiusDesc.textContent = window.junctionT('hard', 'hard');
      else if (v >= 32) radiusDesc.textContent = window.junctionT('circle', 'circle');
      else radiusDesc.textContent = '';
      document.documentElement.style.setProperty('--junction-bubble-radius', v + 'px');
      saveBubbleSettings();
    });

    syncRadius();
    window.settingsSyncFunctions.push(syncRadius);
    section.appendChild(radiusRow);

    // ── Tip position ─────────────────────────────────────────────────────
    var tipRow = document.createElement('div');
    tipRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:4px;';
    var tipLbl = document.createElement('span');
    tipLbl.textContent = window.junctionT('tip', 'Tip');
    tipLbl.style.cssText = 'font-size:9px;color:var(--vscode-editor-foreground);min-width:52px;';
    tipRow.appendChild(tipLbl);

    var tips = [
      { val: 'none', label: window.junctionT('none', 'None') },
      { val: 'bottom-right', label: window.junctionT('bottom', 'Bottom') },
      { val: 'top-right', label: window.junctionT('top', 'Top') }
    ];

    var tipBtns = [];
    tips.forEach(function (opt) {
      var btn = document.createElement('button');
      btn.textContent = opt.label;
      btn.style.cssText = 'padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid var(--vscode-input-border);';
      btn.addEventListener('click', function () {
        document.documentElement.style.setProperty('--junction-bubble-tip', opt.val);
        document.querySelectorAll('#chat-messages .chat-row.user .msg-text').forEach(function (b) {
          if (opt.val === 'none') b.removeAttribute('data-tip');
          else b.setAttribute('data-tip', opt.val);
        });
        syncTipBtns();
        saveBubbleSettings();
      });
      tipBtns.push({ btn: btn, val: opt.val });
      tipRow.appendChild(btn);
    });

    function syncTipBtns() {
      var current = getComputedStyle(document.documentElement).getPropertyValue('--junction-bubble-tip').trim() || 'none';
      tipBtns.forEach(function (t) {
        var active = t.val === current;
        t.btn.style.background = active ? 'var(--vscode-button-background)' : 'var(--vscode-input-background)';
        t.btn.style.color = active ? 'var(--vscode-button-foreground)' : 'var(--vscode-editor-foreground)';
      });
    }
    syncTipBtns();
    window.settingsSyncFunctions.push(syncTipBtns);
    section.appendChild(tipRow);

    function saveBubbleSettings() {
      var parsed = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--junction-bubble-radius').trim(), 10);
      var radius = Number.isFinite(parsed) ? parsed : 16;
      var tip = getComputedStyle(document.documentElement).getPropertyValue('--junction-bubble-tip').trim() || 'none';
      try {
        var state = vscode.getState() || {};
        state.bubbleRadius = radius;
        state.bubbleTip = tip;
        vscode.setState(state);
        vscode.postMessage({ type: 'saveBubbleConfig', radius: radius, tip: tip });
      } catch (e) {}
    }

    return { dom: section };
  };
})();
