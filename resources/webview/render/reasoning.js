/* ==========================================================================
   reasoning.js — Reasoning disclosures, thinking bar animation,
                   summary labels, finalize reasoning
   ========================================================================== */
(function () {
  'use strict';

  // ── Reasoning mode ──────────────────────────────────────────────────────────
  var reasoningMode = 'compact';

  // Zalgo character sets for the rising animation
  var ZALGO_UP_r = ['̍','̎','̄','̅','̿','̑','̐','̒','̓','̔','̽','̾','̿','̀','́','̂','̃','̄','̆','̇','̈','̉','̊','̋','̌','̍','̎','̏','̐','̒','̓','̔','̕','̖','̗','̘','̙','̜','̝','̞','̟','̠','̡','̢','̣','̤','̥','̦','̧','̨','̩','̪','̫','̬','̭','̮','̯','̰','̱','̲','̳','̹','̺','̻','̼','̽','̾','̿','̀','́','̂','̃','̄','̅','̆','̇','̈','̉','̊','̋','̌','̍','̎','̏','̐','̒'];
  var ZALGO_MID_r = ['̴','̵','̶','̷','̸'];
  var THINKING_BAR_COLS = 16;
  var THINKING_BAR_HEIGHT = 3;
  var THINKING_BAR_UPDATE_MS = 280;

  function thinkingBarHtml() {
    var cols = '';
    for (var c = 0; c < THINKING_BAR_COLS; c++) {
      var delay = (c * 37) % 200;
      var cells = '';
      for (var r = 0; r < THINKING_BAR_HEIGHT; r++) {
        cells += '<span class="thinking-bar-cell" style="opacity:0"></span>';
      }
      cols += '<div class="thinking-bar-col" style="animation-delay:' + delay + 'ms">' + cells + '</div>';
    }
    var line = '';
    for (var i = 0; i < THINKING_BAR_COLS; i++) line += '\u2500';
    return '<div class="thinking-bar" data-active="false">' +
      '<div class="thinking-bar-cols">' + cols + '</div>' +
      '<div class="thinking-bar-line">' + line + '</div>' +
    '</div>';
  }

  function zalgoRandom(set) { return set[Math.floor(Math.random() * set.length)]; }

  function zalgoChar() {
    var base = String.fromCharCode(0x30 + Math.floor(Math.random() * 42));
    var count = 1 + Math.floor(Math.random() * 2);
    var marks = '';
    for (var i = 0; i < count; i++) marks += zalgoRandom(ZALGO_UP_r);
    return base + marks;
  }

  function tickThinkingBar(bar) {
    if (!bar || bar.dataset.active === 'done') return;
    var cols = bar.querySelectorAll('.thinking-bar-col');
    cols.forEach(function (col, ci) {
      var cells = col.querySelectorAll('.thinking-bar-cell');
      for (var i = 0; i < cells.length - 1; i++) {
        cells[i].textContent = cells[i + 1].textContent;
        cells[i].style.opacity = cells[i + 1].textContent ? (0.3 + 0.7 * (i / cells.length)).toFixed(2) : '0';
        cells[i].style.filter = 'blur(' + (Math.max(0, cells.length - i - 2) * 0.4) + 'px)';
      }
      var topCell = cells[cells.length - 1];
      if (Math.random() < 0.65) {
        topCell.textContent = zalgoChar();
        topCell.style.opacity = '0.9';
        topCell.style.filter = 'blur(0px)';
      } else {
        topCell.textContent = '';
        topCell.style.opacity = '0';
      }
    });
  }

  function startThinkingBar(bar) {
    if (!bar) return;
    bar.dataset.active = 'running';
    bar.querySelectorAll('.thinking-bar-col').forEach(function (col) {
      col.querySelectorAll('.thinking-bar-cell').forEach(function (cell) {
        if (Math.random() < 0.4) {
          cell.textContent = zalgoChar();
          cell.style.opacity = (0.2 + Math.random() * 0.6).toFixed(2);
        }
      });
    });
    scheduleBarTick(bar);
  }

  function stopThinkingBar(bar) {
    if (!bar) return;
    bar.dataset.active = 'done';
    bar.querySelectorAll('.thinking-bar-cell').forEach(function (cell) {
      cell.textContent = '';
      cell.style.opacity = '0';
    });
  }

  var _barTimers = new Map();
  function scheduleBarTick(bar) {
    if (_barTimers.has(bar)) return;
    _barTimers.set(bar, setTimeout(function () {
      _barTimers.delete(bar);
      if (bar.dataset.active === 'running') {
        tickThinkingBar(bar);
        scheduleBarTick(bar);
      }
    }, THINKING_BAR_UPDATE_MS));
  }

  function summaryHtml(label, opts) {
    opts = opts || {};
    var bar = opts.showBar ? thinkingBarHtml() : '';
    return '<span class="thinking-throbber" aria-hidden="true"></span>' +
      bar +
      '<span class="reasoning-summary-text">' +
        '<span class="reasoning-label">' + window.escapeHtml(label) + '</span>' +
        '<span class="reasoning-activity-summary"></span>' +
      '</span>' +
      '<span class="codicon codicon-chevron-right thinking-toggle" aria-hidden="true"></span>';
  }

  // Reasoning shares the .tool-calls stream with tool rows so thoughts and tools
  // interleave chronologically as flat siblings. Ensure that container exists and
  // is registered, creating it if reasoning arrives before the first tool.
  function ensureToolStream(row, runId) {
    var existing = window.toolContainers && window.toolContainers.get(runId);
    if (existing) return existing;
    var tools = row.querySelector('.tool-calls');
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'tool-calls';
      var stream = window.ensureActivityStream ? window.ensureActivityStream(row) : row;
      stream.appendChild(tools);
    }
    if (window.toolContainers) window.toolContainers.set(runId, tools);
    return tools;
  }

  function renderReasoning(runId, fullText, opts) {
    opts = opts || {};
    var row = opts.row || window.getOrCreateAssistantMessage(runId);
    if (window.activityUsesUnifiedTimeline && window.activityUsesUnifiedTimeline()) {
      var previous = (window.thinkingTextState && window.thinkingTextState.get(runId)) || '';
      var next = String(fullText || '');
      var delta = next.indexOf(previous) === 0 ? next.slice(previous.length) : next;
      if (delta.trim() && window.appendActivityNotes) window.appendActivityNotes(runId, delta, row);
      if (window.thinkingTextState) window.thinkingTextState.set(runId, next);
      window.scrollToBottom();
      return;
    }
    var slot = ensureToolStream(row, runId);
    var block = window.reasoningBlocks.get(runId);
    var isActive = !opts.complete;
    // Chronological interspersing: a tool call since the last thinking burst opens
    // a NEW reasoning segment, appended at the container's current end so it lands
    // after the tools that preceded it. Segments carve the cumulative thinking
    // stream by [_segStart, _segEnd) offsets so each disclosure shows only its slice.
    var interrupted = !!(window.reasoningInterrupted && window.reasoningInterrupted.has(runId));
    var fullStr = String(fullText || '');
    if (!block || interrupted) {
      var segStart = (block && typeof block._segEnd === 'number') ? block._segEnd : 0;
      // Don't open a new segment for an empty/whitespace-only burst — a stub thought
      // between two identical tool calls would split them and break the blob group.
      // Keep the interrupt flag pending until real reasoning text actually arrives.
      if (interrupted && !opts.complete && !fullStr.slice(segStart).trim()) {
        return;
      }
      if (interrupted && window.reasoningInterrupted) window.reasoningInterrupted.delete(runId);
      if (block && interrupted) finalizeReasoningBlock(block);
      block = document.createElement('details');
      block.className = 'reasoning-disclosure thinking';
      block._segStart = segStart;
      block.open = false;
      block.innerHTML = '<summary>' + summaryHtml('', { showBar: isActive }) + '</summary>' +
        '<div class="reasoning-content"></div>';
      slot.appendChild(block);
      window.reasoningBlocks.set(runId, block);
    }
    block._segEnd = fullStr.length;
    var segText = fullStr.slice(block._segStart || 0);
    var label = opts.complete
      ? finalReasoningLabel(segText, opts.durationMs)
      : (reasoningMode === 'compact')
      ? 'Thinking\u2026 ~' + window.approxTokens(segText).toLocaleString() + ' tokens'
      : 'Reasoning\u2026';
    block.classList.toggle('thinking', isActive);
    var summary = block.querySelector('summary');
    var labelEl = summary.querySelector('.reasoning-label');
    var existingBar = summary.querySelector('.thinking-bar');

    if (!existingBar && isActive) {
      summary.innerHTML = summaryHtml(label, { showBar: true });
      var bar = block.querySelector('.thinking-bar');
      if (bar) { startThinkingBar(bar); scheduleBarTick(bar); }
      var mDiv = document.getElementById('chat-messages');
      mDiv.dataset.activeRun = runId;
      mDiv.dataset.activeRunTime = Date.now();
    } else if (existingBar && !isActive) {
      summary.innerHTML = summaryHtml(label, { showBar: false });
      var mDiv = document.getElementById('chat-messages');
      if (mDiv.dataset.activeRun === runId) { delete mDiv.dataset.activeRun; delete mDiv.dataset.activeRunTime; }
    } else if (existingBar && isActive) {
      if (existingBar.dataset.active !== 'running') { startThinkingBar(existingBar); scheduleBarTick(existingBar); }
      if (labelEl) labelEl.textContent = label;
    } else if (labelEl) {
      labelEl.textContent = label;
    } else {
      summary.innerHTML = summaryHtml(label, { showBar: isActive });
    }
    var contentEl = block.querySelector('.reasoning-content');
    block.classList.remove('summary-only');
    contentEl.innerHTML = window.formatThinkingContent(segText);
    window.scrollToBottom();
  }
  window.renderReasoning = renderReasoning;

  // Finalize a single reasoning segment (stop its bar, freeze its summary label).
  // Used when a tool interrupts an active segment, before the next one opens.
  function finalizeReasoningBlock(block) {
    if (!block) return;
    var content = block.querySelector('.reasoning-content');
    var label = finalReasoningLabel(content ? content.textContent : '', 0);
    block.classList.remove('thinking');
    var bar = block.querySelector('.thinking-bar');
    if (bar) stopThinkingBar(bar);
    var summary = block.querySelector('summary');
    if (summary) summary.innerHTML = summaryHtml(label);
    block.open = false;
  }

  function finalReasoningLabel(fullText, durationMs) {
    var secs = durationMs ? Math.max(1, Math.round(durationMs / 1000)) : 0;
    var toks = window.approxTokens(fullText);
    return secs
      ? window.junctionT('thoughtForSecondsTokens', 'Thought for {seconds}s · ~{count} tokens', { seconds: secs, count: toks.toLocaleString() })
      : window.junctionT('thoughtTokens', 'Thought · ~{count} tokens', { count: toks.toLocaleString() });
  }

  function finalizeReasoning(runId, durationMs) {
    if (window.activityUsesUnifiedTimeline && window.activityUsesUnifiedTimeline()) {
      var row = (window.activeRuns && window.activeRuns.get(runId)) || document.querySelector('[data-run-id="' + runId + '"]');
      if (window.flushActivityNotes) window.flushActivityNotes(runId, row);
      return;
    }
    var block = window.reasoningBlocks.get(runId);
    if (!block) return;
    var content = block.querySelector('.reasoning-content');
    var label = finalReasoningLabel(content ? content.textContent : '', durationMs);
    block.classList.remove('thinking');
    var bar = block.querySelector('.thinking-bar');
    if (bar) stopThinkingBar(bar);
    block.querySelector('summary').innerHTML = summaryHtml(label);
    block.open = false;
    var mDiv = document.getElementById('chat-messages');
    if (mDiv.dataset.activeRun === runId) { delete mDiv.dataset.activeRun; delete mDiv.dataset.activeRunTime; }
  }
  window.finalizeReasoning = finalizeReasoning;

  // ── Expose functions used by coordinator chat-stream.js ──────────────
  window.thinkingBarHtml = thinkingBarHtml;
  window.startThinkingBar = startThinkingBar;
  window.scheduleBarTick = scheduleBarTick;
  window.tickThinkingBar = tickThinkingBar;
  window.summaryHtml = summaryHtml;
  window.finalReasoningLabel = finalReasoningLabel;

  // ── Expose reasoningMode for config handler ────────────────────────────
  window.reasoningMode = reasoningMode;

})();
