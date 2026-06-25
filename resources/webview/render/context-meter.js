/* ==========================================================================
   context-meter.js — context-window usage + manual compaction affordance
   --------------------------------------------------------------------------
   Two appearances, chosen by the active look-and-feel layout:
     • timeline mode → Claude-Code-faithful: a pie gauge that stays HIDDEN until
       context is meaningfully full (≥ SHOW_AT% used), click to compact, hover
       shows "{remaining}% of context remaining until auto-compact".
     • compact mode → Codex-style TWO-STAGE: below the threshold a minimal
       "{N}%" indicator; at/above it expands to a "Context · {N}% full" chip +
       an explicit Compact button (disabled while a run is active).
   Fed by `contextUsage` / `contextCompacting`; clicking posts `compactContext`.
   ========================================================================== */
(function () {
  'use strict';

  // Mirror Claude Code's gauge gate: nothing until ≥ 50% of the window is used.
  var SHOW_AT = 50;

  var state = { percentUsed: null, usedTokens: null, canCompact: false, running: false, compacting: false, alwaysShow: false };

  // Effective reveal threshold: 0 when the user opts into "always show".
  function showAt() { return state.alwaysShow ? 0 : SHOW_AT; }

  function isTimeline() {
    return document.body.classList.contains('stream-layout-timeline');
  }

  function host() {
    var footer = document.getElementById('composer-footer');
    if (!footer) return null;
    var el = document.getElementById('context-meter');
    if (!el) {
      el = document.createElement('div');
      el.id = 'context-meter';
      el.className = 'context-meter';
      footer.appendChild(el);
    }
    return el;
  }

  function compact() {
    if (!state.canCompact || state.running || state.compacting) return;
    state.compacting = true;
    vscode.postMessage({ type: 'compactContext' });
    render();
  }

  function setHidden(el) { el.hidden = true; el.innerHTML = ''; }

  function render() {
    var el = host();
    if (!el) return;
    el.classList.toggle('context-meter-timeline', isTimeline());
    el.classList.toggle('context-meter-compact', !isTimeline());

    if (state.compacting) {
      el.hidden = false;
      el.innerHTML = '';
      var busy = document.createElement('span');
      busy.className = 'context-meter-busy';
      busy.textContent = window.junctionT('compacting', 'Compacting...');
      el.appendChild(busy);
      return;
    }

    var pct = state.percentUsed;
    var hasPct = typeof pct === 'number';

    if (isTimeline()) return renderTimeline(el, pct, hasPct);
    return renderCompact(el, pct, hasPct);
  }

  // ── timeline: Claude-Code pie gauge, hidden until ≥ SHOW_AT% used ────────
  function renderTimeline(el, pct, hasPct) {
    if (!hasPct || pct < showAt()) { setHidden(el); return; }
    el.hidden = false;
    el.innerHTML = '';
    var remaining = Math.max(0, 100 - pct);

    var gauge = document.createElement('button');
    gauge.type = 'button';
    gauge.className = 'context-gauge';
    gauge.disabled = !state.canCompact;
    gauge.style.setProperty('--ctx-pct', pct);
    gauge.classList.toggle('ctx-warn', pct >= 80);
    gauge.title = window.junctionT('contextUsed', '{percent}% context used', { percent: pct }) + (state.canCompact ? ' - ' + window.junctionT('clickToCompact', 'Click to compact') : '');

    var pie = document.createElement('span');
    pie.className = 'context-gauge-pie';
    gauge.appendChild(pie);
    gauge.addEventListener('click', compact);

    // Hover popover: "{remaining}% of context remaining until auto-compact."
    var pop = document.createElement('span');
    pop.className = 'context-gauge-popover';
    pop.hidden = true;
    pop.innerHTML = '';
    var line = document.createElement('span');
    line.className = 'context-gauge-popover-line';
    line.textContent = window.junctionT('contextRemainingUntilAutoCompact', '{percent}% of context remaining until auto-compact.', { percent: remaining });
    pop.appendChild(line);
    if (state.canCompact) {
      var hint = document.createElement('span');
      hint.className = 'context-gauge-popover-hint';
      hint.textContent = window.junctionT('clickToCompact', 'Click to compact');
      pop.appendChild(hint);
    }
    gauge.addEventListener('mouseenter', function () { pop.hidden = false; });
    gauge.addEventListener('mouseleave', function () { pop.hidden = true; });

    el.appendChild(gauge);
    el.appendChild(pop);
  }

  // ── compact: Codex two-stage chip ───────────────────────────────────────
  function renderCompact(el, pct, hasPct) {
    // Nothing known yet (no window) and no token count → hide.
    if (!hasPct && typeof state.usedTokens !== 'number') { setHidden(el); return; }
    el.hidden = false;
    el.innerHTML = '';

    var full = hasPct && pct >= showAt();
    if (!full) {
      // Stage 1: minimal, unobtrusive indicator. No compact button.
      var mini = document.createElement('span');
      mini.className = 'context-mini';
      mini.textContent = hasPct ? (pct + '%') : (state.usedTokens || 0).toLocaleString();
      mini.title = hasPct ? window.junctionT('contextUsed', '{percent}% context used', { percent: pct }) : window.junctionT('tokensUsed', '{count} tokens used', { count: (state.usedTokens || 0).toLocaleString() });
      el.appendChild(mini);
      return;
    }

    // Stage 2: full chip + Compact emphasis.
    var chip = document.createElement('span');
    chip.className = 'context-chip';
    chip.textContent = window.junctionT('contextFull', 'Context · {percent}% full', { percent: pct });
    if (pct >= 80) chip.classList.add('ctx-warn');
    el.appendChild(chip);
    if (state.canCompact) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'context-compact-btn';
      btn.textContent = window.junctionT('compact', 'Compact');
      btn.disabled = state.running;
      btn.title = state.running ? window.junctionT('compactDisabled', 'Compact is disabled while a task is in progress') : window.junctionT('compactThisThread', 'Compact this thread’s context');
      btn.addEventListener('click', compact);
      el.appendChild(btn);
    }
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'config':
        if (msg.alwaysShowUsageChip !== undefined) { state.alwaysShow = !!msg.alwaysShowUsageChip; render(); }
        break;
      case 'contextUsage':
        state.percentUsed = typeof msg.percentUsed === 'number' ? msg.percentUsed : null;
        state.usedTokens = typeof msg.usedTokens === 'number' ? msg.usedTokens : null;
        state.canCompact = !!msg.canCompact;
        state.compacting = false;
        render();
        break;
      case 'contextCompacting':
        state.compacting = true;
        render();
        break;
      case 'runActive':
        state.running = !!msg.active;
        render();
        break;
      case 'runComplete':
        state.running = false;
        render();
        break;
      case 'clearChat':
        state.percentUsed = null; state.usedTokens = null; state.compacting = false;
        render();
        break;
    }
  });
})();
